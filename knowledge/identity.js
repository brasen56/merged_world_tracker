/**
 * knowledge/identity.js — The entity identity + alias management service
 * (TODO §1, "Entity identity + alias management").
 *
 * WHAT THIS MODULE OWNS
 * ---------------------
 * Registry names are display state; the identity service is the layer that
 * keeps every name-keyed surface agreeing when a human decision changes them:
 *
 *   - canonical entity ids — stamped on every registry record (schema v2 +
 *     saveRegistry), never re-derived from the name, carried across renames
 *     and merges;
 *   - aliases & nicknames — user-approved alternate spellings the resolver's
 *     step 3 honors (resolveRegistryKey), so "The Vixen" resolves to
 *     "Mara Vance" without touching the given-name heuristic;
 *   - user-approved renames — renameEntity() rekeys the registry, the
 *     relationship map + edges (ids unchanged — that is the point), stances,
 *     the evidence map, dossier watermarks, and relabels the lorebook +
 *     profile entries (label-verified), keeping the old name as an alias;
 *   - user-approved merges — mergeEntities() folds one NPC's identity into
 *     another with a `mergedFrom` audit trail, evidence merged under
 *     namespaced ids so quote-receipt links survive, and the absorbed name
 *     kept as an alias so old references still resolve;
 *   - repair — repairEntityLinks() heals drifted edge names from their stable
 *     entity ids.
 *
 * FAIL-SAFE DIRECTION
 * -------------------
 * Nothing here runs automatically. The audit (auditRegistryAliases) reports
 * duplicate identities but never merges them — which copy is authoritative is
 * a human decision. Every mutating entry point validates first and returns a
 * per-surface report instead of throwing halfway through a multi-surface
 * change: a failed surface is a warning, not a lost NPC.
 */

import { getRegistry, saveRegistry, getRegistryEntry, resolveRegistryKey } from './registry.js';
import {
    getRelationships, saveRelationships, rekeyRelationships,
    mergeRelationshipIdentities, repairRelationshipEntityNames,
    syncAllRelationshipsToLorebooks,
} from './relationships.js';
import { backfillRelationshipEntityIds, ensureRegistryIdentityFields } from './schema.js';
import { renameEvidenceFile, mergeEvidenceFiles, canRekeyEvidence, canRenameEvidence } from './evidence.js';
import { renameDossierFieldStatus, mergeDossierFieldStatus } from './dossier_status.js';
import { getLorebookName, getProfileLorebookName } from './scope.js';
import { flushBook } from './store.js';
// Direct import (not the barrel): the scope guard must be the REAL module's
// epoch/identity state under the test barrel→stub alias too. scopeStillCurrent
// carries the §7.5 semantics a write path needs — the epoch (bumped
// synchronously by CHAT_CHANGED) is always checked, the chat identity
// additionally whenever the capture could identify one — so a rename never
// proceeds into another chat's books, and hosts without a usable chat id are
// not falsely marked stale on every await.
import { captureScope, scopeStillCurrent } from '../core/scope.js';

/** The same normalization the resolver and the store schema compare by. */
const norm = value => String(value ?? '').toLowerCase().trim();

// ─── Scope guard (rename/merge IO legs) ───────────────────────────────────────

/**
 * Track chat-scope drift across the rename/merge lorebook IO.
 *
 * renameEntity()/mergeEntities() rekey the registry, relationships, evidence,
 * and dossier watermarks SYNCHRONOUSLY, then cross awaits for the lorebook
 * relabels and the relationship-block sync. The synchronous surfaces belong
 * to the chat the operation started in; everything after an await may be
 * running in a DIFFERENT one. The guard is checked after every await and the
 * first drift reason is remembered, so the final report names why the
 * remaining lorebook work was dropped even after several checks.
 *
 * @param {object} scope — a captureScope() token taken before any mutation
 * @returns {{stillCurrent: () => boolean, driftReason: () => string|null}}
 */
function makeScopeGuard(scope) {
    let driftReason = null;
    return {
        stillCurrent() {
            const check = scopeStillCurrent(scope);
            if (!check.ok && driftReason === null) driftReason = check.reason;
            return check.ok;
        },
        driftReason() { return driftReason; },
    };
}

// ─── Entity ids ───────────────────────────────────────────────────────────────

/**
 * The stable entity id of an NPC, or null when the name resolves to no
 * registry record (or the record predates stamping — a v0/v1 store that has
 * not been migrated or saved since).
 *
 * @param {string} name — any spelling the resolver accepts
 * @returns {string|null}
 */
export function getEntityId(name) {
    return getRegistryEntry(name)?.info?.entityId ?? null;
}

/**
 * The canonical registry name of the record carrying an entity id, or null.
 *
 * @param {string} entityId
 * @returns {string|null}
 */
export function getNameByEntityId(entityId) {
    if (!entityId) return null;
    for (const [name, record] of Object.entries(getRegistry())) {
        if (record?.entityId === entityId) return name;
    }
    return null;
}

// ─── Aliases ──────────────────────────────────────────────────────────────────

/**
 * The NPC's explicit aliases (a copy — mutate through addAlias/removeAlias).
 *
 * @param {string} name
 * @returns {string[]}
 */
export function listAliases(name) {
    return [...(getRegistryEntry(name)?.info?.aliases ?? [])];
}

/**
 * Add a user-approved alias to an NPC. Refuses any alias that would make the
 * resolver's alias step ambiguous or hijack a canonical lookup: one equal
 * (normalized) to another record's key, another record's alias, or this
 * record's own key. Adding an alias the record already carries is an
 * idempotent no-op success.
 *
 * NOTE: aliases are free text — no shape rules beyond the uniqueness checks
 * above — and both consumers treat them as high-confidence evidence: World
 * State's grounding gate matches the whole phrase (provenance.js) and
 * Interiority's roster union matches the full form (generation.js). A single
 * generic word ("Boss") is therefore a valid alias, but it will pull its
 * owner onto the scene roster off ANY mention of that word. Distinctive
 * aliases keep that power meaningful.
 *
 * @param {string} name — any spelling that resolves to the NPC
 * @param {string} alias
 * @returns {{ok:boolean, added?:boolean, reason?:string, owner?:string}}
 */
export function addAlias(name, alias) {
    const trimmed = String(alias ?? '').trim();
    if (!trimmed) return { ok: false, reason: 'invalid-alias' };
    const entry = getRegistryEntry(name);
    if (!entry) return { ok: false, reason: 'unknown-npc' };
    const reg = getRegistry();
    for (const [key, record] of Object.entries(reg)) {
        if (key === entry.key) {
            if (norm(key) === norm(trimmed)) return { ok: false, reason: 'alias-equals-name' };
            if ((record.aliases ?? []).some(a => norm(a) === norm(trimmed))) return { ok: true, added: false };
            continue;
        }
        if (norm(key) === norm(trimmed) || (record.aliases ?? []).some(a => norm(a) === norm(trimmed))) {
            return { ok: false, reason: 'alias-taken', owner: key };
        }
    }
    const record = reg[entry.key];
    record.aliases = [...(record.aliases ?? []), trimmed];
    record.lastUpdated = Date.now();
    saveRegistry(reg);
    return { ok: true, added: true };
}

/**
 * Remove an explicit alias. Removing one that is not on the record is an
 * idempotent no-op success.
 *
 * @param {string} name
 * @param {string} alias
 * @returns {{ok:boolean, removed?:boolean, reason?:string}}
 */
export function removeAlias(name, alias) {
    const entry = getRegistryEntry(name);
    if (!entry) return { ok: false, reason: 'unknown-npc' };
    const reg = getRegistry();
    const record = reg[entry.key];
    const kept = (record.aliases ?? []).filter(a => norm(a) !== norm(alias));
    if (kept.length === (record.aliases ?? []).length) return { ok: true, removed: false };
    record.aliases = kept;
    record.lastUpdated = Date.now();
    saveRegistry(reg);
    return { ok: true, removed: true };
}

// ─── Rename ───────────────────────────────────────────────────────────────────

/**
 * Is a candidate canonical name free? (Not another record's key or alias — and
 * not claimed by an alias of the record itself.)
 */
function nameIsAvailable(reg, candidate, ownKey) {
    const wanted = norm(candidate);
    for (const [key, record] of Object.entries(reg)) {
        if (key === ownKey) {
            if (norm(key) === wanted) return true; // same name — the caller no-ops earlier
            if ((record.aliases ?? []).some(a => norm(a) === wanted)) return false;
            continue;
        }
        if (norm(key) === wanted || (record.aliases ?? []).some(a => norm(a) === wanted)) return false;
    }
    return true;
}

/**
 * Swap a rename's old name for its new name inside a record's keywords — the
 * keywords list is what the scan matches prose against, so a rename that
 * leaves the old spelling there keeps recognizing the OLD name only.
 */
function swapKeywordName(keywords, oldName, newName) {
    if (!Array.isArray(keywords)) return keywords;
    let changed = false;
    const next = keywords.map(k => {
        if (norm(k) === norm(oldName)) { changed = true; return newName; }
        return k;
    });
    return changed ? next : [newName, ...keywords];
}

/**
 * Rename an NPC across every name-keyed surface (user-approved). The old name
 * becomes an alias, so every reference that still spells it — model output,
 * prose, other modules' history — keeps resolving to the same entity.
 *
 * Surfaces, in order: registry key + keywords + alias back-reference →
 * relationships map/targets + stances (rekeyRelationships; entity ids ride
 * along unchanged) → evidence map → dossier watermarks → lorebook entry label
 * + keywords → profile entry label. The store writes are synchronous and
 * cannot fail halfway; the lorebook relabels are best-effort IO reported as
 * warnings — a refused relabel leaves the entry under its old label, which the
 * alias keeps resolving.
 *
 * @param {string} name — any spelling that resolves to the NPC
 * @param {string} newName — the new canonical name
 * @param {{relabelEntries?: boolean, syncBlocks?: boolean}} [options] — both
 *   default true; tests skip the lorebook IO with false
 * @returns {Promise<{ok:boolean, renamed?:boolean, from?:string, to?:string, book?:string, reason?:string, warnings?:string[]}>}
 */
export async function renameEntity(name, newName, { relabelEntries = true, syncBlocks = true } = {}) {
    const entry = getRegistryEntry(name);
    if (!entry) return { ok: false, reason: 'unknown-npc' };
    const oldKey = entry.key;
    const target = String(newName ?? '').trim();
    if (!target) return { ok: false, reason: 'invalid-name' };
    if (target === oldKey) return { ok: true, renamed: false, reason: 'same-name' };

    const reg = getRegistry();
    if (!nameIsAvailable(reg, target, oldKey)) {
        return { ok: false, reason: 'name-taken' };
    }

    // Identity fields first: an identity operation guarantees the record it
    // touches carries its canonical entityId/aliases before any of its legs
    // read or move them. saveRegistry stamps at the END of the operation; a
    // record that predates stamping (v2 makes the fields optional) would
    // otherwise travel unstamped until then.
    ensureRegistryIdentityFields(reg);

    // 0) Evidence preflight — BEFORE the registry is rekeyed. A rename that
    //    cannot re-key this NPC's evidence would strand the file under the old
    //    name the moment the registry moves (only the alias keeps it
    //    reachable). Two refusals are visible without doing the work: the
    //    store being paused (retry once it accepts writes again), and a file
    //    already sitting under the NEW name — an orphan left by a removed
    //    record, and a collision the merge flow owns, not this rename. Refuse
    //    up front, while every surface is still consistent. Refusals a
    //    preflight cannot see are still reported by the checked
    //    saveEvidenceMap() result renameEvidenceFile() propagates.
    const evidencePreflight = canRenameEvidence(oldKey, target);
    if (!evidencePreflight.ok) {
        return {
            ok: false,
            reason: evidencePreflight.reason === 'target-exists' ? 'evidence-target-exists' : 'evidence-store-unavailable',
            evidenceReason: evidencePreflight.reason,
        };
    }

    const warnings = [];

    // SCOPE GUARD: steps 4–5 below cross awaits. The scope and BOTH book
    // names are captured here — before any mutation — and every relabel
    // writes the CAPTURED names; resolving them again after an await could
    // target the newly active chat's books, where these uids point at
    // strangers. After each await the scope is re-verified and the remaining
    // lorebook work is dropped on drift: the synchronous surfaces already
    // changed belong to this scope, but a relabel or sync that runs in
    // another chat's books is exactly the cross-contamination this prevents.
    const scopeGuard = makeScopeGuard(captureScope());
    const knowledgeBook = getLorebookName();
    const profileBook = getProfileLorebookName();

    // 1) Registry: move the record (its entityId travels untouched), keep the
    //    old spelling as an alias, and swap the old spelling out of keywords.
    //    A case-only rename ("mara" → "Mara") skips the alias back-reference:
    //    it normalized-equals the new canonical name — the exact shape addAlias
    //    refuses ('alias-equals-name') and the validator's alias-collision
    //    repair strips on the next load, so keeping it would only surface a
    //    spurious repair in diagnostics.
    const record = reg[oldKey];
    const caseOnly = norm(oldKey) === norm(target);
    record.aliases = [
        ...(record.aliases ?? []).filter(a => norm(a) !== norm(oldKey) && norm(a) !== norm(target)),
        ...(caseOnly ? [] : [oldKey]),
    ];
    record.keywords = swapKeywordName(record.keywords, oldKey, target);
    record.lastUpdated = Date.now();
    delete reg[oldKey];
    reg[target] = record;
    saveRegistry(reg);

    // 2) Relationships + stances: names rekeyed, entity ids preserved.
    rekeyRelationships(oldKey, target);
    // Stamp ids onto any edge that predates them (legacy stores).
    const rels = getRelationships();
    if (backfillRelationshipEntityIds({ registry: reg, relationships: rels })) {
        saveRelationships(rels);
    }

    // 3) Evidence + dossier watermarks (chat metadata, keyed by name).
    const evidence = renameEvidenceFile(oldKey, target);
    if (!evidence.ok) {
        warnings.push(`Evidence file not rekeyed (${evidence.reason}) — "${oldKey}" evidence remains under its old name; merge or clear it manually.`);
    }
    const dossier = renameDossierFieldStatus(oldKey, target);
    if (!dossier.ok) {
        warnings.push(`Dossier field watermarks not rekeyed (${dossier.reason}) — staleness chips for "${target}" restart from "never tracked".`);
    }

    // 4) Lorebook entries (best-effort IO). The label verification runs against
    //    the OLD name — writeToLorebook cannot do this (see relabelLorebookEntry).
    //    Book names come from the scope capture above, and each leg re-checks
    //    the scope after its await.
    if (relabelEntries) {
        try {
            const { relabelLorebookEntry } = await import('./lorebook.js');
            if (scopeGuard.stillCurrent() && record.uid !== null && record.uid !== undefined) {
                const relabel = await relabelLorebookEntry(knowledgeBook, record.uid, target, oldKey, record.keywords);
                if (!relabel.success) warnings.push(`Knowledge entry (uid ${record.uid}) not relabelled: ${relabel.error}.`);
            }
            if (scopeGuard.stillCurrent() && record.profileUid !== null && record.profileUid !== undefined) {
                const relabel = await relabelLorebookEntry(profileBook, record.profileUid, target, oldKey, null);
                if (!relabel.success) warnings.push(`Profile entry (uid ${record.profileUid}) not relabelled: ${relabel.error}.`);
            }
            if (scopeGuard.driftReason() !== null) {
                warnings.push(`Chat changed during the rename (${scopeGuard.driftReason()}) — remaining lorebook relabels were skipped so the rename could not relabel entries in another chat's books. The registry, relationships, and evidence are rekeyed; relabel the lorebook entries from the original chat if they still carry the old label.`);
            }
        } catch (err) {
            warnings.push(`Lorebook relabel failed: ${err?.message || err}.`);
        }
    }

    // 5) Re-sync the managed relationship blocks — they embed target names.
    //    Same scope guard: a sync that runs after a chat switch would rewrite
    //    the newly active chat's books from the old chat's state.
    if (syncBlocks) {
        if (!scopeGuard.stillCurrent()) {
            warnings.push(`Relationship blocks not re-synced — the chat changed during the rename (${scopeGuard.driftReason() ?? 'scope changed'}).`);
        } else {
            try { await syncAllRelationshipsToLorebooks(); } catch (err) {
                warnings.push(`Relationship blocks not re-synced: ${err?.message || err}.`);
            }
        }
    }

    // `book` is the knowledge book captured BEFORE any mutation. Callers that
    // flush after the operation must flush THIS name (flushIdentityWrites
    // takes it as an argument): the zero-argument form re-resolves the book
    // against the NOW-active chat, so after a mid-operation chat switch it
    // would flush the incoming chat's book instead of the one these writes
    // belong to.
    return { ok: true, renamed: true, from: oldKey, to: target, book: knowledgeBook, warnings };
}

// ─── Merge ────────────────────────────────────────────────────────────────────

/**
 * Merge one NPC's identity into another's (user-approved). KEEP semantics: the
 * keep record survives with its uid, type, and stance; the absorbed record's
 * evidence, edges, and unfilled pointers fold in; the absorbed name and its
 * aliases become aliases of the keep record; a `mergedFrom` entry records what
 * was absorbed and when. The absorbed record is REMOVED from the registry —
 * its physical lorebook entry is never deleted automatically (that is the
 * user's call, and the alias keeps its label reachable), only reported.
 *
 * @param {string} keepName — any spelling that resolves to the surviving NPC
 * @param {string} mergeName — any spelling that resolves to the absorbed NPC
 * @param {{relabelEntries?: boolean, syncBlocks?: boolean}} [options]
 * @returns {Promise<{ok:boolean, merged?:boolean, from?:string, to?:string, book?:string, reason?:string, warnings?:string[], report?:object}>}
 */
export async function mergeEntities(keepName, mergeName, { relabelEntries = true, syncBlocks = true } = {}) {
    const keepEntry = getRegistryEntry(keepName);
    const mergeEntry = getRegistryEntry(mergeName);
    if (!keepEntry) return { ok: false, reason: 'unknown-keep-npc' };
    if (!mergeEntry) return { ok: false, reason: 'unknown-merge-npc' };
    const keepKey = keepEntry.key;
    const mergeKey = mergeEntry.key;
    if (keepKey === mergeKey) return { ok: true, merged: false, reason: 'same-npc' };
    if (keepEntry.info.entityId && keepEntry.info.entityId === mergeEntry.info.entityId) {
        return { ok: true, merged: false, reason: 'already-merged' };
    }

    // Evidence preflight — BEFORE the registry folds the records. A merge
    // whose evidence cannot be re-keyed would strand the absorbed file under
    // a name that no longer has a registry record at all (only keep's alias
    // keeps it reachable). Refuse up front, while both identities are still
    // intact and the merge can be retried once the store accepts writes.
    const evidencePreflight = canRekeyEvidence(keepKey, mergeKey);
    if (!evidencePreflight.ok) {
        return { ok: false, reason: 'evidence-store-unavailable', evidenceReason: evidencePreflight.reason };
    }

    // SCOPE GUARD: the registry/evidence/watermark fold below is synchronous
    // and belongs to the chat the merge started in; the relabels and the
    // block sync cross awaits. Capture the scope and BOTH book names before
    // any mutation, relabel the CAPTURED names only, and drop the remaining
    // lorebook work if the chat changed mid-merge (see renameEntity).
    const scopeGuard = makeScopeGuard(captureScope());
    const knowledgeBook = getLorebookName();
    const profileBook = getProfileLorebookName();

    const reg = getRegistry();
    // Identity fields BEFORE the fold: the absorbed record's entityId is read
    // twice below — into the mergedFrom audit trail and as the evidence
    // merge's namespace tag — and a v2 record may legitimately lack one (ids
    // are optional; the duplicate-id validator repair also deletes them).
    // saveRegistry stamps at the END of the fold, which is how a merge used to
    // write `entityId: null` into the trail and quarantine the SURVIVOR on
    // the next load. Stamping here means the trail records a real id.
    ensureRegistryIdentityFields(reg);
    const keep = reg[keepKey];
    const merge = reg[mergeKey];
    const warnings = [];

    // 1) Registry: combine the records under keep. Uid/profile pointers are
    //    adopted only where keep has none — an existing pointer is a statement
    //    about which physical entry is authoritative.
    const adoptedUid = (keep.uid === null || keep.uid === undefined) && merge.uid !== null && merge.uid !== undefined;
    if (adoptedUid) keep.uid = merge.uid;
    const adoptedProfileUid = (keep.profileUid === null || keep.profileUid === undefined)
        && merge.profileUid !== null && merge.profileUid !== undefined;
    if (adoptedProfileUid) keep.profileUid = merge.profileUid;

    // Keywords union (deduped, order-preserving, keep's spelling first).
    const seenKeywords = new Set();
    keep.keywords = [...(keep.keywords ?? []), ...(merge.keywords ?? [])]
        .filter(k => {
            const n = norm(k);
            if (!n || seenKeywords.has(n)) return false;
            seenKeywords.add(n);
            return true;
        });

    // Aliases: the absorbed name + its aliases join keep's — minus anything
    // that would now collide with ANOTHER record's key or alias (the schema
    // validator would strip it on next load; dropping it here with a warning
    // is the honest version of the same repair). The record being absorbed is
    // EXCLUDED from the scan: it is about to leave the registry, and its
    // key/aliases are exactly what is being transferred. Keep's own aliases
    // are not a conflict either — a shared alias dedupes silently below.
    keep.aliases = [...(keep.aliases ?? [])];
    for (const candidate of [mergeKey, ...(merge.aliases ?? [])]) {
        const conflict = Object.entries(reg).some(([key, record]) => {
            if (key === mergeKey) return false;
            if (key === keepKey) return norm(key) === norm(candidate);
            return norm(key) === norm(candidate)
                || (record.aliases ?? []).some(a => norm(a) === norm(candidate));
        });
        if (conflict) {
            warnings.push(`Alias "${candidate}" from "${mergeKey}" collides with another NPC's name or alias and was not carried over.`);
            continue;
        }
        if (!keep.aliases.some(a => norm(a) === norm(candidate))) keep.aliases.push(candidate);
    }

    // Audit trail: which entity was folded in, under which spelling, when.
    keep.mergedFrom = [
        ...(Array.isArray(keep.mergedFrom) ? keep.mergedFrom : []),
        { entityId: merge.entityId ?? null, name: mergeKey, at: Date.now() },
    ];
    keep.lastUpdated = Date.now();
    delete reg[mergeKey];
    saveRegistry(reg);

    // 2) Relationships + stances.
    const relationships = mergeRelationshipIdentities(keepKey, mergeKey);
    const rels = getRelationships();
    if (backfillRelationshipEntityIds({ registry: reg, relationships: rels })) {
        saveRelationships(rels);
    }

    // 3) Evidence: merged under namespaced ids (the absorbed entityId as the
    //    namespace, so the trail survives even a later rename of either name).
    const evidence = mergeEvidenceFiles(keepKey, mergeKey, merge.entityId ?? mergeKey);
    if (!evidence.ok) {
        warnings.push(`Evidence not merged (${evidence.reason}) — "${mergeKey}" evidence remains under its old name.`);
    }
    const dossier = mergeDossierFieldStatus(keepKey, mergeKey);
    if (!dossier.ok) {
        warnings.push(`Dossier field watermarks not merged (${dossier.reason}).`);
    }

    // 4) Lorebook entries (best-effort IO). The absorbed entry is left in the
    //    book under its old label — deleting user files automatically is not
    //    this service's call — except the one case where keep ADOPTED its uid:
    //    that entry IS keep's dossier now and must carry keep's label.
    //    Book names come from the scope capture above; each leg re-checks the
    //    scope after its await.
    if (relabelEntries) {
        try {
            const { relabelLorebookEntry } = await import('./lorebook.js');
            if (scopeGuard.stillCurrent() && adoptedUid && keep.uid !== null && keep.uid !== undefined) {
                const relabel = await relabelLorebookEntry(knowledgeBook, keep.uid, keepKey, mergeKey, keep.keywords);
                if (!relabel.success) warnings.push(`Adopted entry (uid ${keep.uid}) not relabelled: ${relabel.error}.`);
            }
            if (scopeGuard.stillCurrent() && adoptedProfileUid && keep.profileUid !== null && keep.profileUid !== undefined) {
                const relabel = await relabelLorebookEntry(profileBook, keep.profileUid, keepKey, mergeKey, null);
                if (!relabel.success) warnings.push(`Adopted profile entry (uid ${keep.profileUid}) not relabelled: ${relabel.error}.`);
            }
            if (scopeGuard.driftReason() !== null) {
                warnings.push(`Chat changed during the merge (${scopeGuard.driftReason()}) — remaining lorebook relabels were skipped so the merge could not relabel entries in another chat's books. The registry, relationships, and evidence are merged; relabel the adopted entries from the original chat if they still carry the absorbed label.`);
            }
        } catch (err) {
            warnings.push(`Lorebook relabel failed: ${err?.message || err}.`);
        }
    }
    if (!adoptedUid && merge.uid !== null && merge.uid !== undefined) {
        warnings.push(`"${mergeKey}"'s lorebook entry (uid ${merge.uid}) was left in the book under its old label — delete it manually if it is now redundant.`);
    }

    // 5) Re-sync the managed relationship blocks. Same scope guard as
    //    renameEntity: a sync that runs after a chat switch would rewrite the
    //    newly active chat's books from the old chat's state.
    if (syncBlocks) {
        if (!scopeGuard.stillCurrent()) {
            warnings.push(`Relationship blocks not re-synced — the chat changed during the merge (${scopeGuard.driftReason() ?? 'scope changed'}).`);
        } else {
            try { await syncAllRelationshipsToLorebooks(); } catch (err) {
                warnings.push(`Relationship blocks not re-synced: ${err?.message || err}.`);
            }
        }
    }

    // `book` — same contract as renameEntity's: the knowledge book captured
    // before any mutation, so the caller's post-merge flush lands in the chat
    // the merge started in even if the chat switched mid-merge.
    return {
        ok: true,
        merged: true,
        from: mergeKey,
        to: keepKey,
        book: knowledgeBook,
        warnings,
        report: {
            entityId: keep.entityId ?? null,
            adoptedUid,
            adoptedProfileUid,
            relationships,
            evidence,
            dossier,
        },
    };
}

// ─── Repair ───────────────────────────────────────────────────────────────────

/**
 * Heal relationship display names from their stable entity ids — see
 * relationships.js repairRelationshipEntityNames(). Exposed here so the
 * service's surface is one module.
 *
 * @returns {{keysRekeyed:number, targetsRepointed:number, edgesMerged:number, idsStamped:number, conflicts:Array}}
 */
export function repairEntityLinks() {
    return repairRelationshipEntityNames();
}

/**
 * Flush the knowledge book so identity changes reach disk promptly (the store
 * write seam schedules a debounced flush; a user-initiated rename/merge should
 * not ride on that debounce).
 *
 * @param {string} [bookName] — the book to flush; defaults to the currently
 *   active one. Rename/merge callers should pass the operation's returned
 *   `book` instead: that is the book captured before the operation's awaits,
 *   and after a mid-operation chat switch the default resolves the INCOMING
 *   chat's book — flushing (and creating) a book these writes do not belong
 *   to. Passing `undefined` keeps the resolve-current-book behaviour.
 * @returns {Promise<void>}
 */
export async function flushIdentityWrites(bookName = getLorebookName()) {
    await flushBook(bookName);
}

/** resolveRegistryKey re-export: the resolver is the service's read seam. */
export { resolveRegistryKey };
