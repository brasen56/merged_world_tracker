/**
 * world_state/provenance.js — Entity provenance tracking, stale-entry expiry,
 * and the anti-invention grounding gate.
 *
 * Implements §5 of STALE_ENTRY_EXPIRY_DESIGN.md:
 *   §5.1 buildProvenance()  — deterministic, no-LLM last-touch tracking.
 *   §5.2 applyExpiry()      — drop/quarantine/mark entries stale beyond a
 *                             configurable message-age threshold.
 *   §5.3 groundingGate()    — strip (soft) or reject (strict) bolded names in
 *                             freshly generated text that don't appear
 *                             anywhere in the scan window, prior state, the
 *                             pinned-entities list, or the knowledge
 *                             registry's user-approved alias list (TODO §1
 *                             identity service — collectRegistryAliasGroups).
 *
 * Leaf-ish module — imports only data.js / settings.js (+ core) to avoid
 * circular deps with refresh.js / sections.js, which import this instead.
 */

import { getChat, getStableHistoryEnd, wholePhraseRegex } from '../core/index.js';
import {
    getWorldStateText, getProvenance, getMaxScanMessages,
    extractOnlySection, replaceSection,
} from './data.js';
import { getSettings } from './settings.js';

// ─── Name extraction ─────────────────────────────────────────────────────────

/**
 * Extract entity names from the world-state text: bolded tokens that open a
 * line (optionally after a "- " bullet marker), e.g. "**Dr. Aboud**: ..." or
 * "- **Lorraine** [Off-Screen]". Conservative by design (see design doc's
 * Risks table) — only acts on bold tokens that already parse cleanly, and
 * tracks which "## Section" each name was found under.
 *
 * TODO(§9): reuse the Knowledge module's NPC scan for a chat-side name source
 * instead of/alongside this text-only extraction, once a shared
 * `extractEntityNames()` helper exists in core/.
 */
export function extractBoldNames(text) {
    const names = new Map(); // normalized key -> { key, label, section }
    if (!text) return [];

    let currentSection = null;
    for (const line of text.split('\n')) {
        const sectionHeader = line.match(/^#{1,6}\s+(.+?)\s*$/);
        if (sectionHeader) { currentSection = sectionHeader[1].trim(); continue; }

        const bold = line.match(/^\s*(?:[-*]\s*)?\*\*([^*]+)\*\*/);
        if (!bold) continue;

        const label = bold[1].trim().replace(/[:.,;]+$/, '');
        if (!label || label.length > 60 || !/^[A-Z]/.test(label)) continue;

        const key = label.toLowerCase();
        if (!names.has(key)) names.set(key, { key, label, section: currentSection });
    }
    return [...names.values()];
}

// ─── Message-index sanity ────────────────────────────────────────────────────
// `lastTouchedMsg` is a chat-array index, which we treat as if chat length only
// grows. That assumption breaks if messages are deleted or consolidated
// (bulk delete, "delete above/below", or a summarization extension that
// splices raw messages out and replaces them with a condensed one) — chat.length
// can shrink below indices recorded earlier. A stored index beyond the current
// chat bounds is no longer trustworthy; treat it as "unknown" (null) rather
// than compute a nonsensical negative age from it.
function sanitizeLastTouchedMsg(lastTouchedMsg, currentMsgIndex) {
    if (lastTouchedMsg === null || lastTouchedMsg === undefined) return null;
    if (lastTouchedMsg > currentMsgIndex) return null;
    return lastTouchedMsg;
}

// ─── Scan window (with chat indices) ────────────────────────────────────────

function getScanWindowWithIndices() {
    const max = getMaxScanMessages(getSettings());
    const chat = getChat() || [];
    // Align with getRecentMessagesForScan(): only settled history can mark an
    // entity as touched, so a swiped/discarded turn is deferred rather than
    // recorded as provenance.
    const end = getStableHistoryEnd(chat);
    const start = Math.max(0, end - max);
    const out = [];
    for (let i = start; i < end; i++) {
        const text = String(chat[i]?.mes || '');
        if (text.trim()) out.push({ index: i, text });
    }
    return out;
}

// ─── Build ───────────────────────────────────────────────────────────────────

/**
 * Deterministic, no-LLM pass — safe to call often. Merges into the existing
 * provenance record so entities that fell out of the current scan window
 * (or out of the text entirely) keep their prior `lastTouchedMsg` instead of
 * being silently forgotten (§5.1 step 4). Does not remove or edit anything —
 * building provenance never touches world-state text.
 */
export function buildProvenance() {
    const text = getWorldStateText();
    const scan = getScanWindowWithIndices();
    const priorEntities = getProvenance().entities || {};
    const namesInText = extractBoldNames(text);
    const namesInTextKeys = new Set(namesInText.map(n => n.key));

    // Union: names currently in the text + names only surviving in prior
    // provenance history (so a build never regresses an entry that simply
    // rolled out of the visible text — expiry, not build, decides removal).
    // Cap growth (§10 risk: "Provenance grows unbounded"): a prior-only entry
    // (no longer in the text at all) is dropped once it's more than 2x the
    // expiry threshold old, rather than carried forward forever.
    const currentMsgIndex = (getChat() || []).length;
    const pruneAfter = 2 * (getSettings().expiryStaleAfterMsgs || 40);
    const candidates = new Map(namesInText.map(n => [n.key, n]));
    for (const [key, entry] of Object.entries(priorEntities)) {
        if (candidates.has(key)) continue;
        const lt = entry.lastTouchedMsg;
        if (lt !== null && lt !== undefined) {
            // Drop rather than carry forward when the record is either too old,
            // or invalid (points past the current chat — see sanitizeLastTouchedMsg).
            if (lt > currentMsgIndex || currentMsgIndex - lt > pruneAfter) continue;
        }
        candidates.set(key, { key, label: entry.label, section: entry.section });
    }

    const now = Date.now();
    const entities = {};
    for (const [key, info] of candidates) {
        const prior = priorEntities[key];
        let lastTouchedMsg = sanitizeLastTouchedMsg(prior?.lastTouchedMsg ?? null, currentMsgIndex);
        let foundInWindow = false;
        let windowMentions = 0;

        const escaped = info.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`\\b${escaped}\\b`, 'i');
        for (const { index, text: msgText } of scan) {
            if (!re.test(msgText)) continue;
            foundInWindow = true;
            windowMentions += 1;
            if (lastTouchedMsg === null || index > lastTouchedMsg) lastTouchedMsg = index;
        }
        // Only carry forward the prior cumulative count for entities that fell
        // out of the current scan window. Entities still present in the window
        // get a fresh count of their actual mentions this pass — previously
        // every pass re-counted all overlapping messages and added them to the
        // prior total, so mentionCount grew without bound on each rebuild.
        const mentionCount = foundInWindow
            ? windowMentions
            : (prior?.mentionCount ?? 0);

        entities[key] = {
            label: info.label,
            lastTouchedMsg,
            lastTouchedAt: foundInWindow ? now : (prior?.lastTouchedAt ?? now),
            source: prior?.source || (namesInTextKeys.has(key) ? 'chat' : 'prior-state'),
            section: info.section || prior?.section || null,
            mentionCount,
        };
    }

    return {
        entities,
        lastBuiltAtMsgIndex: (getChat() || []).length,
        schemaVersion: 1,
    };
}

// ─── Read-only queries (for UI) ──────────────────────────────────────────────

/**
 * Entities sorted by staleness (oldest last-touch first). `age` is null for
 * entities never seen in any scan window (grace-cycle candidates per §5.2).
 * Purely a readout — nothing here removes or flags entries in storage.
 */
export function getStalenessReport() {
    const prov = getProvenance();
    const currentMsgIndex = (getChat() || []).length;

    return Object.entries(prov.entities || {})
        .map(([key, e]) => {
            const lt = sanitizeLastTouchedMsg(e.lastTouchedMsg, currentMsgIndex);
            return {
                key,
                label: e.label,
                section: e.section,
                lastTouchedMsg: lt,
                age: lt === null ? null : currentMsgIndex - lt,
                mentionCount: e.mentionCount,
                source: e.source,
            };
        })
        .sort((a, b) => (b.age ?? -1) - (a.age ?? -1));
}

// ─── Expiry (§5.2) ────────────────────────────────────────────────────────────

// The active cast is never expired — these sections are exempt even if a
// caller mistakenly includes them in expirySections.
const NEVER_EXPIRE_SECTIONS = new Set(['Current Scene', 'Key Character States']);

const ARCHIVE_SECTION = 'Archive (Stale)';

function matchBoldLine(line) {
    const bold = line.match(/^\s*(?:[-*]\s*)?\*\*([^*]+)\*\*/);
    if (!bold) return null;
    return bold[1].trim().replace(/[:.,;]+$/, '');
}

/**
 * Apply the configured expiry policy to `text`, using `provenance` to decide
 * which bolded entries are stale. Deterministic, no LLM call. Only acts on
 * lines that parse as a bolded entry (§10 risk mitigation) and never touches
 * `NEVER_EXPIRE_SECTIONS`. Entities with no provenance record at all (never
 * seen in any scan window) get a grace cycle — never auto-acted on — so a
 * brand-new entry introduced in the latest message can't be nuked before its
 * first `buildProvenance()` pass has a chance to see it.
 *
 * @returns {{ text: string, changed: boolean, report: Array }}
 */
export function applyExpiry(text, provenance, opts = {}) {
    const {
        staleAfterMsgs = 40,
        sections = [],
        mode = 'mark', // 'mark' | 'quarantine' | 'remove'
        pinned = [],
        currentMsgIndex = 0,
    } = opts;

    if (!text) return { text, changed: false, report: [] };

    const pinnedSet = new Set(pinned.map(p => p.toLowerCase().trim()).filter(Boolean));
    const entities = provenance?.entities || {};
    const targetSections = sections.filter(s => !NEVER_EXPIRE_SECTIONS.has(s));

    const report = [];
    const quarantineLines = [];
    let workingText = text;

    for (const sectionName of targetSections) {
        const block = extractOnlySection(workingText, sectionName);
        if (!block) continue;

        const lines = block.split('\n');
        const kept = [];
        for (const line of lines) {
            if (/^#{1,6}\s/.test(line)) { kept.push(line); continue; }

            const label = matchBoldLine(line);
            if (!label) { kept.push(line); continue; }

            const key = label.toLowerCase();
            if (pinnedSet.has(key)) { kept.push(line); continue; }

            const entry = entities[key];
            const lastTouchedMsg = entry ? sanitizeLastTouchedMsg(entry.lastTouchedMsg, currentMsgIndex) : null;
            if (lastTouchedMsg === null) {
                kept.push(line); // grace cycle — no trustworthy provenance right now
                continue;
            }

            const age = currentMsgIndex - lastTouchedMsg;
            if (age <= staleAfterMsgs) { kept.push(line); continue; }

            report.push({ key, label, section: sectionName, age });

            if (mode === 'mark') {
                kept.push(/\(stale[^)]*\)\s*$/.test(line) ? line : `${line} (stale — last seen ${age} msgs ago)`);
            } else if (mode === 'quarantine') {
                quarantineLines.push(line.replace(/\s*\(stale[^)]*\)\s*$/, ''));
            } else if (mode === 'remove') {
                // dropped entirely
            } else {
                kept.push(line);
            }
        }

        const newBlock = kept.join('\n');
        if (newBlock !== block) workingText = replaceSection(workingText, sectionName, newBlock);
    }

    if (mode === 'quarantine' && quarantineLines.length > 0) {
        const existingArchive = extractOnlySection(workingText, ARCHIVE_SECTION);
        const existingLines = existingArchive
            ? existingArchive.split('\n').slice(1).filter(l => l.trim())
            : [];
        const existingKeys = new Set(existingLines.map(l => matchBoldLine(l)?.toLowerCase()).filter(Boolean));
        const freshLines = quarantineLines.filter(l => {
            const key = matchBoldLine(l)?.toLowerCase();
            return key && !existingKeys.has(key);
        });
        const merged = [`## ${ARCHIVE_SECTION}`, ...existingLines, ...freshLines].join('\n');
        workingText = replaceSection(workingText, ARCHIVE_SECTION, merged);
    }

    return { text: workingText, changed: report.length > 0, report };
}

/** Manual "Purge stale entries" (§8) — always runs in 'remove' mode regardless of the configured expiryMode. */
export function purgeStaleEntries(text, provenance, opts = {}) {
    return applyExpiry(text, provenance, { ...opts, mode: 'remove' });
}

// ─── Grounding gate (§5.3) ────────────────────────────────────────────────────

const TITLE_WORDS = new Set(['dr', 'mr', 'mrs', 'ms', 'miss', 'sir', 'lord', 'lady', 'captain', 'doctor', 'professor', 'the']);

/**
 * Whether `label` is "grounded" — i.e. plausibly traceable to something the
 * model could actually know about, rather than invented outright. Tests each
 * significant word of the label (skipping short words/titles) as a whole-word,
 * case-insensitive match against the haystacks. Word-level (not full-label)
 * matching is intentional: a character introduced as "Dr. Aboud" should still
 * be considered grounded if only "Aboud" appears in the scan window.
 */
function nameIsGrounded(label, haystacks) {
    const words = label
        .split(/\s+/)
        .map(w => w.replace(/[^A-Za-z'-]/g, ''))
        .filter(w => w.length >= 3 && !TITLE_WORDS.has(w.toLowerCase()));
    const candidates = words.length ? words : [label];
    return candidates.some(word => {
        const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`\\b${escaped}\\b`, 'i');
        return haystacks.some(h => re.test(h));
    });
}

/**
 * Whether `alias` appears in the evidence as a whole PHRASE — all of its
 * words, in order, separated by any run of whitespace, case-insensitive.
 *
 * Aliases are deliberately NOT matched by {@link nameIsGrounded}'s word-level
 * rule, even though that rule is right for canonical names ("Aboud" grounding
 * "Dr. Aboud"): nicknames are built out of ordinary words ("Red Fox",
 * "Little Bird", "Boss"), so matching any single word of the alias would
 * ground the owner's canonical name off unrelated prose ("Jonah wiped his
 * hands on a red rag"). An alias is user-vouched, high-confidence evidence
 * only when the alias itself — all of it — appears.
 */
function aliasPhraseGrounded(alias, haystacks) {
    const phrase = String(alias ?? '').trim();
    if (!phrase) return false;
    // Edge-derived boundaries (wholePhraseRegex): free-text aliases can begin
    // or end with punctuation ("A.J.", "(Vixen)"), and an unconditional `\b`
    // beside the outer non-word character never matches — the bridge would
    // miss the alias's own evidence. Whitespace runs stay flexible.
    const re = wholePhraseRegex(phrase);
    return haystacks.some(h => re.test(h));
}

/**
 * Drop every entry whose bolded name is in `labels` (exact, case-insensitive),
 * INCLUDING the indented subfield lines that belong to that entry.
 *
 * Previously this only stripped the bolded name line itself, leaving orphaned
 * subfields (e.g. `  - Mood: ...`) behind as contextless fragments. The fix
 * tracks "strip mode": once a matching bold line is found, subsequent indented
 * lines (subfields) are also removed until the next top-level line (a new bold
 * entry, a heading, or a non-indented line) resets the state.
 */
function stripNameLines(text, labels) {
    const labelSet = new Set(labels.map(l => l.toLowerCase()));
    const lines = text.split('\n');
    const kept = [];
    let stripping = false;
    for (const line of lines) {
        const label = matchBoldLine(line);
        if (label) {
            // This is a bold entry line — decide whether to strip it AND its subfields
            stripping = labelSet.has(label.toLowerCase());
            if (stripping) continue;
            kept.push(line);
            continue;
        }
        // A heading always resets the strip state
        if (/^#{1,6}\s/.test(line)) {
            stripping = false;
            kept.push(line);
            continue;
        }
        // While in strip mode, remove indented subfield lines (belong to the
        // stripped entry). A non-indented, non-bold, non-heading line ends the
        // strip context — it's standalone content, not a subfield.
        if (stripping) {
            if (/^\s+[-*]?/.test(line)) continue; // indented subfield
            stripping = false;
        }
        kept.push(line);
    }
    return kept.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Anti-invention gate. Checks every bolded name in `newText` against the
 * union of (scan window text) ∪ (prior state text) ∪ (pinned entities) ∪
 * (user-approved registry aliases). Names that appear nowhere in that union
 * are "phantoms."
 *
 * - soft mode: strips the offending line(s) and returns ok:true with the
 *   cleaned text (callers should log `stripped`).
 * - strict mode: returns ok:false without mutating anything, so the caller
 *   can retry the generation (mirrors refresh.js's existing validateOutput
 *   retry path).
 *
 * The alias list (TODO §1 identity service, `aliasGroups` — see
 * {@link collectRegistryAliasGroups}) grounds in two ways:
 *   - outright: an alias spelling is a name the USER vouched for, exactly
 *     like a pinned entity — the model cannot have "invented" it. This is
 *     also what keeps a rename's old spelling grounded (renameEntity keeps
 *     the old name as an alias);
 *   - bridged: a bold label that IS a canonical registry name is grounded
 *     when any of that record's aliases appears in the evidence as a whole
 *     phrase — the scan window said "The Vixen", the model wrote "Mara
 *     Vance", and per the user's own alias decision that is one person.
 * Canonical registry names WITHOUT alias evidence stay ungated as before —
 * grounding every tracked NPC outright would defeat the anti-invention gate.
 *
 * @param {string} newText
 * @param {object} [opts]
 * @param {string} [opts.scanText='']
 * @param {string} [opts.priorText='']
 * @param {string[]} [opts.pinned=[]]
 * @param {'soft'|'strict'} [opts.mode='soft']
 * @param {Array<{owner: string, aliases: string[]}>} [opts.aliasGroups=[]] —
 *   the registry's user-approved alias records
 * @returns {{ ok: boolean, cleanedText?: string, stripped: Array, reason?: string }}
 */
export function groundingGate(newText, opts = {}) {
    const { scanText = '', priorText = '', pinned = [], mode = 'soft', aliasGroups = [] } = opts;

    if (!newText) return { ok: true, cleanedText: newText, stripped: [] };

    const pinnedSet = new Set(pinned.map(p => p.toLowerCase().trim()).filter(Boolean));
    const haystacks = [scanText.toLowerCase(), priorText.toLowerCase()];

    // Alias index (TODO §1): every alias spelling grounds outright; canonical
    // owner → its alias forms, for the bridge check. Defensive normalization —
    // the store validator keeps the registry clean, but the gate must never
    // throw on a malformed group.
    const aliasSpellings = new Set();
    const ownerAliases = new Map();
    for (const group of Array.isArray(aliasGroups) ? aliasGroups : []) {
        const owner = String(group?.owner ?? '').trim();
        const aliases = (Array.isArray(group?.aliases) ? group.aliases : [])
            .map(a => String(a ?? '').trim())
            .filter(Boolean);
        if (!owner || aliases.length === 0) continue;
        ownerAliases.set(owner.toLowerCase(), aliases);
        for (const alias of aliases) aliasSpellings.add(alias.toLowerCase());
    }
    const groundedViaAliasBridge = (label) => {
        const aliases = ownerAliases.get(String(label).toLowerCase().trim());
        // Phrase-level, NOT nameIsGrounded's word-level rule — a word of the
        // alias is not the alias (see aliasPhraseGrounded).
        return aliases != null && aliases.some(alias => aliasPhraseGrounded(alias, haystacks));
    };

    const phantoms = extractBoldNames(newText).filter(({ key, label }) => (
        !pinnedSet.has(key)
        && !aliasSpellings.has(key)
        && !nameIsGrounded(label, haystacks)
        && !groundedViaAliasBridge(label)
    ));

    if (phantoms.length === 0) return { ok: true, cleanedText: newText, stripped: [] };

    if (mode === 'strict') {
        return { ok: false, stripped: phantoms, reason: `ungrounded name(s): ${phantoms.map(p => p.label).join(', ')}` };
    }

    for (const { label } of phantoms) {
        console.warn(`[MWT:WorldState] Grounding gate stripped ungrounded name: "${label}"`);
    }
    return { ok: true, cleanedText: stripNameLines(newText, phantoms.map(p => p.label)), stripped: phantoms };
}

/**
 * Collect the knowledge registry's user-approved alias records (TODO §1
 * identity service) for the grounding gate.
 *
 * Aliases live ONLY in the live lorebook-store registry — the legacy
 * chat-metadata mirror predates the identity service — so this reads
 * `getRegistry()` through a DYNAMIC import, the same optional-dependency
 * pattern interiority uses for the knowledge module. A dynamic import adds no
 * static import edge, keeping this module leaf-ish (no cycle with
 * refresh.js/sections.js, which import this file). Failure is inert: no
 * aliases, and the gate behaves exactly as it did before them.
 *
 * @returns {Promise<Array<{owner: string, aliases: string[]}>>} one group per
 *   registry record that carries aliases; `[]` when the knowledge module or
 *   its registry is unavailable
 */
export async function collectRegistryAliasGroups() {
    try {
        const { getRegistry } = await import('../knowledge/registry.js');
        const reg = getRegistry();
        const groups = [];
        for (const [owner, record] of Object.entries(reg ?? {})) {
            const aliases = (Array.isArray(record?.aliases) ? record.aliases : [])
                .map(a => String(a ?? '').trim())
                .filter(Boolean);
            if (aliases.length > 0) groups.push({ owner, aliases });
        }
        if (groups.length === 0 && Object.keys(reg ?? {}).length === 0) {
            // An empty registry is ambiguous: "this chat has no NPCs" reads
            // exactly like "the store has not hydrated yet" (e.g. the first
            // refresh after a chat switch). Surface it so a silently
            // alias-blind gate pass is reportable instead of invisible.
            console.warn(
                '[MWT:WorldState] collectRegistryAliasGroups: the knowledge registry read empty — ' +
                'either this chat has no NPC records or the store has not hydrated yet. ' +
                'The grounding gate runs alias-blind for this pass.'
            );
        }
        return groups;
    } catch (err) {
        console.warn(
            '[MWT:WorldState] collectRegistryAliasGroups failed — the grounding gate runs alias-blind for this pass.',
            err
        );
        return [];
    }
}
