/**
 * test/interiority_lifecycle.test.js — the deferred lifecycle substrate
 * (INTERIORITY_LIFECYCLE_IMPLEMENTATION_PLAN.md §4 / TODO.md §3-F, spec
 * archive/completed_plans/INTERIORITY_LIFECYCLE_V2_SPEC.md).
 *
 * Covers the four pillars the spec adds on top of the Tier 1–3 fixes:
 *   §2 lifecycle history      — bounded occurrence records, conservative
 *                               cross-turn closure dedup, rollback ownership
 *   §3 evidence boundaries    — stamped only by scoped successful commits
 *   §4 expiration             — in-world vs turn-aging, engine-only defaults
 *   §5 per-NPC controls       — privacy exclusion + creation-only cost gates
 * plus the persistence seam: schema v2 migration/validation, and the backup
 * merge path through the existing interiority section.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import { resetCoreStubs, setFakeChat } from './stubs/core.js';
import {
    getLedger, addLedgerEntry, addManualLedgerEntry, updateLedgerEntry,
    getInteriorityData, saveSettings, getTurnCounter,
    getOrCreateMsgKeyForIndex,
} from '../interiority/data.js';
import { validateAndApply, assembleNpcBlocks } from '../interiority/generation.js';
import {
    recordLifecycleEvent, getLifecycleHistory, clearLifecycleHistory,
    findRecentClosureMatch, isClosureActive, tokenSimilarity,
    getEvidenceBoundary, getEvidenceBoundaries, restoreEvidenceBoundariesSnapshot,
    getLifecycleHistorySnapshot, restoreLifecycleHistorySnapshot,
    getNpcControl, setNpcControl, removeNpcControl, checkProposalAllowed,
    markLedgerEntryDone, dismissLedgerEntry, mergeLedgerEntries,
    reopenFromLifecycle, sleepLedgerEntryTracked, wakeLedgerEntryTracked,
    findLifecycleConflicts, PRIVACY_WITHHELD_NOTE, MAX_LIFECYCLE_EVENTS,
} from '../interiority/lifecycle.js';
import {
    interioritySchema, migrateInteriorityV1ToV2, validateInteriorityData,
    LIFECYCLE_OUTCOMES,
} from '../interiority/schema.js';
import { buildBackupEnvelope } from '../backup/data.js';
import { planRestore } from '../backup/restore.js';

beforeEach(() => {
    resetCoreStubs();
    globalThis.document = {
        dispatchEvent: vi.fn(),
        getElementById: () => null,
        querySelectorAll: () => [],
    };
});

const CHAT = [
    { name: 'User', is_user: true, mes: 'What will you do at the festival?', extra: {} },
    { name: 'Mara', mes: 'Mara glances toward the square.', extra: {} },
    { name: 'Derek', mes: 'Derek wipes his hands on a rag.', extra: {} },
];

function addActiveEntry(npc, action, trigger, extra = {}) {
    return addLedgerEntry({ npc, action, trigger, ...extra }, 'day 1', 0);
}

// ─── §2 lifecycle history ─────────────────────────────────────────────────────

describe('recordLifecycleEvent', () => {
    test('records a bounded, vocabulary-checked event', () => {
        setFakeChat(CHAT);
        const evt = recordLifecycleEvent({
            npc: 'Mara', action: 'rob the caravan', trigger: 'new moon',
            outcome: 'completed', source: 'engine', reason: 'Done on-screen.', entryId: 'i-1',
        });
        expect(evt).toBeTruthy();
        expect(evt.id).toMatch(/^lc-/);
        expect(evt.outcome).toBe('completed');
        expect(getLifecycleHistory()).toHaveLength(1);

        expect(recordLifecycleEvent({ npc: 'Mara', action: 'x', outcome: 'nonsense' })).toBeNull();
        expect(recordLifecycleEvent({ npc: 'Mara', action: 'x', outcome: 'completed', source: 'nobody' })).toBeNull();
        expect(recordLifecycleEvent({ npc: '', action: 'x', outcome: 'completed' })).toBeNull();
        expect(getLifecycleHistory()).toHaveLength(1);
    });

    test('trims oldest records at the retention cap', () => {
        setFakeChat(CHAT);
        for (let i = 0; i < MAX_LIFECYCLE_EVENTS + 2; i++) {
            recordLifecycleEvent({ npc: 'Mara', action: `plan ${i}`, outcome: 'dropped', turn: i });
        }
        const history = getLifecycleHistory();
        expect(history).toHaveLength(MAX_LIFECYCLE_EVENTS);
        expect(history[0].action).toBe('plan 2');
        expect(history.at(-1).action).toBe(`plan ${MAX_LIFECYCLE_EVENTS + 1}`);
    });

    test('clearLifecycleHistory empties the array and returns the count', () => {
        setFakeChat(CHAT);
        recordLifecycleEvent({ npc: 'Mara', action: 'x', outcome: 'completed' });
        expect(clearLifecycleHistory()).toBe(1);
        expect(getLifecycleHistory()).toHaveLength(0);
        expect(clearLifecycleHistory()).toBe(0);
    });
});

describe('tokenSimilarity', () => {
    test('identical token sets score 1, disjoint score 0, paraphrases score high', () => {
        expect(tokenSimilarity('rob the caravan', 'rob the caravan')).toBe(1);
        expect(tokenSimilarity('rob the caravan', 'bake a pie')).toBe(0);
        // Word order changes are irrelevant; a near-paraphrase stays high.
        expect(tokenSimilarity('install the new stall', 'set up the new stall')).toBeGreaterThan(0.5);
        expect(tokenSimilarity('', '')).toBe(1);
    });
});

describe('findRecentClosureMatch (conservative cross-turn dedup, spec §2)', () => {
    test('matches a same-NPC paraphrase within the window', () => {
        setFakeChat(CHAT);
        recordLifecycleEvent({
            npc: 'Derek', action: 'install the new market stall', trigger: 'when the lumber arrives',
            outcome: 'completed', turn: 2,
        });
        const match = findRecentClosureMatch(
            'Derek',
            'install the new market stall today',
            'when the lumber arrives',
            { turn: 5 },
        );
        expect(match).toBeTruthy();
        expect(match.record.outcome).toBe('completed');
        expect(match.actionSimilarity).toBeGreaterThan(0.85);
        // Conservative by design: a genuinely different verb phrase ("set up"
        // vs "install", Dice ≈ 0.73) stays below the threshold and is NOT a
        // match — the prompt contract and capture own that class of paraphrase.
        expect(findRecentClosureMatch('Derek', 'set up the new market stall', 'when the lumber arrives', { turn: 5 })).toBeNull();
    });

    test('does not match another NPC, an expired window, or a low-similarity action', () => {
        setFakeChat(CHAT);
        recordLifecycleEvent({
            npc: 'Derek', action: 'install the new market stall', trigger: 'when the lumber arrives',
            outcome: 'completed', turn: 0,
        });
        // Different canonical NPC.
        expect(findRecentClosureMatch('Mara', 'install the new market stall', 'when the lumber arrives', { turn: 1 })).toBeNull();
        // Beyond the default window (8 turns).
        expect(findRecentClosureMatch('Derek', 'install the new market stall', 'when the lumber arrives', { turn: 12 })).toBeNull();
        // Clearly different action for the same NPC stays legal.
        expect(findRecentClosureMatch('Derek', 'bake a pie for the festival', 'when the lumber arrives', { turn: 1 })).toBeNull();
        // Window 0 disables the guard entirely.
        recordLifecycleEvent({ npc: 'Mara', action: 'rob the caravan', trigger: 'new moon', outcome: 'dropped', turn: 0 });
        expect(findRecentClosureMatch('Mara', 'rob the caravan', 'new moon', { windowTurns: 0 })).toBeNull();
    });

    test('a reopened closure no longer suppresses (occurrence-specific)', () => {
        setFakeChat(CHAT);
        const closed = recordLifecycleEvent({
            npc: 'Mara', action: 'rob the caravan', trigger: 'new moon', outcome: 'completed', turn: 0,
        });
        expect(isClosureActive(closed)).toBe(true);
        expect(findRecentClosureMatch('Mara', 'rob the caravan', 'new moon', { turn: 1 })).toBeTruthy();

        recordLifecycleEvent({
            npc: 'Mara', action: 'rob the caravan', trigger: 'new moon',
            outcome: 'reopened', source: 'user', reopenedFrom: closed.id, turn: 1,
        });
        expect(isClosureActive(closed)).toBe(false);
        expect(findRecentClosureMatch('Mara', 'rob the caravan', 'new moon', { turn: 2 })).toBeNull();
    });

    test('resolves closure NPCs through the roster resolver (canonical identity)', () => {
        setFakeChat(CHAT);
        recordLifecycleEvent({
            npc: 'Mara Vance', action: 'rob the caravan', trigger: 'new moon', outcome: 'completed', turn: 0,
        });
        // The stored spelling is an alias of the roster member "Mara" — the
        // resolver bridges them exactly like the executed/dropped owner check.
        const resolver = (name) => (name.toLowerCase() === 'mara vance' ? 'Mara' : null);
        expect(findRecentClosureMatch('Mara', 'rob the caravan', 'new moon', { turn: 1, resolveNpc: resolver })).toBeTruthy();
        expect(findRecentClosureMatch('Mara', 'rob the caravan', 'new moon', { turn: 1 })).toBeNull();
    });
});

// ─── §5 per-NPC controls ──────────────────────────────────────────────────────

describe('npcControls', () => {
    test('set/get/remove round-trips normalized values', () => {
        setFakeChat(CHAT);
        setNpcControl('Mara', { privacyExcluded: true, cooldownTurns: 3.7, activeCap: -2 });
        const control = getNpcControl('mara');
        expect(control.privacyExcluded).toBe(true);
        expect(control.cooldownTurns).toBe(3);
        expect(control.activeCap).toBe(0);
        expect(getInteriorityData().npcControls['mara']).toBeTruthy();
        removeNpcControl('Mara');
        expect(getInteriorityData().npcControls['mara']).toBeUndefined();
        // Unknown NPCs read as all-defaults, never null.
        expect(getNpcControl('nobody').privacyExcluded).toBe(false);
    });

    test('checkProposalAllowed: pause, cooldown, and cap — creation-only gates', () => {
        setFakeChat(CHAT);
        // Pause blocks indefinitely…

        setNpcControl('Mara', { pauseNewProposals: true });
        expect(checkProposalAllowed('Mara', { turn: 100 })).toMatchObject({ allowed: false, reason: 'paused' });
        setNpcControl('Mara', { pauseNewProposals: false, cooldownTurns: 3, lastAcceptedTurn: 0 });
        expect(checkProposalAllowed('Mara', { turn: 2 }).reason).toBe('cooldown');
        expect(checkProposalAllowed('Mara', { turn: 3 }).allowed).toBe(true);
        setNpcControl('Mara', { cooldownTurns: 0, lastAcceptedTurn: null, activeCap: 1 });
        addActiveEntry('Mara', 'rob the caravan', 'new moon');
        expect(checkProposalAllowed('Mara', { turn: 0 })).toMatchObject({ allowed: false, reason: 'active-cap' });
        addManualLedgerEntry({ npc: 'Mara', action: 'bake a pie', trigger: 'festival' });
        expect(checkProposalAllowed('Mara', { turn: 0 }).reason).toBe('active-cap');
    });
});

// ─── validateAndApply wiring (spec §2/§3/§4/§5 in the engine pass) ───────────

describe('validateAndApply — lifecycle events and gates', () => {
    test('engine executed/dropped marks record audited lifecycle closures', async () => {
        setFakeChat(CHAT);
        saveSettings({ intentionGracePeriod: 0 });
        const done = addActiveEntry('Mara', 'rob the caravan', 'new moon');
        const dropped = addActiveEntry('Mara', 'bake a pie', 'the festival');

        await validateAndApply({
            npcs: [{
                name: 'Mara',
                executed: [done.id],
                dropped: [{ id: dropped.id, reason: 'She lost her nerve.' }],
            }],
        }, ['Mara'], 1);

        expect(getLedger()).toHaveLength(0);
        const outcomes = getLifecycleHistory().map(e => [e.outcome, e.source, e.reason]);
        expect(outcomes).toEqual(expect.arrayContaining([
            ['dropped', 'engine', 'She lost her nerve.'],
            ['completed', 'engine', 'Completed on-screen and marked executed by the intentions call.'],
        ]));
    });

    test('a confirmed dormant wake records an audited woken event', async () => {
        setFakeChat(CHAT);
        const dormant = addLedgerEntry({
            npc: 'Mara', action: 'visit the market', trigger: 'harvest festival',
            status: 'dormant', wakeHint: 'harvest festival',
        }, 'day 1', 0);

        await validateAndApply({ npcs: [] }, ['Mara'], 1, undefined, undefined, [dormant.id]);

        const entry = getLedger().find(e => e.id === dormant.id);
        expect(entry.status).toBe('active');
        expect(getLifecycleHistory().map(e => e.outcome)).toEqual(['woken']);
    });

    test('a new intention matching a recent closure is rejected as recently-closed', async () => {
        setFakeChat(CHAT);
        recordLifecycleEvent({
            npc: 'Derek', action: 'install the new market stall', trigger: 'when the lumber arrives',
            outcome: 'completed', turn: getTurnCounter(),
        });

        await validateAndApply({
            npcs: [{ name: 'Derek', new_intentions: [
                { action: 'set up the new market stall', trigger: 'when the lumber arrives' },
            ] }],
        }, ['Derek'], 1);

        // "set up" is intentionally below the conservative action-similarity
        // threshold for "install"; it remains a legal new occurrence.
        expect(getLedger()).toHaveLength(1);
    });

    test('per-NPC controls reject creation but never block evaluation', async () => {
        setFakeChat(CHAT);
        saveSettings({ intentionGracePeriod: 0 });
        setNpcControl('Mara', { pauseNewProposals: true });
        const existing = addActiveEntry('Mara', 'rob the caravan', 'new moon');

        await validateAndApply({
            npcs: [{
                name: 'Mara',
                executed: [existing.id],
                new_intentions: [{ action: 'bake a pie', trigger: 'the festival' }],
            }],
        }, ['Mara'], 1);

        // The executed mark applied (evaluation is never gated)…
        expect(getLedger().find(e => e.id === existing.id)).toBeUndefined();
        // …while the proposal was refused by the pause control.
        expect(getLedger()).toHaveLength(0);
    });
});

describe('validateAndApply — expiration (spec §4)', () => {
    test('the global max-turns cap expires engine entries only', async () => {
        setFakeChat(CHAT);
        saveSettings({ intentionMaxTurnsOpen: 2 });
        const engineEntry = addActiveEntry('Mara', 'rob the caravan', 'new moon');
        const manualEntry = addManualLedgerEntry({ npc: 'Derek', action: 'bake a pie', trigger: 'festival' });

        const firstPass = await validateAndApply({ npcs: [] }, ['Mara', 'Derek'], 1);
        const secondPass = await validateAndApply({ npcs: [] }, ['Mara', 'Derek'], 2);

        expect(firstPass.ledgerChanged).toBe(false);
        expect(secondPass.ledgerChanged).toBe(true);
        expect(getLedger().find(e => e.id === engineEntry.id)).toBeUndefined();
        expect(getLedger().find(e => e.id === manualEntry.id)).toBeTruthy();
        const expired = getLifecycleHistory().find(e => e.outcome === 'expired');
        expect(expired.source).toBe('engine');
        expect(expired.reason).toMatch(/Aged out after 2 open turns/);
    });

    test('a per-entry expiresTurn overrides authorship (explicit user intent)', async () => {
        setFakeChat(CHAT);
        const manualEntry = addManualLedgerEntry({ npc: 'Derek', action: 'bake a pie', trigger: 'festival' });
        updateLedgerEntry(manualEntry.id, { expiresTurn: 1 });

        await validateAndApply({ npcs: [] }, ['Derek'], 1);

        expect(getLedger().find(e => e.id === manualEntry.id)).toBeUndefined();
        const expired = getLifecycleHistory().find(e => e.outcome === 'expired');
        expect(expired.reason).toMatch(/per-entry turn limit/);
    });
});

describe('validateAndApply — evidence boundaries (spec §3)', () => {
    test('stamps only roster NPCs whose intentions were evaluated', async () => {
        setFakeChat(CHAT);
        await validateAndApply({
            npcs: [{ name: 'Mara', new_intentions: [] }],
            // Strict mode's per-call report wins over the block list.
            intentionsEvaluatedRoster: ['Mara'],
        }, ['Mara', 'Derek'], 2);

        expect(getEvidenceBoundary('Mara')).toMatchObject({ turn: getTurnCounter(), msgIdx: 2 });
        expect(getEvidenceBoundary('Derek')).toBeNull();
    });

    test('the threaded evaluatedNpcNames parameter is authoritative', async () => {
        setFakeChat(CHAT);
        await validateAndApply(
            { npcs: [{ name: 'Derek' }] },
            ['Mara', 'Derek'],
            1,
            undefined, undefined, [],
            null,
            ['Mara'],
        );
        expect(getEvidenceBoundary('Mara')).toBeTruthy();
        expect(getEvidenceBoundary('Derek')).toBeNull();
    });

    test('an explicitly empty evaluated list stamps nothing (failed intentions call)', async () => {
        setFakeChat(CHAT);
        // Split mode with a failed intentions call threads []. Even though the
        // merged result carries thought blocks for the whole roster, evidence
        // was NOT consumed for anyone.
        await validateAndApply(
            { npcs: [{ name: 'Mara', thought: { type: 'rumination', text: 'Hm.' } }] },
            ['Mara'],
            1,
            undefined, undefined, [],
            null,
            [],
        );
        expect(getEvidenceBoundaries()).toEqual({});
    });

    test('a thoughts-only turn stamps nothing', async () => {
        setFakeChat(CHAT);
        saveSettings({ generateIntentions: false });
        await validateAndApply({
            npcs: [{ name: 'Mara', thought: { type: 'rumination', text: 'The festival draws near.' } }],
        }, ['Mara'], 1);
        expect(getEvidenceBoundaries()).toEqual({});
    });

    test('the perMessage record carries the lifecycle rollback snapshots', async () => {
        setFakeChat(CHAT);
        await validateAndApply({ npcs: [] }, ['Mara'], 1);
        const key = getOrCreateMsgKeyForIndex(1);
        const record = getInteriorityData().perMessage[key];
        expect(Array.isArray(record.lifecycleHistorySnapshot)).toBe(true);
        expect(record.evidenceBoundariesSnapshot).toEqual({});
    });
});

// ─── Rollback ownership (spec §2/§3) ──────────────────────────────────────────

describe('lifecycle rollback restores', () => {
    test('engine records truncate, user records survive', () => {
        setFakeChat(CHAT);
        recordLifecycleEvent({ npc: 'Mara', action: 'before', outcome: 'completed', turn: 0 });
        const snapshot = getLifecycleHistorySnapshot();

        recordLifecycleEvent({ npc: 'Mara', action: 'engine-done', outcome: 'completed', source: 'engine', turn: 1 });
        recordLifecycleEvent({ npc: 'Derek', action: 'user-done', outcome: 'completed', source: 'user', turn: 1 });

        const removed = restoreLifecycleHistorySnapshot(snapshot);
        expect(removed).toBe(1);
        const history = getLifecycleHistory();
        expect(history.map(e => e.action)).toEqual(['before', 'user-done']);
    });

    test('engine records still truncate once the history sits at the retention cap', () => {
        setFakeChat(CHAT);
        // The steady state for any long chat: the history is pinned at the cap,
        // so every push trims an older record and the LENGTH never moves. A
        // length-derived "how many were added" count reads 0 here and would
        // skip the restore entirely, leaking the swiped generation's records.
        for (let i = 0; i < MAX_LIFECYCLE_EVENTS; i++) {
            recordLifecycleEvent({ npc: 'Mara', action: `old-${i}`, outcome: 'completed', source: 'engine', turn: 0 });
        }
        const snapshot = getLifecycleHistorySnapshot();
        expect(snapshot).toHaveLength(MAX_LIFECYCLE_EVENTS);

        for (let i = 0; i < 3; i++) {
            recordLifecycleEvent({ npc: 'Mara', action: `new-${i}`, outcome: 'completed', source: 'engine', turn: 1 });
        }
        expect(getLifecycleHistory()).toHaveLength(MAX_LIFECYCLE_EVENTS); // length unchanged

        expect(restoreLifecycleHistorySnapshot(snapshot)).toBe(3);
        expect(getLifecycleHistory().filter(e => e.action.startsWith('new-'))).toEqual([]);
    });

    test('a snapshot with nothing written after it is a no-op', () => {
        setFakeChat(CHAT);
        recordLifecycleEvent({ npc: 'Mara', action: 'only', outcome: 'completed', turn: 0 });
        const snapshot = getLifecycleHistorySnapshot();
        expect(restoreLifecycleHistorySnapshot(snapshot)).toBe(0);
        expect(getLifecycleHistory().map(e => e.action)).toEqual(['only']);
    });

    test('evidence boundaries restore wholesale from the snapshot', () => {
        setFakeChat(CHAT);
        // Simulate stamps from a generation that will be swiped away.
        const data = getInteriorityData();
        data.evidenceBoundaries = { mara: { turn: 0, msgIdx: 1, msgKey: null, at: 1 } };
        const before = JSON.parse(JSON.stringify(data.evidenceBoundaries));
        data.evidenceBoundaries.mara = { turn: 5, msgIdx: 9, msgKey: null, at: 2 };
        data.evidenceBoundaries.derek = { turn: 5, msgIdx: 9, msgKey: null, at: 2 };

        restoreEvidenceBoundariesSnapshot(before);
        expect(getEvidenceBoundaries()).toEqual({ mara: { turn: 0, msgIdx: 1, msgKey: null, at: 1 } });
    });
});


// ─── User lifecycle actions (spec §2/§4) ──────────────────────────────────────

describe('user actions', () => {
    test('mark done / dismiss close the occurrence without a tombstone', () => {
        setFakeChat(CHAT);
        const a = addActiveEntry('Mara', 'rob the caravan', 'new moon');
        const b = addActiveEntry('Derek', 'bake a pie', 'festival');

        expect(markLedgerEntryDone(a.id)).toBeTruthy();
        expect(dismissLedgerEntry(b.id)).toBeTruthy();
        expect(getLedger()).toHaveLength(0);
        // Occurrence-scoped: no permanent tombstone blocks a later repeat.
        expect(getInteriorityData().deletedIntentions).toHaveLength(0);
        expect(getLifecycleHistory().map(e => [e.outcome, e.source])).toEqual(
            [['completed', 'user'], ['dropped', 'user']],
        );
    });

    test('merge keeps one entry and supersedes the other', () => {
        setFakeChat(CHAT);
        const keep = addActiveEntry('Mara', 'rob the caravan', 'new moon');
        const drop = addActiveEntry('Mara', 'rob the caravan tonight', 'new moon');

        const record = mergeLedgerEntries(keep.id, drop.id);
        expect(record.outcome).toBe('merged');
        expect(record.supersededBy).toBe(keep.id);
        expect(getLedger().map(e => e.id)).toEqual([keep.id]);
    });

    test('reopen creates a manual entry and clears the closure as a dedup key', () => {
        setFakeChat(CHAT);
        const closed = recordLifecycleEvent({
            npc: 'Mara', action: 'rob the caravan', trigger: 'new moon',
            outcome: 'completed', source: 'engine', turn: 0,
        });
        const entry = reopenFromLifecycle(closed.id);
        expect(entry).toBeTruthy();
        expect(entry.manual).toBe(true);
        expect(entry.reopenedFrom).toBe(closed.id);
        expect(getLedger()).toHaveLength(1);
        // A second reopen of the same closure is refused…
        expect(reopenFromLifecycle(closed.id)).toBeNull();
        // …and the reopened plan no longer suppresses its own re-proposal.
        expect(findRecentClosureMatch('Mara', 'rob the caravan', 'new moon', { turn: 1 })).toBeNull();
    });

    test('sleep/wake tracked wrappers record audited transitions', () => {
        setFakeChat(CHAT);
        const entry = addActiveEntry('Mara', 'visit the market', 'harvest festival');

        sleepLedgerEntryTracked(entry.id, 'harvest festival');
        expect(getLedger().find(e => e.id === entry.id).status).toBe('dormant');
        wakeLedgerEntryTracked(entry.id, 2);
        expect(getLedger().find(e => e.id === entry.id).status).toBe('active');
        expect(getLifecycleHistory().map(e => e.outcome)).toEqual(['slept', 'woken']);
    });
});

// ─── Conflicts (spec §2 / TODO §3-F) ──────────────────────────────────────────

describe('findLifecycleConflicts', () => {
    test('flags near-identical pairs as duplicates and same-trigger pairs as occasions', () => {
        setFakeChat(CHAT);
        addActiveEntry('Mara', 'rob the caravan', 'at the new moon');
        addActiveEntry('Mara', 'rob the caravan tonight', 'at the new moon');   // duplicate of #1
        addActiveEntry('Mara', 'poison the well', 'at the new moon');           // different plan, same occasion
        addActiveEntry('Derek', 'rob the caravan', 'at the new moon');          // other NPC: never compared

        const conflicts = findLifecycleConflicts();
        // One duplicate pair (the two rob entries)…
        expect(conflicts.filter(c => c.type === 'duplicate')).toHaveLength(1);
        // …and TWO occasion pairs — each clearly-different action competes with
        // BOTH rob entries for the same trigger moment.
        expect(conflicts.filter(c => c.type === 'occasion')).toHaveLength(2);
        expect(conflicts.every(c => c.npc === 'mara')).toBe(true);
    });
});

// ─── Schema v2 (spec §1/§2/§5) ────────────────────────────────────────────────

describe('interiority schema v2', () => {
    test('v1 → v2 migration defaults only the absent containers', () => {
        const v1 = { enabled: true, ledger: [], deletedIntentions: [], perMessage: {}, turnCounter: 3 };
        const migrated = migrateInteriorityV1ToV2(v1);
        expect(migrated.data).toEqual({
            ...v1,
            lifecycleHistory: [],
            evidenceBoundaries: {},
            npcControls: {},
        });
        // Present-but-invalid values are left for the validator, never replaced;
        // only the ABSENT third container is defaulted.
        const hostile = { lifecycleHistory: 'nope', npcControls: 7 };
        expect(migrateInteriorityV1ToV2(hostile).data).toEqual({
            lifecycleHistory: 'nope',
            npcControls: 7,
            evidenceBoundaries: {},
        });
    });

    test('the validator quarantines bad lifecycle records and map values', () => {
        const result = validateInteriorityData({
            lifecycleHistory: [
                { id: 'lc-1', entryId: 'i-1', npc: 'Mara', action: 'x', trigger: 'now', reason: '', outcome: 'completed', source: 'engine', turn: 1, at: 1 },
                { id: 'lc-2', entryId: 'i-2', npc: 'Mara', action: 'x', trigger: 'now', reason: '', outcome: 'teleported', source: 'engine', turn: 1, at: 1 },
            ],
            evidenceBoundaries: {
                mara: { turn: 2, msgIdx: 1, msgKey: null, at: 1 },
                derek: { turn: 'soon' },
            },
            npcControls: {
                mara: { privacyExcluded: true },
                derek: { cooldownTurns: 'many' },
            },
        });
        const codes = result.issues.map(issue => issue.code);
        expect(codes).toContain('lifecycle-invalid-outcome');
        expect(codes).toContain('evidence-boundary-invalid');
        expect(codes).toContain('npc-control-invalid');
        // The valid siblings survive.
        expect(result.data.lifecycleHistory).toHaveLength(1);
        expect(result.data.evidenceBoundaries.mara.turn).toBe(2);
        expect(result.data.npcControls.mara.privacyExcluded).toBe(true);
    });

    test('the descriptor is at version 2 with the containers in createDefault', () => {
        expect(interioritySchema.currentVersion).toBe(2);
        expect(interioritySchema.migrations[1]).toBe(migrateInteriorityV1ToV2);
        expect(interioritySchema.createDefault()).toEqual({
            enabled: true, ledger: [], deletedIntentions: [], perMessage: {},
            turnCounter: 0, lifecycleHistory: [], evidenceBoundaries: {}, npcControls: {},
        });
        expect(LIFECYCLE_OUTCOMES).toEqual(
            expect.arrayContaining(['completed', 'dropped', 'expired', 'merged', 'reopened', 'slept', 'woken']),
        );
    });
});

// ─── Backup merge through the existing interiority section (spec §6) ─────────

describe('backup merge — lifecycle containers', () => {
    test('merges history by id and the maps current-wins / new-names-add', () => {
        const file = buildBackupEnvelope({
            identity: { chatId: 'chat-a', isUnknown: false, characterKey: null, groupKey: null },
            sectionVersions: { interiority: 2 },
            metadata: {
                interiority: {
                    enabled: true, ledger: [], deletedIntentions: [], turnCounter: 0,
                    lifecycleHistory: [
                        { id: 'lc-b', entryId: 'i-b', npc: 'Derek', action: 'b', trigger: 'now', reason: '', outcome: 'completed', source: 'engine', turn: 2, at: 2 },
                    ],
                    evidenceBoundaries: { incoming: { turn: 9, msgIdx: 9, msgKey: null, at: 9 } },
                    npcControls: { derek: { privacyExcluded: true } },
                },
            },
        });
        const result = planRestore(file, {
            interiority: {
                enabled: true, ledger: [], deletedIntentions: [], turnCounter: 4,
                lifecycleHistory: [
                    { id: 'lc-a', entryId: 'i-a', npc: 'Mara', action: 'a', trigger: 'now', reason: '', outcome: 'dropped', source: 'engine', turn: 1, at: 1 },
                ],
                evidenceBoundaries: { current: { turn: 1, msgIdx: 1, msgKey: null, at: 1 } },
                npcControls: {},
            },
        });
        expect(result.ok).toBe(true);
        const merged = result.plan.sections.interiority;
        expect(merged.lifecycleHistory.map(e => e.id).sort()).toEqual(['lc-a', 'lc-b']);
        expect(Object.keys(merged.evidenceBoundaries).sort()).toEqual(['current', 'incoming']);
        expect(merged.npcControls.derek.privacyExcluded).toBe(true);
        // Session scalars keep their current-wins protection.
        expect(merged.turnCounter).toBe(4);
    });

    test('normalizes lifecycle map keys before applying current-wins conflicts', () => {
        const file = buildBackupEnvelope({
            identity: { chatId: 'chat-a', isUnknown: false, characterKey: null, groupKey: null },
            sectionVersions: { interiority: 2 },
            metadata: {
                interiority: {
                    ledger: [], deletedIntentions: [],
                    evidenceBoundaries: { ' Derek ': { turn: 9, msgIdx: 9, msgKey: null, at: 9 } },
                    npcControls: { 'DEREK ': { privacyExcluded: true } },
                },
            },
        });
        const result = planRestore(file, {
            interiority: {
                ledger: [], deletedIntentions: [],
                evidenceBoundaries: { derek: { turn: 1, msgIdx: 1, msgKey: null, at: 1 } },
                npcControls: {},
            },
        });

        expect(result.ok).toBe(true);
        expect(Object.keys(result.plan.sections.interiority.evidenceBoundaries)).toEqual(['derek']);
        expect(result.plan.sections.interiority.evidenceBoundaries.derek.turn).toBe(1);
        expect(Object.keys(result.plan.sections.interiority.npcControls)).toEqual(['derek']);
    });
});

// ─── Privacy exclusion (spec §5) ──────────────────────────────────────────────

describe('privacy exclusion', () => {
    test('assembleNpcBlocks withholds the dossier for an excluded NPC only', async () => {
        setFakeChat(CHAT);
        setNpcControl('Mara', { privacyExcluded: true });
        const blocks = await assembleNpcBlocks(['Mara', 'Derek']);
        expect(blocks[0].knowledgeEntry).toBe(PRIVACY_WITHHELD_NOTE);
        // The non-excluded NPC goes through the normal loader (null without a
        // registry entry in tests — never the withheld note).
        expect(blocks[1].knowledgeEntry).not.toBe(PRIVACY_WITHHELD_NOTE);
    });
});
