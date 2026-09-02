/**
 * recentHistoryExclude — tracker scans use one shared stable-history cutoff.
 *
 * When a tracker refresh (world state, knowledge, story planner, relationships,
 * chronicle, growth) builds its "recent messages" window, the final user +
 * assistant pair is still in flight: the user may swipe, edit, or discard it.
 * Feeding those messages into a scan makes the tracker stale or misrepresent the
 * current scene. These tests pin the shared exclusion behaviour.
 *
 * IMPORTANT: every feature module under test imports the barrel (`../core/index.js`),
 * which vitest aliases to `test/stubs/core.js` — and the stub re-implements the
 * slice logic. So a test that goes through the barrel only pins the STUB, not
 * the production `core/context.js`. The first describe block below imports the
 * REAL module directly (no alias applies to `../core/context.js`) to close that
 * gap, exactly like the relationship tests do for chat ids.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';

import {
    resetCoreStubs,
    setFakeChat,
    setFakeContextExtras,
} from './stubs/core.js';
import {
    getRecentMessages as realGetRecentMessages,
    getRecentHistoryExclude,
    getStableHistoryEnd,
} from '../core/context.js';

const FULL_CHAT = [
    { id: 'm0', name: 'User', is_user: true, mes: 'old user 1' },
    { id: 'm1', name: 'Mara', mes: 'old ai 1' },
    { id: 'm2', name: 'User', is_user: true, mes: 'old user 2' },
    { id: 'm3', name: 'Mara', mes: 'old ai 2' },
    { id: 'm4', name: 'User', is_user: true, mes: 'LATEST USER' },
    { id: 'm5', name: 'Mara', mes: 'LATEST AI' },
];
const TWO_MESSAGE_CHAT = [
    { id: 't0', name: 'User', is_user: true, mes: 'only user' },
    { id: 't1', name: 'Mara', mes: 'only ai' },
];

describe('recentHistoryExclude — shared setting and clamp', () => {
    afterEach(() => { delete globalThis.SillyTavern; });

    test('defaults to two messages (usually the latest user/assistant exchange)', () => {
        globalThis.SillyTavern = { getContext: () => ({ extensionSettings: {} }) };
        expect(getRecentHistoryExclude()).toBe(2);
    });

    test.each([
        [-4, 0], [0, 0], [2.4, 2], [2.5, 3], [10, 10], [42, 10], ['invalid', 2],
    ])('clamps %j to %j', (input, expected) => {
        globalThis.SillyTavern = {
            getContext: () => ({ extensionSettings: { merged_world_tracker: { recentHistoryExclude: input } } }),
        };
        expect(getRecentHistoryExclude()).toBe(expected);
    });
});

describe('core/context.js getRecentMessages — REAL implementation (no stub)', () => {
    afterEach(() => { delete globalThis.SillyTavern; });

    function stubContext(chat, recentHistoryExclude = 2) {
        globalThis.SillyTavern = {
            getContext: () => ({ chat, extensionSettings: { merged_world_tracker: { recentHistoryExclude } } }),
        };
    }

    test('getStableHistoryEnd excludes the trailing pair at the default setting', () => {
        stubContext(FULL_CHAT);
        expect(getStableHistoryEnd(FULL_CHAT)).toBe(4);
        const text = realGetRecentMessages({ maxMessages: 50, excludeLast: getRecentHistoryExclude() });
        expect(text).toContain('old ai 2');
        expect(text).not.toContain('LATEST USER');
        expect(text).not.toContain('LATEST AI');
    });

    test('keeps the tail by default (excludeLast = 0)', () => {
        stubContext(FULL_CHAT);
        const text = realGetRecentMessages({ maxMessages: 50 });
        expect(text).toContain('LATEST AI');
    });

    test('returns an empty scan when the whole chat is the tail', () => {
        stubContext(TWO_MESSAGE_CHAT);
        const text = realGetRecentMessages({ maxMessages: 50, excludeLast: getRecentHistoryExclude() });
        expect(text).toBe('');
    });

    test('slides the window back rather than shrinking it (maxMessages preserved)', () => {
        stubContext(FULL_CHAT);
        const text = realGetRecentMessages({ maxMessages: 3, excludeLast: getRecentHistoryExclude() });
        const lines = text.split('\n');
        expect(lines).toHaveLength(3);
        expect(lines[0]).toBe('Mara: old ai 1');
        expect(lines[2]).toBe('Mara: old ai 2');
        expect(text).not.toContain('LATEST');
    });
});

describe('world_state getRecentMessagesForScan', () => {
    beforeEach(() => resetCoreStubs());

    test('ignores the in-flight pair', async () => {
        setFakeChat(FULL_CHAT);
        const { saveSettings } = await import('../world_state/settings.js');
        saveSettings({ maxScanMessages: 20, messageFilter: '' });
        const { getRecentMessagesForScan } = await import('../world_state/refresh.js');
        const text = getRecentMessagesForScan();
        expect(text).toContain('old ai 2');
        expect(text).not.toContain('LATEST USER');
        expect(text).not.toContain('LATEST AI');
    });

    test('returns empty for a two-message chat', async () => {
        setFakeChat(TWO_MESSAGE_CHAT);
        const { saveSettings } = await import('../world_state/settings.js');
        saveSettings({ maxScanMessages: 20, messageFilter: '' });
        const { getRecentMessagesForScan } = await import('../world_state/refresh.js');
        expect(getRecentMessagesForScan()).toBe('');
    });
});

describe('global stable-history setting — shared tracker cutoff', () => {
    beforeEach(() => {
        resetCoreStubs();
        // This is the test barrel's equivalent of extensionSettings
        // .merged_world_tracker.recentHistoryExclude in production.
        setFakeContextExtras({ globalSettings: { recentHistoryExclude: 3 } });
        setFakeChat(FULL_CHAT);
    });

    test('changes World State, Knowledge, Story Planner, and Growth together', async () => {
        const { saveSettings: saveWorldSettings } = await import('../world_state/settings.js');
        const { getRecentMessagesForScan } = await import('../world_state/refresh.js');
        const { getRecentMessages: getKnowledgeRecentMessages } = await import('../knowledge/lorebook.js');
        const { getRecentMessagesForPlan } = await import('../story_planner/generation.js');
        const { getIndexedMessages } = await import('../knowledge/growth.js');
        saveWorldSettings({ maxScanMessages: 20, messageFilter: '' });

        for (const text of [
            getRecentMessagesForScan(), getKnowledgeRecentMessages(50),
            getRecentMessagesForPlan(), getIndexedMessages(80),
        ]) {
            expect(text).toContain('old ai 1');
            expect(text).toContain('old user 2');
            expect(text).not.toContain('old ai 2');
            expect(text).not.toContain('LATEST');
        }
    });
});

describe('knowledge getRecentMessages', () => {
    beforeEach(() => resetCoreStubs());

    test('ignores the in-flight pair', async () => {
        setFakeChat(FULL_CHAT);
        const { getRecentMessages: getKnowledgeRecentMessages } = await import('../knowledge/lorebook.js');
        const text = getKnowledgeRecentMessages(50);
        expect(text).toContain('old ai 2');
        expect(text).not.toContain('LATEST USER');
        expect(text).not.toContain('LATEST AI');
    });

    test('returns null for a two-message chat', async () => {
        setFakeChat(TWO_MESSAGE_CHAT);
        const { getRecentMessages: getKnowledgeRecentMessages } = await import('../knowledge/lorebook.js');
        expect(getKnowledgeRecentMessages(50)).toBeNull();
    });
});

describe('story planner getRecentMessagesForPlan', () => {
    beforeEach(() => resetCoreStubs());

    test('ignores the in-flight pair', async () => {
        setFakeChat(FULL_CHAT);
        const { getRecentMessagesForPlan } = await import('../story_planner/generation.js');
        const text = getRecentMessagesForPlan();
        expect(text).toContain('old ai 2');
        expect(text).not.toContain('LATEST USER');
        expect(text).not.toContain('LATEST AI');
    });
});

describe('growth profiler getIndexedMessages', () => {
    beforeEach(() => resetCoreStubs());

    test('ignores the in-flight pair', async () => {
        setFakeChat(FULL_CHAT);
        const { getIndexedMessages } = await import('../knowledge/growth.js');
        const text = getIndexedMessages(80);
        expect(text).toContain('old ai 2');
        expect(text).not.toContain('LATEST USER');
        expect(text).not.toContain('LATEST AI');
    });

    test('returns null for a two-message chat', async () => {
        setFakeChat(TWO_MESSAGE_CHAT);
        const { getIndexedMessages } = await import('../knowledge/growth.js');
        expect(getIndexedMessages(80)).toBeNull();
    });
});

describe('world_state provenance — the excluded tail is not "touched"', () => {
    beforeEach(() => resetCoreStubs());

    test('an entity mentioned only in the tail stays untouched', async () => {
        setFakeChat([
            { id: 'm0', mes: 'scene one' },
            { id: 'm1', mes: 'scene two' },
            { id: 'm2', mes: 'scene three' },
            { id: 'm3', name: 'Mara', mes: 'Mara enters.' },
            { id: 'm4', name: 'Mara', mes: 'Mara speaks.' },
        ]);
        const { setWorldStateData } = await import('../world_state/data.js');
        setWorldStateData({ text: '## Current Scene\n**Mara** waits.\n' });
        const { buildProvenance } = await import('../world_state/provenance.js');
        const prov = buildProvenance();
        expect(prov.entities.mara).toBeDefined();
        expect(prov.entities.mara.lastTouchedMsg).toBeNull();
    });

    test('an entity mentioned inside the window is marked touched', async () => {
        setFakeChat([
            { id: 'm0', mes: 'scene one' },
            { id: 'm1', name: 'Mara', mes: 'Mara enters.' },
            { id: 'm2', mes: 'scene two' },
            { id: 'm3', mes: 'scene three' },
            { id: 'm4', mes: 'scene four' },
        ]);
        const { setWorldStateData } = await import('../world_state/data.js');
        setWorldStateData({ text: '## Current Scene\n**Mara** waits.\n' });
        const { buildProvenance } = await import('../world_state/provenance.js');
        const prov = buildProvenance();
        expect(prov.entities.mara.lastTouchedMsg).toBe(1);
    });
});

// v2.1.1 off-screen sealing: the Off-Screen Events block is preserved by the shared
// sanitizer for consumers that understand its actor/witness semantics, but the
// Knowledge module opts out — its prompts would otherwise record an
// unwitnessed sealed event as knowledge a mentioned NPC "learned".
describe('off-screen events block — Knowledge windows strip it (sealed-log opt-out)', () => {
    beforeEach(() => resetCoreStubs());

    const CHAT_WITH_SEALED_LOG = [
        { id: 'm0', name: 'User', is_user: true, mes: 'old user 1' },
        { id: 'm1', name: 'Mara', mes: 'old ai 1' },
        { id: 'm2', name: 'User', is_user: true, mes: 'old user 2' },
        {
            id: 'm3', name: 'Mara',
            mes: 'The kitchen went quiet.\n<details><summary>Tracker</summary>secret dashboard</details>\n<details><summary>📡 <b>Off-Screen Events</b></summary>- Tomas → burned the letters (unwitnessed)</details>',
        },
        { id: 'm4', name: 'User', is_user: true, mes: 'LATEST USER' },
        { id: 'm5', name: 'Mara', mes: 'LATEST AI' },
    ];

    test('knowledge getRecentMessages strips the sealed log along with trackers', async () => {
        setFakeChat(CHAT_WITH_SEALED_LOG);
        const { getRecentMessages: getKnowledgeRecentMessages } = await import('../knowledge/lorebook.js');
        const text = getKnowledgeRecentMessages(50);
        expect(text).toContain('The kitchen went quiet.');
        expect(text).not.toContain('burned the letters');
        expect(text).not.toContain('secret dashboard');
    });

    test('growth getIndexedMessages strips the sealed log too', async () => {
        setFakeChat(CHAT_WITH_SEALED_LOG);
        const { getIndexedMessages } = await import('../knowledge/growth.js');
        const text = getIndexedMessages(80);
        expect(text).toContain('The kitchen went quiet.');
        expect(text).not.toContain('burned the letters');
    });
});
