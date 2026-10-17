/**
 * knowledge/field_contract.js — the shared field discipline contract
 * (docs/KNOWLEDGE_CONCISION_IMPLEMENTATION_PLAN.md Phase 1; bounds and rules
 * recorded in docs/KNOWLEDGE_CONCISION_DECISIONS.md D4a).
 *
 * One module owns three jobs, so prompts, scans, updates, enrichment, and the
 * per-field refresh cannot drift apart again:
 *
 *   1. FIELD definitions — label, generous size bound, and the belongs/does-
 *      not-belong guidance derived from the scope's field table.
 *   2. VALIDATION — type/structure/size checks that run at the Phase 0 writer
 *      seams (S1–S6) BEFORE any merge or formatter sees a model value. Invalid
 *      values are dropped whole with a field-specific reason — never silently
 *      sliced. Existing entries keep their old value (the mergers skip null);
 *      new entries fall back to their unknown/empty convention.
 *   3. PROMPT GUIDANCE — the same definitions render the FIELD CONTRACT block
 *      embedded in every model-facing prompt, so what the model is told and
 *      what the code enforces come from one table.
 *
 * The bounds are structural backstops against runaway event-log values, not
 * scope enforcement: a valid 13-word Role passes, and deliberately so does
 * the reported 149-character Role example (its problem is semantic scope,
 * which the prompt contract addresses — see D4a). Retries stay bounded to the
 * callers' existing two-attempt parse loops; this module adds no model calls.
 *
 * Pure module: no imports, no host dependencies — safe under node tests.
 */

// ─── Field definitions ───────────────────────────────────────────────────────

/**
 * Every model-writable field, with its D4a bound and scope-table guidance.
 * Order is presentation order (canonical DOSSIER_FIELDS order with the
 * compact-format fields first).
 */
export const FIELD_CONTRACT = Object.freeze([
    Object.freeze({
        key: 'tone', label: 'Tone', maxChars: 120,
        belongs: 'stable communication style', notBelongs: 'dialogue history or current errands', shape: '2-3 words',
    }),
    Object.freeze({
        key: 'perceived_as', label: 'Perceived as', maxChars: 200,
        belongs: 'the outward impression they give', notBelongs: 'secret motives or event history', shape: 'one short phrase',
    }),
    Object.freeze({
        key: 'descriptor', label: 'Descriptor', maxChars: 200,
        belongs: 'recognizable physical or enduring-role shorthand', notBelongs: 'scene recaps or task lists', shape: '3-5 words',
    }),
    Object.freeze({
        key: 'first_seen', label: 'First seen', maxChars: 300, creationOnly: true,
        belongs: 'where and when they first appeared', notBelongs: 'later movements', shape: 'one short phrase',
    }),
    Object.freeze({
        key: 'role', label: 'Role', maxChars: 400,
        belongs: 'established occupation, enduring responsibility, or primary story function — stable until a meaningful change',
        notBelongs: "today's chores, completed actions, agreement history, or a relationship inventory", shape: 'one short phrase, usually 3-12 words',
    }),
    Object.freeze({
        key: 'where_to_find', label: 'Where to Find', maxChars: 300,
        belongs: 'established base, usual location, or reliable routine', notBelongs: 'a travel diary or each temporary movement', shape: 'one short sentence',
    }),
    Object.freeze({
        key: 'appearance', label: 'Appearance', maxChars: 900,
        belongs: 'distinguishing physical traits and lasting changes', notBelongs: 'every outfit or incidental gesture', shape: '1-3 short sentences',
    }),
    Object.freeze({
        key: 'voice', label: 'Voice', maxChars: 600,
        belongs: 'stable cadence, accent, and verbal habits', notBelongs: 'tone duplication or a dialogue transcript', shape: '1-2 short sentences',
    }),
    Object.freeze({
        key: 'background', label: 'Background', maxChars: 1200,
        belongs: 'defining history and lasting consequences', notBelongs: 'a running session summary', shape: '2-4 short sentences',
    }),
    Object.freeze({
        key: 'personality', label: 'Personality', maxChars: 900,
        belongs: 'established behavioral traits within existing ownership rules', notBelongs: 'recent-event recap or speculative diagnosis', shape: '1-3 short sentences',
    }),
    Object.freeze({
        key: 'read_on_pc', label: 'Read on PC', maxChars: 400,
        belongs: 'their current stance toward and assessment of the player character',
        notBelongs: 'an interaction log, relationship milestones, or what the player did and felt',
        shape: '1-2 short sentences',
    }),
    Object.freeze({
        key: 'agenda', label: 'Current Agenda', maxChars: 400,
        belongs: 'active overarching goal and meaningful constraint', notBelongs: 'every small task or completed obligation', shape: '1-2 short sentences',
    }),
    Object.freeze({
        key: 'secrets', label: 'Secrets', maxChars: 1200, structured: true,
        belongs: 'still-private information under the existing tier/lifecycle rules', notBelongs: 'public facts or unrelated history', shape: 'brief statements per applicable tier',
    }),
    Object.freeze({
        key: 'canon_lock', label: 'Canon Lock', maxChars: 800, structured: true,
        belongs: 'existing protected continuity constraints', notBelongs: 'an overflow destination for trimmed details', shape: '3-5 immutable facts',
    }),
    Object.freeze({
        key: 'image_tags', label: 'Image Tags', maxChars: 400,
        belongs: 'the existing visual-tag representation', notBelongs: 'narrative prose or event history', shape: 'tags',
    }),
]);

export const FIELD_CONTRACT_BY_KEY = Object.freeze(
    Object.fromEntries(FIELD_CONTRACT.map(def => [def.key, def]))
);

/** Ledger item bounds (D4a). Facts are non-empty single lines; ids stay short. */
export const LEDGER_ITEM_LIMITS = Object.freeze({ fact: 800, source: 80, date: 80 });

/** Keys that may arrive as arrays/objects and are coerced downstream by
 * stringifyDossierValue (knowledge/lorebook.js) — allowed only for these. */
const STRUCTURED_KEYS = new Set(['secrets', 'canon_lock']);

/**
 * Preview how stringifyDossierValue will coerce a structured value, so bound
 * checks measure the text that would actually land in the entry. Mirrors the
 * coercion rules in knowledge/lorebook.js — keep the two in step.
 */
function previewStructured(value) {
    if (Array.isArray(value)) {
        return value.map(v => (typeof v === 'object' && v !== null) ? previewStructured(v) : String(v ?? ''))
            .filter(Boolean).join('; ');
    }
    if (typeof value === 'object' && value !== null) {
        return Object.entries(value)
            .filter(([, v]) => v != null && v !== '')
            .map(([k, v]) => `${k}: ${typeof v === 'object' ? previewStructured(v) : String(v)}`)
            .join(' | ');
    }
    return String(value ?? '');
}

// ─── Validation ──────────────────────────────────────────────────────────────

function structuralRejection(text) {
    if (/[\r\n]/.test(text)) return 'contains a line break (entry values are single-line)';
    const lower = text.toLowerCase();
    if (lower.includes('knowledge ledger:')) return 'contains a "Knowledge Ledger:" heading (section injection)';
    if (lower.includes('<!-- mwt:relationships:')) return 'contains a managed relationship block marker';
    if (lower.includes('[dossier]')) return 'contains the [Dossier] header marker (section injection)';
    return null;
}

/** Fields rejected by validation must never receive a freshness watermark. */
export function acceptedRefreshFields(fields, rejections = []) {
    const rejected = new Set(rejections.map(r => r.field));
    return fields.filter(key => !rejected.has(key));
}

/** Plain text for live status messages; HTML callers must escape it. */
export function contractRejectionSummary(rejections = []) {
    if (!rejections.length) return '';
    return `Field contract: ${rejections.length} invalid model value(s) dropped whole — ${rejections.map(r => `${r.field} (${r.reason})`).join('; ')}. Rejected fields were not re-verified.`;
}

/**
 * Validate one field value against the contract.
 *
 * @param {string} key field key; non-contract keys pass through untouched
 * @param {*} value model-supplied value
 * @returns {{ok: true, value: *}|{ok: false, reason: string}}
 *   ok+null means "no value supplied" (callers treat null as no-change).
 *   Rejections carry a field-specific reason for surfacing; values are never
 *   sliced — the caller drops them and keeps the previous state.
 */
export function validateFieldValue(key, value) {
    const def = FIELD_CONTRACT_BY_KEY[key];
    if (!def) return { ok: true, value };
    if (value === undefined || value === null || value === '') return { ok: true, value: null };

    if (typeof value === 'number' || typeof value === 'boolean') value = String(value);

    if (typeof value !== 'string') {
        if (!STRUCTURED_KEYS.has(key)) {
            return { ok: false, reason: 'value is not a string (structured values are only allowed for secrets/canon_lock)' };
        }
        const preview = previewStructured(value);
        if (preview.length > def.maxChars) {
            return { ok: false, reason: `structured value coerces to ${preview.length} characters (max ${def.maxChars})` };
        }
        const reason = structuralRejection(preview);
        if (reason) return { ok: false, reason };
        return { ok: true, value };
    }

    // Leading/trailing whitespace is normalization, not content slicing.
    const trimmed = value.trim();
    if (trimmed === '') return { ok: true, value: null };
    const reason = structuralRejection(trimmed);
    if (reason) return { ok: false, reason };
    if (trimmed.length > def.maxChars) {
        return { ok: false, reason: `${trimmed.length} characters exceeds the ${def.maxChars}-character bound` };
    }
    return { ok: true, value: trimmed };
}

/**
 * Validate a fields map: every contract-key value is checked; invalid ones are
 * nulled in the returned copy (mergers skip null = existing entries keep their
 * old value) and reported with a per-field reason. Unknown keys pass through
 * unchanged — the mergers ignore them, and rejecting them would be a behavior
 * change beyond this contract.
 *
 * @param {object} fields
 * @returns {{fields: object, rejected: Array<{key: string, reason: string}>}}
 */
export function validateFields(fields) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
        return { fields: {}, rejected: [] };
    }
    const out = { ...fields };
    const rejected = [];
    for (const def of FIELD_CONTRACT) {
        if (!Object.prototype.hasOwnProperty.call(fields, def.key)) continue;
        const check = validateFieldValue(def.key, fields[def.key]);
        if (!check.ok) {
            out[def.key] = null;
            rejected.push({ key: def.key, reason: check.reason });
        } else {
            out[def.key] = check.value;
        }
    }
    return { fields: out, rejected };
}

/**
 * Validate one knowledge/ledger item ({fact, source?, date?}).
 * @returns {{ok: boolean, reason?: string}}
 */
function validateKnowledgeItem(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return { ok: false, reason: 'not an object' };
    }
    const fact = typeof item.fact === 'string' ? item.fact : '';
    if (!fact.trim()) return { ok: false, reason: 'empty or non-string fact' };
    const reason = structuralRejection(fact);
    if (reason) return { ok: false, reason: `fact ${reason}` };
    if (fact.length > LEDGER_ITEM_LIMITS.fact) {
        return { ok: false, reason: `fact is ${fact.length} characters (max ${LEDGER_ITEM_LIMITS.fact})` };
    }
    for (const part of ['source', 'date']) {
        const v = item[part];
        if (v === undefined || v === null || v === '') continue;
        if (typeof v !== 'string') return { ok: false, reason: `non-string ${part}` };
        const partReason = structuralRejection(v);
        if (partReason) return { ok: false, reason: `${part} ${partReason}` };
        if (v.length > LEDGER_ITEM_LIMITS[part]) {
            return { ok: false, reason: `${part} is ${v.length} characters (max ${LEDGER_ITEM_LIMITS[part]})` };
        }
    }
    return { ok: true };
}

/**
 * Validate a new_knowledge/initial_knowledge list: invalid items are dropped
 * whole (never sliced) and reported with their index.
 *
 * @param {Array<{fact: string, source?: string, date?: string}>} items
 * @returns {{items: Array<object>, rejected: Array<{index: number, reason: string}>}}
 */
export function validateKnowledgeList(items) {
    if (!Array.isArray(items)) return { items: [], rejected: [] };
    const kept = [];
    const rejected = [];
    items.forEach((item, index) => {
        const check = validateKnowledgeItem(item);
        if (check.ok) kept.push(item);
        else rejected.push({ index, reason: check.reason });
    });
    return { items: kept, rejected };
}

/**
 * Clean one scan record (new_* or update_*) against the contract before any
 * formatter, merger, or staging consumer sees it — Phase 0 seam S1. Flat
 * creation fields, nested `fields`, and both knowledge lists are validated;
 * identity fields (name/species) are not contract fields and pass through.
 *
 * @param {object} data a scan record
 * @returns {{data: object, rejections: Array<{field: string, reason: string}>}}
 *   `data` is a shallow copy when anything changed, else the original record.
 */
export function validateScanRecord(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { data, rejections: [] };
    }
    const rejections = [];
    let out;
    const set = (key, value) => {
        out = out || { ...data };
        out[key] = value;
    };

    if (data.fields !== undefined) {
        const { fields, rejected } = validateFields(data.fields);
        for (const r of rejected) rejections.push({ field: r.key, reason: r.reason });
        if (rejected.length > 0) set('fields', fields);
    }
    for (const key of ['initial_knowledge', 'new_knowledge']) {
        if (!Array.isArray(data[key])) continue;
        const { items, rejected } = validateKnowledgeList(data[key]);
        for (const r of rejected) rejections.push({ field: `${key}[${r.index}]`, reason: r.reason });
        if (rejected.length > 0) set(key, items);
    }
    for (const def of FIELD_CONTRACT) {
        if (def.key === 'image_tags') continue; // never model-writable from a scan; formats don't read it
        if (!Object.prototype.hasOwnProperty.call(data, def.key)) continue;
        const check = validateFieldValue(def.key, data[def.key]);
        if (!check.ok) {
            rejections.push({ field: def.key, reason: check.reason });
            set(def.key, null);
        } else if (check.value !== data[def.key]) {
            set(def.key, check.value);
        }
    }
    return { data: out || data, rejections };
}

// ─── Prompt guidance ─────────────────────────────────────────────────────────

/**
 * Render the FIELD CONTRACT block embedded in every model-facing Knowledge
 * prompt — the same definitions validation enforces, so prompt and code cannot
 * disagree. Mode 'compact' covers the compact-format fields only; 'dossier'
 * covers the full list (the per-field refresh lists all fields because the
 * model sees only its selected subset).
 *
 * @param {object} [opts]
 * @param {'compact'|'dossier'} [opts.mode]
 * @returns {string}
 */
export function contractPromptBlock({ mode = 'dossier' } = {}) {
    const keys = mode === 'compact'
        ? ['tone', 'perceived_as', 'descriptor', 'first_seen']
        : FIELD_CONTRACT.map(def => def.key);
    const lines = [
        'FIELD CONTRACT (applies to every field you output):',
        "- Update a field only when there is a MEANINGFUL change in that field's subject; otherwise output null.",
        "- Give the field's CURRENT CONCISE VALUE, not its old value plus a new event clause — fields are compact references, not event logs.",
        '- Preserve an unknown, missing, or empty value rather than inventing detail the established facts do not support.',
    ];
    for (const key of keys) {
        const def = FIELD_CONTRACT_BY_KEY[key];
        lines.push(`- ${def.label}: ${def.belongs} (${def.shape}). Not: ${def.notBelongs}.`);
    }
    lines.push('- Knowledge ledger items are durable takeaways — what was established, from what source, on what date — not retellings of the scene.');
    return lines.join('\n');
}
