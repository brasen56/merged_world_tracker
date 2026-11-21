/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { buildLedgerPlannerContext, readLedgerContext, LEDGER_PLANNER_CHAR_LIMIT } from '../core/ledger_context.js';
import { ledgerAddCommand, itemCommand } from '../ledger/commands.js';
import { createCommands } from '../core/commands.js';
import { registerItemSlashCommand } from '../core/item_command_registration.js';
import { createLedger, computeBalances } from '../ledger/data.js';
import { getLedger } from '../ledger/store.js';
import { buildInjectionBody } from '../ledger/injection.js';
import { MANIFEST_METADATA_KEY } from '../schema/manifest.js';
import { buildUserPrompt } from '../story_planner/generation.js';
import { buildTargetedUserPrompt, TARGETED_OPERATIONS } from '../story_planner/targeted.js';
import { getSettings, saveSettings } from '../story_planner/settings.js';
import { render, wireEvents } from '../story_planner/render.js';
import { state } from '../story_planner/data.js';
import { _resetPausedStores, pauseStore } from '../core/schema_status.js';
import { resetCoreStubs, getFakeMeta, getContextSafe, setFakeContextExtras } from './stubs/core.js';

const gold = { id: 'gold', name: 'gold', decimals: 2, badge: true };
const entry = (id, amount, extra = {}) => ({ id, currency: 'gold', amount, kind: 'entry', date: null, note: 'PRIVATE TRANSACTION NOTE', ...extra });
const item = (id, carried, extra = {}) => ({ id, name: id, qty: 2, carried, note: '', ...extra });
function seed(extra = {}) {
    getFakeMeta().mwt_ledger = { ...createLedger(), currencies: [gold],
        transactions: [entry('opening', 1000), entry('borrow', 300, { loan: true, counterparty: 'Aldric' }), entry('lend', -100, { loan: true, counterparty: 'Mira' })],
        items: [item('Rope', true, { note: 'silk' }), item('Secret sword', false, { where: 'Home chest' })], ...extra };
}
beforeEach(() => {
    resetCoreStubs();
    _resetPausedStores();
    setFakeContextExtras({ extensionSettings: { merged_world_tracker: {} }, saveMetadataDebounced: vi.fn(), setExtensionPrompt: vi.fn() });
    vi.stubGlobal('SillyTavern', { getContext: getContextSafe });
    seed();
});
afterEach(() => { state.modal = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ''; });

test('planner projection is detached, exact, debt-signed, bounded and read-only', () => {
    const before = JSON.stringify(getFakeMeta());
    const context = buildLedgerPlannerContext();
    expect(context).toContain('"gold": 12.00');
    expect(context).toContain('You owe "Aldric" 3.00 "gold"');
    expect(context).toContain('"Mira" owes you 1.00 "gold"');
    expect(context).toContain('"Rope" ×2; note: "silk"');
    expect(context).toContain('"Secret sword" ×2; where: "Home chest"');
    expect(context).toContain('NOT on hand');
    expect(context).not.toContain('PRIVATE TRANSACTION NOTE');
    expect(context.length).toBeLessThanOrEqual(LEDGER_PLANNER_CHAR_LIMIT);
    readLedgerContext().items[0].qty = 99;
    expect(JSON.stringify(getFakeMeta())).toBe(before);
    expect(getContextSafe().saveMetadataDebounced).not.toHaveBeenCalled();
    expect(getContextSafe().setExtensionPrompt).not.toHaveBeenCalled();
    expect(buildInjectionBody(getLedger())).not.toContain('Secret sword');
});

test('large inventories keep whole rows and honest omitted counts within the hard cap', () => {
    seed({ items: Array.from({ length: 300 }, (_, index) => item(`item-${index}`, index < 150, { note: 'x'.repeat(500), where: 'y'.repeat(500) })) });
    const context = buildLedgerPlannerContext();
    expect(context.length).toBeLessThanOrEqual(LEDGER_PLANNER_CHAR_LIMIT);
    expect(context).toMatch(/…and \d+ more carried items/);
    expect(context).toMatch(/…and \d+ more stored items/);
    expect(context).toContain('"item-150"');
});

test.each([null, {}, { ...createLedger() }, { ...createLedger(), version: 99 }, { ...createLedger(), currencies: [gold], transactions: [entry('bad', 1.5)] }])('absent, empty, future or invalid ledger is omitted (%j)', value => {
    getFakeMeta().mwt_ledger = value;
    expect(buildLedgerPlannerContext()).toBe('');
});

test('paused, future manifest, disabled and missing host gates are closed without repair', () => {
    getContextSafe().extensionSettings.merged_world_tracker.enableLedger = false;
    expect(buildLedgerPlannerContext()).toBe('');
    getContextSafe().extensionSettings.merged_world_tracker.enableLedger = true;
    getFakeMeta()[MANIFEST_METADATA_KEY] = { manifestVersion: 999, sections: {} };
    expect(buildLedgerPlannerContext()).toBe('');
    delete getFakeMeta()[MANIFEST_METADATA_KEY];
    pauseStore('ledger');
    expect(buildLedgerPlannerContext()).toBe('');
    _resetPausedStores();
    vi.stubGlobal('SillyTavern', { getContext: () => null });
    expect(buildLedgerPlannerContext()).toBe('');
});

test('audit corruption does not suppress healthy money or expose proposals/logs', () => {
    getFakeMeta().mwt_ledger.proposals = [{ secret: 'PRIVATE PROPOSAL' }];
    getFakeMeta().mwt_ledger.itemLog = [{ secret: 'PRIVATE LOG' }];
    expect(buildLedgerPlannerContext()).toContain('12.00');
    expect(buildLedgerPlannerContext()).not.toContain('PRIVATE');
});

test('planner projection ignores narrator/proposal switches but respects its own checkbox', () => {
    Object.assign(getContextSafe().extensionSettings.merged_world_tracker, { injectLedger: false, injectionMasterOff: true, ledgerProposals: false });
    expect(buildUserPrompt('story')).toContain('<ledger>');
    saveSettings({ includeLedger: false });
    expect(buildUserPrompt('story')).not.toContain('<ledger>');
    expect(buildTargetedUserPrompt('rework', { title: 'Arc', body: '', section: 'emerging', beats: [] })).not.toContain('<ledger>');
});

test('Include ledger checkbox defaults on, saves off and re-renders off', () => {
    document.body.innerHTML = `<div id="planner">${render()}</div>`;
    state.modal = document.getElementById('planner');
    wireEvents();
    const checkbox = state.modal.querySelector('#sp-include-ledger');
    expect(checkbox.checked).toBe(true);
    expect(checkbox.closest('label').textContent).toContain('Include ledger');
    checkbox.checked = false;
    state.modal.querySelector('#sp-save-settings').click();
    expect(getSettings().includeLedger).toBe(false);
    document.body.innerHTML = render();
    expect(document.getElementById('sp-include-ledger').checked).toBe(false);
    expect(buildUserPrompt('story')).not.toContain('<ledger>');
});

test('default/custom/scoped planner prompts prepend the application block', () => {
    expect(buildUserPrompt('story')).toContain('<ledger>');
    saveSettings({ customUserPrompt: 'CUSTOM {{chatHistory}}\nOutput only the plan.' });
    const custom = buildUserPrompt('story');
    expect(custom.startsWith('<ledger>')).toBe(true);
    expect(custom.endsWith('Output only the plan.')).toBe(true);
    for (const requestSpec of [
        { operation: 'add', sectionKeys: ['emerging'], requestedCount: 1 },
        { operation: 'refresh', sectionKeys: ['emerging'], targetArcIds: ['a1'] },
    ]) expect(buildUserPrompt('story', '', { requestSpec })).toContain('<ledger>');
});

test.each(TARGETED_OPERATIONS)('targeted %s receives the same block', operation => {
    const prompt = buildTargetedUserPrompt(operation, { title: 'Arc', body: '', section: 'emerging', beats: [] });
    expect(prompt).toContain(buildLedgerPlannerContext());
    expect(prompt.endsWith('Return the JSON object now.')).toBe(true);
});

test('live chat changes never reuse a cached inventory', () => {
    expect(buildLedgerPlannerContext()).toContain('Secret sword');
    seed({ items: [item('Other chat stash', false)] });
    expect(buildLedgerPlannerContext()).not.toContain('Secret sword');
    expect(buildLedgerPlannerContext()).toContain('Other chat stash');
});

test('raw command registration preserves numeric-ending quoted item names through host parsing', () => {
    const handlers = new Map();
    const legacy = vi.fn((name, callback) => handlers.set(name, value => callback({}, value.replace(/^"(.*?)"/, '$1'))));
    const raw = vi.fn((name, callback) => handlers.set(name, value => callback({}, value)));
    createCommands({ registerSlashCommand: legacy, registerRawSlashCommand: raw, modules: { Ledger: { itemCommand } } }).setupSlashCommands();
    expect(raw.mock.calls.map(([name]) => name)).toEqual(['wt-item']);
    expect(handlers.get('wt-item')('"Model 42"')).toContain('Added Model 42 ×1');
    expect(handlers.get('wt-item')('"Model 42" 2')).toContain('Added Model 42 ×2');
    expect(getLedger().items.find(row => row.name === 'Model 42').qty).toBe(3);
});

test('split host arguments preserve quoted numeric-ending names on parsers without rawQuotes', () => {
    let command;
    const fromProps = props => props;
    registerItemSlashCommand({ SlashCommandParser: { addCommandObject: value => { command = value; } },
        SlashCommand: { fromProps }, SlashCommandArgument: { fromProps } }, 'wt-item',
    (_args, value) => itemCommand(value), [], 'Inventory');
    expect(command.splitUnnamedArgument).toBe(true);
    expect(command.unnamedArgumentList).toHaveLength(1);
    expect(command.callback({}, ['Model 42'])).toContain('Added Model 42 ×1');
    expect(command.callback({}, ['Model 42', '2'])).toContain('Added Model 42 ×2');
    expect(command.callback({}, ['Healing potion', '2'])).toContain('Added Healing potion ×2');
    expect(getLedger().items.find(row => row.name === 'Model 42').qty).toBe(3);
    const before = JSON.stringify(getLedger());
    expect(command.callback({}, 'Model 42')).toMatch(/^Error:/);
    expect(JSON.stringify(getLedger())).toBe(before);
});

test('money command uses exact minor units, user attribution, notes and shared save/injection', () => {
    ledgerAddCommand('-0.25 gold paid smith');
    expect(getLedger().transactions.at(-1)).toMatchObject({ amount: -25, note: 'paid smith', kind: 'entry', date: null });
    expect(getLedger().transactions.at(-1).source).toBeUndefined();
    expect(computeBalances(getLedger()).get('gold')).toBe(1175);
    expect(getContextSafe().saveMetadataDebounced).toHaveBeenCalled();
    expect(getContextSafe().setExtensionPrompt).toHaveBeenCalled();
    ledgerAddCommand('+1.05 gift');
    expect(getLedger().transactions.at(-1)).toMatchObject({ amount: 105, note: 'gift' });
});

test('quoted multi-word currencies resolve case-insensitively, ambiguity never guesses', () => {
    getFakeMeta().mwt_ledger.currencies.push({ id: 'silver', name: 'Silver marks', decimals: 0, badge: false });
    expect(() => ledgerAddCommand('5')).toThrow(/Specify/);
    expect(() => ledgerAddCommand('5 unknown')).toThrow(/Specify/);
    ledgerAddCommand('5 "silver MARKS" reward');
    expect(getLedger().transactions.at(-1)).toMatchObject({ currency: 'silver', amount: 5, note: 'reward' });
    getFakeMeta().mwt_ledger.currencies.push({ id: 'duplicate', name: 'GOLD', decimals: 2, badge: false });
    expect(() => ledgerAddCommand('5 gold')).toThrow(/ambiguous/);
});

test.each(['', '0', '1.001 gold', 'NaN', '9007199254740992', '2 "unclosed'])('invalid money command makes no write: %s', input => {
    const before = getLedger();
    expect(() => ledgerAddCommand(input)).toThrow();
    expect(getLedger()).toEqual(before);
    expect(getContextSafe().saveMetadataDebounced).not.toHaveBeenCalled();
});

test('item command creates carried items, increments exact matches and preserves storage', () => {
    itemCommand('"Long bow" 3');
    expect(getLedger().items.at(-1)).toMatchObject({ name: 'Long bow', qty: 3, carried: true });
    expect(getLedger().itemLog.at(-1)).toMatchObject({ name: 'Long bow', change: 'added', source: 'user' });
    itemCommand('rope');
    expect(getLedger().items.find(row => row.name === 'Rope').qty).toBe(3);
    itemCommand('"Secret sword" 2');
    expect(getLedger().items.find(row => row.name === 'Secret sword')).toMatchObject({ qty: 4, carried: false, where: 'Home chest' });
    expect(getLedger().itemLog.at(-1)).toMatchObject({ change: 'qty', source: 'user' });
    itemCommand('"Model 42"');
    expect(getLedger().items.at(-1).name).toBe('Model 42');
});

test.each(['', 'Rope 0', 'Rope -1', 'Rope 1.5', 'Rope 9007199254740992', '"" 2',
    'Rope -1e3', 'Rope 1e3', 'Rope NaN', 'Rope Infinity', 'Rope -Infinity',
    'Rope .5', 'Rope 1.', 'Rope 1,000', 'Rope 0x10', 'Rope 2oops'])('invalid item command makes no write: %s', input => {
    const before = getLedger();
    const metadata = JSON.stringify(getFakeMeta());
    expect(() => itemCommand(input)).toThrow();
    expect(getLedger()).toEqual(before);
    expect(JSON.stringify(getFakeMeta())).toBe(metadata);
    expect(getContextSafe().saveMetadataDebounced).not.toHaveBeenCalled();
});

test.each(['42', '-1e3', 'NaN', 'Infinity'])('quoted numeric-ending item names remain literal: %s', ending => {
    itemCommand(`"Model ${ending}"`);
    expect(getLedger().items.at(-1)).toMatchObject({ name: `Model ${ending}`, qty: 1 });
    itemCommand(`Model "${ending}" 2`);
    expect(getLedger().items.at(-1)).toMatchObject({ name: `Model ${ending}`, qty: 3 });
    itemCommand(`Model "${ending}"`);
    expect(getLedger().items.at(-1).qty).toBe(4);
});

test('item duplicate-name ambiguity and quantity overflow refuse atomically', () => {
    getFakeMeta().mwt_ledger.items.push(item('rope2', true, { name: 'ROPE' }));
    expect(() => itemCommand('rope')).toThrow(/ambiguous/);
    seed({ items: [item('Rope', true, { qty: Number.MAX_SAFE_INTEGER })] });
    expect(() => itemCommand('Rope')).toThrow(/safe integer/);
});

test('missing ledger can receive items but commands never invent currencies', () => {
    delete getFakeMeta().mwt_ledger;
    expect(() => ledgerAddCommand('5 gold')).toThrow(/currency/);
    expect(getFakeMeta().mwt_ledger).toBeUndefined();
    itemCommand('Rope');
    expect(getLedger().currencies).toEqual([]);
    expect(getLedger().items).toHaveLength(1);
});

test.each([
    { manifestVersion: 999, sections: {} },
    { manifestVersion: 1, sections: { ledger: 999 } },
])('future manifests block planner reads and both command writes (%j)', manifest => {
    getFakeMeta()[MANIFEST_METADATA_KEY] = manifest;
    const before = JSON.stringify(getFakeMeta());
    expect(buildLedgerPlannerContext()).toBe('');
    expect(() => ledgerAddCommand('5')).toThrow(/newer/);
    expect(() => itemCommand('Rope')).toThrow(/newer/);
    expect(JSON.stringify(getFakeMeta())).toBe(before);
});

test('safe individual money amounts cannot overflow the aggregate balance', () => {
    seed({ transactions: [entry('max', Number.MAX_SAFE_INTEGER)] });
    const before = getLedger();
    expect(() => ledgerAddCommand('0.01')).toThrow();
    expect(getLedger()).toEqual(before);
});

test('commands refuse a missing host without creating a ledger', () => {
    vi.stubGlobal('SillyTavern', { getContext: () => null });
    expect(() => ledgerAddCommand('5')).toThrow(/active chat/);
    expect(() => itemCommand('Rope')).toThrow(/active chat/);
});

test.each(['disabled', 'paused', 'future', 'invalid'])('both command write paths refuse %s ledgers', gate => {
    if (gate === 'disabled') getContextSafe().extensionSettings.merged_world_tracker.enableLedger = false;
    if (gate === 'paused') pauseStore('ledger');
    if (gate === 'future') getFakeMeta().mwt_ledger.version = 99;
    if (gate === 'invalid') getFakeMeta().mwt_ledger.items[0].qty = -1;
    const before = getLedger();
    expect(() => ledgerAddCommand('5')).toThrow();
    expect(() => itemCommand('Rope')).toThrow();
    expect(getLedger()).toEqual(before);
});

test('registrar uses ST second argument and returns readable errors', () => {
    const handlers = new Map();
    const ledger = { ledgerAddCommand, itemCommand };
    createCommands({ registerSlashCommand: (name, callback) => handlers.set(name, callback), modules: { Ledger: ledger } }).setupSlashCommands();
    expect(handlers.get('wt-ledger-add')({ ignored: true }, '1 gold tip')).toContain('Recorded 1.00 gold');
    expect(handlers.get('wt-item')({}, 'Rope 2')).toContain('Added Rope ×2');
    expect(handlers.get('wt-item')({}, 'Rope -1')).toMatch(/^Error:/);
});