/**
 * test/modal_interactions.test.js — TODO §6 "Mobile/keyboard modal
 * interactions": the shared modal lifecycle (core/modal.js) driven through
 * keyboard and pointer input.
 *
 * What is pinned here:
 *   - the Escape rule — only the topmost VISIBLE `.mwt-modal` closes, so a
 *     stacked modal below stays open and a hidden one never reacts;
 *   - the pointer paths — the × close button and the backdrop (the mobile
 *     tap target shares the click handler with the mouse path);
 *   - the onClose veto — returning exactly false cancels the close on every
 *     path (the unsaved-changes guard);
 *   - same-id recreation — the previous modal's keydown handler is cleaned
 *     up, so re-opening a modal cannot leak handlers;
 *   - setStatus timing — a later persistent message cancels a pending
 *     auto-fade timer (CORE-03).
 *
 * The DOM is a local minimal fake whose elements PARSE the markup assigned to
 * innerHTML (a small scanner for the tags, quoted attributes, and &…;
 * entities core/modal.js emits); querySelector walks that parsed tree and
 * returns null for anything the markup does not contain, so the pointer tests
 * bind to the real class names rather than to whatever they ask for. No
 * stub-core aliasing is needed: core/modal.js's only import is the pure
 * escapeHtml. Listeners are still invoked directly (fire/click) — these stay
 * handler tests rather than full mobile interaction coverage.
 *
 * SCOPE — these guarantees hold for createModal CONSUMERS only. The four
 * Knowledge modals hand-roll their markup and never call the helper, so none
 * of the Escape/veto/cleanup contract pinned here applies to them by
 * construction: #kt-view-modal, #kt-growth-modal, #kt-dossier-refresh-modal,
 * and #kt-identity-modal (knowledge/render.js). What IS pinned elsewhere is
 * their removal on chat change (test/paused_chat_cleanup.test.js, via the
 * _cleanupKeyHandler convention). A lifecycle regression in one of those
 * modals is invisible to this file — do not read green here as "modal
 * interactions are covered" for them.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createModal, showModal, hideModal, setStatus } from '../core/modal.js';

// ─── Minimal fake DOM ─────────────────────────────────────────────────────────

/**
 * Entities escapeHtml and the modal markup actually produce (plus the
 * &times; glyph on the close button).
 */
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', times: '×' };

function decodeEntities(text) {
    return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X'
                ? Number.parseInt(body.slice(2), 16)
                : Number.parseInt(body.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : match;
        }
        return ENTITIES[body] ?? match;
    });
}

/** Elements that never carry children — enough for the modal markup family. */
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);

/** The '>' that ends a tag, ignoring any '>' inside quoted attributes. */
function endOfTag(html, from) {
    let quote = null;
    for (let i = from + 1; i < html.length; i++) {
        const ch = html[i];
        if (quote) { if (ch === quote) quote = null; }
        else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '>') return i;
    }
    return html.length;
}

/**
 * Parse the selector forms used here: `.class`, `tag`, `tag.class`,
 * `.class.class`. Combinators are deliberately unsupported; an unparsable
 * selector matches nothing (like an unsupported selector in a browser).
 */
function parseSelector(selector) {
    const m = /^([a-zA-Z][a-zA-Z0-9-]*)?((?:\.[^.+\s>~]+)*)$/.exec(String(selector).trim());
    if (!m) return null;
    return { tag: m[1] ? m[1].toLowerCase() : null, classes: m[2] ? m[2].slice(1).split('.') : [] };
}

function matchesSelector(el, parsed) {
    if (parsed.tag && el.tagName !== parsed.tag) return false;
    return parsed.classes.every(cls => el.hasClass(cls));
}

class FakeElement {
    constructor(tag = 'div') {
        this.tagName = String(tag).toLowerCase();
        this.id = '';
        this.className = '';
        this.style = {};
        this.parentNode = null;
        /** Element children and decoded text strings, in document order. */
        this.childNodes = [];
        this._listeners = new Map();
        this._doc = null;
    }

    /** Element children only (text nodes are not children in the DOM). */
    get children() {
        return this.childNodes.filter(n => n instanceof FakeElement);
    }

    get textContent() {
        return this.childNodes.map(n => (n instanceof FakeElement ? n.textContent : n)).join('');
    }

    set textContent(text) {
        this.childNodes = [String(text)];
    }

    /** Assigning markup PARSES it into a real element tree (see parseHtmlInto). */
    set innerHTML(html) {
        this.childNodes = [];
        parseHtmlInto(this, String(html));
    }

    hasClass(cls) {
        return this.className.split(/\s+/).includes(cls);
    }

    appendChild(child) {
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = this;
        child._doc = this._doc ?? child._doc;
        this.childNodes.push(child);
        this._doc?._register(child);
        return child;
    }

    removeChild(child) {
        const i = this.childNodes.indexOf(child);
        if (i !== -1) this.childNodes.splice(i, 1);
        child.parentNode = null;
    }

    remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
        this._doc?._forget(this);
    }

    addEventListener(type, fn) {
        if (!this._listeners.has(type)) this._listeners.set(type, new Set());
        this._listeners.get(type).add(fn);
    }

    removeEventListener(type, fn) {
        this._listeners.get(type)?.delete(fn);
    }

    /** Test-side dispatch of a DOM event at this element. */
    fire(type, event = {}) {
        for (const fn of [...(this._listeners.get(type) || [])]) fn({ type, ...event });
    }

    click() {
        this.fire('click');
    }

    /** Descendants in document order (pre-order DFS); self excluded. */
    *_descendants() {
        for (const child of this.children) {
            yield child;
            yield* child._descendants();
        }
    }

    /** Walks the PARSED tree — null for anything the markup does not contain. */
    querySelectorAll(selector) {
        const parsed = parseSelector(selector);
        if (!parsed) return [];
        return [...this._descendants()].filter(el => matchesSelector(el, parsed));
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] ?? null;
    }
}

/**
 * Parse a fragment of markup and append the resulting nodes onto `root`.
 * Covers what core/modal.js emits — nested elements, quoted attributes,
 * &…; entities, self-closing and void tags. Whitespace-only text nodes are
 * dropped: real DOMs keep them, but nothing in these tests reads them.
 */
function parseHtmlInto(root, html) {
    const stack = [root];
    const top = () => stack[stack.length - 1];
    let i = 0;
    while (i < html.length) {
        const lt = html.indexOf('<', i);
        const text = html.slice(i, lt === -1 ? html.length : lt);
        if (text.trim()) top().childNodes.push(decodeEntities(text));
        if (lt === -1) break;
        i = lt;
        if (html.startsWith('<!--', i)) { // comment — skip past its end
            const end = html.indexOf('-->', i);
            i = end === -1 ? html.length : end + 3;
            continue;
        }
        const gt = endOfTag(html, i);
        const inner = html.slice(i + 1, gt);
        i = gt + 1;
        if (inner.startsWith('/')) { // closing tag — pop to its opener
            const name = inner.slice(1).trim().toLowerCase();
            for (let s = stack.length - 1; s > 0; s--) {
                if (stack[s].tagName === name) { stack.length = s; break; }
            }
            continue;
        }
        const tagMatch = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(inner);
        if (!tagMatch) continue; // stray '<' — markup noise, skip
        const el = new FakeElement(tagMatch[1]);
        el._doc = root._doc;
        // Quoted attributes only — that is all the modal markup uses.
        for (const [, name, dq, sq] of inner.matchAll(/([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
            const value = decodeEntities(dq ?? sq ?? '');
            if (name.toLowerCase() === 'class') el.className = value;
            else if (name.toLowerCase() === 'id') el.id = value;
        }
        top().childNodes.push(el);
        el.parentNode = top();
        const selfClosing = inner.trimEnd().endsWith('/');
        if (!selfClosing && !VOID_TAGS.has(el.tagName)) stack.push(el);
    }
}

function makeFakeDocument() {
    const byId = new Map();
    const listeners = new Map();
    const doc = {
        body: null,
        getElementById: (id) => byId.get(id) ?? null,
        createElement(tag) {
            const el = new FakeElement(tag);
            el._doc = doc;
            return el;
        },
        querySelectorAll(selector) {
            // Document order from the tree root — the same generic walk the
            // elements use, so the topmost-visible rule in modal.js's Escape
            // handler sees real DOM order.
            const parsed = parseSelector(selector);
            if (!parsed || !doc.body) return [];
            const out = [];
            const walk = (el) => {
                if (matchesSelector(el, parsed)) out.push(el);
                for (const child of el.children) walk(child);
            };
            walk(doc.body);
            return out;
        },
        addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(fn);
        },
        removeEventListener(type, fn) {
            listeners.get(type)?.delete(fn);
        },
        /** Test helper: press a key — runs every live keydown listener. */
        pressKey(key) {
            for (const fn of [...(listeners.get('keydown') || [])]) fn({ type: 'keydown', key });
        },
        /** Test helper: how many live listeners a document event type has. */
        listenerCount(type) {
            return listeners.get(type)?.size ?? 0;
        },
        _register(el) {
            if (el.id) byId.set(el.id, el);
        },
        _forget(el) {
            if (el.id && byId.get(el.id) === el) byId.delete(el.id);
        },
    };
    doc.body = doc.createElement('body');
    return doc;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let doc;

beforeEach(() => {
    doc = makeFakeDocument();
    globalThis.document = doc;
});

afterEach(() => {
    vi.useRealTimers();
    delete globalThis.document;
});

function openModal(id, opts = {}) {
    const modal = createModal({ id, title: 'Test modal', content: '<p>body</p>', ...opts });
    showModal(id);
    return modal;
}

// ─── Escape key: the topmost-visible rule ─────────────────────────────────────

describe('Escape key handling', () => {
    test('Escape closes a single visible modal', () => {
        const modal = openModal('mwt-t1');
        expect(modal.style.display).toBe('flex');

        doc.pressKey('Escape');

        expect(modal.style.display).toBe('none');
    });

    test('Escape closes only the topmost of two stacked modals; a second Escape closes the lower one', () => {
        const lower = openModal('mwt-lower');
        const upper = openModal('mwt-upper');

        doc.pressKey('Escape');

        // The upper modal was shown last → it is topmost in DOM order.
        expect(upper.style.display).toBe('none');
        expect(lower.style.display).toBe('flex');

        doc.pressKey('Escape');

        expect(lower.style.display).toBe('none');
    });

    test('Escape does nothing while the modal is hidden', () => {
        const modal = createModal({ id: 'mwt-hidden', title: 't', content: '' });
        // Never shown — display stays 'none'.

        doc.pressKey('Escape');

        expect(modal.style.display).toBe('none');
    });

    test('non-Escape keys do nothing', () => {
        const modal = openModal('mwt-keys');

        doc.pressKey('Enter');
        doc.pressKey('Tab');
        doc.pressKey('Esc'); // Only the exact 'Escape' matches.

        expect(modal.style.display).toBe('flex');
    });
});

// ─── Pointer interactions: close button and backdrop ──────────────────────────

describe('pointer interactions (close button / backdrop tap)', () => {
    test('the × close button click hides the modal', () => {
        const modal = openModal('mwt-close-btn');

        modal.querySelector('.mwt-modal-close').click();

        expect(modal.style.display).toBe('none');
    });

    test('a backdrop click — the mobile tap target — hides the modal', () => {
        const modal = openModal('mwt-backdrop');

        modal.querySelector('.mwt-modal-backdrop').click();

        expect(modal.style.display).toBe('none');
    });

    test('closing only hides: showModal brings the same element back', () => {
        const modal = openModal('mwt-reopen');
        modal.querySelector('.mwt-modal-close').click();
        expect(modal.style.display).toBe('none');

        showModal('mwt-reopen');

        expect(modal.style.display).toBe('flex');
        expect(doc.getElementById('mwt-reopen')).toBe(modal);
    });
});

// ─── Fake-DOM fidelity: selectors bind to the real markup ─────────────────────

describe('fake DOM selector fidelity', () => {
    // The first version of this fake materialized ANY element querySelector
    // was asked for, so renaming a class in core/modal.js (say .mwt-modal-close
    // → .mwt-close-btn) kept every pointer test green while the production
    // handler silently bound to null. The parsing DOM must return exactly
    // what the markup contains — and null for anything it does not.
    test('querySelector finds the markup elements and returns null for missing selectors', () => {
        const modal = openModal('mwt-fidelity');

        // The three selectors modal.js itself queries, present in the markup:
        expect(modal.querySelector('.mwt-modal-close')).toBeInstanceOf(FakeElement);
        expect(modal.querySelector('.mwt-modal-backdrop')).toBeInstanceOf(FakeElement);
        expect(modal.querySelector('.mwt-status')).toBeInstanceOf(FakeElement);
        // A tag+class compound matches, and the × glyph decodes through
        // entities rather than sitting in the text as "&times;".
        const closeBtn = modal.querySelector('button.mwt-modal-close');
        expect(closeBtn).toBeInstanceOf(FakeElement);
        expect(closeBtn.textContent).toBe('×');

        // A class the markup does not contain comes back null…
        expect(modal.querySelector('.mwt-modal-close-btn')).toBeNull();
        // …and so does a compound selector whose second class is not on the
        // element (setStatus has not run yet).
        expect(modal.querySelector('.mwt-status.mwt-status-info')).toBeNull();
    });
});

// ─── The onClose veto (unsaved-changes guard) ─────────────────────────────────

describe('onClose veto', () => {
    test('returning false keeps the modal open on Escape', () => {
        const modal = openModal('mwt-veto-esc', { onClose: () => false });

        doc.pressKey('Escape');

        expect(modal.style.display).toBe('flex');
    });

    test('returning false keeps the modal open on the close button', () => {
        const modal = openModal('mwt-veto-btn', { onClose: () => false });

        modal.querySelector('.mwt-modal-close').click();

        expect(modal.style.display).toBe('flex');
    });

    test('returning false keeps the modal open on a backdrop tap', () => {
        const modal = openModal('mwt-veto-tap', { onClose: () => false });

        modal.querySelector('.mwt-modal-backdrop').click();

        expect(modal.style.display).toBe('flex');
    });

    test('a non-false return (undefined) closes normally — the veto is exact', () => {
        let called = 0;
        const modal = openModal('mwt-veto-undef', { onClose: () => { called += 1; } });

        doc.pressKey('Escape');

        expect(called).toBe(1);
        expect(modal.style.display).toBe('none');
    });
});


// ─── Same-id recreation: handler cleanup ──────────────────────────────────────

describe('re-creating a modal with the same id', () => {
    test('removes the old element, detaches its keydown handler, and the new modal owns Escape', () => {
        const first = openModal('mwt-same');
        expect(doc.listenerCount('keydown')).toBe(1);
        // Wrap (not replace) the cleanup the production code stashed on the
        // old element, so the real removal still happens while we observe it.
        const realCleanup = first._cleanupKeyHandler;
        expect(typeof realCleanup).toBe('function');
        const cleanupSpy = vi.fn(() => realCleanup());
        first._cleanupKeyHandler = cleanupSpy;

        const second = createModal({ id: 'mwt-same', title: 'again', content: '' });
        showModal('mwt-same');

        expect(cleanupSpy).toHaveBeenCalledTimes(1);
        expect(first.parentNode).toBeNull(); // old element detached from the DOM
        expect(doc.getElementById('mwt-same')).toBe(second);
        expect(doc.listenerCount('keydown')).toBe(1); // exactly one live handler

        // The OLD modal must not react to Escape any more…
        doc.pressKey('Escape');
        expect(first.style.display).toBe('flex');
        expect(second.style.display).toBe('none'); // …but the NEW one does.
    });
});

// ─── showModal / hideModal by id ───────────────────────────────────────────────

describe('showModal / hideModal', () => {
    test('show sets display flex and hide sets display none', () => {
        createModal({ id: 'mwt-sh', title: 't', content: '' });
        expect(doc.getElementById('mwt-sh').style.display).toBe('none');

        showModal('mwt-sh');
        expect(doc.getElementById('mwt-sh').style.display).toBe('flex');

        hideModal('mwt-sh');
        expect(doc.getElementById('mwt-sh').style.display).toBe('none');
    });

    test('an unknown id is a quiet no-op for both', () => {
        expect(() => { showModal('mwt-missing'); }).not.toThrow();
        expect(() => { hideModal('mwt-missing'); }).not.toThrow();
    });
});

// ─── setStatus timing (incl. the CORE-03 fix) ─────────────────────────────────

describe('setStatus', () => {
    test('writes the message and the type class, visible immediately', () => {
        const modal = openModal('mwt-status');

        setStatus(modal, 'Importing…', 'info');

        const statusEl = modal.querySelector('.mwt-status');
        expect(statusEl.textContent).toBe('Importing…');
        expect(statusEl.className).toBe('mwt-status mwt-status-info');
        expect(statusEl.style.opacity).toBe('1');
    });

    test('a transient message fades out after clearAfterMs', () => {
        vi.useFakeTimers();
        const modal = openModal('mwt-fade');

        setStatus(modal, 'Saved.', 'success', 3000);
        vi.advanceTimersByTime(2999);
        expect(modal.querySelector('.mwt-status').style.opacity).toBe('1');

        vi.advanceTimersByTime(1);
        expect(modal.querySelector('.mwt-status').style.opacity).toBe('0');
    });

    test('CORE-03: a later persistent message cancels the stale auto-fade timer', () => {
        vi.useFakeTimers();
        const modal = openModal('mwt-core03');

        setStatus(modal, 'Working…', 'info', 3000);           // transient
        setStatus(modal, 'Done — kept on screen.', 'success'); // persistent (0)

        vi.advanceTimersByTime(10000);

        // The persistent message must NOT be faded by the earlier timer.
        expect(modal.querySelector('.mwt-status').style.opacity).toBe('1');
        expect(modal.querySelector('.mwt-status').textContent).toBe('Done — kept on screen.');
    });
});

