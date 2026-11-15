/**
 * diagnostics_panel/scope_storage.js — Tab 3: Scope & storage
 * (Diagnostics Phase 8).
 *
 * "Which lorebooks is this chat actually using, and WHY?" (phases doc §II.4
 * Phase 8, design §I.5 Tab 3): the resolved character/chat identity and the
 * current operation epoch, the three lorebook names this scope resolves to
 * with the reason each step of the resolution produced them, the saved
 * bindings, per-book hydration and store versions — and the loud warning when
 * scope silently fell back to the global books (fueled by Phase 3's site-4
 * `scope_fallback_global` counter in the event ring).
 *
 * The storage half (collectStorageSizes, below) is a size meter: how full the
 * browser's localStorage is and how much of it is MWT's, grouped by key
 * family, plus the serialized size of each MWT store in this chat's metadata.
 * Sizes and family names only — never a stored value or a raw key name.
 *
 * ── Why resolution is RE-DERIVED, not resolved ───────────────────────────────
 * `knowledge/scope.js resolveBookNames()` is the authoritative resolver, but it
 * is also a WRITER: on first sight of an identity it saves a binding via
 * saveSettings(). The diagnostics panel is read-only by contract (design §I.1,
 * validation baseline §II.6) — opening a tab must never persist a binding.
 * So `explainBookResolution()` (defined in knowledge/scope.js beside the
 * resolver it mirrors, imported here downward and re-exported for established
 * import sites) mirrors resolveBookNames()'s decision tree using only the pure
 * helpers (`deriveBookNames`, `shortHash`) plus a settings SNAPSHOT, and
 * reports which mode production resolution would take — including that a
 * binding WOULD be saved on the next real resolve. The mirror is deliberately
 * kept branch-for-branch so the two cannot drift silently.
 *
 * DOM-free by design (the Phase 6 health.js pattern): the snapshot is a plain
 * object, the markup lives in diagnostics_panel/render.js, every dependency is
 * injectable, and every accessor call is individually guarded — one throwing
 * dependency degrades its own field plus an `errors` note, never the tab.
 *
 * Direct imports throughout for core singletons (NOT via core/index.js): the
 * barrel is aliased to test/stubs/core.js under Vitest, and this module must
 * read the real helpers + version regardless (the barrel→stub alias trap,
 * §II.3). knowledge/* are imported exactly the way index.js's MWT.scope
 * diagnostics reach them, so the tab and the console view one live graph.
 */

import { MWT_VERSION } from '../core/version.js';
import { getEpoch } from '../core/scope.js';
import { getEvents } from '../core/diagnostics.js';
import { getContextSafe } from '../core/context.js';

// The resolution explainer now lives in knowledge/scope.js, beside the
// resolver it mirrors — this tab imports it downward like every other
// consumer (see the file header and the re-export below).
import {
    explainBookResolution,
    getCharacterIdentity,
    getChatIdentity,
} from '../knowledge/scope.js';
import {
    LOREBOOK_NAME, STATE_LOREBOOK_NAME, PROFILE_LOREBOOK_NAME,
    HISTORY_KEY_PREFIX,
    state as knowledgeState,
} from '../knowledge/state.js';
import { getSettings } from '../knowledge/settings.js';
import { peekStore, STORE_VERSION } from '../knowledge/store.js';
// Storage meter: the chat-metadata rows enumerate the schema registry (the
// "one list" rule, schema/registry.js header) plus the MWT keys that live
// outside it. Leaf imports only — none of these pull a module's store graph.
import { CHAT_METADATA_SCHEMA_IDS, STORE_SCHEMAS } from '../schema/registry.js';
import { MANIFEST_METADATA_KEY } from '../schema/manifest.js';
import { QUARANTINE_METADATA_KEY } from '../core/quarantine.js';
import { BUDGET_METADATA_KEY } from '../core/budget.js';

// Re-exported from the one-owner home (knowledge/scope.js): the two-book
// read-only resolver and the explainer it builds on live beside
// resolveBookNames(), so backup/recovery.js's fail-closed §5.3 completeness
// guard, Integrity, and this panel all import DOWNWARD — backup/ must not
// reach into a UI module for a knowledge-scope rule the export refuses over.
// Established import sites keep working unchanged.
export { explainBookResolution, resolveKnowledgeBooks } from '../knowledge/scope.js';

// ─── Book specs ───────────────────────────────────────────────────────────────

/**
 * The three books a scope resolves to, in panel order. `hasStore` marks which
 * books carry a `[MWT:store]` entry: the Knowledge and State Tracker books
 * each keep a store inside the book (registry / state registry), while NPC
 * Profiles is plain entries with no store — hydration and store version only
 * exist where a store exists.
 *
 * `injectable` marks which books ST is expected to inject from, and therefore
 * which ones need to be switched on in the World Info panel to do anything.
 * The Knowledge and State Tracker books hold keyworded entries that ST injects
 * when the book is active; NPC Profiles entries carry NO keywords on purpose
 * (see knowledge/lorebook.js), so ST never injects them whether the book is
 * active or not — activation status is meaningless for it.
 */
export const SCOPE_BOOK_SPECS = [
    { id: 'knowledge', label: '🧠 Knowledge Tracker', nameKey: 'knowledge', hasStore: true, injectable: true },
    { id: 'state', label: '📜 State Tracker', nameKey: 'state', hasStore: true, injectable: true },
    { id: 'profiles', label: '👥 NPC Profiles', nameKey: 'profiles', hasStore: false, injectable: false },
];

/** The global (un-scoped) book names, for comparison and labels. */
export const GLOBAL_BOOK_NAMES = {
    knowledge: LOREBOOK_NAME,
    state: STATE_LOREBOOK_NAME,
    profiles: PROFILE_LOREBOOK_NAME,
};

// ─── World-info activation probe (read-only) ──────────────────────────────────
//
// MWT creates the lorebook FILES (loadWorldInfo / saveWorldInfo) but has never
// touched any of SillyTavern's activation slots. ST only scans a book that is
// switched on in one of four places (world-info.js):
//
//   1. Global select      selected_world_info[]                 (applies to all)
//   2. Chat-bound         chat_metadata.world_info              (this chat)
//   3. Character primary  character.data.extensions.world       (this card)
//   4. Character extra    world_info.charLore[…].extraBooks     (this card)
//
// A book that is in none of these is inert: MWT keeps writing entries and ST
// injects nothing, with no error anywhere. That is invisible on 'global' scope
// (the name never changes, so a book switched on once stays on), but 'character'
// and 'chat' scope mint a brand-new book name that is guaranteed inactive on
// creation. This probe reads all four slots so the tab can say, per book,
// whether ST will actually scan it.

/**
 * Read SillyTavern's world-info activation state for the CURRENT chat/character,
 * defensively and READ-ONLY. Every slot is read under its own guard; a fork
 * that lacks one export degrades that slot to "unreadable" rather than throwing.
 *
 * `detectable` means EVERY applicable slot was read. A book that is absent
 * from the readable slots can only be proved inactive when nothing was
 * missed, so as soon as any slot is unreadable (world-info.js not imported
 * yet, a fork without an export, a hostile accessor) the classifier reports
 * such books as 'unknown' rather than risk a false 'inactive'.
 *
 * @param {object} [deps]
 * @param {object} [deps.wiScript] — the world-info.js namespace (live export bindings)
 * @param {object} [deps.ctx] — SillyTavern context
 * @returns {{ detectable: boolean, globalReadable: boolean, chatReadable: boolean,
 *            charReadable: boolean, global: string[], chat: string|null,
 *            charPrimary: string|null, charAdditional: string[], note: string }}
 */
export function gatherActivationState({
    wiScript = knowledgeState?.wiScript,
    ctx = getContextSafe(),
} = {}) {
    const out = {
        detectable: false,
        globalReadable: false, chatReadable: false, charReadable: false,
        global: [], chat: null, charPrimary: null, charAdditional: [],
        note: '',
    };

    // 1. Global select — `selected_world_info` (a live binding on the namespace).
    try {
        const sel = wiScript?.selected_world_info;
        if (Array.isArray(sel)) {
            out.global = sel.filter((n) => typeof n === 'string');
            out.globalReadable = true;
        }
    } catch { /* fork without the export — leave unreadable */ }

    // 2. Chat-bound — `chat_metadata.world_info` (ST's METADATA_KEY === 'world_info').
    //    An open chat always has a chatMetadata object; the key simply being
    //    absent is a definite "not chat-bound", not an unreadable slot.
    try {
        const meta = ctx?.chatMetadata;
        if (meta && typeof meta === 'object') {
            const bound = meta.world_info;
            out.chat = (typeof bound === 'string' && bound) ? bound : null;
            out.chatReadable = true;
        }
    } catch { /* ignore */ }

    // 3 + 4. Character primary + additional — scoped to the CURRENT character.
    try {
        const chid = ctx?.characterId;
        const card = (chid !== null && chid !== undefined && Array.isArray(ctx?.characters))
            ? ctx.characters[chid]
            : null;
        if (card) {
            const primary = card?.data?.extensions?.world;
            out.charPrimary = (typeof primary === 'string' && primary) ? primary : null;
            // charLore keys on the avatar filename WITHOUT its extension — the
            // exact transform ST's getCharaFilename() applies.
            const fileName = String(card?.avatar || '').replace(/\.[^/.]+$/, '');
            const charLore = wiScript?.world_info?.charLore;
            if (fileName && Array.isArray(charLore)) {
                const entry = charLore.find((e) => e?.name === fileName);
                if (entry && Array.isArray(entry.extraBooks)) {
                    out.charAdditional = entry.extraBooks.filter((n) => typeof n === 'string');
                }
            }
            // Readable only NOW: every character source above (primary world,
            // avatar, charLore) has been read without throwing. Setting the
            // flag earlier left it stuck on `true` when a later accessor
            // threw, letting the classifier report a definite 'inactive'
            // from what was actually a partial read.
            out.charReadable = true;
        } else if (ctx && (ctx.groupId === null || ctx.groupId === undefined || ctx.groupId === '')) {
            // Context present, not a group, but no character resolved (no card
            // open): there is simply no character slot to read, which is a
            // definite "not character-bound" — mark it readable so a book that
            // is otherwise absent can be reported 'inactive', not 'unknown'.
            out.charReadable = true;
        }
    } catch { /* ignore */ }

    // Detection needs every slot: absence from the readable ones proves
    // inactivity only when nothing applicable was missed.
    out.detectable = out.globalReadable && out.chatReadable && out.charReadable;
    const unread = [];
    if (!out.globalReadable) unread.push('global selection');
    if (!out.chatReadable) unread.push('chat metadata');
    if (!out.charReadable) unread.push('character books');
    out.note = unread.length
        ? `Could not read: ${unread.join(', ')}. Books absent from the readable slots are reported "unknown", not inactive.`
        : 'All four world-info activation slots read successfully.';
    return out;
}

/**
 * Classify one resolved book name against the gathered activation state.
 *
 * @param {string} name — the resolved book name
 * @param {ReturnType<typeof gatherActivationState>} active
 * @param {{ injectable?: boolean }} [opts]
 * @returns {{ active: 'yes'|'no'|'unknown'|'n/a', activeIn: string[], note: string }}
 */
export function classifyBookActivation(name, active, { injectable = true } = {}) {
    if (injectable === false) {
        return {
            active: 'n/a',
            activeIn: [],
            note: 'Never injected — its entries carry no keywords, so World Info activation does not apply.',
        };
    }
    if (!name || name === '(unresolved)') {
        return { active: 'unknown', activeIn: [], note: 'Book name unresolved.' };
    }
    const a = active || {};
    const activeIn = [];
    if (Array.isArray(a.global) && a.global.includes(name)) activeIn.push('global selection');
    if (a.chat === name) activeIn.push('chat-bound');
    if (a.charPrimary === name) activeIn.push('character (primary)');
    if (Array.isArray(a.charAdditional) && a.charAdditional.includes(name)) activeIn.push('character (additional)');

    if (activeIn.length) {
        return { active: 'yes', activeIn, note: `ST will scan this book — switched on via ${activeIn.join(', ')}.` };
    }
    // Absence proves inactivity only when EVERY applicable slot was read: the
    // book may be active in a slot that could not be inspected, so a partial
    // read reports 'unknown' — never a false 'no'.
    const unread = [];
    if (!a.globalReadable) unread.push('global selection');
    if (!a.chatReadable) unread.push('chat');
    if (!a.charReadable) unread.push('character');
    if (unread.length) {
        return {
            active: 'unknown',
            activeIn: [],
            note: `Not found in the readable slots, but could not read: ${unread.join(', ')} — activation cannot be ruled out.`,
        };
    }
    return {
        active: 'no',
        activeIn: [],
        note: 'Not switched on in any World Info slot — ST will NOT inject its entries.',
    };
}

// ─── Storage meter (read-only) ────────────────────────────────────────────────
//
// Two sizes the tab used to leave to a console snippet: how full the browser's
// localStorage is (and how much of it is MWT's), and how big each MWT store in
// this chat's metadata is. Knowledge's Restore history once filled localStorage
// to the last character and new snapshots were dropped without a sound; the
// self-trimming exists now (knowledge/lorebook.js storeByTrimmingHistories),
// what was missing is a place to SEE the level.
//
// Sizes only, never values or individual key names: a history key embeds a
// lorebook name (a character name under per-character scope), so keys are
// counted into families and only the family label and totals leave this
// module — the Copy Report serializes exactly this.

/**
 * Approximate localStorage quota in characters. Browsers count the UTF-16
 * length of every key plus its value against a per-site limit near five
 * million characters (Chromium and Firefox ≈ 5.24M, jsdom exactly 5.00M).
 * There is no API that reports the real number, so the meter labels this an
 * estimate everywhere it appears.
 */
export const APPROX_LOCAL_STORAGE_QUOTA_CHARS = 5_000_000;

/** Fraction of the approximate quota at which the meter turns amber. */
export const LOCAL_STORAGE_WARN_RATIO = 0.9;

/** core/ui.js FLOAT_POSITIONS_KEY (module-private there; core/ui.js is a DOM
 * module this collector must not import). */
const FLOAT_POSITIONS_KEY = 'mwt_float_positions';

/** The global settings key (core/settings.js GLOBAL_SETTINGS_KEY). */
const GLOBAL_SETTINGS_KEY = 'merged_world_tracker';

/**
 * Settings keys of the three extensions MWT merged. createSettingsManager()
 * reads each once as `legacyKey` (chronicle/data.js, knowledge/settings.js,
 * world_state/settings.js) and migrates it, but never removes it — so they can
 * sit in storage indefinitely. A closed, historical set: no new legacy key can
 * appear.
 */
const LEGACY_SETTINGS_KEYS = Object.freeze([
    'session_chronicle_settings',
    'knowledge_tracker_settings',
    'world_state_settings',
]);

/**
 * MWT's localStorage key families, matched first-to-last (float positions
 * before the `mwt_` settings prefix). Every MWT localStorage writer lands in
 * one of these:
 *   - knowledge/lorebook.js pushHistory() and knowledge/staging.js's import
 *     both write `kt_history_<lorebook>_<uid>` keys;
 *   - core/settings.js createSettingsManager() writes `merged_world_tracker`
 *     and the per-module `mwt_<module>` keys ONLY when SillyTavern's
 *     extension_settings is unavailable (normally these are absent);
 *   - core/ui.js writes `mwt_float_positions`.
 * The settings rule is a prefix, like report.js collectKnownSecrets(), so a
 * module added later is counted without touching this list.
 */
export const LOCAL_STORAGE_FAMILIES = Object.freeze([
    {
        id: 'knowledgeHistory',
        label: '🧠 Knowledge Restore history',
        match: (key) => key.startsWith(HISTORY_KEY_PREFIX),
    },
    {
        id: 'floatPositions',
        label: '📍 Floating button positions',
        match: (key) => key === FLOAT_POSITIONS_KEY,
    },
    {
        id: 'settings',
        label: '⚙️ Settings (fallback copy)',
        match: (key) => key === GLOBAL_SETTINGS_KEY || key.startsWith('mwt_'),
    },
    {
        id: 'legacySettings',
        label: '🗄️ Old pre-merge settings',
        match: (key) => LEGACY_SETTINGS_KEYS.includes(key),
    },
]);

/** The non-MWT bucket's id (SillyTavern itself and every other extension). */
export const OTHER_STORAGE_FAMILY_ID = 'other';

/**
 * MWT chat-metadata keys that are not registry stores: the manifest,
 * quarantine container and context-budget record are MWT bookkeeping.
 * Calendar and Ambient predate their registration and are kept here as a
 * fallback — chatMetadataSizeSpecs() drops any key the registry already
 * covers, so they are measured through their registry rows while registered
 * and fall back to these rows if that ever changes. Any further
 * `mwt_`-prefixed key is summed into one "other MWT keys" row, so a key added
 * later is still counted.
 */
const EXTRA_CHAT_METADATA_KEYS = Object.freeze([
    { id: 'calendar', key: 'mwt_calendar' },
    { id: 'ambient', key: 'mwt_ambient' },
    { id: 'contextBudget', key: BUDGET_METADATA_KEY },
    { id: 'schemaManifest', key: MANIFEST_METADATA_KEY },
    { id: 'quarantine', key: QUARANTINE_METADATA_KEY },
]);

/**
 * Every named MWT chat-metadata row, in display order: the registry's
 * chat-metadata stores first, then the unregistered keys above.
 *
 * A key covered by the registry gets its registry row ONLY. The extras list
 * can name the same key (calendar and ambient above), and an undeduped pair
 * would render two rows while measureChatMetadata's by-key map routes the
 * measurement to just one of them, leaving the other forever absent/0.
 *
 * @returns {Array<{id: string, key: string, registered: boolean}>}
 */
export function chatMetadataSizeSpecs() {
    const registered = CHAT_METADATA_SCHEMA_IDS.map((id) => ({ id, key: STORE_SCHEMAS[id].metadataKey, registered: true }));
    const registeredKeys = new Set(registered.map((row) => row.key));
    return [
        ...registered,
        ...EXTRA_CHAT_METADATA_KEYS
            .filter((spec) => !registeredKeys.has(spec.key))
            .map((spec) => ({ ...spec, registered: false })),
    ];
}

/** @private Default localStorage accessor; the property itself can throw (a
 * browser blocking site data raises SecurityError on access). */
function defaultLocalStorage() {
    return globalThis.localStorage;
}

/** @private Default chat-metadata accessor. Reads the context field directly:
 * core/context.js getChatMeta() creates `chatMetadata` when it is missing,
 * and this collector must not write even in memory. */
function defaultChatMetadata() {
    return getContextSafe()?.chatMetadata;
}

/**
 * Measure localStorage and this chat's metadata (DOM-free, read-only).
 *
 * localStorage is walked with `length` / `key(i)` / `getItem()` only, and each
 * call is individually guarded: a key that cannot be read is counted as
 * unreadable (the totals then become a known minimum) without dropping the
 * rest. Each chat-metadata value is serialized under its own guard, so one
 * unserializable value degrades only its own row.
 *
 * Sizes are characters (UTF-16 code units), the unit browsers enforce the
 * localStorage quota in. Chat-metadata sizes are each value's JSON length.
 *
 * @param {object} [deps]
 * @param {function(): (Storage|undefined)} [deps.getLocalStorage]
 * @param {function(): (object|undefined)} [deps.getChatMetadata]
 * @param {number} [deps.approxQuotaChars]
 * @returns {{local: object, chatMetadata: object, errors?: string[]}}
 */
export function collectStorageSizes({
    getLocalStorage = defaultLocalStorage,
    getChatMetadata = defaultChatMetadata,
    approxQuotaChars = APPROX_LOCAL_STORAGE_QUOTA_CHARS,
} = {}) {
    const errors = [];
    const errText = (err) => String(err?.message || err);
    return {
        local: measureLocalStorage(getLocalStorage, approxQuotaChars, errors, errText),
        chatMetadata: measureChatMetadata(getChatMetadata, errors, errText),
        ...(errors.length ? { errors } : {}),
    };
}

/** @private */
function measureLocalStorage(getLocalStorage, approxQuotaChars, errors, errText) {
    const families = [
        ...LOCAL_STORAGE_FAMILIES.map((f) => ({ id: f.id, label: f.label, mwt: true, keys: 0, chars: 0 })),
        { id: OTHER_STORAGE_FAMILY_ID, label: 'Other (SillyTavern and other extensions)', mwt: false, keys: 0, chars: 0 },
    ];
    const out = {
        available: false,
        note: '',
        totalChars: null,
        keyCount: null,
        mwtChars: null,
        unreadableKeys: 0,
        approxQuotaChars,
        percentOfQuota: null,
        level: 'ok',
        warning: null,
        families,
    };

    let storage = null;
    try {
        storage = getLocalStorage();
    } catch (err) {
        errors.push(`localStorage: ${errText(err)}`);
    }
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.key !== 'function') {
        out.note = 'Browser storage could not be read here — the browser is blocking it for this site, or this environment has none.';
        return out;
    }

    let length = 0;
    try {
        length = Number(storage.length) || 0;
    } catch (err) {
        errors.push(`localStorage.length: ${errText(err)}`);
        out.note = 'Browser storage refused to report how many keys it holds.';
        return out;
    }

    const familyFor = (key) => {
        const index = LOCAL_STORAGE_FAMILIES.findIndex((f) => f.match(key));
        return families[index === -1 ? families.length - 1 : index];
    };
    let total = 0;
    let readable = 0;
    for (let i = 0; i < length; i++) {
        let key;
        let value;
        try {
            key = storage.key(i);
            if (typeof key !== 'string') throw new Error('no key at this index');
            value = storage.getItem(key);
        } catch {
            out.unreadableKeys++;
            continue;
        }
        const size = key.length + (typeof value === 'string' ? value.length : 0);
        const family = familyFor(key);
        family.keys++;
        family.chars += size;
        total += size;
        readable++;
    }
    if (out.unreadableKeys > 0) {
        errors.push(`localStorage: ${out.unreadableKeys} key(s) could not be read — totals are a minimum`);
    }

    out.available = true;
    out.totalChars = total;
    out.keyCount = readable;
    out.mwtChars = families.filter((f) => f.mwt).reduce((sum, f) => sum + f.chars, 0);
    out.percentOfQuota = approxQuotaChars > 0
        ? Math.round((total / approxQuotaChars) * 1000) / 10
        : null;
    if (approxQuotaChars > 0 && total >= approxQuotaChars * LOCAL_STORAGE_WARN_RATIO) {
        out.level = 'warn';
        out.warning = `Browser storage for this site is about ${Math.round((total / approxQuotaChars) * 100)}% of the approximate limit. When it fills, Knowledge removes the oldest Restore versions to make room (lorebook entries are not touched), and SillyTavern or other extensions may fail to save their own browser data.`;
    }
    return out;
}

/** @private */
function measureChatMetadata(getChatMetadata, errors, errText) {
    const specs = chatMetadataSizeSpecs();
    const rows = specs.map((spec) => ({ ...spec, present: false, chars: 0 }));
    const otherMwt = { id: 'otherMwt', keys: 0, chars: 0 };
    const other = { id: OTHER_STORAGE_FAMILY_ID, keys: 0, chars: 0 };
    const out = {
        available: false,
        note: '',
        rows,
        otherMwt,
        other,
        mwtChars: null,
        totalChars: null,
    };

    let meta;
    try {
        meta = getChatMetadata();
    } catch (err) {
        errors.push(`chatMetadata: ${errText(err)}`);
    }
    if (!meta || typeof meta !== 'object') {
        out.note = 'No chat is open, so there is no chat metadata to measure.';
        return out;
    }

    let keys = [];
    try {
        keys = Object.keys(meta);
    } catch (err) {
        errors.push(`chatMetadata keys: ${errText(err)}`);
        out.note = 'This chat\'s metadata could not be listed.';
        return out;
    }

    const rowByKey = new Map(rows.map((row) => [row.key, row]));
    for (const key of keys) {
        const row = rowByKey.get(key);
        let size;
        try {
            const value = meta[key];
            if (value === undefined) continue;
            // JSON.stringify returns undefined for functions/symbols — those
            // never reach the chat file, so they measure 0.
            size = JSON.stringify(value)?.length ?? 0;
        } catch (err) {
            if (row) {
                row.present = true;
                row.chars = null;
                errors.push(`chatMetadata[${key}]: ${errText(err)}`);
            } else {
                errors.push(`chatMetadata: a ${key.startsWith('mwt_') ? 'MWT' : 'non-MWT'} key could not be serialized`);
            }
            continue;
        }
        if (row) {
            row.present = true;
            row.chars = size;
        } else {
            const bucket = key.startsWith('mwt_') ? otherMwt : other;
            bucket.keys++;
            bucket.chars += size;
        }
    }

    out.available = true;
    out.mwtChars = rows.reduce((sum, row) => sum + (row.chars ?? 0), 0) + otherMwt.chars;
    out.totalChars = out.mwtChars + other.chars;
    return out;
}

// ─── Snapshot collector ───────────────────────────────────────────────────────

/**
 * Collect the Scope & storage snapshot (DOM-free, side-effect-free).
 *
 * @param {object} [deps] — every dependency injectable for the Node suite
 * @param {object} [deps.scopeApi] — { getCharacterIdentity, getChatIdentity }
 * @param {object} [deps.storeApi] — { peekStore }
 * @param {object} [deps.activationApi] — { gather } → gatherActivationState()
 * @param {function(): object} [deps.getKnowledgeSettings]
 * @param {function(): number} [deps.epoch]
 * @param {function(object=): object[]} [deps.events] — core/diagnostics getEvents
 * @param {string} [deps.version]
 * @param {number} [deps.currentStoreVersion]
 * @param {function(): number} [deps.now]
 * @param {object} [deps.storageApi] — { collect } → collectStorageSizes()
 * @returns {{generatedAt: number, mwtVersion: string, epoch: number,
 *   scopeSetting: {value: string, valid: boolean}, character: object|null,
 *   chat: object|null, resolution: object, books: Array<object>,
 *   activation: {detectable: boolean, globalReadable: boolean, chatReadable: boolean,
 *     charReadable: boolean, globalCount: number, note: string},
 *   bindings: {count: number, rows: Array<object>},
 *   fallbackEvents: {count: number, last: object|null},
 *   bannerLevel: 'ok'|'warn'|'fail', warnings: Array<object>,
 *   storage: {local: object, chatMetadata: object, errors?: string[]},
 *   errors?: string[]}}
 */
export function collectScopeSnapshot({
    scopeApi = { getCharacterIdentity, getChatIdentity },
    storeApi = { peekStore },
    activationApi = { gather: gatherActivationState },
    getKnowledgeSettings = getSettings,
    epoch = getEpoch,
    events = getEvents,
    version = MWT_VERSION,
    currentStoreVersion = STORE_VERSION,
    now = Date.now,
    storageApi = { collect: collectStorageSizes },
} = {}) {
    const errors = [];
    // Per-field guard (health.js pattern): one throwing accessor degrades its
    // own field and notes the failure — the tab must never blank.
    const call = (label, fn, fallback) => {
        try {
            const v = fn();
            return v === undefined ? fallback : v;
        } catch (err) {
            errors.push(`${label}: ${String(err?.message || err)}`);
            return fallback;
        }
    };

    // Settings snapshot — read ONCE, never written back. The read-only rule is
    // structural here: no saveSettings reference even exists in this module.
    const settings = call('settings', () => getKnowledgeSettings() || {}, {});
    const rawScope = settings?.scope;
    const bindings = (settings?.bookBindings && typeof settings.bookBindings === 'object')
        ? settings.bookBindings
        : {};

    const character = call('characterIdentity', () => scopeApi.getCharacterIdentity?.() ?? null, null);
    const chat = call('chatIdentity', () => scopeApi.getChatIdentity?.() ?? null, null);

    const resolution = call('resolution', () => explainBookResolution({
        scope: rawScope, character, chat, bindings,
    }), null) ?? {
        scope: 'global',
        valid: true,
        mode: 'global',
        identityKey: null,
        identityName: null,
        books: { ...GLOBAL_BOOK_NAMES },
        note: '(resolution explainer failed — see errors)',
        wouldSaveBinding: false,
    };

    // Books — hydration + store version per resolved name, via the read-only
    // peek. peekStore() distinguishes two states the tab must NOT conflate:
    //   null       → no cache slot at all: hydration has not been ATTEMPTED for
    //                this name. hydrateBook() creates the slot synchronously
    //                before its first await, so "no slot" can only mean
    //                not-yet-tried — normal early in a session, and guaranteed
    //                right after resetStoreCache() clears the cache on a chat
    //                change (knowledge/index.js reloadStores is fire-and-forget
    //                while index.js re-renders an open modal synchronously).
    //   { hydrated: false } → the slot exists and the load FAILED (no
    //                world-info.js, a load error, corrupt JSON). This is the
    //                state assertHydrated() blocks writes on.
    // Only the second is a fault. Reporting the first in red would paint
    // "writes are blocked" over a panel that is simply early.
    //
    // Activation is read ONCE for all three books — the four World Info slots
    // (see gatherActivationState) are the same regardless of which book we ask
    // about. Guarded like every other accessor so a probe failure degrades to
    // an undetectable state, never a blank tab.
    const activation = call('activation', () => activationApi.gather?.() ?? null, null) ?? {
        detectable: false, globalReadable: false, chatReadable: false, charReadable: false,
        global: [], chat: null, charPrimary: null, charAdditional: [],
        note: '(activation probe failed — see errors)',
    };

    const books = SCOPE_BOOK_SPECS.map((spec) => {
        const name = resolution.books?.[spec.nameKey];
        const peek = (spec.hasStore && name)
            ? call(`peekStore:${spec.id}`, () => storeApi.peekStore?.(name) ?? null, null)
            : null;
        const storeState = !spec.hasStore
            ? 'no-store'
            : (peek === null || peek === undefined
                ? 'not-attempted'
                : (peek.hydrated === true ? 'loaded' : 'failed'));
        const act = call(`activation:${spec.id}`,
            () => classifyBookActivation(name ?? '(unresolved)', activation, { injectable: spec.injectable !== false }),
            { active: 'unknown', activeIn: [], note: '' });
        return {
            id: spec.id,
            label: spec.label,
            name: name ?? '(unresolved)',
            hasStore: spec.hasStore,
            injectable: spec.injectable !== false,
            storeState,
            hydrated: peek?.hydrated === true,
            dirty: peek?.dirty === true,
            // A FAILED slot's `version` is the blank placeholder's — hydrateBook
            // never adopts a blocked source into the cache — so an on-disk v99
            // store would render "v1" beside its load-failed badge. The slot
            // preserves the version observed on disk at the failure
            // (peekStore's observedVersion, null when it could not be read);
            // that — or null — is what a failed book reports, matching the §9.1
            // schema-status collector so the two tables can never disagree.
            storeVersion: peek !== null && peek.hydrated !== true
                ? (typeof peek.observedVersion === 'number' ? peek.observedVersion : null)
                : (typeof peek?.version === 'number' ? peek.version : null),
            currentStoreVersion,
            active: act.active,
            activeIn: Array.isArray(act.activeIn) ? act.activeIn : [],
            activeNote: act.note ?? '',
        };
    });

    // Saved bindings — one row per stable identity key ever bound.
    const bindingRows = Object.entries(bindings)
        .map(([key, v]) => ({
            key,
            knowledge: v?.knowledge ?? null,
            state: v?.state ?? null,
            profiles: v?.profiles ?? null,
            isCurrent: key === resolution.identityKey,
        }));
    const bindingsInfo = { count: bindingRows.length, rows: bindingRows };

    // Phase 3's site-4 counter, read from the event ring: every
    // scope_fallback_global warn this session, newest first. The live
    // resolution above says what would happen NOW; these say what already DID
    // — including fallbacks on chats the user has since switched away from.
    const knowledgeEvents = call('events', () => events({ module: 'knowledge' }) || [], []);
    const fallbacks = (Array.isArray(knowledgeEvents) ? knowledgeEvents : [])
        .filter((e) => e?.event === 'scope_fallback_global');
    const fallbackEvents = {
        count: fallbacks.length,
        last: fallbacks[0]
            ? {
                ts: fallbacks[0].ts ?? null,
                epoch: fallbacks[0].epoch ?? null,
                scopeKey: fallbacks[0].scopeKey ?? null,
                scope: fallbacks[0].detail?.scope ?? null,
            }
            : null,
    };

    // Warnings drive the pane banner. Levels: 'fail' renders red (the state a
    // tester must act on), 'warn' amber (safe-but-silent recoveries this tab
    // exists to surface). Absence of both → the quiet 'ok' footnote.
    const warnings = [];
    if (resolution.mode === 'fallback-global') {
        warnings.push({
            id: 'scope-fallback-live',
            level: 'warn',
            text: `Scope is "${resolution.scope}" but the current ${resolution.scope} could not be identified — this chat is using the GLOBAL lorebooks right now. The classic "why is my data weird across chats" cause.`,
        });
    }
    if (resolution.mode === 'sanitize-fallback-global') {
        warnings.push({
            id: 'scope-name-unusable',
            level: 'warn',
            text: `This ${resolution.scope}'s name sanitises to nothing usable in a lorebook filename — the GLOBAL books are in use, deliberately unbound.`,
        });
    }
    if (resolution.mode === 'collision-refused') {
        warnings.push({
            id: 'scope-name-collision',
            level: 'fail',
            text: resolution.note,
        });
    }
    if (fallbackEvents.count > 0) {
        const last = fallbackEvents.last;
        warnings.push({
            id: 'scope-fallback-events',
            level: 'warn',
            text: `Scope fell back to the global books ${fallbackEvents.count}× this session (scope_fallback_global warns)${last?.epoch != null ? ` — last at epoch ${last.epoch}` : ''}${last?.ts != null ? `, ${new Date(last.ts).toLocaleTimeString()}` : ''}. Check the identity rows below for which lookup came back absent.`,
        });
    }
    if (resolution.valid === false && resolution.mode === 'global') {
        warnings.push({
            id: 'scope-setting-invalid',
            level: 'warn',
            text: `The Knowledge scope setting is invalid ("${String(rawScope)}") and is being treated as 'global'.`,
        });
    }
    // The Knowledge store gets TWO distinct findings, because "not loaded"
    // has two very different causes (see the storeState comment above).
    const knowledgeBook = books.find((b) => b.id === 'knowledge');
    if (knowledgeBook?.storeState === 'failed') {
        warnings.push({
            id: 'knowledge-store-load-failed',
            level: 'fail',
            text: `The Knowledge store for "${knowledgeBook.name}" was loaded and FAILED, so creating entries is blocked (deliberate — it prevents duplicate entries). Look for an earlier store-load error in the console: a missing world-info.js, an unreadable book, or corrupt store JSON.`,
        });
    } else if (knowledgeBook?.storeState === 'not-attempted') {
        warnings.push({
            id: 'knowledge-store-not-attempted',
            level: 'warn',
            text: `The Knowledge store for "${knowledgeBook.name}" has not been loaded yet this session. Hydration runs on chat change and is asynchronous, so this is expected right after a reload or a chat switch — re-open this tab in a moment. If it persists, writes stay blocked and the console will carry the reason.`,
        });
    }

    const mismatched = books.filter((b) => b.hasStore && b.hydrated && b.storeVersion != null && b.storeVersion !== currentStoreVersion);
    if (mismatched.length > 0) {
        warnings.push({
            id: 'store-version-mismatch',
            level: 'warn',
            text: `Store version mismatch: ${mismatched.map((b) => `"${b.name}" is v${b.storeVersion}, code expects v${b.currentStoreVersion}`).join('; ')}. Data still reads; a migration is pending.`,
        });
    }

    // World Info activation — the silent-injection gap. MWT creates a book file
    // but never switches it on in ST; an inactive injectable book means the
    // tracker keeps writing and ST scans nothing, with no error. The Knowledge
    // book is the documented keyword-injection path, so an inactive one is
    // always worth surfacing. The State book is user-created, so only flag it
    // once its store is loaded (the book is real and MWT is using it) — that
    // avoids a false alarm for users who never set up state trackers.
    if (knowledgeBook?.injectable && knowledgeBook.active === 'no') {
        warnings.push({
            id: 'knowledge-book-inactive',
            level: 'warn',
            text: `The Knowledge Tracker book "${knowledgeBook.name}" is NOT switched on in SillyTavern's World Info — not in the global selection, this chat's bound book, or the character's books. MWT keeps writing NPC entries to it, but ST will not inject them until the book is activated. Enable it in the World Info panel, or turn on "Switch the Knowledge Tracker lorebook on automatically" in Knowledge → Settings and MWT will claim this chat's slot itself (per-character and per-chat scope each mint a new book that starts inactive).`,
        });
    }
    const stateBook = books.find((b) => b.id === 'state');
    if (stateBook?.injectable && stateBook.active === 'no' && stateBook.storeState === 'loaded') {
        warnings.push({
            id: 'state-book-inactive',
            level: 'warn',
            text: `The State Tracker book "${stateBook.name}" is NOT switched on in SillyTavern's World Info. MWT still updates its tracker entries, but ST will not inject them until the book is activated in the World Info panel, or you turn on the State Tracker auto-activation toggle in Knowledge → Settings.`,
        });
    }

    const bannerLevel = warnings.some((w) => w.level === 'fail')
        ? 'fail'
        : (warnings.length > 0 ? 'warn' : 'ok');

    // Storage meter — sizes only. Its level and degraded fields stay inside
    // `storage` (rendered in its own section) rather than joining the
    // lorebook-resolution banner above, which answers a different question.
    // collectStorageSizes() guards each of its own reads; this outer guard is
    // only for an injected collector that throws outright.
    const storage = call('storage', () => storageApi.collect?.() ?? null, null) ?? {
        local: {
            available: false, note: '(storage probe failed — see errors)',
            totalChars: null, keyCount: null, mwtChars: null, unreadableKeys: 0,
            approxQuotaChars: APPROX_LOCAL_STORAGE_QUOTA_CHARS, percentOfQuota: null,
            level: 'ok', warning: null, families: [],
        },
        chatMetadata: {
            available: false, note: '(storage probe failed — see errors)',
            rows: [], otherMwt: { id: 'otherMwt', keys: 0, chars: 0 },
            other: { id: OTHER_STORAGE_FAMILY_ID, keys: 0, chars: 0 },
            mwtChars: null, totalChars: null,
        },
    };

    return {
        generatedAt: now(),
        mwtVersion: version,
        // Guarded like every other accessor: getEpoch() is trivial today, but
        // the collector's contract is that NO single dependency can blank the
        // tab, and an unguarded call in the return statement is exactly the
        // hole that let a hostile getter take down the Environment snapshot.
        epoch: call('epoch', () => (typeof epoch === 'function' ? epoch() : null), null),
        scopeSetting: { value: resolution.scope, valid: resolution.valid === true },
        character,
        chat,
        resolution,
        books,
        activation: {
            detectable: activation.detectable === true,
            globalReadable: activation.globalReadable === true,
            chatReadable: activation.chatReadable === true,
            charReadable: activation.charReadable === true,
            globalCount: Array.isArray(activation.global) ? activation.global.length : 0,
            note: activation.note ?? '',
        },
        bindings: bindingsInfo,
        fallbackEvents,
        bannerLevel,
        warnings,
        storage,
        ...(errors.length ? { errors } : {}),
    };
}
