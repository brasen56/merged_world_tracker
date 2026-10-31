/** Optional audit using the revision-4 external js-tiktoken harness; no runtime dependency.
 * node <absolute path to this file> <absolute path to js-tiktoken/dist/index.js>
 */
import { pathToFileURL } from 'node:url';
import { buildCalendarBody } from '../core/calendar_state.js';
import { calendarDateFromDayIndex } from '../core/calendar_math.js';

if (!process.argv[2]) throw new Error('Supply the absolute path to the external js-tiktoken module.');
const { getEncoding } = await import(pathToFileURL(process.argv[2]).href);
const encoder = getEncoding('cl100k_base');
const calendar = { version: 1, structure: 'custom',
    months: ['Snowmoon', 'Icewind', 'Thawmoon', 'Seedmoon', 'Bloom', 'Highsun', 'Rotmonth', 'Harvest', 'Frostmoon', 'Deepnight'].map(name => ({ name, days: 36 })),
    weekdays: ['Starday', 'Oneday', 'Twoday', 'Threeday', 'Fiveday', 'Sixday'], era: 'Kelen Epoch',
    anchor: { year: 1247, month: 6, day: 18, weekday: 3 }, dateLine: true };
const groups = { everyday: [], nearMonthEnd: [], fullYear: [] };
for (let index = 0; index < 360; index++) {
    const date = calendarDateFromDayIndex(calendar, index);
    const body = buildCalendarBody(calendar, date);
    const tokens = encoder.encode(`<mwt_calendar>\n${body}\n</mwt_calendar>`).length;
    groups.fullYear.push(tokens);
    groups[36 - date.day <= 7 ? 'nearMonthEnd' : 'everyday'].push(tokens);
}
for (const [name, counts] of Object.entries(groups)) {
    counts.sort((a, b) => a - b);
    console.log(JSON.stringify({ name, samples: counts.length, min: counts[0], median: counts[Math.floor(counts.length / 2)],
        max: counts.at(-1), mean: Number((counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(2)) }));
}