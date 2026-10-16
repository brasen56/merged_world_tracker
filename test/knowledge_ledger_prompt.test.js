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
} from '../knowledge/prompts.js';

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
    });
});
