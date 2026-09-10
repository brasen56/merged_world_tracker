/**
 * budget/panel.js — The 📊 Budget main tab (TODO §2 context/token budget).
 *
 * The user-facing half of core/budget.js: one cross-module view answering
 * "what is MWT putting in the prompt, what would the budget do about it, and
 * what are my caps?" —
 *
 *   · estimated tokens per module (REGISTERED payload tokens for the four
 *     seam modules — the Phase 2 snapshots, never a rebuild — plus
 *     Knowledge's stored lorebook total, reported as ADVISORY only);
 *   · total vs the selected model's context limit (auto-detected where the
 *     build exposes it, manual override otherwise);
 *   · the drop-order MODEL (what gets dropped/truncated first, from the
 *     same planner the enforcement seam uses — the panel and the seam can
 *     never disagree because there is one brain);
 *   · per-module priority + soft/hard caps and the global hard cap, saved
 *     into THIS CHAT's metadata (per-project, not global);
 *   · the ENFORCE toggle — off by default; the panel models, enforcement
 *     acts only where the user opted in.
 *
 * DOM-free collector + string renderer + wiring, the diagnostics_panel
 * pattern (health.js/injection.js): every dependency injectable, every
 * accessor call individually guarded — one throwing module degrades its own
 * row plus an `errors` note, never the tab. Direct imports throughout (NOT
 * core/index.js — the §II.3 barrel→stub alias trap).
 */

import { MWT_VERSION } from '../core/version.js';
import { escapeHtml } from '../core/diff.js';
import { estimateTokens } from '../core/context.js';
import { getAllInjectedSnapshots } from '../core/diagnostics.js';
import {
    BUDGET_MODULE_SPECS,
    BUDGET_LIMITS,
    getBudgetSettings,
    saveBudgetSettings,
    resolveContextLimit,
    modelDropOrder,
    planBudgetDecision,
} from '../core/budget.js';
// Knowledge's stored lorebook total — the advisory figure (its entries reach
// the prompt through ST's World Info activation, not MWT's seam).
import * as Knowledge from '../knowledge/index.js';

// ─── Snapshot collector ──────────────────────────────────────────────────────

/**
 * Collect the panel's whole view. Read-only: nothing here writes settings or
 * touches a registered slot — the save path (wireBudgetTab) is the only
 * writer, and it goes through saveBudgetSettings.
 *
 * @param {object} [deps] — injectable for tests
 * @returns {object} the snapshot the renderer consumes
 */
export function collectBudgetSnapshot({
    settings = getBudgetSettings(),
    injections = getAllInjectedSnapshots(),
    knowledgeTokens = () => Knowledge.getTotalTokens?.() ?? 0,
    contextLimit = resolveContextLimit(),
    version = MWT_VERSION,
    now = Date.now,
} = {}) {
    const errors = [];
    const call = (label, fn, fallback) => {
        try {
            const v = fn();
            return v === undefined ? fallback : v;
        } catch (err) {
            errors.push(`${label}: ${String(err?.message || err)}`);
            return fallback;
        }
    };

    // Registered tokens per module id — the seam modules from the Phase 2
    // snapshots (exactly what was handed to setExtensionPrompt), Knowledge's
    // advisory stored total from its own accessor.
    const registered = {};
    for (const spec of BUDGET_MODULE_SPECS) {
        if (spec.key === null) {
            registered[spec.id] = call(`tokens:${spec.id}`, () => Number(knowledgeTokens()) || 0, 0);
        } else {
            const snap = injections[spec.key];
            registered[spec.id] = (snap?.enabled && snap.payload)
                ? call(`tokens:${spec.id}`, () => estimateTokens(snap.payload), 0)
                : 0;
        }
    }

    // The modeled decision per seam module — what enforcement WOULD do with
    // the payload that is registered RIGHT NOW. Each row's `others` map
    // excludes itself (the planner only ever reads other ids).
    const seamTokens = {};
    for (const spec of BUDGET_MODULE_SPECS) {
        if (spec.key !== null) seamTokens[spec.id] = registered[spec.id];
    }

    const modules = BUDGET_MODULE_SPECS.map((spec) => {
        const m = settings.modules[spec.id] || { priority: spec.defaultPriority, softCap: 0, hardCap: 0 };
        const snap = spec.key !== null ? (injections[spec.key] ?? null) : null;
        let plan = null;
        if (spec.key !== null && snap?.enabled && snap.payload) {
            const others = { ...seamTokens };
            delete others[spec.id];
            plan = call(`plan:${spec.id}`, () => planBudgetDecision({
                spec,
                payload: snap.payload,
                settings,
                others,
            }), null);
        }
        return {
            id: spec.id,
            label: spec.label,
            mechanism: spec.mechanism,
            advisory: spec.advisory === true,
            priority: m.priority,
            softCap: m.softCap,
            hardCap: m.hardCap,
            tokens: registered[spec.id],
            // The seam modules' figure is prompt load this turn; Knowledge's
            // is library size on disk (the Health tab's token-kind split).
            tokenKind: spec.key === null ? 'stored' : 'injected',
            registered: spec.key !== null ? (snap?.enabled === true && !!snap?.payload) : false,
            plan: plan ? {
                action: plan.action,
                reason: plan.reason,
                tokensBefore: plan.tokensBefore,
                tokensAfter: plan.tokensAfter,
                displaced: plan.displaced,
            } : null,
        };
    });

    const injectedTotal = modules.filter((r) => r.tokenKind === 'injected').reduce((s, r) => s + r.tokens, 0);
    const storedTotal = modules.filter((r) => r.tokenKind === 'stored').reduce((s, r) => s + r.tokens, 0);

    // The pre-send summary (the user-facing "N dropped, M truncated, ~K tokens
    // sent"): what enforcement would do with the CURRENTLY registered payloads
    // under the current caps. Each row's plan is modeled independently (its
    // `others` are the current registrations, not other rows' plans) — exactly
    // how enforcement sees each apply — so the aggregate is per-apply truth,
    // not a hypothetical simultaneous pass.
    let dropped = 0;
    let truncated = 0;
    let keptTokens = 0;
    let totalBefore = 0;
    for (const r of modules) {
        if (!r.plan) continue;
        totalBefore += r.plan.tokensBefore;
        if (r.plan.action === 'drop') {
            dropped += 1;
        } else {
            if (r.plan.action === 'truncate') truncated += 1;
            keptTokens += r.plan.tokensAfter;
        }
    }

    return {
        generatedAt: now(),
        mwtVersion: version,
        enforce: settings.enforce,
        contextLimit: {
            value: contextLimit.value ?? null,
            source: contextLimit.source,
            note: contextLimit.note,
        },
        contextLimitOverride: settings.contextLimitOverride,
        globalHardCap: settings.globalHardCap,
        injectedTokens: injectedTotal,
        storedTokens: storedTotal,
        projected: {
            dropped,
            truncated,
            keptTokens,
            totalBefore,
        },
        modules,
        dropOrder: modelDropOrder({ settings }),
        ...(errors.length ? { errors } : {}),
    };
}

// ─── Renderer ────────────────────────────────────────────────────────────────

/** Shared badge builder (the diagnostics panels' tones). */
function badge(text, tone) {
    return `<span class="mwt-diag-badge mwt-diag-badge--${tone}">${text}</span>`;
}

/**
 * Split a module label into its decorative leading icon and the plain module
 * name. BUDGET_MODULE_SPECS labels are emoji-led ("🌍 World State"), and the
 * emoji is visual sugar (a11y plan §4.4): it renders inside an aria-hidden
 * span and never rides into an accessible name or a textual summary. A label
 * with no leading emoji — the shape hand-built test snapshots use — passes
 * through whole, and so does a label that is ONLY an emoji (it has no plain
 * name to expose; splitting it would render the glyph twice), so all of these
 * shapes name their rows identically.
 *
 * @param {string} label — a spec label (or any snapshot row's label)
 * @returns {{icon: string, name: string}} icon is '' when there is none; name
 *   is always the text an accessible name or summary should use
 */
function splitModuleLabel(label) {
    const raw = String(label ?? '');
    // One emoji sequence — a pictographic base plus any VS-16, skin-tone
    // modifier, or ZWJ-joined continuation — then the separator and the rest.
    const m = raw.match(/^(\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic})*)\s*(.*)$/u);
    // No match, or nothing after the emoji: pass the whole label through as
    // the name with no icon split. Falling back to `raw` as the name here
    // (m[2] || raw) would make an emoji-only label yield name === icon — the
    // glyph would render twice (once aria-hidden, once not) and ride into
    // every accessible name built from `name`.
    if (!m || !m[2]) return { icon: '', name: raw };
    return { icon: m[1], name: m[2] };
}

/**
 * Plain display name for a module ID. planBudgetDecision's `displaced` array
 * holds module IDS (core/budget.js pushes victim.id), and the note under the
 * badge must read with the same plain names the drop-order summary uses —
 * "(would displace: World State)" — not raw snake_case ids. An id with no
 * spec (hand-built snapshots, forward-compat) passes through unchanged.
 *
 * @param {string} id — a module id (a BUDGET_MODULE_SPECS id, or any string)
 * @returns {string} the spec label's plain name, or the id itself when unknown
 */
function modulePlainName(id) {
    const spec = BUDGET_MODULE_SPECS.find((s) => s.id === id);
    return spec ? splitModuleLabel(spec.label).name : String(id ?? '');
}

/**
 * Render the pane markup from a snapshot (pure string builder; injectable
 * formatTime keeps Node tests deterministic — renderHealthSnapshot's rule).
 *
 * @param {object} snapshot — collectBudgetSnapshot() output
 * @param {{formatTime?: function(number): string}} [opts]
 * @returns {string} innerHTML for the pane
 */
export function renderBudgetSnapshot(snapshot, { formatTime = (ts) => new Date(ts).toLocaleTimeString() } = {}) {
    const s = snapshot || {};
    const rows = Array.isArray(s.modules) ? s.modules : [];

    // The registered-vs-stored tokens explanation lives in the visible help
    // block under the table (#mwt-budget-help-tokens), not in a tooltip
    // (a11y plan §5 Slice 4 item 3).
    const tokensCell = (r) => {
        const n = Number(r.tokens) || 0;
        const amount = n.toLocaleString();
        if (r.tokenKind === 'stored') {
            return `<span class="mwt-budget-tokens-stored">${amount} <span class="mwt-diag-dim">stored</span></span>`;
        }
        return `<span>${r.registered ? amount : '<span class="mwt-diag-dim">not registered</span>'}</span>`;
    };

    // The modeled action's reason (and displacement note) ride visibly under
    // the badge — the action must not live in a tooltip alone — and the
    // truncate result is spelled out rather than an arrow-plus-number whose
    // meaning was carried by the arrow glyph and the badge color.
    const planCell = (r) => {
        if (r.advisory) return '<span class="mwt-diag-dim">advisory only</span>';
        if (!r.plan) return `<span class="mwt-diag-dim">—<span class="mwt-sr-only"> nothing registered — nothing to model</span></span>`;
        // displaced holds module IDS — map them to plain names like the
        // drop-order summary below does, and escape the list like its escaped
        // sibling `reason` on the same line.
        const displacedNote = r.plan.displaced?.length
            ? ` (would displace: ${escapeHtml(r.plan.displaced.map(modulePlainName).join(', '))})`
            : '';
        const detail = `<div class="mwt-budget-plan-reason">${escapeHtml(r.plan.reason)}${displacedNote}</div>`;
        if (r.plan.action === 'keep') return badge('keeps', 'ok') + detail;
        if (r.plan.action === 'truncate') return badge(`truncates to ~${Number(r.plan.tokensAfter).toLocaleString()}`, 'warn') + detail;
        return badge('drops', 'fail') + detail;
    };

    const rowHtml = rows.map((r) => {
        const classes = ['mwt-budget-row'];
        if (!r.registered && !r.advisory) classes.push('mwt-budget-row--idle');
        // Knowledge is advisory only: it reaches the prompt through
        // SillyTavern World Info activation rather than MWT's shared seam, so
        // enforcement cannot read or apply priority/soft/hard values for it.
        // Disabled fields make that scope explicit instead of presenting
        // editable no-op controls (TODO §2 P3).
        const advisoryDisabled = r.advisory
            ? ' disabled title="Advisory only — Knowledge is not managed by MWT budget enforcement"'
            : '';
        // Slice 4 (a11y plan §4.4 / §5 Slice 4 items 1+3): the module cell is
        // the row header (scope="row"), and every per-module input is named
        // "«Module» priority/soft cap/hard cap" with its column's visible
        // help snippet as the description — the bare number inputs announced
        // as nothing but their value before.
        // The spec labels are emoji-led ("🌍 World State"), so the icon is
        // split off and hidden (aria-hidden) while every textual surface —
        // the row header and the three input names — uses the plain name only.
        const { icon, name } = splitModuleLabel(r.label);
        return `
            <tr class="${classes.join(' ')}" data-module="${r.id}">
                <th scope="row" class="mwt-budget-module">${icon ? `<span aria-hidden="true">${escapeHtml(icon)}</span> ` : ''}${escapeHtml(name)}</th>
                <td><input class="mwt-budget-priority" data-module="${r.id}" type="number" min="${BUDGET_LIMITS.priorityMin}" max="${BUDGET_LIMITS.priorityMax}" step="1" value="${r.priority}" aria-label="${escapeHtml(name)} priority" aria-describedby="mwt-budget-help-priority"${advisoryDisabled}></td>
                <td>${tokensCell(r)}</td>
                <td class="mwt-budget-plan">${planCell(r)}</td>
                <td><input class="mwt-budget-soft" data-module="${r.id}" type="number" min="0" max="${BUDGET_LIMITS.capMax}" step="50" value="${r.softCap}" aria-label="${escapeHtml(name)} soft cap" aria-describedby="mwt-budget-help-soft"${advisoryDisabled}></td>
                <td><input class="mwt-budget-hard" data-module="${r.id}" type="number" min="0" max="${BUDGET_LIMITS.capMax}" step="50" value="${r.hardCap}" aria-label="${escapeHtml(name)} hard cap" aria-describedby="mwt-budget-help-hard"${advisoryDisabled}></td>
            </tr>`;
    }).join('');

    // The usage bar: MWT's injected total vs the resolved context limit.
    const limit = s.contextLimit?.value ?? null;
    const injected = Number(s.injectedTokens) || 0;
    const stored = Number(s.storedTokens) || 0;
    let barHtml;
    if (limit && limit > 0) {
        const pct = Math.min(100, Math.round((injected / limit) * 100));
        const over = injected > limit;
        // The limit's source note rides visibly under the bar — the
        // unknown-limit branch already shows it, and it was tooltip-only here
        // (a11y plan §5 Slice 4 item 3).
        const barNote = s.contextLimit.note
            ? `<div class="mwt-budget-bar-note mwt-diag-dim">${escapeHtml(s.contextLimit.note)}</div>`
            : '';
        barHtml = `
            <div class="mwt-budget-bar-wrap">
                <div class="mwt-budget-bar"><div class="mwt-budget-bar-fill${over ? ' mwt-budget-bar-fill--over' : ''}" style="width:${pct}%"></div></div>
                <span class="mwt-budget-bar-label">${injected.toLocaleString()} / ${limit.toLocaleString()} tokens (${pct}%)${over ? ' — OVER' : ''}</span>
            </div>
            ${barNote}`;
    } else {
        barHtml = `
            <div class="mwt-budget-bar-wrap">
                <span class="mwt-diag-dim">${injected.toLocaleString()} tokens injected — context limit unknown on this build. ${escapeHtml(s.contextLimit?.note || '')}</span>
            </div>`;
    }

    // Slice 4 item 2: the banner glyphs are decorative — the banner text
    // carries the whole meaning — so they sit in aria-hidden spans.
    const modeBanner = s.enforce
        ? `<div class="mwt-budget-mode mwt-budget-mode--enforce"><span aria-hidden="true">🛡</span> <strong>ENFORCE is ON for this chat</strong> — over-cap injections are truncated or dropped at the shared injection seam. Re-apply a module's injection (toggle it, or trigger a refresh) for the new caps to take effect on its current payload.</div>`
        : `<div class="mwt-budget-mode mwt-budget-mode--observe"><span aria-hidden="true">👀</span> <strong>Observe mode (default)</strong> — injection applies are not modified. The chat-change lifecycle still clears stale cross-chat injection snapshots. The "Budget action" column models what enforcement WOULD do with the current caps.</div>`;

    // The pre-send summary: "1 dropped · 1 truncated · ~800 of 1,200 tokens
    // kept" at current sizes. Only meaningful when something is registered.
    const proj = s.projected || { dropped: 0, truncated: 0, keptTokens: 0, totalBefore: 0 };
    const summaryLine = proj.totalBefore > 0
        ? `<div class="mwt-budget-summary">At current sizes with these caps:
            <strong>${proj.dropped} dropped</strong> · <strong>${proj.truncated} truncated</strong> ·
            ~${proj.keptTokens.toLocaleString()} of ${proj.totalBefore.toLocaleString()} tokens kept
            ${s.enforce ? '(applied at each module\'s next injection apply)' : '(would be, if enforcement were on)'}</div>`
        : '';

    // Plain names only (splitModuleLabel): this is a textual summary, and the
    // emoji-led spec labels would otherwise announce their glyphs here too.
    const dropOrderText = (Array.isArray(s.dropOrder) ? s.dropOrder : [])
        .map((d) => `${splitModuleLabel(d.label).name} (P${d.priority})`).join(' → ');

    const storedStat = stored > 0
        ? `<span class="mwt-diag-dim">+ ${stored.toLocaleString()} stored (advisory)</span>`
        : '';

    const errBanner = s.errors?.length
        ? `<div class="mwt-diag-panic"><span aria-hidden="true">⚠</span> Some rows degraded: ${escapeHtml(s.errors.join('; '))}</div>`
        : '';

    return `
        <div class="mwt-budget">
            <div class="mwt-diag-health-stats">
                <span class="mwt-diag-health-stat"><strong>MWT v${escapeHtml(String(s.mwtVersion ?? '?'))}</strong></span>
                <span class="mwt-diag-health-stat">MWT injections: <strong>${injected.toLocaleString()}</strong> tokens</span>
                ${storedStat}
                <span class="mwt-diag-health-stat">read at ${escapeHtml(formatTime(s.generatedAt ?? Date.now()))}</span>
            </div>
            ${modeBanner}
            ${errBanner}
            ${summaryLine}
            ${barHtml}
            <table class="mwt-diag-health-table mwt-budget-table">
                <thead>
                    <tr>
                        <th scope="col">Module</th>
                        <th scope="col" aria-describedby="mwt-budget-help-priority">Priority</th>
                        <th scope="col" aria-describedby="mwt-budget-help-tokens">Estimated tokens</th>
                        <th scope="col" aria-describedby="mwt-budget-help-action">Budget action</th>
                        <th scope="col" aria-describedby="mwt-budget-help-soft">Soft cap</th>
                        <th scope="col" aria-describedby="mwt-budget-help-hard">Hard cap</th>
                    </tr>
                </thead>
                <tbody>${rowHtml}</tbody>
            </table>
            <div class="mwt-budget-help">
                <p id="mwt-budget-help-priority"><strong>Priority</strong> — lower number = kept longer when the budget must drop content.</p>
                <p id="mwt-budget-help-tokens"><strong>Estimated tokens</strong> — registered payload tokens (what setExtensionPrompt received); the stored figure is Knowledge's library size on disk — SillyTavern activates only entries whose keywords match, so this is NOT prompt load.</p>
                <p id="mwt-budget-help-action"><strong>Budget action</strong> — what enforcement would do with the CURRENTLY registered payload under the current caps.</p>
                <p id="mwt-budget-help-soft"><strong>Soft cap</strong> — over the soft cap → truncate with a marker. 0 = off.</p>
                <p id="mwt-budget-help-hard"><strong>Hard cap</strong> — over the hard cap → drop the injection. 0 = off.</p>
            </div>
            <div class="mwt-budget-controls">
                <label class="mwt-budget-enforce-label" for="mwt-budget-enforce">
                    <input type="checkbox" id="mwt-budget-enforce" ${s.enforce ? 'checked' : ''}>
                    <span><strong>Enforce budget for this chat</strong> — over-cap injections are truncated (soft) or dropped (hard) at the shared injection seam. Off by default; observe mode leaves injection applies unchanged.</span>
                </label>
                <div class="mwt-budget-global-controls">
                    <label for="mwt-budget-global-hard">Global hard cap (tokens, 0 = off):</label>
                    <input id="mwt-budget-global-hard" type="number" min="0" max="${BUDGET_LIMITS.capMax}" step="100" value="${Number(s.globalHardCap) || 0}">
                    <label for="mwt-budget-limit-override">Context limit override (tokens, 0 = auto):</label>
                    <input id="mwt-budget-limit-override" type="number" min="0" max="${BUDGET_LIMITS.overrideMax}" step="500" value="${Number(s.contextLimitOverride) || 0}">
                    <button id="mwt-budget-save" class="mwt-btn mwt-btn-primary">Save Budget</button>
                </div>
            </div>
            <p class="mwt-diag-note">Actionable drop order when the global cap is exceeded (lowest priority first):
                <strong>${escapeHtml(dropOrderText || '(none)')}</strong>.<br>
                These settings live in THIS CHAT's metadata — other chats are unaffected.<br>
                <strong>Not managed here:</strong> SillyTavern's own prompt (system prompt, chat history, author's note) and
                Knowledge's lorebook entries (SillyTavern World Info keyword activation) — reported, never modified, and outside the actionable drop order.
                Token figures are estimates (the same estimateTokens every MWT surface uses).</p>
        </div>
    `;
}

/**
 * Collect + render the Budget pane. Called at markup-build time inside the
 * modal's buildTabContent(): the modal body is rebuilt on every open, which
 * is this tab's refresh model (decision D2 — no render loop). A collection
 * failure degrades to an error card, never a broken panel (renderHealthPane's
 * rule).
 *
 * @returns {string} innerHTML for the Budget tab
 */
export function renderBudgetPane() {
    let snapshot;
    try {
        snapshot = collectBudgetSnapshot();
    } catch (err) {
        return `
            <div class="mwt-diag-placeholder">
                <span class="mwt-diag-placeholder-badge">Budget unavailable</span>
                <p>Collecting the budget snapshot failed: ${escapeHtml(String(err?.message || err))}</p>
            </div>
        `;
    }
    return renderBudgetSnapshot(snapshot);
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

/**
 * Wire the Budget tab's interactive controls: the Save button (priority/
 * caps/override/enforce persist through saveBudgetSettings), with clamping
 * identical to normalizeBudgetSettings so what is saved is what is enforced.
 * Rebind-every-render (the wireDiagnosticsPanel rule): the modal is rebuilt
 * on each open, so stale listeners cannot accumulate.
 *
 * @param {HTMLElement} root — the modal root (or any container holding the
 *   tab's markup)
 * @param {object} [deps] — injectable for tests
 */
export function wireBudgetTab(root, {
    save = saveBudgetSettings,
    setStatusFn = null,
} = {}) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    const btn = root.querySelector('#mwt-budget-save');
    if (!btn) return;

    btn.addEventListener('click', () => {
        const num = (sel, max) => {
            const n = Number(root.querySelector(sel)?.value);
            return Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n))) : 0;
        };
        const modules = {};
        for (const row of root.querySelectorAll('.mwt-budget-priority')) {
            const id = row.dataset.module;
            const spec = BUDGET_MODULE_SPECS.find((s) => s.id === id);
            if (spec?.advisory) continue;
            const n = Number(row.value);
            // Omit (never pass undefined) — saveBudgetSettings spread-merges
            // per-module patches, and an explicit undefined would clobber the
            // stored value before normalize falls it back to the DEFAULT.
            modules[id] = Number.isFinite(n)
                ? { priority: Math.min(BUDGET_LIMITS.priorityMax, Math.max(BUDGET_LIMITS.priorityMin, Math.round(n))) }
                : {};
        }
        for (const row of root.querySelectorAll('.mwt-budget-soft')) {
            const id = row.dataset.module;
            const spec = BUDGET_MODULE_SPECS.find((s) => s.id === id);
            if (spec?.advisory) continue;
            modules[id] = { ...(modules[id] || {}), softCap: num(`.mwt-budget-soft[data-module="${id}"]`, BUDGET_LIMITS.capMax) };
        }
        for (const row of root.querySelectorAll('.mwt-budget-hard')) {
            const id = row.dataset.module;
            const spec = BUDGET_MODULE_SPECS.find((s) => s.id === id);
            if (spec?.advisory) continue;
            modules[id] = { ...(modules[id] || {}), hardCap: num(`.mwt-budget-hard[data-module="${id}"]`, BUDGET_LIMITS.capMax) };
        }
        const ok = save({
            enforce: root.querySelector('#mwt-budget-enforce')?.checked ?? false,
            globalHardCap: num('#mwt-budget-global-hard', BUDGET_LIMITS.capMax),
            contextLimitOverride: num('#mwt-budget-limit-override', BUDGET_LIMITS.overrideMax),
            modules,
        });
        const message = ok
            ? 'Budget saved for this chat. Caps apply to injections registered AFTER this point — re-apply (toggle a module or trigger a refresh) to enforce on its current payload.'
            : 'Could not save the budget settings — see the console.';
        // A successful save changes every derived surface: enforcement banner,
        // cap summary, row actions, projected summary, drop order, and usage
        // model. Recollect + replace this pane immediately, then bind the new
        // Save button; leaving the old markup made the panel visibly describe
        // its pre-save state until the modal was reopened (TODO §2 P2).
        if (ok) {
            const pane = root.querySelector('.mwt-tab-content[data-tab="budget"]');
            if (pane) {
                pane.innerHTML = renderBudgetPane();
                wireBudgetTab(root, { save, setStatusFn });
            }
        }
        if (typeof setStatusFn === 'function') setStatusFn(root, message, ok ? 'success' : 'error', 8000);
        else if (ok) console.log('[MWT:Budget] Settings saved for this chat.');
    });
}



