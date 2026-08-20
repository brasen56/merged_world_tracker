/**
 * test/diagnostics_copy.test.js — Phase 5 review follow-up tests for the Copy
 * Report clipboard path (diagnostics_panel/render.js).
 *
 * navigator.clipboard is UNDEFINED on non-secure origins — SillyTavern served
 * over plain http on a LAN is exactly that — and the original handler
 * dereferenced it outside its error guard, producing an uncaught synchronous
 * TypeError instead of the intended status message. copyTextToClipboard() is
 * exported with injectable nav/doc refs precisely so this Node suite (no
 * browser globals) can pin all three outcomes: async Clipboard API, legacy
 * execCommand fallback, total failure.
 */

import { describe, test, expect } from 'vitest';

import { copyTextToClipboard } from '../diagnostics_panel/render.js';

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
