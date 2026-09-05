/**
 * test/world_state_delta.test.js — TODO §3-F: low-cost delta mode for World
 * State.
 *
 * Covers the three halves of the feature (world_state/delta.js + the
 * orchestration added to world_state/refresh.js):
 *
 *   1. The patch protocol — parseDeltaPatch()/applyDeltaPatch() must be STRICT:
 *      anything the model produces that is not a well-formed
 *      ### UPDATE: / ### REMOVE: / ### NO CHANGES patch is rejected, because
 *      the result is spliced into the live document.
 *   2. Status bookkeeping — deriveDocumentStatus() (empty/manual/stale/delta/
 *      reconciled) and planAutoRefresh() (the delta-vs-full decision incl. the
 *      periodic reconciliation cadence).
 *   3. The orchestrated refreshWorldStateDelta()/runScheduledWorldStateRefresh()
 *      — the same guard discipline as the full refresh (busy flag, scope,
 *      same-chat revision guard, ONE checked write carrying text + history +
 *      status), plus the escalation-to-full when the model fails the protocol
 *      twice.
 *
 * Test-environment conventions mirror test/remediation_followups.test.js (the
 * world_state refresh tests): resetCoreStubs + a seeded SillyTavern chat-id
 * (core/scope.js reads it directly) + setFakeApi for the LLM.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import { resetCoreStubs, setFakeChat, setFakeApi } from './stubs/core.js';
import { _resetEpoch } from '../core/scope.js';

import {
    parseDeltaPatch, applyDeltaPatch, buildRefreshStatusDelta, buildPartialRefreshStatus,
    digestText, deriveDocumentStatus, planAutoRefresh, DeltaPatchError,
} from '../world_state/delta.js';
import { removeSection, setWorldStateData } from '../world_state/data.js';

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const BASELINE = [
    '## Current Scene',
    'Date: March 3, 2026',
    'Time: 14:00',
    'Location: The harbour office',
    'Present: Alex, Derek',
    'Situation: Waiting for the ferry manifest.',
    '',
    '## Recent Changes',
    '- The manifest arrived torn.',
    '',
    '## Pending',
    '- Alex owes Derek a report by Friday.',
    '',
    '## Key Character States',
    '- **Alex**:',
    '  - Mood: focused',
    '  - Worn / Significant Items: none',
].join('\n');

const PATCH = [
    '### UPDATE: current scene',
    '## Current Scene',
    'Date: March 4, 2026',
    'Time: 09:30',
    'Location: The harbour office',
    'Present: Alex, Derek',
    'Situation: The manifest is gone.',
    '',
    '### REMOVE: Pending',
].join('\n');

// A full-document output that passes validateOutput (starts with
// "## Current Scene" and contains ≥2 expected sections) — for the
// escalation tests where the fallback full refresh must succeed.
const FULL_DOC = [
    '## Current Scene',
    'Date: March 4, 2026',
    'Time: 09:30',
    'Location: The harbour office',
    'Present: Alex, Derek',
    'Situation: The manifest is gone.',
    '',
    '## Recent Changes',
    '- The manifest went missing overnight.',
    '',
    '## Key Character States',
    '- **Alex**:',
    '  - Mood: alarmed',
    '  - Worn / Significant Items: none',
].join('\n');

const CHAT_LEN = 6;
// The stable-history end of a CHAT_LEN-message chat: the core stub's default
// recentHistoryExclude is 2 (the in-flight tail), and the refresh watermarks
// record where the scan actually ENDS — this point, not chat length.
const STABLE_END = CHAT_LEN - 2;

function makeChat(n = CHAT_LEN) {
    return Array.from({ length: n }, (_, i) => ({
        id: `m${i}`,
        name: i % 2 ? 'Mara' : 'User',
        is_user: i % 2 === 0,
        mes: `Message number ${i} of the scene.`,
    }));
}

// Seed a document + its refresh status in one checked write. Synchronous on
// purpose: the statically-imported setWorldStateData is the same module
// instance the code under test uses, and an async helper was a trap — callers
// that forgot to await it asserted before the write landed.
function seedReconciledDoc(text = BASELINE, { deltasSinceFull = 0, kind = 'full', msgIndex = CHAT_LEN } = {}) {
    // To land on deltasSinceFull = n with kind 'delta', build from n-1.
    const prev = kind === 'delta' ? { deltasSinceFull: Math.max(0, deltasSinceFull - 1) } : { deltasSinceFull: 0 };
    const status = buildRefreshStatusDelta(kind, text, prev, msgIndex);
    setWorldStateData({ text, deltaStatus: status });
    return status;
}

// ─── 1. Patch protocol — parsing ─────────────────────────────────────────────

describe('parseDeltaPatch', () => {
    test('parses UPDATE and REMOVE ops and canonicalizes section names', () => {
        const parsed = parseDeltaPatch(PATCH);
        expect(parsed.ok).toBe(true);
        expect(parsed.noChanges).toBe(false);
        expect(parsed.ops).toHaveLength(2);
        expect(parsed.ops[0]).toEqual({
            type: 'update',
            section: 'Current Scene',
            body: '## Current Scene\nDate: March 4, 2026\nTime: 09:30\nLocation: The harbour office\nPresent: Alex, Derek\nSituation: The manifest is gone.',
        });
        expect(parsed.ops[1]).toEqual({ type: 'remove', section: 'Pending', body: '' });
    });

    test('accepts bolded section spellings and ##-depth markers', () => {
        const parsed = parseDeltaPatch('## UPDATE: **Pending**\n## Pending\n- A new debt.');
        expect(parsed.ok).toBe(true);
        expect(parsed.ops[0].section).toBe('Pending');
    });

    test('indented markers parse uniformly — UPDATE/REMOVE like NO CHANGES', () => {
        // Leading whitespace on a marker line previously made an indented
        // "### NO CHANGES" parse while an indented "### UPDATE:" died as a
        // preamble error; all marker regexes now test the trimmed line.
        const parsed = parseDeltaPatch('  ### UPDATE: Pending\n  ## Pending\n- A new debt.');
        expect(parsed.ok).toBe(true);
        expect(parsed.ops[0]).toEqual({ type: 'update', section: 'Pending', body: '## Pending\n- A new debt.' });
        expect(parseDeltaPatch('  ### NO CHANGES').noChanges).toBe(true);
        // Indented UNKNOWN all-caps markers are still rejected — trimming is
        // for layout tolerance, not for smuggling invented protocol.
        const bad = parseDeltaPatch('  ### DELETE: Pending');
        expect(bad.ok).toBe(false);
        expect(bad.reason).toMatch(/unknown patch marker/i);
    });

    test('### NO CHANGES parses to an empty op set', () => {
        const parsed = parseDeltaPatch('### NO CHANGES');
        expect(parsed.ok).toBe(true);
        expect(parsed.noChanges).toBe(true);
        expect(parsed.ops).toHaveLength(0);
    });

    test('strips one outer code fence', () => {
        const parsed = parseDeltaPatch('```\n### NO CHANGES\n```');
        expect(parsed.ok).toBe(true);
        expect(parsed.noChanges).toBe(true);
    });

    test('rejects an unknown section', () => {
        const parsed = parseDeltaPatch('### UPDATE: Rumors\n## Rumors\n- gossip');
        expect(parsed.ok).toBe(false);
        expect(parsed.reason).toMatch(/unknown section/i);
    });

    test('rejects REMOVE of "Current Scene"', () => {
        const parsed = parseDeltaPatch('### REMOVE: Current Scene');
        expect(parsed.ok).toBe(false);
        expect(parsed.reason).toMatch(/Current Scene.*cannot be removed/i);
    });

    test('rejects an UPDATE with an empty body', () => {
        const parsed = parseDeltaPatch('### UPDATE: Pending\n### REMOVE: Off-Screen');
        expect(parsed.ok).toBe(false);
        expect(parsed.reason).toMatch(/empty body/);
    });

    test('rejects preamble text before the first marker', () => {
        const parsed = parseDeltaPatch('Here is the patch you asked for:\n### UPDATE: Pending\n## Pending\n- x');
        expect(parsed.ok).toBe(false);
        expect(parsed.reason).toMatch(/unexpected text before the first marker/);
    });

    test('rejects unknown ALL-CAPS markers instead of silently keeping them', () => {
        const parsed = parseDeltaPatch('### DELETE: Pending');
        expect(parsed.ok).toBe(false);
        expect(parsed.reason).toMatch(/unknown patch marker/i);
    });

    test('rejects ### NO CHANGES mixed with operations', () => {
        const parsed = parseDeltaPatch('### NO CHANGES\n### UPDATE: Pending\n## Pending\n- x');
        expect(parsed.ok).toBe(false);
        expect(parsed.reason).toMatch(/mixed/);
    });

    // ── Protocol markers must never leak into bodies ──────────────────────

    test('rejects "### NO CHANGES" appended inside an open UPDATE body', () => {
        const parsed = parseDeltaPatch('### UPDATE: Pending\n## Pending\n- x\n### NO CHANGES');
        expect(parsed.ok).toBe(false);
        expect(parsed.reason).toMatch(/mixed/);
    });

    test('rejects "### NO CHANGES" after a REMOVE op', () => {
        const parsed = parseDeltaPatch('### REMOVE: Pending\n### NO CHANGES');
        expect(parsed.ok).toBe(false);
        expect(parsed.reason).toMatch(/mixed/);
    });

    test('rejects unknown ALL-CAPS markers inside an operation body', () => {
        const parsed = parseDeltaPatch('### UPDATE: Pending\n## Pending\n- x\n### DELETE: Pending');
        expect(parsed.ok).toBe(false);
        expect(parsed.reason).toMatch(/unknown patch marker/i);
    });

    test('rejects content attached to a REMOVE op (blank separators are fine)', () => {
        const stray = parseDeltaPatch('### REMOVE: Pending\nstray content under the marker');
        expect(stray.ok).toBe(false);
        expect(stray.reason).toMatch(/REMOVE.*must not carry content/);
        const blanks = parseDeltaPatch('### REMOVE: Pending\n\n');
        expect(blanks.ok).toBe(true);
        expect(blanks.ops[0].body).toBe('');
    });

    test('rejects duplicate operations for one section', () => {
        const twice = parseDeltaPatch('### UPDATE: Pending\n## Pending\n- a\n### UPDATE: Pending\n## Pending\n- b');
        expect(twice.ok).toBe(false);
        expect(twice.reason).toMatch(/duplicate/i);
        const updateAndRemove = parseDeltaPatch('### UPDATE: Pending\n## Pending\n- a\n### REMOVE: Pending');
        expect(updateAndRemove.ok).toBe(false);
        expect(updateAndRemove.reason).toMatch(/duplicate/i);
    });

    test('rejects empty input', () => {
        expect(parseDeltaPatch('').ok).toBe(false);
        expect(parseDeltaPatch(null).ok).toBe(false);
    });
});

// ─── 2. Patch protocol — application ─────────────────────────────────────────

describe('applyDeltaPatch', () => {
    test('applies an update surgically — other sections untouched', () => {
        const parsed = parseDeltaPatch(PATCH);
        const applied = applyDeltaPatch(BASELINE, parsed.ops);
        expect(applied.ok).toBe(true);
        expect(applied.text).toContain('March 4, 2026');
        expect(applied.text).toContain('## Recent Changes');
        expect(applied.text).toContain('The manifest arrived torn.');
        expect(applied.text).toContain('## Key Character States');
        // The REMOVE dropped Pending.
        expect(applied.text).not.toContain('owes Derek');
        expect(applied.text).not.toContain('## Pending');
    });

    test('prepends the section header when the model forgot it', () => {
        const applied = applyDeltaPatch(BASELINE, [{ type: 'update', section: 'Current Scene', body: 'Date: March 5, 2026' }]);
        expect(applied.ok).toBe(true);
        expect(applied.text).toMatch(/^## Current Scene\nDate: March 5, 2026/);
    });

    test('appends a section that did not exist yet', () => {
        const applied = applyDeltaPatch(BASELINE, [{ type: 'update', section: 'Plot Seeds', body: '## Plot Seeds\n- [threat] The harbour master asks questions.' }]);
        expect(applied.ok).toBe(true);
        expect(applied.text).toContain('## Plot Seeds');
        // Plot Seeds is LAST in canonical SECTIONS order and no later section
        // is present, so it still lands at the document end.
        expect(applied.text.trim().endsWith('harbour master asks questions.')).toBe(true);
    });

    test('re-adds a previously-omitted section at its canonical position, not the document end', () => {
        // replaceSection appends a missing section at the document's end, so a
        // delta re-adding an omitted section used to drift out of SECTIONS
        // order until the next full reconciliation.
        const removed = removeSection(BASELINE, 'Recent Changes');
        const applied = applyDeltaPatch(removed, [{ type: 'update', section: 'Recent Changes', body: '## Recent Changes\n- The manifest went missing overnight.' }]);
        expect(applied.ok).toBe(true);
        // Canonical order: Recent Changes sits BEFORE Pending and Key
        // Character States, not appended after them.
        expect(applied.text.indexOf('## Recent Changes')).toBeLessThan(applied.text.indexOf('## Pending'));
        expect(applied.text.indexOf('## Recent Changes')).toBeLessThan(applied.text.indexOf('## Key Character States'));
        expect(applied.text.trim().endsWith('The manifest went missing overnight.')).toBe(false);
    });

    test('enforces the "## Current Scene" postcondition even on hand-built ops', () => {
        const applied = applyDeltaPatch(BASELINE, [{ type: 'remove', section: 'Current Scene', body: '' }]);
        expect(applied.ok).toBe(false);
        expect(applied.reason).toMatch(/Current Scene/);
    });

    test('rejects empty or malformed op lists', () => {
        expect(applyDeltaPatch(BASELINE, []).ok).toBe(false);
        expect(applyDeltaPatch(BASELINE, [{ type: 'explode', section: 'Pending', body: 'x' }]).ok).toBe(false);
    });
});

describe('removeSection (data.js)', () => {
    test('removes a middle section cleanly', () => {
        const out = removeSection(BASELINE, 'Recent Changes');
        expect(out).not.toContain('## Recent Changes');
        expect(out).not.toContain('manifest arrived torn');
        expect(out).toContain('## Current Scene');
        expect(out).toContain('## Pending');
        expect(out).not.toMatch(/\n{3,}/);
    });

    test('removing the first section leaves no leading blank line', () => {
        const out = removeSection(BASELINE, 'Current Scene');
        expect(out.startsWith('## Recent Changes')).toBe(true);
    });

    test('a missing section is a no-op', () => {
        expect(removeSection(BASELINE, 'Plot Seeds')).toBe(BASELINE);
    });
});

// ─── 3. Status bookkeeping + planning (store-backed) ──────────────────────────

describe('buildRefreshStatusDelta', () => {
    test('a full refresh resets the delta counter and stamps the digest', () => {
        const status = buildRefreshStatusDelta('full', BASELINE, { deltasSinceFull: 4 }, 30);
        expect(status.deltasSinceFull).toBe(0);
        expect(status.lastRefreshKind).toBe('full');
        expect(status.lastRefreshAtMsg).toBe(30);
        expect(status.lastRefreshDigest).toBe(digestText(BASELINE));
    });

    test('a delta refresh increments the counter', () => {
        expect(buildRefreshStatusDelta('delta', BASELINE, { deltasSinceFull: 2 }, 30).deltasSinceFull).toBe(3);
    });

    test('a garbage previous status is normalized instead of crashing', () => {
        const status = buildRefreshStatusDelta('delta', BASELINE, 'garbage', NaN);
        expect(status.deltasSinceFull).toBe(1);
        expect(status.lastRefreshAtMsg).toBe(0);
    });
});

// ── Partial updates must not clear the manual signal ─────────

describe('buildPartialRefreshStatus', () => {
    test('stamps a fresh digest when the incoming document matched the last refresh', () => {
        const prev = buildRefreshStatusDelta('full', BASELINE, {}, 10);
        const updated = BASELINE.replace('focused', 'alarmed');
        const status = buildPartialRefreshStatus(prev, BASELINE, updated, 12);
        expect(status.lastRefreshKind).toBe('delta');
        expect(status.deltasSinceFull).toBe(1);
        expect(status.lastRefreshAtMsg).toBe(12);
        expect(status.lastRefreshDigest).toBe(digestText(updated));
    });

    test('preserves the old digest when the incoming document had manual edits', () => {
        const prev = buildRefreshStatusDelta('full', BASELINE, {}, 10);
        const edited = BASELINE + '\n(user note in another section)';
        const committed = edited.replace('focused', 'alarmed');
        const status = buildPartialRefreshStatus(prev, edited, committed, 12);
        // A fresh digest would clear the manual signal — the OLD one must be
        // kept so the committed document still mismatches it.
        expect(status.lastRefreshDigest).toBe(prev.lastRefreshDigest);
        expect(status.lastRefreshDigest).not.toBe(digestText(committed));
        // …but the partial update itself still counts toward the cadence.
        expect(status.lastRefreshKind).toBe('delta');
        expect(status.deltasSinceFull).toBe(1);
        expect(status.lastRefreshAtMsg).toBe(12);
    });

    test('a legacy document with no baseline digest stays manual after a partial update', () => {
        const status = buildPartialRefreshStatus({ lastRefreshDigest: '' }, BASELINE, BASELINE + '\n- new', 5);
        expect(status.lastRefreshDigest).toBe('');
    });
});

describe('deriveDocumentStatus + planAutoRefresh', () => {
    let saveSettings;

    beforeEach(async () => {
        resetCoreStubs();
        _resetEpoch();
        globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'chat-delta' }) };
        globalThis.document = { dispatchEvent: vi.fn() };
        setFakeChat(makeChat());
        ({ saveSettings } = await import('../world_state/settings.js'));
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('no document → empty', () => {
        expect(deriveDocumentStatus().kind).toBe('empty');
    });

    test('fresh full refresh, chat unchanged → reconciled', () => {
        seedReconciledDoc(BASELINE);
        expect(deriveDocumentStatus().kind).toBe('reconciled');
    });

    test('document with no recorded baseline (imported/legacy) → manual', () => {
        setWorldStateData({ text: BASELINE });
        expect(deriveDocumentStatus().kind).toBe('manual');
    });

    test('any out-of-band edit flips the digest → manual (no hook calls needed)', () => {
        seedReconciledDoc(BASELINE);
        setWorldStateData({ text: BASELINE + '\n(handwritten note)' });
        expect(deriveDocumentStatus().kind).toBe('manual');
    });

    test('chat grew past the threshold → stale (threshold is configurable)', () => {
        seedReconciledDoc(BASELINE); // refreshed at msg 6
        saveSettings({ deltaStaleAfterMsgs: 10 });
        // 15 messages now → 9 since refresh: below 10 → still reconciled.
        expect(deriveDocumentStatus({ currentMsgIndex: 15 }).kind).toBe('reconciled');
        // 17 messages now → 11 since refresh: stale.
        const stale = deriveDocumentStatus({ currentMsgIndex: 17 });
        expect(stale.kind).toBe('stale');
        expect(stale.msgsSinceRefresh).toBe(11);
        // The live getChat() default is exercised by the index wrapper in
        // world_state/index.js — here the override is what the UI passes.
    });

    // ── A valid zero watermark must still go stale ─────────

    test('a zero watermark from a short chat still goes stale', () => {
        // A full refresh in a short chat legitimately records stable-history
        // end 0. With a baseline digest on record, 0 is a VALID watermark —
        // not "no watermark" — so the difference is computed from zero.
        seedReconciledDoc(BASELINE, { msgIndex: 0 });
        expect(deriveDocumentStatus({ currentMsgIndex: 0 })).toMatchObject({ kind: 'reconciled', msgsSinceRefresh: 0 });
        // Default threshold 15: once enough settled messages accumulate, the
        // document reports stale instead of staying reconciled forever.
        const stale = deriveDocumentStatus({ currentMsgIndex: 15 });
        expect(stale.kind).toBe('stale');
        expect(stale.msgsSinceRefresh).toBe(15);
    });

    test('partial updates since the last full → delta', () => {
        seedReconciledDoc(BASELINE, { kind: 'delta', deltasSinceFull: 2 });
        const status = deriveDocumentStatus();
        expect(status.kind).toBe('delta');
        expect(status.deltasSinceFull).toBe(2);
    });

    test('manual beats stale, and stale beats delta (priority order)', () => {
        // Manual edit AND long staleness → manual.
        seedReconciledDoc(BASELINE, { kind: 'delta', deltasSinceFull: 3, msgIndex: 1 });
        setWorldStateData({ text: BASELINE + '\n(edit)' });
        expect(deriveDocumentStatus({ currentMsgIndex: 99 }).kind).toBe('manual');
        // Stale AND delta-updated → stale.
        seedReconciledDoc(BASELINE, { kind: 'delta', deltasSinceFull: 3, msgIndex: 1 });
        expect(deriveDocumentStatus({ currentMsgIndex: 99 }).kind).toBe('stale');
    });

    test('planAutoRefresh: disabled / no doc / no baseline / manual edits / reconcile-due all route to full', async () => {
        const { getWorldStateText } = await import('../world_state/data.js');

        // Disabled (default settings) — checked first, on the empty store.
        expect(planAutoRefresh()).toEqual({ kind: 'full', reason: 'delta-mode-disabled' });

        // Enabled, but no document yet.
        saveSettings({ deltaMode: true });
        expect(planAutoRefresh().reason).toBe('no-document');

        // Document present, but no refresh baseline on record (imported/legacy).
        setWorldStateData({ text: BASELINE });
        expect(planAutoRefresh().reason).toBe('no-refresh-baseline');

        // Manual edits since the last refresh.
        seedReconciledDoc(BASELINE);
        setWorldStateData({ text: BASELINE + '\n(edit)' });
        expect(planAutoRefresh().reason).toBe('manual-edits-since-refresh');

        // Reconciliation cadence (default every 5).
        seedReconciledDoc(BASELINE, { kind: 'delta', deltasSinceFull: 5 });
        expect(planAutoRefresh().reason).toBe('reconciliation-due');

        // …and one below the cadence runs the cheap delta.
        seedReconciledDoc(BASELINE, { kind: 'delta', deltasSinceFull: 4 });
        expect(planAutoRefresh()).toEqual({ kind: 'delta', reason: 'scheduled' });
        expect(getWorldStateText()).toBe(BASELINE);
    });
});

// ─── 4. Orchestration (refresh.js) ───────────────────────────────────────────

/** What the fake API returns; may be a string or (req, callNumber) => string. */
let CURRENT_FAKE_RESPONSE = '';

describe('refreshWorldStateDelta / runScheduledWorldStateRefresh', () => {
    let state, getWorldStateData, getWorldStateText, saveSettings;
    let requests;

    beforeEach(async () => {
        resetCoreStubs();
        _resetEpoch();
        // core/scope.js reads globalThis.SillyTavern directly (not the stub
        // context), so the chat id has to be seeded here — same note as
        // test/remediation_followups.test.js.
        globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'chat-delta' }) };
        globalThis.document = { dispatchEvent: vi.fn() };
        setFakeChat(makeChat());
        ({ state, getWorldStateData, getWorldStateText } = await import('../world_state/data.js'));
        ({ saveSettings } = await import('../world_state/settings.js'));
        state.wstIsRefreshing = false;
        state.modal = null;
        state.autoRefreshQueued = false;
        state.autoRefreshDeferTimer = null;
        requests = [];
        CURRENT_FAKE_RESPONSE = '';
        setFakeApi(async (req) => {
            requests.push(req);
            return typeof CURRENT_FAKE_RESPONSE === 'string' ? CURRENT_FAKE_RESPONSE : CURRENT_FAKE_RESPONSE(req, requests.length);
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        // Defensive: a leaked busy flag would fail every later test.
        state.wstIsRefreshing = false;
        vi.restoreAllMocks();
    });

    test('happy path: one cheap call patches the document and stamps delta status', async () => {
        const { refreshWorldStateDelta } = await import('../world_state/refresh.js');
        const { getDeltaStatus } = await import('../world_state/delta.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        // Watermark 2 → the scan window is [2, STABLE_END): exactly the
        // unseen messages, never the already-consumed older ones.
        seedReconciledDoc(BASELINE, { msgIndex: 2 });
        CURRENT_FAKE_RESPONSE = PATCH;

        const text = await refreshWorldStateDelta();

        // One cheap API call, using the delta prompt shape.
        expect(requests).toHaveLength(1);
        expect(requests[0].systemPrompt).toContain('DELTA PATCH MODE');
        expect(requests[0].userContent).toContain('### Previous World State');
        // The scan is built from the refresh watermark, not the latest N:
        // messages 2 and 3 are in, the already-consumed 0/1 are out.
        expect(requests[0].userContent).toContain('Message number 2');
        expect(requests[0].userContent).toContain('Message number 3');
        expect(requests[0].userContent).not.toContain('Message number 0');

        // The patch was applied and returned.
        expect(text).toContain('March 4, 2026');
        expect(text).not.toContain('owes Derek');
        expect(getWorldStateText()).toBe(text);

        // Status stamped in the same checked write; baseline snapshotted. The
        // watermark is where the scan actually ended (stable history end).
        const status = getDeltaStatus();
        expect(status.lastRefreshKind).toBe('delta');
        expect(status.deltasSinceFull).toBe(1);
        expect(status.lastRefreshDigest).toBe(digestText(text));
        expect(status.lastRefreshAtMsg).toBe(STABLE_END);
        expect(getWorldStateData().autoSaveHistory).toHaveLength(1);

        // Busy flag released.
        expect(state.wstIsRefreshing).toBe(false);
    });

    test('"### NO CHANGES" keeps the document but advances the bookkeeping', async () => {
        const { refreshWorldStateDelta } = await import('../world_state/refresh.js');
        const { getDeltaStatus } = await import('../world_state/delta.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        // Default watermark = CHAT_LEN (a legacy chat-length stamp): above the
        // stable end, so the window is empty — clamped, never negative.
        seedReconciledDoc(BASELINE);
        CURRENT_FAKE_RESPONSE = '### NO CHANGES';

        const text = await refreshWorldStateDelta();

        expect(text).toBe(BASELINE);
        expect(getWorldStateText()).toBe(BASELINE);
        expect(requests).toHaveLength(1);
        expect(requests[0].userContent).toContain('No recent messages.');
        // No history snapshot for an unchanged document…
        expect(getWorldStateData().autoSaveHistory).toHaveLength(0);
        // …but the refresh happened: the watermark advanced (to the stable
        // history end — where the scan ends) and the no-op counts toward the
        // reconciliation cadence.
        const status = getDeltaStatus();
        expect(status.deltasSinceFull).toBe(1);
        expect(status.lastRefreshAtMsg).toBe(STABLE_END);
    });

    test('a patch rejected twice throws DeltaPatchError and keeps the document', async () => {
        const { refreshWorldStateDelta } = await import('../world_state/refresh.js');
        const { getDeltaStatus } = await import('../world_state/delta.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        const seeded = seedReconciledDoc(BASELINE);
        CURRENT_FAKE_RESPONSE = 'Nothing changed, honestly!'; // preamble → invalid

        await expect(refreshWorldStateDelta()).rejects.toThrow(DeltaPatchError);

        expect(requests).toHaveLength(2); // first attempt + one reminder retry
        expect(requests[1].userContent).toContain('REMINDER');
        expect(getWorldStateText()).toBe(BASELINE);
        expect(getDeltaStatus()).toEqual(seeded); // bookkeeping untouched
        expect(state.wstIsRefreshing).toBe(false);
    });

    test('a same-chat edit during generation discards the delta (revision guard)', async () => {
        const { refreshWorldStateDelta } = await import('../world_state/refresh.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        seedReconciledDoc(BASELINE);
        const edited = BASELINE + '\n(user annotation)';
        CURRENT_FAKE_RESPONSE = () => {
            // Simulate the user saving an edit while the call is in flight.
            setWorldStateData({ text: edited });
            return PATCH;
        };

        const text = await refreshWorldStateDelta();

        expect(text).toBeNull(); // declined, not applied
        expect(getWorldStateText()).toBe(edited); // the user's edit survived
        expect(state.wstIsRefreshing).toBe(false);
    });

    test('scheduled run escalates to a full refresh when the patch protocol fails twice', async () => {
        const { runScheduledWorldStateRefresh } = await import('../world_state/refresh.js');
        const { getDeltaStatus } = await import('../world_state/delta.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model', deltaMode: true });
        seedReconciledDoc(BASELINE, { kind: 'delta', deltasSinceFull: 2 });
        CURRENT_FAKE_RESPONSE = (_req, n) => (n <= 2 ? 'garbage preamble' : FULL_DOC);

        const text = await runScheduledWorldStateRefresh(true);

        // Two delta attempts, then the full-refresh fallback.
        expect(requests).toHaveLength(3);
        expect(requests[0].systemPrompt).toContain('DELTA PATCH MODE');
        expect(requests[2].systemPrompt).not.toContain('DELTA PATCH MODE');
        expect(text).toBe(FULL_DOC);
        expect(getWorldStateText()).toBe(FULL_DOC);
        const status = getDeltaStatus();
        expect(status.lastRefreshKind).toBe('full'); // reconciled again
        expect(status.deltasSinceFull).toBe(0);
        expect(getWorldStateData().autoSaveHistory).toHaveLength(1);
    });

    test('scheduled run uses the cheap delta when the plan allows it', async () => {
        const { runScheduledWorldStateRefresh } = await import('../world_state/refresh.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model', deltaMode: true });
        seedReconciledDoc(BASELINE);
        CURRENT_FAKE_RESPONSE = PATCH;

        const text = await runScheduledWorldStateRefresh(true);

        expect(requests).toHaveLength(1);
        expect(requests[0].systemPrompt).toContain('DELTA PATCH MODE');
        expect(text).toContain('March 4, 2026');
    });

    test('scheduled run plans FULL when delta mode is off', async () => {
        const { runScheduledWorldStateRefresh } = await import('../world_state/refresh.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model', deltaMode: false });
        seedReconciledDoc(BASELINE);
        CURRENT_FAKE_RESPONSE = FULL_DOC;

        const text = await runScheduledWorldStateRefresh(true);

        expect(requests).toHaveLength(1);
        expect(requests[0].systemPrompt).not.toContain('DELTA PATCH MODE');
        expect(text).toBe(FULL_DOC);
    });

    test('manual delta without any document tells the user to run a full refresh first', async () => {
        const { refreshWorldStateDelta } = await import('../world_state/refresh.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        CURRENT_FAKE_RESPONSE = PATCH;

        await expect(refreshWorldStateDelta(false)).rejects.toThrow(/full Refresh first/);
        expect(requests).toHaveLength(0); // declined before spending a call
    });

    // ── Manual edits must not lose their status ───────────

    test('manual delta on an edited document refuses instead of patching over it', async () => {
        const { refreshWorldStateDelta } = await import('../world_state/refresh.js');
        const { getDeltaStatus } = await import('../world_state/delta.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        const seeded = seedReconciledDoc(BASELINE);
        // What the ⚡ Delta button's editor pre-sync produces: an edited
        // document that still HAS a baseline digest on record.
        const edited = BASELINE + '\n(user annotation)';
        setWorldStateData({ text: edited });
        CURRENT_FAKE_RESPONSE = PATCH;

        await expect(refreshWorldStateDelta(false)).rejects.toThrow(/manual edits.*full Refresh/i);
        // Declined before spending a call; the edit and the bookkeeping are
        // untouched — the document keeps reporting as manually edited.
        expect(requests).toHaveLength(0);
        expect(getWorldStateText()).toBe(edited);
        expect(getDeltaStatus()).toEqual(seeded);
    });

    test('auto delta on an edited document escalates to the full refresh', async () => {
        const { refreshWorldStateDelta } = await import('../world_state/refresh.js');
        const { getDeltaStatus } = await import('../world_state/delta.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        seedReconciledDoc(BASELINE);
        setWorldStateData({ text: BASELINE + '\n(user annotation)' });
        CURRENT_FAKE_RESPONSE = FULL_DOC;

        const text = await refreshWorldStateDelta(true);

        expect(requests).toHaveLength(1);
        expect(requests[0].systemPrompt).not.toContain('DELTA PATCH MODE');
        expect(text).toBe(FULL_DOC);
        expect(getDeltaStatus().lastRefreshKind).toBe('full');
        expect(getDeltaStatus().deltasSinceFull).toBe(0);
    });

    // ── The delta scan is built from the refresh watermark ─

    test('falls back to a full refresh when the unseen interval cannot fit the scan budget', async () => {
        const { refreshWorldStateDelta } = await import('../world_state/refresh.js');
        const { getDeltaStatus } = await import('../world_state/delta.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model', deltaMode: true, maxScanMessages: 2 });
        // Watermark 0 → 4 unseen settled messages > budget 2: a delta would
        // silently skip the two oldest; the full refresh must run instead.
        seedReconciledDoc(BASELINE, { msgIndex: 0 });
        CURRENT_FAKE_RESPONSE = FULL_DOC;

        const text = await refreshWorldStateDelta(true);

        // No delta call was spent — the fallback fired before the first fetch.
        expect(requests).toHaveLength(1);
        expect(requests[0].systemPrompt).not.toContain('DELTA PATCH MODE');
        expect(text).toBe(FULL_DOC);
        expect(getDeltaStatus().lastRefreshKind).toBe('full');
    });

    test('manual delta with too large a gap throws DeltaPatchError before any call', async () => {
        const { refreshWorldStateDelta } = await import('../world_state/refresh.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model', maxScanMessages: 2 });
        seedReconciledDoc(BASELINE, { msgIndex: 0 });
        CURRENT_FAKE_RESPONSE = PATCH;

        await expect(refreshWorldStateDelta(false)).rejects.toThrow(DeltaPatchError);
        await expect(refreshWorldStateDelta(false)).rejects.toThrow(/full Refresh to catch up/);
        expect(requests).toHaveLength(0);
    });

    // ── Section regeneration keeps the manual signal ──────

    test('section regeneration preserves the manual signal when other sections have edits', async () => {
        const { regenerateSection } = await import('../world_state/sections.js');
        const { getDeltaStatus } = await import('../world_state/delta.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        const seeded = seedReconciledDoc(BASELINE);
        // Manual edit in a section the regen will NOT touch.
        setWorldStateData({ text: BASELINE.replace('Waiting for the ferry manifest.', 'Waiting for the ferry manifest. (user edit)') });
        CURRENT_FAKE_RESPONSE = '## Pending\n- Alex owes Derek TWO reports by Friday.';

        const updated = await regenerateSection('Pending', 2);

        expect(updated).toContain('TWO reports');
        expect(getWorldStateText()).toContain('TWO reports');
        // The regenerated section landed, but the manual signal survives: the
        // old digest is kept (it still mismatches the committed document), so
        // only a full refresh can clear it.
        expect(getDeltaStatus().lastRefreshDigest).toBe(seeded.lastRefreshDigest);
        expect(deriveDocumentStatus().kind).toBe('manual');
        // The partial update still counts toward the reconciliation cadence.
        expect(getDeltaStatus().deltasSinceFull).toBe(1);
        expect(getDeltaStatus().lastRefreshKind).toBe('delta');
    });

    test('section regeneration on a reconciled document stamps a fresh digest', async () => {
        const { regenerateSection } = await import('../world_state/sections.js');
        const { getDeltaStatus } = await import('../world_state/delta.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        // Refreshed at stable end 2 — two settled messages arrived afterwards.
        seedReconciledDoc(BASELINE, { msgIndex: 2 });
        CURRENT_FAKE_RESPONSE = '## Pending\n- Alex owes Derek TWO reports by Friday.';

        const updated = await regenerateSection('Pending', 2);

        expect(updated).toContain('TWO reports');
        // Clean incoming document → the fresh digest is stamped and no manual
        // flag is raised. The watermark STAYS at 2 (watermark preservation): the regen
        // reconciled only "Pending", so the next delta must still scan from 2
        // to see what the newer messages did to the other sections.
        expect(deriveDocumentStatus().kind).toBe('delta');
        expect(getDeltaStatus().deltasSinceFull).toBe(1);
        expect(getDeltaStatus().lastRefreshDigest).toBe(digestText(updated));
        expect(getDeltaStatus().lastRefreshAtMsg).toBe(2);
    });

    // ── Section regeneration must not advance the watermark ─

    test('a delta after a section regeneration still scans from the old watermark', async () => {
        const { regenerateSection } = await import('../world_state/sections.js');
        const { refreshWorldStateDelta } = await import('../world_state/refresh.js');
        const { getDeltaStatus } = await import('../world_state/delta.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        // Refreshed at stable end 2; messages 2 and 3 arrived afterwards.
        seedReconciledDoc(BASELINE, { msgIndex: 2 });
        CURRENT_FAKE_RESPONSE = '## Pending\n- Alex owes Derek TWO reports by Friday.';
        await regenerateSection('Pending', 2);
        // The regen reconciled only ONE section — it must NOT advance the
        // global watermark, or the next delta would start after it and
        // permanently skip messages 2/3 for every OTHER section.
        expect(getDeltaStatus().lastRefreshAtMsg).toBe(2);

        CURRENT_FAKE_RESPONSE = PATCH;
        await refreshWorldStateDelta();

        // The delta scanned from the preserved watermark: both unseen
        // messages are in its window.
        expect(requests.at(-1).userContent).toContain('Message number 2');
        expect(requests.at(-1).userContent).toContain('Message number 3');
    });

    test('section regeneration quietly discards a coordinator cancellation', async () => {
        const { regenerateSection } = await import('../world_state/sections.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        seedReconciledDoc(BASELINE);
        // A mid-wire abort rejects the fetch with a native AbortError — the
        // shape the coordinator's composed signal produces when a chat switch
        // retires the job. The regen must resolve to null (quiet discard),
        // never surface as a user-facing failure, and never spend a grounding
        // retry on the cancelled call.
        const aborted = new Error('The operation was aborted');
        aborted.name = 'AbortError';
        CURRENT_FAKE_RESPONSE = () => { throw aborted; };

        await expect(regenerateSection('Pending', 2)).resolves.toBeNull();

        expect(requests).toHaveLength(1);
        expect(getWorldStateText()).toBe(BASELINE);
        // The finally still released the busy flag — a leak would wedge the
        // module's refresh gate for every later action.
        expect(state.wstIsRefreshing).toBe(false);
    });

    // ── The oversized-gap fallback must cover the interval ──

    test('an oversized gap triggers a catch-up that scans the OLDEST unseen messages', async () => {
        const { refreshWorldStateDelta } = await import('../world_state/refresh.js');
        const { getDeltaStatus } = await import('../world_state/delta.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model', deltaMode: true, maxScanMessages: 2 });
        seedReconciledDoc(BASELINE, { msgIndex: 0 });
        CURRENT_FAKE_RESPONSE = FULL_DOC;

        const text = await refreshWorldStateDelta(true);

        // One budget-sized pass covered the whole interval [0, 4)…
        expect(requests).toHaveLength(1);
        expect(requests[0].systemPrompt).not.toContain('DELTA PATCH MODE');
        // …including the messages the old sliding window (latest 2) skipped.
        expect(requests[0].userContent).toContain('Message number 0');
        expect(requests[0].userContent).toContain('Message number 1');
        expect(requests[0].userContent).toContain('Message number 3');
        // The watermark only claims what the scan actually covered.
        expect(text).toBe(FULL_DOC);
        expect(getDeltaStatus().lastRefreshKind).toBe('full');
        expect(getDeltaStatus().lastRefreshAtMsg).toBe(STABLE_END);
    });

    test('a char-oversized interval is replayed in multiple catch-up passes, oldest first', async () => {
        const { refreshWorldStateDelta } = await import('../world_state/refresh.js');
        const { getDeltaStatus } = await import('../world_state/delta.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model', deltaMode: true, maxScanMessages: 2 });
        // Two ~12k-character messages: no single 20k-character scan can hold
        // both, so the catch-up must run two passes — [0,1) then [1,4).
        const chat = makeChat(6);
        chat[0] = { ...chat[0], mes: `Long scene one. ${'x'.repeat(12000)}` };
        chat[1] = { ...chat[1], mes: `Long scene two. ${'y'.repeat(12000)}` };
        setFakeChat(chat);
        seedReconciledDoc(BASELINE, { msgIndex: 0 });
        CURRENT_FAKE_RESPONSE = FULL_DOC;

        const text = await refreshWorldStateDelta(true);

        expect(requests).toHaveLength(2);
        // Pass 1: the oldest chunk only — message 1 did not fit in the budget.
        expect(requests[0].userContent).toContain('Long scene one');
        expect(requests[0].userContent).not.toContain('Long scene two');
        // Pass 2: everything remaining, building on pass 1's document.
        expect(requests[1].userContent).toContain('Long scene two');
        expect(requests[1].userContent).toContain('Message number 3');
        expect(text).toBe(FULL_DOC);
        // Each pass stamped its own honest end; the last covers the interval.
        expect(getDeltaStatus().lastRefreshKind).toBe('full');
        expect(getDeltaStatus().lastRefreshAtMsg).toBe(STABLE_END);
    });

    test('with delta mode on, a plain manual full refresh also upgrades to catch-up when the watermark has an uncovered gap', async () => {
        const { refreshWorldState } = await import('../world_state/refresh.js');
        const { getDeltaStatus } = await import('../world_state/delta.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model', deltaMode: true, maxScanMessages: 2 });
        seedReconciledDoc(BASELINE, { msgIndex: 0 });
        CURRENT_FAKE_RESPONSE = FULL_DOC;

        const text = await refreshWorldState();

        // The 🔄 Refresh button goes through the same path — it must not
        // regenerate from the latest window alone and stamp over the gap.
        expect(requests).toHaveLength(1);
        expect(requests[0].userContent).toContain('Message number 0');
        expect(text).toBe(FULL_DOC);
        expect(getDeltaStatus().lastRefreshAtMsg).toBe(STABLE_END);
    });

    test('delta mode OFF (default): a manual full refresh stays ONE generation — no catch-up fan-out', async () => {
        const { refreshWorldState } = await import('../world_state/refresh.js');
        const { getDeltaStatus } = await import('../world_state/delta.js');
        // deltaMode not set — the shipped default. The user never opted into
        // the incremental cost model, so the 🔄 button must keep its
        // one-click/one-generation behavior even when the watermark gap is
        // uncovered.
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model', maxScanMessages: 2 });
        seedReconciledDoc(BASELINE, { msgIndex: 0 });
        CURRENT_FAKE_RESPONSE = FULL_DOC;

        const text = await refreshWorldState();

        // A single full generation from the sliding latest-2 window; the
        // pre-window messages are NOT replayed by surprise.
        expect(requests).toHaveLength(1);
        expect(requests[0].userContent).toContain('Message number 3');
        expect(requests[0].userContent).not.toContain('Message number 0');
        expect(text).toBe(FULL_DOC);
        expect(getDeltaStatus().lastRefreshAtMsg).toBe(STABLE_END);
    });

    test('a catch-up run is capped at 8 generation passes — the stop is honest and resumable', async () => {
        const { refreshWorldState } = await import('../world_state/refresh.js');
        const { getDeltaStatus } = await import('../world_state/delta.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model', deltaMode: true, maxScanMessages: 2 });
        // 12 messages × ~15k chars: one message per 20k-character pass, and
        // the 10 settled messages (stable end 10) would need 10 passes — the
        // cap must stop the fan-out at 8 without stamping over the rest.
        const chat = makeChat(12);
        for (let i = 0; i < chat.length; i++) {
            chat[i] = { ...chat[i], mes: `Long scene ${i}. ${'x'.repeat(15000)}` };
        }
        setFakeChat(chat);
        seedReconciledDoc(BASELINE, { msgIndex: 0 });
        CURRENT_FAKE_RESPONSE = FULL_DOC;

        const text = await refreshWorldState();

        // Exactly MAX_CATCH_UP_PASSES generations were spent…
        expect(requests).toHaveLength(8);
        expect(text).toBe(FULL_DOC);
        // …and the watermark only claims what they covered: [0, 8). The
        // remaining interval [8, 10) stays scannable for the next click.
        expect(getDeltaStatus().lastRefreshAtMsg).toBe(8);
    });

    test('a failed later catch-up pass keeps the earlier passes\' honest watermarks', async () => {
        const { refreshWorldStateDelta } = await import('../world_state/refresh.js');
        const { getDeltaStatus } = await import('../world_state/delta.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model', deltaMode: true, maxScanMessages: 2 });
        const chat = makeChat(6);
        chat[0] = { ...chat[0], mes: `Long scene one. ${'x'.repeat(12000)}` };
        chat[1] = { ...chat[1], mes: `Long scene two. ${'y'.repeat(12000)}` };
        setFakeChat(chat);
        seedReconciledDoc(BASELINE, { msgIndex: 0 });
        CURRENT_FAKE_RESPONSE = (req, n) => (n === 1 ? FULL_DOC : 'not a valid document');

        await expect(refreshWorldStateDelta(true)).rejects.toThrow(/rejected/i);

        // Pass 1 committed at watermark 1; pass 2's failure must not advance
        // it — the remaining interval [1, 4) stays scannable for the next run.
        expect(getDeltaStatus().lastRefreshKind).toBe('full');
        expect(getDeltaStatus().lastRefreshAtMsg).toBe(1);
    });

    // ── Catch-up honesty ────────────────────────────────────────────────────────

    test('a message too large for any window is scanned truncated with a marker, never skipped-and-stamped', async () => {
        const { refreshWorldStateDelta } = await import('../world_state/refresh.js');
        const { getDeltaStatus } = await import('../world_state/delta.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model', deltaMode: true, maxScanMessages: 2 });
        // Message 0 alone (~25k chars) exceeds the 20k scan budget: no window
        // can ever hold it whole. The old code skipped it while the watermark
        // still advanced past it — its content reached no model pass at all.
        const chat = makeChat(6);
        chat[0] = { ...chat[0], mes: `Colossal scene one. ${'x'.repeat(25000)}` };
        setFakeChat(chat);
        seedReconciledDoc(BASELINE, { msgIndex: 0 });
        CURRENT_FAKE_RESPONSE = FULL_DOC;

        const text = await refreshWorldStateDelta(true);

        // Pass 1 scanned message 0's LEADING PORTION — content the model can
        // use plus the explicit partial-coverage marker — and nothing after it.
        expect(requests[0].userContent).toContain('Colossal scene one');
        expect(requests[0].userContent).toContain('leading portion only');
        expect(requests[0].userContent).not.toContain('Message number 1');
        // Pass 2 covered the remaining interval [1, 4), and the final watermark
        // is honest: everything up to the stable end was (partially) examined.
        expect(requests).toHaveLength(2);
        expect(requests[1].userContent).toContain('Message number 1');
        expect(text).toBe(FULL_DOC);
        expect(getDeltaStatus().lastRefreshAtMsg).toBe(STABLE_END);
    });

    test('catch-up replays a frozen target — messages settling mid-replay wait for the next delta', async () => {
        const { refreshWorldStateDelta } = await import('../world_state/refresh.js');
        const { getDeltaStatus } = await import('../world_state/delta.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model', deltaMode: true, maxScanMessages: 2 });
        // Two ~12k messages force two passes over the interval [0, 4).
        const chat = makeChat(6);
        chat[0] = { ...chat[0], mes: `Long scene one. ${'x'.repeat(12000)}` };
        chat[1] = { ...chat[1], mes: `Long scene two. ${'y'.repeat(12000)}` };
        setFakeChat(chat);
        seedReconciledDoc(BASELINE, { msgIndex: 0 });
        // Four more messages settle DURING pass 1 — the loop must not chase
        // them; the old code re-aimed at the new stable end (8) and spent a
        // third full-generation pass on it.
        CURRENT_FAKE_RESPONSE = () => {
            const grown = makeChat(10);
            grown[0] = { ...grown[0], mes: `Long scene one. ${'x'.repeat(12000)}` };
            grown[1] = { ...grown[1], mes: `Long scene two. ${'y'.repeat(12000)}` };
            setFakeChat(grown);
            return FULL_DOC;
        };

        const text = await refreshWorldStateDelta(true);

        // Exactly the two passes the frozen interval required.
        expect(requests).toHaveLength(2);
        expect(requests[1].userContent).toContain('Long scene two');
        expect(requests[1].userContent).not.toContain('Message number 4');
        expect(text).toBe(FULL_DOC);
        // The final watermark is the frozen target (4), not the grown stable
        // end (8) — the four newer messages stay for the next delta cycle.
        expect(getDeltaStatus().lastRefreshAtMsg).toBe(4);
    });

    // ── Grounding must check the window the model saw ───────

    test('delta grounding checks the exact window the model saw, not a re-read one', async () => {
        const { refreshWorldStateDelta } = await import('../world_state/refresh.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model', maxScanMessages: 4, groundingEnabled: true });
        // Message 0 mentions a name that exists ONLY there.
        const chat = makeChat(6);
        chat[0] = { ...chat[0], mes: 'Zephyr the courier ducks into the alley.' };
        setFakeChat(chat);
        seedReconciledDoc(BASELINE, { msgIndex: 0 });
        // While the model is generating, four more messages arrive — the
        // sliding re-read window [4, 8) no longer contains message 0.
        CURRENT_FAKE_RESPONSE = () => {
            const grown = makeChat(10);
            grown[0] = { ...grown[0], mes: 'Zephyr the courier ducks into the alley.' };
            setFakeChat(grown);
            return [
                '### UPDATE: Key Character States',
                '## Key Character States',
                '- **Alex**:',
                '  - Mood: alarmed',
                '  - Worn / Significant Items: none',
                '- **Zephyr**: lurking by the docks.',
            ].join('\n');
        };

        await refreshWorldStateDelta();

        // The patch was generated from scanWindow.text (which includes
        // message 0), so **Zephyr** IS grounded and must survive soft mode —
        // a re-read window would have stripped it as ungrounded.
        expect(requests[0].userContent).toContain('Zephyr');
        expect(getWorldStateText()).toContain('**Zephyr**');
    });

    test('section regeneration grounding also checks the frozen window, not a re-read one', async () => {
        const { regenerateSection } = await import('../world_state/sections.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model', maxScanMessages: 4, groundingEnabled: true });
        // Message 0 mentions a name that exists ONLY there.
        const chat = makeChat(6);
        chat[0] = { ...chat[0], mes: 'Zephyr the courier ducks into the alley.' };
        setFakeChat(chat);
        seedReconciledDoc(BASELINE);
        // While the model is generating, four more messages arrive — the
        // sliding re-read window [4, 8) no longer contains message 0.
        CURRENT_FAKE_RESPONSE = () => {
            const grown = makeChat(10);
            grown[0] = { ...grown[0], mes: 'Zephyr the courier ducks into the alley.' };
            setFakeChat(grown);
            return '## Key Character States\n- **Alex**:\n  - Mood: alarmed\n- **Zephyr**: lurking by the docks.';
        };

        await regenerateSection('Key Character States', 2);

        // The section was generated from the frozen window (which includes
        // message 0), so **Zephyr** IS grounded and must survive soft mode —
        // a re-read window would have stripped it as ungrounded.
        expect(requests[0].userContent).toContain('Zephyr');
        expect(getWorldStateText()).toContain('**Zephyr**');
    });
});
