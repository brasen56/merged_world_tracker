/**
 * schema/registry.js — One registry for every authoritative MWT store schema.
 *
 * Design §3.2 of SCHEMA_VALIDATION_MIGRATIONS_PLAN.md: schemas are
 * module-owned, but the registry is the single shared list. Backup, runtime
 * preparation, and Diagnostics all enumerate stores from HERE — never from a
 * second hand-maintained list.
 *
 * The registry ids intentionally match BOTH:
 *   - the backup section names (backup/data.js SECTION_KEYS), and
 *   - the future schema-manifest section names (design §3.3),
 * so one id addresses a store everywhere.
 *
 * This module may import module schemas (the one permitted core-to-feature
 * direction); module schemas import only core/schema.js and core/quarantine.js.
 * test/schema_engine.test.js enforces that statically.
 */
import { worldStateSchema } from '../world_state/schema.js';
import { chronicleSchema } from '../chronicle/schema.js';
import {
    knowledgeEvidenceSchema,
    knowledgeCountersSchema,
    knowledgeStoreSchema,
} from '../knowledge/schema.js';
import { storyPlannerSchema } from '../story_planner/schema.js';
import { interioritySchema } from '../interiority/schema.js';

/** Every authoritative store descriptor, keyed by store id. */
export const STORE_SCHEMAS = Object.freeze({
    worldState: worldStateSchema,
    chronicle: chronicleSchema,
    knowledgeEvidence: knowledgeEvidenceSchema,
    knowledgeCounters: knowledgeCountersSchema,
    storyPlanner: storyPlannerSchema,
    interiority: interioritySchema,
    knowledgeStore: knowledgeStoreSchema,
});

/** All registered store ids, in canonical order. */
export const SCHEMA_STORE_IDS = Object.freeze(Object.keys(STORE_SCHEMAS));

/** The six chat-metadata stores (they own a `metadataKey`; Knowledge's lorebook store does not). */
export const CHAT_METADATA_SCHEMA_IDS = Object.freeze(
    SCHEMA_STORE_IDS.filter(id => typeof STORE_SCHEMAS[id].metadataKey === 'string'),
);

/**
 * Look up a store schema by id (equivalently, by backup section name).
 * Unknown ids return null — an absent store stays absent and is never
 * manufactured just to satisfy a lookup (design §3.3).
 *
 * @param {string} id
 * @returns {object|null}
 */
export function getStoreSchema(id) {
    return STORE_SCHEMAS[id] ?? null;
}
