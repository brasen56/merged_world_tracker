import { getCalendar, saveCalendar, exportCalendar, importCalendar, buildPresetSnippet } from './settings.js';
import { calendarPreview } from './render.js';
import { resolveCalendarClock } from '../core/calendar_state.js';
import { editCalendarMonths, requireCalendarRecord } from '../core/calendar_edit.js';
import { validateCalendarRecord } from '../core/calendar_math.js';
import { captureScope, assertSameScope } from '../core/scope.js';
import { wireCalendarEvents } from './events.js';
import { wireCalendarPhenomena } from './phenomena.js';

/** DOM-created controls keep every authored string out of HTML interpolation. */
export function wireCalendarPanel(root) {
    const panel = root?.querySelector('#mwt-calendar-panel');
    if (!panel || panel._mwtWired) return;
    panel._mwtWired = true;
    const scope = captureScope();
    const metaClock = resolveCalendarClock();
    let base = validateCalendarRecord(getCalendar()).record ?? { version: 1, structure: 'custom', months: [{ name: 'Highsun', days: 30 }],
        weekdays: null, era: null, anchor: { year: metaClock.year ?? null, month: 1, day: 15 },
        dateLine: true, eventsLine: true, events: [], phenomena: [] };
    let rows = [];
    // Event draft application rebases rows; retain the map from persisted months
    // separately so a later re-stamp still starts in the saved clock domain.
    let persistedMonths = new Map((base.months ?? []).map((_, index) => [index + 1, index + 1]));
    const monthMapping = () => new Map([...persistedMonths].flatMap(([saved, current]) => {
        const index = rows.findIndex(row => row.original === current - 1);
        return index < 0 ? [] : [[saved, index + 1]];
    }));
    const el = id => panel.querySelector(`#mwt-c-${id}`);
    const guard = () => {
        if (!assertSameScope(scope).ok) throw new Error('Chat changed. Reopen the Calendar tab.');
    };
    const options = () => ({ restamp: el('restamp').checked });
    const confirmed = () => { guard(); if (!el('confirm').checked) throw new Error('Confirm the clock-domain and history changes before saving.'); };
    const run = fn => { try { guard(); fn(); } catch (error) { el('status').textContent = error.message; } };
    const weekdays = () => el('weekdays').value.trim() ? el('weekdays').value.split('\n').map(name => name.trim()).filter(Boolean) : null;
    const selectOptions = (select, names, value) => {
        select.replaceChildren(...names.map((name, index) => {
            const option = document.createElement('option'); option.value = index; option.textContent = name; return option;
        }));
        select.value = String(value);
    };
    const read = () => {
        if (el('structure').value === 'gregorian') {
            if (base.structure === 'custom' && (base.events.length || base.phenomena.length)) throw new Error('Export and clear date-referenced events and phenomena before switching structure.');
            return { version: 1, structure: 'gregorian', eventsLine: el('events-line').checked, events: base.events, phenomena: base.phenomena };
        }
        if (base.structure === 'gregorian' && (base.events.length || base.phenomena.length)) throw new Error('Export and clear date-referenced events and phenomena before switching structure.');
        const next = base.structure === 'custom'
            // The form authors a replacement anchor in the edited month order.
            // Only retained references should be transformed from the old order.
            ? editCalendarMonths({ ...base, anchor: null }, rows, { clamp: el('clamp').checked })
            : { record: { version: 1, structure: 'custom', months: rows.map(({ name, days }) => ({ name, days })),
                events: base.events, phenomena: base.phenomena }, clamped: [] };
        if (next.needsClamping) throw new Error(`Clamping required: ${next.clamped.join('; ')}. Enable explicit day clamping to proceed.`);
        const days = weekdays();
        next.record = { ...next.record, weekdays: days, era: el('era').value.trim() || null,
            anchor: { year: el('year').value === '' ? null : Number(el('year').value), month: Number(el('month').value) + 1,
                day: Number(el('day').value), ...(days ? { weekday: Number(el('weekday').value) } : {}) },
            dateLine: el('date-line').checked, eventsLine: el('events-line').checked };
        if (next.record.anchor.day > rows[next.record.anchor.month - 1]?.days) {
            if (!el('clamp').checked) throw new Error(`Clamping required: anchor: day ${next.record.anchor.day} → ${rows[next.record.anchor.month - 1].days}. Enable explicit day clamping to proceed.`);
            next.record.anchor.day = rows[next.record.anchor.month - 1].days;
        }
        return next.record;
    };
    const preview = () => {
        try { const next = requireCalendarRecord(read()); el('preview').textContent = calendarPreview(next); el('snippet').value = buildPresetSnippet(next); refreshEvents?.(next); refreshPhenomena?.(next); }
        catch (error) { el('preview').textContent = error.message; el('snippet').value = ''; el('grid').textContent = 'Month grid unavailable until the calendar is valid.'; }
    };
    const drawRows = () => {
        const selected = Number(el('month').value || 0);
        el('months').replaceChildren();
        rows.forEach((row, index) => {
            const wrapper = document.createElement('div');
            const name = document.createElement('input'); name.className = 'mwt-input'; name.value = row.name; name.setAttribute('aria-label', `Month ${index + 1} name`);
            name.addEventListener('input', () => { row.name = name.value; refreshMonths(); preview(); });
            const length = document.createElement('input'); length.type = 'number'; length.min = 1; length.max = 40; length.value = row.days; length.setAttribute('aria-label', `Month ${index + 1} days`);
            length.addEventListener('input', () => { row.days = Number(length.value); preview(); });
            wrapper.append(name, length);
            for (const [label, action] of [['↑', -1], ['↓', 1], ['Remove', 0]]) {
                const button = document.createElement('button'); button.type = 'button'; button.className = 'mwt-btn'; button.textContent = label;
                button.disabled = action !== 0 && !rows[index + action];
                button.addEventListener('click', () => {
                    const anchorRow = rows[Number(el('month').value)];
                    if (!action) rows.splice(index, 1);
                    else [rows[index], rows[index + action]] = [rows[index + action], rows[index]];
                    drawRows(); el('month').value = String(rows.indexOf(anchorRow)); preview();
                }); wrapper.append(button);
            }
            el('months').append(wrapper);
        });
        selectOptions(el('month'), rows.map(row => row.name), selected);
    };
    const refreshMonths = () => selectOptions(el('month'), rows.map(row => row.name), Number(el('month').value));
    const load = (record, draft = false) => {
        record = requireCalendarRecord(record);
        persistedMonths = draft ? monthMapping() : new Map((record.months ?? []).map((_, index) => [index + 1, index + 1]));
        base = record;
        rows = (record.months ?? [{ name: 'Highsun', days: 30 }]).map((month, original) => ({ ...month, original: record.months ? original : null }));
        el('structure').value = record.structure;
        el('custom').hidden = record.structure !== 'custom';
        el('weekdays').value = record.weekdays?.join('\n') ?? '';
        el('era').value = record.era ?? '';
        el('year').value = record.anchor?.year ?? metaClock.year ?? '';
        el('day').value = record.anchor?.day ?? 15;
        drawRows(); el('month').value = String((record.anchor?.month ?? 1) - 1);
        selectOptions(el('weekday'), record.weekdays ?? [], record.anchor?.weekday ?? 0);
        el('date-line').checked = record.dateLine !== false;
        el('events-line').checked = record.eventsLine;
        preview();
    };
    panel.addEventListener('change', preview);
    el('structure').addEventListener('change', () => { el('custom').hidden = el('structure').value !== 'custom'; preview(); });
    el('weekdays').addEventListener('input', () => { selectOptions(el('weekday'), weekdays() ?? [], Number(el('weekday').value)); preview(); });
    for (const id of ['year', 'day', 'era']) el(id).addEventListener('input', preview);
    el('add').addEventListener('click', () => { rows.push({ name: '', days: 30, original: null }); drawRows(); preview(); });
    el('save').addEventListener('click', () => run(() => {
        confirmed(); const next = read();
        const monthMap = base.structure === 'custom' && next.structure === 'custom'
            ? monthMapping() : undefined;
        load(saveCalendar(next, { ...options(), monthMap }));
        el('status').textContent = 'Calendar saved for this chat.';
    }));
    el('delete').addEventListener('click', () => run(() => { confirmed(); saveCalendar(null, options()); el('status').textContent = 'Calendar removed. Reopen this tab to start a new calendar.'; }));
    el('export').addEventListener('click', () => run(() => { el('json').value = exportCalendar(); }));
    el('import').addEventListener('click', () => run(() => { confirmed(); load(importCalendar(el('json').value, options())); el('status').textContent = 'Calendar imported and saved.'; }));
    const refreshEvents = wireCalendarEvents(panel, { read: () => requireCalendarRecord(read()), load: record => load(record, true), run });
    const refreshPhenomena = wireCalendarPhenomena(panel, { read: () => requireCalendarRecord(read()), load: record => load(record, true), run });
    // A new chat may still need an anchor year; keep that draft editable.
    if (validateCalendarRecord(base).valid) load(base);
    else {
        rows = base.months.map((month, original) => ({ ...month, original }));
        el('structure').value = base.structure; el('day').value = base.anchor.day;
        el('year').value = base.anchor.year ?? ''; el('events-line').checked = true; el('date-line').checked = true;
        drawRows(); preview();
    }
}