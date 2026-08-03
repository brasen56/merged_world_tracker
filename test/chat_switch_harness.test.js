/**
 * test/chat_switch_harness.test.js — Chat-switch harness integration test.
 *
 * Proves the core invariant from REMEDIATION_MAP.md Tier 0.2 / Tier 5:
 * a stale operation (captured before a chat switch) performs zero writes
 * after the switch is detected.
 *
 * This test exercises the harness itself AND demonstrates the pattern that
 * every Tier 1 critical fix should follow:
 *
 *   1. capture scope before an async op
 *   2. assert scope after the async op resolves
 *   3. if stale: return early, zero writes
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { createChatSwitchHarness } from './stubs/chat_switch.js';

describe('chat-switch harness', () => {
    let h;

    beforeEach(() => {
        h = createChatSwitchHarness();
        h.resetEpoch();
    });

    test('starts with zero writes', () => {
        expect(h.writeCount).toBe(0);
        expect(h.writes).toHaveLength(0);
    });

    test('captureScope + assertScope match when no switch occurred', () => {
        h.setChatId('chat-A');
        const scope = h.captureScope();
        const result = h.assertScope(scope);
        expect(result.ok).toBe(true);
    });

    test('switchTo bumps the epoch and changes chat ID', () => {
        h.setChatId('chat-A');
        const scope = h.captureScope();

        h.switchTo('chat-B');

        const result = h.assertScope(scope);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('epoch-changed');
    });

    test('a stale operation performs zero writes', () => {
        h.setChatId('chat-A');
        const scope = h.captureScope();

        // Simulate: user switches chat while an async op is in flight.
        h.switchTo('chat-B');

        // The module adapter checks scope before writing.
        const result = h.assertScope(scope);
        if (result.ok) {
            h.recordWrite('metadata', { key: 'should-not-happen' });
        }

        expect(h.writeCount).toBe(0);
        expect(h.writes).toHaveLength(0);
    });

    test('a non-stale operation writes exactly once', () => {
        h.setChatId('chat-A');
        const scope = h.captureScope();

        // No chat switch — operation completes normally.
        const result = h.assertScope(scope);
        if (result.ok) {
            h.recordWrite('metadata', { key: 'test-value' });
        }

        expect(h.writeCount).toBe(1);
        expect(h.writes[0]).toMatchObject({
            type: 'metadata',
            detail: { key: 'test-value' },
            chatId: 'chat-A',
        });
    });

    test('two chats on the same character produce different scopes', () => {
        // This is the core bug the scope guard fixes: same characterId but
        // different chats must not compare equal.
        h.setCharacter(0, { name: 'Mara', avatar: 'mara.png' });
        h.setChatId('chat-1');
        const scope1 = h.captureScope();

        h.setChatId('chat-2');
        const result = h.assertScope(scope1);

        expect(result.ok).toBe(false);
    });

    test('switchTo without a new chat ID still bumps the epoch', () => {
        h.setChatId('chat-A');
        const scope = h.captureScope();

        h.switchTo(); // epoch-only invalidation

        const result = h.assertScope(scope);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('epoch-changed');
    });

    test('resetWrites clears the write log without resetting epoch', () => {
        h.recordWrite('test', {});
        expect(h.writeCount).toBe(1);

        h.resetWrites();
        expect(h.writeCount).toBe(0);
        expect(h.writes).toHaveLength(0);
    });

    test('recordWrite captures the current epoch and chat ID', () => {
        h.setChatId('chat-X');
        const scope = h.captureScope();
        h.recordWrite('lorebook', { uid: 42 });

        expect(h.writes[0].epoch).toBe(scope.epoch);
        expect(h.writes[0].chatId).toBe('chat-X');
    });

    test('simulates a realistic async flow: capture, await, switch, assert, no write', async () => {
        h.setChatId('chat-A');

        // Module captures scope before starting an async operation.
        const scope = h.captureScope();

        // Simulate an async LLM call.
        const result = await new Promise((resolve) =>
            setTimeout(() => resolve('generated content'), 10)
        );

        // During the await, the user switched chats.
        h.switchTo('chat-B');

        // The module checks scope after the await.
        const scopeResult = h.assertScope(scope);
        expect(scopeResult.ok).toBe(false);

        // Module returns without writing.
        if (scopeResult.ok) {
            h.recordWrite('metadata', { generated: result });
        }

        expect(h.writeCount).toBe(0);
    });
});