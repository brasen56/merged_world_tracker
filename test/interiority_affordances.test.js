import { beforeEach, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripNonNarrative } from '../core/strip.js';
import { resetCoreStubs, setFakeChat, setFakeContextExtras, setFakeApi, getRecentMessages } from './stubs/core.js';
import { saveSettings, addLedgerEntry } from '../interiority/data.js';
import { runBatchedCall, runSplitCall, runStrictCalls, runDormantPoll, judgeIntentionEvidence } from '../interiority/generation.js';

const timestamp = '[In-story time: Day 1, 12:00]';
const affordances = '<div style="color: #eee">\n1. Ask Derek about the conduit bank path<br>\n2. Ask about the riser run<br>\n3. Wait for the ride<br>\n4. Leave the car\n</div>';
const narrative = 'Derek watches the road while Alex sits beside him.';
const receipt = '<details><summary>Off-Screen Events</summary>Mara delivered the parcel.</details>';

beforeEach(() => {
    resetCoreStubs();
    setFakeContextExtras({ name1: 'Alex', name2: 'Derek' });
    saveSettings({ apiUrl: 'https://example.test/v1', modelName: 'test' });
});

describe('Interiority affordance filtering', () => {
    test('strips the v5 preset format while preserving clock, narrative and execution receipts', () => {
        const preset = JSON.parse(readFileSync(new URL('../test_presets/test_preset_mwt_v5.json', import.meta.url), 'utf8'));
        const template = preset.prompts.find(prompt => prompt.name === 'affordances').content;
        const div = template.match(/<div\b[\s\S]*?<\/div>/)[0];
        const message = `${narrative}\n${timestamp}\n${div}\n<details><summary>Work in progress</summary>Private notes</details>\n${receipt}`;
        expect(stripNonNarrative(message, { stripAffordances: true })).toBe(`${narrative}\n${timestamp}\n\n${receipt}`);
        expect(stripNonNarrative(message)).toContain(div);
    });

    test.each(['\n', '\r\n', ' '])('supports whitespace %j and case-insensitive HTML', (separator) => {
        expect(stripNonNarrative(`${timestamp}${separator}${affordances.toUpperCase()}`, { stripAffordances: true })).toBe(timestamp);
    });

    test.each([
        `${timestamp}\n<div>A narrative graphic</div>`,
        `${timestamp}\nActual prose\n${affordances}`,
        `${timestamp}\n<details>Tracker</details>\n${affordances}`,
        `${timestamp}\n<div>1. Only one numbered narrative line</div>`,
        `${timestamp}\n${affordances.replace('</div>', '')}`,
    ])('does not remove unrelated, nonadjacent or incomplete divs', (message) => {
        expect(stripNonNarrative(message, { stripAffordances: true })).toContain('<div');
    });

    test('filters per message without mutating chat or changing default consumers', () => {
        const message = { name: 'Derek', mes: `${narrative}\n${timestamp}\n${affordances}`, extra: {} };
        const original = message.mes;
        setFakeChat([message, { name: 'Alex', is_user: true, mes: 'I watch the road.', extra: {} }]);
        const filtered = getRecentMessages({ strip: true, stripAffordances: true });
        expect(filtered).not.toContain('conduit bank');
        expect(filtered).toContain('Alex: I watch the road.');
        expect(getRecentMessages({ strip: true })).toContain('conduit bank');
        expect(message.mes).toBe(original);
        expect(judgeIntentionEvidence('Ask Derek about the conduit bank path', filtered, true)).toBe('not-found');
    });

    test('generation and dormant polling receive the filtered window', async () => {
        setFakeChat([{ name: 'Derek', mes: `${narrative}\n${timestamp}\n${affordances}\n${receipt}`, extra: {} }]);
        const calls = [];
        setFakeApi(async (request) => {
            calls.push(request);
            return JSON.stringify({ npcs: [{ name: 'Derek', reaction: null, executed: [], dropped: [], new_intentions: [] }], intentions: [] });
        });
        await runBatchedCall(['Derek']);
        await runSplitCall(['Derek'], { force: true });
        await runStrictCalls(['Derek']);
        addLedgerEntry({ npc: 'Derek', action: 'meet Mara', trigger: 'day 2', status: 'dormant', wakeHint: 'day 2' }, 'day 1', 0);
        await runDormantPoll();
        expect(calls).toHaveLength(5);
        for (const request of calls) {
            expect(request.userContent).not.toContain('conduit bank');
            expect(request.userContent).toContain('Derek watches the road');
            expect(request.userContent).toContain('In-story time:');
            expect(request.userContent).toContain('Mara delivered the parcel');
        }
    });
});