/**
 * knowledge/response_shape.js — the top-level shape check for Knowledge replies.
 *
 * parseJsonLenient answers "is this JSON?", not "is this the JSON we asked
 * for?". A reply like {"personal_habits": [...], "behavioral_traits": [...]}
 * parses cleanly, every expected key reads as missing, and the run used to
 * finish as "No new info" — no retry, no warning, nothing in Diagnostics.
 * These helpers turn that into a rejected attempt: the 2-attempt loops in
 * knowledge/lorebook.js and knowledge/relationships.js retry with the real
 * reason, Growth evidence capture (knowledge/growth.js) stops before its
 * cursor moves, and every rejection is recorded as a `response_shape_rejected`
 * diagnostics event.
 *
 * The specs (expected keys + the reminder text) live beside the prompts they
 * describe — SCAN_RESPONSE etc. in knowledge/prompts.js.
 *
 * Diagnostics, not schema events: recordSchemaEvent() is for the health of
 * STORED data (migrated / repaired / quarantined); a model reply that never
 * reached storage is a model-output problem, logged like core/api.js's
 * `json_repaired`.
 */

import { record } from '../core/index.js';

/** The retry reason when the reply could not be parsed as JSON at all. */
export const PARSE_FAILURE_REASON = 'the response was cut off or was not valid JSON';

/** How many offending keys a reason / diagnostics event names, and how long each may be. */
const MAX_SHOWN_KEYS = 5;
const MAX_KEY_CHARS = 40;

/** A reply that parsed but has the wrong top-level shape. */
export class ResponseShapeError extends Error {
    /** @param {{code: string, reason: string}} shape */
    constructor(shape) {
        super(shape.reason);
        this.name = 'ResponseShapeError';
        this.code = shape.code;
    }
}

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** Model-invented key names are bounded before they reach a prompt or the log. */
function capKeys(keys) {
    return keys.slice(0, MAX_SHOWN_KEYS)
        .map(k => (k.length > MAX_KEY_CHARS ? `${k.slice(0, MAX_KEY_CHARS)}…` : k));
}

/** `"a"`, `"a" and "b"`, `"a", "b" and "c"`. */
function quoteList(keys) {
    const quoted = keys.map(k => JSON.stringify(k));
    return quoted.length <= 1 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/**
 * Check a parsed reply's top-level shape against a response spec.
 *
 * Accepted: an object carrying at least one expected key (extra keys beside
 * them are ignored, as before), and `{}` when the spec says an empty object
 * means "nothing new". Rejected: anything that is not a plain object, an
 * object whose keys are all invented, and a missing `requireObject` /
 * `requireArray` key.
 *
 * @param {*} result — the parsed reply
 * @param {{keys: readonly string[], emptyOk?: boolean, requireObject?: string, requireArray?: string}} spec
 * @returns {{ok: true} | {ok: false, code: string, reason: string, keys: string[]}}
 */
export function checkResponseShape(result, spec) {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
        const kind = result === null ? 'null' : Array.isArray(result) ? 'an array' : `a bare ${typeof result}`;
        return { ok: false, code: 'not_object', reason: `the response was ${kind}, not a JSON object`, keys: [] };
    }
    const present = Object.keys(result);
    if (present.length === 0) {
        if (spec.emptyOk) return { ok: true };
        return { ok: false, code: 'empty', reason: 'the response was an empty JSON object', keys: [] };
    }
    if (!spec.keys.some(k => hasOwn(result, k))) {
        const shown = capKeys(present);
        const more = present.length > shown.length ? ` (+${present.length - shown.length} more)` : '';
        const noun = present.length === 1 ? 'key' : 'keys';
        return {
            ok: false,
            code: 'wrong_keys',
            reason: `the response used the top-level ${noun} ${quoteList(shown)}${more} instead of ${quoteList([...spec.keys])}`,
            keys: present,
        };
    }
    if (spec.requireObject) {
        const value = result[spec.requireObject];
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return {
                ok: false,
                code: 'missing_object',
                reason: `the response had no "${spec.requireObject}" object`,
                keys: present,
            };
        }
    }
    if (spec.requireArray && !Array.isArray(result[spec.requireArray])) {
        return {
            ok: false,
            code: 'missing_array',
            reason: `the response had no "${spec.requireArray}" list`,
            keys: present,
        };
    }
    return { ok: true };
}

/**
 * Throw a ResponseShapeError (recording a diagnostics event first) when the
 * reply's shape is wrong. Call it inside the try that wraps the parse, so the
 * existing catch sends it down the retry path like a parse failure.
 *
 * @param {*} result — the parsed reply
 * @param {object} spec — one of the *_RESPONSE specs in knowledge/prompts.js
 * @param {{op: string, attempt?: number}} context — op names the Knowledge
 *   call; attempt is omitted by callers without a retry loop (Growth capture)
 * @returns {void}
 */
export function assertResponseShape(result, spec, { op, attempt }) {
    const shape = checkResponseShape(result, spec);
    if (shape.ok) return;
    record({
        level: 'warn',
        module: 'knowledge',
        event: 'response_shape_rejected',
        detail: {
            op,
            ...(attempt != null ? { attempt } : {}),
            code: shape.code,
            keyCount: shape.keys.length,
            keys: capKeys(shape.keys),
        },
    });
    throw new ResponseShapeError(shape);
}

/**
 * The reason a retry tells the model. A shape rejection names what was wrong;
 * a parse failure gets the plain wording, since a parser position ("at
 * position 4012") means nothing to the model.
 *
 * @param {*} err — what the attempt threw
 * @returns {string}
 */
export function retryReasonFor(err) {
    return err instanceof ResponseShapeError ? err.message : PARSE_FAILURE_REASON;
}

/**
 * Field refresh's likeliest drift: the request lists the fields to refresh as
 * a FLAT JSON object (<refresh_fields>), and a model mirroring it answers flat
 * — {"agenda": "…"} with no "fields" wrapper. That answer is unambiguous, so
 * it is wrapped rather than spending a retry on it. Only when there is no
 * "fields" key and at least one requested key sits at the top level; the
 * caller's scope filter still keeps only the requested keys.
 *
 * @param {*} result — the parsed reply
 * @param {string[]} requestedKeys — the fields the refresh asked for
 * @param {{op: string}} context
 * @returns {*} `{fields: result}` when wrapped, otherwise `result` unchanged
 */
export function wrapFlatFieldsAnswer(result, requestedKeys, { op }) {
    if (!result || typeof result !== 'object' || Array.isArray(result) || hasOwn(result, 'fields')) return result;
    if (!requestedKeys.some(k => hasOwn(result, k))) return result;
    record({
        level: 'info',
        module: 'knowledge',
        event: 'response_shape_repaired',
        detail: { op, code: 'flat_fields', keyCount: Object.keys(result).length },
    });
    return { fields: result };
}
