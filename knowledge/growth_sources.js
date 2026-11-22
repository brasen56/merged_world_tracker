/** Capture receipts may only verify against the originals supplied to the model. */
import { findQuoteMatch, sendDateToMs } from '../core/index.js';
import { getReceiptIdentity } from '../core/message_identity.js';

export function verifyGrowthObservations(observations, sources) {
    const messages = sources.map(source => source.msg);
    return observations.filter(o => o && typeof o.claim === 'string' && o.claim.trim()
        && typeof o.quote === 'string' && o.quote.trim()).map(o => {
        const cited = Number.isInteger(o.msgIdx) ? o.msgIdx : null;
        const preferred = sources.findIndex(source => source.promptIndex === cited);
        let index = findQuoteMatch(o.quote.trim(), preferred < 0 ? null : preferred, messages);
        if (index < 0 && preferred >= 0) index = findQuoteMatch(o.quote.trim(), null, messages);
        // A citation identifies provenance even when the quote cannot verify.
        // Never let a prompt-local or summary-container index become a live one.
        const source = sources[index < 0 ? preferred : index];
        const identity = source && (source.identity || (source.msg.id != null ? `id:${source.msg.id}`
            : source.msg.extra?.mesid != null ? `mesid:${source.msg.extra.mesid}`
                : source.msg.extra?.mwt_uuid ? `uuid:${source.msg.extra.mwt_uuid}` : null));
        return {
            category: ['trait', 'value', 'speech'].includes(o.category) ? o.category : 'trait',
            claim: o.claim.trim(), quote: o.quote.trim(), verified: index >= 0,
            msgIdx: source ? source.liveIndex ?? null : null,
            ...(source ? { ts: source.ts ?? sendDateToMs(source.msg.send_date),
                // The quote never matched, so the citation must not order the
                // evidence — the timeline treats 'cited' as position-unknown
                // even though the ts itself is the cited original's.
                tsSource: index >= 0 ? 'message' : 'cited',
                ...(identity ? { sourceIdentity: identity } : {}),
                // Verified receipts thread msgKey (the growth_timeline grouping
                // key) from the source original; an unconfirmed citation names
                // no source message, so it never counts as support.
                ...(index >= 0 ? { msgKey: getReceiptIdentity(source.msg) } : {}) } : {}),
        };
    });
}