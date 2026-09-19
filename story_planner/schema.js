/**
 * story_planner/schema.js — Story Planner store descriptor, arc schema, and
 * canonicalizers.
 *
 * THE module-owned schema for `chat_metadata.story_planner_data` (design
 * §3.2/§6.5 of SCHEMA_VALIDATION_MIGRATIONS_PLAN.md). sanitizeArc/sanitizeArcs,
 * the section/status vocabulary, the arc-id factory, and the beat-index clamp
 * moved here from data.js in Part 1 of the schema plan; Part 2 moves the
 * markdown plan PARSER here too (parsePlanTextToArcs and its helpers — one
 * owner shared by the legacy-plan migration, fresh LLM responses, and history
 * restores), adds the 0 -> 1 migration that retires getArcs()' lazy
 * text-to-arcs path, and the per-store issue policy. data.js imports and
 * re-exports everything unchanged.
 *
 * Pure by contract: no DOM, no SillyTavern runtime, no core barrel, and
 * nothing from story_planner/data.js or story_planner/settings.js (that would
 * be a cycle — data.js imports this file).
 *
 * The metadataKey literal mirrors backup/data.js METADATA_KEYS (and the
 * module's own CHAT_DATA_KEY); test/schema_parity.test.js pins them together.
 */
import {
    checkPlainRecordList,
    defineIssuePolicy,
    defineStoreSchema,
    emptyStats,
    fatalIssue,
    isFiniteNumber,
    isNonEmptyString,
    isObject,
    quarantineIssue,
    repairIssue,
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
export const MAX_PROGRESS_METADATA_ENTRIES = 500;
export const MAX_PROGRESS_IDENTITY_LENGTH = 500;
export const MAX_IGNORED_PROGRESS_EVIDENCE_LENGTH = 2000;
export const MAX_CHARACTER_CONTEXT_ENTITY_ID_LENGTH = 120;
export const STORY_PLANNER_METRIC_COUNTER_MAX = 1_000_000_000;
export const STORY_PALETTE_EMPHASES = Object.freeze(['conflict', 'mystery', 'discovery', 'consequences', 'relationships', 'character growth', 'quiet moments', 'repair/reconciliation']);
export const STORY_PALETTE_ESCALATIONS = Object.freeze(['restrained', 'balanced', 'escalating']);
export const CHARACTER_CONTEXT_MODES = Object.freeze(['off', 'selected', 'active']);

export function sanitizeStoryPalette(value) {
    const raw = isObject(value) ? value : {};
    return {
        emphases: [...new Set(Array.isArray(raw.emphases) ? raw.emphases.map(item => String(item).trim()).filter(item => STORY_PALETTE_EMPHASES.includes(item)).slice(0, STORY_PALETTE_EMPHASES.length) : [])],
        escalation: STORY_PALETTE_ESCALATIONS.includes(raw.escalation) ? raw.escalation : 'balanced',
        allowNewMajorCharacters: raw.allowNewMajorCharacters === true,
    };
}

export function sanitizeCharacterContextSelection(value) {
    const raw = isObject(value) ? value : {};
    return {
        mode: CHARACTER_CONTEXT_MODES.includes(raw.mode) ? raw.mode : 'off',
        entityIds: [...new Set(Array.isArray(raw.entityIds) ? raw.entityIds.map(item => String(item).trim().slice(0, MAX_CHARACTER_CONTEXT_ENTITY_ID_LENGTH)).filter(Boolean).slice(0, 24) : [])],
    };
}

const METRIC_COUNTER_FIELDS = Object.freeze([
    'fullGenerations', 'targetedGenerations', 'targetedApplied',
    'progressChecks', 'progressSuggestions', 'progressNoEvidence',
    'progressAccepted', 'progressIgnored', 'closedRecurrencesSuppressed',
    'requestCount', 'requestChars', 'maxRequestChars',
]);

const METRIC_KINDS = Object.freeze(['full', 'targeted', 'progress']);

/** Canonical, content-free Phase 7 observation counters stored per chat. */
export function sanitizePhase7Metrics(value) {
    const raw = isObject(value) ? value : {};
    const out = {
        startedAt: isFiniteNumber(raw.startedAt) && raw.startedAt >= 0 ? Math.floor(raw.startedAt) : 0,
        updatedAt: isFiniteNumber(raw.updatedAt) && raw.updatedAt >= 0 ? Math.floor(raw.updatedAt) : 0,
    };
    for (const field of METRIC_COUNTER_FIELDS) {
        const number = Number(raw[field]);
        out[field] = Number.isFinite(number)
            ? Math.min(STORY_PLANNER_METRIC_COUNTER_MAX, Math.max(0, Math.floor(number)))
            : 0;
    }
    out.lastRequestAt = isFiniteNumber(raw.lastRequestAt) && raw.lastRequestAt >= 0 ? Math.floor(raw.lastRequestAt) : 0;
    out.lastRequestKind = METRIC_KINDS.includes(raw.lastRequestKind) ? raw.lastRequestKind : '';
    out.lastRequestChars = Number.isFinite(Number(raw.lastRequestChars))
        ? Math.min(STORY_PLANNER_METRIC_COUNTER_MAX, Math.max(0, Math.floor(Number(raw.lastRequestChars))))
        : 0;
    out.lastProgressCheckAt = isFiniteNumber(raw.lastProgressCheckAt) && raw.lastProgressCheckAt >= 0
        ? Math.floor(raw.lastProgressCheckAt) : 0;
    out.lastProgressSuggestions = Number.isFinite(Number(raw.lastProgressSuggestions))
        ? Math.min(STORY_PLANNER_METRIC_COUNTER_MAX, Math.max(0, Math.floor(Number(raw.lastProgressSuggestions))))
        : 0;
    out.lastProgressNoEvidence = Number.isFinite(Number(raw.lastProgressNoEvidence))
        ? Math.min(STORY_PLANNER_METRIC_COUNTER_MAX, Math.max(0, Math.floor(Number(raw.lastProgressNoEvidence))))
        : 0;
    out.lastProgressUpToDate = raw.lastProgressUpToDate === true;
    out.lastProgressStale = raw.lastProgressStale === true;
    return out;
}

/**
 * ARC SHAPE
 * {
 *   id: string, title: string, body: string,
 *   section: 'immediate'|'emerging'|'horizon'|'character'|'unresolved',
 *   status: 'active'|'parked'|'resolved'|'dropped',
 *   pinned: boolean, focused: boolean, activateWhen?: string,
 *   closeReason: string, closedAt: number|null,
 *   beats: Array<{id,text,state,stateReason,updatedAt}>,
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
export const BEAT_STATES = ['pending', 'planted', 'skipped'];

let _beatIdSeq = 0;
export function newBeatId() {
    _beatIdSeq = (_beatIdSeq + 1) % 1e6;
    return `beat-${Date.now()}-${_beatIdSeq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Convert legacy text or an existing record to the canonical v2 beat shape. */
export function sanitizeBeat(raw, { preserveId = true, state = 'pending', updatedAt = 0, fallbackId = '' } = {}) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { text: raw };
    return {
        id: preserveId && isNonEmptyString(src.id) ? String(src.id) : (fallbackId || newBeatId()),
        text: String(src.text ?? '').trim().slice(0, MAX_BEAT_LENGTH),
        state: BEAT_STATES.includes(src.state) ? src.state : (BEAT_STATES.includes(state) ? state : 'pending'),
        stateReason: String(src.stateReason ?? '').trim().slice(0, MAX_BEAT_LENGTH),
        updatedAt: Number.isFinite(Number(src.updatedAt)) ? Number(src.updatedAt) : updatedAt,
    };
}

export function sanitizeArc(raw, { preserveId = true } = {}) {
    const src = (raw && typeof raw === 'object') ? raw : {};
    const now = Date.now();
    const arcId = preserveId && src.id ? String(src.id) : newArcId();
    const rawBeats = Array.isArray(src.beats) ? src.beats : [];
    // v1 applied beatIndex after blank beats had been removed.
    const filteredBeats = rawBeats.filter(beat => {
        const text = typeof beat === 'string' ? beat : beat?.text;
        return String(text ?? '').trim() !== '';
    });
    const legacyIndex = clampBeatIndex(src.beatIndex, filteredBeats.length);
    const seenBeatIds = new Set();
    const beats = filteredBeats.map((beat, index) => {
        const canonical = sanitizeBeat(beat, {
            preserveId: true,
            state: typeof beat === 'string' && index < legacyIndex ? 'planted' : 'pending',
            updatedAt: 0,
            fallbackId: `beat-${arcId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${index + 1}`,
        });
        if (seenBeatIds.has(canonical.id)) canonical.id = uniqueBeatId(arcId, index, seenBeatIds);
        seenBeatIds.add(canonical.id);
        return canonical;
    }).filter(beat => beat.text);
    return {
        id: arcId,
        title: String(src.title ?? '').trim().slice(0, MAX_ARC_TITLE),
        body: String(src.body ?? '').trim().slice(0, MAX_ARC_BODY),
        section: SECTION_KEYS.has(src.section) ? src.section : DEFAULT_SECTION,
        status: ARC_STATUSES.includes(src.status) ? src.status : 'active',
        pinned: src.pinned === true,
        focused: src.focused === true,
        ...(Object.hasOwn(src, 'activateWhen')
            ? { activateWhen: String(src.activateWhen ?? '').trim().slice(0, MAX_ARC_BODY) }
            : {}),
        closeReason: String(src.closeReason ?? '').trim().slice(0, MAX_ARC_BODY),
        closedAt: src.closedAt !== null && src.closedAt !== undefined && Number.isFinite(Number(src.closedAt))
            ? Number(src.closedAt)
            : null,
        beats,
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
    const seenBeatIds = new Set();
    return arcs.map((a, arcIndex) => {
        const arc = sanitizeArc(a, { preserveId: true });
        if (seen.has(arc.id)) arc.id = newArcId();
        seen.add(arc.id);
        for (let beatIndex = 0; beatIndex < arc.beats.length; beatIndex++) {
            const beat = arc.beats[beatIndex];
            if (seenBeatIds.has(beat.id)) beat.id = uniqueBeatId(`${arc.id}-${arcIndex + 1}`, beatIndex, seenBeatIds);
            seenBeatIds.add(beat.id);
        }
        return arc;
    });
}

function uniqueBeatId(arcId, beatIndex, seen) {
    const stem = `beat-${String(arcId).replace(/[^a-zA-Z0-9_-]/g, '_')}-${beatIndex + 1}`;
    let id = stem;
    let suffix = 2;
    while (seen.has(id)) id = `${stem}-${suffix++}`;
    return id;
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

export const ARC_STATUSES = ['active', 'parked', 'resolved', 'dropped'];

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
    return `arc-${Date.now()}-${_arcIdSeq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Beat index is allowed to equal beats.length — that is the READY state. */
export function clampBeatIndex(idx, beatCount) {
    const n = Number(idx);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(Math.floor(n), beatCount);
}

// ─── Markdown plan parsing (moved from data.js, Part 2) ──────────────────────
//
// ONE OWNER OF FORMAT, read side: the parser must sit HERE because the
// v0 -> v1 migration parses legacy plan text with the exact same rules that
// turn a fresh LLM response into arcs — the two can never disagree about what
// counts as an arc.

/** Normalise a heading label for tolerant matching ("## Immediate Hooks:" → "immediatehooks"). */
function normaliseLabel(label) {
    return String(label).toLowerCase().replace(/[^a-z]/g, '');
}

const LABEL_TO_KEY = new Map(SECTIONS.map(s => [normaliseLabel(s.label), s.key]));

/**
 * Resolve a markdown heading to a section key. Unrecognised headings (e.g. from
 * a custom system prompt, or the legacy "Upcoming Arcs") fall back to the
 * default section rather than dropping their bullets on the floor.
 */
export function sectionKeyFromLabel(label) {
    return LABEL_TO_KEY.get(normaliseLabel(label)) || DEFAULT_SECTION;
}

/** Strip markdown emphasis and a leading legacy `[Tag]` from bullet content. */
function cleanBulletContent(raw) {
    return String(raw)
        .replace(/^\s*\[[^\]]{1,24}\]\s*/, '')  // legacy "[Arc] " prefix — never parsed, purely decorative
        .replace(/\*\*/g, '')
        .replace(/^\s*__|__\s*$/g, '')
        .trim();
}

/** A request-local arc handle, wherever the model put it on the line. */
const ARC_HANDLE_RE = /\[\s*ARC\s*:\s*([^\]]*?)\s*\]/gi;
const ARC_HANDLE_STRIP_RE = /\s*\[\s*ARC\s*:[^\]]*\]\s*/gi;

/**
 * Remove every request-local arc handle from a bullet and return the handle
 * separately from the prose.
 *
 * Models do not reliably keep the marker in front of the name: they bold it
 * together with the name (`**[ARC:k7q] Title**`) or move it after the name
 * like the other bracketed annotations. A marker left in place becomes part
 * of the stored title, reaches the narrator, and forks the arc on merge, so
 * it is stripped wherever it appears. Two different handles on one line are
 * ambiguous and identify nothing.
 */
function extractArcHandle(raw) {
    const text = String(raw);
    const found = new Set([...text.matchAll(ARC_HANDLE_RE)]
        .map(match => match[1].toLowerCase())
        .filter(Boolean));
    return {
        handle: found.size === 1 ? [...found][0] : '',
        content: text.replace(ARC_HANDLE_STRIP_RE, ' '),
    };
}

/** Normalize titles for the request-local, unambiguous identity fallback. */
function normaliseArcTitle(title) {
    return String(title || '')
        .toLocaleLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[.!?,;_*#]/g, '');
}

/**
 * Status flags `serializeArcsToText` appends to a title under `annotateStatus`.
 * Built from the same sources the serializer uses so the two can't drift.
 */
const ARC_FLAG_WORDS = [...ARC_STATUSES.map(s => s.toUpperCase()), 'PINNED', 'SETUP COMPLETE'];
const ARC_FLAG_ALT = ARC_FLAG_WORDS.join('|');
const ARC_FLAG_RE = new RegExp(
    `\\s*\\[(?:${ARC_FLAG_ALT})(?:\\s*,\\s*(?:${ARC_FLAG_ALT}))*\\]\\s*$`, 'i',
);

/**
 * Strip a trailing "[PINNED]" / "[RESOLVED, SETUP COMPLETE]" off a parsed title.
 *
 * The annotated plan is what regeneration hands the model, so a model that
 * echoes a title back hands the flag back with it. Left in, the flag becomes
 * part of the stored title — and since titles are the merge key, the arc no
 * longer matches the one it came from and gets duplicated alongside it.
 * Symmetric to the [PLANTED]/[CURRENT] strip in {@link cleanBeatContent}.
 */
function stripArcFlags(title) {
    return String(title).replace(ARC_FLAG_RE, '').trim();
}

/** Strip the leading marker and any "NOW:"/"NEXT:" label off a beat line. */
function cleanBeatContent(raw) {
    return String(raw)
        // Handles identify arcs only; one copied onto a beat is never beat text.
        .replace(ARC_HANDLE_STRIP_RE, ' ')
        .replace(/\*\*/g, '')
        .replace(/^\s*(?:NOW|NEXT|BEAT|SETUP)\s*[:—-]\s*/i, '')
        .replace(/^\s*\[[^\]]{1,32}\]\s*/, '')  // our own "[beat 2 of 3 · 6 turns]" marker
        // Trailing progress markers we emit ourselves — stripped so a
        // serialize → parse round-trip does not bake them into the beat text.
        .replace(/\s*\[(?:PLANTED|SKIPPED|CURRENT|READY|SETUP COMPLETE)\]\s*$/i, '')
        .trim();
}

/**
 * Split a bullet into title + body. Prefers an em/en-dash or colon separator
 * (the format the prompt asks for); falls back to the first sentence, and
 * finally to a length cut so a title is never absurdly long.
 */
function splitTitleBody(content) {
    const dash = content.match(/^(.{2,90}?)\s*[—–]\s*(.+)$/s);
    if (dash) return { title: dash[1].trim(), body: dash[2].trim() };

    const hyphen = content.match(/^(.{2,90}?)\s+-\s+(.+)$/s);
    if (hyphen) return { title: hyphen[1].trim(), body: hyphen[2].trim() };

    const colon = content.match(/^([^:]{2,90}?):\s+(.+)$/s);
    if (colon) return { title: colon[1].trim(), body: colon[2].trim() };

    if (content.length <= 70) return { title: content, body: '' };

    const sentence = content.match(/^(.{2,90}?[.!?])\s+(.+)$/s);
    if (sentence) return { title: sentence[1].trim(), body: sentence[2].trim() };

    return { title: `${content.slice(0, 67).trim()}…`, body: content };
}

/**
 * Parse a markdown plan document into arcs.
 *
 * Used for BOTH the migration of legacy single-blob plans and for turning a
 * fresh LLM response into arc objects, so the two can never disagree about what
 * counts as an arc.
 *
 * @param {string} text
 * @param {object} [options] regeneration identity; see resolveCapturedIdentities
 * @param {Map<string, object>} [options.handles] lowercase handle → captured arc
 * @param {object[]} [options.capturedArcs] the arcs shown to the model
 * @returns {object[]} arcs
 */
export function parsePlanTextToArcs(text, options = {}) {
    if (!text || !String(text).trim()) return [];
    const arcs = [];
    let section = DEFAULT_SECTION;
    let last = null;
    const identities = [];

    for (const rawLine of String(text).split(/\r?\n/)) {
        const line = rawLine.trimEnd();
        // A blank line does NOT end an arc any more — beats are often separated
        // from their arc bullet by one. Only a heading or a new bullet does.
        if (!line.trim()) continue;

        const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
        if (heading) {
            section = sectionKeyFromLabel(heading[1]);
            last = null;
            continue;
        }

        // ── Beats ──
        // Checked BEFORE the arc bullet, because an indented "- foo" would
        // otherwise match as a new arc. Two accepted forms, since models are
        // inconsistent: a numbered line at any indent, or an indented bullet.
        const numbered = line.match(/^[ \t]*\d+[.)][ \t]+(.+)$/);
        const indentedBullet = line.match(/^(?:[ \t]{2,}|\t)[-*+][ \t]+(.+)$/);
        const beatMatch = numbered || indentedBullet;
        if (beatMatch && last) {
            const beat = cleanBeatContent(beatMatch[1]);
            if (beat) last.beats.push(sanitizeBeat(beat));
            continue;
        }
        // A numbered line with no arc above it is malformed — skip rather than
        // silently turning it into an arc.
        if (numbered && !last) continue;

        // ── Arc bullet ──
        const bullet = line.match(/^[ \t]{0,3}[-*+][ \t]+(.+)$/);
        if (bullet) {
            const extracted = extractArcHandle(bullet[1]);
            const content = cleanBulletContent(extracted.content);
            if (!content) { last = null; continue; }
            const { title, body } = splitTitleBody(content);
            // preserveId:false mints a fresh id — identical to data.js's
            // makeArc(), which is just sanitizeArc with this option. A captured
            // identity, if any, replaces it once the whole response is read.
            last = sanitizeArc({ title: stripArcFlags(title), body, section }, { preserveId: false });
            arcs.push(last);
            identities.push({ arc: last, handle: extracted.handle });
            continue;
        }

        // A wrapped continuation line beneath a bullet — fold it into that
        // arc's body so multi-line descriptions survive the round-trip.
        // STORY-PLANNER-06: The old `last.beats.length === 0` guard dropped
        // wrapped prose that appeared AFTER a beat list, silently losing the
        // continuation. Fold into the body regardless of whether beats exist.
        if (last && /^[ \t]+\S/.test(rawLine)) {
            const continuation = line.trim();
            // Don't fold beat-like lines (numbered or already handled above).
            if (!numbered && !indentedBullet) {
                last.body = last.body ? `${last.body} ${continuation}` : continuation;
            }
        }
    }
    resolveCapturedIdentities(identities, options);
    return arcs;
}

/**
 * Give parsed arcs the ids of the captured arcs they carry forward.
 *
 * Handles are resolved for the whole response before any title fallback, so
 * the line that kept its marker claims the arc even when a marker-less copy
 * appears earlier. A handle binds only when it is valid for this request,
 * appears on exactly one line, and does not contradict the line's title: a
 * title that exactly names a different captured arc means the markers were
 * swapped or copied, and moving planted progress on that evidence is worse
 * than leaving identity to the title. A handle that fails any check is treated
 * as absent, so the unambiguous-title fallback still applies to its line.
 *
 * @param {{arc: object, handle: string}[]} identities parsed arcs in order
 * @param {object} options
 * @param {Map<string, object>} [options.handles] lowercase handle → captured arc
 * @param {object[]} [options.capturedArcs] the arcs shown to the model
 */
function resolveCapturedIdentities(identities, options) {
    const handles = options.handles instanceof Map ? options.handles : new Map();
    const captured = Array.isArray(options.capturedArcs) ? options.capturedArcs : [];
    if (!identities.length || (!handles.size && !captured.length)) return;

    const byTitle = new Map();
    for (const arc of captured) {
        const key = normaliseArcTitle(arc.title);
        if (!key) continue;
        byTitle.set(key, [...(byTitle.get(key) || []), arc]);
    }
    const lines = new Map();
    for (const { handle } of identities) {
        if (handle) lines.set(handle, (lines.get(handle) || 0) + 1);
    }

    const claimed = new Set();
    const bound = new Set();
    for (const entry of identities) {
        const target = entry.handle && lines.get(entry.handle) === 1
            ? handles.get(entry.handle) : null;
        if (!target || claimed.has(target.id)) continue;
        const titled = byTitle.get(normaliseArcTitle(entry.arc.title)) || [];
        if (titled.length && !titled.some(arc => arc.id === target.id)) continue;
        entry.arc.id = target.id;
        claimed.add(target.id);
        bound.add(entry);
    }
    for (const entry of identities) {
        if (bound.has(entry)) continue;
        const titled = byTitle.get(normaliseArcTitle(entry.arc.title)) || [];
        if (titled.length !== 1 || claimed.has(titled[0].id)) continue;
        entry.arc.id = titled[0].id;
        claimed.add(titled[0].id);
    }
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
    if (!Array.isArray(record.beats)) {
        return { code: 'arc-invalid-beats', message: 'Arc beats must be an array.' };
    }
    for (const beat of record.beats) {
        if (!isObject(beat) || typeof beat.text !== 'string' || !beat.text.trim()
            || !BEAT_STATES.includes(beat.state)
            || (beat.stateReason !== undefined && typeof beat.stateReason !== 'string')
            || (beat.updatedAt !== undefined && !isFiniteNumber(beat.updatedAt))) {
            return { code: 'arc-invalid-beat-record', message: 'Arc beat records must have text, a valid state, reason, and timestamp.' };
        }
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
        // Fatal-root policy (design §3.5, category 4): block the store with the
        // raw value preserved instead of loading an empty one.
        issues.push(fatalIssue('root-not-object', [], 'Story Planner data must be an object.', data, 'storyPlanner'));
        return { data: {}, issues, stats };
    }
    const accepted = { ...data };
    if (data.arcs !== undefined) {
        // Deliberately the NON-deduplicating check: sanitizeArcs() below mints
        // a fresh id for a duplicate arc id (STORY-PLANNER-09), so repeats are
        // resolved by canonicalization rather than quarantined here. When §6.5
        // moves Story Planner to quarantine-on-duplicate, this becomes
        // checkRecordList — the deduplicating twin.
        const arcs = checkPlainRecordList(data.arcs, 'arcs', checkArc, { path: ['arcs'] });
        accepted.arcs = sanitizeArcs(arcs.records);
        collectBeatIdIssues(arcs.records, ['arcs'], issues);
        // Same counting the backup summary always did: the check counts the
        // arcs it accepted; canonicalization never removes one.
        stats.added += arcs.stats.added;
        stats.updated += arcs.stats.updated;
        stats.conflicts += arcs.stats.conflicts;
        issues.push(...arcs.issues);
    }
    if (data.history !== undefined && !Array.isArray(data.history)) {
        delete accepted.history;
        issues.push(quarantineIssue('history-not-array', ['history'], 'Story Planner history must be an array.', data.history, 'history'));
    } else if (Array.isArray(data.history)) {
        accepted.history = [];
        for (let index = 0; index < data.history.length; index++) {
            const entry = data.history[index];
            if (!isObject(entry)) {
                issues.push(quarantineIssue('history-entry-invalid', ['history', index], 'Story Planner history entries must be objects.', entry, index));
                continue;
            }
            if (entry.arcs !== undefined && !Array.isArray(entry.arcs)) {
                issues.push(quarantineIssue('history-arcs-invalid', ['history', index, 'arcs'], 'Story Planner history arcs must be an array.', entry, index));
                continue;
            }
            if (Array.isArray(entry.arcs)) {
                const checked = checkPlainRecordList(entry.arcs, 'history arcs', checkArc, { path: ['history', index, 'arcs'] });
                issues.push(...checked.issues);
                collectBeatIdIssues(checked.records, ['history', index, 'arcs'], issues);
                accepted.history.push({ ...entry, arcs: sanitizeArcs(checked.records) });
            } else {
                accepted.history.push({ ...entry });
            }
        }
    }
    canonicalizeProgressMetadata(data, accepted, issues);
    if (data.storyPalette !== undefined) {
        accepted.storyPalette = sanitizeStoryPalette(data.storyPalette);
        if (JSON.stringify(accepted.storyPalette) !== JSON.stringify(data.storyPalette)) {
            issues.push(repairIssue('story-palette-canonicalized', ['storyPalette'], 'Story Planner palette preferences were canonicalized to the supported bounded values.', data.storyPalette));
        }
    }
    if (data.characterContext !== undefined) {
        accepted.characterContext = sanitizeCharacterContextSelection(data.characterContext);
        if (JSON.stringify(accepted.characterContext) !== JSON.stringify(data.characterContext)) {
            issues.push(repairIssue('character-context-canonicalized', ['characterContext'], 'Story Planner character-context selection was canonicalized to bounded values.', data.characterContext));
        }
    }
    if (data.phase7Metrics !== undefined) {
        accepted.phase7Metrics = sanitizePhase7Metrics(data.phase7Metrics);
        if (JSON.stringify(accepted.phase7Metrics) !== JSON.stringify(data.phase7Metrics)) {
            issues.push(repairIssue('phase7-metrics-canonicalized', ['phase7Metrics'], 'Story Planner observation metrics were canonicalized to bounded content-free values.', data.phase7Metrics));
        }
    }
    return { data: accepted, issues, stats };
}

function liveProgressItemKeys(arcs) {
    const keys = new Set();
    for (const arc of arcs || []) {
        keys.add(`arc:${arc.id}`);
        for (const beat of arc.beats || []) keys.add(`beat:${arc.id}:${beat.id}`);
    }
    return keys;
}

/** Canonicalize bounded Phase 5 scan cursors and ignored-evidence fingerprints. */
function canonicalizeProgressMetadata(raw, accepted, issues) {
    const itemKeys = liveProgressItemKeys(accepted.arcs);
    if (raw.progressWatermarks !== undefined) {
        accepted.progressWatermarks = {};
        if (!isObject(raw.progressWatermarks)) {
            issues.push(repairIssue('progress-watermarks-invalid', ['progressWatermarks'], 'Progress watermarks must be an object map and were reset.', raw.progressWatermarks));
        } else {
            const valid = [];
            for (const [key, value] of Object.entries(raw.progressWatermarks)) {
                if (!itemKeys.has(key)) continue;
                const identity = typeof value === 'string' ? value : value?.identity;
                const index = typeof value === 'string' ? undefined : value?.index;
                if (!isNonEmptyString(identity) || String(identity).length > MAX_PROGRESS_IDENTITY_LENGTH
                    || (index !== undefined && (!Number.isSafeInteger(index) || index < 0))) continue;
                valid.push([key, index === undefined
                    ? String(identity)
                    : { identity: String(identity), index }]);
            }
            for (const [key, value] of valid.slice(-MAX_PROGRESS_METADATA_ENTRIES)) {
                accepted.progressWatermarks[key] = value;
            }
            if (Object.keys(accepted.progressWatermarks).length !== Object.keys(raw.progressWatermarks).length) {
                issues.push(repairIssue('progress-watermarks-pruned', ['progressWatermarks'], 'Invalid, excess, or orphaned progress watermarks were removed.', raw.progressWatermarks));
            }
        }
    }
    if (raw.ignoredProgressEvidence !== undefined) {
        if (!Array.isArray(raw.ignoredProgressEvidence)) {
            accepted.ignoredProgressEvidence = [];
            issues.push(repairIssue('ignored-progress-evidence-invalid', ['ignoredProgressEvidence'], 'Ignored progress evidence must be an array and was reset.', raw.ignoredProgressEvidence));
        } else {
            const valid = raw.ignoredProgressEvidence.filter(value => {
                if (typeof value !== 'string' || value.length > MAX_IGNORED_PROGRESS_EVIDENCE_LENGTH) return false;
                const parts = value.split('\u0000');
                return parts.length === 3 && itemKeys.has(parts[0])
                    && isNonEmptyString(parts[1]) && parts[1].length <= MAX_PROGRESS_IDENTITY_LENGTH
                    && isNonEmptyString(parts[2]);
            });
            accepted.ignoredProgressEvidence = [...new Set(valid)].slice(-MAX_PROGRESS_METADATA_ENTRIES);
            if (accepted.ignoredProgressEvidence.length !== raw.ignoredProgressEvidence.length) {
                issues.push(repairIssue('ignored-progress-evidence-pruned', ['ignoredProgressEvidence'], 'Invalid, duplicate, excess, or orphaned ignored progress evidence was removed.', raw.ignoredProgressEvidence));
            }
        }
    }
}

function collectBeatIdIssues(arcs, path, issues) {
    const seen = new Set();
    for (let arcIndex = 0; arcIndex < arcs.length; arcIndex++) {
        const rawBeats = arcs[arcIndex]?.beats;
        if (!Array.isArray(rawBeats)) continue;
        for (let beatIndex = 0; beatIndex < rawBeats.length; beatIndex++) {
            const id = rawBeats[beatIndex]?.id;
            const issuePath = [...path, arcIndex, 'beats', beatIndex, 'id'];
            if (!isNonEmptyString(id)) {
                issues.push(repairIssue('beat-id-minted', issuePath, 'A missing beat id was replaced with a stable id.', rawBeats[beatIndex]));
            } else if (seen.has(String(id))) {
                issues.push(repairIssue('beat-id-duplicate', issuePath, 'A duplicate beat id was replaced so both beats remain independently addressable.', rawBeats[beatIndex]));
            }
            if (isNonEmptyString(id)) seen.add(String(id));
        }
    }
}

// ─── Migration (design §4.2 / §6.5, Part 2) ──────────────────────────────────

/**
 * v0 -> v1: convert a legacy single-blob text plan into structured arcs.
 *
 * Mirrors the lazy conversion getArcs() used to perform on first read — same
 * parser, same "keep the original text" recovery rule — but as a pure,
 * idempotent step: once `arcs` is an array the migration is a no-op. The old
 * `text` field is deliberately LEFT IN PLACE rather than deleted; the
 * migration is a parse, and keeping the original means a bad parse is
 * recoverable instead of destructive (design §12).
 *
 * A PRESENT but non-array `arcs` is corrupt, not legacy. The lazy path fell
 * straight through to the text conversion and overwrote it; here the raw
 * container is QUARANTINED first, so the conversion still returns the user's
 * plan without the rejected value being destroyed on the way (design §5.2:
 * never drop what was rejected). The code and message match the v1
 * validator's own `not-an-array` finding so summaries do not churn depending
 * on which path rejected it.
 *
 * A NON-OBJECT root is returned untouched for the validation gate to block
 * (fatal-root policy, design §3.5 category 4) — never replaced with an empty
 * store here.
 */
export function migrateStoryPlannerV0ToV1(data) {
    const issues = [];
    if (!isObject(data)) return { data, issues };
    const next = { ...data };
    if (!Array.isArray(next.arcs)) {
        if (next.arcs !== undefined) {
            issues.push(quarantineIssue('not-an-array', ['arcs'], 'arcs must be an array.', next.arcs, 'arcs'));
        }
        const legacy = typeof next.text === 'string' ? next.text : '';
        const migrated = sanitizeArcs(parsePlanTextToArcs(legacy));
        next.arcs = migrated;
        if (legacy.trim()) {
            // Only flag the marker when something was actually converted —
            // exactly what the lazy path did.
            if (migrated.length > 0) next._migratedFromText = true;
            issues.push(repairIssue(
                'plan-text-migrated',
                ['text'],
                `Migrated legacy plan text to ${migrated.length} arc(s); the original text was retained.`,
                legacy,
            ));
        }
    }
    return { data: next, issues };
}

/** v1 -> v2: make beat progress and lifecycle decisions explicit and durable. */
export function migrateStoryPlannerV1ToV2(data) {
    if (!isObject(data)) return { data, issues: [] };
    const migrateArc = raw => {
        const arc = sanitizeArc(raw, { preserveId: true });
        // Migration can run more than once before a confirmation commits. IDs
        // derived from durable arc identity + position make the same v1 input
        // produce the same preview while becoming ordinary stable v2 IDs once
        // stored. Existing nested ids, if present, are never replaced here.
        arc.beats = arc.beats.map((beat, index) => ({
            ...beat,
            id: isObject(raw?.beats?.[index]) && isNonEmptyString(raw.beats[index].id)
                ? String(raw.beats[index].id)
                : `beat-${String(arc.id).replace(/[^a-zA-Z0-9_-]/g, '_')}-${index + 1}`,
        }));
        return arc;
    };
    const next = { ...data, arcs: Array.isArray(data.arcs) ? data.arcs.map(migrateArc) : [] };
    if (Array.isArray(data.history)) {
        next.history = data.history.map(entry => isObject(entry) && Array.isArray(entry.arcs)
            ? { ...entry, arcs: entry.arcs.map(migrateArc) }
            : entry);
    }
    if (next.injectMode === 'active') next.injectMode = 'all';
    if (isObject(next.settingsOverride) && next.settingsOverride.injectMode === 'active') {
        next.settingsOverride = { ...next.settingsOverride, injectMode: 'all' };
    }
    return { data: next, issues: [] };
}

/** Story Planner store schema — arcs under their own key since v1. */
export const storyPlannerSchema = defineStoreSchema({
    id: 'storyPlanner',
    metadataKey: 'story_planner_data',
    currentVersion: 2,
    createDefault: () => ({ arcs: [] }),
    migrations: { 0: migrateStoryPlannerV0ToV1, 1: migrateStoryPlannerV1ToV2 },
    validate: validateStoryPlannerData,
    policy: defineIssuePolicy({
        repair: [
            'plan-text-migrated', 'beat-id-minted', 'beat-id-duplicate',
            'progress-watermarks-invalid', 'progress-watermarks-pruned',
            'ignored-progress-evidence-invalid', 'ignored-progress-evidence-pruned',
            'phase7-metrics-canonicalized',
        ],
        fatal: ['root-not-object'],
        record: [
            'not-an-array',
            'arc-not-object',
            'arc-missing-id',
            'arc-title-not-string',
            'arc-body-not-string',
            'arc-invalid-section',
            'arc-invalid-status',
            'arc-invalid-beats',
            'arc-invalid-beat-record',
            'arc-invalid-turns',
            'arc-invalid-timestamps',
            'history-not-array',
            'history-entry-invalid',
            'history-arcs-invalid',
        ],
    }),
});
