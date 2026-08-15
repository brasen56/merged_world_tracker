/**
 * knowledge/staging.js — Staging item construction, import/export, and
 * lorebook auto-discovery.
 *
 * Uses dynamic import() for render functions to avoid circular deps with
 * render.js (which calls staging functions from event handlers).
 */

import { getPlayerNames, getUserNames, notify, downloadJson, pickTextFile } from '../core/index.js';

import {
    TRACKER_SENTINEL,
    HISTORY_KEY_PREFIX, state, ktSetStatus,
} from './state.js';
import { getSettings, saveSettings } from './settings.js';
import {
    getRegistry, saveRegistry,
    getStateRegistry, saveStateRegistry,
    resolveRegistryKey, normalizeRegistryName,
} from './registry.js';
import {
    formatMinorEntry, formatMajorEntry,
    synthesizeMinorFromUpdate, synthesizeMajorFromUpdate,
    formatDossierEntry, synthesizeDossierFromUpdate,
    writeToLorebook,
    loadEntryContent, getHistory,
    fieldsFromScanRecord,
} from './lorebook.js';
import { getLorebookName, getStateLorebookName } from './scope.js';
import { isStoreEntry } from './store.js';
import { reconcileImportedUid } from './reconcile.js';

// ─── Staging helpers ─────────────────────────────────────────────────────────

export const STAGING_PLACEHOLDERS = ['(Fetch to see changes)', '(promoting)', '(demoting)'];

/**
 * Union of keyword lists, case-insensitively deduped, order preserved.
 *
 * A reclassified proposal used to keep only the registry's existing keywords,
 * so an entry tracked as "Sophie" never gained "Sophie Simpson" — the exact
 * spelling the prose used and the scan reacted to. The entry then failed to
 * trigger on the text that mentions her.
 *
 * @param {...(string[]|string|null|undefined)} lists
 * @returns {string[]}
 */
export function mergeKeywords(...lists) {
    const out = [];
    const seen = new Set();
    for (const list of lists) {
        for (const raw of (Array.isArray(list) ? list : [list])) {
            const s = String(raw ?? '').trim();
            if (!s) continue;
            const n = s.toLowerCase();
            if (seen.has(n)) continue;
            seen.add(n);
            out.push(s);
        }
    }
    return out;
}

/**
 * The type a proposal for an ALREADY-TRACKED NPC must carry.
 *
 * The registry's recorded type wins over the scan's classification. The scan
 * re-decides minor/major from the recent messages alone, so a tracked major
 * who had a quiet scene comes back as `new_minor`/`update_minor` — and because
 * the accept paths write `item.type` straight into the registry, that silently
 * DEMOTED her and merged her dossier with the compact-entry merger. The
 * converse (a minor implicitly promoted) loses nothing but is equally
 * unintended. Type changes belong to the explicit ↑/↓ buttons, which stage a
 * 'promote'/'demote' item and never reach this helper.
 *
 * @param {object} reg — the NPC's registry record
 * @param {string} scannedType — the category the scan put them in
 * @returns {string} 'minor' | 'major'
 */
export function trackedType(reg, scannedType) {
    return (reg?.type === 'major' || reg?.type === 'minor') ? reg.type : scannedType;
}

export function buildStagingItems(scanResult) {
    const registry = getRegistry();
    const items = [];
    const makeId = () => `kt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let misclassifiedCount = 0;
    let reclassifiedCount = 0;
    let typeKeptCount = 0;
    // Dossier mode is determined by the scan result flag (set in runScan).
    const dossierMode = scanResult.dossierMode === true;

    // CANONICAL-IDENTITY BOUNDARY (every category runs it now, including new_*).
    // The scan prompt tells the model an update name must match a tracked name
    // exactly, so when messages say "Sophie Simpson" and the registry says
    // "Sophie", the model is INSTRUCTED to classify her as new. Accepting that
    // proposal used to create a second physical entry and record the model's
    // spelling as a second registry identity — the alias pile-up. Instead:
    //   - unambiguous alias of a TRACKED (uid'd) NPC → reclassify as an update
    //     under the canonical key, so it merges into the existing entry;
    //   - unambiguous alias of an ORPHAN (uid-less) identity → create under
    //     the canonical key, so accepting repairs that registry record;
    //   - no match → genuinely new; the model's spelling stands.
    // resolveRegistryKey refuses ambiguous given-name matches, so two Sophies
    // in the registry never collapse into each other.
    const canonical = (name) => {
        const key = resolveRegistryKey(registry, name);
        return key != null ? { key, reg: registry[key] } : null;
    };

    // Build the staging item for a new_* record that turned out to describe an
    // ALREADY-TRACKED NPC. The registry's type wins (see trackedType) and every
    // applicable field is carried across (see fieldsFromScanRecord) — the old
    // conversion hardcoded 'minor'/'major' from the scan category and copied
    // only tone/perceived_as/descriptor, so a tracked major returned as
    // new_minor was demoted and her role, appearance, secrets and agenda were
    // dropped on the floor.
    const reclassified = (data, known, scannedType) => {
        const type = trackedType(known.reg, scannedType);
        const keywords = mergeKeywords(known.reg.keywords, known.key, data.name);
        const fields = fieldsFromScanRecord(data, type);
        const newKnowledge = data.initial_knowledge || data.new_knowledge || [];
        const tracked = known.reg.uid !== null && known.reg.uid !== undefined;
        if (tracked) {
            return {
                id: makeId(), type, action: 'update', name: known.key, data,
                proposedContent: '(Fetch to see changes)', existingContent: null,
                keywords, uid: known.reg.uid, fields,
                ...(type === 'major' ? { newKnowledge, dossierMode } : {}),
                reclassified: true, typeFromRegistry: type !== scannedType,
            };
        }
        // Orphan (uid-less) identity: create under the canonical key so
        // accepting repairs the record. enrichStagingItem promotes this to an
        // update if the physical entry actually still exists.
        const named = { ...data, name: known.key };
        const proposed = type === 'major'
            ? (dossierMode ? formatDossierEntry(named) : formatMajorEntry(named))
            : formatMinorEntry(named);
        return {
            id: makeId(), type, action: 'create', name: known.key, data,
            proposedContent: proposed, mergedContent: proposed, existingContent: null,
            keywords, ...(type === 'major' ? { dossierMode } : {}),
            reclassified: true, typeFromRegistry: type !== scannedType,
        };
    };

    scanResult.new_minor.forEach(data => {
        const known = canonical(data.name);
        if (known) {
            reclassifiedCount++;
            const item = reclassified(data, known, 'minor');
            if (item.typeFromRegistry) typeKeptCount++;
            items.push(item);
            return;
        }
        const proposed = formatMinorEntry(data);
        items.push({ id: makeId(), type: 'minor', action: 'create', name: data.name, data, proposedContent: proposed, mergedContent: proposed, existingContent: null, keywords: [data.name] });
    });
    scanResult.new_major.forEach(data => {
        const known = canonical(data.name);
        if (known) {
            reclassifiedCount++;
            const item = reclassified(data, known, 'major');
            if (item.typeFromRegistry) typeKeptCount++;
            items.push(item);
            return;
        }
        const proposed = dossierMode ? formatDossierEntry(data) : formatMajorEntry(data);
        items.push({ id: makeId(), type: 'major', action: 'create', name: data.name, data, proposedContent: proposed, mergedContent: proposed, existingContent: null, keywords: [data.name], dossierMode });
    });
    scanResult.update_minor.forEach(data => {
        // KNOWLEDGE-03: Resolve the name through resolveRegistryKey so "Mara"
        // matches "Mara Vance" instead of creating a false orphan.
        const regKey = resolveRegistryKey(registry, data.name);
        const reg = regKey ? registry[regKey] : null;
        const orphan = !reg || reg.uid === null || reg.uid === undefined;
        // The registry's type wins here too: the scan re-decides minor/major
        // every run, so a tracked major who had a quiet scene comes back as
        // update_minor — and the accept paths write item.type straight into
        // the registry. Without this she is silently demoted and merged with
        // the compact-entry merger instead of the dossier one.
        const type = trackedType(reg, 'minor');
        const keywords = mergeKeywords(reg && reg.keywords, regKey, data.name);
        if (orphan) {
            misclassifiedCount++;
            // Canonical spelling when one exists: the synthesized create must
            // repair the registry identity, not fork it with the model's
            // spelling (which would also fail writeToLorebook's label check).
            const name = regKey || data.name;
            const proposed = type === 'major'
                ? (dossierMode
                    ? synthesizeDossierFromUpdate(name, data.fields, data.new_knowledge || [])
                    : synthesizeMajorFromUpdate(name, data.fields, data.new_knowledge || []))
                : synthesizeMinorFromUpdate(name, data.fields);
            items.push({ id: makeId(), type, action: 'create', name, data, proposedContent: proposed, mergedContent: proposed, existingContent: null, keywords, synthesized: true, ...(type === 'major' ? { dossierMode } : {}) });
            return;
        }
        if (type !== 'minor') typeKeptCount++;
        // item.name is the CANONICAL key, not the model's spelling — accepting
        // re-labels the entry consistently and passes writeToLorebook's
        // KNOWLEDGE-01 comment check instead of detaching a valid uid.
        items.push({ id: makeId(), type, action: 'update', name: regKey, data, proposedContent: '(Fetch to see changes)', existingContent: null, keywords, uid: reg.uid, fields: data.fields, ...(type === 'major' ? { newKnowledge: data.new_knowledge || [], dossierMode } : {}) });
    });
    scanResult.update_major.forEach(data => {
        // KNOWLEDGE-03: Resolve the name through resolveRegistryKey so "Mara"
        // matches "Mara Vance" instead of creating a false orphan.
        const regKey = resolveRegistryKey(registry, data.name);
        const reg = regKey ? registry[regKey] : null;
        const orphan = !reg || reg.uid === null || reg.uid === undefined;
        const type = trackedType(reg, 'major');
        const keywords = mergeKeywords(reg && reg.keywords, regKey, data.name);
        if (orphan) {
            misclassifiedCount++;
            const name = regKey || data.name;
            const syn = type === 'major'
                ? (dossierMode
                    ? synthesizeDossierFromUpdate(name, data.fields, data.new_knowledge || [])
                    : synthesizeMajorFromUpdate(name, data.fields, data.new_knowledge || []))
                : synthesizeMinorFromUpdate(name, data.fields);
            items.push({ id: makeId(), type, action: 'create', name, data, proposedContent: syn, mergedContent: syn, existingContent: null, keywords, synthesized: true, ...(type === 'major' ? { dossierMode } : {}) });
            return;
        }
        if (type !== 'major') typeKeptCount++;
        items.push({ id: makeId(), type, action: 'update', name: regKey, data, proposedContent: '(Fetch to see changes)', existingContent: null, keywords, uid: reg.uid, fields: data.fields, ...(type === 'major' ? { newKnowledge: data.new_knowledge || [], dossierMode } : {}) });
    });
    const notes = [];
    if (reclassifiedCount > 0) notes.push(`${reclassifiedCount} proposal(s) reclassified — the NPC is already tracked under another spelling.`);
    if (misclassifiedCount > 0) notes.push(`${misclassifiedCount} misclassified entries converted to new proposals.`);
    if (typeKeptCount > 0) notes.push(`${typeKeptCount} kept their tracked minor/major type — use ↑/↓ to change it deliberately.`);
    if (notes.length > 0) ktSetStatus(notes.join(' '), 'info');
    return items;
}

export function formatHistoryAge(ts) {
    const seconds = Math.floor((Date.now() - ts) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * Canonical staging identity: the key two proposals must share to be treated
 * as the same staged NPC. The model's spelling is NOT an identity — a re-scan
 * that says "Sophie Simpson" must replace the staged "Sophie" proposal, not
 * stack beside it. Strictest-first:
 *   1. the physical entry uid (updates/promotes/demotes — same uid is
 *      unambiguously the same NPC);
 *   2. the registry key the name resolves to (covers alias spellings of an
 *      already-tracked NPC, both directions);
 *   3. the normalized name (case/whitespace-insensitive only — two spellings
 *      of an UNTRACKED npc cannot be proven the same person, so they stay
 *      separate proposals rather than risk merging two strangers).
 *
 * @param {object} item — a staging item (new or already staged)
 * @param {object} registry — the current NPC registry
 * @returns {string}
 */
function stagingIdentityKey(item, registry) {
    if (item.uid !== null && item.uid !== undefined) return `uid:${item.uid}`;
    const regKey = registry ? resolveRegistryKey(registry, item.name) : null;
    return `name:${regKey ?? normalizeRegistryName(item.name)}`;
}

/**
 * Merge freshly-scanned staging items into the existing staging list.
 *
 * Items are keyed by canonical identity ALONE — uid, then registry key, then
 * normalized name (see {@link stagingIdentityKey}) — so a re-scan that spells
 * an NPC differently, or re-classifies them minor↔major, replaces the earlier
 * proposal for the SAME NPC instead of stacking a second one. When a scan
 * re-detects an item already staged, the
 * new proposal replaces the old one — UNLESS the user has manually edited the
 * existing proposal (`existing.edited === true`), in which case the user's
 * edited content is preserved and only the surrounding metadata (keywords,
 * fields, uid, etc.) is refreshed. This stops a re-scan from silently
 * discarding hand-edited proposal text.
 *
 * When a non-edited proposal is superseded by a newer one, the outgoing
 * proposal text is preserved in a `supersededContent` array so the user can
 * review what was replaced (it appears in the staging detail panel). This
 * prevents silent data loss when a re-scan fires while proposals are pending.
 *
 * @param {Array} newItems                   proposals from buildStagingItems()
 * @param {(id: string) => void} removeNotification  removes a notification entry by id
 * @returns {Array} the items now staged for these proposals (for enrichment/notification)
 */
export function mergeScanResults(newItems, removeNotification) {
    const registry = getRegistry();
    const identityOf = (item) => stagingIdentityKey(item, registry);
    const added = [];
    for (const item of newItems) {
        // Identity ALONE — no action, no type. Including them let one uid hold
        // a 'minor update' and a 'major update' proposal at once, which is two
        // staged proposals for one NPC and two writes to one entry: exactly
        // what canonical-identity dedup is supposed to prevent. One NPC = one
        // staged proposal, newest wins; the outgoing text is kept in
        // supersededContent and is restorable from the staging panel, so a
        // pending promote/demote that a fresh scan supersedes is recoverable.
        const key = identityOf(item);
        const existingIdx = state.stagingItems.findIndex(it => identityOf(it) === key);
        let stored;
        if (existingIdx >= 0) {
            const existing = state.stagingItems[existingIdx];
            removeNotification(existing.id);
            if (existing.edited) {
                // Keep the user's edits as the source of truth; refresh metadata only.
                stored = {
                    ...item,
                    id: existing.id,
                    edited: true,
                    mergedContent: existing.mergedContent,
                    proposedContent: existing.mergedContent || existing.proposedContent,
                    existingContent: existing.existingContent ?? item.existingContent,
                };
            } else {
                // Preserve the outgoing proposal text so the user can see what
                // was replaced by the new scan. Stack prior superseded entries
                // too, so nothing is lost across multiple re-scans.
                const priorSuperseded = Array.isArray(existing.supersededContent) ? existing.supersededContent : [];
                const outgoingContent = existing.mergedContent || existing.proposedContent;
                stored = {
                    ...item,
                    id: existing.id,
                    supersededContent: outgoingContent
                        ? [...priorSuperseded, { content: outgoingContent, timestamp: Date.now() }]
                        : priorSuperseded,
                };
            }
            state.stagingItems[existingIdx] = stored;
        } else {
            state.stagingItems.push(item);
            stored = item;
        }
        added.push(stored);
    }
    return added;
}

// ─── NPC Export / Import ─────────────────────────────────────────────────────

export async function exportNpcs() {
    const registry = getRegistry();
    const entries = {};
    for (const [name, info] of Object.entries(registry)) {
        // Load the actual lorebook entry content and history so the export is
        // self-contained — a registry-only export (content: null) imported on
        // another install would carry raw uids that point at different (or no)
        // entries in the destination lorebook.
        let content = null;
        let history = [];
        if (info.uid != null) {
            try {
                // Label-verified: a stale uid pointing at another NPC's entry
                // exports as content: null rather than another character's text.
                content = await loadEntryContent(info.uid, name);
            } catch { /* entry may not exist */ }
            try {
                history = getHistory(info.uid, getLorebookName());
            } catch { /* ignore */ }
        }
        entries[name] = {
            uid: info.uid ?? null,
            type: info.type || 'minor',
            keywords: info.keywords || [name],
            lastUpdated: info.lastUpdated || null,
            content,
            history,
        };
    }
    // Strip API key from export to avoid leaking credentials
    const { apiKey, ...safeSettings } = getSettings();
    const data = {
        version: 1,
        type: 'knowledge_tracker',
        exportedAt: new Date().toISOString(),
        lorebook: getLorebookName(),
        settings: safeSettings,
        entries,
    };
    downloadJson(`knowledge-tracker-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, data);
    ktSetStatus('NPC registry exported (API key excluded for security).', 'success');
}

export async function importNpcs() {
    const text = await pickTextFile('.json');
    if (!text) return;
    try {
        const data = JSON.parse(text);

        if (!data.entries || typeof data.entries !== 'object') {
            throw new Error('Invalid format: missing "entries" object.');
        }

        let imported = 0;
        let skipped = 0;
        let settingsImported = false;
        const registry = getRegistry();

        // Import settings if present
        if (data.settings && data.type === 'knowledge_tracker') {
            if (confirm('Import settings too? (API URL, key, model, etc.)')) {
                saveSettings({ ...getSettings(), ...data.settings });
                settingsImported = true;
            }
        }

        for (const [name, entry] of Object.entries(data.entries)) {
            if (registry[name] && registry[name].uid !== null && registry[name].uid !== undefined) {
                skipped++;
                continue;
            }

            let incomingUid = entry.uid ?? null;

            // When a uid is present, verify it against the local lorebook.
            // An exported uid from another install may point at a different
            // (or non-existent) entry here. Previously this only checked that
            // *some* entry existed at that uid — not that it matched the
            // exported NPC. Two NPCs could silently end up sharing the wrong
            // dossier content because the content-write branch only fires
            // when `incomingUid == null`.
            //
            // Now we also compare the existing entry's content against the
            // exported content. If they differ significantly, the uid points
            // at a different NPC's entry — drop it so the correct content is
            // written as a new entry instead.
            if (incomingUid != null && state.wiScript) {
                const originalUid = incomingUid;
                incomingUid = await reconcileImportedUid(incomingUid, entry.content, loadEntryContent);
                if (incomingUid === null) {
                    console.warn(
                        `[MWT:Knowledge] Import uid ${originalUid} for "${name}" could not be verified in the local ` +
                        'lorebook — dropping it to avoid identity corruption.'
                    );
                }
            }

            if (incomingUid != null) {
                for (const [regName, regEntry] of Object.entries(registry)) {
                    if (regEntry.uid === incomingUid && regName !== name) {
                        console.warn(`[MWT:Knowledge] Import UID ${incomingUid} was owned by "${regName}", reassigning to "${name}"`);
                        registry[regName].uid = null;
                    }
                }
            }

            registry[name] = {
                uid: incomingUid,
                type: entry.type || 'minor',
                keywords: entry.keywords || [name],
                lastUpdated: entry.lastUpdated || Date.now(),
            };
            imported++;

            // If the uid was dropped (or was never present) but content is
            // available, write it as a new entry in the local lorebook.
            if (entry.content && state.wiScript && incomingUid == null) {
                try {
                    const result = await writeToLorebook(name, entry.content, entry.keywords || [name], null);
                    if (result.success) {
                        registry[name].uid = result.uid;
                    }
                } catch (err) {
                    console.warn(`[MWT:Knowledge] Import write failed for "${name}":`, err.message);
                }
            }

            const finalUid = registry[name].uid;
            if (entry.history && Array.isArray(entry.history) && entry.history.length > 0 && finalUid != null) {
                try {
                    const key = HISTORY_KEY_PREFIX + getLorebookName() + '_' + finalUid;
                    localStorage.setItem(key, JSON.stringify(entry.history));
                } catch { /* quota */ }
            }
        }

        saveRegistry(registry);

        // Trigger re-render
        const { renderNpcsSubTab } = await import('./render.js');
        renderNpcsSubTab();

        let msg = `Imported ${imported} NPC(s).`;
        if (skipped > 0) msg += ` ${skipped} already tracked (skipped).`;
        if (settingsImported) msg += ' Settings restored.';
        ktSetStatus(msg, 'success');
    } catch (err) {
        ktSetStatus(`Import failed: ${err.message}`, 'error');
    }
}

// ─── Lorebook scan (auto-discover existing entries) ─────────────────────────

export async function importFromLorebooks() {
    if (!state.wiScript) {
        ktSetStatus('World-info script not available.', 'error');
        return;
    }

    const imported = { npcs: 0, states: 0 };
    const skipped  = { npcs: 0, states: 0 };
    const errors = [];

    // ── Knowledge Tracker ───────────────────────────────────────────────
    try {
        const ktWi = await state.wiScript.loadWorldInfo(getLorebookName());
        if (ktWi?.entries) {
            const registry = getRegistry();
            // Respect the trackMainCharAsNpc setting: when ON, only the human
            // user is excluded so the AI cast ({{char}} and group members) can
            // be imported as tracked NPCs too.
            const playerSet = getSettings().trackMainCharAsNpc ? getUserNames() : getPlayerNames();

            for (const [uidStr, entry] of Object.entries(ktWi.entries)) {
                // The module's own bookkeeping entry is not an NPC.
                if (isStoreEntry(entry)) continue;
                const name = String(entry.comment || '').trim();
                if (!name) continue;
                if (playerSet.has(name.toLowerCase())) continue;
                // Canonical check: an entry whose label is an unambiguous alias
                // of a tracked NPC must not become a SECOND registry identity.
                // The old exact `registry[name]` lookup let "Sophie Simpson"
                // slip past a "Sophie" record, preserving the alias duplicate
                // this import exists to repair.
                const canonKey = resolveRegistryKey(registry, name);
                const existing = canonKey != null ? registry[canonKey] : null;
                if (existing && existing.uid !== null && existing.uid !== undefined) {
                    skipped.npcs++;
                    continue;
                }
                const isMajor = /knowledge ledger\s*:/i.test(entry.content || '');
                const uid = entry.uid ?? Number(uidStr);
                const finalUid = Number.isFinite(uid) ? uid : null;
                const keywords = Array.isArray(entry.key) && entry.key.length ? entry.key : [name];
                // Where this entry lands in the registry: an existing canonical
                // record (repairing its missing uid) or a brand-new identity.
                const targetKey = canonKey != null && registry[canonKey] ? canonKey : name;

                // Unlink UID from any other entry that already owns it
                if (finalUid != null) {
                    for (const [regName, regEntry] of Object.entries(registry)) {
                        if (regEntry.uid === finalUid && regName !== targetKey) {
                            console.warn(`[MWT:Knowledge] UID ${finalUid} was owned by "${regName}", reassigning to "${targetKey}"`);
                            registry[regName].uid = null;
                        }
                    }
                }

                if (targetKey !== name && registry[targetKey]) {
                    // Repair the canonical record in place: fill the missing
                    // uid and adopt the physical entry's keywords. Type is left
                    // alone — relinking is not reclassification.
                    registry[targetKey].uid = finalUid;
                    registry[targetKey].keywords = keywords;
                    registry[targetKey].lastUpdated = Date.now();
                } else {
                    registry[targetKey] = {
                        uid: finalUid,
                        type: isMajor ? 'major' : 'minor',
                        keywords,
                        lastUpdated: Date.now(),
                    };
                }
                imported.npcs++;
            }
            saveRegistry(registry);
        }
    } catch (err) {
        errors.push(`Knowledge Tracker: ${err.message}`);
    }

    // ── State Tracker ───────────────────────────────────────────────────
    try {
        const stWi = await state.wiScript.loadWorldInfo(getStateLorebookName());
        if (stWi?.entries) {
            const stateReg = getStateRegistry();

            for (const [uidStr, entry] of Object.entries(stWi.entries)) {
                const comment = String(entry.comment || '').trim();
                if (!comment.startsWith(TRACKER_SENTINEL)) continue;
                const displayName = comment.slice(TRACKER_SENTINEL.length).trim() || `Tracker ${uidStr}`;
                if (stateReg[displayName]) {
                    skipped.states++;
                    continue;
                }
                const uid = entry.uid ?? Number(uidStr);
                stateReg[displayName] = {
                    uid: Number.isFinite(uid) ? uid : null,
                    lastUpdatedMsg: 0,
                    lastUpdatedAt: 0,
                    enabled: true,
                    alwaysUpdate: false,
                };
                imported.states++;
            }
            saveStateRegistry(stateReg);
        }
    } catch (err) {
        errors.push(`State Tracker: ${err.message}`);
    }

    // ── Report ──────────────────────────────────────────────────────────
    const { renderNpcsSubTab } = await import('./render.js');
    renderNpcsSubTab();

    const parts = [];
    if (imported.npcs)   parts.push(`${imported.npcs} NPC(s)`);
    if (imported.states) parts.push(`${imported.states} state tracker(s)`);
    let msg = parts.length ? `Imported ${parts.join(' and ')}.` : 'Nothing new to import.';
    if (skipped.npcs + skipped.states > 0) msg += ` (${skipped.npcs + skipped.states} already tracked.)`;
    if (errors.length) msg += ` Errors: ${errors.join('; ')}`;
    ktSetStatus(msg, errors.length ? 'error' : 'success');
    notify('Knowledge Tracker', msg, parts.length ? 'success' : 'info');
}