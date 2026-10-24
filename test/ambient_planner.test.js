import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { buildAmbientPlannerContext, describeConditions } from '../core/ambient_prompt.js';
import { readAmbientConditions } from '../core/ambient_state.js';
import { parseAmbientDateTime } from '../core/ambient_time.js';
import { buildUserPrompt } from '../story_planner/generation.js';
import { buildTargetedUserPrompt, TARGETED_OPERATIONS } from '../story_planner/targeted.js';
import { buildStoryPlanSystemPrompt } from '../story_planner/prompts.js';
import { saveSettings } from '../story_planner/settings.js';
import { resetCoreStubs, getFakeMeta, getContextSafe, setFakeChat, setFakeContextExtras } from './stubs/core.js';

const config = { enabled: true, climate: 'temperate', hemisphere: 'north', manualSeason: 'spring', variability: 0.5, seed: 0 };
const pinned = { sky: 'overcast', temperature: 'cool', air: 'damp', precipitation: 'thunderstorm', wind: 'strong' };
const hours = parseAmbientDateTime('2026-06-04', '12:00').hours;

beforeEach(() => {
    resetCoreStubs();
    setFakeChat([{ mes: '[In-story time: 12:00 PM, Thursday, June 4, 2026]' }]);
    setFakeContextExtras({ extensionSettings: { merged_world_tracker: {} }, saveMetadataDebounced: vi.fn(), setExtensionPrompt: vi.fn() });
    vi.stubGlobal('SillyTavern', { getContext: getContextSafe });
    getFakeMeta().mwt_ambient = { ...config };
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Ambient Phase 4 planner integration', () => {
    test('current conditions and exactly one forecast match the shared live projection without writes', () => {
        const before = JSON.stringify(getFakeMeta());
        const { ambient } = readAmbientConditions(config, config.seed);
        const context = buildAmbientPlannerContext();
        expect(context).toContain(`Current ${ambient.band.name} band: ${describeConditions(ambient.conditions)}`);
        expect(context).toContain(`Forecast for the next ${ambient.forecast.band.name} band only: ${describeConditions(ambient.forecast.conditions)}`);
        expect(context.match(/Forecast for/g)).toHaveLength(1);
        expect(context).toContain('do not invent conflicting weather');
        expect(context).toContain('Beyond that band or after a time skip, leave weather unspecified');
        expect(JSON.stringify(getFakeMeta())).toBe(before);
        expect(getContextSafe().saveMetadataDebounced).not.toHaveBeenCalled();
        expect(getContextSafe().setExtensionPrompt).not.toHaveBeenCalled();
    });

    test.each([
        {},
        { enabled: false },
        { climate: 'invalid' },
        { hemisphere: 'invalid' },
        { manualSeason: 'invalid' },
        { variability: 2 },
        { seed: undefined },
        { seed: NaN },
    ])('inactive or incomplete configuration is omitted: %j', patch => {
        getFakeMeta().mwt_ambient = Object.keys(patch).length ? { ...config, ...patch } : {};
        expect(buildAmbientPlannerContext()).toBe('');
        expect(buildUserPrompt('story')).not.toContain('<ambient_conditions>');
        expect(getContextSafe().saveMetadataDebounced).not.toHaveBeenCalled();
    });

    test.each(['injectionMasterOff', 'enableAmbient'])('global gate %s omits planner weather', key => {
        getContextSafe().extensionSettings.merged_world_tracker[key] = key === 'injectionMasterOff';
        expect(buildAmbientPlannerContext()).toBe('');
    });

    test('full-plan and custom templates retain application-owned weather before output instructions', () => {
        expect(buildUserPrompt('story')).toContain('<ambient_conditions>');
        saveSettings({ customUserPrompt: 'CUSTOM {{chatHistory}}\nOutput only the plan.' });
        const prompt = buildUserPrompt('story');
        expect(prompt).toContain('<ambient_conditions>');
        expect(prompt).toContain('CUSTOM');
        expect(prompt.endsWith('Output only the plan.')).toBe(true);
    });

    test.each(['open', 'world-pressure'])('scoped Add uses weather under %s lens', lens => {
        const prompt = buildUserPrompt('story', '', { requestSpec: { operation: 'add', sectionKeys: ['emerging'], requestedCount: 1, lens } });
        expect(prompt).toContain('<ambient_conditions>');
        expect(prompt).toContain(buildAmbientPlannerContext());
    });

    test('Refresh receives weather without changing lens or arc ownership', () => {
        const prompt = buildUserPrompt('story', '', { requestSpec: { operation: 'refresh', sectionKeys: ['emerging'], targetArcIds: ['arc-1'], lens: 'world-pressure' } });
        expect(prompt).toContain('<ambient_conditions>');
        expect(prompt).not.toContain('Focus: world complications');
        expect(prompt).toContain('Do not add new arcs');
    });

    test.each(TARGETED_OPERATIONS)('targeted %s receives the same weather', operation => {
        const prompt = buildTargetedUserPrompt(operation, { title: 'A road', body: 'A crossing.', section: 'emerging', beats: [] });
        expect(prompt).toContain(buildAmbientPlannerContext());
        expect(prompt.endsWith('Return the JSON object now.')).toBe(true);
    });

    test('world-pressure lens explicitly defers weather ownership to Ambient Conditions', () => {
        expect(buildStoryPlanSystemPrompt(['emerging'], 'world-pressure')).toContain('weather and sky conditions come from that module');
        expect(buildStoryPlanSystemPrompt(['emerging'], 'open')).not.toContain('weather and sky conditions come from that module');
    });

    test('pin applies only inside its interval, including forecast expiry and rewind', () => {
        getFakeMeta().mwt_ambient.pin = { startHours: hours, endHours: hours + 1, source: 'timestamp', conditions: pinned };
        expect(buildAmbientPlannerContext()).toContain(`Current afternoon band: ${describeConditions(pinned)}`);
        const { ambient } = readAmbientConditions(getFakeMeta().mwt_ambient, 0);
        expect(ambient.forecast.conditions).not.toEqual(pinned);
        setFakeChat([{ mes: '[In-story time: 2:00 PM, Thursday, June 4, 2026]' }]);
        expect(buildAmbientPlannerContext()).not.toContain(`Current afternoon band: ${describeConditions(pinned)}`);
        setFakeChat([{ mes: '[In-story time: 12:00 PM, Thursday, June 4, 2026]' }]);
        expect(buildAmbientPlannerContext()).toContain(`Current afternoon band: ${describeConditions(pinned)}`);
    });

    test('message-count fallback and chat switches recompute rather than reuse a cached block', () => {
        setFakeChat([{ mes: 'No calendar' }]);
        expect(buildAmbientPlannerContext()).toContain('Current night band:');
        getFakeMeta().mwt_ambient = {};
        expect(buildAmbientPlannerContext()).toBe('');
        getFakeMeta().mwt_ambient = { ...config, climate: 'arctic', seed: 123 };
        expect(buildAmbientPlannerContext()).toContain('Current night band:');
    });
});