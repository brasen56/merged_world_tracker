/**
 * world_state/sections.js — Per-section regeneration logic.
 *
 * Depends on data.js, settings.js, injection.js, refresh.js (for buildSystemPrompt).
 */

import {
    resolveApiCall, normaliseOutput, escapeRegex,
    captureScope, assertSameScope,
    captureRevision, sameRevision,
    truncateText, isCancellation,
} from '../core/index.js';
// Part 6 (§7.4) pause guard + the store id it checks. Direct import (not the
// barrel) so the REAL pause singleton is read even under the test
// barrel→stub alias.
import { isStorePausedForCurrentScope } from '../core/schema_status.js';
import { worldStateSchema } from './schema.js';

import { DEFAULT_SYSTEM_PROMPT } from './prompts.js';
import { getSettings, hasValidSettings, getPinnedEntities } from './settings.js';
import {
    state, SECTIONS, VARIETY_LABELS,
    getWorldStateText, commitHistorySnapshot, setProvenance,
    extractOnlySection, replaceSection,
} from './data.js';
import { applyWorldStateInjection } from './injection.js';
import { getRecentMessagesForScan } from './refresh.js';
import { buildProvenance, groundingGate } from './provenance.js';
import { getDeltaStatus, buildPartialRefreshStatus } from './delta.js';

export { extractOnlySection, replaceSection };

// ─── Section prompt builders ─────────────────────────────────────────────────

function buildSystemPrompt() {
    const custom = getSettings().customPrompt?.trim();
    return custom || DEFAULT_SYSTEM_PROMPT;
}

function buildSectionSystemPrompt(sectionName, variety) {
    const baseSystem = buildSystemPrompt();

    let extra = '';
    if (sectionName === 'Plot Seeds') {
        if (variety >= 4) {
            extra = `

VARIETY MODE (level ${variety}/5 — ${VARIETY_LABELS[variety]}):
- Lean toward bold, unexpected, or destabilizing seeds. Avoid the safest interpretation.
- At least one seed should introduce a disruption, twist, or escalation that hasn't been telegraphed yet.
- Diversify categories: try to hit at least 4 different ones from [contact, entrance, social, institutional, opportunity, pressure, threat].
- Consider tangential connections — characters, threads, or pressures that haven't been combined before.
- Still: every seed must be a NEW EVENT, not a restatement of established facts.`;
        } else if (variety === 3) {
            extra = `

VARIETY MODE (level ${variety}/5 — ${VARIETY_LABELS[variety]}):
- Cover more categories than usual: aim for at least 3 different ones from [contact, entrance, social, institutional, opportunity, pressure, threat].
- Mix safer and bolder seeds.
- Consider less obvious escalations of existing pressures.`;
        }
    } else if (variety >= 4) {
        extra = `

VARIETY MODE (level ${variety}/5 — ${VARIETY_LABELS[variety]}):
- Prefer bolder, more vivid, less default interpretations where the section allows it.`;
    }

    const override = `

---

OVERRIDE FOR THIS GENERATION:
- Output ONLY the "## ${sectionName}" section. No other sections.
- Your output MUST begin with the exact header "## ${sectionName}" — nothing before it.
- Use the formatting and rules defined above for that section.
- The rest of the existing world state is provided as context (do NOT include it in your output).${extra}`;

    return baseSystem + override;
}

// WORLD-STATE-03: Maximum character budget for the full world-state context
// fed into a section regeneration prompt. Same rationale as the refresh
// prompt's PREV_STATE_BUDGET.
const SECTION_CONTEXT_BUDGET = 30000;

/**
 * @param {string} sectionName — the section being regenerated.
 * @param {string} scanText — the scan window this generation is built from.
 *  Frozen by the caller before the first await so the initial attempt, the
 *  grounding retry, and the grounding gate all see the EXACT evidence the
 *  model was given — never a re-read window that messages arriving mid-await
 *  may have shifted (the frozen-evidence rule, same fix as the delta/full paths).
 */
function buildSectionUserMessage(sectionName, scanText) {
    const fullState = truncateText(getWorldStateText().trim() || 'None yet.', SECTION_CONTEXT_BUDGET);
    const recent = scanText || 'No recent messages.';
    return [
        '### Full Current World State (for context only — do not include in output)',
        fullState,
        '',
        '### Recent Chat Messages',
        recent,
        '',
        '='.repeat(60),
        `Output ONLY the regenerated "## ${sectionName}" section now.`,
        `Begin with the header "## ${sectionName}" — nothing before it.`,
    ].join('\n');
}

function validateSectionOutput(text, sectionName) {
    if (!text) return { ok: false, reason: 'empty response' };

    const escaped = escapeRegex(sectionName);
    const headerPattern = new RegExp(`^##\\s*${escaped}\\b`, 'm');
    if (!headerPattern.test(text)) {
        const preview = text.slice(0, 100).replace(/\n/g, ' ');
        return { ok: false, reason: `missing "## ${sectionName}" header. First 100 chars: "${preview}"` };
    }

    const rpMarkers = [
        { pattern: /\b(you see|you notice|you feel)\b/i, label: 'second-person narration' },
    ];
    for (const { pattern, label } of rpMarkers) {
        if (pattern.test(text)) return { ok: false, reason: `RP marker detected: ${label}` };
    }

    return { ok: true };
}

// ─── Section regeneration ────────────────────────────────────────────────────

export async function regenerateSection(sectionName, variety = 2) {
    if (!hasValidSettings()) {
        throw new Error('No API connection configured. Open ⚙ Settings in the World State panel.');
    }
    if (!SECTIONS.includes(sectionName)) {
        throw new Error(`Unknown section: ${sectionName}`);
    }
    if (state.wstIsRefreshing) {
        throw new Error('World State is already refreshing.');
    }

    // Part 6 (§7.4): the section-regen button reaches this API-spending choke
    // point without the event router's decline predicate. Refuse while the
    // store is paused — before reading the unprepared store or spending the
    // API call (the checked commit would refuse afterwards anyway).
    if (isStorePausedForCurrentScope(worldStateSchema.id)) {
        console.warn('[MWT:WorldState] Cannot regenerate section — the store is paused for this chat (schema preparation).');
        throw new Error('World State is paused for this chat — its data could not be safely prepared, so nothing was generated. Use Retry in the banner after repairing the data.');
    }

    // WORLD-STATE-01: Section regeneration had NO chat guard at all — a stale
    // section result from Chat A could overwrite Chat B's section after a
    // chat switch during the API call.
    const scopeBefore = captureScope();

    // WORLD-STATE-02: Capture the target SECTION's revision at start so we can
    // detect same-chat edits to that section during the API call.
    const sectionRevision = captureRevision(
        extractOnlySection(getWorldStateText(), sectionName) || ''
    );

    state.wstIsRefreshing = true;
    document.dispatchEvent(new CustomEvent('mwt:busy-changed'));

    try {
        const s = getSettings();
        const baseTemp = isNaN(Number(s.temperature)) ? 0.3 : Number(s.temperature);
        const tempBoost = { 1: 0, 2: 0.05, 3: 0.3, 4: 0.55, 5: 0.85 }[variety] || 0;
        const temperature = Math.min(1.4, baseTemp + tempBoost);

        const sectionSettings = { ...s, temperature };

        // Frozen-evidence rule (follow-up): freeze the scan window BEFORE the first
        // await. The generation prompt, the grounding retry, and the grounding
        // gate must all work from the exact same evidence — a re-read after
        // the API await could lose the oldest part of this window to messages
        // that arrived meanwhile, stripping names the model legitimately used.
        const scanWindowText = getRecentMessagesForScan();

        const _wsApi3 = resolveApiCall({ moduleSettings: sectionSettings });
        const raw = await _wsApi3.fetchFn({
            systemPrompt: buildSectionSystemPrompt(sectionName, variety),
            userContent: buildSectionUserMessage(sectionName, scanWindowText),
            settings: _wsApi3.settings,
            retries: 1,
        });

        const text = normaliseOutput(raw);
        const check = validateSectionOutput(text, sectionName);
        if (!check.ok) {
            throw new Error(`Section regen validation failed: ${check.reason}`);
        }

        // WORLD-STATE-01: Assert scope before any writes. A chat switch during
        // the API call must discard the result to prevent cross-chat
        // contamination — same guard as full refresh.
        const scopeResult = assertSameScope(scopeBefore);
        if (!scopeResult.ok) {
            console.warn(
                `[MWT:WorldState] Chat switched during section regeneration (${scopeResult.reason}) — ` +
                `discarding result to avoid cross-chat contamination.`
            );
            return null;
        }

        // WORLD-STATE-02: Verify the target section wasn't edited during the
        // API call. If the user changed this section while regen was in flight,
        // discard the result rather than clobbering their edit.
        const sectionNow = extractOnlySection(getWorldStateText(), sectionName) || '';
        if (!sameRevision(sectionRevision, sectionNow)) {
            console.warn(`[MWT:WorldState] Section "${sectionName}" was edited during regeneration — discarding result to preserve user changes.`);
            return null;
        }

        let cleaned = extractOnlySection(text, sectionName) || text.trim();

        // The grounding gate's `priorText` is the pre-operation document — it
        // answers "was this name already known before this regen?", so it must
        // NOT be re-read after the retry. The document used for the actual
        // WRITE is re-read separately below (see WORLD-STATE-02 note).
        const priorText = getWorldStateText();

        // Grounding gate only (§7) — expiry is a whole-document concern and
        // does not run on a single-section regen.
        // WORLD-STATE-04: Both retry and strict/soft policy mirror the full
        // refresh path so the two agree.
        if (s.groundingEnabled) {
            let grounding = groundingGate(cleaned, {
                scanText: scanWindowText,
                priorText,
                pinned: getPinnedEntities(s),
                mode: s.groundingMode,
            });
            if (!grounding.ok) {
                console.warn(`[MWT:WorldState] Grounding gate rejected section "${sectionName}": ${grounding.reason} — retrying once`);
                const _wsApiRetry = resolveApiCall({ moduleSettings: sectionSettings });
                const rawRetry = await _wsApiRetry.fetchFn({
                    systemPrompt: buildSectionSystemPrompt(sectionName, variety),
                    userContent: buildSectionUserMessage(sectionName, scanWindowText) + `\n\n[REMINDER: ${grounding.reason}. Output ONLY the section with grounded names.]`,
                    settings: _wsApiRetry.settings,
                    retries: 1,
                });
                const textRetry = normaliseOutput(rawRetry);
                const checkRetry = validateSectionOutput(textRetry, sectionName);
                if (!checkRetry.ok) throw new Error(`Section regen validation failed after grounding retry: ${checkRetry.reason}`);
                // WORLD-STATE-01/02: Re-assert scope AND section revision after
                // the grounding retry await. A chat switch or same-chat edit
                // during the retry must discard the result before any write.
                const scopeAfterRetry = assertSameScope(scopeBefore);
                if (!scopeAfterRetry.ok) {
                    console.warn(
                        `[MWT:WorldState] Chat switched during section grounding retry (${scopeAfterRetry.reason}) — ` +
                        `discarding result to avoid cross-chat contamination.`
                    );
                    return null;
                }
                const sectionAfterRetry = extractOnlySection(getWorldStateText(), sectionName) || '';
                if (!sameRevision(sectionRevision, sectionAfterRetry)) {
                    console.warn(`[MWT:WorldState] Section "${sectionName}" was edited during grounding retry — discarding result to preserve user changes.`);
                    return null;
                }
                cleaned = extractOnlySection(textRetry, sectionName) || textRetry.trim();
                grounding = groundingGate(cleaned, {
                    scanText: scanWindowText,
                    priorText,
                    pinned: getPinnedEntities(s),
                    mode: s.groundingMode,
                });
                if (!grounding.ok) {
                    // WORLD-STATE-04: Strict mode fails closed with a visible
                    // status. Soft mode strips and commits.
                    if (s.groundingMode === 'strict') {
                        console.warn(`[MWT:WorldState] Grounding gate still rejected section after retry (${grounding.reason}) — strict mode, discarding.`);
                        return null;
                    }
                    console.warn(`[MWT:WorldState] Grounding gate still rejected section after retry (${grounding.reason}) — soft mode, stripping.`);
                    grounding = groundingGate(cleaned, {
                        scanText: scanWindowText,
                        priorText,
                        pinned: getPinnedEntities(s),
                        mode: 'soft',
                    });
                }
            }
            for (const { label } of grounding.stripped) {
                console.warn(`[MWT:WorldState] Grounding gate stripped ungrounded name from "${sectionName}": "${label}"`);
            }
            cleaned = grounding.cleanedText;
        }

        // WORLD-STATE-02: Re-read the document immediately before the write.
        // The grounding-retry branch above contains an `await`, so a document
        // captured before it is stale by the time we get here — splicing the
        // new section into that stale copy would silently revert any edit the
        // user made to a DIFFERENT section during the retry. The revision guard
        // deliberately only protects the target section, so it cannot catch
        // this; re-reading is what makes the write surgical.
        const docNow = getWorldStateText();
        const updated = replaceSection(docNow, sectionName, cleaned);

        // Checked write (design §8): ONE commit carries BOTH the outgoing
        // document's history snapshot and the regenerated document. A refused
        // store write (unsafe current value, quarantine container refusing the
        // rejected records) must not apply injection/provenance or report
        // success — discard the generated text and return null so the caller
        // keeps the previous document, exactly like the guards above. (A blank
        // outgoing document skips the history snapshot, preserving the old
        // `if (docNow?.trim())` no-op.)
        //
        // Delta-status bookkeeping (TODO §3-F) rides the same patch, but a
        // section regen may stamp a fresh digest ONLY when the incoming
        // document was still reconciled (its digest matched the last
        // refresh's). When other sections carry manual edits,
        // buildPartialRefreshStatus keeps the OLD digest so the document keeps
        // reporting as manually edited — one model-reconciled section must not
        // clear that signal — while the kind and reconciliation cadence still
        // advance.
        //
        // The watermark deliberately does NOT advance (watermark-preservation
        // rule): this
        // run reconciled exactly ONE section from the sliding scan window, so
        // stamping the stable-history end here would let the next delta start
        // AFTER it and permanently skip messages that changed OTHER sections.
        // Re-stamping the previous watermark keeps the unseen interval
        // scannable; the next delta re-reads it cheaply (at worst answering
        // "### NO CHANGES" for this already-regenerated section), and a full
        // refresh or catch-up advances the watermark as usual.
        const prevStatus = getDeltaStatus();
        const written = commitHistorySnapshot(docNow, {
            text: updated,
            deltaStatus: buildPartialRefreshStatus(prevStatus, docNow, updated, prevStatus.lastRefreshAtMsg),
        });
        if (!written.ok) {
            console.warn(`[MWT:WorldState] Section "${sectionName}" regeneration refused at the store write (${written.reason ?? 'unknown reason'}) — the previous world state was kept.`);
            return null;
        }
        applyWorldStateInjection();
        try { setProvenance(buildProvenance()); } catch (err) {
            console.warn('[MWT:WorldState] Provenance build failed (non-fatal):', err.message);
        }

        console.log(`[MWT:WorldState] Section "${sectionName}" regenerated (variety ${variety}).`);
        return updated;
    } catch (err) {
        // Coordinator cancellation (TODO §1): the chat changed mid-regen and
        // the coordinator aborted the call, or the queued job was retired
        // before it started. The scope guard above would have discarded the
        // result anyway — discard quietly instead of surfacing an intentional
        // stop as a user-facing failure, matching refreshWorldState() /
        // refreshWorldStateDelta(). isCancellation() covers both the marked
        // JobCancelledError and the native AbortError of a mid-wire abort.
        if (isCancellation(err)) {
            console.log('[MWT:WorldState] Section regeneration cancelled (coordinator) — discarded.');
            return null;
        }
        throw err;
    } finally {
        state.wstIsRefreshing = false;
        document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
    }
}