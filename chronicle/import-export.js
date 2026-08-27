/**
 * chronicle/import-export.js — Export and import chronicle data.
 */

import {
    downloadJson, downloadBlob, pickTextFile,
} from '../core/index.js';

import {
    state, SC_VERSION,
    getChronicleData, setChronicleDataChecked, getSnapshots,
    scSetStatus,
    _render,
} from './data.js';

import { applyInjection, isInjectionEnabled } from './injection.js';
import { chronicleSchema } from './schema.js';
import { prepareStore } from '../core/schema.js';

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
    // CHRONICLE-07: pickTextFile() can reject on a real file-read/picker
    // failure (its onchange handler rethrows). The caller in render.js invokes
    // this without awaiting, so an unhandled rejection would surface with no
    // Chronicle status message. Catch it here, set an error status, and keep
    // cancellation (the helper resolves '') as a quiet no-op.
    let text;
    try {
        text = await pickTextFile('.json');
    } catch (err) {
        scSetStatus(`Import failed: could not read file (${err?.message || err}).`, 'error');
        return;
    }
    if (text) importChronicle(text);
}

// Standalone export files predate the data-schema version marker (SC_VERSION
// is the module version, not a data version — design §6.2), so the import
// always prepares from legacy version 0. One constant feeds BOTH the
// prepareStore version AND the quarantine sourceVersion below, so a rejected
// record's recovery metadata always names the version it actually came from.
const LEGACY_IMPORT_VERSION = 0;

function importChronicle(jsonString) {
    try {
        const parsed = JSON.parse(jsonString);
        if (!parsed.snapshots || !Array.isArray(parsed.snapshots)) throw new Error('Invalid: missing snapshots.');

        // Part 3 (design §8): the standalone import runs through the SAME
        // schema owner as runtime loading and backup imports. Standalone
        // export files predate the data-schema version marker (SC_VERSION is
        // the module version, not a data version — design §6.2), so the
        // import prepares from legacy version 0: the migration backfills
        // missing ids DETERMINISTICALLY (same file ⇒ same ids, so re-imports
        // dedup instead of duplicating), and the validator quarantines
        // malformed snapshots with their raw records preserved.
        const prepared = prepareStore(chronicleSchema, { snapshots: parsed.snapshots }, {
            version: LEGACY_IMPORT_VERSION,
            deferPolicy: 'canonicalize',
        });
        if (prepared.status === 'blocked') {
            throw new Error(prepared.error?.message || 'Snapshots failed schema validation.');
        }
        const incoming = prepared.data.snapshots || [];
        const skipped = prepared.issues.filter(issue => issue.severity === 'quarantine').length;

        const existing = getSnapshots();
        const existingIds = new Set(existing.map(s => s.id));
        let added = 0;
        const merged = [...existing];
        for (const snap of incoming) {
            // The schema guarantees a non-empty id (backfilled above when the
            // record was acceptable), so the id IS the merge key: a snapshot
            // this chat already has is preserved as-is (merge semantics), and
            // a file containing the same id twice was already deduplicated by
            // the validator (CHRONICLE-04).
            if (existingIds.has(snap.id)) continue;
            existingIds.add(snap.id);
            merged.push({ ...snap });
            added++;
        }
        merged.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

        // Restore lastAnchor and msgSinceSnapshot (data), but skip injection settings
        // (session config) to avoid silently overwriting the user's current preferences
        const patch = { snapshots: merged, suggestSent: false };
        if (parsed.lastAnchor) patch.lastAnchor = parsed.lastAnchor;
        if (typeof parsed.msgSinceSnapshot === 'number' && Number.isFinite(parsed.msgSinceSnapshot)) {
            patch.msgSinceSnapshot = parsed.msgSinceSnapshot;
        }
        if (parsed.injectEnabled !== undefined || parsed.injectCount !== undefined || parsed.injectDepth !== undefined) {
            const restoreInjection = confirm('Import contains injection settings (enabled/count/depth). Restore those too?');
            if (restoreInjection) {
                if (parsed.injectEnabled !== undefined) patch.injectEnabled = parsed.injectEnabled;
                if (parsed.injectCount !== undefined) patch.injectCount = parsed.injectCount;
                if (parsed.injectDepth !== undefined) patch.injectDepth = parsed.injectDepth;
            }
        }

        // Checked write (design §8 + §5.2): ONE commit carries the merged
        // snapshots AND the import file's schema findings (e.g. a malformed
        // snapshot) so its rejected records are preserved. The findings ride
        // the checked seam itself — the store validates the destination
        // BEFORE the quarantine container is touched, so a refused write (an
        // unreadable current Chronicle, or a container that refuses the
        // records) leaves BOTH the previous store AND the container intact.
        // The old standalone preserve ran first and could not be undone when
        // the write refused, stranding quarantine records in a chat whose
        // import then reported failure.
        const written = setChronicleDataChecked(patch, {
            // The file's findings ride the same commit, stamped with the
            // version their SOURCE was at (0) — not the destination's current
            // version, which would misreport an unversioned legacy export's
            // rejected snapshots as current-version data.
            preserveIssues: { issues: prepared.issues, sourceVersion: LEGACY_IMPORT_VERSION },
        });
        if (!written.ok) {
            const detail = written.message || written.reason || 'unknown reason';
            scSetStatus(`Import failed: the chronicle store refused the write (${detail}); the previous chronicle was kept.`, 'error');
            return;
        }
        // Module/UI state only moves after the commit is confirmed — a
        // refusal must not leave the cadence counter, injection, selection,
        // or render reporting an import that never landed.
        if (patch.msgSinceSnapshot !== undefined) {
            state.msgSinceSnapshot = patch.msgSinceSnapshot;
        }
        applyInjection();
        state.selectedSnapshotId = null;
        _render.renderContent();
        scSetStatus(`Imported ${added} entries (${merged.length} total${skipped ? `, ${skipped} skipped (failed validation)` : ''}).`, 'success');
    } catch (err) {
        scSetStatus(`Import failed: ${err.message}`, 'error');
    }
}