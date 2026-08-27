/**
 * backup/restore.js — Pure restore strategies and dry-run planner.
 *
 * This module plans changes only. It never writes chat metadata or lorebooks;
 * Phase 2b will apply the returned `plan.sections` after explicit confirmation.
 */

import {
    MAX_TRASH_SIZE,
    backupDataEqual,
    cloneBackupData,
} from './data.js';
import { validateBackupEnvelope } from './validate.js';
import { getStoreSchema } from '../schema/registry.js';
import { ISSUE_SEVERITIES, prepareStore } from '../core/schema.js';
import { mergeQuarantineItems } from '../core/quarantine.js';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const objectOrEmpty = value => (isObject(value) ? value : {});

function emptySummary() {
    return { added: 0, updated: 0, skipped: [], conflicts: 0 };
}
function addSkip(summary, record, reason) {
    summary.skipped.push({ record, reason });
}

function isEmptyObject(value) {
    return isObject(value) && Object.keys(value).length === 0;
}

function mergeSafeScalars(result, current, incoming, keys, summary) {
    for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(incoming || {}, key)) continue;
        const value = cloneBackupData(incoming[key]);
        if (JSON.stringify(current?.[key]) !== JSON.stringify(value)) summary.updated++;
        result[key] = value;
    }
    return result;
}

function skipProtectedScalars(summary, incoming, keys, label, restore) {
    for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(incoming || {}, key)) continue;
        if (restore) continue;
        addSkip(summary, key, `${label} session setting was preserved; explicit restore confirmation is required.`);
    }
}

function mergeUnique(current, incoming, key, label) {
    const summary = emptySummary();
    const result = Array.isArray(current) ? current.map(item => cloneBackupData(item)) : [];
    const seen = new Set(result.map(item => item?.[key]).filter(value => value !== undefined).map(String));
    for (const record of Array.isArray(incoming) ? incoming : []) {
        const id = record?.[key];
        if (id === undefined || id === null || id === '') {
            addSkip(summary, record, `${label} has no merge key "${key}".`);
        } else if (seen.has(String(id))) {
            summary.conflicts++;
            summary.updated++;
            addSkip(summary, String(id), `${label} already exists; current record was preserved.`);
        } else {
            seen.add(String(id));
            result.push(cloneBackupData(record));
            summary.added++;
        }
    }
    return { data: result, summary };
}

function mergeNamedFiles(current, incoming, mergeFile) {
    const summary = emptySummary();
    const result = cloneBackupData(objectOrEmpty(current));
    for (const [name, file] of Object.entries(objectOrEmpty(incoming))) {
        if (!Object.prototype.hasOwnProperty.call(result, name)) {
            result[name] = cloneBackupData(file);
            summary.added++;
            continue;
        }
        const merged = mergeFile(result[name], file, name);
        result[name] = merged.data;
        summary.added += merged.summary.added;
        summary.updated += merged.summary.updated;
        summary.conflicts += merged.summary.conflicts;
        summary.skipped.push(...merged.summary.skipped);
    }
    return { data: result, summary };
}

function mergeEvidenceFile(current, incoming, name) {
    const summary = emptySummary();
    const result = { ...cloneBackupData(objectOrEmpty(current)), npc: current?.npc || incoming?.npc || name };
    for (const tier of ['raw', 'consolidated', 'archivedRaw']) {
        const merged = mergeUnique(result[tier], incoming?.[tier], 'id', `${name}.${tier} observation`);
        result[tier] = merged.data;
        summary.added += merged.summary.added;
        summary.updated += merged.summary.updated;
        summary.conflicts += merged.summary.conflicts;
        summary.skipped.push(...merged.summary.skipped);
    }
    // Existing metadata is user/chat-local history. Do not replace it with an
    // imported value merely because the outer evidence file has the same name.
    if (!current?.meta && incoming?.meta) result.meta = cloneBackupData(incoming.meta);
    if (current?.enrolled === undefined && incoming?.enrolled !== undefined) result.enrolled = incoming.enrolled;
    return { data: result, summary };
}

function mergeChronicle(current, incoming, { restoreSessionConfig = false } = {}) {
    const result = cloneBackupData(objectOrEmpty(current));
    const summary = emptySummary();
    const snapshots = Object.prototype.hasOwnProperty.call(incoming || {}, 'snapshots')
        ? mergeUnique(current?.snapshots, incoming.snapshots, 'id', 'Chronicle snapshot')
        : { data: cloneBackupData(current?.snapshots || []), summary: emptySummary() };
    const trash = Object.prototype.hasOwnProperty.call(incoming || {}, '_deletedBin')
        ? mergeUnique(current?._deletedBin, incoming._deletedBin, 'id', 'Chronicle trash entry')
        : { data: cloneBackupData(current?._deletedBin || []), summary: emptySummary() };
    result.snapshots = snapshots.data;
    result._deletedBin = trash.data.slice(-MAX_TRASH_SIZE);
    mergeSafeScalars(result, current, incoming, ['lastAnchor', 'msgSinceSnapshot'], summary);
    const sessionSettings = ['injectEnabled', 'injectMode', 'injectCount', 'injectDepth', 'injectFromDate', 'injectToDate', 'selectedForInjection'];
    skipProtectedScalars(summary, incoming, sessionSettings, 'Chronicle', restoreSessionConfig);
    if (restoreSessionConfig) mergeSafeScalars(result, current, incoming, sessionSettings, summary);
    for (const part of [snapshots.summary, trash.summary]) {
        summary.added += part.added;
        summary.updated += part.updated;
        summary.conflicts += part.conflicts;
        summary.skipped.push(...part.skipped);
    }
    return { data: result, summary };
}

function mergeInteriority(current, incoming, { sameChat, restoreSessionConfig = false }) {
    const result = cloneBackupData(objectOrEmpty(current));
    const summary = emptySummary();
    const ledger = Object.prototype.hasOwnProperty.call(incoming || {}, 'ledger')
        ? mergeUnique(current?.ledger, incoming.ledger, 'id', 'Interiority ledger entry')
        : { data: cloneBackupData(current?.ledger || []), summary: emptySummary() };
    const tombstones = Object.prototype.hasOwnProperty.call(incoming || {}, 'deletedIntentions')
        ? mergeUnique(current?.deletedIntentions, incoming.deletedIntentions, 'id', 'Interiority tombstone')
        : { data: cloneBackupData(current?.deletedIntentions || []), summary: emptySummary() };
    result.ledger = ledger.data;
    result.deletedIntentions = tombstones.data;
    // These scalar values are part of the current session/configuration state;
    // do not silently replace them during an append-only merge.
    skipProtectedScalars(summary, incoming, ['enabled', 'turnCounter'], 'Interiority', restoreSessionConfig);
    if (restoreSessionConfig) {
        mergeSafeScalars(result, current, incoming, ['enabled', 'turnCounter'], summary);
    }
    for (const part of [ledger.summary, tombstones.summary]) {
        summary.added += part.added;
        summary.updated += part.updated;
        summary.conflicts += part.conflicts;
        summary.skipped.push(...part.skipped);
    }
    if (isObject(incoming?.perMessage)) {
        if (sameChat) {
            result.perMessage = cloneBackupData(incoming.perMessage);
            summary.updated++;
        } else {
            result.perMessage = cloneBackupData(current?.perMessage || {});
            addSkip(summary, 'perMessage', 'Skipped because the backup identity does not match the current chat.');
        }
    }
    return { data: result, summary };
}

function mergeRelationshipMap(current, incoming) {
    const summary = emptySummary();
    const result = cloneBackupData(objectOrEmpty(current));
    for (const [name, edges] of Object.entries(objectOrEmpty(incoming))) {
        const existing = Array.isArray(result[name]) ? result[name] : [];
        const seen = new Set(existing.map(edge => edge?.id !== undefined ? `id:${edge.id}` : `json:${JSON.stringify(edge)}`));
        for (const edge of Array.isArray(edges) ? edges : []) {
            const identity = edge?.id !== undefined ? `id:${edge.id}` : `json:${JSON.stringify(edge)}`;
            if (seen.has(identity)) {
                summary.conflicts++;
                addSkip(summary, name, 'Relationship already exists; current record was preserved.');
            } else {
                seen.add(identity);
                existing.push(cloneBackupData(edge));
                summary.added++;
            }
        }
        result[name] = existing;
    }
    return { data: result, summary };
}

/**
 * Merge a per-NPC scalar map (stances / stanceSources). Current names win — a
 * hand-set stance or its provenance lock must survive an import — and new
 * names are added. Same current-wins rule as the registry name reconciler.
 */
function mergeStanceMap(current, incoming) {
    const summary = emptySummary();
    const result = cloneBackupData(objectOrEmpty(current));
    for (const [name, value] of Object.entries(objectOrEmpty(incoming))) {
        if (Object.prototype.hasOwnProperty.call(result, name)) {
            summary.conflicts++;
            addSkip(summary, name, 'Stance already exists; current value was preserved.');
        } else {
            result[name] = cloneBackupData(value);
            summary.added++;
        }
    }
    return { data: result, summary };
}

/**
 * Shared name-keyed reconciler seam for the lorebook registry and state
 * registry. The current name wins, which preserves local pointers and user
 * edits. Phase 3 can supply `resolveUid` to re-resolve an imported name in the
 * destination lorebook rather than trusting an export-local UID.
 */
export function reconcileNameMap(current, incoming, { resolveUid = null, label = 'registry' } = {}) {
    const result = cloneBackupData(objectOrEmpty(current));
    const summary = emptySummary();
    for (const [name, record] of Object.entries(objectOrEmpty(incoming))) {
        if (Object.prototype.hasOwnProperty.call(result, name)) {
            summary.conflicts++;
            addSkip(summary, name, `${label} name already exists; current record was preserved.`);
            continue;
        }
        const next = cloneBackupData(record);
        if (typeof resolveUid === 'function') {
            next.uid = resolveUid(name, next);
        } else if (Object.prototype.hasOwnProperty.call(next, 'uid')) {
            // A UID is local to the source lorebook. Without a destination
            // resolver it must not be presented as a valid local pointer.
            next.uid = null;
        }
        result[name] = next;
        summary.added++;
    }
    return { data: result, summary };
}

function mergeKnowledgeStore(current, incoming, options = {}) {
    const result = cloneBackupData(objectOrEmpty(current));
    const summary = emptySummary();
    mergeSafeScalars(result, current, incoming, ['version'], summary);
    for (const [key, label] of [['registry', 'NPC registry'], ['stateRegistry', 'state registry']]) {
        if (incoming?.[key] === undefined) continue;
        const merged = reconcileNameMap(current?.[key], incoming[key], {
            resolveUid: options.resolveUid?.[key], label,
        });
        result[key] = merged.data;
        summary.added += merged.summary.added;
        summary.updated += merged.summary.updated;
        summary.conflicts += merged.summary.conflicts;
        summary.skipped.push(...merged.summary.skipped);
    }
    if (incoming?.relationships !== undefined) {
        const merged = mergeRelationshipMap(current?.relationships, incoming.relationships);
        result.relationships = merged.data;
        summary.added += merged.summary.added;
        summary.updated += merged.summary.updated;
        summary.conflicts += merged.summary.conflicts;
        summary.skipped.push(...merged.summary.skipped);
    }
    for (const key of ['stances', 'stanceSources']) {
        if (incoming?.[key] === undefined) continue;
        const merged = mergeStanceMap(current?.[key], incoming[key]);
        result[key] = merged.data;
        summary.added += merged.summary.added;
        summary.conflicts += merged.summary.conflicts;
        summary.skipped.push(...merged.summary.skipped);
    }
    return { data: result, summary };
}

/**
 * Exact (non-merge) knowledge-store plan for session-local undo. The incoming
 * snapshot REPLACES the current store — current-only records are dropped, which
 * is how undo removes records the original restore added. UIDs are reset to
 * null because they are source-local; resolveKnowledgeStorePlan re-resolves
 * them against the destination lorebook before commit.
 */
function exactKnowledgeStore(incoming) {
    const data = cloneBackupData(objectOrEmpty(incoming));
    for (const key of ['registry', 'stateRegistry']) {
        for (const record of Object.values(data[key] || {})) {
            if (record && typeof record === 'object' && Object.prototype.hasOwnProperty.call(record, 'uid')) {
                record.uid = null;
            }
        }
    }
    return { data, summary: emptySummary() };
}

function replaceSection(current, incoming, mode, name) {
    const summary = emptySummary();
    if (mode === 'keep' || mode === 'skip') {
        addSkip(summary, name, `Section was not replaced (${mode}).`);
        return { data: cloneBackupData(current || {}), summary };
    }
    if (isEmptyObject(incoming)) {
        addSkip(summary, name, 'Empty replace payload was ignored; current section was preserved.');
        return { data: cloneBackupData(current || {}), summary };
    }
    summary.updated = current === undefined ? 0 : 1;
    summary.added = current === undefined ? 1 : 0;
    return { data: cloneBackupData(incoming || {}), summary };
}

function mergeStoryPlanner(current, incoming) {
    const summary = emptySummary();
    if (isEmptyObject(incoming)) {
        addSkip(summary, 'storyPlanner', 'Empty merge payload was ignored; current section was preserved.');
        return { data: cloneBackupData(current || {}), summary };
    }
    const result = current === undefined
        ? cloneBackupData(objectOrEmpty(incoming))
        : cloneBackupData(objectOrEmpty(current));
    const arcs = Object.prototype.hasOwnProperty.call(incoming || {}, 'arcs')
        ? mergeUnique(current?.arcs, incoming.arcs, 'id', 'Story Planner arc')
        : { data: cloneBackupData(current?.arcs || []), summary: emptySummary() };
    if (Object.prototype.hasOwnProperty.call(incoming || {}, 'arcs') || current?.arcs !== undefined) {
        result.arcs = arcs.data;
    }
    summary.added += arcs.summary.added;
    summary.updated += arcs.summary.updated;
    summary.conflicts += arcs.summary.conflicts;
    summary.skipped.push(...arcs.summary.skipped);
    return { data: result, summary };
}

function sameChatIdentity(backupIdentity, currentIdentity) {
    if (!isObject(backupIdentity) || !isObject(currentIdentity)) return false;
    if (backupIdentity.isUnknown === true || currentIdentity.isUnknown === true) return false;
    const backupId = backupIdentity.chatId;
    const currentId = currentIdentity.chatId;
    return backupId !== null && backupId !== undefined && String(backupId) !== ''
        && currentId !== null && currentId !== undefined && String(currentId) !== ''
        && String(backupId) === String(currentId);
}

/**
 * Resolve the unknown-identity compatibility policy.
 *
 * Two regimes:
 *  - Known identity (or a pure plan with no identity supplied): ordinary merge
 *    restore; perMessage/exact only when the backup is the same chat; world
 *    state may be replaced.
 *  - Unknown identity (the build cannot identify the chat, isUnknown === true):
 *    merge restore is permitted (the epoch guard still applies), but perMessage
 *    is always skipped, exact/replace is disabled, and world state defaults to
 *    "keep current" so the merge-only fallback never contains a destructive
 *    whole-document overwrite. A prominent warning is surfaced for the UI.
 */
function resolveIdentityPolicy(identityUnknown, sameChat) {
    if (!identityUnknown) {
        return {
            identityKnown: true,
            sameChat,
            worldStateDefault: 'replace',
            perMessageAllowed: sameChat,
            exactAllowed: sameChat,
            restrictions: sameChat ? [] : ['perMessage and exact restore require the same chat'],
            warning: sameChat ? null
                : 'The backup is from a different chat; per-message interiority and exact replacement are not available.',
        };
    }
    return {
        identityKnown: false,
        sameChat: false,
        worldStateDefault: 'keep',
        perMessageAllowed: false,
        exactAllowed: false,
        restrictions: ['perMessage skipped', 'exact/replace disabled', 'world state defaults to keep current'],
        warning: 'This SillyTavern build cannot verify chat identity. Only non-destructive merge restore is available; per-message interiority and exact replacement are disabled, and world state defaults to keep current.',
    };
}

function sectionMode(modes, name, fallback = 'merge') {
    return modes?.[name] || fallback;
}

/**
 * Create a dry-run restore plan. `current` is a plain object containing the
 * currently stored section data; omitted sections are treated as empty.
 *
 * `currentVersions` (optional) maps each section name to the schema version
 * the DESTINATION's manifest actually declares for it. The current half of
 * every merged section is prepared from that version before merging, so a
 * legacy destination (an unstamped Chronicle store) runs its v0 → v1 migration
 * instead of being quarantined by the current-version validator (design §4.2/
 * §7.7). Without the map, each section defaults to its current version — the
 * historical behavior for pure callers with no manifest at hand.
 */
export function planRestore(envelope, current = {}, {
    modes = {},
    currentIdentity = null,
    currentMessageIds = [],
    maxFormatVersion,
    exact = false,
    currentVersions = null,
} = {}) {
    const validation = validateBackupEnvelope(envelope, maxFormatVersion === undefined ? {} : { maxFormatVersion });
    if (!validation.ok) return { ok: false, validation, summary: {}, plan: null };

    const sameChat = sameChatIdentity(envelope._meta.identity, currentIdentity);
    const identityUnknown = isObject(currentIdentity) && currentIdentity.isUnknown === true;
    const identityPolicy = resolveIdentityPolicy(identityUnknown, sameChat);
    const sections = {};
    const summary = {};
    const canonicalSections = [];
    // Sections whose completed value is DEFERRED (design §7.5): their retained
    // data is committed, but they are never stamped current and the commit
    // withholds any existing stamp — the privileged conversion has not run.
    const deferredSections = [];
    // Destination sections whose CURRENT half REFUSED preparation (§3.5: an
    // unreadable root, a manifest version from the future). The plan omits
    // them so the raw stored value survives unstamped and un-downgraded;
    // exposed on the plan so exact planning preserves the same refusal
    // instead of reintroducing the section from the import.
    const blockedSections = [];
    const imported = validation.sections;

    // ── Recovery ownership (design §5.1, Part 3) ───────────────────────────
    //
    // The envelope-level recovery container imports tolerantly, but its items
    // are NOT all chat-local: a recovery export — or a backup written by the
    // earlier implementation, before Knowledge quarantine moved into the
    // lorebook store — can carry store:'knowledgeStore' records, which one
    // chat's metadata must not own (a shared global/scoped book belongs to
    // every chat that reads it). Partition the recovery items by store,
    // exactly like the per-section findings: Knowledge-store items ride
    // validation.quarantine.knowledgeStore so the commit's lorebook flush
    // carries them INSIDE the affected book(s), and only genuinely
    // chat-local records stay in validation.recovery for the chat container
    // merge.
    if (Array.isArray(validation.recovery?.items) && validation.recovery.items.length > 0) {
        const knowledgeStoreId = getStoreSchema('knowledgeStore')?.id;
        const chatLocalRecovery = [];
        const storeOwnedRecovery = [];
        for (const item of validation.recovery.items) {
            (item && item.store === knowledgeStoreId ? storeOwnedRecovery : chatLocalRecovery).push(item);
        }
        if (storeOwnedRecovery.length > 0) {
            validation.quarantine.knowledgeStore = mergeQuarantineItems(
                validation.quarantine.knowledgeStore || [],
                storeOwnedRecovery,
            );
        }
        validation.recovery.items = chatLocalRecovery;
    }

    const restoreChronicleSettings = modes.restoreSessionConfig === true
        || modes.chronicle?.restoreSessionConfig === true;
    const restoreInterioritySettings = modes.restoreSessionConfig === true
        || modes.interiority?.restoreSessionConfig === true;

    for (const [name, data] of Object.entries(imported)) {
        const schema = getStoreSchema(name);
        const rawCurrent = current[name];
        // Replace-mode sections honor keep/skip (worldState, knowledgeCounters).
        const replaceMode = name === 'worldState'
            ? sectionMode(modes, name, identityPolicy.worldStateDefault)
            : name === 'knowledgeCounters'
                ? sectionMode(modes, name, 'replace')
                : null;
        const isKeepSkip = replaceMode === 'keep' || replaceMode === 'skip';

        // ── Migrate the DESTINATION half before merging (design §4.2/§7.7) ──
        //
        // Only the incoming half of each section was ever prepared: the import
        // validation (§7.7) migrated it from its declared version, but the
        // CURRENT half entered the merge raw. Preparing the completed value at
        // the CURRENT version (below) could not fix that — a legacy Chronicle
        // snapshot without an id was quarantined by the v1 validator even
        // though its v0 → v1 migration would have backfilled a deterministic
        // id, so valid legacy data went inactive with the wrong sourceVersion.
        // Prepare the current section from the version the destination
        // manifest actually declares (missing ⇒ legacy 0) and merge canonical
        // current data with canonical imported data.
        let currentData = rawCurrent;
        let currentQuarantined = [];
        let currentSkipped = [];
        // §3.5: a current store that REFUSED preparation (a fatal root, a
        // declared version from the future) makes this section unwritable —
        // see the write decision below. The merge helpers normalize whatever
        // shape they are handed, so merging the raw value and revalidating the
        // completed result would happily "repair" an unreadable store (or
        // downgrade a future-version one) and stamp it current.
        let currentBlocked = false;
        if (schema && !isKeepSkip && rawCurrent !== undefined && rawCurrent !== null) {
            const declaredVersion = currentVersions !== null && Number.isInteger(currentVersions[name])
                ? currentVersions[name]
                : schema.currentVersion;
            const preparedCurrent = prepareStore(schema, rawCurrent, {
                version: declaredVersion,
                deferPolicy: 'canonicalize',
            });
            if (preparedCurrent.status === 'blocked') {
                currentBlocked = true;
                // Surface the refusal (§10.3 display contract: identifiers,
                // never rejected prose). A blocked preparation carries either
                // FATAL/QUARANTINE issues (an unreadable root) or only a
                // store-level error — a future version blocks before any issue
                // is recorded — so the error message names the reason then.
                currentSkipped = preparedCurrent.issues
                    .filter(issue => issue.severity === ISSUE_SEVERITIES.QUARANTINE
                        || issue.severity === ISSUE_SEVERITIES.FATAL)
                    .map(issue => ({ record: issue.identity ?? issue.record, reason: issue.message }));
                if (currentSkipped.length === 0 && preparedCurrent.error) {
                    currentSkipped = [{ record: name, reason: preparedCurrent.error.message }];
                }
            } else {
                currentData = preparedCurrent.data;
                currentQuarantined = preparedCurrent.quarantined;
                // §10.3 display contract: identifiers, never rejected prose.
                currentSkipped = preparedCurrent.issues
                    .filter(issue => issue.severity === ISSUE_SEVERITIES.QUARANTINE
                        || issue.severity === ISSUE_SEVERITIES.FATAL)
                    .map(issue => ({ record: issue.identity ?? issue.record, reason: issue.message }));
            }
        }

        let planned;
        if (name === 'chronicle') planned = mergeChronicle(currentData, data, {
            restoreSessionConfig: restoreChronicleSettings,
        });
        else if (name === 'knowledgeEvidence') planned = mergeNamedFiles(currentData, data, mergeEvidenceFile);
        else if (name === 'knowledgeCounters') planned = replaceSection(currentData, data, replaceMode, name);
        else if (name === 'storyPlanner') planned = mergeStoryPlanner(currentData, data);
        else if (name === 'interiority') planned = mergeInteriority(currentData, data, {
            sameChat,
            restoreSessionConfig: restoreInterioritySettings,
        });
        else if (name === 'knowledgeStore') planned = exact
            ? exactKnowledgeStore(data)
            : mergeKnowledgeStore(currentData, data, modes.knowledgeStore || {});
        else if (name === 'worldState') planned = replaceSection(currentData, data, replaceMode, name);
        else planned = { data: cloneBackupData(data), summary: emptySummary() };

        // ── Revalidate the COMPLETED section value (design §8) ──────────────
        //
        // Both halves are canonical by now, but the merge itself can still
        // produce a shape neither half validated (a duplicate id formed across
        // the two halves). Preparing the completed value here means the plan
        // only ever carries canonical data: invalid records are quarantined
        // (their items ride validation.quarantine so the commit preserves
        // them, §5.2) and a FATAL result leaves the section UNWRITTEN — the
        // previous value stays intact and unstamped (§3.5: a blocked store
        // blocks only itself).
        let writeSection = true;
        let canonicalWrite = true;
        // DEFER findings of the completed-value preparation (§7.5), surfaced
        // in the summary below alongside the import-time deferrals.
        let preparedDeferred = [];
        if (isKeepSkip) {
            // Keep/skip owes the section NO write at all. Re-preparing the
            // kept value would turn the "no-op" into an integrity repair the
            // preview never offered — a kept World State with an invalid
            // autoSaveHistory had that field removed, quarantined, written,
            // and stamped, even though the preview said the section was not
            // replaced. The section is omitted from the write plan entirely;
            // repairing the live store is a separate operation.
            writeSection = false;
            canonicalWrite = false;
        } else if (currentBlocked) {
            // The current half refused preparation, so the completed value is
            // unwritable no matter what the merge produced (§3.5): the section
            // keeps its raw stored value, unstamped and un-downgraded. The
            // refusal rides the summary's skipped list so the preview explains
            // the omission; a blocked store blocks only itself — unrelated
            // sections still restore.
            writeSection = false;
            canonicalWrite = false;
            blockedSections.push(name);
            // The preview must describe the actual write plan (§10.3): nothing
            // from this section's merge will be committed, so its prospective
            // added/updated/conflict counts are fiction — zero them and let
            // the skipped entries carry the refusal instead, so the summary
            // never reports an addition that cannot occur.
            planned.summary.added = 0;
            planned.summary.updated = 0;
            planned.summary.conflicts = 0;
            if (currentSkipped.length > 0) {
                planned.summary.skipped = [...currentSkipped, ...planned.summary.skipped];
            }
        } else if (schema) {
            const prepared = prepareStore(schema, planned.data, {
                version: schema.currentVersion,
                deferPolicy: 'canonicalize',
            });
            // §10.3: findings against the completed value are surfaced in the
            // preview exactly like import-time refusals — identifiers, never
            // rejected prose (same display contract as toBackupSummary).
            const preparedSkipped = prepared.issues
                .filter(issue => issue.severity === ISSUE_SEVERITIES.QUARANTINE
                    || issue.severity === ISSUE_SEVERITIES.FATAL)
                .map(issue => ({ record: issue.identity ?? issue.record, reason: issue.message }));
            if (preparedSkipped.length > 0) {
                planned.summary.skipped = [...preparedSkipped, ...planned.summary.skipped];
            }
            if (prepared.status === 'blocked') {
                writeSection = false;
            } else {
                planned.data = prepared.data;
                if (prepared.status === 'deferred') {
                    // §7.5: a deferred completed value is RETAINED (written)
                    // but never stamped current — the manifest may not claim
                    // the privileged conversion already ran, or it never will.
                    // The commit also withholds any EXISTING stamp
                    // (plan.deferredSections): a newly deferred section must
                    // not keep a stamp claiming it is prepared.
                    canonicalWrite = false;
                    deferredSections.push(name);
                    preparedDeferred = prepared.issues
                        .filter(issue => issue.severity === ISSUE_SEVERITIES.DEFER)
                        .map(issue => ({ record: issue.identity ?? issue.record, reason: issue.message }));
                } else {
                    // Stamp only what the restore actually rewrites (§7.7): a
                    // completed value whose canonical form equals the STORED
                    // value made no canonical change and must not be stamped.
                    // The comparison is against the RAW stored value, not the
                    // prepared current half — a migration the write persists
                    // (backfilled legacy ids) is a canonical change even
                    // though both prepared halves already agree.
                    canonicalWrite = !backupDataEqual(prepared.data, rawCurrent);
                }
                // Records quarantined out of the CURRENT half ride the same
                // commit-time preservation (§5.2): the write drops them from
                // the live store, so they must stay recoverable. Surfaced only
                // when the section is written — an unwritten section leaves
                // the current store, rejected records included, untouched.
                if (currentSkipped.length > 0) {
                    planned.summary.skipped = [...currentSkipped, ...planned.summary.skipped];
                }
                if (prepared.quarantined.length > 0 || currentQuarantined.length > 0) {
                    validation.quarantine[name] = mergeQuarantineItems(
                        validation.quarantine[name] || [],
                        mergeQuarantineItems(prepared.quarantined, currentQuarantined),
                    );
                }
            }
        }
        if (writeSection) {
            sections[name] = planned.data;
            if (canonicalWrite) canonicalSections.push(name);
        }
        summary[name] = planned.summary;
        // §10.3 (Part 3): merge/replace preview counts include quarantine
        // results. The planner's summary covers merge decisions; records the
        // IMPORT VALIDATION refused never reach the planner (they were
        // quarantined out of the canonical section), so their skips are
        // prepended here — a preview that silently dropped records it refused
        // would understate what the restore does. Import-time DEFER findings
        // ride along the same way (a preparing store, §7.5).
        const importSkipped = validation.summaries[name]?.skipped;
        if (Array.isArray(importSkipped) && importSkipped.length > 0) {
            summary[name].skipped = [...importSkipped, ...summary[name].skipped];
        }
        const importDeferred = validation.summaries[name]?.deferred;
        // §7.5: the completed value's own DEFER findings (e.g. legacy
        // per-message keys retained out of the CURRENT half) join the
        // import-time ones — deduplicated, because both describe the same
        // retained entries when the deferral came in with the import.
        const deferredSeen = new Set(preparedDeferred.map(entry => `${entry.record}::${entry.reason}`));
        const deferredEntries = [
            ...preparedDeferred,
            ...(Array.isArray(importDeferred) ? importDeferred : [])
                .filter(entry => !deferredSeen.has(`${entry.record}::${entry.reason}`)),
        ];
        if (deferredEntries.length > 0) {
            summary[name].deferred = deferredEntries;
        }
    }

    const perMessage = imported.interiority?.perMessage;
    if (isObject(perMessage)) {
        const available = new Set(Array.isArray(currentMessageIds) ? currentMessageIds.map(String) : []);
        const keys = Object.keys(perMessage);
        const resolved = keys.filter(key => available.has(String(key))).length;
        summary.interiority = summary.interiority || emptySummary();
        summary.interiority.perMessage = {
            imported: keys.length,
            resolved,
            sameChat,
            messageIds: keys,
        };
    }

    return {
        ok: true,
        validation,
        sameChat,
        identityPolicy,
        summary,
        plan: {
            sections,
            identity: envelope._meta.identity,
            // Sections the restore actually rewrites with canonical data (a
            // keep/skip no-op is not one): the ONLY sections the commit may
            // stamp current-version in the schema manifest (§7.3/§7.7).
            canonicalSections,
            // Sections whose completed value is DEFERRED (§7.5): their data is
            // retained in the write, but the commit must NOT stamp them — and
            // must remove any existing stamp, since the privileged conversion
            // has not run on the committed value.
            deferredSections,
            // Destination sections whose CURRENT half refused preparation
            // (§3.5): unwritten, unstamped, and left raw. Exact planning reads
            // this so an exact restore preserves the same refusal.
            blockedSections,
        },
    };
}
