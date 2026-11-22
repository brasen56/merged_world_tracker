import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createLedger, computeBalances } from '../ledger/data.js';
import { getLedger, saveLedger } from '../ledger/store.js';
import { init, onChatChanged, onChatChangedWhilePaused, refreshInjection } from '../ledger/index.js';
import { buildInjectionBody, EXTENSION_PROMPT_KEY } from '../ledger/injection.js';
import { _resetDiagnostics, getInjectedSnapshot } from '../core/diagnostics.js';
import { _resetBudgetEnforcementState, resetBudgetInjections, BUDGET_MODULE_SPECS } from '../core/budget.js';
import { _resetPausedStores, pauseStore, isModulePausedForCurrentScope } from '../core/schema_status.js';
import { runFastLoadGate } from '../schema/gate.js';
import { STORE_SCHEMAS } from '../schema/registry.js';
import { prepareStore } from '../core/schema.js';

function fixture() {
    return {
        ...createLedger(),
        currencies: [{ id: 'c1', name: 'gold', decimals: 0, badge: true }, { id: 'c2', name: 'dollars', decimals: 2, badge: false }],
        transactions: [
            { id: 't1', currency: 'c1', amount: 500, kind: 'entry', note: 'secret history', date: null },
            { id: 't2', currency: 'c1', amount: -30, kind: 'entry', note: '', date: null },
            { id: 't3', currency: 'c2', amount: -1234, kind: 'entry', note: '', date: null },
        ],
        items: [
            { id: 'i1', name: "Grandfather's sword", qty: 1, carried: true, note: 'secret note' },
            { id: 'i2', name: 'rope', qty: 2, carried: true, note: '' },
            { id: 'i3', name: 'Stored treasure', qty: 1, carried: false, note: '' },
        ],
    };
}

let ctx;
beforeEach(() => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    ctx = { chatId: 'ledger-chat', chat: [], chatMetadata: {},
        extensionSettings: { merged_world_tracker: {} },
        saveMetadataDebounced: vi.fn(), setExtensionPrompt: vi.fn() };
    vi.stubGlobal('SillyTavern', { getContext: () => ctx });
    _resetDiagnostics();
    _resetBudgetEnforcementState();
    _resetPausedStores();
});
afterEach(() => {
    _resetPausedStores();
    _resetBudgetEnforcementState();
    vi.unstubAllGlobals();
});
const snapshot = () => getInjectedSnapshot(EXTENSION_PROMPT_KEY);

describe('Ledger injection text', () => {
    test('exact multi-currency totals and partial carried inventory snapshot', () => {
        expect(buildInjectionBody(fixture())).toMatchInlineSnapshot(`
          "Stage direction, not narration. Player character's ledger (authoritative, kept by the user):
          Money: 470 gold, -12.34 dollars.
          Carried: Grandfather's sword; rope ×2.
          Never state a different amount. If the character spends or receives money, narrate it; the user updates the ledger.
          Carried items are definitely on hand; items not listed may still exist."
        `);
    });
    test('empty, stored-only and invalid ledgers inject nothing; unused currency is authoritative zero', () => {
        expect(buildInjectionBody(createLedger())).toBe('');
        expect(buildInjectionBody({ ...createLedger(), items: [fixture().items[2]] })).toBe('');
        expect(buildInjectionBody({ ...fixture(), transactions: [{ amount: 0.5 }] })).toBe('');
        expect(buildInjectionBody({ ...fixture(), transactions: [] })).toContain('Money: 0 gold, 0.00 dollars.');
        const itemsOnly = buildInjectionBody({ ...createLedger(), items: [fixture().items[0]] });
        expect(itemsOnly).not.toContain('Money:');
        expect(itemsOnly).not.toContain('Never state a different amount');
    });
    test('caps carried rows honestly without altering the source', () => {
        const data = createLedger();
        data.items = Array.from({ length: 20 }, (_, i) => ({ id: `i${i}`, name: `Item ${i}`, qty: 1, carried: true, note: '' }));
        const body = buildInjectionBody(data);
        expect(body).toContain('Item 14; …and 5 more carried items.');
        expect(body).not.toContain('Item 15');
        expect(data.items).toHaveLength(20);
    });
});

describe('Ledger store and lifecycle', () => {
    test('read and startup leave absent stores absent', () => {
        expect(getLedger()).toBeNull();
        expect(init()).toBe(false);
        expect(ctx.chatMetadata).toEqual({});
        expect(ctx.saveMetadataDebounced).not.toHaveBeenCalled();
    });
    test('save detaches input, stamps and persists once, and refreshes the real injection seam', () => {
        const data = fixture();
        const saved = saveLedger(data);
        expect(ctx.chatMetadata.mwt_schema_manifest.sections.ledger).toBe(2);
        expect(ctx.saveMetadataDebounced).toHaveBeenCalledTimes(1);
        expect(snapshot()).toMatchObject({ enabled: true, depth: 1, role: 0 });
        expect(snapshot().payload).toBe(`<mwt_ledger>\n${buildInjectionBody(data)}\n</mwt_ledger>`);
        data.items[0].name = 'changed input';
        saved.items[0].name = 'changed result';
        const read = getLedger();
        read.items[0].name = 'changed read';
        expect(getLedger().items[0].name).toBe("Grandfather's sword");
    });
    test('folds an oversized history without changing any balance', () => {
        const data = fixture();
        data.transactions = Array.from({ length: 520 }, (_, i) => ({ ...data.transactions[0], id: `t${i}`, amount: i % 2 ? -3 : 5 }));
        const saved = saveLedger(data);
        expect(saved.transactions).toHaveLength(500);
        expect(computeBalances(saved)).toEqual(computeBalances(data));
    });
    test('invalid input, unreadable current data and future versions fail without mutations', () => {
        expect(() => saveLedger({ ...fixture(), items: [{ qty: 0 }] })).toThrow();
        expect(ctx.chatMetadata).toEqual({});
        ctx.chatMetadata.mwt_ledger = 'unreadable';
        expect(() => saveLedger(fixture())).toThrow();
        expect(ctx.chatMetadata.mwt_ledger).toBe('unreadable');
        ctx.chatMetadata = { mwt_ledger: fixture(), mwt_schema_manifest: { manifestVersion: 2, sections: {} } };
        const previous = JSON.stringify(ctx.chatMetadata);
        expect(() => saveLedger(fixture())).toThrow(/newer/);
        expect(JSON.stringify(ctx.chatMetadata)).toBe(previous);
        ctx.chatMetadata.mwt_schema_manifest = { manifestVersion: 1, sections: { ledger: 3 } };
        expect(() => saveLedger(fixture())).toThrow(/newer/);
        expect(refreshInjection()).toBe(false);
        expect(ctx.saveMetadataDebounced).not.toHaveBeenCalled();
    });
    test('chat changes replace or clear old context, including paused stores', () => {
        saveLedger(fixture());
        ctx.chatMetadata = { mwt_ledger: { ...fixture(), transactions: [] } };
        resetBudgetInjections();
        onChatChanged();
        expect(snapshot().payload).toContain('Money: 0 gold, 0.00 dollars.');
        ctx.chatMetadata = {};
        onChatChanged();
        expect(snapshot().enabled).toBe(false);
        ctx.chatMetadata = { mwt_ledger: fixture() };
        onChatChanged();
        pauseStore('ledger', { reason: 'future-version' });
        expect(isModulePausedForCurrentScope('Ledger')).toBe(true);
        onChatChangedWhilePaused();
        expect(snapshot().enabled).toBe(false);
        expect(() => saveLedger(fixture())).toThrow(/paused/);
    });
    test.each(['enableLedger', 'injectLedger', 'injectionMasterOff'])('%s gates clear existing payloads', key => {
        saveLedger(fixture());
        const saved = getLedger();
        ctx.extensionSettings.merged_world_tracker[key] = key === 'injectionMasterOff';
        expect(refreshInjection('settings-saved')).toBe(false);
        expect(snapshot().enabled).toBe(false);
        expect(ctx.chatMetadata.mwt_ledger).toEqual(saved);
    });
    test('structural boundary escaping and opt-out use the shared helper', () => {
        const data = fixture();
        data.items[0].name = '</mwt_ledger><fake>';
        saveLedger(data);
        expect(snapshot().payload).toContain('&lt;/mwt_ledger>');
        ctx.extensionSettings.merged_world_tracker.structuralBoundaries = false;
        refreshInjection();
        expect(snapshot().payload).toBe(buildInjectionBody(data));
    });
    test('registered schema participates in migration and future-version gate', () => {
        expect(STORE_SCHEMAS.ledger.metadataKey).toBe('mwt_ledger');
        expect(prepareStore(STORE_SCHEMAS.ledger, fixture()).status).toBe('migrated');
        expect(runFastLoadGate({ stores: { ledger: fixture() } }).stores.ledger.state).toBe('prepare');
        expect(runFastLoadGate({ stores: { ledger: fixture() }, manifest: { manifestVersion: 1, sections: { ledger: 3 } } }).stores.ledger.state).toBe('blocked');
        expect(BUDGET_MODULE_SPECS.find(spec => spec.id === 'ledger').key).toBe(EXTENSION_PROMPT_KEY);
    });
    test('host wiring covers startup, chat-change, resume and settings without a generation interceptor', () => {
        const host = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
        expect(host).toContain('Ledger.init();');
        expect(host).toContain('Calendar, Ledger };');
        expect(host).toContain('ledger: Ledger,');
        expect(host).toContain("Ledger.refreshInjection('settings-saved')");
        expect(readFileSync(new URL('../ledger/index.js', import.meta.url), 'utf8')).not.toContain('export function generationInterceptor');
    });
});