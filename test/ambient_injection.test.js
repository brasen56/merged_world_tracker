import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { onGenerationStarted, onChatChanged } from '../ambient/index.js';
import { EXTENSION_PROMPT_KEY, buildInjectionBody } from '../ambient/injection.js';
import { getInjectedSnapshot, getEvents, _resetDiagnostics } from '../core/diagnostics.js';
import { resetBudgetInjections, _resetBudgetEnforcementState, _setBudgetSettingsReader } from '../core/budget.js';
import { collectBudgetSnapshot, renderBudgetSnapshot } from '../budget/panel.js';
import { generateAmbientConditions } from '../core/ambient_generator.js';
import { bumpEpoch } from '../core/scope.js';

const tag = (hour = '12:00 PM', day = 4) => `[In-story time: ${hour}, Thursday, June ${day}, 2026]`;
let ctx;
let prompts;
const snapshot = () => getInjectedSnapshot(EXTENSION_PROMPT_KEY);

beforeEach(() => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    _resetDiagnostics();
    _resetBudgetEnforcementState();
    _setBudgetSettingsReader(null);
    prompts = {};
    ctx = {
        chatId: 'chat-a',
        chat: [{ mes: tag() }],
        chatMetadata: { mwt_ambient: { enabled: true, climate: 'temperate', hemisphere: 'north' } },
        extensionSettings: { merged_world_tracker: {} },
        saveMetadataDebounced: vi.fn(),
        setExtensionPrompt: vi.fn((key, payload) => { prompts[key] = payload; }),
    };
    globalThis.SillyTavern = { getContext: () => ctx };
    onChatChanged();
    ctx.setExtensionPrompt.mockClear();
});

afterEach(() => {
    vi.unstubAllGlobals();
    delete globalThis.SillyTavern;
    vi.restoreAllMocks();
    _setBudgetSettingsReader(null);
    _resetBudgetEnforcementState();
});

describe('ambient per-generation runtime (real injection and budget seam)', () => {
    test.each(['normal', 'continue'])('%s registers guarded qualitative conditions and exactly one band of forecast', type => {
        expect(onGenerationStarted(type)).toBe(true);
        expect(prompts[EXTENSION_PROMPT_KEY]).toBe(snapshot().payload);
        expect(snapshot()).toMatchObject({ enabled: true, depth: 1, role: 0,
            diagnostics: { kind: 'ambient-conditions', timeSource: 'timestamp', band: 'afternoon', outerBudgetAction: 'keep' } });
        const text = snapshot().payload;
        expect(text).toContain('<mwt_ambient>');
        expect(text).toContain('Stage direction, not narration.');
        expect(text).toContain('Forecast for the next evening band only:');
        expect(text).toContain('Reference when perceptually relevant; do not re-mention conditions every reply.');
        expect(text).toContain('If this response skips ahead in time, keep conditions vague; they will be supplied next turn.');
        expect(text).not.toMatch(/°|within the hour/);
    });

    test('normal and repeated swipes agree despite the replaced message jumping ahead', () => {
        onGenerationStarted('normal');
        const initial = snapshot().payload;
        ctx.chat.push({ mes: tag('11:00 PM', 9) });
        onGenerationStarted('swipe');
        expect(snapshot().payload).toBe(initial);
        ctx.chat[1].mes = tag('06:00 AM', 20);
        onGenerationStarted('swipe');
        expect(snapshot().payload).toBe(initial);
        expect(snapshot().diagnostics.messageIndex).toBe(0);
    });

    test.each(['quiet', 'impersonate', 'unknown'])('%s clears active and desired context without creating a seed', type => {
        onGenerationStarted(type);
        expect(ctx.chatMetadata.mwt_ambient.seed).toBeUndefined();
        onGenerationStarted('normal');
        onGenerationStarted(type);
        expect(snapshot()).toMatchObject({ enabled: false, payload: '' });
        // A subsequent budget rebalance must not resurrect suppressed context.
        resetBudgetInjections();
        expect(prompts[EXTENSION_PROMPT_KEY]).toBe('');
    });

    test.each(['normal', 'quiet', 'swipe'])('dry-run %s does not read, recompute, clear, or persist', type => {
        onGenerationStarted('normal');
        const prior = snapshot();
        ctx.chat[0].mes = tag('12:00 PM', 9);
        ctx.chatMetadata.mwt_ambient.enabled = false;
        ctx.setExtensionPrompt.mockClear();
        ctx.saveMetadataDebounced.mockClear();
        onGenerationStarted(type, {}, true);
        expect(snapshot()).toEqual(prior);
        expect(ctx.setExtensionPrompt).not.toHaveBeenCalled();
        expect(ctx.saveMetadataDebounced).not.toHaveBeenCalled();
    });

    test('no enabled/configured chat means no silent climate, seed, or injection', () => {
        for (const settings of [undefined, {}, { enabled: true }, { enabled: true, climate: 'temperate' },
            { enabled: true, climate: 'invalid', hemisphere: 'north' },
            { enabled: true, climate: 'temperate', hemisphere: 'north', variability: 2 }]) {
            ctx.chatMetadata.mwt_ambient = settings;
            expect(onGenerationStarted('normal')).toBe(false);
            expect(snapshot().payload).toBe('');
            expect(ctx.chatMetadata.mwt_ambient?.seed).toBeUndefined();
        }
        expect(ctx.saveMetadataDebounced).not.toHaveBeenCalled();
    });

    test('one random seed is saved once, survives renames and inherited branch metadata', () => {
        const random = vi.spyOn(Math, 'random').mockReturnValue(0.25);
        onGenerationStarted('normal');
        const payload = snapshot().payload;
        expect(ctx.chatMetadata.mwt_ambient.seed).toBe(1073741824);
        ctx.chatId = 'renamed';
        onGenerationStarted('normal');
        expect(snapshot().payload).toBe(payload);
        ctx.chatMetadata = structuredClone(ctx.chatMetadata);
        ctx.chatId = 'branch';
        onChatChanged();
        onGenerationStarted('normal');
        expect(snapshot().payload).toBe(payload);
        expect(random).toHaveBeenCalledTimes(1);
        expect(ctx.saveMetadataDebounced).toHaveBeenCalledTimes(1);
    });

    test('an existing seed of zero is retained', () => {
        ctx.chatMetadata.mwt_ambient.seed = 0;
        onGenerationStarted('normal');
        expect(ctx.chatMetadata.mwt_ambient.seed).toBe(0);
        expect(ctx.saveMetadataDebounced).not.toHaveBeenCalled();
    });

    test('world-state fallback and synthetic swipe clock use the Phase 1 ladder', () => {
        ctx.chat = [{ mes: 'No usable clock' }];
        ctx.chatMetadata.world_state_tracker_metadata = { text: '## Current Scene\nDate: June 4, 2026\nTime: 12:00 PM' };
        onGenerationStarted('normal');
        expect(snapshot().diagnostics.timeSource).toBe('world-state');
        delete ctx.chatMetadata.world_state_tracker_metadata;
        ctx.chatMetadata.mwt_ambient.manualSeason = 'winter';
        ctx.chat = Array.from({ length: 12 }, () => ({ mes: 'No clock' }));
        onGenerationStarted('normal');
        const prior = snapshot().payload;
        expect(snapshot().diagnostics).toMatchObject({ timeSource: 'message-count', storyHours: 12, season: 'winter' });
        ctx.chat.push({ mes: 'replacement' });
        onGenerationStarted('swipe');
        expect(snapshot().payload).toBe(prior);
    });

    test('panic and module disable clear the slot', () => {
        for (const flag of ['injectionMasterOff', 'enableAmbient']) {
            ctx.extensionSettings.merged_world_tracker = {};
            onGenerationStarted('normal');
            ctx.extensionSettings.merged_world_tracker[flag] = flag === 'injectionMasterOff';
            expect(onGenerationStarted('normal')).toBe(false);
            expect(snapshot().payload).toBe('');
        }
    });

    test('structural boundaries follow the global switch', () => {
        ctx.extensionSettings.merged_world_tracker.structuralBoundaries = false;
        onGenerationStarted('normal');
        expect(snapshot().payload).not.toContain('<mwt_ambient>');
        expect(snapshot().payload).toContain('Ambient conditions (authoritative)');
    });

    test('budget panel and console collector see the registered ambient block; caps enforce', () => {
        onGenerationStarted('normal');
        const budget = collectBudgetSnapshot({ knowledgeTokens: () => 0 });
        expect(budget.modules.find(row => row.id === 'ambient')).toMatchObject({ tokens: expect.any(Number), registered: true });
        expect(budget.modules.find(row => row.id === 'ambient').tokens).toBeGreaterThan(0);
        expect(renderBudgetSnapshot(budget)).toContain('Ambient Conditions');
        ctx.chatMetadata.mwt_context_budget = { enforce: true, modules: { ambient: { hardCap: 1 } } };
        expect(onGenerationStarted('normal')).toBe(false);
        expect(snapshot()).toMatchObject({ enabled: false, payload: '', diagnostics: { outerBudgetAction: 'drop' } });
    });

    test('logs forward and backward jumps above six hours, but not stable swipes or small steps', () => {
        onGenerationStarted('normal');
        ctx.chat[0].mes = tag('06:00 PM');
        onGenerationStarted('normal');
        expect(getEvents({ module: 'ambient' })).toHaveLength(0);
        ctx.chat[0].mes = tag('06:00 PM', 5);
        onGenerationStarted('normal');
        ctx.chat.push({ mes: tag('11:00 PM', 20) });
        onGenerationStarted('swipe');
        ctx.chat[0].mes = tag();
        onGenerationStarted('swipe');
        const events = getEvents({ module: 'ambient', event: 'ambient_time_jump' });
        expect(events).toHaveLength(2);
        expect(events.map(event => event.detail.deltaHours)).toEqual([-30, 24]);
    });

    test('chat change clears stale payload and jump history; epoch guards without lifecycle dispatch', () => {
        onGenerationStarted('normal');
        onChatChanged();
        expect(snapshot().payload).toBe('');
        ctx.chat[0].mes = tag('12:00 PM', 20);
        onGenerationStarted('normal');
        bumpEpoch();
        ctx.chat[0].mes = tag();
        onGenerationStarted('normal');
        expect(getEvents({ module: 'ambient' })).toHaveLength(0);
    });

    test('missing host is harmless and does not create a transient seed', () => {
        delete globalThis.SillyTavern;
        expect(() => onGenerationStarted('normal')).not.toThrow();
        expect(ctx.chatMetadata.mwt_ambient.seed).toBeUndefined();
    });

    test('formatter does not promote next-band forecast into a within-hour claim', () => {
        const ambient = generateAmbientConditions({ seed: 42, time: { hours: 12, month: null }, climate: 'desert' });
        const body = buildInjectionBody(ambient);
        expect(body).toContain('next evening band only');
        expect(body).not.toContain('within the hour');
    });

    test('root wires the existing generation event with all host arguments and chat cleanup', () => {
        const root = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
        expect(root).toContain("onAnyEvent(['GENERATION_STARTED'], (type, options, dryRun) => {");
        expect(root).toContain('Ambient.onGenerationStarted(type, options, dryRun);');
        expect(root).toMatch(/resetBudgetInjections\(\);\s+Ambient\.onChatChanged\(\);/);
    });
});