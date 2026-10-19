/** Explicit, bounded VectFox scene capture. Never advances chronological cursors. */
import { stripNonNarrative } from '../core/index.js';
import { isModulePausedForCurrentScope } from '../core/schema_status.js';
import { hasValidSettings } from './settings.js';
import { getRegistry } from './registry.js';
import { getEvidenceFile, appendRawObservations } from './evidence.js';
import { captureEvidence } from './growth.js';
import { getVectFoxHistoryStatus, captureHistoryContext, assertHistoryContext } from './vectfox_history.js';

export const TARGETED_LIMITS = Object.freeze({ windows: 4, messages: 120, perWindow: 40,
    chars: 48000, perWindowChars: 16000, calls: 4 });
const plans = new WeakMap();
const running = new Set();

function connection() {
    if (isModulePausedForCurrentScope('knowledge')) throw new Error('Knowledge is paused for this chat.');
    if (!hasValidSettings()) throw new Error('No API connection configured.');
    const value = getVectFoxHistoryStatus();
    if (!value.available || value.status.capabilities?.candidate_windows?.available !== true
        || typeof value.api.findCandidateWindows !== 'function') {
        throw new Error(`VectFox Targeted Capture unavailable: ${value.reason || 'candidate-window API unsupported'}`);
    }
    return value;
}
function requireResult(result, token) {
    if (!result?.ok) throw new Error(`VectFox: ${result?.error?.code || 'invalid_response'}`);
    if (result.scope_token !== token) throw new Error('VectFox scope changed. Plan again.');
    return result;
}
function check(plan, signal) {
    if (signal?.aborted) throw new Error('Targeted capture cancelled. Uncommitted work remains retryable.');
    assertHistoryContext(plan.context);
    const current = connection();
    if (current.api !== plan.api || current.status.scope_token !== plan.token) throw new Error('VectFox scope changed. Plan again.');
}
function sourceRecord(source, context) {
    const id = source.leaf_identity;
    const identity = id?.id != null ? `id:${id.id}` : id?.mesid != null ? `mesid:${id.mesid}`
        : JSON.stringify(['fallback', source.expanded_index, source.message?.send_date, source.current_fingerprint]);
    return { chat: source.source_chat_id, npc: context.entityId || `name:${context.name}`,
        identity, fingerprint: source.current_fingerprint, processedAt: Date.now() };
}
function covered(record, coverage) {
    return coverage.some(old => old.chat === record.chat && old.npc === record.npc
        && old.identity === record.identity && old.fingerprint === record.fingerprint);
}

export async function planTargetedCapture(name, { signal } = {}) {
    const value = connection();
    const info = getRegistry()[name];
    if (info?.uid == null) throw new Error('NPC has no registered lorebook entry.');
    const plan = { api: value.api, token: value.status.scope_token,
        context: captureHistoryContext(name, info.uid), batches: [], skipped: 0, unavailable: 0, budgetOmitted: 0, chars: 0 };
    check(plan, signal);
    const result = requireResult(await plan.api.findCandidateWindows({ subjects: [{ name, aliases: plan.context.aliases }],
        scope: { kind: 'current_chat' }, scope_token: plan.token, max_windows: TARGETED_LIMITS.windows }), plan.token);
    check(plan, signal);
    const coverage = getEvidenceFile(name, false)?.meta?.targetedCoverage || [];
    const seen = new Set();
    let count = 0;
    for (const window of (result.windows || []).slice(0, TARGETED_LIMITS.windows)) {
        const refs = (window.source_refs || []).slice(0, TARGETED_LIMITS.perWindow);
        const resolved = requireResult(await plan.api.resolveSources({ scope_token: plan.token, sources: refs }), plan.token);
        check(plan, signal);
        if (!Array.isArray(resolved.sources) || resolved.sources.length !== refs.length) throw new Error('Invalid source response.');
        const sources = [], records = [], usedRefs = [], lines = [];
        let chars = 0;
        for (let index = 0; index < resolved.sources.length; index++) {
            const source = resolved.sources[index];
            if (source.ref !== (typeof refs[index] === 'string' ? refs[index] : refs[index].ref)) throw new Error('Mismatched source response.');
            if (source.status !== 'verified' || !source.message || source.message.is_system
                || !source.source_chat_id || !source.current_fingerprint) { plan.unavailable++; continue; }
            const record = sourceRecord(source, plan.context);
            const key = JSON.stringify([record.chat, record.npc, record.identity, record.fingerprint]);
            if (seen.has(key) || covered(record, coverage)) { plan.skipped++; continue; }
            seen.add(key);
            const text = stripNonNarrative(source.message.mes, { preserveOffScreen: false }).trim();
            const line = `[${sources.length}] ${source.message.name || 'Unknown'}: ${text}`;
            if (count >= TARGETED_LIMITS.messages || chars + line.length > TARGETED_LIMITS.perWindowChars
                || plan.chars + line.length > TARGETED_LIMITS.chars) { plan.budgetOmitted++; continue; }
            sources.push({ msg: structuredClone(source.message), promptIndex: sources.length,
                liveIndex: source.recovered_ils ? null : source.visible_index, identity: record.identity });
            records.push(record); usedRefs.push(refs[index]); lines.push(line);
            chars += line.length; plan.chars += line.length; count++;
        }
        if (sources.length) plan.batches.push({ sources, records, refs: usedRefs, text: lines.join('\n'),
            eventRefs: window.event_refs, windowRef: window.window_ref });
    }
    plan.coverage = result.coverage;
    const preview = { name, windows: plan.batches.length, messages: count, chars: plan.chars,
        maxCalls: plan.batches.length, skipped: plan.skipped, unavailable: plan.unavailable, budgetOmitted: plan.budgetOmitted,
        coverage: structuredClone(result.coverage), scenes: plan.batches.map(batch => ({
            windowRef: batch.windowRef, eventRefs: batch.eventRefs, messages: batch.sources.length })) };
    plans.set(preview, plan);
    return preview;
}

export async function runTargetedCapture(preview, { signal, onProgress } = {}) {
    const plan = plans.get(preview);
    if (!plan) throw new Error('Plan missing or already used. Preview again.');
    check(plan, signal);
    const name = plan.context.name;
    if (running.size) throw new Error('Another targeted capture is running.');
    running.add(name); plans.delete(preview);
    const totals = { added: 0, skipped: 0, verified: 0, calls: 0, messages: 0, inputChars: 0,
        tokenUsage: null, tokenUsageReason: 'The capture provider returns text only; exact token usage is unavailable.' };
    try {
        for (const batch of plan.batches) {
            check(plan, signal);
            const coverage = getEvidenceFile(name, false)?.meta?.targetedCoverage || [];
            const pending = batch.records.map((record, index) => covered(record, coverage) ? -1 : index).filter(index => index >= 0);
            if (!pending.length) continue;
            if (pending.length !== batch.records.length) {
                batch.sources = pending.map((index, promptIndex) => ({ ...batch.sources[index], promptIndex }));
                batch.refs = pending.map(index => batch.refs[index]);
                batch.records = pending.map(index => batch.records[index]);
                batch.text = batch.sources.map((source, index) => `[${index}] ${source.msg.name || 'Unknown'}: ${stripNonNarrative(source.msg.mes, { preserveOffScreen: false }).trim()}`).join('\n');
            }
            const observations = await captureEvidence(name, plan.context.uid, batch, { retries: 0, signal, contextLimit: 2000 });
            totals.calls++; totals.inputChars += batch.text.length;
            check(plan, signal);
            const current = requireResult(await plan.api.resolveSources({ scope_token: plan.token, sources: batch.refs }), plan.token);
            check(plan, signal);
            if (current.sources?.length !== batch.records.length || current.sources.some((source, index) =>
                source.status !== 'verified' || source.current_fingerprint !== batch.records[index].fingerprint
                || JSON.stringify(source.message) !== JSON.stringify(batch.sources[index].msg))) {
                throw new Error('Original source changed during capture. Uncommitted work remains retryable.');
            }
            const stats = appendRawObservations(name, observations, null, null, batch.records);
            totals.added += stats.added; totals.skipped += stats.skipped;
            totals.verified += observations.filter(o => o.verified).length;
            totals.messages += batch.sources.length;
            onProgress?.({ ...totals });
        }
        return totals;
    } finally { running.delete(name); }
}