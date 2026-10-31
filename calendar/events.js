import { calendarDayIndex, calendarDateFromDayIndex, calendarDateToHours, calendarMonthLength, calendarWeekday, datedRuleActive, formatCalendarDate } from '../core/calendar_math.js';
import { calendarEventOccurrences } from '../core/calendar_events.js';
import { escapeHtml } from '../core/diff.js';
import { getChatMeta } from '../core/context.js';
import { resolveCalendarClock } from '../core/calendar_state.js';

/** All names are escaped; this range projection is intentionally not lookahead-capped. */
export function renderCalendarMonth(calendar, date, options = {}) {
    const start = calendarDayIndex(calendar, { ...date, day: 1 });
    const length = calendarMonthLength(calendar, date.year, date.month);
    const events = calendarEventOccurrences(calendar, start, start + length - 1, options);
    const weekdays = calendar.structure === 'gregorian'
        ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] : calendar.weekdays;
    const columns = weekdays?.length ?? 7;
    const offset = weekdays ? weekdays.indexOf(calendarWeekday(calendar, start)) : 0;
    const cells = Array.from({ length: offset }, () => '<td></td>');
    for (let day = 1; day <= length; day++) {
        const index = start + day - 1;
        const names = events.filter(event => event.start <= index && event.end > index).map(({ event }) => escapeHtml(event.name));
        const cellDate = calendarDateFromDayIndex(calendar, index);
        for (const rule of calendar.phenomena ?? []) {
            if (datedRuleActive(calendar, rule, { ...cellDate, hours: calendarDateToHours(calendar, cellDate, options) }, options)) names.push(escapeHtml(rule.name));
        }
        cells.push(`<td><strong>${day}</strong>${names.map(name => `<div>${name}</div>`).join('')}</td>`);
    }
    while (cells.length % columns) cells.push('<td></td>');
    const rows = [];
    for (let index = 0; index < cells.length; index += columns) rows.push(`<tr>${cells.slice(index, index + columns).join('')}</tr>`);
    return `<table><caption>${escapeHtml(formatCalendarDate(calendar, { ...date, day: 1 }, { weekday: false }))}</caption>`
        + (weekdays ? `<thead><tr>${weekdays.map(name => `<th scope="col">${escapeHtml(name)}</th>`).join('')}</tr></thead>` : '')
        + `<tbody>${rows.join('')}</tbody></table>`;
}

/** Draft edits reuse the parent form's validation, month remapping and scope guard. */
export function wireCalendarEvents(panel, { read, load, run }) {
    const el = id => panel.querySelector(`#mwt-c-${id}`);
    let editing = null;
    let viewed = null;
    const lunar = () => ['new', 'full'].includes(el('event-repeat').value);
    const fields = () => {
        for (const id of ['year', 'month', 'day']) el(`event-${id}`).disabled = lunar();
        el('event-every').disabled = el('event-repeat').value !== 'every';
    };
    const reset = () => {
        editing = null; el('event-id').disabled = false;
        el('event-id').value = ''; el('event-name').value = ''; el('event-repeat').value = 'none';
        el('event-year').value = resolveCalendarClock().year ?? '';
        el('event-month').value = 1; el('event-day').value = 1; el('event-duration').value = 1; fields();
    };
    const refresh = calendar => {
        el('events').replaceChildren();
        for (const event of calendar.events) {
            const row = document.createElement('div');
            const text = document.createElement('span');
            text.textContent = `${event.name} (${event.id}): ${event.date ? formatCalendarDate(calendar, event.date, { weekday: false }) : `${event.repeat.lunar} moon`}; ${event.durationDays ?? 1} day(s); repeat ${JSON.stringify(event.repeat)} `;
            row.append(text);
            for (const label of ['Edit', 'Delete']) {
                const button = document.createElement('button'); button.type = 'button'; button.className = 'mwt-btn'; button.textContent = label;
                button.addEventListener('click', () => run(() => {
                    const draft = read();
                    const current = draft.events.find(item => item.id === event.id);
                    if (label === 'Delete') { draft.events = draft.events.filter(item => item.id !== event.id); load(draft); reset(); return; }
                    editing = current.id; el('event-id').value = current.id; el('event-id').disabled = true;
                    el('event-name').value = current.name; el('event-duration').value = current.durationDays ?? 1;
                    el('event-repeat').value = current.repeat?.lunar ?? (current.repeat?.everyYears ? 'every' : current.repeat);
                    el('event-every').value = current.repeat?.everyYears ?? 2;
                    for (const key of ['year', 'month', 'day']) el(`event-${key}`).value = current.date?.[key] ?? '';
                    fields();
                })); row.append(button);
            }
            el('events').append(row);
        }
        const time = resolveCalendarClock(calendar);
        viewed ??= time.customDate ?? (time.month != null ? time : calendar.anchor ?? { year: 1, month: 1, day: 1 });
        if (calendarMonthLength(calendar, viewed.year, viewed.month) == null) viewed = { year: viewed.year, month: 1, day: 1 };
        const ambient = getChatMeta('mwt_ambient');
        el('grid').innerHTML = renderCalendarMonth(calendar, viewed, { hemisphere: ambient?.hemisphere ?? 'north', moonEpochOffset: ambient?.moonEpochOffset });
    };
    el('event-repeat').addEventListener('change', fields);
    el('event-new').addEventListener('click', () => run(reset));
    el('event-apply').addEventListener('click', () => run(() => {
        const draft = read();
        const repeat = el('event-repeat').value;
        const event = { id: el('event-id').value.trim(), name: el('event-name').value,
            durationDays: Number(el('event-duration').value), repeat: lunar() ? { lunar: repeat } : repeat === 'every' ? { everyYears: Number(el('event-every').value) } : repeat };
        if (!lunar()) event.date = Object.fromEntries(['year', 'month', 'day'].map(key => [key, Number(el(`event-${key}`).value)]));
        if (!editing && draft.events.some(item => item.id === event.id)) throw new Error('Event ID already exists. Use Edit to change it.');
        draft.events = editing ? draft.events.map(item => item.id === editing ? event : item) : [...draft.events, event];
        load(draft); reset();
    }));
    for (const [id, direction] of [['grid-prev', -1], ['grid-next', 1]]) el(id).addEventListener('click', () => run(() => {
        const calendar = read();
        const start = calendarDayIndex(calendar, { ...viewed, day: 1 });
        viewed = calendarDateFromDayIndex(calendar, direction < 0 ? start - 1 : start + calendarMonthLength(calendar, viewed.year, viewed.month));
        refresh(calendar);
    }));
    reset();
    return refresh;
}