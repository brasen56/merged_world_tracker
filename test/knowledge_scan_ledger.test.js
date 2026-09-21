/**
 * test/knowledge_scan_ledger.test.js — the auto-scan → Knowledge Ledger path.
 *
 * THE REPORT (live use): with the NPC auto-scan on, tracked majors had their
 * Tone / Perceived as / Read on PC / Current Agenda rewritten every cadence
 * but their Knowledge Ledger never grew. Hitting "Update" on the Major tab for
 * the same NPC DID add ledger lines.
 *
 * Two independent causes, both pinned here:
 *
 *   1. PLACEMENT. Both mergers appended new facts with `lines.push(...)` — the
 *      end of the array, which is the end of the ledger only when the ledger
 *      is the last thing in the entry. An entry carrying a managed
 *      relationships block got its new facts written BELOW
 *      `<!-- mwt:relationships:end -->`, outside the section. The per-NPC
 *      paths never showed it because they stripRelationshipBlock() first —
 *      which is precisely why the manual button "worked".
 *
 *   2. VISIBILITY. runScan truncated <existing_entry> at 800 characters. A
 *      real dossier passes 800 somewhere around Appearance, so the model never
 *      saw `Knowledge Ledger:` at all, and the fields past the cut read as
 *      MISSING — which the prompt's "FILL MISSING FIELDS" rule then had it
 *      rewrite on every run. That is both halves of the report from one line.
 *
 * Plus the coverage gap that let it ship: every scan fixture in the suite used
 * `update_major: []`, so nothing ever fed a populated update record through
 * buildStagingItems → enrichStagingItem and asserted the ledger grew.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import { resetCoreStubs, setFakeChat, setFakeApi } from './stubs/core.js';
import { state, RELATIONSHIP_BLOCK_START, RELATIONSHIP_BLOCK_END } from '../knowledge/state.js';
import { saveSettings } from '../knowledge/settings.js';
import { _setCacheForTests, _clearCacheForTests } from '../knowledge/store.js';
import { buildStagingItems, knowledgeFromRecord, applyFieldOwnership } from '../knowledge/staging.js';
import {
    enrichStagingItem, runScan,
    appendLedgerLines, buildScanEntryProjection,
    buildUpdatedDossierContent, buildUpdatedMajorContent,
} from '../knowledge/lorebook.js';
import { SCAN_SYSTEM_PROMPT, DOSSIER_SCAN_SYSTEM_PROMPT } from '../knowledge/prompts.js';
import { getEvidenceFile, saveEvidenceMap } from '../knowledge/evidence.js';

// ─── Harness ─────────────────────────────────────────────────────────────────

function makeFakeWorldInfo() {
    const books = new Map();
    return {
        books,
        async loadWorldInfo(name) { return books.has(name) ? structuredClone(books.get(name)) : null; },
        async saveWorldInfo(name, wi, immediately = false) { if (immediately) books.set(name, structuredClone(wi)); },
        async createNewWorldInfo(name) { books.set(name, { entries: {} }); return true; },
    };
}

const NPC = 'Mara Voss';

/** A dossier long enough to be realistic — the old 800-char cut lands inside it. */
const DOSSIER = [
    '[Dossier] Mara Voss | Human | weathered harbourmaster',
    'Tone: brisk',
    'Perceived as: unflappable',
    'Role: Harbourmaster of Dusk Quay',
    'Where to Find: the harbour office at dawn',
    'Appearance: Rope-burned hands and a grey-streaked braid she re-pins whenever she is thinking. Tall, squared off at the shoulders, and she stands as though the floor might pitch.',
    "Voice: Low and clipped; drops her g's when she is tired and goes formal when she is lying.",
    'Background: Former navy quartermaster who took the harbour post after the wreck of the Kestrel. She has run Dusk Quay for eleven years and knows every hull that ties up there.',
    'Personality: Paternal but rigid; fears the sea claiming another child; taps the rail twice before she gives bad news.',
    'Read on PC: Wary ally so far.',
    'Current Agenda: Root out the smugglers using her quay.',
    'Secrets: Tier 1 (semi-public): owes the guild a debt | Tier 3 (buried): her brother leads the smugglers',
    'Canon Lock: Born in Dusk Quay; lost her son to a storm twelve years ago',
    '',
    'Knowledge Ledger:',
    '- Met the informant at the docks on Day 3 via witness — Day 3',
].join('\n');

const REL_BLOCK = `${RELATIONSHIP_BLOCK_START}\nRelationships: ally of Tam.\n${RELATIONSHIP_BLOCK_END}`;
const DOSSIER_WITH_REL = `${DOSSIER}\n\n${REL_BLOCK}`;

const FACT = { fact: 'Learned the smugglers use the north wharf', source: 'told', date: 'Day 5' };
const FACT_LINE = '- Learned the smugglers use the north wharf via told — Day 5';

function scanResult(overrides = {}) {
    return { dossierMode: true, new_minor: [], new_major: [], update_minor: [], update_major: [], ...overrides };
}

/** The scan record the report described: real field changes + one new fact. */
function updateMajorRecord(overrides = {}) {
    return {
        name: NPC,
        fields: { tone: 'clipped', perceived_as: 'unflappable', descriptor: null, agenda: 'Find her brother', read_on_pc: 'Trusts the PC now' },
        new_knowledge: [FACT],
        ...overrides,
    };
}

let wiFake;

beforeEach(() => {
    resetCoreStubs();
    _clearCacheForTests();
    saveSettings({ scope: 'global', dossierMode: true, connectionProfileId: 'test-profile' });
    wiFake = makeFakeWorldInfo();
    state.wiScript = wiFake;
    state.stagingItems = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    _clearCacheForTests();
    state.wiScript = null;
    vi.restoreAllMocks();
});

function seed(content) {
    _setCacheForTests('Knowledge Tracker', { registry: { [NPC]: { uid: 7, type: 'major', keywords: [NPC] } } });
    wiFake.books.set('Knowledge Tracker', {
        entries: { 7: { uid: 7, comment: NPC, key: [NPC], content } },
    });
}

/** Run one scan result through the full staging path, as the auto-scan does. */
async function stageFrom(result, content) {
    seed(content);
    const items = buildStagingItems(result);
    for (const item of items) await enrichStagingItem(item);
    return items;
}

/** Enrol an NPC in growth capture, the way evidence.js expects it staged. */
function enrolInGrowth(name) {
    getEvidenceFile(name).enrolled = true;
    saveEvidenceMap();
}

/** The ledger section's item lines, in order. */
function ledgerLines(content) {
    const lines = content.split('\n');
    const headerIdx = lines.findIndex(l => l.trim().toLowerCase().startsWith('knowledge ledger:'));
    if (headerIdx === -1) return null;
    const out = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
        const t = lines[i].trim();
        if (t === '') continue;
        if (!t.startsWith('- ')) break;
        out.push(t);
    }
    return out;
}

// ─── 1. Placement ────────────────────────────────────────────────────────────

describe('new facts land inside the Knowledge Ledger section', () => {
    test('THE REPORT: a relationships block no longer pushes the fact out of the ledger', async () => {
        const [item] = await stageFrom(scanResult({ update_major: [updateMajorRecord()] }), DOSSIER_WITH_REL);

        // The fact is IN the section, not stranded after the block.
        expect(ledgerLines(item.mergedContent)).toEqual([
            '- Met the informant at the docks on Day 3 via witness — Day 3',
            FACT_LINE,
        ]);
        // ...and the block itself survives the merge untouched.
        expect(item.mergedContent).toContain(REL_BLOCK);
        expect(item.mergedContent.indexOf(FACT_LINE)).toBeLessThan(item.mergedContent.indexOf(RELATIONSHIP_BLOCK_START));
    });

    test('the same entry without a relationships block is unaffected', async () => {
        const [item] = await stageFrom(scanResult({ update_major: [updateMajorRecord()] }), DOSSIER);
        expect(ledgerLines(item.mergedContent)).toEqual([
            '- Met the informant at the docks on Day 3 via witness — Day 3',
            FACT_LINE,
        ]);
    });

    test('the field updates the report DID see still apply', async () => {
        const [item] = await stageFrom(scanResult({ update_major: [updateMajorRecord()] }), DOSSIER_WITH_REL);
        expect(item.mergedContent).toContain('Tone: clipped');
        expect(item.mergedContent).toContain('Read on PC: Trusts the PC now');
        expect(item.mergedContent).toContain('Current Agenda: Find her brother');
    });

    test('compact (non-dossier) major entries get the same treatment', () => {
        const compact = [
            'Mara Voss | Human | harbourmaster',
            'Tone: brisk',
            'Perceived as: unflappable',
            'First seen: the quay',
            '',
            'Knowledge Ledger:',
            '- Met the informant via witness — Day 3',
            '',
            REL_BLOCK,
        ].join('\n');
        const merged = buildUpdatedMajorContent(compact, { tone: 'clipped' }, [FACT]);
        expect(ledgerLines(merged)).toEqual(['- Met the informant via witness — Day 3', FACT_LINE]);
        expect(merged).toContain(REL_BLOCK);
    });

    test('appendLedgerLines replaces the "(no entries yet)" placeholder', () => {
        const lines = ['Name | Human | x', '', 'Knowledge Ledger:', '- (no entries yet)'];
        expect(appendLedgerLines(lines, [FACT])).toEqual([
            'Name | Human | x', '', 'Knowledge Ledger:', FACT_LINE,
        ]);
    });

    test('appendLedgerLines starts a section when the entry has none', () => {
        expect(appendLedgerLines(['Name | Human | x', 'Tone: brisk'], [FACT])).toEqual([
            'Name | Human | x', 'Tone: brisk', '', 'Knowledge Ledger:', FACT_LINE,
        ]);
    });

    test('appendLedgerLines is a no-op for an empty fact list and never mutates its input', () => {
        const lines = ['Knowledge Ledger:', '- a via witness'];
        expect(appendLedgerLines(lines, [])).toBe(lines);
        appendLedgerLines(lines, [FACT]);
        expect(lines).toEqual(['Knowledge Ledger:', '- a via witness']);
    });

    test('a dossier field appended by the same merge still lands above the ledger', () => {
        // buildUpdatedDossierContent splices missing fields in before the
        // ledger; that must keep working now that facts splice in too.
        const merged = buildUpdatedDossierContent(DOSSIER_WITH_REL, { voice: null, secrets: null, where_to_find: null, image_tags: 'braid' }, [FACT]);
        const idxLedger = merged.indexOf('Knowledge Ledger:');
        if (merged.includes('Image Tags:')) expect(merged.indexOf('Image Tags:')).toBeLessThan(idxLedger);
        expect(ledgerLines(merged)).toEqual([
            '- Met the informant at the docks on Day 3 via witness — Day 3',
            FACT_LINE,
        ]);
    });
});

// ─── 2. Visibility: what the scan prompt actually shows the model ─────────────

describe('scan entry projection', () => {
    test('THE REPORT: the ledger reaches the prompt (the old 800-char cut dropped it)', () => {
        expect(DOSSIER.indexOf('Knowledge Ledger:')).toBeGreaterThan(800);
        const projected = buildScanEntryProjection(DOSSIER);
        expect(projected).toContain('Knowledge Ledger:');
        expect(projected).toContain('- Met the informant at the docks on Day 3 via witness — Day 3');
    });

    test('every field label survives, so nothing reads as MISSING that is not', () => {
        const projected = buildScanEntryProjection(DOSSIER);
        for (const label of ['Tone', 'Perceived as', 'Role', 'Where to Find', 'Appearance', 'Voice', 'Background', 'Personality', 'Read on PC', 'Current Agenda', 'Secrets', 'Canon Lock']) {
            expect(projected).toContain(`${label}:`);
        }
    });

    test('long values are clipped with the ellipsis the prompt tells the model to expect', () => {
        const projected = buildScanEntryProjection(DOSSIER);
        const background = projected.split('\n').find(l => l.startsWith('Background:'));
        expect(background).toMatch(/…$/);
        expect(background.length).toBeLessThan(140);
        // Short values are left whole.
        expect(projected).toContain('Tone: brisk');
        expect(projected).toContain('Read on PC: Wary ally so far.');
    });

    test('only the recent ledger tail is carried, and the elision is stated', () => {
        const many = DOSSIER + '\n' + Array.from({ length: 8 }, (_, i) => `- fact ${i} via witness — Day ${i}`).join('\n');
        const projected = buildScanEntryProjection(many);
        expect(projected).toContain('- …(4 older ledger lines not shown)');
        expect(projected).toContain('- fact 7 via witness — Day 7');
        expect(projected).not.toContain('- fact 0 via witness — Day 0');
    });

    test('the relationships block is left out — it has its own extractor', () => {
        const projected = buildScanEntryProjection(DOSSIER_WITH_REL);
        expect(projected).not.toContain(RELATIONSHIP_BLOCK_START);
        expect(projected).not.toContain('Relationships: ally of Tam.');
    });

    test('empty / non-string content projects to nothing', () => {
        expect(buildScanEntryProjection('')).toBe('');
        expect(buildScanEntryProjection(null)).toBe('');
        expect(buildScanEntryProjection(undefined)).toBe('');
    });

    test('runScan sends the projection, ledger included', async () => {
        seed(DOSSIER_WITH_REL);
        // getStableHistoryEnd() excludes the 2 most recent messages, so the
        // chat needs more than that before anything reaches the scan.
        setFakeChat([
            { name: 'User', is_user: true, mes: 'We walk the quay.' },
            { name: 'Mara Voss', is_user: false, mes: 'She nods at the north wharf.' },
            { name: 'User', is_user: true, mes: 'Who runs it?' },
            { name: 'Mara Voss', is_user: false, mes: 'Her brother, she does not say.' },
        ]);
        let sent = null;
        setFakeApi(async ({ userContent }) => {
            sent = userContent;
            return JSON.stringify(scanResult());
        });

        await runScan();

        expect(sent).toContain('<existing_entry>');
        expect(sent).toContain('Knowledge Ledger:');
        expect(sent).toContain('- Met the informant at the docks on Day 3 via witness — Day 3');
        expect(sent).not.toContain('…(truncated)');
        expect(sent).not.toContain(RELATIONSHIP_BLOCK_START);
    });
});

describe('scan prompts ask for ledger facts, not just forbid them', () => {
    test.each([
        ['SCAN_SYSTEM_PROMPT', SCAN_SYSTEM_PROMPT],
        ['DOSSIER_SCAN_SYSTEM_PROMPT', DOSSIER_SCAN_SYSTEM_PROMPT],
    ])('%s carries a positive new_knowledge instruction', (_name, prompt) => {
        expect(prompt).toContain('RECORD WHAT THEY LEARNED');
        // The prohibition from test/knowledge_ledger_prompt.test.js stays.
        expect(prompt).toContain('ESTABLISHED FACTS ONLY');
    });

    test('the dossier scan prompt states that <existing_entry> is abbreviated', () => {
        expect(DOSSIER_SCAN_SYSTEM_PROMPT).toContain('<existing_entry> IS ABBREVIATED');
    });
});

// ─── 3. Either ledger key on an update record ────────────────────────────────

describe('knowledgeFromRecord accepts both schema keys', () => {
    test('new_major says initial_knowledge, update_major says new_knowledge', () => {
        expect(knowledgeFromRecord({ new_knowledge: [FACT] })).toEqual([FACT]);
        expect(knowledgeFromRecord({ initial_knowledge: [FACT] })).toEqual([FACT]);
        expect(knowledgeFromRecord({ new_knowledge: [], initial_knowledge: [FACT] })).toEqual([FACT]);
        expect(knowledgeFromRecord({})).toEqual([]);
        expect(knowledgeFromRecord({ new_knowledge: 'not an array' })).toEqual([]);
        expect(knowledgeFromRecord(null)).toEqual([]);
    });

    test('an update_major that used initial_knowledge is no longer dropped', async () => {
        const record = updateMajorRecord({ new_knowledge: undefined, initial_knowledge: [FACT] });
        const [item] = await stageFrom(scanResult({ update_major: [record] }), DOSSIER);
        expect(item.newKnowledge).toEqual([FACT]);
        expect(ledgerLines(item.mergedContent)).toContain(FACT_LINE);
    });
});

// ─── 4. Growth owns personality on the scan path too ─────────────────────────

describe('growth-owned personality is not overwritten by a scan', () => {
    test('applyFieldOwnership nulls personality only when an evidence file exists', () => {
        expect(applyFieldOwnership(NPC, { personality: 'rewritten', tone: 'brisk' }))
            .toEqual({ personality: 'rewritten', tone: 'brisk' });

        enrolInGrowth(NPC);
        expect(applyFieldOwnership(NPC, { personality: 'rewritten', tone: 'brisk' }))
            .toEqual({ personality: null, tone: 'brisk' });
        // Untouched when the field was not proposed, or for a different NPC.
        expect(applyFieldOwnership(NPC, { tone: 'brisk' })).toEqual({ tone: 'brisk' });
        expect(applyFieldOwnership('Someone Else', { personality: 'x' })).toEqual({ personality: 'x' });
    });

    test('a scan proposal leaves the profiled NPC\'s Personality line alone', async () => {
        enrolInGrowth(NPC);
        const record = updateMajorRecord({
            fields: { ...updateMajorRecord().fields, personality: 'Model-invented personality prose.' },
        });
        const [item] = await stageFrom(scanResult({ update_major: [record] }), DOSSIER);

        expect(item.fields.personality).toBeNull();
        expect(item.mergedContent).toContain('Personality: Paternal but rigid;');
        expect(item.mergedContent).not.toContain('Model-invented personality prose.');
        // The rest of the proposal still applies.
        expect(item.mergedContent).toContain('Current Agenda: Find her brother');
    });

    test('without an evidence file the scan may still update personality', async () => {
        const record = updateMajorRecord({
            fields: { ...updateMajorRecord().fields, personality: 'Newly observed prose.' },
        });
        const [item] = await stageFrom(scanResult({ update_major: [record] }), DOSSIER);
        expect(item.mergedContent).toContain('Personality: Newly observed prose.');
    });
});
