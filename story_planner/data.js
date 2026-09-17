/**
 * story_planner/data.js — Shared constants, mutable state, and data access.
 *
 * Leaf module — no imports from other story_planner modules except its pure
 * schema owner (./schema.js).
 *
 * The plan is stored as an array of structured arc objects (see ARC SHAPE in
 * ./schema.js) rather than one opaque blob of text. Plans authored before that
 * change are migrated by the schema's v0 -> v1 migration, which the runtime
 * gate (schema/runtime.js, Part 6 of the schema plan) runs on load; getArcs()
 * keeps only a read-only parse fallback, never a write.
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
// Part 6 write-seam pause guard. Direct import (not the barrel) so the REAL
// pause singleton is read even under the test barrel→stub alias.
import { isStoreWriteBlocked } from '../core/schema_status.js';
import {
    SECTIONS,
    DEFAULT_SECTION,
    ARC_STATUSES,
    SECTION_KEYS,
    MAX_ARC_TITLE,
    MAX_ARC_BODY,
    newArcId,
    newBeatId,
    sanitizeBeat,
    parsePlanTextToArcs,
    sanitizeArc,
    sanitizeArcs,
    sectionKeyFromLabel,
    storyPlannerSchema,
} from './schema.js';

export { SECTIONS, DEFAULT_SECTION, ARC_STATUSES, SECTION_KEYS, newArcId, newBeatId, sanitizeBeat, parsePlanTextToArcs, sanitizeArc, sanitizeArcs, sectionKeyFromLabel };

// ─── Constants ───────────────────────────────────────────────────────────────

export const CHAT_DATA_KEY = 'story_planner_data';
export const EXTENSION_PROMPT_KEY = 'mwt_story_plan_injection';

// SECTIONS / DEFAULT_SECTION / ARC_STATUSES are owned by ./schema.js and
// re-exported at the top of this file.

/** Injection modes — mirrors chronicle's injectMode switch. */
export const INJECT_MODES = [
    { key: 'all', label: 'All active', blurb: 'Inject every active arc' },
    { key: 'pinned', label: 'Pinned only', blurb: 'Inject only active arcs you have pinned' },
    { key: 'focused', label: 'Focused only', blurb: 'Inject only active arcs you have focused' },
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
    /** True while a targeted proposal is awaiting review. */
    targetedReviewOpen: false,
    /** True while the targeted action that owns isGenerating is in flight. */
    targetedActionInFlight: false,
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
    // Part 6: a store paused by the runtime schema gate keeps its untouched
    // original as the recoverable state — a module write would validate the
    // unprepared value at the current version and replace it (a silent
    // downgrade for a future-version store, exactly what §12 forbids). The
    // only exception is the §7.5 privileged-preparation window.
    if (isStoreWriteBlocked(storyPlannerSchema.id)) {
        console.warn('[MWT:StoryPlanner] Write refused — the store is paused for this chat (schema preparation); the previous value was kept.');
        return meta[CHAT_DATA_KEY];
    }
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
        overrides[key] = normalizePlanSetting(key, globalSettings[key] ?? LEGACY_LOCAL_DEFAULTS[key]);
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
    const resolved = (value, source) => {
        const normalized = normalizePlanSetting(key, value);
        return provenance ? { value: normalized, source } : normalized;
    };
    const data = getPlanData();
    if (!usesGlobalDefaults()) {
        const override = data.settingsOverride?.[key];
        if (override !== undefined) {
            return resolved(override, 'per-chat-override');
        }
        if (data[key] !== undefined) {
            return resolved(data[key], 'per-chat-legacy');
        }
        const builtin = LEGACY_LOCAL_DEFAULTS[key];
        if (builtin != null) {
            return resolved(builtin, 'builtin-default');
        }
        return resolved(fallback, 'fallback');
    }
    const global = getSettings()[key];
    if (global != null) {
        return resolved(global, 'global');
    }
    return resolved(fallback, 'fallback');
}

/** Preserve the legacy Active mode's behavior while exposing only current vocabulary. */
function normalizePlanSetting(key, value) {
    return key === 'injectMode' && value === 'active' ? 'all' : value;
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
    return total > 0 && !arc.beats.some(beat => beat?.state === 'pending');
}

/** The canonical beat record currently awaiting confirmation. */
export function getCurrentBeatRecord(arc) {
    return (arc?.beats || []).find(beat => beat?.state === 'pending') || null;
}

/** The single beat the narrator should be working on. '' when none/ready. */
export function getCurrentBeat(arc) {
    return getCurrentBeatRecord(arc)?.text || '';
}

/** 1-based position of the pending beat for user-facing progress labels. */
export function getCurrentBeatNumber(arc) {
    const index = (arc?.beats || []).findIndex(beat => beat?.state === 'pending');
    return index === -1 ? 0 : index + 1;
}

/** Derived display progress; never persisted as positional authority. */
export function getBeatProgress(arc) {
    const beats = arc?.beats || [];
    return {
        done: beats.filter(beat => beat?.state === 'planted').length,
        total: beats.length,
    };
}

/** Mark the current beat planted and move to the next (or to READY). */
export function advanceBeat(id) {
    const arc = getArcs().find(a => a.id === id);
    if (!arc) return null;
    const current = getCurrentBeatRecord(arc);
    if (!current) return arc;
    return setArcBeatState(id, current.id, 'planted');
}

/** Step back a beat — for when a beat was marked planted by mistake. */
export function retreatBeat(id) {
    const arc = getArcs().find(a => a.id === id);
    if (!arc) return null;
    const history = [...(arc.beats || [])].reverse().find(beat => beat?.state === 'planted');
    if (!history) return arc;
    return setArcBeatState(id, history.id, 'pending');
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

/** Ready arcs whose completed setup has been waiting long enough for a payoff check. */
export function getOverdueReadyArcs(threshold = getNudgeTurns()) {
    return getArcs()
        .filter(a => a.status === 'active' && isArcReady(a) && (a.turnsSinceAdvance || 0) >= threshold)
        .sort((x, y) => (y.turnsSinceAdvance || 0) - (x.turnsSinceAdvance || 0));
}

/**
 * A bounded memory projection for regeneration. Closed arcs remain in storage,
 * but their setup route is not useful to the model and can grow every prompt.
 */
export const MAX_CLOSED_MEMORY_ARCS = 20;
export const MAX_CLOSED_MEMORY_CHARS = 6000;
export const MAX_PARKED_MEMORY_ARCS = 20;
export const MAX_PARKED_MEMORY_CHARS = 3000;

export function buildClosedMemoryProjection(arcs = getArcs()) {
    const closed = (Array.isArray(arcs) ? arcs : [])
        .filter(a => a.status === 'resolved' || a.status === 'dropped')
        .sort((a, b) => (b.pinned === true) - (a.pinned === true)
            || (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
    const lines = [];
    let chars = 0;
    for (const arc of closed) {
        const reasonText = arc.closeReason || arc.body;
        const reason = reasonText ? ` — ${String(reasonText).trim()}` : '';
        const line = `- [${arc.status}] ${arc.title || '(untitled arc)'}${reason}`;
        if (lines.length >= MAX_CLOSED_MEMORY_ARCS || chars + line.length + 1 > MAX_CLOSED_MEMORY_CHARS) break;
        lines.push(line);
        chars += line.length + 1;
    }
    return lines.join('\n');
}

/** Bounded title-only memory for arcs deliberately shelved by the user. */
export function buildParkedMemoryProjection(arcs = getArcs()) {
    const parked = (Array.isArray(arcs) ? arcs : [])
        .filter(arc => arc.status === 'parked' && arc.title)
        .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
    const lines = [];
    let chars = 0;
    for (const arc of parked) {
        const line = `- ${arc.title}`;
        if (lines.length >= MAX_PARKED_MEMORY_ARCS || chars + line.length + 1 > MAX_PARKED_MEMORY_CHARS) break;
        lines.push(line);
        chars += line.length + 1;
    }
    return lines.join('\n');
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
export function serializeArcsToText(arcs, { annotateStatus = false, beats = 'all', handles, prioritizeFocused = false } = {}) {
    const list = sanitizeArcs(Array.isArray(arcs) ? arcs : []);
    const out = [];
    const sections = prioritizeFocused
        ? [...SECTIONS].sort((a, b) => {
            const aFocused = list.some(arc => arc.section === a.key && arc.focused);
            const bFocused = list.some(arc => arc.section === b.key && arc.focused);
            return Number(bFocused) - Number(aFocused);
        })
        : SECTIONS;
    for (const sec of sections) {
        const inSection = list
            .filter(a => a.section === sec.key)
            .sort((a, b) => prioritizeFocused ? Number(b.focused) - Number(a.focused) : 0);
        if (inSection.length === 0) continue;
        out.push(`## ${sec.label}`);
        for (const arc of inSection) {
            const flags = [];
            if (annotateStatus && arc.status !== 'active') flags.push(arc.status.toUpperCase());
            if (annotateStatus && arc.pinned) flags.push('PINNED');
            if (annotateStatus && isArcReady(arc)) flags.push('SETUP COMPLETE');
            const flag = flags.length ? ` [${flags.join(', ')}]` : '';
            const title = arc.title || '(untitled arc)';
            const handle = handles instanceof Map ? handles.get(arc.id) : handles?.[arc.id];
            const handleMarker = handle ? `[ARC:${handle}] ` : '';
            out.push(arc.body ? `- ${handleMarker}${title}${flag} — ${arc.body}` : `- ${handleMarker}${title}${flag}`);

            if (beats === 'all' && arc.beats?.length) {
                arc.beats.forEach((beat, i) => {
                    const record = typeof beat === 'string' ? { id: '', text: beat, state: 'pending' } : beat;
                    // Progress markers matter on regeneration: without them the
                    // model happily re-proposes setup the story already planted.
                    let mark = '';
                    if (annotateStatus) {
                        if (record.state === 'planted') mark = ' [PLANTED]';
                        else if (record.state === 'skipped') mark = ' [SKIPPED]';
                        else if (record.id && record.id === getCurrentBeatRecord(arc)?.id) mark = ' [CURRENT]';
                    }
                    out.push(`  ${i + 1}. ${record.text}${mark}`);
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
 *  - Incoming arc already carrying an existing arc's id (the parser resolved a
 *    request handle or an unambiguous title) → that arc. Otherwise the same
 *    (normalised) title as an existing arc no incoming id has claimed → that
 *    arc. Closed arcs are excluded from both identity paths so a recurring
 *    suggestion cannot rewrite durable resolved/dropped memory. Otherwise keep
 *    its id, beatIndex, pinned, status and age; take the
 *    model's refreshed body/section and pending beats. The stored planted
 *    prefix is never model-authored data.
 *  - Existing arc the model dropped → discarded, UNLESS it is pinned or has
 *    beats already planted. Losing an in-progress arc is exactly the bug.
 *  - Everything else the model returned → added as new.
 *
 * @param {object[]} previous existing arcs
 * @param {object[]} incoming freshly parsed arcs
 * @param {object} [options]
 * @param {Set<string>} [options.protectedIds] arcs materially edited by the user
 * @param {Set<string>} [options.deletedIds] arcs deleted while generation ran
 * @param {Set<string>} [options.deletedTitles] titles deleted while generation ran
 * @returns {{arcs: object[], carried: number, matched: number, added: number}}
 */
export function mergeRegeneratedArcs(previous, incoming, options = {}) {
    // Public/import callers may still provide v1 string-beat records. Treat this
    // merge boundary like every storage boundary so positional data is converted
    // before any progress decision is made.
    const prev = sanitizeArcs(Array.isArray(previous) ? previous : []);
    const next = sanitizeArcs(Array.isArray(incoming) ? incoming : []);
    const protectedIds = options.protectedIds || new Set();
    const deletedIds = options.deletedIds || new Set();
    const deletedTitles = options.deletedTitles || new Set();

    const existingIds = new Set(prev.map(arc => arc.id));
    const parkedTitles = new Set(prev
        .filter(arc => arc.status === 'parked')
        .map(arc => titleKey(arc.title))
        .filter(Boolean));
    // Parked records were not sent to the model and must not be title-fallback
    // candidates for a new suggestion.
    const mergeable = prev.filter(arc => arc.status === 'active');
    const byId = new Map(mergeable.map(arc => [arc.id, arc]));
    const byTitle = new Map();
    for (const arc of mergeable) {
        const key = titleKey(arc.title);
        if (!key) continue;
        const matches = byTitle.get(key) || [];
        matches.push(arc);
        byTitle.set(key, matches);
    }
    // Reserve every arc an incoming id already names before any title match
    // runs, so a marker-less duplicate earlier in the response cannot take the
    // progress of the arc a later line was resolved to.
    const claimedById = new Set(next.map(fresh => fresh.id).filter(id => byId.has(id)));

    const consumed = new Set();
    let matched = 0;
    const merged = next.map(fresh => {
        const key = titleKey(fresh.title);
        const titleMatches = key ? (byTitle.get(key) || []) : [];
        // Title fallback is safe only when it identifies one active arc.
        const titled = titleMatches.length === 1 ? titleMatches[0] : null;
        const old = byId.get(fresh.id)
            || (titled && !claimedById.has(titled.id) ? titled : null);
        // A response must not recreate an arc removed after generation began,
        // even when the model repeats its title. This is an in-flight tombstone,
        // not a permanent ban on creating the idea again later. A title the user
        // re-added as a new (live) arc during the call is not tombstoned: the
        // title ban applies only when no current arc bears that title, so the
        // re-added arc can still be refreshed by the response instead of lost.
        // The response's own id is checked as well: a deleted arc the model
        // renamed, but carried by its request handle, matches no current arc or
        // deleted title, so only its id shows that it was deleted.
        if (deletedIds.has(fresh.id)) return null;
        if (old && deletedIds.has(old.id)) return null;
        if (!old && deletedTitles.has(key)) return null;
        // The model is explicitly told not to re-propose shelved ideas, but the
        // merge boundary enforces that user decision even when it ignores the
        // prompt. The durable parked record is carried below.
        if (!old && parkedTitles.has(key)) return null;
        // Closed ids are not valid merge identities. A malformed/stale caller
        // may still send one explicitly, so mint a distinct id before carrying
        // the durable closed record alongside this newly proposed active arc.
        if (!old) return existingIds.has(fresh.id) ? { ...fresh, id: newArcId() } : fresh;
        // Two incoming arcs naming one id: the first carries it forward and
        // the repeat is added as new rather than aliasing a stored record.
        // Its stale id can belong to a carried parked/closed arc, even when it
        // does not equal the active arc matched through title fallback.
        if (consumed.has(old.id)) return existingIds.has(fresh.id) ? { ...fresh, id: newArcId() } : fresh;
        consumed.add(old.id);
        matched++;
        // User edits are authoritative. Do not let a stale response replace an
        // arc whose title/body/section/progress was changed during the request.
        if (protectedIds.has(old.id)) return { ...old };

        const oldBeats = Array.isArray(old.beats) ? old.beats : [];
        if (isArcReady(old)) {
            return { ...fresh, id: old.id, pinned: old.pinned, status: old.status,
                focused: old.focused, activateWhen: old.activateWhen,
                closeReason: old.closeReason, closedAt: old.closedAt,
                createdAt: old.createdAt, beats: oldBeats,
                turnsSinceAdvance: old.turnsSinceAdvance || 0, updatedAt: Date.now() };
        }
        const historical = oldBeats.filter(beat => beat.state !== 'pending');
        const oldPending = oldBeats.filter(beat => beat.state === 'pending');
        const incomingBeats = Array.isArray(fresh.beats) ? fresh.beats : [];

        // The model sees planted beats in the previous-plan block and commonly
        // echoes them. Remove one normalized copy of each before replacing the
        // pending route, while retaining the exact stored strings in the prefix.
        const remaining = [...incomingBeats];
        for (const plantedBeat of historical) {
            const wanted = normaliseBeatForMerge(plantedBeat);
            const copy = remaining.findIndex(beat => normaliseBeatForMerge(beat) === wanted);
            if (copy !== -1) remaining.splice(copy, 1);
        }
        // A model response containing only the planted prefix is not a usable
        // route. Keep the stored pending suffix so regeneration cannot make an
        // arc Ready merely by omitting setup beats.
        const pending = remaining.length ? preservePendingBeatIds(oldPending, remaining) : oldPending;
        const beats = [...historical, ...pending];
        const oldCurrent = getCurrentBeatRecord(old);
        const newCurrent = beats.find(beat => beat.state === 'pending');
        const currentChanged = oldCurrent?.id !== newCurrent?.id;
        return {
            ...fresh,
            id: old.id,
            pinned: old.pinned,
            status: old.status,
            focused: old.focused,
            activateWhen: old.activateWhen,
            closeReason: old.closeReason,
            closedAt: old.closedAt,
            createdAt: old.createdAt,
            beats,
            turnsSinceAdvance: currentChanged ? 0 : (old.turnsSinceAdvance || 0),
            updatedAt: Date.now(),
        };
    }).filter(Boolean);

    // Arcs the model omitted but that we refuse to lose. Closed records are
    // durable user decisions: they are intentionally absent from the editable
    // previous-plan block and represented only in bounded closed memory, so an
    // omission can never mean "delete this record." Explicit removeArc() remains
    // the deliberate forget path.
    // A title fallback with multiple stored candidates is deliberately not an
    // identity match. Retain every candidate rather than churning their IDs
    // merely because the model returned one ambiguous title.
    const ambiguousTitleIds = new Set(
        [...byTitle.values()].filter(matches => matches.length > 1).flat().map(arc => arc.id),
    );
    const carried = prev.filter(a =>
        !consumed.has(a.id)
        && (a.status === 'resolved' || a.status === 'dropped'
            || a.status === 'parked' || protectedIds.has(a.id) || a.pinned
            || ambiguousTitleIds.has(a.id)
            || (a.beats || []).some(beat => beat.state !== 'pending')),
    );

    return {
        arcs: [...carried, ...merged],
        carried: carried.length,
        matched,
        added: merged.length - matched,
    };
}

/** Compare beat text without allowing harmless model formatting to defeat the
 * planted-copy removal. The value returned to storage is always the original
 * stored beat, never this normalized representation. */
function normaliseBeatForMerge(value) {
    return String(value?.text ?? value ?? '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function preservePendingBeatIds(oldPending, incoming) {
    const oldCounts = new Map();
    const incomingCounts = new Map();
    for (const beat of oldPending) {
        const key = normaliseBeatForMerge(beat);
        oldCounts.set(key, (oldCounts.get(key) || 0) + 1);
    }
    for (const beat of incoming) {
        const key = normaliseBeatForMerge(beat);
        incomingCounts.set(key, (incomingCounts.get(key) || 0) + 1);
    }
    return incoming.map(beat => {
        const key = normaliseBeatForMerge(beat);
        if (oldCounts.get(key) !== 1 || incomingCounts.get(key) !== 1) return beat;
        const old = oldPending.find(candidate => normaliseBeatForMerge(candidate) === key);
        return old ? { ...old } : beat;
    });
}

// ─── Arc access + migration ──────────────────────────────────────────────────

/**
 * Read the arc list.
 *
 * Part 6 retired the lazy text-to-arcs migration this function used to perform
 * on first read: the runtime gate (schema/runtime.js) runs the schema's v0→v1
 * migration — same parser, same "keep the original text" recovery rule —
 * BEFORE any module read. What remains is a read-only parse fallback for a
 * store the gate cannot have stamped (an absent `arcs` beside legacy text),
 * so the plan stays displayable without ANY write from a read path; the
 * central migration owns the persisted conversion.
 */
export function getArcs() {
    const data = getPlanData();
    if (Array.isArray(data.arcs)) return data.arcs;

    const legacy = typeof data.text === 'string' ? data.text : '';
    if (!legacy.trim()) return [];

    return parsePlanTextToArcs(legacy);
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
    // Clamp/clean the mutable fields a patch may set. A text-only beat patch is
    // an editor-friendly representation, not permission to discard the stable
    // records that hold planted/skipped progress.
    merged.title = String(merged.title ?? '').trim().slice(0, MAX_ARC_TITLE);
    merged.body = String(merged.body ?? '').trim().slice(0, MAX_ARC_BODY);
    merged.beats = Array.isArray(merged.beats)
        ? reconcilePatchedBeats(base.beats, merged.beats)
        : base.beats;
    merged.pinned = merged.pinned === true;
    merged.focused = merged.focused === true;
    merged.activateWhen = String(merged.activateWhen ?? '').trim().slice(0, MAX_ARC_BODY);
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

/**
 * Reconcile a beat patch against the records it is replacing.
 *
 * A text-only patch is an editor-friendly representation, not permission to
 * discard the stable records that carry planted/skipped progress. Each text
 * entry claims the first stored beat with the same normalized text no earlier
 * entry has taken, so duplicating a row adds a new pending beat instead of
 * un-planting the original. The text still has to match exactly: progress is
 * preserved in place and never transferred to different wording.
 *
 * Blank entries are dropped, the same rule the pre-v2 clamp applied and what
 * setArcs() would do regardless. Dropping them here keeps the arc updateArc()
 * RETURNS identical to the one it stores — callers read progress back off that
 * return value (index.js markBeatPlanted derives its message from it).
 *
 * Historical beats then float ahead of pending ones, keeping relative order
 * within each group. Planted and skipped beats record what the story already
 * did with this arc, so a pending beat cannot be moved in front of one without
 * the user changing that beat's state first (design §5.1). This is the same
 * normalization mergeRegeneratedArcs() applies, and a no-op on an ordered list.
 */
function reconcilePatchedBeats(baseBeats, patchedBeats) {
    const old = Array.isArray(baseBeats) ? baseBeats : [];
    const used = new Set();
    const reconciled = patchedBeats.map(beat => {
        if (beat && typeof beat === 'object' && !Array.isArray(beat)) return sanitizeBeat(beat);
        const key = normaliseBeatForMerge(beat);
        const match = old.find(candidate => !used.has(candidate.id) && normaliseBeatForMerge(candidate) === key);
        if (!match) return sanitizeBeat(beat);
        used.add(match.id);
        return sanitizeBeat({ ...match, text: beat });
    }).filter(beat => beat.text);
    return [
        ...reconciled.filter(beat => beat.state !== 'pending'),
        ...reconciled.filter(beat => beat.state === 'pending'),
    ];
}

// ─── Full beat editor mutations ──────────────────────────────────────────────

/** A stable description of what the narrator currently sees as this arc's beat. */
function currentBeatFingerprint(arc) {
    const beat = getCurrentBeatRecord(arc);
    return beat ? `${beat.id}\u0000${beat.text}` : '';
}

/** Compare user-authored beat state while ignoring bookkeeping timestamps. */
function beatSequenceFingerprint(beats) {
    return JSON.stringify((beats || []).map(({ id, text, state: beatState, stateReason }) => ({
        id, text, state: beatState, stateReason,
    })));
}

/**
 * Commit one completed beat-editor operation.
 *
 * Every caller supplies the whole proposed sequence, so one history snapshot is
 * written for one user operation (never for each keystroke). The ordinary arc
 * update seam still canonicalizes the records and keeps historical beats ahead
 * of pending ones. Reminder age belongs to the current beat, so only changing
 * that beat's identity or text resets the counter and its high-water mark.
 */
function commitBeatEdit(id, proposedBeats) {
    const arcs = getArcs();
    const arc = arcs.find(candidate => candidate.id === id);
    if (!arc) return null;

    const beats = reconcilePatchedBeats(arc.beats, proposedBeats);
    const nextShape = { ...arc, beats };
    const currentChanged = currentBeatFingerprint(arc) !== currentBeatFingerprint(nextShape);
    const same = beatSequenceFingerprint(arc.beats) === beatSequenceFingerprint(beats);
    if (same) return arc;

    pushPlanToHistory(arcs);
    const updated = updateArc(id, {
        beats,
        ...(currentChanged ? { turnsSinceAdvance: 0 } : {}),
    });
    if (currentChanged) cleanNudgeMarksForArc(id);
    return updated;
}

/** Add one non-blank pending setup beat and return the updated arc. */
export function addArcBeat(id, text = '') {
    const arc = getArcs().find(candidate => candidate.id === id);
    if (!arc) return null;
    const beat = sanitizeBeat({ text, state: 'pending', updatedAt: Date.now() });
    if (!beat.text) return arc;
    return commitBeatEdit(id, [...arc.beats, beat]);
}

/** Edit one beat's text or skipped-state reason. Blank text is not a delete. */
export function updateArcBeat(id, beatId, patch = {}) {
    const arc = getArcs().find(candidate => candidate.id === id);
    const beat = arc?.beats.find(candidate => candidate.id === beatId);
    if (!arc || !beat) return null;
    const next = { ...beat, updatedAt: Date.now() };
    if (Object.hasOwn(patch, 'text')) {
        const text = String(patch.text ?? '').trim();
        if (!text) return arc;
        next.text = text;
    }
    if (Object.hasOwn(patch, 'stateReason')) next.stateReason = String(patch.stateReason ?? '').trim();
    return commitBeatEdit(id, arc.beats.map(candidate => candidate.id === beatId ? next : candidate));
}

/** Mark any beat pending, planted, or skipped. Skip never counts as planted. */
export function setArcBeatState(id, beatId, beatState, reason = '') {
    if (!['pending', 'planted', 'skipped'].includes(beatState)) return null;
    const arc = getArcs().find(candidate => candidate.id === id);
    const beat = arc?.beats.find(candidate => candidate.id === beatId);
    if (!arc || !beat) return null;
    const stateReason = beatState === 'skipped' ? String(reason || beat.stateReason || '').trim() : '';
    const next = { ...beat, state: beatState, stateReason, updatedAt: Date.now() };
    return commitBeatEdit(id, arc.beats.map(candidate => candidate.id === beatId ? next : candidate));
}

/** Permanently remove one beat. The UI owns the specific confirmation. */
export function removeArcBeat(id, beatId) {
    const arc = getArcs().find(candidate => candidate.id === id);
    if (!arc || !arc.beats.some(beat => beat.id === beatId)) return null;
    return commitBeatEdit(id, arc.beats.filter(beat => beat.id !== beatId));
}

/**
 * Move a beat one row within its historical or pending group.
 * Pending beats cannot cross the historical boundary; changing a historical
 * beat back to pending is the explicit operation that makes such a move legal.
 */
export function moveArcBeat(id, beatId, direction) {
    const arc = getArcs().find(candidate => candidate.id === id);
    if (!arc) return null;
    const index = arc.beats.findIndex(beat => beat.id === beatId);
    const offset = direction === 'up' || direction === -1 ? -1
        : direction === 'down' || direction === 1 ? 1 : 0;
    const target = index + offset;
    if (!offset || index < 0 || target < 0 || target >= arc.beats.length) return arc;
    const historical = beat => beat.state !== 'pending';
    if (historical(arc.beats[index]) !== historical(arc.beats[target])) return arc;
    const beats = [...arc.beats];
    [beats[index], beats[target]] = [beats[target], beats[index]];
    return commitBeatEdit(id, beats);
}

export function removeArc(id) {
    const arcs = getArcs();
    const remaining = arcs.filter(a => a.id !== id);
    if (remaining.length === arcs.length) return false;
    pushPlanToHistory(arcs);
    setArcs(remaining);
    // STORY-PLANNER-08: clear this arc's nudge marks immediately rather than
    // waiting for takeDueNudges() to reconcile them lazily on its next call.
    cleanNudgeMarksForArc(id);
    return true;
}

export function setArcStatus(id, status, closeReason = '') {
    const next = ARC_STATUSES.includes(status) ? status : 'active';
    const arc = getArcs().find(a => a.id === id);
    if (!arc) return null;
    // STORY-PLANNER-08: Reactivating a resolved/dropped arc starts its beat-age
    // countdown over — the old turnsSinceAdvance and nudge high-water mark
    // belong to the arc's previous life and would otherwise suppress or
    // mis-time the next reminder. Clearing marks on resolve/drop too means a
    // stale high-water mark never lingers in metadata.
    const patch = { status: next };
    const wasClosed = arc.status === 'resolved' || arc.status === 'dropped';
    const willClose = next === 'resolved' || next === 'dropped';
    if (next === 'active' && arc.status !== 'active') {
        patch.turnsSinceAdvance = 0;
        patch.closedAt = null;
        patch.closeReason = '';
    } else if (willClose && !wasClosed) {
        patch.closedAt = Date.now();
        patch.closeReason = String(closeReason || '').trim().slice(0, MAX_ARC_BODY);
    }
    const updated = updateArc(id, patch);
    if (arc.status !== next) cleanNudgeMarksForArc(id);
    return updated;
}

/** Pause an arc without changing its pin/focus or confirmed beat history. */
export function parkArc(id) {
    const arc = getArcs().find(a => a.id === id);
    if (!arc || arc.status !== 'active') return arc || null;
    return setArcStatus(id, 'parked');
}

/** Return a parked arc to active life with a fresh reminder age. */
export function resumeArc(id) {
    const arc = getArcs().find(a => a.id === id);
    if (!arc || arc.status !== 'parked') return arc || null;
    return setArcStatus(id, 'active');
}

export function toggleArcPinned(id) {
    const arc = getArcs().find(a => a.id === id);
    if (!arc) return null;
    return updateArc(id, { pinned: !arc.pinned });
}

export function toggleArcFocused(id) {
    const arc = getArcs().find(a => a.id === id);
    if (!arc) return null;
    return updateArc(id, { focused: !arc.focused });
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
    const keyFor = arc => `${arc.id}#${getCurrentBeatRecord(arc)?.id || 'none'}`;
    const awaiting = getArcsAwaitingBeat();
    const ready = getArcs().filter(a => a.status === 'active' && isArcReady(a));

    // Reconcile BEFORE deciding what is due, so the result never depends on how
    // often this ran. Two ways a mark dies: its beat is gone (advanced, resolved,
    // deleted), or its wait fell back below the multiple it was recorded at
    // (a retreat, or an edit).
    const live = new Map([
        ...awaiting.map(a => [keyFor(a), a.turnsSinceAdvance || 0]),
        ...ready.map(a => [`${a.id}#ready`, a.turnsSinceAdvance || 0]),
    ]);
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

    for (const arc of ready) {
        const key = `${arc.id}#ready`;
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

/** Human-readable history projection that makes beat state/reason changes visible. */
export function historyEntryToDiffText(entry) {
    if (!entry) return '';
    if (!Array.isArray(entry.arcs)) return entry.text || '';
    const arcs = sanitizeArcs(entry.arcs);
    const lines = [];
    for (const section of SECTIONS) {
        const inSection = arcs.filter(arc => arc.section === section.key);
        if (!inSection.length) continue;
        lines.push(`## ${section.label}`);
        for (const arc of inSection) {
            const flags = [arc.status !== 'active' ? arc.status : '', arc.pinned ? 'pinned' : '', arc.focused ? 'focused' : ''].filter(Boolean);
            lines.push(`- ${arc.title || '(untitled arc)'}${flags.length ? ` [${flags.join(', ')}]` : ''}${arc.body ? ` — ${arc.body}` : ''}`);
            if (arc.activateWhen) lines.push(`  Resume when: ${arc.activateWhen}`);
            if (arc.closeReason) lines.push(`  Close reason: ${arc.closeReason}`);
            arc.beats.forEach((beat, index) => {
                const label = beat.state === 'planted' ? 'Planted' : beat.state === 'skipped' ? 'Skipped' : 'Pending';
                lines.push(`  ${index + 1}. [${label}] ${beat.text}${beat.stateReason ? ` — ${beat.stateReason}` : ''}`);
            });
        }
        lines.push('');
    }
    return lines.join('\n').trim();
}

/** Restore a history entry to arcs, parsing legacy text snapshots as needed. */
export function historyEntryToArcs(entry) {
    if (!entry) return [];
    if (Array.isArray(entry.arcs)) return sanitizeArcs(entry.arcs);
    return parsePlanTextToArcs(entry.text || '');
}

function historyEntrySignature(entry) {
    if (Array.isArray(entry?.arcs)) {
        // History must distinguish every user-restorable planning decision,
        // including stable ids and skip reasons, while ignoring bookkeeping-only
        // timestamps so automatic aging does not create meaningless snapshots.
        const durable = sanitizeArcs(entry.arcs).map(arc => ({
            id: arc.id,
            title: arc.title,
            body: arc.body,
            section: arc.section,
            status: arc.status,
            pinned: arc.pinned,
            focused: arc.focused,
            activateWhen: arc.activateWhen,
            closeReason: arc.closeReason,
            closedAt: arc.closedAt,
            createdAt: arc.createdAt,
            beats: arc.beats.map(({ id, text, state: beatState, stateReason }) => ({ id, text, state: beatState, stateReason })),
        }));
        return `arcs:${JSON.stringify(durable)}`;
    }
    return `text:${historyEntryToText(entry)}`;
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
    const candidate = { arcs: structuredCloneSafe(list) };
    if (history.length && historyEntrySignature(history[history.length - 1]) === historyEntrySignature(candidate)) return;
    history.push({ ...candidate, timestamp: Date.now() });
    if (history.length > MAX_PLAN_HISTORY) history.splice(0, history.length - MAX_PLAN_HISTORY);
    setPlanData({ history });
}

/**
 * Commit a reviewed replacement and its pre-operation history snapshot in one
 * checked metadata write. Targeted proposals use this seam so a refused write
 * cannot consume a history slot without also applying the reviewed plan.
 */
export function setArcsWithHistory(arcs, before = getArcs()) {
    const storeBefore = getPlanData();
    const nextArcs = sanitizeArcs(Array.isArray(arcs) ? arcs : []);
    const prior = Array.isArray(before) ? before : [];
    // Work on a detached history snapshot. setPlanData can refuse the complete
    // proposed store; a refusal must leave the live metadata object untouched.
    const history = structuredCloneSafe(getPlanHistory());
    if (prior.length && serializeArcsToText(prior).trim()) {
        const candidate = { arcs: structuredCloneSafe(prior) };
        if (!history.length || historyEntrySignature(history[history.length - 1]) !== historyEntrySignature(candidate)) {
            history.push({ ...candidate, timestamp: Date.now() });
            if (history.length > MAX_PLAN_HISTORY) history.splice(0, history.length - MAX_PLAN_HISTORY);
        }
    }
    const committed = setPlanData({ arcs: nextArcs, history });
    return {
        ok: !!committed && committed !== storeBefore,
        arcs: Array.isArray(committed?.arcs) ? committed.arcs : getArcs(),
    };
}

function structuredCloneSafe(value) {
    return JSON.parse(JSON.stringify(value));
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
