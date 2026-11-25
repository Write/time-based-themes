'use strict';

// Unit tests for the pure scheduling logic (js/schedule.js and the helpers it
// borrows from js/utils.js). Run with:
//
//     node --test test/
//
// Neither file touches the browser APIs on the paths exercised here, so the
// tests load them into the Node global scope the same way the background page
// does.

const test = require("node:test");
const assert = require("node:assert");

const utils = require("../js/utils.js");
Object.keys(utils).forEach((key) => {
    global[key] = utils[key];
});
const schedule = require("../js/schedule.js");
Object.keys(schedule).forEach((key) => {
    global[key] = schedule[key];
});

const TZ = 0; // treat every Date in these tests as UTC

function at(hours, minutes) {
    // A fixed UTC instant whose minute-of-day is `hours:minutes`.
    return Date.UTC(2024, 0, 15, hours, minutes, 0, 0);
}

function baseConfig(overrides) {
    return Object.assign({
        mode: "manual-suntimes",
        systemDark: false,
        tzOffsetMinutes: TZ,
        safeMode: false,
        polarDay: null,
        sunriseMin: 8 * 60,
        sunsetMin: 20 * 60,
        sunriseOffset: 0,
        sunsetOffset: 0,
        dayThemeId: "light-theme",
        nightThemeId: "dark-theme",
        dayScheme: "auto",
        nightScheme: "auto",
        extras: []
    }, overrides || {});
}

test("parseTimeToMinutes accepts HH:MM and rejects garbage", () => {
    assert.strictEqual(parseTimeToMinutes("08:00"), 480);
    assert.strictEqual(parseTimeToMinutes("23:59"), 1439);
    assert.strictEqual(parseTimeToMinutes("00:00"), 0);
    assert.strictEqual(parseTimeToMinutes("8:5"), 485);
    assert.strictEqual(parseTimeToMinutes("24:30"), 30, "wraps past midnight");
    assert.strictEqual(parseTimeToMinutes(""), null);
    assert.strictEqual(parseTimeToMinutes("8"), null);
    assert.strictEqual(parseTimeToMinutes("nope:00"), null);
    assert.strictEqual(parseTimeToMinutes(null), null);
    assert.strictEqual(parseTimeToMinutes(480), null);
});

test("normalizeMinutes wraps both directions", () => {
    assert.strictEqual(normalizeMinutes(-30), 1410);
    assert.strictEqual(normalizeMinutes(1470), 30);
    assert.strictEqual(normalizeMinutes(1440), 0);
    assert.strictEqual(normalizeMinutes(90.4), 90);
});

test("minutesOfDay honours the time-zone override", () => {
    const noonUtc = Date.UTC(2024, 0, 15, 12, 0, 0, 0);
    assert.strictEqual(minutesOfDay(noonUtc, 0), 720);
    assert.strictEqual(minutesOfDay(noonUtc, 60), 780, "UTC+1 is 13:00");
    assert.strictEqual(minutesOfDay(noonUtc, -300), 420, "UTC-5 is 07:00");
    assert.strictEqual(typeof browserOffsetMinutes(new Date()), "number");
});

test("daytime between sunrise and sunset", () => {
    const slot = computeSlot(baseConfig(), at(12, 0));
    assert.strictEqual(slot.slot, SLOT_DAY);
    assert.strictEqual(slot.themeId, "light-theme");
});

test("nighttime after sunset", () => {
    const slot = computeSlot(baseConfig(), at(22, 0));
    assert.strictEqual(slot.slot, SLOT_NIGHT);
    assert.strictEqual(slot.themeId, "dark-theme");
});

test("before sunrise it is still the previous night", () => {
    const slot = computeSlot(baseConfig(), at(3, 0));
    assert.strictEqual(slot.slot, SLOT_NIGHT);
});

test("a schedule crossing midnight keeps the right state", () => {
    // Night from 02:00 to 08:00 (the user lives with the curtains shut).
    const config = baseConfig({sunriseMin: 8 * 60, sunsetMin: 2 * 60});
    assert.strictEqual(computeSlot(config, at(3, 0)).slot, SLOT_NIGHT);
    assert.strictEqual(computeSlot(config, at(7, 59)).slot, SLOT_NIGHT);
    assert.strictEqual(computeSlot(config, at(8, 0)).slot, SLOT_DAY);
    assert.strictEqual(computeSlot(config, at(23, 0)).slot, SLOT_DAY);
    assert.strictEqual(computeSlot(config, at(1, 59)).slot, SLOT_DAY);
});

test("the switch is inclusive on the boundary minute", () => {
    const config = baseConfig();
    assert.strictEqual(computeSlot(config, at(7, 59)).slot, SLOT_NIGHT);
    assert.strictEqual(computeSlot(config, at(8, 0)).slot, SLOT_DAY);
    assert.strictEqual(computeSlot(config, at(19, 59)).slot, SLOT_DAY);
    assert.strictEqual(computeSlot(config, at(20, 0)).slot, SLOT_NIGHT);
});

test("system-theme mode follows systemDark", () => {
    const dark = computeSlot(baseConfig({mode: "system-theme", systemDark: true}), at(12, 0));
    assert.strictEqual(dark.slot, SLOT_NIGHT);
    assert.strictEqual(dark.themeId, "dark-theme");
    assert.strictEqual(dark.min, null);

    const light = computeSlot(baseConfig({mode: "system-theme", systemDark: false}), at(22, 0));
    assert.strictEqual(light.slot, SLOT_DAY);
});

test("polar day and polar night do not crash", () => {
    const polarDay = computeSlot(baseConfig({safeMode: true, polarDay: true}), at(23, 0));
    assert.strictEqual(polarDay.slot, SLOT_DAY);

    const polarNight = computeSlot(baseConfig({safeMode: true, polarDay: false}), at(12, 0));
    assert.strictEqual(polarNight.slot, SLOT_NIGHT);
});

test("extra slots override the base schedule", () => {
    const config = baseConfig({
        extras: [
            {id: "evening", time: "22:00", themeId: "evening-theme", scheme: "dark"},
            {id: "morning", time: "06:00", themeId: "morning-theme", scheme: "light"}
        ]
    });

    const evening = computeSlot(config, at(23, 0));
    assert.strictEqual(evening.slot, SLOT_EXTRA_PREFIX + "evening");
    assert.strictEqual(evening.themeId, "evening-theme");
    assert.strictEqual(evening.scheme, "dark");

    const morning = computeSlot(config, at(7, 0));
    assert.strictEqual(morning.themeId, "morning-theme");

    // 09:00 falls back to the day theme from sunrise.
    assert.strictEqual(computeSlot(config, at(9, 0)).themeId, "light-theme");
});

test("an extra slot with a broken time is ignored", () => {
    const config = baseConfig({extras: [{id: "bad", time: "", themeId: "x"}]});
    assert.strictEqual(computeSlot(config, at(12, 0)).slot, SLOT_DAY);
});

test("effectiveSunTimes applies and wraps the offsets", () => {
    const later = effectiveSunTimes(baseConfig({sunriseMin: 480, sunriseOffset: 30}));
    assert.strictEqual(later.sunrise, 510);

    const earlier = effectiveSunTimes(baseConfig({sunsetMin: 1200, sunsetOffset: -45}));
    assert.strictEqual(earlier.sunset, 1155);

    const wrapped = effectiveSunTimes(baseConfig({sunriseMin: 10, sunriseOffset: -30}));
    assert.strictEqual(wrapped.sunrise, 1420);
});

test("nextEvent finds the next boundary and wraps to the first", () => {
    const events = buildEvents(baseConfig());
    // nextEvent() takes minutes since local midnight.
    assert.strictEqual(nextEvent(events, 12 * 60).slot, SLOT_NIGHT);
    assert.strictEqual(nextEvent(events, 21 * 60).slot, SLOT_DAY);
});

test("a timezone override shifts the computed slot", () => {
    // 12:00 UTC is 23:00 at UTC+11 — should already be night.
    const config = baseConfig({tzOffsetMinutes: 660});
    assert.strictEqual(computeSlot(config, at(12, 0)).slot, SLOT_NIGHT);
    // 12:00 UTC is 10:00 at UTC-2 — still daytime.
    assert.strictEqual(computeSlot(baseConfig({tzOffsetMinutes: -120}), at(12, 0)).slot, SLOT_DAY);
});
