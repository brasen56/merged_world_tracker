/** @vitest-environment jsdom */
/**
 * test/knowledge_cleanup_review.test.js — the Phase 4 review UI and request
 * orchestration (knowledge/cleanup_review.js + knowledge/cleanup_review_ui.js).
 *
 * THE PHASE 4 EXIT GATE, as tests (docs/KNOWLEDGE_CONCISION_IMPLEMENTATION_
 * PLAN.md): explicit invocation, payload minimization, cancel, keyboard
 * review, source decisions, no auto/bulk acceptance, stale draft
 * preservation, duplicate clicks, truthful save status, strict parsing with
 * no preview for invalid output, fresh review ids (regeneration included),
 * scope-detach with origin-bound retained drafts, the reviewed recovery
 * surface, and escaped rendering of untrusted ledger text.
 *
 * Drives the REAL wiring (renderNpcsSubTab → click handlers → modal events)
 * under jsdom with the fake world-info disk from the Phase 3 commit suite
 * (the books Map is the disk) plus setFakeApi as the model endpoint.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { resetCoreStubs, setFakeApi, setFakeChat, getFakeDownloadJsonCalls, setPickTextFileStub, setFakeContextExtras, getContextSafe } from './stubs/core.js';
import { installCleanupFetch } from './stubs/cleanup-fetch.js';
import { bumpEpoch, _resetEpoch, captureScope } from '../core/scope.js';
import { releaseManagedInert } from '../core/modal.js';
import { state } from '../knowledge/state.js';
import { mergeEntities } from '../knowledge/identity.js';
import { getRegistry } from '../knowledge/registry.js';
import { saveSettings } from '../knowledge/settings.js';
import { _setCacheForTests, _clearCacheForTests, withStoreLock } from '../knowledge/store.js';
import { renderNpcsSubTab } from '../knowledge/render.js';
import { openLedgerCleanupReviewModal, openCleanupRecoveryModal } from '../knowledge/cleanup_review_ui.js';
import { onChatChanged } from '../knowledge/index.js';
import { listCleanupRecovery, exportCleanupRecovery, getCleanupRecord, importCleanupRecovery, updateCleanupRecord } from '../knowledge/cleanup_recovery.js';
import { getLorebookName } from '../knowledge/scope.js';
import { LEDGER_CLEANUP_PROMPT } from '../knowledge/prompts.js';
import {
    prepareLedgerCleanup, saveCleanupDraft, getCleanupDraft, clearCleanupDraft, requestLedgerProposal,
    restoreReviewedLedgerCleanup, PREVIOUS_DRAFT_LIMIT, _resetCleanupDraftsForTests,
    buildLedgerCleanupUserContent, minimumProposalEnvelope, estimateCleanupRequest, estimateLedgerCleanup,
    checkCleanupBudget, expandKeepListProposal, CLEANUP_WIRE_VERSION,
} from '../knowledge/cleanup_review.js';
import { captureLedgerReview, validateLedgerProposal, originalLedgerProposal, patchLedgerProposal } from '../knowledge/ledger_cleanup.js';
import { estimateTokens } from '../core/context.js';
import { buildBackupEnvelope } from '../backup/data.js';

// ─── Harness (mirrors test/knowledge_cleanup_commit.test.js) ─────────────────

const BOOK = 'Knowledge Tracker';
const NPC = 'Mara Voss';
const OTHER = 'Derek Sandhorn';

const ORIGINAL = [
    '[Dossier] Mara Voss | Human | weathered harbourmaster',
    'Tone: brisk',
    'Role: Harbourmaster of Dusk Quay',
    'Appearance: SENTINEL-APPEARANCE silver braid and an oilskin coat',
    'Current Agenda: Root out the smugglers.',
    '',
    'Knowledge Ledger:',
    '- smugglers use the north wharf via told — Day 5',
    '- Mara saw guild keys on the north wharf via witness — Day 7',
    '- the gate code is 7314 via document — Day 7',
].join('\n');

function makeFakeWorldInfo() {
    const books = new Map();
    let saveCalls = 0;
    const fake = {
        books,
        failSaveAt: null,
        failSavesFrom: null,
        afterSave: null,
        tamperAfterSave: null,
        get saveCalls() { return saveCalls; },
        async loadWorldInfo(name) {
            const wi = books.has(name) ? structuredClone(books.get(name)) : null;
            if (wi && fake.tamperAfterSave !== null && saveCalls >= fake.tamperAfterSave && wi.entries?.[7]) {
                wi.entries[7].content += '\nLATER EDIT';
            }
            return wi;
        },
        async saveWorldInfo(name, wi, immediately = false) {
            saveCalls++;
            if (fake.failSaveAt === saveCalls || (fake.failSavesFrom !== null && saveCalls >= fake.failSavesFrom)) throw new Error('disk unavailable');
            if (!immediately) return;
            books.set(name, structuredClone(wi));
            fake.afterSave?.(saveCalls, name);
        },
        async createNewWorldInfo(name) { books.set(name, { entries: {} }); return true; },
    };
    return fake;
}

let wiFake;
let contentEl;
const apiRequests = [];

function seedBook({ npcContent = ORIGINAL, npcLabel = NPC } = {}) {
    wiFake.books.set(BOOK, {
        entries: {
            7: { uid: 7, comment: npcLabel, key: [NPC], content: npcContent },
            8: { uid: 8, comment: OTHER, key: [OTHER], content: `${OTHER} | Human | harbour clerk` },
        },
    });
}

const entry7 = () => wiFake.books.get(BOOK).entries[7];
const modalEl = () => document.getElementById('kt-ledger-review-modal');
const body = () => modalEl()?.querySelector('.kt-condense-content');
const statusText = () => modalEl()?.querySelector('.mwt-status')?.textContent || '';
const ktStatusText = () => contentEl?.querySelector('#kt-status')?.textContent || '';

/** The source numbers ([sN] labels) a request payload carries, in order. */
const sourceNumbers = userContent => [...userContent.matchAll(/^\[s(\d+)\] /gm)].map(m => Number(m[1]));

/** Build a valid keep-list response from the request's own payload: the
 *  first two sources merge, every further source is kept verbatim, and (with
 *  3+ sources) one advisory pruning suggestion is included. */
function condensedProposalJson(userContent) {
    const reviewId = /<review_id>([^<]+)<\/review_id>/.exec(userContent)?.[1] || '';
    const numbers = sourceNumbers(userContent);
    const merge = numbers.length >= 2;
    return JSON.stringify({
        version: 2,
        reviewId,
        keep: merge ? numbers.slice(2) : numbers,
        changed: merge
            ? [{ s: [1, 2], t: 'smugglers use the north wharf and were seen with guild keys there via told/witness — Day 5-7', n: 'Merged the two wharf observations.' }]
            : [],
        pruningSuggestions: numbers.length >= 3
            ? [{ s: [3], r: 'duplicates the wharf record (source 1): the gate code came from the same document drop' }]
            : [],
        notes: 'Two wharf lines merged; everything else kept verbatim.',
    });
}

function useGoodApi() {
    setFakeApi(request => {
        apiRequests.push(request);
        return condensedProposalJson(request.userContent);
    });
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

/** Hold every world-info save until the returned release() is called. A
 *  failing test that never releases is released by afterEach, so its held
 *  write cannot keep the store lock and stall every later test. */
let releaseHeldSaves = null;
function holdSaves() {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const save = wiFake.saveWorldInfo.bind(wiFake);
    vi.spyOn(wiFake, 'saveWorldInfo').mockImplementation(async (...args) => {
        await gate;
        return save(...args);
    });
    releaseHeldSaves = () => release();
    return releaseHeldSaves;
}

async function openReview({ npcContent = ORIGINAL } = {}) {
    seedBook({ npcContent });
    await openLedgerCleanupReviewModal(NPC, 7);
    await vi.waitFor(() => expect(modalEl()).toBeTruthy());
    return modalEl();
}

async function consentAndGenerate() {
    body().querySelector('.kt-condense-consent-box').click();
    body().querySelector('.kt-condense-generate').click();
    await vi.waitFor(() => expect(body().querySelector('.kt-condense-records')).toBeTruthy());
}

beforeEach(() => {
    resetCoreStubs();
    _resetEpoch();
    _clearCacheForTests();
    _resetCleanupDraftsForTests();
    saveSettings({ scope: 'global', connectionProfileId: 'test-profile' });
    _setCacheForTests(BOOK, { registry: {
        [NPC]: { uid: 7, type: 'major', keywords: [NPC], entityId: 'ent-1' },
        [OTHER]: { uid: 8, type: 'minor', keywords: [OTHER] },
    } });
    wiFake = makeFakeWorldInfo();
    state.wiScript = wiFake;
    installCleanupFetch(wiFake);
    apiRequests.length = 0;
    document.body.innerHTML = '';
    contentEl = document.createElement('div');
    document.body.append(contentEl);
    state.npcsContentEl = contentEl;
    state.activeSubTab = 'major';
    state.stagingItems = [];
    state.activeItemId = null;
    setFakeChat([{ mes: 'CHAT-SENTINEL-9 the tide turned', name: 'User', is_user: true, send_date: '2026-01-01T00:00:00.000Z' }]);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    releaseHeldSaves?.();
    releaseHeldSaves = null;
    document.body.innerHTML = '';
    releaseManagedInert();
    state.wiScript = null;
    state.npcsContentEl = null;
    _clearCacheForTests();
    _resetEpoch();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

// ─── Invocation and disclosure ───────────────────────────────────────────────

describe('explicit invocation and disclosure', () => {
    test('the Condense button opens the review modal; a double click stacks nothing', async () => {
        useGoodApi();
        seedBook();
        renderNpcsSubTab();
        const btn = contentEl.querySelector('.kt-npc-condense');
        expect(btn).toBeTruthy();
        btn.click();
        btn.click(); // the in-flight guard must swallow this one
        await vi.waitFor(() => expect(modalEl()).toBeTruthy());
        await flush();
        expect(document.querySelectorAll('#kt-ledger-review-modal')).toHaveLength(1);
        // Disclosure precedes any request: consent gate, sizes, no records yet.
        expect(body().querySelector('.kt-condense-consent-box')).toBeTruthy();
        expect(body().querySelector('.kt-condense-generate').disabled).toBe(true);
        expect(body().querySelector('.kt-condense-records')).toBeNull();
        expect(apiRequests).toHaveLength(0);
    });

    test('capture refusals open an explanation popup and change nothing', async () => {
        seedBook();
        delete wiFake.books.get(BOOK).entries[7];
        renderNpcsSubTab(); // ktSetStatus writes #kt-status inside the sub-tab
        await openLedgerCleanupReviewModal(NPC, 7);
        await flush();
        expect(body().querySelector('.kt-condense-explain-reason').textContent).toContain('no longer exists');
        expect(ktStatusText()).toContain('no longer exists');
        expect(body().querySelector('.kt-condense-generate')).toBeNull();
        expect(apiRequests).toHaveLength(0);
        expect(wiFake.saveCalls).toBe(0);
    });

    test('an Identity merge with two lorebook entries explains the refusal; resolving the leftover allows review', async () => {
        seedBook();
        const merged = await mergeEntities(NPC, OTHER, { relabelEntries: false, syncBlocks: false });
        expect(merged).toMatchObject({ ok: true, merged: true, report: { adoptedUid: false } });
        expect(getRegistry()[NPC].aliases).toContain(OTHER);
        expect(getRegistry()[OTHER]).toBeUndefined();
        const originalEntries = structuredClone(wiFake.books.get(BOOK).entries);
        const saves = wiFake.saveCalls;
        renderNpcsSubTab();
        const btn = contentEl.querySelector('.kt-npc-condense');
        btn.focus();
        btn.click();
        btn.click();
        await vi.waitFor(() => expect(modalEl()).toBeTruthy());
        expect(body().querySelector('.kt-condense-explain-reason').textContent).toContain('2 candidate(s)');
        expect(body().querySelector('.kt-condense-explain-note').textContent).toContain('Identity');
        expect(body().querySelector('.kt-condense-explain-note').textContent).toContain('unique facts');
        expect(body().querySelector('.kt-condense-generate')).toBeNull();
        expect(document.querySelectorAll('#kt-ledger-review-modal')).toHaveLength(1);
        expect(wiFake.books.get(BOOK).entries).toEqual(originalEntries);
        expect(wiFake.saveCalls).toBe(saves);
        expect(apiRequests).toHaveLength(0);
        body().querySelector('.kt-condense-close').click();
        expect(modalEl()).toBeNull();
        expect(document.activeElement).toBe(btn);
        expect(btn.disabled).toBe(false);

        // Simulate the user reconciling the redundant physical entry in World Info.
        delete wiFake.books.get(BOOK).entries[8];
        btn.click();
        await vi.waitFor(() => expect(body()?.querySelector('.kt-condense-consent-box')).toBeTruthy());
        expect(entry7().content).toBe(ORIGINAL);
        expect(apiRequests).toHaveLength(0);
    });

    test('a failed capture after a chat switch opens no popup and reports no error in the incoming chat', async () => {
        seedBook();
        renderNpcsSubTab();
        let rejectLoad;
        vi.spyOn(wiFake, 'loadWorldInfo').mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectLoad = reject; }));
        const statusBefore = ktStatusText();
        const opening = openLedgerCleanupReviewModal(NPC, 7);
        bumpEpoch();
        rejectLoad(new Error('old chat read failed'));
        await opening;
        expect(modalEl()).toBeNull();
        expect(ktStatusText()).toBe(statusBefore);
    });

    test('an empty ledger opens the explain state — no request, no rewrite', async () => {
        const emptyLedger = [
            '[Dossier] Mara Voss | Human | weathered harbourmaster',
            'Tone: brisk',
            '',
            'Knowledge Ledger:',
            '- (no entries yet)',
        ].join('\n');
        await openReview({ npcContent: emptyLedger });
        expect(body().querySelector('.kt-condense-explain')).toBeTruthy();
        expect(body().querySelector('.kt-condense-explain-reason').textContent).toContain('empty');
        expect(body().querySelector('.kt-condense-consent-box')).toBeNull();
        expect(entry7().content).toContain('(no entries yet)');
    });

    test('the disclosure names the resolved model, payload scope, sizes, and allowance', async () => {
        useGoodApi();
        await openReview();
        const text = body().textContent;
        expect(text).toContain('test-profile'); // module-profile source
        expect(text).toContain('3 Knowledge Ledger lines');
        expect(text).toContain('no chat messages, no dossier fields');
        expect(text).toContain('8,000 tokens'); // maxTokens default
        expect(text).toContain('unknown on this build'); // honest context limit
        expect(text).toContain('Up to two billable requests per generation or regeneration');
        expect(text).toContain('one automatic retry');
        expect(text).not.toContain('One paid request');
    });

    test('the Condense button discloses the two-attempt bound too', () => {
        seedBook();
        renderNpcsSubTab();
        const title = contentEl.querySelector('.kt-npc-condense').title;
        expect(title).toContain('up to two billable attempts');
        expect(title).not.toContain('one model call');
    });

    test('consent gates the request; an unchecked box sends nothing', async () => {
        useGoodApi();
        await openReview();
        body().querySelector('.kt-condense-generate').click(); // disabled + unchecked
        await flush();
        expect(apiRequests).toHaveLength(0);
        expect(body().querySelector('.kt-condense-records')).toBeNull();
    });

    test('a known-excess budget refusal disables Generate and names the fix', async () => {
        saveSettings({ maxTokens: 4 });
        useGoodApi();
        await openReview();
        expect(body().querySelector('.kt-condense-refusal')).toBeTruthy();
        expect(body().querySelector('.kt-condense-refusal').textContent).toContain('output allowance');
        expect(body().querySelector('.kt-condense-refusal').textContent).toContain('Max Tokens');
        body().querySelector('.kt-condense-consent-box').click();
        expect(body().querySelector('.kt-condense-generate').disabled).toBe(true);
        expect(apiRequests).toHaveLength(0);
    });

    test.each([128, 1000000])('active chat capacity %i does not establish the Knowledge endpoint capacity', async (maxContext) => {
        setFakeContextExtras({ maxContext });
        saveSettings({ connectionProfileId: 'independent-knowledge-profile' });
        useGoodApi();
        await openReview();
        expect(body().querySelector('.kt-condense-refusal')).toBeNull();
        expect(body().textContent).toContain('unknown on this build');
        expect(body().textContent).toContain('active chat context limit and Budget override do not establish its capacity');
        await consentAndGenerate();
        expect(apiRequests).toHaveLength(1);
    });
});

// ─── Request: payload, strict parsing, cancellation ──────────────────────────

describe('the model request', () => {
    test('transport failures cannot multiply the two-attempt budget', async () => {
        let transportAttempts = 0;
        setFakeApi(async request => {
            apiRequests.push(request);
            // Model the transport retry layer rather than just counting wrapper calls.
            for (let attempt = 0; attempt <= request.retries; attempt++) transportAttempts++;
            throw new Error('transport unavailable');
        });
        seedBook();
        const { capture } = await prepareLedgerCleanup({ name: NPC, uid: 7 });
        await expect(requestLedgerProposal({ capture })).rejects.toThrow('failed after 2 attempts');
        expect(apiRequests).toHaveLength(2);
        expect(apiRequests.every(request => request.retries === 0)).toBe(true);
        expect(transportAttempts).toBe(2);
    });

    test('terminal transport failures are not retried by the proposal runner', async () => {
        const error = Object.assign(new Error('invalid credentials'), { _noRetry: true });
        const api = vi.fn(() => { throw error; });
        setFakeApi(api);
        seedBook();
        const { capture } = await prepareLedgerCleanup({ name: NPC, uid: 7 });
        await expect(requestLedgerProposal({ capture })).rejects.toBe(error);
        expect(api).toHaveBeenCalledTimes(1);
    });
    test('the cleanup prompt allows shortening one line by a third, never for a smaller saving', () => {
        expect(LEDGER_CLEANUP_PROMPT).toContain('shorten it by at least about a third without losing any fact, name, number, code, or date');
        expect(LEDGER_CLEANUP_PROMPT).toContain('Never rewrite a line for a smaller saving or just to tidy its wording');
        expect(LEDGER_CLEANUP_PROMPT).toContain('Keep the date part exactly as written');
        expect(LEDGER_CLEANUP_PROMPT).toContain('"via told by Ezra"');
        // The old rule that blocked single-line shortening is gone.
        expect(LEDGER_CLEANUP_PROMPT).not.toContain('Keep lines verbatim by default');
        expect(LEDGER_CLEANUP_PROMPT).not.toContain('only for a line that must be reworded');
    });

    test('payload minimization: only the ledger lines, source ids, and NPC name are sent', async () => {
        useGoodApi();
        await openReview();
        await consentAndGenerate();
        expect(apiRequests).toHaveLength(1);
        const { systemPrompt, userContent, trigger } = apiRequests[0];
        expect(systemPrompt).toBe(LEDGER_CLEANUP_PROMPT);
        expect(trigger).toBe('manual');
        expect(userContent).toContain('smugglers use the north wharf');
        expect(userContent).toContain('the gate code is 7314');
        // Short wire ids only; the review id travels once, for the echo.
        expect([...userContent.matchAll(/^\[([^\]]+)\] /gm)].map(m => m[1])).toEqual(['s1', 's2', 's3']);
        expect(userContent).not.toContain(':source:');
        expect(userContent).toMatch(/<review_id>lr-[a-z0-9-]+<\/review_id>/);
        expect(userContent).toContain(`<entity>${NPC}</entity>`);
        // No dossier fields, no chat, no other entries.
        expect(userContent).not.toContain('SENTINEL-APPEARANCE');
        expect(userContent).not.toContain('CHAT-SENTINEL-9');
        expect(userContent).not.toContain(OTHER);
        // And the entry itself is untouched by generation.
        expect(entry7().content).toBe(ORIGINAL);
    });

    test('prose-wrapped or truncated JSON never becomes a preview (strict parse, bounded retries)', async () => {
        setFakeApi(request => {
            apiRequests.push(request);
            return 'Here is your proposal:\n{"version":2,"reviewId":"lr-';
        });
        await openReview();
        body().querySelector('.kt-condense-consent-box').click();
        body().querySelector('.kt-condense-generate').click();
        await vi.waitFor(() => expect(statusText()).toContain('strict JSON'));
        expect(apiRequests).toHaveLength(2); // the shared 2-attempt bound, nothing more
        expect(body().querySelector('.kt-condense-records')).toBeNull();
        expect(body().querySelector('.kt-condense-consent-box')).toBeTruthy();
        // Retry is possible and a clean response then succeeds.
        useGoodApi();
        body().querySelector('.kt-condense-generate').click();
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-records')).toBeTruthy());
    });

    test('cancel returns to the disclosure without a proposal and without touching the entry', async () => {
        setFakeApi(request => new Promise((resolve, reject) => {
            apiRequests.push(request);
            request.signal?.addEventListener('abort', () => {
                const err = new Error('The operation was aborted');
                err.name = 'AbortError';
                reject(err);
            });
        }));
        await openReview();
        body().querySelector('.kt-condense-consent-box').click();
        body().querySelector('.kt-condense-generate').click();
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-generating')).toBeTruthy());
        body().querySelector('.kt-condense-cancel-request').click();
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-consent-box')).toBeTruthy());
        expect(statusText()).toContain('cancelled');
        expect(body().querySelector('.kt-condense-records')).toBeNull();
        expect(entry7().content).toBe(ORIGINAL);
    });

    test('Escape is blocked while a request is in flight', async () => {
        setFakeApi(() => new Promise(() => { /* never resolves */ }));
        await openReview();
        body().querySelector('.kt-condense-consent-box').click();
        body().querySelector('.kt-condense-generate').click();
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-generating')).toBeTruthy());
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await flush();
        expect(modalEl()).toBeTruthy();
        expect(statusText()).toContain('cancel it before closing');
    });

    test('Escape on an idle modal closes it and restores focus to the opener', async () => {
        seedBook();
        renderNpcsSubTab();
        const btn = contentEl.querySelector('.kt-npc-condense');
        btn.focus();
        btn.click();
        await vi.waitFor(() => expect(modalEl()).toBeTruthy());
        expect(modalEl().contains(document.activeElement)).toBe(true);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await flush();
        expect(modalEl()).toBeNull();
        expect(document.activeElement).toBe(btn);
    });
});

// ─── The keep-list response wire format and its output floor (Phase 5 prep) ──

const PROBE_REVIEW_ID = 'lr-mgv0k3x9-q7f2m8zt';

/** A representative long ledger: 680 distinct ~100-character lines, roughly
 *  15,000 tokens under the chars/4.5 heuristic (the Phase 5 target size). */
function longLedgerContent(lines = 680) {
    const items = Array.from({ length: lines }, (_, i) =>
        `- Mara logged manifest ${1000 + i} at berth ${(i % 40) + 1} via document — courier swore it came from Dusk Quay, Day ${(i % 90) + 1}`);
    return ['[Dossier] Mara Voss | Human | weathered harbourmaster', '', 'Knowledge Ledger:', ...items].join('\n');
}

/** A fake live tokenizer that compresses repeated characters: every maximal
 *  run of one character is a single token. A run of 'x' is ONE token at any
 *  length, while numbers and JSON punctuation cost roughly a token per character. */
function installRunLengthTokenizer() {
    const runs = vi.fn(text => text.match(/(.)\1*/gsu)?.length ?? 0);
    setFakeContextExtras({ getTokenCount: runs });
    vi.stubGlobal('SillyTavern', { getContext: getContextSafe });
    return runs;
}

/** Answer each request with build(sourceNumbers, reviewId) spread over an
 *  empty keep-list response, read off the payload. */
function proposalApi(build) {
    setFakeApi(request => {
        apiRequests.push(request);
        const reviewId = /<review_id>([^<]+)<\/review_id>/.exec(request.userContent)?.[1] || '';
        return JSON.stringify({ version: 2, reviewId, keep: [], changed: [], ...build(sourceNumbers(request.userContent), reviewId) });
    });
}

async function requestFor(npcContent) {
    seedBook({ npcContent });
    const { capture } = await prepareLedgerCleanup({ name: NPC, uid: 7 });
    return requestLedgerProposal({ capture });
}

describe('the keep-list response wire format', () => {
    test('round trip: [sN] labels out, keep numbers and changed records back, full ids validated', async () => {
        useGoodApi();
        const { review, proposal } = await requestFor(ORIGINAL);
        expect(apiRequests).toHaveLength(1);
        const { userContent } = apiRequests[0];
        expect(userContent).toContain(`<review_id>${review.reviewId}</review_id>`);
        for (const source of review.sources) expect(userContent).not.toContain(source.id);
        // The returned proposal is the unchanged Phase 2 shape over full ids.
        const [s1, s2, s3] = review.sources.map(source => source.id);
        expect(proposal).toEqual({
            version: 1,
            reviewId: review.reviewId,
            records: [
                { id: 'r1', text: 'smugglers use the north wharf and were seen with guild keys there via told/witness — Day 5-7', sourceIds: [s1, s2], notes: 'Merged the two wharf observations.' },
                { id: `original:${s3}`, text: 'the gate code is 7314 via document — Day 7', sourceIds: [s3], notes: '' },
            ],
            pruningSuggestions: [{ sourceIds: [s3], reason: 'duplicates the wharf record (source 1): the gate code came from the same document drop' }],
            notes: 'Two wharf lines merged; everything else kept verbatim.',
        });
        expect(validateLedgerProposal(review, proposal)).toMatchObject({ ok: true });
    });

    test('a ~15k-token, 680-source review round-trips merges, a reword, keeps and pruning in source order', async () => {
        const changedNumbers = [1, 2, 10, 11, 12, 680];
        proposalApi(numbers => ({
            keep: numbers.filter(n => !changedNumbers.includes(n)),
            changed: [
                { s: [680], t: 'Mara logged manifest 1679 at berth 40 via document — courier swore it came from Dusk Quay, Day 50 (later corrected)', n: 'reworded to state the correction' },
                { s: [12, 10, 11], t: 'Mara logged manifests 1009-1011 at berths 10-12 via document — courier swore they came from Dusk Quay, Days 10-12' },
                { s: [1, 2], t: 'Mara logged manifests 1000-1001 at berths 1-2 via document — courier swore they came from Dusk Quay, Days 1-2', n: 'merged two manifests' },
            ],
            pruningSuggestions: [{ s: [12], r: 'duplicates source 10 (same courier)' }],
        }));
        const { review, proposal } = await requestFor(longLedgerContent());
        expect(apiRequests).toHaveLength(1);
        expect(apiRequests[0].userContent).toContain('[s680] - Mara logged manifest 1679');
        const id = n => review.sources[n - 1].id;
        expect(proposal.records).toHaveLength(680 - changedNumbers.length + 3);
        // Every source is owned exactly once, and records run in earliest-source order.
        const owned = proposal.records.flatMap(record => record.sourceIds);
        expect(owned).toHaveLength(680);
        expect(new Set(owned)).toEqual(new Set(review.sources.map(source => source.id)));
        const firstOrder = record => Math.min(...record.sourceIds.map(sourceId => review.sources.findIndex(source => source.id === sourceId)));
        const orders = proposal.records.map(firstOrder);
        expect(orders).toEqual([...orders].sort((a, b) => a - b));
        expect(proposal.records[0]).toEqual({ id: 'r3', text: expect.stringContaining('manifests 1000-1001'), sourceIds: [id(1), id(2)], notes: 'merged two manifests' });
        expect(proposal.records[1]).toEqual({ id: `original:${id(3)}`, text: review.sources[2].text.slice(2), sourceIds: [id(3)], notes: '' });
        expect(proposal.records[8]).toMatchObject({ id: 'r2', sourceIds: [id(12), id(10), id(11)], notes: '' });
        expect(proposal.records.at(-1)).toMatchObject({ id: 'r1', sourceIds: [id(680)], notes: 'reworded to state the correction' });
        expect(proposal.pruningSuggestions).toEqual([{ sourceIds: [id(12)], reason: 'duplicates source 10 (same courier)' }]);
        expect(validateLedgerProposal(review, proposal)).toMatchObject({ ok: true });
        const patch = patchLedgerProposal(review, proposal, { removals: [] });
        expect(patch.ok).toBe(true);
        expect(patch.replacement).toContain('- Mara logged manifest 1500 at berth 21');
        expect(patch.replacement).toContain('(later corrected)');
    });

    test.each([
        ['an out-of-range number', numbers => ({ keep: [...numbers, 4] }), 'unknown source number (4)'],
        ['source number zero', numbers => ({ keep: [0, ...numbers] }), 'unknown source number (0)'],
        ['a non-integer number', () => ({ keep: [1, 2], changed: [{ s: [2.5], t: 'reworded' }] }), 'unknown source number (2.5)'],
        ['a numeric string', () => ({ keep: ['1', 2, 3] }), 'unknown source number ("1")'],
        ['an [sN] label instead of its number', () => ({ keep: [1, 2, 's3'] }), 'unknown source number ("s3")'],
        ['a null number', () => ({ keep: [1, 2, null] }), 'unknown source number (a non-number value)'],
        ['an unknown pruning number', numbers => ({ keep: numbers, pruningSuggestions: [{ s: [9], r: 'duplicates source 1' }] }), 'unknown source number (9)'],
        ['a number kept twice', numbers => ({ keep: [...numbers, 2] }), 'Source 2 is listed more than once'],
        ['a kept number that is also changed', numbers => ({ keep: numbers, changed: [{ s: [3], t: 'reworded' }] }), 'Source 3 is listed more than once'],
        ['a number repeated inside one record', () => ({ keep: [1], changed: [{ s: [2, 2, 3], t: 'merged' }] }), 'Source 2 is listed more than once'],
        ['an omitted source', () => ({ keep: [1, 2] }), 'Missing source coverage'],
        ['an empty answer', () => ({}), 'Missing source coverage'],
        ['a missing keep list', numbers => ({ keep: undefined, changed: [{ s: numbers, t: 'everything at once' }] }), 'coverage is never implicit'],
        ['a missing changed list', numbers => ({ keep: numbers, changed: undefined }), 'coverage is never implicit'],
        ['the old object-per-record format', (numbers, reviewId) => ({
            version: 1, keep: undefined, changed: undefined, reviewId,
            records: numbers.map(n => ({ id: `r${n}`, text: 'kept', sourceIds: [`s${n}`], notes: '' })),
        }), 'unknown field ("records")'],
        ['a wrong format version', numbers => ({ version: 1, keep: numbers }), 'Unsupported proposal format version'],
        ['an unknown record field', () => ({ keep: [3], changed: [{ s: [1, 2], t: 'merged', sourceIds: ['s1', 's2'] }] }), 'unknown field ("sourceIds")'],
        ['an unknown suggestion field', numbers => ({ keep: numbers, pruningSuggestions: [{ s: [3], r: 'duplicates source 1', reason: 'again' }] }), 'unknown field ("reason")'],
        ['a non-object record', numbers => ({ keep: numbers, changed: ['merged'] }), 'must be an object'],
        ['a scalar "s"', () => ({ keep: [1, 2], changed: [{ s: 3, t: 'reworded' }] }), 'non-empty "s" array'],
        ['an empty "s"', numbers => ({ keep: numbers, changed: [{ s: [], t: 'orphan text' }] }), 'non-empty "s" array'],
        ['a non-array pruning list', numbers => ({ keep: numbers, pruningSuggestions: {} }), '"pruningSuggestions" must be an array'],
        ['a stale review id', numbers => ({ reviewId: 'lr-stale', keep: numbers }), 'stale review ID'],
        ['multiline record text', () => ({ keep: [3], changed: [{ s: [1, 2], t: 'line one\nline two' }] }), 'multiline/structural text'],
        ['a missing record text', () => ({ keep: [3], changed: [{ s: [1, 2] }] }), 'Malformed record'],
        ['a non-string record note', () => ({ keep: [3], changed: [{ s: [1, 2], t: 'merged', n: 5 }] }), 'Malformed record'],
        ['a non-string overall note', numbers => ({ keep: numbers, notes: null }), 'Invalid proposal schema'],
        ['an empty pruning reason', numbers => ({ keep: numbers, pruningSuggestions: [{ s: [3], r: '' }] }), 'Malformed advisory pruning suggestion'],
        ['a repeated pruning number', numbers => ({ keep: numbers, pruningSuggestions: [{ s: [3, 3], r: 'duplicates source 1' }] }), 'Malformed advisory pruning suggestion'],
    ])('%s fails validation on both attempts and is never guessed', async (_label, build, reason) => {
        proposalApi(build);
        seedBook();
        const { capture } = await prepareLedgerCleanup({ name: NPC, uid: 7 });
        const failure = requestLedgerProposal({ capture });
        await expect(failure).rejects.toThrow('The proposal failed validation and was discarded');
        await expect(failure).rejects.toThrow(reason);
        expect(apiRequests).toHaveLength(2); // the shared 2-attempt bound, unchanged
        expect(entry7().content).toBe(ORIGINAL);
    });

    const MIXED_LEDGER = [
        '[Dossier] Mara Voss | Human | weathered harbourmaster',
        '',
        'Knowledge Ledger:',
        '- smugglers use the north wharf via told — Day 5',
        '',
        '  - an indented line via witness — Day 6',
        '- Mara plans to meet the courier via told — Day 8',
        '',
        'Trailing section: untouched',
    ].join('\r\n');

    test.each([
        ['a mixed CRLF ledger, ascending', MIXED_LEDGER, numbers => numbers],
        ['a mixed CRLF ledger, any order', MIXED_LEDGER, numbers => [...numbers].reverse()],
        ['the 680-source ledger', longLedgerContent(), numbers => numbers],
    ])('a keep-only response reproduces the original ledger byte for byte (%s)', async (_label, content, order) => {
        proposalApi(numbers => ({ keep: order(numbers) }));
        const { review, proposal } = await requestFor(content);
        expect(proposal).toEqual(originalLedgerProposal(review));
        expect(patchLedgerProposal(review, proposal, { removals: [] })).toMatchObject({ ok: true, replacement: content });
    });

    test('a keep-only response previews as "nothing to apply"', async () => {
        proposalApi(numbers => ({ keep: numbers }));
        await openReview();
        await consentAndGenerate();
        expect(body().querySelectorAll('.kt-condense-record')).toHaveLength(3);
        expect(body().querySelector('.kt-condense-summary').textContent).toContain('nothing to apply');
        expect(body().querySelector('.kt-condense-apply').disabled).toBe(true);
        expect(entry7().content).toBe(ORIGINAL);
    });

    test('truncated keep-list JSON never becomes a preview, wherever it is cut', async () => {
        seedBook({ npcContent: longLedgerContent(40) });
        const { capture } = await prepareLedgerCleanup({ name: NPC, uid: 7 });
        const cuts = [
            json => json.slice(0, json.indexOf('"keep":[') + 12), // inside the keep list
            json => json.slice(0, json.indexOf('"changed":[') + 14), // inside a changed record
            json => json.slice(0, Math.floor(json.length / 2)),
            json => json.slice(0, -1), // only the closing brace missing
        ];
        for (const cut of cuts) {
            apiRequests.length = 0;
            setFakeApi(request => {
                apiRequests.push(request);
                return cut(condensedProposalJson(request.userContent));
            });
            await expect(requestLedgerProposal({ capture })).rejects.toThrow('No preview is shown for incomplete output');
            expect(apiRequests).toHaveLength(2);
        }
        // And through the modal: no records, the disclosure stays.
        apiRequests.length = 0;
        setFakeApi(request => {
            apiRequests.push(request);
            return condensedProposalJson(request.userContent).slice(0, -1);
        });
        await openReview();
        body().querySelector('.kt-condense-consent-box').click();
        body().querySelector('.kt-condense-generate').click();
        await vi.waitFor(() => expect(statusText()).toContain('strict JSON'));
        expect(apiRequests).toHaveLength(2);
        expect(body().querySelector('.kt-condense-records')).toBeNull();
        expect(body().querySelector('.kt-condense-consent-box')).toBeTruthy();
    });

    test('translation is pure, fills the optional fields, and orders records by earliest source', () => {
        const review = captureLedgerReview(ORIGINAL, PROBE_REVIEW_ID);
        const [s1, s2, s3] = review.sources.map(source => source.id);
        const wire = {
            version: CLEANUP_WIRE_VERSION, reviewId: PROBE_REVIEW_ID,
            keep: [2],
            changed: [{ s: [3, 1], t: 'the gate code 7314 and the north wharf via told/document — Day 5-7' }],
        };
        const snapshot = structuredClone(wire);
        const out = expandKeepListProposal(review, wire);
        expect(wire).toEqual(snapshot);
        expect(out).toEqual({
            ok: true,
            proposal: {
                version: 1,
                reviewId: PROBE_REVIEW_ID,
                records: [
                    { id: 'r1', text: 'the gate code 7314 and the north wharf via told/document — Day 5-7', sourceIds: [s3, s1], notes: '' },
                    { id: `original:${s2}`, text: 'Mara saw guild keys on the north wharf via witness — Day 7', sourceIds: [s2], notes: '' },
                ],
                pruningSuggestions: [],
                notes: '',
            },
        });
        expect(validateLedgerProposal(review, out.proposal)).toMatchObject({ ok: true });
        // Non-objects never translate, and prototype keys are unknown fields, not lookups.
        for (const shape of [null, [], 'text', 3]) expect(expandKeepListProposal(review, shape).ok).toBe(false);
        const proto = JSON.parse(`{"version":2,"reviewId":"${PROBE_REVIEW_ID}","keep":[1,2,3],"changed":[],"__proto__":{}}`);
        expect(expandKeepListProposal(review, proto)).toMatchObject({ ok: false, reason: expect.stringContaining('"__proto__"') });
        for (const n of ['__proto__', 'constructor', Infinity, -1, true, [1]]) {
            expect(expandKeepListProposal(review, { ...snapshot, keep: [n, 2] }).ok).toBe(false);
        }
    });

    test('the disclosure figures size the short-label payload actually sent', async () => {
        useGoodApi();
        await openReview();
        const { capture } = await prepareLedgerCleanup({ name: NPC, uid: 7 });
        const { estimate } = estimateLedgerCleanup(capture);
        expect(body().textContent).toContain(`request ~${estimate.inputTokens.toLocaleString()} tokens in`);
        expect(body().textContent).toContain(`at least ~${estimate.minimumOutputTokens.toLocaleString()} tokens (every line kept verbatim)`);
        expect(body().textContent).toContain(`~${estimate.rewriteAllOutputTokens.toLocaleString()} if every line were rewritten`);
        expect(body().textContent).toContain('depends on how much the model changes');
        await consentAndGenerate();
        const sent = apiRequests[0].userContent;
        expect(sent).not.toContain(':source:');
        // Same shape and review-id length as the probe, so the same estimate.
        expect(Math.abs(estimateTokens(sent) - estimate.userTokens)).toBeLessThanOrEqual(1);
        expect(estimate.inputTokens).toBe(estimate.systemTokens + estimate.userTokens);
    });

    test('on a ~15k-token ledger the keep-all floor is small and the rewrite figure tracks the ledger', () => {
        const review = captureLedgerReview(longLedgerContent(), PROBE_REVIEW_ID);
        const userContent = buildLedgerCleanupUserContent(NPC, review);
        const estimate = estimateCleanupRequest({ review, userContent });
        expect(estimate.sourceCount).toBe(680);
        expect(estimate.ledgerTokens).toBeGreaterThan(14000);
        // Input: a 3–7 character [sN] prefix per line, not a ~31-character full
        // id (~1.1k tokens of mapping overhead instead of ~5.1k).
        const fullIdContent = userContent.replace(/^\[s(\d+)\]/gm, (_, n) => `[${review.sources[n - 1].id}]`);
        expect(estimate.userTokens - estimate.ledgerTokens).toBeLessThan(1500);
        expect(estimateTokens(fullIdContent) - estimateTokens(userContent)).toBeGreaterThan(3500);
        // Output: keeping every line costs only its number. The old
        // object-per-record shape needed a whole record per source even with
        // one-character text, so its floor was many times larger.
        const oldPerSourceFloor = JSON.stringify({
            version: 1, reviewId: PROBE_REVIEW_ID, pruningSuggestions: [], notes: '',
            records: review.sources.map((_source, i) => ({ id: `r${i + 1}`, text: 'x', sourceIds: [`s${i + 1}`], notes: '' })),
        });
        expect(estimate.minimumOutputTokens).toBeLessThan(1000);
        expect(estimateTokens(oldPerSourceFloor)).toBeGreaterThan(estimate.minimumOutputTokens * 8);
        // Rewriting every line costs about the ledger itself plus a small wrapper per record.
        expect(estimate.rewriteAllOutputTokens).toBeGreaterThan(estimate.ledgerTokens);
        expect(estimate.rewriteAllOutputTokens).toBeLessThan(estimate.ledgerTokens * 1.3);
        // At the default allowance the request goes ahead, with an honest
        // warning that the output size depends on how much the model changes.
        const budget = checkCleanupBudget({ ...estimate, outputAllowance: 8000 });
        expect(budget.ok).toBe(true);
        expect(budget.warnings.join('\n')).toContain('output grows with every line the model merges or rewrites');
        // An allowance that covers a full rewrite has nothing to warn about.
        const roomy = checkCleanupBudget({ ...estimate, outputAllowance: estimate.rewriteAllOutputTokens });
        expect(roomy.warnings.join('\n')).not.toContain('merges or rewrites');
    });
});

describe('the real-JSON output floor', () => {
    test('the floor and the rewrite figure are complete wire answers that translate, validate, and change nothing', () => {
        const review = captureLedgerReview(longLedgerContent(25), PROBE_REVIEW_ID);
        const envelope = minimumProposalEnvelope(review);
        const numbers = review.sources.map((_source, i) => i + 1);
        expect(JSON.parse(envelope.keepAll)).toEqual({ version: CLEANUP_WIRE_VERSION, reviewId: PROBE_REVIEW_ID, keep: numbers, changed: [] });
        expect(JSON.parse(envelope.rewriteAll).changed.map(entry => entry.s)).toEqual(numbers.map(n => [n]));
        for (const json of [envelope.keepAll, envelope.rewriteAll]) {
            const expanded = expandKeepListProposal(review, JSON.parse(json));
            expect(validateLedgerProposal(review, expanded.proposal)).toMatchObject({ ok: true });
            expect(patchLedgerProposal(review, expanded.proposal, { removals: [] }).replacement).toBe(review.original);
        }
        // Under the heuristic the estimate is exactly the wire JSON's size.
        const estimate = estimateCleanupRequest({ review, userContent: buildLedgerCleanupUserContent(NPC, review) });
        expect(estimate.minimumOutputTokens).toBe(estimateTokens(envelope.keepAll));
        expect(estimate.rewriteAllOutputTokens).toBe(estimateTokens(envelope.rewriteAll));
    });

    test('a compressing live tokenizer counts the real numbers, not a run of placeholder characters', () => {
        const runs = installRunLengthTokenizer();
        const sizes = [40, 400].map(lines => {
            const review = captureLedgerReview(longLedgerContent(lines), PROBE_REVIEW_ID);
            const envelope = minimumProposalEnvelope(review);
            const estimate = estimateCleanupRequest({ review, userContent: buildLedgerCleanupUserContent(NPC, review) });
            expect(runs).toHaveBeenCalledWith(envelope.keepAll);
            expect(estimate.minimumOutputTokens).toBe(runs(envelope.keepAll));
            expect(estimate.rewriteAllOutputTokens).toBe(runs(envelope.rewriteAll));
            // A same-length placeholder would collapse to one token at any size.
            expect(runs('x'.repeat(envelope.keepAll.length))).toBe(1);
            return estimate.minimumOutputTokens;
        });
        // The floor tracks the keep list: every further number costs at least
        // two runs (its digits, then a comma), so 360 more sources raise it by
        // well over seven hundred.
        expect(sizes[0]).toBeGreaterThan(40 * 2);
        expect(sizes[1] - sizes[0]).toBeGreaterThan(360 * 2);
    });

    test('the known-excess refusal fires on the real floor before any request is paid for', async () => {
        const runs = installRunLengthTokenizer();
        seedBook();
        const { capture } = await prepareLedgerCleanup({ name: NPC, uid: 7 });
        const floor = runs(minimumProposalEnvelope(captureLedgerReview(capture.originalContent, PROBE_REVIEW_ID)).keepAll);
        // An allowance a one-token placeholder estimate would pass, but that the
        // real keep-all answer cannot fit.
        const allowance = Math.floor(floor / 2);
        expect(allowance).toBeGreaterThan(1);
        saveSettings({ maxTokens: allowance });
        useGoodApi();
        await expect(requestLedgerProposal({ capture })).rejects.toMatchObject({ code: 'output-envelope-exceeds-allowance' });
        expect(apiRequests).toHaveLength(0);
        expect(estimateLedgerCleanup(capture).budget).toMatchObject({ ok: false, code: 'output-envelope-exceeds-allowance' });
    });
});

// ─── Review: records, sources, decisions ─────────────────────────────────────

describe('the source-aware review', () => {
    test('records render beside expandable exact originals, notes, and advisory warnings', async () => {
        useGoodApi();
        await openReview();
        await consentAndGenerate();
        const records = body().querySelectorAll('.kt-condense-record');
        expect(records).toHaveLength(2);
        expect(records[0].querySelector('h4').textContent).toContain('merges 2 lines (1, 2)');
        expect(records[0].querySelector('.kt-condense-record-notes').textContent).toContain('Merged the two wharf observations');
        const sources = records[0].querySelectorAll('.kt-condense-source-text');
        expect(sources).toHaveLength(2);
        expect(sources[0].textContent).toBe('- smugglers use the north wharf via told — Day 5');
        // The summary reports sizes honestly with the estimate caveat.
        expect(body().querySelector('.kt-condense-summary').textContent).toContain('3 sources → 2 records');
        expect(body().querySelector('.kt-condense-est-note').textContent).toContain('estimates');
        // Supplementary diff is offered, collapsed.
        expect(body().querySelector('.kt-condense-diff summary').textContent).toContain('diff');
        // Suggestions are advisory and clearly labeled.
        expect(body().querySelector('.kt-condense-suggestions').textContent).toContain('advisory');
        expect(body().querySelector('.kt-condense-removals')).toBeNull();
        // The entry is still untouched.
        expect(entry7().content).toBe(ORIGINAL);
    });

    test('Tab away from an edited record preserves controls, mapping, and the intended focus destination', async () => {
        useGoodApi();
        await openReview();
        await consentAndGenerate();
        const area = body().querySelector('.kt-condense-text');
        const recordId = area.dataset.record;
        const originals = area.closest('.kt-condense-record').querySelector('summary');
        const keep = area.closest('.kt-condense-record').querySelector('.kt-condense-keep');
        area.focus();
        area.value = 'edited: wharf and guild keys merge via told/witness — Day 5-7';
        // jsdom has no native Tab navigation or textarea change-on-blur.
        // Model the browser sequence: Tab, commit during blur, then focus the
        // already-resolved next target (not a newly queried replacement).
        area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        area.addEventListener('blur', () => area.dispatchEvent(new Event('change', { bubbles: true })), { once: true });
        originals.focus();
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-text').value).toContain('edited: wharf'));
        const refocused = body().querySelector(`.kt-condense-text[data-record="${recordId}"]`);
        expect(refocused).toBe(area);
        expect(originals.isConnected).toBe(true);
        expect(keep.isConnected).toBe(true);
        expect(document.activeElement).toBe(originals);
        expect(refocused.closest('.kt-condense-record').querySelectorAll('.kt-condense-source-text')).toHaveLength(2);
        expect(statusText()).toContain('mapping kept');
        expect(body().querySelector('.kt-condense-diff-body').textContent).toContain('edited: wharf');
        keep.click();
        expect(body().querySelectorAll('.kt-condense-record')).toHaveLength(3);
    });

    test('an invalid blur edit restores the retained text without disconnecting the next control', async () => {
        useGoodApi();
        await openReview();
        await consentAndGenerate();
        const area = body().querySelector('.kt-condense-text');
        const retained = area.value;
        const next = area.closest('.kt-condense-record').querySelector('summary');
        area.focus();
        area.value = '';
        area.addEventListener('blur', () => area.dispatchEvent(new Event('change', { bubbles: true })), { once: true });
        next.focus();
        expect(area.value).toBe(retained);
        expect(area.isConnected).toBe(true);
        expect(document.activeElement).toBe(next);
        expect(entry7().content).toBe(ORIGINAL);
    });

    test('keeping originals restores the whole ownership group in source order', async () => {
        useGoodApi();
        await openReview();
        await consentAndGenerate();
        body().querySelector('.kt-condense-keep').click();
        await vi.waitFor(() => expect(body().querySelectorAll('.kt-condense-record')).toHaveLength(3));
        // All three lines are now kept as written, in source order, and the
        // kept group opened so the restored lines are visible.
        expect(body().querySelectorAll('.kt-condense-record--kept')).toHaveLength(3);
        expect(body().querySelector('.kt-condense-kept').open).toBe(true);
        const first = body().querySelector('.kt-condense-record');
        expect(first.querySelector('.kt-condense-text').value).toBe('smugglers use the north wharf via told — Day 5');
        expect(body().querySelector('.kt-condense-changed-title').textContent).toContain('none — every line is kept as written');
    });

    /** One shortened line (source 1) and two lines kept as written. */
    function useShorteningApi() {
        setFakeApi(request => {
            apiRequests.push(request);
            const reviewId = /<review_id>([^<]+)<\/review_id>/.exec(request.userContent)?.[1] || '';
            return JSON.stringify({
                version: 2, reviewId, keep: [2, 3],
                changed: [{ s: [1], t: 'smugglers use north wharf via told — Day 5' }],
                pruningSuggestions: [], notes: '',
            });
        });
    }

    test('changed records come first with their size change; kept lines collapse into one group', async () => {
        useShorteningApi();
        await openReview();
        await consentAndGenerate();
        expect(body().querySelector('.kt-condense-changed-title').textContent).toBe('Changed: 1 record covering 1 line');
        const changedCard = body().querySelector('.kt-condense-record:not(.kt-condense-record--kept)');
        expect(changedCard.querySelector('h4').textContent).toContain('shortens line 1');
        expect(changedCard.querySelector('.kt-condense-record-size').textContent).toBe('46 → 42 chars (−9%)');
        const keptGroup = body().querySelector('.kt-condense-kept');
        expect(keptGroup.open).toBe(false);
        expect(keptGroup.querySelector('summary').textContent).toContain('Kept as written: 2 lines');
        const keptCards = keptGroup.querySelectorAll('.kt-condense-record--kept');
        expect(keptCards).toHaveLength(2);
        // A kept line has nothing to warn about and no "keep originals" action.
        for (const card of keptCards) {
            expect(card.querySelector('.kt-condense-keep')).toBeNull();
            expect(card.querySelector('.kt-condense-record-warnings')).toBeNull();
            expect(card.querySelector('.kt-condense-remove-src')).toBeTruthy();
        }
        expect(body().querySelector('.kt-condense-counts').textContent).toContain('1 changed, 2 kept as written');
    });

    test('editing a kept line shows its feedback on that card only, then moves it to the changed group', async () => {
        useShorteningApi();
        await openReview();
        await consentAndGenerate();
        const changedSize = () => body().querySelector('.kt-condense-record:not(.kt-condense-record--kept) .kt-condense-record-size').textContent;
        const before = changedSize();
        const [line2, line3] = body().querySelectorAll('.kt-condense-record--kept');
        const area = line3.querySelector('.kt-condense-text');
        area.value = 'gate code 7314 via document — Day 7';
        area.dispatchEvent(new Event('change', { bubbles: true }));
        await vi.waitFor(() => expect(line3.querySelector('.kt-condense-record-size')).toBeTruthy());
        // Blur-time refresh: matched by record, not by position.
        expect(line2.querySelector('.kt-condense-record-feedback').textContent.trim()).toBe('');
        expect(changedSize()).toBe(before);
        expect(area.isConnected).toBe(true); // not moved while the user may still be tabbing
        // The next full render regroups it.
        body().querySelector('.kt-condense-restore-all').click();
        body().querySelector('.kt-condense-restore-all').click();
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-changed-title').textContent).toContain('none'));
    });

    test('the kept group stays open across decisions once the user opens it', async () => {
        useShorteningApi();
        await openReview();
        await consentAndGenerate();
        const keptGroup = body().querySelector('.kt-condense-kept');
        keptGroup.open = true;
        keptGroup.dispatchEvent(new Event('toggle'));
        // Removing a kept line re-renders the review; focus goes to the new
        // removal's Undo (outside the group), so only the remembered state can reopen it.
        const line3 = body().querySelectorAll('.kt-condense-record--kept')[1];
        line3.querySelector('.kt-condense-remove-src').click();
        body().querySelector('.kt-condense-reason-input').value = 'superseded';
        body().querySelector('.kt-condense-remove-confirm').click();
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-removals')).toBeTruthy());
        expect(body().querySelectorAll('.kt-condense-record--kept')).toHaveLength(1);
        expect(body().querySelector('.kt-condense-kept').open).toBe(true);
        expect(document.activeElement.matches('.kt-condense-removal-undo')).toBe(true);
    });

    test('keyboard focus stays on a live review control after each decision re-renders', async () => {
        useGoodApi();
        await openReview();
        await consentAndGenerate();
        // A refused partial removal of the merged record lands on its Keep fix.
        const merged = body().querySelector('.kt-condense-record');
        merged.querySelector('.kt-condense-remove-src').click();
        body().querySelector('.kt-condense-reason-input').value = 'just this one';
        body().querySelector('.kt-condense-remove-confirm').click();
        await vi.waitFor(() => expect(statusText()).toContain('Keep originals before removing'));
        expect(document.activeElement).toBe(body().querySelector(`.kt-condense-keep[data-record="${merged.dataset.record}"]`));
        // Keep originals → the first restored record's edit box.
        document.activeElement.click();
        await vi.waitFor(() => expect(body().querySelectorAll('.kt-condense-record')).toHaveLength(3));
        expect(document.activeElement).toBe(body().querySelector('#kt-condense-text-0'));
        // Cancelling a removal returns to its Remove button.
        const single = [...body().querySelectorAll('.kt-condense-record')].find(r => r.textContent.includes('gate code'));
        const removeBtn = single.querySelector('.kt-condense-remove-src');
        const sourceId = removeBtn.dataset.source;
        removeBtn.click();
        body().querySelector('.kt-condense-remove-cancel').click();
        expect(document.activeElement).toBe(removeBtn);
        // A confirmed removal → that removal's Undo button.
        removeBtn.click();
        body().querySelector('.kt-condense-reason-input').value = 'obsolete';
        body().querySelector('.kt-condense-remove-confirm').click();
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-removals')).toBeTruthy());
        expect(document.activeElement).toBe(body().querySelector(`.kt-condense-removal-undo[data-source="${sourceId}"]`));
        // Undoing it → the restored record's edit box.
        document.activeElement.click();
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-removals')).toBeNull());
        expect(document.activeElement.matches('.kt-condense-text')).toBe(true);
        expect(document.activeElement.closest('.kt-condense-record').textContent).toContain('gate code');
        // Restore-all (two clicks) keeps focus on its button.
        body().querySelector('.kt-condense-restore-all').click();
        body().querySelector('.kt-condense-restore-all').click();
        await vi.waitFor(() => expect(statusText()).toContain('exact original line'));
        expect(document.activeElement).toBe(body().querySelector('.kt-condense-restore-all'));
    });

    test('removal requires an explicit reason; absence is not consent', async () => {
        useGoodApi();
        await openReview();
        await consentAndGenerate();
        // r2 owns one source — open its removal control.
        const rows = [...body().querySelectorAll('.kt-condense-record')];
        const single = rows.find(r => r.textContent.includes('gate code'));
        single.querySelector('.kt-condense-remove-src').click();
        const confirmBtn = body().querySelector('.kt-condense-remove-confirm');
        confirmBtn.click(); // empty reason
        await flush();
        expect(statusText()).toContain('explicit reason');
        expect(body().querySelector('.kt-condense-removals')).toBeNull();
        body().querySelector('.kt-condense-reason-input').value = 'superseded by the merged wharf record';
        body().querySelector('.kt-condense-remove-confirm').click();
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-removals')).toBeTruthy());
        expect(body().querySelector('.kt-condense-removals').textContent).toContain('superseded by the merged wharf record');
        expect(body().querySelectorAll('.kt-condense-record')).toHaveLength(1);
        // Undo brings the exact original back.
        body().querySelector('.kt-condense-removal-undo').click();
        await vi.waitFor(() => expect(body().querySelectorAll('.kt-condense-record')).toHaveLength(2));
        expect(body().querySelector('.kt-condense-removals')).toBeNull();
    });

    test('removing part of a merged record is refused with guidance', async () => {
        useGoodApi();
        await openReview();
        await consentAndGenerate();
        body().querySelector('.kt-condense-remove-src').click(); // a member of r1's merge
        body().querySelector('.kt-condense-reason-input').value = 'looks redundant';
        body().querySelector('.kt-condense-remove-confirm').click();
        await vi.waitFor(() => expect(statusText()).toContain('Keep originals before removing only part of a merged record'));
        expect(body().querySelectorAll('.kt-condense-record')).toHaveLength(2);
    });

    test('a pruning suggestion never removes by itself; acting on it is still an explicit decision', async () => {
        useGoodApi();
        await openReview();
        await consentAndGenerate();
        expect(body().querySelector('.kt-condense-removals')).toBeNull(); // nothing preselected
        body().querySelector('.kt-condense-suggest-remove').click();
        const input = body().querySelector('.kt-condense-reason-input');
        expect(input.value).toContain('gate code'); // prefilled with the model's reason
        body().querySelector('.kt-condense-remove-confirm').click();
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-removals')).toBeTruthy());
        expect(body().querySelectorAll('.kt-condense-record')).toHaveLength(1);
    });

    test('restore-all discards the condensation only after a second confirming click', async () => {
        useGoodApi();
        await openReview();
        await consentAndGenerate();
        const btn = body().querySelector('.kt-condense-restore-all');
        btn.click(); // arms only
        await flush();
        expect(body().querySelectorAll('.kt-condense-record')).toHaveLength(2);
        body().querySelector('.kt-condense-restore-all').click(); // confirms
        await vi.waitFor(() => expect(body().querySelectorAll('.kt-condense-record')).toHaveLength(3));
        expect(statusText()).toContain('exact original');
        // The identity proposal reproduces the original ledger: Apply disabled.
        expect(body().querySelector('.kt-condense-apply').disabled).toBe(true);
        expect(body().querySelector('.kt-condense-summary').textContent).toContain('nothing to apply');
    });

    test('untrusted ledger text is escaped, never executed or injected', async () => {
        useGoodApi();
        const hostile = [
            '[Dossier] Mara Voss | Human | harbourmaster',
            'Tone: brisk',
            '',
            'Knowledge Ledger:',
            '- Mara <img src=x onerror="window.__mwtPwned=1"> via witness — Day 1',
            '- </textarea><script>window.__mwtPwned=2</script> via told — Day 2',
        ].join('\n');
        await openReview({ npcContent: hostile });
        await consentAndGenerate();
        expect(modalEl().querySelectorAll('img, script, iframe')).toHaveLength(0);
        const texts = [...modalEl().querySelectorAll('.kt-condense-source-text')].map(n => n.textContent);
        expect(texts.some(t => t.includes('<img src=x'))).toBe(true);
        expect(texts.some(t => t.includes('</textarea><script>'))).toBe(true);
        expect(window.__mwtPwned).toBeUndefined();
    });
});

// ─── Apply ───────────────────────────────────────────────────────────────────

describe('apply', () => {
    async function toConfirm() {
        useGoodApi();
        await openReview();
        await consentAndGenerate();
        body().querySelector('.kt-condense-apply').click();
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-confirm')).toBeTruthy());
    }

    test.each(['success', 'failure'])('review controls are frozen during pending Apply (%s)', async outcome => {
        await toConfirm();
        let release;
        const pending = new Promise(resolve => { release = resolve; });
        const save = wiFake.saveWorldInfo.bind(wiFake);
        vi.spyOn(wiFake, 'saveWorldInfo').mockImplementation(async (...args) => {
            await pending;
            return save(...args);
        });
        if (outcome === 'failure') wiFake.failSaveAt = 1;
        const originalText = body().querySelector('.kt-condense-text').value;
        body().querySelector('.kt-condense-confirm-apply').click();
        await flush();
        for (const control of body().querySelectorAll('textarea, input, button')) {
            expect(control.matches(':disabled')).toBe(true);
        }
        // Even an already armed destructive action and regeneration are blocked.
        body().querySelector('.kt-condense-restore-all').click();
        body().querySelector('.kt-condense-restore-all').click();
        body().querySelector('.kt-condense-regenerate').click();
        body().querySelector('.kt-condense-confirm-back').click();
        expect(body().querySelector('.kt-condense-text').value).toBe(originalText);
        expect(apiRequests).toHaveLength(1);
        release();
        if (outcome === 'success') {
            await vi.waitFor(() => expect(body().querySelector('.kt-condense-applied')).toBeTruthy());
            expect(entry7().content).toContain(originalText);
        } else {
            await vi.waitFor(() => expect(statusText()).toContain('recovery original could not be saved'));
            const area = body().querySelector('.kt-condense-text');
            expect(area.matches(':disabled')).toBe(false);
            expect(area.value).toBe(originalText);
            area.value = 'A new edit after the failed apply';
            area.dispatchEvent(new Event('change', { bubbles: true }));
            expect(body().querySelector('.kt-condense-text').value).toBe(area.value);
            expect(body().querySelector('.kt-condense-regenerate').matches(':disabled')).toBe(false);
        }
    });

    function tryToClose() {
        modalEl().querySelector('.mwt-modal-close').click();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }

    test.each(['success', 'failure'])('X and Escape cannot close the modal while Apply is saving (%s)', async outcome => {
        await toConfirm();
        const release = holdSaves();
        if (outcome === 'failure') wiFake.failSaveAt = 1;
        body().querySelector('.kt-condense-confirm-apply').click();
        await flush();
        tryToClose();
        await flush();
        expect(modalEl()).toBeTruthy();
        expect(statusText()).toContain('Apply is still saving');
        release();
        if (outcome === 'success') {
            await vi.waitFor(() => expect(body().querySelector('.kt-condense-applied')).toBeTruthy());
            expect(document.activeElement).toBe(body().querySelector('.kt-condense-close'));
        } else {
            await vi.waitFor(() => expect(statusText()).toContain('recovery original could not be saved'));
            // The non-destructive Back button, not a retry Enter would repeat.
            expect(document.activeElement).toBe(body().querySelector('.kt-condense-confirm-back'));
        }
        // Once the outcome is shown, closing works again.
        modalEl().querySelector('.mwt-modal-close').click();
        await flush();
        expect(modalEl()).toBeNull();
    });

    test('a chat switch still detaches a pending Apply, and nothing lands', async () => {
        await toConfirm();
        const release = holdSaves();
        body().querySelector('.kt-condense-confirm-apply').click();
        await flush();
        bumpEpoch();
        onChatChanged();
        expect(modalEl()).toBeNull();
        release();
        await vi.waitFor(async () => expect((await listCleanupRecovery()).records[0]?.status).toBe('failed'));
        expect(entry7().content).toBe(ORIGINAL);
    });

    test('X cannot close the modal while Undo is saving; a spent Undo is retired', async () => {
        await toConfirm();
        body().querySelector('.kt-condense-confirm-apply').click();
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-applied')).toBeTruthy());
        const release = holdSaves();
        body().querySelector('.kt-condense-undo').click();
        await flush();
        tryToClose();
        await flush();
        expect(modalEl()).toBeTruthy();
        expect(statusText()).toContain('Undo is still saving');
        release();
        await vi.waitFor(() => expect(statusText()).toContain('Original ledger restored'));
        expect(entry7().content).toBe(ORIGINAL);
        expect(body().querySelector('.kt-condense-undo')).toBeNull();
        expect(body().querySelector('.kt-condense-restored-note')).toBeTruthy();
        expect(document.activeElement).toBe(body().querySelector('.kt-condense-close'));
    });

    test('Undo after a restore made elsewhere says so and writes nothing', async () => {
        await toConfirm();
        body().querySelector('.kt-condense-confirm-apply').click();
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-applied')).toBeTruthy());
        const [record] = (await listCleanupRecovery()).records.filter(r => r.actionType === 'ledger-condensation');
        await expect(restoreReviewedLedgerCleanup(record.actionId)).resolves.toMatchObject({ ok: true });
        const savesBefore = wiFake.saveCalls;
        body().querySelector('.kt-condense-undo').click();
        await vi.waitFor(() => expect(statusText()).toContain('already restored'));
        expect(wiFake.saveCalls).toBe(savesBefore);
        expect(entry7().content).toBe(ORIGINAL);
        expect(body().querySelector('.kt-condense-undo')).toBeNull();
    });

    test('two-step explicit confirm: no write before the final click; only the ledger changes', async () => {
        await toConfirm();
        expect(entry7().content).toBe(ORIGINAL); // still untouched in the confirm step
        expect(body().querySelector('.kt-condense-confirm').textContent).toContain('recovery');
        body().querySelector('.kt-condense-confirm-apply').click();
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-applied')).toBeTruthy());
        expect(statusText()).toContain('Applied');
        const applied = entry7().content;
        expect(applied).toContain('smugglers use the north wharf and were seen with guild keys');
        expect(applied).toContain('the gate code is 7314');
        // Every non-ledger byte is identical.
        expect(applied.split('Knowledge Ledger:')[0]).toBe(ORIGINAL.split('Knowledge Ledger:')[0]);
        const record = await getCleanupRecord(
            (await listCleanupRecovery()).records[0].actionId);
        expect(record.status).toBe('applied');
        expect(record.originalContent).toBe(ORIGINAL);
    });

    test('a duplicate click on the final confirm performs exactly one apply', async () => {
        await toConfirm();
        const btn = body().querySelector('.kt-condense-confirm-apply');
        btn.click();
        btn.click(); // disabled synchronously by setControlBusy; jsdom drops it
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-applied')).toBeTruthy());
        const list = await listCleanupRecovery();
        expect(list.records).toHaveLength(1);
    });

    test('undo restores the original ledger span while preserving newer unrelated edits', async () => {
        useGoodApi();
        await openReview();
        await consentAndGenerate();
        body().querySelector('.kt-condense-apply').click();
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-confirm')).toBeTruthy());
        body().querySelector('.kt-condense-confirm-apply').click();
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-applied')).toBeTruthy());
        // Newer unrelated work lands after the apply.
        entry7().content = entry7().content.replace('Tone: brisk', 'Tone: newer unrelated work');
        body().querySelector('.kt-condense-undo').click();
        await vi.waitFor(() => expect(statusText()).toContain('Original ledger restored'));
        expect(entry7().content).toBe(ORIGINAL.replace('Tone: brisk', 'Tone: newer unrelated work'));
    });

    test('a stale source refuses, retains the edited draft, and offers export + regenerate', async () => {
        useGoodApi();
        await openReview();
        await consentAndGenerate();
        // Edit, then let the entry drift behind the review's back.
        const area = body().querySelector('.kt-condense-text');
        area.value = 'edited merged record text via told/witness — Day 5-7';
        area.dispatchEvent(new Event('change', { bubbles: true }));
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-text').value).toContain('edited merged'));
        entry7().content += '\n- appended later by a background update via witness — Day 9';
        const savesBefore = wiFake.saveCalls;
        body().querySelector('.kt-condense-apply').click();
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-confirm')).toBeTruthy());
        body().querySelector('.kt-condense-confirm-apply').click();
        await vi.waitFor(() => expect(statusText()).toContain('entry changed after the proposal'));
        expect(wiFake.saveCalls).toBe(savesBefore); // refused before any persistence
        // The review (with the user's edit) is still on screen and exportable.
        expect(body().querySelector('.kt-condense-text').value).toContain('edited merged');
        body().querySelector('.kt-condense-draft-export-review').click();
        await vi.waitFor(() => expect(getFakeDownloadJsonCalls()).toHaveLength(1));
        const payload = getFakeDownloadJsonCalls()[0].data;
        expect(payload.type).toBe('mwt-cleanup-review-draft');
        expect(payload.proposal.records[0].text).toContain('edited merged');
        expect(body().querySelector('.kt-condense-regenerate')).toBeTruthy();
    });

    test('truthful failure status: recovery-persist failure blocks the write and keeps the draft', async () => {
        useGoodApi();
        await openReview();
        await consentAndGenerate();
        wiFake.failSaveAt = 1; // the recovery container save
        body().querySelector('.kt-condense-apply').click();
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-confirm')).toBeTruthy());
        body().querySelector('.kt-condense-confirm-apply').click();
        await vi.waitFor(() => expect(statusText()).toContain('recovery original could not be saved'));
        expect(entry7().content).toBe(ORIGINAL);
        expect(body().querySelector('.kt-condense-records')).toBeTruthy(); // draft retained
    });

    test('truthful failure status: target-save failure preserves recovery and the review', async () => {
        useGoodApi();
        await openReview();
        await consentAndGenerate();
        wiFake.failSaveAt = 3; // recovery save (1), pending update (2), target write (3)
        body().querySelector('.kt-condense-apply').click();
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-confirm')).toBeTruthy());
        body().querySelector('.kt-condense-confirm-apply').click();
        await vi.waitFor(() => expect(statusText()).toContain('Saving the entry failed'));
        expect(entry7().content).toBe(ORIGINAL);
        const list = await listCleanupRecovery();
        expect(list.records).toHaveLength(1);
        expect(list.records[0].status).toBe('failed');
    });

    test('retrying after a failed pending-status save applies instead of claiming a duplicate', async () => {
        await toConfirm();
        wiFake.failSaveAt = 2; // recovery save (1) lands; pending-status update (2) fails
        body().querySelector('.kt-condense-confirm-apply').click();
        await vi.waitFor(() => expect(statusText()).toContain('recovery original could not be saved'));
        expect((await listCleanupRecovery()).records.map(r => r.status)).toEqual(['original-saved']);
        expect(entry7().content).toBe(ORIGINAL);
        wiFake.failSaveAt = null;
        body().querySelector('.kt-condense-confirm-apply').click();
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-applied')).toBeTruthy());
        expect(entry7().content).not.toBe(ORIGINAL);
        expect((await listCleanupRecovery()).records.map(r => r.status)).toEqual(['applied']);
    });

    test('a duplicate refusal that is not confirmed applied never claims the entry changed', async () => {
        await toConfirm();
        wiFake.failSaveAt = 2;
        body().querySelector('.kt-condense-confirm-apply').click();
        await vi.waitFor(() => expect(statusText()).toContain('recovery original could not be saved'));
        const [record] = (await listCleanupRecovery()).records;
        await updateCleanupRecord(record.actionId, { status: 'restored' }, BOOK);
        wiFake.failSaveAt = null;
        body().querySelector('.kt-condense-confirm-apply').click();
        await vi.waitFor(() => expect(statusText()).toContain('nothing was written again'));
        expect(statusText()).toContain('status: restored');
        expect(statusText()).not.toContain('already applied');
        expect(entry7().content).toBe(ORIGINAL);
        expect(body().querySelector('.kt-condense-records')).toBeTruthy(); // draft retained
    });
});

// ─── Drafts, regeneration, scope detach ──────────────────────────────────────

describe('drafts, regeneration, and scope detach', () => {
    test.each(['resolve', 'reject', 'cancel'])('chat switch detaches an unresolved request before it can %s', async completion => {
        setFakeContextExtras({ chatId: 'origin-chat' });
        vi.stubGlobal('SillyTavern', { getContext: getContextSafe });
        useGoodApi();
        await openReview();
        await consentAndGenerate();
        const area = body().querySelector('.kt-condense-text');
        area.value = 'origin-only edited draft';
        area.dispatchEvent(new Event('change', { bubbles: true }));
        let finish;
        setFakeApi(request => new Promise((resolve, reject) => {
            apiRequests.push(request);
            finish = () => completion === 'resolve'
                ? resolve(condensedProposalJson(request.userContent))
                : reject(Object.assign(new Error('late failure'), { name: completion === 'cancel' ? 'AbortError' : 'Error' }));
        }));
        body().querySelector('.kt-condense-regenerate').click();
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        const oldModal = modalEl();
        // User close is still blocked, but the scope sweep must never be.
        oldModal._closeModal();
        expect(modalEl()).toBe(oldModal);
        const origin = (await prepareLedgerCleanup({ name: NPC, uid: 7 })).capture;
        setFakeContextExtras({ chatId: 'different-chat' });
        bumpEpoch();
        onChatChanged();
        expect(modalEl()).toBeNull();
        expect(apiRequests.at(-1).signal.aborted).toBe(true);
        finish();
        await flush();
        await flush();
        expect(modalEl()).toBeNull();
        expect(apiRequests).toHaveLength(2); // no retry launched in the new scope
        expect(getCleanupDraft(origin).proposal.records[0].text).toBe('origin-only edited draft');
        const destination = (await prepareLedgerCleanup({ name: NPC, uid: 7 })).capture;
        expect(destination.scopeKey).not.toBe(origin.scopeKey);
        expect(getCleanupDraft(destination)).toBeNull();
    });

    test('stale completion detaches even without an explicit sweep', async () => {
        let finish;
        setFakeApi(request => new Promise(resolve => { finish = () => resolve(condensedProposalJson(request.userContent)); }));
        await openReview();
        body().querySelector('.kt-condense-consent-box').click();
        body().querySelector('.kt-condense-generate').click();
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        bumpEpoch();
        finish();
        await vi.waitFor(() => expect(modalEl()).toBeNull());
    });

    test('draft save and clear use captured ownership after switching chats', async () => {
        setFakeContextExtras({ chatId: 'origin-chat' });
        vi.stubGlobal('SillyTavern', { getContext: getContextSafe });
        await openReview();
        const { capture } = await prepareLedgerCleanup({ name: NPC, uid: 7 });
        setFakeContextExtras({ chatId: 'other-origin' });
        const other = (await prepareLedgerCleanup({ name: NPC, uid: 7 })).capture;
        expect(other.scopeKey).not.toBe(capture.scopeKey);
        const draft = { review: { original: ORIGINAL }, proposal: { records: [] }, decisions: { removals: [] } };
        saveCleanupDraft(capture, draft);
        expect(getCleanupDraft(capture)).toMatchObject(draft);
        expect(getCleanupDraft(other)).toBeNull();
        saveCleanupDraft(other, draft);
        clearCleanupDraft(capture);
        expect(getCleanupDraft(other)).toMatchObject(draft);
    });

    test('cancelled regeneration keeps the edited draft resumable after close/reopen', async () => {
        useGoodApi();
        await openReview();
        await consentAndGenerate();
        const area = body().querySelector('.kt-condense-text');
        area.value = 'editable after cancellation';
        area.dispatchEvent(new Event('change', { bubbles: true }));
        setFakeApi(request => new Promise((_resolve, reject) => {
            request.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })));
            apiRequests.push(request);
        }));
        body().querySelector('.kt-condense-regenerate').click();
        await vi.waitFor(() => expect(apiRequests).toHaveLength(2));
        body().querySelector('.kt-condense-cancel-request').click();
        await vi.waitFor(() => expect(statusText()).toContain('cancelled'));
        modalEl()._closeModal();
        await openLedgerCleanupReviewModal(NPC, 7);
        expect(body().querySelector('.kt-condense-resume')).toBeTruthy();
        body().querySelector('.kt-condense-resume').click();
        expect(body().querySelector('.kt-condense-text').value).toBe('editable after cancellation');
    });

    test.each(['ledger', 'outside'])('stale %s source regeneration recaptures, re-discloses and can apply', async change => {
        useGoodApi();
        await openReview();
        await consentAndGenerate();
        const area = body().querySelector('.kt-condense-text');
        area.value = 'old edits must not be rebased';
        area.dispatchEvent(new Event('change', { bubbles: true }));
        if (change === 'ledger') entry7().content += '\n- NEW-LIVE-FACT via witness — Day 9';
        else entry7().content = entry7().content.replace('Tone: brisk', 'Tone: new tone');
        body().querySelector('.kt-condense-apply').click();
        body().querySelector('.kt-condense-confirm-apply').click();
        await vi.waitFor(() => expect(statusText()).toContain('entry changed after the proposal'));
        body().querySelector('.kt-condense-regenerate').click();
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-disclosure')).toBeTruthy());
        expect(apiRequests).toHaveLength(1);
        expect(body().querySelector('.kt-condense-consent-box').checked).toBe(false);
        expect(body().querySelector('.kt-condense-generate').disabled).toBe(true);
        body().querySelector('.kt-condense-draft-export').click();
        expect(getFakeDownloadJsonCalls().at(-1).data.proposal.records[0].text).toBe('old edits must not be rebased');
        await consentAndGenerate();
        expect(apiRequests).toHaveLength(2);
        if (change === 'ledger') expect(apiRequests[1].userContent).toContain('NEW-LIVE-FACT');
        body().querySelector('.kt-condense-apply').click();
        body().querySelector('.kt-condense-confirm-apply').click();
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-applied')).toBeTruthy());
        if (change === 'outside') expect(entry7().content).toContain('Tone: new tone');
        expect(entry7().content).not.toContain('old edits must not be rebased');
    });
    test('regeneration mints a fresh review id and keeps the pre-regeneration draft exportable', async () => {
        useGoodApi();
        await openReview();
        await consentAndGenerate();
        const firstId = /<review_id>([^<]+)<\/review_id>/.exec(apiRequests[0].userContent)[1];
        const area = body().querySelector('.kt-condense-text');
        area.value = 'pre-regeneration edit via told/witness — Day 5-7';
        area.dispatchEvent(new Event('change', { bubbles: true }));
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-text').value).toContain('pre-regeneration'));
        body().querySelector('.kt-condense-regenerate').click();
        await vi.waitFor(() => expect(apiRequests.length).toBe(2));
        const secondId = /<review_id>([^<]+)<\/review_id>/.exec(apiRequests[1].userContent)[1];
        expect(secondId).not.toBe(firstId);
        await vi.waitFor(() => expect(body().querySelectorAll('.kt-condense-record')).toHaveLength(2));
        // Close and reopen: the fresh draft is resumable, the old one export-only.
        modalEl()._closeModal();
        await openLedgerCleanupReviewModal(NPC, 7);
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-resume')).toBeTruthy());
        expect(body().querySelector('.kt-condense-prev-draft')).toBeTruthy();
        body().querySelector('.kt-condense-prev-draft .kt-condense-draft-export').click();
        await vi.waitFor(() => expect(getFakeDownloadJsonCalls()).toHaveLength(1));
        expect(getFakeDownloadJsonCalls()[0].data.proposal.records[0].text).toContain('pre-regeneration');
        body().querySelector('.kt-condense-resume').click();
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-records')).toBeTruthy());
        expect(body().querySelector('.kt-condense-text').value).not.toContain('pre-regeneration');
    });

    async function editFirstRecord(text) {
        const area = body().querySelector('.kt-condense-text');
        area.value = text;
        area.dispatchEvent(new Event('change', { bubbles: true }));
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-text').value).toBe(text));
    }

    async function reopen() {
        modalEl()._closeModal();
        await openLedgerCleanupReviewModal(NPC, 7);
        await vi.waitFor(() => expect(modalEl()).toBeTruthy());
    }

    async function exportPrevious(index) {
        const before = getFakeDownloadJsonCalls().length;
        body().querySelector(`.kt-condense-prev-draft .kt-condense-draft-export[data-index="${index}"]`).click();
        await vi.waitFor(() => expect(getFakeDownloadJsonCalls()).toHaveLength(before + 1));
        return getFakeDownloadJsonCalls()[before].data;
    }

    test('a fresh request from the disclosure keeps the unresumed retained draft exportable', async () => {
        useGoodApi();
        await openReview();
        await consentAndGenerate();
        await editFirstRecord('USER-EDIT merged wharf record via told/witness — Day 5-7');
        await reopen();
        expect(body().querySelector('.kt-condense-resume')).toBeTruthy();
        expect(body().querySelector('.kt-condense-draft-offer').textContent).toContain('keeps it below for export');
        await consentAndGenerate(); // a new proposal instead of Resume
        await reopen();
        const payload = await exportPrevious(0);
        expect(payload.proposal.records[0].text).toContain('USER-EDIT');
    });

    test('repeated regenerations keep each replaced draft, up to the stated limit', async () => {
        useGoodApi();
        await openReview();
        await consentAndGenerate();
        await editFirstRecord('FIRST-EDIT merged wharf record via told/witness — Day 5-7');
        const regenerate = async () => {
            const sent = apiRequests.length;
            body().querySelector('.kt-condense-regenerate').click();
            await vi.waitFor(() => expect(apiRequests.length).toBe(sent + 1));
            await vi.waitFor(() => expect(statusText()).toContain('Proposal ready'));
        };
        await regenerate();
        await regenerate();
        await reopen();
        expect(body().querySelectorAll('.kt-condense-prev-draft .kt-condense-draft-export')).toHaveLength(2);
        expect((await exportPrevious(1)).proposal.records[0].text).toContain('FIRST-EDIT');
        // Beyond the limit only the most recent stay, and the panel says so.
        body().querySelector('.kt-condense-resume').click();
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-records')).toBeTruthy());
        for (let i = 0; i < PREVIOUS_DRAFT_LIMIT; i++) await regenerate();
        await reopen();
        expect(body().querySelectorAll('.kt-condense-prev-draft .kt-condense-draft-export')).toHaveLength(PREVIOUS_DRAFT_LIMIT);
        expect(body().querySelector('.kt-condense-prev-draft').textContent).toContain(`the ${PREVIOUS_DRAFT_LIMIT} most recent`);
    });

    test('a chat change detaches the open review; the retained draft stays bound to its origin', async () => {
        useGoodApi();
        await openReview();
        await consentAndGenerate();
        const area = body().querySelector('.kt-condense-text');
        area.value = 'scope-surviving edit via told/witness — Day 5-7';
        area.dispatchEvent(new Event('change', { bubbles: true }));
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-text').value).toContain('scope-surviving'));
        bumpEpoch();
        onChatChanged();
        await flush();
        await flush();
        expect(modalEl()).toBeNull();
        // Reopening in the (now current) scope offers the draft again.
        await openLedgerCleanupReviewModal(NPC, 7);
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-resume')).toBeTruthy());
        body().querySelector('.kt-condense-resume').click();
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-text').value).toContain('scope-surviving'));
    });
});

// ─── The reviewed recovery surface ───────────────────────────────────────────

describe('the recovery manager', () => {
    test.each(['retry', 'recovery'])('uncertain final status can be reconciled through %s without another target write', async path => {
        useGoodApi();
        await openReview();
        await consentAndGenerate();
        wiFake.failSavesFrom = 4; // original, pending, target succeed; final status fails
        body().querySelector('.kt-condense-apply').click();
        body().querySelector('.kt-condense-confirm-apply').click();
        await vi.waitFor(() => expect(statusText()).toContain('save outcome is uncertain'));
        const appliedContent = entry7().content;
        expect(appliedContent).not.toBe(ORIGINAL);
        const pending = (await listCleanupRecovery()).records;
        expect(pending).toHaveLength(1);
        expect(pending[0].status).toBe('application-pending');
        wiFake.failSavesFrom = null;
        const savesBefore = wiFake.saveCalls;
        if (path === 'retry') {
            body().querySelector('.kt-condense-confirm-apply').click();
            await vi.waitFor(() => expect(body().querySelector('.kt-condense-applied')).toBeTruthy());
        } else {
            // The manager needs only the persisted record, not the review or
            // its in-memory attempt ID (the same path is available after reload).
            modalEl()._closeModal();
            const capture = await prepareLedgerCleanup({ name: NPC, uid: 7 });
            clearCleanupDraft(capture.capture);
            await openCleanupRecoveryModal();
            const manager = document.getElementById('kt-cleanup-recovery-modal');
            expect(manager.querySelector('.kt-crec-restore')).toBeNull();
            manager.querySelector('.kt-crec-reconcile').click();
            await vi.waitFor(() => expect(manager.querySelector('.kt-crec-restore')).toBeTruthy());
            expect(manager.querySelector('.kt-crec-reconcile')).toBeNull();
        }
        expect(entry7().content).toBe(appliedContent);
        expect(wiFake.saveCalls - savesBefore).toBe(1); // status only; no duplicate target save
        const records = (await listCleanupRecovery()).records;
        expect(records).toHaveLength(1);
        expect(records[0].actionId).toBe(pending[0].actionId);
        expect(records[0].status).toBe('applied');
    });

    async function appliedReview() {
        useGoodApi();
        await openReview();
        await consentAndGenerate();
        body().querySelector('.kt-condense-apply').click();
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-confirm')).toBeTruthy());
        body().querySelector('.kt-condense-confirm-apply').click();
        await vi.waitFor(() => expect(body().querySelector('.kt-condense-applied')).toBeTruthy());
    }

    test('lists records with usage, restores span-aware, and deletes only on explicit double confirm', async () => {
        await appliedReview();
        body().querySelector('.kt-condense-recovery-open').click();
        const recModal = document.getElementById('kt-cleanup-recovery-modal');
        await vi.waitFor(() => expect(recModal.querySelector('.kt-crec-usage')).toBeTruthy());
        expect(recModal.querySelector('.kt-crec-usage').textContent).toContain('1 record');
        expect(recModal.querySelectorAll('.kt-crec-row')).toHaveLength(1);
        expect(recModal.querySelector('.kt-crec-status').textContent).toBe('applied');
        // Restore from the manager, after newer unrelated work.
        entry7().content = entry7().content.replace('Tone: brisk', 'Tone: newer unrelated work');
        recModal.querySelector('.kt-crec-restore').click();
        await vi.waitFor(() => expect(entry7().content).toBe(ORIGINAL.replace('Tone: brisk', 'Tone: newer unrelated work')));
        expect(recModal.querySelector('.mwt-status').textContent).toContain('Original restored');
        // The restore captured a restore-safeguard record: two records now.
        expect((await listCleanupRecovery()).records).toHaveLength(2);
        // Deletion needs the second confirming click.
        const del = recModal.querySelector('.kt-crec-delete');
        del.click();
        await flush();
        expect((await listCleanupRecovery()).records).toHaveLength(2);
        recModal.querySelector('.kt-crec-delete').click();
        await vi.waitFor(async () => expect((await listCleanupRecovery()).records).toHaveLength(1));
    });

    test('a touched-span restore conflicts and offers the record for export', async () => {
        await appliedReview();
        // Someone edits the ledger after the apply → the span no longer matches.
        entry7().content = entry7().content.replace(
            '- the gate code is 7314 via document — Day 7',
            '- the gate code was changed from 7314 via document — Day 9');
        body().querySelector('.kt-condense-recovery-open').click();
        const recModal = document.getElementById('kt-cleanup-recovery-modal');
        await vi.waitFor(() => expect(recModal.querySelector('.kt-crec-restore')).toBeTruthy());
        recModal.querySelector('.kt-crec-restore').click();
        await vi.waitFor(() => expect(recModal.querySelector('.mwt-status').textContent).toContain('Restore refused'));
        // The record itself remains exportable for manual reconciliation.
        recModal.querySelector('.kt-crec-export').click();
        await vi.waitFor(() => expect(getFakeDownloadJsonCalls()).toHaveLength(1));
        expect(getFakeDownloadJsonCalls()[0].data.type).toBe('mwt-cleanup-recovery');
    });

    test('import merges exported records (current wins) through the file picker', async () => {
        await appliedReview();
        const payload = await exportCleanupRecovery();
        // Wipe the container entry off the book, leaving zero records.
        const entries = wiFake.books.get(BOOK).entries;
        for (const [key, entry] of Object.entries(entries)) {
            if (String(entry.comment || '').startsWith('[MWT:cleanup-recovery]')) delete entries[key];
        }
        expect((await listCleanupRecovery()).records).toHaveLength(0);
        openCleanupRecoveryModal();
        await vi.waitFor(() => {
            const recModal = document.getElementById('kt-cleanup-recovery-modal');
            expect(recModal).toBeTruthy();
            expect(recModal.querySelector('.kt-crec-empty')).toBeTruthy();
        });
        setPickTextFileStub(() => JSON.stringify(payload));
        document.getElementById('kt-cleanup-recovery-modal').querySelector('.kt-crec-import').click();
        await vi.waitFor(() => {
            const recModal = document.getElementById('kt-cleanup-recovery-modal');
            expect(recModal.querySelector('.kt-crec-row')).toBeTruthy();
        });
        expect((await listCleanupRecovery()).records).toHaveLength(1);
    });

    test.each(['chat-switch', 'modal-close'])('pending import writes nothing after %s', async (change) => {
        await appliedReview();
        const payload = await exportCleanupRecovery();
        let resolvePicker;
        const picked = new Promise(resolve => { resolvePicker = resolve; });
        setPickTextFileStub(() => picked);
        await openCleanupRecoveryModal();
        const modal = document.getElementById('kt-cleanup-recovery-modal');
        modal.querySelector('.kt-crec-import').click();
        const before = structuredClone([...wiFake.books]);
        const savesBefore = wiFake.saveCalls;
        if (change === 'chat-switch') {
            saveSettings({ scope: 'chat' });
            setFakeContextExtras({ chatId: 'destination-chat', getCurrentChatId: () => 'destination-chat' });
            expect(getLorebookName()).not.toBe(BOOK);
            bumpEpoch();
            onChatChanged();
        } else {
            modal._closeModal();
        }
        expect(modal.isConnected).toBe(false);
        resolvePicker(JSON.stringify(payload));
        await flush();
        await flush();
        expect(wiFake.saveCalls).toBe(savesBefore);
        expect([...wiFake.books]).toEqual(before);
    });

    test('the import service refuses a stale bound scope or destination', async () => {
        await appliedReview();
        const payload = await exportCleanupRecovery();
        const scopeToken = captureScope();
        const savesBefore = wiFake.saveCalls;
        await expect(importCleanupRecovery(payload, { bookName: 'wrong-book', scopeToken })).rejects.toThrow('changed');
        bumpEpoch();
        await expect(importCleanupRecovery(payload, { bookName: BOOK, scopeToken })).rejects.toThrow('changed');
        expect(wiFake.saveCalls).toBe(savesBefore);
    });

    test('the import service rechecks scope after waiting for the store lock', async () => {
        await appliedReview();
        const payload = await exportCleanupRecovery();
        let release;
        const blocked = new Promise(resolve => { release = resolve; });
        const lock = withStoreLock(() => blocked);
        const savesBefore = wiFake.saveCalls;
        const pending = importCleanupRecovery(payload);
        const refused = expect(pending).rejects.toThrow('changed');
        bumpEpoch();
        release();
        await lock;
        await refused;
        expect(wiFake.saveCalls).toBe(savesBefore);
    });

    test('a chat switch after the import write lands reports the import as landed', async () => {
        await appliedReview();
        const payload = await exportCleanupRecovery();
        const [[, record]] = Object.entries(payload.records);
        payload.records = { 'imported-copy': { ...record, actionId: 'imported-copy' } };
        let saves = 0;
        wiFake.afterSave = () => { if (++saves === 1) bumpEpoch(); };
        await expect(importCleanupRecovery(payload)).resolves.toEqual({ added: ['imported-copy'], kept: [], rejected: [] });
        expect(saves).toBe(1);
        expect(await getCleanupRecord('imported-copy', BOOK)).toBeTruthy();
    });

    test('recovery manager can retry importing recovery directly from a retained backup', async () => {
        await appliedReview();
        const recovery = await exportCleanupRecovery();
        const backup = buildBackupEnvelope({ identity: { chatId: 'chat-a', isUnknown: false }, metadata: {}, cleanupRecovery: { version: recovery.version, records: recovery.records } });
        const entries = wiFake.books.get(BOOK).entries;
        for (const [key, entry] of Object.entries(entries)) if (String(entry.comment || '').startsWith('[MWT:cleanup-recovery]')) delete entries[key];
        openCleanupRecoveryModal();
        await vi.waitFor(() => expect(document.querySelector('.kt-crec-import')).toBeTruthy());
        setPickTextFileStub(() => JSON.stringify(backup));
        document.querySelector('.kt-crec-import').click();
        await vi.waitFor(async () => expect((await listCleanupRecovery()).records).toHaveLength(1));
    });
});
