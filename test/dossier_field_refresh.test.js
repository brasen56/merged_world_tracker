/**
 * Tests for TODO §3 "Per-field / partial dossier refresh (Knowledge)":
 *   - sanitizeDossierRefreshFields — the two ownership boundaries (canon_lock
 *     never model-refreshed; personality growth-owned when an evidence file
 *     exists), unknown-key/duplicate filtering, canonical ordering.
 *   - runDossierFieldRefresh — field-scoped request (<refresh_fields>), the
 *     response scoped to requested keys only (defense in depth), the
 *     2-attempt retry, non-dossier refusal.
 *   - dossier_status watermarks — stamp/read/stale math, storage inside the
 *     counters store value (deltaStatus precedent), survival across
 *     persistCounters(), cleanup, garbage tolerance.
 */

import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { resetCoreStubs, setFakeChat, getFakeMeta, setFakeApi } from './stubs/core.js';
import { state } from '../knowledge/state.js';
import { saveSettings } from '../knowledge/settings.js';
import {
    runDossierFieldRefresh, sanitizeDossierRefreshFields,
    extractDossierFieldValues, DOSSIER_FIELDS,
} from '../knowledge/lorebook.js';
import { DOSSIER_FIELD_REFRESH_PROMPT } from '../knowledge/prompts.js';
import {
    recordDossierFieldRefresh, deleteDossierFieldStatus,
    getDossierFieldStatusMap, getDossierFieldStaleness,
    DOSSIER_STATUS_SUBKEY, DOSSIER_STALE_AFTER_MSGS,
} from '../knowledge/dossier_status.js';
import { COUNTERS_META_KEY, knowledgeCountersSchema } from '../knowledge/schema.js';
// The Part 6 pause harness (borrowed from test/paused_chat_cleanup.test.js).
// Direct imports from core/schema_status.js so the REAL pause singleton is
// read under the test barrel→stub alias — the rule evidence.js follows.
import { pauseStore, _resetPausedStores, _setScopeKeyResolver } from '../core/schema_status.js';
import { getEvidenceFile, saveEvidenceMap, deleteEvidenceFile } from '../knowledge/evidence.js';
import { persistCounters } from '../knowledge/index.js';

// ─── Harness ─────────────────────────────────────────────────────────────────

/** Fake world-info module (the test/store.test.js disk contract). */
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
    };
}

const NPC = 'Mara Voss';

const DOSSIER_CONTENT = [
    '[Dossier] Mara Voss | Human | weathered harbourmaster',
    'Tone: brisk',
    'Perceived as: unflappable',
    'Role: Harbourmaster of Dusk Quay',
    'Where to Find: the harbour office at dawn',
    'Appearance: Rope-burned hands and a grey-streaked braid.',
    'Voice: Low and clipped; drops her g\'s.',
    'Background: Former navy quartermaster.',
    'Personality: Paternal but rigid; fears the sea claiming another child.',
    'Read on PC: Wary ally so far.',
    'Current Agenda: Root out the smugglers using her quay.',
    'Secrets: Tier 1 (semi-public): owes the guild a debt | Tier 3 (buried): her brother leads the smugglers',
    'Canon Lock: Born in Dusk Quay; lost her son to a storm twelve years ago',
    'Image Tags: weathered, braid, harbour',
    '',
    'Knowledge Ledger:',
    '- Met the informant at the docks on Day 3 via witness — Day 3',
].join('\n');

let wiFake;
let apiCalls;

beforeEach(() => {
    resetCoreStubs();
    saveSettings({ connectionProfileId: 'test-profile', scope: 'global' });
    wiFake = makeFakeWorldInfo();
    state.wiScript = wiFake;
    wiFake.books.set('Knowledge Tracker', {
        entries: { 7: { uid: 7, comment: NPC, content: DOSSIER_CONTENT } },
    });
    // 6 messages: the stub's getStableHistoryEnd() excludes the trailing 2 by
    // default (recentHistoryExclude), so a shorter chat would yield no stable
    // messages and runDossierFieldRefresh would refuse with "No recent messages".
    setFakeChat([
        { is_user: true, mes: 'The harbour bells ring at dusk.' },
        { is_user: false, mes: 'Mara Voss studies the cargo manifest with narrowed eyes.' },
        { is_user: true, mes: 'Mara slams the ledger shut. "The smuggling runs stop tonight."' },
        { is_user: false, mes: 'Mara posts extra watchers at the quay gates after dusk.' },
        { is_user: true, mes: 'We leave before dawn.' },
        { is_user: false, mes: 'The watchers take their positions silently.' },
    ]);
    apiCalls = [];
    setFakeApi(req => {
        apiCalls.push(req);
        return JSON.stringify({ fields: { agenda: 'Shut down the smuggling runs and post watchers at the quay gates.' } });
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    state.wiScript = null;
    deleteEvidenceFile(NPC);
    _resetPausedStores();
    _setScopeKeyResolver(null);
    vi.restoreAllMocks();
});

// ─── sanitizeDossierRefreshFields ────────────────────────────────────────────

describe('sanitizeDossierRefreshFields — ownership boundaries', () => {
    test('canon_lock is always excluded, with the reason surfaced', () => {
        const { requested, skipped } = sanitizeDossierRefreshFields(['agenda', 'canon_lock'], NPC);
        expect(requested).toEqual(['agenda']);
        expect(skipped).toEqual([{ key: 'canon_lock', reason: expect.stringContaining('user-authored canon') }]);
    });

    test('personality is excluded when the NPC has a growth evidence file', () => {
        const file = getEvidenceFile(NPC);
        file.enrolled = true; // hasEvidenceFile() gate
        saveEvidenceMap();

        const { requested, skipped } = sanitizeDossierRefreshFields(['personality', 'agenda'], NPC);
        expect(requested).toEqual(['agenda']);
        expect(skipped).toEqual([{ key: 'personality', reason: expect.stringContaining('Growth') }]);
    });

    test('personality is refreshable when no growth evidence file exists', () => {
        const { requested, skipped } = sanitizeDossierRefreshFields(['personality', 'agenda'], NPC);
        expect(requested).toEqual(['personality', 'agenda']); // canonical DOSSIER_FIELDS order
        expect(skipped).toEqual([]);
    });

    test('unknown keys are skipped, duplicates dropped, order canonicalized', () => {
        const { requested, skipped } = sanitizeDossierRefreshFields(
            ['secrets', 'bogus_field', 'agenda', 'secrets', ''], NPC,
        );
        expect(requested).toEqual(['agenda', 'secrets']);
        expect(skipped).toEqual([{ key: 'bogus_field', reason: 'not a dossier field' }]);
    });

    test('a bare string key is accepted (defensive UI input)', () => {
        expect(sanitizeDossierRefreshFields('agenda', NPC).requested).toEqual(['agenda']);
    });
});

// ─── runDossierFieldRefresh ──────────────────────────────────────────────────

describe('runDossierFieldRefresh', () => {
    test('refreshes only the requested fields; unrequested model output is discarded', async () => {
        // The model "helpfully" answers with canon_lock + personality too —
        // both must be stripped before the merge, and the merge must leave
        // every unrequested line byte-identical.
        setFakeApi(() => JSON.stringify({
            fields: {
                agenda: 'New agenda from the story.',
                canon_lock: 'MODEL-FORGED CANON',
                personality: 'MODEL-FORGED PERSONALITY',
                secrets: '',
            },
        }));
        const result = await runDossierFieldRefresh(NPC, 7, ['agenda']);

        expect(result.requestedFields).toEqual(['agenda']);
        // Only requested keys enter `fields` — secrets was never requested, so
        // it is absent entirely, and canon_lock/personality output was
        // discarded before the merge.
        expect(result.fields).toEqual({ agenda: 'New agenda from the story.' });
        expect(result.merged).toContain('Current Agenda: New agenda from the story.');
        expect(result.merged).toContain('Canon Lock: Born in Dusk Quay; lost her son to a storm twelve years ago');
        expect(result.merged).toContain('Personality: Paternal but rigid; fears the sea claiming another child.');
        expect(result.merged).toContain('Secrets: Tier 1 (semi-public): owes the guild a debt');
        expect(result.merged).toContain('Knowledge Ledger:');
    });

    test('the request carries a <refresh_fields> block with the current values, and the field-refresh prompt', async () => {
        await runDossierFieldRefresh(NPC, 7, ['agenda', 'secrets']);
        expect(apiCalls.length).toBe(1);
        expect(apiCalls[0].systemPrompt).toBe(DOSSIER_FIELD_REFRESH_PROMPT);
        expect(apiCalls[0].userContent).toContain('<refresh_fields>');
        expect(apiCalls[0].userContent).toContain('"agenda": "Root out the smugglers using her quay."');
        expect(apiCalls[0].userContent).toContain('"secrets"');
        expect(apiCalls[0].userContent).not.toContain('"canon_lock"');
    });

    test('personality is never requested or merged for growth-profiled NPCs', async () => {
        const file = getEvidenceFile(NPC);
        file.enrolled = true;
        saveEvidenceMap();
        setFakeApi(req => {
            apiCalls.push(req);
            return JSON.stringify({
                fields: { personality: 'MODEL-FORGED PERSONALITY', agenda: 'Chasing the ghost ship.' },
            });
        });

        const result = await runDossierFieldRefresh(NPC, 7, ['personality', 'agenda']);

        expect(result.requestedFields).toEqual(['agenda']);
        expect(result.skippedFields.map(s => s.key)).toEqual(['personality']);
        expect(result.fields.personality).toBeUndefined();
        // The telephone-loop partition: the existing Personality line survives.
        expect(result.merged).toContain('Personality: Paternal but rigid; fears the sea claiming another child.');
        expect(result.merged).toContain('Current Agenda: Chasing the ghost ship.');
        // The request itself never offered personality to the model.
        expect(apiCalls[0].userContent).not.toContain('"personality"');
    });

    test('a truncated/invalid first response gets one retry', async () => {
        const responses = ['{truncat', JSON.stringify({ fields: { agenda: 'Second-attempt agenda.' } })];
        setFakeApi(req => {
            apiCalls.push(req);
            return responses.shift();
        });
        const result = await runDossierFieldRefresh(NPC, 7, ['agenda']);
        expect(apiCalls.length).toBe(2);
        expect(apiCalls[1].userContent).toContain('[REMINDER:');
        expect(result.merged).toContain('Current Agenda: Second-attempt agenda.');
    });

    test('two invalid responses throw the standard 2-attempt error', async () => {
        setFakeApi(req => {
            apiCalls.push(req);
            return 'not json at all';
        });
        await expect(runDossierFieldRefresh(NPC, 7, ['agenda'])).rejects.toThrow(/after 2 attempts/);
        expect(apiCalls.length).toBe(2);
    });

    test('refuses a non-dossier entry (the Enrich-first gate)', async () => {
        wiFake.books.set('Knowledge Tracker', {
            entries: { 7: { uid: 7, comment: NPC, content: 'Mara Voss | Human | harbourmaster\nTone: brisk' } },
        });
        await expect(runDossierFieldRefresh(NPC, 7, ['agenda'])).rejects.toThrow(/not in dossier format/);
        expect(apiCalls.length).toBe(0);
    });

    test('refuses a selection that sanitizes down to nothing', async () => {
        await expect(runDossierFieldRefresh(NPC, 7, ['canon_lock', 'nope'])).rejects.toThrow(/No refreshable dossier fields/);
        expect(apiCalls.length).toBe(0);
    });

    test('label mismatch (stale uid → another NPC) refuses to run', async () => {
        wiFake.books.set('Knowledge Tracker', {
            entries: { 7: { uid: 7, comment: 'Someone Else', content: DOSSIER_CONTENT } },
        });
        await expect(runDossierFieldRefresh(NPC, 7, ['agenda'])).rejects.toThrow(/Could not load entry/);
        expect(apiCalls.length).toBe(0);
    });

    test('an empty-string model value reads as null and preserves the existing line', async () => {
        setFakeApi(() => JSON.stringify({ fields: { agenda: '' } }));
        const result = await runDossierFieldRefresh(NPC, 7, ['agenda']);
        expect(result.fields.agenda).toBeNull();
        expect(result.merged).toContain('Current Agenda: Root out the smugglers using her quay.');
    });

    test('an echo response (nothing new) merges byte-identical to the entry', async () => {
        // DOSSIER_FIELD_REFRESH_PROMPT echoes unchanged values rather than
        // returning null, so the picker's no-change detection compares the
        // merge against the current entry — pin that contract here.
        setFakeApi(() => JSON.stringify({ fields: { agenda: 'Root out the smugglers using her quay.' } }));
        const result = await runDossierFieldRefresh(NPC, 7, ['agenda']);
        expect(result.fields.agenda).toBe('Root out the smugglers using her quay.');
        expect(result.merged).toBe(result.currentContent);
    });
});


// ─── extractDossierFieldValues ───────────────────────────────────────────────

describe('extractDossierFieldValues', () => {
    test('maps every dossier label to its value; absent fields read null', () => {
        const values = extractDossierFieldValues(DOSSIER_CONTENT);
        expect(values.agenda).toBe('Root out the smugglers using her quay.');
        expect(values.canon_lock).toBe('Born in Dusk Quay; lost her son to a storm twelve years ago');
        expect(DOSSIER_FIELDS.every(f => typeof values[f.key] !== 'undefined')).toBe(true);
        const partial = extractDossierFieldValues('[Dossier] X | Human | scout\nRole: Scout');
        expect(partial.role).toBe('Scout');
        expect(partial.agenda).toBeNull();
        expect(extractDossierFieldValues(null)).toEqual(Object.fromEntries(DOSSIER_FIELDS.map(f => [f.key, null])));
    });
});

// ─── dossier_status watermarks ───────────────────────────────────────────────

describe('dossier field-status watermarks', () => {
    test('stamps live inside the counters store value and read back (deltaStatus precedent)', () => {
        setFakeChat(Array.from({ length: 40 }, (_, i) => ({ is_user: true, mes: `msg ${i}` })));
        expect(recordDossierFieldRefresh(NPC, ['agenda', 'secrets'], { at: 1000, msgIdx: 40 })).toBe(true);

        const stored = getFakeMeta()[COUNTERS_META_KEY][DOSSIER_STATUS_SUBKEY];
        expect(stored[NPC]).toEqual({
            agenda: { at: 1000, msgIdx: 40 },
            secrets: { at: 1000, msgIdx: 40 },
        });

        // Fresh at the watermark, stale once DOSSIER_STALE_AFTER_MSGS arrive.
        expect(getDossierFieldStaleness(NPC, 'agenda', 40)).toMatchObject({ known: true, stale: false, msgsSince: 0 });
        expect(getDossierFieldStaleness(NPC, 'agenda', 40 + DOSSIER_STALE_AFTER_MSGS - 1).stale).toBe(false);
        expect(getDossierFieldStaleness(NPC, 'agenda', 40 + DOSSIER_STALE_AFTER_MSGS)).toMatchObject({ stale: true, msgsSince: DOSSIER_STALE_AFTER_MSGS });
    });

    test('a field with no watermark reads never-tracked/stale, not garbage', () => {
        expect(getDossierFieldStaleness(NPC, 'agenda', 12)).toEqual({ known: false, stale: true, msgsSince: null, at: null, msgIdx: null });
        expect(getDossierFieldStatusMap()).toEqual({});
    });

    test('a later stamp for one field does not disturb other fields or NPCs', () => {
        recordDossierFieldRefresh(NPC, ['agenda'], { at: 1000, msgIdx: 10 });
        recordDossierFieldRefresh('Other NPC', ['role'], { at: 1000, msgIdx: 10 });
        recordDossierFieldRefresh(NPC, ['secrets'], { at: 2000, msgIdx: 20 });

        const map = getDossierFieldStatusMap();
        expect(map[NPC]).toEqual({ agenda: { at: 1000, msgIdx: 10 }, secrets: { at: 2000, msgIdx: 20 } });
        expect(map['Other NPC']).toEqual({ role: { at: 1000, msgIdx: 10 } });
    });

    test('persistCounters() commits its own keys WITHOUT dropping the sub-key', () => {
        recordDossierFieldRefresh(NPC, ['agenda'], { at: 1000, msgIdx: 5 });

        persistCounters();

        const store = getFakeMeta()[COUNTERS_META_KEY];
        expect(store.dossierFieldStatus[NPC].agenda).toEqual({ at: 1000, msgIdx: 5 });
        expect(store.messageCounter).toBe(0);
        expect(Array.isArray(store.countedReceiptEvents)).toBe(true);
    });

    test('delete removes one NPC and is a no-op when absent', () => {
        recordDossierFieldRefresh(NPC, ['agenda'], { at: 1000, msgIdx: 5 });
        recordDossierFieldRefresh('Keeper', ['role'], { at: 1000, msgIdx: 5 });

        expect(deleteDossierFieldStatus(NPC)).toBe(true);
        expect(getDossierFieldStatusMap()).toEqual({ Keeper: { role: { at: 1000, msgIdx: 5 } } });
        expect(deleteDossierFieldStatus(NPC)).toBe(false);
        expect(deleteDossierFieldStatus('Never Tracked')).toBe(false);
    });

    test('a paused counters store refuses both writes, keeping the previous value (Part 6 seam)', () => {
        // Pause the counters store for a deterministic scope key — the same
        // harness test/paused_chat_cleanup.test.js uses for the chat-change
        // paths. A paused store keeps its untouched original as the
        // recoverable state, so EVERY write seam must refuse, deletes
        // included: committing here would validate the unprepared value at
        // the current version (a silent downgrade for a future-version
        // store).
        _setScopeKeyResolver(() => 'chat:dossier-status-paused');
        pauseStore(knowledgeCountersSchema.id, { reasonCode: 'future-version', message: 'blocked' });

        // The stamp is refused and nothing is written…
        expect(recordDossierFieldRefresh(NPC, ['agenda'], { at: 1000, msgIdx: 5 })).toBe(false);
        expect(getFakeMeta()[COUNTERS_META_KEY]).toBeUndefined();
        expect(getDossierFieldStatusMap()).toEqual({});

        // …and so is the cleanup: the previous value survives intact.
        getFakeMeta()[COUNTERS_META_KEY] = {
            messageCounter: 3,
            [DOSSIER_STATUS_SUBKEY]: {
                [NPC]: { agenda: { at: 1000, msgIdx: 5 } },
                Keeper: { role: { at: 1, msgIdx: 1 } },
            },
        };
        expect(deleteDossierFieldStatus(NPC)).toBe(false);
        expect(getDossierFieldStatusMap()).toEqual({
            [NPC]: { agenda: { at: 1000, msgIdx: 5 } },
            Keeper: { role: { at: 1, msgIdx: 1 } },
        });
        // The counters' own keys ride along untouched too.
        expect(getFakeMeta()[COUNTERS_META_KEY].messageCounter).toBe(3);
    });

    test('a corrupted sub-key reads as empty and the next stamp converges it', () => {
        getFakeMeta()[COUNTERS_META_KEY] = { messageCounter: 3, [DOSSIER_STATUS_SUBKEY]: 'garbage' };
        expect(getDossierFieldStatusMap()).toEqual({});
        expect(recordDossierFieldRefresh(NPC, ['agenda'], { at: 1, msgIdx: 1 })).toBe(true);
        expect(getDossierFieldStatusMap()).toEqual({ [NPC]: { agenda: { at: 1, msgIdx: 1 } } });
        // The counters' own keys ride along untouched.
        expect(getFakeMeta()[COUNTERS_META_KEY].messageCounter).toBe(3);
    });

    test('stamps with unreadable shape read as never tracked', () => {
        getFakeMeta()[COUNTERS_META_KEY] = {
            [DOSSIER_STATUS_SUBKEY]: { [NPC]: { agenda: 'garbage', secrets: { at: 5 } } },
        };
        expect(getDossierFieldStaleness(NPC, 'agenda', 10).known).toBe(false);
        // at-only stamp: known, no msgIdx → stale (cannot prove freshness).
        expect(getDossierFieldStaleness(NPC, 'secrets', 10)).toMatchObject({ known: true, stale: true, msgsSince: null });
    });
});

