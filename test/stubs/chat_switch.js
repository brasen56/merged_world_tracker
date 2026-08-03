/**
 * test/stubs/chat_switch.js — Chat-switch test harness.
 *
 * This is the "minimal chat-switch half" of the fake-SillyTavern harness
 * described in REMEDIATION_MAP.md Tier 5 / pulled into Tier 0.2. It proves
 * that a stale operation (captured before a chat switch, asserted after)
 * performs zero writes.
 *
 * Usage:
 *
 *   import { createChatSwitchHarness } from '../stubs/chat_switch.js';
 *
 *   const h = createChatSwitchHarness();
 *   h.setChatId('chat-A');
 *   const scope = h.captureScope();
 *
 *   // ... start an async operation that would write ...
 *
 *   h.switchTo('chat-B');  // simulates CHAT_CHANGED + bumpEpoch
 *
 *   // ... async operation resumes ...
 *
 *   expect(h.assertScope(scope).ok).toBe(false);
 *   expect(h.writes).toHaveLength(0);  // zero writes
 *
 * The harness tracks every write through a `writes` array. Module adapters
 * in future tests will route their metadata/lorebook/history mutations
 * through `h.recordWrite(...)` so the "zero writes" assertion is meaningful.
 */

import { captureScope, assertSameScope, bumpEpoch, _resetEpoch, getEpoch } from '../../core/scope.js';

/**
 * Create a fresh chat-switch harness instance.
 *
 * @returns {object} harness API
 */
export function createChatSwitchHarness() {
    let _chatId = 'test-chat-default';
    let _characterId = 0;
    let _characters = [{ name: 'TestChar', avatar: 'test.png' }];
    let _writeCount = 0;

    /** All writes recorded by `recordWrite()`, in order. */
    const writes = [];

    /**
     * Simulated SillyTavern context object. `getCurrentChatId()` returns the
     * current `_chatId`, mirroring the real ST API.
     */
    function buildContext() {
        return {
            characterId: _characterId,
            characters: _characters,
            groupId: null,
            chatId: _chatId,
            getCurrentChatId: () => _chatId,
            // Allow tests to inspect the context directly.
            name1: 'User',
            name2: _characters[_characterId]?.name || 'TestChar',
        };
    }

    return {
        /** The array of recorded writes (for assertions). */
        writes,

        /** Number of writes recorded. */
        get writeCount() { return _writeCount; },

        /**
         * Set the current chat ID (simulates being in a particular chat).
         * Does NOT bump the epoch — use `switchTo()` for that.
         * @param {string} id
         */
        setChatId(id) {
            _chatId = String(id);
        },

        /**
         * Set the active character.
         * @param {number} chid
         * @param {object} [card]
         */
        setCharacter(chid, card) {
            _characterId = chid;
            if (card) {
                _characters[chid] = card;
            }
        },

        /**
         * Get the current fake context object.
         * @returns {object}
         */
        getContext() {
            return buildContext();
        },

        /**
         * Capture the current scope (epoch + chat identity).
         * Convenience wrapper around `captureScope()` with the harness context.
         * @returns {import('../../core/scope.js').ScopeToken}
         */
        captureScope() {
            return captureScope(buildContext());
        },

        /**
         * Assert that the current scope matches the captured token.
         * Convenience wrapper around `assertSameScope()`.
         * @param {import('../../core/scope.js').ScopeToken} token
         * @returns {{ ok: boolean, reason: string }}
         */
        assertScope(token) {
            return assertSameScope(token, buildContext());
        },

        /**
         * Simulate a chat switch: set the new chat ID AND bump the epoch,
         * exactly as the root `CHAT_CHANGED` handler does.
         *
         * @param {string} [newChatId] — if omitted, just bumps the epoch
         */
        switchTo(newChatId) {
            if (newChatId !== undefined) {
                _chatId = String(newChatId);
            }
            bumpEpoch();
        },

        /**
         * Record a write (metadata mutation, lorebook update, etc.).
         * Module adapters call this at every commit point so the harness
         * can assert "zero writes" for stale operations.
         *
         * @param {string} type — e.g. 'metadata', 'lorebook', 'history'
         * @param {object} [detail]
         */
        recordWrite(type, detail = {}) {
            _writeCount++;
            writes.push({ type, detail, chatId: _chatId, epoch: getEpoch() });
        },

        /**
         * Reset write tracking (does not reset the epoch or chat ID).
         */
        resetWrites() {
            writes.length = 0;
            _writeCount = 0;
        },

        /**
         * Reset the epoch to zero. Call in `beforeEach` for test isolation.
         */
        resetEpoch() {
            _resetEpoch();
        },
    };
}