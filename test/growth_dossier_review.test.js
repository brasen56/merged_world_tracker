/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { resetCoreStubs, setFakeApi, setFakeContextExtras } from './stubs/core.js';
import { installCleanupFetch } from './stubs/cleanup-fetch.js';
import { state } from '../knowledge/state.js';
import { saveSettings } from '../knowledge/settings.js';
import { _clearCacheForTests, _setCacheForTests, flushAll, isStoreEntry } from '../knowledge/store.js';
import { getRegistry, getGrowthDossierSettings, setGrowthDossierSettings } from '../knowledge/registry.js';
import { getEvidenceFile } from '../knowledge/evidence.js';
import { renderNpcsSubTab, openGrowthProfileModal } from '../knowledge/render.js';
import { createGrowthStagingItem, buildGrowthReviewContent } from '../knowledge/growth_dossier_review.js';
import { mergeScanResults } from '../knowledge/staging.js';
import { bumpEpoch, _resetEpoch } from '../core/scope.js';
import { pauseStore, resumeStore } from '../core/schema_status.js';
import { appendGrowthApprovalToBook, readGrowthHistoryContainer, isGrowthHistoryEntry } from '../knowledge/growth_history.js';
import { getHistory } from '../knowledge/lorebook.js';
import { applyConsolidation } from '../knowledge/evidence.js';

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

test('Growth modal displays durable approvals and pre-Growth original', async () => {
    appendGrowthApprovalToBook(disk, 'mara', { approved: { personality: 'Asks for help.', voice: 'Drops formal titles.' },
        current: { personality: 'Waits patiently.', voice: 'Speaks plainly.' }, changes: makeItem().changes });
    await openGrowthProfileModal(NAME);
    await vi.waitFor(() => expect(document.querySelector('.kt-growth-approval-history')?.textContent).toContain('Dossier approval history (1/10)'));
    const history = document.querySelector('.kt-growth-approval-history');
    expect(history.textContent).toContain('Pre-Growth original');
    expect(history.textContent).toContain('Asks for help.');
});

test('review displays advisory message-time echo and timing unknown on kept sentences only', () => {
    // Personality is kept with fresh support (echo candidate); Voice is an
    // evidence-backed edit, which is a new sentence and can never echo.
    const item = createGrowthStagingItem({ name: NAME, uid: 0, entityId: 'mara', original: BODY,
        proposal: { personality: 'Waits patiently.', voice: 'Drops formal titles.', changes: [
            { field: 'personality', action: 'keep', before: 'Waits patiently.', after: 'Waits patiently.', evidenceIds: ['obs-1'] },
            { field: 'voice', action: 'edit', before: 'Speaks plainly.', after: 'Drops formal titles.', evidenceIds: ['obs-1'] },
        ] }, warnings: [] });
    item.lineage = [
        { field: 'personality', after: 'Waits patiently.', firstApprovedAt: 1000 },
        { field: 'voice', after: 'Speaks plainly.', firstApprovedAt: 1000 },
    ];
    const echoes = () => [...el.querySelectorAll('.kt-growth-echo')].map(node => node.textContent);
    getEvidenceFile(NAME).raw[0].ts = 2000;
    show([item]);
    expect(echoes()[0]).toContain('possible echo');
    expect(echoes()[1]).toBe('');
    expect(el.querySelector('#kt-accept').disabled).toBe(false);
    getEvidenceFile(NAME).raw[0].ts = null;
    show([item]);
    expect(echoes()[0]).toContain('timing unknown');
    expect(echoes()[1]).toBe('');
});

test('unsupported history refuses acceptance without writing dossier or history', async () => {
    disk.entries[9] = { uid: 9, comment: '[MWT:growth-history]', content: '{"version":99,"records":{}}' };
    const before = structuredClone(disk);
    show([makeItem()]);
    await click();
    expect(disk).toEqual(before);
    expect(host.saveWorldInfo).not.toHaveBeenCalled();
    expect(state.stagingItems).toHaveLength(1);
});

test('accept writes only identity lines, preserves registry type and live keywords', async () => {
    const localWrite = vi.spyOn(Storage.prototype, 'setItem');
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
    const history = await readGrowthHistoryContainer();
    expect(history.records.mara).toHaveLength(1);
    expect(history.records.mara[0].approved).toEqual({ personality: 'Asks for help.', voice: 'Drops formal titles.' });
    expect(history.records.mara[0].original).toEqual({ personality: 'Waits patiently.', voice: 'Speaks plainly.' });
    expect(Object.values(disk.entries).some(isGrowthHistoryEntry)).toBe(true);
    expect(localWrite).toHaveBeenCalled();
    expect(getHistory(0).some(record => record.content === BODY)).toBe(true);
    localWrite.mockRestore();
});

test.each(['switch', 'pause'])('successful Growth save is finalized after a %s during persistence', async change => {
    const save = host.saveWorldInfo;
    host.saveWorldInfo = vi.fn(async (...args) => {
        await save(...args);
        if (change === 'switch') setGrowthDossierSettings(NAME, { enabled: false });
        else pauseStore('knowledgeStore', { reasonCode: 'test', message: 'test pause' });
    });
    show([makeItem()]);
    await click();
    expect(entry().content).toBe(GROWN);
    expect(state.stagingItems).toHaveLength(0);
    expect(state._lastKtStatusMsg).not.toContain('Accept failed');
    expect((await readGrowthHistoryContainer()).records.mara).toHaveLength(1);
});

test('stale Growth review preserves a later hand edit and updates Current → Proposed changes', async () => {
    const item = makeItem();
    show([item]);
    entry().content = BODY.replace('Waits patiently.', 'A hand-edited personality.');
    await click();
    expect(host.saveWorldInfo).not.toHaveBeenCalled();
    expect(item.mergedContent).toContain('Personality: A hand-edited personality.');
    expect(item.staleWarning).toContain('Hand-edited personality');
    expect(item.changes.filter(c => c.field === 'personality')).toEqual([
        expect.objectContaining({ action: 'keep', before: 'A hand-edited personality.', after: 'A hand-edited personality.', evidenceIds: [] }),
    ]);
    await click();
    expect(entry().content).toContain('Personality: A hand-edited personality.');
    expect(entry().content).toContain('Voice: Drops formal titles.');
});

test('stale Growth review retains an explicit reviewer rewrite without attributing model evidence', async () => {
    const item = makeItem();
    show([item]);
    edit(GROWN.replace('Asks for help.', 'Reviewer choice.'));
    entry().content = BODY.replace('Waits patiently.', 'A hand-edited personality.');
    await click();
    expect(item.mergedContent).toContain('Personality: Reviewer choice.');
    expect(item.changes.filter(c => c.field === 'personality')).toEqual([
        expect.objectContaining({ action: 'edit', after: 'Reviewer choice.', evidenceIds: [] }),
        expect.objectContaining({ action: 'remove', before: 'A hand-edited personality.', evidenceIds: [] }),
    ]);
});

test('pending Growth evidence links survive raw evidence consolidation', async () => {
    const item = makeItem();
    const file = getEvidenceFile(NAME);
    applyConsolidation(NAME, [{ claim: 'Asks for help.', category: 'trait', sources: [1] }]);
    expect(file.raw).toHaveLength(0);
    show([item]);
    expect(el.querySelector('[data-evidence-id="obs-1"]')).not.toBeNull();
    expect(el.textContent).not.toContain('obs-1 — no longer on file');
    expect(el.textContent).toContain('deleted — no longer on file');
    el.querySelector('[data-evidence-id="obs-1"]').click();
    await vi.waitFor(() => expect(document.querySelector('#kt-growth-modal [data-obs-id="obs-1"]')?.textContent).toContain('Archived raw evidence'));
});

test('reviewer restores a proposed removal before accepting without recording that removal', async () => {
    const item = createGrowthStagingItem({ name: NAME, uid: 0, entityId: 'mara', original: BODY,
        proposal: { personality: '', voice: 'Speaks plainly.', changes: [
            { field: 'personality', action: 'remove', before: 'Waits patiently.', after: '', reason: 'evidence', evidenceIds: ['obs-1'] },
            { field: 'voice', action: 'keep', before: 'Speaks plainly.', after: 'Speaks plainly.', evidenceIds: [] },
        ] }, warnings: [] });
    show([item]);
    edit(BODY);
    await click();
    expect(entry().content).toBe(BODY);
    expect(host.saveWorldInfo).toHaveBeenCalledOnce();
    const record = (await readGrowthHistoryContainer()).records.mara[0];
    expect(record.approved.personality).toBe('Waits patiently.');
    expect(record.changes.some(c => c.action === 'remove')).toBe(false);
    expect(record.changes.find(c => c.field === 'personality')).toMatchObject({
        after: 'Waits patiently.', evidenceIds: [], sourceLabel: 'hand edit, no evidence',
    });
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

test('turning Growth off during a pending acceptance remains persistable', async () => {
    show([makeItem()]);
    let release;
    host.saveWorldInfo.mockImplementationOnce(async (_book, wi) => {
        const snapshot = structuredClone(wi);
        await new Promise(resolve => { release = resolve; });
        disk = snapshot;
    });
    const accepting = click();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    setGrowthDossierSettings(NAME, { enabled: false });
    release();
    await accepting;
    await flushAll();
    expect(getGrowthDossierSettings(NAME).enabled).toBe(false);
    const store = Object.values(disk.entries).find(isStoreEntry);
    expect(JSON.parse(store.content).registry.Mara.growthDossier.enabled).toBe(false);
});

test.each(['personality', 'voice'])('an already absent %s field can stay empty through staging and acceptance', async field => {
    const label = field === 'voice' ? 'Voice' : 'Personality';
    const original = BODY.replace(new RegExp(`^${label}:[^\\n]*\\n`, 'm'), '');
    entry().content = original;
    const item = createGrowthStagingItem({ name: NAME, uid: 0, entityId: 'mara', original,
        proposal: { personality: 'Asks for help.', voice: 'Drops formal titles.', [field]: '', changes: [] } });
    show([item]);
    await click();
    expect(state.stagingItems).toEqual([]);
    expect(entry().content).not.toContain(`${label}:`);
    expect((await readGrowthHistoryContainer()).records.mara[0].approved[field]).toBe('');
});

test('Growth with Dossier Mode off preserves a compact header through staging and acceptance', async () => {
    saveSettings({ dossierMode: false });
    const original = BODY.replace('[Dossier] ', '');
    entry().content = original;
    const item = createGrowthStagingItem({ name: NAME, uid: 0, entityId: 'mara', original,
        proposal: { personality: 'Asks for help.', voice: 'Drops formal titles.', changes: [] } });
    expect(item.proposedContent).toBe(GROWN.replace('[Dossier] ', ''));
    show([item]);
    await click();
    expect(entry().content).toBe(GROWN.replace('[Dossier] ', ''));
    expect(state.stagingItems).toEqual([]);
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
    const limits = modal.querySelectorAll('.kt-growth-dossier-limit');
    expect(limits).toHaveLength(2);
    for (const limit of limits) {
        expect(limit.classList.contains('mwt-input')).toBe(true);
        expect(limit.type).toBe('number');
        expect(modal.querySelector(`label[for="${limit.id}"]`)).not.toBeNull();
    }
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