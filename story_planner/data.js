/**
 * story_planner/data.js — Shared constants, mutable state, and data access.
 *
 * Leaf module — no imports from other story_planner modules.
 *
 * The plan is stored as an array of structured arc objects (see ARC SHAPE
 * below) rather than one opaque blob of text. Plans authored before that change
 * are migrated lazily on first read (see {@link getArcs}).
 */

import { getChatMeta, patchChatMeta } from '../core/index.js';

// ─── Constants ───────────────────────────────────────────────────────────────

export const CHAT_DATA_KEY = 'story_planner_data';
export const EXTENSION_PROMPT_KEY = 'mwt_story_plan_injection';

/**
 * The canonical section list — ONE OWNER OF FORMAT.
 *
 * Everything downstream derives from this: prompts.js builds the FORMAT block
 * the model is asked to follow, the parser maps headings back to `key`, the
 * serializer emits headings in this order, and render.js groups cards by it.
 * Adding a section here is enough to thread it through the whole module.
 *
 * `hint` is shown to the model in the generation prompt; `blurb` is shown to
 * the user in the UI.
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

const SECTION_KEYS = new Set(SECTIONS.map(s => s.key));

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

export function setPlanData(patch) {
    patchChatMeta(CHAT_DATA_KEY, patch);
}

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
export function makeArc({
    title = '', body = '', section = DEFAULT_SECTION, status = 'active',
    pinned = false, beats = [], beatIndex = 0,
} = {}) {
    const now = Date.now();
    const cleanBeats = (Array.isArray(beats) ? beats : [])
        .map(b => String(b).trim())
        .filter(Boolean);
    return {
        id: newArcId(),
        title: String(title).trim(),
        body: String(body).trim(),
        section: SECTION_KEYS.has(section) ? section : DEFAULT_SECTION,
        status: ARC_STATUSES.includes(status) ? status : 'active',
        pinned: !!pinned,
        beats: cleanBeats,
        beatIndex: clampBeatIndex(beatIndex, cleanBeats.length),
        turnsSinceAdvance: 0,
        createdAt: now,
        updatedAt: now,
    };
}

/** Beat index is allowed to equal beats.length — that is the READY state. */
function clampBeatIndex(idx, beatCount) {
    const n = Number(idx);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(Math.floor(n), beatCount);
}

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

export function getSectionMeta(key) {
    return SECTIONS.find(s => s.key === key) || SECTIONS.find(s => s.key === DEFAULT_SECTION);
}

/** Strip markdown emphasis and a leading legacy `[Tag]` from bullet content. */
function cleanBulletContent(raw) {
    return String(raw)
        .replace(/^\s*\[[^\]]{1,24}\]\s*/, '')  // legacy "[Arc] " prefix — never parsed, purely decorative
        .replace(/\*\*/g, '')
        .replace(/^\s*__|__\s*$/g, '')
        .trim();
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
        .replace(/\*\*/g, '')
        .replace(/^\s*(?:NOW|NEXT|BEAT|SETUP)\s*[:—-]\s*/i, '')
        .replace(/^\s*\[[^\]]{1,32}\]\s*/, '')  // our own "[beat 2 of 3 · 6 turns]" marker
        // Trailing progress markers we emit ourselves — stripped so a
        // serialize → parse round-trip does not bake them into the beat text.
        .replace(/\s*\[(?:PLANTED|CURRENT|READY|SETUP COMPLETE)\]\s*$/i, '')
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
 * @returns {object[]} arcs
 */
export function parsePlanTextToArcs(text) {
    if (!text || !String(text).trim()) return [];
    const arcs = [];
    let section = DEFAULT_SECTION;
    let last = null;

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
            if (beat) last.beats.push(beat);
            continue;
        }
        // A numbered line with no arc above it is malformed — skip rather than
        // silently turning it into an arc.
        if (numbered && !last) continue;

        // ── Arc bullet ──
        const bullet = line.match(/^[ \t]{0,3}[-*+][ \t]+(.+)$/);
        if (bullet) {
            const content = cleanBulletContent(bullet[1]);
            if (!content) { last = null; continue; }
            const { title, body } = splitTitleBody(content);
            last = makeArc({ title: stripArcFlags(title), body, section });
            arcs.push(last);
            continue;
        }

        // A wrapped continuation line beneath a bullet — fold it into that
        // arc's body so multi-line descriptions survive the round-trip.
        if (last && /^[ \t]+\S/.test(rawLine) && last.beats.length === 0) {
            last.body = last.body ? `${last.body} ${line.trim()}` : line.trim();
        }
    }
    return arcs;
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

/** Loose title key for matching a regenerated arc to the one it replaces. */
function titleKey(title) {
    return String(title || '').toLowerCase().replace(/[^a-z0-9]/g, '');
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
    setPlanData({ arcs: Array.isArray(arcs) ? arcs : [] });
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
    const next = { ...arcs[idx], ...patch, id: arcs[idx].id, updatedAt: Date.now() };
    if (!SECTION_KEYS.has(next.section)) next.section = DEFAULT_SECTION;
    if (!ARC_STATUSES.includes(next.status)) next.status = 'active';
    const copy = [...arcs];
    copy[idx] = next;
    setArcs(copy);
    return next;
}

export function removeArc(id) {
    const arcs = getArcs();
    const remaining = arcs.filter(a => a.id !== id);
    if (remaining.length === arcs.length) return false;
    setArcs(remaining);
    return true;
}

export function setArcStatus(id, status) {
    return updateArc(id, { status: ARC_STATUSES.includes(status) ? status : 'active' });
}

export function toggleArcPinned(id) {
    const arc = getArcs().find(a => a.id === id);
    if (!arc) return null;
    return updateArc(id, { pinned: !arc.pinned });
}

// ─── Injection mode / steering settings (per chat) ───────────────────────────

export function getInjectMode() {
    const mode = getPlanData().injectMode;
    return INJECT_MODES.some(m => m.key === mode) ? mode : 'all';
}

export function getEnforcement() {
    const mode = getPlanData().enforcement;
    return ENFORCEMENT_MODES.some(m => m.key === mode) ? mode : 'proactive';
}

export function getDirectionHint() {
    return getPlanData().directionHint || '';
}

export function getArcCount() {
    const v = Number(getPlanData().arcCount);
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
    return getPlanData().injectEnabled !== false;
}

// ─── Auto-trigger helpers ────────────────────────────────────────────────────

export function getAutoInterval() {
    const v = getPlanData().autoInterval;
    return Number.isFinite(Number(v)) ? Math.max(1, Number(v)) : 10;
}

export function isAutoEnabled() {
    return getPlanData().autoEnabled === true;
}

export function persistAutoCounter() {
    setPlanData({ autoCounter: state.autoCounter });
}

export function resetAutoCounter() {
    state.autoCounter = 0;
    persistAutoCounter();
}
