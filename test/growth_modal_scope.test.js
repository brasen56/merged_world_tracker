/**
 * test/growth_modal_scope.test.js — Growth Profile modal opening guards.
 *
 * openGrowthProfileModal is async: it awaits the growth/evidence module
 * imports and the profile lorebook read BEFORE the modal node exists. Two
 * failure modes are pinned here:
 *
 *   1. A chat change during that window. The chat-change sweeps
 *      (knowledge/index.js onChatChanged / onChatChangedWhilePaused) remove
 *      #kt-growth-modal, but they cannot remove a modal that is not in the
 *      DOM yet — without a scope recheck the OLD chat's modal was appended
 *      into the NEW chat, and its evidence-editing / Save-to-Lorebook
 *      handlers then acted on the new chat's stores.
 *   2. Rapid clicks. Both clicks could pass the (nonexistent) singleton
 *      check during the await window and stack two #kt-growth-modal nodes.
 *
 * The harness drives the REAL openGrowthProfileModal against a minimal fake
 * DOM — the relationship_graph_zoom.test.js pattern (FakeEl + a global
 * document stub), extended with getElementById for the singleton check.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import { resetCoreStubs, setFakeChat } from './stubs/core.js';
import { bumpEpoch, _resetEpoch } from '../core/scope.js';
import { state } from '../knowledge/state.js';
import { saveSettings } from '../knowledge/settings.js';

// ─── Minimal fake DOM ────────────────────────────────────────────────────────

class FakeEl {
    constructor(tag) {
        this.tagName = tag;
        this.attributes = new Map();
        this.children = [];
        this.style = {};
        this.listeners = new Map();
        this.textContent = '';
        this.dataset = {};
        this.parentNode = null;
        this.disabled = false;
        this.value = '';
        this._innerHTML = '';
        this._queryStubs = new Map();
    }

    get id() { return this.getAttribute('id') || ''; }
    set id(v) { this.setAttribute('id', v); }

    get className() { return this.getAttribute('class') || ''; }
    set className(v) { this.setAttribute('class', v); }

    get innerHTML() { return this._innerHTML; }
    set innerHTML(v) {
        // A real browser would parse this markup into child nodes; the fake
        // stores the string. Selectors the wiring code needs as ELEMENTS
        // (.mwt-modal-close, .kt-growth-content, …) are served by the
        // auto-stub in querySelector below, memoized so repeated queries
        // return the same node (the close button and the content element are
        // each looked up more than once).
        this._innerHTML = String(v);
        this._queryStubs.clear();
    }

    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    removeAttribute(name) { this.attributes.delete(name); }

    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    removeChild(child) {
        const i = this.children.indexOf(child);
        if (i >= 0) { this.children.splice(i, 1); child.parentNode = null; }
        return child;
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    get firstChild() { return this.children[0] || null; }

    * walk() { for (const c of this.children) { yield c; yield* c.walk(); } }

    _matches(selector) {
        if (selector.startsWith('.')) {
            const cls = selector.slice(1).split(/[.\[:]/)[0];
            return (this.getAttribute('class') || '').split(/\s+/).includes(cls);
        }
        return false;
    }

    querySelectorAll(selector) {
        if (selector.startsWith('#')) {
            const id = selector.slice(1);
            return [...this.walk()].filter(el => el.id === id);
        }
        return [...this.walk()].filter(el => el._matches(selector));
    }

    querySelector(selector) {
        // Real tree first (the appended modal is a real node)…
        if (selector.startsWith('#')) {
            const id = selector.slice(1);
            if (this.id === id) return this;
            const found = [...this.walk()].find(el => el.id === id);
            if (found) return found;
        } else {
            const found = this.querySelectorAll(selector)[0];
            if (found) return found;
        }
        // …then a memoized stub for elements the innerHTML string would have
        // created in a real browser (see the innerHTML setter note).
        if (!this._queryStubs.has(selector)) this._queryStubs.set(selector, new FakeEl('div'));
        return this._queryStubs.get(selector);
    }

    addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(fn);
    }
    removeEventListener(type, fn) {
        const list = this.listeners.get(type) || [];
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
    }
    dispatch(type, ev) { return (this.listeners.get(type) || []).map(fn => fn(ev)); }
}

// ─── Harness ─────────────────────────────────────────────────────────────────

let fakeChatId = 'chat-a';
let dispatchedEvents = [];
let consoleLogSpy;

beforeEach(async () => {
    resetCoreStubs();
    _resetEpoch();
    fakeChatId = 'chat-a';
    dispatchedEvents = [];
    setFakeChat([{ mes: 'hello' }]);
    // captureScope()/scopeStillCurrent() read the host context directly via
    // SillyTavern.getContext — the same source core/scope.js uses in
    // production. fakeChatId lets a test simulate the switch to another chat.
    globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => fakeChatId }) };

    const body = new FakeEl('body');
    globalThis.document = {
        createElement: (tag) => new FakeEl(tag),
        getElementById: (id) => [...body.walk()].find(el => el.id === id) || null,
        body,
        addEventListener() { },
        removeEventListener() { },
        dispatchEvent(ev) { dispatchedEvents.push(ev.type); },
        querySelector: () => null,
        querySelectorAll: () => [],
    };
    globalThis.CustomEvent = class CustomEvent {
        constructor(type, opts) { this.type = type; Object.assign(this, opts); }
    };

    // Global scope + a seeded registry so loadProfile's getProfileUid path
    // resolves against the store cache (Mara has no profileUid → loadProfile
    // returns null without touching the lorebook).
    saveSettings({ scope: 'global' });
    const { _clearCacheForTests, _setCacheForTests } = await import('../knowledge/store.js');
    _clearCacheForTests();
    _setCacheForTests('Knowledge Tracker', {
        registry: { Mara: { uid: 7, type: 'minor', keywords: ['Mara'], entityId: 'mwt_mara', aliases: [] } },
    });

    // Fresh unread badge so the happy path exercises the clear + dispatch.
    state.unreadGrowthEvidenceCount = 2;

    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.SillyTavern;
    delete globalThis.document;
    delete globalThis.CustomEvent;
});

async function open(name = 'Mara') {
    const { openGrowthProfileModal } = await import('../knowledge/render.js');
    return openGrowthProfileModal(name, new FakeEl('button'));
}

function growthModalCount() {
    return [...globalThis.document.body.walk()].filter(el => el.id === 'kt-growth-modal').length;
}

// ─── Guards ──────────────────────────────────────────────────────────────────

describe('openGrowthProfileModal scope + singleton guards', () => {
    test('opens exactly one modal and clears the unread evidence badge', async () => {
        await open();
        expect(globalThis.document.getElementById('kt-growth-modal')).toBeTruthy();
        expect(growthModalCount()).toBe(1);
        expect(state.unreadGrowthEvidenceCount).toBe(0);
        expect(dispatchedEvents).toContain('mwt:busy-changed');
    });

    test('a second open while the modal is already open is a no-op', async () => {
        await open();
        await open();
        expect(growthModalCount()).toBe(1);
    });

    test('rapid double-clicks during the opening awaits create a single modal', async () => {
        // Both calls start before the first one's awaits resolve — the
        // in-flight flag, not the DOM check, must collapse them.
        const first = open();
        const second = open();
        await Promise.all([first, second]);
        expect(growthModalCount()).toBe(1);
    });

    test('a chat change during the opening awaits discards the modal before it is appended', async () => {
        const { openGrowthProfileModal } = await import('../knowledge/render.js');
        // Call the modal opener DIRECTLY (not through the async open() helper):
        // it then runs synchronously up to its first await, so captureScope()
        // has already fired when the chat change lands below — deterministic,
        // exactly the production window between capture and append.
        const opening = openGrowthProfileModal('Mara', new FakeEl('button'));
        // The chat changes while the opening awaits are still pending: the
        // epoch bumps and the chat id switches. The sweep has nothing to
        // remove yet (no #kt-growth-modal in the DOM), so only the scope
        // recheck can stop the stale append.
        fakeChatId = 'chat-b';
        bumpEpoch();
        await opening;
        expect(globalThis.document.getElementById('kt-growth-modal')).toBeNull();
        expect(growthModalCount()).toBe(0);
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('the chat changed'));
    });
});
