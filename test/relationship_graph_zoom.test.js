/**
 * test/relationship_graph_zoom.test.js — Relationship graph wheel-zoom wiring.
 *
 * The graph hint promises "Scroll to zoom". These tests drive the REAL render
 * pipeline (renderNpcsSubTab → renderRelationshipGraph →
 * wireRelationshipGraphInteractions) against a minimal fake DOM and then fire
 * the registered 'wheel' listener directly, so a regression in the wiring
 * (listener never attached, viewBox math producing NaN, zoom stuck at the
 * clamp bounds) fails here instead of being discovered in the UI.
 *
 * Browser fidelity notes for the fake DOM:
 *   - `svg.viewBox.baseVal` is a LIVE reflection of the viewBox attribute
 *     (that is how SVGSVGElement behaves), so the wiring code reads the
 *     same {x,y,w,h} it would in a real browser.
 *   - `getBoundingClientRect()` returns a realistic element box whose aspect
 *     ratio does NOT match the 600×400 viewBox, matching the production CSS
 *     (width:100%; height:420px under preserveAspectRatio="xMidYMid meet").
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import { resetCoreStubs } from './stubs/core.js';
import { _clearCacheForTests, _setCacheForTests } from '../knowledge/store.js';
import { getLorebookName } from '../knowledge/scope.js';
import { updateRelationship } from '../knowledge/relationships.js';
import { state } from '../knowledge/state.js';

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
        this._innerHTML = '';
    }

    get id() { return this.getAttribute('id') || ''; }
    set id(v) { this.setAttribute('id', v); }

    get className() { return this.getAttribute('class') || ''; }
    set className(v) { this.setAttribute('class', v); }

    get innerHTML() { return this._innerHTML; }
    set innerHTML(v) {
        // The real innerHTML parse creates the #kt-rel-graph svg. The harness
        // pre-attaches a fake svg under the modal instead; storing the string
        // is enough for content assertions.
        this._innerHTML = String(v);
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
        if (selector.startsWith('#')) {
            const id = selector.slice(1);
            if (this.id === id) return this;
            return [...this.walk()].find(el => el.id === id) || null;
        }
        return this.querySelectorAll(selector)[0] || null;
    }

    addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(fn);
    }
    removeEventListener() { /* not needed by the graph path */ }
    setPointerCapture() { }
    releasePointerCapture() { }
    dispatch(type, ev) { return (this.listeners.get(type) || []).map(fn => fn(ev)); }
}

/** Faithful-enough SVGSVGElement: live viewBox reflection + real layout box. */
class FakeSvg extends FakeEl {
    constructor() {
        super('svg');
        // Realistic production box: content column is wider than 600px, fixed
        // 420px height (knowledge/style.css .kt-rel-graph).
        this.rect = { left: 100, top: 50, width: 800, height: 420 };
    }

    get viewBox() {
        const self = this;
        return {
            // REAL browser semantics: baseVal is an SVGRect exposing
            // x/y/width/height — there are NO `w`/`h` properties. Faking
            // w/h here once let the wiring bug below slip through, so this
            // fake must stay faithful to the actual SVGRect interface.
            get baseVal() {
                const parts = (self.getAttribute('viewBox') || '0 0 0 0')
                    .trim().split(/\s+/).map(Number);
                return { x: parts[0] || 0, y: parts[1] || 0, width: parts[2] || 0, height: parts[3] || 0 };
            },
        };
    }

    getBoundingClientRect() { return { ...this.rect }; }
    getScreenCTM() { return null; } // drag path is guarded against a null CTM
    createSVGPoint() { return { x: 0, y: 0 }; }
}

function installGlobals() {
    globalThis.document = {
        createElementNS: (_ns, tag) => new FakeEl(tag),
        createElement: (tag) => new FakeEl(tag),
        body: new FakeEl('body'),
        addEventListener() { },
        removeEventListener() { },
        dispatchEvent() { },
        querySelector: () => null,
        querySelectorAll: () => [],
    };
    globalThis.CustomEvent = class CustomEvent {
        constructor(type, opts) { this.type = type; Object.assign(this, opts); }
    };
    globalThis.requestAnimationFrame = (cb) => cb();
}

// ─── Harness ─────────────────────────────────────────────────────────────────

let modal;
let contentEl;
let svg;

async function renderRelationshipsTab() {
    const { renderNpcsSubTab } = await import('../knowledge/render.js');
    state.activeSubTab = 'relationships';
    state.relViewMode = 'graph';
    state.modal = modal;
    state.npcsContentEl = contentEl;
    renderNpcsSubTab();
}

function parseViewBox(el) {
    return (el.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number);
}

function fireWheel(delta) {
    let prevented = false;
    svg.dispatch('wheel', {
        // Centre of the svg box in viewport coordinates.
        clientX: svg.rect.left + svg.rect.width / 2,
        clientY: svg.rect.top + svg.rect.height / 2,
        deltaY: delta,
        preventDefault() { prevented = true; },
    });
    return prevented;
}

beforeEach(async () => {
    resetCoreStubs();
    _clearCacheForTests();
    _setCacheForTests(getLorebookName(), {});
    vi.spyOn(console, 'warn').mockImplementation(() => { });

    installGlobals();

    modal = new FakeEl('div');
    contentEl = new FakeEl('div');
    contentEl.setAttribute('class', 'mwt-tab-content');
    contentEl.setAttribute('data-tab', 'knowledge');
    modal.appendChild(contentEl);

    // The element `renderRelationshipGraph` looks up inside state.modal.
    svg = new FakeSvg();
    svg.setAttribute('id', 'kt-rel-graph');
    modal.appendChild(svg);

    // Two NPCs, one bidirectional pair + one single edge → non-trivial graph.
    updateRelationship('Mara', 'Jonah', 'friend', '');
    updateRelationship('Jonah', 'Mara', 'rival', '');
    updateRelationship('Mara', 'Old Pete', 'mentor', '');

    await renderRelationshipsTab();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('relationship graph wheel zoom', () => {
    test('renders nodes and registers a wheel listener', () => {
        expect(svg.querySelectorAll('.kt-rel-graph-node').length).toBe(3);
        expect(svg.listeners.has('wheel')).toBe(true);
    });

    test('wheel-up zooms in: viewBox narrows around the cursor', () => {
        expect(fireWheel(-100)).toBe(true); // preventDefault called
        const [x, y, w, h] = parseViewBox(svg);
        // 0.9 factor from 600×400, anchored at the rect centre (mx=my=0.5).
        expect(w).toBeCloseTo(540, 6);
        expect(h).toBeCloseTo(360, 6);
        expect(x).toBeCloseTo(30, 6);
        expect(y).toBeCloseTo(20, 6);
        // All finite — a NaN here is the classic "zoom silently does nothing".
        expect([x, y, w, h].every(Number.isFinite)).toBe(true);
    });

    test('wheel-down zooms out', () => {
        fireWheel(100);
        const [, , w] = parseViewBox(svg);
        expect(w).toBeCloseTo(660, 6);
    });

    test('zoom clamps instead of running away', () => {
        for (let i = 0; i < 40; i++) fireWheel(-100);
        expect(parseViewBox(svg)[2]).toBe(150);
        for (let i = 0; i < 80; i++) fireWheel(100);
        expect(parseViewBox(svg)[2]).toBe(2400);
    });

    test('the rendered hint matches what the wiring actually provides', () => {
        // If someone removes the wheel listener, the "Scroll to zoom" hint
        // becomes a lie — this pins hint text to handler presence.
        expect(contentEl.innerHTML).toContain('Scroll to zoom');
        expect(svg.listeners.has('wheel')).toBe(true);
    });
});

