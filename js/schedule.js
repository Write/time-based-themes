'use strict';

// ---------------------------------------------------------------------------
// Pure scheduling logic — no browser APIs, no storage. Loaded by the
// background page and by the options page, and unit-tested from Node
// (test/schedule.test.js).
// ---------------------------------------------------------------------------

// Constants identifying which "slot" of the day is active.
const SLOT_DAY = "day";
const SLOT_NIGHT = "night";
const SLOT_EXTRA_PREFIX = "extra:";

// Build the list of switch points for one day. Every entry is
// { min: <minutes since local midnight>, slot, themeId, scheme }.
//
// The two base entries come from sunrise/sunset (both already carrying the
// user's offsets); additional entries come from the user's extra
// times/themes list (issue #7).
function buildEvents(config) {
    let events = [];

    if (config.sunriseMin !== null && config.sunriseMin !== undefined) {
        events.push({
            min: normalizeMinutes(config.sunriseMin),
            slot: SLOT_DAY,
            themeId: config.dayThemeId,
            scheme: config.dayScheme
        });
    }
    if (config.sunsetMin !== null && config.sunsetMin !== undefined) {
        events.push({
            min: normalizeMinutes(config.sunsetMin),
            slot: SLOT_NIGHT,
            themeId: config.nightThemeId,
            scheme: config.nightScheme
        });
    }

    (config.extras || []).forEach((extra) => {
        let min = parseTimeToMinutes(extra.time);
        if (min === null) {
            return;
        }
        events.push({
            min: min,
            slot: SLOT_EXTRA_PREFIX + extra.id,
            themeId: extra.themeId,
            scheme: extra.scheme
        });
    });

    return events;
}

// Pick the event that most recently started: the last one at or before
// `nowMin`, wrapping around to the last event of the day before the first
// switch (i.e. the previous day's final state).
function pickEvent(events, nowMin) {
    if (!events || events.length === 0) {
        return null;
    }

    let sorted = events.slice().sort((a, b) => a.min - b.min);
    let chosen = sorted[sorted.length - 1];

    for (let i = 0; i < sorted.length; i++) {
        if (sorted[i].min <= nowMin) {
            chosen = sorted[i];
        }
    }

    return chosen;
}

// Which theme should be enabled right now?
//
// config: {
//   mode: "manual-suntimes" | "location-suntimes" | "system-theme",
//   systemDark: bool,
//   tzOffsetMinutes: number,
//   safeMode: bool,             // no sunrise/sunset available (polar day/night)
//   sunriseMin, sunsetMin,      // minutes of day, offsets applied
//   dayThemeId, nightThemeId, dayScheme, nightScheme,
//   extras: [{id, time, themeId, scheme}]
// }
//
// Returns { slot, themeId, scheme, min } — `min` is null in system mode.
function computeSlot(config, nowMs) {
    if (config.mode === "system-theme") {
        return {
            slot: config.systemDark ? SLOT_NIGHT : SLOT_DAY,
            themeId: config.systemDark ? config.nightThemeId : config.dayThemeId,
            scheme: config.systemDark ? config.nightScheme : config.dayScheme,
            min: null
        };
    }

    let nowMin = minutesOfDay(nowMs, config.tzOffsetMinutes);

    // Polar day / polar night: SunCalc reports no sunrise and no sunset for
    // the whole day. Fall back to the plain day/night slots so the user's
    // themes are still applied deterministically.
    if (config.safeMode) {
        let isDay = config.polarDay === true;
        return {
            slot: isDay ? SLOT_DAY : SLOT_NIGHT,
            themeId: isDay ? config.dayThemeId : config.nightThemeId,
            scheme: isDay ? config.dayScheme : config.nightScheme,
            min: nowMin
        };
    }

    let events = buildEvents(config);
    let chosen = pickEvent(events, nowMin);

    if (!chosen) {
        // Nothing configured (e.g. only extras with invalid times).
        return {
            slot: SLOT_NIGHT,
            themeId: config.nightThemeId,
            scheme: config.nightScheme,
            min: nowMin
        };
    }

    return {
        slot: chosen.slot,
        themeId: chosen.themeId,
        scheme: chosen.scheme,
        min: chosen.min
    };
}

// The next boundary strictly after nowMin, used to know when the schedule
// changes without waiting for the minutely tick (display purposes).
function nextEvent(events, nowMin) {
    if (!events || events.length === 0) {
        return null;
    }
    let sorted = events.slice().sort((a, b) => a.min - b.min);
    for (let i = 0; i < sorted.length; i++) {
        if (sorted[i].min > nowMin) {
            return sorted[i];
        }
    }
    return sorted[0];
}

// Resolve the effective sunrise/sunset minutes from a config.
function effectiveSunTimes(config) {
    let sunrise = config.sunriseMin === null || config.sunriseMin === undefined
        ? null
        : normalizeMinutes(config.sunriseMin + (config.sunriseOffset || 0));
    let sunset = config.sunsetMin === null || config.sunsetMin === undefined
        ? null
        : normalizeMinutes(config.sunsetMin + (config.sunsetOffset || 0));
    return { sunrise: sunrise, sunset: sunset };
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        SLOT_DAY: SLOT_DAY,
        SLOT_NIGHT: SLOT_NIGHT,
        SLOT_EXTRA_PREFIX: SLOT_EXTRA_PREFIX,
        buildEvents: buildEvents,
        pickEvent: pickEvent,
        computeSlot: computeSlot,
        nextEvent: nextEvent,
        effectiveSunTimes: effectiveSunTimes,
        normalizeMinutes: normalizeMinutes,
        minutesOfDay: minutesOfDay,
        parseTimeToMinutes: parseTimeToMinutes
    };
}
