/**
 * test/knowledge_concision_fixtures.test.js — Phase 0 baseline fixtures for the
 * Knowledge concision roadmap (docs/KNOWLEDGE_CONCISION_IMPLEMENTATION_PLAN.md,
 * Phase 0; fixture module: test/fixtures/knowledge_concision.js).
 *
 * Phase 0 requires baseline fixtures BEFORE any generation or persistence
 * change. These tests pin that the fixtures themselves are faithful:
 *
 *   - role scenarios parse as the current formatters write and carry the
 *     reported Role line verbatim;
 *   - the ledger coverage corpus really contains every case the plan names
 *     (gate code 7314, correction pair, other-person promise, legacy own-plan
 *     lines, all five provenance classes, meaningful dates);
 *   - malformed boundary documents really are malformed under the CURRENT
 *     parser semantics, so Phase 2's refusal behavior has honest inputs;
 *   - the representative-size builders land in their documented token bands
 *     under the documented estimator, and that estimator agrees with
 *     core/context.js estimateTokens where both are deterministic.
 *
 * The Phase 1–6 suites consume these fixtures. If a fixture quietly stopped
 * exercising its case, every downstream test would pass vacuously — that is
 * the failure mode this file exists to prevent.
 */

import { describe, test, expect } from 'vitest';

import {
    GATE_CODE,
    RELATIONSHIP_BLOCK_START,
    renderLedgerLine,
    buildDossierDocument,
    ROLE_SCENARIOS,
    cloneRoleScenario,
    LEDGER_COVERAGE_RECORDS,
    CONDENSATION_EXAMPLE,
    cloneLedgerCoverageRecords,
    KNOWLEDGE_CONCISION_DOCUMENTS,
    estimateFixtureTokens,
    REPRESENTATIVE_TARGET_TOKENS,
    REPRESENTATIVE_TOKEN_TOLERANCE,
    OVERSIZE_REFUSAL_FLOOR_TOKENS,
    buildRepresentativeLedgerEntry,
    buildHighDistinctFactEntry,
    buildOversizedLedgerEntry,
} from './fixtures/knowledge_concision.js';
import {
    isDossierEntry,
    extractDossierFieldValues,
    appendLedgerLines,
} from '../knowledge/lorebook.js';
import { estimateTokens } from '../core/context.js';

// ─── Helpers (mirror the current parser semantics, knowledge/lorebook.js) ────

/** LEDGER_HEADER_RE + ledgerItemIndices, read-only, for counting in tests. */
function ledgerSectionStats(content) {
    const lines = content.split(/\r?\n/);
    const isHeading = (l) => /^knowledge ledger:/i.test(l.trim());
    const headerIdx = lines.findIndex(isHeading);
    const headings = lines.filter(isHeading).length;
    let contiguousItems = 0;
    if (headerIdx !== -1) {
        for (let i = headerIdx + 1; i < lines.length; i++) {
            const t = lines[i].trim();
            if (t === '') continue;
            if (!t.startsWith('- ')) break;
            contiguousItems++;
        }
    }
    const totalItemLines = lines.filter(l => l.trim().startsWith('- ')).length;
    return { headerIdx, headings, contiguousItems, totalItemLines };
}

// ─── Role scenarios ──────────────────────────────────────────────────────────

describe('knowledge concision Phase 0 — role scenarios', () => {
    test('the registry carries exactly the plan-mandated scenarios', () => {
        expect(Object.keys(ROLE_SCENARIOS).sort()).toEqual([
            'enduringRelationshipRole',
            'mayorTransition',
            'readOnPcDrift',
            'reportedRoleDrift',
            'temporaryTasks',
            'unknownRolePreserved',
        ]);
    });

    test('every scenario entry parses as a dossier entry the current code accepts', () => {
        for (const [id, scenario] of Object.entries(ROLE_SCENARIOS)) {
            expect(isDossierEntry(scenario.entryContent), `entry for ${id}`).toBe(true);
            const values = extractDossierFieldValues(scenario.entryContent);
            expect(values.role, `role for ${id}`).toBeTruthy();
        }
        // unknownRolePreserved also demonstrates the missing-field convention:
        // the entry never grew a Current Agenda line, and that absence is data.
        expect(extractDossierFieldValues(ROLE_SCENARIOS.unknownRolePreserved.entryContent).agenda).toBeNull();
    });

    test('the reported Role line is preserved verbatim in the reportedRoleDrift entry', () => {
        const { entryContent } = ROLE_SCENARIOS.reportedRoleDrift;
        // The exact reported string (scope §1) — the drift-repro anchor.
        expect(entryContent).toContain(
            'Role: Alex\'s boyfriend; Braun transmittal sent; co-signer of the amended weekend law; ' +
            'chock duty and photo-hanging at today\'s Kovach unload'
        );
    });

    test('the reported Read on PC line is preserved verbatim in the readOnPcDrift entry', () => {
        const { entryContent } = ROLE_SCENARIOS.readOnPcDrift;
        // The exact reported string (doubled space included) — the drift-repro
        // anchor for the interaction-log failure mode.
        expect(entryContent).toContain(
            'Read on PC: Kissed Alex for the fourth time; confessed the full wants list and the ugly fog-keeping detail aloud; ' +
            'Alex agreed to all terms without hesitation; Alex  went red to the collar from the kiss'
        );
    });

    test('unknownRolePreserved: explicit unknown stays, and the missing-line variant has no Role line', () => {
        const scenario = ROLE_SCENARIOS.unknownRolePreserved;
        expect(extractDossierFieldValues(scenario.entryContent).role).toBe('unknown');
        const withoutLine = extractDossierFieldValues(scenario.entryContentWithoutRoleLine);
        expect(withoutLine.role).toBeNull();
    });

    test('mayorTransition stores the BEFORE role so a meaningful-change update is testable', () => {
        expect(extractDossierFieldValues(ROLE_SCENARIOS.mayorTransition.entryContent).role)
            .toBe('harbourmaster of Greyrock quay');
        expect(ROLE_SCENARIOS.mayorTransition.scanUpdate.fields.role).toBe('Mayor of Greyrock');
    });

    test('every scanUpdate matches the update_major record shape the scan paths consume', () => {
        for (const [id, scenario] of Object.entries(ROLE_SCENARIOS)) {
            const { name, fields, new_knowledge } = scenario.scanUpdate;
            expect(typeof name, `name for ${id}`).toBe('string');
            expect(fields, `fields for ${id}`).toBeTruthy();
            expect(fields.tone, `tone slot for ${id}`).toBeNull();
            expect(Array.isArray(new_knowledge), `new_knowledge for ${id}`).toBe(true);
            for (const k of new_knowledge) {
                expect(typeof k.fact).toBe('string');
                expect(k.fact.length).toBeGreaterThan(0);
            }
        }
    });

    test('cloneRoleScenario returns a detached copy', () => {
        const clone = cloneRoleScenario('temporaryTasks');
        clone.scanUpdate.fields.role = 'mutated';
        clone.entryContent = 'mutated';
        expect(ROLE_SCENARIOS.temporaryTasks.scanUpdate.fields.role).not.toBe('mutated');
        expect(ROLE_SCENARIOS.temporaryTasks.entryContent).not.toBe('mutated');
    });
});

// ─── Ledger coverage corpus ──────────────────────────────────────────────────

describe('knowledge concision Phase 0 — ledger coverage corpus', () => {
    test('every record renders in the exact current ledger-line shape', () => {
        for (const record of LEDGER_COVERAGE_RECORDS) {
            expect(renderLedgerLine(record))
                .toMatch(/^- .+ via (witness|told|document|rumor|institutional|unknown)(?: — .+)?$/);
        }
    });

    test('corpus ids are unique', () => {
        const ids = LEDGER_COVERAGE_RECORDS.map(r => r.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('all five provenance classes appear as sources', () => {
        const sources = new Set(LEDGER_COVERAGE_RECORDS.map(r => r.source || 'unknown'));
        for (const s of ['witness', 'told', 'document', 'rumor', 'institutional']) {
            expect(sources.has(s), `provenance ${s}`).toBe(true);
        }
    });

    test('the mandated detail cases are present and findable by id', () => {
        const byId = Object.fromEntries(LEDGER_COVERAGE_RECORDS.map(r => [r.id, r]));
        // Gate code 7314, in both the overlap pair and the correction pair.
        expect(byId['overlap-gate-code'].fact).toContain(GATE_CODE);
        expect(byId['overlap-gate-code-rich'].fact).toContain(GATE_CODE);
        // A correction pair: an old belief and its dated correction.
        expect(byId['correction-west-gate-old'].fact).toContain('1402');
        expect(byId['correction-west-gate-new'].fact).toContain(GATE_CODE);
        expect(byId['correction-west-gate-old'].date).toBe('Day 30');
        expect(byId['correction-west-gate-new'].date).toBe('Day 31');
        // Another person's promise — an allowed established fact.
        expect(byId['promise-dorothy'].fact).toContain('Dorothy promised');
        // Legacy own-plan lines that cleanup must keep represented and flag.
        expect(byId['legacy-plan-repaint'].fact).toMatch(/^plans to /);
        expect(byId['legacy-plan-informant'].fact).toMatch(/^will meet /);
        expect(byId['legacy-commitment-cosign'].fact).toMatch(/^agreed to /);
        // Meaningful explicit dates, not just Day N.
        expect(byId['technical-gnx'].date).toBe('July 2, 2000');
        expect(byId['date-quay-deed'].date).toBe('March 3, 2026');
        // Preserved uncertainty.
        expect(byId['uncertainty-ferry'].fact).toContain('not sure');
    });

    test('duplicate cases: one exact pair and one reworded pair', () => {
        const byId = Object.fromEntries(LEDGER_COVERAGE_RECORDS.map(r => [r.id, r]));
        expect(byId['duplicate-key-1'].fact).toBe(byId['duplicate-key-2'].fact);
        expect(byId['duplicate-debt-1'].fact).not.toBe(byId['duplicate-debt-2'].fact);
        expect(byId['duplicate-debt-1'].fact).toMatch(/forty crowns/);
        expect(byId['duplicate-debt-2'].fact).toMatch(/40 crowns/);
    });

    test('the scope §4.2 condensation example maps to real corpus records', () => {
        const byId = Object.fromEntries(LEDGER_COVERAGE_RECORDS.map(r => [r.id, r]));
        for (const id of CONDENSATION_EXAMPLE.sourceIds) {
            expect(byId[id], `source ${id}`).toBeTruthy();
        }
        // The proposed record keeps every model name (no silent detail loss)
        // and makes the STRONGER "expert" claim the originals do not.
        const proposed = CONDENSATION_EXAMPLE.proposed.fact;
        expect(proposed).toContain('GNX');
        expect(proposed).toContain('LS1/Trans Am WS6');
        expect(proposed).toContain('20B rotary');
        expect(proposed).toContain('expert');
        for (const id of CONDENSATION_EXAMPLE.sourceIds) {
            expect(byId[id].fact, `original ${id} must not already claim expertise`).not.toContain('expert');
        }
    });

    test('cloneLedgerCoverageRecords strips ids and detaches', () => {
        const clone = cloneLedgerCoverageRecords();
        expect(clone).toHaveLength(LEDGER_COVERAGE_RECORDS.length);
        expect(clone[0].id).toBeUndefined();
        clone[0].fact = 'mutated';
        expect(LEDGER_COVERAGE_RECORDS[0].fact).not.toBe('mutated');
    });

    test('the corpus embeds cleanly in a dossier document', () => {
        const doc = buildDossierDocument({ records: cloneLedgerCoverageRecords() });
        const stats = ledgerSectionStats(doc);
        expect(stats.headings).toBe(1);
        expect(stats.contiguousItems).toBe(LEDGER_COVERAGE_RECORDS.length);
        expect(doc).toContain(`via rumor — Day 42`);
    });
});

// ─── Format and boundary documents ───────────────────────────────────────────

describe('knowledge concision Phase 0 — format and boundary documents', () => {
    test('supported documents: exactly one unambiguous ledger heading', () => {
        for (const id of ['canonicalDossierEntry', 'crlfDossierEntry', 'trailingNewlineDossierEntry',
            'emptyLedgerPlaceholderEntry', 'compactMajorEntry', 'relationshipBlockDossierEntry',
            'lowercaseHeadingEntry']) {
            const stats = ledgerSectionStats(KNOWLEDGE_CONCISION_DOCUMENTS[id]);
            expect(stats.headings, `headings for ${id}`).toBe(1);
            expect(stats.headerIdx, `headerIdx for ${id}`).toBeGreaterThan(0);
        }
    });

    test('CRLF document uses CRLF everywhere and nowhere a lone LF', () => {
        const doc = KNOWLEDGE_CONCISION_DOCUMENTS.crlfDossierEntry;
        expect(doc).toContain('\r\n');
        const lines = doc.split('\n');
        for (let i = 0; i < lines.length - 1; i++) {
            expect(lines[i].endsWith('\r'), `line ${i} of crlfDossierEntry`).toBe(true);
        }
    });

    test('trailing-newline variant ends with exactly one newline; canonical has none', () => {
        expect(KNOWLEDGE_CONCISION_DOCUMENTS.trailingNewlineDossierEntry.endsWith('\n')).toBe(true);
        expect(KNOWLEDGE_CONCISION_DOCUMENTS.canonicalDossierEntry.endsWith('\n')).toBe(false);
    });

    test('compact entry carries no [Dossier] marker; placeholder entry carries the placeholder', () => {
        expect(isDossierEntry(KNOWLEDGE_CONCISION_DOCUMENTS.compactMajorEntry)).toBe(false);
        expect(KNOWLEDGE_CONCISION_DOCUMENTS.emptyLedgerPlaceholderEntry).toContain('- (no entries yet)');
        expect(ledgerSectionStats(KNOWLEDGE_CONCISION_DOCUMENTS.emptyLedgerPlaceholderEntry).contiguousItems).toBe(1);
    });

    test('relationship-block document: block sits after the ledger items, exact markers intact', () => {
        const doc = KNOWLEDGE_CONCISION_DOCUMENTS.relationshipBlockDossierEntry;
        const blockStart = doc.indexOf(RELATIONSHIP_BLOCK_START);
        const lastItem = doc.lastIndexOf('- Dorothy promised to arrive Monday');
        expect(blockStart).toBeGreaterThan(0);
        expect(lastItem).toBeGreaterThan(0);
        expect(lastItem).toBeLessThan(blockStart);
        expect(doc).toContain('<!-- mwt:relationships:end -->');
    });

    test('ambiguous documents are honestly ambiguous under current parser semantics', () => {
        const docs = KNOWLEDGE_CONCISION_DOCUMENTS;
        // Two headings — which one owns the ledger?
        expect(ledgerSectionStats(docs.duplicateLedgerHeadingsEntry).headings).toBe(2);
        // Item lines but no heading at all.
        const missing = ledgerSectionStats(docs.missingLedgerHeadingEntry);
        expect(missing.headings).toBe(0);
        expect(missing.totalItemLines).toBeGreaterThan(0);
        // Heading with trailing text: the loose parser regex still matches it,
        // but it is NOT an exact "Knowledge Ledger:" line — Phase 2 must refuse.
        const trailing = ledgerSectionStats(docs.headingWithTrailingTextEntry);
        expect(trailing.headings).toBe(1);
        expect(docs.headingWithTrailingTextEntry.split(/\r?\n/).some(l => l.trim().toLowerCase() === 'knowledge ledger:'))
            .toBe(false);
        // Prose splits the item run: 1 contiguous item, 3 total item lines.
        const prose = ledgerSectionStats(docs.proseInsideSectionEntry);
        expect(prose.headings).toBe(1);
        expect(prose.contiguousItems).toBe(1);
        expect(prose.totalItemLines).toBe(3);
    });
});

// ─── Current parser baseline on the fixtures ─────────────────────────────────
//
// These pin TODAY'S appendLedgerLines behavior on the boundary corpus. Phase 2
// changes any of these deliberately (e.g. CRLF preservation), and these tests
// are the baseline that makes such a change visible rather than accidental.

describe('knowledge concision Phase 0 — current appendLedgerLines baseline', () => {
    const NEW_FACT = { fact: 'stamped the Braun dock manifests', source: 'witness', date: 'Day 214' };

    test('new facts land before a trailing managed relationship block', () => {
        const doc = KNOWLEDGE_CONCISION_DOCUMENTS.relationshipBlockDossierEntry;
        const out = appendLedgerLines(doc.split('\n'), [NEW_FACT]).join('\n');
        const inserted = out.indexOf(renderLedgerLine(NEW_FACT));
        expect(inserted).toBeGreaterThan(0);
        expect(inserted).toBeLessThan(out.indexOf(RELATIONSHIP_BLOCK_START));
    });

    test('real facts replace the empty-ledger placeholder rather than stacking under it', () => {
        const doc = KNOWLEDGE_CONCISION_DOCUMENTS.emptyLedgerPlaceholderEntry;
        const out = appendLedgerLines(doc.split('\n'), [NEW_FACT]).join('\n');
        expect(out).not.toContain('- (no entries yet)');
        expect(out).toContain(renderLedgerLine(NEW_FACT));
    });

    test('BASELINE CAPTURE: appending into a CRLF entry inserts LF lines (Phase 2 must preserve CRLF instead)', () => {
        const doc = KNOWLEDGE_CONCISION_DOCUMENTS.crlfDossierEntry;
        const out = appendLedgerLines(doc.split('\n'), [NEW_FACT]).join('\n');
        // Surrounding lines keep their CRLF endings...
        expect(out).toContain('\r\n');
        // ...but the inserted line arrives with a bare LF and no trailing CR.
        expect(out.endsWith(renderLedgerLine(NEW_FACT))).toBe(true);
        expect(out.endsWith(renderLedgerLine(NEW_FACT) + '\r')).toBe(false);
    });

    test('an entry with no ledger section gets one started at the end', () => {
        const doc = KNOWLEDGE_CONCISION_DOCUMENTS.missingLedgerHeadingEntry;
        const out = appendLedgerLines(doc.split('\n'), [NEW_FACT]).join('\n');
        const stats = ledgerSectionStats(out);
        expect(stats.headings).toBe(1);
        expect(stats.contiguousItems).toBe(1);
    });
});

// ─── Representative-size builders ────────────────────────────────────────────

describe('knowledge concision Phase 0 — representative-size builders', () => {
    test('the fixture estimator agrees with core estimateTokens where both are deterministic', () => {
        // Under the node test environment there is no window/tokenizer, so
        // core/context.js estimateTokens is its chars/4.5 fallback — the same
        // arithmetic the fixture estimator documents.
        const samples = [
            KNOWLEDGE_CONCISION_DOCUMENTS.canonicalDossierEntry,
            KNOWLEDGE_CONCISION_DOCUMENTS.crlfDossierEntry,
            buildRepresentativeLedgerEntry().content,
            buildOversizedLedgerEntry().content,
        ];
        for (const sample of samples) {
            expect(estimateFixtureTokens(sample)).toBe(estimateTokens(sample));
        }
    });

    test('representative entry lands in the documented ~15,000-token band', () => {
        const built = buildRepresentativeLedgerEntry();
        expect(built.estimatedTokens).toBeGreaterThanOrEqual(REPRESENTATIVE_TARGET_TOKENS - REPRESENTATIVE_TOKEN_TOLERANCE);
        expect(built.estimatedTokens).toBeLessThanOrEqual(REPRESENTATIVE_TARGET_TOKENS + REPRESENTATIVE_TOKEN_TOLERANCE);
        // ~30 tokens per line means hundreds of distinct ledger lines, like the
        // long-session entries that motivated this work.
        expect(built.ledgerLineCount).toBeGreaterThan(300);
        // Realistic duplicate density is on by default.
        expect(built.duplicateLineCount).toBeGreaterThan(0);
        expect(built.records).toHaveLength(built.ledgerLineCount);
        // Structurally a dossier the current code accepts.
        expect(isDossierEntry(built.content)).toBe(true);
        expect(ledgerSectionStats(built.content).headings).toBe(1);
    });

    test('every counted duplicate rewords an earlier EMITTED original with the same observation date', () => {
        const { records, duplicateLineCount } = buildRepresentativeLedgerEntry();
        const duplicates = records.filter(r => r.duplicateOf !== null);
        expect(duplicates).toHaveLength(duplicateLineCount);
        expect(duplicateLineCount).toBeGreaterThan(0);
        for (const dup of duplicates) {
            const original = records[dup.duplicateOf];
            // "duplicate of" must point at an EARLIER, non-duplicate record
            // that was actually emitted — never at a slot that itself holds a
            // duplicate or was never reached.
            expect(original, `duplicate at slot ${dup.slot}`).toBeTruthy();
            expect(original.slot).toBeLessThan(dup.slot);
            expect(original.duplicateOf).toBeNull();
            // Whole-record duplicate: same observation date, reworded fact.
            expect(dup.date).toBe(original.date);
            expect(dup.fact).not.toBe(original.fact);
        }
    });

    test('corpus duplicate pairs share a date; the overlap and correction pairs deliberately diverge', () => {
        const byId = Object.fromEntries(LEDGER_COVERAGE_RECORDS.map(r => [r.id, r]));
        // Whole-record duplicates: same observation date.
        expect(byId['duplicate-key-1'].date).toBe(byId['duplicate-key-2'].date);
        expect(byId['duplicate-debt-1'].date).toBe(byId['duplicate-debt-2'].date);
        // Date-divergent overlaps are intentional and must survive a merge
        // with their attribution (told Day 30 vs witness Day 31) — merging
        // must not flatten them into a timeless assertion.
        expect(byId['overlap-gate-code'].date).toBe('Day 30');
        expect(byId['overlap-gate-code-rich'].date).toBe('Day 31');
        expect(byId['overlap-gate-code'].source).toBe('told');
        expect(byId['overlap-gate-code-rich'].source).toBe('witness');
        expect(byId['correction-west-gate-old'].date).not.toBe(byId['correction-west-gate-new'].date);
    });

    test('high-distinct-fact mode has zero duplicates — the cannot-safely-shrink case', () => {
        const built = buildHighDistinctFactEntry();
        expect(built.duplicateLineCount).toBe(0);
        expect(built.records.every(r => r.duplicateOf === null)).toBe(true);
        const itemFacts = built.content
            .split(/\r?\n/)
            .filter(l => l.trim().startsWith('- ') && !l.includes('(no entries yet)'))
            .map(l => l.trim());
        expect(new Set(itemFacts).size).toBe(itemFacts.length);
    });

    test('oversized entry exceeds the documented refusal floor', () => {
        const built = buildOversizedLedgerEntry();
        expect(built.estimatedTokens).toBeGreaterThan(OVERSIZE_REFUSAL_FLOOR_TOKENS);
    });

    test('builders are deterministic: same arguments, identical bytes', () => {
        expect(buildRepresentativeLedgerEntry().content).toBe(buildRepresentativeLedgerEntry().content);
        expect(buildHighDistinctFactEntry(12000).content).toBe(buildHighDistinctFactEntry(12000).content);
        expect(buildHighDistinctFactEntry(12000).estimatedTokens).toBeGreaterThanOrEqual(12000 - REPRESENTATIVE_TOKEN_TOLERANCE);
    });
});
