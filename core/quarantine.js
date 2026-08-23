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
