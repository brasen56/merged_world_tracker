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
    gatherActivationState,
    classifyBookActivation,
    SCOPE_BOOK_SPECS,
    GLOBAL_BOOK_NAMES,
} from '../diagnostics_panel/scope_storage.js';
import {
    renderScopePane,
    renderScopeSnapshot,
    renderDiagnosticsPanel,
} from '../diagnostics_panel/render.js';
import { peekStore, isHydrated, _setCacheForTests, _clearCacheForTests, STORE_VERSION } from '../knowledge/store.js';
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

    test('a FAILED book reports the version observed on disk, never the placeholder', () => {
        const snap = collectScopeSnapshot(deps({
            storeApi: {
                peekStore: (name) => (name.startsWith('Knowledge')
                    ? { hydrated: false, dirty: false, version: 1, fields: [], observedVersion: 99 }
                    : { hydrated: true, dirty: false, version: 1, fields: [] }),
            },
        }));
        const byId = Object.fromEntries(snap.books.map((b) => [b.id, b]));
        expect(byId.knowledge.storeState).toBe('failed');
        // peek.version is blankStore()'s placeholder after a blocked load; the
        // on-disk v99 the failed load observed is what the table must show
        // (the §9.1 schema-status collector's rule, applied here too).
        expect(byId.knowledge.storeVersion).toBe(99);
        expect(byId.state.storeVersion).toBe(1);
    });

    test('a failed book whose on-disk version could not be read reports null, never the placeholder', () => {
        const snap = collectScopeSnapshot(deps({
            storeApi: {
                peekStore: () => ({ hydrated: false, dirty: false, version: 1, fields: [], observedVersion: null }),
            },
        }));
        const byId = Object.fromEntries(snap.books.map((b) => [b.id, b]));
        expect(byId.knowledge.storeState).toBe('failed');
        expect(byId.knowledge.storeVersion).toBeNull();
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

// ─── World Info activation probe ──────────────────────────────────────────────

describe('gatherActivationState — reads the four ST activation slots, read-only', () => {
    test('reads global select, chat-bound, character primary and additional', () => {
        const a = gatherActivationState({
            wiScript: {
                selected_world_info: ['Some Global Book', 'Knowledge Tracker'],
                world_info: { charLore: [{ name: 'seraphina', extraBooks: ['Extra Book'] }] },
            },
            ctx: {
                chatMetadata: { world_info: 'Chat Bound Book' },
                characterId: 0,
                characters: [{ avatar: 'seraphina.png', data: { extensions: { world: 'Primary Book' } } }],
            },
        });
        expect(a.globalReadable).toBe(true);
        expect(a.chatReadable).toBe(true);
        expect(a.charReadable).toBe(true);
        expect(a.detectable).toBe(true);
        expect(a.global).toContain('Knowledge Tracker');
        expect(a.chat).toBe('Chat Bound Book');
        expect(a.charPrimary).toBe('Primary Book');
        expect(a.charAdditional).toEqual(['Extra Book']);
    });

    test('matches charLore on the extension-stripped avatar filename (getCharaFilename rule)', () => {
        const a = gatherActivationState({
            wiScript: { selected_world_info: [], world_info: { charLore: [{ name: 'mara_v2', extraBooks: ['Mara Book'] }] } },
            ctx: { chatMetadata: {}, characterId: 0, characters: [{ avatar: 'mara_v2.png', data: {} }] },
        });
        expect(a.charAdditional).toEqual(['Mara Book']);
    });

    test('an absent global export leaves globalReadable false and undetectable', () => {
        const a = gatherActivationState({ wiScript: {}, ctx: { chatMetadata: {}, characters: [] } });
        expect(a.globalReadable).toBe(false);
        expect(a.detectable).toBe(false);
        expect(a.note).toMatch(/global selection/i);
    });

    test('a partially unreadable state is not detectable — absence proves nothing', () => {
        const a = gatherActivationState({
            wiScript: { selected_world_info: [] },
            ctx: { chatMetadata: {}, groupId: 7 }, // group: character slot not inspectable
        });
        expect(a.globalReadable).toBe(true);
        expect(a.chatReadable).toBe(true);
        expect(a.charReadable).toBe(false);
        expect(a.detectable).toBe(false);
        expect(a.note).toMatch(/character books/);
        expect(a.note).toMatch(/unknown/i);
    });

    test('an open chat with no bound book is readable but null (definite "not chat-bound")', () => {
        const a = gatherActivationState({
            wiScript: { selected_world_info: [] },
            ctx: { chatMetadata: {}, characterId: 0, characters: [{ avatar: 'x.png', data: {} }] },
        });
        expect(a.chatReadable).toBe(true);
        expect(a.chat).toBeNull();
    });

    test('never throws on a hostile context', () => {
        expect(() => gatherActivationState({
            wiScript: { get selected_world_info() { throw new Error('boom'); } },
            ctx: { get chatMetadata() { throw new Error('boom'); } },
        })).not.toThrow();
    });

    test('a throwing charLore accessor leaves the character slot unreadable — never a false "read"', () => {
        const wiScript = { selected_world_info: [], world_info: {} };
        Object.defineProperty(wiScript.world_info, 'charLore', {
            configurable: true,
            get() { throw new Error('boom'); },
        });
        const a = gatherActivationState({
            wiScript,
            ctx: { chatMetadata: {}, characterId: 0, characters: [{ avatar: 'mara.png', data: {} }] },
        });
        expect(a.charReadable).toBe(false); // a FAILED read must not count as a read
        expect(a.detectable).toBe(false);
        expect(a.note).toMatch(/character books/);
    });

    test('a throwing card accessor (avatar) leaves the character slot unreadable', () => {
        const card = { data: {} };
        Object.defineProperty(card, 'avatar', {
            configurable: true,
            get() { throw new Error('boom'); },
        });
        const a = gatherActivationState({
            wiScript: { selected_world_info: [], world_info: { charLore: [] } },
            ctx: { chatMetadata: {}, characterId: 0, characters: [card] },
        });
        expect(a.charReadable).toBe(false);
        expect(a.detectable).toBe(false);
    });

    test('a missing charLore (stock ST world_info === {}) still reads the character slot', () => {
        const a = gatherActivationState({
            wiScript: { selected_world_info: [], world_info: {} },
            ctx: { chatMetadata: {}, characterId: 0, characters: [{ avatar: 'mara.png', data: {} }] },
        });
        expect(a.charReadable).toBe(true);
        expect(a.charAdditional).toEqual([]);
        expect(a.detectable).toBe(true);
    });
});

describe('classifyBookActivation — yes/no/unknown/n-a', () => {
    const readable = {
        globalReadable: true, chatReadable: true, charReadable: true,
        global: ['Knowledge Tracker - Mara'], chat: null, charPrimary: null, charAdditional: [],
    };
    test('a book in a readable slot is active, and names the slot', () => {
        const r = classifyBookActivation('Knowledge Tracker - Mara', readable);
        expect(r.active).toBe('yes');
        expect(r.activeIn).toContain('global selection');
    });
    test('a book absent from all readable slots is inactive', () => {
        const r = classifyBookActivation('State Tracker - Mara', readable);
        expect(r.active).toBe('no');
        expect(r.note).toMatch(/will NOT inject/i);
    });
    test('when the global slot is unreadable, activation is unknown (never a false inactive)', () => {
        const r = classifyBookActivation('Anything', { globalReadable: false, chatReadable: false, charReadable: false });
        expect(r.active).toBe('unknown');
    });
    test('a non-injectable book (NPC Profiles) reports n/a regardless of slots', () => {
        const r = classifyBookActivation('NPC Profiles', readable, { injectable: false });
        expect(r.active).toBe('n/a');
        expect(r.note).toMatch(/no keywords/i);
    });
    test('a readable global selection but an unreadable chat slot cannot prove inactivity → unknown', () => {
        const r = classifyBookActivation('State Tracker - Mara', {
            ...readable, chatReadable: false, chat: null,
        });
        expect(r.active).toBe('unknown');
        expect(r.note).toMatch(/could not read: chat/i);
    });
    test('an unreadable character slot likewise reports unknown, never a false inactive', () => {
        const r = classifyBookActivation('State Tracker - Mara', {
            ...readable, charReadable: false, charPrimary: null, charAdditional: [],
        });
        expect(r.active).toBe('unknown');
        expect(r.note).toMatch(/character/);
    });
});

describe('collectScopeSnapshot — activation wiring & warnings', () => {
    /** All three resolved global books switched on. */
    const allActive = () => ({
        detectable: true, globalReadable: true, chatReadable: true, charReadable: true,
        global: [GLOBAL_BOOK_NAMES.knowledge, GLOBAL_BOOK_NAMES.state, GLOBAL_BOOK_NAMES.profiles],
        chat: null, charPrimary: null, charAdditional: [], note: 'ok',
    });
    /** Nothing switched on, but ST readable → definite "inactive". */
    const noneActive = () => ({
        detectable: true, globalReadable: true, chatReadable: true, charReadable: true,
        global: [], chat: null, charPrimary: null, charAdditional: [], note: 'ok',
    });

    test('per-book active fields land on each row; Profiles is n/a', () => {
        const snap = collectScopeSnapshot(deps({ activationApi: { gather: allActive } }));
        const k = snap.books.find((b) => b.id === 'knowledge');
        const p = snap.books.find((b) => b.id === 'profiles');
        expect(k.active).toBe('yes');
        expect(k.activeIn).toContain('global selection');
        expect(p.active).toBe('n/a');
        expect(snap.activation.detectable).toBe(true);
    });

    test('an inactive Knowledge book raises a warn (the silent-injection gap)', () => {
        const snap = collectScopeSnapshot(deps({ activationApi: { gather: noneActive } }));
        const w = snap.warnings.find((x) => x.id === 'knowledge-book-inactive');
        expect(w).toBeTruthy();
        expect(w.level).toBe('warn');
        expect(snap.bannerLevel).toBe('warn');
    });

    test('the State warning fires only when its store is loaded (avoids false alarm for unused trackers)', () => {
        // State store NOT loaded → no state warning even though it is inactive.
        const noStore = collectScopeSnapshot(deps({ activationApi: { gather: noneActive } }));
        expect(noStore.warnings.find((x) => x.id === 'state-book-inactive')).toBeFalsy();
        // State store loaded → the warning appears.
        const withStore = collectScopeSnapshot(deps({
            activationApi: { gather: noneActive },
            storeApi: { peekStore: () => ({ hydrated: true, dirty: false, version: 1, fields: [] }) },
        }));
        expect(withStore.warnings.find((x) => x.id === 'state-book-inactive')).toBeTruthy();
    });

    test('no activation warning when detection is undetectable (unknown, not inactive)', () => {
        const undetectable = () => ({
            detectable: false, globalReadable: false, chatReadable: false, charReadable: false,
            global: [], chat: null, charPrimary: null, charAdditional: [], note: 'unreadable',
        });
        const snap = collectScopeSnapshot(deps({ activationApi: { gather: undetectable } }));
        expect(snap.books.find((b) => b.id === 'knowledge').active).toBe('unknown');
        expect(snap.warnings.find((x) => x.id === 'knowledge-book-inactive')).toBeFalsy();
    });

    test('a throwing activation probe degrades to undetectable, never blanks the tab', () => {
        const snap = collectScopeSnapshot(deps({
            activationApi: { gather: () => { throw new Error('probe exploded'); } },
        }));
        expect(snap.activation.detectable).toBe(false);
        expect(snap.books.find((b) => b.id === 'knowledge').active).toBe('unknown');
        expect(snap.errors?.some((e) => /activation/.test(e))).toBe(true);
    });
});

describe('renderScopeSnapshot — activation column', () => {
    const noneActive = () => ({
        detectable: true, globalReadable: true, chatReadable: true, charReadable: true,
        global: [], chat: null, charPrimary: null, charAdditional: [], note: 'ok',
    });
    test('renders the Active column header and an inactive amber badge', () => {
        const html = renderScopeSnapshot(collectScopeSnapshot(deps({ activationApi: { gather: noneActive } })), { formatTime: T });
        expect(html).toContain('Active (World Info)');
        expect(html).toContain('>inactive<');
        expect(html).toContain('ST will not inject');
        // NPC Profiles is n/a, not a badge.
        expect(html).toContain('never injected');
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
        // _setCacheForTests seeds blankStore(), whose version is the current
        // KNOWLEDGE_STORE_VERSION — pinned via the same export, not a literal.
        expect(peek).toMatchObject({ hydrated: true, dirty: false, version: STORE_VERSION });
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

    test('a FAILED book shows the observed on-disk version, not the blank placeholder', () => {
        const html = renderScopeSnapshot(collectScopeSnapshot(deps({
            storeApi: {
                peekStore: (name) => (name.startsWith('Knowledge')
                    ? { hydrated: false, dirty: false, version: 1, fields: [], observedVersion: 99 }
                    : { hydrated: true, dirty: false, version: 1, fields: [] }),
            },
        })), { formatTime: T });
        expect(html).toContain('>load failed<');
        // v99 was on disk; the placeholder v1 must not masquerade as it.
        expect(html).toContain('<td>v99');
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
        // …and with Phase 12 (Integrity) landed 2026-08-21, every one of the
        // seven v1 tabs renders a real pane — no placeholder remains.
        expect(html).toContain('mwt-diag-int-run');
        expect(html).not.toContain('— not built yet');
    });
});
