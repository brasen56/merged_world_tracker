/** Review probes for the Module 3 (Knowledge) findings (docs/TODO.md §0).
 *
 * Most assertions below still reproduce CURRENT defects: their functions are
 * extracted from actual source and run with explicit boundary stubs. These are
 * not host integration tests.
 *
 * Two probes were converted into regression pins of FIXED behavior (2.10.2):
 * NK-01 + NK-09 (failed-flush retention across a cache reset) and NK-07
 * (imported-UID verification). Per docs/TODO.md §0 "The review probe tests",
 * those import the real modules under the core stub instead of copying source
 * text into a `vm` sandbox.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, test } from 'vitest';

import { reconcileImportedUid } from '../knowledge/reconcile.js';
import {
    _clearCacheForTests, hydrateBook, peekStore, readField, resetStoreCache, writeField,
} from '../knowledge/store.js';
import { state as knowledgeState } from '../knowledge/state.js';

function load(file, start, end, context) {
    const source = readFileSync(new URL(`../knowledge/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    if (from < 0 || to < 0) throw new Error(`Missing source boundary: ${file}`);
    vm.runInNewContext(source.slice(from, to).replace(/^export /gm, ''), context);
}

describe('Module 3 review — defect reproductions', () => {
    test('consolidation preserves a source promoted to canon while generation was pending', () => {
        const file = { raw: [{ id: 'obs-001', claim: 'User canon', quote: 'receipt', canon: true, ts: 1 }], consolidated: [], archivedRaw: [] };
        const c = { getEvidenceFile: () => file, obsIdSequence: () => () => 'con-001', validCategory: x => x, touch() {} };
        load('evidence.js', 'export function applyConsolidation(', '/**\n * Update a consolidated', c);
        c.applyConsolidation('Mara', [{ claim: 'Model inference', sources: [1] }], ['obs-001']);
        expect(file.raw).toHaveLength(1);
        expect(file.archivedRaw).toHaveLength(0);
        load('evidence.js', 'export function getEvidenceForProfile(', '/**\n * Return a summary', c);
        expect(c.getEvidenceForProfile('Mara').some(item => item.canon)).toBe(true);
    });

    test('enrichment preserves growth-owned personality but still allows canon updates', async () => {
        let forwarded;
        const c = { hasValidSettings: () => true, loadEntryContent: async () => 'Existing dossier',
            stripRelationshipBlock: x => x, getRecentMessages: () => 'Recent scene',
            getWorldStateFactual: () => '', getLatestChronicleEntry: () => '',
            DOSSIER_ENRICH_PROMPT: '', ktFetchFromApi: async () => '{}', normaliseOutput: x => x,
            parseJsonLenient: () => ({ fields: { canon_lock: 'Replaced canon', personality: 'Replaced profile' } }),
            applyFieldOwnership: (name, fields) => name === 'Mara' ? { ...fields, personality: null } : fields,
            buildUpdatedDossierContent: (text, fields) => { forwarded = fields; return text; } };
        load('lorebook.js', 'export async function runNpcEnrich(', '// ─── Dossier per-field refresh', c);
        await c.runNpcEnrich('Mara', 1);
        expect(forwarded.canon_lock).toBe('Replaced canon');
        expect(forwarded.personality).toBeNull();
    });

    // NK-01 + NK-09 (fixed in 2.10.2): a failed flush no longer evicts the
    // dirty book from the cache. The slot survives the reset with its retry
    // armed, so the edits are persisted by the later retry instead of being
    // dropped (and re-created as a duplicate entry by the next save).
    test('failed reset flush retains the dirty book and the later retry persists it', async () => {
        _clearCacheForTests();
        const books = new Map();
        let failSave = true;
        knowledgeState.wiScript = {
            loadWorldInfo: async name => (books.has(name) ? structuredClone(books.get(name)) : { entries: {} }),
            saveWorldInfo: async (name, book) => {
                if (failSave) throw new Error('disk unavailable');
                books.set(name, structuredClone(book));
            },
        };
        try {
            await hydrateBook('Knowledge Tracker');
            writeField('Knowledge Tracker', 'registry', { Mara: { uid: 3, keywords: ['Mara'] } });
            // The reset reports that a book failed to flush…
            expect(await resetStoreCache()).toBe(false);
            // …and the failed slot survives it, still dirty, still holding the
            // only copy of the edits.
            expect(peekStore('Knowledge Tracker')).toMatchObject({ hydrated: true, dirty: true });
            expect(readField('Knowledge Tracker', 'registry')).toHaveProperty('Mara');
            // Once the disk is back, the retained slot flushes cleanly.
            failSave = false;
            expect(await resetStoreCache()).toBe(true);
            expect(books.get('Knowledge Tracker')).toBeTruthy();
        } finally {
            _clearCacheForTests();
            knowledgeState.wiScript = undefined;
        }
    });

    test('64-character suffix discards the collision discriminator', () => {
        const c = { ILLEGAL_FILENAME_CHARS: /[\\/:*?"<>|\u0000-\u001f]/g, MAX_SUFFIX_LENGTH: 64 };
        load('scope.js', 'export function sanitizeLorebookName(', '/**\n * Build the three book names', c);
        const name = 'A'.repeat(64);
        expect(c.sanitizeLorebookName(`${name} (unique123)`)).toBe(name);
    });

    test('timestamp-only delta cursor skips the remainder of a tied timestamp batch', () => {
        const chat = [1, 2, 3].map(n => ({ name: 'Mara', mes: `message ${n}`, send_date: 100 }));
        const c = { getChat: () => chat, getEligibleChatEnd: () => chat.length,
            isIlsSummary: () => false, normalizeSendDate: x => x, stripNonNarrative: x => x };
        load('growth.js', 'function buildDeltaWindow(', '/**\n * Run a continuous', c);
        const first = c.buildDeltaWindow(null, 2, 1);
        expect(first.count).toBe(2);
        expect(c.buildDeltaWindow(first.maxTs, 2, 1)).toBeNull();
    });

    test('all-stripped leading delta batch stalls before later narrative', () => {
        const chat = [1, 2, 3].map(n => ({ mes: n === 3 ? 'narrative' : 'stripped', send_date: n }));
        const c = { getChat: () => chat, getEligibleChatEnd: () => chat.length,
            isIlsSummary: () => false, normalizeSendDate: x => x,
            stripNonNarrative: x => x === 'stripped' ? '' : x };
        load('growth.js', 'function buildDeltaWindow(', '/**\n * Run a continuous', c);
        expect(c.buildDeltaWindow(null, 2, 1)).toBeNull();
    });

    test('bootstrap watermark consumes messages arriving during capture', async () => {
        let complete;
        let chat = [{ send_date: 10 }];
        let watermark;
        const c = { refuseIfGrowthPaused() {}, getRegistry: () => ({ Mara: { uid: 1 } }),
            hasValidSettings: () => true, getCaptureWatermark: () => null,
            captureEvidence: () => new Promise(resolve => { complete = resolve; }),
            appendRawObservations: () => ({ added: 1, skipped: 0 }),
            getChat: () => chat, getEligibleChatEnd: x => x.length, EVIDENCE_MESSAGE_WINDOW: 80,
            normalizeSendDate: x => x, setCaptureWatermark: (name, ts) => { watermark = ts; },
            getEvidenceForProfile: () => [] };
        load('growth.js', 'export async function runCaptureOnly(', '// ─── Consolidation pass', c);
        const pending = c.runCaptureOnly('Mara');
        chat = [...chat, { send_date: 20 }];
        complete([{ claim: 'captured only the original message' }]);
        await pending;
        expect(watermark).toBe(20);
    });

    test('consolidation applies after scope changes when transport resolves', async () => {
        let complete;
        let scope = 'A';
        let writtenScope;
        const c = { refuseIfGrowthPaused() {}, getRegistry: () => ({ Mara: { uid: 1 } }),
            consolidateEvidence: () => new Promise(resolve => { complete = resolve; }),
            applyConsolidation: () => { writtenScope = scope; return {}; } };
        load('growth.js', 'export async function runConsolidation(', '// ─── Profile regeneration', c);
        const pending = c.runConsolidation('Mara');
        scope = 'B';
        complete({ consolidated: [], sourceIds: [] });
        await pending;
        expect(writtenScope).toBe('B');
    });

    // NK-07 (fixed in 2.10.2): an imported UID is kept only when the entry it
    // points at is verified to belong to the same NPC, by name and by content.
    test('UID reconciliation refuses unverified imports instead of trusting any non-null content', async () => {
        const read = async (uid, name) => (uid === 7 && name === 'Mara' ? 'Mara dossier' : 'Unrelated NPC');
        // The old defect: no exported content + any non-null load = trusted,
        // which could strip the UID from its real owner's registry record.
        expect(await reconcileImportedUid(7, null, read, 'Mara')).toBeNull();
        // A name is required, and the loaded content must match the export.
        expect(await reconcileImportedUid(7, 'Mara dossier', read)).toBeNull();
        expect(await reconcileImportedUid(7, 'wrong NPC', read, 'Mara')).toBeNull();
        expect(await reconcileImportedUid(7, 'Mara dossier', read, 'Mara')).toBe(7);
    });
});