/** Pure pin validation and interval application. Expiry is exclusive. */
import { AMBIENT_VOCABULARY } from './ambient_generator.js';

export function isAmbientPin(pin) {
    return !!pin && Number.isFinite(pin.startHours)
        && ['timestamp', 'world-state', 'message-count'].includes(pin.source)
        && (pin.endHours === null || (Number.isFinite(pin.endHours) && pin.endHours > pin.startHours))
        && Object.entries(AMBIENT_VOCABULARY).every(([key, values]) => values.includes(pin.conditions?.[key]));
}

export function isAmbientPinActive(pin, time) {
    return isAmbientPin(pin) && (pin.source === 'message-count') === (time.source === 'message-count')
        && time.hours >= pin.startHours && (pin.endHours === null || time.hours < pin.endHours);
}

export function applyAmbientPin(ambient, pin, time) {
    const pinned = isAmbientPinActive(pin, time);
    const forecastPinned = isAmbientPinActive(pin, { ...time, hours: ambient.forecast.band.startHours });
    return { ...ambient, pinned,
        conditions: pinned ? { ...pin.conditions } : ambient.conditions,
        forecast: { ...ambient.forecast, pinned: forecastPinned,
            conditions: forecastPinned ? { ...pin.conditions } : ambient.forecast.conditions } };
}