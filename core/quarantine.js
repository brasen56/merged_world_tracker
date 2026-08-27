/**
 * core/quarantine.js — Pure quarantine records, fingerprinting, and dedup.
 *
 * Design §5 of upcoming_work_misc/SCHEMA_VALIDATION_MIGRATIONS_PLAN.md:
 * invalid records are never silently dropped. They are preserved whole,
 * fingerprinted, and deduplicated so a repeated load does not append the same
 * record twice.
 *
 * Purity rules match core/schema.js: no feature modules, no barrels, no DOM,
 * no SillyTavern runtime. Persistence does NOT happen here — callers own
 * where the items live (`mwt_schema_quarantine` in chat metadata for
 * chat-local stores, inside the affected lorebook store for Knowledge, which
 * a chat-local quarantine cannot correctly own).
 */

/** The chat-metadata key that owns chat-local quarantine records (design §5.1). */
export const QUARANTINE_METADATA_KEY = 'mwt_schema_quarantine';

/** Version of the quarantine container shape itself. */
export const QUARANTINE_SCHEMA_VERSION = 1;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Deterministic, key-order-independent serialization of a JSON-shaped value.
 *
 * Object keys are sorted so two structurally equal records that were
 * serialised in different property orders (an entry re-imported through a
 * different writer) fingerprint identically. Arrays keep their order — order
 * is meaning. Circular references throw: quarantine payloads come from
 * persisted JSON and must be acyclic.
 */
export function canonicalStringify(value, seen = new WeakMap()) {
    if (value === null || typeof value !== 'object') {
        return `${typeof value}:${String(value)}`;
    }
    if (seen.has(value)) throw new TypeError('Quarantine payloads must not contain circular references.');
    seen.set(value, true);
    const result = Array.isArray(value)
        ? `[${value.map(item => canonicalStringify(item, seen)).join(',')}]`
        : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalStringify(value[key], seen)}`).join(',')}}`;
    seen.delete(value);
    return result;
}

/**
 * Compact, stable content fingerprint: 32-bit FNV-1a over the canonical
 * serialization, as eight hex characters. Not cryptographic — its only job is
 * deduplicating repeated detections of the same raw record.
 */
export function fingerprintValue(value) {
    const text = canonicalStringify(value);
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

/**
 * Build one quarantine item (design §5.1 shape). The fingerprint derives from
 * the raw record unless one is supplied, and the id derives from
 * store + fingerprint — so re-detecting the same record yields the same id
 * and merges as a duplicate instead of appending a second copy.
 */
export function makeQuarantineItem({
    store,
    path = [],
    reasonCode,
    message,
    raw,
    sourceVersion = null,
    detectedAt = Date.now(),
    fingerprint,
} = {}) {
    const print = (typeof fingerprint === 'string' && fingerprint.length > 0)
        ? fingerprint
        : fingerprintValue(raw);
    return {
        id: `${store}:${print}`,
        store,
        path: Array.isArray(path) ? [...path] : [],
        reasonCode,
        message,
        raw,
        detectedAt,
        sourceVersion,
        fingerprint: print,
    };
}

/**
 * Merge quarantine item lists, dropping incoming items whose
 * (store, fingerprint) pair is already present. Existing items come first.
 * Items without a usable fingerprint are always kept — they cannot be
 * deduplicated, and quarantine data is never silently dropped (design §5.2).
 *
 * @param {object[]} existingItems — items already stored
 * @param {object[]} incomingItems — newly detected items
 * @returns {object[]} the merged, deduplicated item list
 */
export function mergeQuarantineItems(existingItems = [], incomingItems = []) {
    const merged = [];
    const seen = new Set();
    for (const list of [existingItems, incomingItems]) {
        if (!Array.isArray(list)) continue;
        for (const item of list) {
            if (!isObject(item)) continue;
            if (typeof item.fingerprint !== 'string') {
                merged.push(item);
                continue;
            }
            const key = `${typeof item.store === 'string' ? item.store : ''}:${item.fingerprint}`;
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(item);
        }
    }
    return merged;
}

/**
 * Coerce a persisted quarantine container to the canonical shape. Garbage
 * becomes an empty container rather than an error: quarantine is recovery
 * data, and refusing to load it would block the very store it is meant to
 * help recover. Surviving items are deduplicated on the way in.
 */
export function normalizeQuarantineStore(value) {
    const items = isObject(value) && Array.isArray(value.items) ? value.items : [];
    return {
        version: QUARANTINE_SCHEMA_VERSION,
        items: mergeQuarantineItems([], items),
    };
}

// ─── Container schema + export/import shapes (design §5, Part 2) ─────────────
//
// The `mwt_schema_quarantine` chat-metadata container gets its own validator
// (same `{ data, issues, stats }` contract as every store validator) and a
// recovery-export envelope so quarantined records can leave the chat and come
// back without being re-interpreted by hand.
//
// This module stays import-free (core/schema.js imports it), so issue objects
// here are built with literal severities that mirror ISSUE_SEVERITIES.

/**
 * Rebuild one persisted/imported item in the canonical makeQuarantineItem()
 * shape. The fingerprint is ALWAYS recomputed from `raw`: it is derived data
 * by definition, and trusting a supplied value would let a hand-edited import
 * stamp one fingerprint onto two DIFFERENT raw records, after which
 * mergeQuarantineItems() silently discards the second as a duplicate (the
 * mismatch is reported as a repair finding by the caller). The id is always
 * `store:fingerprint` so deduplication stays reliable even when the stored id
 * disagrees, and path/detectedAt/sourceVersion fall back to the same defaults
 * the factory uses.
 */
function canonicalizeQuarantineItem(item) {
    const print = fingerprintValue(item.raw);
    return {
        id: `${item.store}:${print}`,
        store: item.store,
        path: Array.isArray(item.path) ? [...item.path] : [],
        reasonCode: item.reasonCode,
        message: item.message,
        raw: item.raw,
        detectedAt: Number.isFinite(item.detectedAt) ? item.detectedAt : Date.now(),
        sourceVersion: item.sourceVersion === undefined ? null : item.sourceVersion,
        fingerprint: print,
    };
}

/**
 * Item-level structural check shared by the container validator and import
 * (ONE owner so the two paths cannot drift).
 *
 * Recovery contract (design §5.1): an item must carry its raw record and a
 * human-readable message — neither can be derived, and without them the item
 * supports neither recovery ({ store, reasonCode } alone reconstructs nothing)
 * nor a meaningful display. Everything else (fingerprint, id, path,
 * detectedAt, sourceVersion) is canonicalized from what IS present — the
 * fingerprint unconditionally from `raw` — so an export written by a slightly
 * different build still imports cleanly and a forged fingerprint cannot
 * collide distinct records.
 *
 * @returns {{ issues: object[], usable: object[], accepted: number }} the
 *   findings plus the canonicalized items allowed into a container.
 */
function checkQuarantineItems(items) {
    const issues = [];
    const usable = [];
    for (let index = 0; index < items.length; index++) {
        const item = items[index];
        if (!isObject(item)) {
            issues.push({
                code: 'item-not-object',
                path: ['items', index],
                severity: 'quarantine',
                message: 'Quarantine item must be an object.',
                record: item,
                identity: index,
            });
            continue;
        }
        if (typeof item.store !== 'string' || !item.store.trim()
            || typeof item.reasonCode !== 'string' || !item.reasonCode.trim()) {
            issues.push({
                code: 'item-missing-fields',
                path: ['items', index],
                severity: 'quarantine',
                message: 'Quarantine item needs non-empty store and reasonCode strings.',
                // §5.2 applies to quarantine's own records too: `record` is the
                // COMPLETE rejected item (what a recovery export reconstructs
                // from), and the display identity rides separately so summaries
                // still print an identifier rather than the raw payload. These
                // used to carry only the id, so re-quarantining a malformed
                // recovery item preserved a bare string and lost the record.
                record: item,
                identity: typeof item.id === 'string' ? item.id : index,
            });
            continue;
        }
        if (item.raw === undefined || typeof item.message !== 'string' || !item.message.trim()) {
            issues.push({
                code: 'item-unrecoverable',
                path: ['items', index],
                severity: 'quarantine',
                message: 'Quarantine item needs a raw record and a non-empty message to support recovery.',
                record: item,
                identity: typeof item.id === 'string' ? item.id : index,
            });
            continue;
        }
        const canonical = canonicalizeQuarantineItem(item);
        // Repair, not rejection: the fingerprint is derived data, so a
        // disagreeing supplied value is overwritten with the recomputed one
        // while the item — raw record intact — stays recoverable.
        if (typeof item.fingerprint === 'string' && item.fingerprint.length > 0
            && item.fingerprint !== canonical.fingerprint) {
            issues.push({
                code: 'fingerprint-mismatch',
                path: ['items', index, 'fingerprint'],
                severity: 'repair',
                message: `Supplied fingerprint "${item.fingerprint}" does not match its raw record's content fingerprint "${canonical.fingerprint}"; it was recomputed from the raw record.`,
                record: typeof item.id === 'string' ? item.id : index,
                identity: typeof item.id === 'string' ? item.id : index,
            });
        }
        usable.push(canonical);
    }
    return { issues, usable, accepted: usable.length };
}

const emptyQuarantineStats = () => ({ added: 0, updated: 0, conflicts: 0 });

/**
 * Validate the `mwt_schema_quarantine` container. The canonical data is
 * normalizeQuarantineStore()'s output — re-stamped version, deduplicated
 * items — so loading quarantine always converges on one shape no matter what
 * was persisted. The one refusal is a container from a NEWER MWT (below).
 */
export function validateQuarantineStoreData(data) {
    const issues = [];
    const stats = emptyQuarantineStats();
    if (!isObject(data)) {
        issues.push({
            code: 'root-not-object',
            path: [],
            severity: 'quarantine',
            message: 'Quarantine container must be an object.',
            record: QUARANTINE_METADATA_KEY,
        });
        return { data: normalizeQuarantineStore(null), issues, stats };
    }
    // Unknown-future-version guardrail (design §3.5 category 4 — the same rule
    // quarantine imports and the manifest validator enforce): a container a
    // NEWER release wrote may carry item fields or shapes this build cannot
    // understand, so it is refused UNCHANGED with a fatal finding instead of
    // being silently rewritten as the current version (which would discard
    // whatever that release recorded). Integer-only, mirroring the manifest: a
    // fractional or non-number version is garbage that converges on the
    // canonical shape below, not a deliberate marker from a future release.
    if (Number.isInteger(data.version) && data.version > QUARANTINE_SCHEMA_VERSION) {
        issues.push({
            code: 'future-version',
            path: ['version'],
            severity: 'fatal',
            message: `Quarantine container version ${data.version} is newer than the supported version ${QUARANTINE_SCHEMA_VERSION}; it was left unchanged.`,
            record: 'version',
        });
        return { data, issues, stats };
    }
    let sourceItems = [];
    if (data.items !== undefined && !Array.isArray(data.items)) {
        issues.push({
            code: 'items-not-array',
            path: ['items'],
            severity: 'quarantine',
            message: 'Quarantine items must be an array.',
            record: 'items',
        });
    } else {
        sourceItems = Array.isArray(data.items) ? data.items : [];
    }
    const checked = checkQuarantineItems(sourceItems);
    issues.push(...checked.issues);
    stats.added = checked.accepted;
    // The canonical container keeps only recoverable items — rejected ones are
    // reported above with their raw value preserved in the issue.
    return {
        data: { version: QUARANTINE_SCHEMA_VERSION, items: mergeQuarantineItems([], checked.usable) },
        issues,
        stats,
    };
}

/** Marks a JSON payload as a MWT quarantine recovery export. */
export const QUARANTINE_EXPORT_KIND = 'mwt-quarantine-export';

/**
 * Build a portable recovery export from quarantine items. Deduplicating here
 * means an export can never carry the same raw record twice, matching what a
 * re-import would merge down to anyway.
 */
export function exportQuarantineData(items, { exportedAt = Date.now() } = {}) {
    return {
        kind: QUARANTINE_EXPORT_KIND,
        version: QUARANTINE_SCHEMA_VERSION,
        exportedAt,
        items: mergeQuarantineItems([], Array.isArray(items) ? items : []),
    };
}

/**
 * Ingest a quarantine recovery export (or any persisted quarantine-shaped
 * payload). Tolerant by design — this is recovery data — except that foreign
 * kinds and future versions are refused untouched rather than guessed at.
 *
 * @returns {{ items: object[], issues: object[] }} canonical deduplicated
 *   items plus plain { code, message } findings (empty `items` on refusal).
 */
export function importQuarantineItems(payload) {
    const issues = [];
    if (!isObject(payload)) {
        issues.push({ code: 'root-not-object', message: 'Quarantine export must be a JSON object.' });
        return { items: [], issues };
    }
    if (payload.kind !== undefined && payload.kind !== QUARANTINE_EXPORT_KIND) {
        issues.push({ code: 'unknown-kind', message: `Not a quarantine export (kind "${String(payload.kind)}").` });
        return { items: [], issues };
    }
    if (payload.version !== undefined && (!Number.isInteger(payload.version) || payload.version < 1)) {
        issues.push({ code: 'version-invalid', message: 'Quarantine export version must be a positive integer.' });
        return { items: [], issues };
    }
    if (payload.version > QUARANTINE_SCHEMA_VERSION) {
        issues.push({
            code: 'future-version',
            message: `Quarantine export version ${payload.version} is newer than supported version ${QUARANTINE_SCHEMA_VERSION}; it was left unchanged.`,
        });
        return { items: [], issues };
    }
    if (payload.items !== undefined && !Array.isArray(payload.items)) {
        issues.push({ code: 'items-not-array', message: 'Quarantine export items must be an array.' });
        return { items: [], issues };
    }
    const sourceItems = Array.isArray(payload.items) ? payload.items : [];
    const checked = checkQuarantineItems(sourceItems);
    issues.push(...checked.issues.map(({ code, message }) => ({ code, message })));
    // Only recoverable items survive the import; rejected ones are reported
    // above and stay in the source export untouched.
    return { items: mergeQuarantineItems([], checked.usable), issues };
}
