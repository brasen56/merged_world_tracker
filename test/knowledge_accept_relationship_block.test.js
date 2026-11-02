/** @vitest-environment jsdom */
/**
 * test/knowledge_accept_relationship_block.test.js — accepting a proposal must
 * not take the managed relationship block off the lorebook entry.
 *
 * runNpcUpdate, runNpcEnrich and runDossierFieldRefresh strip the block before
 * merging, so the model never sees it, and the stripped text is what gets
 * staged. Accepting that text replaced the whole entry, and nothing put the
 * block back until the next relationship sync. Auto-sync only touches NPCs
 * whose relationships just changed, so `Stance toward {{user}}:` (which presets
 * match on) could stay missing for a long time.
 *
 * Drives the real card buttons, staging panel and Accept handler under jsdom,
 * against a fake world-info module and the real relationship store.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { resetCoreStubs, setFakeApi, setFakeChat } from './stubs/core.js';
import { installCleanupFetch } from './stubs/cleanup-fetch.js';
import { RELATIONSHIP_BLOCK_END, RELATIONSHIP_BLOCK_START, state } from '../knowledge/state.js';
import { saveSettings } from '../knowledge/settings.js';
import { _clearCacheForTests, _setCacheForTests } from '../knowledge/store.js';
import { buildStagingItems, mergeScanResults } from '../knowledge/staging.js';
import { enrichStagingItem, getHistory } from '../knowledge/lorebook.js';
import {
    formatRelationshipBlock, injectRelationshipBlock, removeRelationship, setStance,
    stripRelationshipBlock, syncRelationshipsToLorebook, updateRelationship,
} from '../knowledge/relationships.js';
import { releaseManagedInert } from '../core/modal.js';

const runScanMock = vi.fn();

// Only the unattended scan test swaps this out; every other test here drives
// the real per-NPC run* functions.
vi.mock('../knowledge/lorebook.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, runScan: (...args) => runScanMock(...args) };
});

const { renderNpcsSubTab } = await import('../knowledge/render.js');
const { scanAndAccept } = await import('../knowledge/index.js');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BOOK = 'Knowledge Tracker';
const NPC = 'Mara Voss';
const UID = 7;

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

const MINOR = [
    'Mara Voss | Human | harbourmaster',
    'Tone: brisk',
    'Perceived as: unflappable',
    'First seen: the quay',
].join('\n');

const FACT = { fact: 'Learned the smugglers use the north wharf', source: 'told', date: 'Day 5' };

const SCAN_UPDATE = {
    dossierMode: true, new_minor: [], new_major: [], update_minor: [],
    update_major: [{ name: NPC, fields: { tone: 'wry' }, new_knowledge: [] }],
};

function makeFakeWorldInfo() {
    const books = new Map();
    return {
        books,
        async loadWorldInfo(name) { return books.has(name) ? structuredClone(books.get(name)) : null; },
        async saveWorldInfo(name, wi, immediately = false) { if (immediately) books.set(name, structuredClone(wi)); },
        async createNewWorldInfo(name) { books.set(name, { entries: {} }); return true; },
    };
}

// ─── Harness ─────────────────────────────────────────────────────────────────

let wiFake;
let contentEl;

function seedEntry(content, { type = 'major', aliases } = {}) {
    _setCacheForTests(BOOK, {
        registry: { [NPC]: { uid: UID, type, keywords: [NPC], ...(aliases ? { aliases } : {}) } },
    });
    wiFake.books.set(BOOK, {
        entries: { [UID]: { uid: UID, comment: NPC, key: [NPC], content } },
    });
}

/** Entry text the way a relationship sync leaves it, for the current graph. */
function withCurrentBlock(body) {
    return injectRelationshipBlock(body, formatRelationshipBlock(NPC));
}

function seedGraph() {
    setStance(NPC, 'wary');
    updateRelationship(NPC, 'Tam', 'ally', '');
}

const entryContent = () => wiFake.books.get(BOOK).entries[UID].content;
const blockCount = content => content.split(RELATIONSHIP_BLOCK_START).length - 1;

function openTab(sub) {
    state.activeSubTab = sub;
    renderNpcsSubTab();
}

async function waitForStagedItem() {
    await vi.waitFor(() => expect(state.stagingItems).toHaveLength(1));
    return state.stagingItems[0];
}

/** Each flow clicks the real card control and leaves one proposal staged. */
const PROPOSAL_FLOWS = {
    Update: async (tab = 'major') => {
        setFakeApi(() => JSON.stringify({ fields: { tone: 'clipped' }, new_knowledge: tab === 'major' ? [FACT] : [] }));
        openTab(tab);
        contentEl.querySelector('.kt-npc-update').click();
        return waitForStagedItem();
    },
    Enrich: async () => {
        setFakeApi(() => JSON.stringify({ fields: { agenda: 'Find her brother' }, new_knowledge: [FACT] }));
        openTab('major');
        contentEl.querySelector('.kt-npc-enrich').click();
        return waitForStagedItem();
    },
    Fields: async () => {
        setFakeApi(() => JSON.stringify({ fields: { agenda: 'Find her brother' } }));
        openTab('major');
        contentEl.querySelector('.kt-npc-fields').click();
        await vi.waitFor(() => expect(document.querySelector('.kt-dfr-run')).not.toBeNull());
        const field = document.querySelector('.kt-dfr-field[data-key="agenda"]');
        field.checked = true;
        field.dispatchEvent(new Event('change'));
        document.querySelector('.kt-dfr-run').click();
        return waitForStagedItem();
    },
};

async function clickAccept() {
    const pending = state.stagingItems.length;
    contentEl.querySelector('#kt-accept').click();
    await vi.waitFor(() => expect(state.stagingItems).toHaveLength(pending - 1));
}

beforeEach(() => {
    resetCoreStubs();
    _clearCacheForTests();
    saveSettings({ scope: 'global', dossierMode: true, connectionProfileId: 'test-profile' });
    wiFake = makeFakeWorldInfo();
    state.wiScript = wiFake;
    installCleanupFetch(wiFake);
    state.stagingItems = [];
    state.activeItemId = null;
    state.notificationEntries = {};
    localStorage.clear();
    runScanMock.mockReset();

    // 6 messages: the stub keeps the trailing 2 out of "stable" history.
    setFakeChat([
        { is_user: true, mes: 'The harbour bells ring at dusk.' },
        { is_user: false, mes: 'Mara Voss studies the cargo manifest with narrowed eyes.' },
        { is_user: true, mes: 'Mara slams the ledger shut.' },
        { is_user: false, mes: 'Mara posts extra watchers at the quay gates after dusk.' },
        { is_user: true, mes: 'We leave before dawn.' },
        { is_user: false, mes: 'The watchers take their positions silently.' },
    ]);

    contentEl = document.createElement('div');
    document.body.append(contentEl);
    state.npcsContentEl = contentEl;
    state.modal = document.body;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    _clearCacheForTests();
    document.body.innerHTML = '';
    releaseManagedInert();
    state.modal = null;
    state.npcsContentEl = null;
    state.wiScript = null;
    state.stagingItems = [];
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

// ─── The reported bug ────────────────────────────────────────────────────────

describe('accepting a per-NPC proposal keeps the relationship block', () => {
    test.each([
        ['Update on a dossier', 'Update', DOSSIER, 'major', 'major'],
        ['Update on a minor', 'Update', MINOR, 'minor', 'minor'],
        ['Enrich', 'Enrich', DOSSIER, 'major', undefined],
        ['Fields', 'Fields', DOSSIER, 'major', undefined],
    ])('%s', async (_label, flow, body, type, tab) => {
        seedEntry(body, { type });
        seedGraph();
        const raw = withCurrentBlock(body);
        wiFake.books.get(BOOK).entries[UID].content = raw;

        const item = await PROPOSAL_FLOWS[flow](tab);
        expect(item.mergedContent).not.toContain(RELATIONSHIP_BLOCK_START);

        await clickAccept();

        const written = entryContent();
        expect(written).toBe(withCurrentBlock(item.mergedContent));
        expect(written).toContain('Stance toward {{user}}: wary.');
        expect(written).toContain('Relationships: ally of Tam.');
        expect(blockCount(written)).toBe(1);
    });

    test('an accept records one history entry, and a later sync has nothing to do', async () => {
        // The sync's scope guard fails closed without a resolvable chat id.
        vi.stubGlobal('SillyTavern', { getContext: () => ({ getCurrentChatId: () => 'chat-accept' }) });
        seedEntry(DOSSIER);
        seedGraph();
        const raw = withCurrentBlock(DOSSIER);
        wiFake.books.get(BOOK).entries[UID].content = raw;

        await PROPOSAL_FLOWS.Update();
        await clickAccept();

        expect(getHistory(UID, BOOK).map(record => record.content)).toEqual([raw]);
        await expect(syncRelationshipsToLorebook(NPC)).resolves.toEqual({ success: true, unchanged: true });
        expect(getHistory(UID, BOOK)).toHaveLength(1);
    });

    test('Accept All keeps it too', async () => {
        vi.stubGlobal('confirm', () => true);
        seedEntry(DOSSIER);
        seedGraph();
        wiFake.books.get(BOOK).entries[UID].content = withCurrentBlock(DOSSIER);

        await PROPOSAL_FLOWS.Update();
        contentEl.querySelector('#kt-batch-accept').click();
        await vi.waitFor(() => expect(state.stagingItems).toHaveLength(0));

        expect(blockCount(entryContent())).toBe(1);
        expect(entryContent()).toContain('Stance toward {{user}}: wary.');
    });
});

describe('the block written on accept comes from the graph', () => {
    test('a stance changed while the proposal waited wins over the entry', async () => {
        seedEntry(DOSSIER);
        seedGraph();
        wiFake.books.get(BOOK).entries[UID].content = withCurrentBlock(DOSSIER);

        await PROPOSAL_FLOWS.Update();
        setStance(NPC, 'hostile');
        await clickAccept();

        expect(entryContent()).toContain('Stance toward {{user}}: hostile.');
        expect(entryContent()).not.toContain('Stance toward {{user}}: wary.');
        expect(blockCount(entryContent())).toBe(1);
    });

    test('an empty graph leaves the entry with no block', async () => {
        seedEntry(DOSSIER);
        seedGraph();
        wiFake.books.get(BOOK).entries[UID].content = withCurrentBlock(DOSSIER);

        const item = await PROPOSAL_FLOWS.Update();
        setStance(NPC, '');
        removeRelationship(NPC, 'Tam');
        await clickAccept();

        expect(entryContent()).toBe(item.mergedContent);
        expect(entryContent()).not.toContain(RELATIONSHIP_BLOCK_START);
        expect(entryContent()).not.toContain(RELATIONSHIP_BLOCK_END);
    });

    test('an NPC with no relationships gets no empty markers', async () => {
        seedEntry(DOSSIER);

        const item = await PROPOSAL_FLOWS.Update();
        await clickAccept();

        expect(entryContent()).toBe(item.mergedContent);
    });

    test('a proposal staged under an alias finds the canonical graph entry', async () => {
        seedEntry(DOSSIER, { aliases: ['The Vixen'] });
        seedGraph();
        wiFake.books.get(BOOK).entries[UID].content = withCurrentBlock(DOSSIER);
        state.stagingItems = [{
            id: 'alias-item', type: 'major', action: 'update', name: 'The Vixen', data: {},
            proposedContent: DOSSIER, existingContent: DOSSIER, mergedContent: DOSSIER,
            keywords: [NPC], uid: UID,
        }];
        state.activeItemId = 'alias-item';
        openTab('staging');

        await clickAccept();

        expect(entryContent()).toContain('Stance toward {{user}}: wary.');
    });
});

// ─── Scan proposals merge onto the raw entry ─────────────────────────────────

describe('scan proposals keep the block', () => {
    test('accepted from the staging panel', async () => {
        seedEntry(DOSSIER);
        seedGraph();
        const raw = withCurrentBlock(DOSSIER);
        wiFake.books.get(BOOK).entries[UID].content = raw;

        const [item] = mergeScanResults(buildStagingItems(SCAN_UPDATE), () => {});
        await enrichStagingItem(item);
        state.activeItemId = item.id;
        openTab('staging');
        expect(item.mergedContent).toContain(RELATIONSHIP_BLOCK_START);

        await clickAccept();

        expect(entryContent()).toContain('Tone: wry');
        expect(entryContent()).toContain('Stance toward {{user}}: wary.');
        expect(blockCount(entryContent())).toBe(1);
        expect(getHistory(UID, BOOK).map(record => record.content)).toEqual([raw]);
    });

    test('accepted unattended by scanAndAccept', async () => {
        seedEntry(DOSSIER);
        seedGraph();
        wiFake.books.get(BOOK).entries[UID].content = withCurrentBlock(DOSSIER);
        runScanMock.mockResolvedValue(SCAN_UPDATE);

        const [item] = await scanAndAccept();

        expect(item.accepted).toBe(true);
        expect(entryContent()).toContain('Tone: wry');
        expect(entryContent()).toContain('Stance toward {{user}}: wary.');
        expect(blockCount(entryContent())).toBe(1);
    });

    test('a block that went stale while the proposal waited is replaced', async () => {
        seedEntry(DOSSIER);
        seedGraph();
        wiFake.books.get(BOOK).entries[UID].content = withCurrentBlock(DOSSIER);

        const [item] = mergeScanResults(buildStagingItems(SCAN_UPDATE), () => {});
        await enrichStagingItem(item);
        state.activeItemId = item.id;
        openTab('staging');
        setStance(NPC, 'hostile');

        await clickAccept();

        expect(entryContent()).toContain('Stance toward {{user}}: hostile.');
        expect(entryContent()).not.toContain('Stance toward {{user}}: wary.');
        expect(blockCount(entryContent())).toBe(1);
    });

    test('a block the graph has since emptied is removed', async () => {
        seedEntry(DOSSIER);
        seedGraph();
        wiFake.books.get(BOOK).entries[UID].content = withCurrentBlock(DOSSIER);

        const [item] = mergeScanResults(buildStagingItems(SCAN_UPDATE), () => {});
        await enrichStagingItem(item);
        state.activeItemId = item.id;
        openTab('staging');
        expect(item.mergedContent).toContain(RELATIONSHIP_BLOCK_START);
        setStance(NPC, '');
        removeRelationship(NPC, 'Tam');

        await clickAccept();

        expect(entryContent()).toContain('Tone: wry');
        expect(entryContent()).not.toContain(RELATIONSHIP_BLOCK_START);
        expect(entryContent()).not.toContain(RELATIONSHIP_BLOCK_END);
    });
});

// ─── The proposal diff ───────────────────────────────────────────────────────

describe('the proposal diff never shows the block as removed', () => {
    const diffText = () => contentEl.querySelector('.kt-detail-diff')?.textContent ?? '';

    test.each(['Update', 'Enrich', 'Fields'])('%s', async (flow) => {
        seedEntry(DOSSIER);
        seedGraph();
        wiFake.books.get(BOOK).entries[UID].content = withCurrentBlock(DOSSIER);

        await PROPOSAL_FLOWS[flow]();

        expect(diffText()).not.toBe('');
        expect(diffText()).not.toContain('mwt:relationships');
        expect(diffText()).not.toContain('Stance toward');
    });

    test('a restored per-NPC proposal over a scan baseline', async () => {
        // The one path where stripped text meets a raw baseline: a re-scan
        // supersedes a per-NPC proposal, and Restore brings its text back.
        seedEntry(DOSSIER);
        seedGraph();
        wiFake.books.get(BOOK).entries[UID].content = withCurrentBlock(DOSSIER);

        const perNpc = await PROPOSAL_FLOWS.Update();
        const stripped = perNpc.mergedContent;
        const [item] = mergeScanResults(buildStagingItems(SCAN_UPDATE), () => {});
        await enrichStagingItem(item);
        state.activeItemId = item.id;
        openTab('staging');
        contentEl.querySelector('.kt-superseded-restore').click();

        expect(item.mergedContent).toBe(stripped);
        expect(stripRelationshipBlock(item.existingContent)).not.toBe(item.existingContent);
        expect(diffText()).not.toBe('');
        expect(diffText()).not.toContain('mwt:relationships');
        expect(diffText()).not.toContain('Stance toward');

        await clickAccept();
        expect(entryContent()).toBe(withCurrentBlock(stripped));
    });

    test('a proposal that differs only by the block shows no diff at all', async () => {
        seedEntry(DOSSIER);
        seedGraph();
        const raw = withCurrentBlock(DOSSIER);
        wiFake.books.get(BOOK).entries[UID].content = raw;
        state.stagingItems = [{
            id: 'block-only', type: 'major', action: 'update', name: NPC, data: {}, edited: true,
            proposedContent: DOSSIER, existingContent: raw, mergedContent: DOSSIER,
            keywords: [NPC], uid: UID,
        }];
        state.activeItemId = 'block-only';
        openTab('staging');

        expect(contentEl.querySelector('.kt-detail-diff')).toBeNull();
    });
});
