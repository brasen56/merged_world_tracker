/**
 * core/api.js — Shared LLM API fetch with retry logic
 *
 * Consolidates the three nearly-identical fetchFromApi implementations
 * from WorldState, Session Chronicle, and Knowledge Tracker.
 */

import { getContextSafe } from './context.js';

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

        // Some models (DeepSeek, o1, etc.) put reasoning in a separate field.
        // If content is empty but reasoning_content exists, the model may have
        // hit max_tokens during the thinking phase. Try to recover.
        if (!content || !content.trim()) {
            const reasoning = message?.reasoning_content || message?.reasoning || '';
            if (reasoning.trim()) {
                console.warn(`[MWT API] Content empty but reasoning_content present (${reasoning.length} chars). finish_reason=${finishReason}. Using reasoning_content as fallback.`);
                content = reasoning;
            } else if (finishReason === 'length') {
                const err = new Error(
                    `API returned empty content — the model hit max_tokens (${settings.maxTokens}) before producing output. ` +
                    `Try increasing Max Tokens in settings, or use a model that doesn't use extended thinking.`
                );
                err._noRetry = true;
                throw err;
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
 * Resolve API settings, preferring Connection Profile then falling back
 * to custom API config.
 * Returns { mode: 'cm' | 'custom', fetchFn, settings }
 */
export function resolveApiCall({ moduleSettings, globalSettings = {} }) {
    const profileId = moduleSettings.connectionProfileId ?? globalSettings.connectionProfileId ?? null;
    if (profileId) {
        return { mode: 'cm', fetchFn: fetchViaConnectionProfile, settings: moduleSettings };
    }
    return { mode: 'custom', fetchFn: fetchFromApi, settings: moduleSettings };
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