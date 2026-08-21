/**
 * test/scope_storage_tab.test.js — Diagnostics Phase 8 (Tab 3: Scope & storage).
 *
 * Covers the three layers of the Scope & storage tab, mirroring the Phase 6/7
 * suites:
 *   1. diagnostics_panel/scope_storage.js — the read-only resolution mirror
 *      (explainBookResolution: every mode of knowledge/scope.js
 *      resolveBookNames(), derived WITHOUT saving a binding) and the snapshot
 *      collector with injected scope/store/settings/epoch/events deps
 *      (hydration + store version rows, bindings, the Phase 3
 *      scope_fallback_global counter read from the REAL event ring, per-field
 *      degradation).
 *   2. knowledge/store.js — peekStore(), the read-only slot view this phase
 *      adds (null for untouched books, no slot creation).
 *   3. diagnostics_panel/render.js — renderScopeSnapshot() /
 *      renderScopePane() string builders (banner tones, badges, escaping)
 *      plus the pane switch that mounts the sub-tab.
 *
 * The final smoke test exercises the DEFAULT wiring (real knowledge/* graph
 * under the barrel→stub alias) — it exists to catch import-graph breakage,
 * not to assert live values.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
    explainBookResolution,
    collectScopeSnapshot,
    SCOPE_BOOK_SPECS,
    GLOBAL_BOOK_NAMES,
} from '../diagnostics_panel/scope_storage.js';
import {
    renderScopePane,
    renderScopeSnapshot,
    renderDiagnosticsPanel,
} from '../diagnostics_panel/render.js';
import { peekStore, isHydrated, _setCacheForTests, _clearCacheForTests } from '../knowledge/store.js';
import { shortHash } from '../knowledge/scope.js';
import { record, getEvents, _resetDiagnostics } from '../core/diagnostics.js';
import { MWT_VERSION } from '../core/version.js';

// ─── Fakes ───────────────────────────────────────────────────────────────────

const CHAR = { key: 'char:seraphina.png', name: 'Seraphina', isGroup: false };
const CHAT = { key: 'chat:2026-08-17@0001', name: '2026-08-17@0001' };

/** Default deps: everything injected, nothing live. */
function deps(extra = {}) {
    return {
        scopeApi: {
            getCharacterIdentity: () => CHAR,
            getChatIdentity: () => CHAT,
        },
        storeApi: { peekStore: () => null },
        getKnowledgeSettings: () => ({ scope: 'global', bookBindings: {} }),
        epoch: () => 7,
        events: () => [],
        version: '9.9.9-test',
        currentStoreVersion: 1,
        now: () => 1_700_000_000_000,
        ...extra,
    };
}

const T = () => '12:00:00';

beforeEach(() => {
    _resetDiagnostics();
    _clearCacheForTests();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

// ─── explainBookResolution — the read-only mirror of resolveBookNames ─────────

describe('explainBookResolution — every resolveBookNames() mode, read-only', () => {
    test('global scope → the three global book names, no identity', () => {
        const r = explainBookResolution({ scope: 'global' });
        expect(r.mode).toBe('global');
        expect(r.valid).toBe(true);
        expect(r.identityKey).toBeNull();
        expect(r.books).toEqual(GLOBAL_BOOK_NAMES);
        expect(r.wouldSaveBinding).toBe(false);
    });

    test('invalid scope value → normalized to global with the invalid value named', () => {
        const r = explainBookResolution({ scope: 'planetary' });
        expect(r.mode).toBe('global');
        expect(r.valid).toBe(false);
        expect(r.scope).toBe('global');
        expect(r.note).toContain('planetary');
        expect(r.note).toContain('not one of');
    });

    test('character scope with a saved binding → binding books, survives renames', () => {
        const binding = { knowledge: 'Knowledge Tracker - Old Name', state: 'State Tracker - Old Name', profiles: 'NPC Profiles - Old Name' };
        const r = explainBookResolution({
            scope: 'character',
            character: { ...CHAR, name: 'Renamed Since' },
            bindings: { [CHAR.key]: binding },
        });
        expect(r.mode).toBe('saved-binding');
        expect(r.books).toEqual(binding);
        expect(r.wouldSaveBinding).toBe(false);
    });

    test('character scope, no binding yet → newly-derived names flagged as save-on-next-resolve', () => {
        const r = explainBookResolution({ scope: 'character', character: CHAR });
        expect(r.mode).toBe('newly-derived');
        expect(r.books.knowledge).toBe('Knowledge Tracker - Seraphina');
        expect(r.wouldSaveBinding).toBe(true);
        expect(r.note).toContain('read-only');
    });

    test('chat scope with the chat unidentifiable → fallback to the GLOBAL books', () => {
        const r = explainBookResolution({ scope: 'chat', character: CHAR, chat: null });
        expect(r.mode).toBe('fallback-global');
        expect(r.books).toEqual(GLOBAL_BOOK_NAMES);
        expect(r.note).toContain('GLOBAL');
    });

    test('a name that sanitises to nothing → sanitize-fallback-global, deliberately unbound', () => {
        const r = explainBookResolution({ scope: 'character', character: { key: 'char:q.png', name: '???' } });
        expect(r.mode).toBe('sanitize-fallback-global');
        expect(r.books.knowledge).toBe(GLOBAL_BOOK_NAMES.knowledge);
        expect(r.wouldSaveBinding).toBe(false);
    });

    test('two cards sharing a display name → collision-disambiguated with the identity-key hash', () => {
        const taken = { knowledge: 'Knowledge Tracker - Mara', state: 'State Tracker - Mara', profiles: 'NPC Profiles - Mara' };
        const other = 'char:mara-v1.png';
        const me = { key: 'char:mara-v2.png', name: 'Mara' };
        const r = explainBookResolution({ scope: 'character', character: me, bindings: { [other]: taken } });
        expect(r.mode).toBe('collision-disambiguated');
        expect(r.books.knowledge).toBe(`Knowledge Tracker - Mara (${shortHash('char:mara-v2.png')})`);
        expect(r.wouldSaveBinding).toBe(true);
    });
});

// ─── collectScopeSnapshot ─────────────────────────────────────────────────────

describe('collectScopeSnapshot — header, books, bindings', () => {
    test('carries version, generation time, epoch, and the scope setting', () => {
        const snap = collectScopeSnapshot(deps());
        expect(snap.mwtVersion).toBe('9.9.9-test');
        expect(snap.generatedAt).toBe(1_700_000_000_000);
        expect(snap.epoch).toBe(7);
        expect(snap.scopeSetting).toEqual({ value: 'global', valid: true });
        expect(snap.character).toEqual(CHAR);
        expect(snap.chat).toEqual(CHAT);
    });

    test('one row per book spec; profiles has no store', () => {
        const snap = collectScopeSnapshot(deps());
        expect(snap.books.map((b) => b.id)).toEqual(SCOPE_BOOK_SPECS.map((s) => s.id));
        expect(snap.books.map((b) => b.hasStore)).toEqual(SCOPE_BOOK_SPECS.map((s) => s.hasStore));
        const byId = Object.fromEntries(snap.books.map((b) => [b.id, b]));
        expect(byId.knowledge.name).toBe(GLOBAL_BOOK_NAMES.knowledge);
        expect(byId.profiles.hasStore).toBe(false);
        expect(byId.knowledge.hasStore).toBe(true);
    });

    test('hydration, dirty, and store version come from the read-only peek', () => {
        const snap = collectScopeSnapshot(deps({
            getKnowledgeSettings: () => ({ scope: 'character', bookBindings: {} }),
            storeApi: {
                peekStore: (name) => (name.startsWith('Knowledge')
                    ? { hydrated: true, dirty: true, version: 1, fields: ['version', 'registry'] }
                    : { hydrated: true, dirty: false, version: 1, fields: ['version'] }),
            },
        }));
        const byId = Object.fromEntries(snap.books.map((b) => [b.id, b]));
        expect(byId.knowledge.hydrated).toBe(true);
        expect(byId.knowledge.dirty).toBe(true);
        expect(byId.knowledge.storeVersion).toBe(1);
        expect(byId.knowledge.currentStoreVersion).toBe(1);
        // Fully hydrated + matching versions + scoped resolution → quiet banner.
        expect(snap.bannerLevel).toBe('ok');
        expect(snap.warnings).toEqual([]);
    });

    test('bindings are listed with the current one marked', () => {
        const binding = { knowledge: 'KT - A', state: 'ST - A', profiles: 'NP - A' };
        const snap = collectScopeSnapshot(deps({
            getKnowledgeSettings: () => ({
                scope: 'character',
                bookBindings: { [CHAR.key]: binding, 'char:other.png': { knowledge: 'KT - B', state: 'ST - B', profiles: 'NP - B' } },
            }),
        }));
        expect(snap.bindings.count).toBe(2);
        const current = snap.bindings.rows.find((r) => r.key === CHAR.key);
        const other = snap.bindings.rows.find((r) => r.key === 'char:other.png');
        expect(current.isCurrent).toBe(true);
        expect(current.knowledge).toBe('KT - A');
        expect(other.isCurrent).toBe(false);
        expect(snap.resolution.mode).toBe('saved-binding');
    });

    test('READ-ONLY: collecting never mutates settings or adds a binding', () => {
        const settings = { scope: 'character', bookBindings: {} };
        const before = JSON.stringify(settings);
        collectScopeSnapshot(deps({ getKnowledgeSettings: () => settings }));
        expect(JSON.stringify(settings)).toBe(before);
        expect(Object.keys(settings.bookBindings)).toHaveLength(0);
    });
});

describe('collectScopeSnapshot — warnings & the Phase 3 counter', () => {
    test('live fallback to global books → warn banner + warning id, with the store loaded', () => {
        const snap = collectScopeSnapshot(deps({
            getKnowledgeSettings: () => ({ scope: 'chat', bookBindings: {} }),
            scopeApi: { getCharacterIdentity: () => CHAR, getChatIdentity: () => null },
            storeApi: { peekStore: () => ({ hydrated: true, dirty: false, version: 1, fields: [] }) },
        }));
        expect(snap.resolution.mode).toBe('fallback-global');
        expect(snap.bannerLevel).toBe('warn');
        expect(snap.warnings.map((w) => w.id)).toContain('scope-fallback-live');
    });

    // peekStore() returns null for "no cache slot" and { hydrated: false } for
    // "slot exists, load failed". hydrateBook() creates the slot synchronously
    // before its first await, so those two are genuinely different states —
    // and only the second is a fault. Conflating them paints "writes are
    // blocked" over a panel that is merely early, which is guaranteed right
    // after resetStoreCache() clears the cache on a chat change.
    test('a FAILED Knowledge store load is the one fail-level state (writes blocked)', () => {
        const snap = collectScopeSnapshot(deps({
            storeApi: { peekStore: () => ({ hydrated: false, dirty: false, version: null, fields: [] }) },
        }));
        expect(snap.bannerLevel).toBe('fail');
        expect(snap.warnings.map((w) => w.id)).toContain('knowledge-store-load-failed');
        const knowledge = snap.books.find((b) => b.id === 'knowledge');
        expect(knowledge.storeState).toBe('failed');
        expect(knowledge.hydrated).toBe(false);
    });

    test('a store never hydrated yet is amber, not red — it is the ordinary early state', () => {
        const snap = collectScopeSnapshot(deps());   // default peekStore → null
        expect(snap.bannerLevel).toBe('warn');
        const ids = snap.warnings.map((w) => w.id);
        expect(ids).toContain('knowledge-store-not-attempted');
        expect(ids).not.toContain('knowledge-store-load-failed');
        const knowledge = snap.books.find((b) => b.id === 'knowledge');
        expect(knowledge.storeState).toBe('not-attempted');
        // The note must point at the timing, not at a fault to chase.
        expect(snap.warnings.find((w) => w.id === 'knowledge-store-not-attempted').text)
            .toMatch(/hydration runs on chat change/i);
    });

    test('store version mismatch → warning naming both versions', () => {
        const snap = collectScopeSnapshot(deps({
            storeApi: { peekStore: () => ({ hydrated: true, dirty: false, version: 0, fields: [] }) },
        }));
        expect(snap.warnings.map((w) => w.id)).toContain('store-version-mismatch');
        expect(snap.bannerLevel).toBe('warn');
    });

    test('scope_fallback_global events from the ring → count, newest last-event, and a warning', () => {
        const snap = collectScopeSnapshot(deps({
            events: () => [
                { ts: 200, epoch: 3, event: 'scope_fallback_global', module: 'knowledge', detail: { scope: 'chat' }, scopeKey: 'unknown:2' },
                { ts: 100, epoch: 1, event: 'scope_fallback_global', module: 'knowledge', detail: { scope: 'chat' }, scopeKey: 'unknown:1' },
                { ts: 150, epoch: 2, event: 'something_else', module: 'knowledge' },
            ],
            storeApi: { peekStore: () => ({ hydrated: true, dirty: false, version: 1, fields: [] }) },
        }));
        expect(snap.fallbackEvents.count).toBe(2);
        expect(snap.fallbackEvents.last).toMatchObject({ ts: 200, epoch: 3, scope: 'chat' });
        expect(snap.warnings.map((w) => w.id)).toContain('scope-fallback-events');
    });

    test('integration: events read from the REAL Phase 0 ring (record() → getEvents)', () => {
        record({ level: 'warn', module: 'knowledge', event: 'scope_fallback_global', detail: { scope: 'chat' } });
        record({ level: 'warn', module: 'api', event: 'json_repaired' });
        const snap = collectScopeSnapshot({ ...deps(), events: getEvents });
        expect(snap.fallbackEvents.count).toBe(1);
        expect(snap.fallbackEvents.last.scope).toBe('chat');
    });

    test('a throwing accessor degrades its field into errors without blanking the tab', () => {
        const snap = collectScopeSnapshot(deps({
            scopeApi: { getCharacterIdentity: () => { throw new Error('ctx exploded'); }, getChatIdentity: () => CHAT },
        }));
        expect(snap.errors.some((e) => e.startsWith('characterIdentity:'))).toBe(true);
        expect(snap.chat).toEqual(CHAT);
        expect(snap.books).toHaveLength(3);
    });
});

// ─── peekStore — the read-only slot view (knowledge/store.js) ─────────────────

describe('peekStore — read-only, creates nothing', () => {
    test('an untouched book peeks null and stays absent from the cache', () => {
        expect(peekStore('Never Touched')).toBeNull();
        // Reading must not have CREATED a slot (isHydrated installs nothing).
        expect(peekStore('Never Touched')).toBeNull();
        expect(isHydrated('Never Touched')).toBe(false);
    });

    test('a seeded book reports hydration, dirty, version, and its field names', () => {
        _setCacheForTests('Knowledge Tracker - Seraphina', { registry: { Mara: { uid: 5 } } });
        const peek = peekStore('Knowledge Tracker - Seraphina');
        expect(peek).toMatchObject({ hydrated: true, dirty: false, version: 1 });
        expect(peek.fields).toEqual(expect.arrayContaining(['version', 'registry']));
    });
});

// ─── renderScopeSnapshot — the pane markup ────────────────────────────────────

describe('renderScopeSnapshot — banner tones, badges, escaping', () => {
    test('a clean scoped resolution renders the quiet ok banner', () => {
        const html = renderScopeSnapshot(collectScopeSnapshot(deps({
            getKnowledgeSettings: () => ({ scope: 'character', bookBindings: {} }),
            storeApi: { peekStore: () => ({ hydrated: true, dirty: false, version: 1, fields: [] }) },
        })), { formatTime: T });
        expect(html).toContain('mwt-diag-scope-banner--ok');
        expect(html).toContain('lorebook resolution: newly-derived');
        expect(html).not.toContain('mwt-diag-scope-warnings');
    });

    test('the fallback-to-global warning is loud: warn banner + GLOBAL named + warning listed', () => {
        const snap = collectScopeSnapshot(deps({
            getKnowledgeSettings: () => ({ scope: 'chat', bookBindings: {} }),
            scopeApi: { getCharacterIdentity: () => CHAR, getChatIdentity: () => null },
            storeApi: { peekStore: () => ({ hydrated: true, dirty: false, version: 1, fields: [] }) },
        }));
        const html = renderScopeSnapshot(snap, { formatTime: T });
        expect(html).toContain('mwt-diag-scope-banner--warn');
        expect(html).toContain('GLOBAL lorebooks');
        expect(html).toContain('mwt-diag-scope-warnings');
    });

    test('a FAILED store load renders the fail banner and a red badge', () => {
        const snap = collectScopeSnapshot(deps({
            storeApi: { peekStore: () => ({ hydrated: false, dirty: false, version: null, fields: [] }) },
        }));
        const html = renderScopeSnapshot(snap, { formatTime: T });
        expect(html).toContain('mwt-diag-scope-banner--fail');
        expect(html).toContain('>load failed<');
        expect(html).toContain('mwt-diag-badge--fail');
        expect(html).toContain('writes blocked');
    });

    test('a not-yet-hydrated store renders amber and says so, never "writes blocked"', () => {
        const html = renderScopeSnapshot(collectScopeSnapshot(deps()), { formatTime: T });
        expect(html).toContain('mwt-diag-scope-banner--warn');
        expect(html).not.toContain('mwt-diag-scope-banner--fail');
        expect(html).toContain('>not loaded yet<');
        expect(html).not.toContain('writes blocked');
    });

    test('hydration badges, dirty marker, versions, epoch, and the events line render', () => {
        const snap = collectScopeSnapshot(deps({
            storeApi: {
                peekStore: (name) => (name.startsWith('Knowledge')
                    ? { hydrated: true, dirty: true, version: 1, fields: [] }
                    : { hydrated: true, dirty: false, version: 1, fields: [] }),
            },
            events: () => [{ ts: 123, epoch: 4, event: 'scope_fallback_global', module: 'knowledge', detail: { scope: 'chat' } }],
        }));
        const html = renderScopeSnapshot(snap, { formatTime: T });
        expect(html).toContain('>loaded<');
        expect(html).toContain('>dirty<');
        expect(html).toContain('>v1<');
        expect(html).toContain('epoch <strong>7</strong>');
        expect(html).toContain('fired 1× this session');
        expect(html).toContain('epoch 4');
    });

    test('a version mismatch states both versions in the cell', () => {
        const html = renderScopeSnapshot(collectScopeSnapshot(deps({
            storeApi: { peekStore: () => ({ hydrated: true, dirty: false, version: 0, fields: [] }) },
        })), { formatTime: T });
        expect(html).toContain('<td>v0');
        expect(html).toContain('(code: v1)');
    });

    test('bindings render with the ● current marker; the empty state explains itself', () => {
        const withBindings = renderScopeSnapshot(collectScopeSnapshot(deps({
            getKnowledgeSettings: () => ({ scope: 'character', bookBindings: { [CHAR.key]: { knowledge: 'KT - A', state: 'ST - A', profiles: 'NP - A' } } }),
        })), { formatTime: T });
        expect(withBindings).toContain('mwt-diag-scope-current');
        expect(withBindings).toContain('KT - A');

        const empty = renderScopeSnapshot(collectScopeSnapshot(deps()), { formatTime: T });
        expect(empty).toContain('No bindings saved yet');
    });

    test('escapes user-derived identity, book, and binding strings', () => {
        const hostile = { key: 'char:<script>x</script>.png', name: '<img src=x onerror=alert(1)>' };
        const snap = collectScopeSnapshot(deps({
            scopeApi: { getCharacterIdentity: () => hostile, getChatIdentity: () => CHAT },
        }));
        const html = renderScopeSnapshot(snap, { formatTime: T });
        expect(html).not.toContain('<img src=x');
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;img src=x');
        expect(html).toContain('&lt;script&gt;');
    });
});

// ─── Pane mounting + default-wiring smoke ─────────────────────────────────────

describe('renderScopePane (default wiring)', () => {
    test('collects and renders against the real knowledge graph without throwing', () => {
        const html = renderScopePane();
        // Not asserting live values (state depends on stubbed context) — only
        // that the default wiring resolves end-to-end and renders the tables.
        expect(html).toContain('mwt-diag-scope');
        expect(html).toContain('lorebook resolution:');
        // The real version constant flows through (direct core/version.js
        // import — the §II.3 alias trap).
        expect(html).toContain(`MWT v${MWT_VERSION}`);
    });

    test('the panel shell mounts the Scope pane instead of its placeholder', () => {
        const html = renderDiagnosticsPanel();
        expect(html).toContain('data-diag-tab="scope"');
        // The real pane rendered (not the Phase 8 placeholder card)…
        expect(html).toContain('lorebook resolution:');
        expect(html).not.toContain('Phase 8 — not built yet');
        // …while later tabs still show their placeholders (Phase 11 landed
        // 2026-08-21 — its suite owns the log-pane assertion now).
        expect(html).toContain('Phase 12 — not built yet');
    });
});
