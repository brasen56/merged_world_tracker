/**
 * story_planner/schema.js — Story Planner store descriptor, arc schema, and
 * canonicalizers.
 *
 * THE module-owned schema for `chat_metadata.story_planner_data` (design
 * §3.2/§6.5 of SCHEMA_VALIDATION_MIGRATIONS_PLAN.md). sanitizeArc/sanitizeArcs,
 * the section/status vocabulary, the arc-id factory, and the beat-index clamp
 * moved here from data.js (Part 1 of the schema plan) so writes, loads,
 * backup imports, and history restores retain ONE owner; data.js imports and
 * re-exports them unchanged.
 *
 * Pure by contract: no DOM, no SillyTavern runtime, no core barrel, and
 * nothing from story_planner/data.js or story_planner/settings.js (that would
 * be a cycle — data.js imports this file).
 *
 * The metadataKey literal mirrors backup/data.js METADATA_KEYS (and the
 * module's own CHAT_DATA_KEY); test/schema_parity.test.js pins them together.
 */
import {
    checkUniqueRecordList,
    defineStoreSchema,
    emptyStats,
    isFiniteNumber,
    isNonEmptyString,
    isObject,
    quarantineIssue,
} from '../core/schema.js';

// ─── STORY-PLANNER-04 / -09: Arc canonicalizer ──────────────────────────────
//
// `updateArc()` and `setArcs()` used to spread an arbitrary patch into an arc
// with no validation: unbounded `title`/`body`/`beats`, non-number `beatIndex`,
// non-boolean `pinned`, NaN counters, and even foreign keys could land in
// metadata. History restore / import can persist non-canonical arcs that later
// can't be removed. The canonicalizer below is the single validation seam: it
// is called from `makeArc`, `updateArc`, `setArcs`, and the legacy migration
// path, so every write to chat metadata runs through it.

/**
 * Maximum character lengths for user/model-authored arc fields. Keeps a
 * runaway generation or a pasted wall of text from bloating metadata and the
 * injected payload. Exported for data.js's updateArc clamp, which shares the
 * same bounds.
 */
export const MAX_ARC_TITLE = 200;
export const MAX_ARC_BODY = 2000;
export const MAX_BEAT_LENGTH = 1000;

/**
 * ARC SHAPE
 * {
 *   id: string, title: string, body: string,
 *   section: 'immediate'|'emerging'|'horizon'|'character'|'unresolved',
 *   status: 'active'|'resolved'|'dropped',   // user-controlled, never LLM-authored
 *   pinned: boolean,
 *   beats: string[],          // ordered setup beats; [] for Immediate Hooks
 *   beatIndex: number,        // current beat; >= beats.length means READY
 *   turnsSinceAdvance: number,// turns since this beat became current
 *   createdAt: number, updatedAt: number,
 * }
 *
 * `body` is the arc's ENDPOINT (where it eventually lands). `beats` are the
 * small, concrete steps toward it. Only the current beat is ever injected —
 * that is the whole point: the narrator gets one actionable instruction per
 * arc per turn instead of a destination it cannot act on yet.
 */

/**
 * Sanitize a single arc object, returning a canonical arc that satisfies the
 * ARC SHAPE contract. Non-finite numbers, wrong types, and oversized strings
 * are repaired to safe defaults; foreign keys are dropped.
 *
 * @param {object} raw — the arc to sanitize
 * @param {boolean} [preserveId=true] — keep the incoming id (used by updateArc)
 * @returns {object} a canonical arc object
 */
export function sanitizeArc(raw, { preserveId = true } = {}) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const now = Date.now();
    const beats = (Array.isArray(src.beats) ? src.beats : [])
        .map(b => String(b ?? '').trim().slice(0, MAX_BEAT_LENGTH))
        .filter(Boolean);
    const beatCount = beats.length;
    return {
        id: preserveId && src.id ? String(src.id) : newArcId(),
        title: String(src.title ?? '').trim().slice(0, MAX_ARC_TITLE),
        body: String(src.body ?? '').trim().slice(0, MAX_ARC_BODY),
        section: SECTION_KEYS.has(src.section) ? src.section : DEFAULT_SECTION,
        status: ARC_STATUSES.includes(src.status) ? src.status : 'active',
        pinned: src.pinned === true,
        beats,
        beatIndex: clampBeatIndex(src.beatIndex, beatCount),
        turnsSinceAdvance: Number.isFinite(Number(src.turnsSinceAdvance))
            ? Math.max(0, Math.floor(Number(src.turnsSinceAdvance)))
            : 0,
        createdAt: Number.isFinite(Number(src.createdAt)) ? Number(src.createdAt) : now,
        updatedAt: Number.isFinite(Number(src.updatedAt)) ? Number(src.updatedAt) : now,
    };
}

/**
 * Sanitize an array of arcs (used by setArcs, import, and history restore).
 * @param {Array} arcs
 * @returns {object[]}
 */
export function sanitizeArcs(arcs) {
    if (!Array.isArray(arcs)) return [];
    // STORY-PLANNER-09: A duplicate id (a hand-edited import or a legacy
    // snapshot) makes two arcs alias the same key — removeArc/updateArc would
    // then hit both, and the user could not remove them independently. Mint a
    // fresh id for any repeat so every arc is independently addressable,
    // without silently dropping data.
    const seen = new Set();
    return arcs.map(a => {
        const arc = sanitizeArc(a, { preserveId: true });
        if (seen.has(arc.id)) arc.id = newArcId();
        seen.add(arc.id);
        return arc;
    });
}

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * The canonical section list — ONE OWNER OF FORMAT.
 *
 * Everything downstream derives from this: prompts.js builds the FORMAT block
 * the model is asked to follow, the parser maps headings back to `key`, the
 * serializer emits headings in this order, and render.js groups cards by it.
 * Adding a section here is enough to thread it through the whole module.
 *
 * `hint` is shown to the model in the generation prompt; `blurb` is shown to
 * the user in the UI. (Moved from data.js with the canonicalizer — the arc
 * schema reads it, so it lives with the schema; data.js re-exports it.)
 */
export const SECTIONS = [
    {
        key: 'immediate',
        label: 'Immediate Hooks',
        hint: 'Ready to use right now — something that could surface in the very next scene without any setup.',
        blurb: 'Usable in the next scene',
    },
    {
        key: 'emerging',
        label: 'Emerging Arcs',
        hint: 'Threads already in motion that need a few scenes to develop.',
        blurb: 'Developing over the next few scenes',
    },
    {
        key: 'horizon',
        label: 'Horizon Arcs',
        hint: 'Major structural shifts far enough out that the story must build toward them.',
        blurb: 'Major shifts, further out',
    },
    {
        key: 'character',
        label: 'Character Journeys',
        hint: 'Per-character growth, change, or reckoning — arcs that belong to a person rather than a plot.',
        blurb: 'Growth arcs belonging to a character',
    },
    {
        key: 'unresolved',
        label: 'Unresolved Threads',
        hint: 'Setup the story already planted that still owes a payoff. Name the original setup so it can be called back and resolved.',
        blurb: 'Already set up — still owes a payoff',
    },
];

/** Section assigned to bullets with no recognisable heading above them. */
export const DEFAULT_SECTION = 'emerging';

export const ARC_STATUSES = ['active', 'resolved', 'dropped'];

/** The set of valid `section` values, derived from SECTIONS (one owner). */
export const SECTION_KEYS = new Set(SECTIONS.map(s => s.key));

// ─── Arc identity ────────────────────────────────────────────────────────────

/**
 * Mint a unique arc id.
 *
 * Chronicle's `Date.now()`-plus-6-random-chars scheme would be fine here in
 * practice (a 30-arc batch inside one millisecond has ~1-in-5-million odds of
 * a collision). The monotonic sequence just makes uniqueness guaranteed rather
 * than merely very likely, for free — worth it because ids are the only handle
 * the UI has on an arc, so a duplicate would alias two cards together for every
 * edit and delete.
 */
let _arcIdSeq = 0;
export function newArcId() {
    _arcIdSeq = (_arcIdSeq + 1) % 1e6;
    return `${Date.now()}-${_arcIdSeq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Beat index is allowed to equal beats.length — that is the READY state. */
export function clampBeatIndex(idx, beatCount) {
    const n = Number(idx);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(Math.floor(n), beatCount);
}

// ─── Store validation ────────────────────────────────────────────────────────

/**
 * Structural arc check used before canonicalization: an arc that fails here
 * is quarantined (its raw record preserved) rather than silently repaired
 * beyond recognition. sanitizeArc() still canonicalizes survivors.
 */
export function checkArc(record) {
    if (!isObject(record)) return { code: 'arc-not-object', message: 'Arc must be an object.' };
    if (!isNonEmptyString(record.id)) return { code: 'arc-missing-id', message: 'Arc id must be a non-empty string.' };
    if (record.title !== undefined && typeof record.title !== 'string') return { code: 'arc-title-not-string', message: 'Arc title must be a string.' };
    if (record.body !== undefined && typeof record.body !== 'string') return { code: 'arc-body-not-string', message: 'Arc body must be a string.' };
    if (!SECTION_KEYS.has(record.section)) return { code: 'arc-invalid-section', message: 'Arc section is invalid.' };
    if (!ARC_STATUSES.includes(record.status)) return { code: 'arc-invalid-status', message: 'Arc status is invalid.' };
    if (!Array.isArray(record.beats) || record.beats.some(beat => typeof beat !== 'string')) {
        return { code: 'arc-invalid-beats', message: 'Arc beats must be an array of strings.' };
    }
    if (!Number.isInteger(record.beatIndex) || record.beatIndex < 0) {
        return { code: 'arc-invalid-beat-index', message: 'Arc beatIndex must be a non-negative integer.' };
    }
    if (!isFiniteNumber(record.turnsSinceAdvance) || record.turnsSinceAdvance < 0) {
        return { code: 'arc-invalid-turns', message: 'Arc turnsSinceAdvance is invalid.' };
    }
    if (!isFiniteNumber(record.createdAt) || !isFiniteNumber(record.updatedAt)) {
        return { code: 'arc-invalid-timestamps', message: 'Arc timestamps must be finite numbers.' };
    }
    return null;
}

/**
 * Validate a Story Planner section: root object, arc list (checked, then
 * canonicalized), and the history container. Unknown keys pass through
 * unchanged, exactly as before. Deep history-entry checks (design §6.5)
 * arrive with Part 2.
 */
export function validateStoryPlannerData(data) {
    const issues = [];
    const stats = emptyStats();
    if (!isObject(data)) {
        issues.push(quarantineIssue('root-not-object', [], 'Story Planner data must be an object.', 'storyPlanner'));
        return { data: {}, issues, stats };
    }
    const accepted = { ...data };
    if (data.arcs !== undefined) {
        const arcs = checkUniqueRecordList(data.arcs, 'arcs', checkArc, { path: ['arcs'] });
        accepted.arcs = sanitizeArcs(arcs.records);
        // Same counting the backup summary always did: the check counts the
        // arcs it accepted; canonicalization never removes one.
        stats.added += arcs.stats.added;
        stats.updated += arcs.stats.updated;
        stats.conflicts += arcs.stats.conflicts;
        issues.push(...arcs.issues);
    }
    if (data.history !== undefined && !Array.isArray(data.history)) {
        delete accepted.history;
        issues.push(quarantineIssue('history-not-array', ['history'], 'Story Planner history must be an array.', 'history'));
    }
    return { data: accepted, issues, stats };
}

/** Story Planner store schema — arcs under their own key since v1. */
export const storyPlannerSchema = defineStoreSchema({
    id: 'storyPlanner',
    metadataKey: 'story_planner_data',
    currentVersion: 1,
    createDefault: () => ({ arcs: [] }),
    migrations: {},
    validate: validateStoryPlannerData,
});
