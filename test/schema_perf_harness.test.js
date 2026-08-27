/**
 * test/schema_perf_harness.test.js — §7.2 performance harness (Part 3).
 *
 * SCHEMA_VALIDATION_MIGRATIONS_PLAN.md §7.2 sets two budgets, measured against
 * the ~1,940-entry reference chat:
 *
 *   | Path                                             | Budget          |
 *   |--------------------------------------------------|-----------------|
 *   | Fast load gate on a current-schema chat switch    | p95 ≤ 5 ms      |
 *   | One-time legacy migration, synchronous            | < 50 ms         |
 *
 * This file is the harness that keeps those budgets honest: it synthesizes a
 * reference-scale fixture (roughly 1,940 knowledge records plus the other
 * stores at a long-chat scale), measures BOTH paths, and fails when a budget
 * is exceeded. A migration that cannot meet the 50 ms ceiling may not run on
 * the synchronous hot path (design §7.2) — it must take the module-local
 * preparation state instead — so exceeding the budget here is a design gate,
 * not a flaky timing.
 *
 * Recorded baselines live in upcoming_work_misc/SCHEMA_PERF_BASELINES.md;
 * re-record them (run this file and copy the table it prints) whenever a
 * migration or validator changes shape.
 *
 * Determinism: the fixture is generated from indexes only (no random), so
 * runs are comparable across machines and time. Timings use a p95 tail for
 * the gate (per-switch cost, many samples) and p95-of-20 for migrations
 * (one-time cost, JIT-warmed after the first pass, tolerating a single
 * environment outlier) — the §7.2 budgets are ceilings, and a median can
 * pass while several runs cross the line.
 */

import { describe, test, expect } from 'vitest';
import { STORE_SCHEMAS } from '../schema/registry.js';
import { runFastLoadGate } from '../schema/gate.js';
import { prepareStore } from '../core/schema.js';
import { createSchemaManifest } from '../schema/manifest.js';

// ─── Reference-scale fixture ─────────────────────────────────────────────────
//
// The reference chat (Diagnostics design §I.6) carries ~1,940 knowledge
// entries. The dominant schema-visible cost of that scale is the evidence
// record walk, so the fixture puts ~1,940 records there and scales every other
// store to a long chat: a century of chronicle snapshots, a busy interiority
// ledger/perMessage map, a mature arc plan, and a receipts log. Sizes are
// chosen to be deterministic and comparable — not to mimic any one user.

const NPC_COUNT = 55;
const RAW_PER_NPC = 30;
const CONSOLIDATED_PER_NPC = 5;
// 55 × (30 raw + 5 consolidated) = 1,925 records ≈ the reference chat's scale.
const REFERENCE_RECORDS = NPC_COUNT * (RAW_PER_NPC + CONSOLIDATED_PER_NPC);

function pad(index, width = 4) {
    return String(index).padStart(width, '0');
}

function referenceWorldState() {
    const paragraph = (i) => `## Current Scene\nThe moon bridge ${pad(i)} is open; the ferrymen refuse coin.\n`
        + `## Recent Changes\nMara seized the ledger${i}; the guild closed the east gate.\n`
        + `## Pending\nThe duel at dawn${i} still lacks a second.\n`;
    return {
        text: Array.from({ length: 12 }, (_, i) => paragraph(i)).join('\n'),
        autoSaveHistory: Array.from({ length: 40 }, (_, i) => ({
            text: paragraph(i),
            timestamp: 1_700_000_000_000 + i * 3_600_000,
        })),
    };
}

function referenceChronicle() {
    return {
        snapshots: Array.from({ length: 120 }, (_, i) => ({
            id: `snap-${pad(i)}`,
            text: `Session ${i}: the party crossed the ash bridge and the ferryman asked for a name instead of coin. `
                + `Mara refused; the ledger stayed shut. Thread ${i} of the succession plot advanced one beat.`,
            createdAt: `2025-01-${pad((i % 28) + 1, 2)}T12:00:00.000Z`,
            manual: i % 7 === 0,
            consolidated: i % 5 === 0,
            worldDate: `Day ${i + 1}`,
        })),
        _deletedBin: Array.from({ length: 15 }, (_, i) => ({
            id: `del-${pad(i)}`,
            text: `Superseded session summary ${i} awaiting consolidation.`,
            createdAt: `2025-02-${pad((i % 28) + 1, 2)}T12:00:00.000Z`,
        })),
    };
}

function referenceKnowledgeEvidence() {
    const map = {};
    for (let npc = 0; npc < NPC_COUNT; npc++) {
        const name = `Reference NPC ${pad(npc)}`;
        const raw = Array.from({ length: RAW_PER_NPC }, (_, i) => ({
            id: `obs-${pad(npc)}-${pad(i)}`,
            category: ['appearance', 'goal', 'secret', 'asset', 'relationship'][i % 5],
            claim: `NPC ${pad(npc)} intends to settle debt ${i} before the frost fair.`,
            quote: `"The ferryman takes names, not coin — not this season," she said (${i}).`,
            msgIdx: npc * RAW_PER_NPC + i,
            ts: 1_700_000_000_000 + i * 60_000,
            capturedAt: 1_700_000_000_000 + i * 60_000,
        }));
        const consolidated = Array.from({ length: CONSOLIDATED_PER_NPC }, (_, i) => ({
            id: `con-${pad(npc)}-${pad(i)}`,
            claim: `NPC ${pad(npc)} consolidated finding ${i}: the succession plot is ahead of the guild.`,
            sources: raw.slice(i * 4, i * 4 + 4).map(observation => observation.id),
            firstSeen: 1_700_000_000_000,
            lastSeen: 1_700_100_000_000,
            confidence: 0.6 + (i % 4) * 0.1,
        }));
        map[name] = {
            npc: name,
            raw,
            consolidated,
            archivedRaw: [],
            userOverrides: [],
            meta: { createdAt: 1_700_000_000_000, updatedAt: 1_700_100_000_000, lastProfileAt: null },
        };
    }
    return map;
}

function referenceKnowledgeCounters() {
    return {
        messageCounter: 4100,
        npcMessageCounter: 37,
        growthMessageCounter: 19,
        relationshipMessageCounter: 7,
        countedReceiptEvents: Array.from({ length: 200 }, (_, i) => [
            `id:msg-${pad(i)}`,
            { npc: i % 2, growth: (i + 1) % 2, relationship: i % 3 === 0 ? 1 : 0 },
        ]),
    };
}

function referenceStoryPlanner() {
    const sections = ['immediate', 'emerging', 'horizon', 'character', 'unresolved'];
    return {
        arcs: Array.from({ length: 15 }, (_, i) => ({
            id: `arc-${pad(i)}`,
            title: `Arc ${i}: the ash bridge succession`,
            body: `The guild wants the bridge named; the ferrymen want it forgotten. Endpoint ${i}: a duel nobody wins.`,
            section: sections[i % sections.length],
            status: i % 6 === 5 ? 'resolved' : 'active',
            pinned: i % 4 === 0,
            beats: Array.from({ length: 4 }, (unused, b) => `Beat ${b}: pressure the ferryman's ledger (arc ${i}).`),
            beatIndex: i % 4,
            turnsSinceAdvance: i % 12,
            createdAt: 1_700_000_000_000 + i,
            updatedAt: 1_700_100_000_000 + i,
        })),
        history: Array.from({ length: 30 }, (_, i) => ({
            arcs: [],
            savedAt: 1_700_000_000_000 + i * 60_000,
            label: `autosave ${i}`,
        })),
    };
}

function referenceInteriority() {
    return {
        enabled: true,
        ledger: Array.from({ length: 120 }, (_, i) => ({
            id: `int-${pad(i)}`,
            npc: `Reference NPC ${pad(i % NPC_COUNT)}`,
            action: `settle debt ${i} with the ferryman`,
            trigger: `when the ledger ${i} is open on deck`,
            since: `Day ${i + 1}`,
            declaredMsgIdx: i,
            turnsOpen: i % 20,
            status: i % 9 === 8 ? 'dormant' : 'active',
        })),
        deletedIntentions: [],
        // Canonical mu-* keys only: the legacy numeric/sd-* conversion is
        // chat-DEPENDENT (it needs live message UUIDs) and is therefore not
        // eligible for the synchronous hot path at all — it is not
        // benchmarked here by design (§7.2/§7.5).
        perMessage: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [
            `mu-7b1c-${pad(i, 8)}`,
            {
                reactions: [{ npc: `Reference NPC ${pad(i % NPC_COUNT)}`, re: 'wary', thought: `The coin is a promise (message ${i}).` }],
                ledgerSnapshot: [],
                generatedAt: 1_700_000_000_000 + i,
            },
        ])),
        turnCounter: 240,
    };
}

function referenceKnowledgeStore() {
    const registry = {};
    const relationships = {};
    for (let npc = 0; npc < NPC_COUNT; npc++) {
        const name = `Reference NPC ${pad(npc)}`;
        registry[name] = { uid: npc, type: npc % 3 === 0 ? 'major' : 'minor', keywords: [name], lastUpdated: 1_700_000_000_000 };
        if (npc % 5 === 0) {
            relationships[name] = [{ target: `Reference NPC ${pad(npc + 1)}`, type: 'rival' }];
        }
    }
    return {
        version: 1,
        registry,
        relationships,
        stances: {},
        stanceSources: {},
        stateRegistry: {},
    };
}

/** The full reference chat, as raw (pre-v1) chat metadata would hold it. */
function buildReferenceFixture() {
    return {
        worldState: referenceWorldState(),
        chronicle: referenceChronicle(),
        knowledgeEvidence: referenceKnowledgeEvidence(),
        knowledgeCounters: referenceKnowledgeCounters(),
        storyPlanner: referenceStoryPlanner(),
        interiority: referenceInteriority(),
        knowledgeStore: referenceKnowledgeStore(),
    };
}

// ─── Timing helpers ──────────────────────────────────────────────────────────

function now() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
}

function timeSync(fn) {
    const start = now();
    fn();
    return now() - start;
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, p) {
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[index];
}

// ─── Harness ─────────────────────────────────────────────────────────────────

describe('schema performance harness — §7.2 budgets on the ~1,940-entry reference fixture', () => {
    const fixture = buildReferenceFixture();

    test('fixture is at reference scale (~1,940 knowledge records)', () => {
        expect(REFERENCE_RECORDS).toBe(1925);
        const evidenceRecords = Object.values(fixture.knowledgeEvidence)
            .reduce((sum, file) => sum + file.raw.length + file.consolidated.length, 0);
        expect(evidenceRecords).toBe(REFERENCE_RECORDS);
    });

    test('fast load gate meets the p95 ≤ 5 ms budget on a current-schema chat', () => {
        // A current-schema chat: every present store stamped at its current
        // version in the manifest, all roots objects — the per-switch case.
        const manifest = createSchemaManifest();
        const stores = {};
        for (const [id, schema] of Object.entries(STORE_SCHEMAS)) {
            if (schema.metadataKey) {
                manifest.sections[id] = schema.currentVersion;
                stores[id] = fixture[id];
            }
        }

        // Warm-up pass (JIT), then sample.
        const warm = runFastLoadGate({ manifest, stores });
        expect(warm.allReady).toBe(true);

        const samples = [];
        for (let i = 0; i < 500; i++) {
            samples.push(timeSync(() => runFastLoadGate({ manifest, stores })));
        }
        const p95 = percentile(samples, 95);
        const medianMs = median(samples);
        console.log(`[perf] fast load gate: median ${medianMs.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms over ${samples.length} runs (budget p95 ≤ 5 ms)`);
        expect(p95).toBeLessThanOrEqual(5);
    });

    test('every 0 → 1 migration meets the < 50 ms synchronous budget', () => {
        const results = [];
        for (const [id, schema] of Object.entries(STORE_SCHEMAS)) {
            const input = fixture[id];
            // Warm-up (the first run pays JIT/parser costs; the budget guards
            // the user's one-time migration, which runs on a warm page).
            const warm = prepareStore(schema, input, { version: 0 });
            expect(['valid', 'migrated', 'deferred']).toContain(warm.status);

            // §7.2 says the ONE synchronous migration the user pays must stay
            // under 50 ms — the median cannot police that: a median-of-7 run
            // passes even when several individual migrations exceed the
            // ceiling. The TAIL is what the budget enforces. p95 over 20 runs
            // tolerates exactly ONE outlier (index ceil(0.95·20)−1 = 18 of
            // 20, sorted), which is the "reasonable environment handling" a
            // shared CI box needs (a GC pause or scheduler hiccup), while
            // still failing as soon as two runs cross the line.
            const runs = [];
            for (let i = 0; i < 20; i++) {
                runs.push(timeSync(() => prepareStore(schema, input, { version: 0 })));
            }
            const med = median(runs);
            const p95 = percentile(runs, 95);
            const worst = Math.max(...runs);
            results.push({ id, median: med, p95, worst, status: warm.status });
            console.log(`[perf] ${id} 0→1 migration: median ${med.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms, worst ${worst.toFixed(3)} ms over ${runs.length} runs (budget p95 < 50 ms) — ${warm.status}`);
            // §7.2: a migration over the ceiling may not run on the
            // synchronous hot path. p95 guards the budget; the harness
            // records the median and worst case for the baseline document.
            expect(p95, `${id} migration exceeds the 50 ms synchronous budget — it must move to a module-local preparation state (§7.5)`).toBeLessThan(50);
        }
        // Sanity: every registered store was measured.
        expect(results.map(entry => entry.id).sort()).toEqual(Object.keys(STORE_SCHEMAS).sort());
    });

    test('current-version validation baseline (recorded, no budget)', () => {
        // §7.1: current-version data takes the fast path at load, so
        // validation at the current version is NOT on the hot path — but its
        // cost is the reference number for import/restore previews, so the
        // harness records it.
        for (const [id, schema] of Object.entries(STORE_SCHEMAS)) {
            const prepared = prepareStore(schema, fixture[id], { version: schema.currentVersion });
            const runs = [];
            for (let i = 0; i < 5; i++) {
                runs.push(timeSync(() => schema.validate(fixture[id])));
            }
            console.log(`[perf] ${id} validate@v${schema.currentVersion}: median ${median(runs).toFixed(3)} ms (status ${prepared.status}, ${prepared.issues.length} issue(s))`);
            expect(['valid', 'migrated', 'deferred']).toContain(prepared.status);
        }
    });
});

