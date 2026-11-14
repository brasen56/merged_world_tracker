/** Pure, read-time story chronology. Never mutates evidence or exposes clock time. */
export const GROWTH_TIMELINE_DEFAULTS = Object.freeze({ sampleK: 3, sampleBudget: 8000,
    minTimestamps: 3, maxTimestampShare: 0.25 });

const compareId = (a, b) => String(a.id).localeCompare(String(b.id), 'en');
const phaseAt = position => position < 34 ? 'early' : position <= 66 ? 'middle' : 'late';

/**
 * Saved provenance bypasses only the legacy heuristic, not verification/validity.
 * `cited` (an unmatched quote's model-cited message date) is unknown on its own,
 * so it stays unknown even if `verified` ever changes.
 */
export function isPositionUnknown(observation) {
    const { ts, capturedAt, tsSource, verified } = observation;
    if (verified === false || !Number.isFinite(ts) || ts === 0 || tsSource === 'capture' || tsSource === 'cited') return true;
    if (tsSource === 'message') return false;
    return Number.isFinite(capturedAt) && capturedAt - ts >= 0 && capturedAt - ts < 50;
}

function compareObservations(a, b) {
    const time = a.ts - b.ts;
    if (time) return time;
    // Cosmetic only: tied messages always receive the same position.
    if (Number.isFinite(a.msgIdx) && Number.isFinite(b.msgIdx) && a.msgIdx !== b.msgIdx) return a.msgIdx - b.msgIdx;
    return compareId(a, b);
}

/** One domain for raw plus ONLY archive reached through surviving claims. */
function timelineDomain(file, options) {
    const byId = new Map();
    const archived = new Map((file?.archivedRaw || []).map(o => [o.id, o]));
    for (const o of file?.raw || []) if (!byId.has(o.id)) byId.set(o.id, o);
    for (const claim of file?.consolidated || []) {
        for (const id of claim.sources || []) if (!byId.has(id) && archived.has(id)) byId.set(id, archived.get(id));
    }
    const dated = [...byId.values()].filter(o => !isPositionUnknown(o));
    const counts = new Map();
    for (const o of dated) counts.set(o.ts, (counts.get(o.ts) || 0) + 1);
    const timestamps = [...counts.keys()].sort((a, b) => a - b);
    const orderUnknown = timestamps.length < options.minTimestamps
        || [...counts.values()].some(count => count / dated.length > options.maxTimestampShare);
    const positions = new Map(timestamps.map((ts, index) => [ts, 100 * index / (timestamps.length - 1)]));
    const annotate = o => {
        const unknown = orderUnknown || isPositionUnknown(o);
        const position = unknown ? null : positions.get(o.ts);
        return { position, phase: unknown ? null : phaseAt(position), orderUnknown: unknown };
    };
    return { byId, annotate, orderUnknown };
}

function messageSources(sources) {
    const messages = new Map();
    // Pick the lowest observation id from each distinct source message.
    for (const o of [...sources].sort(compareId)) {
        const key = o.msgKey || `ts:${o.ts}`;
        if (!messages.has(key)) messages.set(key, o);
    }
    return [...messages.values()].sort(compareObservations);
}

function selectSamples(messages, k) {
    return messages.length <= 2 * k ? messages : [...messages.slice(0, k), ...messages.slice(-k)];
}

/** Dated messages keep both ends of the story; undated ones follow, capped, so they never take the latest slots. */
function pickSamples({ dated, undated }, k, sample) {
    const shown = selectSamples(dated, k);
    const extra = undated.slice(0, k);
    return { samples: [...shown, ...extra].map(sample), omittedMessages: dated.length - shown.length,
        omittedUndated: undated.length - extra.length };
}

/**
 * Spend the sample budget on the widest claims first — a change hidden inside
 * a claim can only show where its sources spread out — each at the largest k
 * that still fits. Ties: more source messages, then claim id. Deterministic.
 */
function allocateSamples(candidates, sample, options) {
    const span = item => item.lastPosition == null ? -1 : item.lastPosition - item.position;
    const ranked = [...candidates.keys()].sort((a, b) => span(b) - span(a)
        || b.sourceMessages - a.sourceMessages || compareId(a, b));
    let remaining = options.sampleBudget;
    for (const item of ranked) {
        const sets = candidates.get(item);
        Object.assign(item, { samples: [], omittedMessages: sets.dated.length, omittedUndated: sets.undated.length });
        for (let k = options.sampleK; k >= 1; k--) {
            const pick = pickSamples(sets, k, sample);
            // Budget exactly the serialized sample payload, including elision counts.
            const cost = JSON.stringify(pick).length;
            if (cost <= remaining) {
                Object.assign(item, pick);
                remaining -= cost;
                break;
            }
        }
    }
}

/** Returns a whitelist projection: no dates, receipt identities, source ids, or store references. */
export function buildProfileEvidenceView(file, settings = {}) {
    const options = { ...GROWTH_TIMELINE_DEFAULTS, ...settings };
    const { byId, annotate, orderUnknown } = timelineDomain(file, options);
    const candidates = new Map();
    const items = (file?.consolidated || []).map(claim => {
        const sources = [...new Set(claim.sources || [])].map(id => byId.get(id)).filter(Boolean);
        const dated = sources.filter(o => !isPositionUnknown(o));
        const messages = orderUnknown ? [] : messageSources(dated);
        const first = messages[0];
        const last = messages.at(-1);
        const firstPosition = first ? annotate(first).position : null;
        const lastPosition = last ? annotate(last).position : null;
        // Receipt validity is independent of whether a timestamp can establish order.
        const undated = messageSources(sources.filter(o => o.verified !== false
            && (orderUnknown || isPositionUnknown(o)))).sort(compareId);
        const neutral = firstPosition != null && firstPosition === lastPosition ? [...messages, ...undated] : undated;
        const quotes = neutral.filter(o => typeof o.quote === 'string' && o.quote.trim());
        const sourceQuotes = [...new Set([quotes[0]?.quote, quotes.at(-1)?.quote].filter(Boolean))];
        const spread = { early: 0, middle: 0, late: 0 };
        for (const o of messages) spread[annotate(o).phase]++;
        const item = { id: claim.id, category: claim.category, claim: claim.claim, tier: 'consolidated', canon: false,
            position: firstPosition, phase: first ? annotate(first).phase : null, orderUnknown: !first,
            lastPosition, lastPhase: last ? annotate(last).phase : null,
            sourceMessages: messages.length, spread, earliestQuote: first?.quote || '', latestQuote: last?.quote || '',
            earliestTied: messages.filter(o => o.ts === first?.ts).length > 1,
            latestTied: messages.filter(o => o.ts === last?.ts).length > 1, sourceQuotes,
            samples: [], omittedMessages: 0, omittedUndated: 0 };
        if (messages.length + undated.length >= 2) candidates.set(item, { dated: messages, undated });
        return item;
    });
    for (const o of file?.raw || []) items.push({ id: o.id, category: o.category, claim: o.claim,
        quote: o.quote, canon: !!o.canon, tier: 'raw', ...annotate(o) });

    allocateSamples(candidates, o => ({ claim: o.claim, ...annotate(o) }), options);
    items.sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || compareId(a, b));
    return { orderUnknown, items };
}

const location = (position, phase) => position == null ? 'order unknown' : `${phase} ${Math.round(position * 10) / 10}`;

/** Text for Generate/Psychoanalyze; no live message indices masquerading as chronology. */
export function formatProfileEvidence(view) {
    return [view.orderUnknown ? 'Evidence order unknown; do not infer chronology from list order.'
        : 'Story positions are ranks, not dates. Equal positions are simultaneous for ordering purposes; display order breaks no ties.',
    ...view.items.map((o, index) => {
        const heading = `${index + 1}. [${o.category}]${o.canon ? ' [CANON]' : ''} [${o.tier}] ${o.claim}`;
        if (o.tier !== 'consolidated') return `${heading}\n   Seen: ${location(o.position, o.phase)}\n   Quote: "${o.quote || ''}"`;
        const lines = [heading];
        if (o.orderUnknown) lines.push('   Seen: order unknown');
        else {
            const count = `${o.sourceMessages} source message${o.sourceMessages === 1 ? '' : 's'}`;
            lines.push(`   Seen: ${location(o.position, o.phase)} → ${location(o.lastPosition, o.lastPhase)} · ${count}: `
                + `early ×${o.spread.early}, middle ×${o.spread.middle}, late ×${o.spread.late}`);
            if (o.position !== o.lastPosition) {
                const latest = `${o.latestTied ? 'Latest position (representative quote)' : 'Latest'}: "${o.latestQuote}"`;
                // The earliest receipt earns its tokens only when it shows a different phase.
                if (o.phase === o.lastPhase) lines.push(`   ${latest}`);
                else lines.push(`   ${o.earliestTied ? 'Earliest position (representative quote)' : 'Earliest'}: "${o.earliestQuote}"  ${latest}`);
            }
        }
        for (const quote of o.sourceQuotes || []) lines.push(`   Source quote: "${quote}" (no relative order implied)`);
        if (o.samples.length) {
            lines.push('   Source claims (equal positions do not imply order):');
            const dated = o.samples.filter(s => s.position != null);
            dated.forEach((s, i) => {
                if (o.omittedMessages && i === dated.length / 2) lines.push(`     … ${o.omittedMessages} more …`);
                lines.push(`     ${location(s.position, s.phase)} ${s.claim}`);
            });
            for (const s of o.samples.filter(u => u.position == null)) lines.push(`     order unknown ${s.claim}`);
            if (o.omittedUndated) lines.push(`     … ${o.omittedUndated} more with unknown order …`);
        } else if (o.omittedMessages || o.omittedUndated) {
            lines.push(`   … ${o.omittedMessages + o.omittedUndated} source messages omitted …`);
        }
        return lines.join('\n');
    })].join('\n');
}

/** Preserve the caller's numeric source IDs/snapshot while reordering display only. */
export function formatConsolidationEvidence(file, observations) {
    const view = buildProfileEvidenceView(file);
    const raw = new Map(view.items.filter(o => o.tier === 'raw').map(o => [o.id, o]));
    const ordered = observations.map(o => ({ ...o, ...raw.get(o.id) }));
    ordered.sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || compareId(a, b));
    return [view.orderUnknown ? 'Evidence order unknown; do not infer chronology from list order.'
        : 'Story positions are ranks, not dates; equal positions have no known relative order.',
    ...ordered.map(o => `[${o.numericId}] [${o.category}] [${location(o.position, o.phase)}] ${o.claim}\n   Quote: "${o.quote}"`)].join('\n');
}