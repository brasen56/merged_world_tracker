/** @vitest-environment jsdom */

// Accessibility plan Slice 3 (§4.3–§4.5 / §6.4): scoped :focus-visible rules,
// outline:none ↔ :focus-visible pairing per stylesheet, the setStatus() live
// region, per-handler disabled + aria-busy (including the error path), and
// the reduced-motion block plus its one JS gate.
//
// §6.5 stays manual and is NOT claimed here: :focus-visible rendering,
// prefers-reduced-motion behavior in a real browser, and real sequential
// focus traversal. The CSS assertions below check the *source contracts*
// those manual checks rely on (scoping and pairing), the same
// read-the-source approach as test/main_tabbar_adoption.test.js.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createModal, setStatus } from '../core/modal.js';
import { prefersReducedMotion, setControlBusy } from '../core/ui.js';
import { runCopyReport } from '../diagnostics_panel/render.js';
// The renderer as source text. A Vite `?raw` import stands in for the
// readFileSync precedent in test/schema_engine.test.js because node builtins
// are externalized under this file's jsdom environment
// (readFileSync/fileURLToPath are not functions there) — the same approach
// as test/main_tabbar_adoption.test.js. (CSS ?raw imports do NOT work here:
// vitest stubs CSS modules with an empty string, so the stylesheet source
// assertions live in test/focus_status_motion_css.test.js, which runs in
// the default Node environment.)
import knowledgeRenderSource from '../knowledge/render.js?raw';

beforeEach(() => {
    document.body.innerHTML = '';
});

afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

// ─── §4.4 / §6.4: status live region ──────────────────────────────────────────

describe('setStatus() live region', () => {
    test('createModal stamps the status bar as a polite, atomic live region', () => {
        const modal = createModal({ id: 'mwt-fsm-stamped', title: 'Demo', content: '' });
        const statusEl = modal.querySelector('.mwt-status');
        expect(statusEl.getAttribute('role')).toBe('status');
        expect(statusEl.getAttribute('aria-live')).toBe('polite');
        expect(statusEl.getAttribute('aria-atomic')).toBe('true');
    });

    test('status updates land in the live region', () => {
        const modal = createModal({ id: 'mwt-fsm-update', title: 'Demo', content: '' });
        setStatus('mwt-fsm-update', 'Saved.', 'success');
        const statusEl = modal.querySelector('.mwt-status');
        expect(statusEl.textContent).toBe('Saved.');
        expect(statusEl.className).toContain('mwt-status-success');
    });

    test('setStatus() stamps the semantics on legacy shells that predate the template', () => {
        const shell = document.createElement('div');
        shell.id = 'mwt-fsm-legacy';
        shell.innerHTML = '<div class="mwt-modal-panel"><span class="mwt-status"></span></div>';
        document.body.append(shell);
        setStatus('mwt-fsm-legacy', 'Done.', 'info');
        const statusEl = shell.querySelector('.mwt-status');
        expect(statusEl.textContent).toBe('Done.');
        expect(statusEl.getAttribute('role')).toBe('status');
        expect(statusEl.getAttribute('aria-live')).toBe('polite');
        expect(statusEl.getAttribute('aria-atomic')).toBe('true');
    });

    test('the Knowledge tab ships its #kt-status element with the same semantics', () => {
        expect(knowledgeRenderSource).toMatch(/id="kt-status"[^>]*role="status"/);
        expect(knowledgeRenderSource).toMatch(/id="kt-status"[^>]*aria-live="polite"/);
    });
});

// ─── §4.4 / §6.4: busy state ──────────────────────────────────────────────────

describe('setControlBusy()', () => {
    test('sets and clears disabled and aria-busy together', () => {
        const btn = document.createElement('button');
        setControlBusy(btn, true);
        expect(btn.disabled).toBe(true);
        expect(btn.getAttribute('aria-busy')).toBe('true');
        setControlBusy(btn, false);
        expect(btn.disabled).toBe(false);
        expect(btn.getAttribute('aria-busy')).toBe('false');
    });

    test('is null-safe and tolerates element fakes without setAttribute', () => {
        expect(() => setControlBusy(null, true)).not.toThrow();
        expect(() => setControlBusy(undefined, false)).not.toThrow();
        const fake = { disabled: false };
        setControlBusy(fake, true);
        expect(fake.disabled).toBe(true);
    });
});

describe('async handler busy contract (runCopyReport)', () => {
    test('exposes disabled + aria-busy while running and clears BOTH on the error path', async () => {
        const button = document.createElement('button');
        button.textContent = '📋 Copy Report';
        const root = document.createElement('div');
        let seenWhileRunning;
        const collect = async () => {
            seenWhileRunning = { disabled: button.disabled, busy: button.getAttribute('aria-busy') };
            throw new Error('boom');
        };
        const status = vi.fn();
        const copied = await runCopyReport(button, root, { collect, status });
        expect(copied).toBe(false);
        expect(seenWhileRunning).toEqual({ disabled: true, busy: 'true' });
        expect(button.disabled).toBe(false);
        expect(button.getAttribute('aria-busy')).toBe('false');
        expect(button.textContent).toBe('📋 Copy Report');
        expect(status).toHaveBeenCalledWith(expect.stringContaining('boom'), 'error');
    });

    test('clears both after a successful copy', async () => {
        const button = document.createElement('button');
        button.textContent = '📋 Copy Report';
        const root = document.createElement('div');
        const copied = await runCopyReport(button, root, {
            collect: async () => [],
            build: () => ({ markdown: '# report' }),
            copy: async () => true,
            status: vi.fn(),
        });
        expect(copied).toBe(true);
        expect(button.disabled).toBe(false);
        expect(button.getAttribute('aria-busy')).toBe('false');
    });
});

// ─── §4.5: reduced motion ─────────────────────────────────────────────────────

describe('prefersReducedMotion()', () => {
    const originalMatchMedia = typeof window.matchMedia === 'function'
        ? window.matchMedia.bind(window)
        : undefined;

    afterEach(() => {
        if (originalMatchMedia) window.matchMedia = originalMatchMedia;
        else delete window.matchMedia;
    });

    test('reads the media query through matchMedia', () => {
        window.matchMedia = vi.fn().mockReturnValue({ matches: true });
        expect(prefersReducedMotion()).toBe(true);
        window.matchMedia = vi.fn().mockReturnValue({ matches: false });
        expect(prefersReducedMotion()).toBe(false);
    });

    test('fails open when matchMedia is unavailable', () => {
        delete window.matchMedia;
        expect(prefersReducedMotion()).toBe(false);
    });
});

describe('reduced-motion JS gate', () => {
    test('the psychoanalyze smooth scroll is gated in JS', () => {
        expect(knowledgeRenderSource).toContain("behavior: prefersReducedMotion() ? 'auto' : 'smooth'");
        // No ungated smooth scroll may remain.
        expect(knowledgeRenderSource).not.toMatch(/behavior:\s*'smooth'/);
    });
});



