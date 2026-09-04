/**
 * test/entity_identity.test.js — The entity identity + alias service
 * (TODO §1: "Entity identity + alias management").
 *
 * Covers the four properties the service exists for:
 *   1. Canonical ids — every registry record gets one (migration v1→v2 and
 *      runtime stamping), it never changes on rename, and edges carry stable
 *      subject/target pointers.
 *   2. Aliases — the resolver honors explicit aliases exactly, fails closed
 *      on ambiguity, and write-time guards keep them collision-free.
 *   3. User-approved renames — every name-keyed surface travels: registry,
 *      relationships, stances, evidence, dossier watermarks; the old name
 *      stays resolvable as an alias.
 *   4. User-approved merges — absorbed evidence keeps its quote-receipt links
 *      (namespaced ids), absorbed edges re-point at the survivor, and the
 *      mergedFrom audit trail records what happened.
 *
 * The lorebook relabel path is exercised separately by the lorebook tests;
 * here it is skipped via { relabelEntries: false, syncBlocks: false } so the
 * store-level propagation can be asserted without world-info IO.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import { resetCoreStubs, getFakeMeta, getFakeExtSettings, setFakeContextExtras } from './stubs/core.js';
import { _clearCacheForTests, _setCacheForTests } from '../knowledge/store.js';
import { state } from '../knowledge/state.js';
import { getLorebookName } from '../knowledge/scope.js';
import { saveSettings } from '../knowledge/settings.js';
import { bumpEpoch } from '../core/scope.js';
import { pauseStore, resumeStore } from '../core/schema_status.js';
import { QUARANTINE_METADATA_KEY } from '../core/quarantine.js';
import {
    getRegistry, saveRegistry, registerEntry, resolveRegistryKey,
} from '../knowledge/registry.js';
import {
    updateRelationship, addRelationship, getRelationships, saveRelationships,
    getStance, setStance,
} from '../knowledge/relationships.js';
import {
    getEntityId, getNameByEntityId, listAliases, addAlias, removeAlias,
    renameEntity, mergeEntities, repairEntityLinks, flushIdentityWrites,
} from '../knowledge/identity.js';
import { knowledgeStoreSchema, COUNTERS_META_KEY, KNOWLEDGE_STORE_VERSION } from '../knowledge/schema.js';
import { prepareStore } from '../core/schema.js';
import { getEvidenceMap, saveEvidenceMap } from '../knowledge/evidence.js';
import { recordDossierFieldRefresh } from '../knowledge/dossier_status.js';
// Side-effect import: knowledge/lorebook.js assigns state.wiScript at module
// load. Loading it here means that assignment happens BEFORE any beforeEach
// installs the per-test fake — otherwise the first renameEntity's dynamic
// `await import('./lorebook.js')` would load the module mid-test and clobber
// the fake with the null-returning stub (same pattern canonical_identity
// avoids by importing lorebook functions at the top).
import '../knowledge/lorebook.js';

const NO_LOREBOOK = { relabelEntries: false, syncBlocks: false };

/**
 * Minimal stand-in for ST's world-info.js — same contract as store.test.js's
 * fake: loadWorldInfo returns a deep copy so read-modify-write is forced.
 * Used by the scope-guard tests, which relabel through the real lorebook IO.
 */
function makeFakeWorldInfo() {
    const books = new Map();
    return {
        books,
        async loadWorldInfo(name) {
            return books.has(name) ? structuredClone(books.get(name)) : null;
        },
        async saveWorldInfo(name, wi, immediately = false) {
            if (immediately) books.set(name, structuredClone(wi));
        },
        async createNewWorldInfo(name) {
            books.set(name, { entries: {} });
            return true;
        },
    };
}

function seedNpc(name, { uid = 0, type = 'minor', keywords } = {}) {
    registerEntry(name, uid, type, keywords ?? [name]);
}

function seedEvidence(name, raw, consolidated = []) {
    const map = getEvidenceMap();
    map[name] = {
        npc: name,
        raw: raw.map((r, i) => ({ id: `o${i}`, claim: r.claim, quote: r.quote, ...r })),
        consolidated: consolidated.map((c, i) => ({ id: `c${i}`, claim: c.claim, ...(c.sources ? { sources: c.sources } : {}) })),
        archivedRaw: [],
        meta: { createdAt: 1, updatedAt: 1, lastProfileAt: null },
    };
    saveEvidenceMap();
}

beforeEach(() => {
    resetCoreStubs();
    _clearCacheForTests();
    // Mark the knowledge book hydrated so writes are accepted without a fake
    // lorebook behind them; flushes then no-op with a warning.
    _setCacheForTests(getLorebookName(), {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// ─── 1. Canonical ids ────────────────────────────────────────────────────────

describe('canonical entity ids', () => {
    test('registerEntry stamps an entityId and empty aliases on every record', () => {
        seedNpc('Mara', { uid: 1 });
        const reg = getRegistry();
        expect(reg.Mara.entityId).toMatch(/^mwt_/);
        expect(reg.Mara.aliases).toEqual([]);
    });

    test('registerEntry merges into the existing record — identity fields and pointers survive', () => {
        seedNpc('Mara', { uid: 1 });
        const id = getRegistry().Mara.entityId;
        addAlias('Mara', 'The Vixen');
        const reg = getRegistry();
        reg.Mara.profileUid = 5;
        saveRegistry(reg);

        registerEntry('Mara', 2, 'major', ['Mara']);

        const after = getRegistry().Mara;
        expect(after.entityId).toBe(id);            // not re-minted
        expect(after.aliases).toEqual(['The Vixen']);
        expect(after.profileUid).toBe(5);           // unmanaged field preserved
        expect(after.uid).toBe(2);                  // the call's own fields win
        expect(after.type).toBe('major');
    });

    test('saveRegistry stamps records created by any path (not just registerEntry)', () => {
        const reg = getRegistry();
        reg['Jonah'] = { uid: 2, type: 'minor', keywords: ['Jonah'], lastUpdated: 1 };
        saveRegistry(reg);
        expect(getRegistry().Jonah.entityId).toMatch(/^mwt_/);
        expect(getRegistry().Jonah.aliases).toEqual([]);
    });

    test('an existing entityId is never re-stamped', () => {
        const reg = getRegistry();
        reg['Mara'] = { uid: 1, type: 'minor', keywords: ['Mara'], lastUpdated: 1, entityId: 'mwt_fixed', aliases: ['M'] };
        saveRegistry(reg);
        expect(getRegistry().Mara.entityId).toBe('mwt_fixed');
    });

    test('getEntityId / getNameByEntityId round-trip through the resolver', () => {
        seedNpc('Mara Vance', { uid: 1 });
        const id = getEntityId('mara vance'); // case-insensitive resolution
        expect(id).toBe(getRegistry()['Mara Vance'].entityId);
        expect(getNameByEntityId(id)).toBe('Mara Vance');
        expect(getEntityId('Nobody')).toBeNull();
    });

    test('the v1 → v2 migration stamps registry ids and backfills edge pointers', () => {
        const v1 = {
            version: 1,
            registry: {
                Mara: { uid: 1, type: 'minor', keywords: ['Mara'], lastUpdated: 1 },
                Jonah: { uid: 2, type: 'minor', keywords: ['Jonah'], lastUpdated: 1 },
            },
            relationships: {
                Mara: [{ target: 'Jonah', type: 'friend', notes: '', source: 'manual' }],
            },
        };
        const result = prepareStore(knowledgeStoreSchema, v1, { version: 1 });
        expect(result.status).toBe('migrated');
        expect(result.data.version).toBe(KNOWLEDGE_STORE_VERSION);
        expect(result.data.registry.Mara.entityId).toMatch(/^mwt_/);
        expect(result.data.registry.Jonah.entityId).toMatch(/^mwt_/);
        const edge = result.data.relationships.Mara[0];
        expect(edge.subjectEntityId).toBe(result.data.registry.Mara.entityId);
        expect(edge.targetEntityId).toBe(result.data.registry.Jonah.entityId);
        // The migration must not mutate its input.
        expect(v1.registry.Mara.entityId).toBeUndefined();
        expect(v1.relationships.Mara[0].subjectEntityId).toBeUndefined();
    });

    test('the migration leaves unknown edge targets bare (never guesses an id)', () => {
        const v1 = {
            version: 1,
            registry: { Mara: { uid: 1, type: 'minor', keywords: ['Mara'], lastUpdated: 1 } },
            relationships: { Mara: [{ target: 'Ghost', type: 'rival', notes: '', source: 'manual' }] },
        };
        const result = prepareStore(knowledgeStoreSchema, v1, { version: 1 });
        expect(result.data.relationships.Mara[0].targetEntityId).toBeUndefined();
    });

    test('the migration is idempotent — re-preparing v2 data stamps nothing new', () => {
        const once = prepareStore(knowledgeStoreSchema, {
            version: 1,
            registry: { Mara: { uid: 1, type: 'minor', keywords: ['Mara'], lastUpdated: 1 } },
        }, { version: 1 });
        const twice = prepareStore(knowledgeStoreSchema, once.data, { version: once.data.version });
        expect(twice.status).toBe('valid');
        expect(twice.data.registry.Mara.entityId).toBe(once.data.registry.Mara.entityId);
    });

    test('edges written after v2 carry subject/target entity ids', () => {
        seedNpc('Mara', { uid: 1 });
        seedNpc('Jonah', { uid: 2 });
        addRelationship('Mara', 'Jonah', 'friend', '', 'manual');
        const edge = getRelationships().Mara[0];
        expect(edge.subjectEntityId).toBe(getRegistry().Mara.entityId);
        expect(edge.targetEntityId).toBe(getRegistry().Jonah.entityId);
        // An update re-stamps legacy edges that predate ids.
        delete edge.subjectEntityId;
        delete edge.targetEntityId;
        updateRelationship('Mara', 'Jonah', 'rival', '', 'manual');
        expect(edge.subjectEntityId).toBe(getRegistry().Mara.entityId);
        expect(edge.targetEntityId).toBe(getRegistry().Jonah.entityId);
    });

    test('schema validation quarantines a malformed entityId and repairs duplicate ids', () => {
        const validated = knowledgeStoreSchema.validate({
            version: 2,
            registry: {
                A: { uid: 1, entityId: 'mwt_a', aliases: [] },
                B: { uid: 2, entityId: 7 },           // invalid → record quarantine
                C: { uid: 3, entityId: 'mwt_a' },     // duplicate → repair strips
                D: { uid: 4, aliases: ['ok', 42] },   // invalid aliases → quarantine
            },
        });
        const codes = validated.issues.map(i => i.code);
        expect(codes).toContain('registry-invalid-entity-id');
        expect(codes).toContain('registry-aliases-invalid');
        expect(codes).toContain('registry-duplicate-entity-id');
        expect(validated.data.registry.A.entityId).toBe('mwt_a');
        expect(validated.data.registry.C.entityId).toBeUndefined();
        expect(validated.data.registry.B).toBeUndefined();
        expect(validated.data.registry.D).toBeUndefined();
    });

    test('schema validation strips an alias that collides with another record or alias', () => {
        const validated = knowledgeStoreSchema.validate({
            version: 2,
            registry: {
                A: { uid: 1, entityId: 'mwt_a', aliases: ['B', 'shared'] },
                B: { uid: 2, entityId: 'mwt_b', aliases: ['shared', 'fine'] },
            },
        });
        const codes = validated.issues.map(i => i.code);
        expect(codes).toContain('registry-alias-collision');
        // 'B' (a canonical key) is stripped from A; the first 'shared' claim
        // (A's, in insertion order) survives and B's duplicate is stripped;
        // B's 'fine' was never contested.
        expect(validated.data.registry.A.aliases).toEqual(['shared']);
        expect(validated.data.registry.B.aliases).toEqual(['fine']);
    });

    test('schema validation repairs a malformed merge audit trail instead of quarantining the NPC', () => {
        const validated = knowledgeStoreSchema.validate({
            version: 2,
            registry: {
                Sophie: { uid: 10, entityId: 'mwt_keep', mergedFrom: [{ entityId: null, name: 'Soph', at: 1 }] },
                Bad: { uid: 11, entityId: 'mwt_bad', mergedFrom: 'not-an-array' },
            },
        });
        const trailIssues = validated.issues.filter(i => i.code === 'registry-merged-from-invalid');
        expect(trailIssues).toHaveLength(2);
        expect(trailIssues.every(i => i.severity === 'repair')).toBe(true);
        // The NPC records stay live; only the malformed trail is stripped,
        // with the raw value preserved in the issue for recovery.
        expect(validated.data.registry.Sophie).toBeDefined();
        expect(validated.data.registry.Sophie.mergedFrom).toBeUndefined();
        expect(validated.data.registry.Bad.mergedFrom).toBeUndefined();
        expect(trailIssues[0].record).toEqual([{ entityId: null, name: 'Soph', at: 1 }]);
    });

    test('schema validation quarantines a malformed edge entity id', () => {
        const validated = knowledgeStoreSchema.validate({
            version: 2,
            registry: { A: { uid: 1 } },
            relationships: { A: [{ target: 'A', type: 'friend', subjectEntityId: 13 }] },
        });
        expect(validated.issues.map(i => i.code)).toContain('relationship-invalid-entity-id');
        expect(validated.data.relationships.A).toHaveLength(0);
    });
});

// ─── 2. Alias resolution ─────────────────────────────────────────────────────

describe('explicit alias resolution', () => {
    test('an exact alias resolves to its record', () => {
        seedNpc('Mara Vance', { uid: 1 });
        addAlias('Mara Vance', 'The Vixen');
        expect(resolveRegistryKey(getRegistry(), 'The Vixen')).toBe('Mara Vance');
    });

    test('alias matching is case-insensitive and trims', () => {
        seedNpc('Mara Vance', { uid: 1 });
        addAlias('Mara Vance', 'The Vixen');
        expect(resolveRegistryKey(getRegistry(), '  the vixen ')).toBe('Mara Vance');
    });

    test('an alias claimed by two records is ambiguous and fails closed', () => {
        seedNpc('Mara Vance', { uid: 1 });
        seedNpc('Mara Chen', { uid: 2 });
        addAlias('Mara Vance', 'The Vixen');
        // Smuggle the SAME alias onto a second record past the write guard
        // (imported data the validator would repair on load) — the resolver
        // must still refuse rather than pick one.
        const reg = getRegistry();
        reg['Mara Chen'].aliases = ['The Vixen'];
        saveRegistry(reg);
        expect(resolveRegistryKey(getRegistry(), 'The Vixen')).toBeNull();
    });

    test('an alias never shadows a canonical key', () => {
        seedNpc('Mara Vance', { uid: 1 });
        seedNpc('Jonah', { uid: 2 });
        // 'Jonah' the canonical key wins over any alias claim imported onto
        // another record.
        const reg = getRegistry();
        reg['Mara Vance'].aliases = ['Jonah'];
        saveRegistry(reg);
        expect(resolveRegistryKey(getRegistry(), 'Jonah')).toBe('Jonah');
    });

    test('aliases do not weaken the given-name heuristic for other records', () => {
        seedNpc('Mara Vance', { uid: 1 });
        addAlias('Mara Vance', 'The Vixen');
        // The heuristic still answers the given name.
        expect(resolveRegistryKey(getRegistry(), 'Mara')).toBe('Mara Vance');
    });
});

// ─── 3. Alias CRUD guards ────────────────────────────────────────────────────

describe('alias CRUD', () => {
    test('addAlias accepts, dedupes idempotently, and removeAlias removes', () => {
        seedNpc('Mara Vance', { uid: 1 });
        expect(addAlias('Mara Vance', 'The Vixen')).toEqual({ ok: true, added: true });
        expect(addAlias('mara vance', 'the vixen')).toEqual({ ok: true, added: false });
        expect(listAliases('The Vixen')).toEqual(['The Vixen']); // resolved by alias
        expect(removeAlias('Mara Vance', 'the vixen')).toEqual({ ok: true, removed: true });
        expect(listAliases('Mara Vance')).toEqual([]);
    });

    test('addAlias refuses collisions with canonical keys and other aliases', () => {
        seedNpc('Mara Vance', { uid: 1 });
        seedNpc('Jonah', { uid: 2 });
        addAlias('Jonah', 'Doc');
        expect(addAlias('Mara Vance', 'Jonah')).toEqual({ ok: false, reason: 'alias-taken', owner: 'Jonah' });
        expect(addAlias('Mara Vance', 'Doc')).toEqual({ ok: false, reason: 'alias-taken', owner: 'Jonah' });
        expect(addAlias('Mara Vance', 'Mara Vance')).toEqual({ ok: false, reason: 'alias-equals-name' });
        expect(addAlias('Mara Vance', '   ')).toEqual({ ok: false, reason: 'invalid-alias' });
        expect(addAlias('Nobody', 'X')).toEqual({ ok: false, reason: 'unknown-npc' });
    });
});

// ─── 4. Rename ───────────────────────────────────────────────────────────────

describe('renameEntity', () => {
    test('propagates across every name-keyed surface and keeps the old name resolving', async () => {
        seedNpc('Mara', { uid: 7, type: 'major', keywords: ['Mara', 'spy'] });
        seedNpc('Jonah', { uid: 8 });
        const maraId = getRegistry().Mara.entityId;
        updateRelationship('Mara', 'Jonah', 'friend', 'met at work', 'auto');
        updateRelationship('Jonah', 'Mara', 'mentor', '', 'manual');
        setStance('Mara', 'wary', 'manual');
        seedEvidence('Mara', [{ claim: 'watches exits', quote: 'Mara watches the exits.' }]);
        recordDossierFieldRefresh('Mara', ['agenda']);

        const result = await renameEntity('Mara', 'Mara Vance', NO_LOREBOOK);
        expect(result.ok).toBe(true);
        expect(result.renamed).toBe(true);

        // Registry: rekeyed, same entity id, old name is an alias, keywords swapped.
        const reg = getRegistry();
        expect(reg['Mara']).toBeUndefined();
        expect(reg['Mara Vance'].entityId).toBe(maraId);
        expect(reg['Mara Vance'].aliases).toEqual(['Mara']);
        expect(reg['Mara Vance'].keywords).toEqual(['Mara Vance', 'spy']);

        // The old spelling still resolves (alias), and its uid link is intact.
        expect(resolveRegistryKey(reg, 'Mara')).toBe('Mara Vance');
        expect(reg['Mara Vance'].uid).toBe(7);

        // Relationships: map key + target names moved, ids unchanged.
        const rels = getRelationships();
        expect(rels['Mara']).toBeUndefined();
        expect(rels['Mara Vance'][0].target).toBe('Jonah');
        expect(rels['Mara Vance'][0].subjectEntityId).toBe(maraId);
        expect(rels['Mara Vance'][0].targetEntityId).toBe(getRegistry().Jonah.entityId);

        // Incoming edges re-point too, and their target id rides along.
        expect(rels.Jonah[0].target).toBe('Mara Vance');
        expect(rels.Jonah[0].targetEntityId).toBe(maraId);

        // Stance travels.
        expect(getStance('Mara Vance')).toBe('wary');

        // Evidence rekeyed + npc field updated.
        const map = getEvidenceMap();
        expect(map['Mara']).toBeUndefined();
        expect(map['Mara Vance'].npc).toBe('Mara Vance');

        // Dossier watermarks rekeyed.
        const stamps = getFakeMeta()[COUNTERS_META_KEY].dossierFieldStatus;
        expect(stamps['Mara Vance'].agenda).toBeDefined();
        expect(stamps['Mara']).toBeUndefined();

        // A SECOND rename layers correctly: aliases accumulate, ids stay.
        const again = await renameEntity('Mara Vance', 'Mara V.', NO_LOREBOOK);
        expect(again.ok).toBe(true);
        expect(getRegistry()['Mara V.'].aliases).toEqual(['Mara', 'Mara Vance']);
        expect(getRegistry()['Mara V.'].entityId).toBe(maraId);
        expect(getStance('Mara V.')).toBe('wary');
        expect(getRelationships().Jonah[0].target).toBe('Mara V.');
    });

    test('refuses unknown NPCs, empty names, taken names, and no-ops the same name', async () => {
        seedNpc('Mara', { uid: 1 });
        seedNpc('Jonah', { uid: 2 });
        addAlias('Jonah', 'Captain');
        expect((await renameEntity('Ghost', 'X', NO_LOREBOOK)).reason).toBe('unknown-npc');
        expect((await renameEntity('Mara', '  ', NO_LOREBOOK)).reason).toBe('invalid-name');
        expect((await renameEntity('Mara', 'Jonah', NO_LOREBOOK)).reason).toBe('name-taken');
        expect((await renameEntity('Mara', 'Captain', NO_LOREBOOK)).reason).toBe('name-taken');
        const same = await renameEntity('Mara', 'Mara', NO_LOREBOOK);
        expect(same.ok).toBe(true);
        expect(same.renamed).toBe(false);
    });

    test('a rename to a name that only differs in case/whitespace is a rekey, not a collision', async () => {
        seedNpc('Mara', { uid: 1 });
        const result = await renameEntity('Mara', 'mara', NO_LOREBOOK);
        expect(result.ok).toBe(true);
        // The canonical key is the trimmed new spelling.
        expect(Object.keys(getRegistry())).toEqual(['mara']);
        // The old spelling is NOT kept as an alias — it normalized-equals the
        // new canonical name (the shape addAlias refuses), so keeping it would
        // only surface a spurious alias-collision repair on the next load.
        expect(getRegistry().mara.aliases).toEqual([]);
    });
});

// ─── 5. Merge ────────────────────────────────────────────────────────────────

describe('mergeEntities', () => {
    test('folds one identity into another with evidence links preserved', async () => {
        seedNpc('Sophie Simpson', { uid: 10, type: 'major', keywords: ['Sophie Simpson'] });
        seedNpc('Sophie', { uid: 11, type: 'minor', keywords: ['Sophie'] });
        seedNpc('Jonah', { uid: 12 });
        const keepId = getRegistry()['Sophie Simpson'].entityId;
        const mergeId = getRegistry().Sophie.entityId;

        // Keep has one edge + a stance; merged has its own evidence with
        // consolidated → raw source links, an outgoing edge, an incoming edge,
        // a stance, and a dossier watermark for a field keep never tracked.
        updateRelationship('Sophie Simpson', 'Jonah', 'friend', 'old friends', 'auto');
        setStance('Sophie Simpson', 'wary', 'manual');
        updateRelationship('Sophie', 'Jonah', 'rival', 'school', 'auto');
        updateRelationship('Jonah', 'Sophie', 'client', 'hired her', 'manual');
        setStance('Sophie', 'curious', 'auto');
        seedEvidence('Sophie Simpson', [{ claim: 'keeps ledgers', quote: 'Sophie keeps ledgers.' }]);
        seedEvidence('Sophie',
            [{ claim: 'lies about her past', quote: 'My past? Nothing to tell.' }],
            [{ claim: 'hides her history', sources: ['o0'] }],
        );
        recordDossierFieldRefresh('Sophie Simpson', ['agenda']);
        recordDossierFieldRefresh('Sophie', ['secrets']);

        const result = await mergeEntities('Sophie Simpson', 'Sophie', NO_LOREBOOK);
        expect(result.ok).toBe(true);
        expect(result.merged).toBe(true);
        expect(result.warnings.join('\n')).toContain('uid 11'); // entry left in book

        // Registry: merged record gone, keep carries aliases + mergedFrom trail.
        const reg = getRegistry();
        expect(reg.Sophie).toBeUndefined();
        expect(reg['Sophie Simpson'].entityId).toBe(keepId);
        expect(reg['Sophie Simpson'].aliases).toEqual(['Sophie']);
        expect(reg['Sophie Simpson'].mergedFrom).toEqual([
            { entityId: mergeId, name: 'Sophie', at: expect.any(Number) },
        ]);
        // Keywords union, keep's spelling first.
        expect(reg['Sophie Simpson'].keywords).toEqual(['Sophie Simpson', 'Sophie']);
        // Keep's uid is authoritative; merged's entry was reported, not adopted.
        expect(reg['Sophie Simpson'].uid).toBe(10);
        // The absorbed name still resolves — now as an alias of the survivor.
        expect(resolveRegistryKey(reg, 'Sophie')).toBe('Sophie Simpson');

        // Relationships: the overlapping edge collapsed (merged content wins,
        // exactly like rekeyRelationships), the non-overlapping incoming edge
        // re-pointed, and every survivor carries keep's entity id.
        const rels = getRelationships();
        expect(rels['Sophie']).toBeUndefined();
        const toJonah = rels['Sophie Simpson'].find(r => r.target === 'Jonah');
        expect(toJonah.type).toBe('rival');
        expect(toJonah.subjectEntityId).toBe(keepId);
        const incoming = rels.Jonah.find(r => r.target === 'Sophie Simpson');
        expect(incoming.type).toBe('client');
        expect(incoming.targetEntityId).toBe(keepId);

        // Stance: keep's wins.
        expect(getStance('Sophie Simpson')).toBe('wary');

        // Evidence: merged under namespaced ids, source links intact.
        const map = getEvidenceMap();
        expect(map.Sophie).toBeUndefined();
        const merged = map['Sophie Simpson'];
        const ns = `${mergeId}::`;
        expect(merged.raw.find(o => o.id === `${ns}o0`)).toBeDefined();
        const mergedConsolidated = merged.consolidated.find(c => c.id === `${ns}c0`);
        expect(mergedConsolidated).toBeDefined();
        expect(mergedConsolidated.sources).toEqual([`${ns}o0`]);
        // The keep file's own observation kept its original id.
        expect(merged.raw.some(o => o.id === 'o0')).toBe(true);

        // Dossier watermarks: keep's stamps win, missing fields filled.
        const stamps = getFakeMeta()[COUNTERS_META_KEY].dossierFieldStatus;
        expect(stamps['Sophie Simpson'].agenda).toBeDefined();
        expect(stamps['Sophie Simpson'].secrets).toBeDefined();
        expect(stamps.Sophie).toBeUndefined();
    });

    test('adopts the merged uid only when keep has none and the merged record has one', async () => {
        seedNpc('A', { uid: 1 });
        seedNpc('B', { uid: 9 });
        const result = await mergeEntities('A', 'B', NO_LOREBOOK);
        expect(result.ok).toBe(true);
        expect(result.report.adoptedUid).toBe(false); // A already had uid 1
        expect(getRegistry().A.uid).toBe(1);

        // Now a uid-less keep adopts.
        seedNpc('C', { uid: null });
        const adopted = await mergeEntities('C', 'D', NO_LOREBOOK).catch(() => null);
        // (D does not exist — guard first)
        expect(adopted.reason).toBe('unknown-merge-npc');
    });

    test('guards its inputs and is idempotent for the same entity', async () => {
        seedNpc('A', { uid: 1 });
        expect((await mergeEntities('A', 'Ghost', NO_LOREBOOK)).reason).toBe('unknown-merge-npc');
        expect((await mergeEntities('Ghost', 'A', NO_LOREBOOK)).reason).toBe('unknown-keep-npc');
        // 'a' resolves to the SAME record as 'A' — same NPC, no-op.
        const same = await mergeEntities('A', 'a', NO_LOREBOOK);
        expect(same.ok).toBe(true);
        expect(same.merged).toBe(false);
    });

    test('an alias that would collide with a third NPC is not carried over', async () => {
        seedNpc('Sophie Simpson', { uid: 1 });
        seedNpc('Sophie', { uid: 2 });
        seedNpc('Fifi', { uid: 3 });
        // Smuggle a colliding alias onto the merged record (imported data the
        // addAlias guard would have refused) so the merge has a conflict to
        // resolve rather than to prevent.
        const reg = getRegistry();
        reg.Sophie.aliases = ['Fifi'];
        saveRegistry(reg);
        const result = await mergeEntities('Sophie Simpson', 'Sophie', NO_LOREBOOK);
        expect(result.ok).toBe(true);
        expect(result.warnings.join('\n')).toContain('Fifi');
        expect(getRegistry()['Sophie Simpson'].aliases).toEqual(['Sophie']);
    });
});

// ─── 5b. Merge collapses between-identity edges, never self-relationships ────

describe('mergeEntities drops edges that would collapse into self-relationships', () => {
    test('edges between the two identities and the absorbed self-edge are dropped', async () => {
        seedNpc('Sophie Simpson', { uid: 10 });
        seedNpc('Sophie', { uid: 11 });
        seedNpc('Jonah', { uid: 12 });
        updateRelationship('Sophie Simpson', 'Sophie', 'sister', 'once removed', 'manual'); // keep → merge
        updateRelationship('Sophie', 'Sophie Simpson', 'sister', 'once removed', 'manual'); // merge → keep
        updateRelationship('Sophie', 'Sophie', 'knows herself', 'pre-existing self-edge', 'manual'); // merge → merge
        updateRelationship('Sophie', 'Jonah', 'rival', 'school', 'auto'); // survives (moved)
        updateRelationship('Jonah', 'Sophie', 'client', 'hired her', 'manual'); // survives (repointed)

        const result = await mergeEntities('Sophie Simpson', 'Sophie', NO_LOREBOOK);

        expect(result.ok).toBe(true);
        expect(result.report.relationships.edgesDropped).toBe(3);
        const rels = getRelationships();
        // No survivor edge targets the survivor — no self-relationships.
        expect(rels['Sophie Simpson'].some(r => r.target === 'Sophie Simpson')).toBe(false);
        // Real relationships to OTHER NPCs survived the merge.
        expect(rels['Sophie Simpson'].find(r => r.target === 'Jonah')?.type).toBe('rival');
        expect(rels.Jonah.find(r => r.target === 'Sophie Simpson')?.type).toBe('client');
    });

    test("a pre-existing self-edge on the SURVIVOR predates the merge and stays", async () => {
        seedNpc('Sophie Simpson', { uid: 10 });
        seedNpc('Sophie', { uid: 11 });
        updateRelationship('Sophie Simpson', 'Sophie Simpson', 'notes to self', '', 'manual');

        const result = await mergeEntities('Sophie Simpson', 'Sophie', NO_LOREBOOK);

        expect(result.ok).toBe(true);
        expect(result.report.relationships.edgesDropped).toBe(0);
        expect(getRelationships()['Sophie Simpson'].some(r => r.target === 'Sophie Simpson')).toBe(true);
    });

    test('a merge of id-less records stamps ids first — the audit trail never breaks the survivor', async () => {
        // A v2 store that predates id stamping: both records are legacy-shaped
        // (ids are optional), exactly the state the duplicate-id repair or a
        // foreign store can leave behind.
        _setCacheForTests(getLorebookName(), {
            registry: {
                Sophie: { uid: 10, type: 'minor', keywords: ['Sophie'], lastUpdated: 1 },
                Soph: { uid: 11, type: 'minor', keywords: ['Soph'], lastUpdated: 1 },
            },
        });

        const result = await mergeEntities('Sophie', 'Soph', NO_LOREBOOK);
        expect(result.ok).toBe(true);

        // The trail records the absorbed record's REAL (freshly stamped) id,
        // not `null` — the shape the validator used to quarantine whole.
        const trail = getRegistry().Sophie.mergedFrom;
        expect(trail).toHaveLength(1);
        expect(trail[0].entityId).toMatch(/^mwt_/);
        // Round-trip through the store validator: the survivor stays live.
        const prepared = prepareStore(knowledgeStoreSchema,
            { version: KNOWLEDGE_STORE_VERSION, registry: getRegistry() },
            { version: KNOWLEDGE_STORE_VERSION });
        expect(prepared.status).toBe('valid');
        expect(prepared.data.registry.Sophie).toBeDefined();
        expect(prepared.issues.some(i => i.code === 'registry-merged-from-invalid')).toBe(false);
    });
});

// ─── 5c. Evidence preflight + checked evidence commits ───────────────────────

describe('rename/merge evidence safety', () => {
    afterEach(() => {
        // A leaked pause would refuse evidence writes in every later test.
        resumeStore('knowledgeEvidence');
    });

    test('a rename is refused BEFORE the registry is rekeyed while the evidence store is paused', async () => {
        seedNpc('Mara', { uid: 7 });
        seedEvidence('Mara', [{ claim: 'watches exits', quote: 'Mara watches the exits.' }]);
        pauseStore('knowledgeEvidence', { reasonCode: 'future-version', message: 'paused for test' });

        const result = await renameEntity('Mara', 'Mara Vance', NO_LOREBOOK);

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('evidence-store-unavailable');
        // Nothing was touched — a retry after the store recovers starts clean.
        expect(getRegistry().Mara).toBeDefined();
        expect(getRegistry()['Mara Vance']).toBeUndefined();
        expect(getEvidenceMap().Mara).toBeDefined();
    });

    test('a paused store does not block evidence-less NPCs — there is nothing to rekey', async () => {
        seedNpc('Mara', { uid: 7 });
        pauseStore('knowledgeEvidence', { reasonCode: 'future-version', message: 'paused for test' });

        const result = await renameEntity('Mara', 'Mara Vance', NO_LOREBOOK);

        expect(result.ok).toBe(true);
        expect(result.renamed).toBe(true);
        expect(getRegistry()['Mara Vance']).toBeDefined();
    });

    test('a merge is refused BEFORE the registry folds records while the evidence store is paused', async () => {
        seedNpc('Sophie Simpson', { uid: 10 });
        seedNpc('Sophie', { uid: 11 });
        seedEvidence('Sophie', [{ claim: 'lies about her past', quote: 'My past? Nothing to tell.' }]);
        pauseStore('knowledgeEvidence', { reasonCode: 'future-version', message: 'paused for test' });

        const result = await mergeEntities('Sophie Simpson', 'Sophie', NO_LOREBOOK);

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('evidence-store-unavailable');
        expect(getRegistry().Sophie).toBeDefined();
        expect(getRegistry()['Sophie Simpson'].mergedFrom).toBeUndefined();
    });

    test('a refused evidence commit after the rekey surfaces as a warning, not a silent success', async () => {
        seedNpc('Mara', { uid: 7 });
        seedEvidence('Mara', [{ claim: 'ok', quote: 'a fine quote' }]);
        // An uncommittable staged edit: a record the schema quarantines…
        getEvidenceMap().Mara.raw.push({ id: 'bad', claim: 'missing its quote receipt' });
        // …and a future-version quarantine container that refuses to preserve
        // quarantined records, so the checked commit must decline the write.
        getFakeMeta()[QUARANTINE_METADATA_KEY] = { version: 99, items: [] };

        const result = await renameEntity('Mara', 'Mara Vance', NO_LOREBOOK);

        expect(result.ok).toBe(true);
        expect(result.warnings.join('\n')).toContain('Evidence file not rekeyed');
        expect(result.warnings.join('\n')).toContain('save-refused:quarantine-refused');
        // The refusal kept the previous map: the evidence stays under the old
        // name (reachable through the alias), not silently orphaned.
        expect(getEvidenceMap().Mara).toBeDefined();
        expect(getEvidenceMap()['Mara Vance']).toBeUndefined();
    });

    test('a rename is refused BEFORE the registry moves when an orphan evidence file already sits under the new name', async () => {
        seedNpc('Mara', { uid: 7 });
        seedEvidence('Mara', [{ claim: 'watches exits', quote: 'Mara watches the exits.' }]);
        // An orphan file under a name whose registry record was removed.
        seedEvidence('Vixen', [{ claim: 'stale orphan', quote: 'Old news.' }]);

        const result = await renameEntity('Mara', 'Vixen', NO_LOREBOOK);

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('evidence-target-exists');
        expect(result.evidenceReason).toBe('target-exists');
        // Nothing moved: the registry and both evidence files are as they were.
        expect(Object.keys(getRegistry())).toEqual(['Mara']);
        expect(getEvidenceMap().Mara).toBeDefined();
        expect(getEvidenceMap().Vixen).toBeDefined();
    });
});

// ─── 5d. Scope guard across the rename/merge lorebook IO ─────────────────────

describe('renameEntity / mergeEntities scope guard', () => {
    let wiFake;

    beforeEach(() => {
        wiFake = makeFakeWorldInfo();
        state.wiScript = wiFake;
    });
    afterEach(() => { state.wiScript = null; });

    /** The book state a rename touches: knowledge dossier + profile. */
    function seedMaraInBooks() {
        seedNpc('Mara', { uid: 3, keywords: ['Mara'] });
        const reg = getRegistry();
        reg.Mara.profileUid = 5;
        saveRegistry(reg);
        wiFake.books.set('Knowledge Tracker', {
            entries: { 3: { uid: 3, comment: 'Mara', key: ['Mara'], content: 'dossier' } },
        });
        wiFake.books.set('NPC Profiles', {
            entries: { 5: { uid: 5, comment: 'Mara', key: [], content: 'profile' } },
        });
    }

    /** Simulate the chat switching while the Knowledge book save is in flight. */
    function switchChatDuringKnowledgeSave() {
        const realSave = wiFake.saveWorldInfo.bind(wiFake);
        wiFake.saveWorldInfo = async (name, wi, immediately) => {
            await realSave(name, wi, immediately);
            if (name === 'Knowledge Tracker') bumpEpoch();
        };
    }

    test('a chat switch during a relabel stops the remaining lorebook work and the sync', async () => {
        seedMaraInBooks();
        switchChatDuringKnowledgeSave();

        const result = await renameEntity('Mara', 'Mara Vance', { relabelEntries: true, syncBlocks: true });

        expect(result.ok).toBe(true);
        expect(result.renamed).toBe(true);
        const warnings = result.warnings.join('\n');
        expect(warnings).toContain('Chat changed during the rename');
        expect(warnings).toContain('Relationship blocks not re-synced');
        // The knowledge relabel had already landed in the ORIGINAL book…
        expect(wiFake.books.get('Knowledge Tracker').entries[3].comment).toBe('Mara Vance');
        // …everything after was dropped, not written into whatever books the
        // newly active chat resolves to.
        expect(wiFake.books.get('NPC Profiles').entries[5].comment).toBe('Mara');
    });

    test('after drift, the returned book pins the caller\'s flush to the ORIGINAL chat', async () => {
        // The caller-side half of the scope guard: renameEntity returns the
        // knowledge book it captured BEFORE its awaits, so the post-operation
        // flush (render.js and the console path both call flushIdentityWrites)
        // commits the original chat's pending writes — never the incoming
        // chat's book, which the zero-argument form would resolve instead.
        setFakeContextExtras({ extensionSettings: getFakeExtSettings(), getCurrentChatId: () => 'chat-a' });
        saveSettings({ scope: 'chat' });
        const bookA = 'Knowledge Tracker - chat-a';
        const bookB = 'Knowledge Tracker - chat-b';
        // Hydrate chat-a's store first so the synchronous rekey writes are
        // accepted; seed Mara and her physical entry in chat-a's book.
        _setCacheForTests(bookA, {});
        seedNpc('Mara', { uid: 3, keywords: ['Mara'] });
        wiFake.books.set(bookA, {
            entries: { 3: { uid: 3, comment: 'Mara', key: ['Mara'], content: 'dossier' } },
        });
        // The INCOMING chat's store is also live — flushing it is the bug.
        _setCacheForTests(bookB, {});
        // Switch chats once the knowledge relabel lands in chat-a's book.
        const realSave = wiFake.saveWorldInfo.bind(wiFake);
        wiFake.saveWorldInfo = async (name, wi, immediately) => {
            await realSave(name, wi, immediately);
            if (name === bookA) {
                bumpEpoch();
                setFakeContextExtras({ getCurrentChatId: () => 'chat-b' });
            }
        };

        const result = await renameEntity('Mara', 'Mara Vance', { relabelEntries: true, syncBlocks: true });

        expect(result.ok).toBe(true);
        expect(result.renamed).toBe(true);
        // The resolver HAS moved on to chat-b — that is exactly why the
        // zero-argument flush would be wrong here…
        expect(getLorebookName()).toBe(bookB);
        // …but the returned book is the one the operation captured.
        expect(result.book).toBe(bookA);

        await flushIdentityWrites(result.book);

        // The flush went to chat-a's book, and the incoming chat's book was
        // never flushed (or created) — with the old zero-argument call,
        // flushBook would have materialised bookB from its seeded cache.
        expect(wiFake.books.has(bookA)).toBe(true);
        expect(wiFake.books.has(bookB)).toBe(false);
    });

    test('without drift, both relabels run and there are no warnings', async () => {
        seedMaraInBooks();

        const result = await renameEntity('Mara', 'Mara Vance', { relabelEntries: true, syncBlocks: false });

        expect(result.ok).toBe(true);
        expect(result.warnings).toEqual([]);
        // Without drift the returned book is simply the active one — callers
        // flushing result.book behave exactly as they did before.
        expect(result.book).toBe(getLorebookName());
        expect(wiFake.books.get('Knowledge Tracker').entries[3].comment).toBe('Mara Vance');
        expect(wiFake.books.get('NPC Profiles').entries[5].comment).toBe('Mara Vance');
    });

    test('a merge stops its adopted-entry relabel after a chat switch', async () => {
        // Keep has no pointers, so it adopts BOTH of the absorbed record's —
        // the profile relabel is the second leg to skip after the drift.
        seedNpc('Sophie Simpson', { uid: null });
        seedNpc('Sophie', { uid: 11 });
        const reg0 = getRegistry();
        reg0.Sophie.profileUid = 12;
        saveRegistry(reg0);
        wiFake.books.set('Knowledge Tracker', {
            entries: { 11: { uid: 11, comment: 'Sophie', key: ['Sophie'], content: 'dossier' } },
        });
        wiFake.books.set('NPC Profiles', {
            entries: { 12: { uid: 12, comment: 'Sophie', key: [], content: 'profile' } },
        });
        switchChatDuringKnowledgeSave();

        const result = await mergeEntities('Sophie Simpson', 'Sophie', { relabelEntries: true, syncBlocks: false });

        expect(result.ok).toBe(true);
        expect(result.merged).toBe(true);
        expect(result.report.adoptedUid).toBe(true);
        // The merge reports its captured book too, for the same flush pinning.
        expect(result.book).toBe('Knowledge Tracker');
        expect(result.warnings.join('\n')).toContain('Chat changed during the merge');
        expect(wiFake.books.get('Knowledge Tracker').entries[11].comment).toBe('Sophie Simpson');
        expect(wiFake.books.get('NPC Profiles').entries[12].comment).toBe('Sophie');
    });
});

// ─── 6. Repair ───────────────────────────────────────────────────────────────

describe('repairEntityLinks (heal names from entity ids)', () => {
    test('a renamed-away map key is healed from its edges\u2019 subject id', () => {
        seedNpc('Mara Vance', { uid: 1 });
        const maraId = getRegistry()['Mara Vance'].entityId;
        // Simulate a rename that missed the relationships map: the bucket is
        // still keyed by the OLD spelling, its edge's subject id still points
        // at the record.
        const rels = getRelationships();
        rels['Mara'] = [{ target: 'Nobody', type: 'friend', notes: '', source: 'manual', subjectEntityId: maraId }];
        saveRelationships(rels);

        const result = repairEntityLinks();
        expect(result.keysRekeyed).toBe(1);
        const healed = getRelationships();
        expect(healed['Mara']).toBeUndefined();
        expect(healed['Mara Vance'][0].subjectEntityId).toBe(maraId);
    });

    test('a dangling edge target is healed from its target id; conflicts are reported, not overwritten', () => {
        seedNpc('Mara Vance', { uid: 1 });
        seedNpc('Jonah', { uid: 2 });
        const maraId = getRegistry()['Mara Vance'].entityId;
        const jonahId = getRegistry().Jonah.entityId;
        const rels = getRelationships();
        rels['Jonah'] = [
            // Dangling: names no record, id says Mara Vance.
            { target: 'Mara', type: 'client', notes: '', source: 'manual', targetEntityId: maraId, subjectEntityId: jonahId },
            // Conflict: names a REAL different record than the id claims.
            { target: 'Jonah', type: 'self', notes: '', source: 'manual', targetEntityId: maraId, subjectEntityId: jonahId },
        ];
        saveRelationships(rels);

        const result = repairEntityLinks();
        expect(result.targetsRepointed).toBe(1);
        expect(result.conflicts.some(c => c.kind === 'target-conflict')).toBe(true);
        const healed = getRelationships().Jonah;
        expect(healed.find(e => e.type === 'client').target).toBe('Mara Vance');
        expect(healed.find(e => e.type === 'self').target).toBe('Jonah'); // untouched
    });

    test('legacy edges without ids get them stamped by the repair pass', () => {
        seedNpc('Mara', { uid: 1 });
        seedNpc('Jonah', { uid: 2 });
        const rels = getRelationships();
        rels['Mara'] = [{ target: 'Jonah', type: 'friend', notes: '', source: 'manual' }];
        saveRelationships(rels);

        const result = repairEntityLinks();
        expect(result.idsStamped).toBeGreaterThanOrEqual(2); // subject + target
        const edge = getRelationships().Mara[0];
        expect(edge.subjectEntityId).toBe(getRegistry().Mara.entityId);
        expect(edge.targetEntityId).toBe(getRegistry().Jonah.entityId);
    });
});



