/**
 * World State-owned synchronization boundary for Chronicle scene anchors.
 *
 * Chronicle may describe a candidate and the accepted Chronicle ranges, but it
 * never writes World State metadata. Eligibility, revision checks, document
 * patching, atomic status/history persistence, and post-commit side effects all
 * live here.
 */

import {
    assertSameScope,
    normalizeSceneAnchor,
    parseCurrentScene,
    patchCurrentScene,
    sameRevision,
    validateWorldStateDocument,
} from '../core/index.js';
import { isStorePausedForCurrentScope } from '../core/schema_status.js';
import {
    state, getWorldStateText, commitHistorySnapshot, setProvenance,
} from './data.js';
import { worldStateSchema } from './schema.js';
import { applyWorldStateInjection } from './injection.js';
import { buildProvenance } from './provenance.js';
import { digestText, getDeltaStatus } from './delta.js';

let pendingCandidate = null;

function result(status, details = {}) {
    return { status, applied: status === 'applied', ...details };
}

function normalizeRange(range) {
    const from = Number(range?.from);
    const to = Number(range?.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) return null;
    return { from, to };
}

function compareRanges(a, b) {
    return a.to - b.to || a.from - b.from;
}

function newestAcceptedSource(sources) {
    return (Array.isArray(sources) ? sources : [])
        .map(item => ({ id: item?.id, range: normalizeRange(item?.range) }))
        .filter(item => item.id != null && item.range)
        .sort((a, b) => compareRanges(a.range, b.range))
        .at(-1) || null;
}

function statusSignature(status) {
    return JSON.stringify({
        lastRefreshKind: status.lastRefreshKind,
        lastRefreshAtMsg: status.lastRefreshAtMsg,
        lastRefreshAt: status.lastRefreshAt,
        deltasSinceFull: status.deltasSinceFull,
        lastRefreshDigest: status.lastRefreshDigest,
    });
}

/** Capture World State operation state before Chronicle begins async work. */
export function captureSceneAnchorBaseline() {
    return statusSignature(getDeltaStatus());
}

function sameCandidateScope(a, b) {
    return a?.scope?.epoch === b?.scope?.epoch
        && a?.scope?.identity?.key === b?.scope?.identity?.key;
}

function queueCandidate(candidate) {
    const queued = {
        ...candidate,
        queuedStatusSignature: captureSceneAnchorBaseline(),
        queuedTextDigest: digestText(getWorldStateText()),
    };
    if (!pendingCandidate || !sameCandidateScope(pendingCandidate, candidate)) {
        pendingCandidate = queued;
    } else {
        const oldRange = normalizeRange(pendingCandidate.sourceRange);
        const newRange = normalizeRange(candidate.sourceRange);
        if (!oldRange || (newRange && compareRanges(newRange, oldRange) >= 0)) pendingCandidate = queued;
    }
    return result('deferred', { sourceId: candidate.sourceId });
}

function errorKeys(validation) {
    return new Set((validation?.errors || []).map(entry => JSON.stringify([entry.code, entry.message])));
}

function isCurrentSceneIssue(entry) {
    return entry?.section === 'Current Scene' || entry?.code === 'missing-current-scene';
}

function syncOpenEditor(text) {
    const editor = state.modal?.querySelector?.('#ws-editor');
    if (editor) editor.value = text;
}

function sourceEligible(candidate, sourceRange) {
    const acceptedSources = typeof candidate.getAcceptedSources === 'function'
        ? candidate.getAcceptedSources()
        : candidate.acceptedSources;
    const newest = newestAcceptedSource(acceptedSources);
    if (!newest || String(newest.id) !== String(candidate.sourceId)
        || compareRanges(newest.range, sourceRange) !== 0) {
        return result('stale-source', { reason: 'not-newest-accepted-range' });
    }

    if (candidate.source === 'consolidation') {
        const previousNewest = normalizeRange(candidate.previousNewestRange);
        if (!previousNewest
            || sourceRange.from > previousNewest.from
            || sourceRange.to < previousNewest.to) {
            return result('stale-source', { reason: 'consolidation-does-not-include-previous-newest' });
        }
    }
    return null;
}

/**
 * Apply (or defer) one trusted Chronicle scene-anchor candidate.
 *
 * `sourceRange` is inclusive (`from`/`to` chat-array indexes). `acceptedSources`
 * is the Chronicle list after its own successful commit, allowing this owner to
 * independently verify that the candidate is still the newest accepted range.
 */
export function updateSceneAnchor(candidate = {}) {
    if (isStorePausedForCurrentScope(worldStateSchema.id)) return result('store-refused', { reason: 'store-paused' });
    if (!candidate.scope || !assertSameScope(candidate.scope).ok) return result('stale-source', { reason: 'scope-changed' });

    const sourceRange = normalizeRange(candidate.sourceRange);
    if (!sourceRange) return result('stale-source', { reason: 'untrustworthy-range' });
    const ineligible = sourceEligible(candidate, sourceRange);
    if (ineligible) return ineligible;

    if (state.wstIsRefreshing) return queueCandidate(candidate);

    // Input is durable only after the debounce writes it to metadata. A
    // Chronicle commit in that window would patch the old text, leave the live
    // textarea stale, and let the pending callback overwrite the anchor.
    if (state.isDirty || state.editorPersistTimer) return result('user-edited');

    const currentText = getWorldStateText();
    const status = getDeltaStatus();
    // lastRefreshAtMsg is an exclusive history end, while sourceRange.to is an
    // inclusive index. A source ending before that boundary is already covered.
    if (sourceRange.to < status.lastRefreshAtMsg) {
        return result('stale-source', { reason: 'older-than-world-state-evidence' });
    }
    if (!sameRevision(candidate.expectedRevision, currentText)) {
        if (candidate.baselineStatusSignature
            && candidate.baselineStatusSignature !== statusSignature(status)) {
            // A deferred Chronicle candidate was captured while World State
            // owned the document. Once the exclusive evidence watermark above
            // proves its inclusive range is not covered, a completed refresh
            // is safe to patch rather than a reason to discard newer evidence.
            // Non-deferred preview results still fail closed on any intervening
            // World State operation.
            if (!candidate.wasDeferred) return result('busy-superseded');
        }
        if (!candidate.wasDeferred) return result('user-edited');
        // An unchanged operation signature means this was an intervening manual
        // edit. A changed signature with an uncovered range is the completed
        // World State operation that the watermark check already approved.
        if (statusSignature(status) === candidate.queuedStatusSignature) return result('user-edited');
        // A completed refresh stamps the exact text it wrote. It must differ
        // from the queued document and still describe the live document; if it
        // does not, a persisted manual edit landed after the refresh and must
        // always win over this deferred Chronicle candidate.
        if (!status.lastRefreshDigest
            || status.lastRefreshDigest === candidate.queuedTextDigest
            || digestText(currentText) !== status.lastRefreshDigest) {
            return result('user-edited');
        }
    }

    const scene = parseCurrentScene(currentText);
    if (!scene.section || scene.issues.some(entry => entry.severity === 'error' && isCurrentSceneIssue(entry))) {
        return result('store-refused', { reason: 'invalid-current-scene', issues: scene.issues });
    }
    const anchor = normalizeSceneAnchor({
        dateTime: candidate.dateTime,
        location: candidate.location,
        current: scene.raw,
    });
    if (!anchor.ok) return result('no-change', { warnings: anchor.warnings });

    let nextText;
    try {
        nextText = patchCurrentScene(currentText, anchor.patch);
    } catch (error) {
        return result('store-refused', { reason: 'scene-patch-failed', message: error.message });
    }
    if (nextText === currentText) return result('no-change', { warnings: anchor.warnings });

    const currentValidation = validateWorldStateDocument(currentText, { mode: 'structural' });
    const validation = validateWorldStateDocument(nextText, { mode: 'structural' });
    const currentErrors = errorKeys(currentValidation);
    const introducedErrors = validation.errors.filter(entry => !currentErrors.has(JSON.stringify([entry.code, entry.message])));
    const sceneErrors = validation.errors.filter(isCurrentSceneIssue);
    if (introducedErrors.length || sceneErrors.length) {
        return result('store-refused', {
            reason: 'structural-validation', issues: [...introducedErrors, ...sceneErrors],
        });
    }

    // Chronicle changes only Current Scene. Advance the digest only when the
    // current document still matches the refresh baseline; otherwise this
    // partial update must retain the manual-edit signal. Refresh kind,
    // watermark, and reconciliation cadence stay untouched either way.
    const wasReconciled = !!status.lastRefreshDigest
        && digestText(currentText) === status.lastRefreshDigest;
    const written = commitHistorySnapshot(currentText, {
        text: nextText,
        ...(wasReconciled
            ? { deltaStatus: { ...status, lastRefreshDigest: digestText(nextText) } }
            : {}),
    });
    if (!written.ok) return result('store-refused', { reason: written.reason });

    state.autoSaveLastText = nextText;
    state.isDirty = false;
    syncOpenEditor(nextText);
    applyWorldStateInjection();
    try { setProvenance(buildProvenance()); } catch (error) {
        console.warn('[MWT:WorldState] Provenance build after Chronicle sync failed (non-fatal):', error.message);
    }
    return result('applied', { text: nextText, warnings: anchor.warnings });
}

/** Re-evaluate the newest queued candidate after a World State operation. */
export function settleSceneAnchorSync() {
    if (state.wstIsRefreshing || !pendingCandidate) return null;
    const candidate = pendingCandidate;
    pendingCandidate = null;
    const outcome = updateSceneAnchor({ ...candidate, wasDeferred: true });
    console.log(`[MWT:WorldState] Deferred Chronicle scene sync settled: ${outcome.status}.`);
    return outcome;
}

/** Drop a candidate captured for the previous chat. */
export function resetSceneAnchorSync() {
    pendingCandidate = null;
}
