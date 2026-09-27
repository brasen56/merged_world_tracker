/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import chronicleCss from '../chronicle/style.css?raw';
import { resetCoreStubs, getFakeMeta, setFakeChat, setFakeApi } from './stubs/core.js';
import { applyExpiry } from '../world_state/provenance.js';
import { extractOnlySection, replaceSection, removeSection } from '../world_state/data.js';
import { applyDeltaPatch } from '../world_state/delta.js';
import { parseWorldStateSections } from '../core/world_state_document.js';
import { state, getSnapshots, saveSettings, getChronicleData, MAX_TRASH_SIZE, _render } from '../chronicle/data.js';
import { renderContent } from '../chronicle/render.js';
import { regenerateSnapshot, deleteEntry, bulkDeleteEntries } from '../chronicle/snapshots.js';

function entry(id, extra = {}) {
    return { id, createdAt: '2026-01-01T00:00:00.000Z', text: `## Summary\n${id}`,
        fromIndex: 0, toIndex: 0, ...extra };
}

beforeEach(() => {
    resetCoreStubs();
    globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'tier2-chat' }) };
    state.contentEl = document.createElement('div');
    document.body.append(state.contentEl);
    state.selectedSnapshotId = null;
    state.checkedForMerge.clear();
    state.consolidateBaseId = null;
    state.pendingSearch = '';
    state.consolidateMode = false;
    state.bulkDeleteMode = false;
    _render.renderContent = renderContent;
});
afterEach(() => { document.body.innerHTML = ''; state.contentEl = null; _render.renderContent = null; delete globalThis.SillyTavern; vi.restoreAllMocks(); });

describe('Tier 2 Chronicle contracts', () => {
    test('empty view offers generate, import and trash even after the last entry is deleted', () => {
        getFakeMeta().session_chronicle_data = { snapshots: [], _deletedBin: [entry('removed')] };
        renderContent();
        for (const id of ['sc-generate-btn', 'sc-import-btn', 'sc-trash-btn']) {
            expect(state.contentEl.querySelector(`#${id}`)).toBeTruthy();
        }
        expect(state.contentEl.querySelector('#sc-trash-btn').textContent).toContain('1');
    });

    test('undo refuses to drop the merged entry if even one original was evicted', () => {
        const merged = entry('merged', { _consolidatedFrom: ['a', 'b'] });
        getFakeMeta().session_chronicle_data = { snapshots: [merged], _deletedBin: [entry('a')] };
        state.selectedSnapshotId = 'merged';
        renderContent();
        state.contentEl.querySelector('#sc-undo-consolidate').click();
        state.contentEl.querySelector('.sc-confirm-yes').click();
        expect(getSnapshots().map(s => s.id)).toEqual(['merged']);
        expect(getChronicleData()._deletedBin.map(s => s.id)).toEqual(['a']);
    });

    test('undo restores every original when all are present, even a batch over 50', () => {
        const originals = Array.from({ length: 51 }, (_, i) => entry(`s${i}`));
        getFakeMeta().session_chronicle_data = { snapshots: [entry('merged', { _consolidatedFrom: originals.map(s => s.id) })], _deletedBin: originals };
        state.selectedSnapshotId = 'merged';
        renderContent();
        state.contentEl.querySelector('#sc-undo-consolidate').click();
        state.contentEl.querySelector('.sc-confirm-yes').click();
        expect(getSnapshots()).toHaveLength(51);
        expect(getChronicleData()._deletedBin).toHaveLength(0);
    });

    test.each(['single', 'bulk'])('%s deletion preserves a large consolidation undo and caps unprotected trash', operation => {
        const originals = Array.from({ length: 51 }, (_, i) => entry(`s${i}`));
        const merged = entry('merged', { _consolidatedFrom: originals.map(s => s.id) });
        const other = entry('other');
        getFakeMeta().session_chronicle_data = { snapshots: [merged, other], _deletedBin: originals };
        if (operation === 'single') deleteEntry('other');
        else bulkDeleteEntries(['other']);
        expect(getChronicleData()._deletedBin.map(s => s.id)).toEqual(originals.map(s => s.id));
        state.selectedSnapshotId = 'merged';
        renderContent();
        state.contentEl.querySelector('#sc-undo-consolidate').click();
        state.contentEl.querySelector('.sc-confirm-yes').click();
        expect(getSnapshots().map(s => s.id)).toEqual(originals.map(s => s.id));
        expect(getChronicleData()._deletedBin).toEqual([]);
    });

    test('ordinary trash is still capped when no live consolidation references it', () => {
        const oldTrash = Array.from({ length: MAX_TRASH_SIZE }, (_, i) => entry(`t${i}`));
        getFakeMeta().session_chronicle_data = { snapshots: [entry('other')], _deletedBin: oldTrash };
        deleteEntry('other');
        expect(getChronicleData()._deletedBin).toHaveLength(MAX_TRASH_SIZE);
        expect(getChronicleData()._deletedBin[0].id).toBe('t1');
    });

    test('deletion preserves nested consolidation sources and the newest ordinary trash', () => {
        const nested = entry('nested', { _consolidatedFrom: ['inner-a', 'inner-b'] });
        const outer = entry('outer', { _consolidatedFrom: ['nested'] });
        const oldTrash = Array.from({ length: MAX_TRASH_SIZE }, (_, i) => entry(`t${i}`));
        getFakeMeta().session_chronicle_data = {
            snapshots: [outer, entry('other')],
            _deletedBin: [entry('inner-a'), entry('inner-b'), nested, ...oldTrash],
        };
        deleteEntry('other');
        const ids = getChronicleData()._deletedBin.map(item => item.id);
        expect(ids).toEqual(['inner-a', 'inner-b', 'nested', ...oldTrash.slice(4).map(item => item.id), 'other']);
    });

    test('clear all resets the old anchor, stale marker and injection selection', () => {
        getFakeMeta().session_chronicle_data = { snapshots: [entry('a')], lastAnchor: { id: 'old' },
            anchorStale: true, injectMode: 'range', injectFromDate: '2026-01-01', injectToDate: '2026-02-01', selectedForInjection: ['a'] };
        state.checkedForMerge.add('a');
        renderContent();
        state.contentEl.querySelector('#sc-reset-btn').click();
        state.contentEl.querySelector('.sc-confirm-yes').click();
        expect(getChronicleData()).toMatchObject({ snapshots: [], lastAnchor: null, anchorStale: false,
            injectFromDate: '', injectToDate: '', selectedForInjection: [] });
        expect(state.checkedForMerge.size).toBe(0);
    });

    test('regenerate keeps a single-message range instead of widening to later messages', async () => {
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        setFakeChat([{ id: 'first', mes: 'First marker' }, { id: 'later', mes: 'Later marker' },
            { id: 'user', is_user: true, mes: 'User' }, { id: 'reply', mes: 'Reply' }]);
        getFakeMeta().session_chronicle_data = { snapshots: [entry('a')] };
        const requests = [];
        setFakeApi(async request => { requests.push(request); return '## Summary\nRegenerated'; });
        await regenerateSnapshot('a');
        expect(requests).toHaveLength(1);
        expect(requests[0].userContent).toContain('First marker');
        expect(requests[0].userContent).not.toContain('Later marker');
    });

    test('datetime input rules are scoped to Chronicle', () => {
        expect(chronicleCss).not.toMatch(/(^|\n)input\[type="datetime-local"\]/);
    });
});

describe('Tier 2 World State document and expiry contracts', () => {
    test('section helpers use exactly the level-two names and boundaries used by injection', () => {
        const text = '## Pending Threads\nNot the Pending section\n## Pending\nKeep this\n# Subheading stays in body\nSubtext\n## Recent Changes\nNext';
        expect(parseWorldStateSections(text).sections.map(s => s.name)).toEqual(['Pending Threads', 'Pending', 'Recent Changes']);
        expect(extractOnlySection(text, 'Pending')).toContain('Subtext');
        expect(extractOnlySection('## Pending Threads\nOnly this', 'Pending')).toBeNull();
        expect(replaceSection(text, 'Pending', '## Pending\nReplacement')).toContain('## Pending Threads\nNot the Pending section');
        expect(removeSection(text, 'Pending')).toContain('## Pending Threads\nNot the Pending section');
        expect(removeSection(text, 'Pending')).toContain('## Recent Changes\nNext');
        const patched = applyDeltaPatch('## Current Scene\nHere\n## Pending Threads\nLeave intact',
            [{ type: 'update', section: 'Pending', body: '## Pending\nAdded' }]);
        expect(patched.ok).toBe(true);
        expect(patched.text).toContain('## Pending Threads\nLeave intact');
    });

    test.each(['remove', 'quarantine'])('%s expiry removes subfields with the stale parent', mode => {
        const text = '## Off-Screen\n**Mara**: old\n  - Mood: cautious\n**Jonah**: current\n  - Mood: happy';
        const result = applyExpiry(text, { entities: { mara: { lastTouchedMsg: 1 }, jonah: { lastTouchedMsg: 10 } } },
            { sections: ['Off-Screen'], staleAfterMsgs: 2, currentMsgIndex: 10, mode });
        expect(extractOnlySection(result.text, 'Off-Screen')).not.toContain('cautious');
        expect(extractOnlySection(result.text, 'Off-Screen')).toContain('happy');
        if (mode === 'quarantine') expect(extractOnlySection(result.text, 'Archive (Stale)')).toContain('Mood: cautious');
    });
});