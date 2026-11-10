/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { resetCoreStubs, setFakeApi, setFakeContextExtras } from './stubs/core.js';
import { installCleanupFetch } from './stubs/cleanup-fetch.js';
import { state } from '../knowledge/state.js';
import { saveSettings } from '../knowledge/settings.js';
import { _clearCacheForTests, _setCacheForTests } from '../knowledge/store.js';
import { getRegistry, getGrowthDossierSettings, setGrowthDossierSettings } from '../knowledge/registry.js';
import { getEvidenceFile } from '../knowledge/evidence.js';
import { renderNpcsSubTab, openGrowthProfileModal } from '../knowledge/render.js';
import { createGrowthStagingItem, buildGrowthReviewContent } from '../knowledge/growth_dossier_review.js';
import { mergeScanResults } from '../knowledge/staging.js';
import { bumpEpoch, _resetEpoch } from '../core/scope.js';
import { pauseStore, resumeStore } from '../core/schema_status.js';

vi.mock('../knowledge/growth.js', async importOriginal => ({ ...await importOriginal(), loadProfile: vi.fn(async () => 'A patient captain.') }));

const BOOK = 'Knowledge Tracker';
const NAME = 'Mara';
const BODY = '[Dossier] Mara | Human | captain\nRole: captain\nPersonality: Waits patiently.\nVoice: Speaks plainly.\nKnowledge Ledger:\n- Knows the harbour.';
const GROWN = BODY.replace('Waits patiently.', 'Asks for help.').replace('Speaks plainly.', 'Drops formal titles.');
let disk, host, el;
const entry = () => disk.entries[0];
const makeItem = () => createGrowthStagingItem({ name: NAME, uid: 0, entityId: 'mara', original: BODY,
    proposal: { personality: 'Asks for help.', voice: 'Drops formal titles.', changes: [
        { field: 'personality', action: 'edit', before: 'Waits patiently.', after: 'Asks for help.', evidenceIds: ['obs-1', 'deleted'] },
        { field: 'voice', action: 'edit', before: 'Speaks plainly.', after: 'Drops formal titles.', evidenceIds: ['obs-1'] },
    ] }, warnings: [{ field: 'voice', message: 'Typology vocabulary present.' }] });

function show(items) {
    state.stagingItems = items;
    state.activeItemId = items[0]?.id;
    state.activeSubTab = 'staging';
    renderNpcsSubTab();
}
async function click(selector = '#kt-accept') {
    const button = el.querySelector(selector);
    button.click();
    await vi.waitFor(() => expect(button.isConnected && button.disabled).toBe(false));
}
function edit(text) {
    const editor = el.querySelector('#kt-proposal-editor');
    editor.value = text;
    editor.dispatchEvent(new Event('input'));
}

beforeEach(() => {
    resetCoreStubs();
    _resetEpoch();
    _clearCacheForTests();
    saveSettings({ scope: 'global', apiUrl: 'https://example.test', modelName: 'test-model', dossierMode: true });
    _setCacheForTests(BOOK, { registry: { Mara: { uid: 0, entityId: 'mara', type: 'major', keywords: [NAME], growthDossier: { enabled: true } } } });
    disk = { entries: { 0: { uid: 0, comment: NAME, content: BODY, key: [NAME] } } };
    host = { worldInfoCache: new Map(), loadWorldInfo: vi.fn(async () => structuredClone(disk)),
        saveWorldInfo: vi.fn(async (_book, wi) => { disk = structuredClone(wi); }) };
    state.wiScript = host;
    installCleanupFetch(host);
    getEvidenceFile(NAME).raw.push({ id: 'obs-1', claim: 'Asks for help', category: 'trait', quote: 'Help me.', ts: 1 });
    state.notificationEntries = {};
    state._lastKtStatusMsg = '';
    el = document.createElement('div');
    document.body.append(el);
    state.npcsContentEl = el;
    state.modal = document.body;
    vi.stubGlobal('confirm', vi.fn(() => true));
});
afterEach(() => {
    resumeStore('knowledgeStore');
    _clearCacheForTests();
    state.wiScript = null;
    state.npcsContentEl = null;
    state.modal = null;
    state.stagingItems = [];
    state.notificationEntries = {};
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

test('review shows changes, warnings, live evidence and deleted evidence; dismiss writes nothing', async () => {
    show([makeItem()]);
    expect(el.querySelector('.kt-growth-review').textContent).toContain('no longer on file');
    expect(el.querySelector('.kt-growth-review').textContent).toContain('Typology vocabulary');
    expect(el.querySelector('.kt-growth-evidence-link').dataset.evidenceId).toBe('obs-1');
    await click('#kt-dismiss');
    expect(state.stagingItems).toEqual([]);
    expect(host.saveWorldInfo).not.toHaveBeenCalled();
});

test('accept writes only identity lines, preserves registry type and live keywords', async () => {
    const item = makeItem();
    show([item]);
    edit(GROWN.replace('Role: captain', 'Role: injected').replace('- Knows the harbour.', '- erased'));
    expect(el.querySelector('#kt-growth-outside-warning').textContent).toContain('will not be written');
    el.querySelector('#kt-keyword-input').value = 'injected-key';
    await click();
    expect(entry().content).toBe(GROWN);
    expect(entry().key).toEqual([NAME]);
    expect(getRegistry().Mara.type).toBe('major');
    expect(host.saveWorldInfo).toHaveBeenCalledOnce();
});

test.each(['scan', 'manual edit', 'field refresh'])('Growth stale accept after %s rebuilds both times onto fresh fields and ledger', async _kind => {
    const item = makeItem();
    show([item]);
    entry().content = BODY.replace('Role: captain', 'Role: admiral') + '\n- Learned a new route.';
    await click();
    expect(host.saveWorldInfo).not.toHaveBeenCalled();
    expect(item.mergedContent).toContain('Role: admiral');
    expect(item.staleWarning).toBeTruthy();
    await click();
    expect(entry().content).toContain('Asks for help.');
    expect(entry().content).toContain('Role: admiral');
    expect(entry().content).toContain('- Learned a new route.');
});

test.each([true, false])('stale scan field refresh respects explicit reviewer identity edit=%s across repeated changes', async reviewerEdit => {
    const proposed = BODY.replace('Role: captain', 'Role: admiral');
    const item = { id: 'scan', name: NAME, uid: 0, type: 'major', action: 'update',
        existingContent: BODY, proposedContent: proposed, mergedContent: proposed, refreshFields: ['role'], keywords: [NAME] };
    show([item]);
    if (reviewerEdit) edit(proposed.replace('Waits patiently.', 'Reviewer personality.'));
    entry().content = GROWN;
    await click();
    entry().content = GROWN.replace('Drops formal titles.', 'Uses short sentences.');
    await click();
    await click();
    expect(entry().content).toContain(reviewerEdit ? 'Reviewer personality.' : 'Asks for help.');
    expect(entry().content).toContain('Voice: Uses short sentences.');
    expect(entry().content).toContain('Role: admiral');
});

test('pending off disables acceptance; back on permits it; runtime guard also refuses off', async () => {
    const item = makeItem();
    setGrowthDossierSettings(NAME, { enabled: false });
    show([item]);
    expect(el.querySelector('#kt-accept').disabled).toBe(true);
    setGrowthDossierSettings(NAME, { enabled: true });
    show([item]);
    setGrowthDossierSettings(NAME, { enabled: false });
    await click();
    expect(host.saveWorldInfo).not.toHaveBeenCalled();
    setGrowthDossierSettings(NAME, { enabled: true });
    show([item]);
    await click();
    expect(entry().content).toBe(GROWN);
});

test('Accept All excludes Growth from confirmation and leaves it pending', async () => {
    const growth = makeItem();
    const scan = { id: 'scan', name: NAME, uid: 0, type: 'major', existingContent: BODY, proposedContent: BODY, keywords: [NAME] };
    show([growth, scan]);
    await click('#kt-batch-accept');
    expect(confirm.mock.calls[0][0]).toContain('Accept all 1 proposals?');
    expect(state.stagingItems).toEqual([growth]);
    expect(state._lastKtStatusMsg).toContain('Growth proposal(s) excluded');
});

test('scan merging never replaces pending Growth, even with reviewer edits', () => {
    const growth = makeItem();
    growth.edited = true;
    show([growth]);
    const scan = { id: 'scan', name: NAME, uid: 0, type: 'major', proposedContent: BODY };
    mergeScanResults([scan], vi.fn());
    expect(state.stagingItems).toEqual([growth, scan]);
});

test.each(['Personality: ', 'Personality: bad\nPersonality: duplicate\n', `Personality: ${'x'.repeat(1501)}`])('invalid reviewer line fails atomically: %s', line => {
    expect(() => buildGrowthReviewContent(BODY, `${line}\nVoice: Speaks plainly.`)).toThrow();
});

test.each(['scope', 'identity', 'switch'])('%s change during fresh read prevents writing', async kind => {
    const item = makeItem();
    show([item]);
    host.loadWorldInfo.mockImplementation(async () => {
        if (kind === 'scope') bumpEpoch();
        if (kind === 'identity') getRegistry().Mara.entityId = 'replacement';
        if (kind === 'switch') setGrowthDossierSettings(NAME, { enabled: false });
        return structuredClone(disk);
    });
    await click();
    expect(host.saveWorldInfo).not.toHaveBeenCalled();
    expect(state.stagingItems).toEqual([item]);
});

test('owned lines are protected even when a scan was staged before the switch was enabled', async () => {
    const proposed = BODY.replace('Waits patiently.', 'Old scan personality.').replace('Role: captain', 'Role: admiral');
    const item = { id: 'scan', name: NAME, uid: 0, type: 'major', existingContent: BODY,
        proposedContent: proposed, mergedContent: proposed, keywords: [NAME] };
    show([item]);
    await click();
    expect(entry().content).toContain('Personality: Waits patiently.');
    expect(entry().content).toContain('Role: admiral');
});

test.each(['scope', 'identity', 'uid', 'switch', 'pause', 'book', 'content', 'label', 'missing', 'internal'])('%s change during final writer read prevents Growth writing', async kind => {
    const item = makeItem();
    show([item]);
    let reads = 0;
    host.loadWorldInfo.mockImplementation(async () => {
        if (++reads === 2) {
            if (kind === 'scope') bumpEpoch();
            if (kind === 'identity') getRegistry().Mara.entityId = 'replacement';
            if (kind === 'uid') getRegistry().Mara.uid = 1;
            if (kind === 'switch') setGrowthDossierSettings(NAME, { enabled: false });
            if (kind === 'pause') pauseStore('knowledgeStore', { reasonCode: 'test', message: 'blocked' });
            if (kind === 'book') {
                setFakeContextExtras({ chatId: 'other-chat' });
                saveSettings({ scope: 'chat' });
            }
            if (kind === 'content') entry().content = BODY.replace('Role: captain', 'Role: admiral');
            if (kind === 'label') entry().comment = 'Someone else';
            if (kind === 'missing') delete disk.entries[0];
            if (kind === 'internal') entry().comment = '[MWT:growth-history]';
        }
        return structuredClone(disk);
    });
    await click();
    expect(reads).toBe(2);
    expect(host.saveWorldInfo).not.toHaveBeenCalled();
    expect(state.stagingItems).toEqual([item]);
    if (kind === 'content') {
        expect(state._lastKtStatusMsg).toMatch(/changed|review/i);
        await click(); // Refresh the diff; still no write.
        expect(host.saveWorldInfo).not.toHaveBeenCalled();
        expect(item.mergedContent).toContain('Role: admiral');
        await click();
        expect(entry().content).toBe(GROWN.replace('Role: captain', 'Role: admiral'));
    }
});

test('scope change during Growth save does not update the new registry or consume its staging item', async () => {
    const item = makeItem();
    show([item]);
    let newRegistry;
    host.saveWorldInfo.mockImplementation(async (_book, wi) => {
        disk = structuredClone(wi);
        bumpEpoch();
        _setCacheForTests(BOOK, { registry: { Mara: { uid: 0, entityId: 'new-mara', type: 'minor', keywords: ['new'], lastUpdated: 123 } } });
        newRegistry = structuredClone(getRegistry());
    });
    await click();
    expect(entry().content).toBe(GROWN);
    expect(getRegistry()).toEqual(newRegistry);
    expect(state.stagingItems).toEqual([item]);
    expect(state._lastKtStatusMsg).not.toContain('written to lorebook');
});

test.each([true, false])('re-scans retain reviewer identity edits and their baseline (recorded baseline=%s)', async recorded => {
    const proposed = BODY.replace('Role: captain', 'Role: admiral');
    const item = { id: 'scan', name: NAME, uid: 0, type: 'major', action: 'update',
        existingContent: BODY, proposedContent: proposed, mergedContent: proposed, keywords: [NAME] };
    show([item]);
    edit(proposed.replace('Waits patiently.', 'Reviewer personality.'));
    if (!recorded) delete item.reviewerBaseline;
    for (let i = 0; i < 2; i++) {
        mergeScanResults([{ ...item, id: `rescan-${i}`, proposedContent: BODY, mergedContent: BODY,
            reviewerBaseline: undefined }], vi.fn());
    }
    const retained = state.stagingItems[0];
    expect(retained.reviewerBaseline).toBe(proposed);
    show([retained]);
    entry().content = GROWN;
    await click(); // Re-review the intervening live edit.
    expect(host.saveWorldInfo).not.toHaveBeenCalled();
    await click();
    expect(entry().content).toContain('Personality: Reviewer personality.');
    expect(entry().content).toContain('Voice: Drops formal titles.');
    expect(entry().content).toContain('Role: admiral');
});

test('evidence link opens the existing evidence view and focuses its observation', async () => {
    show([makeItem()]);
    el.querySelector('.kt-growth-evidence-link').click();
    await vi.waitFor(() => expect(document.activeElement?.dataset.obsId).toBe('obs-1'));
});

test('Growth window limits round-trip and switch on card updates ownership setting', async () => {
    await openGrowthProfileModal(NAME);
    const modal = document.getElementById('kt-growth-modal');
    const estimate = modal.querySelector('.kt-growth-token-estimate').textContent;
    const input = modal.querySelector('[data-field="personality"]');
    input.value = '1400';
    input.dispatchEvent(new Event('input'));
    expect(getGrowthDossierSettings(NAME).limits.personality).toBe(1400);
    expect(modal.querySelector('.kt-growth-token-estimate').textContent).not.toBe(estimate);
    input.value = '1501';
    input.dispatchEvent(new Event('input'));
    expect(input.validationMessage).toBeTruthy();
    expect(getGrowthDossierSettings(NAME).limits.personality).toBe(1400);
    state.activeSubTab = 'major';
    renderNpcsSubTab();
    const toggle = el.querySelector('.kt-growth-dossier-enabled');
    toggle.click();
    expect(getGrowthDossierSettings(NAME).enabled).toBe(false);
});

test('explicit draft stages without writing, replaces only pending Growth and can then be approved', async () => {
    const requests = [];
    setFakeApi(request => { requests.push(request); return JSON.stringify({ personality: 'Asks for help.', voice: 'Drops formal titles.',
        changes: makeItem().changes.map(c => ({ ...c, evidenceIds: ['obs-1'] })) }); });
    await openGrowthProfileModal(NAME);
    const modal = document.getElementById('kt-growth-modal');
    const button = modal.querySelector('#kt-growth-draft');
    expect(button.disabled).toBe(false);
    button.click();
    await vi.waitFor(() => expect(state.stagingItems, modal.querySelector('.mwt-status').textContent).toHaveLength(1));
    expect(host.saveWorldInfo).not.toHaveBeenCalled();
    const firstId = state.stagingItems[0].id;
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    button.click();
    await vi.waitFor(() => expect(state.stagingItems[0].id).not.toBe(firstId));
    expect(state.stagingItems).toHaveLength(1);
    expect(requests).toHaveLength(2);
    await click();
    expect(entry().content).toBe(GROWN);
});