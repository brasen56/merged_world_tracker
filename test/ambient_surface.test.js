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
    test('Phase 6 anchor controls round-trip, clear, validate and remain chat-local', () => {
        saveSettings(config); mount();
        expect(el('moon-date').value).toBe('');
        expect(el('moon-time').value).toBe('18:00');
        expect(ctx.chatMetadata.mwt_ambient).not.toHaveProperty('moonEpochOffset');
        el('moon-date').value = '2026-10-24'; el('moon-time').value = '19:30'; click('save');
        const stored = getSettings().moonEpochOffset;
        expect(Number.isFinite(stored)).toBe(true);
        mount();
        expect(el('moon-date').value).toBe('2026-10-24');
        expect(el('moon-time').value).toBe('19:30');
        el('moon-time').value = ''; click('save');
        expect(el('status').textContent).toContain('valid full moon');
        expect(getSettings().moonEpochOffset).toBe(stored);
        expect(() => saveSettings({ moonEpochOffset: Infinity })).toThrow('Moon anchor');
        const previous = ctx.chatMetadata;
        ctx.chatMetadata = {}; mount(); expect(el('moon-date').value).toBe('');
        ctx.chatMetadata = previous; mount(); el('moon-date').value = ''; click('save');
        expect(getSettings().moonEpochOffset).toBeNull();
    });

    test('Phase 6 moon and pinned night brightness agree on every surface without read writes', async () => {
        const { buildAmbientPlannerContext } = await import('../core/ambient_prompt.js');
        const { moonAnchorOffset } = await import('../core/ambient_astronomy.js');
        const night = parseAmbientDateTime('2026-10-24', '21:00').hours;
        ctx.chat = [{ mes: '[In-story time: 09:00 PM, Saturday, October 24, 2026]' }];
        saveSettings({ ...config, moonEpochOffset: moonAnchorOffset(night),
            pin: { startHours: night, endHours: null, source: 'timestamp', conditions: { ...conditions, sky: 'clear', precipitation: 'none' } } });
        const status = getAmbientStatus();
        expect(status.ambient.moon).toMatchObject({ name: 'full', up: true, brightness: 'bright moonlight, shadows cast' });
        ctx.saveMetadataDebounced.mockClear();
        const before = JSON.stringify(ctx.chatMetadata);
        onGenerationStarted();
        const description = status.ambient.moon.description;
        expect(getInjectedSnapshot('mwt_ambient_injection').payload).toContain(description);
        expect(ambientCommand()).toBe(buildInjectionBody(status.ambient));
        expect(renderOverviewSnapshot({ ambient: { ok: true, value: status } })).toContain(description);
        expect(buildAmbientPlannerContext()).toContain(description);
        ctx.chat.push({ mes: 'A replaced reply' });
        onGenerationStarted('swipe');
        expect(getInjectedSnapshot('mwt_ambient_injection').payload).toContain(description);
        expect(JSON.stringify(ctx.chatMetadata)).toBe(before);
        expect(ctx.saveMetadataDebounced).not.toHaveBeenCalled();
        ctx.chat = [{ mes: 'No clock' }];
        const fallback = getAmbientStatus();
        expect(fallback.ambient.moon).toBeNull();
        expect(buildInjectionBody(fallback.ambient)).not.toContain('Moon:');
        expect(buildAmbientPlannerContext()).not.toContain('Moon at');
        expect(ambientCommand()).toContain('no calendar clock');
        expect(renderOverviewSnapshot({ ambient: { ok: true, value: fallback } })).toContain('Moon: unavailable — no calendar clock');
    });

    test('Phase 5 defaults are read-only, shown in Overview, and not saved by unrelated settings', () => {
        saveSettings(config);
        ctx.saveMetadataDebounced.mockClear();
        const before = JSON.stringify(ctx.chatMetadata);
        mount();
        expect(el('latitude').value).toBe('');
        expect(el('latitude').placeholder).toContain('45°');
        expect(getSettings().latitude).toBeNull();
        const status = getAmbientStatus();
        const overview = renderOverviewSnapshot({ ambient: { ok: true, value: status } });
        expect(overview).toContain('Latitude 45° (temperate default) — set yours');
        expect(overview).toContain(status.ambient.daylight.description);
        expect(JSON.stringify(ctx.chatMetadata)).toBe(before);
        expect(ctx.saveMetadataDebounced).not.toHaveBeenCalled();
        saveSettings({ variability: 0.8 });
        expect(ctx.chatMetadata.mwt_ambient).not.toHaveProperty('latitude');
        expect(ctx.chatMetadata.mwt_ambient).not.toHaveProperty('clockAhead');
    });

    test('Phase 5 controls save explicit latitude and clock offset, and blank restores the derived default', () => {
        saveSettings(config); mount();
        el('latitude').value = '60'; el('clock-ahead').value = '1'; click('save');
        expect(getSettings()).toMatchObject({ latitude: 60, clockAhead: 1 });
        mount();
        expect(el('latitude').value).toBe('60');
        expect(el('clock-ahead').value).toBe('1');
        el('latitude').value = ''; el('climate').value = 'arctic'; click('save');
        expect(getAmbientStatus().ambient.daylight).toMatchObject({ latitude: 65, isDefault: true });
        expect(ctx.chatMetadata.mwt_ambient.latitude).toBeNull();
    });

    test.each([{ latitude: -1 }, { latitude: 91 }, { latitude: '60' }, { latitude: NaN },
        { clockAhead: 0.25 }, { clockAhead: 3 }, { clockAhead: -0.5 }, { clockAhead: '1' }])('Phase 5 rejects invalid settings without writes: %j', patch => {
        saveSettings(config);
        const before = JSON.stringify(ctx.chatMetadata);
        expect(() => saveSettings(patch)).toThrow();
        expect(JSON.stringify(ctx.chatMetadata)).toBe(before);
    });

    test.each(['normal', 'continue', 'regenerate', 'swipe'])('Phase 5 August daylight is shared across %s, command, planner, and Overview', async type => {
        saveSettings({ ...config, latitude: 60, clockAhead: 1 });
        ctx.chat = [{ mes: '[In-story time: 05:00 PM, Saturday, August 15, 2026]', is_user: true }];
        if (type === 'swipe') ctx.chat.push({ mes: '[In-story time: 11:00 PM, Saturday, August 15, 2026]', is_user: false });
        onGenerationStarted(type);
        const payload = getInjectedSnapshot('mwt_ambient_injection').payload;
        const { ambient } = readAmbientConditions(getSettings(), ensureSeed(), type);
        expect(ambient.daylight.regime).toBe('daylight');
        expect(payload).toContain(ambient.daylight.description);
        if (type === 'swipe') {
            ctx.chat.at(-1).mes = 'A different swiped reply';
            onGenerationStarted(type);
            expect(getInjectedSnapshot('mwt_ambient_injection').payload).toBe(payload);
            ctx.chat.pop();
        }
        expect(ambientCommand()).toBe(buildInjectionBody(ambient));
        expect(renderOverviewSnapshot({ ambient: { ok: true, value: getAmbientStatus() } })).toContain(ambient.daylight.description);
        const { buildAmbientPlannerContext } = await import('../core/ambient_prompt.js');
        expect(buildAmbientPlannerContext()).toContain(ambient.daylight.description);
    });

    test('variability feedback updates live without saving and resets with explicit defaults', () => {
        mount();
        expect(el('variability-value').textContent).toBe('50% — balanced (default)');
        expect(el('variability').getAttribute('aria-describedby')).toBe('mwt-a-variability-help');
        expect(el('variability-help').textContent).toContain('not its severity');
        ctx.saveMetadataDebounced.mockClear();
        for (const [value, text] of [['0', '0% — slower changes'], ['1', '100% — faster changes']]) {
            el('variability').value = value;
            el('variability').dispatchEvent(new Event('input', { bubbles: true }));
            expect(el('variability-value').textContent).toBe(text);
            expect(el('variability').getAttribute('aria-valuetext')).toBe(text);
        }
        expect(ctx.saveMetadataDebounced).not.toHaveBeenCalled();
        expect(getSettings().variability).toBe(0.5);
        click('dismiss');
        expect(el('variability-value').textContent).toBe('50% — balanced (default)');
        expect(el('variability').getAttribute('aria-valuetext')).toBe('50% — balanced (default)');
        el('variability').value = '0.8'; click('save'); mount();
        expect(el('variability-value').textContent).toBe('80% — faster changes');
    });

    test('Overview exposes the exact resolved clock, stale tag source and next band boundary', () => {
        saveSettings(config);
        ctx.chat[0].mes = '[In-story time: 11:37 PM, Thursday, June 4, 2026]';
        ctx.chat.push({ mes: 'A later message without a usable timestamp' });
        ctx.saveMetadataDebounced.mockClear();
        document.body.innerHTML = renderOverviewSnapshot({ ambient: { ok: true, value: getAmbientStatus() } });
        expect(document.body.textContent).toContain('Story clock used: 2026-06-04 23:37');
        expect(document.body.textContent).toContain('latest usable In-story time tag (message #0, 1 message ago)');
        expect(document.body.textContent).toContain('Current night:');
        expect(document.body.textContent).toContain('Next dawn (2026-06-05 05:00)');
        expect(ctx.saveMetadataDebounced).not.toHaveBeenCalled();
    });

    test('Overview labels World State and synthetic clock fallbacks without fabricating calendar dates', () => {
        saveSettings(config);
        ctx.chat = [{ mes: 'No clock' }];
        ctx.chatMetadata.world_state_tracker_metadata = { text: '## Current Scene\nDate: June 4, 2026\nTime: 12:00 PM' };
        document.body.innerHTML = renderOverviewSnapshot({ ambient: { ok: true, value: getAmbientStatus() } });
        expect(document.body.textContent).toContain('Story clock used: 2026-06-04 12:00');
        expect(document.body.textContent).toContain('Source: World State Current Scene');
        delete ctx.chatMetadata.world_state_tracker_metadata;
        ctx.saveMetadataDebounced.mockClear();
        document.body.innerHTML = renderOverviewSnapshot({ ambient: { ok: true, value: getAmbientStatus() } });
        expect(document.body.textContent).toContain('Story clock used: synthetic story hour 1');
        expect(document.body.textContent).toContain('message-count fallback; no usable story date/time');
        expect(document.body.textContent).toContain('Next dawn (synthetic story hour 5)');
        expect(document.body.textContent).not.toContain('1970-');
        expect(ctx.saveMetadataDebounced).not.toHaveBeenCalled();
    });

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
        expect(registration[1]({}, '')).toBe(ambientCommand());
        expect(registration[1]({ ignored: 'reseed' })).toBe(ambientCommand());
        const seed = ensureSeed();
        const inherited = structuredClone(ctx.chatMetadata);
        vi.spyOn(Math, 'random').mockReturnValue(seed === 0 ? 0.5 : 0);
        const output = registration[1]({}, 'reseed');
        expect(ensureSeed()).not.toBe(seed);
        expect(getSettings().pin).toEqual(pin);
        expect(output).toBe(buildInjectionBody(readAmbientConditions(getSettings(), ensureSeed()).ambient));
        ctx.chatMetadata = inherited; onChatChanged(); expect(ensureSeed()).toBe(seed);
        expect(registration[1]({}, 'bad')).toContain('Usage');
    });

    test('/wt-inject reads the typed value the way ST passes it and clears the ambient line', async () => {
        saveSettings(config); onGenerationStarted();
        expect(getInjectedSnapshot('mwt_ambient_injection').enabled).toBe(true);
        const register = vi.fn();
        const saved = [];
        createCommands({ registerSlashCommand: register, saveSettings: patch => saved.push(patch),
            modules: { WorldState: {}, Chronicle: {}, Knowledge: {}, StoryPlanner: {}, Interiority: {}, Ambient: { ambientCommand } } }).setupSlashCommands();
        const inject = register.mock.calls.find(([name]) => name === 'wt-inject')[1];
        // ST passes (namedArgs, value); the named-args object is never the text.
        await expect(inject({ _scope: {} }, 'off')).resolves.toBe('Injection off for all modules.');
        expect(saved).toEqual([{ injectionMasterOff: true }]);
        expect(getInjectedSnapshot('mwt_ambient_injection')).toMatchObject({ enabled: false, diagnostics: { clearReason: 'panic-slash-command' } });
        await expect(inject({}, 'sideways')).resolves.toBe('Usage: /wt-inject on|off');
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