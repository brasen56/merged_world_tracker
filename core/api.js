/**
 * core/api.js — Shared LLM API fetch with retry logic
 *
 * Consolidates the three nearly-identical fetchFromApi implementations
 * from WorldState, Session Chronicle, and Knowledge Tracker.
 */

import { getContextSafe } from './context.js';
import { getGlobalSettings } from './settings.js';
import { recordApiCall } from './diagnostics.js';

function apiModule(settings) {
    return settings?.module || settings?.moduleKey || 'api';
}

function usageSummary(usage) {
    if (!usage || typeof usage !== 'object') return null;
    return {
        prompt_tokens: usage.prompt_tokens ?? null,
        completion_tokens: usage.completion_tokens ?? null,
        total_tokens: usage.total_tokens ?? null,
    };
}

function errorClass(err) {
    if (err?._isHtmlResponse) return 'HTML-response';
    if (err?._isNoContent) return 'no-content';
    if (err?._isLengthError) return '_isLengthError';
    if (err?._noRetry) return '_noRetry';
    return err ? (err.name || 'Error') : 'Error';
}

function captureApiCall({ startedAt, settings, mode, name, attempts, status, finishReason, usage, error }) {
    recordApiCall({
        module: apiModule(settings),
        mode,
        model: name,
        durationMs: Date.now() - startedAt,
        retries: Math.max(0, attempts - 1),
        status,
        finish_reason: finishReason,
        usage: usageSummary(usage),
        ...(error ? { errorClass: errorClass(error) } : {}),
        ok: !error,
        at: Date.now(),
    });
}

/**
 * Strip trailing slashes and an accidental /chat/completions suffix.
 *
 * CORE-04: The previous version did not strip query strings or fragments, so
 * a URL like `https://api.example.com/v1?x=1` survived intact and the endpoint
 * became `https://api.example.com/v1?x=1/chat/completions`. Strip the query
 * and fragment before the suffix check so the endpoint is assembled correctly.
 */
export function normalizeApiBase(url) {
    let clean = String(url || '');
    // CORE-04: Drop query string and fragment before suffix checks.
    const qIdx = clean.search(/[?#]/);
    if (qIdx !== -1) clean = clean.slice(0, qIdx);
    return clean.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
}

/**
 * Coerce a value to a finite number, falling back when it is not.
 *
 * CORE-05 (read boundary): the write boundary in core/ui.js
 * (readApiSettingsValues) now guards non-numeric input, but settings persisted
 * as NaN *before* that fix survive on disk. `JSON.stringify(NaN)` emits `null`,
 * so a bare `Number(settings.topP)` sent `top_p: null` to the API on every call
 * until the user re-opened and re-saved settings. This is the read-side safety
 * net: any non-finite optional generation value is replaced with the same
 * default the write boundary uses, so pre-fix NaN data behaves like a fresh
 * save rather than reaching the wire as `null`.
 *
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
export function finiteNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * Generic async retry with exponential backoff.
 *
 * The inner function should throw errors as normal. To prevent retry on
 * specific errors, set `err._noRetry = true` before throwing.
 *
 * @param {number} attempts — max retries (0 = one attempt, no retries)
 * @param {function(number): Promise<T>} fn — async function receiving attempt index
 * @param {object} [opts]
 * @param {function(Error, number, number): void} [opts.onRetry] — called before each retry with (err, attempt, delay)
 * @returns {Promise<T>}
 */
export async function retryAsync(attempts, fn, { onRetry } = {}) {
    // CORE-06: Validate `attempts` at the boundary. A negative or non-finite
    // value used to run zero loop iterations and then fall through to
    // `throw lastErr`, where `lastErr` was `undefined` — so the caller got a
    // useless throw of `undefined` instead of the original rejection (or a
    // useful input error). Coerce to a finite non-negative integer; an invalid
    // value becomes 0 so the function makes exactly one attempt and surfaces
    // the real error.
    const rawAttempts = Number(attempts);
    const maxAttempts = Number.isFinite(rawAttempts) && rawAttempts >= 0
        ? Math.floor(rawAttempts)
        : 0;
    let lastErr;
    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
        try {
            return await fn(attempt);
        } catch (err) {
            lastErr = err;
            if (attempt >= maxAttempts) throw err;
            // CORE-06: A non-object rejection (a string, null, number, etc.)
            // made `err._noRetry` itself throw a TypeError, masking the
            // original rejection. Inspect the no-retry marker safely so the
            // real error always propagates.
            if (err && typeof err === 'object' && err._noRetry) throw err;
            const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
            onRetry?.(err, attempt, delay);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastErr;
}

/**
 * Send a chat-completion request to an OpenAI-compatible API.
 *
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {string} opts.userContent
 * @param {object} opts.settings — { apiUrl, apiKey, modelName, maxTokens, temperature, topP, frequencyPenalty, presencePenalty, customHeaders }
 * @param {number} [opts.retries=2]
 * @returns {Promise<string>} the raw content string from the API
 */
export async function fetchFromApi({
    systemPrompt,
    userContent,
    settings,
    retries = 2,
}) {
    const startedAt = Date.now();
    let attempts = 0;
    let status = null;
    let finishReason = null;
    let usage = null;
    const base = normalizeApiBase(settings.apiUrl);
    const endpoint = `${base}/chat/completions`;

    let headers = { 'Content-Type': 'application/json' };
    if (settings.apiKey) {
        headers['Authorization'] = `Bearer ${settings.apiKey}`;
    }
    if (settings.customHeaders) {
        try {
            const extra = JSON.parse(settings.customHeaders);
            headers = { ...headers, ...extra };
        } catch { /* ignore malformed headers */ }
    }

    const payload = {
        model: settings.modelName,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
        ],
        max_tokens: Number(settings.maxTokens) || 2000,
        temperature: Number.isFinite(Number(settings.temperature)) ? Number(settings.temperature) : 0.3,
        stream: false,
    };

    // Optional params — only include if the settings object provides them.
    // CORE-05 (read boundary): recover non-finite values (NaN persisted before
    // the write-boundary fix) to the documented default instead of letting
    // JSON.stringify serialize them to `null` in the payload.
    if (settings.topP != null) payload.top_p = finiteNumber(settings.topP, 1.0);
    if (settings.frequencyPenalty != null) payload.frequency_penalty = finiteNumber(settings.frequencyPenalty, 0);
    if (settings.presencePenalty != null) payload.presence_penalty = finiteNumber(settings.presencePenalty, 0);

    try {
        const apiContent = await retryAsync(retries, async (attempt) => {
        attempts = attempt + 1;
        console.log(`[MWT API] POST ${endpoint} model=${settings.modelName} attempt=${attempt}`);
        const response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
        });
        status = response.status ?? null;

        if (!response.ok) {
            const errText = await response.text().catch(() => response.statusText);

            // Detect HTML responses (wrong URL) — always fatal
            if (/^\s*<!DOCTYPE/i.test(errText) || /^\s*<html/i.test(errText)) {
                const err = new Error(
                    `API URL returned HTML instead of JSON (${response.status}). ` +
                    `Check the API URL — resolved to: "${endpoint}". ` +
                    `For OpenAI-compatible APIs, use a base URL like https://api.openai.com/v1`
                );
                err._noRetry = true;
                err._isHtmlResponse = true;
                throw err;
            }

            const err = new Error(`API error ${response.status}: ${errText}`);
            // Only retry on 5xx / 429; 4xx is fatal
            if (response.status < 500 && response.status !== 429) {
                err._noRetry = true;
            }
            throw err;
        }

        const data = await response.json();
        usage = data?.usage ?? null;
        const message = data?.choices?.[0]?.message;
        let content = message?.content;
        const detectedFinishReason = data?.choices?.[0]?.finish_reason
            ?? data?.finish_reason ?? data?.finishReason ?? null;
        finishReason = detectedFinishReason;

        // Truncation detection. finish_reason="length" means the model hit the
        // max_tokens cap mid-generation, so any returned content is a partial,
        // unusable fragment (e.g. half a JSON object) that would only fail
        // downstream. Fail fast with a clear, actionable error instead of
        // returning the broken text. This is especially common with reasoning
        // models (which spend part of the token budget on thinking) and with
        // large outputs such as Knowledge Tracker Dossier Mode scans.
        if (detectedFinishReason === 'length') {
            const err = new Error(
                `Response truncated — the model hit the Max Tokens limit (${settings.maxTokens}) ` +
                `before finishing (finish_reason="length"). ` +
                `Reasoning models consume part of the token budget for thinking; reasoning depth is ` +
                `non-deterministic so a retry may succeed. Consider increasing "Max Tokens" in Settings.`
            );
            // Allow retry: reasoning models are non-deterministic — a retry may
            // use fewer reasoning tokens and finish within budget.
            err._isLengthError = true;
            throw err;
        }

        // Some models (DeepSeek, o1, etc.) put reasoning in a separate field.
        // If content is empty but reasoning_content exists, fall back to it.
        if (!content || !content.trim()) {
            const reasoning = message?.reasoning_content || message?.reasoning || '';
            if (reasoning.trim()) {
                console.warn(`[MWT API] Content empty but reasoning_content present (${reasoning.length} chars). Using reasoning_content as fallback.`);
                content = reasoning;
            } else {
                const err = new Error('API returned no content. Response: ' + JSON.stringify(data).slice(0, 300));
                err._noRetry = true;
                err._isNoContent = true;
                throw err;
            }
        }

        // Log token usage if available
        if (data?.usage) {
            console.log(`[MWT API] Token usage — prompt: ${data.usage.prompt_tokens || 0}, completion: ${data.usage.completion_tokens || 0}, total: ${data.usage.total_tokens || 0}`);
        }

        return content;
        });
        captureApiCall({ startedAt, settings, mode: 'custom', name: settings.modelName, attempts, status, finishReason, usage });
        return apiContent;
    } catch (error) {
        captureApiCall({ startedAt, settings, mode: 'custom', name: settings.modelName, attempts, status, finishReason, usage, error });
        throw error;
    }
}

/**
 * Send a prompt through a SillyTavern Connection Manager profile.
 * Uses ConnectionManagerRequestService from shared.js to support every
 * backend ST supports (OpenAI, TextGen, etc.) with full preset/instruct support.
 *
 * @param {object} opts
 * @param {string} opts.systemPrompt
 * @param {string} opts.userContent
 * @param {object} opts.settings — { connectionProfileId, maxTokens }
 * @param {number} [opts.retries=2]
 * @returns {Promise<string>} the raw content string
 */
export async function fetchViaConnectionProfile({ systemPrompt, userContent, settings, retries = 2 }) {
    const startedAt = Date.now();
    let attempts = 0;
    let status = null;
    let finishReason = null;
    let usage = null;
    // Lazy-load ConnectionManagerRequestService from ST's shared.js
    const sharedModule = await import('../../../../shared.js');
    const ConnectionManagerRequestService = sharedModule.ConnectionManagerRequestService;

    if (!ConnectionManagerRequestService) {
        throw new Error(
            'ConnectionManagerRequestService not available. ' +
            'Your SillyTavern version may not support connection profiles. ' +
            'Configure a custom API URL/Key in Settings instead.'
        );
    }

    // Resolve profile ID: explicit setting > ST's currently selected profile
    let profileId = settings.connectionProfileId || null;
    const ctx = getContextSafe();
    if (!profileId) {
        profileId = ctx?.extensionSettings?.connectionManager?.selectedProfile || null;
    }
    if (!profileId) {
        throw new Error(
            'No connection profile selected. ' +
            'Select a profile in Settings or in ST\'s Connection Manager.'
        );
    }

    // Build messages array — constructPrompt handles text vs. chat completion formatting.
    // Feature-detect: the Aikobots v4 fork removed constructPrompt, but sendRequest
    // accepts a messages array directly (Array.isArray(prompt) ? prompt : [...]).
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
    ];
    const prompt = typeof ConnectionManagerRequestService.constructPrompt === 'function'
        ? ConnectionManagerRequestService.constructPrompt(messages, profileId)
        : messages;
    const maxTokens = Number(settings.maxTokens) || 2000;

    try {
        const cmText = await retryAsync(retries, async (attempt) => {
        attempts = attempt + 1;
        console.log(`[MWT API] Using Connection Profile: ${profileId}, attempt=${attempt}`);
        const result = await ConnectionManagerRequestService.sendRequest(
            profileId,
            prompt,
            maxTokens,
            {
                extractData: true,
                includePreset: true,
                includeInstruct: true,
            },
        );
        status = result?.status ?? result?.statusCode ?? null;
        usage = result?.usage ?? null;

        // Truncation detection — see fetchFromApi for rationale. finish_reason
        // can surface in several shapes depending on ST version and extractData:
        // with extractData:true the fork often returns { content, reasoning } and
        // NO `choices` array, so the raw-shape check alone silently misses
        // truncation. Check every known location, and log it (plus completion
        // tokens) on every call so a hidden response-length cap is diagnosable —
        // e.g. a connection profile whose own preset caps below `maxTokens`.
        const cmFinishReason = result?.choices?.[0]?.finish_reason
            ?? result?.finish_reason ?? result?.finishReason ?? null;
        finishReason = cmFinishReason;
        const cmCompletionTokens = result?.usage?.completion_tokens
            ?? result?.completion_tokens ?? null;
        console.log(
            `[MWT API] CM result — finish_reason=${cmFinishReason ?? 'n/a'}, ` +
            `completion_tokens=${cmCompletionTokens ?? 'n/a'}, maxTokens(req)=${maxTokens}`
        );
        if (cmFinishReason === 'length') {
            const err = new Error(
                `Response truncated — the model hit the Max Tokens limit (${maxTokens}) ` +
                `before finishing (finish_reason="length"). ` +
                `If it's already high, check that the connection profile's own response-length ` +
                `preset isn't capping lower. Reasoning models consume part of the token budget for ` +
                `thinking; reasoning depth is non-deterministic so a retry may succeed.`
            );
            // Allow retry: reasoning models are non-deterministic — a retry may
            // use fewer reasoning tokens and finish within budget.
            err._isLengthError = true;
            throw err;
        }

        // Extract text from result — handle multiple possible shapes.
        // The Aikobots v4 fork (and newer ST versions) return { content, reasoning }
        // where content can be a string or a parsed JSON object (when json_schema
        // is used). Check this branch before the legacy shapes.
        let text = '';
        if (typeof result === 'string') {
            text = result;
        } else if (result?.content != null) {
            text = typeof result.content === 'object' ? JSON.stringify(result.content) : String(result.content);
        } else if (result?.text) {
            text = result.text;
        } else if (result?.choices?.[0]?.message?.content) {
            text = result.choices[0].message.content;
        } else if (result?.choices?.[0]?.text) {
            text = result.choices[0].text;
        } else {
            const err = new Error('Unable to extract text from API response: ' + JSON.stringify(result).slice(0, 300));
            err._noRetry = true;
            throw err;
        }

        // Log token usage if available
        if (result?.usage) {
            console.log(`[MWT API] Token usage — prompt: ${result.usage.prompt_tokens || 0}, completion: ${result.usage.completion_tokens || 0}, total: ${result.usage.total_tokens || 0}`);
        }

        return text;
        }, {
        onRetry: (err, attempt, delay) => {
            console.warn(`[MWT API] Connection profile request failed (attempt ${attempt + 1}): ${err.message}. Retrying in ${delay}ms...`);
        },
        });
        captureApiCall({ startedAt, settings, mode: 'cm', name: profileId, attempts, status, finishReason, usage });
        return cmText;
    } catch (error) {
        captureApiCall({ startedAt, settings, mode: 'cm', name: profileId, attempts, status, finishReason, usage, error });
        throw error;
    }
}

/**
 * Resolve API settings. The global Settings tab is documented as "defaults
 * for all modules", so an unconfigured module falls back to it without
 * requiring an explicit "Sync to Modules". Precedence:
 *
 *   1. module Connection Profile
 *   2. module custom API (URL + model both set)
 *   3. global Connection Profile
 *   4. global custom API (module keeps its own generation params)
 *
 * A module explicitly configured with a custom URL/model wins over a global
 * profile — module config is the override, global config is the default.
 *
 * Returns { mode: 'cm' | 'custom', fetchFn, settings }
 */
export function resolveApiCall({ moduleSettings, globalSettings }) {
    const globals = globalSettings ?? getGlobalSettings();

    if (moduleSettings.connectionProfileId) {
        return { mode: 'cm', fetchFn: fetchViaConnectionProfile, settings: moduleSettings };
    }
    if (moduleSettings.apiUrl && moduleSettings.modelName) {
        return { mode: 'custom', fetchFn: fetchFromApi, settings: moduleSettings };
    }
    if (globals.connectionProfileId) {
        return {
            mode: 'cm',
            fetchFn: fetchViaConnectionProfile,
            settings: { ...moduleSettings, connectionProfileId: globals.connectionProfileId },
        };
    }
    // Global custom API: connection fields come from the global settings while
    // generation params (maxTokens, temperature, …) stay module-specific.
    return {
        mode: 'custom',
        fetchFn: fetchFromApi,
        settings: {
            ...moduleSettings,
            apiUrl: globals.apiUrl || '',
            apiKey: globals.apiKey || '',
            modelName: globals.modelName || '',
            customHeaders: moduleSettings.customHeaders || globals.customHeaders || '',
        },
    };
}

/**
 * Clean up common model output artifacts:
 * - Strip thinking blocks
 * - Remove code fences
 * - Remove common preambles
 * - Normalize line endings
 */
export function normaliseOutput(raw) {
    let text = (raw || '').trim();

    // Strip thinking blocks — <think>, <thinking>, <reasoning>; the backreference
    // matches the correct closing tag so <thinking>…</thinking> doesn't leave "ing>".
    text = text.replace(/<(think|thinking|reasoning)\b[\s\S]*?<\/\1>/gi, '').trim();

    // Unwrap markdown code fences — handle multiple patterns:
    // 1. Entire response is a single fenced block
    // 2. Fenced block with optional text before/after
    // 3. Fences without language tag
    const fenceMatch = text.match(/^```[a-z]*\r?\n([\s\S]*?)```\s*$/i);
    if (fenceMatch) {
        text = fenceMatch[1].trim();
    } else {
        // Try to extract JSON from a fenced block that may have surrounding text
        const innerFence = text.match(/```[a-z]*\r?\n([\s\S]*?)```/i);
        if (innerFence) text = innerFence[1].trim();
    }

    // Strip common single-line preambles
    text = text.replace(
        /^(here(?:'s| is)(?: the| an)?(?: updated)?(?: world state)?(?:\s*document)?[:.\s]*)/i,
        ''
    ).trim();

    // Normalize line endings
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    text = text.replace(/\n{3,}/g, '\n\n');

    return text.trim();
}

// ─── Lenient JSON extraction & repair ──────────────────────────────────────────
//
// Models frequently return JSON that JSON.parse rejects for reasons that are
// entirely recoverable:
//
//   1. Surrounding prose ("Here is the result:\n{ ... }")
//   2. Truncation — the output hit max_tokens and was cut off mid-object
//      (sometimes the API doesn't report finish_reason="length", e.g. with
//      connection profiles or proxies).
//   3. Trailing commas before a closing } or ].
//   4. An unterminated string value (the last field was being written when
//      generation stopped).
//
// `parseJsonLenient` handles all of these gracefully. It first tries a strict
// parse; if that fails it extracts the outermost { … } block, removes trailing
// commas, repairs truncation, and tries again.

/**
 * Find the index of the matching closing brace for the opening brace at
 * `start`, respecting string literals and escape sequences so that braces
 * inside strings don't affect depth counting.
 *
 * Returns the index of the matching '}', or -1 if the object is never closed
 * (i.e. truncated output).
 */
function findMatchingBrace(text, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\' && inString) { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1; // never closed
}

/**
 * Attempt to repair a truncated JSON string by:
 * - Closing any unterminated string
 * - Removing trailing incomplete key/value fragments and dangling commas
 * - Closing open arrays and objects in the correct nesting order
 *
 * Returns the repaired string (which may still be invalid — caller should try
 * parsing and fall back to an error).
 */
function repairTruncatedJson(text) {
    let repaired = text;

    // If the text ends mid-string (odd number of unescaped quotes from the last
    // structural character), close the string.
    let inString = false;
    let escaped = false;
    for (let i = 0; i < repaired.length; i++) {
        const ch = repaired[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\' && inString) { escaped = true; continue; }
        if (ch === '"') inString = !inString;
    }
    if (inString) repaired += '"';

    // Trim trailing whitespace and incomplete fragments after the last
    // complete value.
    // 1. Drop trailing whitespace + commas (a comma with nothing after it)
    repaired = repaired.replace(/[\s,]+$/, '');
    // 2. If it ends with a colon (key with no value), drop that incomplete key
    repaired = repaired.replace(/"[^"]*"\s*:\s*$/, '');
    // 3. Drop a dangling comma again (the key-drop above may have exposed one)
    repaired = repaired.replace(/[\s,]+$/, '');

    // Track a stack of open delimiters (outside strings) so we can close them
    // in the correct nesting order. Opening order { [ { means closing } ] }.
    const stack = [];
    inString = false; escaped = false;
    for (let i = 0; i < repaired.length; i++) {
        const ch = repaired[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\' && inString) { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{' || ch === '[') stack.push(ch);
        else if (ch === '}' || ch === ']') stack.pop();
    }

    // Close in reverse order of opening (pop from the stack)
    while (stack.length > 0) {
        const opener = stack.pop();
        repaired += (opener === '{') ? '}' : ']';
    }

    return repaired;
}

/**
 * Remove trailing commas that appear immediately before } or ] — a common
 * model output error that strict JSON.parse rejects.
 *
 * **CORE-01 fix:** The previous implementation was a single regex
 * (`/,\s*([}\]])/g`) that operated on the raw text with no string-state
 * tracking. A generated *value* containing `,}` or `,]` (e.g. dialogue text
 * `"she said,}"`) was silently edited — the parse succeeded, so no downstream
 * validation could ever catch the corruption.
 *
 * This scanner walks the text character by character, tracking whether we are
 * inside a string literal and whether the current character is escaped. Only
 * commas found at structural depth (outside any string) followed by optional
 * whitespace and then `}` or `]` are removed.
 *
 * Regression cases handled:
 * - `",}"` — comma inside a string value → preserved
 * - `",]"` — comma inside a string value → preserved
 * - escaped quotes inside a value (`"he said \"hi,}\""`) → preserved
 * - genuine trailing commas (`{"a":1,}`) → stripped
 * - truncated input (`{"a":1,`) → no false match (no closing brace)
 * - nested structures (`{"a":[1,2,],}`) → both trailing commas stripped
 */
function removeTrailingCommas(text) {
    let out = '';
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (escaped) {
            // Previous char was a backslash inside a string — copy this char
            // verbatim and clear the escape flag.
            out += ch;
            escaped = false;
            continue;
        }

        if (inString) {
            if (ch === '\\') {
                out += ch;
                escaped = true;
                continue;
            }
            if (ch === '"') {
                inString = false;
                out += ch;
                continue;
            }
            // Any other character inside a string — copy verbatim. This
            // includes commas and braces, which must NOT be treated as
            // structural.
            out += ch;
            continue;
        }

        // --- Structural context (outside any string) ---

        if (ch === '"') {
            inString = true;
            out += ch;
            continue;
        }

        if (ch === ',') {
            // Look ahead: if the next non-whitespace character is } or ],
            // this is a genuine trailing comma — skip it. Otherwise keep it.
            let j = i + 1;
            while (j < text.length && /\s/.test(text[j])) j++;
            if (j < text.length && (text[j] === '}' || text[j] === ']')) {
                // Trailing comma — omit it from the output.
                continue;
            }
            out += ch;
            continue;
        }

        out += ch;
    }

    return out;
}

/**
 * Parse a string expected to contain a single JSON object, tolerating common
 * model output problems: surrounding prose, markdown fences, truncation,
 * trailing commas, and unterminated strings.
 *
 * @param {string} raw
 * @returns {object} the parsed object
 * @throws {Error} if the string cannot be parsed even after repair
 */
export function parseJsonLenient(raw) {
    const text = (raw || '').trim();
    if (!text) throw new Error('empty output');

    // Fast path — strict parse
    try { return JSON.parse(text); } catch { /* continue to recovery */ }

    // Extract the outermost { … } region. This strips prose/code fences.
    const start = text.indexOf('{');
    if (start === -1) throw new Error('no JSON object found in output');
    const end = findMatchingBrace(text, start);

    let jsonText;
    if (end !== -1) {
        // Complete object found — try strict parse on the extracted region
        jsonText = text.slice(start, end + 1);
        jsonText = removeTrailingCommas(jsonText);
        try { return JSON.parse(jsonText); } catch { /* continue */ }
    } else {
        // Truncated — no closing brace. Work with everything from the first {.
        jsonText = text.slice(start);
    }

    // Remove trailing commas then attempt repair + parse
    jsonText = removeTrailingCommas(jsonText);
    try { return JSON.parse(jsonText); } catch { /* continue */ }

    // Full repair pipeline: remove trailing commas → repair truncation → parse
    const repaired = repairTruncatedJson(removeTrailingCommas(jsonText));
    try { return JSON.parse(repaired); } catch (err) {
        throw new Error(`Could not parse JSON even after repair: ${err.message}`);
    }
}
