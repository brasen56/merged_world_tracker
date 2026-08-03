/**
 * test/scope_guard.test.js — Tier 0.2: stable chat identity + operation epoch.
 *
 * The core invariant: two different chats on the same character must NOT
 * compare equal, and any in-flight operation captured before a chat switch
 * must be detected as stale after the switch.
 */

import { describe, test, expect, beforeEach } from 'vitest';

import {
    getEpoch,
    bumpEpoch,
    _resetEpoch,
    getChatIdentity,
    captureScope,
    assertSameScope,
    getChatScopeKey,
} from '../core/scope.js';

beforeEach(() => {
    _resetEpoch();
});

// ─── Epoch ───────────────────────────────────────────────────────────────────

describe('epoch counter', () => {
    test('starts at zero', () => {
        expect(getEpoch()).toBe(0);
    });

    test('bumpEpoch advances by one each call', () => {
        expect(bumpEpoch()).toBe(1);
        expect(bumpEpoch()).toBe(2);
        expect(bumpEpoch()).toBe(3);
    });

    test('_resetEpoch returns to zero (test-only)', () => {
        bumpEpoch();
        bumpEpoch();
        _resetEpoch();
        expect(getEpoch()).toBe(0);
    });
});

// ─── getChatIdentity ─────────────────────────────────────────────────────────

describe('getChatIdentity', () => {
    test('prefers getCurrentChatId() over ctx.chatId', () => {
        const ctx = {
            getCurrentChatId: () => 'chat-from-method',
            chatId: 'chat-from-property',
        };
        const id = getChatIdentity(ctx);
        expect(id.chatId).toBe('chat-from-method');
        expect(id.isUnknown).toBe(false);
    });

    test('falls back to ctx.chatId when getCurrentChatId is unavailable', () => {
        const ctx = { chatId: 'chat-9' };
        const id = getChatIdentity(ctx);
        expect(id.chatId).toBe('chat-9');
        expect(id.isUnknown).toBe(false);
    });

    test('returns isUnknown when no chat identifier is available', () => {
        const id = getChatIdentity({});
        expect(id.isUnknown).toBe(true);
        expect(id.chatId).toBeNull();
    });

    test('returns isUnknown when context is null', () => {
        const id = getChatIdentity(null);
        expect(id.isUnknown).toBe(true);
    });

    test('two unknown identities never compare equal (unique nonce)', () => {
        const a = getChatIdentity(null);
        const b = getChatIdentity(null);
        expect(a.key).not.toBe(b.key);
    });

    test('carries character info as supplementary but not in the key', () => {
        const ctx = {
            getCurrentChatId: () => 'chat-42',
            characterId: 0,
            characters: [{ name: 'Mara', avatar: 'mara.png' }],
        };
        const id = getChatIdentity(ctx);
        expect(id.characterKey).toBe('char:mara.png');
        expect(id.key).toBe('chat:chat-42');
        // Two chats on the same character have the same characterKey but
        // different keys.
        const ctx2 = {
            getCurrentChatId: () => 'chat-99',
            characterId: 0,
            characters: [{ name: 'Mara', avatar: 'mara.png' }],
        };
        const id2 = getChatIdentity(ctx2);
        expect(id2.characterKey).toBe(id.characterKey);
        expect(id2.key).not.toBe(id.key);
    });

    test('the weak-key collapse scenario: same character, different chats', () => {
        // This is the bug: two chats with the same characterId would produce
        // the same weak key `${characterId}|${groupId}|${chatId}` on builds
        // where chatId is not populated but getCurrentChatId() works.
        const ctx1 = {
            characterId: 0,
            groupId: null,
            // chatId NOT set — mimics builds that rely on getCurrentChatId
            getCurrentChatId: () => 'chat-alpha',
            characters: [{ name: 'Mara', avatar: 'mara.png' }],
        };
        const ctx2 = {
            characterId: 0,
            groupId: null,
            getCurrentChatId: () => 'chat-beta',
            characters: [{ name: 'Mara', avatar: 'mara.png' }],
        };
        const id1 = getChatIdentity(ctx1);
        const id2 = getChatIdentity(ctx2);
        expect(id1.key).not.toBe(id2.key);
    });

    test('handles getCurrentChatId throwing', () => {
        const ctx = {
            getCurrentChatId: () => { throw new Error('not available'); },
            chatId: 'fallback-chat',
        };
        const id = getChatIdentity(ctx);
        expect(id.chatId).toBe('fallback-chat');
    });

    test('handles empty-string chat IDs as unknown', () => {
        const id = getChatIdentity({ chatId: '' });
        expect(id.isUnknown).toBe(true);
    });
});

// ─── captureScope / assertSameScope ──────────────────────────────────────────

describe('captureScope and assertSameScope', () => {
    test('returns ok when scope is unchanged (no chat switch)', () => {
        const ctx = { getCurrentChatId: () => 'chat-1' };
        const token = captureScope(ctx);
        expect(assertSameScope(token, ctx).ok).toBe(true);
    });

    test('detects epoch change after bumpEpoch (chat switch)', () => {
        const ctx = { getCurrentChatId: () => 'chat-1' };
        const token = captureScope(ctx);
        bumpEpoch(); // simulate chat switch
        const result = assertSameScope(token, ctx);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('epoch-changed');
    });

    test('detects identity change without epoch bump', () => {
        const ctx1 = { getCurrentChatId: () => 'chat-1' };
        const token = captureScope(ctx1);
        // Same epoch but different chat ID
        const ctx2 = { getCurrentChatId: () => 'chat-2' };
        const result = assertSameScope(token, ctx2);
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('identity-changed');
    });

    test('returns no-token when token is null/undefined', () => {
        expect(assertSameScope(null).ok).toBe(false);
        expect(assertSameScope(null).reason).toBe('no-token');
    });

    test('a stale operation performs zero writes (integration pattern)', () => {
        // Simulate the pattern: capture before async, assert after await.
        const ctx = { getCurrentChatId: () => 'chat-1' };
        const token = captureScope(ctx);

        // Simulate: user switches chat while LLM call is in flight.
        bumpEpoch();

        // After the await, the module checks scope before writing.
        const result = assertSameScope(token, ctx);
        expect(result.ok).toBe(false);

        // In production code, the module would `return` here — zero writes.
        let writeHappened = false;
        if (result.ok) {
            writeHappened = true; // would write metadata/lorebook/etc.
        }
        expect(writeHappened).toBe(false);
    });

    test('works with unknown identity + epoch as backup mechanism', () => {
        // On builds with no usable chat ID, the epoch is the only mechanism.
        const token = captureScope(null); // unknown identity
        // Without a chat switch, two unknown captures still don't match
        // (by design — fail closed).
        expect(assertSameScope(token, null).ok).toBe(false);
        // The reason is identity-unknown because the nonce differs.
        const result = assertSameScope(token, null);
        expect(result.reason).toBe('identity-unknown');
    });
});

// ─── getChatScopeKey (backwards-compat helper) ───────────────────────────────

describe('getChatScopeKey', () => {
    test('produces a key using getCurrentChatId', () => {
        const ctx = { characterId: 1, groupId: null, getCurrentChatId: () => 'c1' };
        expect(getChatScopeKey(ctx)).toBe('1||c1');
    });

    test('two chats on the same character produce different keys', () => {
        const ctx1 = { characterId: 1, groupId: null, getCurrentChatId: () => 'c1' };
        const ctx2 = { characterId: 1, groupId: null, getCurrentChatId: () => 'c2' };
        expect(getChatScopeKey(ctx1)).not.toBe(getChatScopeKey(ctx2));
    });
});