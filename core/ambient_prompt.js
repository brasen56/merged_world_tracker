/** Shared qualitative copy; planner reads live conditions without owning state. */
import { getAmbientStatus } from './ambient_state.js';

export function describeConditions(conditions) {
    const precipitation = conditions.precipitation === 'none' ? 'no precipitation' : conditions.precipitation;
    return `${conditions.sky}, ${conditions.temperature}, ${conditions.air} air; ${precipitation}. Wind ${conditions.wind}.`;
}

export function buildAmbientPlannerContext() {
    const status = getAmbientStatus();
    if (status.state !== 'enabled') return '';
    const { ambient } = status;
    return '[Ambient Conditions owns weather and sky conditions for this chat. These conditions are authoritative, even if older story, World State or plan text describes different weather or daylight. Build consequences and playable incidents from them; do not invent conflicting weather or daylight or pin future weather to an arc. '
        + 'The forecast covers only the next named band, not the duration of an arc. Beyond that band or after a time skip, leave weather unspecified; Ambient Conditions will supply it when that story time is reached.]\n'
        + `Current ${ambient.band.name} band: ${describeConditions(ambient.conditions)}\n`
        + (ambient.daylight ? `Daylight at the exact story time: ${ambient.daylight.description}\n` : '')
        + `Forecast for the next ${ambient.forecast.band.name} band only: ${describeConditions(ambient.forecast.conditions)}`;
}