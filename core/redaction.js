/**
 * core/redaction.js — Shared redaction layer for the diagnostics panel + report.
 *
 * Phase 5 of the Diagnostics Panel (design §I.6, phases doc §II.4 Phase 5).
 * The copy-report button is the point of the feature, which makes it a leak
 * vector: testers paste its output into Discord and GitHub issues. Every
 * diagnostics tab and the report therefore route their data through THIS
 * module — no hand-rolled redaction anywhere else.
 *
 * Two independent rules, deliberately split (design §I.6):
 *
 *  1. UNCONDITIONAL secret redaction — always applied, in every mode:
 *       - settings.apiKey        → '[REDACTED]'
 *       - settings.customHeaders → header NAMES kept, every VALUE redacted
 *                                  (parsed JSON; may carry auth headers)
 *       - settings.apiUrl        → scheme + host only (some proxy setups
 *                                  embed a key in the path or query)
 *     Plus the auth header names (case-insensitive, like HTTP header names)
 *     anywhere they appear, for the day a report serializes request headers.
 *
 *  1b. STRING SCRUBBING — the same secrets, hiding inside free text. Matching
 *     on field NAMES alone is not enough, because MWT interpolates both a URL
 *     and an upstream error body into its error messages (`core/api.js`), and
 *     every toast is captured into the event ring (`core/notifications.js`):
 *
 *       "…resolved to: \"https://proxy.example.com/v1/<key>/chat/completions\""
 *       "API error 401: {…\"Incorrect API key provided: sk-live-…\"}"
 *
 *     Neither string sits under a secret key name, so every string value is
 *     additionally scrubbed for (a) caller-supplied known secret values,
 *     (b) embedded URLs (reduced to scheme + host), and (c) recognizable
 *     API-key/bearer-token shapes.
 *
 *  2. CONTENT gating — prompt bodies, injected payloads, chat-derived text,
 *     and ERROR BODIES. MWT interpolates model output ("API returned no
 *     content. Response: …") and raw upstream bodies into its error strings
 *     (`core/api.js`), so an error can quote the chat just as surely as a
 *     payload can. Included ONLY when the report's explicit opt-in checkbox
 *     is on (`{ includeContent: true }`); otherwise replaced by a marker that
 *     keeps the size (diagnostic, not sensitive). Error fields get their own
 *     marker so a reader can tell an omitted failure from an omitted prompt.
 *
 * Rules 1/1b apply even inside included content: opting IN to content never
 * opts IN to secrets.
 *
 * Pure module: no DOM, no SillyTavern runtime, no state — unit-testable with
 * nothing stubbed (test/redaction.test.js).
 *
 * Barrel/stub note: re-exported through core/index.js and mirrored in
 * test/stubs/core.js (the barrel→stub alias trap, phases doc §II.3).
 */

// ─── Constants ───────────────────────────────────────────────────────────────

/** Marker substituted for every redacted value. */
export const REDACTED = '[REDACTED]';

/**
 * Setting keys redacted unconditionally, wherever they appear in a structure
 * (the global settings AND per-module settings objects use these same names —
 * every module's settings block carries apiUrl/apiKey/customHeaders). Listed
 * here for consumers/tests; matching inside the walker is case-insensitive
 * because 'Authorization' is an HTTP header name.
 */
export const SECRET_KEYS = Object.freeze([
    'apiKey',
    'apiUrl',
    'customHeaders',
    // HTTP auth header names, for any surface that serializes request headers
    // (Phase 10's last-request tab). 'Authorization' is the generic one; the
    // rest are what the OpenAI-compatible backends MWT talks to actually use.
    'Authorization',
    'Proxy-Authorization',
    'api-key',        // Azure OpenAI
    'x-api-key',      // Anthropic
    'x-goog-api-key', // Google
]);

/**
 * Field names treated as reportable CONTENT (prompt bodies, injected payloads,
 * chat-derived text). Gated behind the explicit include-content opt-in; when
 * the opt-in is off their values are replaced with a size-only marker.
 *
 * Deliberately a conservative, well-known list rather than "every string":
 * telemetry fields (model names, durations, usage numbers, and Phase 3 event
 * details that are sizes/flags by construction) must stay visible, because
 * they ARE the diagnostics. The known content carriers today are the Phase 2
 * injection snapshots (`payload`) and the captured toast bodies (`message`);
 * the prompt fields cover the Phase 10 last-request tab before it exists.
 *
 * `message` is here because core/notifications.js records EVERY toast into the
 * event ring as `detail: { title, message }`, and those bodies quote the chat:
 * story beats (`story_planner/index.js`), NPC names (`knowledge/render.js`).
 * Only the body is gated — `title`, `event`, `module`, `level`, and `ts` stay,
 * so "a toast fired at T from module X" survives in either mode.
 *
 * `error` is NOT in this list because it gets its own branch in the walker
 * (ERROR_KEYS below): error strings quote the chat too — `core/api.js`
 * interpolates model output ("API returned no content. Response: …") and raw
 * upstream bodies into them, and a Phase 5 review caught exactly that shape
 * shipping in a content-EXCLUDED report. Error fields are gated with a
 * size-only `[error excluded — N chars]` marker: the fact AND size of the
 * failure survive, none of its text does. The raw, still-scrubbed body is the
 * "separately gated raw error" the content opt-in exists for. The `ok` flag,
 * durations, and token counts around it stay ungated, so "module X failed at
 * T" remains readable in either mode.
 */
export const CONTENT_KEYS = Object.freeze([
    'payload',       // Phase 2 injection snapshots — the exact setExtensionPrompt string
    'prompt',        // assembled prompt bodies
    'systemPrompt',  // per-call system prompts
    'userPrompt',
    'userContent',
    'messages',      // chat-derived message arrays
    'message',       // captured toast bodies (core/notifications.js) — quote the chat
    'customPrompt',  // user-authored prompt additions in the module settings blobs
    // Story Planner's REAL prompt setting names (story_planner/settings.js —
    // buildSystemPrompt()/buildUserPrompt() read these). A later tab that
    // serializes module configuration would otherwise pass them through with
    // content disabled.
    'customSystemPrompt',
    'customUserPrompt',
    // World State pinned entity names (world_state/settings.js) — a
    // comma-separated list of CHARACTER names, i.e. chat-derived content.
    'pinnedEntities',
]);

/**
 * Error-body field names, gated like content but with their own marker (the
 * walker's third branch). `error` is what every MWT failure path stamps — the
 * last-run map, the API-call capture, recovery-event details. collectionError
 * is what report.js's guarded collectors emit when an accessor throws, and a
 * V8 SyntaxError message includes a snippet of the text that failed to parse —
 * which can be chat data. Matched case-insensitively like SECRET_KEYS,
 * because 'error' is also the JSON key OpenAI-compatible backends use.
 */
export const ERROR_KEYS = Object.freeze(['error', 'collectionError']);

const _secretKeySet = new Set(SECRET_KEYS.map(k => k.toLowerCase()));
const _contentKeySet = new Set(CONTENT_KEYS);
const _errorKeySet = new Set(ERROR_KEYS.map(k => k.toLowerCase()));

function isSecretKey(key) {
    return typeof key === 'string' && _secretKeySet.has(key.toLowerCase());
}

function isContentKey(key) {
    return typeof key === 'string' && _contentKeySet.has(key);
}

function isErrorKey(key) {
    return typeof key === 'string' && _errorKeySet.has(key.toLowerCase());
}

// ─── Per-key redactors ───────────────────────────────────────────────────────

/**
 * Reduce a URL to scheme + host only ('https://api.example.com'). Everything
 * that could carry a secret — credentials, path, query, fragment — is
 * dropped: some proxy setups embed the API key in the path.
 *
 * Unparseable or host-less input returns REDACTED outright: if we cannot
 * prove where the host ends, we cannot prove the rest is safe to show.
 *
 * @param {string} url
 * @returns {string}
 */
export function redactApiUrl(url) {
    const raw = String(url ?? '').trim();
    if (!raw) return '';
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        return REDACTED;
    }
    if (!parsed.hostname) return REDACTED;
    return `${parsed.protocol}//${parsed.host}`;
}

/**
 * Redact a customHeaders value (a JSON string of header name → value, the
 * shape core/api.js parses).
 *
 * Names are kept — knowing that an auth-style header EXISTS is diagnostic
 * gold — but every value is replaced with REDACTED, whatever its type.
 * Non-object JSON (arrays, bare strings/numbers) and unparseable text are
 * redacted wholesale: we cannot reason about their shape, so we cannot show
 * them. Empty/whitespace input stays empty (nothing to leak, nothing to
 * noise up).
 *
 * @param {string} raw — the settings.customHeaders string
 * @returns {string} canonical JSON with redacted values (same shape as input)
 */
export function redactCustomHeaders(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return '';
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        return REDACTED;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return REDACTED;
    }
    const out = {};
    for (const name of Object.keys(parsed)) out[name] = REDACTED;
    return JSON.stringify(out);
}

// ─── String scrubbing (Rule 1b) ──────────────────────────────────────────────

/**
 * Any absolute URL embedded in free text. Stops at whitespace and at the
 * quoting/bracketing characters that surround a URL in a sentence, so
 * `resolved to: "https://host/v1/KEY".` yields the URL without the closing
 * quote or the full stop.
 */
const EMBEDDED_URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>()[\]{},]+/gi;

/**
 * Recognizable secret shapes. Deliberately prefix-anchored rather than
 * "any long random-looking run": profile UIDs, message hashes, and chat
 * identity keys are long opaque strings too, and scrubbing those would gut
 * exactly the diagnostics the panel exists to show.
 */
const TOKEN_RES = Object.freeze([
    // Authorization-style values, with or without their header name.
    /\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9\-._~+/=]{8,}/gi,
    // Vendor-prefixed keys: sk- / sk-ant- / sk-proj- (OpenAI, Anthropic),
    // gsk_ (Groq), xai- (xAI), hf_ (HuggingFace), r8_ (Replicate), etc.
    /\b(?:sk|rk|pk|xai|gsk|ghp|gho|ghu|ghs|hf|r8|pplx|nvapi|csk|sess)[-_][A-Za-z0-9\-_]{12,}/gi,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    /\bAIza[A-Za-z0-9\-_]{20,}/g,
]);

/**
 * Normalize caller-supplied known secret values into a scrub list: non-empty
 * strings only (an empty value would match everywhere and shred every string
 * it touched), longest first (so a key that contains a shorter one is
 * replaced whole).
 *
 * NO length floor, deliberately. The first draft dropped values under 8
 * characters to avoid over-redacting unrelated text, and a Phase 5 review
 * caught the hole: a configured key like `abc123`, echoed by a backend
 * notification, shipped in an opted-in report. Rule 1's unconditional secret
 * guarantee takes precedence over possible over-redaction — a short value
 * scrubbed out of a diagnostic sentence costs a little clarity; a live key in
 * a pasted report costs the account.
 *
 * @private
 */
function normalizeKnownSecrets(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const s of list) {
        if (typeof s === 'string' && s.trim()) out.push(s.trim());
    }
    return out.sort((a, b) => b.length - a.length);
}

/**
 * Scrub secrets out of one free-text string (Rule 1b). Applied to EVERY string
 * value the walker emits, in both content modes.
 *
 * Known limitation, stated plainly: an unrecognizable bare key (no vendor
 * prefix) echoed by a proxy in an error body is only caught when the caller
 * passes it via `knownSecrets`. The structural defenses are the content gate
 * on `message` and the host-only URL rewrite; the pattern list is the third
 * net, not the first.
 *
 * @param {string} text
 * @param {string[]} [knownSecrets] — already normalized (see above)
 * @returns {string}
 */
function scrubString(text, knownSecrets = []) {
    let out = text;
    // Exact known values first — zero false positives, highest confidence.
    for (const secret of knownSecrets) {
        if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    // Embedded URLs → scheme + host (the same rule redactApiUrl applies to the
    // settings field, for the copies that leaked into prose).
    out = out.replace(EMBEDDED_URL_RE, (match) => redactApiUrl(match) || REDACTED);
    for (const re of TOKEN_RES) out = out.replace(re, REDACTED);
    return out;
}

/**
 * Describe a value the walker cannot safely copy, instead of passing the
 * original reference through.
 *
 * This is the fail-CLOSED branch: an object whose prototype is not
 * Object.prototype could be a class instance (or a cross-realm object) holding
 * an apiKey, and returning it verbatim would hand the report a secret the
 * key-based rules never got to inspect. Dates are the one exception — they
 * cannot carry a field, and their ISO form is genuinely diagnostic.
 * @private
 */
function describeOpaque(node) {
    if (Object.prototype.toString.call(node) === '[object Date]') {
        const ms = node.getTime();
        return Number.isNaN(ms) ? '[Invalid Date]' : node.toISOString();
    }
    let name = 'object';
    try {
        name = node?.constructor?.name || 'object';
    } catch { /* exotic proxy — fall back to the generic label */ }
    return `[unserializable ${name}]`;
}

/**
 * Size-only placeholder for gated content. Keeps the length / item count
 * (both diagnostic, neither sensitive) and states plainly what happened.
 */
function contentMarker(value) {
    if (value == null) return value;
    if (typeof value === 'string') {
        return value.length ? `[content excluded — ${value.length} chars]` : '';
    }
    if (Array.isArray(value)) {
        return `[content excluded — ${value.length} item(s)]`;
    }
    return REDACTED; // unknown shape under a content key — never pass it through
}

/**
 * Size-only placeholder for a gated error body — the "safe summary" half of
 * the error rule. The fact that an error was recorded, plus its size, is
 * telemetry; the TEXT is not provably free of chat-derived content (MWT
 * interpolates model output and upstream bodies into error strings), so none
 * of it survives without the opt-in — there is no prefix length at which an
 * error string is provably safe, so we fail closed.
 *
 * `null` stays `null`: on a last-run stamp a null error MEANS "no error", and
 * replacing it with a marker would turn every success into a maybe-failure.
 */
function errorMarker(value) {
    if (value == null) return value;
    if (typeof value === 'string') {
        return value.length ? `[error excluded — ${value.length} chars]` : '';
    }
    if (Array.isArray(value)) {
        return `[error excluded — ${value.length} item(s)]`;
    }
    return REDACTED; // unknown shape under an error key — never pass it through
}

// ─── Deep walker ─────────────────────────────────────────────────────────────

/**
 * The single redaction entry point every diagnostics tab and the report must
 * route through (Phase 5's hard gate — phases doc §II.4).
 *
 * Deep-copies plain structures applying ALL rules:
 *  - secret keys are redacted unconditionally (Rule 1), in either mode;
 *  - every string value is scrubbed for embedded secrets (Rule 1b);
 *  - content keys are replaced with a size-only marker unless
 *    `{ includeContent: true }` (Rule 2);
 *  - error bodies are likewise replaced with a size-only ERROR marker unless
 *    opted in (see ERROR_KEYS) — an error string can quote the chat.
 *
 * Fidelity notes:
 *  - Cycles are cut with a '[Circular]' placeholder (the report serializes to
 *    JSON, where they could not survive anyway). Tracking is per-PATH, not
 *    per-visit, so an object legitimately referenced twice in one structure is
 *    rendered twice rather than mislabelled '[Circular]'. The cost is that a
 *    wide DAG is walked once per reference; diagnostics structures (a 200-slot
 *    ring, ≤20 API calls) are far too small for that to matter.
 *  - Arrays, plain objects, and null-prototype objects are walked. Anything
 *    else is replaced by a describeOpaque() label rather than passed through —
 *    a class instance could be carrying an apiKey the key rules never saw.
 *  - The input is never mutated; the output shares no references with it.
 *
 * @param {*} value
 * @param {object} [opts]
 * @param {boolean} [opts.includeContent=false]
 * @param {string[]} [opts.knownSecrets] — live secret VALUES (this install's
 *        apiKey, customHeaders values) to strike out of free text wherever
 *        they appear. See collectKnownSecrets() in diagnostics_panel/report.js.
 * @returns {*} a redacted deep copy
 */
export function redactForReport(value, { includeContent = false, knownSecrets } = {}) {
    const secrets = normalizeKnownSecrets(knownSecrets);
    const path = new WeakSet();
    const walk = (node) => {
        if (typeof node === 'string') return scrubString(node, secrets);
        if (node === null || typeof node !== 'object') return node;
        if (path.has(node)) return '[Circular]';
        if (!Array.isArray(node)) {
            const proto = Object.getPrototypeOf(node);
            if (proto !== Object.prototype && proto !== null) return describeOpaque(node);
        }
        path.add(node);
        try {
            if (Array.isArray(node)) return node.map(walk);
            const out = {};
            for (const key of Object.keys(node)) {
                const v = node[key];
                if (isSecretKey(key)) {
                    const lower = key.toLowerCase();
                    out[key] = lower === 'apiurl' ? redactApiUrl(v)
                        : lower === 'customheaders' ? redactCustomHeaders(v)
                        : REDACTED;
                } else if (!includeContent && isContentKey(key)) {
                    out[key] = contentMarker(v);
                } else if (!includeContent && isErrorKey(key)) {
                    out[key] = errorMarker(v);
                } else {
                    out[key] = walk(v);
                }
            }
            return out;
        } finally {
            path.delete(node);
        }
    };
    return walk(value);
}

/**
 * Unconditional secret redaction with NO content gating — for telemetry-only
 * surfaces that never opted into content (e.g. the Phase 1 API-call tables:
 * telemetry by construction, no content fields to gate).
 *
 * ⚠ This is `includeContent: true`. It is the right call ONLY for data that
 * carries no content fields by construction. A tab that reaches for it as
 * "the simple one" would render payloads regardless of the opt-in checkbox —
 * if the data could contain a content field, call redactForReport() and pass
 * the live checkbox state instead.
 *
 * @param {*} value
 * @param {{ knownSecrets?: string[] }} [opts]
 * @returns {*} a redacted deep copy
 */
export function redactSecretsDeep(value, { knownSecrets } = {}) {
    return redactForReport(value, { includeContent: true, knownSecrets });
}

