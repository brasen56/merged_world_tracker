/**
 * chronicle/import-export.js — Export and import chronicle data.
 */

import {
    downloadJson, downloadBlob, pickTextFile,
} from '../core/index.js';

import {
    state, SC_VERSION,
    getChronicleData, setChronicleData, getSnapshots,
    scSetStatus,
    _render,
} from './data.js';

import { applyInjection, isInjectionEnabled } from './injection.js';

// ─── Export / Import ─────────────────────────────────────────────────────────

export function exportChronicle() {
    const cd = getChronicleData();
    const data = {
        snapshots: getSnapshots(),
        lastAnchor: cd.lastAnchor,
        injectEnabled: isInjectionEnabled(),
        injectCount: cd.injectCount || 2,
        injectDepth: cd.injectDepth || 2,
        msgSinceSnapshot: state.msgSinceSnapshot,
        exportedAt: new Date().toISOString(),
        version: SC_VERSION,
    };
    downloadJson(`chronicle-${Date.now()}.json`, data);
    scSetStatus('Exported.', 'success');
}

export function exportMarkdown() {
    const snapshots = getSnapshots().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    let md = `# Session Chronicle\n\n*Exported: ${new Date().toLocaleString()}*\n\n---\n\n`;
    snapshots.forEach((s, i) => {
        md += `## ${s.manual ? 'Manual' : s.consolidated ? 'Consolidated' : `#${i + 1}`}: ${s.worldDate || s.createdAt}\n\n${s.text}\n\n---\n\n`;
    });
    downloadBlob(`chronicle-${new Date().toISOString().slice(0, 10)}.md`, new Blob([md], { type: 'text/markdown' }));
    scSetStatus('Exported as Markdown.', 'success');
}

export async function triggerImport() {
    const text = await pickTextFile('.json');
    if (text) importChronicle(text);
}

function importChronicle(jsonString) {
    try {
        const parsed = JSON.parse(jsonString);
        if (!parsed.snapshots || !Array.isArray(parsed.snapshots)) throw new Error('Invalid: missing snapshots.');
        const existing = getSnapshots();
        const existingIds = new Set(existing.map(s => s.id));
        let added = 0;
        const merged = [...existing];
        for (const snap of parsed.snapshots) {
            if (!existingIds.has(snap.id)) { merged.push({ ...snap, id: snap.id || `imp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }); added++; }
        }
        merged.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

        // Restore lastAnchor and msgSinceSnapshot (data), but skip injection settings
        // (session config) to avoid silently overwriting the user's current preferences
        const patch = { snapshots: merged, suggestSent: false };
        if (parsed.lastAnchor) patch.lastAnchor = parsed.lastAnchor;
        if (typeof parsed.msgSinceSnapshot === 'number' && Number.isFinite(parsed.msgSinceSnapshot)) {
            patch.msgSinceSnapshot = parsed.msgSinceSnapshot;
            state.msgSinceSnapshot = parsed.msgSinceSnapshot;
        }
        if (parsed.injectEnabled !== undefined || parsed.injectCount !== undefined || parsed.injectDepth !== undefined) {
            const restoreInjection = confirm('Import contains injection settings (enabled/count/depth). Restore those too?');
            if (restoreInjection) {
                if (parsed.injectEnabled !== undefined) patch.injectEnabled = parsed.injectEnabled;
                if (parsed.injectCount !== undefined) patch.injectCount = parsed.injectCount;
                if (parsed.injectDepth !== undefined) patch.injectDepth = parsed.injectDepth;
            }
        }

        setChronicleData(patch);
        applyInjection();
        state.selectedSnapshotId = null;
        _render.renderContent();
        scSetStatus(`Imported ${added} entries (${merged.length} total).`, 'success');
    } catch (err) {
        scSetStatus(`Import failed: ${err.message}`, 'error');
    }
}