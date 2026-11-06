/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCoreStubs, getFakeDownloadJsonCalls, getFakeDownloadBlobCalls } from './stubs/core.js';
import { releaseManagedInert } from '../core/modal.js';
import { captureScope, _resetEpoch, bumpEpoch } from '../core/scope.js';
import { captureCleanupTarget } from '../knowledge/cleanup_commit.js';
import { ktFetchFromApi } from '../knowledge/lorebook.js';
import { cleanupModelDisclosure } from '../knowledge/cleanup_review.js';
import { openDeepConsolidationPreviewModal } from '../knowledge/deep_consolidation_review_ui.js';
import { captureDeepConsolidationReview, expandDeepConsolidationProposal } from '../knowledge/deep_consolidation.js';
import { moveDeepSource, exportDeepTrialPacket } from '../knowledge/deep_consolidation_preview.js';

vi.mock('../knowledge/cleanup_commit.js', () => ({ captureCleanupTarget: vi.fn() }));
vi.mock('../knowledge/lorebook.js', () => ({ ktFetchFromApi: vi.fn() }));
vi.mock('../knowledge/settings.js', () => ({ hasValidSettings: () => true }));
vi.mock('../knowledge/cleanup_review.js', async importOriginal => ({
    ...await importOriginal(), cleanupModelDisclosure: vi.fn(),
}));

const original = 'PRIVATE DOSSIER\r\nKnowledge Ledger:\r\n- gate code 7314\r\n- gate opens at dawn\r\n- correction: password raven\r\n- RECENT PRIVATE\r\n\r\nOther: intact';
const find = selector => document.querySelector(selector);
const action = name => find(`[data-deep-action="${name}"]`);
const change = (input, value) => { input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); };
function answer(_prompt, payload) {
    const reviewId = /<review_id>(.*?)<\/review_id>/.exec(payload)[1];
    return JSON.stringify({ version: 3, reviewId, keep: [], changed: [{ s: [1, 2], t: 'The gate opens at dawn.' }],
        archive: [3], groups: [{ s: [1, 2, 3], label: 'Gate <img src=x onerror=alert(1)>' }] });
}
async function open() {
    const modal = await openDeepConsolidationPreviewModal('Mara <script>bad</script>', 7);
    change(find('[data-deep-boundary]'), '3');
    return modal;
}
async function generate() {
    find('[data-deep-consent]').click();
    action('generate').click();
    await vi.waitFor(() => expect(action('accept-groups')).toBeTruthy());
}

beforeEach(() => {
    resetCoreStubs();
    _resetEpoch();
    vi.clearAllMocks();
    document.body.innerHTML = '';
    captureCleanupTarget.mockImplementation(async () => ({ name: 'Mara', uid: 7, bookName: 'Test',
        originalContent: original, scopeToken: captureScope() }));
    cleanupModelDisclosure.mockReturnValue({ mode: 'custom', source: 'module-custom', modelName: 'test-model', maxTokens: 8000 });
    ktFetchFromApi.mockImplementation(answer);
});
afterEach(() => {
    find('#kt-deep-consolidation-modal')?._closeModal();
    releaseManagedInert();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

describe('read-only deep consolidation preview UI', () => {
    it('discloses, requires consent, minimizes the request, gates records on groups and escapes untrusted strings', async () => {
        const modal = await open();
        expect(modal.style.display).not.toBe('none');
        expect(modal.getAttribute('id')).toBe('kt-deep-consolidation-modal');
        expect(ktFetchFromApi).not.toHaveBeenCalled();
        expect(action('generate').disabled).toBe(true);
        expect(modal.textContent).toContain('test-model');
        expect(modal.textContent).toContain('capacity is unknown');
        await generate();
        expect(ktFetchFromApi.mock.calls[0][1]).not.toMatch(/PRIVATE DOSSIER|RECENT PRIVATE|\[s4\]/);
        expect(find('[data-deep-record]')).toBeNull();
        expect(find('script, img')).toBeNull();
        action('accept-groups').click();
        expect(find('[data-deep-record]')).toBeTruthy();
        expect(modal.textContent).toContain('7314');
        expect(modal.textContent).toContain('raven');
        expect(modal.textContent).toContain('semantic equivalence');
        expect([...modal.querySelectorAll('button')].some(button => /^apply/i.test(button.textContent))).toBe(false);
    });

    it('edits records, disables exports on invalid text, recomputes and exports linked current data', async () => {
        await open(); await generate(); action('accept-groups').click();
        change(find('[data-deep-record]'), 'bad\nline');
        expect(action('export-text').disabled).toBe(true);
        expect(find('[role="alert"]').textContent).toContain('invalid');
        change(find('[data-deep-record]'), 'gate code 7314, opens at dawn');
        expect(action('export-text').disabled).toBe(false);
        action('export-text').click(); action('export-packet').click();
        const packet = getFakeDownloadJsonCalls()[0].data;
        expect(packet.records[0]).toMatchObject({ text: 'gate code 7314, opens at dawn', sourceNumbers: [1, 2] });
        expect(packet.sources.map(source => source.disposition)).toEqual(['changed', 'changed', 'archived', 'recent']);
        expect(packet.originalEntry).toBe(original);
        expect(packet.consolidatedEntry).toContain('- RECENT PRIVATE\r\n\r\nOther: intact');
        expect(packet.requestFacts.estimate.disclosure.modelName).toBe('test-model');
        expect(packet.requestFacts.grammar.name).toBe('inline-clause-provenance');
        expect(getFakeDownloadBlobCalls()).toHaveLength(1);
        expect(packet.measurements.afterTokens).toBeGreaterThan(0);
        expect(packet.warnings.some(warning => warning.sourceNumber === 3)).toBe(true);
    });

    it('relabels, ungroups and restores merged owners, with fresh record acceptance', async () => {
        await open(); await generate();
        change(find('[data-deep-label]'), 'Harbour');
        action('accept-groups').click();
        change(find('[data-deep-group]'), '-1');
        expect(find('[data-deep-record]')).toBeNull();
        action('accept-groups').click();
        expect(document.querySelectorAll('[data-deep-record]')).toHaveLength(2);
        action('export-packet').click();
        const packet = getFakeDownloadJsonCalls()[0].data;
        expect(packet.groups[0]).toMatchObject({ label: 'Harbour', sourceNumbers: [2, 3] });
        expect(packet.sources[0].disposition).toBe('kept');
        expect(packet.sources[1].disposition).toBe('kept');
    });

    it('keeps an archived exact candidate and recomputes its disposition', async () => {
        await open(); await generate(); action('accept-groups').click();
        const keep = [...document.querySelectorAll('[data-deep-action="keep-record"]')].find(button => button.textContent === 'Keep source exactly');
        keep.click(); action('export-packet').click();
        const packet = getFakeDownloadJsonCalls()[0].data;
        expect(packet.sources[2].disposition).toBe('kept');
        expect(packet.archiveOnlyDetails).toHaveLength(0);
    });

    it('selects pins before the request and refuses known output excess before dispatch', async () => {
        await open();
        find('[data-deep-pin="1"]').click();
        expect(find('[data-deep-pin="4"]').disabled).toBe(true);
        ktFetchFromApi.mockImplementation((_prompt, payload) => {
            expect(payload).toContain('<pinned_keep>[1]</pinned_keep>');
            return JSON.stringify({ version: 3, reviewId: /<review_id>(.*?)<\/review_id>/.exec(payload)[1],
                keep: [1, 2, 3], changed: [], archive: [], groups: [] });
        });
        await generate();
        expect(ktFetchFromApi).toHaveBeenCalledTimes(1);
        cleanupModelDisclosure.mockReturnValue({ maxTokens: 1 });
        change(find('[data-deep-budget]'), '3000');
        expect(action('generate').disabled).toBe(true);
    });

    it('cancels and ignores late results, and closing aborts without downloads', async () => {
        let resolve;
        ktFetchFromApi.mockImplementation(() => new Promise(done => { resolve = done; }));
        const modal = await open();
        find('[data-deep-consent]').click(); action('generate').click();
        await vi.waitFor(() => expect(ktFetchFromApi).toHaveBeenCalledTimes(1));
        action('cancel').click();
        const args = ktFetchFromApi.mock.calls[0];
        expect(args[2].signal.aborted).toBe(true);
        resolve(answer(...args));
        await vi.waitFor(() => expect(action('generate').disabled).toBe(false));
        expect(action('accept-groups')).toBeNull();
        action('generate').click();
        await vi.waitFor(() => expect(ktFetchFromApi).toHaveBeenCalledTimes(2));
        modal._closeModal();
        expect(ktFetchFromApi.mock.calls[1][2].signal.aborted).toBe(true);
        resolve(answer(...ktFetchFromApi.mock.calls[1]));
        expect(getFakeDownloadJsonCalls()).toHaveLength(0);
    });

    it('regenerates with fresh capture/identity and stops old-scope actions', async () => {
        await open(); await generate();
        const first = ktFetchFromApi.mock.calls[0][1];
        action('generate').click();
        await vi.waitFor(() => expect(ktFetchFromApi).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(action('generate').disabled).toBe(false));
        expect(ktFetchFromApi.mock.calls[1][1]).not.toBe(first);
        expect(captureCleanupTarget).toHaveBeenCalledTimes(3);
        bumpEpoch();
        action('accept-groups').click();
        expect(find('[data-deep-record]')).toBeNull();
    });
});

describe('pure group editing and packet safety', () => {
    it('moves across groups, keeps ownership exact, rejects unknown targets and detaches exports', () => {
        const selection = captureDeepConsolidationReview(original, { throughSource: 3 });
        const { proposal } = expandDeepConsolidationProposal(selection, { version: 3, reviewId: selection.review.reviewId,
            keep: [], changed: [{ s: [1, 2], t: 'Gate summary' }], archive: [3],
            groups: [{ s: [1, 2], label: 'Gate' }, { s: [3], label: 'Correction' }] });
        const before = JSON.stringify(proposal);
        const next = moveDeepSource(selection, proposal, selection.eligibleSources[0].id, 1);
        expect(next.records).toHaveLength(2);
        expect(next.groups[1].sourceIds).toContain(selection.eligibleSources[0].id);
        expect(JSON.stringify(proposal)).toBe(before);
        expect(() => moveDeepSource(selection, proposal, selection.eligibleSources[0].id, 9)).toThrow();
        const packet = exportDeepTrialPacket({ selection, proposal, capture: { name: 'Mara' }, activeBudget: 1, requestFacts: {} });
        packet.proposal.records[0].text = 'different';
        expect(proposal.records[0].text).toBe('Gate summary');
        expect(packet.measurements.overBudget).toBe(true);
    });
});