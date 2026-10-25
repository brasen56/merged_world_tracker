/**
 * test/chronicle_world_date.test.js — in-world dates without real-world
 * fallbacks (co-author review, 2026-10-24).
 *
 * 1. New entries (generated and manual) fell back to today's REAL date when
 *    World State had none. That label reached the narrator through the
 *    injection header and the consolidation prompt through its timeline; the
 *    `worldDate || createdAt` display fallback would have leaked a real ISO
 *    timestamp the same way.
 * 2. A generated entry was labelled from World State's current scene instead
 *    of its own Time Anchor (regenerate already used the anchor).
 * 3. The Time Anchor placeholders now mirror World State's wording, so a
 *    story with no time cues gets "Unknown" instead of an invented date.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { getFakeMeta, resetCoreStubs, setFakeApi, setFakeChat } from './stubs/core.js';
import { _resetEpoch } from '../core/scope.js';
import {
    state, saveSettings, getSnapshots, _render,
    UNKNOWN_WORLD_DATE_LABEL, entryDateDisplay, entryWorldDateLabel, establishedWorldDate, sceneWorldDate,
} from '../chronicle/data.js';
import { buildChronicleInjectionBody } from '../chronicle/injection.js';
import { CHRONICLE_SYSTEM_PROMPT, CONSOLIDATE_SYSTEM_PROMPT } from '../chronicle/prompts.js';
import { consolidateEntries, createManualEntry, generateSnapshot, regenerateSnapshot } from '../chronicle/snapshots.js';

const entryWithAnchor = (dateTime) => [
    '## Summary',
    '- The troupe crosses the river.',
    '',
    '## Time Anchor',
    `In-world date and time at end of this period: ${dateTime}`,
    'Location at end of this period: The ferry landing',
].join('\n');

const ENTRY_WITHOUT_ANCHOR = '## Summary\n- The troupe crosses the river.\n\n## Open Loops Created\n- The fare is still owed.';

const SCENE_WITH_DATE = [
    '## Current Scene',
    'Date: June 5, 2026',
    'Time: Evening',
    'Location: Harbour office',
    'Present: Mara',
    'Situation: The troupe waits for the ferry.',
].join('\n');

const SETTLED_CHAT = [
    { id: 'm0', name: 'Mara', mes: 'The troupe reaches the river.' },
    { id: 'm1', name: 'Mara', mes: 'They haggle with the ferryman.' },
    { id: 'u', name: 'User', is_user: true, mes: 'A user turn.' },
    { id: 'r', name: 'Mara', mes: 'A pending reply.' },
];

const TODAY = new Date().toLocaleDateString();

function setWorldState(text) {
    getFakeMeta().world_state_tracker_metadata = { text };
}

function seedEntries(...entries) {
    getFakeMeta().session_chronicle_data = { snapshots: entries, _deletedBin: [] };
}

let requests;

function answerWith(output) {
    setFakeApi(async (request) => { requests.push(request); return output; });
}

beforeEach(() => {
    resetCoreStubs();
    _resetEpoch();
    globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'chat-A' }) };
    globalThis.document = { dispatchEvent: vi.fn() };
    requests = [];
    saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model', syncWorldState: false });
    Object.assign(state, {
        isGenerating: false, isMainGenerating: false,
        msgSinceSnapshot: 0, autoSnapshotRetryAt: 0, selectedSnapshotId: null,
    });
    _render.renderContent = vi.fn();
    _render.showRegenerateDiff = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setFakeChat(SETTLED_CHAT);
});

afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.SillyTavern;
    delete globalThis.document;
});

describe('generated entries take their label from their own Time Anchor', () => {
    test('an established anchor wins over World State\'s current scene', async () => {
        setWorldState(SCENE_WITH_DATE);
        answerWith(entryWithAnchor('June 4, 2026 Late afternoon'));

        await generateSnapshot();

        expect(getSnapshots()[0].worldDate).toBe('June 4, 2026 Late afternoon');
    });

    test('an Unknown anchor falls back to World State\'s established scene date', async () => {
        setWorldState(SCENE_WITH_DATE);
        answerWith(entryWithAnchor('Unknown'));

        await generateSnapshot();

        expect(getSnapshots()[0].worldDate).toBe('June 5, 2026 Evening');
    });

    test('with neither established the entry is undated — never today\'s real date', async () => {
        setWorldState(SCENE_WITH_DATE.replace('June 5, 2026', 'Unknown'));
        answerWith(entryWithAnchor('Unknown'));

        await generateSnapshot();

        const [entry] = getSnapshots();
        expect(entry.worldDate).toBe('');
        expect(entry.worldDate).not.toBe(TODAY);
        expect(entry.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    test('an entry with no anchor line and no World State is undated', async () => {
        answerWith(ENTRY_WITHOUT_ANCHOR);

        await generateSnapshot();

        expect(getSnapshots()[0].worldDate).toBe('');
    });
});

describe('manual entries', () => {
    test('take World State\'s established date, or none — not today\'s', () => {
        expect(createManualEntry().worldDate).toBe('');

        setWorldState(SCENE_WITH_DATE);
        expect(createManualEntry().worldDate).toBe('June 5, 2026 Evening');
    });
});

describe('regenerate replaces the label from the new Time Anchor', () => {
    async function regenerateTo(output, oldWorldDate) {
        seedEntries({ id: 's1', text: 'Old.', createdAt: '2026-01-01T00:00:00.000Z', fromIndex: 0, toIndex: 1, worldDate: oldWorldDate });
        answerWith(output);
        let accept = null;
        _render.showRegenerateDiff = (_old, _new, onDecision) => { accept = onDecision; };
        await regenerateSnapshot('s1');
        await accept(true);
        return getSnapshots()[0].worldDate;
    }

    test('an Unknown anchor clears a stale real-world label', async () => {
        expect(await regenerateTo(entryWithAnchor('Unknown'), TODAY)).toBe('');
    });

    test('an established anchor replaces the label', async () => {
        expect(await regenerateTo(entryWithAnchor('Day 3, Evening'), TODAY)).toBe('Day 3, Evening');
    });

    test('no anchor line keeps the old label', async () => {
        expect(await regenerateTo(ENTRY_WITHOUT_ANCHOR, 'Day 2')).toBe('Day 2');
    });
});

describe('prompts never carry the recording time', () => {
    const undated = { id: 'a', text: entryWithAnchor('Unknown'), createdAt: '2026-10-24T16:36:48.000Z', worldDate: '' };
    const unknownLabel = { id: 'b', text: entryWithAnchor('Unknown'), createdAt: '2026-10-25T09:00:00.000Z', worldDate: 'Unknown' };
    const dated = { id: 'c', text: entryWithAnchor('Day 3'), createdAt: '2026-10-26T09:00:00.000Z', worldDate: 'Day 3', characters: ['Mara'] };

    test('narrator injection omits the date for an undated entry', () => {
        const body = buildChronicleInjectionBody([undated, unknownLabel, dated], [undated, unknownLabel, dated]);
        expect(body).toContain('### Chronicle Entry 1\n');
        expect(body).toContain('### Chronicle Entry 2\n');
        expect(body).toContain('### Chronicle Entry 3 — Day 3 [Mara]\n');
        expect(body).not.toMatch(/2026-10-2\dT/);
    });

    test('the consolidation timeline says the date is unknown instead of using createdAt', async () => {
        seedEntries(undated, dated);
        let prompt = null;
        _render.showConsolidationPreview = (_entries, input) => { prompt = input; };

        await consolidateEntries(['a', 'c']);

        expect(prompt).toContain(`1. a — ${UNKNOWN_WORLD_DATE_LABEL}`);
        expect(prompt).toContain('2. c — Day 3');
        expect(prompt).not.toMatch(/2026-10-2\dT/);
    });
});

describe('label helpers', () => {
    test('establishedWorldDate drops missing and Unknown values', () => {
        expect(establishedWorldDate(' Day 3 ')).toBe('Day 3');
        expect(['', '  ', 'Unknown', 'unspecified', undefined, null, 42].map(establishedWorldDate)).toEqual(['', '', '', '', '', '', '']);
    });

    test('sceneWorldDate needs an established date; the time is optional', () => {
        expect(sceneWorldDate({ date: 'Day 3', time: 'Evening' })).toBe('Day 3 Evening');
        expect(sceneWorldDate({ date: 'Day 3', time: 'Unknown' })).toBe('Day 3');
        expect(sceneWorldDate({ date: 'Unknown', time: 'Evening' })).toBe('');
        expect(sceneWorldDate(null)).toBe('');
    });

    test('panel text shows the unknown label and the recording time separately', () => {
        expect(entryWorldDateLabel({ worldDate: '' })).toBe(UNKNOWN_WORLD_DATE_LABEL);
        expect(entryDateDisplay({ worldDate: 'Day 3', createdAt: '2026-10-24T16:36:48.000Z' })).toBe('Day 3');
        expect(entryDateDisplay({ worldDate: '', createdAt: '2026-10-24T16:36:48.000Z' }))
            .toMatch(new RegExp(`^${UNKNOWN_WORLD_DATE_LABEL} · recorded .+`));
        expect(entryDateDisplay({ worldDate: 'Unknown', createdAt: 'not a date' })).toBe(UNKNOWN_WORLD_DATE_LABEL);
    });
});

describe('Time Anchor placeholders mirror World State\'s wording', () => {
    test('the snapshot prompt asks for established values, or Unknown', () => {
        expect(CHRONICLE_SYSTEM_PROMPT).toContain('In-world date and time at end of this period: [established date and exact or qualitative time, or Unknown]');
        expect(CHRONICLE_SYSTEM_PROMPT).toContain('Location at end of this period: [established location, or Unknown]');
    });

    test('the consolidation prompt keeps the timeline endpoint and allows Unknown', () => {
        expect(CONSOLIDATE_SYSTEM_PROMPT).toContain('[from the timeline endpoint: established date and exact or qualitative time, or Unknown]');
        expect(CONSOLIDATE_SYSTEM_PROMPT).toContain('[from the timeline endpoint: established location, or Unknown]');
    });
});
