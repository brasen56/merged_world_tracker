/**
 * diagnostics_panel/log.js — Tab 6: Log (Diagnostics Phase 11).
 *
 * "What has MWT been doing this session?" (phases doc §II.4 Phase 11, design
 * §I.5 Tab 6): the Phase 0 ring buffer — every toast captured by
 * core/notifications.js, every API-call echo, every silent-recovery warn —
 * newest first, with per-level and per-module counts. Per decision D2 the tab
 * is open-and-read: the ring is read once when the modal is built and the
 * level/module filters are VIEW TOGGLES over the rendered rows (they never
 * re-read the store); re-opening the tab is the refresh model.
 *
 * REDACTION (the Phase 5 contract — every surface routes through
 * core/redaction.js, no hand-rolled redaction): unlike the Last request tab's
 * telemetry-by-construction capture, the ring DOES carry content — every toast
 * is recorded with `detail: { title, message }` and those message bodies quote
 * the chat (story beats, NPC names), while `wi_script_unavailable` records a
 * raw `detail.error`. So this snapshot goes through redactForReport() with the
 * LIVE content flag, NOT the "simple" redactSecretsDeep(): by default the
 * message/error fields collapse to size-only markers ("the safe summary") and
 * every remaining string is Rule-1b secret-scrubbed; the full — still
 * scrubbed — detail text is the separately gated reveal the opt-in checkbox
 * exists for (scrubLogDetailForDisplay, wired in render.js exactly like the
 * Phase 9 payload reveal: deferred insertion + secret scrubbing).
 *
 * DOM-free by design (the Phase 6 health.js pattern): the snapshot is a plain
 * object, the markup lives in diagnostics_panel/render.js, every dependency is
 * injectable, and every accessor call is individually guarded — a throwing
 * dependency degrades its own field plus an `errors` note, never the tab.
 *
 * Direct imports throughout for core singletons (NOT via core/index.js): the
 * barrel is aliased to test/stubs/core.js under Vitest, and this module must
 * read the real ring regardless (the barrel→stub alias trap, §II.3).
 */

import { MWT_VERSION } from '../core/version.js';
import { getEvents, LEVELS, RING_CAPACITY } from '../core/diagnostics.js';
import { redactForReport } from '../core/redaction.js';
// Live secret VALUES for the scrub list. report.js is a sibling collector (it
// does not import this module), so there is no cycle; the guarded
// collectKnownSecrets() returns [] with no SillyTavern runtime, keeping this
// unit-testable in Node (the last_request.js precedent).
import { collectKnownSecrets } from './report.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * The tab's level vocabulary — the Phase 0 store's LEVELS, low → high, frozen
 * so the chips (render.js) and the counts share one definition.
 */
export const LOG_LEVELS = Object.freeze([...LEVELS]);

/**
 * Count lookup for a snapshot's `levels` array. The counts ship as
 * `[{ level, count }]` pairs (the same shape as `modules`) rather than a
 * `{ error: N, ... }` map ON PURPOSE: core/redaction.js gates any field
 * literally named `error` (ERROR_KEYS — error BODIES can quote the chat), so
 * a map would have its `error` COUNT replaced by an exclusion marker the
 * moment the snapshot is redacted. Pair entries say what they are by VALUE
 * (`level: 'error'`), not by field name, so the numbers survive redaction.
 *
 * @param {Array<{level: string, count: number}>} levels — snapshot.levels
 * @param {string} name — a LOG_LEVELS member
 * @returns {number} the count (0 when absent)
 */
export function logLevelCount(levels, name) {
    const hit = (Array.isArray(levels) ? levels : []).find((l) => l?.level === name);
    return Number(hit?.count) || 0;
}


// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Defensive shape check for one ring event. The store only ever holds what
 * record() (core/diagnostics.js) put there, but the collector still normalises:
 * a malformed entry (hand-written via MWT.diagnostics, a future shape change)
 * must degrade ITS OWN cells, never break the table. `detail` is kept AS-IS —
 * content/error gating is the redaction layer's job (by field name), not this
 * normaliser's. `ageSec` is decorated here so the pane and the console bridge
 * can never disagree about it (the normaliseApiCall precedent).
 *
 * `seq` — the store's monotonic sequence number — is carried through because
 * it is the ONLY per-event-unique field: record() stamps ts at millisecond
 * resolution, so repeated events from one module in one millisecond share
 * ts/epoch/module/event. The reveal fingerprint (logEventKey) needs it to
 * select the right detail for exactly such rows.
 *
 * @param {object} raw — one getEvents() entry
 * @param {number} now — the snapshot's reference clock
 * @returns {object|null} the normalised event, or null when raw is not an object
 */
export function normaliseLogEvent(raw, now) {
    if (!raw || typeof raw !== 'object') return null;
    const ts = Number.isFinite(Number(raw.ts)) ? Number(raw.ts) : null;
    const level = (typeof raw.level === 'string' && LEVELS.includes(raw.level)) ? raw.level : 'info';
    return {
        seq: Number.isFinite(Number(raw.seq)) ? Number(raw.seq) : null,
        ts,
        epoch: Number.isFinite(Number(raw.epoch)) ? Number(raw.epoch) : null,
        level,
        module: (typeof raw.module === 'string' && raw.module) ? raw.module : '(no module)',
        event: (typeof raw.event === 'string' && raw.event) ? raw.event : '(unnamed)',
        detail: raw.detail,
        scopeKey: (typeof raw.scopeKey === 'string' && raw.scopeKey) ? raw.scopeKey : null,
        ageSec: ts != null ? Math.max(0, Math.round((now - ts) / 1000)) : null,
    };
}

/**
 * A stable fingerprint for one ring event — `seq|ts|epoch|module|event`. The
 * opt-in reveal (wireDiagnosticsPanel) uses it to match each rendered row to
 * the LIVE ring entry whose raw detail it must scrub and insert, without
 * trusting array indexes (the ring may have advanced since the pane was
 * built; a row whose event was evicted simply keeps its safe summary).
 *
 * `seq` leads because it is the disambiguator: ts has millisecond
 * resolution, so repeated events from the same module and epoch can share
 * every OTHER field — without seq the Map in revealLogDetails() would
 * collapse such rows onto one detail and several rows would display the
 * wrong event content. The monotonic seq is stamped by record() and survives
 * both normaliseLogEvent() and redactLogSnapshot() (a plain number under a
 * non-secret, non-content field name).
 *
 * @param {object} e — a ring entry (raw or normalised)
 * @returns {string}
 */
export function logEventKey(e) {
    return `${e?.seq ?? ''}|${e?.ts ?? ''}|${e?.epoch ?? ''}|${e?.module ?? ''}|${e?.event ?? ''}`;
}

// ─── Collector ────────────────────────────────────────────────────────────────

/**
 * Collect the Log tab snapshot. Read-only by contract (design §I.1): nothing
 * here writes the diagnostics stores — it only READS the Phase 0 ring
 * (getEvents(), newest first, capped at RING_CAPACITY by the store itself).
 *
 * `level` / `module` are DATA-side filters (the console bridge passes them so
 * `MWT.diagnostics.log({ level: 'error' })` mirrors `events()`); the tab
 * always collects unfiltered and filters as view toggles. They take the same
 * shapes getEvents() accepts: level a single string or array, module an exact
 * match. `levels` / `modules` counts always describe the WHOLE ring read (the
 * chips' numbers must not change because the bridge filtered); `events` /
 * `count` describe the filtered view; `total` is the unfiltered size.
 *
 * Snapshot shape:
 *   {
 *     generatedAt, mwtVersion,
 *     capacity,          // the store's RING_CAPACITY (context for `total`)
 *     total,             // retained events before any level/module filter
 *     count,             // events after the filter (== total for the tab)
 *     levels,            // [{ level, count }] over the whole ring (see logLevelCount)
 *     modules,           // [{ name, count }] over the whole ring, noisiest first
 *     events,            // the (filtered) events, newest first (normalised)
 *     warnings,          // e.g. error-events-present (level warn)
 *     bannerLevel,       // 'ok' | 'warn'
 *     errors?,           // degradation notes when an accessor threw
 *   }
 *
 * @param {object} [deps]
 * @param {function(): number} [deps.now] — clock (defaults Date.now)
 * @param {string} [deps.version] — MWT_VERSION (defaults the real constant)
 * @param {function(object=): object[]} [deps.events] — getEvents (newest first)
 * @param {number} [deps.capacity] — RING_CAPACITY
 * @param {string|string[]} [deps.level] — data-side level filter (bridge)
 * @param {string} [deps.module] — data-side module filter (bridge)
 * @returns {object} the snapshot
 */
export function collectLogSnapshot({
    now = Date.now,
    version = MWT_VERSION,
    events = getEvents,
    capacity = RING_CAPACITY,
    level,
    module,
} = {}) {
    const errors = [];

    /** Guarded accessor call — a throwing dependency degrades to `fallback`
     *  plus an `errors` note naming the field, never the whole tab. */
    const call = (field, fn, fallback) => {
        try {
            return fn();
        } catch (err) {
            errors.push(`${field}: ${err?.message || err}`);
            return fallback;
        }
    };

    const generatedAt = call('now', () => now(), Date.now());
    const rawEvents = call('events', () => events(), []);

    // Newest-first is the store's contract; a defensive re-sort costs nothing
    // and pins the table order even against a hand-fed dependency.
    const all = (Array.isArray(rawEvents) ? rawEvents : [])
        .map((e) => normaliseLogEvent(e, generatedAt))
        .filter((e) => e !== null)
        .sort((a, b) => (b.ts ?? -Infinity) - (a.ts ?? -Infinity));

    // ── Counts over the WHOLE ring (the chips' numbers), computed before any
    //    data-side filter is applied. Emitted as { level, count } pairs —
    //    see logLevelCount() for why not a map keyed `error`.
    const levelTally = Object.create(null);
    const moduleCounts = Object.create(null);
    for (const e of all) {
        levelTally[e.level] = (levelTally[e.level] ?? 0) + 1;
        moduleCounts[e.module] = (moduleCounts[e.module] ?? 0) + 1;
    }
    const levels = LOG_LEVELS.map((lvl) => ({ level: lvl, count: levelTally[lvl] ?? 0 }));
    const modules = Object.keys(moduleCounts)
        .map((name) => ({ name, count: moduleCounts[name] }))
        .sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name));

    // ── Data-side filter (console bridge only) — same predicate shapes
    //    getEvents() accepts, applied locally so the counts above stay whole.
    const levelSet = level === undefined ? null : new Set(Array.isArray(level) ? level : [level]);
    const filtered = all.filter((e) =>
        (!levelSet || levelSet.has(e.level)) && (module === undefined || e.module === module));

    // ── Warnings — the tab's one at-a-glance flag. Error-level events in the
    //    ring are the "something already failed" signal (a failed call echo,
    //    an error toast); warn-level silent recoveries stay readings in the
    //    table, not verdicts (the last-request tab's rule: an older failure is
    //    a row, the banner is for what needs eyes now).
    const warnings = [];
    const errorCount = logLevelCount(levels, 'error');
    if (errorCount > 0) {
        warnings.push({
            id: 'error-events-present',
            level: 'warn',
            text: `${errorCount} error-level event(s) are in the ring — a failed API-call echo or an error toast. Untick every level but error (or run MWT.diagnostics.log({ level: 'error' })) to see only those; pair with the ❤️ Health tab's last-run column and the 📡 Last request tab for the call itself. Error TEXT is content-gated exactly like toast bodies — tick the opt-in above for the scrubbed bodies.`,
        });
    }
    const bannerLevel = warnings.length ? 'warn' : 'ok';

    return {
        generatedAt,
        mwtVersion: String(version ?? MWT_VERSION),
        capacity: Number(capacity) || RING_CAPACITY,
        total: all.length,
        count: filtered.length,
        levels,
        modules,
        events: filtered,
        warnings,
        bannerLevel,
        ...(errors.length ? { errors } : {}),
    };
}

// ─── Formatting / redaction (shared by the pane + the console bridge) ─────────

/**
 * Serialize a Log snapshot for SAFE return/render — what
 * `MWT.diagnostics.log()` returns and what the 📋 Log pane renders (the
 * Phase 5 contract: every surface routes through core/redaction.js; no
 * hand-rolled redaction).
 *
 * redactForReport() with the LIVE content flag (NOT redactSecretsDeep — this
 * data CAN carry content): by default every `message` inside an event's
 * `detail` collapses to a size-only `[content excluded — N chars]` marker and
 * every `error` to `[error excluded — N chars]` ("the safe summary"), while
 * `title` / `event` / `module` / `level` / `ts` / counts stay; EVERY string is
 * Rule-1b scrubbed in BOTH modes (known secret values, embedded URLs →
 * scheme+host, key/bearer shapes). `{ includeContent: true }` is the report
 * opt-in: full — still scrubbed — message/error bodies.
 *
 * The input is never mutated; the output shares no references with it.
 *
 * @param {object} snapshot — collectLogSnapshot() output
 * @param {object} [opts]
 * @param {boolean} [opts.includeContent=false] — the live opt-in state
 * @param {string[]} [opts.knownSecrets] — live secret VALUES; defaults to
 *        collectKnownSecrets() (guarded; [] with no SillyTavern runtime)
 * @returns {object} a redacted deep copy
 */
export function redactLogSnapshot(snapshot, { includeContent = false, knownSecrets } = {}) {
    return redactForReport(snapshot, {
        includeContent,
        knownSecrets: knownSecrets ?? collectKnownSecrets(),
    });
}

/**
 * Scrub one event's RAW detail for on-screen display once the content opt-in
 * is ticked — the log-tab sibling of the Injection tab's
 * scrubPayloadForDisplay(): opting into CONTENT never opts into SECRETS, so
 * the reveal inserts the redacted-with-content copy as textContent and the
 * raw detail never enters the DOM at all.
 *
 * @param {*} detail — the event's raw detail (any shape record() accepted)
 * @param {{ knownSecrets?: string[] }} [opts] — live secret VALUES (see
 *        collectKnownSecrets() in ./report.js); pass [] to test shape-scrubbing
 * @returns {string} the scrubbed, serialized detail — '' when there is none
 */
export function scrubLogDetailForDisplay(detail, { knownSecrets } = {}) {
    if (detail == null) return '';
    const redacted = redactForReport(detail, { includeContent: true, knownSecrets });
    try {
        return JSON.stringify(redacted) ?? '';
    } catch {
        // Redaction replaces opaque objects with labels, so this is
        // unreachable in practice — kept so a pathological detail degrades to
        // a marker instead of throwing inside a change handler.
        return '[unserializable detail]';
    }
}

/**
 * Format a snapshot event age for humans: `just now`, `45s ago`, `3m ago`,
 * `2h 05m ago`, `1d 4h ago`. The same buckets as the Last request tab's
 * formatRequestAge() (each tab owns its formatter — the health.js
 * formatHealthDuration precedent) so the two can never disagree.
 *
 * @param {number|null} sec
 * @returns {string}
 */
export function formatLogAge(sec) {
    if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return '—';
    if (sec < 10) return 'just now';
    if (sec < 60) return `${Math.round(sec)}s ago`;
    if (sec < 3_600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86_400) {
        const h = Math.floor(sec / 3_600);
        const m = Math.floor((sec % 3_600) / 60);
        return `${h}h ${String(m).padStart(2, '0')}m ago`;
    }
    return `${Math.floor(sec / 86_400)}d ${Math.floor((sec % 86_400) / 3_600)}h ago`;
}
