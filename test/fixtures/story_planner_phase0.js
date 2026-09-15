/**
 * Literal Story Planner v1 compatibility records used by the Phase 0 safety net.
 *
 * These fixtures deliberately keep beats as strings. `beatIndex` is the only
 * durable evidence that the user confirmed a beat as planted in store v1; model
 * output is merely a proposal and must never gain that progress by position.
 */

export const V1_PROGRESS_ARC = Object.freeze({
    id: 'v1-progress-arc',
    title: 'The Harbour Ledger',
    body: 'The falsified accounts expose the harbourmaster.',
    section: 'horizon',
    status: 'active',
    pinned: true,
    beats: Object.freeze([
        'Mara notices the duplicate seal.',
        'Derek obtains the original ledger.',
        'They confront the harbourmaster.',
    ]),
    beatIndex: 1,
    turnsSinceAdvance: 17,
    createdAt: 1756000000000,
    updatedAt: 1756000001000,
});

export const V1_READY_ARC = Object.freeze({
    id: 'v1-ready-arc',
    title: 'The Bell at Low Tide',
    body: 'The drowned bell finally rings beneath the harbour.',
    section: 'unresolved',
    status: 'active',
    pinned: false,
    beats: Object.freeze([
        'The cracked clapper is recovered.',
        'The tide chart points to midnight.',
    ]),
    beatIndex: 2,
    turnsSinceAdvance: 24,
    createdAt: 1756000002000,
    updatedAt: 1756000003000,
});

export const V1_CLOSED_ARCS = Object.freeze([
    Object.freeze({
        ...V1_PROGRESS_ARC,
        id: 'v1-resolved-arc',
        title: 'The Customs Bribe',
        status: 'resolved',
        pinned: false,
        beats: Object.freeze(['Mara finds the marked coin.']),
        beatIndex: 1,
    }),
    Object.freeze({
        ...V1_PROGRESS_ARC,
        id: 'v1-dropped-arc',
        title: 'The Northern Detour',
        status: 'dropped',
        beats: Object.freeze(['Book passage on the ice ferry.']),
        beatIndex: 0,
    }),
]);

/** Return detached mutable records, as if JSON had crossed a storage boundary. */
export function cloneV1(value) {
    return JSON.parse(JSON.stringify(value));
}

export function makeV1PlannerStore() {
    const progress = cloneV1(V1_PROGRESS_ARC);
    const ready = cloneV1(V1_READY_ARC);
    return {
        arcs: [progress, ready, ...cloneV1(V1_CLOSED_ARCS)],
        history: [
            { arcs: [cloneV1(V1_PROGRESS_ARC)], timestamp: 1756000010000 },
            {
                text: '## Horizon Arcs\n- Legacy text snapshot — Kept for pre-structured history compatibility\n  1. A string beat survives',
                timestamp: 1756000011000,
            },
        ],
    };
}