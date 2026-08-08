/**
 * backup/restore.js — Pure restore strategies and dry-run planner.
 *
 * This module plans changes only. It never writes chat metadata or lorebooks;
 * Phase 2b will apply the returned `plan.sections` after explicit confirmation.
 */

import {
    MAX_TRASH_SIZE,
    cloneBackupData,
} from './data.js';
import { validateBackupEnvelope } from './validate.js';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const objectOrEmpty = value => (isObject(value) ? value : {});

function emptySummary() {
    return { added: 0, updated: 0, skipped: [], conflicts: 0 };
}

function addSkip(summary, record, reason) {
    summary.skipped.push({ record, reason });
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

function mergeChronicle(current, incoming) {
    const result = { ...cloneBackupData(objectOrEmpty(current)), ...cloneBackupData(objectOrEmpty(incoming)) };
    const summary = emptySummary();
    const snapshots = mergeUnique(current?.snapshots, incoming?.snapshots, 'id', 'Chronicle snapshot');
    const trash = mergeUnique(current?._deletedBin, incoming?._deletedBin, 'id', 'Chronicle trash entry');
    result.snapshots = snapshots.data;
    result._deletedBin = trash.data.slice(-MAX_TRASH_SIZE);
    for (const part of [snapshots.summary, trash.summary]) {
        summary.added += part.added;
        summary.updated += part.updated;
        summary.conflicts += part.conflicts;
        summary.skipped.push(...part.skipped);
    }
    return { data: result, summary };
}

function mergeInteriority(current, incoming, { sameChat }) {
    const result = { ...cloneBackupData(objectOrEmpty(current)), ...cloneBackupData(objectOrEmpty(incoming)) };
    const summary = emptySummary();
    const ledger = mergeUnique(current?.ledger, incoming?.ledger, 'id', 'Interiority ledger entry');
    const tombstones = mergeUnique(current?.deletedIntentions, incoming?.deletedIntentions, 'id', 'Interiority tombstone');
    result.ledger = ledger.data;
    result.deletedIntentions = tombstones.data;
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

export const reconcileNameUidMap = reconcileNameMap;

function mergeKnowledgeStore(current, incoming, options = {}) {
    const result = { ...cloneBackupData(objectOrEmpty(current)), ...cloneBackupData(objectOrEmpty(incoming)) };
    const summary = emptySummary();
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
    return { data: result, summary };
}

function replaceSection(current, incoming, mode, name) {
    const summary = emptySummary();
    if (mode === 'keep' || mode === 'skip') {
        addSkip(summary, name, `Section was not replaced (${mode}).`);
        return { data: cloneBackupData(current || {}), summary };
    }
    summary.updated = current === undefined ? 0 : 1;
    summary.added = current === undefined ? 1 : 0;
    return { data: cloneBackupData(incoming || {}), summary };
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

function sectionMode(modes, name, fallback = 'merge') {
    return modes?.[name] || fallback;
}

/**
 * Create a dry-run restore plan. `current` is a plain object containing the
 * currently stored section data; omitted sections are treated as empty.
 */
export function planRestore(envelope, current = {}, {
    modes = {},
    currentIdentity = null,
    currentMessageIds = [],
    maxFormatVersion,
} = {}) {
    const validation = validateBackupEnvelope(envelope, maxFormatVersion === undefined ? {} : { maxFormatVersion });
    if (!validation.ok) return { ok: false, validation, summary: {}, plan: null };

    const sameChat = sameChatIdentity(envelope._meta.identity, currentIdentity);
    const sections = {};
    const summary = {};
    const imported = validation.sections;

    for (const [name, data] of Object.entries(imported)) {
        const currentData = current[name];
        let planned;
        if (name === 'chronicle') planned = mergeChronicle(currentData, data);
        else if (name === 'knowledgeEvidence') planned = mergeNamedFiles(currentData, data, mergeEvidenceFile);
        else if (name === 'knowledgeCounters') planned = replaceSection(currentData, data, sectionMode(modes, name, 'replace'), name);
        else if (name === 'storyPlanner') planned = replaceSection(currentData, data, sectionMode(modes, name, 'replace'), name);
        else if (name === 'interiority') planned = mergeInteriority(currentData, data, { sameChat });
        else if (name === 'knowledgeStore') planned = mergeKnowledgeStore(currentData, data, modes.knowledgeStore || {});
        else if (name === 'worldState') planned = replaceSection(currentData, data, sectionMode(modes, name, 'replace'), name);
        else planned = { data: cloneBackupData(data), summary: emptySummary() };
        sections[name] = planned.data;
        summary[name] = planned.summary;
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
        summary,
        plan: { sections, identity: envelope._meta.identity },
    };
}

export const previewRestore = planRestore;
export const createRestorePlan = planRestore;
