/**
 * Knowledge replies with the wrong top-level shape (GitHub report, local Gemma
 * roleplay fine-tune): late in a chat the model answered a per-NPC update with
 * valid JSON under keys of its own — {"personal_habits": [...],
 * "behavioral_traits": [...]} — and the run finished as "No new info" with no
 * retry and nothing logged. Pinned here:
 *
 *   - checkResponseShape — what is rejected (invented keys, non-objects, a
 *     missing required object) and what is not (`{}` where it means "nothing
 *     new", extra keys beside the expected ones).
 *   - every request ends with its spec's shape reminder, and the reminder
 *     names every key the code-side check accepts (one list, two uses).
 *   - a rejected reply is retried with the REAL reason, then the reminder, and
 *     each rejection records a `response_shape_rejected` diagnostics event.
 *   - field refresh wraps a flat reply that mirrors <refresh_fields>.
 *
 * The production parser is installed over the stub (setFakeParser): the stub
 * returns null on unparseable text where core/api.js throws, and the retry
 * wording differs between the two paths.
 */

import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { resetCoreStubs, setFakeChat, setFakeApi, setFakeParser } from './stubs/core.js';
import { parseJsonLenient as realParseJsonLenient } from '../core/api.js';
import { getEvents } from '../core/diagnostics.js';
import { state } from '../knowledge/state.js';
import { saveSettings } from '../knowledge/settings.js';
import { runScan, runNpcUpdate, runNpcEnrich, runDossierFieldRefresh } from '../knowledge/lorebook.js';
import {
    SCAN_RESPONSE, NPC_UPDATE_RESPONSE, DOSSIER_ENRICH_RESPONSE, DOSSIER_FIELD_REFRESH_RESPONSE,
    buildRetryReminder,
} from '../knowledge/prompts.js';
import {
    checkResponseShape, assertResponseShape, retryReasonFor, ResponseShapeError, PARSE_FAILURE_REASON,
} from '../knowledge/response_shape.js';

const NPC = 'Mara Voss';
const DOSSIER = [
    '[Dossier] Mara Voss | Human | weathered harbourmaster',
    'Tone: brisk',
    'Perceived as: unflappable',
    'Role: Harbourmaster of Dusk Quay',
    'Current Agenda: Root out the smugglers using her quay.',
    '',
    'Knowledge Ledger:',
    '- Met the informant at the docks on Day 3 via witness — Day 3',
].join('\n');

/** The reported reply, verbatim keys. */
const INVENTED = JSON.stringify({
    personal_habits: ['drinks black tea at dawn'],
    professional_insights: ['reads the tide tables'],
    behavioral_traits: ['curt with strangers'],
});

const ALL_SPECS = { SCAN_RESPONSE, NPC_UPDATE_RESPONSE, DOSSIER_ENRICH_RESPONSE, DOSSIER_FIELD_REFRESH_RESPONSE };

let calls;
/** Queue fake replies; the last one repeats. */
function replies(...queue) {
    setFakeApi(req => {
        calls.push(req);
        return queue.length > 1 ? queue.shift() : queue[0];
    });
}
const shapeEvents = event => getEvents({ module: 'knowledge' }).filter(e => e.event === event).reverse();

beforeEach(() => {
    resetCoreStubs();
    setFakeParser(realParseJsonLenient);
    saveSettings({ connectionProfileId: 'test-profile', scope: 'global' });
    const books = new Map([['Knowledge Tracker', { entries: { 7: { uid: 7, comment: NPC, content: DOSSIER } } }]]);
    state.wiScript = {
        books,
        async loadWorldInfo(name) { return books.has(name) ? structuredClone(books.get(name)) : null; },
        async saveWorldInfo(name, wi, immediately = false) { if (immediately) books.set(name, structuredClone(wi)); },
    };
    // 6 messages: the stub's stable-history end drops the trailing 2.
    setFakeChat(Array.from({ length: 6 }, (_, i) => ({ is_user: i % 2 === 0, mes: `Mara Voss checks the quay gates (${i}).` })));
    calls = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    state.wiScript = null;
    vi.restoreAllMocks();
});

// ─── checkResponseShape ──────────────────────────────────────────────────────

describe('checkResponseShape', () => {
    test('invented top-level keys are rejected, naming them and the expected keys', () => {
        const shape = checkResponseShape(JSON.parse(INVENTED), NPC_UPDATE_RESPONSE);
        expect(shape.ok).toBe(false);
        expect(shape.code).toBe('wrong_keys');
        expect(shape.reason).toBe('the response used the top-level keys "personal_habits", "professional_insights" and "behavioral_traits" instead of "fields" and "new_knowledge"');
    });

    test('one expected key is enough; extra keys beside it are ignored as before', () => {
        expect(checkResponseShape({ new_knowledge: [], mood: 'tense' }, NPC_UPDATE_RESPONSE).ok).toBe(true);
        expect(checkResponseShape({ new_minor: [] }, SCAN_RESPONSE).ok).toBe(true);
    });

    test('`{}` means "nothing new" for scan and update, but not for enrich or field refresh', () => {
        expect(checkResponseShape({}, SCAN_RESPONSE).ok).toBe(true);
        expect(checkResponseShape({}, NPC_UPDATE_RESPONSE).ok).toBe(true);
        expect(checkResponseShape({}, DOSSIER_ENRICH_RESPONSE)).toMatchObject({ ok: false, code: 'empty' });
        expect(checkResponseShape({}, DOSSIER_FIELD_REFRESH_RESPONSE)).toMatchObject({ ok: false, code: 'empty' });
    });

    test('non-objects are rejected (null, arrays, bare strings)', () => {
        expect(checkResponseShape(null, NPC_UPDATE_RESPONSE).reason).toBe('the response was null, not a JSON object');
        expect(checkResponseShape([], SCAN_RESPONSE).reason).toBe('the response was an array, not a JSON object');
        expect(checkResponseShape('text', SCAN_RESPONSE).reason).toBe('the response was a bare string, not a JSON object');
    });

    test('requireObject: enrich without a "fields" object is rejected', () => {
        const shape = checkResponseShape({ new_knowledge: [] }, DOSSIER_ENRICH_RESPONSE);
        expect(shape).toMatchObject({ ok: false, code: 'missing_object', reason: 'the response had no "fields" object' });
        expect(checkResponseShape({ fields: 'none' }, DOSSIER_FIELD_REFRESH_RESPONSE).code).toBe('missing_object');
        expect(checkResponseShape({ fields: [] }, DOSSIER_FIELD_REFRESH_RESPONSE).code).toBe('missing_object');
        expect(checkResponseShape({ fields: {} }, DOSSIER_FIELD_REFRESH_RESPONSE).ok).toBe(true);
    });

    test('model-invented key names are capped before they reach a prompt or the log', () => {
        const many = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`${'k'.repeat(50)}${i}`, 1]));
        const shape = checkResponseShape(many, SCAN_RESPONSE);
        expect(shape.reason).toContain('(+3 more)');
        expect(shape.reason).not.toContain('k'.repeat(41));
        expect(() => assertResponseShape(many, SCAN_RESPONSE, { op: 'scan', attempt: 1 })).toThrow(ResponseShapeError);
        const [evt] = shapeEvents('response_shape_rejected');
        expect(evt.level).toBe('warn');
        expect(evt.detail).toMatchObject({ op: 'scan', attempt: 1, code: 'wrong_keys', keyCount: 8 });
        expect(evt.detail.keys).toHaveLength(5);
        expect(evt.detail.keys.every(k => k.length <= 41)).toBe(true);
    });

    test('retryReasonFor: shape errors carry their reason, parse errors the plain wording', () => {
        expect(retryReasonFor(new ResponseShapeError({ code: 'empty', reason: 'the response was an empty JSON object' })))
            .toBe('the response was an empty JSON object');
        expect(retryReasonFor(new Error('Could not parse JSON even after repair: … at position 4012'))).toBe(PARSE_FAILURE_REASON);
    });
});

// ─── Reminders ───────────────────────────────────────────────────────────────

describe('end-of-request reminders', () => {
    test.each(Object.entries(ALL_SPECS))('%s names every key its shape check accepts', (_name, spec) => {
        for (const key of spec.keys) expect(spec.reminder).toContain(`"${key}"`);
    });

    test('every Knowledge request ends with its shape reminder', async () => {
        replies(JSON.stringify({ new_minor: [], new_major: [], update_minor: [], update_major: [] }));
        await runScan();
        replies(JSON.stringify({ fields: {}, new_knowledge: [] }));
        await runNpcUpdate(NPC, 7);
        replies(JSON.stringify({ fields: { role: 'Harbourmaster' }, new_knowledge: [] }));
        await runNpcEnrich(NPC, 7);
        replies(JSON.stringify({ fields: { agenda: 'Root out the smugglers using her quay.' } }));
        await runDossierFieldRefresh(NPC, 7, ['agenda']);

        expect(calls).toHaveLength(4);
        const specs = [SCAN_RESPONSE, NPC_UPDATE_RESPONSE, DOSSIER_ENRICH_RESPONSE, DOSSIER_FIELD_REFRESH_RESPONSE];
        calls.forEach((call, i) => expect(call.userContent.endsWith(specs[i].reminder)).toBe(true));
    });
});

// ─── The reported failure, per call ──────────────────────────────────────────

describe('runNpcUpdate', () => {
    test('the reported reply is retried with its real reason, and the retry lands', async () => {
        replies(INVENTED, JSON.stringify({
            fields: { tone: 'clipped' },
            new_knowledge: [{ fact: 'Posted watchers at the quay gates', source: 'witness', date: 'Day 4' }],
        }));
        const result = await runNpcUpdate(NPC, 7);

        expect(calls).toHaveLength(2);
        const retry = calls[1].userContent;
        expect(retry.startsWith(calls[0].userContent)).toBe(true);
        const reason = 'the response used the top-level keys "personal_habits", "professional_insights" and "behavioral_traits" instead of "fields" and "new_knowledge"';
        expect(retry.endsWith(buildRetryReminder(reason, NPC_UPDATE_RESPONSE))).toBe(true);
        expect(result.fields.tone).toBe('clipped');
        expect(result.newKnowledge).toHaveLength(1);

        const events = shapeEvents('response_shape_rejected');
        expect(events).toHaveLength(1);
        expect(events[0].detail).toEqual({
            op: 'npc_update', attempt: 1, code: 'wrong_keys', keyCount: 3,
            keys: ['personal_habits', 'professional_insights', 'behavioral_traits'],
        });
    });

    test('two wrong-shape replies fail loudly instead of reading as "No new info"', async () => {
        replies(INVENTED);
        await expect(runNpcUpdate(NPC, 7)).rejects.toThrow(
            /did not return the expected JSON after 2 attempts\. Last error: the response used the top-level keys "personal_habits"/,
        );
        expect(calls).toHaveLength(2);
        expect(shapeEvents('response_shape_rejected').map(e => e.detail.attempt)).toEqual([1, 2]);
    });

    test('`{}` is still a one-call "nothing new"', async () => {
        replies('{}');
        const result = await runNpcUpdate(NPC, 7);
        expect(calls).toHaveLength(1);
        expect(result.fields).toEqual({});
        expect(result.newKnowledge).toEqual([]);
        expect(shapeEvents('response_shape_rejected')).toHaveLength(0);
    });

    test('a bare `null` reply is retried (it used to throw a TypeError outside the retry)', async () => {
        replies('null', JSON.stringify({ fields: {}, new_knowledge: [] }));
        await expect(runNpcUpdate(NPC, 7)).resolves.toBeDefined();
        expect(calls).toHaveLength(2);
        expect(calls[1].userContent).toContain('rejected because the response was null, not a JSON object.');
    });

    test('a parse failure keeps the plain wording — no parser positions in the prompt', async () => {
        // An in-character prose reply: the production parser throws on it (a
        // truncated object would not do — parseJsonLenient repairs those).
        replies('Mara nods slowly. "Fine."', JSON.stringify({ fields: {}, new_knowledge: [] }));
        await runNpcUpdate(NPC, 7);
        expect(calls).toHaveLength(2);
        expect(calls[1].userContent.endsWith(buildRetryReminder(PARSE_FAILURE_REASON, NPC_UPDATE_RESPONSE))).toBe(true);
        expect(calls[1].userContent).not.toMatch(/position \d+/);
        expect(shapeEvents('response_shape_rejected')).toHaveLength(0);
    });
});

describe('runNpcEnrich', () => {
    test('a reply without a "fields" object is retried, naming the missing object', async () => {
        replies(
            JSON.stringify({ new_knowledge: [{ fact: 'Owns the harbour office', source: 'witness', date: 'Day 1' }] }),
            JSON.stringify({ fields: { role: 'Harbourmaster of Dusk Quay' }, new_knowledge: [] }),
        );
        const result = await runNpcEnrich(NPC, 7);
        expect(calls).toHaveLength(2);
        expect(calls[1].userContent.endsWith(
            buildRetryReminder('the response had no "fields" object', DOSSIER_ENRICH_RESPONSE),
        )).toBe(true);
        expect(result.fields.role).toBe('Harbourmaster of Dusk Quay');
        expect(shapeEvents('response_shape_rejected')[0].detail).toMatchObject({ op: 'npc_enrich', code: 'missing_object' });
    });
});

describe('runDossierFieldRefresh', () => {
    test('a flat reply mirroring <refresh_fields> is wrapped, not retried', async () => {
        replies(JSON.stringify({ agenda: 'Shut the smuggling runs down before the festival.' }));
        const result = await runDossierFieldRefresh(NPC, 7, ['agenda']);
        expect(calls).toHaveLength(1);
        expect(result.fields).toEqual({ agenda: 'Shut the smuggling runs down before the festival.' });
        expect(result.merged).toContain('Current Agenda: Shut the smuggling runs down before the festival.');
        const [evt] = shapeEvents('response_shape_repaired');
        expect(evt.detail).toEqual({ op: 'dossier_field_refresh', code: 'flat_fields', keyCount: 1 });
    });

    test('a flat reply carrying no requested key is not wrapped — it is rejected and retried', async () => {
        replies(JSON.stringify({ canon_lock: 'MODEL-FORGED CANON' }), JSON.stringify({ fields: { agenda: 'Second try.' } }));
        const result = await runDossierFieldRefresh(NPC, 7, ['agenda']);
        expect(calls).toHaveLength(2);
        expect(calls[1].userContent).toContain('rejected because the response used the top-level key "canon_lock" instead of "fields".');
        expect(result.fields).toEqual({ agenda: 'Second try.' });
        expect(result.merged).not.toContain('MODEL-FORGED');
        expect(shapeEvents('response_shape_repaired')).toHaveLength(0);
    });

    test('wrapping keeps the scope filter: unrequested flat keys are still discarded', async () => {
        replies(JSON.stringify({ agenda: 'New agenda.', canon_lock: 'MODEL-FORGED CANON' }));
        const result = await runDossierFieldRefresh(NPC, 7, ['agenda']);
        expect(result.fields).toEqual({ agenda: 'New agenda.' });
        expect(result.merged).not.toContain('MODEL-FORGED');
    });
});

describe('runScan', () => {
    test('invented keys are retried with the reason (the scan retry used to resend the same prompt)', async () => {
        replies(
            JSON.stringify({ npcs: [{ name: 'Old Tam' }] }),
            JSON.stringify({ new_minor: [{ name: 'Old Tam', species: 'Human' }], new_major: [], update_minor: [], update_major: [] }),
        );
        const result = await runScan();
        expect(calls).toHaveLength(2);
        expect(calls[1].userContent.endsWith(
            buildRetryReminder('the response used the top-level key "npcs" instead of "new_minor", "new_major", "update_minor" and "update_major"', SCAN_RESPONSE),
        )).toBe(true);
        expect(result.new_minor.map(n => n.name)).toEqual(['Old Tam']);
        expect(shapeEvents('response_shape_rejected')[0].detail).toMatchObject({ op: 'scan', attempt: 1, keys: ['npcs'] });
    });

    test('`{}` is still a one-call empty scan', async () => {
        replies('{}');
        const result = await runScan();
        expect(calls).toHaveLength(1);
        expect(result).toMatchObject({ new_minor: [], new_major: [], update_minor: [], update_major: [] });
    });
});
