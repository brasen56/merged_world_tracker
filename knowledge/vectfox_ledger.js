/** Explicit, deterministic ledger proposals. No generation and no scanner changes. */
import { validateKnowledgeList } from './field_contract.js';
import { appendLedgerLines, loadEntryContent } from './lorebook.js';
import { getRegistry, resolveRegistryKey } from './registry.js';
import {
    getVectFoxHistoryStatus, captureHistoryContext, assertHistoryContext, validateVectFoxHistory,
} from './vectfox_history.js';

const normalize = value => value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
const bases = ['witnessed', 'told', 'document', 'rumor', 'institutional_access', 'other'];
const statuses = ['fact', 'belief', 'rumor'];
// Same quote folding as VectFox's acquisition check (core/event-knowledge.js), so
// a quote VectFox accepted is not deferred here over curly vs straight quotes.
const quoteText = value => value.normalize('NFKC').replace(/[‘’‚‛]/gu, "'")
    .replace(/[“”„‟]/gu, '"').replace(/\s+/gu, ' ').trim();
// Older VectFox releases expose only the raw original. Never interpret an
// unknown representation version as evidence we understand.
const evidenceText = source => source?.evidence_narrative == null ? source?.message?.mes
    : source.evidence_narrative.version === 1 ? source.evidence_narrative.text : null;

/** The text ledger carries epistemic meaning and basis, not session handles.
 * Durable source receipts live separately in NPC registry metadata.
 * Overlong items are deferred whole, never clipped or promoted to facts.
 */
export function mapVectFoxAcquisitions(events, context, sources, content) {
    const items = [], records = [], deferred = [];
    const checks = new Map(sources.map(source => [source.ref, source]));
    const accepted = new Set();
    let inLedger = false;
    for (const line of content.split('\n')) {
        const text = line.trim();
        if (/^knowledge ledger:/i.test(text)) { inLedger = true; continue; }
        if (!inLedger || !text) continue;
        if (!text.startsWith('- ')) { inLedger = false; continue; }
        // The formatter appends attribution after the fact. Claims and
        // uncertainty may themselves contain " via ", so keep those intact.
        const entry = text.slice(2);
        const sourceAt = entry.lastIndexOf(' via ');
        accepted.add(normalize(sourceAt === -1 ? entry : entry.slice(0, sourceAt)));
    }
    const seen = new Set(accepted);
    const names = new Set([context.name, ...context.aliases].map(normalize));
    for (const event of events) {
        if (event.knowledge_status !== 'recorded' || event.knowledge?.v !== 1
            || !Array.isArray(event.knowledge.acquisitions)) continue;
        for (const acquisition of event.knowledge.acquisitions) {
            if (typeof acquisition?.character !== 'string' || !names.has(normalize(acquisition.character))) continue;
            // Require positive attribution: null also means an ambiguous alias,
            // not just an unknown name, and must never authorize an import.
            const owner = resolveRegistryKey(getRegistry(), acquisition.character);
            const evidence = acquisition.evidence;
            const valid = owner === context.name
                && typeof acquisition.claim === 'string' && acquisition.claim.trim()
                && bases.includes(acquisition.basis) && statuses.includes(acquisition.epistemic_status)
                && (acquisition.basis !== 'rumor' || acquisition.epistemic_status === 'rumor')
                && typeof acquisition.uncertainty === 'string'
                && Array.isArray(evidence) && evidence.length > 0 && evidence.length <= 16
                && evidence.every(e => Number.isInteger(e?.source_index) && e.source_index >= 0
                    && event.source_refs?.[e.source_index]?.ref === e.source_ref
                    && typeof e.quote === 'string' && e.quote.trim()
                    && checks.get(e.source_ref)?.status === 'verified'
                    && typeof evidenceText(checks.get(e.source_ref)) === 'string'
                    && quoteText(evidenceText(checks.get(e.source_ref))).includes(quoteText(e.quote)));
            if (!valid) { deferred.push({ event_ref: event.event_ref, reason: 'Invalid, ambiguous, or unverified acquisition' }); continue; }
            const claim = acquisition.claim.trim();
            const meaning = `[${acquisition.epistemic_status === 'belief' ? 'Claim heard; not established or necessarily believed' : acquisition.epistemic_status}] ${claim}`
                + (acquisition.uncertainty.trim() ? ` [Uncertainty: ${acquisition.uncertainty.trim()}]` : '');
            // Exact durable meaning dedupes across events without collapsing rumors
            // into facts. Plain legacy facts match only unqualified fact imports.
            const key = normalize(meaning);
            if (seen.has(key) || [...seen].some(value => value.startsWith(`${key} [vectfox evidence: `))
                || (acquisition.epistemic_status === 'fact' && !acquisition.uncertainty.trim() && accepted.has(normalize(claim)))) continue;
            const item = { fact: meaning,
                source: `VectFox (${acquisition.basis})` };
            const checked = validateKnowledgeList([item]);
            if (checked.rejected.length) { deferred.push({ event_ref: event.event_ref, reason: checked.rejected[0].reason }); continue; }
            if (items.length >= 30) { deferred.push({ event_ref: event.event_ref, reason: '30-item proposal limit' }); continue; }
            seen.add(key);
            items.push(item);
            records.push({ event_ref: event.event_ref, acquisition: structuredClone(acquisition),
                ledger_line: `- ${item.fact} via ${item.source}`,
                provenance: evidence.map(e => {
                    const source = checks.get(e.source_ref);
                    return { quote: e.quote, fingerprint: source.current_fingerprint ?? null,
                        source_chat_id: source.source_chat_id ?? event.source_chat_id ?? null,
                        leaf_identity: structuredClone(source.leaf_identity ?? null),
                        send_date: source.message?.send_date ?? null };
                }) });
        }
    }
    return { items, records, deferred };
}

export async function prepareVectFoxLedger(name, uid) {
    const connection = getVectFoxHistoryStatus();
    if (!connection.available || connection.status.capabilities?.knowledge_acquisition?.available !== true
        || connection.status.capabilities.knowledge_acquisition.schema_version !== 1) {
        throw new Error(`VectFox knowledge acquisition unavailable: ${connection.reason || 'unsupported capability/schema'}`);
    }
    const context = captureHistoryContext(name, uid);
    assertHistoryContext(context);
    const content = await loadEntryContent(uid, name);
    if (typeof content !== 'string') throw new Error('Cannot load the NPC ledger.');
    const token = connection.status.scope_token;
    const scope = { kind: 'current_chat' };
    const result = await connection.api.findEvents({ subjects: [{ name, aliases: context.aliases }], match: 'all',
        types: [], mode: 'history', history_selection: 'representative', scope, scope_token: token, limit: 500 });
    if (!result?.ok || result.scope_token !== token || !Array.isArray(result.events) || result.events.length > 500) {
        throw new Error(`VectFox ledger retrieval failed: ${result?.error?.message || 'invalid response or changed scope'}`);
    }
    const events = [], refs = [];
    for (const event of result.events) {
        if (event.knowledge_status !== 'recorded' || event.knowledge?.v !== 1) continue;
        if (!Array.isArray(event.source_refs) || refs.length + event.source_refs.length > 500) continue;
        events.push(event);
        refs.push(...event.source_refs);
    }
    const resolved = await connection.api.resolveSources({ scope_token: token, sources: refs });
    if (!resolved?.ok || resolved.scope_token !== token || resolved.sources?.length !== refs.length
        || resolved.sources.some((s, i) => s.ref !== refs[i].ref)) throw new Error('Invalid source resolution response.');
    const mapped = mapVectFoxAcquisitions(events, context, resolved.sources, content);
    const used = new Set(mapped.records.flatMap(record => record.acquisition.evidence.map(e => e.source_ref)));
    const history = { context, scope, scope_token: token, fields: [],
        events: mapped.records, sourceRefs: refs.filter(ref => used.has(ref.ref)),
        sourceChecks: resolved.sources.filter(source => used.has(source.ref)).map(source => ({ ref: source.ref,
            status: source.status, reason: source.reason ?? null, current_fingerprint: source.current_fingerprint ?? null })),
        coverage: result.coverage, selection: { candidates: result.events.length, selected: mapped.records.length,
            limited: mapped.deferred.length > 0 || events.length < result.events.length } };
    await validateVectFoxHistory(history);
    if (await loadEntryContent(uid, name) !== content) throw new Error('NPC ledger changed during import. Try again.');
    assertHistoryContext(context);
    return { ...mapped, currentContent: content, merged: appendLedgerLines(content.split('\n'), mapped.items).join('\n'),
        historyEvidence: history, historyRevision: content };
}