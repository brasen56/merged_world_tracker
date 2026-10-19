/** Capture receipts may only verify against the originals supplied to the model. */
import { findQuoteMatch, sendDateToMs } from '../core/index.js';

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
                : source.msg.extra?.mwt_uuid ? `uuid:${source.msg.extra.mwt_uuid}`
                    : JSON.stringify(['original', source.promptIndex, source.msg.send_date, source.msg.name, source.msg.mes])));
        return {
            category: ['trait', 'value', 'speech'].includes(o.category) ? o.category : 'trait',
            claim: o.claim.trim(), quote: o.quote.trim(), verified: index >= 0,
            msgIdx: source ? source.liveIndex ?? null : null,
            ...(source ? { ts: source.ts ?? sendDateToMs(source.msg.send_date),
                ...(identity ? { sourceIdentity: identity } : {}) } : {}),
        };
    });
}