/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createFloatingButtonBar } from '../core/ui.js';
import * as Ledger from '../ledger/index.js';
import { createLedger } from '../ledger/data.js';
import { saveLedger } from '../ledger/store.js';
import { EXTENSION_PROMPT_KEY } from '../ledger/injection.js';
import { _resetDiagnostics, getInjectedSnapshot } from '../core/diagnostics.js';
import { _resetBudgetEnforcementState } from '../core/budget.js';
import { _resetPausedStores } from '../core/schema_status.js';

let ctx;
let settings;
let prompts;

beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    settings = {};
    prompts = new Map();
    ctx = {
        chatId: 'ledger-floating-panic', chat: [], chatMetadata: {},
        extensionSettings: { merged_world_tracker: settings },
        saveMetadataDebounced: vi.fn(),
        setExtensionPrompt: vi.fn((key, payload) => prompts.set(key, payload)),
    };
    vi.stubGlobal('SillyTavern', { getContext: () => ctx });
    _resetDiagnostics();
    _resetBudgetEnforcementState();
    _resetPausedStores();
});

afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    _resetPausedStores();
    _resetBudgetEnforcementState();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

test.each([null, 'enableLedger', 'injectLedger'])('floating panic clears Ledger and restores it only if allowed (gate: %s)', gate => {
    const ledger = {
        ...createLedger(),
        items: [{ id: 'rope', name: 'rope', qty: 2, carried: true, note: '' }],
    };
    saveLedger(ledger);
    const payload = prompts.get(EXTENSION_PROMPT_KEY);
    expect(payload).toContain('Carried: rope ×2.');
    expect(getInjectedSnapshot(EXTENSION_PROMPT_KEY).enabled).toBe(true);
    const savedMetadata = JSON.stringify(ctx.chatMetadata);
    ctx.saveMetadataDebounced.mockClear();

    const saveSettings = vi.fn(patch => Object.assign(settings, patch));
    const bar = createFloatingButtonBar({
        getSettings: () => settings,
        saveSettings,
        openModal: vi.fn(),
        modules: { WorldState: {}, Chronicle: {}, Knowledge: {}, StoryPlanner: {}, Interiority: {}, Ledger },
    });
    // Keep the factory's resize listener scoped to this test.
    vi.spyOn(window, 'addEventListener').mockImplementation(() => {});
    bar.setupButtonBar();
    const button = document.getElementById('mwt-float-settings');
    const togglePanic = () => {
        const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        button.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
    };

    togglePanic();
    expect(settings.injectionMasterOff).toBe(true);
    expect(saveSettings).toHaveBeenLastCalledWith({ injectionMasterOff: true });
    expect(prompts.get(EXTENSION_PROMPT_KEY)).toBe('');
    expect(getInjectedSnapshot(EXTENSION_PROMPT_KEY).enabled).toBe(false);

    if (gate) settings[gate] = false;
    togglePanic();
    expect(settings.injectionMasterOff).toBe(false);
    expect(saveSettings).toHaveBeenLastCalledWith({ injectionMasterOff: false });
    expect(prompts.get(EXTENSION_PROMPT_KEY)).toBe(gate ? '' : payload);
    expect(getInjectedSnapshot(EXTENSION_PROMPT_KEY).enabled).toBe(!gate);
    expect(JSON.stringify(ctx.chatMetadata)).toBe(savedMetadata);
    expect(ctx.saveMetadataDebounced).not.toHaveBeenCalled();
});