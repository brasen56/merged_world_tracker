/**
 * test/world_time_parity.test.js — <world_time> parity across prompt builders.
 *
 * generation.js picks a builder from a single if/else and passes the SAME
 * `worldTime` to whichever it chose:
 *
 *   useRichThoughtsContext ? buildThoughtsUserContent({…, worldTime, …})
 *                          : buildUserContent({…, worldTime, …})
 *
 * buildUserContent accepted worldTime and never emitted it, so the batched and
 * strict paths handed the model `<open_intentions>` lines carrying `since`
 * labels with no "now" to compare them against — while the split-thoughts path
 * and the dormant poll both supplied it. Same feature, two settings, different
 * reasoning quality.
 *
 * A first `no-unused-vars` pass reads that dropped parameter as dead code. It
 * is the opposite: callers were actively passing it. These tests pin the
 * contract so the parameter cannot be quietly deleted again.
 */

import { describe, test, expect } from 'vitest';

import {
    buildUserContent,
    buildThoughtsUserContent,
    buildDormantPollUserContent,
} from '../interiority/prompts.js';

const WORLD_TIME = 'Tuesday evening, 9:15pm';

const NPC_BLOCKS = [{
    name: 'Mara',
    knowledgeEntry: 'Keeps the ledger.',
    openIntentions: [
        { id: 'i-1', action: 'search the study drawer', trigger: 'next time Jonah leaves', since: 'Tue evening' },
    ],
}];

describe('<world_time> parity across the interiority prompt builders', () => {
    test('buildUserContent emits world_time (the batched / strict path)', () => {
        const content = buildUserContent({
            npcBlocks: NPC_BLOCKS,
            recentMessages: 'Mara watches the door.',
            worldTime: WORLD_TIME,
        });
        expect(content).toContain('<world_time>');
        expect(content).toContain(WORLD_TIME);
    });

    test('buildThoughtsUserContent emits world_time (the split-thoughts path)', () => {
        const content = buildThoughtsUserContent({
            npcBlocks: NPC_BLOCKS,
            recentMessages: 'Mara watches the door.',
            worldTime: WORLD_TIME,
        });
        expect(content).toContain('<world_time>');
        expect(content).toContain(WORLD_TIME);
    });

    test('buildDormantPollUserContent emits world_time', () => {
        const content = buildDormantPollUserContent({
            dormantEntries: [
                { id: 'i-9', npc: 'Mara', action: 'confront Jonah', trigger: 'the funeral', wakeHint: 'the funeral' },
            ],
            recentMessages: 'Mara watches the door.',
            worldTime: WORLD_TIME,
        });
        expect(content).toContain('<world_time>');
        expect(content).toContain(WORLD_TIME);
    });

    test('the batched path pairs world_time with the since labels it has to judge', () => {
        // This is the actual failure the missing block caused: the model is
        // shown "(since Tue evening)" and asked whether the trigger has fired
        // now. Both halves have to be present for that question to be
        // answerable at all.
        const content = buildUserContent({
            npcBlocks: NPC_BLOCKS,
            recentMessages: 'Mara watches the door.',
            worldTime: WORLD_TIME,
            includeIntentions: true,
        });
        expect(content).toContain('since Tue evening');
        expect(content).toContain(`<world_time>${WORLD_TIME}</world_time>`);
    });

    test('every builder omits the block entirely when there is no world time', () => {
        // getWorldTime() returns '' when the world-state document has no Date /
        // Time fields. An empty <world_time></world_time> would be worse than
        // nothing — it reads as "the time is known and it is blank".
        const args = { npcBlocks: NPC_BLOCKS, recentMessages: 'msg' };
        expect(buildUserContent({ ...args, worldTime: '' })).not.toContain('<world_time>');
        expect(buildUserContent(args)).not.toContain('<world_time>');
        expect(buildThoughtsUserContent({ ...args, worldTime: '' })).not.toContain('<world_time>');
    });
});
