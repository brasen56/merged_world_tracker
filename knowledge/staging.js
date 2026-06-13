/**
 * knowledge/staging.js — Staging item construction, import/export, and
 * lorebook auto-discovery.
 *
 * Uses dynamic import() for render functions to avoid circular deps with
 * render.js (which calls staging functions from event handlers).
 */

import { getPlayerNames, notify, downloadJson, pickTextFile } from '../core/index.js';

import {
    LOREBOOK_NAME, STATE_LOREBOOK_NAME, TRACKER_SENTINEL,
    HISTORY_KEY_PREFIX, state,
} from './state.js';
import { hasValidSettings, getSettings, saveSettings } from './settings.js';
import {
    getRegistry, saveRegistry, getAllNpcNames,
    getStateRegistry, saveStateRegistry, registerStateTracker,
} from './registry.js';
import {
    formatMinorEntry, formatMajorEntry,
    synthesizeMinorFromUpdate, synthesizeMajorFromUpdate,
    enrichStagingItem, writeToLorebook,
} from './lorebook.js';

// ─── Staging helpers ─────────────────────────────────────────────────────────

export const STAGING_PLACEHOLDERS = ['(Fetch to see changes)', '(promoting)', '(demoting)'];

export function buildStagingItems(scanResult) {
    const registry = getRegistry();
    const items = [];
    const makeId = () => `kt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let misclassifiedCount = 0;

    scanResult.new_minor.forEach(data => {
        items.push({ id: makeId(), type: 'minor', action: 'create', name: data.name, data, proposedContent: formatMinorEntry(data), existingContent: null, keywords: [data.name] });
    });
    scanResult.new_major.forEach(data => {
        items.push({ id: makeId(), type: 'major', action: 'create', name: data.name, data, proposedContent: formatMajorEntry(data), existingContent: null, keywords: [data.name] });
    });
    scanResult.update_minor.forEach(data => {
        const reg = registry[data.name];
        const orphan = !reg || reg.uid === null || reg.uid === undefined;
        if (orphan) {
            misclassifiedCount++;
            items.push({ id: makeId(), type: 'minor', action: 'create', name: data.name, data, proposedContent: synthesizeMinorFromUpdate(data.name, data.fields), existingContent: null, keywords: [data.name], synthesized: true });
            return;
        }
        items.push({ id: makeId(), type: 'minor', action: 'update', name: data.name, data, proposedContent: '(Fetch to see changes)', existingContent: null, keywords: reg.keywords || [data.name], uid: reg.uid, fields: data.fields });
    });
    scanResult.update_major.forEach(data => {
        const reg = registry[data.name];
        const orphan = !reg || reg.uid === null || reg.uid === undefined;
        if (orphan) {
            misclassifiedCount++;
            items.push({ id: makeId(), type: 'major', action: 'create', name: data.name, data, proposedContent: synthesizeMajorFromUpdate(data.name, data.fields, data.new_knowledge || []), existingContent: null, keywords: [data.name], synthesized: true });
            return;
        }
        items.push({ id: makeId(), type: 'major', action: 'update', name: data.name, data, proposedContent: '(Fetch to see changes)', existingContent: null, keywords: reg.keywords || [data.name], uid: reg.uid, fields: data.fields, newKnowledge: data.new_knowledge || [] });
    });
    if (misclassifiedCount > 0) {
        import('./render.js').then(({ ktSetStatus }) => {
            ktSetStatus(`${misclassifiedCount} misclassified entries converted to new proposals.`, 'info');
        });
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

// ─── NPC Export / Import ─────────────────────────────────────────────────────

export function exportNpcs() {
    const registry = getRegistry();
    const entries = {};
    for (const [name, info] of Object.entries(registry)) {
        entries[name] = {
            uid: info.uid ?? null,
            type: info.type || 'minor',
            keywords: info.keywords || [name],
            lastUpdated: info.lastUpdated || null,
            content: null,
            history: [],
        };
    }
    // Strip API key from export to avoid leaking credentials
    const { apiKey, ...safeSettings } = getSettings();
    const data = {
        version: 1,
        type: 'knowledge_tracker',
        exportedAt: new Date().toISOString(),
        lorebook: LOREBOOK_NAME,
        settings: safeSettings,
        entries,
    };
    downloadJson(`knowledge-tracker-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, data);
    import('./render.js').then(({ ktSetStatus }) => {
        ktSetStatus('NPC registry exported (API key excluded for security).', 'success');
    });
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

            registry[name] = {
                uid: entry.uid ?? null,
                type: entry.type || 'minor',
                keywords: entry.keywords || [name],
                lastUpdated: entry.lastUpdated || Date.now(),
            };
            imported++;

            if (entry.content && state.wiScript && entry.uid == null) {
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
                    const key = HISTORY_KEY_PREFIX + finalUid;
                    localStorage.setItem(key, JSON.stringify(entry.history));
                } catch { /* quota */ }
            }
        }

        saveRegistry(registry);

        // Trigger re-render
        const { renderNpcsSubTab, ktSetStatus } = await import('./render.js');
        renderNpcsSubTab();

        let msg = `Imported ${imported} NPC(s).`;
        if (skipped > 0) msg += ` ${skipped} already tracked (skipped).`;
        if (settingsImported) msg += ' Settings restored.';
        ktSetStatus(msg, 'success');
    } catch (err) {
        const { ktSetStatus } = await import('./render.js');
        ktSetStatus(`Import failed: ${err.message}`, 'error');
    }
}

// ─── Lorebook scan (auto-discover existing entries) ─────────────────────────

export async function importFromLorebooks() {
    if (!state.wiScript) {
        const { ktSetStatus } = await import('./render.js');
        ktSetStatus('World-info script not available.', 'error');
        return;
    }

    let imported = { npcs: 0, states: 0 };
    let skipped  = { npcs: 0, states: 0 };
    const errors = [];

    // ── Knowledge Tracker ───────────────────────────────────────────────
    try {
        const ktWi = await state.wiScript.loadWorldInfo(LOREBOOK_NAME);
        if (ktWi?.entries) {
            const registry = getRegistry();
            const playerSet = getPlayerNames();

            for (const [uidStr, entry] of Object.entries(ktWi.entries)) {
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
                const keywords = Array.isArray(entry.key) && entry.key.length ? entry.key : [name];
                registry[name] = {
                    uid: Number.isFinite(uid) ? uid : null,
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
        const stWi = await state.wiScript.loadWorldInfo(STATE_LOREBOOK_NAME);
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
    const { renderNpcsSubTab, ktSetStatus } = await import('./render.js');
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