/** Inline chat-local setup and pin controls, wired on each main-modal render. */
import { escapeHtml } from '../core/diff.js';
import { getChatMeta } from '../core/context.js';
import { getEpoch } from '../core/scope.js';
import { AMBIENT_CLIMATES, AMBIENT_SEASONS, AMBIENT_VOCABULARY } from '../core/ambient_generator.js';
import { AMBIENT_HOUR_MS, parseAmbientDateTime } from '../core/ambient_time.js';
import { readAmbientConditions } from '../core/ambient_state.js';
import { isMoonEpochOffset, LUNAR_EPOCH_HOURS, LUNAR_MONTH_DAYS, moonAnchorOffset, resolveAmbientLatitude } from '../core/ambient_astronomy.js';
import { getSettings, saveSettings, isConfigured, ensureSeed } from './settings.js';
import { clearAmbientInjection } from './injection.js';

function select(id, label, values, selected, blank = false) {
    const entries = Array.isArray(values) ? values.map(value => [value, value]) : Object.entries(values);
    return `<label class="mwt-label" for="${id}">${label}</label><select class="mwt-input" id="${id}">
        ${blank ? '<option value="">Choose…</option>' : ''}
        ${entries.map(([value, name]) => `<option value="${escapeHtml(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select>`;
}

function variabilityText(value) {
    return `${Math.round(value * 100)}% — ${value < 0.5 ? 'slower changes' : value > 0.5 ? 'faster changes' : 'balanced (default)'}`;
}

export function renderAmbientSettings() {
    const s = getSettings();
    const variability = Number.isFinite(s.variability) ? s.variability : 0.5;
    const anchor = isMoonEpochOffset(s.moonEpochOffset)
        ? new Date(Math.round((LUNAR_EPOCH_HOURS + s.moonEpochOffset + LUNAR_MONTH_DAYS * 12) * AMBIENT_HOUR_MS)).toISOString() : '';
    return `<details class="mwt-settings-disclosure" id="mwt-ambient-settings" open>
        <summary><span aria-hidden="true">🌦️</span> Ambient Conditions (this chat)</summary>
        <p>Code decides the weather; narration renders it when relevant. These controls save separately from global settings.</p>
        <label for="mwt-a-enabled"><input type="checkbox" id="mwt-a-enabled" ${s.enabled ? 'checked' : ''}> Enable Ambient Conditions</label>
        <div id="mwt-a-setup" role="status" ${!s.setupAsked || isConfigured(s) ? 'hidden' : ''}>
            Choose the climate and hemisphere before enabling.
            <button type="button" class="mwt-btn" id="mwt-a-dismiss">Temperate, don’t ask again (Northern hemisphere)</button>
        </div>
        <div class="mwt-settings-grid">
            ${select('mwt-a-climate', 'Climate', Object.fromEntries(Object.entries(AMBIENT_CLIMATES).map(([key, preset]) => [key, preset.label])), s.climate, true)}
            ${select('mwt-a-hemisphere', 'Hemisphere', { north: 'Northern', south: 'Southern' }, s.hemisphere, true)}
            <label class="mwt-label" for="mwt-a-latitude">Latitude magnitude (0–90°; hemisphere supplies the sign)</label>
            <div><input class="mwt-input" id="mwt-a-latitude" type="number" min="0" max="90" step="any" value="${Number.isFinite(s.latitude) ? s.latitude : ''}" placeholder="Climate default: ${resolveAmbientLatitude(s).latitude}°">
                <p class="mwt-text-dim mwt-text-sm">Leave blank to follow the climate default; no default latitude is saved.</p></div>
            ${select('mwt-a-clock-ahead', 'Clocks run ahead of the sun by', { '0': '0 hours (sun time)', '0.5': '30 minutes', '1': '1 hour', '1.5': '1 hour 30 minutes', '2': '2 hours' }, String(s.clockAhead))}
            <p class="mwt-text-dim mwt-text-sm">Offsets stated sky-event times only. No longitude, time-zone or automatic summer-time modeling.</p>
            <label class="mwt-label" for="mwt-a-moon-date">Full moon falls on (story date)</label>
            <div><input class="mwt-input" id="mwt-a-moon-date" type="date" value="${escapeHtml(anchor.slice(0, 10))}">
                <label for="mwt-a-moon-time">Story time of full moon</label>
                <input class="mwt-input" id="mwt-a-moon-time" type="time" value="${anchor ? anchor.slice(11, 16) : '18:00'}">
                <p class="mwt-text-dim mwt-text-sm">Optional. Blank date restores the real-world moon cycle. Re-anchoring rewrites past and future phases consistently; it is not a weather pin. Moon facts need a calendar clock. Moon-up is approximate and ignores latitude.</p></div>
            ${select('mwt-a-season', 'Manual season (when no calendar is usable)', AMBIENT_SEASONS, s.manualSeason)}
            <label class="mwt-label" for="mwt-a-variability">Variability (change frequency)</label>
            <div>
                <input id="mwt-a-variability" type="range" min="0" max="1" step="0.05" value="${variability}" aria-describedby="mwt-a-variability-help" aria-valuetext="${variabilityText(variability)}">
                <div class="mwt-text-dim mwt-text-sm">Slower (0%) → Faster (100%)</div>
                <output id="mwt-a-variability-value" for="mwt-a-variability">${variabilityText(variability)}</output>
                <p class="mwt-text-dim mwt-text-sm" id="mwt-a-variability-help">Controls how often weather changes as story time advances, not its severity or which conditions your climate allows. 0% means slower changes, not frozen weather; 50% is the default. Conditions stay stable within each time band (dawn, morning, afternoon, evening, night). Changes take effect after Save Ambient Settings.</p>
            </div>
        </div>
        <button type="button" class="mwt-btn" id="mwt-a-save">Save Ambient Settings</button>
        <details><summary>Pin conditions</summary>
            <p>Pins override rolls, including climate restrictions. Expiry uses story time, not real time.</p>
            <div class="mwt-settings-grid">
                ${Object.entries(AMBIENT_VOCABULARY).map(([key, values]) => select(`mwt-a-pin-${key}`, key, values, s.pin?.conditions?.[key] || values[0])).join('')}
                ${select('mwt-a-expiry', 'Expires', { none: 'Until unpinned', band: 'Next band', dawn: 'Next dawn', date: 'Story date/time' }, 'none')}
                <label for="mwt-a-date">Story date (YYYY-MM-DD)</label><input class="mwt-input" id="mwt-a-date" type="text" placeholder="2026-06-05">
                <label for="mwt-a-time">Story time (HH:MM, 24-hour)</label><input class="mwt-input" id="mwt-a-time" type="text" placeholder="05:00">
            </div>
            <button type="button" class="mwt-btn" id="mwt-a-pin">Pin now</button>
            <button type="button" class="mwt-btn" id="mwt-a-unpin">Unpin</button>
        </details>
        <p id="mwt-a-status" role="status" aria-live="polite">${s.pin ? 'A pin is stored; see Overview for its current status and bound.' : ''}</p>
    </details>`;
}

export function wireAmbientSettings(root) {
    const panel = root?.querySelector('#mwt-ambient-settings');
    if (!panel || panel._mwtWired) return;
    panel._mwtWired = true;
    const meta = getChatMeta();
    const epoch = getEpoch();
    const el = id => panel.querySelector(`#mwt-a-${id}`);
    const updateVariability = () => {
        const text = variabilityText(Number(el('variability').value));
        el('variability-value').textContent = text;
        el('variability').setAttribute('aria-valuetext', text);
    };
    el('variability').addEventListener('input', updateVariability);
    const run = action => {
        try {
            if (getChatMeta() !== meta || getEpoch() !== epoch) throw new Error('Chat changed. Reopen Settings.');
            action();
        } catch (error) { el('status').textContent = error.message; }
    };
    const invalidate = message => {
        clearAmbientInjection({ kind: 'ambient-conditions', clearReason: 'settings-changed' });
        el('status').textContent = message;
    };
    el('enabled').addEventListener('change', () => run(() => {
        const s = getSettings();
        if (el('enabled').checked && !isConfigured(s)) {
            if (!s.setupAsked) saveSettings({ setupAsked: true });
            el('setup').hidden = false;
            return;
        }
        saveSettings({ enabled: el('enabled').checked });
        invalidate('Ambient enable setting saved for this chat.');
    }));
    el('dismiss').addEventListener('click', () => run(() => {
        saveSettings({ enabled: true, setupAsked: true, climate: 'temperate', hemisphere: 'north', manualSeason: 'spring', variability: 0.5 });
        el('enabled').checked = true;
        el('climate').value = 'temperate'; el('hemisphere').value = 'north';
        el('season').value = 'spring'; el('variability').value = '0.5';
        updateVariability();
        el('setup').hidden = true;
        invalidate('Temperate / Northern hemisphere saved. Setup will not ask again.');
    }));
    el('save').addEventListener('click', () => run(() => {
        const moonDate = el('moon-date').value.trim();
        const fullMoon = moonDate ? parseAmbientDateTime(moonDate, el('moon-time').value) : null;
        if (moonDate && !fullMoon) throw new Error('Enter a valid full moon story date and time.');
        saveSettings({ enabled: el('enabled').checked, climate: el('climate').value,
            hemisphere: el('hemisphere').value, manualSeason: el('season').value,
            latitude: el('latitude').value.trim() === '' ? null : Number(el('latitude').value),
            clockAhead: Number(el('clock-ahead').value),
            moonEpochOffset: fullMoon ? moonAnchorOffset(fullMoon.hours) : null,
            variability: Number(el('variability').value), setupAsked: true });
        el('setup').hidden = true;
        invalidate('Ambient settings saved for this chat.');
    }));
    el('pin').addEventListener('click', () => run(() => {
        const s = getSettings();
        if (!s.enabled || !isConfigured(s)) throw new Error('Enable and configure Ambient Conditions before pinning.');
        const { time, ambient } = readAmbientConditions(s, ensureSeed());
        let endHours = null;
        if (el('expiry').value === 'band') endHours = ambient.band.nextHours;
        if (el('expiry').value === 'dawn') {
            endHours = Math.floor(time.hours / 24) * 24 + 5;
            if (endHours <= time.hours) endHours += 24;
        }
        if (el('expiry').value === 'date') {
            if (time.source === 'message-count') throw new Error('A dated expiry needs a usable story calendar. Choose next band or dawn instead.');
            endHours = parseAmbientDateTime(el('date').value, el('time').value)?.hours;
            if (!Number.isFinite(endHours)) throw new Error('Enter a valid story date and time.');
        }
        if (endHours !== null && endHours <= time.hours) throw new Error('Expiry must be after the current story time.');
        saveSettings({ pin: { startHours: time.hours, endHours, source: time.source,
            conditions: Object.fromEntries(Object.keys(AMBIENT_VOCABULARY).map(key => [key, el(`pin-${key}`).value])) } });
        invalidate('Conditions pinned. Refresh Overview to see the pin and expiry.');
    }));
    el('unpin').addEventListener('click', () => run(() => {
        saveSettings({ pin: null }); invalidate('Pin removed.');
    }));
}