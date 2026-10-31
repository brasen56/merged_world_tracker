/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { parseAmbientTimestamp, resolveAmbientTime } from '../core/ambient_time.js';
import { getWeekdayDriftStatus, observeWeekdayDrift } from '../core/weekday_drift.js';
import { _resetDiagnostics, getEvents } from '../core/diagnostics.js';
import { bumpEpoch } from '../core/scope.js';
import { collectOverviewSnapshot } from '../dashboard/status.js';
import { renderOverviewSnapshot } from '../dashboard/render.js';

const tag = (weekday = 'Friday', date = 'June 4, 2026') => `[In-story time: 02:30 PM, ${weekday}, ${date}]`;
let ctx;
beforeEach(() => {
    _resetDiagnostics();
    bumpEpoch();
    ctx = { chatId: 'weekday', chat: [{ mes: tag() }], chatMetadata: {},
        extensionSettings: { merged_world_tracker: { injectionMasterOff: true, enableWorldState: false } },
        saveMetadataDebounced: vi.fn(), setExtensionPrompt: vi.fn() };
    vi.stubGlobal('SillyTavern', { getContext: () => ctx });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = ''; });

describe('Gregorian weekday drift', () => {
    test('is safe before the host or chat is available', () => {
        vi.stubGlobal('SillyTavern', { getContext: () => null });
        expect(observeWeekdayDrift()).toBeNull();
        expect(observeWeekdayDrift()).toBeNull();
        expect(getEvents({ module: 'calendar' })).toEqual([]);
    });

    test('retains normalized tagged and UTC-computed weekdays without changing the clock', () => {
        const mismatch = parseAmbientTimestamp(tag('fRiDaY'));
        const match = parseAmbientTimestamp(tag('Thursday'));
        expect(mismatch.weekday).toEqual({ tagged: 'Friday', computed: 'Thursday', mismatch: true });
        expect(match.weekday.mismatch).toBe(false);
        expect(mismatch.hours).toBe(match.hours);
        expect(parseAmbientTimestamp(tag('Thursday', '2026-06-04')).weekday.mismatch).toBe(false);
    });

    test.each([
        ['Tuesday', 'January 1, 1850'],
        ['Thursday', 'February 29, 2024'],
        ['Monday', 'January 1, 1'],
    ])('computes %s for %s, including pre-epoch and early years', (weekday, date) => {
        expect(parseAmbientTimestamp(tag(weekday, date)).weekday).toEqual({ tagged: weekday, computed: weekday, mismatch: false });
    });

    test('Overview badge and diagnostics work with Ambient absent and panic on, with no writes', () => {
        const before = JSON.stringify(ctx);
        const status = observeWeekdayDrift();
        expect(status).toEqual({ date: '2026-06-04', tagged: 'Friday', computed: 'Thursday', messageIndex: 0, messagesAfter: 0 });
        const snapshot = collectOverviewSnapshot();
        expect(snapshot.ambient.value.state).toBe('off');
        expect(snapshot.weekdayDrift).toEqual({ ok: true, value: status });
        document.body.innerHTML = renderOverviewSnapshot(snapshot);
        const badge = document.querySelector('.mwt-overview-weekday-drift');
        expect(badge.getAttribute('role')).toBe('status');
        expect(badge.textContent).toContain('message #0 tags 2026-06-04 as Friday');
        expect(badge.textContent).toContain('Gregorian date is Thursday');
        expect(getEvents({ module: 'calendar' })).toMatchObject([
            { event: 'gregorian_weekday_drift', level: 'warn', detail: status },
        ]);
        expect(JSON.stringify(ctx)).toBe(before);
        expect(ctx.saveMetadataDebounced).not.toHaveBeenCalled();
        expect(ctx.setExtensionPrompt).not.toHaveBeenCalled();
    });

    test.each([
        tag('Thursday'), 'No timestamp', '[In-story time: Unknown]',
        tag('Friday', 'February 29, 2025'), tag('Moonday'),
    ])('matches, absent tags and unusable dates remain silent: %s', text => {
        ctx.chat = [{ mes: text }];
        expect(observeWeekdayDrift()).toBeNull();
        expect(getEvents({ module: 'calendar' })).toEqual([]);
        document.body.innerHTML = renderOverviewSnapshot({ weekdayDrift: { ok: true, value: getWeekdayDriftStatus() } });
        expect(document.querySelector('.mwt-overview-weekday-drift')).toBeNull();
    });

    test('uses the same last-usable-tag ladder and replacement semantics as the clock', () => {
        ctx.chat = [{ mes: tag() }, { mes: `${tag('Friday')} ${tag('Thursday')} [In-story time: Unknown]` }];
        expect(getWeekdayDriftStatus()).toBeNull();
        expect(resolveAmbientTime({ messages: ctx.chat, type: 'swipe' }).weekday.mismatch).toBe(true);
        ctx.chat.pop();
        ctx.chat.push({ mes: 'Later narration' });
        expect(getWeekdayDriftStatus()).toMatchObject({ messageIndex: 0, messagesAfter: 1 });
    });

    test('deduplicates observations but re-evaluates edits, swipes, rewinds and scope changes', () => {
        observeWeekdayDrift(); observeWeekdayDrift(); getWeekdayDriftStatus();
        ctx.chat.push({ mes: 'No new clock' }); observeWeekdayDrift();
        expect(getEvents({ module: 'calendar' })).toHaveLength(1);
        ctx.chat[0].mes = tag('Thursday');
        expect(observeWeekdayDrift()).toBeNull();
        ctx.chat[0].mes = tag(); observeWeekdayDrift();
        expect(getEvents({ module: 'calendar' })).toHaveLength(2);
        ctx.chat[0].mes = tag('Saturday'); observeWeekdayDrift();
        expect(getEvents({ module: 'calendar' })).toHaveLength(3);
        bumpEpoch(); observeWeekdayDrift();
        expect(getEvents({ module: 'calendar' })).toHaveLength(4);
        ctx.chat = [{ mes: tag('Saturday') }]; observeWeekdayDrift();
        expect(getEvents({ module: 'calendar' })).toHaveLength(5);
        ctx.chat = []; expect(observeWeekdayDrift()).toBeNull();
    });

    test('badge escapes supplied status fields', () => {
        document.body.innerHTML = renderOverviewSnapshot({ weekdayDrift: { ok: true,
            value: { date: '<img src=x onerror=alert(1)>', tagged: '<script>bad</script>', computed: 'Thursday', messageIndex: 0 } } });
        expect(document.querySelector('img, script')).toBeNull();
        expect(document.body.textContent).toContain('<script>bad</script>');
    });
});