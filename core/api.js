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

    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            console.log(`[MWT API] POST ${endpoint} model=${settings.modelName} attempt=${attempt}`);
            const response = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                const errText = await response.text().catch(() => response.statusText);
                const err = new Error(`API error ${response.status}: ${errText}`);

                // Detect HTML responses (wrong URL)
                if (/^\s*<!DOCTYPE/i.test(errText) || /^\s*<html/i.test(errText)) {
                    throw new Error(
                        `API URL returned HTML instead of JSON (${response.status}). ` +
                        `Check the API URL — resolved to: "${endpoint}". ` +
                        `For OpenAI-compatible APIs, use a base URL like https://api.openai.com/v1`
                    );
                }

                // Retry on 5xx / 429; fatal on 4xx
                if (response.status >= 500 || response.status === 429) {
                    lastErr = err;
                    if (attempt < retries) {
                        const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
                        await new Promise(r => setTimeout(r, delay));
                        continue;
                    }
                    throw err;
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
                    throw new Error(
                        `API returned empty content — the model hit max_tokens (${settings.maxTokens}) before producing output. ` +
                        `Try increasing Max Tokens in settings, or use a model that doesn't use extended thinking.`
                    );
                } else {
                    throw new Error('API returned no content. Response: ' + JSON.stringify(data).slice(0, 300));
                }
            }

            // Log token usage if available
            if (data?.usage) {
                console.log(`[MWT API] Token usage — prompt: ${data.usage.prompt_tokens || 0}, completion: ${data.usage.completion_tokens || 0}, total: ${data.usage.total_tokens || 0}`);
            }

            return content;
        } catch (err) {
            lastErr = err;
            // Network-level errors (TypeError from fetch) — retry
            if (err instanceof TypeError && attempt < retries) {
                const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            throw err;
        }
    }
    throw lastErr || new Error('API request failed');
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

    // Strip thinking blocks
    text = text.replace(/<think[\s\S]*?<\/think>/gi, '').trim();

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