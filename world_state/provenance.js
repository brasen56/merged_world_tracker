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
 *                             anywhere in the scan window, prior state, or
 *                             the pinned-entities list.
 *
 * Leaf-ish module — imports only data.js / settings.js (+ core) to avoid
 * circular deps with refresh.js / sections.js, which import this instead.
 */

import { getChat } from '../core/index.js';
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

// ─── Scan window (with chat indices) ────────────────────────────────────────

function getScanWindowWithIndices() {
    const max = getMaxScanMessages(getSettings());
    const chat = getChat() || [];
    const start = Math.max(0, chat.length - max);
    const out = [];
    for (let i = start; i < chat.length; i++) {
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
        if (entry.lastTouchedMsg !== null && entry.lastTouchedMsg !== undefined
            && currentMsgIndex - entry.lastTouchedMsg > pruneAfter) continue;
        candidates.set(key, { key, label: entry.label, section: entry.section });
    }

    const now = Date.now();
    const entities = {};
    for (const [key, info] of candidates) {
        const prior = priorEntities[key];
        let lastTouchedMsg = prior?.lastTouchedMsg ?? null;
        let mentionCount = prior?.mentionCount ?? 0;
        let foundInWindow = false;

        const escaped = info.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`\\b${escaped}\\b`, 'i');
        for (const { index, text: msgText } of scan) {
            if (!re.test(msgText)) continue;
            foundInWindow = true;
            mentionCount += 1;
            if (lastTouchedMsg === null || index > lastTouchedMsg) lastTouchedMsg = index;
        }

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
        .map(([key, e]) => ({
            key,
            label: e.label,
            section: e.section,
            lastTouchedMsg: e.lastTouchedMsg,
            age: e.lastTouchedMsg === null ? null : currentMsgIndex - e.lastTouchedMsg,
            mentionCount: e.mentionCount,
            source: e.source,
        }))
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
            if (!entry || entry.lastTouchedMsg === null || entry.lastTouchedMsg === undefined) {
                kept.push(line); // grace cycle — no provenance yet
                continue;
            }

            const age = currentMsgIndex - entry.lastTouchedMsg;
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

/** Drop every line whose bolded name is in `labels` (exact, case-insensitive). Conservative — single-line only, mirrors extractBoldNames' one-line-per-entry assumption. */
function stripNameLines(text, labels) {
    const labelSet = new Set(labels.map(l => l.toLowerCase()));
    const kept = text.split('\n').filter(line => {
        const label = matchBoldLine(line);
        return !(label && labelSet.has(label.toLowerCase()));
    });
    return kept.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Anti-invention gate. Checks every bolded name in `newText` against the
 * union of (scan window text) ∪ (prior state text) ∪ (pinned entities).
 * Names that appear nowhere in that union are "phantoms."
 *
 * - soft mode: strips the offending line(s) and returns ok:true with the
 *   cleaned text (callers should log `stripped`).
 * - strict mode: returns ok:false without mutating anything, so the caller
 *   can retry the generation (mirrors refresh.js's existing validateOutput
 *   retry path).
 *
 * @returns {{ ok: boolean, cleanedText?: string, stripped: Array, reason?: string }}
 */
export function groundingGate(newText, opts = {}) {
    const { scanText = '', priorText = '', pinned = [], mode = 'soft' } = opts;

    if (!newText) return { ok: true, cleanedText: newText, stripped: [] };

    const pinnedSet = new Set(pinned.map(p => p.toLowerCase().trim()).filter(Boolean));
    const haystacks = [scanText.toLowerCase(), priorText.toLowerCase()];

    const phantoms = extractBoldNames(newText).filter(({ key, label }) => (
        !pinnedSet.has(key) && !nameIsGrounded(label, haystacks)
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
