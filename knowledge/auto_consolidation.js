/**
 * knowledge/auto_consolidation.js — Opt-in raw-backlog management for the
 * growth evidence store.
 *
 * Users routinely forget to press Consolidate, so raw observations pile up
 * (300+ in long-running chats is normal). When enabled, this driver runs the
 * SAME consolidation pipeline as the manual button — automatically, after any
 * capture completes, for every NPC whose raw backlog has crossed a
 * user-chosen threshold.
 *
 * Consolidation is safe to automate in a way dossier rewrites are not: a pass
 * only moves the raw observations it actually distilled into archivedRaw
 * (nothing is deleted — Expand undoes it claim by claim), and it never touches
 * profiles or dossier lines. What it manages is the RAW TIER ONLY — the
 * consolidated and archived tiers keep growing unbounded, by design.
 *
 * The trigger is NOT a bare `rawCount >= threshold` check. Uncited raws stay
 * raw, so a low-yield or failed pass leaves the count above the threshold —
 * a naive check would re-fire the same request forever. A pass only becomes
 * eligible again when evidence the previous pass never SAW has arrived:
 *
 *   1. non-canon raw count ≥ threshold (user setting, default 100)
 *   2. raw ids above meta.autoConsolidation.watermark — raw ids rise
 *      monotonically (obsIdSequence scans raw ∪ archivedRaw), so the
 *      watermark is an exact "seen by a pass" marker that uncited stayers
 *      cannot inflate. ≥ backoffRequired(failures) new ids are required:
 *      1 after a success, 20/40/80… after consecutive failures — an
 *      evidence-denominated backoff (a retry means "enough has changed to
 *      be worth another pass"), mirroring Chronicle's message-denominated
 *      auto-snapshot retry gate.
 *
 * Overlap protection: runConsolidation holds a per-NPC in-flight guard
 * (growth.js), and maybeRunAutoConsolidation holds a single scan guard —
 * manual and automatic passes can never run concurrently over the same
 * evidence file.
 *
 * Large backlogs drain in bounded batches (≤150 oldest raws per API call,
 * ≤3 batches per NPC per scan), so enabling the feature on a chat with
 * hundreds of raw observations spends model calls the way a manual pass
 * would — just split. The manual button keeps presenting the whole pool in
 * one call, exactly as before.
 */

import { captureScope, isCancellation } from '../core/index.js';
// scopeStillCurrent (not the barrel's strict assertSameScope): the same rule
// growth.js applies — on hosts with an UNKNOWN chat identity, strict identity
// equality would misclassify every error as a chat switch. The epoch check is
// authoritative; identity additionally when the scope identified the chat.
import { scopeStillCurrent } from '../core/scope.js';
// Direct import (not the barrel) so the REAL pause singleton is read even
// under the test barrel→stub alias — the same rule growth.js applies.
import { isModulePausedForCurrentScope } from '../core/schema_status.js';
import { getSettings } from './settings.js';
import { state } from './state.js';
import { getEvidenceMap, obsSeq, readAutoConsolidationState, recordAutoConsolidationOutcome } from './evidence.js';
import { runConsolidation } from './growth.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Max raw observations presented to one consolidation API call (automatic
 *  passes only; manual passes present the whole pool). */
export const AUTO_CONSOLIDATION_BATCH_LIMIT = 150;

/** Max batches per NPC per scan — the drain loop's ceiling. One scan presents
 *  at most 3 × 150 raw observations per NPC. */
export const AUTO_CONSOLIDATION_MAX_BATCHES = 3;

/** Backoff curve: after N consecutive failed/zero-yield automatic passes, the
 *  NPC needs min(BASE × 2^(N−1), CAP) NEW observations above the watermark
 *  before another attempt. */
export const AUTO_CONSOLIDATION_BACKOFF_BASE = 20;
export const AUTO_CONSOLIDATION_BACKOFF_CAP = 80;

/** Bounds for the user's trigger threshold (clamped on save and on read). */
export const AUTO_CONSOLIDATION_MIN_THRESHOLD = 10;
export const AUTO_CONSOLIDATION_MAX_THRESHOLD = 1000;
const DEFAULT_THRESHOLD = 100;

/** Resolve the trigger threshold from (possibly hand-edited) settings. */
export function resolveThreshold(settings) {
    const raw = Number(settings?.growthAutoConsolidationThreshold);
    if (!Number.isFinite(raw)) return DEFAULT_THRESHOLD;
    return Math.min(AUTO_CONSOLIDATION_MAX_THRESHOLD, Math.max(AUTO_CONSOLIDATION_MIN_THRESHOLD, Math.trunc(raw)));
}

/**
 * New observations (above the watermark) required before another automatic
 * pass. 0 failures → 1 (any genuinely-new evidence re-arms the trigger);
 * each consecutive failure doubles the requirement, capped.
 *
 * @param {number} failures — consecutive failed/zero-yield passes
 * @returns {number}
 */
export function backoffRequired(failures) {
    if (!Number.isFinite(failures) || failures <= 0) return 1;
    const n = Math.trunc(failures);
    return Math.min(AUTO_CONSOLIDATION_BACKOFF_BASE * 2 ** (n - 1), AUTO_CONSOLIDATION_BACKOFF_CAP);
}

/**
 * Evaluate every NPC's evidence file against the automatic-consolidation
 * gate. PURE — takes the evidence map, returns facts. The driver re-runs it
 * after every batch: applyConsolidation archives cited raws and advances the
 * watermark, so both gate legs move underneath the drain loop.
 *
 * @param {Object<string, import('./evidence.js').EvidenceFile>} files — from getEvidenceMap()
 * @param {number} threshold — resolved trigger threshold
 * @returns {Array<{name:string, eligible:boolean, nonCanonRawCount:number, newSinceWatermark:number, failures:number}>}
 */
export function evaluateAutoConsolidation(files, threshold) {
    const results = [];
    for (const [name, file] of Object.entries(files || {})) {
        if (!file) continue;
        const nonCanon = (file.raw || []).filter(o => o && !o.canon);
        const { watermark, failures } = readAutoConsolidationState(file);
        // Ids without a numeric suffix cannot be ordered against the
        // watermark; count them as NOT new so they can never arm the trigger.
        let newSinceWatermark = 0;
        for (const o of nonCanon) {
            const seq = obsSeq(o.id);
            if (seq != null && seq > watermark) newSinceWatermark++;
        }
        results.push({
            name,
            nonCanonRawCount: nonCanon.length,
            newSinceWatermark,
            failures,
            eligible: nonCanon.length >= threshold && newSinceWatermark >= backoffRequired(failures),
        });
    }
    return results;
}

// ─── Driver ──────────────────────────────────────────────────────────────────

/**
 * Check every NPC against the gate and run bounded drain passes for the
 * eligible ones. Called after any capture completion — the only paths that
 * grow raw[]: the auto-capture cadence (knowledge/index.js) and the manual
 * Capture / Backfill / Catch Up buttons (render.js).
 *
 * Cheap when idle: the gate reads chat metadata only; no API call happens
 * unless an NPC is genuinely eligible.
 *
 * @param {string} [reason] — trigger seam, for the debug start toast
 * @returns {Promise<{npcs:string[], consolidatedCount:number, archivedCount:number}|null>}
 *   Aggregate of what landed, or null when disabled / idle / already scanning.
 */
export async function maybeRunAutoConsolidation(reason = 'manual') {
    const settings = getSettings();
    if (!settings.growthAutoConsolidationEnabled) return null;
    // One scan at a time: several seams can fire in quick succession (the
    // auto-capture cadence completing while a Catch Up finishes).
    if (state.autoConsolidationScanInFlight) return null;
    const threshold = resolveThreshold(settings);

    const scopeBefore = captureScope();
    state.autoConsolidationScanInFlight = true;
    try {
        const candidates = evaluateAutoConsolidation(getEvidenceMap(), threshold)
            .filter(result => result.eligible);
        if (candidates.length === 0) return null;

        // Start toast is debug-gated (same rule as auto-capture): firing one
        // every cycle is noise in normal roleplay; outcomes below always toast.
        if (settings.growthDebugToasts) {
            const { notify } = await import('../core/index.js');
            notify('Knowledge Tracker', `🌿 Auto-consolidating raw evidence for ${candidates.map(c => c.name).join(', ')}… (${reason})`, 'info');
        }

        const outcomes = [];
        for (const candidate of candidates) {
            const outcome = await drainNpcBacklog(candidate.name, { threshold, scopeBefore });
            outcomes.push(outcome);
            if (outcome.stopped) break; // scope gone or module paused — drop the rest
        }
        await reportOutcomes(outcomes);
        return summarize(outcomes);
    } finally {
        state.autoConsolidationScanInFlight = false;
    }
}

/**
 * Bounded drain loop for one NPC: batch after batch until the gate closes
 * (below threshold, or no unseen evidence left) or the batch cap is hit.
 *
 * Failure stamping follows the review contract: an API error or a zero-yield
 * pass (nothing admissible) bumps `failures` so the backoff raises the next
 * attempt's bar — the watermark is NOT advanced, so the same pool is retried
 * once enough new evidence accumulates. Coordinator cancellation and chat
 * switches are quiet discards with no stamp: nothing was wrong with the
 * evidence, and the new chat has its own.
 *
 * @param {string} name — NPC name
 * @param {{threshold:number, scopeBefore:object}} ctx
 * @returns {Promise<{name:string, attempted:boolean, stopped:boolean, batches:number,
 *   consolidatedCount:number, archivedCount:number, error:Error|null}>}
 */
async function drainNpcBacklog(name, { threshold, scopeBefore }) {
    let batches = 0;
    let consolidatedCount = 0;
    let archivedCount = 0;
    let totalConsolidated = 0;
    let error = null;

    while (batches < AUTO_CONSOLIDATION_MAX_BATCHES) {
        // The module can be paused between batches; continuing would spend
        // the API call only for the write seam to refuse the result.
        if (isModulePausedForCurrentScope('knowledge')) {
            return { name, attempted: batches > 0, stopped: true, batches, consolidatedCount, archivedCount, error: null };
        }
        // Re-evaluate the gate against the CURRENT file — the previous batch
        // archived cited raws and advanced the watermark.
        const current = evaluateAutoConsolidation(getEvidenceMap(), threshold)
            .find(result => result.name === name);
        if (!current?.eligible) break;
        // A manual pass for this NPC may have started between batches. Treat
        // that as handled, not failed: the backlog is being worked on.
        if (state.consolidationInFlight.has(name)) {
            return { name, attempted: batches > 0, stopped: false, batches, consolidatedCount, archivedCount, error: null };
        }

        try {
            const stats = await runConsolidation(name, { limit: AUTO_CONSOLIDATION_BATCH_LIMIT, trigger: 'auto' });
            batches++;
            consolidatedCount += stats.consolidatedCount;
            archivedCount += stats.archivedCount;
            totalConsolidated = stats.totalConsolidated;
            if (stats.consolidatedCount === 0) {
                // Zero useful claims = failure for backoff purposes: the
                // watermark did not advance, so without a rising bar the
                // next trigger would re-present the exact same pool.
                recordAutoConsolidationOutcome(name, { ok: false });
                break;
            }
            recordAutoConsolidationOutcome(name, { ok: true });
        } catch (err) {
            // Quietly discard work the coordinator or a chat switch stopped —
            // no failure stamp (nothing was wrong with the evidence) — and
            // stop the whole scan: the scope the candidates came from is gone.
            if (isCancellation(err) || !scopeStillCurrent(scopeBefore).ok) {
                return { name, attempted: batches > 0, stopped: true, batches, consolidatedCount, archivedCount, error: null };
            }
            recordAutoConsolidationOutcome(name, { ok: false });
            error = err;
            break;
        }
    }
    return { name, attempted: batches > 0 || error != null, stopped: false, batches, consolidatedCount, archivedCount, totalConsolidated, error };
}

/**
 * Report through toasts, following the auto-capture conventions: failures
 * ALWAYS toast (a silently failing loop behind a quiet gate is exactly how
 * backlogs rot), successes toast their counts, and an open Growth window for
 * an affected NPC is refreshed so the evidence counts it shows stay true.
 */
async function reportOutcomes(outcomes) {
    const attempted = outcomes.filter(o => o.attempted);
    if (attempted.length === 0) return;
    const { notify } = await import('../core/index.js');

    const failed = attempted.filter(o => o.error);
    if (failed.length > 0) {
        const detail = failed.map(o => `${o.name}: ${o.error.message}`).join('; ');
        notify('Knowledge Tracker', `🌿 Auto-consolidation failed for ${failed.length} NPC(s) — ${detail}. Will retry as more evidence accumulates.`, 'error');
    }

    const zeroYield = attempted.filter(o => !o.error && o.batches > 0 && o.consolidatedCount === 0);
    if (zeroYield.length > 0) {
        const names = zeroYield.map(o => o.name).join(', ');
        notify('Knowledge Tracker', `🌿 Auto-consolidation found no new claims for ${names} — their observations stay raw; it will retry once more evidence accumulates.`, 'info');
    }

    const succeeded = attempted.filter(o => o.consolidatedCount > 0);
    if (succeeded.length > 0) {
        const claims = succeeded.reduce((sum, o) => sum + o.consolidatedCount, 0);
        const archived = succeeded.reduce((sum, o) => sum + o.archivedCount, 0);
        const npcWord = succeeded.length !== 1 ? 's' : '';
        const claimWord = claims !== 1 ? 's' : '';
        const archWord = archived !== 1 ? 's' : '';
        const totalNote = succeeded.length === 1 && succeeded[0].totalConsolidated > claims
            ? ` (${succeeded[0].totalConsolidated} total)` : '';
        notify('Knowledge Tracker', `🌿 Auto-consolidation done for ${succeeded.length} NPC${npcWord}: +${claims} consolidated claim${claimWord}${totalNote}, ${archived} raw observation${archWord} archived.`, 'success');
        try {
            const { refreshOpenGrowthModal } = await import('./render.js');
            for (const o of succeeded) await refreshOpenGrowthModal(o.name);
        } catch { /* render is UI sugar; never fail the scan over it */ }
    }
}

function summarize(outcomes) {
    const succeeded = outcomes.filter(o => o.consolidatedCount > 0);
    return {
        npcs: succeeded.map(o => o.name),
        consolidatedCount: succeeded.reduce((sum, o) => sum + o.consolidatedCount, 0),
        archivedCount: succeeded.reduce((sum, o) => sum + o.archivedCount, 0),
    };
}
