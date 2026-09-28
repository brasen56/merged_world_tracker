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
// Part 6 injection pause guard. Direct import (not the barrel) so the REAL
// pause singleton is read even under the test barrel→stub alias.
import { isStorePausedForCurrentScope } from '../core/schema_status.js';
// Direct import (not the barrel) so the event reaches the real ring, as in
// lifecycle.js.
import { record } from '../core/diagnostics.js';

import { INJECTION_HEADER, formatLedgerForInjection, selectInjectedIntentions } from './prompts.js';
import { INJECTION_KEY, INJECTION_TAG, getLedger, getInteriorityData, getActiveLedger, getDormantLedger } from './data.js';

/** Last omitted count reported to diagnostics (see applyIntentionsInjection). */
let _lastReportedOmitted = 0;

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
    // Part 6: a store paused by the runtime schema gate is never read — the
    // ledger IS the unprepared store (or its legacy per-message keys are the
    // pending conversion), so a paused Interiority injects nothing and clears
    // whatever a pre-pause state left registered (§7.4).
    const paused = isStorePausedForCurrentScope('interiority');
    if (paused) {
        console.log('[MWT:Interiority] Injection cleared — the store is paused for this chat (schema preparation).');
        const placement = resolveInjectionPlacement();
        const globalSettings = getGlobalSettings();
        applyExtensionPromptInjection({
            key: INJECTION_KEY,
            header: INJECTION_HEADER,
            body: '',
            enabled: false,
            fallbackDepth: placement.depth.value,
            globalRole: placement.role.value,
            wrapperTag: INJECTION_TAG,
            useTags: globalSettings.structuralBoundaries !== false,
        });
        return;
    }
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
    // M5-6: over the cap, the lowest-priority / oldest intentions are left out
    // of the narrator block. Tell the user through diagnostics (and the panel
    // note in render.js), never through the prompt. Recorded when the count
    // changes, so the Log tab isn't flooded on every turn.
    const omitted = enabled && body ? selectInjectedIntentions(ledger).omitted : 0;
    if (omitted !== _lastReportedOmitted) {
        _lastReportedOmitted = omitted;
        if (omitted > 0) {
            record({
                level: 'warn',
                module: 'interiority',
                event: 'intentions_injection_capped',
                detail: { active: activeCount, injected: activeCount - omitted, omitted },
            });
        }
    }
    const cappedNote = omitted > 0 ? ` (${omitted} over the narrator cap, not injected)` : '';
    console.log(`[MWT:Interiority] Injection ${enabled && body ? 'applied' : 'cleared'} — ${activeCount} active of ${ledger.length} ledger entries${dormantNote}${cappedNote}, depth ${placement.depth.value}.`);
}
