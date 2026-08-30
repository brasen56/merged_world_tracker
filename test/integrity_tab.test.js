/**
 * test/integrity_tab.test.js — Diagnostics Phase 12 (Tab 7: Integrity).
 *
 * Covers the layers of the Integrity tab, mirroring the Phase 6–11 suites:
 *   1. diagnostics_panel/integrity.js — integritySample() capping;
 *      INTEGRITY_STORE_SPECS derived from the METADATA_KEYS whitelist (no
 *      second list); collectIntegritySnapshot() with injected deps (empty
 *      world, duplicate profiles, dangling profileUid pointers, the
 *      evidence↔profile join incl. the registry-alias path, per-store
 *      validateSection() rows with the REAL validator, Interiority ledger
 *      reference integrity, the empty-book unreliability guard, per-check
 *      degradation, no mutation of the live inputs); redactIntegritySnapshot()
 *      (known-secret exact scrub in free strings, NPC names survive, no
 *      mutation / no shared references).
 *   2. diagnostics_panel/render.js — renderIntegrityPane() idle markup (the
 *      on-demand contract: a Run button, never live data); renderIntegritySnapshot()
 *      string builders (stat header, verdict banner, warning list, per-check
 *      cards with counts/samples/“more” tails, escaping, zero + unreliable
 *      states); runIntegrityChecks() + copyIntegritySnapshotJson() wiring
 *      helpers driven with element-like fakes (the applyLogViewFilters
 *      precedent); the pane switch that mounts the seventh sub-tab.
 *
 * The final smoke test exercises the DEFAULT wiring (real module graph under
 * the barrel→stub alias) — it exists to catch import-graph breakage, not to
 * assert live values.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
    collectIntegritySnapshot,
    redactIntegritySnapshot,
    integritySample,
    INTEGRITY_SAMPLE_LIMIT,
    INTEGRITY_STORE_SPECS,
} from '../diagnostics_panel/integrity.js';
import {
    renderIntegrityPane,
    renderIntegritySnapshot,
    renderDiagnosticsPanel,
    runIntegrityChecks,
    copyIntegritySnapshotJson,
} from '../diagnostics_panel/render.js';
import { METADATA_KEYS } from '../backup/data.js';
// Part 5 (§9.2): the registry is the enumeration source the specs derive from.
import { CHAT_METADATA_SCHEMA_IDS } from '../schema/registry.js';
import { resetCoreStubs } from './stubs/core.js';

beforeEach(() => {
    resetCoreStubs();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Deterministic snapshot clock. */
const NOW = 2_000_000;

/** A fully-shaped evidence observation (the real validator runs on meta too). */
const obs = (id) => ({ id, category: 'fact', claim: `claim ${id}`, quote: `quote ${id}`, msgIdx: 1, ts: 1 });

/** One evidence file, tier-count parameterised. */
const evidenceFile = (raw = 1, consolidated = 0, archivedRaw = 0) => ({
    raw: Array.from({ length: raw }, (_, i) => obs(`r${i}`)),
    consolidated: Array.from({ length: consolidated }, (_, i) => ({ id: `c${i}`, claim: `c ${i}`, sources: [`r${i}`] })),
    archivedRaw: Array.from({ length: archivedRaw }, (_, i) => obs(`a${i}`)),
});

/** The world the collector reads: every input in one object. */
const world = (over = {}) => ({
    profiles: [],
    registry: {},
    meta: {},
    ledger: [],
    tombstones: [],
    // isIntentionDeleted matches: [npc, action] pairs.
    deleted: [],
    ...over,
});

/** Default deps: everything injected except validateSection + stores (real). */
const deps = (w = world(), over = {}) => ({
    now: () => NOW,
    version: '9.9.9-test',
    listProfileEntries: async () => w.profiles,
    getRegistry: () => w.registry,
    getChatMeta: () => w.meta,
    getLedger: () => w.ledger,
    getDeletedIntentions: () => w.tombstones,
    isIntentionDeleted: (npc, action) => w.deleted.some(([n, a]) => n === npc && a === action),
    ...over,
});

/** Minimal element-like fake (the Phase 11 wiring-test pattern). */
const fakeEl = (over = {}) => {
    const listeners = {};
    return {
        innerHTML: '',
        disabled: false,
        textContent: '▶ Run integrity checks',
        addEventListener(evt, fn) { listeners[evt] = fn; },
        _listeners: listeners,
        ...over,
    };
};

/** Result container fake exposing the copy button like the real markup. */
const fakeResult = () => {
    const copyBtn = fakeEl();
    const el = fakeEl();
    el.querySelector = (sel) => (sel === '[data-diag-int-copy]' ? copyBtn : null);
    el._copyBtn = copyBtn;
    return el;
};

// ─── integritySample + store specs ────────────────────────────────────────────

describe('integritySample', () => {
    test('keeps the first INTEGRITY_SAMPLE_LIMIT rows and folds the rest into `more`', () => {
        const items = Array.from({ length: INTEGRITY_SAMPLE_LIMIT + 3 }, (_, i) => i);
        const out = integritySample(items);
        expect(out.sample).toEqual([0, 1, 2, 3, 4]);
        expect(out.more).toBe(3);
    });

    test('non-arrays degrade to empty, never throw', () => {
        expect(integritySample(null)).toEqual({ sample: [], more: 0 });
        expect(integritySample('nope')).toEqual({ sample: [], more: 0 });
    });
});

describe('INTEGRITY_STORE_SPECS', () => {
    test('is enumerated from the schema registry — no second list to drift (§9.2)', () => {
        // Part 5: the enumeration source moved from the METADATA_KEYS
        // whitelist to schema/registry.js — the registry is the single owner
        // (ids AND metadata keys). The METADATA_KEYS equivalence still holds
        // and is pinned here, because the two agreeing IS the invariant that
        // made the switch safe.
        expect(INTEGRITY_STORE_SPECS.map((s) => s.id)).toEqual(Object.keys(METADATA_KEYS));
        expect(INTEGRITY_STORE_SPECS.map((s) => s.key)).toEqual(Object.values(METADATA_KEYS));
        expect(INTEGRITY_STORE_SPECS.map((s) => s.id)).toEqual(CHAT_METADATA_SCHEMA_IDS);
        for (const spec of INTEGRITY_STORE_SPECS) {
            expect(typeof spec.label).toBe('string');
            expect(spec.label.length).toBeGreaterThan(0);
        }
    });
});

// ─── collectIntegritySnapshot ─────────────────────────────────────────────────

describe('collectIntegritySnapshot', () => {
    test('empty world: zero findings, ok banner, every store section absent, no errors', async () => {
        const snap = await collectIntegritySnapshot(deps());
        expect(snap.mwtVersion).toBe('9.9.9-test');
        expect(snap.generatedAt).toBe(NOW);
        expect(snap.bannerLevel).toBe('ok');
        expect(snap.warnings).toEqual([]);
        expect(snap.totals.findings).toBe(0);
        expect(snap.errors).toBeUndefined();
        // Part 5 (§9.2): the Knowledge lorebook store now has its OWN rows —
        // one per book, since the store spans the Knowledge AND the State
        // Tracker book. Neither is hydrated in this Node world, so both are
        // dim not-checked readings, never findings and never counted as
        // present.
        expect(snap.storeValidations.sections.map((r) => [r.id, r.present])).toEqual([
            ['worldState', false], ['chronicle', false], ['knowledgeEvidence', false],
            ['knowledgeCounters', false], ['storyPlanner', false], ['interiority', false],
            ['knowledgeStore', false], ['knowledgeStore', false],
        ]);
        expect(snap.totals.sectionsPresent).toBe(0);
        const knowledgeRows = snap.storeValidations.sections.filter((r) => r.id === 'knowledgeStore');
        expect(knowledgeRows.map((r) => r.book)).toEqual(['Knowledge Tracker', 'State Tracker']);
        for (const row of knowledgeRows) {
            expect(row.checked).toBe(false);
            expect(row.reason).toBe('not-hydrated');
        }
    });

    test('the Knowledge lorebook store validates BOTH books when both are hydrated', async () => {
        const snap = await collectIntegritySnapshot(deps(world(), {
            knowledgeBooks: () => ({
                books: [
                    { name: 'Knowledge Tracker', role: 'knowledge' },
                    { name: 'State Tracker', role: 'state' },
                ],
                mode: 'global',
            }),
            knowledgePeek: () => ({ hydrated: true, dirty: false, version: 1 }),
            knowledgePeekData: (name) => (name === 'State Tracker'
                ? { version: 1, stateRegistry: { Weather: { uid: 3 } } }
                : { version: 1, registry: { Mara: { uid: 1 } }, relationships: {} }),
        }));
        const lorebookRows = snap.storeValidations.sections.filter((r) => r.id === 'knowledgeStore');
        expect(lorebookRows).toHaveLength(2);
        expect(lorebookRows.map((r) => r.book)).toEqual(['Knowledge Tracker', 'State Tracker']);
        expect(lorebookRows[0].label).toContain('Knowledge lorebook store');
        expect(lorebookRows[1].label).toContain('State Tracker lorebook store');
        // Both validated from their read-only cache copies.
        for (const row of lorebookRows) {
            expect(row.checked).not.toBe(false);
            expect(row.present).toBe(true);
            expect(row.lorebook).toBe(true);
            expect(row.storeVersion).toBe(1);
        }
    });

    test('duplicate profiles: counts entries, samples per group, flags the referenced uid', async () => {
        const snap = await collectIntegritySnapshot(deps(world({
            profiles: [
                { uid: 1, name: 'Mara Vance', chars: 900 },
                { uid: 2, name: 'mara vance', chars: 400 },
                { uid: 3, name: 'Kira', chars: 100 },
            ],
            registry: { 'Kira': { uid: 9, type: 'npc', profileUid: 3 } },
        })));
        expect(snap.duplicateProfiles.count).toBe(2); // ENTRIES, not groups
        expect(snap.duplicateProfiles.groups).toBe(1);
        const group = snap.duplicateProfiles.sample[0];
        expect(group.npc).toBe('Mara Vance');
        expect(group.count).toBe(2);
        expect(group.entries.map((e) => e.uid)).toEqual([1, 2]);
        expect(group.entries.map((e) => e.referenced)).toEqual([false, false]);
        expect(snap.warnings.map((w) => w.id)).toContain('duplicate-profiles');
        expect(snap.bannerLevel).toBe('warn');
    });

    test('unnamed profile entries are counted, never grouped (the prune rationale)', async () => {
        const snap = await collectIntegritySnapshot(deps(world({
            profiles: [{ uid: 5, name: '', chars: 10 }, { uid: 6, name: '   ', chars: 5 }],
        })));
        expect(snap.duplicateProfiles.unnamed).toBe(2);
        expect(snap.duplicateProfiles.count).toBe(0);
    });

    test('dangling profileUid: registry pointer whose target entry is gone', async () => {
        const snap = await collectIntegritySnapshot(deps(world({
            profiles: [{ uid: 1, name: 'Mara Vance', chars: 900 }],
            registry: {
                'Mara Vance': { uid: 7, type: 'npc', profileUid: 99 }, // gone
                'Kira': { uid: 8, type: 'npc', profileUid: 1 },         // not Mara's, but exists → not dangling
            },
        })));
        expect(snap.danglingProfileUids.count).toBe(1);
        expect(snap.danglingProfileUids.sample[0]).toEqual({
            npc: 'Mara Vance', registryKey: 'Mara Vance', profileUid: 99, registryUid: 7,
        });
        expect(snap.warnings.map((w) => w.id)).toContain('dangling-profile-uids');
    });

    test('evidence↔profile join, both directions, incl. the registry-alias path', async () => {
        const snap = await collectIntegritySnapshot(deps(world({
            profiles: [
                { uid: 1, name: 'Mara Vance', chars: 900 }, // joins evidence "Mara" through the registry
                { uid: 2, name: 'Boris', chars: 300 },       // profile with NO evidence → warn-worthy
            ],
            registry: { 'Mara Vance': { uid: 7, type: 'npc' } },
            meta: { knowledge_growth_evidence: { Mara: evidenceFile(2, 1, 3) } },
        })));
        // "Mara" resolved through the real resolveRegistryKey to "Mara Vance".
        expect(snap.evidenceWithoutProfile.count).toBe(0);
        expect(snap.profilesWithoutEvidence.count).toBe(1);
        expect(snap.profilesWithoutEvidence.sample[0]).toEqual({ npc: 'Boris', uid: 2, chars: 300 });
        const ids = snap.warnings.map((w) => w.id);
        expect(ids).toContain('profiles-without-evidence');
        // evidence-without-profile is a READING — never a warning.
    });

    test('evidence with no profile is a reading (counted, not warned)', async () => {
        const snap = await collectIntegritySnapshot(deps(world({
            profiles: [],
            registry: {},
            meta: { knowledge_growth_evidence: { Kira: evidenceFile(2, 0, 1) } },
        })));
        // Empty book BUT nothing contradicts it (no registry pointers) → reliable.
        expect(snap.evidenceWithoutProfile.unreliable).toBeUndefined();
        expect(snap.evidenceWithoutProfile.count).toBe(1);
        expect(snap.evidenceWithoutProfile.sample[0]).toEqual({ npc: 'Kira', raw: 2, consolidated: 0, archivedRaw: 1 });
        expect(snap.warnings.map((w) => w.id)).not.toContain('evidence-without-profile');
    });

    test('validateSection rows come from the REAL validator over live meta', async () => {
        const snap = await collectIntegritySnapshot(deps(world({
            meta: {
                story_planner_data: {
                    arcs: [
                        { id: 'ok1', section: 'immediate', status: 'active', beats: [], beatIndex: 0, turnsSinceAdvance: 0, createdAt: 1, updatedAt: 1 },
                        { id: '', section: 'immediate', status: 'active' }, // skipped (id check fires first)
                    ],
                },
                mwt_interiority: {
                    ledger: [
                        { id: 'i1', npc: 'A', action: 'x', trigger: 'y' },
                        { id: 'i1', npc: 'A', action: 'x', trigger: 'y' }, // conflict + skip
                    ],
                },
            },
        })));
        const byId = Object.fromEntries(snap.storeValidations.sections.map((r) => [r.id, r]));
        expect(byId.storyPlanner.present).toBe(true);
        expect(byId.storyPlanner.added).toBe(1);
        expect(byId.storyPlanner.skippedCount).toBe(1);
        expect(byId.storyPlanner.reasons).toEqual(['Arc id must be a non-empty string.']);
        expect(byId.interiority.conflicts).toBe(1);
        expect(snap.storeValidations.skippedTotal).toBe(2);
        expect(snap.storeValidations.conflictsTotal).toBe(1);
        expect(snap.totals.sectionsPresent).toBe(2);
        const ids = snap.warnings.map((w) => w.id);
        expect(ids).toContain('store-validation-skipped');
        expect(ids).toContain('store-validation-conflicts');
        // Quarantined RECORDS never enter the snapshot — only reason strings.
        expect(JSON.stringify(snap)).not.toContain('claim ok');
    });

    test('interiority integrity: dup ledger ids, tombstoned-but-live, dup tombstone ids', async () => {
        const snap = await collectIntegritySnapshot(deps(world({
            ledger: [
                { id: 'L1', npc: 'Mara', action: 'call Dorothy', trigger: 'Monday' },
                { id: 'L1', npc: 'Mara', action: 'sneak out', trigger: 'dusk' },
                { id: 'L2', npc: 'Kira', action: 'steal the key', trigger: 'night' }, // tombstoned but alive
            ],
            tombstones: [
                { id: 'T1', npc: 'kira', actions: ['steal the key'], triggers: ['night'], at: 1 },
                { id: 'T1', npc: 'boris', actions: ['flee'], triggers: [], at: 2 },
            ],
            deleted: [['Kira', 'steal the key']],
        })));
        expect(snap.interiority.ledgerEntries).toBe(3);
        expect(snap.interiority.tombstones).toBe(2);
        expect(snap.interiority.duplicateLedgerIds.count).toBe(1);
        expect(snap.interiority.duplicateLedgerIds.sample[0]).toEqual({ id: 'L1', occurrences: 2 });
        expect(snap.interiority.tombstonedStillInLedger.count).toBe(1);
        expect(snap.interiority.tombstonedStillInLedger.sample[0]).toEqual({
            id: 'L2', npc: 'Kira', action: 'steal the key',
        });
        expect(snap.interiority.duplicateTombstoneIds.count).toBe(1);
        const ids = snap.warnings.map((w) => w.id);
        expect(ids).toContain('duplicate-ledger-ids');
        expect(ids).toContain('tombstoned-intention-live');
        expect(ids).toContain('duplicate-tombstone-ids');
    });

    test('empty profile book over a non-empty registry: checks skip as unreliable, one warning', async () => {
        const snap = await collectIntegritySnapshot(deps(world({
            profiles: [], // book unreadable / empty
            registry: { 'Mara Vance': { uid: 7, type: 'npc', profileUid: 4 } },
        })));
        expect(snap.danglingProfileUids.unreliable).toBe(true);
        expect(snap.danglingProfileUids.count).toBe(0);
        expect(snap.evidenceWithoutProfile.unreliable).toBe(true);
        expect(snap.profilesWithoutEvidence.unreliable).toBe(true);
        expect(snap.warnings.map((w) => w.id)).toContain('profile-book-unreadable');
        expect(snap.warnings.map((w) => w.id)).not.toContain('dangling-profile-uids');
    });

    test('a throwing dependency degrades its own check, never the snapshot', async () => {
        const snap = await collectIntegritySnapshot(deps(world(), {
            getRegistry: () => { throw new Error('registry blew up'); },
        }));
        expect(snap.errors).toEqual([expect.stringContaining('getRegistry: registry blew up')]);
        expect(snap.warnings.map((w) => w.id)).toContain('check-degraded');
        expect(snap.duplicateProfiles.count).toBe(0);
        expect(snap.totals.findings).toBe(0);
        expect(snap.mwtVersion).toBe('9.9.9-test');
    });

    test('read-only: the live inputs are never mutated', async () => {
        const w = world({
            profiles: [{ uid: 1, name: 'Mara Vance', chars: 900 }],
            registry: { 'Mara Vance': { uid: 7, type: 'npc', profileUid: 99 } },
            meta: { knowledge_growth_evidence: { Mara: evidenceFile(1) } },
            ledger: [{ id: 'L1', npc: 'Mara', action: 'a', trigger: 't' }],
            tombstones: [{ id: 'T1', npc: 'mara', actions: ['a'], triggers: ['t'], at: 1 }],
        });
        const before = JSON.stringify(w);
        await collectIntegritySnapshot(deps(w));
        expect(JSON.stringify(w)).toBe(before);
    });
});

// ─── redactIntegritySnapshot ──────────────────────────────────────────────────

describe('redactIntegritySnapshot', () => {
    test('known secret VALUES are struck out of free strings; NPC names survive', () => {
        const snap = {
            mwtVersion: '9.9.9-test',
            danglingProfileUids: { count: 1, sample: [{ npc: 'hunter2-secret', profileUid: 5, registryUid: 1 }], more: 0 },
            storeValidations: { sections: [], skippedTotal: 0, conflictsTotal: 0 },
        };
        const out = redactIntegritySnapshot(snap, { knownSecrets: ['hunter2-secret'] });
        expect(out.danglingProfileUids.sample[0].npc).toBe('[REDACTED]');
        // A normal NPC name is an identity string — it stays readable.
        const snap2 = { danglingProfileUids: { count: 1, sample: [{ npc: 'Mara Vance', profileUid: 5 }], more: 0 } };
        expect(redactIntegritySnapshot(snap2, { knownSecrets: ['hunter2-secret'] }).danglingProfileUids.sample[0].npc).toBe('Mara Vance');
    });

    test('no mutation, no shared references', () => {
        const snap = { danglingProfileUids: { count: 1, sample: [{ npc: 'Mara' }], more: 0 } };
        const out = redactIntegritySnapshot(snap, { knownSecrets: [] });
        expect(snap.danglingProfileUids.sample[0].npc).toBe('Mara');
        out.danglingProfileUids.sample[0].npc = 'MUTATED';
        expect(snap.danglingProfileUids.sample[0].npc).toBe('Mara');
    });
});

// ─── renderIntegrityPane (the idle / on-demand contract) ──────────────────────

describe('renderIntegrityPane', () => {
    test('renders the Run button and idle note — never live data (on-demand only)', () => {
        const html = renderIntegrityPane();
        expect(html).toContain('mwt-diag-int');
        expect(html).toContain('data-diag-int-run="1"');
        expect(html).toContain('data-diag-int-idle');
        expect(html).toContain('Not run yet');
        expect(html).toContain('O(entries)');
        // No results markup at idle — the run wiring builds that.
        expect(html).not.toContain('data-diag-int-run-result');
        expect(html).not.toContain('data-diag-int-copy');
    });
});

// ─── renderIntegritySnapshot ──────────────────────────────────────────────────

describe('renderIntegritySnapshot', () => {
    // A findings-everywhere snapshot, collected then redacted like the pane does.
    const richWorld = () => world({
        profiles: [
            { uid: 1, name: 'Mara Vance', chars: 900 },
            { uid: 2, name: 'Mara Vance', chars: 400 },
            { uid: 3, name: 'Boris', chars: 300 },
        ],
        registry: {
            'Mara Vance': { uid: 7, type: 'npc', profileUid: 99 },
            Boris: { uid: 8, type: 'npc' },
        },
        meta: {
            knowledge_growth_evidence: { Kira: evidenceFile(2, 0, 1) },
            story_planner_data: { arcs: [{ id: '', section: 'immediate', status: 'active' }] },
        },
        ledger: [
            { id: 'L1', npc: 'Mara', action: 'a', trigger: 't' },
            { id: 'L1', npc: 'Mara', action: 'b', trigger: 't' },
            { id: 'L2', npc: 'Kira', action: 'steal', trigger: 'night' },
        ],
        tombstones: [{ id: 'T1', npc: 'kira', actions: ['steal'], triggers: ['night'], at: 1 }],
        deleted: [['Kira', 'steal']],
    });

    test('stat header, warn banner, warning list, every card, copy button', async () => {
        const snap = redactIntegritySnapshot(await collectIntegritySnapshot(deps(richWorld())), { knownSecrets: [] });
        const html = renderIntegritySnapshot(snap, { formatTime: () => '12:00:00' });
        expect(html).toContain('MWT v9.9.9-test');
        expect(html).toContain('run at 12:00:00');
        expect(html).toContain('mwt-diag-scope-banner--warn');
        expect(html).toContain('<code>dangling-profile-uids</code>'); // warning list entries
        expect(html).toContain('Duplicate profile entries');
        expect(html).toContain('Dangling profileUid pointers');
        expect(html).toContain('Evidence with no profile');
        expect(html).toContain('Profiles with no evidence');
        expect(html).toContain('Store validation (validateSection per store)');
        expect(html).toContain('Interiority ledger integrity');
        expect(html).toContain('data-diag-int-copy="1"');
        expect(html).toContain('Arc id must be a non-empty string.'); // reason sample
        expect(html).toContain('tombstoned but still live');
    });

    test('NPC names render escaped; hostile names cannot inject markup', async () => {
        const evil = '<img src=x onerror=alert(1)>';
        const snap = redactIntegritySnapshot(await collectIntegritySnapshot(deps(world({
            profiles: [{ uid: 1, name: evil, chars: 10 }],
        }))), { knownSecrets: [] });
        const html = renderIntegritySnapshot(snap, { formatTime: () => '12:00:00' });
        expect(html).not.toContain(`<img src=x onerror=alert(1)>`);
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });

    test('clean snapshot: ok banner, zero badges, zero-text placeholders', async () => {
        const snap = redactIntegritySnapshot(await collectIntegritySnapshot(deps()), { knownSecrets: [] });
        const html = renderIntegritySnapshot(snap, { formatTime: () => '12:00:00' });
        expect(html).toContain('mwt-diag-scope-banner--ok');
        expect(html).toContain('None found.');
        expect(html).not.toContain('mwt-diag-scope-warnings');
    });

    test('unreliable checks show the unreliable badge and no zero-text verdict', async () => {
        const snap = redactIntegritySnapshot(await collectIntegritySnapshot(deps(world({
            registry: { 'Mara Vance': { uid: 7, type: 'npc', profileUid: 4 } },
        }))), { knownSecrets: [] });
        const html = renderIntegritySnapshot(snap, { formatTime: () => '12:00:00' });
        expect(html).toContain('unreliable');
    });

    test('“more” tails fold sampled-out findings behind the copy escape hatch', async () => {
        const profiles = Array.from({ length: 9 }, (_, i) => ({ uid: i + 1, name: 'Mara Vance', chars: 100 }));
        const snap = redactIntegritySnapshot(await collectIntegritySnapshot(deps(world({ profiles }))), { knownSecrets: [] });
        expect(snap.duplicateProfiles.count).toBe(9);
        expect(snap.duplicateProfiles.more).toBe(0); // one GROUP, sampled whole
        const profiles2 = Array.from({ length: 8 }, (_, i) => ({ uid: i + 1, name: `NPC${i} <x>`, chars: 100 }))
            .concat(Array.from({ length: 7 }, (_, i) => ({ uid: 100 + i, name: `Dup${i}`, chars: 100 + i }))
                .concat(Array.from({ length: 7 }, (_, i) => ({ uid: 200 + i, name: `Dup${i}`, chars: 200 + i }))));
        const snap2 = await collectIntegritySnapshot(deps(world({ profiles: profiles2 })));
        expect(snap2.duplicateProfiles.more).toBeGreaterThan(0);
        const html = renderIntegritySnapshot(redactIntegritySnapshot(snap2, { knownSecrets: [] }), { formatTime: () => '12:00:00' });
        expect(html).toContain('Copy full JSON');
        expect(html).toMatch(/and \d+ group\(s\) not shown/);
    });
});

// ─── Wiring helpers ───────────────────────────────────────────────────────────

describe('runIntegrityChecks', () => {
    test('collect → render → re-enable → status; wires the copy button to the run snapshot', async () => {
        const button = fakeEl();
        const result = fakeResult();
        const statuses = [];
        const copies = [];
        const snap = await collectIntegritySnapshot(deps(world({
            profiles: [{ uid: 1, name: 'Boris', chars: 10 }],
            // Boris has evidence → zero findings → the success-type status.
            meta: { knowledge_growth_evidence: { Boris: evidenceFile(1) } },
        })));
        await runIntegrityChecks(button, result, {
            collect: async () => snap,
            redact: (v) => v,
            copy: async (text) => { copies.push(text); return true; },
            status: (message, type) => statuses.push([message, type]),
        });
        expect(result.innerHTML).toContain('mwt-diag-int');
        // Zero findings → no sample rows, but the stat header carries the
        // checked totals from THIS run.
        expect(result.innerHTML).toContain('<strong>1</strong> profile entries');
        expect(button.disabled).toBe(false);
        expect(button.textContent).toBe('▶ Run again');
        expect(statuses.at(-1)[1]).toBe('success'); // zero findings
        // The copy button was wired against THIS run's snapshot.
        expect(typeof result._copyBtn._listeners.click).toBe('function');
        result._copyBtn._listeners.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(copies).toHaveLength(1);
        expect(JSON.parse(copies[0]).totals.profileEntries).toBe(1);
    });

    test('warn findings route a warning-type status', async () => {
        const button = fakeEl();
        const result = fakeResult();
        const statuses = [];
        const snap = await collectIntegritySnapshot(deps(world({
            registry: { 'Mara Vance': { uid: 7, type: 'npc', profileUid: 99 } },
            profiles: [{ uid: 1, name: 'Mara Vance', chars: 900 }],
        })));
        await runIntegrityChecks(button, result, {
            collect: async () => snap,
            redact: (v) => v,
            status: (message, type) => statuses.push([message, type]),
        });
        expect(statuses.at(-1)[1]).toBe('warning');
    });

    test('a failed collection degrades to an error card + error status, button restored', async () => {
        const button = fakeEl();
        const result = fakeResult();
        const statuses = [];
        await runIntegrityChecks(button, result, {
            collect: async () => { throw new Error('book read failed'); },
            status: (message, type) => statuses.push([message, type]),
        });
        expect(result.innerHTML).toContain('Integrity run failed');
        expect(result.innerHTML).toContain('book read failed');
        expect(button.disabled).toBe(false);
        expect(statuses.at(-1)[1]).toBe('error');
    });

    test('no-ops without a button or a result container', async () => {
        await expect(runIntegrityChecks(null, fakeResult())).resolves.toBeUndefined();
        await expect(runIntegrityChecks(fakeEl(), null)).resolves.toBeUndefined();
    });
});

describe('copyIntegritySnapshotJson', () => {
    test('copies pretty JSON and reports success', async () => {
        const copies = [];
        const statuses = [];
        const out = await copyIntegritySnapshotJson({ a: 1 }, {
            copy: async (text) => { copies.push(text); return true; },
            status: (message, type) => statuses.push([message, type]),
        });
        expect(out).toBe('{\n  "a": 1\n}');
        expect(statuses.at(-1)[1]).toBe('success');
    });

    test('a failed copy dumps the JSON to the console (the escape hatch) and errors', async () => {
        const statuses = [];
        const out = await copyIntegritySnapshotJson({ a: 1 }, {
            copy: async () => false,
            status: (message, type) => statuses.push([message, type]),
        });
        expect(out).toBeNull();
        expect(statuses.at(-1)[1]).toBe('error');
        expect(console.warn).toHaveBeenCalled();
    });
});

// ─── Pane mounting + default-wiring smoke ─────────────────────────────────────

describe('pane mounting + default wiring', () => {
    test('renderDiagnosticsPanel() mounts the seventh sub-tab with no placeholders left', () => {
        const html = renderDiagnosticsPanel();
        expect(html).toContain('data-diag-tab="integrity"');
        expect(html).toContain('mwt-diag-int-run');
        expect(html).not.toContain('— not built yet');
    });

    test('collects against the real module graph under the stub barrel without throwing', async () => {
        const snap = await collectIntegritySnapshot();
        expect(snap.bannerLevel).toBe('ok');
        expect(snap.totals.findings).toBe(0);
        expect(Array.isArray(snap.storeValidations.sections)).toBe(true);
    });
});
