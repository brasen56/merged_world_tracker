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
import { INJECTION_KEY, INJECTION_TAG, getLedger, getInteriorityData } from './data.js';

/**
 * Apply (or clear) the NPC intentions injection.
 *
 * Called after each turn's interiority generation, on CHAT_CHANGED, and
 * when the module is toggled on/off.
 */
export function applyIntentionsInjection() {
    const data = getInteriorityData();
    const enabled = data.enabled !== false && injectionAllowed('Interiority');
    const globalSettings = getGlobalSettings();

    const ledger = getLedger();
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
    console.log(`[MWT:Interiority] Injection ${enabled && body ? 'applied' : 'cleared'} — ${ledger.length} ledger entries, depth ${depth}.`);
}