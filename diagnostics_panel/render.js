/**
 * diagnostics_panel/render.js — Panel shell (Diagnostics Phase 5) + Tab 1
 * Health (Phase 6) + Tab 2 Environment (Phase 7) + Copy Report finalize
 * (Phase 13).
 *
 * The mount point every later tab plugs into (phases doc §II.4 Phase 5): a
 * 🩺 Diagnostics tab INSIDE the existing MWT modal (createModal infra — never
 * a fixed overlay, which collapses on SillyTavern mobile; design §I.6), a
 * secondary tab strip with empty placeholders for the seven v1 tabs, the
 * content opt-in checkbox (default off, consequence stated in the label —
 * design §I.6), and the Copy Report button wired to the D1 report shape
 * (./report.js).
 *
 * Phase 6 replaced the first placeholder with the real ❤️ Health tab
 * (./health.js for the snapshot, renderHealthPane/renderHealthSnapshot here
 * for the markup): one row per module — enabled · injection gate · busy ·
 * tokens · auto-countdown · last run — under a version / token-load header
 * and the unmissable panic-switch banner. Open-and-read per decision D2: the
 * modal is rebuilt on every open, which is this tab's refresh model.
 *
 * Phase 7 added the 🌐 Environment tab (./environment.js for the snapshot,
 * renderEnvironmentPane/renderEnvironmentSnapshot here): MWT + SillyTavern
 * versions, feature detection, and the raw context-field table — the
 * fork-compat probe. The one async probe (shared.js →
 * ConnectionManagerRequestService) starts as a "probing…" placeholder and is
 * filled in ONCE by wireDiagnosticsPanel() when it resolves — a deferred
 * fill, not a render loop, so decision D2 still holds.
 *
 * Phase 8 added the 🗂️ Scope & storage tab (./scope_storage.js for the
 * snapshot, renderScopePane/renderScopeSnapshot here): resolved identity +
 * epoch, which lorebooks this chat resolves to and WHY (re-derived
 * read-only — opening the tab never saves a binding), per-book hydration +
 * store versions, saved bindings, and the loud fallback-to-global warning
 * fueled by Phase 3's scope_fallback_global counter. Fully synchronous —
 * open-and-read, no wiring needed.
 *
 * Phase 9 added the 💉 Injection tab (./injection.js for the snapshot,
 * renderInjectionPane/renderInjectionSnapshot here): per module on/off ·
 * gate · resolved role/depth WITH provenance · token estimate · the Phase 2
 * recorded payload (collapsed <details>, age-stamped, behind the content
 * opt-in checkbox above — wireDiagnosticsPanel() inserts the payload text
 * only on opt-in, scrubbed through core/redaction.js — opting into content
 * never opts into secrets — and as textContent, never HTML), plus the
 * mandatory Knowledge lorebook caveat, which also closes TODO.md §4 "Panic
 * switch UI clarity". Fully synchronous — open-and-read; the only wiring is
 * the checkbox reveal.
 *
 * Phase 10 added the 📡 Last request tab (./last_request.js for the snapshot,
 * renderLastRequestPane/renderLastRequestSnapshot here): the Phase 1 capture
 * for the most recent call — one detail card (module · mode · model/profile ·
 * HTTP status · duration · retries · finish_reason · token usage · error
 * class) — plus the short history table, newest first, under window stats
 * (ok/failed, retries, token totals, avg/max duration) and a banner when the
 * most recent call failed. Telemetry by construction (never the prompt, API
 * key, custom headers, or response body), so there is no content to gate;
 * strings still route through the shared redaction layer on BOTH surfaces —
 * the console bridge AND the rendered pane (redactLastRequestSnapshot, Phase
 * 10 review). Fully synchronous — open-and-read, no wiring.
 *
 * Phase 11 added the 📋 Log tab (./log.js for the snapshot,
 * renderLogPane/renderLogSnapshot here): the Phase 0 ring buffer, newest
 * first, with per-level and per-module counts. The level chips and module
 * select are VIEW TOGGLES over the rendered rows — they never re-read the
 * store, so decision D2's open-and-read model is untouched (the pane is
 * re-built on every modal open). Event details carry chat content (toast
 * bodies) and raw error text, so the pane renders redactLogSnapshot() output
 * — size-only markers by default — and the content opt-in checkbox above
 * reveals the full (still secret-scrubbed) detail per row via
 * wireDiagnosticsPanel(), the same deferred-insertion + scrub guards the
 * Phase 9 payload reveal uses.
 *
 * Phase 12 added the 🛡️ Integrity tab (./integrity.js for the snapshot,
 * renderIntegrityPane/renderIntegritySnapshot here): on-demand read-only
 * checks — duplicate profile entries, dangling profileUid pointers,
 * evidence↔profile orphans, validateSection() per store (enumerated from the
 * METADATA_KEYS whitelist), Interiority ledger reference integrity. Unlike
 * Tabs 1–6 this pane is NOT open-and-read: every check is O(entries) across
 * lorebooks and chat metadata (the §I.6 scale note), so the pane renders an
 * idle state + a ▶ Run button and the checks only run on click
 * (runIntegrityChecks) — still one collect per render, never a render loop
 * and never on open. Counts + a top-N sample per check, with a "copy full
 * JSON" escape hatch (copyIntegritySnapshotJson); no repair actions in v1.
 *
 * Phase 13 finalized the 📋 Copy Report button (runCopyReport, extracted and
 * injectable like runIntegrityChecks): collectReportSections() (./report.js)
 * now serializes the tab accessors — health, environment (shared.js probe
 * awaited up front), scope, injection, integrity — alongside the Phase 0–4
 * accessors, which makes the collect async; the button disables + relabels
 * while it runs. The button press is the Phase 12 "on demand only" trigger
 * for the Integrity section (one press = one collect, never on open), and
 * buildReport()'s redaction gate still sees every section.
 *
 * Hard limits inherited from the design (§I.1): READ-ONLY — nothing here
 * writes to settings, chat metadata, or localStorage; the checkbox state is
 * deliberately not persisted, so every session starts with content EXCLUDED.
 *
 * DOM-coupled by design; all testable logic lives in core/redaction.js,
 * ./report.js, ./health.js, ./environment.js, ./scope_storage.js,
 * ./injection.js, and ./integrity.js.
 */

import { setStatus, escapeHtml } from '../core/index.js';
import { buildReport, collectReportSections, collectKnownSecrets } from './report.js';
import { collectHealthSnapshot, TOKEN_KINDS } from './health.js';
import { collectEnvironmentSnapshot, inspectConnectionManager, loadSharedModule } from './environment.js';
import { collectScopeSnapshot } from './scope_storage.js';
// Direct core/diagnostics.js import (NOT the barrel) per the §II.3 alias-trap
// rule: the payload reveal must read the REAL Phase 2 snapshot store, and the
// Phase 11 log reveal must read the REAL Phase 0 ring.
import { getAllInjectedSnapshots, getEvents } from '../core/diagnostics.js';
import {
    collectInjectionSnapshot,
    PLACEMENT_SOURCE_LABELS,
    ROLE_NUMBERS,
    formatInjectionAge,
    scrubPayloadForDisplay,
} from './injection.js';
// Diagnostics Phase 10 — Tab 5 Last request: the snapshot collector + shared
// age formatter behind the 📡 Last request sub-tab (the Phase 1 capture for
// the most recent call plus the short history).
import { collectLastRequestSnapshot, redactLastRequestSnapshot, formatRequestAge } from './last_request.js';
// Diagnostics Phase 11 — Tab 6 Log: the snapshot collector + redaction gate +
// reveal scrubber + fingerprint keys behind the 📋 Log sub-tab (the Phase 0
// ring, filterable by level and module, newest first).
// Diagnostics Phase 12 — Tab 7 Integrity: the async snapshot collector +
// redaction gate behind the 🛡️ Integrity sub-tab (on-demand read-only checks
// over lorebooks + chat metadata; counts + top-N samples, no chat prose).
import { collectIntegritySnapshot, redactIntegritySnapshot, INTEGRITY_SAMPLE_LIMIT } from './integrity.js';
import {
    collectLogSnapshot,
    redactLogSnapshot,
    scrubLogDetailForDisplay,
    logEventKey,
    logLevelCount,
    formatLogAge,
    LOG_LEVELS,
} from './log.js';

// ─── Panel tab definitions (design §I.5 — the seven v1 tabs) ─────────────────

/**
 * The seven Phase 6–12 tabs, in panel order. `phase` + `blurb` drive the
 * placeholder panes until each tab lands — an empty placeholder must still
 * say what WILL live there, so the shape of the panel is reviewable now.
 */
export const DIAGNOSTICS_PANEL_TABS = [
    {
        id: 'health',
        label: '❤️ Health',
        phase: 6,
        blurb: 'One row per module: enabled · injection gate · busy · tokens · auto-countdown · last run (time, ok/failed, duration).',
    },
    {
        id: 'environment',
        label: '🌐 Environment',
        phase: 7,
        blurb: 'MWT + SillyTavern versions and feature detection: which context APIs this build (or fork) actually exposes.',
    },
    {
        id: 'scope',
        label: '🗂️ Scope & storage',
        phase: 8,
        blurb: 'Resolved character/chat identity and epoch, which lorebooks this chat resolves to and why, bindings, hydration, store versions.',
    },
    {
        id: 'injection',
        label: '💉 Injection',
        phase: 9,
        blurb: 'Per module: on/off, resolved role and depth with provenance, token estimate, and the recorded payload (content opt-in).',
    },
    {
        id: 'last-request',
        label: '📡 Last request',
        phase: 10,
        blurb: 'The most recent API-call capture plus a short history, routed through the redaction layer.',
    },
    {
        id: 'log',
        label: '📋 Log',
        phase: 11,
        blurb: 'The event ring buffer, filterable by level and module, newest first. Open-and-read — re-open to refresh.',
    },
    {
        id: 'integrity',
        label: '🛡️ Integrity',
        phase: 12,
        blurb: 'On-demand read-only checks: duplicate profiles, dangling profileUid pointers, evidence orphans, store validation. Never runs on open.',
    },
];

/** DOM id of the content opt-in checkbox (read live by the copy handler). */
export const DIAGNOSTICS_CONTENT_OPT_IN_ID = 'mwt-diag-include-content';

// ─── Render ──────────────────────────────────────────────────────────────────

/**
 * Render the panel shell (static markup — no live data, no per-entry lists).
 * Called from index.js buildTabContent() for the 'diagnostics' main tab; the
 * modal body is rebuilt on every open, which is also what resets the content
 * opt-in to its default-off state.
 *
 * @returns {string} innerHTML for the tab
 */
export function renderDiagnosticsPanel() {
    const subTabButtons = DIAGNOSTICS_PANEL_TABS.map((t, i) =>
        `<button class="mwt-diag-tab-btn ${i === 0 ? 'active' : ''}" data-diag-tab="${t.id}">${t.label}</button>`
    ).join('');

    const subTabPanes = DIAGNOSTICS_PANEL_TABS.map((t, i) => `
        <div class="mwt-diag-tab-pane ${i === 0 ? 'active' : ''}" data-diag-tab="${t.id}">
            ${t.id === 'health' ? renderHealthPane() : (t.id === 'environment' ? renderEnvironmentPane() : (t.id === 'scope' ? renderScopePane() : (t.id === 'injection' ? renderInjectionPane() : (t.id === 'last-request' ? renderLastRequestPane() : (t.id === 'log' ? renderLogPane() : (t.id === 'integrity' ? renderIntegrityPane() : `
            <div class="mwt-diag-placeholder">
                <span class="mwt-diag-placeholder-badge">Phase ${t.phase} — not built yet</span>
                <p>${t.blurb}</p>
            </div>
            `))))))}
        </div>
    `).join('');

    return `
        <div class="mwt-diag-panel">
            <div class="mwt-diag-toolbar">
                <label class="mwt-diag-content-opt-in" for="${DIAGNOSTICS_CONTENT_OPT_IN_ID}">
                    <input type="checkbox" id="${DIAGNOSTICS_CONTENT_OPT_IN_ID}">
                    <span>Include prompt bodies, injected payloads &amp; full error text in the copied report —
                    <strong>⚠ the report will contain chat content</strong>; only turn this on if you mean to.</span>
                </label>
                <button id="mwt-diag-copy-report" class="mwt-btn mwt-btn-primary">📋 Copy Report</button>
            </div>
            <p class="mwt-diag-note">Read-only. Every report redacts your API key, custom headers, and API URL —
                including copies that leaked into error messages — and diagnostics data is in-memory only and resets
                on reload. With the checkbox off, error bodies are replaced by size-only markers; turning it on includes
                the verbatim error text (still secret-scrubbed), which can quote your chat — skim before pasting.</p>
            <div class="mwt-diag-tab-bar">${subTabButtons}</div>
            ${subTabPanes}
        </div>
    `;
}

// ─── Tab 1: Health (Phase 6) ──────────────────────────────────────────────────

/** Format a duration for the Last-run column: `830ms` / `3.2s` / `1m 04s`. */
export function formatHealthDuration(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return `${m}m ${String(s).padStart(2, '0')}s`;
}

/**
 * Render the Health pane markup from a snapshot (pure string builder — the
 * injectable formatTime keeps Node tests deterministic).
 *
 * @param {object} snapshot — collectHealthSnapshot() output
 * @param {{formatTime?: function(number): string}} [opts]
 * @returns {string} innerHTML for the pane
 */
export function renderHealthSnapshot(snapshot, { formatTime = (ts) => new Date(ts).toLocaleTimeString() } = {}) {
    const s = snapshot || {};
    const rows = Array.isArray(s.modules) ? s.modules : [];

    const badge = (text, tone) => `<span class="mwt-diag-badge mwt-diag-badge--${tone}">${text}</span>`;

    const autoCell = (auto) => {
        if (!auto) return `<span class="mwt-diag-dim" title="Auto-run is off for this module">off</span>`;
        if (auto.perTurn) {
            // Interiority: fires on every AI message; the counter describes the
            // dormant-intentions poll (its own accessor says so — Phase 4).
            const poll = auto.pollDue ? 'poll due' : (auto.interval > 0 ? `poll in ${auto.remaining}` : '');
            return `every turn${poll ? ` <span class="mwt-diag-dim">· ${poll}</span>` : ''}`;
        }
        if (auto.remaining <= 0) return badge('due now', 'warn');
        return `in ${auto.remaining} msg${auto.remaining !== 1 ? 's' : ''}`;
    };

    // The Tokens cell states WHICH kind of tokens it is counting. Four modules
    // report what they are injecting right now; Knowledge reports the size of
    // the lorebook it has written (see TOKEN_KINDS in health.js). Printed bare
    // in one column, a ~36k library reads as a ~36k injection — the single
    // most alarming misreading this tab can produce.
    const tokensCell = (r) => {
        const n = Number(r.tokens) || 0;
        const kind = TOKEN_KINDS[r.tokenKind] || TOKEN_KINDS.injected;
        const amount = n.toLocaleString();
        if (r.tokenKind === 'stored') {
            return `<span class="mwt-diag-tokens-stored" title="${escapeHtml(kind.title)}">${amount}
                <span class="mwt-diag-dim">stored</span></span>`;
        }
        return `<span title="${escapeHtml(kind.title)}">${amount}</span>`;
    };

    const lastRunCell = (run) => {
        if (!run) return `<span class="mwt-diag-dim">never</span>`;
        const dur = formatHealthDuration(run.durationMs);
        const bits = [formatTime(run.at), run.ok ? badge('ok', 'ok') : badge('FAILED', 'fail')];
        if (dur) bits.push(`<span class="mwt-diag-dim">${dur}</span>`);
        if (run.retries > 0) bits.push(`<span class="mwt-diag-dim">+${run.retries} retry</span>`);
        const titleParts = [];
        if (run.model) titleParts.push(`model/profile: ${run.model}`);
        if (run.status != null) titleParts.push(`HTTP ${run.status}`);
        titleParts.push(`source: ${run.source}`);
        if (run.trigger) titleParts.push(`trigger: ${run.trigger}`);
        return `<span class="mwt-diag-last-run" title="${escapeHtml(titleParts.join(' · '))}">${bits.join(' ')}</span>`;
    };

    const rowHtml = rows.map((r) => {
        const classes = ['mwt-diag-health-row'];
        if (!r.enabled) classes.push('mwt-diag-health-row--off');
        if (!r.injectionAllowed) classes.push('mwt-diag-health-row--gated');
        if (r.busy) classes.push('mwt-diag-health-row--busy');
        const errFlag = r.errors?.length
            ? ` <span class="mwt-diag-badge mwt-diag-badge--fail" title="${escapeHtml(r.errors.join('\n'))}">⚠</span>`
            : '';
        return `
            <tr class="${classes.join(' ')}" data-module="${r.id}">
                <td class="mwt-diag-health-module">${r.label}${errFlag}</td>
                <td>${r.enabled ? badge('on', 'ok') : badge('off', 'dim')}</td>
                <td>${r.injectionAllowed ? badge('open', 'ok') : badge('blocked', 'fail')}</td>
                <td>${r.busy ? badge('busy', 'warn') : '<span class="mwt-diag-dim">idle</span>'}</td>
                <td class="mwt-diag-health-tokens">${tokensCell(r)}</td>
                <td>${autoCell(r.auto)}</td>
                <td>${lastRunCell(r.lastRun)}</td>
            </tr>`;
    }).join('');

    // The panic switch is rendered unmissably (design §I.5 Tab 1): it is the
    // one global state that makes every "why is nothing injecting" report a
    // non-bug, so it leads the pane whenever it is on.
    // Shown next to the injected total, never added to it: it answers "why is
    // the Knowledge row so big" before the tester has to ask.
    const storedTokens = Number(s.storedTokens) || 0;
    const storedStat = storedTokens > 0
        ? `<span class="mwt-diag-health-stat mwt-diag-dim" title="${escapeHtml(TOKEN_KINDS.stored.title)}">+
             ${storedTokens.toLocaleString()} stored in lorebook (not injected)</span>`
        : '';

    const panicBanner = s.injectionMasterOff
        ? `<div class="mwt-diag-panic">⛔ <strong>PANIC SWITCH ON</strong> — injection &amp; scanning are stopped for every module
             (<code>injectionMasterOff</code>). Right-click the ⚙️ floating button to release it.</div>`
        : '';

    return `
        <div class="mwt-diag-health">
            <div class="mwt-diag-health-stats">
                <span class="mwt-diag-health-stat"><strong>MWT v${escapeHtml(String(s.mwtVersion ?? '?'))}</strong></span>
                <span class="mwt-diag-health-stat">injecting: <strong>${(Number(s.injectedTokens) || 0).toLocaleString()}</strong> tokens</span>
                ${storedStat}
                <span class="mwt-diag-health-stat">read at ${escapeHtml(formatTime(s.generatedAt ?? Date.now()))}</span>
            </div>
            ${panicBanner}
            <table class="mwt-diag-health-table">
                <thead>
                    <tr><th>Module</th><th>On</th><th>Gate</th><th>Busy</th><th>Tokens</th><th>Auto</th><th>Last run</th></tr>
                </thead>
                <tbody>${rowHtml}</tbody>
            </table>
            <p class="mwt-diag-note">Open-and-read — re-open this tab to refresh. "Last run" is the module's most recent
                API call (time · ok/failed · duration; hover for model/status); "never" is normal right after a reload —
                the capture is in-memory only. The "Gate" column collapses the panic switch and per-module disable into
                the one question that matters: may this module act right now — inject, or in Knowledge's case scan.<br>
                <strong>Tokens</strong> are what each module is injecting <em>right now</em> — except Knowledge, marked
                <em>stored</em>: those live in a lorebook and are never injected as a block. SillyTavern activates only
                the entries whose keywords match recent chat, so a large library is normal and is not prompt load.</p>
        </div>
    `;
}

/**
 * Collect + render the Health pane. Called at markup-build time inside
 * renderDiagnosticsPanel(): the modal body is rebuilt on every open, which is
 * this tab's whole refresh model (decision D2 — no render loop). A total
 * collection failure degrades to an error card, never a broken panel.
 *
 * @returns {string} innerHTML for the Health sub-tab pane
 */
export function renderHealthPane() {
    let snapshot;
    try {
        snapshot = collectHealthSnapshot();
    } catch (err) {
        return `
            <div class="mwt-diag-placeholder">
                <span class="mwt-diag-placeholder-badge">Health unavailable</span>
                <p>Collecting the health snapshot failed: ${escapeHtml(String(err?.message || err))}</p>
            </div>
        `;
    }
    return renderHealthSnapshot(snapshot);
}

// ─── Tab 2: Environment (Phase 7) ────────────────────────────────────────────

/** Shared badge builder (same tones as the Health pane's badges). */
function diagBadge(text, tone) {
    return `<span class="mwt-diag-badge mwt-diag-badge--${tone}">${text}</span>`;
}

/** DOM id of the shared.js Connection Manager cell wireDiagnosticsPanel() fills. */
export const DIAGNOSTICS_ENV_CMRS_CELL_ID = 'mwt-diag-env-cmrs-cell';

/**
 * Render the shared.js ConnectionManagerRequestService probe cell — used for
 * the unprobed placeholder at markup-build time AND re-used verbatim by
 * wireDiagnosticsPanel()'s one-shot deferred fill, so the cell cannot look
 * different depending on which path painted it.
 *
 * @param {object} probe — an inspectConnectionManager() result
 * @returns {string} innerHTML for the cell
 */
export function renderConnectionManagerCell(probe) {
    if (!probe?.probed) {
        return '<span class="mwt-diag-dim">probing… (shared.js import in flight — check again in a second)</span>';
    }
    if (probe.error) {
        return `<span title="${escapeHtml(probe.error)}">${diagBadge('shared.js import failed', 'fail')}
            <span class="mwt-diag-dim">connection profiles unavailable — hover for the error</span></span>`;
    }
    const availability = probe.available
        ? diagBadge('available', 'ok')
        : diagBadge('missing', 'fail');
    // constructPrompt is the member the Aikobots-4 fork removed; core/api.js
    // feature-detects around its absence, so missing ≠ broken — but a tester
    // on such a fork should see it called out, not buried.
    const promptPart = probe.constructPrompt
        ? '<span class="mwt-diag-dim">constructPrompt ✓</span>'
        : diagBadge('constructPrompt missing', 'warn');
    const sendPart = `<span class="mwt-diag-dim">sendRequest ${probe.sendRequest ? '✓' : '✗'}</span>`;
    return `<span title="the exact import core/api.js uses for connection-profile calls">${availability} ${promptPart} ${sendPart}</span>`;
}

/**
 * Render the Environment pane markup from a snapshot (pure string builder —
 * the injectable formatTime keeps Node tests deterministic). Everything
 * user-derived (names, avatars, ids, error text) is escaped: fork context
 * objects carry user-controlled strings.
 *
 * @param {object} snapshot — collectEnvironmentSnapshot() output
 * @param {{formatTime?: function(number): string}} [opts]
 * @returns {string} innerHTML for the pane
 */
export function renderEnvironmentSnapshot(snapshot, { formatTime = (ts) => new Date(ts).toLocaleTimeString() } = {}) {
    const s = snapshot || {};
    const premise = s.chatIdPremise || { level: 'unknown', note: '' };
    const features = Array.isArray(s.features) ? s.features : [];

    const stStat = s.stVersion
        ? `<span class="mwt-diag-health-stat">SillyTavern: <strong>${escapeHtml(String(s.stVersion))}</strong>
             <span class="mwt-diag-dim">(${escapeHtml(String(s.stVersionSource ?? '?'))})</span></span>`
        : '<span class="mwt-diag-health-stat">SillyTavern: <span class="mwt-diag-dim">version not exposed on this build</span></span>';
    const ctxStat = s.contextAvailable
        ? `<span class="mwt-diag-health-stat">context via ${escapeHtml(String(s.contextSource ?? 'unknown route'))}</span>`
        : '<span class="mwt-diag-health-stat">no SillyTavern context</span>';

    // The fork-compat headline: one banner stating whether the
    // getCurrentChatId() premise behind core/scope.js holds on this build.
    // 'ok' is deliberately quiet; the other levels must survive a screenshot.
    const premiseBanner = `
        <div class="mwt-diag-env-premise mwt-diag-env-premise--${escapeHtml(premise.level)}">
            ${premise.level === 'ok' ? '✓' : (premise.level === 'fallback' ? '⚠' : '⛔')}
            <strong>chat-ID premise: ${escapeHtml(premise.level)}</strong>
            ${premise.identityKey ? ` <span class="mwt-diag-dim">· identity ${escapeHtml(premise.identityKey)}</span>` : ''}
            ${premise.chatIdValue ? ` <span class="mwt-diag-dim">· ${escapeHtml(premise.method)} → "${escapeHtml(premise.chatIdValue)}"</span>` : ''}
            <div class="mwt-diag-env-premise-note">${escapeHtml(premise.note)}</div>
        </div>
    `;

    const featureRows = features.map((f) => `
        <tr data-feature="${escapeHtml(f.id)}">
            <td class="mwt-diag-env-feature">${escapeHtml(String(f.label ?? f.id))}</td>
            <td>${f.available ? diagBadge('✓ present', 'ok') : diagBadge('absent', 'fail')}</td>
            <td class="mwt-diag-env-detail">${escapeHtml(String(f.detail ?? ''))}</td>
        </tr>
    `).join('');

    // The shared.js probe row — its status cell carries the id the deferred
    // fill targets, so the async result lands exactly where the placeholder
    // was, with no other markup moving.
    const cmrsRow = `
        <tr data-feature="connectionManagerShared">
            <td class="mwt-diag-env-feature">ConnectionManagerRequestService
                <span class="mwt-diag-dim">(shared.js import — the path core/api.js uses)</span></td>
            <td id="${DIAGNOSTICS_ENV_CMRS_CELL_ID}">${renderConnectionManagerCell(s.connectionManager)}</td>
            <td class="mwt-diag-env-detail"><span class="mwt-diag-dim">connection-profile API calls</span></td>
        </tr>
    `;

    // The raw context-field table MWT.scope.diagnose() already builds — same
    // row labels, so console dumps and pane screenshots read alike.
    const fieldRows = Object.entries(s.contextFields || {}).map(([k, v]) => `
        <tr><td class="mwt-diag-env-key">${escapeHtml(k)}</td><td class="mwt-diag-env-value">${escapeHtml(String(v))}</td></tr>
    `).join('');

    return `
        <div class="mwt-diag-env">
            <div class="mwt-diag-health-stats">
                <span class="mwt-diag-health-stat"><strong>MWT v${escapeHtml(String(s.mwtVersion ?? '?'))}</strong></span>
                ${stStat}
                ${ctxStat}
                <span class="mwt-diag-health-stat">read at ${escapeHtml(formatTime(s.generatedAt ?? Date.now()))}</span>
            </div>
            ${premiseBanner}
            <table class="mwt-diag-env-table">
                <thead><tr><th>Feature</th><th>Status</th><th>Detail</th></tr></thead>
                <tbody>${featureRows}${cmrsRow}</tbody>
            </table>
            <p class="mwt-diag-env-subheading">Raw context fields — mirrors MWT.scope.diagnose()</p>
            <table class="mwt-diag-env-table mwt-diag-env-kv">
                <tbody>${fieldRows}</tbody>
            </table>
            <p class="mwt-diag-note">Open-and-read — re-open this tab to refresh. This tab is the fork-compat probe: when
                reporting from a non-reference SillyTavern build or fork, copy this whole tab (or run
                <code>MWT.diagnostics.environment()</code>) into the report — the banner row is the
                <code>getCurrentChatId()</code> premise behind core/scope.js, validated live on your build. The context
                fields below the feature table are the same eleven rows <code>MWT.scope.diagnose()</code> prints. Context
                field values can contain your character's name and avatar filename — skim before pasting publicly.</p>
        </div>
    `;
}

/**
 * Collect + render the Environment pane. Called at markup-build time inside
 * renderDiagnosticsPanel() — the modal is rebuilt on every open, which is this
 * tab's refresh model (decision D2). The shared.js probe is NOT awaited here:
 * the pane renders immediately with a "probing…" cell and
 * wireDiagnosticsPanel() fills it once when the import settles. A total
 * collection failure degrades to an error card, never a broken panel.
 *
 * @returns {string} innerHTML for the Environment sub-tab pane
 */
export function renderEnvironmentPane() {
    let snapshot;
    try {
        snapshot = collectEnvironmentSnapshot();
    } catch (err) {
        return `
            <div class="mwt-diag-placeholder">
                <span class="mwt-diag-placeholder-badge">Environment unavailable</span>
                <p>Collecting the environment snapshot failed: ${escapeHtml(String(err?.message || err))}</p>
            </div>
        `;
    }
    return renderEnvironmentSnapshot(snapshot);
}

// ─── Tab 3: Scope & storage (Phase 8) ────────────────────────────────────────

/**
 * Render the Scope & storage pane markup from a snapshot (pure string builder —
 * the injectable formatTime keeps Node tests deterministic). Everything
 * user-derived (identity keys, card/chat names, book names, binding keys,
 * notes, error text) is escaped: those strings come from character cards and
 * chat filenames.
 *
 * Layout, in design §I.5 Tab 3 order: stat header (version · scope · epoch) →
 * the resolution banner (the "why", with the loud fallback warning) → the
 * identity/book kv table → per-book hydration + store version → saved
 * bindings → the Phase 3 counter line.
 *
 * @param {object} snapshot — collectScopeSnapshot() output
 * @param {{formatTime?: function(number): string}} [opts]
 * @returns {string} innerHTML for the pane
 */
export function renderScopeSnapshot(snapshot, { formatTime = (ts) => new Date(ts).toLocaleTimeString() } = {}) {
    const s = snapshot || {};
    const r = s.resolution || { scope: 'global', mode: 'global', note: '', books: {} };
    const books = Array.isArray(s.books) ? s.books : [];
    const bindings = Array.isArray(s.bindings?.rows) ? s.bindings.rows : [];
    const warnings = Array.isArray(s.warnings) ? s.warnings : [];

    const identityCell = (id) => id
        ? `${escapeHtml(String(id.key ?? ''))}${id.name ? ` → "${escapeHtml(String(id.name))}"` : ''}${id.isGroup ? ' (group)' : ''}`
        : '<span class="mwt-diag-dim">(unresolved)</span>';

    const resolutionRows = [
        ['scope setting', `${escapeHtml(String(r.scope ?? '?'))}${s.scopeSetting?.valid === false ? ' <span class="mwt-diag-dim">(invalid value — treated as global)</span>' : ''}`],
        ['character identity', identityCell(s.character)],
        ['chat identity', identityCell(s.chat)],
        ['identity used by scope', r.identityKey ? escapeHtml(String(r.identityKey)) : '<span class="mwt-diag-dim">(none — global books)</span>'],
        ['Knowledge book', escapeHtml(String(r.books?.knowledge ?? '?'))],
        ['State book', escapeHtml(String(r.books?.state ?? '?'))],
        ['Profiles book', escapeHtml(String(r.books?.profiles ?? '?'))],
    ].map(([k, v]) => `
        <tr><td class="mwt-diag-env-key">${escapeHtml(k)}</td><td class="mwt-diag-env-value">${v}</td></tr>
    `).join('');

    const bookRows = books.map((b) => {
        // Store cell: only the Knowledge/State books carry a [MWT:store]
        // entry; NPC Profiles is plain entries. The two un-loaded states are
        // shown differently on purpose — 'failed' means writes are blocked and
        // a tester must act; 'not attempted' is the ordinary early state right
        // after a reload or chat switch, and painting that red would report a
        // fault where there is none.
        const storeCell = !b.hasStore
            ? '<span class="mwt-diag-dim">no store — plain entries</span>'
            : (b.storeState === 'loaded'
                ? `${diagBadge('loaded', 'ok')}${b.dirty ? ` ${diagBadge('dirty', 'warn')}` : ''}`
                : (b.storeState === 'failed'
                    ? `${diagBadge('load failed', 'fail')} <span class="mwt-diag-dim">writes blocked</span>`
                    : `${diagBadge('not loaded yet', 'warn')} <span class="mwt-diag-dim">hydration runs on chat change</span>`));
        const versionCell = !b.hasStore
            ? '—'
            : (b.storeVersion != null
                ? `v${escapeHtml(String(b.storeVersion))}${b.storeVersion !== b.currentStoreVersion ? ` <span class="mwt-diag-dim">(code: v${escapeHtml(String(b.currentStoreVersion ?? '?'))})</span>` : ''}`
                : '<span class="mwt-diag-dim">—</span>');
        // Active cell: whether ST will actually scan this book (see
        // gatherActivationState). 'inactive' is amber, not red — it is usually a
        // one-click fix in the World Info panel, not a fault in MWT. NPC Profiles
        // reports n/a: its entries carry no keywords, so activation is moot.
        const title = b.activeNote ? ` title="${escapeHtml(String(b.activeNote))}"` : '';
        const activeCell = b.injectable === false
            ? `<span class="mwt-diag-dim"${title}>n/a — never injected</span>`
            : (b.active === 'yes'
                ? `${diagBadge('active', 'ok')}${b.activeIn?.length ? ` <span class="mwt-diag-dim"${title}>${escapeHtml(b.activeIn.join(', '))}</span>` : ''}`
                : (b.active === 'no'
                    ? `${diagBadge('inactive', 'warn')} <span class="mwt-diag-dim"${title}>ST will not inject</span>`
                    : `${diagBadge('unknown', 'dim')} <span class="mwt-diag-dim"${title}>can't read World Info</span>`));
        return `
            <tr data-book="${escapeHtml(String(b.id))}">
                <td>${escapeHtml(String(b.label ?? b.id))}</td>
                <td class="mwt-diag-env-value">${escapeHtml(String(b.name ?? ''))}</td>
                <td>${activeCell}</td>
                <td>${storeCell}</td>
                <td>${versionCell}</td>
            </tr>
        `;
    }).join('');

    const bindingRows = bindings.map((row) => `
        <tr data-binding="${escapeHtml(String(row.key))}">
            <td class="mwt-diag-env-value">${row.isCurrent ? '<span class="mwt-diag-scope-current" title="the identity this chat currently resolves to">● </span>' : ''}${escapeHtml(String(row.key))}</td>
            <td>${escapeHtml(String(row.knowledge ?? '—'))}</td>
            <td>${escapeHtml(String(row.state ?? '—'))}</td>
            <td>${escapeHtml(String(row.profiles ?? '—'))}</td>
        </tr>
    `).join('');

    const level = ['ok', 'warn', 'fail'].includes(s.bannerLevel) ? s.bannerLevel : 'ok';
    const icon = level === 'ok' ? '✓' : (level === 'warn' ? '⚠' : '⛔');
    const errorNote = s.errors?.length
        ? `<p class="mwt-diag-note">⚠ Some fields degraded: ${escapeHtml(s.errors.join(' · '))}</p>`
        : '';
    const fallbackNote = s.fallbackEvents?.count > 0
        ? `<p class="mwt-diag-note">⚠ <code>scope_fallback_global</code> fired ${escapeHtml(String(s.fallbackEvents.count))}× this session${s.fallbackEvents.last?.epoch != null ? ` — last at epoch ${escapeHtml(String(s.fallbackEvents.last.epoch))}` : ''}. Run <code>MWT.diagnostics.events({ level: 'warn' })</code> for every silent recovery this session.</p>`
        : '';
    const bindingsBlock = bindings.length
        ? `<table class="mwt-diag-env-table">
            <thead><tr><th>Identity key</th><th>Knowledge</th><th>State</th><th>Profiles</th></tr></thead>
            <tbody>${bindingRows}</tbody>
        </table>`
        : '<p class="mwt-diag-note">No bindings saved yet — scope \'global\' never binds; character/chat scopes bind on their first real resolve.</p>';

    return `
        <div class="mwt-diag-scope">
            <div class="mwt-diag-health-stats">
                <span class="mwt-diag-health-stat"><strong>MWT v${escapeHtml(String(s.mwtVersion ?? '?'))}</strong></span>
                <span class="mwt-diag-health-stat">scope: <strong>${escapeHtml(String(r.scope ?? '?'))}</strong></span>
                <span class="mwt-diag-health-stat">epoch <strong>${escapeHtml(String(s.epoch ?? '?'))}</strong> <span class="mwt-diag-dim">(bumped on every chat switch)</span></span>
                <span class="mwt-diag-health-stat">read at ${escapeHtml(formatTime(s.generatedAt ?? Date.now()))}</span>
            </div>
            <div class="mwt-diag-scope-banner mwt-diag-scope-banner--${level}">
                ${icon} <strong>lorebook resolution: ${escapeHtml(String(r.mode ?? '?'))}</strong>
                <div class="mwt-diag-scope-banner-note">${escapeHtml(String(r.note ?? ''))}</div>
            </div>
            ${warnings.length ? `<ul class="mwt-diag-scope-warnings">${warnings.map((w) => `
                <li>${w.level === 'fail' ? '⛔' : '⚠'} ${escapeHtml(String(w.text ?? ''))}</li>
            `).join('')}</ul>` : ''}
            <table class="mwt-diag-env-table mwt-diag-env-kv">
                <tbody>${resolutionRows}</tbody>
            </table>
            <p class="mwt-diag-env-subheading">Books — World Info activation, hydration &amp; store version</p>
            <table class="mwt-diag-env-table">
                <thead><tr><th>Book</th><th>Name</th><th>Active (World Info)</th><th>Store</th><th>Version</th></tr></thead>
                <tbody>${bookRows}</tbody>
            </table>
            ${s.activation && s.activation.detectable === false
                ? `<p class="mwt-diag-note">⚠ Could not read SillyTavern's World Info activation state${s.activation.note ? ` — ${escapeHtml(String(s.activation.note))}` : ''}. Book activation shows as “unknown” while any activation slot cannot be read.</p>`
                : `<p class="mwt-diag-note"><strong>Active</strong> = the book is switched on in ST's World Info (global selection, this chat's bound book, or the character's books), so ST will scan it. <strong>Inactive</strong> = MWT still writes to the book, but ST injects nothing until you enable it in the World Info panel. Activation is opt-in — the toggles in Knowledge → Settings can switch these books on automatically (this chat's slot for the Knowledge book, the global selection or the character's additional books for the State book); a book no toggle covers stays inactive until you enable it in the World Info panel. Per-character and per-chat scope each mint a fresh book that starts inactive.</p>`}
            <p class="mwt-diag-env-subheading">Saved bindings (${escapeHtml(String(s.bindings?.count ?? bindings.length))}) — stable identity key → book names</p>
            ${bindingsBlock}
            ${fallbackNote}
            ${errorNote}
            <p class="mwt-diag-note">Open-and-read — re-open this tab to refresh. This tab re-derives the resolution
                READ-ONLY: opening it never saves a binding or touches a book (that is <code>resolveBookNames()</code>'s
                job, on the next real resolve). For the same data in the console run <code>MWT.diagnostics.scope()</code>;
                <code>MWT.scope.diagnose()</code> adds the raw context fields, and <code>MWT.scope.bindings()</code>
                prints the bindings table. Identity values contain your card/chat names — skim before pasting publicly.</p>
        </div>
    `;
}

/**
 * Collect + render the Scope & storage pane under the Environment pane. Called
 * at markup-build time inside renderDiagnosticsPanel() — the modal is rebuilt
 * on every open, which is this tab's refresh model (decision D2). Fully
 * synchronous; a total collection failure degrades to an error card, never a
 * broken panel.
 *
 * @returns {string} innerHTML for the Scope & storage sub-tab pane
 */
export function renderScopePane() {
    let snapshot;
    try {
        snapshot = collectScopeSnapshot();
    } catch (err) {
        return `
            <div class="mwt-diag-placeholder">
                <span class="mwt-diag-placeholder-badge">Scope &amp; storage unavailable</span>
                <p>Collecting the scope snapshot failed: ${escapeHtml(String(err?.message || err))}</p>
            </div>
        `;
    }
    return renderScopeSnapshot(snapshot);
}

// ─── Tab 4: Injection (Phase 9) ───────────────────────────────────────────────

/**
 * Render the Injection pane markup from a snapshot (pure string builder — the
 * injectable formatTime keeps Node tests deterministic). Everything
 * user-derived (payloads, notes, warning text, hover titles) is escaped:
 * payloads are chat-derived content by construction.
 *
 * Layout, in design §I.5 Tab 4 order: stat header (version · live payloads ·
 * registered tokens · tag wrapping · read-at) → the panic banner when the
 * switch is on → the mandatory Knowledge lorebook caveat (always shown; the
 * design requires this tab to state it, and TODO.md §4 closes here) → the
 * per-module table (on/off · gate · depth & role WITH provenance · tokens ·
 * registered/age) → the recorded payloads, one collapsed <details> per
 * module with the payload gated behind the content opt-in checkbox.
 *
 * @param {object} snapshot — collectInjectionSnapshot() output
 * @param {{formatTime?: function(number): string}} [opts]
 * @returns {string} innerHTML for the pane
 */
export function renderInjectionSnapshot(snapshot, { formatTime = (ts) => new Date(ts).toLocaleTimeString() } = {}) {
    const s = snapshot || {};
    const rows = Array.isArray(s.modules) ? s.modules : [];
    const warnings = Array.isArray(s.warnings) ? s.warnings : [];

    const badge = (text, tone) => `<span class="mwt-diag-badge mwt-diag-badge--${tone}">${text}</span>`;

    const sourceLabel = (r, part) => {
        const source = part?.source ?? 'builtin';
        if (source === 'module' && r.moduleSourceLabel) return r.moduleSourceLabel;
        return PLACEMENT_SOURCE_LABELS[source] ?? source;
    };

    const depthCell = (r) => r.placement
        ? `${escapeHtml(String(r.placement.depth.value))} <span class="mwt-diag-dim">(${escapeHtml(sourceLabel(r, r.placement.depth))})</span>`
        : '<span class="mwt-diag-dim">—</span>';

    const roleCell = (r) => r.placement
        ? `${escapeHtml(String(r.placement.role.value))} <span class="mwt-diag-dim">(${escapeHtml(sourceLabel(r, r.placement.role))})</span>`
        : '<span class="mwt-diag-dim">—</span>';

    // Tokens carry their KIND, same rule as the Health tab: 'recorded' is the
    // exact registered payload, 'accessor' is only an estimate shown when
    // nothing is registered yet, and 'stored' is lorebook corpus — never
    // prompt load.
    const tokensCell = (r) => {
        const n = (Number(r.tokens?.value) || 0).toLocaleString();
        if (r.tokens?.kind === 'stored') {
            return `<span class="mwt-diag-tokens-stored" title="Lorebook corpus — SillyTavern activates only keyword-matched entries, so this is NOT prompt load.">${n} <span class="mwt-diag-dim">stored</span></span>`;
        }
        if (r.tokens?.kind === 'accessor') {
            return `<span title="Module accessor estimate (header + current data) — nothing is registered yet this session; the number approximates the NEXT apply, not the prompt.">${n} <span class="mwt-diag-dim">est.</span></span>`;
        }
        return `<span title="Tokens of the exact payload registered with SillyTavern right now (estimateTokens on the Phase 2 snapshot).">${n}</span>`;
    };

    const registeredCell = (r) => {
        if (!r.snapshot) return '<span class="mwt-diag-dim" title="In-memory capture — appears after the module first applies its prompt this session (a reload clears it).">never</span>';
        const time = r.snapshot.at != null ? formatTime(r.snapshot.at) : '?';
        const age = formatInjectionAge(r.snapshot.ageSec);
        const hover = `registered at depth ${r.snapshot.depth ?? '?'} / role ${ROLE_NUMBERS[r.snapshot.role] ?? '?'} · ${r.snapshot.chars.toLocaleString()} chars`;
        if (!r.snapshot.enabled) {
            return `<span class="mwt-diag-last-run" title="${escapeHtml(hover)}">${badge('cleared', 'dim')} <span class="mwt-diag-dim">${escapeHtml(time)} · ${escapeHtml(age)}</span></span>`;
        }
        return `<span class="mwt-diag-last-run" title="${escapeHtml(hover)}">${escapeHtml(time)} <span class="mwt-diag-dim">· ${escapeHtml(age)}</span></span>`;
    };

    const rowHtml = rows.map((r) => {
        const classes = ['mwt-diag-health-row'];
        if (r.enabled === false) classes.push('mwt-diag-health-row--off');
        if (!r.gate) classes.push('mwt-diag-health-row--gated');
        const errFlag = r.errors?.length
            ? ` <span class="mwt-diag-badge mwt-diag-badge--fail" title="${escapeHtml(r.errors.join('\n'))}">⚠</span>`
            : '';
        const onCell = r.enabled === null
            ? '<span class="mwt-diag-dim" title="Knowledge has no injection flag — its gates (panic switch / enableKnowledge) govern SCANNING, and its lorebook entries are always live in SillyTavern.">n/a</span>'
            : (r.enabled ? badge('on', 'ok') : badge('off', 'dim'));
        const noteRow = r.note
            ? `<div class="mwt-diag-inj-note">${escapeHtml(r.note)}</div>`
            : '';
        return `
            <tr class="${classes.join(' ')}" data-module="${escapeHtml(r.id)}">
                <td class="mwt-diag-health-module">${r.label}${errFlag}${noteRow}</td>
                <td>${onCell}</td>
                <td>${r.gate ? badge('open', 'ok') : badge('blocked', 'fail')}</td>
                <td>${depthCell(r)}</td>
                <td>${roleCell(r)}</td>
                <td class="mwt-diag-health-tokens">${tokensCell(r)}</td>
                <td>${registeredCell(r)}</td>
            </tr>`;
    }).join('');

    const panicBanner = s.injectionMasterOff
        ? `<div class="mwt-diag-panic">⛔ <strong>PANIC SWITCH ON</strong> — no module can register injections via
             <code>setExtensionPrompt</code> while this is on, and SillyTavern keeps whatever was registered before it was
             flipped. Right-click the ⚙️ floating button to release it.</div>`
        : '';

    // The Knowledge caveat is mandatory on this tab (design §I.5 Tab 4) — it
    // closes TODO.md §4 "Panic switch UI clarity". Always shown as its own
    // banner (amber normally; the panic tone when the switch is on), and it
    // is excluded from the generic warnings list below so it cannot render
    // twice.
    const caveat = warnings.find((w) => w.id === 'knowledge-lorebook-caveat');
    const caveatBanner = caveat ? `
        <div class="mwt-diag-scope-banner mwt-diag-scope-banner--${caveat.level === 'fail' ? 'fail' : 'warn'}">
            ${caveat.level === 'fail' ? '⛔' : '⚠'} <strong>Knowledge caveat: lorebook entries are not switchable from MWT</strong>
            <div class="mwt-diag-scope-banner-note">${escapeHtml(caveat.text)}</div>
        </div>
    ` : '';
    const otherWarnings = warnings.filter((w) => w.id !== 'knowledge-lorebook-caveat');
    const warningList = otherWarnings.length ? `<ul class="mwt-diag-scope-warnings">${otherWarnings.map((w) => `
        <li>${w.level === 'fail' ? '⛔' : '⚠'} <code>${escapeHtml(w.id)}</code> ${escapeHtml(w.text)}</li>
    `).join('')}</ul>` : '';

    // The recorded payloads — Phase 2 snapshots, collapsed by default with
    // their age (design §I.5 Tab 4). The payload body is chat-derived
    // content, so it renders behind the panel's content opt-in checkbox
    // (design §I.6): the gated placeholder ships visible and the <pre> ships
    // hidden; wireDiagnosticsPanel() flips them when the checkbox changes.
    const withSnapshots = rows.filter((r) => r.snapshot);
    const payloadBlocks = withSnapshots.map((r) => {
        const summary = r.snapshot.enabled
            ? `${r.label} — ${r.snapshot.chars.toLocaleString()} chars · ~${r.tokens.value.toLocaleString()} tokens · applied ${escapeHtml(formatTime(r.snapshot.at ?? Date.now()))} (${escapeHtml(formatInjectionAge(r.snapshot.ageSec))})`
            : `${r.label} — cleared ${escapeHtml(formatTime(r.snapshot.at ?? Date.now()))} (${escapeHtml(formatInjectionAge(r.snapshot.ageSec))})`;
        // DEFERRED INSERTION (redaction contract §I.6): the payload text is
        // deliberately NOT in this markup — the <pre> ships empty, carrying
        // only the snapshot KEY, and wireDiagnosticsPanel() fills it (via
        // textContent, so payload text is never parsed as HTML) only when the
        // content opt-in is ticked — scrubbed through scrubPayloadForDisplay
        // first, because opting into content never opts into secrets.
        const body = r.snapshot.payload
            ? `<div class="mwt-diag-inj-gated" data-diag-inj-gate="placeholder">[content excluded — tick the “Include prompt bodies, injected payloads…” checkbox above to reveal the recorded ${r.snapshot.chars.toLocaleString()}-char payload (secrets stay redacted even then)]</div>
               <pre class="mwt-diag-inj-payload" data-diag-inj-gate="body" data-diag-inj-key="${escapeHtml(r.key)}" hidden></pre>`
            : '<div class="mwt-diag-inj-gated">(registered empty — the last apply cleared this slot)</div>';
        return `<details class="mwt-diag-inj-details"><summary>${summary}</summary>${body}</details>`;
    }).join('');
    const payloadSection = withSnapshots.length
        ? `<p class="mwt-diag-env-subheading">Recorded payloads — the exact strings last registered via setExtensionPrompt (collapsed; re-open this tab to refresh)</p>${payloadBlocks}`
        : '<p class="mwt-diag-dim">No injection registrations yet this session — snapshots are in-memory and appear after each module first applies its prompt (a reload clears them).</p>';

    const registeredTokens = (Number(s.registeredTokens) || 0).toLocaleString();

    return `
        <div class="mwt-diag-inj">
            <div class="mwt-diag-health-stats">
                <span class="mwt-diag-health-stat"><strong>MWT v${escapeHtml(String(s.mwtVersion ?? '?'))}</strong></span>
                <span class="mwt-diag-health-stat">registered: <strong>${Number(s.livePayloads) || 0}</strong> live payload(s) · <strong>${registeredTokens}</strong> tokens</span>
                <span class="mwt-diag-health-stat mwt-diag-dim" title="Structural boundaries: whether injected blocks are wrapped in &lt;mwt_*&gt; tags.">tags ${s.structuralBoundaries ? 'on' : 'off'}</span>
                <span class="mwt-diag-health-stat">read at ${escapeHtml(formatTime(s.generatedAt ?? Date.now()))}</span>
            </div>
            ${panicBanner}
            ${caveatBanner}
            ${warningList}
            <table class="mwt-diag-health-table">
                <thead>
                    <tr><th>Module</th><th>On</th><th>Gate</th><th>Depth</th><th>Role</th><th>Tokens</th><th>Registered</th></tr>
                </thead>
                <tbody>${rowHtml}</tbody>
            </table>
            ${payloadSection}
            <p class="mwt-diag-note">Open-and-read — re-open this tab to refresh. "Registered" is the Phase 2 snapshot: the exact
                string MWT last handed to SillyTavern's <code>setExtensionPrompt</code> (frozen until re-applied), with its age —
                registration only, final-prompt placement is not observable from the extension. <strong>Depth/Role</strong> show
                where the value resolved FROM (global override · module setting · built-in default) — the same resolver the
                appliers call, so they cannot disagree. <strong>Tokens</strong> marked <em>est.</em> are module accessor
                estimates (nothing registered yet); <em>stored</em> is lorebook corpus, not prompt load. Payloads are chat
                content — the text does not enter this page until the content opt-in above is ticked, and even then it is
                secret-scrubbed (core/redaction.js — the same layer as Copy Report; URLs are cut to scheme+host and key/
                bearer shapes are redacted) and inserted as plain text. Same data in the console:
                <code>MWT.diagnostics.injectionStatus()</code> — its return value is redacted the same way by default
                (<code>{ includeContent: true }</code> for scrubbed payload text); one key's exact recorded string:
                <code>MWT.diagnostics.injection(key)</code>.</p>
        </div>
    `;
}

/**
 * Collect + render the Injection pane under the Scope pane. Called at
 * markup-build time inside renderDiagnosticsPanel() — the modal is rebuilt on
 * every open, which is this tab's refresh model (decision D2). Fully
 * synchronous; a total collection failure degrades to an error card, never a
 * broken panel. The ONLY wiring this tab needs (the payload reveal) lives in
 * wireDiagnosticsPanel().
 *
 * @returns {string} innerHTML for the Injection sub-tab pane
 */
export function renderInjectionPane() {
    let snapshot;
    try {
        snapshot = collectInjectionSnapshot();
    } catch (err) {
        return `
            <div class="mwt-diag-placeholder">
                <span class="mwt-diag-placeholder-badge">Injection unavailable</span>
                <p>Collecting the injection snapshot failed: ${escapeHtml(String(err?.message || err))}</p>
            </div>
        `;
    }
    return renderInjectionSnapshot(snapshot);
}

// ─── Tab 5: Last request (Phase 10) ───────────────────────────────────────────

/**
 * What each captured `mode` means, shown inline so the card is self-explaining.
 * Mirrors the two call paths in core/api.js (fetchFromApi = the module's own
 * API settings; fetchViaConnectionProfile = a SillyTavern connection profile).
 */
const LR_MODE_LABELS = {
    custom: 'custom (this module\u2019s own API settings)',
    cm: 'cm (SillyTavern connection profile)',
};

/**
 * Render the Last request pane markup from a snapshot (pure string builder —
 * the injectable formatTime keeps Node tests deterministic). Every
 * string-valued captured field (model/profile ids, finish reasons, error
 * classes) is escaped — they are free text — and numbers render through the
 * shared formatters so the card, the history table, and the console bridge
 * (MWT.diagnostics.lastRequest()) can never disagree.
 *
 * Layout, in design §I.5 Tab 5 order: stat header (version · captured ·
 * ok/failed · tokens · avg/max · read-at) → the failure banner when the most
 * recent call failed → the "most recent call" detail card → the short
 * history table, newest first.
 *
 * @param {object} snapshot — collectLastRequestSnapshot() output
 * @param {{formatTime?: function(number): string}} [opts]
 * @returns {string} innerHTML for the pane
 */
export function renderLastRequestSnapshot(snapshot, { formatTime = (ts) => new Date(ts).toLocaleTimeString() } = {}) {
    const s = snapshot || {};
    const history = Array.isArray(s.history) ? s.history : [];
    const stats = s.stats || {};
    const warnings = Array.isArray(s.warnings) ? s.warnings : [];
    const last = s.last ?? null;

    const dim = (text) => `<span class="mwt-diag-dim">${text}</span>`;

    /** One kv row for the detail card. */
    const kv = (k, v) => `<tr><td class="mwt-diag-env-key">${escapeHtml(k)}</td><td class="mwt-diag-env-value">${v}</td></tr>`;

    /** The usage trio, or a dim dash when the backend reported none. */
    const usageCell = (c) => {
        if (!c?.usage) return dim('—');
        const t = Number(c.usage.total_tokens ?? 0).toLocaleString();
        const p = c.usage.prompt_tokens != null ? Number(c.usage.prompt_tokens).toLocaleString() : '—';
        const o = c.usage.completion_tokens != null ? Number(c.usage.completion_tokens).toLocaleString() : '—';
        return `<strong>${t}</strong> ${dim('total')} <span class="mwt-diag-dim" title="usage.prompt_tokens / usage.completion_tokens">(in ${p} · out ${o})</span>`;
    };

    // The banner appears only when the most recent call failed (the
    // collector's one warning today); it reuses the Scope pane's banner list
    // markup, like the Injection pane does.
    const warningList = warnings.length ? `<ul class="mwt-diag-scope-warnings">${warnings.map((w) => `
        <li>${w.level === 'fail' ? '⛔' : '⚠'} <code>${escapeHtml(w.id)}</code> ${escapeHtml(w.text)}</li>
    `).join('')}</ul>` : '';

    // The most recent call — one detail card of exactly what Phase 1 captured.
    const lastCard = last ? `
        <div class="mwt-diag-lr-detail">
            <p class="mwt-diag-env-subheading">Most recent call — ${escapeHtml(formatTime(last.at ?? s.generatedAt ?? Date.now()))} (${escapeHtml(formatRequestAge(last.ageSec))})</p>
            <table class="mwt-diag-env-table mwt-diag-env-kv">
                <tbody>
                    ${kv('module', escapeHtml(last.module))}
                    ${kv('mode', last.mode ? `${escapeHtml(last.mode)} — ${escapeHtml(LR_MODE_LABELS[last.mode] ?? 'unknown capture mode')}` : dim('—'))}
                    ${kv('model / profile', last.model != null ? `<code>${escapeHtml(last.model)}</code>` : dim('—'))}
                    ${kv('HTTP status', last.status != null ? escapeHtml(String(last.status)) : dim('—'))}
                    ${kv('result', last.ok
                        ? '<span class="mwt-diag-badge mwt-diag-badge--ok">ok</span>'
                        : `<span class="mwt-diag-badge mwt-diag-badge--fail">FAILED</span>${last.errorClass ? dim(` error class: <code>${escapeHtml(last.errorClass)}</code>`) : ''}`)}
                    ${kv('duration', last.durationMs != null ? escapeHtml(formatHealthDuration(last.durationMs)) : dim('—'))}
                    ${kv('retries', String(last.retries ?? 0))}
                    ${kv('finish_reason', last.finish_reason ? escapeHtml(last.finish_reason) : dim('—'))}
                    ${kv('token usage', usageCell(last))}
                </tbody>
            </table>
        </div>
    ` : '<p class="mwt-diag-dim">No API calls captured yet this session — the capture is in-memory, appears after a module\u2019s first call, and clears on reload.</p>';

    // The short history — every retained call (the store caps at
    // API_CALL_CAPACITY = 20), newest first, one row per call.
    const historyRows = history.map((c) => `
        <tr class="${c.ok ? '' : 'mwt-diag-health-row--gated'}">
            <td>${escapeHtml(formatTime(c.at ?? s.generatedAt ?? Date.now()))}</td>
            <td class="mwt-diag-dim">${escapeHtml(formatRequestAge(c.ageSec))}</td>
            <td>${escapeHtml(c.module)}</td>
            <td class="mwt-diag-dim">${escapeHtml(c.mode ?? '—')}</td>
            <td>${c.model != null ? escapeHtml(c.model) : dim('—')}</td>
            <td>${c.status != null ? escapeHtml(String(c.status)) : dim('—')}</td>
            <td>${c.ok ? '<span class="mwt-diag-badge mwt-diag-badge--ok">ok</span>' : '<span class="mwt-diag-badge mwt-diag-badge--fail">FAILED</span>'}</td>
            <td class="mwt-diag-dim">${c.durationMs != null ? escapeHtml(formatHealthDuration(c.durationMs)) : '—'}</td>
            <td class="mwt-diag-dim">${c.retries > 0 ? `+${c.retries}` : '0'}</td>
            <td class="mwt-diag-dim">${c.finish_reason ? escapeHtml(c.finish_reason) : '—'}</td>
            <td class="mwt-diag-dim">${c.usage ? escapeHtml(Number(c.usage.total_tokens ?? 0).toLocaleString()) : '—'}</td>
        </tr>
    `).join('');

    const historySection = history.length ? `
        <p class="mwt-diag-env-subheading">History — newest first (the store keeps the last ${escapeHtml(String(s.capacity ?? '?'))} calls)</p>
        <table class="mwt-diag-health-table">
            <thead>
                <tr><th>Time</th><th>Age</th><th>Module</th><th>Mode</th><th>Model</th><th>HTTP</th><th>Result</th><th>Dur</th><th>Ret</th><th>Finish</th><th>Tokens</th></tr>
            </thead>
            <tbody>${historyRows}</tbody>
        </table>
    ` : '';

    const tokenStat = stats.totalTokens
        ? `<span class="mwt-diag-health-stat"><strong>${Number(stats.totalTokens).toLocaleString()}</strong> tokens ${dim('across captured calls')}</span>`
        : '';
    const paceStat = stats.avgDurationMs != null
        ? `<span class="mwt-diag-health-stat">avg ${escapeHtml(formatHealthDuration(stats.avgDurationMs))}${stats.maxDurationMs != null ? ` · max ${escapeHtml(formatHealthDuration(stats.maxDurationMs))}` : ''}</span>`
        : '';

    return `
        <div class="mwt-diag-lr">
            <div class="mwt-diag-health-stats">
                <span class="mwt-diag-health-stat"><strong>MWT v${escapeHtml(String(s.mwtVersion ?? '?'))}</strong></span>
                <span class="mwt-diag-health-stat"><strong>${history.length}</strong> captured call(s) ${dim(`store keeps ${s.capacity ?? '?'}`)}</span>
                <span class="mwt-diag-health-stat">ok <strong>${Number(stats.ok) || 0}</strong> · failed <strong>${Number(stats.failed) || 0}</strong>${stats.retries ? ` · ${stats.retries} retr${stats.retries === 1 ? 'y' : 'ies'}` : ''}</span>
                ${tokenStat}
                ${paceStat}
                <span class="mwt-diag-health-stat">read at ${escapeHtml(formatTime(s.generatedAt ?? Date.now()))}</span>
            </div>
            ${warningList}
            ${lastCard}
            ${historySection}
            <p class="mwt-diag-note">Open-and-read — re-open this tab to refresh. Telemetry by construction: the capture records ABOUT a call — module,
                mode, model/profile, HTTP status, duration, retries, finish_reason, token usage, error class — and NEVER the prompt, API key, custom
                headers, or response body, so there is no content to gate here (the report checkbox above changes nothing on this tab). It is in-memory
                only and resets on reload. This pane renders redactLastRequestSnapshot() output — the same secret-scrubbed guarantee. Same data in the console: <code>MWT.diagnostics.lastRequest()</code> — its return value is secret-scrubbed
                (model/profile strings can quote a secret, so every string routes through core/redaction.js) — or the raw telemetry-only copies
                <code>MWT.diagnostics.apiCalls()</code> / <code>lastApiCall(module)</code>.</p>
        </div>
    `;
}

/**
 * Collect + render the Last request pane. Called at markup-build time inside
 * renderDiagnosticsPanel() — the modal is rebuilt on every open, which is this
 * tab's refresh model (decision D2). Fully synchronous; a total collection
 * failure degrades to an error card, never a broken panel. The collected
 * snapshot is REDACTED (redactLastRequestSnapshot) before it is rendered — the
 * same safe-by-default contract as the console bridge; the raw telemetry-only
 * copies stay in the store and on MWT.diagnostics.apiCalls(). No wiring —
 * unlike the Injection tab there is nothing to reveal.
 *
 * @returns {string} innerHTML for the Last request sub-tab pane
 */
export function renderLastRequestPane() {
    let snapshot;
    try {
        snapshot = collectLastRequestSnapshot();
    } catch (err) {
        return `
            <div class="mwt-diag-placeholder">
                <span class="mwt-diag-placeholder-badge">Last request unavailable</span>
                <p>Collecting the last-request snapshot failed: ${escapeHtml(String(err?.message || err))}</p>
            </div>
        `;
    }
    // Redact BEFORE rendering (Phase 10 review): the console bridge guarantees
    // redactLastRequestSnapshot() output, and the visible pane must not be the
    // one surface without it — model/profile ids, finish reasons, error
    // classes, and warning text are free strings that can quote a secret.
    return renderLastRequestSnapshot(redactLastRequestSnapshot(snapshot));
}

// ─── Diagnostics Tab 6: Log (Phase 11) ────────────────────────────────────────

/**
 * Render a REDACTED Log snapshot (renderLogPane / the console bridge pass
 * redactLogSnapshot() output). Stat header (version · total vs ring capacity ·
 * error/warn counts · read-at), the warning banner when error-level events
 * exist, the filter row (level chips with counts + module select + the
 * visible-of counter), and the event table — newest first, one row per event:
 * time · age · level · module · event · detail · the chat stamp (epoch with
 * the scopeKey on hover — Phase 0's cross-chat-switch correlation dimension).
 *
 * The detail column ships the SAFE SUMMARY (the already-redacted detail JSON —
 * message/error bodies are size-only markers by construction); the opt-in
 * reveal element ships HIDDEN and EMPTY carrying only the event's fingerprint
 * key, and wireDiagnosticsPanel() fills it on opt-in — the Phase 9
 * deferred-insertion guards, applied to every row (injectable formatTime
 * keeps Node tests deterministic).
 *
 * @param {object} snapshot — collectLogSnapshot() → redactLogSnapshot() output
 * @param {{formatTime?: function(number): string}} [opts]
 * @returns {string} innerHTML for the pane
 */
export function renderLogSnapshot(snapshot, { formatTime = (ts) => new Date(ts).toLocaleTimeString() } = {}) {
    const s = snapshot || {};
    const events = Array.isArray(s.events) ? s.events : [];
    const levels = s.levels || {};
    const modules = Array.isArray(s.modules) ? s.modules : [];
    const warnings = Array.isArray(s.warnings) ? s.warnings : [];

    const dim = (text) => `<span class="mwt-diag-dim">${text}</span>`;

    /** Level cell — error/warn get the loud badges; info/debug stay quiet. */
    const levelCell = (lvl) => {
        if (lvl === 'error') return '<span class="mwt-diag-badge mwt-diag-badge--fail">error</span>';
        if (lvl === 'warn') return '<span class="mwt-diag-badge mwt-diag-badge--warn">warn</span>';
        if (lvl === 'debug') return dim('debug');
        return 'info';
    };

    /**
     * The safe-summary detail text: the event's detail as it arrived HERE is
     * already redactLogSnapshot() output, so plain JSON serialisation is the
     * summary — markers and all. Null/undefined detail renders a dim dash.
     */
    const detailSummary = (e) => {
        if (e.detail == null) return dim('—');
        try {
            return escapeHtml(JSON.stringify(e.detail) ?? '—');
        } catch {
            return dim('[unserializable detail]');
        }
    };

    // The banner list reuses the Scope pane's warning markup, like the
    // Last request + Injection panes do.
    const warningList = warnings.length ? `<ul class="mwt-diag-scope-warnings">${warnings.map((w) => `
        <li>${w.level === 'fail' ? '⛔' : '⚠'} <code>${escapeHtml(w.id)}</code> ${escapeHtml(w.text)}</li>
    `).join('')}</ul>` : '';

    // The filter row — chips carry the whole-ring counts (they are the
    // "what is in here" numbers, independent of the current filter), and the
    // counter ships its all-visible initial state; the wiring rewrites it as
    // filters toggle. View toggles only: nothing here re-reads the store.
    // The checkbox carries value="<level>" (a checkbox with no value
    // attribute reads as the string "on" in the DOM — the Phase 11 review's
    // P1: without it the filter set became {'on'} and every toggle blanked
    // the table); applyLogViewFilters() reads data-diag-log-filter-level
    // FIRST so the dataset is authoritative either way.
    const chips = LOG_LEVELS.map((lvl) => `
        <label class="mwt-diag-log-chip" title="Show/hide ${lvl}-level events — a view toggle over the rendered rows; it never re-reads the store">
            <input type="checkbox" checked value="${lvl}" data-diag-log-filter-level="${lvl}">
            <span class="mwt-diag-log-chip-label">${lvl}</span>
            <span class="mwt-diag-log-chip-count">${logLevelCount(levels, lvl)}</span>
        </label>`).join('');

    const moduleOptions = `
        <option value="all">all modules (${escapeHtml(String(s.total ?? events.length))})</option>
        ${modules.map((m) => `<option value="${escapeHtml(m.name)}">${escapeHtml(m.name)} — ${escapeHtml(String(m.count))}</option>`).join('')}`;

    const rows = events.map((e) => `
        <tr data-diag-log-row data-diag-log-level="${escapeHtml(e.level)}" data-diag-log-module="${escapeHtml(e.module)}">
            <td>${e.ts != null ? escapeHtml(formatTime(e.ts)) : dim('—')}</td>
            <td class="mwt-diag-dim">${escapeHtml(formatLogAge(e.ageSec))}</td>
            <td>${levelCell(e.level)}</td>
            <td><code>${escapeHtml(e.module)}</code></td>
            <td><code>${escapeHtml(e.event)}</code></td>
            <td class="mwt-diag-log-detail">${e.detail == null ? dim('—') : `
                <span data-diag-log-gate="summary">${detailSummary(e)}</span>
                <code data-diag-log-gate="body" data-diag-log-key="${escapeHtml(logEventKey(e))}" hidden></code>`}
            </td>
            <td class="mwt-diag-log-scope" title="${e.scopeKey ? escapeHtml(e.scopeKey) : 'scope key unknown (identity did not resolve)'}">#${e.epoch != null ? escapeHtml(String(e.epoch)) : '?'}</td>
        </tr>`).join('');

    const tableSection = events.length ? `
        <div class="mwt-diag-log-filters">
            <span class="mwt-diag-log-filters-label">Filter:</span>
            ${chips}
            <select class="mwt-diag-log-module" data-diag-log-filter-module title="Show one module's events — a view toggle over the rendered rows; it never re-reads the store">${moduleOptions}</select>
            <span class="mwt-diag-log-counter" data-diag-log-counter>showing ${events.length} of ${events.length}</span>
        </div>
        <table class="mwt-diag-health-table mwt-diag-log-table">
            <thead>
                <tr><th>Time</th><th>Age</th><th>Level</th><th>Module</th><th>Event</th><th>Detail</th><th>Chat</th></tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    ` : '<p class="mwt-diag-dim">No diagnostics events captured yet this session — every toast, API-call echo, and silent-recovery warn lands here; the ring is in-memory and resets on reload.</p>';

    return `
        <div class="mwt-diag-log">
            <div class="mwt-diag-health-stats">
                <span class="mwt-diag-health-stat"><strong>MWT v${escapeHtml(String(s.mwtVersion ?? '?'))}</strong></span>
                <span class="mwt-diag-health-stat"><strong>${escapeHtml(String(s.total ?? events.length))}</strong> event(s) ${dim(`ring keeps ${s.capacity ?? '?'}`)}</span>
                <span class="mwt-diag-health-stat">error <strong>${logLevelCount(levels, 'error')}</strong> · warn <strong>${logLevelCount(levels, 'warn')}</strong></span>
                <span class="mwt-diag-health-stat">read at ${escapeHtml(formatTime(s.generatedAt ?? Date.now()))}</span>
            </div>
            ${warningList}
            ${tableSection}
            <p class="mwt-diag-note">Open-and-read — re-open this tab to refresh; the level/module filters are view toggles over the rows already on screen and never re-read the store.
                The ring is global across chat switches — the <strong>Chat</strong> column stamps each event with the operation epoch (hover for the resolved chat identity), so a scope bug is visible
                across a switch. Detail summaries are safe by construction here: toast message bodies and raw error text render as size-only markers and every string is secret-scrubbed
                (core/redaction.js); tick the content opt-in above to reveal the full — still scrubbed — detail text. In-memory only; resets on reload. Same data in the console:
                <code>MWT.diagnostics.log()</code> (redacted return, accepts the same level/module filters as <code>events()</code>) or the raw ring <code>MWT.diagnostics.events()</code>.</p>
        </div>
    `;
}

/**
 * Collect + render the Log pane. Called at markup-build time inside
 * renderDiagnosticsPanel() — the modal is rebuilt on every open, which is this
 * tab's whole refresh model (decision D2 — no render loop). Fully synchronous;
 * a total collection failure degrades to an error card, never a broken panel.
 * The collected snapshot is REDACTED (redactLogSnapshot, strict mode) before
 * it is rendered — the same safe-by-default contract as the console bridge;
 * the full-but-scrubbed detail is the opt-in reveal wireDiagnosticsPanel()
 * performs, and the raw ring stays on MWT.diagnostics.events().
 *
 * @returns {string} innerHTML for the Log sub-tab pane
 */
export function renderLogPane() {
    let snapshot;
    try {
        snapshot = collectLogSnapshot();
    } catch (err) {
        return `
            <div class="mwt-diag-placeholder">
                <span class="mwt-diag-placeholder-badge">Log unavailable</span>
                <p>Collecting the log snapshot failed: ${escapeHtml(String(err?.message || err))}</p>
            </div>
        `;
    }
    // Redact BEFORE rendering (the Phase 10 review rule): toast bodies and
    // raw error text can quote the chat, so the pane renders the SAME
    // strict-mode redactLogSnapshot() output the console bridge returns by
    // default — only markers + scrubbed strings reach the DOM.
    return renderLogSnapshot(redactLogSnapshot(snapshot));
}

/**
 * Apply the Log tab's level/module VIEW filters to already-rendered rows —
 * wireDiagnosticsPanel()'s change listener calls this; nothing re-collects
 * or re-renders, so decision D2's open-and-read model is untouched.
 *
 * Extracted as a named export (the copyTextToClipboard precedent) so the
 * Node suite can drive the real filter logic with element-like fakes — the
 * Phase 11 review's P1 lived exactly here: the chips shipped without a
 * `value` attribute, so `c.value` read as the default string "on", the
 * active-level set became {'on'}, and toggling ANY chip hid EVERY row. The
 * level now comes from `data-diag-log-filter-level` first (the markup pins
 * `value="<level>"` as well), and checked-ness is filtered HERE rather than
 * delegated to a `:checked` pseudo-class the fakes cannot honour.
 *
 * @param {Iterable<object>} rows — the rendered `tr[data-diag-log-row]`
 *        elements (`.dataset.diagLogLevel` / `.dataset.diagLogModule` / `.hidden`)
 * @param {Iterable<object>} levelFilters — the chip inputs (`.checked`,
 *        `.dataset.diagLogFilterLevel`, `.value`)
 * @param {{value: string}|null} moduleFilter — the module `<select>` (value
 *        'all' or an exact module name), or null when absent
 * @param {{textContent: string}|null} counter — the visible-of counter, or null
 * @returns {number} how many rows remain visible
 */
export function applyLogViewFilters(rows, levelFilters, moduleFilter, counter) {
    const activeLevels = new Set(
        Array.from(levelFilters ?? [])
            .filter((c) => c?.checked === true)
            .map((c) => c?.dataset?.diagLogFilterLevel ?? c?.value),
    );
    const module = moduleFilter?.value ?? 'all';
    const rowList = Array.from(rows ?? []);
    let visible = 0;
    for (const row of rowList) {
        const show = activeLevels.has(row?.dataset?.diagLogLevel ?? '')
            && (module === 'all' || row?.dataset?.diagLogModule === module);
        row.hidden = !show;
        if (show) visible += 1;
    }
    if (counter) counter.textContent = `showing ${visible} of ${rowList.length}`;
    return visible;
}

/**
 * Reveal (or re-hide) every rendered Log row's full detail — the content
 * opt-in checkbox handler in wireDiagnosticsPanel() calls this. The Phase 9
 * guard stack, applied per row:
 *   1. DEFERRED INSERTION — the body `<code>` shipped empty; the raw detail
 *      only enters the DOM at the moment of opt-in (as textContent) and
 *      leaves it again on un-tick.
 *   2. SECRET SCRUBBING — what gets inserted is scrubLogDetailForDisplay()
 *      over the LIVE ring entry matched by fingerprint key
 *      (logEventKey = seq|ts|epoch|module|event), never a rebuild.
 *
 * A body whose key is NOT in the live ring (the event was evicted after the
 * pane was built) is never revealed: it stays hidden and empty and its safe
 * summary stays visible — the documented fallback, and the Phase 11 review's
 * second P2: the previous code hid the summary and showed an empty detail
 * for exactly those rows. Extracted (the copyTextToClipboard precedent) so
 * the Node suite can pin both behaviours with element-like fakes.
 *
 * @param {Iterable<object>} bodies — the `[data-diag-log-gate="body"]`
 *        elements (`.dataset.diagLogKey` / `.hidden` / `.textContent`, and
 *        `.parentElement.querySelector` reaching the sibling summary)
 * @param {boolean} include — the live content opt-in state
 * @param {object} [deps]
 * @param {function(object=): object[]} [deps.events] — core/diagnostics
 *        getEvents (defaults the real ring; direct import, §II.3)
 * @param {function(): string[]} [deps.knownSecrets] — collectKnownSecrets
 * @returns {void}
 */
export function revealLogDetails(bodies, include, { events = getEvents, knownSecrets = collectKnownSecrets } = {}) {
    const bodyList = Array.from(bodies ?? []);
    if (!bodyList.length) return;

    // The LIVE ring, keyed by fingerprint. seq disambiguates same-millisecond
    // repeats (the review's third find) — without it this Map would collapse
    // them onto one detail and several rows would show the wrong content.
    const secrets = knownSecrets();
    const detailByKey = new Map();
    for (const evt of events()) detailByKey.set(logEventKey(evt), evt.detail);

    for (const el of bodyList) {
        const key = el?.dataset?.diagLogKey;
        const known = detailByKey.has(key);
        const showBody = include && known;
        el.hidden = !showBody;
        el.textContent = showBody
            ? scrubLogDetailForDisplay(detailByKey.get(key), { knownSecrets: secrets })
            : '';
        const summary = el.parentElement?.querySelector?.('[data-diag-log-gate="summary"]');
        if (summary) summary.hidden = showBody;
    }
}

// ─── Diagnostics Tab 7: Integrity (Phase 12) ──────────────────────────────────

/** DOM id of the ▶ Run button (wireDiagnosticsPanel wires its click). */
export const DIAGNOSTICS_INTEGRITY_RUN_BTN_ID = 'mwt-diag-int-run';

/** DOM id of the results container runIntegrityChecks() replaces. */
export const DIAGNOSTICS_INTEGRITY_RESULT_ID = 'mwt-diag-int-result';

/**
 * Render the Integrity pane's IDLE state — the only tab that does NOT render
 * live data at markup-build time. Every check is O(entries) across lorebooks
 * and chat metadata (design §I.6 scale note) and one is an async lorebook
 * read, so the checks run ONLY when the ▶ Run button is clicked
 * (wireDiagnosticsPanel → runIntegrityChecks): never on open, never as a
 * render loop — the §II.4 Phase 12 "on demand only" rule. The idle markup
 * states what will be checked and that nothing is written.
 *
 * @returns {string} innerHTML for the pane
 */
export function renderIntegrityPane() {
    return `
        <div class="mwt-diag-int">
            <div class="mwt-diag-note">
                Read-only checks over this chat's stores — duplicate profile entries, dangling <code>profileUid</code>
                pointers, evidence↔profile orphans, <code>validateSection()</code> per store, and Interiority ledger
                reference integrity. They are <strong>O(entries)</strong>, so they never run on open: press the button,
                read the counts (top-${INTEGRITY_SAMPLE_LIMIT} sample per check; “Copy full JSON” for the complete lists).
                Nothing is written or repaired — the cleanup tools stay in the console where they have dry-run guards.
            </div>
            <button type="button" class="mwt-diag-int-run" id="${DIAGNOSTICS_INTEGRITY_RUN_BTN_ID}" data-diag-int-run="1">▶ Run integrity checks</button>
            <div class="mwt-diag-int-result" id="${DIAGNOSTICS_INTEGRITY_RESULT_ID}" data-diag-int-result="1">
                <p class="mwt-diag-dim" data-diag-int-idle>Not run yet — this tab never checks anything on its own.</p>
            </div>
        </div>
    `;
}

/**
 * Render a REDACTED Integrity snapshot (runIntegrityChecks / the console
 * bridge pass redactIntegritySnapshot() output). Stat header (version ·
 * findings · checked totals · run-at), the verdict banner + warning list
 * (the Scope pane's markup), then one card per check: title + count badge +
 * top-N sample table + “N more” line. Findings are counts and references
 * only — no chat prose reaches this markup by construction (see the
 * integrity.js header), and everything is escapeHtml()-ed regardless.
 *
 * @param {object} snapshot — collectIntegritySnapshot() → redactIntegritySnapshot() output
 * @param {{formatTime?: function(number): string}} [opts] — injectable for Node tests
 * @returns {string} innerHTML for the results container
 */
export function renderIntegritySnapshot(snapshot, { formatTime = (ts) => new Date(ts).toLocaleTimeString() } = {}) {
    const s = snapshot || {};
    const warnings = Array.isArray(s.warnings) ? s.warnings : [];
    const totals = s.totals || {};

    const dim = (text) => `<span class="mwt-diag-dim">${text}</span>`;
    const badge = (text, kind) => `<span class="mwt-diag-badge mwt-diag-badge--${kind}">${escapeHtml(text)}</span>`;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '?');

    // A card: header (title + count badge or dim “unreliable”) + optional
    // note line + optional sample table + “N more” tail. `rows` are pre-built
    // <tr> strings so each check keeps its own columns.
    const card = (title, block, { note = '', columns = '', rowsHtml = '', zeroText = 'None found.', moreLabel = 'more' } = {}) => {
        const countCell = block?.unreliable
            ? badge('unreliable', 'dim')
            : (num(block?.count) === '0' ? badge('0', 'ok') : badge(num(block?.count), 'warn'));
        const more = typeof block?.more === 'number' ? block.more : 0;
        const table = block?.unreliable
            // An unreliable check was SKIPPED, not run clean — "None found."
            // would read as a verdict it does not have.
            ? ''
            : (rowsHtml && columns
                ? `<table class="mwt-diag-health-table mwt-diag-int-table"><thead><tr>${columns}</tr></thead><tbody>${rowsHtml}</tbody></table>`
                : `<p class="mwt-diag-dim">${escapeHtml(zeroText)}</p>`);
        const moreLine = more > 0 ? `<p class="mwt-diag-dim">…and ${more} ${escapeHtml(moreLabel)} — “Copy full JSON” below carries the complete lists.</p>` : '';
        return `
            <div class="mwt-diag-int-card">
                <div class="mwt-diag-int-card-head"><strong>${escapeHtml(title)}</strong> ${countCell}</div>
                ${note ? `<div class="mwt-diag-dim mwt-diag-int-note">${note}</div>` : ''}
                ${table}
                ${moreLine}
            </div>
        `;
    };

    const dupRows = (Array.isArray(s.duplicateProfiles?.sample) ? s.duplicateProfiles.sample : []).map((g) => `
        <tr>
            <td>${escapeHtml(String(g?.npc ?? '?'))}</td>
            <td>${num(g?.count)}</td>
            <td><code>${escapeHtml((Array.isArray(g?.entries) ? g.entries : []).map((e) => num(e?.uid)).join(', '))}</code></td>
            <td>${(Array.isArray(g?.entries) ? g.entries : []).map((e) => e?.referenced ? badge('↩ referenced', 'ok') : dim('orphan')).join(' ') || dim('—')}</td>
        </tr>`).join('');

    const danglingRows = (Array.isArray(s.danglingProfileUids?.sample) ? s.danglingProfileUids.sample : []).map((r) => `
        <tr>
            <td>${escapeHtml(String(r?.npc ?? '?'))}</td>
            <td><code>${escapeHtml(String(r?.profileUid ?? '?'))}</code></td>
            <td>${r?.registryUid == null ? dim('—') : `<code>${escapeHtml(String(r.registryUid))}</code>`}</td>
        </tr>`).join('');

    const orphanRows = (list) => (Array.isArray(list?.sample) ? list.sample : []).map((r) => `
        <tr>
            <td>${escapeHtml(String(r?.npc ?? '?'))}</td>
            <td>${r?.uid == null ? dim('—') : `<code>${escapeHtml(String(r.uid))}</code>`}</td>
            <td>${r?.chars == null ? dim('—') : num(r.chars)}</td>
        </tr>`).join('');
    const evidenceRows = (Array.isArray(s.evidenceWithoutProfile?.sample) ? s.evidenceWithoutProfile.sample : []).map((r) => `
        <tr>
            <td>${escapeHtml(String(r?.npc ?? '?'))}</td>
            <td>${num(r?.raw)} raw · ${num(r?.consolidated)} consolidated · ${num(r?.archivedRaw)} archived</td>
        </tr>`).join('');

    const storeRows = (Array.isArray(s.storeValidations?.sections) ? s.storeValidations.sections : []).map((r) => {
        // Badges compose: a preparing store (design §7.5 — a one-time
        // compatibility update is pending, data left unchanged) never renders
        // as quarantined/corrupt, and can still show real skipped counts
        // alongside when both apply.
        const statusBits = [];
        if (r?.preparing) statusBits.push(badge('preparing', 'warn'));
        if (num(r.skippedCount) !== '0' || num(r.conflicts) !== '0') {
            statusBits.push(badge(`${num(r.skippedCount)} skipped / ${num(r.conflicts)} conflicts`, 'warn'));
        }
        const statusCell = r?.present === false
            ? dim('absent')
            : (statusBits.length ? statusBits.join(' ') : badge('ok', 'ok'));
        const reasonStrings = [
            ...(Array.isArray(r?.deferredReasons) ? r.deferredReasons : []),
            ...(Array.isArray(r?.reasons) ? r.reasons : []),
        ];
        const reasons = reasonStrings.length
            ? `<div class="mwt-diag-dim mwt-diag-int-reasons">${reasonStrings.map((x) => `“${escapeHtml(String(x))}”`).join(' · ')}</div>`
            : '';
        return `
            <tr>
                <td>${escapeHtml(String(r?.label ?? r?.id ?? '?'))} ${dim(`<code>${escapeHtml(String(r?.key ?? ''))}</code>`)}</td>
                <td>${r?.present === false ? dim('never written this chat') : `${num(r?.added)} in / ${num(r?.updated)} upd`}</td>
                <td>${statusCell}${reasons}</td>
            </tr>`;
    }).join('');

    const warningList = warnings.length ? `<ul class="mwt-diag-scope-warnings">${warnings.map((w) => `
        <li>${w.level === 'fail' ? '⛔' : '⚠'} <code>${escapeHtml(w.id)}</code> ${escapeHtml(w.text)}</li>
    `).join('')}</ul>` : '';

    const bannerNote = (s.bannerLevel === 'ok')
        ? 'No integrity findings — every check ran and found nothing warn-worthy.'
        : 'One or more checks found something — read the cards; every cleanup path named in a warning is a console tool with a dry-run guard.';

    // Interiority card body: fixed rows (one per sub-check) instead of a
    // generic sample table — the sub-checks have different shapes. The card's
    // count badge is the SUM of the three sub-check counts.
    const int = s.interiority || {};
    const intCount = Math.max(0, Number(int.duplicateLedgerIds?.count) || 0)
        + Math.max(0, Number(int.tombstonedStillInLedger?.count) || 0)
        + Math.max(0, Number(int.duplicateTombstoneIds?.count) || 0);
    const intRows = `
        <tr><td>ledger entries / tombstones</td><td>${num(int.ledgerEntries)} / ${num(int.tombstones)}</td></tr>
        <tr><td>duplicate ledger ids</td><td>${num(int.duplicateLedgerIds?.count) === '0' ? badge('0', 'ok') : badge(num(int.duplicateLedgerIds?.count), 'warn')}
            ${(Array.isArray(int.duplicateLedgerIds?.sample) ? int.duplicateLedgerIds.sample : []).map((r) => `<code>${escapeHtml(String(r?.id ?? '?'))}</code>×${num(r?.occurrences)}`).join(' ')}</td></tr>
        <tr><td>tombstoned but still live</td><td>${num(int.tombstonedStillInLedger?.count) === '0' ? badge('0', 'ok') : badge(num(int.tombstonedStillInLedger?.count), 'warn')}
            ${(Array.isArray(int.tombstonedStillInLedger?.sample) ? int.tombstonedStillInLedger.sample : []).map((r) => `<code>${escapeHtml(String(r?.id ?? '?'))}</code> ${escapeHtml(String(r?.npc ?? ''))}`).join(' · ')}</td></tr>
        <tr><td>duplicate tombstone ids</td><td>${num(int.duplicateTombstoneIds?.count) === '0' ? badge('0', 'ok') : badge(num(int.duplicateTombstoneIds?.count), 'warn')}</td></tr>`;

    return `
        <div class="mwt-diag-int" data-diag-int-run-result="1">
            <div class="mwt-diag-health-stats">
                <span class="mwt-diag-health-stat"><strong>MWT v${escapeHtml(String(s.mwtVersion ?? '?'))}</strong></span>
                <span class="mwt-diag-health-stat">findings <strong>${num(totals.findings)}</strong></span>
                <span class="mwt-diag-health-stat">${dim('checked:')} <strong>${num(totals.profileEntries)}</strong> profile entries · <strong>${num(totals.registryRecords)}</strong> registry · <strong>${num(totals.evidenceFiles)}</strong> evidence · <strong>${num(totals.ledgerEntries)}</strong> ledger · <strong>${num(totals.sectionsPresent)}</strong> store(s)</span>
                <span class="mwt-diag-health-stat">run at ${escapeHtml(formatTime(s.generatedAt ?? Date.now()))}</span>
            </div>
            <div class="mwt-diag-scope-banner mwt-diag-scope-banner--${s.bannerLevel === 'ok' ? 'ok' : 'warn'}">
                <strong>${s.bannerLevel === 'ok' ? '✅' : '⚠️'} Integrity: ${num(totals.findings)} finding(s)</strong>
                <div class="mwt-diag-scope-banner-note">${escapeHtml(bannerNote)}</div>
            </div>
            ${warningList}
            ${card('Duplicate profile entries', s.duplicateProfiles, {
                columns: '<th>NPC</th><th>entries</th><th>uids</th><th>registry</th>',
                rowsHtml: dupRows, moreLabel: 'group(s) not shown',
                note: 'Groups of “NPC Profiles” entries sharing a name — the visible half of lost pointers. Preview + prune (dry-run first): <code>MWT.profiles.duplicates()</code> / <code>pruneDuplicates()</code>.',
            })}
            ${card('Dangling profileUid pointers', s.danglingProfileUids, {
                columns: '<th>NPC (registry key)</th><th>points at uid</th><th>lorebook uid</th>',
                rowsHtml: danglingRows, moreLabel: 'pointer(s) not shown',
                note: 'Registry pointers whose target entry no longer exists — the next save duplicates instead of overwriting. Recovery (dry-run first): <code>MWT.profiles.relink()</code>.',
            })}
            ${card('Evidence with no profile', s.evidenceWithoutProfile, {
                columns: '<th>NPC</th><th>evidence</th>',
                rowsHtml: evidenceRows, moreLabel: 'file(s) not shown', zeroText: 'None — every evidence file has a profile behind it.',
                note: 'A READING, not a fault: capture ran, the profile has not been generated yet (ordinary mid-pipeline). It only matters if it persists.',
            })}
            ${card('Profiles with no evidence', s.profilesWithoutEvidence, {
                columns: '<th>NPC</th><th>uid</th><th>chars</th>',
                rowsHtml: orphanRows(s.profilesWithoutEvidence), moreLabel: 'entr(y/ies) not shown',
                note: 'The unfalsifiable state the growth feature exists to prevent — nothing can confirm or regenerate these entries.',
            })}
            ${card('Store validation (validateSection per store)', { count: (s.storeValidations?.skippedTotal || 0) + (s.storeValidations?.conflictsTotal || 0), more: 0, sample: [] }, {
                columns: '<th>Store</th><th>records</th><th>validateSection()</th>',
                rowsHtml: storeRows, zeroText: 'Every present store section passed validateSection() with nothing quarantined.',
                note: 'The chat-metadata stores, enumerated from the <code>METADATA_KEYS</code> whitelist (<code>backup/data.js</code>) — records a backup import would refuse are quarantined here with the validator\u2019s own reasons. A store paused pending a one-time compatibility update renders as <preparing> — its data was left unchanged and nothing was quarantined.',
            })}
            ${card('Interiority ledger integrity', { count: intCount, more: 0, sample: [] }, {
                columns: '<th>check</th><th>rows</th>',
                rowsHtml: intRows, zeroText: '',
                note: 'Built on <code>MWT.interiority.deletions()</code> — live entries matching a deletion tombstone (npc + action) came back through a swipe/restore; <code>clearDeletions()</code> is the regret escape hatch, not a fix for these.',
            })}
            <div class="mwt-diag-int-actions">
                <button type="button" class="mwt-diag-int-copy" data-diag-int-copy="1">📋 Copy full JSON</button>
            </div>
        </div>
    `;
}

// ─── Clipboard (Copy Report) ─────────────────────────────────────────────────

/**
 * Copy text to the clipboard WITHOUT ever throwing.
 *
 * `navigator.clipboard` is UNDEFINED on non-secure origins — SillyTavern
 * served over plain http on a LAN is the canonical case — and `writeText()`
 * can still reject on clipboard-restricted deployments (sandboxed iframes,
 * denied permissions). The original Copy Report handler dereferenced it
 * outside its error guard, so those environments got an uncaught synchronous
 * TypeError instead of the intended status message (Phase 5 review
 * follow-up). Both paths degrade to the legacy `execCommand('copy')`
 * textarea fallback; a total failure resolves `false` so the caller can
 * surface the status message and dump the report to the console.
 *
 * nav/doc are injectable so the Node test suite (no browser globals) can pin
 * all three outcomes — async API, legacy fallback, total failure.
 *
 * @param {string} text — the report Markdown
 * @param {{ nav?: object, doc?: object }} [refs] — defaults: the live globals
 * @returns {Promise<boolean>} whether the text reached the clipboard
 */
export async function copyTextToClipboard(text, { nav = globalThis.navigator, doc = globalThis.document } = {}) {
    try {
        if (typeof nav?.clipboard?.writeText === 'function') {
            await nav.clipboard.writeText(text);
            return true;
        }
    } catch { /* denied / not allowed — fall through to the legacy path */ }
    try {
        // Deprecated but universally implemented, and the only clipboard route
        // that works without a secure context. Off-screen textarea so the
        // selection is invisible and cannot scroll the modal.
        const ta = doc.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '0';
        ta.style.opacity = '0';
        doc.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = doc.execCommand('copy');
        ta.remove();
        return ok === true;
    } catch {
        return false;
    }
}

/**
 * Build + copy the full diagnostics report — the handler behind the panel's
 * 📋 Copy Report button, the feature's primary deliverable (design goal 2).
 *
 * ASYNC since Phase 13: the report now serializes the tab accessors
 * (collectReportSections()), and the Integrity section's collect is an async
 * lorebook read — the button is therefore disabled + relabelled while it runs
 * (the runIntegrityChecks precedent) and restored in `finally`, whatever
 * happened. The press itself is the Phase 12 "on demand only" trigger: nothing
 * collects on tab/modal open, and this is one collect per press, never a
 * render loop (decision D2).
 *
 * The content opt-in is read LIVE from the checkbox and never persisted
 * (read-only + in-memory rules), so every session starts with content
 * EXCLUDED. Redaction is buildReport()'s single gate — every section, secrets
 * in either mode, content only with the opt-in.
 *
 * Extracted as a named export with injectable collect/build/copy/status deps
 * (the runIntegrityChecks precedent) so the Node suite can drive the real
 * flow with element-like fakes.
 *
 * @param {HTMLElement} button — the 📋 Copy Report button element
 * @param {HTMLElement} root — the modal root (its checkbox is read; its
 *        status bar is the default status sink)
 * @param {object} [opts] — { collect, build, copy, status, readOptIn }
 *        overrides; `status` is (message, type, clearAfterMs), `readOptIn`
 *        is () => boolean (defaults: the live checkbox in `root`)
 * @returns {Promise<boolean>} whether the report reached the clipboard
 */
export async function runCopyReport(button, root, {
    collect = collectReportSections,
    build = buildReport,
    copy = copyTextToClipboard,
    status = () => {},
    readOptIn,
} = {}) {
    if (!button || !root) return false;
    const includeContent = (readOptIn ?? (() => !!root.querySelector(`#${DIAGNOSTICS_CONTENT_OPT_IN_ID}`)?.checked))();
    const label = button.textContent;
    button.disabled = true;
    button.textContent = '⏳ Building report…';
    try {
        // Phase 13: one collect per press — the sections now include the five
        // tab accessors (health / environment / scope / injection / integrity).
        const report = build({ includeContent, sections: await collect() });
        const copied = await copy(report.markdown);
        if (!copied) {
            // Escape hatch: the report exists even where the clipboard does
            // not — dump it to the console so a tester can still copy it from
            // there.
            console.warn('[MWT:Diagnostics] Clipboard copy failed — the report follows; copy it from the console:', report.markdown);
            status('Copy failed — clipboard unavailable in this context. The report was logged to the browser console (F12).', 'error');
            return false;
        }
        status(includeContent
            ? 'Report copied — content INCLUDED (contains chat text).'
            : 'Report copied — content excluded, secrets redacted.', 'success', 4000);
        return true;
    } catch (err) {
        status(`Report build failed: ${err?.message || err}`, 'error');
        return false;
    } finally {
        button.disabled = false;
        button.textContent = label || '📋 Copy Report';
    }
}

// ─── Integrity wiring (Phase 12) ──────────────────────────────────────────────

/**
 * Run the Integrity checks on demand and render the results — the handler
 * behind the 🛡️ Integrity pane's ▶ Run button. This is the ONLY trigger: the
 * checks never run on tab open or modal open (the §II.4 Phase 12 rule), and
 * this is one collect per press, never a render loop (decision D2 holds).
 *
 * The button is disabled + relabelled while the async collect runs (the
 * profile-book read can take a moment); a collection failure degrades to an
 * error card in the results container, never a broken pane. The snapshot is
 * REDACTED (redactIntegritySnapshot) before it is rendered — the same
 * safe-by-default contract as the console bridge. The rendered "Copy full
 * JSON" button (data-diag-int-copy) is wired here against the REDACTED
 * snapshot it belongs to, via copyIntegritySnapshotJson().
 *
 * Extracted as a named export with injectable collect/render/copy/status
 * deps (the applyLogViewFilters precedent) so the Node suite can drive the
 * real flow with element-like fakes.
 *
 * @param {HTMLElement} button — the ▶ Run button element
 * @param {HTMLElement} result — the results container replaced by this run
 * @param {object} [opts] — { collect, redact, render, copy, status,
 *        formatTime } overrides; `status` is (message, type, clearAfterMs)
 */
export async function runIntegrityChecks(button, result, {
    collect = collectIntegritySnapshot,
    redact = redactIntegritySnapshot,
    render = renderIntegritySnapshot,
    copy = copyTextToClipboard,
    status = () => {},
    formatTime,
} = {}) {
    if (!button || !result) return;
    button.disabled = true;
    button.textContent = '⏳ Running…';
    let snapshot;
    try {
        snapshot = redact(await collect());
    } catch (err) {
        result.innerHTML = `
            <div class="mwt-diag-placeholder">
                <span class="mwt-diag-placeholder-badge">Integrity run failed</span>
                <p>Collecting the integrity snapshot failed: ${escapeHtml(String(err?.message || err))}</p>
            </div>
        `;
        status(`Integrity run failed: ${err?.message || err}`, 'error');
        return;
    } finally {
        button.disabled = false;
        button.textContent = '▶ Run again';
    }
    result.innerHTML = render(snapshot, formatTime ? { formatTime } : {});
    const copyBtn = result.querySelector('[data-diag-int-copy]');
    if (copyBtn) {
        copyBtn.addEventListener('click', () => copyIntegritySnapshotJson(snapshot, { copy, status }));
    }
    const findings = snapshot?.totals?.findings;
    status(`Integrity check run complete — ${typeof findings === 'number' ? findings : '?'} finding(s).`,
        findings > 0 ? 'warning' : 'success', 4000);
}

/**
 * Copy the (already-redacted) Integrity snapshot as pretty-printed JSON —
 * the "copy full JSON" escape hatch for the complete finding lists the pane
 * samples. The snapshot that reaches here is redactIntegritySnapshot()
 * output, so the clipboard text is safe by construction (secrets scrubbed,
 * no chat prose); it still says what it is on failure: the JSON is dumped to
 * the console so a tester can copy it from there (the copyTextToClipboard
 * escape-hatch precedent).
 *
 * @param {object} snapshot — the REDACTED snapshot this run rendered
 * @param {object} [opts] — { copy, status } overrides (Node tests)
 * @returns {Promise<string|null>} the serialised JSON on success, else null
 */
export async function copyIntegritySnapshotJson(snapshot, { copy = copyTextToClipboard, status = () => {} } = {}) {
    let text;
    try {
        text = JSON.stringify(snapshot ?? {}, null, 2);
    } catch {
        text = null;
    }
    if (typeof text !== 'string') {
        status('Could not serialise the integrity snapshot.', 'error');
        return null;
    }
    const ok = await copy(text);
    if (!ok) {
        console.warn('[MWT:Diagnostics] Clipboard copy failed — the integrity snapshot JSON follows; copy it from the console:', text);
        status('Copy failed — clipboard unavailable. The JSON was logged to the browser console (F12).', 'error');
        return null;
    }
    status('Integrity snapshot JSON copied (secrets redacted).', 'success', 4000);
    return text;
}


// ─── Wiring ──────────────────────────────────────────────────────────────────

/**
 * Wire the panel's events inside the given modal root. Called from
 * index.js renderModal() on every render, mirroring wireBackupEvents().
 *
 * @param {HTMLElement} root — the modal element (its status bar is reused)
 */
export function wireDiagnosticsPanel(root) {
    if (!root) return;

    // Sub-tab switching, scoped to this panel. Deliberately its own class
    // namespace (mwt-diag-tab-*, data-diag-tab) so the main modal tab bar's
    // delegation in index.js (.mwt-tab-btn / data-tab) cannot collide with it.
    const bar = root.querySelector('.mwt-diag-tab-bar');
    if (bar) {
        bar.addEventListener('click', (e) => {
            const btn = e.target.closest('.mwt-diag-tab-btn');
            if (!btn) return;
            const id = btn.dataset.diagTab;
            root.querySelectorAll('.mwt-diag-tab-btn').forEach(b => b.classList.toggle('active', b === btn));
            root.querySelectorAll('.mwt-diag-tab-pane').forEach(p => p.classList.toggle('active', p.dataset.diagTab === id));
        });
    }

    // Copy Report — the feature's primary deliverable (design goal 2). The
    // checkbox is read live and never persisted (read-only + in-memory
    // rules), so every session starts with content EXCLUDED. Phase 13
    // finalized the serialized sections (the tab accessors now included) and
    // made the collect async — the Integrity section reads a lorebook — so the
    // button is disabled while it runs (runCopyReport, the runIntegrityChecks
    // precedent). The clipboard itself goes through copyTextToClipboard():
    // navigator.clipboard is absent on non-secure origins, and touching it
    // unguarded threw synchronously out of this handler (Phase 5 review
    // follow-up).
    const copyBtn = root.querySelector('#mwt-diag-copy-report');
    if (copyBtn) {
        copyBtn.addEventListener('click', () => {
            runCopyReport(copyBtn, root, {
                status: (message, type, clearAfterMs) => setStatus(root, message, type, clearAfterMs),
            });
        });
    }

    // Phase 9 — content opt-in reveal for the Injection tab's recorded
    // payloads. Payloads are chat-derived content, so they sit behind the
    // SAME consequence-stated checkbox the copied report uses (design §I.6).
    // Two guards stack here:
    //   1. DEFERRED INSERTION — the <pre> ships EMPTY in the markup; the
    //      payload only enters the DOM at the moment of opt-in (and leaves it
    //      again on un-tick), so no payload text is ever present-but-hidden.
    //   2. SECRET SCRUBBING — what gets inserted is
    //      scrubPayloadForDisplay() over the live Phase 2 snapshot (embedded
    //      URLs → scheme+host, key/bearer shapes, and this install's known
    //      secret values via collectKnownSecrets()), and it goes in via
    //      textContent, so payload text is never parsed as HTML either.
    // Insertion happens by KEY (data-diag-inj-key), reading the store live —
    // fresher than a render-time copy and no cache to leak. NOT a render
    // loop — decision D2's open-and-read model is untouched.
    const contentToggle = root.querySelector(`#${DIAGNOSTICS_CONTENT_OPT_IN_ID}`);
    if (contentToggle) {
        contentToggle.addEventListener('change', () => {
            const include = contentToggle.checked === true;
            root.querySelectorAll('[data-diag-inj-gate="body"]').forEach((el) => {
                el.hidden = !include;
                el.textContent = include
                    ? scrubPayloadForDisplay(
                        getAllInjectedSnapshots()[el.dataset?.diagInjKey]?.payload ?? '',
                        { knownSecrets: collectKnownSecrets() },
                    )
                    : '';
            });
            root.querySelectorAll('[data-diag-inj-gate="placeholder"]').forEach((el) => { el.hidden = include; });

            // Phase 11 — Log detail reveal: the SAME two guards as the
            // Injection payloads applied to every event row, extracted into
            // revealLogDetails() (deferred insertion + secret scrubbing over
            // the LIVE ring, matched by the seq-carrying fingerprint — see
            // its docstring for the evicted-row and collision rules).
            revealLogDetails(root.querySelectorAll('[data-diag-log-gate="body"]'), include);
        });
    }

    // Phase 11 — Log filters (design §I.5 Tab 6): level chips + module select
    // + the visible-of counter, as VIEW TOGGLES over the rows already on
    // screen — they never re-collect or re-render, so decision D2's
    // open-and-read model is untouched (the same "a view toggle, not a render
    // loop" carve-out the Phase 9 payload reveal uses). The logic lives in
    // applyLogViewFilters(); this glue only gathers the elements. Scoped to
    // the Log pane so the checkbox/select listeners cannot collide with the
    // main modal's delegation.
    const logPane = root.querySelector('.mwt-diag-log');
    if (logPane) {
        const applyLogFilters = () => {
            applyLogViewFilters(
                logPane.querySelectorAll('tr[data-diag-log-row]'),
                logPane.querySelectorAll('input[data-diag-log-filter-level]'),
                logPane.querySelector('select[data-diag-log-filter-module]'),
                logPane.querySelector('[data-diag-log-counter]'),
            );
        };
        logPane.addEventListener('change', (e) => {
            if (e.target?.matches?.('input[data-diag-log-filter-level], select[data-diag-log-filter-module]')) {
                applyLogFilters();
            }
        });
    }

    // Phase 12 — Integrity on-demand run (design §I.5 Tab 7): the ▶ Run
    // button is the ONLY trigger for the checks — they are O(entries) and one
    // is an async lorebook read, so they never run on tab/modal open (the
    // "on demand only" rule). One press = one collect + one render (never a
    // render loop). The real logic lives in runIntegrityChecks(); this glue
    // only adapts the status sink to this modal's status bar.
    const integrityRunBtn = root.querySelector(`#${DIAGNOSTICS_INTEGRITY_RUN_BTN_ID}`);
    const integrityResult = root.querySelector(`#${DIAGNOSTICS_INTEGRITY_RESULT_ID}`);
    if (integrityRunBtn && integrityResult) {
        integrityRunBtn.addEventListener('click', () => {
            runIntegrityChecks(integrityRunBtn, integrityResult, {
                status: (message, type, clearAfterMs) => setStatus(root, message, type, clearAfterMs),
            });
        });
    }

    // Phase 7 — one-shot deferred fill of the shared.js Connection Manager
    // probe cell. The Environment pane renders synchronously with a
    // "probing…" placeholder because the ONLY authoritative source for this
    // feature is the dynamic import core/api.js itself uses; this fills the
    // cell once when that settles (or reports the import failure). NOT a
    // render loop — decision D2's open-and-read model is untouched, and a
    // modal closed before the import settles simply patches a detached node.
    const cmrsCell = root.querySelector(`#${DIAGNOSTICS_ENV_CMRS_CELL_ID}`);
    if (cmrsCell) {
        loadSharedModule().then((loaded) => {
            cmrsCell.innerHTML = renderConnectionManagerCell(inspectConnectionManager(loaded));
        });
    }
}

