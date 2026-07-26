/**
 * interiority/injection.js — NPC intentions injection back to the narrator.
 *
 * Uses the standard `applyExtensionPromptInjection` pattern with wrapper
 * tag `mwt_npc_intentions`, honoring `structuralBoundaries`, global
 * depth/role settings (default depth 1 / system — same neighborhood as
 * world state).
 *
 * Ledger lines only. Reactions are never injected — the narrator can't
 * leak what it can't see.
 */

import {
    applyExtensionPromptInjection, getGlobalSettings, injectionAllowed,
} from '../core/index.js';

import { INJECTION_HEADER, formatLedgerForInjection } from './prompts.js';
import { INJECTION_KEY, INJECTION_TAG, getLedger, getInteriorityData, getActiveLedger, getDormantLedger } from './data.js';

/**
 * Apply (or clear) the NPC intentions injection.
 *
 * Called after each turn's interiority generation, on CHAT_CHANGED, and
 * when the module is toggled on/off.
 *
 * Dormant entries (§20) are filtered out by formatLedgerForInjection — the
 * narrator never spends attention on a trigger that cannot be met yet.
 */
export function applyIntentionsInjection() {
    const data = getInteriorityData();
    const enabled = data.enabled !== false && injectionAllowed('Interiority');
    const globalSettings = getGlobalSettings();

    const ledger = getLedger();
    const activeCount = getActiveLedger().length;
    const dormantCount = getDormantLedger().length;
    const body = formatLedgerForInjection(ledger);

    applyExtensionPromptInjection({
        key: INJECTION_KEY,
        header: INJECTION_HEADER,
        body,
        enabled: enabled && !!body,
        globalDepth: globalSettings.interiorityDepth,
        fallbackDepth: 1,
        globalRole: globalSettings.interiorityRole || 'system',
        wrapperTag: INJECTION_TAG,
        useTags: globalSettings.structuralBoundaries !== false,
    });

    const depth = Number.isFinite(Number(globalSettings.interiorityDepth))
        ? Number(globalSettings.interiorityDepth)
        : 1;
    const dormantNote = dormantCount > 0 ? ` (${dormantCount} dormant, filtered)` : '';
    console.log(`[MWT:Interiority] Injection ${enabled && body ? 'applied' : 'cleared'} — ${activeCount} active of ${ledger.length} ledger entries${dormantNote}, depth ${depth}.`);
}
