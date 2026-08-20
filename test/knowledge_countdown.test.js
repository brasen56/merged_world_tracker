/** Regression coverage for Knowledge countdown receipt deduplication. */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getFakeMeta, resetCoreStubs, setFakeChat } from './stubs/core.js';
import { onMessageDeleted, onMessageReceived } from '../knowledge/index.js';
import { saveSettings } from '../knowledge/settings.js';
import { COUNTERS_META_KEY, state } from '../knowledge/state.js';

describe('Knowledge countdown counts settled message slots, not generations', () => {
    beforeEach(() => {
        resetCoreStubs();
        globalThis.document = {
            dispatchEvent: vi.fn(),
        };
        state.messageCounter = 0;
        state.npcMessageCounter = 0;
        state.growthMessageCounter = 0;
        state.relationshipMessageCounter = 0;
        state.lastChatLength = 0;
        state.countedReceiptEvents = new Map();
        state.isRunning = false;
        state.trackerQueue = Promise.resolve();
        saveSettings({
            connectionProfileId: 'test-profile',
            autoTriggerEnabled: true,
            autoTriggerEveryN: 10,
            npcAutoScanEnabled: true,
            npcAutoScanEveryN: 10,
            growthAutoCaptureEnabled: true,
            growthAutoCaptureEveryN: 10,
            relationshipAutoExtractEnabled: true,
            relationshipAutoExtractEveryN: 10,
        });
    });

    test('a swipe/regeneration of the same assistant receipt advances no cadence', () => {
        const reply = { id: 'reply-1', mes: 'first generation' };
        setFakeChat([{ is_user: true, mes: 'prompt' }, reply]);
        onMessageReceived();

        reply.mes = 'replacement generation';
        onMessageReceived();
        onMessageReceived();

        expect(state.messageCounter).toBe(1);
        expect(state.npcMessageCounter).toBe(1);
        expect(state.growthMessageCounter).toBe(1);
        expect(state.relationshipMessageCounter).toBe(1);
        expect(getFakeMeta()[COUNTERS_META_KEY].countedReceiptEvents).toEqual([
            ['id:reply-1', { state: 1, npc: 1, growth: 1, relationship: 1 }],
        ]);
    });

    test('a receipt remains deduplicated after it completed the prior cadence', () => {
        saveSettings({
            autoTriggerEnabled: false,
            npcAutoScanEnabled: true,
            npcAutoScanEveryN: 1,
            growthAutoCaptureEnabled: false,
            relationshipAutoExtractEnabled: false,
        });
        const reply = { id: 'trigger-reply', mes: 'first generation' };
        setFakeChat([reply]);

        onMessageReceived();
        expect(state.npcMessageCounter).toBe(0);
        expect(state.countedReceiptEvents.get('id:trigger-reply')).toEqual({ npc: 0 });

        reply.mes = 'replacement after trigger';
        onMessageReceived();

        expect(state.npcMessageCounter).toBe(0);
        expect(state.countedReceiptEvents.get('id:trigger-reply')).toEqual({ npc: 0 });
    });

    test('spent markers are released without breaking dedup for the live tail', () => {
        saveSettings({
            autoTriggerEnabled: false,
            npcAutoScanEnabled: true,
            npcAutoScanEveryN: 3,
            growthAutoCaptureEnabled: false,
            relationshipAutoExtractEnabled: false,
        });
        const chat = [];
        for (let i = 0; i < 60; i++) {
            chat.push({ id: `reply-${i}`, mes: `generation ${i}` });
            setFakeChat([...chat]);
            onMessageReceived();
        }
        // Without a release pass this map holds one entry per assistant message
        // for the life of the chat — and it is re-serialised into chat metadata
        // on every receipt.
        expect(state.countedReceiptEvents.size).toBeLessThanOrEqual(13);

        // The tail is what can actually be regenerated, so it must survive.
        const counterBefore = state.npcMessageCounter;
        chat[chat.length - 1].mes = 'regenerated tail';
        onMessageReceived();
        expect(state.npcMessageCounter).toBe(counterBefore);
    });

    test('a receipt owed to the live cadence survives the release pass', () => {
        saveSettings({
            autoTriggerEnabled: false,
            npcAutoScanEnabled: true,
            npcAutoScanEveryN: 10,
            growthAutoCaptureEnabled: false,
            relationshipAutoExtractEnabled: false,
        });
        const chat = [];
        for (let i = 0; i < 25; i++) {
            chat.push({ id: `reply-${i}`, mes: `generation ${i}` });
            setFakeChat([...chat]);
            onMessageReceived();
        }
        // Two cadences completed (at 10 and 20); five receipts are owed to the
        // third, and 20 spent markers are eligible for release.
        expect(state.npcMessageCounter).toBe(5);
        expect(state.countedReceiptEvents.get('id:reply-24')).toEqual({ npc: 1 });

        setFakeChat(chat.slice(0, 24));
        onMessageDeleted(24);

        expect(state.npcMessageCounter).toBe(4);
    });

    test('deleting a multiply-received reply reverses its contribution only once', () => {
        saveSettings({
            autoTriggerEnabled: false,
            npcAutoScanEnabled: true,
            npcAutoScanEveryN: 10,
            growthAutoCaptureEnabled: false,
            relationshipAutoExtractEnabled: false,
        });
        const reply = { id: 'reply-to-delete', mes: 'first generation' };
        setFakeChat([reply]);
        onMessageReceived();
        reply.mes = 'regenerated';
        onMessageReceived();

        setFakeChat([]);
        onMessageDeleted(0);

        expect(state.npcMessageCounter).toBe(0);
        expect(state.countedReceiptEvents.size).toBe(0);
    });
});
