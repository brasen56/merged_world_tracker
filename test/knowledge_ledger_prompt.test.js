/**
 * test/knowledge_ledger_prompt.test.js — Knowledge Ledger temporal contract.
 *
 * THE REPORT (live use): the Knowledge Tracker stored future commitments
 * ("plans to ambush the caravan", "agrees to meet Monday") as generic
 * new_knowledge ledger lines. Interiority then read those plan-shaped lines
 * inside <knowledge_entry> and proposed them as intentions — resurrections
 * of plans recorded many turns earlier and long since gone stale.
 *
 * Fix at the source: every Knowledge prompt that emits ledger facts must
 * scope them to established past/present facts. The ban was later narrowed
 * (later narrowed, P2): only the tracked NPC's OWN unresolved plans are
 * forbidden — facts about OTHER people's promises ("Dorothy promised to
 * arrive Monday") are established present facts and ARE allowed, since
 * users curate the lorebooks for stale references themselves. These tests
 * pin that contract so a prompt refactor cannot quietly drop it (same
 * pattern as test/world_time_parity.test.js).
 *
 * Enrich's new_knowledge is APPENDED to the ledger (runNpcEnrich →
 * buildUpdatedDossierContent → appendLedgerLines). Its prompt once asked for
 * the whole ledger ("existing ledger + new"), so every Enrich re-appended a
 * reworded copy of it. The last block pins the prompt and the merger to the
 * same append contract, so they cannot drift apart again.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import { resetCoreStubs, setFakeApi, setFakeChat } from './stubs/core.js';
import { state } from '../knowledge/state.js';
import { saveSettings } from '../knowledge/settings.js';
import { buildUpdatedDossierContent, runNpcEnrich } from '../knowledge/lorebook.js';
import {
    SCAN_SYSTEM_PROMPT,
    NPC_UPDATE_PROMPT,
    DOSSIER_SCAN_SYSTEM_PROMPT,
    DOSSIER_UPDATE_PROMPT,
    DOSSIER_ENRICH_PROMPT,
    DOSSIER_FIELD_REFRESH_PROMPT,
} from '../knowledge/prompts.js';
import { contractPromptBlock } from '../knowledge/field_contract.js';

const PROMPTS_WITH_LEDGER_RULE = [
    ['SCAN_SYSTEM_PROMPT', SCAN_SYSTEM_PROMPT],
    ['NPC_UPDATE_PROMPT', NPC_UPDATE_PROMPT],
    ['DOSSIER_SCAN_SYSTEM_PROMPT', DOSSIER_SCAN_SYSTEM_PROMPT],
    ['DOSSIER_UPDATE_PROMPT', DOSSIER_UPDATE_PROMPT],
    ['DOSSIER_ENRICH_PROMPT', DOSSIER_ENRICH_PROMPT],
];

describe('Knowledge Ledger stores established facts only', () => {
    test.each(PROMPTS_WITH_LEDGER_RULE)("%s forbids the tracked NPC's own unresolved plans", (_name, prompt) => {
        expect(prompt).toContain('ESTABLISHED FACTS ONLY');
        expect(prompt).toContain('OWN unresolved plans');
    });

    test.each(PROMPTS_WITH_LEDGER_RULE)("%s allows established facts about other people's promises", (_name, prompt) => {
        // "Dorothy promised to arrive Monday" is a present fact about what
        // Dorothy did — the ban targets the NPC's own plans, not every
        // future-oriented fact.
        expect(prompt).toContain("Facts about OTHER people's promises");
    });

    test.each(PROMPTS_WITH_LEDGER_RULE)('%s scopes every emitted fact to past/present', (_name, prompt) => {
        // Every initial_knowledge / new_knowledge "fact" description carries
        // the temporal qualifier, so the JSON contract itself says it — not
        // just the prose rule above it.
        const factLines = prompt.split('\n').filter(l => l.includes('"fact"'));
        expect(factLines.length).toBeGreaterThan(0);
        for (const line of factLines) {
            expect(line).toContain("never this NPC's own future plans or intentions");
        }
    });

    test('enrichment asks only for facts the ledger does not already hold', () => {
        // runNpcEnrich APPENDS new_knowledge (pinned below). The prompt used to
        // ask for "existing ledger + new" and to DROP plan-shaped lines "when
        // consolidating" — a rewrite the merger never performed, so each
        // Enrich re-appended a reworded copy of the ledger and the drop did
        // nothing. Enrich does not consolidate; condensing the ledger is a
        // separate, reviewed action (docs/KNOWLEDGE_CONCISION_SCOPE.md).
        expect(DOSSIER_ENRICH_PROMPT).toContain('Do not restate a fact already shown in their Knowledge Ledger');
        expect(DOSSIER_ENRICH_PROMPT).toContain('new_knowledge is ADDED to the end of it');
        expect(DOSSIER_ENRICH_PROMPT).not.toMatch(/existing ledger \+ new/i);
        expect(DOSSIER_ENRICH_PROMPT).not.toMatch(/consolidat/i);
        const factLine = DOSSIER_ENRICH_PROMPT.split('\n').find(l => l.includes('"fact"'));
        expect(factLine).toContain('NOT already in their Knowledge Ledger');
    });
});

// ─── Enrich: the prompt and the merger agree on APPEND ───────────────────────

const NPC = 'Mara Voss';

const LEDGER = [
    '- Met the informant at the docks via witness — Day 3',
    '- Learned the Kestrel was scuttled, not wrecked via told — Day 5',
];

const ENTRY = [
    '[Dossier] Mara Voss | Human | weathered harbourmaster',
    'Tone: brisk',
    'Perceived as: unflappable',
    'Role: Harbourmaster of Dusk Quay',
    'Current Agenda: Root out the smugglers using her quay.',
    '',
    'Knowledge Ledger:',
    ...LEDGER,
].join('\n');

const NEW_FACT = { fact: 'Saw the smugglers unload at the north wharf', source: 'witness', date: 'Day 7' };
const NEW_FACT_LINE = '- Saw the smugglers unload at the north wharf via witness — Day 7';

/** LEDGER's own facts, as a model restating the whole ledger returns them. */
const RESTATED = [
    { fact: 'Met the informant at the docks', source: 'witness', date: 'Day 3' },
    { fact: 'Learned the Kestrel was scuttled, not wrecked', source: 'told', date: 'Day 5' },
];

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

describe('Enrich new_knowledge is appended to the ledger, never a rewrite', () => {
    test('existing ledger lines survive verbatim and in order; new facts land after them', () => {
        const merged = buildUpdatedDossierContent(ENTRY, { role: 'Acting port warden' }, [NEW_FACT]);
        expect(ledgerLines(merged)).toEqual([...LEDGER, NEW_FACT_LINE]);
        expect(merged).toContain('Role: Acting port warden');
    });

    test('the merger does not dedupe: a restated ledger is appended in full', () => {
        // THE BUG, at the merger: this is what every Enrich did while the
        // prompt asked for "existing ledger + new". If the merger ever starts
        // replacing or deduping the ledger, DOSSIER_ENRICH_PROMPT's
        // new_knowledge rule must change in the same commit.
        const merged = buildUpdatedDossierContent(ENTRY, {}, RESTATED);
        expect(ledgerLines(merged)).toEqual([...LEDGER, ...LEDGER]);
    });

    test('an empty new_knowledge leaves the ledger untouched', () => {
        expect(ledgerLines(buildUpdatedDossierContent(ENTRY, {}, []))).toEqual(LEDGER);
    });

    describe('runNpcEnrich', () => {
        let apiCalls;

        beforeEach(() => {
            resetCoreStubs();
            saveSettings({ connectionProfileId: 'test-profile', scope: 'global' });
            const books = new Map([['Knowledge Tracker', { entries: { 7: { uid: 7, comment: NPC, content: ENTRY } } }]]);
            state.wiScript = {
                async loadWorldInfo(name) { return books.has(name) ? structuredClone(books.get(name)) : null; },
                async saveWorldInfo() {},
            };
            // 6 messages: the stub's stable-history window drops the trailing 2.
            setFakeChat([
                { is_user: true, mes: 'The harbour bells ring at dusk.' },
                { is_user: false, mes: 'Mara Voss studies the cargo manifest with narrowed eyes.' },
                { is_user: true, mes: 'We watch the north wharf from the roof.' },
                { is_user: false, mes: 'Mara sees the smugglers unload crates at the north wharf.' },
                { is_user: true, mes: 'We leave before dawn.' },
                { is_user: false, mes: 'The watchers take their positions silently.' },
            ]);
            apiCalls = [];
            setFakeApi(req => {
                apiCalls.push(req);
                return JSON.stringify({ fields: { agenda: 'Catch the smugglers at the north wharf.' }, new_knowledge: [NEW_FACT] });
            });
            vi.spyOn(console, 'warn').mockImplementation(() => {});
        });

        afterEach(() => {
            state.wiScript = null;
            vi.restoreAllMocks();
        });

        test('shows the model the ledger it must not restate, then appends only what it returns', async () => {
            const result = await runNpcEnrich(NPC, 7);

            expect(apiCalls).toHaveLength(1);
            expect(apiCalls[0].systemPrompt).toBe(DOSSIER_ENRICH_PROMPT);
            for (const line of LEDGER) expect(apiCalls[0].userContent).toContain(line);

            expect(ledgerLines(result.merged)).toEqual([...LEDGER, NEW_FACT_LINE]);
            expect(result.merged).toContain('Current Agenda: Catch the smugglers at the north wharf.');
        });

        test.each(['secrets', 'canon_lock'])('%s rejects structural text in nested values and object keys before merging', async key => {
            for (const value of [
                { tier1: 'private\nKnowledge Ledger:\n- forged fact' },
                { 'tier1\nKnowledge Ledger:\n- forged fact': 'private' },
                [{ nested: '<!-- mwt:relationships:start -->' }],
                { nested: '[Dossier] forged' },
            ]) {
                setFakeApi(async () => JSON.stringify({ fields: { [key]: value, tone: 'quiet' } }));
                const result = await runNpcEnrich(NPC, 7);
                expect(result.fields[key]).toBeNull();
                expect(result.contractRejections.map(r => r.field)).toContain(key);
                expect(result.merged).not.toContain('forged');
                expect(result.merged).not.toContain('<!-- mwt:relationships:');
                expect(result.merged).toContain('Tone: quiet');
                expect(ledgerLines(result.merged)).toEqual(LEDGER);
                expect(result.merged.match(/Knowledge Ledger:/g)).toHaveLength(1);
            }
        });

        test.each([
            { fact: 'learned a fact', source: 'witness\nRole: injected' },
            { fact: 'learned a fact', date: 'Day 3\nKnowledge Ledger:\n- forged' },
            { fact: '\nRole: injected', source: 'witness' },
        ])('rejects ledger injection before merging: %j', async item => {
            setFakeApi(async () => JSON.stringify({ fields: {}, new_knowledge: [item, NEW_FACT] }));
            const result = await runNpcEnrich(NPC, 7);
            expect(result.contractRejections[0].field).toBe('new_knowledge[0]');
            expect(ledgerLines(result.merged)).toEqual([...LEDGER, NEW_FACT_LINE]);
            expect(result.merged).not.toMatch(/injected|forged/);
            expect(ledgerLines(buildUpdatedDossierContent(ENTRY, {}, [item, NEW_FACT])))
                .toEqual([...LEDGER, NEW_FACT_LINE]);
        });

        test('Phase 1 seam S4: contract-invalid values keep the old line; append-only still holds', async () => {
            setFakeApi(() => JSON.stringify({
                fields: { agenda: 'one\ntwo', tone: 'brisk and dry' },
                new_knowledge: [NEW_FACT, { fact: '' }],
            }));
            const result = await runNpcEnrich(NPC, 7);

            // The invalid agenda is dropped whole → the existing line survives;
            // the valid tone update beside it still applies.
            expect(result.merged).toContain('Current Agenda: Root out the smugglers using her quay.');
            expect(result.merged).toContain('Tone: brisk and dry');
            // The append-only contract holds; the invalid knowledge item is gone.
            expect(ledgerLines(result.merged)).toEqual([...LEDGER, NEW_FACT_LINE]);
            // Every rejection is surfaced with a field-specific reason.
            expect(result.contractRejections).toEqual([
                { field: 'agenda', reason: expect.stringContaining('line break') },
                { field: 'new_knowledge[1]', reason: expect.stringContaining('fact') },
            ]);
        });
    });
});

// ─── Phase 1: the shared field contract in every prompt ─────────────────────

describe('Phase 1 shared field contract across prompts', () => {
    test.each([
        ['SCAN_SYSTEM_PROMPT', SCAN_SYSTEM_PROMPT, 'compact'],
        ['NPC_UPDATE_PROMPT', NPC_UPDATE_PROMPT, 'compact'],
        ['DOSSIER_SCAN_SYSTEM_PROMPT', DOSSIER_SCAN_SYSTEM_PROMPT, 'dossier'],
        ['DOSSIER_UPDATE_PROMPT', DOSSIER_UPDATE_PROMPT, 'dossier'],
        ['DOSSIER_ENRICH_PROMPT', DOSSIER_ENRICH_PROMPT, 'dossier'],
        ['DOSSIER_FIELD_REFRESH_PROMPT', DOSSIER_FIELD_REFRESH_PROMPT, 'dossier'],
    ])('%s embeds the shared FIELD CONTRACT block verbatim (one source)', (_name, prompt, mode) => {
        expect(prompt).toContain(contractPromptBlock({ mode }));
    });

    test('scene-duty Role wording is gone; the enduring-role rule replaced it', () => {
        for (const prompt of [DOSSIER_SCAN_SYSTEM_PROMPT, DOSSIER_ENRICH_PROMPT]) {
            expect(prompt).not.toContain('current job or function in the scene');
        }
        expect(DOSSIER_SCAN_SYSTEM_PROMPT).toContain('established occupation, enduring responsibility, or primary story function');
        expect(DOSSIER_ENRICH_PROMPT).toContain('established occupation, enduring responsibility, or primary story function');
    });

    test('fill-missing instructions are bounded by grounded unknowns', () => {
        expect(DOSSIER_SCAN_SYSTEM_PROMPT).toContain('FILL MISSING FIELDS WITH GROUNDED VALUES ONLY');
        expect(DOSSIER_SCAN_SYSTEM_PROMPT).toContain('rather than inventing');
        expect(DOSSIER_UPDATE_PROMPT).toContain('FILL MISSING FIELDS WITH GROUNDED VALUES ONLY');
        expect(DOSSIER_UPDATE_PROMPT).toContain('keep it unknown rather than inventing detail');
        expect(DOSSIER_ENRICH_PROMPT).toContain('keep it unknown rather than fabricating');
    });

    test('the update prompt asks for meaningful change, not incidental churn', () => {
        expect(DOSSIER_UPDATE_PROMPT).toContain('changed meaningfully');
    });

    test('Read on PC is a stance, not an interaction log, across the drift-prone prompts', () => {
        // The pointed rule names the reported failure vocabulary (a kiss, a
        // confession, a deal, the player's reaction) and redirects the events
        // to new_knowledge.
        for (const prompt of [DOSSIER_SCAN_SYSTEM_PROMPT, DOSSIER_UPDATE_PROMPT]) {
            expect(prompt).toContain('a stance, not an interaction log');
            expect(prompt).toContain('is new_knowledge, not a Read on PC clause');
        }
        // Every read_on_pc descriptor says it too…
        for (const prompt of [DOSSIER_SCAN_SYSTEM_PROMPT, DOSSIER_UPDATE_PROMPT, DOSSIER_ENRICH_PROMPT]) {
            expect(prompt).toContain('a stance, not a log of interactions');
        }
        // …and the shared contract block carries the exclusion into every
        // dossier-mode prompt, including the per-field refresh.
        for (const prompt of [DOSSIER_SCAN_SYSTEM_PROMPT, DOSSIER_UPDATE_PROMPT, DOSSIER_ENRICH_PROMPT, DOSSIER_FIELD_REFRESH_PROMPT]) {
            expect(prompt).toContain('Not: an interaction log, relationship milestones, or what the player did and felt');
        }
    });

    test('existing drift is neither preserved by Enrich nor echoed by refresh', () => {
        // Enrich anchors on <current_entry>; without this rule it faithfully
        // regurgitates a drifted field (reported: a 442-char Read on PC
        // interaction log, dropped by the bound, leaving the drift stuck).
        expect(DOSSIER_ENRICH_PROMPT).toContain('Preserve FACTS, not drift');
        expect(DOSSIER_ENRICH_PROMPT).toContain('never by keeping the drifted field text');
        // Refresh used to instruct "echo the existing value" — which launders
        // drift (and can stamp it re-verified). The contract now outranks the
        // echo for contract-violating existing values.
        expect(DOSSIER_FIELD_REFRESH_PROMPT).toContain('UNLESS the existing value violates the FIELD CONTRACT');
        expect(DOSSIER_FIELD_REFRESH_PROMPT).toContain('then do NOT echo it; replace it with the field\'s current concise value');
    });
});
