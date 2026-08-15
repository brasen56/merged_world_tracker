/**
 * knowledge/scope.js — Lorebook scope resolution.
 *
 * The Knowledge module writes into three lorebooks ("Knowledge Tracker",
 * "State Tracker", "NPC Profiles"). Those names used to be hard-coded
 * constants, which meant every chat and every character shared one set of
 * books. Two different cards could each have an NPC called "Mara"; both
 * entries landed in the same book keyed on the same keyword, so both injected
 * into both chats. This module resolves the three names per scope instead:
 *
 *   'global'    — the legacy names. One shared set of books. (default)
 *   'character' — one set per character card, shared by every chat with them.
 *   'chat'      — one set per chat file.
 *
 * ── The rule that matters ───────────────────────────────────────────────────
 * The registry mapping NPC name → lorebook UID must have the SAME LIFETIME as
 * the book it points into. A per-character book with a per-chat registry
 * re-scans from an empty registry on every new chat and creates duplicate
 * entries — the same bug, just narrower. See store.js, which keeps the
 * registry inside the book itself so the two cannot drift apart.
 *
 * ── Why bindings are persisted ──────────────────────────────────────────────
 * Deriving the book name from the character's display name on every call would
 * orphan the entire book the moment someone renames a card. So resolved names
 * are saved under a STABLE key (the card's avatar filename, which survives a
 * rename) and reused from then on. The display name is only consulted the
 * first time, to make the new book's name human-readable.
 *
 * ── Fork compatibility ──────────────────────────────────────────────────────
 * The SillyTavern context fields read here (`characterId`, `characters`,
 * `groupId`, `getCurrentChatId`) vary across ST versions and forks. Every read
 * is defensive, and any failure to identify the current scope falls back to
 * the GLOBAL names rather than guessing — writing to the wrong book is far
 * worse than writing to the shared one.
 */

import { getContextSafe, record } from '../core/index.js';

import {
    LOREBOOK_NAME, STATE_LOREBOOK_NAME, PROFILE_LOREBOOK_NAME,
} from './state.js';
import { getSettings, saveSettings } from './settings.js';

/** Valid values for the `scope` setting. */
export const SCOPES = ['global', 'character', 'chat'];

// ─── Pure helpers (no SillyTavern dependency — unit tested directly) ─────────

/**
 * Characters ST cannot put in a lorebook filename, plus control characters.
 * Lorebook names become files on disk (`worlds/<name>.json`), so a card called
 * "Mara: Book 1 / Act 2" would produce an unwritable path.
 */
const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/** Longest suffix we will append, so the final filename stays reasonable. */
const MAX_SUFFIX_LENGTH = 64;

/**
 * Make a character/chat name safe to embed in a lorebook (file) name.
 *
 * Returns '' when nothing usable survives — callers MUST treat that as
 * "cannot scope" and fall back to the global names.
 *
 * @param {string} name
 * @returns {string}
 */
export function sanitizeLorebookName(name) {
    let out = String(name ?? '').replace(ILLEGAL_FILENAME_CHARS, '');
    // Collapse runs of whitespace so "Mara   Vance" doesn't become a weird name.
    out = out.replace(/\s+/g, ' ').trim();
    // Windows rejects names with leading/trailing dots or spaces.
    out = out.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
    if (out.length > MAX_SUFFIX_LENGTH) {
        out = out.slice(0, MAX_SUFFIX_LENGTH).trim().replace(/[.\s]+$/, '');
    }
    return out;
}

/**
 * Build the three book names for a given suffix.
 *
 * An empty/unusable suffix yields the legacy global names, which is what makes
 * `scope: 'global'` byte-identical to the pre-scope behaviour.
 *
 * @param {string|null|undefined} suffix
 * @returns {{ knowledge: string, state: string, profiles: string }}
 */
export function deriveBookNames(suffix) {
    const clean = sanitizeLorebookName(suffix);
    if (!clean) {
        return {
            knowledge: LOREBOOK_NAME,
            state: STATE_LOREBOOK_NAME,
            profiles: PROFILE_LOREBOOK_NAME,
        };
    }
    return {
        knowledge: `${LOREBOOK_NAME} - ${clean}`,
        state: `${STATE_LOREBOOK_NAME} - ${clean}`,
        profiles: `${PROFILE_LOREBOOK_NAME} - ${clean}`,
    };
}

/**
 * Short, stable, filename-safe discriminator for an identity key.
 *
 * Used only to break a name collision between two different cards that share a
 * display name — see `resolveBookNames`. Not a security hash; it just needs to
 * be deterministic so the same card resolves to the same book every time.
 *
 * KNOWLEDGE-09: The previous 4-char base-36 hash (1.6M possible values) had a
 * meaningful collision probability across a large card collection — two cards
 * sharing a display name could resolve to the same discriminator and still
 * share a book. Increased to 8 chars (2.8 trillion values) so the collision
 * probability is negligible for any realistic card count, while staying
 * filename-safe and short enough for a readable book name.
 *
 * @param {string} str
 * @returns {string} up to 8 base-36 characters
 */
export function shortHash(str) {
    let h1 = 0, h2 = 0;
    const s = String(str ?? '');
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h1 = ((h1 << 5) - h1 + c) | 0;
        h2 = ((h2 << 7) - h2 + c * 31) | 0;
    }
    const combined = (Math.abs(h1).toString(36) + Math.abs(h2).toString(36)).slice(0, 8);
    return combined || '0';
}

// ─── Identity resolution (reads the live ST context) ────────────────────────

/**
 * Identify the current character (or group).
 *
 * `key` is stable across renames — it is the card's avatar filename, which ST
 * uses as the card's real identity. `name` is the display name and is only
 * used to build a readable book name the first time.
 *
 * Returns null when no character is active (e.g. no chat open), which callers
 * treat as "fall back to global".
 *
 * @returns {{ key: string, name: string, isGroup: boolean }|null}
 */
export function getCharacterIdentity() {
    const ctx = getContextSafe();
    if (!ctx) return null;

    // Group chats have no single character. They still get a stable identity of
    // their own so a group can have its own books rather than silently sharing
    // the global ones.
    const groupId = ctx.groupId ?? null;
    if (groupId !== null && groupId !== undefined && groupId !== '') {
        let groupName = '';
        try {
            const group = ctx.groups?.find?.(g => String(g?.id) === String(groupId));
            groupName = group?.name || '';
        } catch { /* shape varies by fork — the id alone is enough */ }
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
        // Prefer the avatar filename: two different cards can share a display
        // name ("Mara" v1 and v2 from different sources), and keying on the
        // name alone would silently merge their books — reintroducing exactly
        // the cross-contamination this module exists to prevent.
        key: avatar ? `char:${avatar}` : `name:${name}`,
        name: name || 'Unknown',
        isGroup: false,
    };
}

/**
 * Identify the current chat file.
 * @returns {{ key: string, name: string }|null}
 */
export function getChatIdentity() {
    const ctx = getContextSafe();
    if (!ctx) return null;

    let id = null;
    try {
        if (typeof ctx.getCurrentChatId === 'function') id = ctx.getCurrentChatId();
    } catch { /* not available on this build */ }
    if (id === null || id === undefined) id = ctx.chatId ?? null;
    if (id === null || id === undefined || id === '') return null;

    return { key: `chat:${id}`, name: String(id) };
}

// ─── Resolution ─────────────────────────────────────────────────────────────

/**
 * Resolve the three lorebook names for the current scope.
 *
 * Reuses a previously saved binding when one exists for this identity, so
 * renaming a card does not orphan its books. Falls back to the global names
 * whenever the current scope cannot be identified.
 *
 * @returns {{ knowledge: string, state: string, profiles: string }}
 */
export function resolveBookNames() {
    const settings = getSettings();
    const scope = SCOPES.includes(settings.scope) ? settings.scope : 'global';
    if (scope === 'global') return deriveBookNames(null);

    const identity = scope === 'chat' ? getChatIdentity() : getCharacterIdentity();
    if (!identity) {
        console.warn(
            `[MWT:Knowledge] Scope is "${scope}" but the current ${scope} could not be ` +
            `identified — falling back to the global lorebooks. (No chat open yet?)`
        );
        // Phase 3 diagnostics (design §I.4.5, site 4): safe-but-silent by design
        // — which is exactly why it must be visible. Everything keeps working,
        // but data lands in the SHARED global books instead of this chat's own,
        // which is the classic "why is my data weird across chats" report.
        record({
            level: 'warn',
            module: 'knowledge',
            event: 'scope_fallback_global',
            detail: { scope },
        });
        return deriveBookNames(null);
    }

    const bindings = settings.bookBindings || {};
    const existing = bindings[identity.key];
    if (existing?.knowledge && existing?.state && existing?.profiles) return existing;

    let names = deriveBookNames(identity.name);

    // A name that sanitises to nothing (e.g. a card called "???") would collide
    // with the global books. Fall back explicitly rather than silently sharing.
    if (names.knowledge === LOREBOOK_NAME) {
        console.warn(
            `[MWT:Knowledge] Could not derive a usable lorebook name from ` +
            `"${identity.name}" — using the global lorebooks for this ${scope}.`
        );
        return names;
    }

    // Two DIFFERENT cards can share a display name — "Mara" downloaded twice
    // from different sources is common. Both would derive the same book name
    // and silently share one book, which is exactly the cross-contamination
    // this module exists to prevent. Disambiguate with a stable discriminator
    // drawn from the identity key (the avatar filename), which differs even
    // when the display names match.
    const takenByOthers = new Set(
        Object.entries(bindings)
            .filter(([key]) => key !== identity.key)
            .map(([, value]) => value?.knowledge)
            .filter(Boolean)
    );
    if (takenByOthers.has(names.knowledge)) {
        names = deriveBookNames(`${identity.name} (${shortHash(identity.key)})`);
        console.log(
            `[MWT:Knowledge] "${identity.name}" collides with an existing binding — ` +
            `using "${names.knowledge}" instead.`
        );
    }

    saveSettings({ bookBindings: { ...bindings, [identity.key]: names } });
    console.log(`[MWT:Knowledge] Bound ${identity.key} → "${names.knowledge}"`);
    return names;
}

/** Current Knowledge Tracker lorebook name. */
export function getLorebookName() { return resolveBookNames().knowledge; }

/** Current State Tracker lorebook name. */
export function getStateLorebookName() { return resolveBookNames().state; }

/** Current NPC Profiles lorebook name. */
export function getProfileLorebookName() { return resolveBookNames().profiles; }
