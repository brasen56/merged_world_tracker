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
 *   createdAt: number, updatedAt: number,
 * }
 */
export function makeArc({ title = '', body = '', section = DEFAULT_SECTION, status = 'active', pinned = false } = {}) {
    const now = Date.now();
    return {
        id: newArcId(),
        title: String(title).trim(),
        body: String(body).trim(),
        section: SECTION_KEYS.has(section) ? section : DEFAULT_SECTION,
        status: ARC_STATUSES.includes(status) ? status : 'active',
        pinned: !!pinned,
        createdAt: now,
        updatedAt: now,
    };
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
        if (!line.trim()) { last = null; continue; }

        const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
        if (heading) {
            section = sectionKeyFromLabel(heading[1]);
            last = null;
            continue;
        }

        const bullet = line.match(/^[ \t]*[-*+][ \t]+(.+)$/);
        if (bullet) {
            const content = cleanBulletContent(bullet[1]);
            if (!content) { last = null; continue; }
            const { title, body } = splitTitleBody(content);
            last = makeArc({ title, body, section });
            arcs.push(last);
            continue;
        }

        // A wrapped continuation line beneath a bullet — fold it into that
        // arc's body so multi-line descriptions survive the round-trip.
        if (last && /^[ \t]+\S/.test(rawLine)) {
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
export function serializeArcsToText(arcs, { annotateStatus = false } = {}) {
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
            const flag = flags.length ? ` [${flags.join(', ')}]` : '';
            const title = arc.title || '(untitled arc)';
            out.push(arc.body ? `- ${title}${flag} — ${arc.body}` : `- ${title}${flag}`);
        }
        out.push('');
    }
    return out.join('\n').trim();
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

export function getDirectionHint() {
    return getPlanData().directionHint || '';
}

export function getArcCount() {
    const v = Number(getPlanData().arcCount);
    return Number.isFinite(v) ? Math.min(30, Math.max(3, v)) : 10;
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
