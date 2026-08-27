/**
 * story_planner/data.js — Shared constants, mutable state, and data access.
 *
 * Leaf module — no imports from other story_planner modules except its pure
 * schema owner (./schema.js).
 *
 * The plan is stored as an array of structured arc objects (see ARC SHAPE in
 * ./schema.js) rather than one opaque blob of text. Plans authored before that
 * change are migrated by the schema's v0 -> v1 migration; the lazy on-read
 * conversion in {@link getArcs} remains only as a temporary compatibility
 * path until the runtime cutover (Part 6 of the schema plan).
 *
 * Arc canonicalization (sanitizeArc/sanitizeArcs), the section/status
 * vocabulary, the arc-id factory, the beat-index clamp, and the markdown plan
 * parser moved to ./schema.js (Parts 1–2 of the schema-validation plan) so
 * writes, loads, backup imports, and history restores retain one owner. They
 * are re-exported below so every existing importer of data.js keeps working
 * unchanged.
 */

import { getChatMeta, persistChatMeta, preserveQuarantinedRecords } from '../core/index.js';
import { getSettings, saveSettings } from './settings.js';
import { prepareNextStoreValue } from '../core/schema.js';
import {
    SECTIONS,
    DEFAULT_SECTION,
    ARC_STATUSES,
    SECTION_KEYS,
    MAX_ARC_TITLE,
    MAX_ARC_BODY,
    MAX_BEAT_LENGTH,
    clampBeatIndex,
    newArcId,
    parsePlanTextToArcs,
    sanitizeArc,
    sanitizeArcs,
    sectionKeyFromLabel,
    storyPlannerSchema,
} from './schema.js';

export { SECTIONS, DEFAULT_SECTION, ARC_STATUSES, SECTION_KEYS, newArcId, parsePlanTextToArcs, sanitizeArc, sanitizeArcs, sectionKeyFromLabel };

// ─── Constants ───────────────────────────────────────────────────────────────

export const CHAT_DATA_KEY = 'story_planner_data';
export const EXTENSION_PROMPT_KEY = 'mwt_story_plan_injection';

// SECTIONS / DEFAULT_SECTION / ARC_STATUSES are owned by ./schema.js and
// re-exported at the top of this file.

/** Injection modes — mirrors chronicle's injectMode switch. */
export const INJECT_MODES = [
    { key: 'all', label: 'All', blurb: 'Inject every arc that is not dropped' },
    { key: 'pinned', label: 'Pinned', blurb: 'Inject only arcs you have pinned' },
    { key: 'active', label: 'Active', blurb: 'Inject only arcs still marked active' },
];

/**
 * How hard the narrator is pushed to act on the plan. Mirrors world_state's
 * hookMode (passive/proactive/assertive).
 *
 * Default is 'proactive', not 'passive': testing showed cautious models read
 * passive phrasing as standing permission to defer indefinitely.
 */
export const ENFORCEMENT_MODES = [
    { key: 'passive', label: 'Passive', blurb: 'Only plant a beat when a natural opening appears' },
    { key: 'proactive', label: 'Proactive', blurb: 'Steer scenes toward an opening instead of waiting for one' },
    { key: 'assertive', label: 'Assertive', blurb: 'Advance an arc every response; create the opening if needed' },
];

/**
 * Turns a beat may sit as CURRENT before it is treated as overdue.
 *
 * ONE OWNER: the injection's "still waiting after N turns" nudge, the amber
 * badge on the arc card, and the user-facing reminder all read this. It used to
 * be a const in injection.js duplicated as a bare `12` in render.js — two
 * sources for one number is exactly the drift SECTIONS exists to prevent.
 */
export const OVERDUE_TURNS = 12;

// ─── Mutable shared state ────────────────────────────────────────────────────

export const state = {
    /** @type {HTMLElement|null} Parent modal element */
    modal: null,
    /** @type {HTMLElement|null} Cached story-planner-tab content element */
    contentEl: null,
    /** True while a generation is in flight */
    isGenerating: false,
    /** Auto-trigger countdown (messages since last plan generation) */
    autoCounter: 0,
    /** Last persisted chat length, used by onMessageDeleted */
    lastChatLength: 0,
    /** Counted receipt events by stable message identity. */
    countedReceiptEvents: new Map(),
    /**
     * STORY-PLANNER-03: Single cancellable auto-generate timer.
     *
     * Every qualifying MESSAGE_RECEIVED previously called setTimeout
     * independently — timers raced, and a rejected run had already reset the
     * counter. Storing one timer here lets us clear the previous one before
     * scheduling a new one, so cadence stays aligned and chat-switch /
     * generation-busy cancels are guaranteed to catch it.
     */
    autoTimer: null,
};

// ─── Chat data helpers ───────────────────────────────────────────────────────

export function getPlanData() {
    const meta = getChatMeta();
    return meta?.[CHAT_DATA_KEY] || {};
}

/**
 * The Story Planner write seam (design §8, Part 3): the COMPLETE proposed next
 * store — current data with the patch applied — is validated by the registered
 * storyPlanner schema before anything is persisted. The write either commits
 * CANONICAL data (a non-canonical arc or container quarantined out of the
 * live value, its issue reported) or, on a fatal root problem, leaves the
 * previous value intact. The canonical result REPLACES the stored value (a
 * merge would resurrect a container the validator just rejected).
 */
export function setPlanData(patch) {
    const meta = getChatMeta();
    if (!meta) return undefined;
    const next = prepareNextStoreValue(storyPlannerSchema, meta[CHAT_DATA_KEY], patch);
    if (!next.ok) {
        console.warn('[MWT:StoryPlanner] Write refused — the proposed update failed schema validation; the previous value was kept.', next.issues);
        return meta[CHAT_DATA_KEY];
    }
    for (const issue of next.issues) {
        console.warn(`[MWT:StoryPlanner] ${issue.severity}: ${issue.message}`);
    }
    // §5.2: the canonical write is only allowed to commit if its rejected
    // records were preserved. A refused quarantine container means they cannot
    // be — leave the previous value intact instead.
    const preserved = preserveQuarantinedRecords(storyPlannerSchema.id, next.issues, { sourceVersion: storyPlannerSchema.currentVersion });
    if (!preserved.ok) {
        console.warn(`[MWT:StoryPlanner] Write refused — quarantined records could not be preserved (${preserved.reason}); the previous value was kept.`);
        return meta[CHAT_DATA_KEY];
    }
    meta[CHAT_DATA_KEY] = next.data;
    persistChatMeta();
    return next.data;
}

// Exported (Phase 4 diagnostics, §I.4.6) so the settings-provenance surfaces
// iterate the single source of truth instead of a second key list. Mirrors
// world_state/data.js's GLOBAL_SETTING_KEYS.
export const GLOBAL_SETTING_KEYS = ['injectMode', 'enforcement', 'arcCount', 'autoInterval', 'injectEnabled', 'autoEnabled'];

// Historical per-chat defaults. Legacy records may contain only settings the
// user changed, so missing keys must not inherit later global changes.
const LEGACY_LOCAL_DEFAULTS = {
    injectMode: 'all', enforcement: 'proactive', arcCount: 10,
    autoInterval: 10, injectEnabled: true, autoEnabled: false,
};

export function usesGlobalDefaults() {
    const data = getPlanData();
    if (typeof data.useGlobalDefaults === 'boolean') return data.useGlobalDefaults;
    return !GLOBAL_SETTING_KEYS.some(key => Object.prototype.hasOwnProperty.call(data, key));
}

export function setUsesGlobalDefaults(useGlobal) {
    if (useGlobal === true) {
        setPlanData({ useGlobalDefaults: true });
        return;
    }
    // This only ever fires while the chat is currently on global defaults (the
    // checkbox can't be unchecked from an already-unchecked state), so the
    // snapshot must come from what's live right now — not from a stale
    // settingsOverride left by an earlier local session, or a stale top-level
    // field left by a pre-this-feature per-chat record. Preferring either of
    // those would silently resurrect a value the user isn't currently seeing.
    const globalSettings = getSettings();
    const overrides = {};
    for (const key of GLOBAL_SETTING_KEYS) {
        overrides[key] = globalSettings[key] ?? LEGACY_LOCAL_DEFAULTS[key];
    }
    setPlanData({ useGlobalDefaults: false, settingsOverride: overrides });
}

/**
 * Resolve a planner setting through the 3-level chain: per-chat override →
 * legacy top-level chat field → global (see usesGlobalDefaults).
 *
 * Phase 4 provenance (diagnostics design §I.4.6 — World State / Story Planner
 * share this chain): pass `{ provenance: true }` to get `{ value, source }`
 * instead of the bare value. Source strings are documented on world_state's
 * getEffectiveWorldSetting and are identical here.
 *
 * @param {string} key
 * @param {*} [fallback]
 * @param {{ provenance?: boolean }} [opts]
 * @returns {*|{ value: *, source: string }}
 */
export function getEffectivePlanSetting(key, fallback, { provenance = false } = {}) {
    const data = getPlanData();
    if (!usesGlobalDefaults()) {
        const override = data.settingsOverride?.[key];
        if (override !== undefined) {
            return provenance ? { value: override, source: 'per-chat-override' } : override;
        }
        if (data[key] !== undefined) {
            return provenance ? { value: data[key], source: 'per-chat-legacy' } : data[key];
        }
        const builtin = LEGACY_LOCAL_DEFAULTS[key];
        if (builtin != null) {
            return provenance ? { value: builtin, source: 'builtin-default' } : builtin;
        }
        return provenance ? { value: fallback, source: 'fallback' } : fallback;
    }
    const global = getSettings()[key];
    if (global != null) {
        return provenance ? { value: global, source: 'global' } : global;
    }
    return provenance ? { value: fallback, source: 'fallback' } : fallback;
}

export function setPlanSetting(key, value) {
    if (usesGlobalDefaults()) saveSettings({ [key]: value });
    else setPlanData({ settingsOverride: { ...(getPlanData().settingsOverride || {}), [key]: value } });
}

// ─── Arc identity ────────────────────────────────────────────────────────────

// newArcId() is owned by ./schema.js and re-exported at the top of this file.

export function makeArc(partial = {}) {
    // STORY-PLANNER-04/-09: Route every arc creation through the single
    // sanitizer so makeArc can never return a non-canonical arc. Direct
    // callers (addArc, parsePlanTextToArcs/migration, import) used to bypass
    // validation, so a pasted or migrated arc could carry unbounded
    // title/body/beats, non-number beatIndex, non-boolean pinned, NaN
    // counters, or foreign keys. preserveId:false mints a fresh id.
    return sanitizeArc(partial, { preserveId: false });
}

// clampBeatIndex() is owned by ./schema.js (see ARC SHAPE there).


// ─── Beat progression ────────────────────────────────────────────────────────

/** An arc whose beats are all planted — setup is done, it can now happen. */
export function isArcReady(arc) {
    const total = arc?.beats?.length || 0;
    return total > 0 && (arc.beatIndex || 0) >= total;
}

/** The single beat the narrator should be working on. '' when none/ready. */
export function getCurrentBeat(arc) {
    const beats = arc?.beats || [];
    if (!beats.length) return '';
    const idx = arc.beatIndex || 0;
    return idx < beats.length ? beats[idx] : '';
}

/** Mark the current beat planted and move to the next (or to READY). */
export function advanceBeat(id) {
    const arc = getArcs().find(a => a.id === id);
    if (!arc) return null;
    const total = arc.beats?.length || 0;
    if (total === 0 || (arc.beatIndex || 0) >= total) return arc;
    return updateArc(id, { beatIndex: (arc.beatIndex || 0) + 1, turnsSinceAdvance: 0 });
}

/** Step back a beat — for when a beat was marked planted by mistake. */
export function retreatBeat(id) {
    const arc = getArcs().find(a => a.id === id);
    if (!arc) return null;
    if ((arc.beatIndex || 0) <= 0) return arc;
    return updateArc(id, { beatIndex: (arc.beatIndex || 0) - 1, turnsSinceAdvance: 0 });
}

/**
 * Age every arc by one turn. Called on each received message.
 *
 * Mirrors interiority's incrementLedgerAges(). The count is advisory context
 * for the narrator ("6 turns on this beat" reads as overdue), not a value
 * anything branches on — so message deletion deliberately does not rewind it.
 */
export function incrementArcTurns() {
    const arcs = getArcs();
    if (!arcs.length) return false;
    let changed = false;
    const next = arcs.map(a => {
        if (a.status !== 'active') return a;
        changed = true;
        return { ...a, turnsSinceAdvance: (a.turnsSinceAdvance || 0) + 1 };
    });
    if (changed) setArcs(next);
    // Reported so the caller can re-apply the injection. The injected payload is
    // a snapshot string (core/injection.js hands it to setExtensionPrompt), so
    // an age that changes without a re-apply never reaches the model.
    return changed;
}

/**
 * Active arcs currently waiting on a specific beat — the ones a user could
 * plausibly mark planted right now.
 *
 * Excludes ready arcs (no current beat left) and Immediate Hooks (no beats at
 * all), so the count means "things you can action", not "arcs you have".
 */
export function getArcsAwaitingBeat() {
    return getArcs().filter(a =>
        a.status === 'active' && !isArcReady(a) && !!getCurrentBeat(a),
    );
}

/**
 * Arcs whose current beat has been waiting long enough to be worth a reminder.
 * Sorted longest-waiting first so a truncated list shows the worst offenders.
 */
export function getOverdueArcs(threshold = getNudgeTurns()) {
    return getArcsAwaitingBeat()
        .filter(a => (a.turnsSinceAdvance || 0) >= threshold)
        .sort((x, y) => (y.turnsSinceAdvance || 0) - (x.turnsSinceAdvance || 0));
}

// ─── Parsing / serialising ───────────────────────────────────────────────────
//
// The markdown PARSER (normaliseLabel/LABEL_TO_KEY/sectionKeyFromLabel,
// cleanBulletContent/cleanBeatContent/splitTitleBody/stripArcFlags, and
// parsePlanTextToArcs) moved to ./schema.js in Part 2 of the schema plan —
// the v0 -> v1 migration parses legacy plan text with the same rules fresh
// LLM responses go through, so both live with the schema owner. This module
// re-exports them unchanged at the top of the file.

export function getSectionMeta(key) {
    return SECTIONS.find(s => s.key === key) || SECTIONS.find(s => s.key === DEFAULT_SECTION);
}

/**
 * Render arcs back to the markdown document shape.
 *
 * Used for the injected body, the `{{previousPlan}}` block, the `{{storyplan}}`
 * macro, and the History/Revert diff views — so all four stay identical.
 *
 * @param {object[]} arcs
 * @param {object}  [opts]
 * @param {boolean} [opts.annotateStatus] mark non-active arcs (for the model)
 */
export function serializeArcsToText(arcs, { annotateStatus = false, beats = 'all' } = {}) {
    const list = Array.isArray(arcs) ? arcs : [];
    const out = [];
    for (const sec of SECTIONS) {
        const inSection = list.filter(a => a.section === sec.key);
        if (inSection.length === 0) continue;
        out.push(`## ${sec.label}`);
        for (const arc of inSection) {
            const flags = [];
            if (annotateStatus && arc.status !== 'active') flags.push(arc.status.toUpperCase());
            if (annotateStatus && arc.pinned) flags.push('PINNED');
            if (annotateStatus && isArcReady(arc)) flags.push('SETUP COMPLETE');
            const flag = flags.length ? ` [${flags.join(', ')}]` : '';
            const title = arc.title || '(untitled arc)';
            out.push(arc.body ? `- ${title}${flag} — ${arc.body}` : `- ${title}${flag}`);

            if (beats === 'all' && arc.beats?.length) {
                arc.beats.forEach((beat, i) => {
                    // Progress markers matter on regeneration: without them the
                    // model happily re-proposes setup the story already planted.
                    let mark = '';
                    if (annotateStatus) {
                        if (i < (arc.beatIndex || 0)) mark = ' [PLANTED]';
                        else if (i === (arc.beatIndex || 0)) mark = ' [CURRENT]';
                    }
                    out.push(`  ${i + 1}. ${beat}${mark}`);
                });
            }
        }
        out.push('');
    }
    return out.join('\n').trim();
}

// ─── Regeneration merge ──────────────────────────────────────────────────────

/**
 * Loose title key for matching a regenerated arc to the one it replaces.
 *
 * STORY-PLANNER-05: The previous implementation stripped ALL non-alphanumeric
 * characters (`/[^a-z0-9]/g`), so titles that differ only in punctuation
 * collided — `"A/B"` and `"AB"` became the same key, and progress from one
 * arc transferred to an unrelated arc during regeneration. We now preserve
 * meaningful structural punctuation (slash, colon, dash, parentheses, quote
 * marks) while still normalizing whitespace and case. Only cosmetic
 * punctuation (periods, commas, exclamation marks, etc.) is stripped.
 */
function titleKey(title) {
    return String(title || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
        // Strip ONLY cosmetic punctuation, not structural delimiters.
        // Preserved: / : - ( ) ' " — anything that distinguishes titles.
        .replace(/[.!?,;_*#]/g, '');
}

/**
 * Merge a freshly generated arc list into the existing one.
 *
 * Regeneration used to REPLACE every non-pinned arc, which quietly reset every
 * arc to a new id with zero progress — so nothing the narrator planted could
 * ever accumulate. Progress is the whole point of beats, so identity has to
 * survive a regenerate.
 *
 * Rules:
 *  - Same (normalised) title as an existing arc → keep its id, beatIndex,
 *    pinned, status and age; take the model's refreshed body/section/beats.
 *  - Existing arc the model dropped → discarded, UNLESS it is pinned or has
 *    beats already planted. Losing an in-progress arc is exactly the bug.
 *  - Everything else the model returned → added as new.
 *
 * @param {object[]} previous existing arcs
 * @param {object[]} incoming freshly parsed arcs
 * @returns {{arcs: object[], carried: number, matched: number, added: number}}
 */
export function mergeRegeneratedArcs(previous, incoming) {
    const prev = Array.isArray(previous) ? previous : [];
    const next = Array.isArray(incoming) ? incoming : [];

    const byTitle = new Map();
    for (const arc of prev) {
        const key = titleKey(arc.title);
        if (key && !byTitle.has(key)) byTitle.set(key, arc);
    }

    const consumed = new Set();
    let matched = 0;
    const merged = next.map(fresh => {
        const key = titleKey(fresh.title);
        const old = key ? byTitle.get(key) : null;
        if (!old || consumed.has(old.id)) return fresh;
        consumed.add(old.id);
        matched++;
        const beats = fresh.beats?.length ? fresh.beats : (old.beats || []);
        return {
            ...fresh,
            id: old.id,
            pinned: old.pinned,
            status: old.status,
            createdAt: old.createdAt,
            beats,
            // The model may have rewritten the beat list; clamp rather than
            // reset, so partially-planted setup is not re-proposed from zero.
            beatIndex: clampBeatIndex(old.beatIndex, beats.length),
            turnsSinceAdvance: old.turnsSinceAdvance || 0,
            updatedAt: Date.now(),
        };
    });

    // Arcs the model dropped but that we refuse to lose.
    const carried = prev.filter(a =>
        !consumed.has(a.id)
        && a.status !== 'dropped'
        && (a.pinned || (a.beatIndex || 0) > 0),
    );

    return {
        arcs: [...carried, ...merged],
        carried: carried.length,
        matched,
        added: merged.length - matched,
    };
}

// ─── Arc access + migration ──────────────────────────────────────────────────

/**
 * Read the arc list, migrating a legacy single-blob plan on first access.
 *
 * Mirrors the lazy-migration precedent in chronicle/data.js (legacy snapshot id
 * backfill on read). The old `text` field is deliberately left in place rather
 * than deleted — the migration is a parse, and keeping the original means a bad
 * parse is recoverable instead of destructive.
 */
export function getArcs() {
    const data = getPlanData();
    if (Array.isArray(data.arcs)) return data.arcs;

    const legacy = typeof data.text === 'string' ? data.text : '';
    if (!legacy.trim()) return [];

    const migrated = parsePlanTextToArcs(legacy);
    if (migrated.length === 0) return [];
    setPlanData({ arcs: migrated, _migratedFromText: true });
    console.log(`[MWT:StoryPlanner] Migrated legacy plan → ${migrated.length} arcs (original text retained).`);
    return migrated;
}

export function setArcs(arcs) {
    // STORY-PLANNER-09: Sanitize every arc so history restore / import cannot
    // persist non-canonical arcs that later can't be removed.
    setPlanData({ arcs: sanitizeArcs(arcs) });
}

/** Full plan as markdown — used by the `{{storyplan}}` macro and diff views. */
export function getPlanText() {
    return serializeArcsToText(getArcs());
}

// ─── Arc CRUD ────────────────────────────────────────────────────────────────

export function addArc(partial = {}) {
    const arc = makeArc(partial);
    setArcs([...getArcs(), arc]);
    return arc;
}

export function updateArc(id, patch = {}) {
    const arcs = getArcs();
    const idx = arcs.findIndex(a => a.id === id);
    if (idx === -1) return null;
    // STORY-PLANNER-04: Validate patch fields rather than blindly spreading.
    // An arbitrary patch could inject unbounded title/body/beats, non-number
    // beatIndex, non-boolean pinned, NaN counters, or foreign keys. The spread
    // is now followed by per-field clamping/coercion, and setArcs() runs the
    // full sanitizer as the final safety net.
    const base = arcs[idx];
    const merged = { ...base, ...patch, id: base.id, updatedAt: Date.now() };
    // Clamp/clean the mutable fields a patch may set.
    merged.title = String(merged.title ?? '').trim().slice(0, MAX_ARC_TITLE);
    merged.body = String(merged.body ?? '').trim().slice(0, MAX_ARC_BODY);
    merged.beats = Array.isArray(merged.beats)
        ? merged.beats.map(b => String(b ?? '').trim().slice(0, MAX_BEAT_LENGTH)).filter(Boolean)
        : base.beats;
    merged.beatIndex = clampBeatIndex(merged.beatIndex, merged.beats.length);
    merged.pinned = merged.pinned === true;
    merged.turnsSinceAdvance = Number.isFinite(Number(merged.turnsSinceAdvance))
        ? Math.max(0, Math.floor(Number(merged.turnsSinceAdvance)))
        : (base.turnsSinceAdvance || 0);
    if (!SECTION_KEYS.has(merged.section)) merged.section = DEFAULT_SECTION;
    if (!ARC_STATUSES.includes(merged.status)) merged.status = 'active';
    const copy = [...arcs];
    copy[idx] = merged;
    setArcs(copy);
    return merged;
}

export function removeArc(id) {
    const arcs = getArcs();
    const remaining = arcs.filter(a => a.id !== id);
    if (remaining.length === arcs.length) return false;
    setArcs(remaining);
    // STORY-PLANNER-08: clear this arc's nudge marks immediately rather than
    // waiting for takeDueNudges() to reconcile them lazily on its next call.
    cleanNudgeMarksForArc(id);
    return true;
}

export function setArcStatus(id, status) {
    const next = ARC_STATUSES.includes(status) ? status : 'active';
    const arc = getArcs().find(a => a.id === id);
    if (!arc) return null;
    // STORY-PLANNER-08: Reactivating a resolved/dropped arc starts its beat-age
    // countdown over — the old turnsSinceAdvance and nudge high-water mark
    // belong to the arc's previous life and would otherwise suppress or
    // mis-time the next reminder. Clearing marks on resolve/drop too means a
    // stale high-water mark never lingers in metadata.
    const patch = { status: next };
    if (next === 'active' && arc.status !== 'active') patch.turnsSinceAdvance = 0;
    const updated = updateArc(id, patch);
    if (arc.status !== next) cleanNudgeMarksForArc(id);
    return updated;
}

export function toggleArcPinned(id) {
    const arc = getArcs().find(a => a.id === id);
    if (!arc) return null;
    return updateArc(id, { pinned: !arc.pinned });
}

// ─── Injection mode / steering settings (global defaults or chat override) ────

export function getInjectMode() {
    const mode = getEffectivePlanSetting('injectMode', 'all');
    return INJECT_MODES.some(m => m.key === mode) ? mode : 'all';
}

export function getEnforcement() {
    const mode = getEffectivePlanSetting('enforcement', 'proactive');
    return ENFORCEMENT_MODES.some(m => m.key === mode) ? mode : 'proactive';
}

export function getDirectionHint() {
    return getPlanData().directionHint || '';
}

export function getArcCount() {
    const v = Number(getEffectivePlanSetting('arcCount', 10));
    return Number.isFinite(v) ? Math.min(30, Math.max(3, v)) : 10;
}

// ─── Beat reminders (zero-API progress tracking) ─────────────────────────────

/** Turns a beat waits before the user is reminded to check on it. */
export function getNudgeTurns() {
    const v = Number(getPlanData().nudgeTurns);
    return Number.isFinite(v) ? Math.min(60, Math.max(3, v)) : OVERDUE_TURNS;
}

export function isNudgeEnabled() {
    return getPlanData().nudgeEnabled !== false;
}

/**
 * STORY-PLANNER-08: Remove every nudge mark belonging to an arc id.
 *
 * Marks are keyed `arcId#beatIndex`. `removeArc()` and `setArcStatus()` used to
 * leave the corresponding marks behind; `takeDueNudges()` only reconciles them
 * lazily on its next call. In the meantime a reopened arc would inherit its old
 * beat-age high-water mark and the reminder the feature exists to fire would be
 * suppressed — the silent stall this feature was built to prevent. Clearing the
 * marks immediately on any arc ID/beat transition keeps metadata honest.
 */
function cleanNudgeMarksForArc(arcId) {
    if (!arcId) return;
    const stored = getPlanData().nudgeMarks;
    if (!stored || typeof stored !== 'object') return;
    let changed = false;
    const marks = { ...stored };
    for (const key of Object.keys(marks)) {
        // Marks use the `arcId#beatIndex` composite key (see takeDueNudges).
        // Arc ids never contain '#', so this prefix match is unambiguous.
        if (key.startsWith(`${arcId}#`)) {
            delete marks[key];
            changed = true;
        }
    }
    if (changed) setPlanData({ nudgeMarks: marks });
}

/**
 * Arcs due for a reminder right now, recording that they were reminded.
 *
 * NOT a pure query — it writes the nudge marks, so call it once per turn from
 * the message hook and nowhere else. Use {@link getOverdueArcs} for display.
 *
 * An arc nudges each time its wait crosses another multiple of the threshold
 * (12, 24, 36 turns…). Nudging once and never again lets an ignored beat stall
 * silently, which is the failure this whole feature exists to prevent; nudging
 * every turn once overdue is spam the user would rightly disable. Crossing a
 * multiple repeats at a rate that stays proportionate to how stale the beat is.
 *
 * @returns {object[]} arcs to remind about (empty when nothing is due)
 */
export function takeDueNudges() {
    if (!isNudgeEnabled()) return [];
    const threshold = getNudgeTurns();
    const stored = getPlanData().nudgeMarks || {};
    const marks = { ...stored };
    const due = [];

    // A mark belongs to a BEAT, not to an arc — hence the composite key. Keying
    // it by arc id alone means advancing to the next beat inherits the previous
    // beat's high-water mark, and the new beat stays silent until it is twice as
    // stale as the threshold. That is a silent stall, which is the failure this
    // whole feature exists to catch.
    const keyFor = arc => `${arc.id}#${arc.beatIndex || 0}`;
    const awaiting = getArcsAwaitingBeat();

    // Reconcile BEFORE deciding what is due, so the result never depends on how
    // often this ran. Two ways a mark dies: its beat is gone (advanced, resolved,
    // deleted), or its wait fell back below the multiple it was recorded at
    // (a retreat, or an edit).
    const live = new Map(awaiting.map(a => [keyFor(a), a.turnsSinceAdvance || 0]));
    for (const key of Object.keys(marks)) {
        if (!live.has(key) || Math.floor(live.get(key) / threshold) < marks[key]) delete marks[key];
    }

    for (const arc of awaiting) {
        const key = keyFor(arc);
        const mult = Math.floor((arc.turnsSinceAdvance || 0) / threshold);
        if (mult >= 1 && mult > (marks[key] || 0)) {
            marks[key] = mult;
            due.push(arc);
        }
    }

    const changed = due.length > 0
        || Object.keys(marks).length !== Object.keys(stored).length;
    if (changed) setPlanData({ nudgeMarks: marks });
    return due;
}

// ─── History (snapshots for Revert / History) ────────────────────────────────

/** Max snapshots retained per chat. Kept modest to bound metadata growth. */
export const MAX_PLAN_HISTORY = 20;

export function getPlanHistory() {
    return getPlanData().history || [];
}

/**
 * Render a history entry as markdown. Entries written before the arc rework
 * carry a `text` blob instead of `arcs`, so both shapes stay readable.
 */
export function historyEntryToText(entry) {
    if (!entry) return '';
    if (Array.isArray(entry.arcs)) return serializeArcsToText(entry.arcs);
    return entry.text || '';
}

/** Restore a history entry to arcs, parsing legacy text snapshots as needed. */
export function historyEntryToArcs(entry) {
    if (!entry) return [];
    if (Array.isArray(entry.arcs)) return entry.arcs;
    return parsePlanTextToArcs(entry.text || '');
}

/**
 * Push an arc-list snapshot onto the per-chat history stack. No-ops on an empty
 * plan and on consecutive duplicates so revert steps stay meaningful.
 */
export function pushPlanToHistory(arcs) {
    const list = Array.isArray(arcs) ? arcs : [];
    if (list.length === 0) return;
    const history = getPlanHistory();
    const serialized = serializeArcsToText(list);
    if (!serialized.trim()) return;
    if (history.length && historyEntryToText(history[history.length - 1]) === serialized) return;
    history.push({ arcs: list.map(a => ({ ...a })), timestamp: Date.now() });
    if (history.length > MAX_PLAN_HISTORY) history.splice(0, history.length - MAX_PLAN_HISTORY);
    setPlanData({ history });
}

export function isInjectionEnabled() {
    return getEffectivePlanSetting('injectEnabled', true) !== false;
}

// ─── Auto-trigger helpers ────────────────────────────────────────────────────

export function getAutoInterval() {
    const v = getEffectivePlanSetting('autoInterval', 10);
    return Number.isFinite(Number(v)) ? Math.max(1, Number(v)) : 10;
}

export function isAutoEnabled() {
    return getEffectivePlanSetting('autoEnabled', false) === true;
}

export function persistAutoCounter() {
    setPlanData({ autoCounter: state.autoCounter, countedReceiptEvents: [...state.countedReceiptEvents.entries()] });
}

export function resetAutoCounter() {
    state.autoCounter = 0;
    state.countedReceiptEvents.clear();
    persistAutoCounter();
}
