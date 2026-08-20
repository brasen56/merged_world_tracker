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
 * Resolve the depth/role this module's injection will use, WITH provenance —
 * the exact precedence applyIntentionsInjection() hands to
 * applyExtensionPromptInjection():
 *   depth — global `interiorityDepth` (Settings tab; a present, finite value
 *           wins) → built-in 1 (no module-level setting exists)
 *   role  — global `interiorityRole` (truthy wins) → built-in 'system'
 *
 * Phase 9 (diagnostics design §I.4.6, §I.5 Tab 4): the apply path and the 💉
 * Injection tab call the SAME function, so what the tab reports and what the
 * applier registers cannot drift. `source` strings are stable API —
 * 'global' | 'module' | 'builtin' (rendered via PLACEMENT_SOURCE_LABELS,
 * diagnostics_panel/injection.js); do not rename.
 *
 * @returns {{depth: {value: number, source: string}, role: {value: string, source: string}}}
 */
export function resolveInjectionPlacement() {
    const globalSettings = getGlobalSettings();
    const gd = globalSettings.interiorityDepth;
    const globalDepthWins = gd != null && Number.isFinite(Number(gd));
    return {
        depth: {
            value: globalDepthWins ? Number(gd) : 1,
            source: globalDepthWins ? 'global' : 'builtin',
        },
        role: {
            value: globalSettings.interiorityRole || 'system',
            source: globalSettings.interiorityRole ? 'global' : 'builtin',
        },
    };
}

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

    // Placement comes fully resolved from resolveInjectionPlacement() (Phase 9)
    // — one resolver, two consumers (this apply + the 💉 Injection tab).
    const placement = resolveInjectionPlacement();

    applyExtensionPromptInjection({
        key: INJECTION_KEY,
        header: INJECTION_HEADER,
        body,
        enabled: enabled && !!body,
        fallbackDepth: placement.depth.value,
        globalRole: placement.role.value,
        wrapperTag: INJECTION_TAG,
        useTags: globalSettings.structuralBoundaries !== false,
    });

    const dormantNote = dormantCount > 0 ? ` (${dormantCount} dormant, filtered)` : '';
    console.log(`[MWT:Interiority] Injection ${enabled && body ? 'applied' : 'cleared'} — ${activeCount} active of ${ledger.length} ledger entries${dormantNote}, depth ${placement.depth.value}.`);
}
