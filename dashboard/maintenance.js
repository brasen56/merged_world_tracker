/** Read-only maintenance findings for the Overview dashboard. */

import { auditNpcIdentities, auditProfiles, planProfilePrune, planProfileRelink } from '../knowledge/profiles_audit.js';
import { deleteProfileEntries, listProfileEntries } from '../knowledge/lorebook.js';
import { getRegistry, getProfileUid, setProfileUid } from '../knowledge/registry.js';
import { clearDeletedIntentions, getDeletedIntentions } from '../interiority/data.js';
import { clearAllEvidence, getEvidenceMap } from '../knowledge/evidence.js';
import { flushBook } from '../knowledge/store.js';
import { getLorebookName } from '../knowledge/scope.js';
import { assertSameScope } from '../core/scope.js';

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
} = {}) {
    const findings = [];
    // Both profile audits read the same book: one read per collection.
    let profileEntries = null;
    const listProfilesOnce = () => (profileEntries ??= readProfileEntries());

    // Keep each source independent. A missing/unavailable lorebook must not
    // hide findings from the other stores.
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
                toDelete,
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

    return findings;
}

/** Guard each asynchronous audit so a maintenance problem cannot blank Overview. */
export async function collectGuardedMaintenanceFindings(deps = {}) {
    try { return { ok: true, value: await collectMaintenanceFindings(deps) }; }
    catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
}

/** Read-only inventory for the collapsed Tools disclosure. */
export function collectMaintenanceTools({
    getEvidenceMap: readEvidence = getEvidenceMap,
    getDeletedIntentions: readDeletions = getDeletedIntentions,
} = {}) {
    return {
        evidenceNames: Object.keys(readEvidence() || {}),
        deletionCount: (readDeletions() || []).length,
    };
}

function samePlan(left = [], right = [], fields) {
    const project = (rows) => rows.map((row) => fields.map((field) => row[field])).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return JSON.stringify(project(left)) === JSON.stringify(project(right));
}

/** Apply only a plan that is still identical to the previewed plan. */
export async function applyPrunePlan({ previewRows = [], audit = auditProfiles, plan = planProfilePrune, deleteEntries = deleteProfileEntries, scopeToken } = {}) {
    if (scopeToken && !assertSameScope(scopeToken).ok) return { ok: false, reason: 'The chat changed. Review a fresh preview before applying.' };
    const fresh = plan(await audit());
    if (scopeToken && !assertSameScope(scopeToken).ok) return { ok: false, reason: 'The chat changed. Review a fresh preview before applying.' };
    const expected = previewRows.filter((row) => row.uid != null);
    if (!samePlan(expected, fresh.toDelete, ['uid', 'keptUid'])) return { ok: false, reason: 'The profile book changed. Review a fresh preview before applying.' };
    const result = await deleteEntries(fresh.toDelete.map((row) => row.uid));
    return result?.success === false || result?.ok === false
        ? { ok: false, reason: result.error || result.reason || 'Profile entries could not be deleted.' }
        : { ok: true, ...result };
}

/** Re-plan relinking at confirmation and refuse if the profile book changed. */
export async function applyRelinkPlan({ previewRows = [], registry = getRegistry(), listProfileEntries: list = listProfileEntries, plan = planProfileRelink, setUid = setProfileUid, flush = flushBook, bookName = getLorebookName(), scopeToken } = {}) {
    if (scopeToken && !assertSameScope(scopeToken).ok) return { ok: false, reason: 'The chat changed. Review a fresh preview before applying.' };
    const fresh = await plan({ registry, listProfileEntries: list });
    if (scopeToken && !assertSameScope(scopeToken).ok) return { ok: false, reason: 'The chat changed. Review a fresh preview before applying.' };
    if (!samePlan(previewRows, fresh.planned, ['npc', 'registryKey', 'linkUid', 'was'])) return { ok: false, reason: 'The profile book changed. Review a fresh preview before applying.' };
    for (const row of fresh.planned) {
        if (setUid(row.npc, row.linkUid) === false) return { ok: false, reason: `Could not record the profile link for ${row.npc}.` };
    }
    if (fresh.planned.length && !(await flush(bookName))) return { ok: false, reason: 'The Knowledge lorebook could not be saved.' };
    return { success: true, applied: fresh.planned.length };
}

/** Clear evidence while preserving the console action's orphan warning. */
export function clearAllEvidenceWithWarning() {
    const names = Object.keys(getEvidenceMap() || {});
    const count = clearAllEvidence();
    const orphaned = count > 0 ? names.filter((name) => {
        try { return getProfileUid(name) !== null; } catch { return false; }
    }) : [];
    if (orphaned.length) console.warn(
        `[MWT] ⚠ ${orphaned.length} generated profile(s) are now UNBACKED by evidence: ${orphaned.join(', ')}. ` +
        'Their entries still exist in the NPC Profiles lorebook but nothing supports them anymore. Re-capture and regenerate, or delete those entries manually.'
    );
    return { ok: true, count, orphaned };
}

export const maintenanceActions = { clearAllEvidence: clearAllEvidenceWithWarning, clearDeletedIntentions };
