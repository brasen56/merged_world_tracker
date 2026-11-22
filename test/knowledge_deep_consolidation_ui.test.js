/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resetCoreStubs, getFakeDownloadJsonCalls } from './stubs/core.js';
import { releaseManagedInert } from '../core/modal.js';
import { captureScope, _resetEpoch, bumpEpoch } from '../core/scope.js';
import { captureCleanupTarget } from '../knowledge/cleanup_commit.js';
import { ktFetchFromApi } from '../knowledge/lorebook.js';
import { cleanupModelDisclosure, _resetCleanupDraftsForTests, getCleanupDraft } from '../knowledge/cleanup_review.js';
import { openDeepConsolidationPreviewModal } from '../knowledge/deep_consolidation_review_ui.js';
import { _resetDeepConsolidationDraftsForTests } from '../knowledge/deep_consolidation_batches.js';

vi.mock('../knowledge/cleanup_commit.js', () => ({ captureCleanupTarget: vi.fn() }));
vi.mock('../knowledge/lorebook.js', () => ({ ktFetchFromApi: vi.fn() }));
vi.mock('../knowledge/settings.js', () => ({ hasValidSettings: () => true }));
vi.mock('../knowledge/cleanup_review.js', async original => ({ ...await original(), cleanupModelDisclosure: vi.fn() }));
const original = 'PRIVATE DOSSIER\r\nKnowledge Ledger:\r\n- PRIVATE PIN\r\n- gate\r\n- correction\r\n- alone\r\n- PRIVATE RECENT';
const find = selector => document.querySelector(selector);
const action = name => find(`[data-deep-action="${name}"]`);
const change = (input, value) => { input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); };
const answer = (_p, payload) => JSON.stringify({ version: 1, reviewId: /<review_id>(.*?)<\/review_id>/.exec(payload)[1],
    groups: [{ label: 'Gate <img src=x>', s: [2, 3, 2, 999] }, { label: 'Alone', s: [4] }] });
async function open() {
    const modal = await openDeepConsolidationPreviewModal('Mara <script>bad</script>', 7);
    change(find('[data-deep-boundary]'), '4');
    find('[data-deep-pin="1"]').click();
    return modal;
}
async function generate() {
    find('[data-deep-consent]').click();
    action('generate').click();
    await vi.waitFor(() => expect(find('[data-deep-label]')).toBeTruthy());
}
beforeEach(() => {
    resetCoreStubs(); _resetEpoch(); vi.clearAllMocks();
    _resetDeepConsolidationDraftsForTests();
    _resetCleanupDraftsForTests();
    document.body.innerHTML = '';
    captureCleanupTarget.mockImplementation(async () => ({ name: 'Mara', uid: 7, bookName: 'Test', originalContent: original, scopeToken: captureScope() }));
    cleanupModelDisclosure.mockReturnValue({ source: 'custom', mode: 'custom', modelName: 'test-model', maxTokens: 8000 });
    ktFetchFromApi.mockImplementation(answer);
});
afterEach(() => {
    find('#kt-deep-consolidation-modal')?._closeModal();
    find('#kt-ledger-review-modal')?._closeModal();
    releaseManagedInert(); document.body.innerHTML = ''; vi.restoreAllMocks();
});

it('requires consent, minimizes the request, displays normalized groups and escapes labels', async () => {
    const modal = await open();
    expect(action('generate').disabled).toBe(true);
    expect(modal.textContent).toContain('test-model');
    await generate();
    expect(ktFetchFromApi.mock.calls[0][1]).not.toMatch(/PRIVATE|\[s1\]|\[s5\]|active_budget/);
    expect(modal.textContent).toContain('1 duplicates resolved');
    expect(modal.textContent).toContain('1 unknown, non-integer or excluded numbers ignored');
    expect(modal.textContent).toContain('kept exact (singleton)');
    expect(modal.textContent).toContain('estimated batches');
    expect(find('script, img')).toBeNull();
    expect(find('[data-deep-record]')).toBeNull();
    expect([...modal.querySelectorAll('button')].some(b => /^apply/i.test(b.textContent))).toBe(false);
    expect(document.querySelectorAll('[data-deep-group]')).toHaveLength(3);
});

it('edits bounded labels, moves, ungroups and creates groups without requesting again', async () => {
    await open(); await generate();
    change(find('[data-deep-label]'), 'x'.repeat(100));
    expect(find('[data-deep-label]').value).toHaveLength(80);
    change(find('[data-deep-group="2"]'), '-1');
    expect(find('#kt-deep-group-description-2').textContent).toBe('Ungrouped — kept exactly.');
    action('add-group').click();
    expect(find('#kt-deep-group-description-2').textContent).toContain('New subject');
    expect(ktFetchFromApi).toHaveBeenCalledTimes(1);
    change(find('[data-deep-boundary]'), '3');
    expect(find('[data-deep-label]')).toBeNull();
    expect(find('[data-deep-consent]').checked).toBe(false);
});

it('offers local position grouping without consent or a sufficient model budget', async () => {
    cleanupModelDisclosure.mockReturnValue({ maxTokens: 1 });
    await open();
    expect(action('generate').disabled).toBe(true);
    expect(action('position').disabled).toBe(false);
    action('position').click();
    expect(find('[data-deep-label]').value).toBe('Position 1');
    expect(ktFetchFromApi).not.toHaveBeenCalled();
});

it('keeps disclosure identity stable and regenerates with a fresh capture', async () => {
    const uuid = vi.spyOn(globalThis.crypto, 'randomUUID');
    await open();
    const initial = find('.kt-deep-disclosure').textContent;
    const count = uuid.mock.calls.length;
    find('[data-deep-consent]').click(); find('[data-deep-consent]').click();
    expect(find('.kt-deep-disclosure').textContent).toBe(initial);
    expect(uuid).toHaveBeenCalledTimes(count);
    await generate();
    action('generate').click();
    await vi.waitFor(() => expect(ktFetchFromApi).toHaveBeenCalledTimes(2));
    expect(ktFetchFromApi.mock.calls[0][1]).not.toBe(ktFetchFromApi.mock.calls[1][1]);
});

it('refuses changed content before dispatch', async () => {
    await open();
    captureCleanupTarget.mockResolvedValue({ name: 'Mara', uid: 7, bookName: 'Test', originalContent: 'changed', scopeToken: captureScope() });
    find('[data-deep-consent]').click(); action('generate').click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Close and reopen'));
    expect(ktFetchFromApi).not.toHaveBeenCalled();
});

it('downloads failures privately and allows local fallback without another call', async () => {
    const raw = '<script>PRIVATE FAILED</script>';
    ktFetchFromApi.mockResolvedValue(raw);
    await open();
    find('[data-deep-consent]').click(); action('generate').click();
    await vi.waitFor(() => expect(find('.kt-deep-failure').hidden).toBe(false));
    expect(find('script')).toBeNull();
    expect(find('[data-deep-parser-error]').textContent).toContain('Unexpected token');
    action('export-failure').click();
    expect(getFakeDownloadJsonCalls()[0].data.rawResponse).toBe(raw);
    action('position').click();
    expect(find('[data-deep-label]')).toBeTruthy();
    expect(ktFetchFromApi).toHaveBeenCalledTimes(1);
});

it('cancels, ignores late results and aborts on close', async () => {
    let resolve;
    ktFetchFromApi.mockImplementation(() => new Promise(done => { resolve = done; }));
    const modal = await open();
    find('[data-deep-consent]').click(); action('generate').click();
    await vi.waitFor(() => expect(resolve).toBeTruthy());
    expect(action('position').disabled).toBe(true);
    action('cancel').click();
    const args = ktFetchFromApi.mock.calls[0];
    expect(args[2].signal.aborted).toBe(true);
    resolve(answer(...args));
    await vi.waitFor(() => expect(action('generate').disabled).toBe(false));
    expect(find('[data-deep-label]')).toBeNull();
    action('generate').click();
    await vi.waitFor(() => expect(ktFetchFromApi).toHaveBeenCalledTimes(2));
    modal._closeModal();
    expect(ktFetchFromApi.mock.calls[1][2].signal.aborted).toBe(true);
    resolve(answer(...ktFetchFromApi.mock.calls[1]));
    expect(getFakeDownloadJsonCalls()).toHaveLength(0);
});

it('ignores late failures and actions from an old scope', async () => {
    let resolve;
    ktFetchFromApi.mockImplementation(() => new Promise(done => { resolve = done; }));
    await open(); find('[data-deep-consent]').click(); action('generate').click();
    await vi.waitFor(() => expect(resolve).toBeTruthy());
    bumpEpoch(); resolve('PRIVATE LATE');
    await vi.waitFor(() => expect(action('generate').getAttribute('aria-busy')).toBeNull());
    expect(find('.kt-deep-failure').hidden).toBe(true);
    action('position').click();
    expect(find('[data-deep-label]')).toBeNull();
});

const batchAnswer = (_p, payload) => JSON.stringify({ version: 2,
    reviewId: /<review_id>(.*?)<\/review_id>/.exec(payload)[1], keep: [1, 2], changed: [], pruningSuggestions: [] });

it('plans locally, requires fresh batch consent, retains accepted work on reopen and discards explicitly', async () => {
    let modal = await open(); await generate();
    action('plan-batches').click();
    expect(find('[data-deep-consent]').checked).toBe(false);
    expect(action('run-batches').disabled).toBe(true);
    expect(ktFetchFromApi).toHaveBeenCalledTimes(1);
    ktFetchFromApi.mockImplementation(batchAnswer);
    find('[data-deep-consent]').click(); action('run-batches').click();
    await vi.waitFor(() => expect(modal.textContent).toContain('1 accepted / 2 planned'));
    expect(modal.textContent).toContain('skipped');
    expect(find('[data-deep-boundary]').disabled || find('.kt-deep-config').disabled).toBe(true);
    modal._closeModal();
    modal = await openDeepConsolidationPreviewModal('Mara <script>bad</script>', 7);
    expect(modal.textContent).toContain('1 accepted / 2 planned');
    expect(action('run-batches').disabled).toBe(true);
    expect(find('[data-deep-consent]').checked).toBe(false);
    expect(ktFetchFromApi).toHaveBeenCalledTimes(2);
    action('discard-draft').click();
    expect(find('.kt-deep-batches').textContent).toBe('');
    expect(action('position').disabled).toBe(false);
});

it('downloads per-batch failures privately and explicitly retries without regenerating groups', async () => {
    const modal = await open(); await generate(); action('plan-batches').click();
    ktFetchFromApi.mockResolvedValue('PRIVATE BATCH RAW');
    find('[data-deep-consent]').click(); action('run-batches').click();
    await vi.waitFor(() => expect(action('retry-batch')).toBeTruthy());
    expect(modal.textContent).not.toContain('PRIVATE BATCH RAW');
    action('export-batch-failure').click();
    expect(getFakeDownloadJsonCalls()[0].data.rawResponse).toBe('PRIVATE BATCH RAW');
    ktFetchFromApi.mockImplementation(batchAnswer);
    action('retry-batch').click();
    await vi.waitFor(() => expect(modal.textContent).toContain('1 accepted / 2 planned'));
    expect(ktFetchFromApi).toHaveBeenCalledTimes(3);
});

it('close aborts a batch, ignores its late result and reopens at pending work', async () => {
    let modal = await open(); await generate(); action('plan-batches').click();
    let resolve;
    ktFetchFromApi.mockImplementation(() => new Promise(done => { resolve = done; }));
    find('[data-deep-consent]').click(); action('run-batches').click();
    await vi.waitFor(() => expect(resolve).toBeTruthy());
    const args = ktFetchFromApi.mock.calls[1];
    modal._closeModal();
    expect(args[2].signal.aborted).toBe(true);
    resolve(batchAnswer(...args));
    // Wait for the runner's finally to return the in-flight batch to pending.
    await new Promise(done => setTimeout(done, 0));
    modal = await openDeepConsolidationPreviewModal('Mara <script>bad</script>', 7);
    expect(modal.textContent).toContain('0 accepted / 2 planned');
    expect(modal.textContent).toContain('pending');
    ktFetchFromApi.mockImplementation(batchAnswer);
    find('[data-deep-consent]').click(); action('run-batches').click();
    await vi.waitFor(() => expect(modal.textContent).toContain('1 accepted / 2 planned'));
});

it('blocks changed-revision draft resume rather than sending replacement sources', async () => {
    const modal = await open(); await generate(); action('plan-batches').click(); modal._closeModal();
    captureCleanupTarget.mockImplementation(async () => ({ name: 'Mara', uid: 7, bookName: 'Test', originalContent: original + '\r\n- appended', scopeToken: captureScope() }));
    const reopened = await openDeepConsolidationPreviewModal('Mara <script>bad</script>', 7);
    expect(reopened.textContent).toContain('draft cannot resume');
    find('[data-deep-consent]').click();
    expect(action('run-batches').disabled).toBe(true);
    expect(ktFetchFromApi).toHaveBeenCalledTimes(1);
});

it('hands off without consent or another model call and opens the Condense editor directly', async () => {
    await open(); await generate(); action('plan-batches').click();
    expect(find('[data-deep-consent]').checked).toBe(false);
    expect(action('handoff').disabled).toBe(false);
    action('handoff').click();
    await vi.waitFor(() => expect(find('.kt-condense-records')).toBeTruthy());
    expect(find('#kt-deep-consolidation-modal')).toBeNull();
    expect(find('.kt-condense-consent-box')).toBeNull();
    expect(ktFetchFromApi).toHaveBeenCalledTimes(1);
    expect(getCleanupDraft({ bookName: 'Test', name: 'Mara', uid: 7 }).review.maxRecordChars).toBe(1200);
});

it('refuses a hand-off if the live entry changed after the modal opened', async () => {
    await open(); await generate(); action('plan-batches').click();
    captureCleanupTarget.mockResolvedValue({ name: 'Mara', uid: 7, bookName: 'Test', originalContent: original + '\r\n- scan', scopeToken: captureScope() });
    action('handoff').click();
    await vi.waitFor(() => expect(find('.mwt-status').textContent).toContain('changed'));
    expect(find('#kt-ledger-review-modal')).toBeNull();
    expect(getCleanupDraft({ bookName: 'Test', name: 'Mara', uid: 7 })).toBeNull();
});