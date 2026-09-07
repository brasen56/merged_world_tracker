/**
 * test/interiority_capture.test.js — lifecycle plan Tier 1 item 4.
 *
 * The generation-scoped intentions capture must:
 *  - capture nothing unless explicitly enabled (opt-in default off);
 *  - group a generation's constituent calls under ONE snapshot, keeping
 *    prompts, raw responses, ledger before/after, and decision reasons;
 *  - never let a thoughts-only (or dormant-poll-only) generation overwrite
 *    committed intentions evidence;
 *  - discard (not commit) when the scope epoch changed mid-generation, and
 *    lazily discard stale committed snapshots on read;
 *  - bound what it stores (text caps, decision overflow counted);
 *  - echo only METADATA into the ordinary diagnostics ring;
 *  - surface through the report section content-gated + secret-scrubbed.
 *
 * Focused file on purpose (module-singleton isolation): the capture lives
 * outside the chat-metadata store, so its lifecycle is easiest to pin here
 * rather than inside the ledger/swipe suites.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { resetCoreStubs, setFakeChat } from './stubs/core.js';
import { bumpEpoch } from '../core/scope.js';
import { getEvents } from '../core/diagnostics.js';
import { redactForReport } from '../core/redaction.js';
import {
    beginIntentionsGenerationCapture, completeIntentionsGenerationCapture,
    noteIntentionsCaptureCall, noteIntentionsCaptureDecision,
    noteIntentionsCaptureRoster, clearIntentionsCapture,
    getIntentionsCaptureSnapshot, isIntentionsCaptureActive,
    collectIntentionsCaptureSection, _resetIntentionsCapture,
    CAPTURE_TEXT_CHAR_CAP, CAPTURE_MAX_DECISIONS,
} from '../interiority/capture.js';

beforeEach(() => {
    resetCoreStubs();
    _resetIntentionsCapture();
});

describe('opt-in contract', () => {
    test('nothing is captured unless enabled at begin time', () => {
        setFakeChat([{ name: 'Narrator', mes: 'A quiet night.', extra: {} }]);
        beginIntentionsGenerationCapture({ enabled: false, ledgerBefore: [] });
        expect(isIntentionsCaptureActive()).toBe(false);

        const call = noteIntentionsCaptureCall({ kind: 'intentions', systemPrompt: 'SYS', userContent: 'USER' });
        call.attempt({ ok: true, rawResponse: 'RAW' });
        call.finish({ parsed: true });
        noteIntentionsCaptureDecision({ npc: 'Mara', kind: 'new_intention', outcome: 'accepted' });

        expect(completeIntentionsGenerationCapture({ ledgerAfter: [] })).toBeNull();
        expect(getIntentionsCaptureSnapshot()).toBeNull();
    });
});

describe('a committed generation snapshot', () => {
    test('keeps prompts, raw responses, decisions, and ledger before/after', () => {
        setFakeChat([{ name: 'Narrator', mes: 'Mara slips out the back.', extra: {} }]);
        beginIntentionsGenerationCapture({
            enabled: true, mode: 'strict', trigger: 'auto',
            ledgerBefore: [{ id: 'i-1', npc: 'Mara', action: 'watch the road', trigger: 'dawn' }],
        });
        noteIntentionsCaptureRoster(['Mara']);

        const call = noteIntentionsCaptureCall({
            kind: 'intentions', label: 'strict:Mara', npc: 'Mara',
            systemPrompt: 'SYS-PROMPT', userContent: 'USER-CONTENT',
        });
        call.attempt({ ok: true, rawResponse: '{"npcs":[]}', normalisedResponse: '{"npcs":[]}' });
        call.finish({ parsed: true });
        noteIntentionsCaptureDecision({ npc: 'Mara', kind: 'new_intention', action: 'a', trigger: 't', outcome: 'accepted', id: 'i-9' });

        const committed = completeIntentionsGenerationCapture({
            ledgerAfter: [{ id: 'i-9', npc: 'Mara', action: 'a', trigger: 't' }],
        });

        expect(committed).not.toBeNull();
        expect(committed.mode).toBe('strict');
        expect(committed.trigger).toBe('auto');
        expect(committed.roster).toEqual(['Mara']);
        expect(committed.ledgerBefore.total).toBe(1);
        expect(committed.ledgerAfter.total).toBe(1);
        expect(committed.calls).toHaveLength(1);
        expect(committed.calls[0]).toMatchObject({
            kind: 'intentions', label: 'strict:Mara', npc: 'Mara', parsed: true,
        });
        expect(committed.calls[0].systemPrompt).toBe('SYS-PROMPT');
        expect(committed.calls[0].userContent).toBe('USER-CONTENT');
        expect(committed.calls[0].attempts[0].rawResponse).toBe('{"npcs":[]}');
        expect(committed.decisions).toHaveLength(1);
        expect(committed.decisions[0]).toMatchObject({ npc: 'Mara', outcome: 'accepted', id: 'i-9' });
        expect(committed.counts).toMatchObject({ calls: 1, decisions: 1 });
    });

    test('a later intentions generation replaces the snapshot (latest only)', () => {
        setFakeChat([{ name: 'Narrator', mes: 'x', extra: {} }]);
        beginIntentionsGenerationCapture({ enabled: true, mode: 'unified' });
        noteIntentionsCaptureCall({ kind: 'intentions' }).finish({ parsed: true });
        const first = completeIntentionsGenerationCapture({ ledgerAfter: [] });

        beginIntentionsGenerationCapture({ enabled: true, mode: 'strict' });
        noteIntentionsCaptureCall({ kind: 'intentions' }).finish({ parsed: true });
        const second = completeIntentionsGenerationCapture({ ledgerAfter: [] });

        expect(second.id).not.toBe(first.id);
        expect(getIntentionsCaptureSnapshot().id).toBe(second.id);
    });
});

describe('thoughts-only responses never overwrite intentions evidence', () => {
    test('a thoughts-only generation keeps the previous committed snapshot', () => {
        setFakeChat([{ name: 'Narrator', mes: 'x', extra: {} }]);
        beginIntentionsGenerationCapture({ enabled: true, mode: 'split' });
        noteIntentionsCaptureCall({ kind: 'intentions', label: 'intentions' }).finish({ parsed: true });
        const committed = completeIntentionsGenerationCapture({ ledgerAfter: [] });
        expect(committed).not.toBeNull();

        // Next turn: thoughts call only (intentions disabled / skipped).
        beginIntentionsGenerationCapture({ enabled: true, mode: 'split' });
        noteIntentionsCaptureCall({ kind: 'thoughts', label: 'thoughts' }).finish({ parsed: true });
        expect(completeIntentionsGenerationCapture({ ledgerAfter: [] })).toBeNull();

        expect(getIntentionsCaptureSnapshot().id).toBe(committed.id);
    });

    test('a dormant-poll-only generation does not commit either', () => {
        setFakeChat([{ name: 'Narrator', mes: 'x', extra: {} }]);
        beginIntentionsGenerationCapture({ enabled: true, mode: 'unified' });
        noteIntentionsCaptureCall({ kind: 'dormant_poll', label: 'dormant_poll' }).finish({ parsed: true });
        expect(completeIntentionsGenerationCapture({ ledgerAfter: [] })).toBeNull();
        expect(getIntentionsCaptureSnapshot()).toBeNull();
    });
});

describe('scope isolation across chat changes', () => {
    test('an epoch change mid-generation discards the pending capture', () => {
        setFakeChat([{ name: 'Narrator', mes: 'x', extra: {} }]);
        beginIntentionsGenerationCapture({ enabled: true, mode: 'unified' });
        noteIntentionsCaptureCall({ kind: 'intentions' }).finish({ parsed: true });

        bumpEpoch(); // chat switched between begin and complete

        expect(completeIntentionsGenerationCapture({ ledgerAfter: [] })).toBeNull();
        expect(getIntentionsCaptureSnapshot()).toBeNull();
    });

    test('a committed snapshot goes stale after an epoch change', () => {
        setFakeChat([{ name: 'Narrator', mes: 'x', extra: {} }]);
        beginIntentionsGenerationCapture({ enabled: true, mode: 'unified' });
        noteIntentionsCaptureCall({ kind: 'intentions' }).finish({ parsed: true });
        expect(completeIntentionsGenerationCapture({ ledgerAfter: [] })).not.toBeNull();

        bumpEpoch(); // chat switched without the explicit clear

        expect(getIntentionsCaptureSnapshot()).toBeNull();
    });

    test('clearIntentionsCapture wipes everything', () => {
        setFakeChat([{ name: 'Narrator', mes: 'x', extra: {} }]);
        beginIntentionsGenerationCapture({ enabled: true, mode: 'unified' });
        noteIntentionsCaptureCall({ kind: 'intentions' }).finish({ parsed: true });
        completeIntentionsGenerationCapture({ ledgerAfter: [] });

        clearIntentionsCapture();

        expect(getIntentionsCaptureSnapshot()).toBeNull();
        expect(isIntentionsCaptureActive()).toBe(false);
    });
});

describe('bounds', () => {
    test('oversized prompt text is truncated, not stored whole', () => {
        setFakeChat([{ name: 'Narrator', mes: 'x', extra: {} }]);
        beginIntentionsGenerationCapture({ enabled: true, mode: 'unified' });
        const long = 'x'.repeat(CAPTURE_TEXT_CHAR_CAP + 5000);
        noteIntentionsCaptureCall({ kind: 'intentions', systemPrompt: long }).finish({ parsed: true });
        const committed = completeIntentionsGenerationCapture({ ledgerAfter: [] });

        const stored = committed.calls[0].systemPrompt;
        expect(stored.length).toBeLessThan(long.length);
        expect(stored).toContain('truncated');
    });

    test('decision overflow is counted, not stored', () => {
        setFakeChat([{ name: 'Narrator', mes: 'x', extra: {} }]);
        beginIntentionsGenerationCapture({ enabled: true, mode: 'unified' });
        noteIntentionsCaptureCall({ kind: 'intentions' }).finish({ parsed: true });
        for (let i = 0; i < CAPTURE_MAX_DECISIONS + 10; i++) {
            noteIntentionsCaptureDecision({ npc: 'Mara', kind: 'new_intention', outcome: 'accepted' });
        }
        const committed = completeIntentionsGenerationCapture({ ledgerAfter: [] });

        expect(committed.decisions).toHaveLength(CAPTURE_MAX_DECISIONS);
        expect(committed.droppedDecisions).toBe(10);
        expect(committed.counts.decisions).toBe(CAPTURE_MAX_DECISIONS + 10);
    });
});

describe('the ordinary diagnostics ring gets metadata only', () => {
    test('the commit echo carries counts and ids, never prompt bodies', () => {
        setFakeChat([{ name: 'Narrator', mes: 'x', extra: {} }]);
        beginIntentionsGenerationCapture({ enabled: true, mode: 'strict' });
        noteIntentionsCaptureCall({
            kind: 'intentions', systemPrompt: 'SECRET-FREE-BUT-PROMPT-BODY',
            userContent: 'USER-BODY-MARKER',
        }).finish({ parsed: true });
        completeIntentionsGenerationCapture({ ledgerAfter: [] });

        const echoes = getEvents({ module: 'interiority' }).filter(e => e.event === 'intentions_capture');
        expect(echoes).toHaveLength(1);
        const serialized = JSON.stringify(echoes[0].detail);
        expect(serialized).toContain('strict');
        expect(serialized).not.toContain('SECRET-FREE-BUT-PROMPT-BODY');
        expect(serialized).not.toContain('USER-BODY-MARKER');
    });
});

describe('report section and redaction', () => {
    test('with nothing captured the section states unavailability', () => {
        const section = collectIntentionsCaptureSection();
        expect(section.meta.available).toBe(false);
        expect(section.payload).toBeUndefined();
    });

    test('the payload body is content-gated through the shared redaction layer', () => {
        setFakeChat([{ name: 'Narrator', mes: 'x', extra: {} }]);
        beginIntentionsGenerationCapture({ enabled: true, mode: 'unified' });
        noteIntentionsCaptureCall({
            kind: 'intentions',
            systemPrompt: 'PROMPT with embedded key url https://proxy.example.com/v1/sk-live-abc123def456/chat',
        }).finish({ parsed: true });
        noteIntentionsCaptureDecision({ npc: 'Mara', kind: 'new_intention', action: 'a', trigger: 't', outcome: 'rejected', reason: 'cap-reached' });
        completeIntentionsGenerationCapture({ ledgerAfter: [] });

        const section = collectIntentionsCaptureSection();
        expect(section.meta.available).toBe(true);
        expect(section.meta.mode).toBe('unified');

        // Content opt-in OFF: the whole evidence body collapses to a marker…
        const excluded = redactForReport(section, { includeContent: false });
        expect(typeof excluded.payload).toBe('string');
        expect(excluded.payload).toContain('excluded');
        expect(excluded.meta.available).toBe(true); // telemetry stays visible

        // …content opt-in ON: bodies appear, but embedded secrets are still
        // scrubbed (opting into content never opts into secrets).
        const included = redactForReport(section, { includeContent: true });
        expect(included.payload.calls[0].systemPrompt).toContain('PROMPT with embedded key url');
        expect(included.payload.calls[0].systemPrompt).not.toContain('sk-live-abc123def456');
        expect(included.payload.decisions[0].reason).toBe('cap-reached');
    });

    test('the roster is content: names live in payload, meta carries only a count', () => {
        setFakeChat([{ name: 'Narrator', mes: 'x', extra: {} }]);
        beginIntentionsGenerationCapture({ enabled: true, mode: 'unified' });
        noteIntentionsCaptureRoster(['Mara Vance', 'Derek Vale']);
        noteIntentionsCaptureCall({ kind: 'intentions' }).finish({ parsed: true });
        completeIntentionsGenerationCapture({ ledgerAfter: [] });

        const section = collectIntentionsCaptureSection();
        // meta is telemetry-safe: a numeric count, never the names.
        expect(section.meta.rosterCount).toBe(2);
        expect(section.meta.roster).toBeUndefined();
        // The names are evidence — nested under payload with the bodies.
        expect(section.payload.roster).toEqual(['Mara Vance', 'Derek Vale']);

        // Content opt-in OFF: no NPC name survives anywhere in the section…
        const excluded = JSON.stringify(redactForReport(section, { includeContent: false }));
        expect(excluded).not.toContain('Mara Vance');
        expect(excluded).not.toContain('Derek Vale');
        // …opt-in ON: the roster rides with the rest of the evidence body.
        const included = redactForReport(section, { includeContent: true });
        expect(included.payload.roster).toEqual(['Mara Vance', 'Derek Vale']);

        // Field-name backstop: a bare `roster` array anywhere in a report is
        // gated by CONTENT_KEYS even outside the payload umbrella.
        const backstop = redactForReport({ roster: ['Mara Vance'] }, { includeContent: false });
        expect(backstop.roster).toBe('[content excluded — 1 item(s)]');
    });
});

describe('wiring — runStrictCalls + validateAndApply under an active capture', () => {
    // The Tier 1 regression list: "Diagnostics collect all intentions
    // constituent calls for a generation, preserve ledger before/after and
    // reasons." This drives the real seams — fetchAndParse records each
    // strict call's prompts and raw response; validateAndApply records each
    // accept/reject/ignore decision with its reason.

    const CHAT = [
        { name: 'User', is_user: true, mes: 'The depot settles for the night.', extra: {} },
        { name: 'Narrator', mes: 'Mara finishes the installation while Derek keeps watch.', extra: {} },
    ];

    test('captures the strict generation and the validation decisions', async () => {
        const { saveSettings, addLedgerEntry, getLedger } = await import('../interiority/data.js');
        const { setFakeApi } = await import('./stubs/core.js');
        const { runStrictCalls, validateAndApply } = await import('../interiority/generation.js');

        setFakeChat(CHAT);
        saveSettings({
            apiUrl: 'https://example.test', modelName: 'test',
            generateThoughts: false, generateIntentions: true, intentionGracePeriod: 0,
        });
        const mara = addLedgerEntry({ npc: 'Mara', action: 'finish the installation', trigger: 'nightfall' }, 'day 1', 0);
        setFakeApi(async () => JSON.stringify({ npcs: [] }));

        beginIntentionsGenerationCapture({ enabled: true, mode: 'strict', ledgerBefore: getLedger() });
        noteIntentionsCaptureRoster(['Mara', 'Derek']);

        await runStrictCalls(['Mara', 'Derek']);
        await validateAndApply(
            {
                npcs: [
                    // Derek tries to close Mara's entry — wrong owner, so the
                    // entry survives his block…
                    { name: 'Derek', executed: [mara.id] },
                    // …while Mara proposes a duplicate of her live entry plus
                    // three new plans (cap accepts two).
                    {
                        name: 'Mara', new_intentions: [
                            { action: 'finish the installation', trigger: 'nightfall' },
                            { action: 'stash the coin', trigger: 'sundown' },
                            { action: 'copy the key', trigger: 'the watch change' },
                            { action: 'scope the vault', trigger: 'midnight' },
                        ],
                    },
                ],
            },
            ['Mara', 'Derek'], 1,
        );

        const committed = completeIntentionsGenerationCapture({ ledgerAfter: getLedger() });
        expect(committed).not.toBeNull();
        expect(committed.mode).toBe('strict');

        // All constituent calls collected under the one generation, with
        // prompts and raw returned text.
        expect(committed.calls).toHaveLength(2);
        expect(committed.calls.map(c => c.label)).toEqual(['strict:Mara', 'strict:Derek']);
        for (const call of committed.calls) {
            expect(call.kind).toBe('intentions');
            expect(call.parsed).toBe(true);
            expect(call.systemPrompt).toContain('NEW INTENTIONS');
            expect(call.userContent).toContain('recent_messages');
            expect(call.attempts[0].rawResponse).toBe('{"npcs":[]}');
        }

        // Ledger before/after preserved: Mara's original (protected by the
        // owner check) + the two capped additions.
        expect(committed.ledgerBefore.total).toBe(1);
        expect(committed.ledgerAfter.total).toBe(3);

        // Decisions with reasons: Derek's wrong-owner execute ignored;
        // duplicate rejected; two new accepted; one cap-rejected.
        const reasons = committed.decisions
            .filter(d => d.kind !== 'block')
            .map(d => `${d.outcome}:${d.reason ?? 'null'}`);
        expect(reasons).toContain('ignored:wrong-owner');
        expect(reasons).toContain('rejected:duplicate');
        expect(reasons).toContain('rejected:cap-reached');
        expect(reasons.filter(r => r === 'accepted:null')).toHaveLength(2);
    });

    test('a parse THROW records one attempt per wire call, never two (production parser path)', async () => {
        const { saveSettings, addLedgerEntry, getLedger } = await import('../interiority/data.js');
        const { setFakeApi, setFakeParser } = await import('./stubs/core.js');
        const { runStrictCalls } = await import('../interiority/generation.js');

        setFakeChat(CHAT);
        saveSettings({
            apiUrl: 'https://example.test', modelName: 'test',
            generateThoughts: false, generateIntentions: true,
        });
        addLedgerEntry({ npc: 'Mara', action: 'finish the installation', trigger: 'nightfall' }, 'day 1', 0);

        // First wire response unparseable, second clean — fetchAndParse's
        // retry-once. The parser behaves like PRODUCTION (throws) — the
        // default stub returns null and never exercises this path.
        let wireCalls = 0;
        setFakeApi(async () => {
            wireCalls += 1;
            return wireCalls === 1 ? 'not json — hallucinated prose' : '{"npcs":[]}';
        });
        setFakeParser((value) => JSON.parse(String(value)));

        beginIntentionsGenerationCapture({ enabled: true, mode: 'strict', ledgerBefore: getLedger() });
        noteIntentionsCaptureRoster(['Mara']);

        const results = await runStrictCalls(['Mara']);
        expect(wireCalls).toBe(2); // the retry fired exactly once
        expect(results.npcs).toEqual([]);

        const committed = completeIntentionsGenerationCapture({ ledgerAfter: getLedger() });
        expect(committed).not.toBeNull();

        // ONE record per wire attempt: the thrown parse is recorded once
        // (ok:false + the parser's error), the retried call once (ok:true).
        // The pre-fix code recorded the SAME first response twice — ok:true
        // before the parse, ok:false again in the catch — one attempt filling
        // two attempt slots.
        const call = committed.calls.find(c => c.label === 'strict:Mara');
        expect(call.attempts).toHaveLength(2);
        expect(call.attempts[0]).toMatchObject({ ok: false });
        expect(call.attempts[0].error).toBeTruthy();
        expect(call.attempts[1]).toMatchObject({ ok: true });
        expect(call.parsed).toBe(true);
    });

    test('unknown and dormant executed/dropped ids are recorded as ignored with reasons', async () => {
        const { saveSettings, addLedgerEntry, getLedger } = await import('../interiority/data.js');
        const { setFakeApi } = await import('./stubs/core.js');
        const { validateAndApply } = await import('../interiority/generation.js');

        setFakeChat(CHAT);
        saveSettings({
            apiUrl: 'https://example.test', modelName: 'test',
            generateThoughts: false, generateIntentions: true, intentionGracePeriod: 0,
        });
        const mara = addLedgerEntry({ npc: 'Mara', action: 'hold the fence', trigger: 'dawn' }, 'day 1', 0);
        const jonas = addLedgerEntry(
            { npc: 'Jonas', action: 'sabotage the bell', trigger: 'festival eve', status: 'dormant', wakeHint: 'festival' },
            'day 1', 0,
        );
        setFakeApi(async () => JSON.stringify({ npcs: [] }));

        beginIntentionsGenerationCapture({ enabled: true, mode: 'strict', ledgerBefore: getLedger() });
        noteIntentionsCaptureRoster(['Mara', 'Derek']);
        // validateAndApply alone records no call; seed one so the capture
        // satisfies the commit rule (an 'intentions' call must exist).
        noteIntentionsCaptureCall({ kind: 'intentions', label: 'strict:Derek', npc: 'Derek' }).finish({ parsed: true });

        await validateAndApply(
            {
                npcs: [
                    {
                        name: 'Derek',
                        // Every flavor of a block closing an entry it cannot
                        // own: Mara's live entry (wrong owner), Jonas's dormant
                        // entry (never in <open_intentions>), invented ids.
                        executed: [mara.id, jonas.id, 'i-hallucinated'],
                        dropped: [{ id: 'i-ghost' }, { id: jonas.id }],
                    },
                ],
            },
            ['Mara', 'Derek'], 1,
        );

        const committed = completeIntentionsGenerationCapture({ ledgerAfter: getLedger() });
        expect(committed).not.toBeNull();

        // Every ignored id carries its distinguishing reason — before the fix
        // unknown/dormant ids vanished without a trace, leaving a wrong-owner
        // ignore indistinguishable from a hallucinated id.
        const reasons = committed.decisions.map(d => `${d.kind}:${d.outcome}:${d.reason ?? 'null'}`);
        expect(reasons).toContain('executed:ignored:wrong-owner');
        expect(reasons).toContain('executed:ignored:dormant-id');
        expect(reasons).toContain('executed:ignored:unknown-id');
        expect(reasons).toContain('dropped:ignored:unknown-id');
        expect(reasons).toContain('dropped:ignored:dormant-id');

        // …and the ignored ids really were ignored: both entries survive.
        const after = getLedger();
        expect(after.some(e => e.id === mara.id)).toBe(true);
        expect(after.some(e => e.id === jonas.id && e.status === 'dormant')).toBe(true);
    });
});



