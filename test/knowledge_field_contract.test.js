/**
 * test/knowledge_field_contract.test.js — the shared field contract
 * (knowledge/field_contract.js), Phase 1 of the Knowledge concision roadmap
 * (docs/KNOWLEDGE_CONCISION_IMPLEMENTATION_PLAN.md; bounds recorded as D4a in
 * docs/KNOWLEDGE_CONCISION_DECISIONS.md).
 *
 * Pins three things the phase cannot ship without:
 *
 *   1. the bounds table IS the D4a decision — a changed bound must be a
 *      deliberate decision-record change, not a quiet edit;
 *   2. validation rejects (whole, with reasons) rather than slices — a valid
 *      13-word Role and the reported 149-character Role both pass on purpose,
 *      because their problems are semantic scope, which prompts address;
 *   3. the prompt guidance renders from the same definitions, so prompts and
 *      validation cannot drift apart.
 *
 * The seam integrations (S1–S6) are tested where each seam lives:
 * test/knowledge_scan_ledger.test.js, test/knowledge_ledger_prompt.test.js,
 * test/dossier_field_refresh.test.js.
 */

import { describe, test, expect } from 'vitest';

import {
    FIELD_CONTRACT,
    FIELD_CONTRACT_BY_KEY,
    LEDGER_ITEM_LIMITS,
    validateFieldValue,
    validateFields,
    validateKnowledgeList,
    validateScanRecord,
    contractPromptBlock,
} from '../knowledge/field_contract.js';
import {
    REPORTED_ROLE_LINE,
    ROLE_SCENARIOS,
    cloneRoleScenario,
    cloneLedgerCoverageRecords,
} from './fixtures/knowledge_concision.js';

// ─── Definitions match the recorded D4a bounds ───────────────────────────────

describe('field contract definitions match decision D4a', () => {
    test.each([
        ['tone', 120], ['perceived_as', 200], ['descriptor', 200], ['first_seen', 300],
        ['role', 400], ['where_to_find', 300], ['appearance', 900], ['voice', 600],
        ['background', 1200], ['personality', 900], ['read_on_pc', 400], ['agenda', 400],
        ['secrets', 1200], ['canon_lock', 800], ['image_tags', 400],
    ])('%s bound is %p characters', (key, maxChars) => {
        expect(FIELD_CONTRACT_BY_KEY[key].maxChars).toBe(maxChars);
    });

    test('ledger item limits match D4a', () => {
        expect(LEDGER_ITEM_LIMITS).toEqual({ fact: 800, source: 80, date: 80 });
    });

    test('every contract field carries prompt guidance (belongs / not / shape)', () => {
        for (const def of FIELD_CONTRACT) {
            expect(def.belongs, `${def.key} belongs`).toBeTruthy();
            expect(def.notBelongs, `${def.key} notBelongs`).toBeTruthy();
            expect(def.shape, `${def.key} shape`).toBeTruthy();
        }
    });
});

// ─── validateFieldValue ──────────────────────────────────────────────────────

describe('validateFieldValue', () => {
    test('a valid 13-word Role passes — shapes are guidance, not truncation thresholds', () => {
        const role = 'long-haul freight dispatcher for the whole northern rail consortium and its retired lockkeepers';
        expect(role.split(' ')).toHaveLength(13);
        const check = validateFieldValue('role', role);
        expect(check.ok).toBe(true);
        expect(check.value).toBe(role);
    });

    test('the reported 149-character Role line passes deliberately (bounds are not scope)', () => {
        // docs/KNOWLEDGE_CONCISION_SCOPE.md §1 — the reported drift case. Its
        // problem is semantic scope (prompt contract territory), not length.
        const check = validateFieldValue('role', REPORTED_ROLE_LINE);
        expect(check.ok).toBe(true);
        expect(check.value).toBe(REPORTED_ROLE_LINE);
    });

    test('overlong values are rejected whole with a size reason, never sliced', () => {
        const overlong = 'x'.repeat(401);
        const check = validateFieldValue('role', overlong);
        expect(check.ok).toBe(false);
        expect(check.reason).toContain('401');
        expect(check.reason).toContain('400');
    });

    test('embedded line breaks are rejected — the entry format is single-line per field', () => {
        for (const value of ['two\nlines', 'carriage\rreturn']) {
            const check = validateFieldValue('background', value);
            expect(check.ok, JSON.stringify(value)).toBe(false);
            expect(check.reason).toContain('line break');
        }
        // Outer whitespace — including a trailing newline — is normalization,
        // not silent slicing: the value itself is intact.
        expect(validateFieldValue('background', 'one paragraph\n')).toEqual({ ok: true, value: 'one paragraph' });
    });

    test('structural injections are rejected with specific reasons', () => {
        expect(validateFieldValue('role', 'keeper; Knowledge Ledger: smuggled goods').reason)
            .toContain('section injection');
        expect(validateFieldValue('role', 'keeper <!-- mwt:relationships:start -->').reason)
            .toContain('relationship block marker');
        expect(validateFieldValue('role', '[Dossier] Mara Voss | Human | harbourmaster').reason)
            .toContain('[Dossier]');
    });

    test('scalar normalization: numbers/booleans stringify, blanks read as null, edges trim', () => {
        expect(validateFieldValue('tone', 42)).toEqual({ ok: true, value: '42' });
        expect(validateFieldValue('tone', true)).toEqual({ ok: true, value: 'true' });
        expect(validateFieldValue('tone', '')).toEqual({ ok: true, value: null });
        expect(validateFieldValue('tone', undefined)).toEqual({ ok: true, value: null });
        expect(validateFieldValue('tone', '  quiet  ')).toEqual({ ok: true, value: 'quiet' });
    });

    test('structured secrets/canon_lock shapes are allowed; structured anything-else is not', () => {
        const tiers = { tier1: 'owes the guild', tier3: 'brother leads the smugglers' };
        expect(validateFieldValue('secrets', tiers).ok).toBe(true);
        expect(validateFieldValue('canon_lock', ['Born in Dusk Quay', 'lost her son']).ok).toBe(true);
        const bad = validateFieldValue('role', { job: 'harbourmaster' });
        expect(bad.ok).toBe(false);
        expect(bad.reason).toContain('not a string');
    });

    test('a structured secrets value that coerces past its bound is rejected', () => {
        const huge = { tier1: 'y'.repeat(1300) };
        const check = validateFieldValue('secrets', huge);
        expect(check.ok).toBe(false);
        expect(check.reason).toContain('coerces to');
    });

    test('non-contract keys pass through untouched (identity fields, future keys)', () => {
        expect(validateFieldValue('species', 42)).toEqual({ ok: true, value: 42 });
        expect(validateFieldValue('name', { full: 'Mara' })).toEqual({ ok: true, value: { full: 'Mara' } });
    });
});

// ─── validateFields ──────────────────────────────────────────────────────────

describe('validateFields', () => {
    test('drops invalid values to null, keeps valid updates, reports per-field reasons', () => {
        const { fields, rejected } = validateFields({
            tone: 'dry and exact',
            role: 'y'.repeat(401),           // invalid — nulled, existing entry keeps old Role
            agenda: null,                     // "no change" stays null
            future_key: 'passes through',     // mergers ignore unknown keys; contract does too
        });
        expect(fields.tone).toBe('dry and exact');
        expect(fields.role).toBeNull();
        expect(fields.agenda).toBeNull();
        expect(fields.future_key).toBe('passes through');
        expect(rejected).toEqual([{ key: 'role', reason: expect.stringContaining('401') }]);
    });

    test('degenerate inputs validate to empty, not throw', () => {
        expect(validateFields(null)).toEqual({ fields: {}, rejected: [] });
        expect(validateFields([])).toEqual({ fields: {}, rejected: [] });
        expect(validateFields('tone: dry')).toEqual({ fields: {}, rejected: [] });
    });
});

// ─── validateKnowledgeList ───────────────────────────────────────────────────

describe('validateKnowledgeList', () => {
    const GOOD = { fact: 'Learned the smugglers use the north wharf', source: 'told', date: 'Day 5' };

    test('drops invalid items whole and reports their indexes', () => {
        const { items, rejected } = validateKnowledgeList([
            GOOD,
            { fact: '' },
            { fact: 'multi\nline fact' },
            'not an object',
            { fact: 'valid fact but the source rambles on far past any reasonable attribution note', source: 's'.repeat(81) },
            { fact: 'knows the gate code is 7314', source: 'told', date: 'Day 30' },
        ]);
        expect(items).toEqual([GOOD, items[1]]);
        expect(items).toHaveLength(2);
        expect(items[1].fact).toBe('knows the gate code is 7314');
        expect(rejected.map(r => r.index)).toEqual([1, 2, 3, 4]);
        for (const r of rejected) expect(r.reason).toBeTruthy();
    });

    test('non-array input is empty, not an error', () => {
        expect(validateKnowledgeList(undefined)).toEqual({ items: [], rejected: [] });
        expect(validateKnowledgeList({})).toEqual({ items: [], rejected: [] });
    });

    test('the Phase 0 ledger coverage corpus validates cleanly — it is the legitimate shape', () => {
        expect(validateKnowledgeList(cloneLedgerCoverageRecords())).toEqual({ items: cloneLedgerCoverageRecords(), rejected: [] });
    });
});

// ─── validateScanRecord (seam S1 helper) ─────────────────────────────────────

describe('validateScanRecord', () => {
    test('cleans a new_major creation record: invalid flat field, invalid knowledge item', () => {
        const record = {
            name: 'Ezra Blackwell',
            species: 'Human',
            tone: 'quiet, precise',
            role: 'chock duty\nand photo-hanging',
            initial_knowledge: [
                { fact: 'stamped the Braun dock manifests', source: 'witness', date: 'Day 214' },
                { fact: '' },
            ],
        };
        const { data, rejections } = validateScanRecord(record);
        expect(data.name).toBe('Ezra Blackwell');
        expect(data.species).toBe('Human');
        expect(data.tone).toBe('quiet, precise');
        // Null is the create-side unknown convention: formatDossierEntry
        // omits the line entirely.
        expect(data.role).toBeNull();
        expect(data.initial_knowledge).toHaveLength(1);
        expect(rejections.map(r => r.field).sort()).toEqual(['initial_knowledge[1]', 'role']);
        // The caller's record object is never mutated.
        expect(record.role).toBe('chock duty\nand photo-hanging');
        expect(record.initial_knowledge).toHaveLength(2);
    });

    test('an update record with an invalid nested field is cleaned; a valid record passes through unchanged', () => {
        const invalid = { name: 'Mara Voss', fields: { tone: 'brisk', appearance: 'z'.repeat(901) }, new_knowledge: [] };
        const cleaned = validateScanRecord(invalid);
        expect(cleaned.data.fields.appearance).toBeNull();
        expect(cleaned.data.fields.tone).toBe('brisk');
        expect(cleaned.rejections.map(r => r.field)).toEqual(['appearance']);

        const valid = { name: 'Mara Voss', fields: { tone: 'brisk' }, new_knowledge: [] };
        const passthrough = validateScanRecord(valid);
        expect(passthrough.data).toBe(valid); // no copy when nothing changed
        expect(passthrough.rejections).toEqual([]);
    });

    test('every Phase 0 role-scenario scanUpdate passes the contract (bounds are not scope enforcement)', () => {
        for (const [id] of Object.entries(ROLE_SCENARIOS)) {
            const { data, rejections } = validateScanRecord(cloneRoleScenario(id).scanUpdate);
            expect(rejections, `scenario ${id}`).toEqual([]);
            expect(data.fields.role, `scenario ${id} keeps its (drifted but structurally valid) role`).toBeTruthy();
        }
    });
});

// ─── Prompt guidance renders from the same definitions ──────────────────────

describe('contractPromptBlock', () => {
    test('dossier mode covers every contract field and the three general rules', () => {
        const block = contractPromptBlock({ mode: 'dossier' });
        for (const def of FIELD_CONTRACT) {
            expect(block).toContain(`${def.label}: ${def.belongs}`);
            expect(block).toContain(`Not: ${def.notBelongs}`);
        }
        expect(block).toContain('MEANINGFUL change');
        expect(block).toContain('CURRENT CONCISE VALUE');
        expect(block).toContain('durable takeaways');
        // Role guidance states the stable-until-meaningful-change rule and
        // names the relationship allowance, per scope §3.1.
        expect(block).toContain('Role: established occupation, enduring responsibility, or primary story function');
    });

    test('compact mode covers only the compact-format fields', () => {
        const block = contractPromptBlock({ mode: 'compact' });
        expect(block).toContain('Tone:');
        expect(block).toContain('Perceived as:');
        expect(block).toContain('Descriptor:');
        expect(block).toContain('First seen:');
        expect(block).not.toContain('- Role:');
        expect(block).not.toContain('- Current Agenda:');
    });

    test('the block never uses vocabulary the enrichment contract forbids', () => {
        // test/knowledge_ledger_prompt.test.js pins that DOSSIER_ENRICH_PROMPT
        // does not match /consolidat/i or "existing ledger + new" — the block
        // is embedded in that prompt, so it must keep that promise too.
        for (const mode of ['compact', 'dossier']) {
            const block = contractPromptBlock({ mode });
            expect(block).not.toMatch(/consolidat/i);
            expect(block).not.toMatch(/existing ledger \+ new/i);
        }
    });
});
