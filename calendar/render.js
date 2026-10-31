import { escapeHtml } from '../core/diff.js';
import { getCalendarStatus, resolveCalendarClock } from '../core/calendar_state.js';
import { validateCalendarRecord } from '../core/calendar_math.js';
import { generateAmbientConditions } from '../core/ambient_generator.js';
import { getChatMeta } from '../core/context.js';

export function calendarPreview(calendar) {
    const result = validateCalendarRecord(calendar);
    if (!result.valid) return result.errors.join(' ');
    const time = resolveCalendarClock(result.record);
    if (time.month == null) return 'Today preview unavailable: no readable dated story clock.';
    const hemisphere = getChatMeta('mwt_ambient')?.hemisphere ?? 'north';
    const ambient = generateAmbientConditions({ seed: 0, climate: 'temperate', hemisphere, variability: 0.5, time });
    return `Today: ${time.formattedDate ?? `${time.year}-${time.month}-${time.day}`}; derived season: ${ambient.season}; midsummer reference: ${hemisphere === 'south' ? 'December' : 'June'} solstice (${hemisphere}).`;
}

export function renderCalendarPanel() {
    const status = getCalendarStatus();
    return `<section id="mwt-calendar-panel">
        <h3>Calendar (this chat)</h3>
        <p>Calendar changes rewrite past and future dates consistently. Saves are independent of global Settings.</p>
        <p role="status" id="mwt-c-status">${escapeHtml(status.reason ?? status.state)}</p>
        <p id="mwt-c-preview"></p>
        <label>Structure <select class="mwt-input" id="mwt-c-structure"><option value="custom">Custom</option><option value="gregorian">Gregorian (events and phenomena)</option></select></label>
        <div id="mwt-c-custom">
            <h4>Months</h4><p>Reorder rows to move dates with their month. Removing a referenced month is refused.</p>
            <div id="mwt-c-months"></div><button type="button" class="mwt-btn" id="mwt-c-add">Add month</button>
            <label>Weekdays, one per line (blank for none)<textarea class="mwt-input" id="mwt-c-weekdays"></textarea></label>
            <label>Era (optional)<input class="mwt-input" id="mwt-c-era"></label>
            <h4>Midsummer anchor</h4>
            <label>Year (defaults to the current story year)<input class="mwt-input" type="number" id="mwt-c-year" min="1" max="9999"></label>
            <label>Month <select class="mwt-input" id="mwt-c-month"></select></label>
            <label>Day <input class="mwt-input" type="number" id="mwt-c-day" min="1" max="40"></label>
            <label>Weekday <select class="mwt-input" id="mwt-c-weekday"></select></label>
            <label><input type="checkbox" id="mwt-c-date-line"> Inject authoritative date line</label>
        </div>
        <label><input type="checkbox" id="mwt-c-events-line"> Inject bounded events line</label>
        <h4>Events</h4>
        <p>Events are authored facts, not weather effects. Edits and deletion rewrite their past and future. Changes are drafts until Save Calendar.</p>
        <div id="mwt-c-events"></div>
        <fieldset><legend>Create / edit event</legend>
            <label>ID <input class="mwt-input" id="mwt-c-event-id" maxlength="64"></label>
            <label>Name <input class="mwt-input" id="mwt-c-event-name" maxlength="24"></label>
            <label>Repeat <select class="mwt-input" id="mwt-c-event-repeat"><option value="none">Once</option><option value="yearly">Yearly</option><option value="every">Every N years</option><option value="new">New moon</option><option value="full">Full moon</option></select></label>
            <label>Every N years <input type="number" id="mwt-c-event-every" min="2" max="99" value="2"></label>
            <label>Year (first occurrence) <input type="number" id="mwt-c-event-year" min="1" max="9999"></label>
            <label>Month <input type="number" id="mwt-c-event-month" min="1" max="24" value="1"></label>
            <label>Day <input type="number" id="mwt-c-event-day" min="1" max="40" value="1"></label>
            <label>Duration in days <input type="number" id="mwt-c-event-duration" min="1" max="14" value="1"></label>
            <button type="button" class="mwt-btn" id="mwt-c-event-apply">Apply event to draft</button>
            <button type="button" class="mwt-btn" id="mwt-c-event-new">New event</button>
        </fieldset>
        <p>Lunar events use the calendar day containing the exact anchored phase instant (approximate astronomy, ±1 day near midnight). No date is stored for lunar events; re-anchoring the Ambient moon moves them.</p>
        <h4>Dated phenomena</h4>
        <p>Schedules affect Ambient when enabled. Schedule edits rewrite history; End now preserves the played past. All changes are drafts until Save Calendar. Date-based schedules and ends follow re-anchors automatically and need no re-stamping.</p>
        <div id="mwt-c-phen-list"></div>
        <label><input type="checkbox" id="mwt-c-phen-delete-confirm"> I understand Delete erases phenomenon history</label>
        <fieldset><legend>Create / edit dated phenomenon</legend>
            <label>ID <input class="mwt-input" id="mwt-c-phen-id" maxlength="64"></label>
            <label>Name <input class="mwt-input" id="mwt-c-phen-name" maxlength="60"></label>
            <label>Clause <input class="mwt-input" id="mwt-c-phen-clause" maxlength="80"></label>
            <label>Start year <input type="number" id="mwt-c-phen-year" min="1" max="9999"></label>
            <label>Start month <input type="number" id="mwt-c-phen-month" min="1" max="24"></label>
            <label>Start day <input type="number" id="mwt-c-phen-day" min="1" max="40"></label>
            <label>Duration <input type="number" id="mwt-c-phen-duration" min="1" max="400"></label>
            <label>Unit <select id="mwt-c-phen-unit"><option value="durationDays">Days (1–400)</option><option value="durationMonths">Calendar months (1–13; destination day clamps)</option></select></label>
            <label>Repeat <select id="mwt-c-phen-repeat"><option value="none">Once</option><option value="yearly">Yearly</option></select></label>
            <label>Light (only darkens) <select id="mwt-c-phen-light"><option value="">No override</option><option>daylight</option><option>twilight</option><option>darkness</option></select></label>
            <label>Priority <input type="number" id="mwt-c-phen-priority" min="-100" max="100"></label>
            <label>Visibility gates (JSON; regime, sky, wind, season)<textarea class="mwt-input" id="mwt-c-phen-gates" aria-label="Phenomenon visibility gates"></textarea></label>
            <p>For a daytime eclipse use {"regime":["daylight","twilight"]}; gates affect clauses, not the light override.</p>
            <button type="button" class="mwt-btn" id="mwt-c-phen-apply">Apply phenomenon to draft</button>
            <button type="button" class="mwt-btn" id="mwt-c-phen-new">New phenomenon</button>
        </fieldset>
        <h4>Month grid</h4>
        <button type="button" class="mwt-btn" id="mwt-c-grid-prev">Previous month</button>
        <button type="button" class="mwt-btn" id="mwt-c-grid-next">Next month</button>
        <div id="mwt-c-grid"></div>
        <p><strong>Clock-domain change:</strong> adoption accepts only custom timestamps. Old Gregorian tags are ignored until a custom date is available. Re-anchoring, month edits, removal and hemisphere changes also reposition the clock. Stored pins and frequency rules do not move automatically; synthetic rules become inactive on a dated clock. Declining re-stamping leaves their hours frozen.</p>
        <label><input type="checkbox" id="mwt-c-restamp"> Re-stamp Ambient pin and frequency-rule bounds by date (synthetic starts reset to now; requires a readable new date)</label>
        <label><input type="checkbox" id="mwt-c-clamp"> Explicitly allow referenced days to clamp to a shortened month's last day</label>
        <label><input type="checkbox" id="mwt-c-confirm"> I understand the clock-domain and history changes</label>
        <button type="button" class="mwt-btn" id="mwt-c-save">Save Calendar</button>
        <button type="button" class="mwt-btn" id="mwt-c-delete">Remove Calendar</button>
        <h4>Export / import JSON</h4>
        <textarea class="mwt-input" id="mwt-c-json" rows="8" aria-label="Calendar JSON"></textarea>
        <button type="button" class="mwt-btn" id="mwt-c-export">Export to text box</button>
        <button type="button" class="mwt-btn" id="mwt-c-import">Import and save JSON</button>
        <h4>Copy-paste preset snippet</h4><textarea class="mwt-input" id="mwt-c-snippet" rows="6" readonly aria-label="Calendar preset snippet"></textarea>
    </section>`;
}