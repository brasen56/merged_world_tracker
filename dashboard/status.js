/**
 * dashboard/status.js — Read-only data collector for the Overview dashboard.
 *
 * This module owns no state and performs no rendering. It only aggregates the
 * existing public accessors behind independently guarded cells, so one broken
 * subsystem can never prevent the rest of the Overview pane from rendering.
 */

import { getDocumentStatus as readDocumentStatus } from '../world_state/index.js';
import {
    getStagingCount as readStagingCount,
    getGrowthEvidenceCount as readGrowthEvidenceCount,
} from '../knowledge/index.js';
import { getBeatStatus as readBeatStatus } from '../story_planner/index.js';
import {
    getActiveLedger as readActiveLedger,
    getDormantLedger as readDormantLedger,
    getDeletedIntentions as readDeletedIntentions,
} from '../interiority/data.js';
import { collectBudgetSnapshot as readBudgetSnapshot } from '../budget/panel.js';
import { getCoordinatorSnapshot as readCoordinatorSnapshot } from '../core/coordinator.js';
import { collectHealthSnapshot as readHealthSnapshot } from '../diagnostics_panel/health.js';
import { collectQuarantineStatus as readQuarantineStatus } from '../backup/recovery.js';

/** Convert any thrown value into the JSON-safe error text used by a cell. */
function errorMessage(error) {
    try {
        return String(error?.message ?? error);
    } catch {
        return 'Unknown error';
    }
}

/**
 * Run one Overview read without allowing its failure to escape the cell.
 * `undefined` is normalized to null because JSON.stringify omits undefined
 * object properties, which would violate the stable `{ ok, value }` shape.
 */
function collectCell(read) {
    try {
        return { ok: true, value: read() ?? null };
    } catch (error) {
        return { ok: false, error: errorMessage(error) };
    }
}

/**
 * Collect all status signals consumed by the Overview dashboard.
 *
 * Dependencies use the production accessor names so tests and other callers
 * can replace any read without mocking module imports. The returned object is
 * composed only of the JSON-safe values supplied by those public accessors and
 * string errors; it contains no functions, promises, or host objects of its
 * own.
 *
 * @param {object} [deps] injectable read-only accessors
 * @returns {object} ten independently guarded Overview cells
 */
export function collectOverviewSnapshot({
    getDocumentStatus = readDocumentStatus,
    getStagingCount = readStagingCount,
    getGrowthEvidenceCount = readGrowthEvidenceCount,
    getBeatStatus = readBeatStatus,
    getActiveLedger = readActiveLedger,
    getDormantLedger = readDormantLedger,
    collectBudgetSnapshot = readBudgetSnapshot,
    getCoordinatorSnapshot = readCoordinatorSnapshot,
    collectHealthSnapshot = readHealthSnapshot,
    getDeletedIntentions = readDeletedIntentions,
    collectQuarantineStatus = readQuarantineStatus,
} = {}) {
    return {
        worldState: collectCell(() => getDocumentStatus()),
        staging: collectCell(() => getStagingCount()),
        growthEvidence: collectCell(() => getGrowthEvidenceCount()),
        beats: collectCell(() => getBeatStatus()),
        intentions: collectCell(() => ({
            active: getActiveLedger(),
            dormant: getDormantLedger(),
        })),
        budget: collectCell(() => collectBudgetSnapshot()),
        coordinator: collectCell(() => getCoordinatorSnapshot()),
        health: collectCell(() => collectHealthSnapshot()),
        deletedIntentions: collectCell(() => getDeletedIntentions()),
        quarantine: collectCell(() => collectQuarantineStatus()),
    };
}
