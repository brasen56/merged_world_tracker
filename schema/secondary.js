/**
 * schema/secondary.js — Pure validators for MWT's SECONDARY persistence
 * (schema plan §2.2 / Part 7).
 *
 * The authoritative chat-metadata + lorebook stores live in
 * schema/registry.js and run through the full manifest/migration gate. The
 * shapes below are the remaining MWT-owned persistence — browser-local,
 * chat-independent, never part of a chat backup — and they use the same
 * VALIDATION VOCABULARY (core/schema.js structured issues) without the
 * registry machinery: there is no manifest to stamp and no module to pause,
 * so the policy is read-side repair. The validator returns the canonical
 * LIVE view; the stored raw value is left exactly where it was, which makes
 * the storage itself the recovery copy — so, like core/settings_schema.js
 * (and unlike the store validators' §5.2 recovery copies), no raw record is
 * embedded in the issues: edit-history content is user prose, and an issue
 * may reach a report surface. Identity strings address every finding.
 *
 * Covered here (§2.2's last three bullets):
 *   - `mwt_float_positions` (localStorage) — floating-button positions,
 *     owned by core/ui.js;
 *   - `kt_history_*` (localStorage) — Knowledge per-UID edit history,
 *     owned by knowledge/lorebook.js;
 *   - `msg.extra.mwt_uuid` — Interiority's per-message UUID stamps, owned
 *     by interiority/data.js.
 *
 * Settings records (§2.2's first bullet) are versioned + validated by
 * core/settings_schema.js through createSettingsManager(), not here.
 *
 * Purity (design §3.1–§3.2, pinned by test/schema_engine.test.js): imports
 * only core/schema.js. No DOM and no storage access — callers own IO.
 */
import { isFiniteNumber, isObject, makeIssue, ISSUE_SEVERITIES } from '../core/schema.js';

/** Property under which Interiority stamps a message's UUID in `msg.extra`. */
export const MESSAGE_UUID_EXTRA_KEY = 'mwt_uuid';

/** Stable issue codes (design §4.3). */
export const SECONDARY_ISSUE_CODES = Object.freeze({
    FLOAT_ROOT_NOT_OBJECT: 'float-positions-root-not-object',
    FLOAT_ENTRY_INVALID: 'float-position-entry-invalid',
    FLOAT_UNKNOWN_ID: 'float-position-unknown-id',
    HISTORY_ROOT_NOT_ARRAY: 'history-root-not-array',
    HISTORY_RECORD_INVALID: 'history-record-invalid',
    MSG_UUID_INVALID: 'message-uuid-invalid',
    MSG_UUID_DUPLICATE: 'message-uuid-duplicate',
});

/**
 * Is this a usable per-message UUID stamp? A stamp that is not a non-empty
 * string cannot address a message, so the seams in interiority/data.js
 * treat it as absent (fall back to send_date / restamp) instead of keying
 * perMessage data off garbage like `mu-123` or `mu-`.
 */
export function isValidMessageUuid(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate the `mwt_float_positions` localStorage record.
 *
 * Each entry must be `{ left, top }` with finite coordinates. Invalid
 * entries are dropped from the live view (the button falls back to its
 * anchored spot); entries for button ids this build no longer has are
 * RETAINED with a reference finding — they are harmless, may belong to
 * another build, and dropping them would lose a position the user set.
 * The next drag rewrite converges the stored key onto the live view.
 *
 * @param {*} raw parsed value of the localStorage key
 * @param {object} [options]
 * @param {string[]|null} [options.allowedIds] known button ids (null = skip
 *   the unknown-id check)
 * @returns {{ data: object, issues: object[], dropped: number }}
 */
export function validateFloatPositions(raw, { allowedIds = null } = {}) {
    if (!isObject(raw)) {
        return {
            data: {},
            dropped: 0,
            issues: [makeIssue({
                code: SECONDARY_ISSUE_CODES.FLOAT_ROOT_NOT_OBJECT,
                path: [],
                severity: ISSUE_SEVERITIES.FATAL,
                message: 'Saved float positions must be a JSON object; buttons use their anchored spots.',
            })],
        };
    }
    const data = {};
    const issues = [];
    let dropped = 0;
    for (const [id, pos] of Object.entries(raw)) {
        if (isObject(pos) && isFiniteNumber(pos.left) && isFiniteNumber(pos.top)) {
            data[id] = { left: pos.left, top: pos.top };
            if (Array.isArray(allowedIds) && !allowedIds.includes(id)) {
                issues.push(makeIssue({
                    code: SECONDARY_ISSUE_CODES.FLOAT_UNKNOWN_ID,
                    path: [id],
                    severity: ISSUE_SEVERITIES.REFERENCE,
                    message: `Saved position for unknown button id "${id}" was retained.`,
                    identity: id,
                }));
            }
        } else {
            dropped += 1;
            issues.push(makeIssue({
                code: SECONDARY_ISSUE_CODES.FLOAT_ENTRY_INVALID,
                path: [id],
                severity: ISSUE_SEVERITIES.QUARANTINE,
                message: `Saved position for button "${id}" was not { left, top } numbers; it was dropped from the live view.`,
                identity: id,
            }));
        }
    }
    return { data, issues, dropped };
}

/**
 * Validate one `kt_history_<lorebook>_<uid>` localStorage record (an array
 * of `{ ts, content, msgIdx }` edit-history entries, newest first).
 *
 * Invalid records are filtered out of the live view; the stored key is
 * untouched (it is the recovery copy) and converges on the next push,
 * which rewrites the whole list. Content is deliberately NOT embedded in
 * the issues — it is lorebook prose.
 *
 * @param {*} raw parsed value of the history key
 * @returns {{ data: object[], issues: object[] }}
 */
export function validateHistoryRecords(raw) {
    if (!Array.isArray(raw)) {
        return {
            data: [],
            issues: [makeIssue({
                code: SECONDARY_ISSUE_CODES.HISTORY_ROOT_NOT_ARRAY,
                path: [],
                severity: ISSUE_SEVERITIES.FATAL,
                message: 'Saved edit history must be a JSON array; it reads as empty.',
            })],
        };
    }
    const data = [];
    const issues = [];
    for (let i = 0; i < raw.length; i++) {
        const entry = raw[i];
        const hasMsgIdx = entry?.msgIdx !== undefined;
        if (isObject(entry)
            && typeof entry.content === 'string'
            && isFiniteNumber(entry.ts)
            && (!hasMsgIdx || (Number.isInteger(entry.msgIdx) && entry.msgIdx >= 0))
        ) {
            data.push(hasMsgIdx
                ? { ts: entry.ts, content: entry.content, msgIdx: entry.msgIdx }
                : { ts: entry.ts, content: entry.content });
        } else {
            issues.push(makeIssue({
                code: SECONDARY_ISSUE_CODES.HISTORY_RECORD_INVALID,
                path: [String(i)],
                severity: ISSUE_SEVERITIES.QUARANTINE,
                message: `Edit-history record ${i} was malformed; it was filtered from the live view.`,
                identity: String(i),
            }));
        }
    }
    return { data, issues };
}

/**
 * Validate the `mwt_uuid` stamps across a chat array (read-only diagnostic;
 * the seams in interiority/data.js validate each stamp as they use it).
 *
 * Findings: a present-but-malformed stamp (not a non-empty string), and
 * duplicate UUIDs — a duplicate silently aliases two messages' perMessage
 * entries (last one wins in buildKeyToIndexMap()), which is exactly the
 * collision UUIDs exist to prevent.
 *
 * @param {*} chat the chat message array (or anything — never throws)
 * @returns {{ issues: object[], stamped: number }} `stamped` counts usable
 *   stamps (valid and unique).
 */
export function validateMessageUuids(chat) {
    const issues = [];
    if (!Array.isArray(chat)) return { issues, stamped: 0 };
    const seen = new Map();
    let stamped = 0;
    for (let i = 0; i < chat.length; i++) {
        const uuid = chat[i]?.extra?.[MESSAGE_UUID_EXTRA_KEY];
        if (uuid === undefined || uuid === null) continue;
        if (!isValidMessageUuid(uuid)) {
            issues.push(makeIssue({
                code: SECONDARY_ISSUE_CODES.MSG_UUID_INVALID,
                path: [String(i)],
                severity: ISSUE_SEVERITIES.QUARANTINE,
                message: `Message ${i} carries a malformed mwt_uuid stamp; it is ignored until restamped.`,
                identity: String(i),
            }));
            continue;
        }
        stamped += 1;
        const firstIndex = seen.get(uuid);
        if (firstIndex === undefined) {
            seen.set(uuid, i);
        } else {
            issues.push(makeIssue({
                code: SECONDARY_ISSUE_CODES.MSG_UUID_DUPLICATE,
                path: [String(firstIndex), String(i)],
                severity: ISSUE_SEVERITIES.REFERENCE,
                message: `Messages ${firstIndex} and ${i} share one mwt_uuid; their perMessage entries alias.`,
                identity: uuid,
            }));
        }
    }
    return { issues, stamped };
}
