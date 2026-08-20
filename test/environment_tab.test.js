/**
 * test/environment_tab.test.js — Diagnostics Phase 7 (Tab 2: Environment).
 *
 * Covers the two layers of the Environment tab, mirroring the Phase 6 health
 * tab suite:
 *   1. diagnostics_panel/environment.js — every detector with injected
 *      st/ctx/globalScope/identity/wiState dependencies (the DOM-free core):
 *      ST version probing, the getCurrentChatId() premise verdict behind
 *      core/scope.js, tokenizer source detection, the world-info tri-state,
 *      and the shared.js ConnectionManagerRequestService probe (the exact
 *      import core/api.js uses — under Vitest the specifier alias lands on
 *      test/stubs/shared.js, so the async path is exercised for real).
 *   2. diagnostics_panel/render.js — renderEnvironmentSnapshot() /
 *      renderEnvironmentPane() / renderConnectionManagerCell() string
 *      builders (premise banner tones, badges, escaping), plus the pane
 *      switch that mounts the sub-tab.
 *
 * The final smoke test exercises the DEFAULT wiring (real context helpers
 * under the barrel→stub alias) — it exists to catch import-graph breakage,
 * not to assert live values.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
    detectStVersion,
    detectChatIdPremise,
    detectTokenizer,
    detectWorldInfo,
    inspectConnectionManager,
    loadSharedModule,
    probeConnectionManager,
    collectEnvironmentSnapshot,
} from '../diagnostics_panel/environment.js';
import {
    renderEnvironmentPane,
    renderEnvironmentSnapshot,
    renderConnectionManagerCell,
    DIAGNOSTICS_ENV_CMRS_CELL_ID,
    renderDiagnosticsPanel,
} from '../diagnostics_panel/render.js';
import { state as knowledgeState } from '../knowledge/state.js';
import { MWT_VERSION } from '../core/version.js';

// ─── Fakes ───────────────────────────────────────────────────────────────────

/** A context object answering every field the Environment tab reads. */
function fakeCtx(overrides = {}) {
    return {
        characterId: 0,
        characters: [{ avatar: 'seraphina.png', name: 'Seraphina' }],
        name1: 'User',
        name2: 'Seraphina',
        groupId: null,
        groups: [],
        getCurrentChatId: () => 'chat-2026-08-16@0001',
        chatId: 'chat-2026-08-16@0001',
        getTokenCount: () => 4,
        ConnectionManagerRequestService: { constructPrompt: () => [], sendRequest: async () => ({}) },
        ...overrides,
    };
}

/** The identity resolver core/scope.js would produce for a resolved chat. */
const CHAT_IDENTITY = (ctx) => ({
    chatId: ctx?.getCurrentChatId?.() ?? ctx?.chatId ?? null,
    characterKey: 'char:seraphina.png',
    groupKey: null,
    isUnknown: false,
    key: `chat:${ctx?.getCurrentChatId?.() ?? ctx?.chatId ?? ''}`,
});

const UNKNOWN_IDENTITY = () => ({
    chatId: null, characterKey: null, groupKey: null, isUnknown: true, key: 'unknown:1',
});

/** Default deps: everything injected, nothing live. */
function deps(extra = {}) {
    return {
        st: {},
        globalScope: {},
        ctx: fakeCtx(),
        getIdentity: CHAT_IDENTITY,
        wiState: { wiScript: { loadWorldInfo() {}, saveWorldInfo() {}, createNewWorldInfo() {} } },
        sharedModule: null,
        version: '9.9.9-test',
        now: () => 1_700_000_000_000,
        ...extra,
    };
}

const T = () => '12:00:00';

beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'table').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.SillyTavern;
    delete globalThis.getContext;
    delete globalThis.getTokenCount;
    knowledgeState.wiScript = undefined;
});

// ─── detectStVersion ─────────────────────────────────────────────────────────

describe('detectStVersion', () => {
    test('reads SillyTavern.version first and names its source', () => {
        expect(detectStVersion({ version: '1.13.0' }, {})).toEqual({ value: '1.13.0', source: 'SillyTavern.version' });
    });

    test('falls back to SillyTavern.manifest.version', () => {
        expect(detectStVersion({ manifest: { version: '1.12.13' } }, {})).toEqual({ value: '1.12.13', source: 'SillyTavern.manifest.version' });
    });

    test('falls back to the context version field', () => {
        expect(detectStVersion({}, { version: '4.0.1-fork' })).toEqual({ value: '4.0.1-fork', source: 'context.version' });
    });

    test('prefers the earlier source when several answer', () => {
        expect(detectStVersion({ version: '1.13.0', manifest: { version: '9.9.9' } }, { version: '8.8.8' }))
            .toEqual({ value: '1.13.0', source: 'SillyTavern.version' });
    });

    test('numeric versions are stringified, blanks skipped', () => {
        expect(detectStVersion({ version: '  ' }, { version: 1.13 })).toEqual({ value: '1.13', source: 'context.version' });
    });

    test('reports null when nothing exposes a version — that absence is the finding', () => {
        expect(detectStVersion(undefined, undefined)).toEqual({ value: null, source: null });
    });
});

// ─── detectChatIdPremise ─────────────────────────────────────────────────────

describe('detectChatIdPremise — the core/scope.js premise verdict', () => {
    test('ok: getCurrentChatId() exposed and answering', () => {
        const p = detectChatIdPremise(fakeCtx(), CHAT_IDENTITY);
        expect(p).toMatchObject({
            level: 'ok', method: 'getCurrentChatId', chatIdValue: 'chat-2026-08-16@0001',
            getCurrentChatIdOutcome: 'returned-value', identityKey: 'chat:chat-2026-08-16@0001', identityUnknown: false,
        });
        expect(p.note).toContain('HOLDS');
    });

    test('fallback: no getCurrentChatId, but ctx.chatId answers', () => {
        const p = detectChatIdPremise(fakeCtx({ getCurrentChatId: undefined }), CHAT_IDENTITY);
        expect(p).toMatchObject({ level: 'fallback', method: 'ctx.chatId', chatIdValue: 'chat-2026-08-16@0001' });
        expect(p.note).toContain('ctx.chatId fallback');
    });

    test('fallback: getCurrentChatId present but throwing', () => {
        const p = detectChatIdPremise(fakeCtx({ getCurrentChatId: () => { throw new Error('boom'); } }), CHAT_IDENTITY);
        expect(p.level).toBe('fallback');
        expect(p.getCurrentChatIdOutcome).toContain('threw');
        expect(p.note).toContain('threw');
    });

    test('fallback: getCurrentChatId returns empty', () => {
        const p = detectChatIdPremise(fakeCtx({ getCurrentChatId: () => '' }), CHAT_IDENTITY);
        expect(p).toMatchObject({ level: 'fallback', getCurrentChatIdOutcome: 'returned-empty' });
    });

    test('fail-closed: neither source answers, identity gets a fresh unknown nonce', () => {
        const p = detectChatIdPremise(fakeCtx({ getCurrentChatId: undefined, chatId: null }), UNKNOWN_IDENTITY);
        expect(p).toMatchObject({ level: 'fail-closed', method: null, chatIdValue: null, identityUnknown: true });
        expect(p.note).toContain('FAIL CLOSED');
    });

    test('unknown: no context object at all', () => {
        const p = detectChatIdPremise(null, UNKNOWN_IDENTITY);
        expect(p).toMatchObject({ level: 'unknown', method: null });
    });
});

// ─── detectTokenizer ─────────────────────────────────────────────────────────

describe('detectTokenizer — estimateTokens() source order, verified live', () => {
    test('ctx.getTokenCount wins', () => {
        const r = detectTokenizer({ getTokenCount: () => 4 }, { getTokenCount: () => 5 }, { tokenizers: { getTokenCount: () => 6 } });
        expect(r).toMatchObject({ available: true, source: 'ctx.getTokenCount' });
    });

    test('falls back to the legacy global', () => {
        const r = detectTokenizer({}, { getTokenCount: () => 5 }, { tokenizers: { getTokenCount: () => 6 } });
        expect(r).toMatchObject({ available: true, source: 'global getTokenCount' });
    });

    test('falls back to SillyTavern.tokenizers', () => {
        const r = detectTokenizer({}, {}, { tokenizers: { getTokenCount: () => 6 } });
        expect(r).toMatchObject({ available: true, source: 'SillyTavern.tokenizers.getTokenCount' });
    });

    test('present but throwing is reported present-but-unusable', () => {
        const r = detectTokenizer({ getTokenCount: () => { throw new Error('tokenizer exploded'); } }, {}, {});
        expect(r).toMatchObject({ available: false, source: 'ctx.getTokenCount' });
        expect(r.detail).toContain('threw');
    });

    test('present but returning a non-number is unusable', () => {
        const r = detectTokenizer({ getTokenCount: () => 'four' }, {}, {});
        expect(r.available).toBe(false);
        expect(r.detail).toContain('did not return a number');
    });

    // estimateTokens() calls ctx.getTokenCount(text) and
    // SillyTavern.tokenizers.getTokenCount(text) as METHODS. A probe that
    // detaches the function first would make a working `this`-using tokenizer
    // throw and be reported as broken — a false alarm on the one tab whose
    // job is to be trusted about fork compatibility.
    test('calls the candidate on its own receiver, like estimateTokens() does', () => {
        const ctx = { _mult: 3, getTokenCount(text) { return text.length * this._mult; } };
        expect(ctx.getTokenCount('hello')).toBe(15);           // production call works…
        expect(detectTokenizer(ctx, {}, {})).toMatchObject({   // …so the probe must agree
            available: true,
            source: 'ctx.getTokenCount',
        });
    });

    test('the SillyTavern.tokenizers route keeps its receiver too', () => {
        const st = { tokenizers: { _mult: 4, getTokenCount(text) { return text.length * this._mult; } } };
        expect(detectTokenizer(null, {}, st)).toMatchObject({
            available: true,
            source: 'SillyTavern.tokenizers.getTokenCount',
        });
    });

    test('none exposed → the chars/4.5 fallback note', () => {
        const r = detectTokenizer({}, {}, {});
        expect(r).toEqual({ available: false, source: null, detail: expect.stringContaining('chars/4.5') });
    });
});

// ─── detectWorldInfo ─────────────────────────────────────────────────────────

describe('detectWorldInfo — the wiScript tri-state', () => {
    test('loaded reports each function Knowledge calls', () => {
        const r = detectWorldInfo({ wiScript: { loadWorldInfo() {}, saveWorldInfo() {}, createNewWorldInfo() {} } });
        expect(r).toMatchObject({ state: 'loaded', available: true, loadWorldInfo: true, saveWorldInfo: true, createNewWorldInfo: true });
    });

    test('loaded but missing members is visible', () => {
        const r = detectWorldInfo({ wiScript: { loadWorldInfo() {} } });
        expect(r).toMatchObject({ state: 'loaded', available: true, saveWorldInfo: false, createNewWorldInfo: false });
    });

    test('undefined = not attempted yet', () => {
        expect(detectWorldInfo({ wiScript: undefined })).toMatchObject({ state: 'not-attempted', available: false });
    });

    test('null = tried and failed — the wi_script_unavailable state', () => {
        const r = detectWorldInfo({ wiScript: null });
        expect(r).toMatchObject({ state: 'failed', available: false });
        expect(r.note).toContain('wi_script_unavailable');
    });

    test('defaults to the real knowledge state object', () => {
        knowledgeState.wiScript = { loadWorldInfo() {}, saveWorldInfo() {}, createNewWorldInfo() {} };
        expect(detectWorldInfo().state).toBe('loaded');
    });
});

// ─── Connection Manager probe ────────────────────────────────────────────────

describe('inspectConnectionManager', () => {
    test('no loaded module → unprobed placeholder shape', () => {
        expect(inspectConnectionManager(null)).toEqual({ probed: false });
        expect(inspectConnectionManager(undefined)).toEqual({ probed: false });
    });

    test('import failure carries the error for the report', () => {
        const r = inspectConnectionManager({ ok: false, error: 'module gone' });
        expect(r).toMatchObject({ probed: true, available: false, constructPrompt: false, sendRequest: false, error: 'module gone' });
    });

    test('full service (the reference build): available with both members', () => {
        const r = inspectConnectionManager({ ok: true, module: { ConnectionManagerRequestService: { constructPrompt() {}, sendRequest() {} } } });
        expect(r).toEqual({ probed: true, available: true, constructPrompt: true, sendRequest: true });
    });

    test('the Aikobots-4 shape: service present, constructPrompt removed', () => {
        const r = inspectConnectionManager({ ok: true, module: { ConnectionManagerRequestService: { sendRequest() {} } } });
        expect(r).toMatchObject({ probed: true, available: true, constructPrompt: false, sendRequest: true });
    });

    test('module without the service at all', () => {
        expect(inspectConnectionManager({ ok: true, module: {} }))
            .toEqual({ probed: true, available: false, constructPrompt: false, sendRequest: false });
    });
});

describe('loadSharedModule / probeConnectionManager — the async shared.js path', () => {
    test('resolves the same Vitest alias stub core/api.js uses, never throwing', async () => {
        const loaded = await loadSharedModule();
        expect(loaded.ok).toBe(true);
        // test/stubs/shared.js exports the service with both members.
        expect(inspectConnectionManager(loaded)).toEqual({ probed: true, available: true, constructPrompt: true, sendRequest: true });
    });

    test('probeConnectionManager = load + inspect in one call', async () => {
        await expect(probeConnectionManager()).resolves.toMatchObject({ probed: true, available: true });
    });
});

// ─── collectEnvironmentSnapshot ──────────────────────────────────────────────

describe('collectEnvironmentSnapshot', () => {
    test('full shape on a reference-like build', () => {
        const snap = collectEnvironmentSnapshot(deps({ st: { version: '1.13.0', getContext() {} } }));
        expect(snap).toMatchObject({
            generatedAt: 1_700_000_000_000,
            mwtVersion: '9.9.9-test',
            stVersion: '1.13.0',
            stVersionSource: 'SillyTavern.version',
            contextAvailable: true,
            contextSource: 'SillyTavern.getContext',
        });
        expect(snap.chatIdPremise).toMatchObject({ level: 'ok', method: 'getCurrentChatId' });
        expect(snap.connectionManager).toEqual({ probed: false });
        expect(snap.features.map(f => f.id)).toEqual([
            'getCurrentChatId', 'chatId', 'getTokenCount', 'connectionManagerContext', 'worldInfo',
        ]);
        expect(snap.errors).toBeUndefined();
    });

    test('contextFields mirror MWT.scope.diagnose() — same rows, same sentinels', () => {
        const snap = collectEnvironmentSnapshot(deps());
        expect(snap.contextFields).toEqual({
            characterId: 0,
            'characters is array': true,
            'characters[characterId]': 'resolved',
            'card.avatar': 'seraphina.png',
            'card.name': 'Seraphina',
            'name1 (user)': 'User',
            'name2 (char)': 'Seraphina',
            // diagnose() reads `ctx.groupId ?? '(absent)'` — a null groupId IS
            // the absent case there, so the pane shows the same sentinel.
            groupId: '(absent)',
            'groups is array': true,
            'getCurrentChatId()': 'chat-2026-08-16@0001',
            chatId: 'chat-2026-08-16@0001',
        });
    });

    test('absent context fields degrade to the diagnose() sentinels', () => {
        const snap = collectEnvironmentSnapshot(deps({ ctx: {} }));
        expect(snap.contextFields['card.avatar']).toBe('(absent)');
        expect(snap.contextFields['name1 (user)']).toBe('(absent)');
        expect(snap.contextFields['getCurrentChatId()']).toBe('(not a function)');
        expect(snap.contextFields['characters[characterId]']).toBe('(not resolved)');
        expect(snap.chatIdPremise.level).toBe('fail-closed');
    });

    test('a throwing getCurrentChatId is caught, not propagated', () => {
        const snap = collectEnvironmentSnapshot(deps({
            ctx: fakeCtx({ getCurrentChatId: () => { throw new Error('nope'); } }),
        }));
        expect(snap.contextFields['getCurrentChatId()']).toContain('threw');
        // ctx.chatId still answers, so the premise holds via the fallback.
        expect(snap.chatIdPremise.level).toBe('fallback');
    });

    test('contextSource detects the legacy global route', () => {
        const snap = collectEnvironmentSnapshot(deps({ globalScope: { getContext() {} } }));
        expect(snap.contextSource).toBe('getContext (legacy global)');
    });

    test('the context-side CMRS feature calls out a missing constructPrompt (the fork datum)', () => {
        const snap = collectEnvironmentSnapshot(deps({
            ctx: fakeCtx({ ConnectionManagerRequestService: { sendRequest() {} } }),
        }));
        const f = snap.features.find(x => x.id === 'connectionManagerContext');
        expect(f).toMatchObject({ available: true });
        expect(f.detail).toContain('constructPrompt: MISSING');
    });

    test('a pre-loaded sharedModule flows into connectionManager', async () => {
        const loaded = await loadSharedModule();
        const snap = collectEnvironmentSnapshot(deps({ sharedModule: loaded }));
        expect(snap.connectionManager).toEqual({ probed: true, available: true, constructPrompt: true, sendRequest: true });
    });

    test('a hostile context getter degrades its sections and records errors, never the snapshot', () => {
        const hostile = fakeCtx();
        Object.defineProperty(hostile, 'getCurrentChatId', { get() { throw new Error('hostile getter'); } });
        const snap = collectEnvironmentSnapshot(deps({ ctx: hostile }));
        // The premise falls back to its unknown shape instead of throwing…
        expect(snap.chatIdPremise.level).toBe('unknown');
        // …the feature table degrades to empty…
        expect(snap.features).toEqual([]);
        // …the header still answers…
        expect(snap.mwtVersion).toBe('9.9.9-test');
        // …and every degraded section is named in errors.
        const labels = snap.errors.map(e => e.split(':')[0]);
        expect(labels).toEqual(expect.arrayContaining(['chatIdPremise', 'contextFields', 'features']));
    });

    test('a hostile ConnectionManagerRequestService getter degrades the feature table, not the snapshot', () => {
        // The property the feature table reads is the ONE the guard used to
        // sit behind rather than around: a fork exposing it as a throwing
        // accessor took the whole snapshot down.
        const hostile = fakeCtx();
        Object.defineProperty(hostile, 'ConnectionManagerRequestService', { get() { throw new Error('hostile getter'); } });
        const snap = collectEnvironmentSnapshot(deps({ ctx: hostile }));
        expect(snap.features).toEqual([]);
        expect(snap.errors.map(e => e.split(':')[0])).toContain('features');
        // Everything that does not depend on that property still answers.
        expect(snap.mwtVersion).toBe('9.9.9-test');
        expect(snap.chatIdPremise.level).toBe('ok');
        expect(snap.contextFields['name2 (char)']).toBe('Seraphina');
    });

    test('a throwing identity resolver is swallowed by the premise probe, not the snapshot', () => {
        const snap = collectEnvironmentSnapshot(deps({ getIdentity: () => { throw new Error('identity blew up'); } }));
        // detectChatIdPremise guards its own identity call — the snapshot-level
        // errors list stays clean and the row still resolves.
        expect(snap.chatIdPremise.identityKey).toBeNull();
        expect(snap.chatIdPremise.level).toBe('ok');
        expect(snap.errors).toBeUndefined();
    });
});

// ─── renderEnvironmentSnapshot / renderConnectionManagerCell ────────────────

describe('renderEnvironmentSnapshot', () => {
    test('renders the header, ok premise banner, features, and raw fields', () => {
        const html = renderEnvironmentSnapshot(collectEnvironmentSnapshot(deps({ st: { version: '1.13.0' } })), { formatTime: T });
        expect(html).toContain('MWT v9.9.9-test');
        expect(html).toContain('SillyTavern:');
        expect(html).toContain('1.13.0');
        expect(html).toContain('mwt-diag-env-premise--ok');
        expect(html).toContain('chat-ID premise: ok');
        for (const id of ['getCurrentChatId', 'chatId', 'getTokenCount', 'connectionManagerContext', 'worldInfo']) {
            expect(html).toContain(`data-feature="${id}"`);
        }
        // The raw context-field table mirrors diagnose()'s row labels.
        expect(html).toContain('characters[characterId]');
        expect(html).toContain('seraphina.png');
        expect(html).toContain('read at 12:00:00');
    });

    test('each premise level gets its banner tone', () => {
        const levels = [
            ['ok', fakeCtx()],
            ['fallback', fakeCtx({ getCurrentChatId: undefined })],
            ['fail-closed', fakeCtx({ getCurrentChatId: undefined, chatId: null })],
            ['unknown', null],
        ];
        for (const [level, ctx] of levels) {
            const snap = collectEnvironmentSnapshot(deps({ ctx }));
            expect(snap.chatIdPremise.level).toBe(level);
            const html = renderEnvironmentSnapshot(snap, { formatTime: T });
            expect(html).toContain(`mwt-diag-env-premise--${level}`);
        }
    });

    test('unprobed shared.js state renders the probing placeholder with the fill target id', () => {
        const html = renderEnvironmentSnapshot(collectEnvironmentSnapshot(deps()), { formatTime: T });
        expect(html).toContain(`id="${DIAGNOSTICS_ENV_CMRS_CELL_ID}"`);
        expect(html).toContain('probing…');
    });

    test('a missing ST version is stated, not blank', () => {
        const html = renderEnvironmentSnapshot(collectEnvironmentSnapshot(deps({ st: {} })), { formatTime: T });
        expect(html).toContain('version not exposed on this build');
    });

    test('escapes user-derived context strings (card name, avatar, chat id, version)', () => {
        const hostile = fakeCtx({
            characters: [{ avatar: '<script>a</script>.png', name: '<script>alert(1)</script>' }],
            chatId: '<img src=x onerror=alert(1)>',
        });
        hostile.getCurrentChatId = () => hostile.chatId;
        const snap = collectEnvironmentSnapshot(deps({ ctx: hostile, st: { version: '<b>1.0</b>' } }));
        const html = renderEnvironmentSnapshot(snap, { formatTime: T });
        expect(html).not.toContain('<script>alert');
        expect(html).not.toContain('<img src=x');
        expect(html).toContain('&lt;script&gt;');
        expect(html).toContain('&lt;b&gt;1.0&lt;/b&gt;');
    });
});

describe('renderConnectionManagerCell — the three probe outcomes', () => {
    test('unprobed → probing placeholder', () => {
        expect(renderConnectionManagerCell({ probed: false })).toContain('probing…');
        expect(renderConnectionManagerCell(undefined)).toContain('probing…');
    });

    test('import failure → fail badge with the error in the hover title', () => {
        const html = renderConnectionManagerCell({ probed: true, available: false, constructPrompt: false, sendRequest: false, error: 'module gone' });
        expect(html).toContain('shared.js import failed');
        expect(html).toContain('module gone');
    });

    test('the reference shape → available with constructPrompt ✓', () => {
        const html = renderConnectionManagerCell({ probed: true, available: true, constructPrompt: true, sendRequest: true });
        expect(html).toContain('>available<');
        expect(html).toContain('constructPrompt ✓');
    });

    test('the Aikobots-4 shape → warn badge for the removed constructPrompt', () => {
        const html = renderConnectionManagerCell({ probed: true, available: true, constructPrompt: false, sendRequest: true });
        expect(html).toContain('>available<');
        expect(html).toContain('constructPrompt missing');
        expect(html).toContain('mwt-diag-badge--warn');
    });
});

// ─── Pane mounting + default-wiring smoke ────────────────────────────────────

describe('renderEnvironmentPane (default wiring)', () => {
    test('collects and renders against the real context graph without throwing', () => {
        const html = renderEnvironmentPane();
        // Not asserting live values (state depends on stubbed context) — only
        // that the default wiring resolves end-to-end and renders the tables.
        expect(html).toContain('mwt-diag-env');
        expect(html).toContain('mwt-diag-env-premise--');
        // The real version constant flows through (direct core/version.js
        // import — the §II.3 alias trap).
        expect(html).toContain(`MWT v${MWT_VERSION}`);
    });

    test('the panel shell mounts the Environment pane instead of its placeholder', () => {
        const html = renderDiagnosticsPanel();
        expect(html).toContain('data-diag-tab="environment"');
        // The real pane rendered (not the Phase 7 placeholder card)…
        expect(html).toContain('mwt-diag-env-premise--');
        expect(html).not.toContain('Phase 7 — not built yet');
        // …while later tabs still show their placeholders (Phase 10 landed
        // 2026-08-20 — its suite owns the last-request-pane assertion now).
        expect(html).toContain('Phase 11 — not built yet');
    });
});
