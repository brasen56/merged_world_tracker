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
    resolveRegistryKey,
} from './registry.js';
import {
    formatMinorEntry, formatMajorEntry,
    synthesizeMinorFromUpdate, synthesizeMajorFromUpdate,
    formatDossierEntry, synthesizeDossierFromUpdate,
    writeToLorebook,
    loadEntryContent, getHistory,
} from './lorebook.js';
import { getLorebookName, getStateLorebookName } from './scope.js';
import { isStoreEntry } from './store.js';

// ─── Staging helpers ─────────────────────────────────────────────────────────

export const STAGING_PLACEHOLDERS = ['(Fetch to see changes)', '(promoting)', '(demoting)'];

export function buildStagingItems(scanResult) {
    const registry = getRegistry();
    const items = [];
    const makeId = () => `kt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let misclassifiedCount = 0;
    // Dossier mode is determined by the scan result flag (set in runScan).
    const dossierMode = scanResult.dossierMode === true;

    scanResult.new_minor.forEach(data => {
        const proposed = formatMinorEntry(data);
        items.push({ id: makeId(), type: 'minor', action: 'create', name: data.name, data, proposedContent: proposed, mergedContent: proposed, existingContent: null, keywords: [data.name] });
    });
    scanResult.new_major.forEach(data => {
        const proposed = dossierMode ? formatDossierEntry(data) : formatMajorEntry(data);
        items.push({ id: makeId(), type: 'major', action: 'create', name: data.name, data, proposedContent: proposed, mergedContent: proposed, existingContent: null, keywords: [data.name], dossierMode });
    });
    scanResult.update_minor.forEach(data => {
        // KNOWLEDGE-03: Resolve the name through resolveRegistryKey so "Mara"
        // matches "Mara Vance" instead of creating a false orphan.
        const regKey = resolveRegistryKey(registry, data.name);
        const reg = regKey ? registry[regKey] : null;
        const orphan = !reg || reg.uid === null || reg.uid === undefined;
        if (orphan) {
            misclassifiedCount++;
            const proposed = synthesizeMinorFromUpdate(data.name, data.fields);
            items.push({ id: makeId(), type: 'minor', action: 'create', name: data.name, data, proposedContent: proposed, mergedContent: proposed, existingContent: null, keywords: [data.name], synthesized: true });
            return;
        }
        items.push({ id: makeId(), type: 'minor', action: 'update', name: data.name, data, proposedContent: '(Fetch to see changes)', existingContent: null, keywords: reg.keywords || [data.name], uid: reg.uid, fields: data.fields });
    });
    scanResult.update_major.forEach(data => {
        // KNOWLEDGE-03: Resolve the name through resolveRegistryKey so "Mara"
        // matches "Mara Vance" instead of creating a false orphan.
        const regKey = resolveRegistryKey(registry, data.name);
        const reg = regKey ? registry[regKey] : null;
        const orphan = !reg || reg.uid === null || reg.uid === undefined;
        if (orphan) {
            misclassifiedCount++;
            const syn = dossierMode
                ? synthesizeDossierFromUpdate(data.name, data.fields, data.new_knowledge || [])
                : synthesizeMajorFromUpdate(data.name, data.fields, data.new_knowledge || []);
            items.push({ id: makeId(), type: 'major', action: 'create', name: data.name, data, proposedContent: syn, mergedContent: syn, existingContent: null, keywords: [data.name], synthesized: true, dossierMode });
            return;
        }
        items.push({ id: makeId(), type: 'major', action: 'update', name: data.name, data, proposedContent: '(Fetch to see changes)', existingContent: null, keywords: reg.keywords || [data.name], uid: reg.uid, fields: data.fields, newKnowledge: data.new_knowledge || [], dossierMode });
    });
    if (misclassifiedCount > 0) {
        ktSetStatus(`${misclassifiedCount} misclassified entries converted to new proposals.`, 'info');
    }
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
 * Merge freshly-scanned staging items into the existing staging list.
 *
 * Items are keyed by `${name}|${action}|${type}`. When a scan re-detects an
 * item already staged, the new proposal replaces the old one — UNLESS the user
 * has manually edited the existing proposal (`existing.edited === true`), in
 * which case the user's edited content is preserved and only the surrounding
 * metadata (keywords, fields, uid, etc.) is refreshed. This stops a re-scan
 * from silently discarding hand-edited proposal text.
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
    const added = [];
    for (const item of newItems) {
        const key = `${item.name}|${item.action}|${item.type}`;
        const existingIdx = state.stagingItems.findIndex(it => `${it.name}|${it.action}|${it.type}` === key);
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
                content = await loadEntryContent(info.uid);
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
                let verified = false;
                try {
                    const existing = await loadEntryContent(incomingUid);
                    if (existing !== null) {
                        if (entry.content && existing.trim() !== entry.content.trim()) {
                            console.warn(
                                `[MWT:Knowledge] Import uid ${incomingUid} for "${name}" exists in local lorebook ` +
                                `but content does not match the export — dropping uid to avoid identity corruption.`
                            );
                            verified = false;
                        } else {
                            verified = true;
                        }
                    }
                } catch { /* assume not found */ }
                if (!verified) {
                    incomingUid = null;
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
                const existing = registry[name];
                if (existing && existing.uid !== null && existing.uid !== undefined) {
                    skipped.npcs++;
                    continue;
                }
                const isMajor = /knowledge ledger\s*:/i.test(entry.content || '');
                const uid = entry.uid ?? Number(uidStr);
                const finalUid = Number.isFinite(uid) ? uid : null;
                const keywords = Array.isArray(entry.key) && entry.key.length ? entry.key : [name];

                // Unlink UID from any other entry that already owns it
                if (finalUid != null) {
                    for (const [regName, regEntry] of Object.entries(registry)) {
                        if (regEntry.uid === finalUid && regName !== name) {
                            console.warn(`[MWT:Knowledge] UID ${finalUid} was owned by "${regName}", reassigning to "${name}"`);
                            registry[regName].uid = null;
                        }
                    }
                }

                registry[name] = {
                    uid: finalUid,
                    type: isMajor ? 'major' : 'minor',
                    keywords,
                    lastUpdated: Date.now(),
                };
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