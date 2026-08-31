/**
 * core/scope.js — Stable chat identity + operation-epoch guard.
 *
 * Tier 0.2 shared primitive. Every module currently computes chat identity
 * as a weak concatenation of characterId / groupId / chatId:
 *
 *     `${ctx?.characterId ?? ''}|${ctx?.groupId ?? ''}|${ctx?.chatId ?? ''}`
 *
 * On builds where the chat is identified by `getCurrentChatId()` rather than
 * `ctx.chatId`, two different chats on the same character collapse to the same
 * key — so every "did the chat change?" guard in the codebase passes when it
 * should fail. That single flaw is the root of four of the six criticals.
 *
 * This module provides three things:
 *
 * 1. `getChatIdentity()` — prefer `ctx.getCurrentChatId()`, fall back to
 *    `ctx.chatId`, carry character/group as supplementary. Returns an explicit
 *    `unknown` state rather than an empty string; two unknowns must **not**
 *    compare equal.
 *
 * 2. A module-shared epoch counter incremented by `bumpEpoch()`, which the
 *    root `onChatChanged()` handler MUST call before dispatching to module
 *    handlers. The epoch is necessary even when the host does not expose a
 *    usable chat ID — it also invalidates delayed timers and confirmation
 *    callbacks.
 *
 * 3. `captureScope()` / `assertSameScope()` helpers. Capture before every
 *    async op; assert immediately before every metadata / lorebook / history /
 *    provenance / injection / UI commit. `assertSameScope` returns a result
 *    object suitable for quiet stale-operation discard; it does **not** throw
 *    after a user-initiated chat switch.
 */

// ─── Epoch ───────────────────────────────────────────────────────────────────

/**
 * Monotonic counter advanced on every chat change. Modules capture this value
 * before an async operation; after any `await`, if the value differs, the
 * operation is stale and must be discarded.
 *
 * The root event wiring MUST call `bumpEpoch()` before invoking module
 * `onChatChanged()` handlers, so that handlers see the new epoch when they
 * re-capture.
 */
let _epoch = 0;

/**
 * Returns the current epoch value.
 * @returns {number}
 */
export function getEpoch() {
    return _epoch;
}

/**
 * Advance the epoch, invalidating all in-flight scope tokens.
 * Called by the root `onChatChanged()` handler.
 * @returns {number} the new epoch value
 */
export function bumpEpoch() {
    return ++_epoch;
}

/**
 * Reset the epoch to zero. Exported for test isolation only — production
 * code must never call this.
 * @internal
 */
export function _resetEpoch() {
    _epoch = 0;
}

// ─── Identity ────────────────────────────────────────────────────────────────

/**
 * Monotonic nonce for unknown-identity disambiguation. Each time
 * `getChatIdentity()` is called and the chat cannot be identified, a new
 * nonce is issued so that two unknown identity objects never compare equal.
 */
let _unknownNonce = 0;

/**
 * Resolve the character identity from a SillyTavern context object.
 *
 * Returns a stable key (preferring the avatar filename, which survives
 * renames) plus the display name, or null when no character is active.
 *
 * @param {object} [ctx]
 * @returns {{ key: string, name: string, isGroup: boolean }|null}
 */
export function getCharacterIdentity(ctx) {
    if (!ctx) return null;

    // Group chats
    const groupId = ctx.groupId ?? null;
    if (groupId !== null && groupId !== undefined && groupId !== '') {
        let groupName = '';
        try {
            const group = ctx.groups?.find?.(g => String(g?.id) === String(groupId));
            groupName = group?.name || '';
        } catch { /* shape varies by fork */ }
        return {
            key: `group:${groupId}`,
            name: groupName || `Group ${groupId}`,
            isGroup: true,
        };
    }

    const chid = ctx.characterId;
    let card = null;
    if (chid !== null && chid !== undefined && Array.isArray(ctx.characters)) {
        card = ctx.characters[chid] ?? null;
    }

    const avatar = card?.avatar || '';
    const name = card?.name || ctx.name2 || '';
    if (!avatar && !name) return null;

    return {
        key: avatar ? `char:${avatar}` : `name:${name}`,
        name: name || 'Unknown',
        isGroup: false,
    };
}

/**
 * Identify the current chat with the strongest available signal.
 *
 * Resolution order:
 * 1. `ctx.getCurrentChatId()` (the correct API on builds that expose it)
 * 2. `ctx.chatId` (fallback for builds without getCurrentChatId)
 * 3. Unknown (no usable chat identifier)
 *
 * When the identity is unknown, a unique nonce is embedded in the `key` so
 * that two unknown identity objects never compare equal. This is the "fail
 * closed" rule: if we cannot identify the chat, we cannot safely assume two
 * captures refer to the same one.
 *
 * Character and group information is carried as supplementary data (useful
 * for logging and for modules that need the character context) but is NOT
 * part of the comparison key — two chats on the same character are still
 * different chats.
 *
 * @param {object} [ctx] — SillyTavern context (defaults to getContextSafe())
 * @returns {{ chatId: string|null, characterKey: string|null, groupKey: string|null,
 *            isUnknown: boolean, key: string }}
 */
export function getChatIdentity(ctx) {
    // Lazy import to avoid circular dependency at module load time.
    if (!ctx) {
        // Inline the safe access to avoid a static import cycle when this
        // module is imported by context.js consumers.
        try {
            if (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function') {
                ctx = SillyTavern.getContext();
            } else if (typeof getContext === 'function') {
                ctx = getContext();
            }
        } catch { /* not available */ }
    }

    // --- Chat ID resolution ---
    let chatId = null;
    if (ctx) {
        try {
            if (typeof ctx.getCurrentChatId === 'function') chatId = ctx.getCurrentChatId();
        } catch { /* not available on this build */ }
        if (chatId === null || chatId === undefined) chatId = ctx.chatId ?? null;
    }

    // --- Supplementary character/group info ---
    let characterKey = null;
    let groupKey = null;
    const charId = getCharacterIdentity(ctx);
    if (charId) {
        if (charId.isGroup) groupKey = charId.key;
        else characterKey = charId.key;
    }

    // --- Build identity ---
    if (chatId !== null && chatId !== undefined && String(chatId) !== '') {
        return {
            chatId: String(chatId),
            characterKey,
            groupKey,
            isUnknown: false,
            key: `chat:${chatId}`,
        };
    }

    // Unknown — each call gets a unique nonce so two unknowns never match.
    // The epoch is the back-up mechanism for detecting chat switches when
    // identity is unavailable, but identity comparison alone must still fail.
    return {
        chatId: null,
        characterKey,
        groupKey,
        isUnknown: true,
        key: `unknown:${++_unknownNonce}`,
    };
}

// ─── Scope capture / assert ──────────────────────────────────────────────────

/**
 * A scope token, capturing the epoch and chat identity at a point in time.
 *
 * Capture before any async operation; pass the token to `assertSameScope()`
 * after each `await` and before every commit point.
 *
 * @typedef {Object} ScopeToken
 * @property {number} epoch         — epoch value at capture time
 * @property {{ key: string, isUnknown: boolean, chatId: string|null,
 *             characterKey: string|null, groupKey: string|null }} identity
 * @property {number} capturedAt    — Date.now() for diagnostics/logging
 */

/**
 * Capture the current scope (epoch + chat identity).
 *
 * @param {object} [ctx] — SillyTavern context (defaults to getContextSafe())
 * @returns {ScopeToken}
 */
export function captureScope(ctx) {
    return {
        epoch: _epoch,
        identity: getChatIdentity(ctx),
        capturedAt: Date.now(),
    };
}

/**
 * Assert that the current scope matches the captured token.
 *
 * Checks in order:
 * 1. Epoch — if the epoch advanced, a chat switch was signalled → stale.
 * 2. Identity — if the chat identity changed (or either side is unknown),
 *    the operation may target a different chat → stale.
 *
 * Returns a result object; does NOT throw. Callers should check `.ok` and
 * quietly discard stale operations:
 *
 *     const scope = captureScope();
 *     const result = await someAsyncWork();
 *     if (!assertSameScope(scope).ok) return; // chat changed mid-flight
 *
 * @param {ScopeToken} token — the token returned by `captureScope()`
 * @param {object} [ctx] — SillyTavern context (defaults to getContextSafe())
 * @returns {{ ok: boolean, reason: string }}
 */
export function assertSameScope(token, ctx) {
    if (!token) return { ok: false, reason: 'no-token' };

    // 1. Epoch check — primary mechanism. Covers all builds, including those
    //    without a usable chat ID.
    if (_epoch !== token.epoch) {
        return { ok: false, reason: 'epoch-changed' };
    }

    // 2. Identity check — secondary mechanism. Catches drift that the epoch
    //    might miss (e.g. getCurrentChatId changed without onChatChanged
    //    firing, or unknown identity where we can't verify anything).
    const current = getChatIdentity(ctx);
    if (token.identity.key !== current.key) {
        return { ok: false, reason: current.isUnknown ? 'identity-unknown' : 'identity-changed' };
    }

    return { ok: true, reason: 'same-scope' };
}

/**
 * Is a scope captured before an await still current, using the §7.5
 * (privileged-preparation) semantics: the EPOCH is always checked —
 * CHAT_CHANGED bumps it synchronously, so a real chat switch can never slip
 * through — but the identity comparison runs only when the capture actually
 * identified the chat.
 *
 * This is deliberately weaker than {@link assertSameScope} for one case:
 * getChatIdentity() issues a fresh nonce for every UNKNOWN identity (two
 * unknowns must never compare equal), so requiring identity equality on a
 * host without a usable chat id would mark every await stale and no
 * long-running operation could ever complete there. The epoch is the
 * authoritative signal on such hosts; when the capture DID know the chat,
 * identity equality is required as well.
 *
 * For callers whose commit writes chat data (never for callers that only
 * display a result): pair this with a direct scope check in the commit path.
 *
 * @param {ScopeToken} token — the token returned by `captureScope()`
 * @param {object} [ctx] — SillyTavern context (defaults to getContextSafe())
 * @returns {{ ok: boolean, reason: string }}
 */
export function scopeStillCurrent(token, ctx) {
    if (!token) return { ok: false, reason: 'no-token' };
    if (getEpoch() !== token.epoch) return { ok: false, reason: 'epoch-changed' };
    if (token.identity?.isUnknown !== false) return { ok: true, reason: 'epoch-only' };
    const result = assertSameScope(token, ctx);
    return result.ok ? { ok: true, reason: 'same-scope' } : result;
}

// ─── Convenience: weak-key replacement ────────────────────────────────────────

/**
 * Build a scope key string for backwards compatibility during migration.
 *
 * This replaces the old `${characterId}|${groupId}|${chatId}` pattern with
 * one that prefers `getCurrentChatId()`. New code should use `captureScope()`
 * / `assertSameScope()` instead of string comparison.
 *
 * @param {object} [ctx]
 * @returns {string}
 */
export function getChatScopeKey(ctx) {
    const identity = getChatIdentity(ctx);
    const charId = ctx?.characterId ?? '';
    const gId = ctx?.groupId ?? '';
    const cId = identity.chatId ?? '';
    return `${charId}|${gId}|${cId}`;
}