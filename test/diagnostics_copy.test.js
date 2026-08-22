/**
 * test/diagnostics_copy.test.js — Phase 5 review follow-up + Phase 13 tests
 * for the Copy Report clipboard path (diagnostics_panel/render.js).
 *
 * navigator.clipboard is UNDEFINED on non-secure origins — SillyTavern served
 * over plain http on a LAN is exactly that — and the original handler
 * dereferenced it outside its error guard, producing an uncaught synchronous
 * TypeError instead of the intended status message. copyTextToClipboard() is
 * exported with injectable nav/doc refs precisely so this Node suite (no
 * browser globals) can pin all three outcomes: async Clipboard API, legacy
 * execCommand fallback, total failure.
 *
 * Phase 13 (copy-report finalize) adds runCopyReport() — the button flow the
 * async collect made worth extracting (the runIntegrityChecks precedent):
 * injectable collect/build/copy/status, the live content opt-in read, the
 * disable+relabel while the lorebook-backed collect runs, and the collect /
 * clipboard failure degradations.
 */

import { describe, test, expect, vi } from 'vitest';

import { copyTextToClipboard, runCopyReport } from '../diagnostics_panel/render.js';

/** Minimal fake document exercising the legacy execCommand('copy') path. */
function fakeDoc({ execResult = true, throwOnCreate = false } = {}) {
    const doc = {
        created: [],
        commands: [],
        createElement() {
            if (throwOnCreate) throw new Error('no DOM');
            const ta = {
                value: '',
                style: {},
                setAttribute() {},
                focus() {},
                select() {},
                remove() {},
            };
            doc.created.push(ta);
            return ta;
        },
        body: { appendChild() {} },
        execCommand(cmd) {
            doc.commands.push(cmd);
            return execResult;
        },
    };
    return { doc, created: doc.created };
}

describe('copyTextToClipboard', () => {
    test('uses the async Clipboard API when present', async () => {
        const writes = [];
        const ok = await copyTextToClipboard('report text', {
            nav: { clipboard: { writeText: async (t) => { writes.push(t); } } },
            doc: fakeDoc().doc,
        });
        expect(ok).toBe(true);
        expect(writes).toEqual(['report text']);
    });

    test('falls back to execCommand when navigator.clipboard is undefined (non-secure origin)', async () => {
        const { doc, created } = fakeDoc();
        const ok = await copyTextToClipboard('report text', { nav: {}, doc });
        expect(ok).toBe(true);
        expect(doc.commands).toEqual(['copy']);
        expect(created).toHaveLength(1);              // the temporary textarea
        expect(created[0].value).toBe('report text'); // carried the report
    });

    test('falls back when writeText rejects (clipboard-restricted context)', async () => {
        const { doc } = fakeDoc();
        const ok = await copyTextToClipboard('report text', {
            nav: { clipboard: { writeText: async () => { throw new Error('not allowed'); } } },
            doc,
        });
        expect(ok).toBe(true);
        expect(doc.commands).toEqual(['copy']);
    });

    test('resolves false — never throws — when both paths are unavailable', async () => {
        // execCommand present but returns false (e.g. nothing selected).
        const denied = fakeDoc({ execResult: false });
        await expect(copyTextToClipboard('report text', { nav: {}, doc: denied.doc })).resolves.toBe(false);
        // The legacy path itself exploding still resolves false.
        const broken = fakeDoc({ throwOnCreate: true });
        await expect(copyTextToClipboard('report text', { nav: {}, doc: broken.doc })).resolves.toBe(false);
    });
});

// ─── Phase 13: the Copy Report flow (runCopyReport) ──────────────────────────

/** Button fake carrying the label runCopyReport disables + restores. */
const fakeReportButton = () => ({ disabled: false, textContent: '📋 Copy Report' });

/** Root fake answering ONLY the content opt-in query runCopyReport makes. */
const fakeReportRoot = ({ includeContent = false } = {}) => ({
    querySelector: (sel) => (sel === '#mwt-diag-include-content' ? { checked: includeContent } : null),
});

describe('runCopyReport', () => {
    test('collect → build → copy with the checkbox read live (content EXCLUDED)', async () => {
        const button = fakeReportButton();
        const statuses = [];
        const copies = [];
        const builtWith = [];
        const ok = await runCopyReport(button, fakeReportRoot(), {
            collect: async () => [{ id: 'events', title: 'Events', data: [] }],
            build: (opts) => { builtWith.push(opts); return { markdown: 'REPORT-MARKDOWN' }; },
            copy: async (text) => { copies.push(text); return true; },
            status: (message, type) => statuses.push([message, type]),
        });
        expect(ok).toBe(true);
        expect(builtWith[0].includeContent).toBe(false);       // checkbox unchecked
        expect(copies).toEqual(['REPORT-MARKDOWN']);
        expect(statuses.at(-1)[0]).toContain('content excluded, secrets redacted');
        expect(statuses.at(-1)[1]).toBe('success');
        expect(button.disabled).toBe(false);
        expect(button.textContent).toBe('📋 Copy Report');
    });

    test('the ticked opt-in flows through: content INCLUDED status', async () => {
        const statuses = [];
        await runCopyReport(fakeReportButton(), fakeReportRoot({ includeContent: true }), {
            collect: async () => [],
            build: (opts) => { expect(opts.includeContent).toBe(true); return { markdown: 'R' }; },
            copy: async () => true,
            status: (message, type) => statuses.push([message, type]),
        });
        expect(statuses.at(-1)[0]).toContain('content INCLUDED');
    });

    test('disables + relabels the button while the async collect runs', async () => {
        const button = fakeReportButton();
        let seenDuringCollect = null;
        await runCopyReport(button, fakeReportRoot(), {
            collect: async () => {
                seenDuringCollect = { disabled: button.disabled, label: button.textContent };
                return [];
            },
            build: () => ({ markdown: 'R' }),
            copy: async () => true,
            status: () => {},
        });
        expect(seenDuringCollect).toEqual({ disabled: true, label: '⏳ Building report…' });
        expect(button.disabled).toBe(false);
    });

    test('a failed collect/build degrades to an error status, button restored', async () => {
        const button = fakeReportButton();
        const statuses = [];
        const ok = await runCopyReport(button, fakeReportRoot(), {
            collect: async () => { throw new Error('lorebook read failed'); },
            copy: async () => true,
            status: (message, type) => statuses.push([message, type]),
        });
        expect(ok).toBe(false);
        expect(statuses.at(-1)[1]).toBe('error');
        expect(statuses.at(-1)[0]).toContain('lorebook read failed');
        expect(button.disabled).toBe(false);
        expect(button.textContent).toBe('📋 Copy Report');
    });

    test('a failed copy dumps the report to the console (the escape hatch)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const statuses = [];
            const ok = await runCopyReport(fakeReportButton(), fakeReportRoot(), {
                collect: async () => [],
                build: () => ({ markdown: 'THE-REPORT' }),
                copy: async () => false,
                status: (message, type) => statuses.push([message, type]),
            });
            expect(ok).toBe(false);
            expect(statuses.at(-1)[1]).toBe('error');
            expect(warn).toHaveBeenCalledWith(
                '[MWT:Diagnostics] Clipboard copy failed — the report follows; copy it from the console:',
                'THE-REPORT',
            );
        } finally {
            warn.mockRestore();
        }
    });

    test('no-ops without a button or a root', async () => {
        await expect(runCopyReport(null, fakeReportRoot())).resolves.toBe(false);
        await expect(runCopyReport(fakeReportButton(), null)).resolves.toBe(false);
    });
});
