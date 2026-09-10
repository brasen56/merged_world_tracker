/**
 * @vitest-environment jsdom
 *
 * Accessibility plan Slice 4 (§5 Slice 4 / §6.4) — the accessible-name sweep.
 *
 * Behavioral checks under jsdom for the two pieces with runtime behavior:
 * the floating button bar (divs, so role/tab stop/name/keyboard activation
 * are all explicit) and renderApiSettingsFields (the one settings renderer
 * every module panel reuses — its for/id fix lands everywhere at once).
 *
 * The renderer sweep itself is a markup contract, so the bulk of this file
 * follows the read-the-source precedent of test/main_tabbar_adoption.test.js
 * (Vite `?raw` imports; node builtins are externalized under jsdom): a small
 * scanner walks every <button> in the swept sources and fails on any whose
 * entire visible label is an emoji or lone symbol with no aria-label — the
 * §6.4 "icon-only controls have accessible names" contract — plus focused
 * assertions for the state-dependent (template-literal) buttons, the sr-only
 * text that replaced color/emoji-only indicators, and the label associations
 * the sweep added.
 *
 * Not claimed here (§6.5, manual QA): how a real screen reader pronounces any
 * of this, and :focus-visible rendering.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createFloatingButtonBar, renderApiSettingsFields } from '../core/ui.js';
// The Budget pane renderer, for its DOM-level contract below (the pane the
// a11y plan's source inventory missed — BUG scope miss filed mid-Slice 4).
import { renderBudgetSnapshot } from '../budget/panel.js';
// Renderers as source text — see the file header (main_tabbar_adoption
// precedent). knowledge/settings.js is swept with knowledge/render.js: the
// settings cog panel renders from it.
import interioritySource from '../interiority/render.js?raw';
import knowledgeSource from '../knowledge/render.js?raw';
import knowledgeSettingsSource from '../knowledge/settings.js?raw';
import storyPlannerSource from '../story_planner/render.js?raw';
import worldStateSource from '../world_state/render.js?raw';
import backupSource from '../backup/render.js?raw';
import chronicleSource from '../chronicle/render.js?raw';
import diagnosticsSource from '../diagnostics_panel/render.js?raw';
import budgetPanelSource from '../budget/panel.js?raw';
import schemaStatusSource from '../core/schema_status.js?raw';
import uiSource from '../core/ui.js?raw';
import indexSource from '../index.js?raw';

const SOURCES = {
    'interiority/render.js': interioritySource,
    'knowledge/render.js': knowledgeSource,
    'knowledge/settings.js': knowledgeSettingsSource,
    'story_planner/render.js': storyPlannerSource,
    'world_state/render.js': worldStateSource,
    'backup/render.js': backupSource,
    'chronicle/render.js': chronicleSource,
    'diagnostics_panel/render.js': diagnosticsSource,
    'core/schema_status.js': schemaStatusSource,
    'core/ui.js': uiSource,
    'index.js': indexSource,
    'budget/panel.js': budgetPanelSource,
};

// ─── Source scanner: icon-only buttons must carry aria-label (§6.4) ──────────

const stripLineComments = (s) => s.replace(/^[ \t]*\/\/.*$/gm, '');
const stripBlockComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
// Template placeholders (${…}) are resolved at runtime; a button whose label
// is a template expression is checked by the focused assertions below instead
// (the scanner cannot evaluate them).
const stripTemplates = (s) => s.replace(/\$\{[^}]*\}/g, '');

/** Emoji (incl. ZWJ sequences / variation selectors) or a lone UI symbol. */
const ICON_ONLY_RE = /^(?:[\p{Extended_Pictographic}\u{FE0F}\u{200D}]|[✔✕✎↺↻⏰✓✗✖✏●])+$/u;

/**
 * Every <button>…</button> in the source whose visible label reduces to a
 * glyph (after dropping nested tags and whitespace) but whose opening tag
 * carries no aria-label. Buttons whose label is produced by a template
 * expression are skipped — their runtime text cannot be evaluated from
 * source, so the state-dependent ones are pinned by the focused assertions
 * below instead.
 */
function unnamedIconOnlyButtons(src) {
    const clean = stripBlockComments(stripLineComments(src));
    const out = [];
    const re = /<button\b[^>]*>([\s\S]*?)<\/button>/g;
    let m;
    while ((m = re.exec(clean))) {
        const open = m[0].slice(0, m[0].indexOf('>') + 1);
        if (/aria-label\s*=/.test(open)) continue;
        const rawBody = m[1];
        if (rawBody.includes('${')) continue; // dynamic label — see doc comment
        const body = stripTemplates(rawBody).replace(/<[^>]*>/g, '').trim();
        if (body === '' || ICON_ONLY_RE.test(body)) out.push(open + '…</button>');
    }
    return out;
}

// ─── Focused assertions for state-dependent (template) icon buttons ─────────

describe('state-dependent icon buttons carry names', () => {
    test('interiority: every icon-only action line carries aria-label', () => {
        // All ten classes are only ever used on icon-only buttons, so every
        // markup line that opens one of them must name it.
        const classes = [
            'mwt-int-done-btn', 'mwt-int-dismiss-btn', 'mwt-int-sleep-btn',
            'mwt-int-edit-btn', 'mwt-int-remove-btn', 'mwt-int-wake-btn',
            'mwt-int-reopen-btn', 'mwt-int-state-edit-btn', 'mwt-int-state-remove-btn',
            'mwt-int-ctl-remove-btn',
        ];
        for (const cls of classes) {
            const lines = interioritySource.split('\n').filter(l => l.includes('<button') && l.includes(`class="${cls}`));
            expect(lines.length, `${cls} markup lines`).toBeGreaterThan(0);
            for (const line of lines) expect(line, cls).toMatch(/aria-label=/);
        }
    });

    test('knowledge: growth, identity, stance, and relationship icon buttons carry names', () => {
        expect(knowledgeSource).toContain('aria-label="Delete observation"');
        expect(knowledgeSource).toContain('aria-label="Delete consolidated claim"');
        expect(knowledgeSource).toContain('aria-label="Delete user note"');
        expect(knowledgeSource).toContain('aria-label="Remove alias ${escapeHtml(a)}"');
        expect(knowledgeSource).toContain('aria-label="Clear stance of ${escapeHtml(n)}"');
        expect(knowledgeSource).toContain('aria-label="Remove relationship ${escapeHtml(e.from)} to ${escapeHtml(e.to)}"');
        // Lock buttons: a state-dependent name mirroring the state-dependent title.
        expect(knowledgeSource).toMatch(/kt-stance-lock[^>]*aria-label=/);
        expect(knowledgeSource).toMatch(/kt-rel-lock[^>]*aria-label=/);
    });

    test('lock names describe the action, not the state (both are toggles)', () => {
        // Regression: the names first shipped as "Lock … (currently locked)",
        // which tells a screen-reader user the press will lock something
        // already locked. Both buttons toggle (toggleEdgeSource /
        // toggleStanceSource), so the locked branch must read "Unlock". The
        // state still reaches AT through the title, which stays in place.
        for (const [what, name] of [['stance', 'stanceName'], ['relationship', 'lockName']]) {
            const branch = knowledgeSource.match(new RegExp(`const ${name} = locked[\\s\\S]{0,400}?;`));
            expect(branch, `${name} ternary`).not.toBeNull();
            const [lockedArm, autoArm] = branch[0].split(': `');
            expect(lockedArm, `${what} locked arm`).toContain('Unlock');
            expect(autoArm, `${what} auto-managed arm`).toMatch(/^Lock /);
        }
    });

    test('knowledge: settings cog and notification bell are named', () => {
        expect(knowledgeSource).toContain('id="kt-cog-btn" title="Settings" aria-label="Settings"');
        expect(knowledgeSource).toMatch(/id="kt-notif-btn" aria-label="Notifications/);
        // The view-modal shell close is refined by decorateModalShell at wire
        // time; the static markup still carries a name of its own.
        expect(knowledgeSource).toContain('class="kt-history-close" aria-label="Close"');
    });

    test('story_planner: pin, delete, and icon-only beat-back carry names', () => {
        expect(storyPlannerSource).toMatch(/class="sp-pin"[^>]*aria-label=/);
        expect(storyPlannerSource).toMatch(/class="sp-arc-del"[^>]*aria-label=/);
        expect(storyPlannerSource).toContain('title="Go back a beat" aria-label="Go back a beat">↺');
    });
});

// ─── Decorative emoji hidden from assistive technology (Slice 4 item 2) ───────

describe('decorative emoji are aria-hidden', () => {
    test('interiority headings and emoji-led buttons wrap the glyph', () => {
        for (const label of ['Active Intentions', 'Scheduled Intentions', 'Inner States', 'Per-NPC Controls', 'Lifecycle History', 'Recent Thoughts', 'Clear Ledger', 'Add Intention', 'Generate Now']) {
            expect(interioritySource, label).toMatch(new RegExp(`<span aria-hidden="true">[^<]+</span>[^\\n]*${label}`));
        }
    });

    test('knowledge toolbar, sub-tabs, and section titles wrap the glyph', () => {
        for (const label of ['Staging', 'Minor', 'Major', 'Relationships', 'Export', 'Import', 'From Lorebooks', 'Graph</button>', 'List</button>', 'Recent Changes', 'Growth Profile']) {
            expect(knowledgeSource, label).toMatch(new RegExp(`<span aria-hidden="true">[^<]+</span>[^\\n]*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
        }
    });

    test('world_state / story_planner / backup / chronicle toolbars wrap the glyph', () => {
        expect(worldStateSource).toContain('<span aria-hidden="true">🔄</span> Refresh');
        expect(storyPlannerSource).toContain('<span aria-hidden="true">🎲</span> Generate Plan');
        expect(backupSource).toContain('<span aria-hidden="true">⬇</span> Export Backup');
        expect(chronicleSource).toContain('<span aria-hidden="true">📊</span> Stats');
        expect(schemaStatusSource).toContain('<span aria-hidden="true">↻</span> Retry');
    });
});

// ─── JS label writes keep the hidden span (post-interaction state) ───────────

/**
 * Every `x.textContent = '…'` label write whose replacement text embeds an
 * emoji. The markup sweeps above cannot see these: they run after render and
 * erase the aria-hidden span the initial markup had, folding the decorative
 * glyph back into the accessible name on the first settings change or busy
 * cycle. story_planner and world_state rebuild such labels through innerHTML
 * with the hidden span instead. (The knowledge and diagnostics renderers
 * follow the older restore-through-innerHTML convention while their transient
 * ⏳ busy labels stay textContent; they are not swept here.)
 */
function emojiTextContentWrites(src) {
    const clean = stripBlockComments(stripLineComments(src));
    const out = [];
    const re = /\.textContent\s*=\s*([^;\n]+)/g;
    let m;
    while ((m = re.exec(clean))) {
        if (/[\p{Extended_Pictographic}\u{FE0F}]/u.test(m[1])) out.push(m[0].trim());
    }
    return out;
}

describe('JS-updated labels keep decorative icons hidden (Slice 4 item 2)', () => {
    test('story_planner: no textContent label write embeds a raw emoji', () => {
        expect(emojiTextContentWrites(storyPlannerSource)).toEqual([]);
    });

    test('world_state: no textContent label write embeds a raw emoji', () => {
        expect(emojiTextContentWrites(worldStateSource)).toEqual([]);
    });

    test('story_planner: toggle labels exist with the hidden span in BOTH the markup and the update path', () => {
        // Two occurrences each: the render() markup and the refreshButtonLabels
        // rewrite (plus the busy/reset restores below). If one side regresses
        // to a raw emoji the count drops and this fails.
        expect(storyPlannerSource.match(/<span aria-hidden="true">🔌<\/span> Injection: ON/g)?.length).toBe(2);
        expect(storyPlannerSource.match(/<span aria-hidden="true">🔄<\/span> Auto: ON \(/g)?.length).toBe(2);
        expect(storyPlannerSource).toContain(`btn.innerHTML = '<span aria-hidden="true">🎲</span> Generate Plan';`);
        expect(storyPlannerSource).toContain(`el.innerHTML = \`<span aria-hidden="true">🔄</span> Auto-generate: ON`);
    });

    test('world_state: toggle labels and the three resets rebuild with the hidden span', () => {
        expect(worldStateSource.match(/<span aria-hidden="true">🔌<\/span> Injection: ON/g)?.length).toBe(2);
        expect(worldStateSource.match(/<span aria-hidden="true">🔄<\/span> Auto: OFF/g)?.length).toBe(2);
        expect(worldStateSource).toContain(`btn.innerHTML = '<span aria-hidden="true">🔄</span> Refresh';`);
        expect(worldStateSource).toContain(`btn.innerHTML = '<span aria-hidden="true">⚡</span> Delta';`);
        expect(worldStateSource).toContain(`regenBtn.innerHTML = '<span aria-hidden="true">🎲</span> Regenerate Section';`);
        // The doc-status chip's emoji duplicates its visible label + color, so
        // it stays decorative on every rewrite too.
        expect(worldStateSource).toContain('chip.innerHTML = `<span aria-hidden="true">${presentation.emoji}</span> ${escapeHtml(presentation.label)}`;');
    });
});

// ─── Source scanner: icon-only buttons must carry aria-label (§6.4) ──────────

describe('icon-only buttons have accessible names (§6.4)', () => {
    for (const [file, src] of Object.entries(SOURCES)) {
        test(`${file}: no icon-only button without aria-label`, () => {
            expect(unnamedIconOnlyButtons(src)).toEqual([]);
        });
    }
});

// ─── Label associations on form controls (Slice 4 item 4) ────────────────────

describe('renderApiSettingsFields associates every label with its control', () => {
    test('each label[for] targets an input/select/textarea in the same fragment', () => {
        const holder = document.createElement('div');
        holder.innerHTML = renderApiSettingsFields({}, {
            urlId: 't-url', keyId: 't-key', modelId: 't-model',
            maxTokensId: 't-max', tempId: 't-temp', topPId: 't-topp',
            freqId: 't-freq', presId: 't-pres', headersId: 't-headers',
        });
        const labels = [...holder.querySelectorAll('label[for]')];
        // All nine fields (advanced + headers included by default).
        expect(labels.length).toBe(9);
        for (const label of labels) {
            const control = holder.querySelector(`#${label.getAttribute('for')}`);
            expect(control, `label "${label.textContent}" → #${label.getAttribute('for')}`).not.toBeNull();
            expect(['INPUT', 'TEXTAREA', 'SELECT']).toContain(control.tagName);
        }
        // And no id-less labels are left over.
        expect(holder.querySelectorAll('label:not([for])')).toHaveLength(0);
    });

    test('custom id maps keep working (module settings pass their own ids)', () => {
        const holder = document.createElement('div');
        holder.innerHTML = renderApiSettingsFields({}, {
            urlId: 'kt-cfg-api-url', keyId: 'kt-cfg-api-key', modelId: 'kt-cfg-model',
            maxTokensId: 'kt-cfg-max-tokens', tempId: 'kt-cfg-temp', topPId: 'kt-cfg-top-p',
            freqId: 'kt-cfg-freq-pen', presId: 'kt-cfg-pres-pen', headersId: 'kt-cfg-headers',
        });
        expect(holder.querySelector('label[for="kt-cfg-api-url"]')).not.toBeNull();
        expect(holder.querySelector('#kt-cfg-api-url')).not.toBeNull();
    });
});

describe('swept renderers associate their own controls', () => {
    test('interiority edit form: label[for] ↔ id per entry', () => {
        for (const field of ['npc', 'action', 'trigger', 'priority', 'expireson', 'expiresturn', 'wakehint']) {
            expect(interioritySource).toContain(`for="mwt-int-edit-${field}-`);
        }
    });

    test('interiority settings dials associate their wrapped inputs', () => {
        const ids = ['mwt-int-thoughts-interval', 'mwt-int-max-npcs', 'mwt-int-window', 'mwt-int-grace',
            'mwt-int-max-new', 'mwt-int-dormant-poll', 'mwt-int-dedup-turns', 'mwt-int-max-turns',
            'mwt-int-mode', 'mwt-int-thoughts-profile'];
        for (const id of ids) expect(interioritySource).toContain(`for="${id}"`);
    });

    test('knowledge settings and relationship add-rows label their controls', () => {
        const ids = ['kt-cfg-scope', 'kt-cfg-state-scope', 'kt-cfg-auto-every', 'kt-cfg-cooldown',
            'kt-cfg-npc-every', 'kt-cfg-growth-every', 'kt-cfg-rel-every', 'kt-stance-npc'];
        for (const id of ids) expect(`${knowledgeSettingsSource}\n${knowledgeSource}`).toContain(`for="${id}"`);
        expect(knowledgeSource).toContain('aria-label="Relationship from (NPC)"');
        expect(knowledgeSource).toContain('aria-label="Relationship type"');
        expect(knowledgeSource).toContain('aria-label="Relationship to (NPC)"');
        expect(knowledgeSource).toContain('aria-label="Stance value"');
    });

    test('knowledge staging detail labels point at the editor and keyword input', () => {
        expect(knowledgeSource).toContain('<label class="kt-detail-label" for="kt-proposal-editor">Proposed</label>');
        expect(knowledgeSource).toContain('<label class="kt-detail-label" for="kt-keyword-input">Keywords</label>');
    });

    test('knowledge state-tracker register fields and identity inputs carry labels', () => {
        // The register row and the identity modal rows are compact flex rows
        // whose meaning lived only in disappearing placeholders; each control
        // now has an sr-only label[for] naming it (Slice 4 item 4).
        for (const id of ['kt-state-uid', 'kt-state-name', 'kt-alias-input', 'kt-rename-input', 'kt-merge-input']) {
            expect(knowledgeSource).toContain(`<label class="mwt-sr-only" for="${id}">`);
            expect(knowledgeSource).toContain(`id="${id}"`);
        }
    });

    test('knowledge growth textareas are named by their visible section headings', () => {
        expect(knowledgeSource).toContain('id="kt-growth-profile-label"');
        expect(knowledgeSource).toContain('aria-labelledby="kt-growth-profile-label"');
        expect(knowledgeSource).toContain('id="kt-growth-psychoanalyze-label"');
        expect(knowledgeSource).toContain('aria-labelledby="kt-growth-psychoanalyze-label"');
    });

    test('knowledge repeated checkbox rows keep unique for/id pairs (name- and key-suffixed)', () => {
        // Per-tracker Auto/Always toggles and the dossier field picker render
        // one row per entry; both sides of each pair share the loop variable
        // so no row's label can point at another row's control.
        expect(knowledgeSource).toContain('for="kt-state-enabled-${escapeHtml(name)}"');
        expect(knowledgeSource).toContain('id="kt-state-enabled-${escapeHtml(name)}"');
        expect(knowledgeSource).toContain('for="kt-state-always-${escapeHtml(name)}"');
        expect(knowledgeSource).toContain('id="kt-state-always-${escapeHtml(name)}"');
        expect(knowledgeSource).toContain('for="kt-dfr-field-${escapeHtml(r.key)}"');
        expect(knowledgeSource).toContain('id="kt-dfr-field-${escapeHtml(r.key)}"');
    });

    test('world_state settings labels associate their controls', () => {
        const ids = ['ws-variety-slider', 'ws-expiry-stale-after', 'ws-expiry-mode', 'ws-injection-depth', 'ws-auto-save-interval', 'ws-custom-prompt'];
        for (const id of ids) expect(worldStateSource).toContain(`for="${id}"`);
    });

    test('story_planner settings labels associate their controls', () => {
        expect(storyPlannerSource).toContain('for="sp-injection-depth"');
        expect(storyPlannerSource).toContain('for="sp-custom-system-prompt"');
    });
});

// ─── Source scanner: explicit associations in the re-swept forms ──────────────
// The Slice 4 sweep had left implicit-nesting labels behind in the backup,
// chronicle, world_state, and interiority renderers (restore options,
// injection/filter settings, expiry/grounding/delta settings, per-NPC controls,
// and the settings checkboxes). Unlike the spot checks above, these scans walk
// every <label> in those sources, so a regression anywhere in the affected
// forms fails rather than only the selected controls.
//
// index.js, story_planner/render.js and knowledge/settings.js joined the map
// after review: the spot checks above passed on each of them while the global
// Settings tab still held 38 unassociated labels (19 of them <label>s wrapping
// no control at all) and the other two held nine each. A per-file scan is what
// catches that; a list of hand-picked ids is not.
//
// knowledge/render.js joined last, for the same reason: its register-row and
// identity-modal inputs were placeholder-only, and its per-tracker / dossier
// picker rows used implicit nesting. The scan now walks every <label> there.

/** Every <label …> opening tag without for= — implicit nesting is not enough. */
function labelsMissingFor(src) {
    const clean = stripBlockComments(stripLineComments(src));
    const out = [];
    const re = /<label\b[^>]*>/g;
    let m;
    while ((m = re.exec(clean))) {
        if (!/\bfor\s*=/.test(m[0])) out.push(m[0]);
    }
    return out;
}

/**
 * Every for="X" whose id="X" is absent from the same source. X may embed a
 * ${…} placeholder — generated controls then require the identical template
 * on the id, so a static scan still proves the pair matches. Ids built by a
 * helper (renderConnectionProfileSelect) resolve via the 'X' string literal
 * the caller passes.
 */
function danglingLabelFors(src) {
    const clean = stripBlockComments(stripLineComments(src));
    const out = [];
    const seen = new Set();
    const re = /\bfor\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(clean))) {
        const ref = m[1];
        if (seen.has(ref)) continue;
        seen.add(ref);
        if (!clean.includes(`id="${ref}"`) && !clean.includes(`'${ref}'`)) out.push(ref);
    }
    return out;
}

const RESWEPT_SOURCES = {
    'backup/render.js': backupSource,
    'chronicle/render.js': chronicleSource,
    'world_state/render.js': worldStateSource,
    'interiority/render.js': interioritySource,
    'index.js': indexSource,
    'story_planner/render.js': storyPlannerSource,
    'knowledge/settings.js': knowledgeSettingsSource,
    'knowledge/render.js': knowledgeSource,
    'budget/panel.js': budgetPanelSource,
};

describe('re-swept forms associate every label explicitly (Slice 4 item 4)', () => {
    for (const [file, src] of Object.entries(RESWEPT_SOURCES)) {
        test(`${file}: every <label> carries for=`, () => {
            expect(labelsMissingFor(src), file).toEqual([]);
        });

        test(`${file}: every for= resolves to an id in the same source`, () => {
            expect(danglingLabelFors(src), file).toEqual([]);
        });
    }

    test('the inner-state edit form does not reuse one fixed field id', () => {
        // Opening a second inner-state editor does not close the first (same
        // as the ledger's edit form), so a literal id="mwt-int-state-edit-line"
        // would put two of them in the DOM and point the second NPC's
        // label[for] at the first NPC's input. Both sides take the counter.
        expect(interioritySource).not.toContain('id="mwt-int-state-edit-line"');
        expect(interioritySource).toContain('const lineId = `mwt-int-state-edit-line-${innerStateEditSeq++}`');
        expect(interioritySource).toContain('<label class="mwt-label" for="${lineId}">');
        expect(interioritySource).toContain('<input type="text" id="${lineId}"');
    });

    test('index.js settings grid: section headers are not empty labels', () => {
        // A <label> that wraps no control and carries no for= is not a label.
        // The four injection-settings group headers and the two world_state-
        // style cell headers are <div class="mwt-label"> instead.
        for (const header of ['World State', 'Chronicle', 'Interiority', 'Structural Boundaries']) {
            expect(indexSource, header).toContain(
                `<div class="mwt-label" style="grid-column:1/3;font-weight:bold"><span aria-hidden="true">`,
            );
            expect(indexSource, header).toMatch(new RegExp(`<div class="mwt-label"[^>]*>[^<]*<span aria-hidden="true">[^<]+</span> ${header}</div>`));
        }
    });

    test('index.js float-button and per-tracker rows name their checkbox', () => {
        // Both cells label the row's checkbox, so its name carries the module
        // rather than being one of six identical "Visible"s.
        for (const cid of ['mwt-s-show-world', 'mwt-s-show-chronicle', 'mwt-s-show-knowledge',
            'mwt-s-show-story-planner', 'mwt-s-show-interiority', 'mwt-s-show-settings',
            'mwt-s-enable-world', 'mwt-s-enable-chronicle', 'mwt-s-enable-knowledge',
            'mwt-s-enable-story-planner', 'mwt-s-enable-interiority']) {
            expect(indexSource.match(new RegExp(`for="${cid}"`, 'g'))?.length, cid).toBe(2);
        }
    });

    test('index.js injection depth/role controls are labelled', () => {
        for (const pre of ['ws', 'ch', 'int']) {
            expect(indexSource).toContain(`<label class="mwt-label" for="mwt-s-${pre}-depth">Depth</label>`);
            expect(indexSource).toContain(`<label class="mwt-label" for="mwt-s-${pre}-role">Role</label>`);
        }
    });

    test('generated controls keep unique for/id pairs (index-suffixed templates)', () => {
        // Repeated controls: per-snapshot chronicle checkboxes and per-section
        // world_state checkboxes use the same ${i} on both sides of the pair.
        expect(chronicleSource).toContain('for="sc-inject-select-${i}"');
        expect(chronicleSource).toContain('id="sc-inject-select-${i}"');
        expect(worldStateSource).toContain('for="ws-expiry-section-${i}"');
        expect(worldStateSource).toContain('id="ws-expiry-section-${i}"');
        // Per-NPC interiority dials: both sides share the row ${uid}.
        expect(interioritySource.match(/for="mwt-int-ctl-(?:privacy|pause|cooldown|cap)\$\{uid\}"/g)?.length).toBe(4);
        expect(interioritySource.match(/id="mwt-int-ctl-(?:privacy|pause|cooldown|cap)\$\{uid\}"/g)?.length).toBe(4);
    });
});

// ─── Title triage (Slice 4 item 3): no meaning trapped in tooltips ────────────

describe('tooltip-only explanations became visible help text', () => {
    test('interiority Closure Dedup / Max Turns Open have visible help paragraphs', () => {
        expect(interioritySource).toContain('Closure Dedup: how recent (in turns)');
        expect(interioritySource).toContain('Max Turns Open: engine-authored intentions');
    });

    test('interiority edit form explains Priority and the two expiry fields inline', () => {
        expect(interioritySource).toContain('class="mwt-int-edit-help">User-set urgency.');
        expect(interioritySource).toContain('class="mwt-int-edit-help">In-world expiry:');
        expect(interioritySource).toContain('class="mwt-int-edit-help">Generation-turn expiry override');
    });

    test('interiority settings labels no longer duplicate the visible help as titles', () => {
        expect(interioritySource).not.toContain('title="Minimum turns an intention must survive');
        expect(interioritySource).not.toContain('title="Maximum accepted new intentions');
    });

    test('interiority per-NPC controls: four help snippets rendered once, one per dial (Slice 4 item 3)', () => {
        // The privacy / pause new / cooldown / cap explanations moved from
        // title-only tooltips to persistent help — first as one combined
        // paragraph per row, with every dial's aria-describedby pointing at
        // the whole thing (each control announced all four explanations, one
        // full paragraph per NPC). They are now four snippets rendered ONCE
        // under the list, each dial referencing only its own.
        expect(interioritySource).toContain('class="mwt-int-ctl-help-group"');
        expect(interioritySource).toContain("privacy: never send this NPC's dossier");
        expect(interioritySource).toContain('pause new: block NEW engine proposals');
        expect(interioritySource).toContain('cooldown: after an accepted proposal');
        expect(interioritySource).toContain('cap: max ACTIVE engine-authored intentions');
        // Each snippet id renders exactly once (after the list, not per row),
        // and exactly one control template references each snippet.
        for (const dial of ['privacy', 'pause', 'cooldown', 'cap']) {
            expect(interioritySource.match(new RegExp(`id="mwt-int-ctl-help-${dial}"`, 'g'))?.length, dial).toBe(1);
            expect(interioritySource.match(new RegExp(`aria-describedby="mwt-int-ctl-help-${dial}"`, 'g'))?.length, dial).toBe(1);
        }
        // The per-row whole-paragraph pattern is gone.
        expect(interioritySource).not.toContain('aria-describedby="${helpId}"');
        expect(interioritySource).not.toContain('const helpId');
    });

    test('interiority per-NPC control rows are fieldsets named by the NPC', () => {
        // The fieldset gives every dial in the row its NPC context without
        // repeating the NPC name in each label. The name is referenced by
        // aria-labelledby rather than held in a <legend>: a rendered legend
        // takes no part in the fieldset's flex layout, so it stacked above
        // the dials instead of sitting opposite them (34px → 50px per row).
        expect(interioritySource).toContain('<fieldset class="mwt-int-controls-row"');
        expect(interioritySource).toContain('aria-labelledby="mwt-int-ctl-npc${uid}"');
        expect(interioritySource).toContain('<div class="mwt-int-ledger-entry-main" id="mwt-int-ctl-npc${uid}">');
        expect(interioritySource).toContain('<span class="mwt-int-ledger-npc">${escapeHtml(npcKey)}</span>');
        // Markup only — the comment above the template explains why there is
        // no legend, so the raw source still mentions the tag.
        expect(stripLineComments(stripBlockComments(interioritySource))).not.toContain('<legend');
        // Boundary-only rows carry no controls and stay plain divs — the same
        // name line and the same flex row, so the two shapes still match.
        expect(interioritySource).toContain('mwt-int-controls-row--readonly');
    });

    test('interiority per-NPC control labels no longer carry the explanations as titles', () => {
        expect(interioritySource).not.toContain("title=\"Never send this NPC's dossier");
        expect(interioritySource).not.toContain('title="Block NEW engine proposals');
        expect(interioritySource).not.toContain('title="After an accepted proposal');
        expect(interioritySource).not.toContain('title="Max ACTIVE engine-authored intentions');
    });

    test('story_planner inject modes render their blurbs persistently, not as titles', () => {
        // All / Pinned / Active differed only in a title tooltip on the label,
        // invisible to keyboard, touch, and many screen-reader users. The
        // descriptions now live in one visible help line under the mode row,
        // built from INJECT_MODES so it cannot drift from data.js, and every
        // radio references it via aria-describedby (three modes → three refs).
        expect(storyPlannerSource).toContain('id="sp-inject-mode-help"');
        expect(storyPlannerSource).not.toContain('title="${escapeHtml(m.blurb)}"');
        // The radios come from one INJECT_MODES.map() template, so the source
        // holds a single aria-describedby that renders once per mode (three
        // modes in data.js); it must sit on the radio input itself.
        expect(storyPlannerSource.match(/aria-describedby="sp-inject-mode-help"/g)?.length).toBe(1);
        expect(storyPlannerSource).toContain('<input type="radio" id="sp-inject-mode-${m.key}" name="sp-inject-mode" value="${m.key}" aria-describedby="sp-inject-mode-help"');
        expect(storyPlannerSource).toContain('INJECT_MODES.map(m => `<strong>${escapeHtml(m.label)}:</strong> ${escapeHtml(m.blurb)}`).join(\' · \')');
    });

    test('budget: the column explanations render visibly under the table, not as th titles', () => {
        // Priority / Estimated tokens / Budget action / Soft cap / Hard cap
        // meanings — cap behavior and the modeled action among them — were
        // tooltip-only on the <th>s; they are now a visible help block whose
        // ids the headers and every per-module input reference via
        // aria-describedby.
        for (const id of ['priority', 'tokens', 'action', 'soft', 'hard']) {
            expect(budgetPanelSource, id).toContain(`id="mwt-budget-help-${id}"`);
            expect(budgetPanelSource, id).toContain(`aria-describedby="mwt-budget-help-${id}"`);
        }
        expect(budgetPanelSource).not.toMatch(/<th[^>]*\stitle=/);
        // The modeled action's reason is visible in the cell, not a td title.
        expect(budgetPanelSource).toContain('class="mwt-budget-plan-reason"');
        expect(budgetPanelSource).not.toContain('planTitle');
        // The banner glyphs (🛡 / 👀 / ⚠) are decorative and hidden; the
        // truncate result is spelled out instead of an arrow-plus-number.
        expect(budgetPanelSource).toContain('<span aria-hidden="true">🛡</span>');
        expect(budgetPanelSource).toContain('<span aria-hidden="true">👀</span>');
        expect(budgetPanelSource).toContain('<span aria-hidden="true">⚠</span>');
        expect(budgetPanelSource).toContain('truncates to ~${Number(r.plan.tokensAfter).toLocaleString()}');
    });
});

// ─── Budget pane: table semantics and named inputs (Slice 4 scope-miss) ──────
// budget/panel.js was absent from the plan's source inventory; these pin the
// markup contract the rest of the sweep already guarantees elsewhere: column
// and row header scopes, per-input names like "Chronicle soft cap", and
// descriptions that resolve inside the pane.

/**
 * A minimal but fully-shaped collectBudgetSnapshot() stand-in. The labels are
 * PRODUCTION-shaped — emoji-led, exactly as BUDGET_MODULE_SPECS defines them —
 * because plain-label fixtures masked the accessible-name bug this block pins:
 * the pane must split the decorative icon (aria-hidden) from the plain module
 * name every accessible name and textual summary uses.
 */
const BUDGET_SNAP = {
    generatedAt: 0,
    mwtVersion: 'test',
    enforce: false,
    contextLimit: { value: 8192, source: 'test', note: 'probe note' },
    contextLimitOverride: 0,
    globalHardCap: 0,
    injectedTokens: 500,
    storedTokens: 1200,
    projected: { dropped: 1, truncated: 1, keptTokens: 300, totalBefore: 1200 },
    modules: [
        { id: 'world_state', label: '🌍 World State', mechanism: 'rebuild', advisory: false, priority: 1, softCap: 0, hardCap: 0, tokens: 0, tokenKind: 'injected', registered: false, plan: null },
        { id: 'chronicle', label: '📜 Chronicle', advisory: false, priority: 2, softCap: 500, hardCap: 0, tokens: 900, tokenKind: 'injected', registered: true, plan: { action: 'truncate', reason: 'Over soft cap (500)', tokensBefore: 900, tokensAfter: 480, displaced: ['world_state', 'story_planner'] } },
        { id: 'knowledge', label: '🧠 Knowledge', advisory: true, priority: 3, softCap: 0, hardCap: 0, tokens: 1200, tokenKind: 'stored', registered: false, plan: null },
    ],
    dropOrder: [{ label: '🗺️ Story Planner', priority: 5 }],
};

/** The plain names and decorative icons the pane must derive from those labels. */
const BUDGET_PLAIN = { world_state: 'World State', chronicle: 'Chronicle', knowledge: 'Knowledge' };
const BUDGET_ICONS = { world_state: '🌍', chronicle: '📜', knowledge: '🧠' };

describe('budget table: scopes, named inputs, hidden banner glyphs', () => {
    const render = () => {
        const holder = document.createElement('div');
        holder.innerHTML = renderBudgetSnapshot(BUDGET_SNAP, { formatTime: () => '12:00:00' });
        return holder;
    };

    test('every column header carries scope="col"; every module cell is a scope="row" th', () => {
        const holder = render();
        const colHeaders = [...holder.querySelectorAll('thead th')];
        expect(colHeaders).toHaveLength(6);
        for (const th of colHeaders) expect(th.getAttribute('scope')).toBe('col');
        const rowHeads = [...holder.querySelectorAll('tbody th[scope="row"]')];
        expect(rowHeads).toHaveLength(BUDGET_SNAP.modules.length);
        // Forward with the split's intent: the decorative icon sits in an
        // aria-hidden span and the header's exposed text is the PLAIN module
        // name — the combined textContent is never asserted to equal the
        // emoji-led spec label.
        expect(rowHeads.map((th) => {
            const icon = th.querySelector('span[aria-hidden="true"]');
            return th.textContent.replace(icon?.textContent ?? '', '').trim();
        })).toEqual(BUDGET_SNAP.modules.map((m) => BUDGET_PLAIN[m.id]));
    });

    test('each input is named "<Module> priority/soft cap/hard cap" and described by its column help', () => {
        const holder = render();
        const inputs = [...holder.querySelectorAll('.mwt-budget-priority, .mwt-budget-soft, .mwt-budget-hard')];
        expect(inputs).toHaveLength(BUDGET_SNAP.modules.length * 3);
        for (const input of inputs) {
            const label = BUDGET_PLAIN[input.dataset.module];
            const expected = {
                'mwt-budget-priority': `${label} priority`,
                'mwt-budget-soft': `${label} soft cap`,
                'mwt-budget-hard': `${label} hard cap`,
            }[input.className];
            expect(input.getAttribute('aria-label'), input.outerHTML).toBe(expected);
            const desc = input.getAttribute('aria-describedby');
            expect(desc, expected).toMatch(/^mwt-budget-help-(priority|soft|hard)$/);
            expect(holder.querySelector(`#${desc}`), expected).not.toBeNull();
        }
        // The advisory module's inputs stay explicitly disabled.
        for (const input of holder.querySelectorAll('input[data-module="knowledge"]')) {
            expect(input.disabled).toBe(true);
        }
    });

    test('the modeled action reads as text: "truncates to ~N" plus a visible reason', () => {
        const holder = render();
        const planCell = holder.querySelector('tr[data-module="chronicle"] .mwt-budget-plan');
        expect(planCell.querySelector('.mwt-diag-badge').textContent).toBe('truncates to ~480');
        expect(planCell.querySelector('.mwt-budget-plan-reason').textContent).toContain('Over soft cap (500)');
        // An idle module's lone "—" carries its meaning as sr-only text.
        const idleCell = holder.querySelector('tr[data-module="world_state"] .mwt-budget-plan');
        expect(idleCell.querySelector('.mwt-sr-only').textContent).toContain('nothing to model');
    });

    test('the displacement note names modules plainly, not by raw id', () => {
        // planBudgetDecision's displaced array holds module IDS (core/budget.js
        // pushes victim.id), and the note under the badge must read with the
        // same plain names the drop-order summary uses — "(would displace:
        // World State, Story Planner)" — not the raw snake_case ids.
        const holder = render();
        const reason = holder.querySelector('tr[data-module="chronicle"] .mwt-budget-plan-reason');
        expect(reason.textContent).toContain('would displace: World State, Story Planner');
        expect(reason.textContent).not.toContain('world_state');
        expect(reason.textContent).not.toContain('story_planner');
    });

    test('a label that is only an emoji renders its glyph once, not duplicated', () => {
        // Latent splitModuleLabel case (no current spec is emoji-only): the
        // fallback must not echo the glyph as both icon and name — the header
        // renders it exactly once, with no aria-hidden icon span.
        const snap = {
            ...BUDGET_SNAP,
            modules: BUDGET_SNAP.modules.map((m) => (m.id === 'world_state' ? { ...m, label: '🌍' } : m)),
        };
        const holder = document.createElement('div');
        holder.innerHTML = renderBudgetSnapshot(snap, { formatTime: () => '12:00:00' });
        const th = holder.querySelector('tr[data-module="world_state"] th[scope="row"]');
        expect(th.querySelector('span[aria-hidden="true"]')).toBeNull();
        expect(th.textContent.trim()).toBe('🌍');
    });

    test('the mode banner and context-limit note are glyph-independent and visible', () => {
        const holder = render();
        const banner = holder.querySelector('.mwt-budget-mode');
        expect(banner).not.toBeNull();
        expect(banner.firstElementChild.getAttribute('aria-hidden')).toBe('true');
        // The note under the usage bar is real text, not a title tooltip.
        expect(holder.querySelector('.mwt-budget-bar-note').textContent).toBe('probe note');
        expect(holder.querySelector('.mwt-budget-bar-wrap').getAttribute('title')).toBeNull();
    });

    test('the emoji-led spec labels never reach an accessible name or textual summary', () => {
        // BUDGET_MODULE_SPECS labels are emoji-led ("🌍 World State"): the
        // row header keeps the glyph visible but hides it from assistive
        // tech, and every name/summary the pane builds from a label — the
        // three per-input aria-labels, the drop-order note — uses the plain
        // module name only (a11y plan §4.4 decorative-emoji rule).
        const holder = render();
        // Row headers: the icon sits in an aria-hidden span and the exposed
        // text is exactly the plain name.
        for (const th of holder.querySelectorAll('tbody th[scope="row"]')) {
            const id = th.closest('tr').dataset.module;
            const icon = th.querySelector('span[aria-hidden="true"]');
            expect(icon, th.outerHTML).not.toBeNull();
            expect(icon.textContent).toBe(BUDGET_ICONS[id]);
            expect(th.textContent.replace(icon.textContent, '').trim()).toBe(BUDGET_PLAIN[id]);
        }
        // No accessible name in the pane announces a glyph.
        for (const el of holder.querySelectorAll('[aria-label]')) {
            expect(el.getAttribute('aria-label'), el.outerHTML).not.toMatch(/\p{Extended_Pictographic}/u);
        }
        // The drop-order summary is a plain-name textual summary.
        expect(holder.querySelector('.mwt-diag-note strong').textContent).toBe('Story Planner (P5)');
    });
});


describe('no essential state is color/emoji-only', () => {
    test('diagnostics: current-scope dot and error badges carry sr-only text', () => {
        expect(diagnosticsSource).toContain('<span class="mwt-sr-only">current — </span>');
        expect(diagnosticsSource.match(/<span class="mwt-sr-only">has error/g)?.length).toBeGreaterThanOrEqual(2);
    });

    test('interiority: manual (✋) badge carries sr-only text', () => {
        expect(interioritySource).toContain('<span aria-hidden="true">✋</span><span class="mwt-sr-only">user-authored</span>');
    });

    test('knowledge: orphan marker and change-origin emoji carry text equivalents', () => {
        expect(knowledgeSource).toContain('(orphaned — lorebook entry missing)');
        expect(knowledgeSource).toContain("'changed by you' : 'changed by auto-extraction'");
    });
});

// ─── Floating button bar (runtime behavior under jsdom) ───────────────────────

const FLOAT_IDS = [
    'mwt-float-world', 'mwt-float-chronicle', 'mwt-float-knowledge',
    'mwt-float-story-planner', 'mwt-float-interiority', 'mwt-float-settings',
];

function makeBar(overrides = {}) {
    const openModal = vi.fn();
    const modules = {
        WorldState: { getTotalTokens: () => 0, getAutoRefreshStatus: () => null, isRefreshing: () => false, getWorldStateText: () => '' },
        Chronicle: { getTotalTokens: () => 0, getAutoSnapshotStatus: () => null, isGeneratingSnapshot: () => false, getLastEntryText: () => '' },
        Knowledge: {
            refreshTotalTokens: () => Promise.resolve(), getAutoScanStatus: () => null,
            isScanning: () => false, getNpcCount: () => 0,
            getStagingCount: () => 0, getGrowthEvidenceCount: () => 0,
        },
        StoryPlanner: { getTotalTokens: () => 0 },
        Interiority: { getTotalTokens: () => 0 },
        ...overrides.modules,
    };
    const settings = { ...overrides.settings };
    const bar = createFloatingButtonBar({
        getSettings: () => settings,
        saveSettings: () => {},
        openModal,
        modules,
    });
    return { bar, openModal, modules, settings };
}

describe('floating button bar (Slice 4 names + keyboard path)', () => {
    beforeEach(() => { document.body.innerHTML = ''; });
    afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks(); });

    test('every float button is a named, focusable role="button"', () => {
        const { bar } = makeBar();
        bar.setupButtonBar();
        for (const id of FLOAT_IDS) {
            const btn = document.getElementById(id);
            expect(btn, id).not.toBeNull();
            expect(btn.getAttribute('role'), id).toBe('button');
            expect(btn.getAttribute('tabindex'), id).toBe('0');
            expect((btn.getAttribute('aria-label') || '').length, id).toBeGreaterThan(0);
            // Decorative glyph and countdown digits are hidden from AT
            // (§4.4: countdowns must not be announced).
            expect(btn.querySelector('.mwt-float-btn-icon').getAttribute('aria-hidden')).toBe('true');
            expect(btn.querySelector('.mwt-float-btn-countdown').getAttribute('aria-hidden')).toBe('true');
        }
    });

    test('Enter and Space activate the button; other keys do not', () => {
        const { bar, openModal } = makeBar();
        bar.setupButtonBar();
        const btn = document.getElementById('mwt-float-world');
        btn.focus();
        btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        btn.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
        expect(openModal).toHaveBeenCalledTimes(2);
        expect(openModal).toHaveBeenCalledWith('world-state');
        btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
        expect(openModal).toHaveBeenCalledTimes(2);
    });

    test('the knowledge button name tracks pending proposals (title ↔ aria-label)', () => {
        const { bar, modules } = makeBar();
        bar.setupButtonBar();
        modules.Knowledge.getStagingCount = () => 3;
        modules.Knowledge.getGrowthEvidenceCount = () => 0;
        bar.updateButtonStates();
        const btn = document.getElementById('mwt-float-knowledge');
        expect(btn.title).toContain('3 proposal(s)');
        expect(btn.getAttribute('aria-label')).toBe(btn.title);
    });

    test('the collapsed hub button is a named, keyboard-operable role="button"', () => {
        const { bar, openModal } = makeBar({ settings: { collapseFloatButtons: true } });
        bar.setupButtonBar();
        bar.applyButtonVisibility();
        const hub = document.getElementById('mwt-float-hub');
        expect(hub).not.toBeNull();
        expect(hub.getAttribute('role')).toBe('button');
        expect(hub.getAttribute('tabindex')).toBe('0');
        expect(hub.getAttribute('aria-label')).toBe('Merged World Tracker');
        expect(hub.querySelector('.mwt-float-btn-icon').getAttribute('aria-hidden')).toBe('true');
        hub.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        expect(openModal).toHaveBeenCalledWith(null);
    });
});


