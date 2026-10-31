import { calendarHoursToDate, formatCalendarDate } from '../core/calendar_math.js';
import { resolveCalendarClock } from '../core/calendar_state.js';
import { getChatMeta } from '../core/context.js';

/** Authored schedules are drafts; the parent supplies validation and chat guards. */
export function wireCalendarPhenomena(panel, { read, load, run }) {
    const el = id => panel.querySelector(`#mwt-c-phen-${id}`);
    let editing = null;
    const reset = () => {
        editing = null; el('id').disabled = false;
        for (const id of ['id', 'name', 'clause']) el(id).value = '';
        el('year').value = resolveCalendarClock().year ?? '';
        el('month').value = 1; el('day').value = 1;
        el('duration').value = 1; el('unit').value = 'durationMonths'; el('repeat').value = 'none';
        el('light').value = ''; el('priority').value = 0; el('gates').value = '{}';
    };
    const refresh = calendar => {
        el('list').replaceChildren();
        for (const rule of calendar.phenomena) {
            const row = document.createElement('div');
            const text = document.createElement('span');
            text.textContent = `${rule.name} (${rule.id}): ${formatCalendarDate(calendar, rule.start, { weekday: false })}; ${rule.durationDays ?? rule.durationMonths} ${rule.durationDays ? 'day(s)' : 'month(s)'}; ${rule.repeat}; ${rule.end ? `ended ${formatCalendarDate(calendar, rule.end, { weekday: false })} ${rule.end.hour}:${String(rule.end.minute).padStart(2, '0')}` : 'no end'} `;
            row.append(text);
            for (const label of ['Edit', 'End now', 'Delete']) {
                const button = document.createElement('button'); button.type = 'button'; button.className = 'mwt-btn'; button.textContent = label;
                button.addEventListener('click', () => run(() => {
                    const draft = read();
                    const current = draft.phenomena.find(item => item.id === rule.id);
                    if (label === 'Delete') {
                        if (!el('delete-confirm').checked) throw new Error('Confirm deletion rewrites phenomenon history. Use End now to preserve the past.');
                        draft.phenomena = draft.phenomena.filter(item => item.id !== rule.id); load(draft); reset(); return;
                    }
                    if (label === 'End now') {
                        const time = resolveCalendarClock(draft);
                        if (time.month == null || time.rejection) throw new Error('End now needs a readable dated story clock.');
                        const now = calendarHoursToDate(draft, time.hours, { hemisphere: getChatMeta('mwt_ambient')?.hemisphere ?? 'north' });
                        if (current.end) throw new Error('This rule already has an End now bound. Edit its JSON to deliberately rewrite that history.');
                        current.end = now; load(draft); reset(); return;
                    }
                    editing = current.id; el('id').value = current.id; el('id').disabled = true;
                    for (const id of ['name', 'clause', 'repeat']) el(id).value = current[id];
                    for (const id of ['year', 'month', 'day']) el(id).value = current.start[id];
                    el('unit').value = current.durationDays ? 'durationDays' : 'durationMonths';
                    el('duration').value = current.durationDays ?? current.durationMonths;
                    el('priority').value = current.priority ?? 0; el('light').value = current.light ?? '';
                    el('gates').value = JSON.stringify(current.visibilityGates ?? {});
                })); row.append(button);
            }
            el('list').append(row);
        }
    };
    el('new').addEventListener('click', () => run(reset));
    el('apply').addEventListener('click', () => run(() => {
        const draft = read();
        const rule = { id: el('id').value.trim(), shape: 'dated', name: el('name').value.trim(), clause: el('clause').value.trim(),
            start: Object.fromEntries(['year', 'month', 'day'].map(key => [key, Number(el(key).value)])),
            [el('unit').value]: Number(el('duration').value), repeat: el('repeat').value,
            end: editing ? draft.phenomena.find(item => item.id === editing).end : null,
            priority: Number(el('priority').value), visibilityGates: JSON.parse(el('gates').value) };
        if (el('light').value) rule.light = el('light').value;
        if (!editing && draft.phenomena.some(item => item.id === rule.id)) throw new Error('Phenomenon ID already exists. Use Edit.');
        draft.phenomena = editing ? draft.phenomena.map(item => item.id === editing ? rule : item) : [...draft.phenomena, rule];
        load(draft); reset();
    }));
    reset();
    return refresh;
}