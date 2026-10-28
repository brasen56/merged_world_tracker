import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { onGenerationStarted, onChatChanged, prepareGeneration, generationInterceptor, ambientCommand } from '../ambient/index.js';
import { EXTENSION_PROMPT_KEY, buildInjectionBody, clearAmbientInjection } from '../ambient/injection.js';
import { getInjectedSnapshot, getEvents, _resetDiagnostics } from '../core/diagnostics.js';
import { resetBudgetInjections, _resetBudgetEnforcementState, _setBudgetSettingsReader } from '../core/budget.js';
import { collectBudgetSnapshot, renderBudgetSnapshot } from '../budget/panel.js';
import { generateAmbientConditions } from '../core/ambient_generator.js';
import { bumpEpoch } from '../core/scope.js';

const tag = (hour = '12:00 PM', day = 4) => `[In-story time: ${hour}, Thursday, June ${day}, 2026]`;
let ctx;
let prompts;
const snapshot = () => getInjectedSnapshot(EXTENSION_PROMPT_KEY);
const ambientEvents = event => getEvents({ module: 'ambient' }).filter(entry => entry.event === event);

// Mirrors ST 1.19 Generate() at interceptor time: a normal send has inserted
// pending input and regenerate has deleted the trailing reply (script.js:4454,
// :4409), but a swiped reply is still in the raw chat. The interceptor argument
// is ST's prompt copy: hidden (is_system) messages dropped, the swiped reply
// popped (:4497) and prompt-only regex applied, imitated here by a rewrite.
function hostGenerate(type, pendingInput = null) {
    prepareGeneration(type, {}, false);
    if (pendingInput !== null) ctx.chat.push({ mes: pendingInput, is_user: true });
    if (type === 'regenerate' && ctx.chat.length && !ctx.chat.at(-1).is_user) ctx.chat.pop();
    const promptCopy = ctx.chat.filter(message => !message.is_system)
        .map(message => ({ ...message, mes: 'prompt-only rewrite' }));
    if (type === 'swipe') promptCopy.pop();
    return generationInterceptor(promptCopy, 4096, vi.fn(), type);
}

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

    test.each(['swipe', 'regenerate'])('normal and repeated %s requests agree despite the replaced message jumping ahead', type => {
        onGenerationStarted('normal');
        const initial = snapshot().payload;
        ctx.chat.push({ mes: tag('11:00 PM', 9) });
        onGenerationStarted(type);
        expect(snapshot().payload).toBe(initial);
        ctx.chat[1].mes = tag('06:00 AM', 20);
        onGenerationStarted(type);
        expect(snapshot().payload).toBe(initial);
        expect(snapshot().diagnostics.messageIndex).toBe(0);
    });

    test.each(['swipe', 'regenerate'])('%s keeps the clock from before the replaced reply, across user insertion', type => {
        ctx.chat = Array.from({ length: 4 }, () => ({ mes: 'No timestamp', is_user: false }));
        prepareGeneration('normal', {}, false);
        expect(ctx.chatMetadata.mwt_ambient.seed).toBeUndefined();
        expect(snapshot().enabled).toBe(false);
        expect(hostGenerate('normal', 'Pending user input')).toBe(true);
        const initial = snapshot().payload;
        expect(snapshot().diagnostics).toMatchObject({ storyHours: 5, band: 'dawn', timeSource: 'message-count' });
        ctx.chat.push({ mes: tag('11:00 PM', 20), is_user: false });
        for (const replacement of [tag('06:00 AM', 21), tag('09:00 PM', 25)]) {
            expect(hostGenerate(type)).toBe(true);
            expect(snapshot().payload).toBe(initial);
            expect(snapshot().diagnostics).toMatchObject({ generationType: type, storyHours: 5, band: 'dawn' });
            // The new reply lands where the replaced one was.
            if (type === 'regenerate') ctx.chat.push({ mes: replacement, is_user: false });
            else ctx.chat.at(-1).mes = replacement;
        }
        expect(ctx.chat).toHaveLength(6);
        expect(ambientEvents('ambient_time_jump')).toHaveLength(0);
    });

    test('the clock includes a timestamp in pending user input but not in a replaced reply', () => {
        ctx.chat = [{ mes: tag('01:00 PM'), is_user: false }];
        hostGenerate('normal', tag('06:00 PM'));
        const initial = snapshot().payload;
        expect(snapshot().diagnostics).toMatchObject({ messageIndex: 1, band: 'evening' });
        ctx.chat.push({ mes: tag('11:00 PM', 20), is_user: false });
        hostGenerate('swipe');
        expect(snapshot().payload).toBe(initial);
        hostGenerate('regenerate');
        expect(snapshot().payload).toBe(initial);
        ctx.chat.push({ mes: tag('11:00 PM', 20), is_user: false });
        hostGenerate('continue');
        expect(snapshot().diagnostics.messageIndex).toBe(2);
    });

    test('hidden messages and prompt-only rewrites cannot pull the injected clock away from the chat', () => {
        // /hide sets is_system, which ST's prompt copy drops; story time is the chat's.
        ctx.chat = Array.from({ length: 30 }, (_, index) => ({ mes: 'No timestamp', is_user: index % 2 === 1, is_system: index < 20 }));
        hostGenerate('normal', 'Next input');
        expect(snapshot().diagnostics).toMatchObject({ timeSource: 'message-count', storyHours: 31 });
        expect(snapshot().payload).toContain(ambientCommand());
        const initial = snapshot().payload;
        // Hiding more must not rewind the clock (or log a jump).
        for (const message of ctx.chat.slice(20, 28)) message.is_system = true;
        ctx.chat.push({ mes: 'Reply being swiped', is_user: false });
        hostGenerate('swipe');
        expect(snapshot().payload).toBe(initial);
        expect(ambientEvents('ambient_time_jump')).toHaveLength(0);
        // A tag in a hidden message still sets the clock.
        ctx.chat[3].mes = tag('09:00 PM');
        hostGenerate('swipe');
        expect(snapshot().diagnostics).toMatchObject({ timeSource: 'timestamp', messageIndex: 3, band: 'night' });
    });

    test('early dry runs leave the slot untouched and excluded interceptors do not seed', () => {
        prepareGeneration('quiet');
        generationInterceptor(ctx.chat, 4096, vi.fn(), 'quiet');
        expect(ctx.chatMetadata.mwt_ambient.seed).toBeUndefined();
        onGenerationStarted('normal');
        const prior = snapshot();
        ctx.setExtensionPrompt.mockClear();
        ctx.saveMetadataDebounced.mockClear();
        prepareGeneration('normal', {}, true);
        prepareGeneration('quiet', {}, true);
        expect(snapshot()).toEqual(prior);
        expect(ctx.setExtensionPrompt).not.toHaveBeenCalled();
        expect(ctx.saveMetadataDebounced).not.toHaveBeenCalled();
    });

    test('enabled alone reports incomplete configuration instead of an unexplained empty slot', () => {
        ctx.chatMetadata.mwt_ambient = { enabled: true };
        onGenerationStarted('normal');
        expect(snapshot()).toMatchObject({ enabled: false, diagnostics: {
            clearReason: 'configuration-incomplete', generationType: 'normal', outerBudgetAction: 'clear',
        } });
        // Nothing was registered, so the no-op clear stays out of the shared
        // event ring; the snapshot above already explains the empty slot.
        expect(ambientEvents('ambient_injection_cleared')).toHaveLength(0);
    });

    test('a quiet generation after a narrator generation identifies why the latest snapshot is empty', () => {
        onGenerationStarted('normal');
        expect(snapshot()).toMatchObject({ enabled: true, diagnostics: { generationType: 'normal' } });
        onGenerationStarted('quiet');
        expect(snapshot()).toMatchObject({ enabled: false, payload: '', diagnostics: {
            clearReason: 'generation-type-excluded', generationType: 'quiet',
        } });
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
        expect(ambientEvents('ambient_time_jump')).toHaveLength(0);
        ctx.chat[0].mes = tag('06:00 PM', 5);
        onGenerationStarted('normal');
        ctx.chat.push({ mes: tag('11:00 PM', 20) });
        onGenerationStarted('swipe');
        ctx.chat[0].mes = tag();
        onGenerationStarted('swipe');
        const events = ambientEvents('ambient_time_jump');
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
        expect(ambientEvents('ambient_time_jump')).toHaveLength(0);
    });

    test('missing host is harmless and does not create a transient seed', () => {
        delete globalThis.SillyTavern;
        expect(() => onGenerationStarted('normal')).not.toThrow();
        expect(ctx.chatMetadata.mwt_ambient.seed).toBeUndefined();
    });

    test.each(['panic-settings-save', 'panic-floating-button', 'panic-slash-command'])('direct %s cleanup records its origin in both snapshot and event history', clearReason => {
        onGenerationStarted('normal');
        clearAmbientInjection({ kind: 'ambient-conditions', clearReason });
        expect(snapshot()).toMatchObject({ enabled: false, payload: '', diagnostics: { clearReason } });
        expect(ambientEvents('ambient_injection_cleared')[0].detail)
            .toMatchObject({ clearReason });
    });

    test('clears are silent until something registers, then exactly one event per generation cycle', () => {
        // Two clears with nothing registered — the early event and the
        // interceptor — must not spend ring-buffer entries for users who
        // never enable the module. The snapshot still keeps the last reason.
        prepareGeneration('normal', {}, false);
        onGenerationStarted('quiet');
        expect(ambientEvents('ambient_injection_cleared')).toHaveLength(0);
        expect(snapshot().diagnostics).toMatchObject({ clearReason: 'generation-type-excluded' });
        // Once registered, one full generation cycle (early clear + interceptor
        // reapply) emits exactly one clear event — never two.
        expect(onGenerationStarted('normal')).toBe(true);
        expect(hostGenerate('normal')).toBe(true);
        const events = ambientEvents('ambient_injection_cleared');
        expect(events).toHaveLength(1);
        expect(events[0].detail).toMatchObject({ clearReason: 'prompt-history-pending', generationType: 'normal' });
    });

    test('clockless injection states the calendar limitation only once', () => {
        ctx.chat = [{ mes: 'No clock in this scene.' }];
        expect(onGenerationStarted('normal')).toBe(true);
        const text = snapshot().payload;
        expect(text).toContain('seasonal proxy.');
        expect(text).toContain('Moon unavailable — no calendar clock.');
        expect(text.match(/no calendar clock/g)).toHaveLength(1);
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
        expect(root).toContain('Ambient.prepareGeneration(type, options, dryRun);');
        expect(root).toContain('globalThis.mwtAmbientGenerationInterceptor = Ambient.generationInterceptor;');
        const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
        expect(manifest.generate_interceptor).toBe('mwtAmbientGenerationInterceptor');
        expect(root).toMatch(/resetBudgetInjections\(\);\s+Ambient\.onChatChanged\(\);/);
    });
});