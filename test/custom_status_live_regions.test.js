/** @vitest-environment jsdom */

// Live-region coverage for the custom status writers that never routed
// through setStatus() (BUG_REPORTS/bugs_temp.md, P2: "Custom status writers
// bypass live-region semantics"):
//
//   - Interiority's setIntStatus() (#mwt-int-status),
//   - Chronicle's scSetStatus() (.sc-status-text),
//   - the Knowledge Growth modal's bare flash writers (.mwt-status).
//
// scSetStatus runs behaviorally against jsdom (chronicle/data.js imports
// cleanly under the barrel→stub alias — the busy_state_handlers.test.js
// precedent). The Interiority and Knowledge writers are pinned as source
// contracts: their render.js modules drag host-only wiring along, the same
// read-the-source approach as test/focus_status_motion.test.js.

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { resetCoreStubs } from './stubs/core.js';
import { state, scSetStatus } from '../chronicle/data.js';

import interiorityRenderSource from '../interiority/render.js?raw';
import chronicleRenderSource from '../chronicle/render.js?raw';
import knowledgeRenderSource from '../knowledge/render.js?raw';

// ─── scSetStatus (behavioral) ────────────────────────────────────────────────

describe('scSetStatus() live region', () => {
    beforeEach(() => {
        resetCoreStubs();
        document.body.innerHTML = '';
        state.contentEl = null;
        state.modal = null;
    });

    afterEach(() => {
        document.body.innerHTML = '';
        state.contentEl = null;
    });

    test('writes text + level and stamps the live-region semantics on every status node', () => {
        const host = document.createElement('div');
        // One node with the semantics the template now ships, one legacy node
        // without — a single write must leave both announced.
        host.innerHTML = `
            <div class="sc-status"><span class="sc-status-text" role="status" aria-live="polite" aria-atomic="true"></span></div>
            <div class="sc-status"><span class="sc-status-text"></span></div>`;
        document.body.append(host);
        state.contentEl = host;

        scSetStatus('Entries consolidated.', 'success');

        host.querySelectorAll('.sc-status-text').forEach(s => {
            expect(s.textContent).toBe('Entries consolidated.');
            expect(s.className).toContain('sc-status--success');
            expect(s.getAttribute('role')).toBe('status');
            expect(s.getAttribute('aria-live')).toBe('polite');
            expect(s.getAttribute('aria-atomic')).toBe('true');
        });
    });

    test('still persists the message for re-render when no content element exists yet', () => {
        state.contentEl = null;
        expect(() => scSetStatus('No host yet.', 'info')).not.toThrow();
        expect(state._lastStatusMsg).toBe('No host yet.');
        expect(state._lastStatusLevel).toBe('info');
    });
});

// ─── Source contracts ────────────────────────────────────────────────────────

describe('custom status writers carry the shared live-region contract (source)', () => {
    test('the Interiority tab ships #mwt-int-status with the semantics and setIntStatus re-stamps them on every write', () => {
        expect(interiorityRenderSource).toMatch(/id="mwt-int-status"[^>]*role="status"/);
        expect(interiorityRenderSource).toMatch(/id="mwt-int-status"[^>]*aria-live="polite"/);
        expect(interiorityRenderSource).toMatch(/id="mwt-int-status"[^>]*aria-atomic="true"/);
        expect(interiorityRenderSource).toMatch(
            /export function setIntStatus[\s\S]{0,700}?setAttribute\?\.\('role', 'status'\);[\s\S]{0,200}?setAttribute\?\.\('aria-atomic', 'true'\);[\s\S]{0,300}?statusEl\.textContent = text \|\| '';/,
        );
    });

    test('every chronicle .sc-status-text template site ships the semantics', () => {
        const sites = chronicleRenderSource.match(/<span class="sc-status-text"[^>]*><\/span>/g) || [];
        expect(sites.length).toBe(3);
        for (const site of sites) {
            expect(site).toMatch(/role="status"/);
            expect(site).toMatch(/aria-live="polite"/);
            expect(site).toMatch(/aria-atomic="true"/);
        }
    });

    test('the Growth modal shell ships .mwt-status with the semantics', () => {
        expect(knowledgeRenderSource).toMatch(
            /<span class="mwt-status" role="status" aria-live="polite" aria-atomic="true"><\/span>/,
        );
    });

    test('the Growth flash writers route through the shared setStatus() — no bare .mwt-status writer remains', () => {
        expect(knowledgeRenderSource).toMatch(/import \{ decorateModalShell, setStatus \} from '\.\.\/core\/modal\.js';/);
        expect(knowledgeRenderSource).toMatch(/setStatus\(modal, flashMsg, 'success', 3000\);/);
        expect(knowledgeRenderSource).toMatch(
            /const flash = \(msg, type = 'success'\) => \{\s*setStatus\(modal, msg, type, type === 'success' \? 3000 : 0\);\s*\};/,
        );
        expect(knowledgeRenderSource).not.toMatch(/querySelector\('\.mwt-status'\)/);
    });
});