/**
 * diagnostics_panel/render.js — Panel shell (Diagnostics Phase 5) + Tab 1
 * Health (Phase 6).
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
 * Hard limits inherited from the design (§I.1): READ-ONLY — nothing here
 * writes to settings, chat metadata, or localStorage; the checkbox state is
 * deliberately not persisted, so every session starts with content EXCLUDED.
 *
 * DOM-coupled by design; all testable logic lives in core/redaction.js,
 * ./report.js, and ./health.js.
 */

import { setStatus, escapeHtml } from '../core/index.js';
import { buildReport, collectReportSections } from './report.js';
import { collectHealthSnapshot } from './health.js';

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
            ${t.id === 'health' ? renderHealthPane() : `
            <div class="mwt-diag-placeholder">
                <span class="mwt-diag-placeholder-badge">Phase ${t.phase} — not built yet</span>
                <p>${t.blurb}</p>
            </div>
            `}
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
                <td class="mwt-diag-health-tokens">${r.tokens || 0}</td>
                <td>${autoCell(r.auto)}</td>
                <td>${lastRunCell(r.lastRun)}</td>
            </tr>`;
    }).join('');

    // The panic switch is rendered unmissably (design §I.5 Tab 1): it is the
    // one global state that makes every "why is nothing injecting" report a
    // non-bug, so it leads the pane whenever it is on.
    const panicBanner = s.injectionMasterOff
        ? `<div class="mwt-diag-panic">⛔ <strong>PANIC SWITCH ON</strong> — injection &amp; scanning are stopped for every module
             (<code>injectionMasterOff</code>). Right-click the ⚙️ floating button to release it.</div>`
        : '';

    return `
        <div class="mwt-diag-health">
            <div class="mwt-diag-health-stats">
                <span class="mwt-diag-health-stat"><strong>MWT v${escapeHtml(String(s.mwtVersion ?? '?'))}</strong></span>
                <span class="mwt-diag-health-stat">tokens: <strong>${s.totalTokens ?? 0}</strong> across all modules</span>
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
                the one question that matters: may this module inject right now.</p>
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
}

