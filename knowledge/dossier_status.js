/**
 * knowledge/dossier_status.js — Per-field dossier staleness watermarks.
 *
 * Implements the staleness half of TODO §3 "Per-field / partial dossier refresh
 * (Knowledge)": a last-updated timestamp AND message-count watermark per NPC
 * per dossier field, so the 🎯 Fields picker can mark individual stale sections
 * the way Chronicle flags a stale anchor.
 *
 * Storage follows the world_state `deltaStatus` precedent (world_state/delta.js):
 * the record lives INSIDE the `knowledge_tracker_counters` store value, under
 * the `dossierFieldStatus` sub-key. The counters validator passes unknown keys
 * through unchanged, `prepareNextStoreValue` merges patches over the current
 * value (so a counter persist never drops the sub-key), and backup/restore
 * carries it as part of the store value — no schema change needed.
 *
 * Shape:
 *   chat_metadata.knowledge_tracker_counters.dossierFieldStatus =
 *     { "<NPC name>": { "<dossier field key>": { at: <epoch ms>, msgIdx: <chat length> } } }
 *
 * Leaf module by design: imports only core + the module's pure schema
 * descriptor, so lorebook.js / render.js can use it without cycles. The
 * canonical DOSSIER_FIELDS list lives in lorebook.js and is passed in by
 * callers; this module never hard-codes field keys.
 */

import { getChat, getChatMeta, persistChatMeta } from '../core/index.js';
import { prepareNextStoreValue } from '../core/schema.js';
import { isStoreWriteBlocked } from '../core/schema_status.js';
import { knowledgeCountersSchema, COUNTERS_META_KEY } from './schema.js';

/** Sub-key inside the counters store value that holds the watermark map. */
export const DOSSIER_STATUS_SUBKEY = 'dossierFieldStatus';

/**
 * A field counts as "stale" once this many messages have arrived after its
 * watermark (or when it has no watermark at all — never refreshed/tracked).
 * Mirrors the granularity of world_state's deltaStaleAfterMsgs default.
 */
export const DOSSIER_STALE_AFTER_MSGS = 30;

/** Read the raw per-NPC watermark map (defensively normalized; garbage → {}). */
export function getDossierFieldStatusMap() {
    const sub = getChatMeta()?.[COUNTERS_META_KEY]?.[DOSSIER_STATUS_SUBKEY];
    if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return {};
    return sub;
}

/** Normalize one stored stamp; unreadable shapes read as "never tracked". */
function normalizeStamp(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const at = Number.isFinite(value.at) ? value.at : null;
    const msgIdx = Number.isFinite(value.msgIdx) ? value.msgIdx : null;
    if (at === null && msgIdx === null) return null;
    return { at, msgIdx };
}

/**
 * Staleness of one field of one NPC.
 *
 * @param {string} name — canonical NPC (registry) name
 * @param {string} fieldKey — dossier field key (e.g. 'agenda')
 * @param {number} [chatLength] — current chat length (defaults to the live chat)
 * @returns {{known:boolean, stale:boolean, msgsSince:number|null, at:number|null, msgIdx:number|null}}
 */
export function getDossierFieldStaleness(name, fieldKey, chatLength = getChat()?.length ?? 0) {
    const stamp = normalizeStamp(getDossierFieldStatusMap()[name]?.[fieldKey]);
    if (!stamp) return { known: false, stale: true, msgsSince: null, at: null, msgIdx: null };
    const msgsSince = stamp.msgIdx === null ? null : Math.max(0, chatLength - stamp.msgIdx);
    const stale = msgsSince === null || msgsSince >= DOSSIER_STALE_AFTER_MSGS;
    return { known: true, stale, msgsSince, at: stamp.at, msgIdx: stamp.msgIdx };
}

/**
 * Stamp a watermark for every listed field of one NPC — called when a proposal
 * that (re)wrote or (re)verified those fields is ACCEPTED, and when a field
 * refresh comes back with no changes (the fields were still just re-examined).
 *
 * Writes go through the §8 write seam: the complete proposed next counters
 * store value is validated by the registered schema, and a store paused by the
 * runtime schema gate refuses the write keeping the previous value intact
 * (same contract as persistCounters in knowledge/index.js).
 *
 * @param {string} name — canonical NPC name
 * @param {string[]} fieldKeys — dossier field keys to stamp
 * @param {{msgIdx?:number, at?:number}} [overrides] — test/UI hooks
 * @returns {boolean} true when a watermark was committed
 */
export function recordDossierFieldRefresh(name, fieldKeys, { msgIdx = getChat()?.length ?? 0, at = Date.now() } = {}) {
    const meta = getChatMeta();
    if (!meta) return false;
    if (!Array.isArray(fieldKeys) || fieldKeys.length === 0) return false;
    if (typeof name !== 'string' || !name) return false;
    if (isStoreWriteBlocked(knowledgeCountersSchema.id)) {
        console.warn('[MWT:Knowledge] Dossier field-status write refused — the counters store is paused for this chat (schema preparation); the previous value was kept.');
        return false;
    }
    const current = meta[COUNTERS_META_KEY];
    const existingRaw = current?.[DOSSIER_STATUS_SUBKEY];
    const existing = (existingRaw && typeof existingRaw === 'object' && !Array.isArray(existingRaw)) ? existingRaw : {};
    const npcStamps = { ...((existing[name] && typeof existing[name] === 'object') ? existing[name] : {}) };
    for (const key of fieldKeys) {
        if (typeof key !== 'string' || !key) continue;
        npcStamps[key] = { at, msgIdx };
    }
    const next = prepareNextStoreValue(knowledgeCountersSchema, current, {
        [DOSSIER_STATUS_SUBKEY]: { ...existing, [name]: npcStamps },
    });
    if (!next.ok) {
        console.warn('[MWT:Knowledge] Dossier field-status write refused — the proposed update failed schema validation; the previous value was kept.', next.issues);
        return false;
    }
    meta[COUNTERS_META_KEY] = next.data;
    persistChatMeta();
    return true;
}

/**
 * Drop one NPC's watermarks (called when the NPC is removed from the registry,
 * beside deleteEvidenceFile) so the map doesn't accumulate orphaned entries.
 * Refused (returns false, previous value kept) while the counters store is
 * paused — the same §8/§12 write-seam contract as recordDossierFieldRefresh
 * and saveEvidenceMap's delete path: a delete is a store write too.
 *
 * @param {string} name
 * @returns {boolean} true when something was removed
 */
export function deleteDossierFieldStatus(name) {
    const meta = getChatMeta();
    if (!meta) return false;
    if (isStoreWriteBlocked(knowledgeCountersSchema.id)) {
        console.warn('[MWT:Knowledge] Dossier field-status cleanup refused — the counters store is paused for this chat (schema preparation); the previous value was kept.');
        return false;
    }
    const current = meta[COUNTERS_META_KEY];
    const existing = current?.[DOSSIER_STATUS_SUBKEY];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing) || !(name in existing)) return false;
    const nextMap = { ...existing };
    delete nextMap[name];
    // An emptied map and an absent sub-key read identically (both → "nothing
    // tracked yet"), so simply write the shrunk map back through the seam.
    const next = prepareNextStoreValue(knowledgeCountersSchema, current, {
        [DOSSIER_STATUS_SUBKEY]: nextMap,
    });
    if (!next.ok) {
        console.warn('[MWT:Knowledge] Dossier field-status cleanup refused; the previous value was kept.', next.issues);
        return false;
    }
    meta[COUNTERS_META_KEY] = next.data;
    persistChatMeta();
    return true;
}

// ─── Rename / merge support (TODO §1 entity identity service) ────────────────

/**
 * Move one NPC's per-field dossier watermarks to a new name (user-approved
 * rename). Same write-seam contract as the functions above: refused (previous
 * value kept) while the counters store is paused.
 *
 * @param {string} oldName
 * @param {string} newName
 * @returns {{ok:boolean, reason?:string, moved:boolean}} — `target-exists`
 *   refuses rather than overwrite a destination NPC's watermarks.
 */
export function renameDossierFieldStatus(oldName, newName) {
    const meta = getChatMeta();
    if (!meta) return { ok: false, reason: 'no-metadata', moved: false };
    if (isStoreWriteBlocked(knowledgeCountersSchema.id)) {
        console.warn('[MWT:Knowledge] Dossier field-status rename refused — the counters store is paused for this chat (schema preparation); the previous value was kept.');
        return { ok: false, reason: 'paused', moved: false };
    }
    const current = meta[COUNTERS_META_KEY];
    const existing = current?.[DOSSIER_STATUS_SUBKEY];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing) || !(oldName in existing)) {
        return { ok: true, moved: false };
    }
    if (newName in existing) return { ok: false, reason: 'target-exists', moved: false };
    const nextMap = { ...existing, [newName]: existing[oldName] };
    delete nextMap[oldName];
    const next = prepareNextStoreValue(knowledgeCountersSchema, current, {
        [DOSSIER_STATUS_SUBKEY]: nextMap,
    });
    if (!next.ok) {
        console.warn('[MWT:Knowledge] Dossier field-status rename refused; the previous value was kept.', next.issues);
        return { ok: false, reason: 'validation-refused', moved: false };
    }
    meta[COUNTERS_META_KEY] = next.data;
    persistChatMeta();
    return { ok: true, moved: true };
}

/**
 * Merge one NPC's per-field dossier watermarks into another's (user-approved
 * merge). The keep NPC's stamps win; fields it never tracked are filled from
 * the absorbed NPC's map so staleness history is not silently reset.
 *
 * @param {string} keepName
 * @param {string} mergeName
 * @returns {{ok:boolean, reason?:string, merged:boolean, fieldsFilled?:number}}
 */
export function mergeDossierFieldStatus(keepName, mergeName) {
    const meta = getChatMeta();
    if (!meta) return { ok: false, reason: 'no-metadata', merged: false };
    if (isStoreWriteBlocked(knowledgeCountersSchema.id)) {
        console.warn('[MWT:Knowledge] Dossier field-status merge refused — the counters store is paused for this chat (schema preparation); the previous value was kept.');
        return { ok: false, reason: 'paused', merged: false };
    }
    const current = meta[COUNTERS_META_KEY];
    const existing = current?.[DOSSIER_STATUS_SUBKEY];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing) || !(mergeName in existing)) {
        return { ok: true, merged: false };
    }
    // Keep's stamps win; fields keep never tracked are filled from the
    // absorbed NPC's map (spread order: merge's first, keep's layered on top).
    const keepStamps = (existing[keepName] && typeof existing[keepName] === 'object') ? existing[keepName] : {};
    const mergeStamps = (existing[mergeName] && typeof existing[mergeName] === 'object') ? existing[mergeName] : {};
    const merged = { ...existing, [keepName]: { ...mergeStamps, ...keepStamps } };
    delete merged[mergeName];
    const fieldsFilled = Object.keys(mergeStamps).filter(k => !(k in keepStamps)).length;
    const next = prepareNextStoreValue(knowledgeCountersSchema, current, {
        [DOSSIER_STATUS_SUBKEY]: merged,
    });
    if (!next.ok) {
        console.warn('[MWT:Knowledge] Dossier field-status merge refused; the previous value was kept.', next.issues);
        return { ok: false, reason: 'validation-refused', merged: false };
    }
    meta[COUNTERS_META_KEY] = next.data;
    persistChatMeta();
    return { ok: true, merged: true, fieldsFilled };
}

