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
 */
import { describe, test, expect } from 'vitest';

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

    test("enrichment drops the NPC's own plan-shaped ledger lines when consolidating", () => {
        // Enrich rewrites the whole ledger from existing content + history;
        // it is the one prompt that can CLEAN legacy pollution, so it must
        // not carry the NPC's own plan-shaped lines forward.
        expect(DOSSIER_ENRICH_PROMPT).toContain("DROP this NPC's own plan-shaped lines");
    });
});
