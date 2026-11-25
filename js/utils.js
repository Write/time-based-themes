'use strict';

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

// Helper: Log debug messages.
function logDebug(text) {
    if (typeof DEBUG_MODE !== "undefined" && DEBUG_MODE) {
        console.log("automaticDark DEBUGGING: " + text);
    }
}

// Helper: Print the error.
function onError(error) {
    console.log("automaticDark Error: " + error);
}

// ---------------------------------------------------------------------------
// Small object helpers
// ---------------------------------------------------------------------------

// Helper: Check if the object is empty.
function isEmpty(obj) {
    for (var key in obj) {
        if (obj.hasOwnProperty(key))
            return false;
    }
    return true;
}

// Helper: deep-ish clone of a JSON-able object.
function cloneObject(obj) {
    return JSON.parse(JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// Time helpers
//
// Every time calculation in this extension works on "minutes since local
// midnight". The local offset is either read from the browser or taken from
// the user's "time zone offset" setting, because
// privacy.resistFingerprinting (and some hardened browsers) force
// Date#getTimezoneOffset() to report UTC — which used to shift every switch
// by a constant amount (issue #5).
// ---------------------------------------------------------------------------

function normalizeMinutes(minutes) {
    return ((Math.round(minutes) % 1440) + 1440) % 1440;
}

// Offset of the current zone relative to UTC, in minutes ahead of UTC
// (e.g. +120 for UTC+2). tzOffsetSeconds from Date#getTimezoneOffset is
// inverted, hence the minus sign.
function browserOffsetMinutes(date) {
    return -(date || new Date()).getTimezoneOffset();
}

// Minute of the day, in the user's zone (override applied when set).
function minutesOfDay(dateMs, tzOffsetMinutes) {
    return normalizeMinutes(Math.floor(dateMs / 60000) + tzOffsetMinutes);
}

// Parse "HH:MM" (a <input type="time"> value) into minutes since midnight.
// Returns null when the value is missing or malformed.
function parseTimeToMinutes(value) {
    if (!value || typeof value !== "string") {
        return null;
    }
    let parts = value.split(":");
    if (parts.length < 2) {
        return null;
    }
    let hours = parseInt(parts[0], 10);
    let minutes = parseInt(parts[1], 10);
    if (isNaN(hours) || isNaN(minutes)) {
        return null;
    }
    return normalizeMinutes(hours * 60 + minutes);
}

function addLeadZero(num) {
    return num < 10 ? "0" + num : "" + num;
}

// "HH:MM" from a value in minutes since midnight.
function formatMinutes(minutes) {
    let m = normalizeMinutes(minutes);
    return addLeadZero(Math.floor(m / 60)) + ":" + addLeadZero(m % 60);
}

// Convert a Date to a "HH:MM" string in the user's zone.
function convertDateToString(date, tzOffsetMinutes) {
    let offset = typeof tzOffsetMinutes === "number"
        ? tzOffsetMinutes
        : browserOffsetMinutes(date);
    return formatMinutes(minutesOfDay(date.getTime(), offset));
}

// Take in the time as hours and minutes and return the next time it will
// occur, as milliseconds since the epoch.
function convertToNextMilliEpoch(hours, minutes) {
    let returnDate = new Date(Date.now());
    returnDate.setHours(hours);
    returnDate.setMinutes(minutes);
    returnDate.setSeconds(0);
    returnDate.setMilliseconds(0);

    if (returnDate < Date.now()) {
        returnDate.setDate(returnDate.getDate() + 1);
    }
    return returnDate.getTime();
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

// Set each key in storage only if overrideDefault is true or that key has
// never been set before. Writing every key in a single storage.local.set()
// call used to clobber unrelated settings, so each key is merged separately.
function setStorage(obj, overrideDefault = false) {
    logDebug("Start setStorage");

    return Promise.all(Object.keys(obj).map((item) => {
        return browser.storage.local.get(item)
            .then((fetchedItem) => {
                if (overrideDefault || isEmpty(fetchedItem)) {
                    return browser.storage.local.set({ [item]: obj[item] })
                        .then(() => {}, onError);
                }
            }, onError);
    }));
}

// Read a single setting, returning fallback when the key is absent or empty.
function getSetting(key, fallback) {
    return browser.storage.local.get(key)
        .then((obj) => {
            if (obj && obj[key] !== undefined && !isEmpty(obj[key])) {
                return obj[key];
            }
            return fallback;
        }, (error) => {
            onError(error);
            return fallback;
        });
}

// ---------------------------------------------------------------------------
// Node export (used by test/schedule.test.js)
// ---------------------------------------------------------------------------
if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        normalizeMinutes: normalizeMinutes,
        minutesOfDay: minutesOfDay,
        parseTimeToMinutes: parseTimeToMinutes,
        formatMinutes: formatMinutes,
        browserOffsetMinutes: browserOffsetMinutes,
        convertDateToString: convertDateToString,
        convertToNextMilliEpoch: convertToNextMilliEpoch,
        addLeadZero: addLeadZero,
        isEmpty: isEmpty,
        cloneObject: cloneObject
    };
}

// Get all active alarms (debug helper).
function logAllAlarms() {
    logDebug("Start logAllAlarms");

    return browser.alarms.getAll()
        .then(function (alarms) {
            logDebug("Log all active alarms...");
            if (DEBUG_MODE) {
                console.log(alarms);
            }
        });
}
