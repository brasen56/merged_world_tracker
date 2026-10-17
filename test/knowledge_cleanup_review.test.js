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
import { saveSettings } from '../knowledge/settings.js';
import { _setCacheForTests, _clearCacheForTests, withStoreLock } from '../knowledge/store.js';
import { renderNpcsSubTab } from '../knowledge/render.js';
import { openLedgerCleanupReviewModal, openCleanupRecoveryModal } from '../knowledge/cleanup_review_ui.js';
import { onChatChanged } from '../knowledge/index.js';
import { listCleanupRecovery, exportCleanupRecovery, getCleanupRecord, importCleanupRecovery } from '../knowledge/cleanup_recovery.js';
import { getLorebookName } from '../knowledge/scope.js';
import { LEDGER_CLEANUP_PROMPT } from '../knowledge/prompts.js';
import { prepareLedgerCleanup, saveCleanupDraft, getCleanupDraft, clearCleanupDraft, requestLedgerProposal } from '../knowledge/cleanup_review.js';
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

/** Build a valid proposal v1 from the request's own review payload: the
 *  first two sources merge, every further source maps to an exact-original
 *  record, and (with 3+ sources) one advisory pruning suggestion is included. */
function condensedProposalJson(userContent) {
    const reviewId = /<review_id>([^<]+)<\/review_id>/.exec(userContent)?.[1] || '';
    const ids = [...userContent.matchAll(/^\[([^\]]+)\] /gm)].map(m => m[1]);
    const lineOf = (id) => {
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const m = new RegExp(`^\\[${escaped}\\] (.*)$`, 'm').exec(userContent);
        return m ? m[1].replace(/^-\s*/, '').trim() : 'kept original';
    };
    const records = [];
    if (ids.length >= 2) {
        records.push({ id: 'r1', text: 'smugglers use the north wharf and were seen with guild keys there via told/witness — Day 5-7', sourceIds: [ids[0], ids[1]], notes: 'Merged the two wharf observations.' });
    }
    for (const id of (ids.length >= 2 ? ids.slice(2) : ids)) {
        records.push({ id: `r${records.length + 1}`, text: lineOf(id), sourceIds: [id], notes: '' });
    }
    return JSON.stringify({
        version: 1,
        reviewId,
        records,
        pruningSuggestions: ids[2]
            ? [{ sourceIds: [ids[2]], reason: `duplicates the wharf record (${ids[0]}): the gate code came from the same document drop` }]
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

    test('capture refusals surface before any modal and change nothing', async () => {
        seedBook();
        delete wiFake.books.get(BOOK).entries[7];
        renderNpcsSubTab(); // ktSetStatus writes #kt-status inside the sub-tab
        await openLedgerCleanupReviewModal(NPC, 7);
        await flush();
        expect(modalEl()).toBeNull();
        expect(ktStatusText()).toContain('no longer exists');
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
        expect(userContent).toMatch(/\[lr-[a-z0-9-]+:source:\d+\]/);
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
            return 'Here is your proposal:\n{"version":1,"reviewId":"lr-';
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

// ─── Review: records, sources, decisions ─────────────────────────────────────

describe('the source-aware review', () => {
    test('records render beside expandable exact originals, notes, and advisory warnings', async () => {
        useGoodApi();
        await openReview();
        await consentAndGenerate();
        const records = body().querySelectorAll('.kt-condense-record');
        expect(records).toHaveLength(2);
        expect(records[0].querySelector('h4').textContent).toContain('covers 2 sources');
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
        const first = body().querySelector('.kt-condense-record');
        expect(first.querySelector('.kt-condense-text').value).toBe('smugglers use the north wharf via told — Day 5');
        expect(first.querySelectorAll('.kt-condense-source-text')).toHaveLength(1);
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
