/**
 * core/api.js — Shared LLM API fetch with retry logic
 *
 * Consolidates the three nearly-identical fetchFromApi implementations
 * from WorldState, Session Chronicle, and Knowledge Tracker.
 */

import { getContextSafe } from './context.js';
import { getGlobalSettings } from './settings.js';

/**
 * Strip trailing slashes and an accidental /chat/completions suffix.
 */
export function normalizeApiBase(url) {
    return String(url || '').replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
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
    let lastErr;
    for (let attempt = 0; attempt <= attempts; attempt++) {
        try {
            return await fn(attempt);
        } catch (err) {
            lastErr = err;
            if (attempt >= attempts) throw err;
            if (err._noRetry) throw err;
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

    // Optional params — only include if the settings object provides them
    if (settings.topP != null) payload.top_p = Number(settings.topP);
    if (settings.frequencyPenalty != null) payload.frequency_penalty = Number(settings.frequencyPenalty);
    if (settings.presencePenalty != null) payload.presence_penalty = Number(settings.presencePenalty);

    return retryAsync(retries, async (attempt) => {
        console.log(`[MWT API] POST ${endpoint} model=${settings.modelName} attempt=${attempt}`);
        const response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
        });

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
        const message = data?.choices?.[0]?.message;
        let content = message?.content;
        const finishReason = data?.choices?.[0]?.finish_reason;

        // Truncation detection. finish_reason="length" means the model hit the
        // max_tokens cap mid-generation, so any returned content is a partial,
        // unusable fragment (e.g. half a JSON object) that would only fail
        // downstream. Fail fast with a clear, actionable error instead of
        // returning the broken text. This is especially common with reasoning
        // models (which spend part of the token budget on thinking) and with
        // large outputs such as Knowledge Tracker Dossier Mode scans.
        if (finishReason === 'length') {
            const err = new Error(
                `Response truncated — the model hit the Max Tokens limit (${settings.maxTokens}) ` +
                `before finishing (finish_reason="length"). ` +
                `Increase "Max Tokens" in the module's Settings. ` +
                `Reasoning models consume part of the token budget for thinking and need a higher limit; ` +
                `richer outputs (e.g. Dossier Mode) are also larger.`
            );
            err._noRetry = true;
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
                throw err;
            }
        }

        // Log token usage if available
        if (data?.usage) {
            console.log(`[MWT API] Token usage — prompt: ${data.usage.prompt_tokens || 0}, completion: ${data.usage.completion_tokens || 0}, total: ${data.usage.total_tokens || 0}`);
        }

        return content;
    });
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
    // Lazy-load ConnectionManagerRequestService from ST's shared.js
    const sharedModule = await import('../../../shared.js');
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

    // Build messages array — constructPrompt handles text vs. chat completion formatting
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
    ];
    const prompt = ConnectionManagerRequestService.constructPrompt(messages, profileId);
    const maxTokens = Number(settings.maxTokens) || 2000;

    return retryAsync(retries, async (attempt) => {
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

        // Truncation detection — see fetchFromApi for rationale.
        const cmFinishReason = result?.choices?.[0]?.finish_reason;
        if (cmFinishReason === 'length') {
            const err = new Error(
                `Response truncated — the model hit the Max Tokens limit (${maxTokens}) ` +
                `before finishing (finish_reason="length"). ` +
                `Increase "Max Tokens" in the module's Settings. ` +
                `Reasoning models consume part of the token budget for thinking and need a higher limit; ` +
                `richer outputs (e.g. Dossier Mode) are also larger.`
            );
            err._noRetry = true;
            throw err;
        }

        // Extract text from result — handle multiple possible shapes
        let text = '';
        if (typeof result === 'string') {
            text = result;
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
 */
function removeTrailingCommas(text) {
    return text.replace(/,\s*([}\]])/g, '$1');
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
