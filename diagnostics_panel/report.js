/**
 * diagnostics_panel/report.js — Copy-report shape (Diagnostics Phases 5 + 13).
 *
 * Decision D1 (phases doc §II.2): the report is MARKDOWN with a fenced JSON
 * appendix — paste-friendly in issues *and* machine-parseable. It is built by
 * SERIALIZING THE ACCESSORS, never by scraping panel DOM (Phase 5 goal), so
 * the console bridge and the report can never disagree about what happened.
 *
 * Every section's data routes through the Phase 5 redaction layer
 * (core/redaction.js) before it reaches either the summary lines or the
 * appendix — secrets are redacted in BOTH content modes, and prompt/payload
 * content appears only when the panel's explicit opt-in checkbox is on.
 *
 * Phase 5 defined and wired the SHAPE with the Phase 0–4 accessors. Phase 13
 * finalized it: collectReportSections() now also serializes the tab accessors
 * (health, environment, scope, injection, integrity), so the copied report and
 * the seven sub-tabs can never disagree about what happened.
 *
 * buildReport() is pure (sections are passed in), so it is unit-testable with
 * no SillyTavern runtime (test/diagnostics_report.test.js).
 */

// Direct imports throughout (NOT via core/index.js): the barrel is aliased to
// test/stubs/core.js under Vitest, and the report must read the real
// singletons + version regardless (the barrel→stub alias trap, §II.3).
import { MWT_VERSION } from '../core/version.js';
import { getEvents, getApiCalls, getAllLastRuns, getAllInjectedSnapshots } from '../core/diagnostics.js';
import { getGlobalSettings } from '../core/settings.js';
import { getContextSafe } from '../core/context.js';
import { getEffectiveWorldSetting, GLOBAL_SETTING_KEYS as WS_GLOBAL_SETTING_KEYS } from '../world_state/data.js';
import { getEffectivePlanSetting, GLOBAL_SETTING_KEYS as SP_GLOBAL_SETTING_KEYS } from '../story_planner/data.js';
import { redactForReport } from '../core/redaction.js';

// Phase 13 — the tab accessors, so the report serializes exactly what the
// sub-tabs render (the "same accessors the tabs use" rule, phases doc §II.4
// Phase 13). Sibling diagnostics_panel modules, imported directly like every
// other import here.
//
// NOTE the module cycle this creates: injection.js and integrity.js import
// collectKnownSecrets() from THIS module. It is safe — both sides only
// reference the other's bindings inside function bodies (function declarations
// are hoisted live bindings), never at module-init time — and their own import
// comments state the same. Direct imports throughout, still never the barrel.
import { collectHealthSnapshot } from './health.js';
import { collectEnvironmentSnapshot, loadSharedModule } from './environment.js';
import { collectScopeSnapshot } from './scope_storage.js';
import { collectInjectionSnapshot } from './injection.js';
import { collectIntegritySnapshot } from './integrity.js';

// ─── Header lines ────────────────────────────────────────────────────────────

/**
 * The report header MUST state whether content is included (design §I.6): a
 * reader of a pasted report needs to know what they are looking at, and a
 * tester needs the warning when they opted in.
 *
 * Error bodies follow the content flag (they can quote the chat — see
 * ERROR_KEYS in core/redaction.js), so each line says what happens to them.
 */
const CONTENT_EXCLUDED_LINE =
    '- **Content: EXCLUDED** — prompt bodies, injected payloads, captured notification text, and full error bodies '
    + 'are omitted (errors appear as size-only markers); API keys / URLs are stripped everywhere. '
    + 'Identity strings (character / chat names in scope keys) can still appear — skim it before pasting.';
const CONTENT_INCLUDED_LINE =
    '- **Content: INCLUDED** — ⚠️ this report contains prompt bodies / injected payloads / full error text '
    + '(API keys and URLs are still stripped everywhere). Backend error text can quote your chat — skim it before pasting.';

// ─── Known secret values (for free-text scrubbing) ───────────────────────────

/**
 * Harvest this install's live secret VALUES so the redaction layer can strike
 * them out of free text as well as out of named fields (redaction Rule 1b).
 *
 * The motivating case: `core/api.js` interpolates the resolved endpoint and
 * the upstream error body into its error messages, and those strings reach the
 * report through the event ring and the last-run stamps. A key sitting inside
 * a sentence has no field name to match on — but we know its exact value, and
 * an exact match is the one scrub with no false positives.
 *
 * Every MWT settings namespace is scanned by prefix (`merged_world_tracker`
 * plus the per-module `mwt_*` blobs) rather than from a hardcoded list, so a
 * module added later is covered without touching this function.
 *
 * Fully guarded: no context, no settings, or an exotic settings object all
 * degrade to an empty list — never a thrown report.
 *
 * (Not covered: the localStorage fallback `createSettingsManager` uses when
 * `extensionSettings` is unavailable. In that state `getGlobalSettings()`
 * returns `{}` and the pattern-based scrub is the remaining net.)
 *
 * @returns {string[]} secret values to strike from free text
 */
export function collectKnownSecrets() {
    const out = [];
    try {
        const all = getContextSafe()?.extensionSettings;
        if (!all || typeof all !== 'object') return out;
        for (const ns of Object.keys(all)) {
            if (ns !== 'merged_world_tracker' && !ns.startsWith('mwt_')) continue;
            const blob = all[ns];
            if (!blob || typeof blob !== 'object') continue;
            if (typeof blob.apiKey === 'string') out.push(blob.apiKey);
            // customHeaders is a JSON string of header name → value; the VALUES
            // are what must never resurface inside an error message.
            if (typeof blob.customHeaders === 'string' && blob.customHeaders.trim()) {
                try {
                    const parsed = JSON.parse(blob.customHeaders);
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                        for (const v of Object.values(parsed)) {
                            if (typeof v === 'string') out.push(v);
                        }
                    }
                } catch { /* unparseable — the field itself is redacted wholesale anyway */ }
            }
        }
    } catch { /* diagnostics must never throw on the way to a report */ }
    return out;
}

// ─── Report builder (pure) ───────────────────────────────────────────────────

/**
 * One summary line per section for the Markdown body. Derived from the
 * ALREADY-REDACTED data, so no raw value can leak through a summary.
 * @private
 */
function sectionSummary(data) {
    if (Array.isArray(data)) {
        return `${data.length} entr${data.length === 1 ? 'y' : 'ies'} — see appendix.`;
    }
    if (data !== null && typeof data === 'object') {
        return `${Object.keys(data).length} key(s) — see appendix.`;
    }
    if (typeof data === 'string') {
        return data.length ? `${data.length} chars — see appendix.` : '(empty)';
    }
    return '— see appendix.';
}

/**
 * Build the D1 copy-report: Markdown body + fenced JSON appendix.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.includeContent=false] — the opt-in flag from the
 *        panel's checkbox. Secrets are redacted in EITHER mode; this flag
 *        only decides whether content fields (payloads, prompts) appear.
 * @param {Array<{id: string, title: string, data: *}>} [opts.sections=[]]
 *        — the serialized accessors (see collectReportSections()).
 * @param {string[]} [opts.knownSecrets] — live secret values to strike out of
 *        free text. Defaults to collectKnownSecrets(), so a caller that
 *        forgets still gets the protection; pass `[]` to opt out explicitly.
 * @param {{ mwtVersion?: string, generatedAt?: string }} [opts.meta={}]
 * @returns {{ markdown: string, data: object }} the paste-ready Markdown and
 *          the redacted appendix object it was built from (for tests/preview)
 */
export function buildReport({ includeContent = false, sections = [], meta = {}, knownSecrets } = {}) {
    const generatedAt = meta.generatedAt ?? new Date().toISOString();
    const mwtVersion = meta.mwtVersion ?? MWT_VERSION;
    // Safe by default: collectKnownSecrets() is fully guarded and returns []
    // with no SillyTavern runtime, so this keeps buildReport() unit-testable.
    const secrets = knownSecrets ?? collectKnownSecrets();

    // Redact FIRST; everything below (summary lines, appendix) is derived
    // from the already-redacted data so no raw value can reach the Markdown.
    const redactedSections = sections.map(s => ({
        ...s,
        data: redactForReport(s.data, { includeContent, knownSecrets: secrets }),
    }));

    const appendix = {
        meta: {
            report: 'mwt-diagnostics',
            mwtVersion,
            generatedAt,
            includeContent,
            redaction: 'apiKey / customHeaders / apiUrl are redacted unconditionally, and every string is '
                + 'scrubbed for embedded URLs and key-shaped tokens; '
                + (includeContent ? 'content fields INCLUDED (explicit opt-in)' : 'content fields excluded (opt-in off)'),
        },
        sections: {},
    };
    for (const s of redactedSections) appendix.sections[s.id] = s.data;

    const lines = [];
    lines.push('# MWT Diagnostics Report');
    lines.push('');
    lines.push(`- **MWT version:** ${mwtVersion}`);
    lines.push(`- **Generated:** ${generatedAt}`);
    lines.push(includeContent ? CONTENT_INCLUDED_LINE : CONTENT_EXCLUDED_LINE);
    lines.push('');
    for (const s of redactedSections) {
        lines.push(`## ${s.title}`);
        lines.push('');
        lines.push(sectionSummary(s.data));
        lines.push('');
    }

    lines.push('## Appendix — full JSON');
    lines.push('');
    const serialized = JSON.stringify(appendix, null, 2);
    // A payload containing '```' would close a 3-backtick fence early and
    // spill the rest of the appendix out of the code block. Fence length =
    // longest backtick run inside the serialized JSON + 1 (minimum 3) — the
    // fence can then only be closed by us.
    const longestRun = (serialized.match(/`+/g) || []).reduce((max, run) => Math.max(max, run.length), 0);
    const fence = '`'.repeat(Math.max(3, longestRun + 1));
    lines.push(`${fence}json`);
    lines.push(serialized);
    lines.push(fence);
    lines.push('');

    return { markdown: lines.join('\n'), data: appendix };
}

// ─── Section collectors (live accessors) ─────────────────────────────────────

/**
 * Serialize the Phase 0–4 accessors AND the tab accessors into report sections
 * — the same data the MWT.diagnostics console bridge shows and the sub-tabs
 * render, so a pasted report, a console dump, and the panel can never
 * disagree. Each collector is guarded: one that throws (sync or async)
 * degrades to an error note in its section, never a broken report.
 *
 * ASYNC since Phase 13: the Integrity section's collect is an async lorebook
 * read, and the Environment section awaits the shared.js probe up front (the
 * exact `MWT.diagnostics.environment()` shape — a report and a console dump of
 * the same session must state the same CMRS verdict).
 *
 * Scope notes (phases doc §II.4 Phase 13 / §0):
 *  - The 📡 Last request and 📋 Log tabs get NO section of their own: their
 *    stores are already serialized as `apiCalls` (Phase 1) and `events`
 *    (Phase 0). Their snapshots only ADD derived digest lines (window stats,
 *    counts, warnings) over those same rows — a report reader loses no data.
 *  - Integrity is the one O(entries) section (design §I.6 scale note). It runs
 *    here because every caller of this function is an explicit user action —
 *    the 📋 Copy Report button or `MWT.diagnostics.report()` — which is
 *    exactly the Phase 12 "on demand only" trigger; it never runs on tab/modal
 *    open and is never a render loop. One press = one collect.
 *
 * @returns {Promise<Array<{id: string, title: string, data: *}>>}
 */
export async function collectReportSections() {
    // guarded() is async (Integrity's collect awaits a lorebook read), so the
    // array below is one of PROMISES until Promise.all resolves it.
    const guarded = async (id, title, collect) => {
        try {
            return { id, title, data: await collect() };
        } catch (err) {
            return { id, title, data: { collectionError: String(err?.message || err) } };
        }
    };

    return Promise.all([
        guarded('settings', 'Global settings (secrets redacted)', () => getGlobalSettings()),

        // Mirrors MWT.diagnostics.settingsProvenance() (index.js), including
        // the module-only asymmetry rows — that asymmetry is itself diagnostic.
        guarded('settingsProvenance', 'Settings provenance (Phase 4)', () => {
            const worldState = {};
            for (const key of WS_GLOBAL_SETTING_KEYS) {
                worldState[key] = getEffectiveWorldSetting(key, undefined, { provenance: true });
            }
            const storyPlanner = {};
            for (const key of SP_GLOBAL_SETTING_KEYS) {
                storyPlanner[key] = getEffectivePlanSetting(key, undefined, { provenance: true });
            }
            return {
                world_state: { settingsScope: 'global-with-per-chat-override', keys: worldState },
                story_planner: { settingsScope: 'global-with-per-chat-override', keys: storyPlanner },
                chronicle: { settingsScope: 'module-only' },
                knowledge: { settingsScope: 'module-only' },
                interiority: { settingsScope: 'module-only' },
            };
        }),

        guarded('lastRuns', 'Last run per module (Phase 0)', () => getAllLastRuns()),
        guarded('apiCalls', 'API calls (Phase 1 — telemetry only)', () => getApiCalls()),
        guarded('events', 'Event log (Phase 0 — newest first)', () => getEvents()),

        // Payloads in this section are content: they appear only when the
        // opt-in is on, because redactForReport() gates the `payload` field.
        guarded('injections', 'Injected payloads (Phase 2 — content-gated)', () => getAllInjectedSnapshots()),

        // ── Phase 13 — the tab accessors, in sub-tab order ──────────────────
        guarded('health', 'Health (Phase 6 — one row per module)', () => collectHealthSnapshot()),

        guarded('environment', 'Environment (Phase 7 — fork-compat probe)', async () =>
            collectEnvironmentSnapshot({ sharedModule: await loadSharedModule() })),

        guarded('scope', 'Scope & storage (Phase 8 — which lorebooks, and why)', () => collectScopeSnapshot()),

        // The Phase 9 snapshot carries each module's recorded payload under
        // `modules[].snapshot.payload` — a CONTENT_KEY, so the panel's opt-in
        // gates it here exactly like it gates the `injections` section above.
        guarded('injection', 'Injection status (Phase 9 — content-gated)', () => collectInjectionSnapshot()),

        guarded('integrity', 'Integrity (Phase 12 — on-demand checks)', () => collectIntegritySnapshot()),
    ]);
}

