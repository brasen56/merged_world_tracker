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
    getNpcRelationships, addRelationship, getRelationships,
    getStance, setStance, getStances,
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
        expect(edges[0]).toEqual({ target: 'Jonah', type: 'friend', notes: 'childhood' });
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
        expect(getNpcRelationships('Mara Vance')).toEqual([{ target: 'Jonah', type: 'rival', notes: '' }]);
        expect(getNpcRelationships('Mara')).toHaveLength(0);
    });

    test('updates an existing edge without duplicating it', () => {
        addRelationship('Mara', 'Jonah', 'friend', '');
        const r = applyExtractedRelationships({ edges: [{ from: 'Mara', to: 'Jonah', type: 'rival', notes: 'they fell out' }] });
        expect(r.edgesAdded).toBe(0);
        expect(r.edgesUpdated).toBe(1);
        const edges = getNpcRelationships('Mara');
        expect(edges).toHaveLength(1);
        expect(edges[0]).toEqual({ target: 'Jonah', type: 'rival', notes: 'they fell out' });
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
        setStance('Mara', 'friendly');
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
        setFakeChat([{ mes: 'Mara greets Jonah warmly.', name: 'Narrator', is_user: false }]);
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
        expect(result.edgesAdded).toBe(1);
        expect(result.stancesSet).toBe(1);
        expect(getNpcRelationships('Mara')).toEqual([{ target: 'Jonah', type: 'friend', notes: 'childhood' }]);
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
