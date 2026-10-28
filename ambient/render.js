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
        <p class="mwt-text-dim mwt-text-sm">Recent weather is recomputed, not logged. Changing the seed, climate, hemisphere, variability, manual season or stored pin rewrites its evaluated history. Rewinding restores stored pins inside their original intervals.</p>
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
            <label for="mwt-a-coastal"><input type="checkbox" id="mwt-a-coastal" ${s.coastal ? 'checked' : ''}> Coastal location (enable tides)</label>
            <p class="mwt-text-dim mwt-text-sm">Tides need a story calendar clock. Fictional semidiurnal schedule, not real-port or navigation predictions. Re-anchoring the moon shifts tides; reseeding changes both weather and the tide schedule.</p>
            ${select('mwt-a-tide-range', 'Tidal range (wording only)', { calm: 'Calm — small range', normal: 'Normal — moderate range', extreme: 'Extreme — large range' }, s.tideRange)}
            <label class="mwt-label" for="mwt-a-variability">Variability (change frequency)</label>
            <div>
                <input id="mwt-a-variability" type="range" min="0" max="1" step="0.05" value="${variability}" aria-describedby="mwt-a-variability-help" aria-valuetext="${variabilityText(variability)}">
                <div class="mwt-text-dim mwt-text-sm">Slower (0%) → Faster (100%)</div>
                <output id="mwt-a-variability-value" for="mwt-a-variability">${variabilityText(variability)}</output>
                <p class="mwt-text-dim mwt-text-sm" id="mwt-a-variability-help">Controls how often weather changes as story time advances, not its severity or which conditions your climate allows. 0% means slower changes, not frozen weather; 50% is the default. Conditions stay stable within each time band (dawn, morning, afternoon, evening, night). Changes take effect after Save Ambient Settings.</p>
            </div>
        </div>
        <button type="button" class="mwt-btn" id="mwt-a-save">Save Ambient Settings</button>
        <details><summary>Frequency-shaped phenomena</summary>
            <p>One start roll per night at 21:00 sun time. New rules start no earlier than now; duration uses noon-to-noon nights. Works without a calendar. No frequency forecasts.</p>
            <label for="mwt-a-phenomena-name">Name</label><input class="mwt-input" id="mwt-a-phenomena-name" maxlength="60" value="Meteor shower">
            <label for="mwt-a-phenomena-clause">Clause (up to 80 characters)</label><input class="mwt-input" id="mwt-a-phenomena-clause" maxlength="80" value="meteors streak across the sky">
            <label for="mwt-a-phenomena-chance">Start chance per night (0–1)</label><input class="mwt-input" id="mwt-a-phenomena-chance" type="number" min="0" max="1" step="0.05" value="0.3">
            <label for="mwt-a-phenomena-duration">Duration (1–30 nights)</label><input class="mwt-input" id="mwt-a-phenomena-duration" type="number" min="1" max="30" value="1">
            ${select('mwt-a-phenomena-kind', 'Effect template', { meteors: 'Meteors (darkness, clear or partly cloudy)', miasma: 'Miasma (starts in calm darkness)', additive: 'Unrestricted additive clause' }, 'meteors')}
            <button type="button" class="mwt-btn" id="mwt-a-phenomena-add">Add rule now</button>
            <label for="mwt-a-phenomena-json">Advanced rules (JSON)</label>
            <textarea class="mwt-input" id="mwt-a-phenomena-json" rows="12">${escapeHtml(JSON.stringify(s.phenomena, null, 2))}</textarea>
            <p class="mwt-text-dim mwt-text-sm">Maximum 16 rules; three visible clauses are shown. Editing chance, gates or duration rewrites history. IDs must remain stable. Optional startGates/visibilityGates accept arrays for regime, sky, wind and season. Optional light is daylight, twilight or darkness; highest priority (−100 to 100, default 0) wins, then ascending ID. Light applies throughout an active occurrence, independently of visibility. Weather pins still own weather fields. Calendar and message-count intervals are separate clock domains.</p>
            <button type="button" class="mwt-btn" id="mwt-a-phenomena-save">Save edited rules (rewrites history)</button>
            <label for="mwt-a-phenomena-id">Rule ID to end or delete</label><input class="mwt-input" id="mwt-a-phenomena-id">
            <button type="button" class="mwt-btn" id="mwt-a-phenomena-end">End now (preserve past)</button>
            <button type="button" class="mwt-btn" id="mwt-a-phenomena-delete">Delete rule (erases history)</button>
        </details>
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
    const saveRules = rules => {
        saveSettings({ phenomena: rules });
        el('phenomena-json').value = JSON.stringify(rules, null, 2);
        invalidate('Phenomena saved for this chat.');
    };
    el('phenomena-save').addEventListener('click', () => run(() => saveRules(JSON.parse(el('phenomena-json').value))));
    el('phenomena-add').addEventListener('click', () => run(() => {
        const s = getSettings();
        if (!s.enabled || !isConfigured(s)) throw new Error('Enable and configure Ambient Conditions first.');
        const { time } = readAmbientConditions(s, ensureSeed());
        const kind = el('phenomena-kind').value;
        const ids = new Set(s.phenomena.map(rule => rule.id));
        let index = 1;
        while (ids.has(`phenomenon-${index}`)) index++;
        const rule = { id: `phenomenon-${index}`, shape: 'frequency', name: el('phenomena-name').value.trim(),
            clause: el('phenomena-clause').value.trim(), chance: Number(el('phenomena-chance').value),
            durationNights: Number(el('phenomena-duration').value), startHours: time.hours, endHours: null, source: time.source };
        if (kind === 'meteors') rule.visibilityGates = { regime: ['darkness'], sky: ['clear', 'partly cloudy'] };
        if (kind === 'miasma') rule.startGates = { regime: ['darkness'], wind: ['calm'] };
        saveRules([...s.phenomena, rule]);
        el('phenomena-id').value = rule.id;
    }));
    for (const action of ['end', 'delete']) el(`phenomena-${action}`).addEventListener('click', () => run(() => {
        const s = getSettings();
        const id = el('phenomena-id').value.trim();
        const rule = s.phenomena.find(item => item.id === id);
        if (!rule) throw new Error('Enter an existing rule ID.');
        if (action === 'delete') { saveRules(s.phenomena.filter(item => item.id !== id)); return; }
        const { time } = readAmbientConditions(s, ensureSeed());
        if (rule.source !== undefined && (rule.source === 'message-count') !== (time.source === 'message-count')) throw new Error('Rule belongs to a different clock domain.');
        if (time.hours < rule.startHours) throw new Error('Cannot end a rule before its start.');
        saveRules(s.phenomena.map(item => item.id === id ? { ...item, endHours: Math.min(item.endHours ?? Infinity, time.hours) } : item));
    }));
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
            coastal: el('coastal').checked, tideRange: el('tide-range').value,
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