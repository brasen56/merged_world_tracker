/**
 * knowledge/auto_consolidation.js — Opt-in raw-backlog management for the
 * growth evidence store.
 *
 * Users routinely forget to press Consolidate, so raw observations pile up
 * (300+ in long-running chats is normal). When enabled, this driver runs the
 * SAME consolidation pipeline as the manual button — automatically, after any
 * capture completes, for every NPC that has piled up enough evidence no pass
 * has looked at yet.
 *
 * Consolidation is safe to automate in a way dossier rewrites are not: a pass
 * only moves the raw observations it actually distilled into archivedRaw
 * (nothing is deleted — Expand undoes it claim by claim), and it never touches
 * profiles or dossier lines. What it manages is the RAW TIER ONLY — the
 * consolidated and archived tiers keep growing unbounded, by design.
 *
 * The trigger counts UNSEEN evidence, never the whole raw tier. Uncited raws
 * stay raw ("stayers"), and a major NPC routinely carries hundreds of them.
 * If stayers counted, they alone would hold the trigger open: every capture
 * would fire a call, and a batch drawn from the oldest raws would re-send the
 * same stayers forever while new evidence waited behind them. So:
 *
 *   1. unseen count ≥ threshold (user setting, default 100). "Unseen" = a
 *      non-canon raw with a numeric id above meta.autoConsolidation.watermark
 *      that the user never restored via Expand (evidence.js isUnseenForAuto).
 *      Raw ids rise monotonically (the minter scans raw ∪ archivedRaw), and
 *      every pass that gets an answer — automatic or manual, any number of
 *      claims — advances the watermark over what it presented, so presented
 *      stayers can never re-arm the trigger. Only a manual pass (whole pool)
 *      shows them to the model again.
 *   2. after N consecutive failed/zero-yield automatic passes, ≥
 *      backoffRequired(N) observations captured since the last attempt
 *      (meta.autoConsolidation.attemptHighWater) — 20/40/80…, an
 *      evidence-denominated backoff mirroring Chronicle's message-denominated
 *      auto-snapshot retry gate. A thrown error leaves the watermark alone, so
 *      the backoff is what stops a failing batch from being retried on every
 *      capture.
 *
 * Batches present the LOWEST unseen ids first (≤150 per API call), and one
 * scan spends at most AUTO_CONSOLIDATION_MAX_CALLS_PER_SCAN calls across ALL
 * NPCs, round-robin, so enabling the feature on a chat with several big
 * backlogs costs a few calls per capture rather than a burst of dozens. The
 * manual button keeps presenting the whole pool in one call, exactly as
 * before.
 *
 * Overlap protection: runConsolidation holds a per-NPC in-flight guard
 * (growth.js), and maybeRunAutoConsolidation holds a single scan guard —
 * manual and automatic passes can never run concurrently over the same
 * evidence file.
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
import {
    getEvidenceMap,
    getEvidenceFile,
    obsSeq,
    isUnseenForAuto,
    rawSeqHighWater,
    readAutoConsolidationState,
    recordAutoConsolidationOutcome,
} from './evidence.js';
import { runConsolidation } from './growth.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Max raw observations presented to one consolidation API call (automatic
 *  passes only; manual passes present the whole pool). */
export const AUTO_CONSOLIDATION_BATCH_LIMIT = 150;

/** Max consolidation API calls one scan may spend, across ALL eligible NPCs
 *  (round-robin, biggest unseen backlog first). Whatever is left waits for
 *  the next capture's scan. */
export const AUTO_CONSOLIDATION_MAX_CALLS_PER_SCAN = 3;

/** Backoff curve: after N consecutive failed/zero-yield automatic passes, the
 *  NPC needs min(BASE × 2^(N−1), CAP) observations captured since the last
 *  attempt before another one. */
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
 * Observations captured since the last attempt required before another
 * automatic pass. 0 failures → 0 (no backoff: the unseen leg of the gate is
 * the whole requirement); each consecutive failure doubles the bar, capped.
 *
 * @param {number} failures — consecutive failed/zero-yield passes
 * @returns {number}
 */
export function backoffRequired(failures) {
    if (!Number.isFinite(failures) || failures <= 0) return 0;
    const n = Math.trunc(failures);
    return Math.min(AUTO_CONSOLIDATION_BACKOFF_BASE * 2 ** (n - 1), AUTO_CONSOLIDATION_BACKOFF_CAP);
}

/**
 * Evaluate every NPC's evidence file against the automatic-consolidation
 * gate. PURE — takes the evidence map, returns facts. The driver re-runs it
 * before every batch: applyConsolidation archives cited raws and advances the
 * watermark, so the unseen count moves underneath the drain loop.
 *
 * @param {Object<string, import('./evidence.js').EvidenceFile>} files — from getEvidenceMap()
 * @param {number} threshold — resolved trigger threshold
 * @returns {Array<{name:string, eligible:boolean, nonCanonRawCount:number, unseenCount:number, newSinceAttempt:number, failures:number}>}
 */
export function evaluateAutoConsolidation(files, threshold) {
    const results = [];
    for (const [name, file] of Object.entries(files || {})) {
        if (!file) continue;
        const nonCanon = (file.raw || []).filter(o => o && !o.canon);
        const { watermark, failures, attemptHighWater } = readAutoConsolidationState(file);
        let unseenCount = 0;
        let newSinceAttempt = 0;
        for (const o of nonCanon) {
            if (!isUnseenForAuto(o, watermark)) continue;
            unseenCount++;
            if (obsSeq(o.id) > attemptHighWater) newSinceAttempt++;
        }
        results.push({
            name,
            nonCanonRawCount: nonCanon.length,
            unseenCount,
            newSinceAttempt,
            failures,
            eligible: unseenCount >= threshold && newSinceAttempt >= backoffRequired(failures),
        });
    }
    return results;
}

// ─── Driver ──────────────────────────────────────────────────────────────────

/**
 * Check every NPC against the gate and spend up to
 * AUTO_CONSOLIDATION_MAX_CALLS_PER_SCAN bounded passes on the eligible ones.
 * Called after any capture completion — the only paths that grow raw[]: the
 * auto-capture cadence (knowledge/index.js) and the manual Capture / Backfill
 * / Catch Up buttons (render.js).
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
        // Biggest unseen backlog first, so a budget-limited scan spends its
        // calls where the backlog is worst.
        const candidates = evaluateAutoConsolidation(getEvidenceMap(), threshold)
            .filter(result => result.eligible)
            .sort((a, b) => b.unseenCount - a.unseenCount || a.name.localeCompare(b.name));
        if (candidates.length === 0) return null;

        // Start toast is debug-gated (same rule as auto-capture): firing one
        // every cycle is noise in normal roleplay; outcomes below always toast.
        if (settings.growthDebugToasts) {
            const { notify } = await import('../core/index.js');
            notify('Knowledge Tracker', `🌿 Auto-consolidating raw evidence for ${candidates.map(c => c.name).join(', ')}… (${reason})`, 'info');
        }

        const outcomes = new Map(candidates.map(c => [c.name, emptyOutcome(c.name)]));
        let queue = candidates.map(c => c.name);
        let calls = 0;
        let stopped = false;
        // Round-robin: one batch per NPC per round, so a single huge backlog
        // can't take the whole budget while three NPCs that each need one
        // call wait. An NPC leaves the queue once its gate closes, a pass
        // fails or finds nothing, or a manual pass for it is running.
        while (queue.length > 0 && calls < AUTO_CONSOLIDATION_MAX_CALLS_PER_SCAN && !stopped) {
            const nextRound = [];
            for (const name of queue) {
                if (calls >= AUTO_CONSOLIDATION_MAX_CALLS_PER_SCAN) break;
                const step = await runOneBatch(name, { threshold, scopeBefore });
                if (step.status === 'stopped') { stopped = true; break; }
                if (step.status === 'closed' || step.status === 'busy') continue;
                calls++;
                mergeStep(outcomes.get(name), step);
                if (step.status === 'ok') nextRound.push(name);
            }
            queue = nextRound;
        }
        const results = [...outcomes.values()];
        await reportOutcomes(results);
        return summarize(results);
    } finally {
        state.autoConsolidationScanInFlight = false;
    }
}

function emptyOutcome(name) {
    return { name, batches: 0, consolidatedCount: 0, archivedCount: 0, totalConsolidated: 0, error: null };
}

function mergeStep(outcome, step) {
    outcome.batches++;
    if (step.stats) {
        outcome.consolidatedCount += step.stats.consolidatedCount;
        outcome.archivedCount += step.stats.archivedCount;
        outcome.totalConsolidated = step.stats.totalConsolidated;
    }
    if (step.error) outcome.error = step.error;
}

/**
 * One bounded pass for one NPC, re-checking the gate against the CURRENT file
 * first (an earlier batch moved the watermark; a capture may have landed).
 *
 * Failure stamping follows the review contract: an API/parse error or a
 * zero-yield pass bumps `failures` so the backoff raises the next attempt's
 * bar. A zero-yield pass DID advance the watermark (the model saw the batch),
 * a thrown one did not (the batch is retried once the bar is met).
 * Coordinator cancellation and chat switches are quiet discards with no
 * stamp: nothing was wrong with the evidence, and the new chat has its own.
 *
 * @param {string} name — NPC name
 * @param {{threshold:number, scopeBefore:object}} ctx
 * @returns {Promise<{status:'ok'|'zero'|'error'|'closed'|'busy'|'stopped', stats?:object, error?:Error}>}
 */
async function runOneBatch(name, { threshold, scopeBefore }) {
    // The module can be paused between batches; continuing would spend the
    // API call only for the write seam to refuse the result.
    if (isModulePausedForCurrentScope('knowledge')) return { status: 'stopped' };
    const current = evaluateAutoConsolidation(getEvidenceMap(), threshold).find(result => result.name === name);
    if (!current?.eligible) return { status: 'closed' };
    // A manual pass for this NPC may have started between batches. Treat
    // that as handled, not failed: the backlog is being worked on.
    if (state.consolidationInFlight.has(name)) return { status: 'busy' };

    // Taken BEFORE the call: evidence captured while it is in flight counts
    // toward the next retry's bar.
    const attemptHighWater = rawSeqHighWater(getEvidenceFile(name, false));
    try {
        const stats = await runConsolidation(name, {
            limit: AUTO_CONSOLIDATION_BATCH_LIMIT, unseenOnly: true, trigger: 'auto',
        });
        if (stats.consolidatedCount === 0) {
            recordAutoConsolidationOutcome(name, { ok: false, attemptHighWater });
            return { status: 'zero', stats };
        }
        recordAutoConsolidationOutcome(name, { ok: true, attemptHighWater });
        return { status: 'ok', stats };
    } catch (err) {
        // Quietly discard work the coordinator or a chat switch stopped — no
        // failure stamp — and stop the whole scan: the scope the candidates
        // came from is gone.
        if (isCancellation(err) || !scopeStillCurrent(scopeBefore).ok) return { status: 'stopped' };
        recordAutoConsolidationOutcome(name, { ok: false, attemptHighWater });
        return { status: 'error', error: err };
    }
}

/**
 * Report through toasts, following the auto-capture conventions: failures
 * ALWAYS toast (a silently failing loop behind a quiet gate is exactly how
 * backlogs rot), successes toast their counts, and an open Growth window for
 * an affected NPC is refreshed when that is safe (render.js
 * refreshOpenGrowthModal) so the evidence counts it shows stay true.
 */
async function reportOutcomes(outcomes) {
    const attempted = outcomes.filter(o => o.batches > 0);
    if (attempted.length === 0) return;
    const { notify } = await import('../core/index.js');

    const failed = attempted.filter(o => o.error);
    if (failed.length > 0) {
        const detail = failed.map(o => `${o.name}: ${o.error.message}`).join('; ');
        notify('Knowledge Tracker', `🌿 Auto-consolidation failed for ${failed.length} NPC(s) — ${detail}. Will retry as more evidence accumulates.`, 'error');
    }

    const zeroYield = attempted.filter(o => !o.error && o.consolidatedCount === 0);
    if (zeroYield.length > 0) {
        const names = zeroYield.map(o => o.name).join(', ');
        notify('Knowledge Tracker', `🌿 Auto-consolidation found nothing to consolidate for ${names} — those observations stay raw (a manual Consolidate still includes them). The next automatic pass waits for more evidence.`, 'info');
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
        const message = `🌿 Auto-consolidation done for ${succeeded.length} NPC${npcWord}: +${claims} consolidated claim${claimWord}${totalNote}, ${archived} raw observation${archWord} archived.`;
        notify('Knowledge Tracker', message, 'success');
        try {
            const { refreshOpenGrowthModal } = await import('./render.js');
            for (const o of succeeded) {
                await refreshOpenGrowthModal(o.name, `Auto-consolidation: +${o.consolidatedCount} claim${o.consolidatedCount !== 1 ? 's' : ''}, ${o.archivedCount} raw observation${o.archivedCount !== 1 ? 's' : ''} archived.`);
            }
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
