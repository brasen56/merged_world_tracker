/**
 * test/relationship_extract.test.js — Automatic relationship extraction.
 *
 * The pure `applyExtractedRelationships(result)` is the only piece worth unit-
 * testing directly: it validates a parsed model output against the registry +
 * canonical enums, then applies edges/stances via the existing CRUD helpers.
 * Properties worth protecting:
 *   1. Only edges whose BOTH endpoints are known NPCs are applied.
 *   2. Given-name variants canonicalize to the registry key.
 *   3. Non-canonical types / stances are dropped, never stored.
 *   4. Existing edges are UPDATED, not duplicated.
 *   5. Manual edits are preserved — extraction never deletes.
 *   6. Idempotent: re-running the same extraction reports no changes.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// The extract path runs the model output through normaliseOutput/parseJsonLenient,
// which the core stub leaves unimplemented (they live in core/api.js, which pulls
// in the ST-dependent modules the stub exists to avoid). Fill in just those two
// locally — everything else passes through, including the REAL captureScope /
// assertSameScope / bumpEpoch, which is the whole point of the scope test below.
vi.mock('../core/index.js', async (importOriginal) => ({
    ...await importOriginal(),
    normaliseOutput: (raw) => String(raw ?? '').trim(),
    parseJsonLenient: (raw) => JSON.parse(raw),
}));

import { resetCoreStubs, setFakeChat, bumpEpoch, _resetEpoch } from './stubs/core.js';
import { _clearCacheForTests, _setCacheForTests } from '../knowledge/store.js';
import { getLorebookName } from '../knowledge/scope.js';
import { saveSettings } from '../knowledge/settings.js';
import {
    applyExtractedRelationships, runRelationshipExtract,
    getNpcRelationships, addRelationship, updateRelationship, getRelationships,
    getStance, setStance, getStances,
    isEdgeAutoManaged, isStanceAutoManaged, toggleEdgeSource, toggleStanceSource,
    SOURCE_AUTO, SOURCE_MANUAL,
} from '../knowledge/relationships.js';

// runRelationshipExtract pulls ktFetchFromApi off lorebook.js via a dynamic
// import; stubbing the module keeps the test off the network.
const mockFetch = vi.fn();
vi.mock('../knowledge/lorebook.js', () => ({
    ktFetchFromApi: (...args) => mockFetch(...args),
}));

/** Build a registry map where each name is a tracked NPC. */
function seedRegistry(names) {
    const reg = {};
    let uid = 1;
    for (const name of names) {
        reg[name] = { uid: uid++, type: 'major', keywords: [name], lastUpdated: 0 };
    }
    return reg;
}

beforeEach(() => {
    resetCoreStubs();
    _clearCacheForTests();
    // Mark the knowledge book hydrated and seed a registry so writes are
    // accepted and getRegistryEntry has entries to resolve against.
    _setCacheForTests(getLorebookName(), { registry: seedRegistry(['Mara', 'Jonah', 'Beck']) });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('applyExtractedRelationships — edges', () => {
    test('adds an edge between two known NPCs', () => {
        const r = applyExtractedRelationships({ edges: [{ from: 'Mara', to: 'Jonah', type: 'friend', notes: 'childhood' }] });
        expect(r.edgesAdded).toBe(1);
        expect(r.edgesUpdated).toBe(0);
        expect(r.skipped).toBe(0);
        expect([...r.affectedNpcs]).toEqual(['Mara']);
        const edges = getNpcRelationships('Mara');
        expect(edges).toHaveLength(1);
        // Extractor-created edges are stamped `auto`, which is what makes them
        // eligible for a later pass to update. See the provenance suite below.
        expect(edges[0]).toEqual({ target: 'Jonah', type: 'friend', notes: 'childhood', source: SOURCE_AUTO });
    });

    test('skips an edge with an unknown endpoint', () => {
        const r = applyExtractedRelationships({ edges: [{ from: 'Mara', to: 'Ghost', type: 'friend' }] });
        expect(r.edgesAdded).toBe(0);
        expect(r.skipped).toBe(1);
        expect(getNpcRelationships('Mara')).toHaveLength(0);
    });

    test('skips an edge with a non-canonical type', () => {
        const r = applyExtractedRelationships({ edges: [{ from: 'Mara', to: 'Jonah', type: 'besties' }] });
        expect(r.edgesAdded).toBe(0);
        expect(r.skipped).toBe(1);
        expect(getNpcRelationships('Mara')).toHaveLength(0);
    });

    test('canonicalizes a given name to the registry key', () => {
        _setCacheForTests(getLorebookName(), { registry: seedRegistry(['Mara Vance', 'Jonah']) });
        // Model emits the given name "Mara"; the edge must be stored under the
        // canonical key "Mara Vance" and point at the canonical "Jonah".
        const r = applyExtractedRelationships({ edges: [{ from: 'Mara', to: 'Jonah', type: 'rival' }] });
        expect(r.edgesAdded).toBe(1);
        expect(getNpcRelationships('Mara Vance')).toEqual([{ target: 'Jonah', type: 'rival', notes: '', source: SOURCE_AUTO }]);
        expect(getNpcRelationships('Mara')).toHaveLength(0);
    });

    test('updates an existing edge without duplicating it', () => {
        // Seeded as `auto` so the extractor owns it — a manual edge is locked,
        // which is the subject of the provenance suite below rather than this one.
        addRelationship('Mara', 'Jonah', 'friend', '', SOURCE_AUTO);
        const r = applyExtractedRelationships({ edges: [{ from: 'Mara', to: 'Jonah', type: 'rival', notes: 'they fell out' }] });
        expect(r.edgesAdded).toBe(0);
        expect(r.edgesUpdated).toBe(1);
        const edges = getNpcRelationships('Mara');
        expect(edges).toHaveLength(1);
        expect(edges[0]).toEqual({ target: 'Jonah', type: 'rival', notes: 'they fell out', source: SOURCE_AUTO });
    });

    test('preserves a manually-added edge that is absent from the extract', () => {
        // Extraction only adds/updates; it must never delete a manual edge.
        addRelationship('Mara', 'Jonah', 'friend', 'manual');
        const r = applyExtractedRelationships({ edges: [{ from: 'Mara', to: 'Beck', type: 'mentor' }] });
        expect(r.edgesAdded).toBe(1);
        const edges = getNpcRelationships('Mara');
        expect(edges).toHaveLength(2);
        expect(edges.some(e => e.target === 'Jonah' && e.notes === 'manual')).toBe(true);
        expect(edges.some(e => e.target === 'Beck' && e.type === 'mentor')).toBe(true);
    });

    test('is idempotent — a second identical pass reports no changes', () => {
        const payload = { edges: [{ from: 'Mara', to: 'Jonah', type: 'friend', notes: 'x' }] };
        const first = applyExtractedRelationships(payload);
        expect(first.edgesAdded).toBe(1);
        const second = applyExtractedRelationships(payload);
        expect(second.edgesAdded).toBe(0);
        expect(second.edgesUpdated).toBe(0);
        expect(getNpcRelationships('Mara')).toHaveLength(1);
    });

    test('caps oversized notes to 280 characters', () => {
        const long = 'a'.repeat(400);
        applyExtractedRelationships({ edges: [{ from: 'Mara', to: 'Jonah', type: 'friend', notes: long }] });
        expect(getNpcRelationships('Mara')[0].notes.length).toBe(280);
    });
});

describe('applyExtractedRelationships — stances toward {{user}}', () => {
    test('sets a stance for a known NPC', () => {
        const r = applyExtractedRelationships({ stances: [{ npc: 'Mara', stance: 'wary' }] });
        expect(r.stancesSet).toBe(1);
        expect(getStance('Mara')).toBe('wary');
        expect([...r.affectedNpcs]).toEqual(['Mara']);
    });

    test('updates an existing stance to a new value', () => {
        // Seeded as `auto` for the same reason as the edge case above.
        setStance('Mara', 'friendly', SOURCE_AUTO);
        applyExtractedRelationships({ stances: [{ npc: 'Mara', stance: 'hostile' }] });
        expect(getStance('Mara')).toBe('hostile');
    });

    test('skips a stance with a non-canonical value', () => {
        applyExtractedRelationships({ stances: [{ npc: 'Mara', stance: 'smitten' }] });
        expect(getStance('Mara')).toBe('');
        expect(getStances()).not.toHaveProperty('Mara');
    });

    test('skips a stance for an unknown NPC', () => {
        applyExtractedRelationships({ stances: [{ npc: 'Ghost', stance: 'wary' }] });
        expect(getStances()).not.toHaveProperty('Ghost');
    });
});

describe('applyExtractedRelationships — manual records are protected', () => {
    // Guard A. The old "only adds or updates, never deletes" invariant protected
    // an edge's EXISTENCE but not its VALUE, so a model reading a quiet scene
    // could rewrite a hand-curated "family" to something else and it counted as
    // a legal update.
    test('will not overwrite a hand-entered edge', () => {
        addRelationship('Mara', 'Jonah', 'family', 'her brother'); // defaults to manual
        const r = applyExtractedRelationships({ edges: [{ from: 'Mara', to: 'Jonah', type: 'rival', notes: 'guessed' }] });
        expect(r.edgesUpdated).toBe(0);
        expect(r.skippedManual).toBe(1);
        expect(getNpcRelationships('Mara')[0]).toMatchObject({ type: 'family', notes: 'her brother' });
    });

    test('will not overwrite a hand-set stance', () => {
        setStance('Mara', 'caring');
        const r = applyExtractedRelationships({ stances: [{ npc: 'Mara', stance: 'hostile' }] });
        expect(r.stancesSet).toBe(0);
        expect(r.skippedManual).toBe(1);
        expect(getStance('Mara')).toBe('caring');
    });

    test('DOES update an edge it created itself', () => {
        applyExtractedRelationships({ edges: [{ from: 'Mara', to: 'Jonah', type: 'friend' }] });
        expect(isEdgeAutoManaged(getNpcRelationships('Mara')[0])).toBe(true);
        const r = applyExtractedRelationships({ edges: [{ from: 'Mara', to: 'Jonah', type: 'rival' }] });
        expect(r.edgesUpdated).toBe(1);
        expect(r.skippedManual).toBe(0);
        expect(getNpcRelationships('Mara')[0].type).toBe('rival');
    });

    test('fills an UNSET stance — nothing of the user\'s is at stake', () => {
        const r = applyExtractedRelationships({ stances: [{ npc: 'Mara', stance: 'wary' }] });
        expect(r.stancesSet).toBe(1);
        expect(isStanceAutoManaged('Mara')).toBe(true);
    });

    test('legacy records with no source are treated as MANUAL, not auto', () => {
        // The migration case that matters: auto-extraction shipped off by default,
        // so every pre-existing record was hand-entered. Reading absent-as-auto
        // would let the first run after upgrading wipe exactly what this protects.
        _setCacheForTests(getLorebookName(), {
            registry: seedRegistry(['Mara', 'Jonah']),
            relationships: { Mara: [{ target: 'Jonah', type: 'lover' }] }, // no `source`
            stances: { Mara: 'caring' },                                    // no stanceSources
        });
        const r = applyExtractedRelationships({
            edges: [{ from: 'Mara', to: 'Jonah', type: 'acquaintance' }],
            stances: [{ npc: 'Mara', stance: 'wary' }],
        });
        expect(r.skippedManual).toBe(2);
        expect(getNpcRelationships('Mara')[0].type).toBe('lover');
        expect(getStance('Mara')).toBe('caring');
    });

    test('a human editing an auto edge claims it, locking out future extraction', () => {
        applyExtractedRelationships({ edges: [{ from: 'Mara', to: 'Jonah', type: 'friend' }] });
        updateRelationship('Mara', 'Jonah', 'family', 'actually her brother'); // manual edit
        const r = applyExtractedRelationships({ edges: [{ from: 'Mara', to: 'Jonah', type: 'friend' }] });
        expect(r.skippedManual).toBe(1);
        expect(getNpcRelationships('Mara')[0].type).toBe('family');
    });

    test('the lock is releasable — a released edge becomes writable again', () => {
        addRelationship('Mara', 'Jonah', 'family', '');
        expect(toggleEdgeSource('Mara', 'Jonah')).toBe(SOURCE_AUTO);
        const r = applyExtractedRelationships({ edges: [{ from: 'Mara', to: 'Jonah', type: 'rival' }] });
        expect(r.edgesUpdated).toBe(1);
        expect(getNpcRelationships('Mara')[0].type).toBe('rival');
        // …and re-locking holds it again.
        expect(toggleEdgeSource('Mara', 'Jonah')).toBe(SOURCE_MANUAL);
        expect(applyExtractedRelationships({ edges: [{ from: 'Mara', to: 'Jonah', type: 'enemy' }] }).skippedManual).toBe(1);
    });

    test('a released stance becomes writable, and re-locking holds', () => {
        setStance('Mara', 'caring');
        expect(toggleStanceSource('Mara')).toBe(SOURCE_AUTO);
        expect(applyExtractedRelationships({ stances: [{ npc: 'Mara', stance: 'wary' }] }).stancesSet).toBe(1);
        expect(getStance('Mara')).toBe('wary');
        expect(toggleStanceSource('Mara')).toBe(SOURCE_MANUAL);
        expect(applyExtractedRelationships({ stances: [{ npc: 'Mara', stance: 'hostile' }] }).skippedManual).toBe(1);
    });
});

describe('applyExtractedRelationships — "neutral" is not a finding', () => {
    // Guard B. `neutral` is a legal enum member and it is what a model emits when
    // it has nothing to report, which is how a quiet scene flattens a graph.
    test('drops a neutral edge type instead of writing it', () => {
        const r = applyExtractedRelationships({ edges: [{ from: 'Mara', to: 'Jonah', type: 'neutral' }] });
        expect(r.edgesAdded).toBe(0);
        expect(r.skippedNeutral).toBe(1);
        expect(getNpcRelationships('Mara')).toHaveLength(0);
    });

    test('drops a neutral stance instead of writing it', () => {
        const r = applyExtractedRelationships({ stances: [{ npc: 'Mara', stance: 'neutral' }] });
        expect(r.stancesSet).toBe(0);
        expect(r.skippedNeutral).toBe(1);
        expect(getStances()).not.toHaveProperty('Mara');
    });

    test('a neutral cannot flatten an edge the extractor itself owns', () => {
        applyExtractedRelationships({ edges: [{ from: 'Mara', to: 'Jonah', type: 'lover' }] });
        const r = applyExtractedRelationships({ edges: [{ from: 'Mara', to: 'Jonah', type: 'neutral' }] });
        expect(r.edgesUpdated).toBe(0);
        expect(r.skippedNeutral).toBe(1);
        expect(getNpcRelationships('Mara')[0].type).toBe('lover');
    });

    test('the manual editor may still set neutral deliberately', () => {
        // Only the extractor treats neutral as noise; a human choosing it means it.
        updateRelationship('Mara', 'Jonah', 'neutral', 'they barely speak');
        expect(getNpcRelationships('Mara')[0].type).toBe('neutral');
        setStance('Mara', 'neutral');
        expect(getStance('Mara')).toBe('neutral');
    });
});

describe('applyExtractedRelationships — robustness', () => {
    test('empty / malformed result is a safe no-op', () => {
        const r = applyExtractedRelationships({});
        expect(r.edgesAdded + r.edgesUpdated + r.stancesSet).toBe(0);
        expect(r.affectedNpcs.size).toBe(0);
    });

    test('ignores non-array edges / stances without throwing', () => {
        const r = applyExtractedRelationships({ edges: 'nope', stances: 42 });
        expect(r.edgesAdded).toBe(0);
        expect(r.stancesSet).toBe(0);
    });
});

describe('runRelationshipExtract — chat-switch guard', () => {
    // The writes go through writeField(getLorebookName(), …), and
    // getLorebookName() resolves per chat/character under non-global scope. A
    // chat switch during the API call therefore has to abort BEFORE anything is
    // applied: the caller in knowledge/index.js also re-checks scope, but that
    // check runs after the writes have landed, so it can only discard the return
    // value — it cannot undo a set of edges merged into another chat's book.
    const PAYLOAD = JSON.stringify({
        edges: [{ from: 'Mara', to: 'Jonah', type: 'friend', notes: 'childhood' }],
        stances: [{ npc: 'Beck', stance: 'wary' }],
    });

    beforeEach(() => {
        mockFetch.mockReset();
        _resetEpoch();
        setFakeChat([
            { mes: 'An earlier scene.', name: 'Narrator', is_user: false },
            { mes: 'Beck lingers by the door.', name: 'Narrator', is_user: false },
            { mes: 'Mara greets Jonah warmly.', name: 'Narrator', is_user: false },
        ]);
        saveSettings({ apiUrl: 'https://example.invalid/v1', modelName: 'test-model' });
        // core/scope.js reads the chat id straight off the SillyTavern global,
        // not through the core stub. Without a resolvable id every identity is
        // "unknown", and getChatIdentity hands each unknown a fresh nonce so no
        // two ever compare equal — which would make the guard fire on every run
        // and the assertions below vacuous.
        globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'chat-A' }) };
    });

    afterEach(() => { delete globalThis.SillyTavern; });

    test('applies the extraction when the chat does not change', async () => {
        mockFetch.mockResolvedValue(PAYLOAD);
        const result = await runRelationshipExtract();
        expect(mockFetch).toHaveBeenCalledTimes(1);
        // The in-flight tail (the two most recent messages) must not reach the
        // model — it can still be swiped/discarded. Only the settled history
        // (here, the first of three messages) is sent in the prompt.
        const userContent = mockFetch.mock.calls[0][1];
        expect(userContent).toContain('An earlier scene.');
        expect(userContent).not.toContain('Beck lingers by the door.');
        expect(userContent).not.toContain('Mara greets Jonah warmly.');
        expect(result.edgesAdded).toBe(1);
        expect(result.stancesSet).toBe(1);
        expect(getNpcRelationships('Mara')).toEqual([{ target: 'Jonah', type: 'friend', notes: 'childhood', source: SOURCE_AUTO }]);
        expect(getStance('Beck')).toBe('wary');
    });

    test('performs zero writes when the chat switches during the API call', async () => {
        // Switch chats while the request is in flight, exactly as a user would.
        mockFetch.mockImplementation(async () => {
            bumpEpoch();
            return PAYLOAD;
        });
        const result = await runRelationshipExtract();
        expect(result.edgesAdded).toBe(0);
        expect(result.stancesSet).toBe(0);
        expect(result.affectedNpcs.size).toBe(0);
        // The store must be untouched — not merely "the result was discarded".
        expect(getRelationships()).toEqual({});
        expect(getStances()).toEqual({});
    });

    test('does not retry after a chat switch — the results belong to the old chat', async () => {
        mockFetch.mockImplementation(async () => {
            bumpEpoch();
            return 'not json at all';
        });
        const result = await runRelationshipExtract();
        // Without the guard this would burn a second attempt on a parse failure
        // before throwing; the switch has to short-circuit it.
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(result.edgesAdded).toBe(0);
    });
});
