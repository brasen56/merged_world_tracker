/** Read-only maintenance findings for the Overview dashboard. */

import { auditNpcIdentities, auditProfiles, planProfilePrune, planProfileRelink } from '../knowledge/profiles_audit.js';
import { listProfileEntries } from '../knowledge/lorebook.js';
import { getRegistry } from '../knowledge/registry.js';
import { getDeletedIntentions } from '../interiority/data.js';

function errorFinding(source, error) {
    return { kind: 'maintenance-error', source, error: String(error?.message ?? error) };
}

function countBy(rows, key) {
    const counts = {};
    for (const row of rows) counts[row[key]] = (counts[row[key]] || 0) + 1;
    return counts;
}

/**
 * Collect actionable and manual-review findings. This function is read-only;
 * callers must use the console twins (or Phase 4 controls) to apply changes.
 * Each finding pairs the Overview's summary counts with its raw `rows`.
 */
export async function collectMaintenanceFindings({
    listProfileEntries: readProfileEntries = listProfileEntries,
    auditProfiles: readProfiles = auditProfiles,
    planProfileRelink: buildRelinkPlan = planProfileRelink,
    auditNpcIdentities: readNpcAudit = auditNpcIdentities,
    getRegistry: readRegistry = getRegistry,
    getDeletedIntentions: readDeletions = getDeletedIntentions,
} = {}) {
    const findings = [];
    // Both profile audits read the same book: one read per collection.
    let profileEntries = null;
    const listProfilesOnce = () => (profileEntries ??= readProfileEntries());

    // Keep each source independent. A missing/unavailable lorebook must not
    // hide findings from the other stores (especially deletion tombstones).
    try {
        const rows = await readProfiles({ listProfileEntries: listProfilesOnce });
        const duplicates = rows.filter((row) => row.duplicate);
        if (duplicates.length) {
            const { toDelete, needsReview } = planProfilePrune(rows);
            // Every automatically prunable group keeps exactly one uid.
            const prunableNpcs = [...new Map(toDelete.map((row) => [row.keptUid, row.npc])).values()];
            findings.push({
                kind: 'duplicate-profiles',
                count: prunableNpcs.length + needsReview.length,
                entries: duplicates.length,
                pruneCount: toDelete.length,
                prunableNpcs,
                review: needsReview.map((group) => ({ reason: group.reason, npc: group.npc, count: group.rows.length })),
                command: 'MWT.profiles.duplicates() / MWT.profiles.pruneDuplicates()',
                rows: duplicates,
            });
        }
    } catch (error) {
        findings.push(errorFinding('profile audit', error));
    }

    try {
        const { planned, unmatched } = await buildRelinkPlan({ registry: readRegistry(), listProfileEntries: listProfilesOnce });
        if (planned.length || unmatched.length) {
            findings.push({
                kind: 'relink-candidates',
                count: planned.length + unmatched.length,
                relinkNpcs: planned.map((row) => row.npc),
                withOtherCandidates: planned.filter((row) => row.otherCandidates > 0).length,
                unmatched: unmatched.map(({ npc, entries }) => ({ npc, count: entries.length })),
                command: 'MWT.profiles.relink()',
                rows: planned,
            });
        }
    } catch (error) {
        findings.push(errorFinding('profile relink audit', error));
    }

    try {
        const registry = readRegistry();
        const identities = await readNpcAudit({ registry });
        if (identities.length) {
            findings.push({
                kind: 'npc-identity-audit',
                count: identities.length,
                byKind: countBy(identities, 'kind'),
                // The console leads with re-adopt guidance in this case; so does Overview.
                registryEmpty: Object.keys(registry || {}).length === 0,
                command: 'MWT.npcs.auditDuplicates()',
                rows: identities,
            });
        }
    } catch (error) {
        findings.push(errorFinding('NPC identity audit', error));
    }

    try {
        const deleted = readDeletions();
        if (deleted.length) {
            findings.push({
                kind: 'deleted-intentions',
                count: deleted.length,
                command: 'MWT.interiority.deletions() / MWT.interiority.clearDeletions()',
                rows: deleted,
            });
        }
    } catch (error) {
        findings.push(errorFinding('deleted intentions audit', error));
    }
    return findings;
}

/** Guard each asynchronous audit so a maintenance problem cannot blank Overview. */
export async function collectGuardedMaintenanceFindings(deps = {}) {
    try { return { ok: true, value: await collectMaintenanceFindings(deps) }; }
    catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
}
