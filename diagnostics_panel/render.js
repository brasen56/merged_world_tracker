/**
 * diagnostics_panel/render.js — Panel shell (Diagnostics Phase 5) + Tab 1
 * Health (Phase 6) + Tab 2 Environment (Phase 7).
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
 * Hard limits inherited from the design (§I.1): READ-ONLY — nothing here
 * writes to settings, chat metadata, or localStorage; the checkbox state is
 * deliberately not persisted, so every session starts with content EXCLUDED.
 *
 * DOM-coupled by design; all testable logic lives in core/redaction.js,
 * ./report.js, ./health.js, and ./environment.js.
 */

import { setStatus, escapeHtml } from '../core/index.js';
import { buildReport, collectReportSections } from './report.js';
import { collectHealthSnapshot, TOKEN_KINDS } from './health.js';
import { collectEnvironmentSnapshot, inspectConnectionManager, loadSharedModule } from './environment.js';
import { collectScopeSnapshot } from './scope_storage.js';

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
            ${t.id === 'health' ? renderHealthPane() : (t.id === 'environment' ? renderEnvironmentPane() : (t.id === 'scope' ? renderScopePane() : `
            <div class="mwt-diag-placeholder">
                <span class="mwt-diag-placeholder-badge">Phase ${t.phase} — not built yet</span>
                <p>${t.blurb}</p>
            </div>
            `))}
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
        return `
            <tr data-book="${escapeHtml(String(b.id))}">
                <td>${escapeHtml(String(b.label ?? b.id))}</td>
                <td class="mwt-diag-env-value">${escapeHtml(String(b.name ?? ''))}</td>
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
            <p class="mwt-diag-env-subheading">Books — hydration &amp; store version</p>
            <table class="mwt-diag-env-table">
                <thead><tr><th>Book</th><th>Name</th><th>Store</th><th>Version</th></tr></thead>
                <tbody>${bookRows}</tbody>
            </table>
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
    // rules), so every session starts with content EXCLUDED. Phase 13 will
    // extend the serialized sections and run the final QA sweep; the shape
    // and the redaction routing are fixed here. The clipboard itself goes
    // through copyTextToClipboard(): navigator.clipboard is absent on
    // non-secure origins, and touching it unguarded threw synchronously out
    // of this handler (Phase 5 review follow-up).
    const copyBtn = root.querySelector('#mwt-diag-copy-report');
    if (copyBtn) {
        copyBtn.addEventListener('click', () => {
            const includeContent = !!root.querySelector(`#${DIAGNOSTICS_CONTENT_OPT_IN_ID}`)?.checked;
            let report;
            try {
                report = buildReport({ includeContent, sections: collectReportSections() });
            } catch (err) {
                setStatus(root, `Report build failed: ${err?.message || err}`, 'error');
                return;
            }
            copyTextToClipboard(report.markdown).then((copied) => {
                if (!copied) {
                    // Escape hatch: the report exists even where the clipboard
                    // does not — dump it to the console so a tester can still
                    // copy it from there.
                    console.warn('[MWT:Diagnostics] Clipboard copy failed — the report follows; copy it from the console:', report.markdown);
                    setStatus(root, 'Copy failed — clipboard unavailable in this context. The report was logged to the browser console (F12).', 'error');
                    return;
                }
                setStatus(root, includeContent
                    ? 'Report copied — content INCLUDED (contains chat text).'
                    : 'Report copied — content excluded, secrets redacted.', 'success', 4000);
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

