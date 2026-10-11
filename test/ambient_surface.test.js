/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderAmbientSettings, wireAmbientSettings } from '../ambient/render.js';
import { getSettings, saveSettings, ensureSeed } from '../ambient/settings.js';
import { ambientCommand, onGenerationStarted, onChatChanged } from '../ambient/index.js';
import { readAmbientConditions, getAmbientStatus } from '../core/ambient_state.js';
import { applyAmbientPin, isAmbientPinActive } from '../core/ambient_pin.js';
import { buildInjectionBody } from '../ambient/injection.js';
import { getInjectedSnapshot, _resetDiagnostics } from '../core/diagnostics.js';
import { _resetBudgetEnforcementState } from '../core/budget.js';
import { parseAmbientDateTime } from '../core/ambient_time.js';
import { createCommands } from '../core/commands.js';
import { renderOverviewSnapshot } from '../dashboard/render.js';

let ctx;
const config = { enabled: true, climate: 'temperate', hemisphere: 'north', manualSeason: 'spring', variability: 0.5 };
const conditions = { sky: 'overcast', temperature: 'cool', air: 'damp', precipitation: 'thunderstorm', wind: 'strong' };
const hours = parseAmbientDateTime('2026-06-04', '12:00').hours;
const pin = { startHours: hours, endHours: hours + 6, source: 'timestamp', conditions };
const el = id => document.querySelector(`#mwt-a-${id}`);
const click = id => el(id).click();
function mount() {
    document.body.innerHTML = renderAmbientSettings();
    wireAmbientSettings(document.body);
    wireAmbientSettings(document.body);
}
beforeEach(() => {
    _resetDiagnostics(); _resetBudgetEnforcementState();
    ctx = { chatId: 'a', chatMetadata: {}, chat: [{ mes: '[In-story time: 12:00 PM, Thursday, June 4, 2026]' }],
        extensionSettings: { merged_world_tracker: {} }, saveMetadataDebounced: vi.fn(), setExtensionPrompt: vi.fn() };
    vi.stubGlobal('SillyTavern', { getContext: () => ctx });
    onChatChanged();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = ''; });

describe('Ambient Phase 3 user surface', () => {
    test('first enable asks once without injecting; dismiss explicitly configures and persists defaults', () => {
        mount(); expect(el('setup').hidden).toBe(true);
        click('enabled');
        expect(getSettings()).toMatchObject({ enabled: false, setupAsked: true });
        expect(el('setup').hidden).toBe(false);
        expect(onGenerationStarted()).toBe(false);
        click('dismiss');
        expect(getSettings()).toMatchObject({ enabled: true, climate: 'temperate', hemisphere: 'north' });
        expect(Number.isFinite(ctx.chatMetadata.mwt_ambient.seed)).toBe(true);
        mount(); expect(el('setup').hidden).toBe(true);
        click('enabled'); click('enabled');
        expect(el('setup').hidden).toBe(true);
    });

    test('custom settings save per chat without losing seed or pin', () => {
        ctx.chatMetadata.mwt_ambient = { ...config, seed: 0, pin };
        mount(); el('climate').value = 'arctic'; el('hemisphere').value = 'south';
        el('season').value = 'winter'; el('variability').value = '0.8'; click('save');
        expect(ctx.chatMetadata.mwt_ambient).toMatchObject({ climate: 'arctic', hemisphere: 'south', manualSeason: 'winter', variability: 0.8, seed: 0, pin });
        const old = ctx.chatMetadata;
        ctx.chatMetadata = {}; mount(); expect(getSettings().enabled).toBe(false);
        ctx.chatMetadata = old; mount(); expect(el('climate').value).toBe('arctic');
    });

    test('invalid configuration does not save or silently default', () => {
        mount(); click('enabled'); click('save');
        expect(getSettings().enabled).toBe(false);
        expect(el('status').textContent).toContain('Choose a valid');
        expect(() => saveSettings({ ...config, variability: 2 })).toThrow();
        expect(() => saveSettings({ pin: { ...pin, conditions: { ...conditions, sky: '<script>' } } })).toThrow();
    });

    test('stale settings handlers cannot write into another chat', () => {
        mount(); ctx.chatMetadata = {}; click('dismiss');
        expect(ctx.chatMetadata).toEqual({});
        expect(el('status').textContent).toContain('Chat changed');
    });

    test.each([['band', hours + 6], ['dawn', hours + 17], ['none', null], ['date', hours + 24]])('pin UI persists %s expiry and unpins', (expiry, endHours) => {
        saveSettings(config); mount();
        for (const [key, value] of Object.entries(conditions)) el(`pin-${key}`).value = value;
        el('expiry').value = expiry; el('date').value = '2026-06-05'; el('time').value = '12:00'; click('pin');
        expect(getSettings().pin).toEqual({ ...pin, endHours });
        expect(onGenerationStarted()).toBe(true);
        expect(getInjectedSnapshot('mwt_ambient_injection').payload).toContain('thunderstorm');
        expect(getInjectedSnapshot('mwt_ambient_injection').diagnostics.pinned).toBe(true);
        click('unpin'); expect(getSettings().pin).toBeNull();
    });

    test('dated pin rejects unusable clock, invalid date and past bounds', () => {
        saveSettings(config); mount(); el('expiry').value = 'date';
        el('date').value = '2026-02-30'; el('time').value = '12:00'; click('pin');
        expect(getSettings().pin).toBeNull();
        el('date').value = '2026-06-03'; click('pin');
        expect(el('status').textContent).toContain('after');
        ctx.chat = []; click('pin'); expect(el('status').textContent).toContain('calendar');
    });

    test('pin interval is exclusive at expiry, rewind-safe, clock-source-safe and forecast-aware', () => {
        saveSettings(config);
        const { ambient, time } = readAmbientConditions(getSettings(), ensureSeed());
        expect(applyAmbientPin(ambient, pin, time)).toMatchObject({ pinned: true, conditions, forecast: { pinned: false } });
        expect(isAmbientPinActive(pin, { ...time, hours: hours + 6 })).toBe(false);
        expect(isAmbientPinActive(pin, { ...time, hours: hours - 1 })).toBe(false);
        expect(isAmbientPinActive(pin, { ...time, hours: hours + 1 })).toBe(true);
        expect(isAmbientPinActive(pin, { ...time, source: 'world-state' })).toBe(true);
        expect(isAmbientPinActive(pin, { ...time, source: 'message-count' })).toBe(false);
        expect(applyAmbientPin(ambient, { ...pin, endHours: null }, time).forecast.conditions).toEqual(conditions);
        expect(applyAmbientPin(ambient, { ...pin, conditions: {} }, time).pinned).toBe(false);
    });

    test('slash alias registration, body parity, reseeding and branch inheritance', () => {
        saveSettings(config); saveSettings({ pin }); onGenerationStarted();
        expect(getInjectedSnapshot('mwt_ambient_injection').payload).toContain(ambientCommand());
        const register = vi.fn();
        createCommands({ registerSlashCommand: register, modules: { WorldState: {}, Chronicle: {}, Knowledge: {}, StoryPlanner: {}, Interiority: {}, Ambient: { ambientCommand } } }).setupSlashCommands();
        const registration = register.mock.calls.find(([name]) => name === 'wt-ambient');
        expect(registration[2]).toEqual(['wt-weather']);
        expect(registration[1]('')).toBe(ambientCommand());
        const seed = ensureSeed();
        const inherited = structuredClone(ctx.chatMetadata);
        vi.spyOn(Math, 'random').mockReturnValue(seed === 0 ? 0.5 : 0);
        const output = ambientCommand('reseed');
        expect(ensureSeed()).not.toBe(seed);
        expect(getSettings().pin).toEqual(pin);
        expect(output).toBe(buildInjectionBody(readAmbientConditions(getSettings(), ensureSeed()).ambient));
        ctx.chatMetadata = inherited; onChatChanged(); expect(ensureSeed()).toBe(seed);
        expect(ambientCommand('bad')).toContain('Usage');
    });

    test('generation expires pins at the exact bound; swipes and rewinds restore the original interval', () => {
        saveSettings(config); saveSettings({ pin });
        onGenerationStarted();
        const initial = getInjectedSnapshot('mwt_ambient_injection').payload;
        ctx.chat.push({ mes: '[In-story time: 06:00 PM, Thursday, June 4, 2026]' });
        onGenerationStarted('swipe');
        expect(getInjectedSnapshot('mwt_ambient_injection').payload).toBe(initial);
        onGenerationStarted('normal');
        expect(getInjectedSnapshot('mwt_ambient_injection').diagnostics.pinned).toBe(false);
        expect(getSettings().pin).toEqual(pin);
        ctx.chat.pop(); onGenerationStarted();
        expect(getInjectedSnapshot('mwt_ambient_injection').payload).toBe(initial);
    });

    test('Overview link opens and scrolls to the chat-local settings disclosure', async () => {
        const { wireOverviewPane } = await import('../dashboard/render.js');
        document.body.innerHTML = `<button id="mwt-tab-settings"></button>
            <details id="mwt-ambient-settings"></details><div class="mwt-tab-content" data-tab="overview">
            ${renderOverviewSnapshot({ ambient: { ok: true, value: { state: 'off' } } })}</div>`;
        const disclosure = document.querySelector('#mwt-ambient-settings');
        disclosure.scrollIntoView = vi.fn();
        wireOverviewPane(document.body, { collectMaintenance: async () => ({ ok: true, value: [] }), collectTools: async () => ({}) });
        document.querySelector('[data-overview-target="ambient-settings"]').click();
        expect(disclosure.open).toBe(true);
        expect(disclosure.scrollIntoView).toHaveBeenCalledOnce();
    });

    test('dashboard is read-only and shows current pin and expiry; panic gates command', () => {
        saveSettings(config); saveSettings({ pin });
        ctx.saveMetadataDebounced.mockClear();
        const status = getAmbientStatus();
        expect(status.ambient.conditions).toEqual(conditions);
        document.body.innerHTML = renderOverviewSnapshot({ ambient: { ok: true, value: status } });
        expect(document.body.textContent).toContain('Pin active');
        expect(document.body.textContent).toContain('2026-06-04 18:00');
        expect(ctx.saveMetadataDebounced).not.toHaveBeenCalled();
        ctx.extensionSettings.merged_world_tracker.injectionMasterOff = true;
        expect(ambientCommand()).toContain('panic');
        saveSettings({ enabled: false }); expect(ambientCommand()).toContain('off');
    });
});