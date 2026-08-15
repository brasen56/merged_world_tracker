/**
 * test/canonical_identity.test.js — One NPC, one identity.
 *
 * Regression tests for the canonical-identity boundary fixes described in
 * bug_report_temp.md. The model's spelling of an NPC name is NOT an identity:
 *
 *   1. Every scan category (including new_*) resolves through
 *      resolveRegistryKey; an unambiguous alias of a tracked NPC becomes an
 *      update under the canonical key instead of a second entry.
 *   2. Staging dedupes by canonical identity (uid → registry key →
 *      normalized name), not by the model-provided spelling.
 *   3. loadEntryContent verifies the lorebook label against the expected NPC
 *      and blocks display/merge on mismatch (the Mikhail/Marcus symptom).
 *   4. Interiority resolves model-returned names against the roster with the
 *      same unambiguous alias rules instead of discarding them (the
 *      Charlotte / Charlotte Simpson warning).
 *   5. auditRegistryAliases reports existing alias duplicates without
 *      merging or deleting anything (entries may hold different facts).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import { resetCoreStubs, setFakeChat } from './stubs/core.js';
import { state } from '../knowledge/state.js';
import { saveSettings as saveKnowledgeSettings } from '../knowledge/settings.js';
import { _setCacheForTests, _clearCacheForTests, isStoreEntry } from '../knowledge/store.js';
import {
    getRegistry, auditRegistryAliases, isSameNpcIdentity, resolveRegistryKey,
} from '../knowledge/registry.js';
import {
    loadEntryContent, enrichStagingItem, writeToLorebook,
    fieldsFromScanRecord, findKnowledgeEntryByName,
} from '../knowledge/lorebook.js';
import { findEntryUidByNpcIdentity } from '../knowledge/reconcile.js';
import {
    buildStagingItems, mergeScanResults, importFromLorebooks, reconcileRegistry,
    mergeKeywords, trackedType,
} from '../knowledge/staging.js';
import { resolveRosterName, mergeSplitResults, validateAndApply } from '../interiority/generation.js';
import { getInnerState } from '../interiority/data.js';

/**
 * Minimal stand-in for ST's world-info.js — same contract as store.test.js's
 * fake: loadWorldInfo returns a deep copy so read-modify-write is forced.
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

let wiFake;

beforeEach(() => {
    resetCoreStubs();
    _clearCacheForTests();
    saveKnowledgeSettings({ scope: 'global' });
    wiFake = makeFakeWorldInfo();
    state.wiScript = wiFake;
    state.stagingItems = [];
    globalThis.document = {
        dispatchEvent: vi.fn(),
        getElementById: () => null,
        querySelectorAll: () => [],
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    _clearCacheForTests();
    state.wiScript = null;
});

/** Seed the NPC registry for the default global-scope Knowledge book. */
function seedRegistry(registry) {
    _setCacheForTests('Knowledge Tracker', { registry });
}

/** An empty scan result to spread test categories into. */
function emptyScan() {
    return { new_minor: [], new_major: [], update_minor: [], update_major: [] };
}

/**
 * The NPC entries of a book, excluding the module's own [MWT:store] entry —
 * a write folds the store back into the book, so a raw key count is always
 * one too many.
 */
function npcEntries(bookName = 'Knowledge Tracker') {
    const entries = wiFake.books.get(bookName)?.entries || {};
    return Object.values(entries).filter(e => !isStoreEntry(e));
}

// ─── Fix 1: buildStagingItems canonicalizes every category ──────────────────

describe('buildStagingItems canonicalizes every scan category', () => {
    test('new_* alias of a tracked NPC is reclassified as an update under the canonical key', () => {
        seedRegistry({ Sophie: { uid: 5, type: 'minor', keywords: ['Sophie'] } });
        const items = buildStagingItems({ ...emptyScan(), new_minor: [
            { name: 'Sophie Simpson', species: 'Human', tone: 'brisk', perceived_as: 'clerk', descriptor: 'front desk', first_seen: 'lobby' },
        ] });

        expect(items).toHaveLength(1);
        expect(items[0].action).toBe('update');
        expect(items[0].name).toBe('Sophie');
        expect(items[0].uid).toBe(5);
        expect(items[0].reclassified).toBe(true);
        // The scanned fields survive as update fields so the merge applies them.
        expect(items[0].fields.tone).toBe('brisk');
    });

    test('new_major alias carries initial_knowledge as newKnowledge', () => {
        seedRegistry({ Charlotte: { uid: 2, type: 'major', keywords: ['Charlotte'] } });
        const items = buildStagingItems({ ...emptyScan(), new_major: [
            { name: 'Charlotte Simpson', initial_knowledge: [{ fact: 'hid the letter', source: 'saw her', date: 'day 3' }] },
        ] });

        expect(items).toHaveLength(1);
        expect(items[0].action).toBe('update');
        expect(items[0].name).toBe('Charlotte');
        expect(items[0].uid).toBe(2);
        expect(items[0].newKnowledge).toEqual([{ fact: 'hid the letter', source: 'saw her', date: 'day 3' }]);
    });

    test('new_* alias of an ORPHAN identity creates under the canonical key (accept repairs it)', () => {
        seedRegistry({ Jonah: { uid: null, type: 'minor', keywords: ['Jonah'] } });
        const items = buildStagingItems({ ...emptyScan(), new_minor: [
            { name: 'Jonah Reyes', tone: 'quiet', perceived_as: 'handyman', descriptor: 'dock worker' },
        ] });

        expect(items).toHaveLength(1);
        expect(items[0].action).toBe('create');
        // Canonical spelling — accepting writes reg[Jonah].uid; it must not
        // fork a second "Jonah Reyes" identity.
        expect(items[0].name).toBe('Jonah');
    });

    test('an ambiguous given name stays a new proposal (fail closed)', () => {
        seedRegistry({ 'Mara Vance': { uid: 1 }, 'Mara Chen': { uid: 2 } });
        const items = buildStagingItems({ ...emptyScan(), new_minor: [{ name: 'Mara', tone: 'terse' }] });

        expect(items).toHaveLength(1);
        expect(items[0].action).toBe('create');
        expect(items[0].name).toBe('Mara');
    });

    test('a genuinely new NPC keeps the model spelling', () => {
        seedRegistry({});
        const items = buildStagingItems({ ...emptyScan(), new_minor: [{ name: 'Bex', tone: 'loud' }] });

        expect(items).toHaveLength(1);
        expect(items[0].action).toBe('create');
        expect(items[0].name).toBe('Bex');
    });

    test('update_* items carry the canonical key, not the model spelling', () => {
        seedRegistry({ Sophie: { uid: 5, type: 'minor', keywords: ['Sophie'] } });
        const items = buildStagingItems({ ...emptyScan(), update_minor: [
            { name: 'Sophie Simpson', fields: { tone: 'weary', perceived_as: null, descriptor: null } },
        ] });

        expect(items).toHaveLength(1);
        expect(items[0].action).toBe('update');
        // Canonical name: writeToLorebook's KNOWLEDGE-01 comment check passes
        // instead of detaching uid 5 and creating a duplicate entry.
        expect(items[0].name).toBe('Sophie');
        expect(items[0].uid).toBe(5);
    });
});

// ─── Fix 2: mergeScanResults dedupes by canonical identity ──────────────────

describe('mergeScanResults dedupes by canonical identity', () => {
    test('same uid under different spellings is one staged item (newest wins)', () => {
        seedRegistry({ Sophie: { uid: 5, type: 'minor', keywords: ['Sophie'] } });
        state.stagingItems = [{ id: 'old', name: 'Sophie Simpson', action: 'update', type: 'minor', uid: 5, proposedContent: 'old', mergedContent: 'old' }];
        const added = mergeScanResults([
            { id: 'new', name: 'Sophie', action: 'update', type: 'minor', uid: 5, proposedContent: 'fresh', mergedContent: 'fresh', fields: {} },
        ], () => {});

        expect(state.stagingItems).toHaveLength(1);
        expect(added).toHaveLength(1);
        expect(state.stagingItems[0].id).toBe('old'); // id preserved
        expect(state.stagingItems[0].mergedContent).toBe('fresh');
        // The outgoing proposal text is preserved for review, not lost.
        expect(state.stagingItems[0].supersededContent[0].content).toBe('old');
    });

    test('registry-key identity merges alias spellings of the same tracked NPC', () => {
        seedRegistry({ Sophie: { uid: 5, type: 'minor', keywords: ['Sophie'] } });
        // uid-less items (e.g. promote staging) fall back to the registry key.
        state.stagingItems = [{ id: 'p1', name: 'Sophie', action: 'update', type: 'promote', proposedContent: 'x', mergedContent: 'x' }];
        mergeScanResults([
            { id: 'p2', name: 'Sophie Simpson', action: 'update', type: 'promote', proposedContent: 'y', mergedContent: 'y' },
        ], () => {});

        expect(state.stagingItems).toHaveLength(1);
        expect(state.stagingItems[0].mergedContent).toBe('y');
    });

    test('case/whitespace variants of an UNTRACKED name still merge', () => {
        seedRegistry({});
        state.stagingItems = [{ id: 'a', name: 'Bex', action: 'create', type: 'minor', proposedContent: 'x', mergedContent: 'x' }];
        mergeScanResults([
            { id: 'b', name: '  bEX ', action: 'create', type: 'minor', proposedContent: 'y', mergedContent: 'y' },
        ], () => {});

        expect(state.stagingItems).toHaveLength(1);
    });

    test('different alias spellings of an UNTRACKED npc stay separate — identity cannot be proven', () => {
        seedRegistry({});
        state.stagingItems = [{ id: 'a', name: 'Bex', action: 'create', type: 'minor', proposedContent: 'x', mergedContent: 'x' }];
        mergeScanResults([
            { id: 'b', name: 'Bex Taylor', action: 'create', type: 'minor', proposedContent: 'y', mergedContent: 'y' },
        ], () => {});

        // Two strangers sharing a given name must not be merged by a guess.
        expect(state.stagingItems).toHaveLength(2);
    });
});

// ─── Fix 3: loadEntryContent verifies the lorebook label ────────────────────

describe('loadEntryContent verifies the lorebook label', () => {
    beforeEach(() => {
        wiFake.books.set('Knowledge Tracker', {
            entries: { 3: { uid: 3, comment: 'Marcus', key: ['Marcus'], content: 'Marcus | Human | blacksmith' } },
        });
    });

    test('returns content when the label matches the expected NPC (case-insensitive)', async () => {
        expect(await loadEntryContent(3, 'Marcus')).toBe('Marcus | Human | blacksmith');
        expect(await loadEntryContent(3, ' marcus ')).toBe('Marcus | Human | blacksmith');
    });

    test('blocks the load when the uid points at a differently-labelled entry', async () => {
        // The Mikhail/Marcus symptom: a stale/duplicate identity pointing at
        // another character's entry must not display or merge as Mikhail.
        expect(await loadEntryContent(3, 'Mikhail')).toBeNull();
    });

    test('loads when the label is an unambiguous alias of the expected canonical key', async () => {
        // importFromLorebooks links canonical key "Sophie" to an entry
        // labelled "Sophie Simpson"; loading under "Sophie" must succeed.
        wiFake.books.set('Knowledge Tracker', {
            entries: { 3: { uid: 3, comment: 'Sophie Simpson', key: ['Sophie Simpson'], content: 'Sophie Simpson | Human | clerk' } },
        });
        expect(await loadEntryContent(3, 'Sophie')).toBe('Sophie Simpson | Human | clerk');
        expect(await loadEntryContent(3, 'Sophie Simpson')).toBe('Sophie Simpson | Human | clerk');
    });

    test('still refuses a different NPC who merely shares a given name (protection preserved)', async () => {
        // Two multi-token names sharing a given name are DIFFERENT people —
        // Option B must not weaken the guard into accepting Mara Chen's entry
        // for Mara Vance.
        wiFake.books.set('Knowledge Tracker', {
            entries: { 3: { uid: 3, comment: 'Mara Chen', key: ['Mara Chen'], content: 'Mara Chen | Human | pilot' } },
        });
        expect(await loadEntryContent(3, 'Mara Vance')).toBeNull();
    });

    test('refuses a pairwise shorthand label when another same-given label makes it ambiguous', async () => {
        wiFake.books.set('Knowledge Tracker', {
            entries: {
                3: { uid: 3, comment: 'Mara', key: ['Mara'], content: 'Mara | Human | pilot' },
                4: { uid: 4, comment: 'Mara Chen', key: ['Mara Chen'], content: 'Mara Chen | Human | doctor' },
            },
        });
        expect(await loadEntryContent(3, 'Mara Vance')).toBeNull();
    });

    test('legacy single-argument calls (no expected name) keep working', async () => {
        expect(await loadEntryContent(3)).toBe('Marcus | Human | blacksmith');
    });

    test('enrichStagingItem does not merge another NPC\'s content on mismatch', async () => {
        const item = { id: 'x', type: 'minor', action: 'update', uid: 3, name: 'Mikhail', fields: { tone: 'calm' }, proposedContent: '(Fetch to see changes)', existingContent: null };
        await enrichStagingItem(item);
        expect(item.existingContent).toBeNull();
        expect(item.mergedContent).toBeUndefined();
    });

    test('enrichStagingItem merges normally when the label matches', async () => {
        wiFake.books.set('Knowledge Tracker', {
            entries: { 3: { uid: 3, comment: 'Mikhail', key: ['Mikhail'], content: 'Mikhail | Human | smith\nTone: gruff\nPerceived as: blunt\nFirst seen: forge' } },
        });
        const item = { id: 'x', type: 'minor', action: 'update', uid: 3, name: 'Mikhail', fields: { tone: 'calm' }, proposedContent: '(Fetch to see changes)', existingContent: null };
        await enrichStagingItem(item);
        expect(item.existingContent).toContain('Mikhail');
        expect(item.mergedContent).toContain('Tone: calm');
    });
});

// ─── Fix 1 (import path): From Lorebooks canonical check ────────────────────

describe('importFromLorebooks canonical check', () => {
    test('an alias entry repairs the canonical orphan record instead of forking a second identity', async () => {
        seedRegistry({ Sophie: { uid: null, type: 'minor', keywords: ['Sophie'] } });
        wiFake.books.set('Knowledge Tracker', {
            entries: { 7: { uid: 7, comment: 'Sophie Simpson', key: ['Sophie Simpson'], content: 'Sophie Simpson | Human | clerk' } },
        });

        await importFromLorebooks();

        const reg = getRegistry();
        expect(reg['Sophie'].uid).toBe(7);
        expect(Object.keys(reg)).not.toContain('Sophie Simpson');

        // Regression: the repaired link must be loadable under its canonical
        // key. The entry is labelled "Sophie Simpson" but reg['Sophie'] points
        // at it — an exact-only label check refused this valid link and, on the
        // next write, detached the uid and re-created the duplicate. The shared
        // NPC-identity rule verifies them as the same NPC.
        expect(await loadEntryContent(reg['Sophie'].uid, 'Sophie')).toBe('Sophie Simpson | Human | clerk');
    });

    test('an alias entry of an already-tracked NPC is a duplicate, not a second identity', async () => {
        seedRegistry({ Sophie: { uid: 5, type: 'minor', keywords: ['Sophie'] } });
        wiFake.books.set('Knowledge Tracker', {
            entries: {
                // Sophie's real entry (verified) plus a stray alias-labelled
                // duplicate. Reconciliation must keep Sophie on uid 5 and flag
                // uid 7 as a duplicate rather than forking "Sophie Simpson".
                5: { uid: 5, comment: 'Sophie', key: ['Sophie'], content: 'Sophie | Human | clerk' },
                7: { uid: 7, comment: 'Sophie Simpson', key: ['Sophie Simpson'], content: 'Sophie Simpson | Human | clerk' },
            },
        });

        await importFromLorebooks();

        const reg = getRegistry();
        expect(Object.keys(reg)).toEqual(['Sophie']);
        expect(reg['Sophie'].uid).toBe(5);
    });
});

// ─── reconcileRegistry: validate/relink/detach + adopt (the repair pass) ─────

describe('reconcileRegistry repairs registry↔entry links non-destructively', () => {
    test('a crossed uid relinks to the NPC\'s real entry and preserves metadata', async () => {
        // reg says Mikhail→67, but uid 67 is physically Marcus. Mikhail's real
        // entry is uid 12. This is the reported warning scenario.
        seedRegistry({ 'Mikhail Volkov': { uid: 67, type: 'major', keywords: ['Mikhail'], profileUid: 99 } });
        wiFake.books.set('Knowledge Tracker', {
            entries: {
                12: { uid: 12, comment: 'Mikhail Volkov', key: ['Mikhail'], content: 'Mikhail | Human | smith' },
                67: { uid: 67, comment: 'Marcus Boykin', key: ['Marcus'], content: 'Marcus | Badger | mechanic' },
            },
        });

        const result = await reconcileRegistry();
        const reg = getRegistry();

        expect(reg['Mikhail Volkov'].uid).toBe(12);       // relinked to the right entry
        expect(reg['Mikhail Volkov'].profileUid).toBe(99); // metadata preserved
        expect(reg['Mikhail Volkov'].type).toBe('major');
        expect(result.relinked).toBe(1);
        // The displaced Marcus entry is now tracked in its own right.
        expect(reg['Marcus Boykin'].uid).toBe(67);
        expect(result.adopted).toBe(1);
        // And Mikhail now loads (the warning stops).
        expect(await loadEntryContent(12, 'Mikhail Volkov')).toBe('Mikhail | Human | smith');
    });

    test('two swapped uids both resolve', async () => {
        seedRegistry({ 'Ada Lin': { uid: 2, keywords: ['Ada'] }, 'Bo Ray': { uid: 1, keywords: ['Bo'] } });
        wiFake.books.set('Knowledge Tracker', {
            entries: {
                1: { uid: 1, comment: 'Ada Lin', key: ['Ada'], content: 'Ada | Human' },
                2: { uid: 2, comment: 'Bo Ray', key: ['Bo'], content: 'Bo | Human' },
            },
        });

        const result = await reconcileRegistry();
        const reg = getRegistry();

        expect(reg['Ada Lin'].uid).toBe(1);
        expect(reg['Bo Ray'].uid).toBe(2);
        expect(result.relinked).toBe(2);
    });

    test('an orphan (uid-less) record adopts its physical entry', async () => {
        seedRegistry({ Sophie: { uid: null, type: 'minor', keywords: ['Sophie'] } });
        wiFake.books.set('Knowledge Tracker', {
            entries: { 7: { uid: 7, comment: 'Sophie Simpson', key: ['Sophie Simpson'], content: 'Sophie Simpson | Human | clerk' } },
        });

        const result = await reconcileRegistry();
        const reg = getRegistry();

        expect(reg['Sophie'].uid).toBe(7);
        expect(Object.keys(reg)).toEqual(['Sophie']);
        expect(result.adopted).toBe(1);
    });

    test('a uid pointing at another NPC with no entry of its own is detached', async () => {
        seedRegistry({ Ghost: { uid: 5, keywords: ['Ghost'] } });
        wiFake.books.set('Knowledge Tracker', {
            entries: { 3: { uid: 3, comment: 'Real Person', key: ['Real'], content: 'Real | Human' } },
        });

        const result = await reconcileRegistry();
        const reg = getRegistry();

        expect(reg['Ghost'].uid).toBeNull();  // detached — a scan will re-create
        expect(result.detached).toBe(1);
    });

    test('an ambiguous repair is left unchanged (fail closed), not guessed', async () => {
        // reg's uid is wrong, and "Mara" could be either full entry — no safe
        // choice, so the (still-wrong) uid is LEFT and reported, not relinked.
        seedRegistry({ Mara: { uid: 9, keywords: ['Mara'] } });
        wiFake.books.set('Knowledge Tracker', {
            entries: {
                1: { uid: 1, comment: 'Mara Vance', key: ['Mara Vance'], content: 'Mara Vance | Human' },
                2: { uid: 2, comment: 'Mara Chen', key: ['Mara Chen'], content: 'Mara Chen | Human' },
            },
        });

        const result = await reconcileRegistry();
        const reg = getRegistry();

        expect(reg['Mara'].uid).toBe(9);      // unchanged
        expect(result.relinked).toBe(0);
        expect(result.ambiguous).toBeGreaterThanOrEqual(1);
    });

    test('a correctly-linked record is left alone (verified)', async () => {
        seedRegistry({ Sophie: { uid: 5, keywords: ['Sophie'] } });
        wiFake.books.set('Knowledge Tracker', {
            entries: { 5: { uid: 5, comment: 'Sophie', key: ['Sophie'], content: 'Sophie | Human' } },
        });

        const result = await reconcileRegistry();
        const reg = getRegistry();

        expect(reg['Sophie'].uid).toBe(5);
        expect(result.verified).toBe(1);
        expect(result.relinked + result.adopted + result.detached).toBe(0);
    });

    test('a duplicate physical entry is flagged, never merged or forked', async () => {
        seedRegistry({ Sophie: { uid: 5, keywords: ['Sophie'] } });
        wiFake.books.set('Knowledge Tracker', {
            entries: {
                5: { uid: 5, comment: 'Sophie', key: ['Sophie'], content: 'Sophie | Human | clerk' },
                7: { uid: 7, comment: 'Sophie Simpson', key: ['Sophie Simpson'], content: 'Sophie Simpson | Human | clerk' },
            },
        });

        const result = await reconcileRegistry();
        const reg = getRegistry();

        expect(Object.keys(reg)).toEqual(['Sophie']); // no second identity
        expect(reg['Sophie'].uid).toBe(5);            // authoritative entry kept
        expect(result.duplicates).toBe(1);            // the stray is reported
    });
});

// ─── Fix 4: Interiority roster alias resolution ──────────────────────────────

describe('resolveRosterName (unambiguous alias rules against a roster)', () => {
    const roster = ['Charlotte', 'Mara Vance'];

    test('exact and case-insensitive membership returns the roster spelling', () => {
        expect(resolveRosterName(roster, 'Charlotte')).toBe('Charlotte');
        expect(resolveRosterName(roster, '  charlotte ')).toBe('Charlotte');
    });

    test('a fuller spelling of a single-token roster member resolves to it', () => {
        expect(resolveRosterName(roster, 'Charlotte Simpson')).toBe('Charlotte');
    });

    test('a short form of a multi-token roster member resolves to it', () => {
        expect(resolveRosterName(roster, 'Mara')).toBe('Mara Vance');
    });

    test('ambiguous and unknown names resolve to null (fail closed)', () => {
        const twoMaras = ['Mara Vance', 'Mara Chen'];
        expect(resolveRosterName(twoMaras, 'Mara')).toBeNull();
        expect(resolveRosterName(roster, 'Dorothy')).toBeNull();
        expect(resolveRosterName(roster, '')).toBeNull();
        expect(resolveRosterName([], 'Charlotte')).toBeNull();
    });
});

describe('validateAndApply accepts roster aliases', () => {
    test('a response naming "Charlotte Simpson" for roster "Charlotte" is applied as Charlotte', async () => {
        setFakeChat([
            { name: 'User', is_user: true, mes: 'What is Charlotte doing?', extra: {} },
            { name: 'Narrator', mes: 'Charlotte Simpson seals the letter.', extra: {} },
        ]);
        const result = await validateAndApply({
            npcs: [{ name: 'Charlotte Simpson', thought: { type: 'rumination', text: 'The letter must not arrive.' }, inner_state: 'tense, resolved' }],
        }, ['Charlotte'], 1);

        // The reaction is kept AND keyed on the roster's canonical spelling.
        expect(result.reactions).toHaveLength(1);
        expect(result.reactions[0].npc).toBe('Charlotte');
        // Inner state (persisted per NPC) lands under the canonical form too.
        expect(getInnerState('Charlotte')).toBeTruthy();
    });

    test('a genuinely unknown name is still discarded', async () => {
        setFakeChat([
            { name: 'User', is_user: true, mes: 'Hello?', extra: {} },
            { name: 'Narrator', mes: 'The wind picks up.', extra: {} },
        ]);
        const result = await validateAndApply({
            npcs: [{ name: 'Dorothy', thought: { type: 'rumination', text: 'Nobody visits anymore.' } }],
        }, ['Charlotte'], 1);

        expect(result.reactions).toHaveLength(0);
    });
});

describe('mergeSplitResults resolves split-call names against the roster', () => {
    test('an intentions call answering with the full spelling still merges', () => {
        const merged = mergeSplitResults(
            { npcs: [{ name: 'Charlotte Simpson', executed: [] }] },
            { npcs: [{ name: 'Charlotte', reaction: { re: 'the sealed letter', thought: 'She counted the stamps twice over.' } }] },
            ['Charlotte'],
        );

        expect(merged.npcs).toHaveLength(1);
        expect(merged.npcs[0].name).toBe('Charlotte');
        expect(merged.npcs[0].reaction.thought).toContain('stamps');
        expect(merged.npcs[0].executed).toEqual([]);
    });

    test('names that resolve to no roster member are dropped here', () => {
        const merged = mergeSplitResults(
            { npcs: [{ name: 'Dorothy', new_intentions: [{ action: 'flee', trigger: 'dawn' }] }] },
            null,
            ['Charlotte'],
        );
        expect(merged.npcs).toHaveLength(1);
        expect(merged.npcs[0].new_intentions).toBeUndefined();
    });
});

// ─── Fix 5: non-destructive registry alias audit ─────────────────────────────

describe('auditRegistryAliases (read-only duplicate report)', () => {
    test('groups unambiguous alias spellings of one NPC', () => {
        const groups = auditRegistryAliases({
            Sophie: { uid: 1, type: 'minor' },
            'Sophie Simpson': { uid: 2, type: 'minor' },
        });
        expect(groups).toHaveLength(1);
        expect(groups[0].names.sort()).toEqual(['Sophie', 'Sophie Simpson']);
        expect(groups[0].entries.map(e => e.uid).sort()).toEqual([1, 2]);
    });

    test('never groups two multi-token NPCs that merely share a given name', () => {
        const groups = auditRegistryAliases({
            'Mara Vance': { uid: 3 },
            'Mara Chen': { uid: 4 },
        });
        expect(groups).toHaveLength(0);
    });

    test('clean registries and empty input report nothing', () => {
        expect(auditRegistryAliases({ Mara: { uid: 0 }, Bren: { uid: 1 } })).toEqual([]);
        expect(auditRegistryAliases({})).toEqual([]);
        expect(auditRegistryAliases(null)).toEqual([]);
    });
});

// ─── Shared pairwise NPC-identity rule (label checks + audit agree) ──────────

describe('isSameNpcIdentity', () => {
    test('equal names and case/whitespace variants are the same NPC', () => {
        expect(isSameNpcIdentity('Sophie', 'Sophie')).toBe(true);
        expect(isSameNpcIdentity('  sophie ', 'SOPHIE')).toBe(true);
    });

    test('a single-token name and its fuller spelling are the same NPC (both directions)', () => {
        expect(isSameNpcIdentity('Sophie', 'Sophie Simpson')).toBe(true);
        expect(isSameNpcIdentity('Sophie Simpson', 'Sophie')).toBe(true);
    });

    test('two multi-token names sharing a given name are DIFFERENT people', () => {
        expect(isSameNpcIdentity('Mara Vance', 'Mara Chen')).toBe(false);
    });

    test('unrelated names and empty input are never the same NPC', () => {
        expect(isSameNpcIdentity('Mikhail Volkov', 'Marcus Boykin')).toBe(false);
        expect(isSameNpcIdentity('', 'Sophie')).toBe(false);
        expect(isSameNpcIdentity('Sophie', '')).toBe(false);
        expect(isSameNpcIdentity('Sophie', null)).toBe(false);
    });
});

// ─── Fix 6: both resolvers run the shared rule, not a first-token compare ────

describe('resolveRegistryKey uses the shared identity rule', () => {
    test('a DIFFERENT full name sharing a given name never resolves', () => {
        // The core P1: with only Vance on file, a first-token compare found
        // exactly one candidate and returned her for "Mara Chen".
        expect(resolveRegistryKey({ 'Mara Vance': { uid: 1 } }, 'Mara Chen')).toBeNull();
        expect(resolveRegistryKey({ 'Mara Vance': { uid: 1 } }, 'Mara Kowalski')).toBeNull();
    });

    test('single-token ↔ full-name still resolves, both directions', () => {
        expect(resolveRegistryKey({ 'Mara Vance': { uid: 1 } }, 'Mara')).toBe('Mara Vance');
        expect(resolveRegistryKey({ Mara: { uid: 1 } }, 'Mara Vance')).toBe('Mara');
        expect(resolveRegistryKey({ Sophie: { uid: 1 } }, 'Sophie Simpson')).toBe('Sophie');
    });

    test('a full name cannot resolve through its short registry key when another same-given NPC exists', () => {
        expect(resolveRegistryKey({
            Mara: { uid: 1 },
            'Mara Chen': { uid: 2 },
        }, 'Mara Vance')).toBeNull();
    });

    test('exact and case-insensitive matching is unaffected', () => {
        expect(resolveRegistryKey({ 'Mara Vance': {} }, 'Mara Vance')).toBe('Mara Vance');
        expect(resolveRegistryKey({ 'Mara Vance': {} }, '  mara vance ')).toBe('Mara Vance');
    });

    test('two registry NPCs sharing a given name stay ambiguous', () => {
        expect(resolveRegistryKey({ 'Mara Vance': {}, 'Mara Chen': {} }, 'Mara')).toBeNull();
    });
});

describe('resolveRosterName uses the shared identity rule', () => {
    test('a DIFFERENT full name sharing a given name is not attributed', () => {
        // Mara Chen's thoughts must never be filed under Mara Vance.
        expect(resolveRosterName(['Mara Vance'], 'Mara Chen')).toBeNull();
    });

    test('the Charlotte alias case still resolves, both directions', () => {
        expect(resolveRosterName(['Charlotte'], 'Charlotte Simpson')).toBe('Charlotte');
        expect(resolveRosterName(['Mara Vance'], 'Mara')).toBe('Mara Vance');
    });

    test('a full roster name cannot resolve through shorthand when another same-given roster member exists', () => {
        expect(resolveRosterName(['Mara', 'Mara Chen'], 'Mara Vance')).toBeNull();
    });
});

// ─── Fix 7: adopt-before-create (the identical-label duplicate source) ───────

describe('findEntryUidByNpcIdentity', () => {
    const entries = {
        0: { uid: 0, comment: 'Sophie', content: 'a' },
        1: { uid: 1, comment: 'Charlotte', content: 'b' },
    };

    test('finds an entry by exact label', () => {
        expect(findEntryUidByNpcIdentity(entries, 'Sophie')?.uid).toBe(0);
        expect(findEntryUidByNpcIdentity(entries, '  sophie ')?.uid).toBe(0);
    });

    test('finds an entry by an unambiguous alias label', () => {
        const found = findEntryUidByNpcIdentity({ 5: { uid: 5, comment: 'Sophie Simpson' } }, 'Sophie');
        expect(found.uid).toBe(5);
        expect(found.exact).toBe(false);
    });

    test('prefers the exact label over an alias label', () => {
        const found = findEntryUidByNpcIdentity({
            2: { uid: 2, comment: 'Sophie Simpson' },
            3: { uid: 3, comment: 'Sophie' },
        }, 'Sophie');
        expect(found.uid).toBe(3);
        expect(found.exact).toBe(true);
    });

    test('several identical labels converge on the lowest uid instead of growing', () => {
        // The reported book state: repeated creates left four "Sophie" entries.
        // Adopting deterministically stops the pile growing on every scan.
        const found = findEntryUidByNpcIdentity({
            9: { uid: 9, comment: 'Sophie' },
            4: { uid: 4, comment: 'Sophie' },
            7: { uid: 7, comment: 'Sophie' },
        }, 'Sophie');
        expect(found.uid).toBe(4);
        expect(found.duplicates).toBe(3);
    });

    test('two different alias candidates fail closed — they are strangers', () => {
        expect(findEntryUidByNpcIdentity({
            1: { uid: 1, comment: 'Sophie Simpson' },
            2: { uid: 2, comment: 'Sophie Sinclair' },
        }, 'Sophie')).toBeNull();
    });

    test('a sole pairwise alias candidate fails when another same-given label makes the shorthand ambiguous', () => {
        expect(findEntryUidByNpcIdentity({
            1: { uid: 1, comment: 'Mara' },
            2: { uid: 2, comment: 'Mara Chen' },
        }, 'Mara Vance')).toBeNull();
    });

    test('unknown, unlabelled and empty inputs return null', () => {
        expect(findEntryUidByNpcIdentity(entries, 'Dorothy')).toBeNull();
        expect(findEntryUidByNpcIdentity({ 1: { uid: 1, comment: '   ' } }, 'Sophie')).toBeNull();
        expect(findEntryUidByNpcIdentity({}, 'Sophie')).toBeNull();
        expect(findEntryUidByNpcIdentity(entries, '')).toBeNull();
    });
});

describe('writeToLorebook adopts an existing entry instead of duplicating', () => {
    test('an orphan create updates the entry the book already holds', async () => {
        seedRegistry({ Sophie: { uid: null, type: 'minor', keywords: ['Sophie'] } });
        wiFake.books.set('Knowledge Tracker', {
            entries: { 0: { uid: 0, comment: 'Sophie', key: ['Sophie'], content: 'old Sophie' } },
        });

        const result = await writeToLorebook('Sophie', 'new Sophie', ['Sophie'], null);

        expect(result.success).toBe(true);
        expect(result.uid).toBe(0);
        // One NPC entry, not two — the whole point.
        expect(npcEntries()).toHaveLength(1);
        expect(wiFake.books.get('Knowledge Tracker').entries[0].content).toBe('new Sophie');
    });

    test('the stale-uid guard no longer manufactures a duplicate', async () => {
        // KNOWLEDGE-01 detaches the wrong-NPC uid and used to fall straight
        // into create — adding a second "Mikhail" beside the real one.
        seedRegistry({ Mikhail: { uid: 3, type: 'minor', keywords: ['Mikhail'] } });
        wiFake.books.set('Knowledge Tracker', {
            entries: {
                3: { uid: 3, comment: 'Marcus', key: ['Marcus'], content: 'Marcus dossier' },
                4: { uid: 4, comment: 'Mikhail', key: ['Mikhail'], content: 'old Mikhail' },
            },
        });

        const result = await writeToLorebook('Mikhail', 'new Mikhail', ['Mikhail'], 3);

        expect(result.uid).toBe(4);
        const book = wiFake.books.get('Knowledge Tracker');
        expect(npcEntries()).toHaveLength(2); // no third "Mikhail" was minted
        expect(book.entries[3].content).toBe('Marcus dossier'); // untouched
        expect(book.entries[4].content).toBe('new Mikhail');
    });

    test('a genuinely new NPC still creates a fresh entry', async () => {
        seedRegistry({});
        wiFake.books.set('Knowledge Tracker', {
            entries: { 0: { uid: 0, comment: 'Sophie', key: ['Sophie'], content: 'Sophie' } },
        });

        const result = await writeToLorebook('Bex', 'Bex content', ['Bex'], null);

        expect(result.success).toBe(true);
        expect(result.uid).not.toBe(0);
        expect(npcEntries()).toHaveLength(2);
    });

    test('two strangers sharing a given name are not merged by adoption', async () => {
        seedRegistry({});
        wiFake.books.set('Knowledge Tracker', {
            entries: { 0: { uid: 0, comment: 'Mara Vance', key: ['Mara Vance'], content: 'Vance' } },
        });

        const result = await writeToLorebook('Mara Chen', 'Chen', ['Mara Chen'], null);

        expect(result.uid).not.toBe(0);
        expect(wiFake.books.get('Knowledge Tracker').entries[0].content).toBe('Vance');
    });
});

describe('enrichStagingItem promotes a create whose entry already exists', () => {
    test('an orphan create becomes an update and MERGES rather than overwriting', async () => {
        seedRegistry({ Sophie: { uid: null, type: 'minor', keywords: ['Sophie'] } });
        wiFake.books.set('Knowledge Tracker', {
            entries: { 6: {
                uid: 6, comment: 'Sophie', key: ['Sophie'],
                content: 'Sophie | Human | front desk\nTone: brisk\nPerceived as: clerk\nFirst seen: lobby',
            } },
        });

        const item = {
            id: 'x', type: 'minor', action: 'create', name: 'Sophie',
            data: { name: 'Sophie', tone: 'weary' },
            proposedContent: 'Sophie | unknown | unknown\nTone: weary\nPerceived as: unknown\nFirst seen: unknown',
            mergedContent: 'Sophie | unknown | unknown\nTone: weary\nPerceived as: unknown\nFirst seen: unknown',
            existingContent: null, keywords: ['Sophie'],
        };
        await enrichStagingItem(item);

        expect(item.action).toBe('update');
        expect(item.uid).toBe(6);
        // The real entry's facts survive; only the scanned field changes. The
        // synthesized "unknown" stub must NOT have replaced the dossier.
        expect(item.mergedContent).toContain('Tone: weary');
        expect(item.mergedContent).toContain('Perceived as: clerk');
        expect(item.mergedContent).toContain('First seen: lobby');
        expect(item.mergedContent).not.toContain('unknown');
    });

    test('a create for an NPC with no entry stays a create', async () => {
        seedRegistry({});
        wiFake.books.set('Knowledge Tracker', { entries: {} });
        const item = {
            id: 'x', type: 'minor', action: 'create', name: 'Bex', data: { name: 'Bex' },
            proposedContent: 'Bex', mergedContent: 'Bex', existingContent: null, keywords: ['Bex'],
        };
        await enrichStagingItem(item);

        expect(item.action).toBe('create');
        expect(item.uid).toBeUndefined();
    });

    test('findKnowledgeEntryByName is read-only and label-driven', async () => {
        wiFake.books.set('Knowledge Tracker', {
            entries: { 2: { uid: 2, comment: 'Sophie Simpson', content: 'text' } },
        });
        expect((await findKnowledgeEntryByName('Sophie')).uid).toBe(2);
        expect(await findKnowledgeEntryByName('Mikhail')).toBeNull();
    });
});

// ─── Fix 8: reclassification preserves type and every dossier field ─────────

describe('reclassified proposals preserve the tracked type', () => {
    test('a tracked MAJOR returned as new_minor stays major', () => {
        seedRegistry({ Sophie: { uid: 5, type: 'major', keywords: ['Sophie'] } });
        const items = buildStagingItems({ ...emptyScan(), new_minor: [
            { name: 'Sophie Simpson', tone: 'weary' },
        ] });

        // Accepting writes item.type into the registry, so 'minor' here was a
        // silent demotion — and merged her dossier with the compact merger.
        expect(items[0].type).toBe('major');
        expect(items[0].action).toBe('update');
        expect(items[0].typeFromRegistry).toBe(true);
    });

    test('a tracked MINOR returned as new_major is not implicitly promoted', () => {
        seedRegistry({ Jonah: { uid: 8, type: 'minor', keywords: ['Jonah'] } });
        const items = buildStagingItems({ ...emptyScan(), new_major: [
            { name: 'Jonah Reyes', tone: 'quiet', role: 'dock hand' },
        ] });

        expect(items[0].type).toBe('minor');
    });

    test('update_minor on a tracked major does not demote either', () => {
        seedRegistry({ Sophie: { uid: 5, type: 'major', keywords: ['Sophie'] } });
        const items = buildStagingItems({ ...emptyScan(), update_minor: [
            { name: 'Sophie', fields: { tone: 'weary' } },
        ] });

        expect(items[0].type).toBe('major');
    });

    test('a new_major alias carries every dossier field, not just three', () => {
        seedRegistry({ Charlotte: { uid: 2, type: 'major', keywords: ['Charlotte'] } });
        const items = buildStagingItems({ ...emptyScan(), new_major: [{
            name: 'Charlotte Simpson',
            tone: 'clipped', perceived_as: 'archivist', descriptor: 'grey cardigan',
            role: 'records clerk', appearance: 'tall, ink-stained cuffs',
            secrets: 'Tier 1: forged a ledger', agenda: 'bury the audit',
        }] });

        const f = items[0].fields;
        expect(f.tone).toBe('clipped');
        // These were dropped on the floor by the old three-field conversion.
        expect(f.role).toBe('records clerk');
        expect(f.appearance).toBe('tall, ink-stained cuffs');
        expect(f.secrets).toBe('Tier 1: forged a ledger');
        expect(f.agenda).toBe('bury the audit');
    });

    test('the alias spelling is merged into the entry keywords', () => {
        seedRegistry({ Sophie: { uid: 5, type: 'minor', keywords: ['Sophie'] } });
        const items = buildStagingItems({ ...emptyScan(), new_minor: [
            { name: 'Sophie Simpson', tone: 'brisk' },
        ] });

        // Without this the entry keeps triggering only on "Sophie" — never on
        // the spelling the prose actually used.
        expect(items[0].keywords).toContain('Sophie');
        expect(items[0].keywords).toContain('Sophie Simpson');
    });
});

describe('fieldsFromScanRecord / mergeKeywords / trackedType', () => {
    test('reads flat new_* records and nested update_* records alike', () => {
        expect(fieldsFromScanRecord({ tone: 'a' }, 'minor').tone).toBe('a');
        expect(fieldsFromScanRecord({ fields: { tone: 'b' } }, 'minor').tone).toBe('b');
    });

    test('minor records carry no dossier keys; major records carry them all', () => {
        expect(fieldsFromScanRecord({ role: 'x' }, 'minor').role).toBeUndefined();
        expect(fieldsFromScanRecord({ role: 'x' }, 'major').role).toBe('x');
        expect(fieldsFromScanRecord({}, 'major').secrets).toBeNull();
    });

    test('mergeKeywords dedupes case-insensitively and drops blanks', () => {
        expect(mergeKeywords(['Sophie'], 'Sophie', 'Sophie Simpson')).toEqual(['Sophie', 'Sophie Simpson']);
        expect(mergeKeywords(['Sophie'], 'sophie', null, '  ')).toEqual(['Sophie']);
        expect(mergeKeywords(null, 'Bex')).toEqual(['Bex']);
    });

    test('trackedType prefers the registry and falls back to the scan', () => {
        expect(trackedType({ type: 'major' }, 'minor')).toBe('major');
        expect(trackedType({ type: 'minor' }, 'major')).toBe('minor');
        expect(trackedType(null, 'major')).toBe('major');
        expect(trackedType({ type: 'nonsense' }, 'minor')).toBe('minor');
    });
});

// ─── Fix 9: the audit refuses to call an ambiguous group one NPC ────────────

describe('auditRegistryAliases classifies rather than merges', () => {
    test('a shorthand bridging two full names is reported as ambiguous', () => {
        const groups = auditRegistryAliases({
            Mara: { uid: 1 }, 'Mara Vance': { uid: 2 }, 'Mara Chen': { uid: 3 },
        });
        expect(groups).toHaveLength(1);
        expect(groups[0].kind).toBe('ambiguous');
        expect(groups[0].names.sort()).toEqual(['Mara', 'Mara Chen', 'Mara Vance']);
    });

    test('a genuine alias pair is still reported as one NPC', () => {
        const groups = auditRegistryAliases({ Sophie: { uid: 1 }, 'Sophie Simpson': { uid: 2 } });
        expect(groups).toHaveLength(1);
        expect(groups[0].kind).toBe('alias');
    });

    test('classification does not depend on registry key order', () => {
        const forward = auditRegistryAliases({
            Mara: {}, 'Mara Vance': {}, 'Mara Chen': {},
        });
        const reverse = auditRegistryAliases({
            'Mara Chen': {}, 'Mara Vance': {}, Mara: {},
        });
        expect(forward).toHaveLength(1);
        expect(reverse).toHaveLength(1);
        expect(forward[0].kind).toBe('ambiguous');
        expect(reverse[0].kind).toBe('ambiguous');
        expect(reverse[0].names.sort()).toEqual(['Mara', 'Mara Chen', 'Mara Vance']);
    });

    test('two multi-token NPCs sharing a given name are still never grouped', () => {
        expect(auditRegistryAliases({ 'Mara Vance': {}, 'Mara Chen': {} })).toEqual([]);
    });
});

// ─── Fix 10: staging dedupes on identity alone ──────────────────────────────

describe('mergeScanResults keys on identity alone', () => {
    test('a minor and a major proposal for one uid collapse to one item', () => {
        seedRegistry({ Sophie: { uid: 5, type: 'major', keywords: ['Sophie'] } });
        state.stagingItems = [{ id: 'a', name: 'Sophie', action: 'update', type: 'minor', uid: 5, proposedContent: 'x', mergedContent: 'x' }];
        mergeScanResults([
            { id: 'b', name: 'Sophie', action: 'update', type: 'major', uid: 5, proposedContent: 'y', mergedContent: 'y' },
        ], () => {});

        expect(state.stagingItems).toHaveLength(1);
        expect(state.stagingItems[0].type).toBe('major');
        expect(state.stagingItems[0].supersededContent[0].content).toBe('x');
    });

    test('a create proposal supersedes a staged update for the same NPC', () => {
        seedRegistry({ Sophie: { uid: null, type: 'minor', keywords: ['Sophie'] } });
        state.stagingItems = [{ id: 'a', name: 'Sophie', action: 'update', type: 'minor', proposedContent: 'x', mergedContent: 'x' }];
        mergeScanResults([
            { id: 'b', name: 'Sophie Simpson', action: 'create', type: 'minor', proposedContent: 'y', mergedContent: 'y' },
        ], () => {});

        expect(state.stagingItems).toHaveLength(1);
        expect(state.stagingItems[0].action).toBe('create');
    });

    test('different NPCs still stage independently', () => {
        seedRegistry({});
        state.stagingItems = [{ id: 'a', name: 'Bex', action: 'create', type: 'minor', proposedContent: 'x', mergedContent: 'x' }];
        mergeScanResults([
            { id: 'b', name: 'Dorothy', action: 'create', type: 'minor', proposedContent: 'y', mergedContent: 'y' },
        ], () => {});

        expect(state.stagingItems).toHaveLength(2);
    });
});
