'use strict';

// ---------------------------------------------------------------------------
// Storage keys.
//
// The `autodark…` strings for the original settings are kept byte-for-byte
// identical so that upgrading from 1.x keeps the user's configuration.
// ---------------------------------------------------------------------------

const KEY_PREFIX = "autodark";

const DEBUG_MODE_KEY = KEY_PREFIX + "debugMode";
const CURRENT_MODE_KEY = KEY_PREFIX + "currentMode"; // day-mode, night-mode, <slot>
const CHANGE_MODE_KEY = KEY_PREFIX + "changeMode"; // location-suntimes, manual-suntimes, system-theme
const CHECK_TIME_STARTUP_ONLY_KEY = KEY_PREFIX + "checkTimeStartupOnly";
const DAYTIME_THEME_KEY = KEY_PREFIX + "daytimeTheme";
const NIGHTTIME_THEME_KEY = KEY_PREFIX + "nighttimeTheme";
const SUNRISE_TIME_KEY = KEY_PREFIX + "sunriseTime";
const SUNSET_TIME_KEY = KEY_PREFIX + "sunsetTime";
const GEOLOCATION_LATITUDE_KEY = KEY_PREFIX + "geoLatitude";
const GEOLOCATION_LONGITUDE_KEY = KEY_PREFIX + "geoLongitude";

// New in 2.0.0
const SUNRISE_OFFSET_KEY = KEY_PREFIX + "sunriseOffset"; // {minutes}
const SUNSET_OFFSET_KEY = KEY_PREFIX + "sunsetOffset"; // {minutes}
const TIMEZONE_OFFSET_KEY = KEY_PREFIX + "timezoneOffset"; // {minutes|null}
const MANUAL_LATITUDE_KEY = KEY_PREFIX + "manualLatitude"; // {value}
const MANUAL_LONGITUDE_KEY = KEY_PREFIX + "manualLongitude"; // {value}
const USE_MANUAL_LOCATION_KEY = KEY_PREFIX + "useManualLocation"; // {check}
const DAY_SCHEME_KEY = KEY_PREFIX + "dayScheme"; // {value}
const NIGHT_SCHEME_KEY = KEY_PREFIX + "nightScheme"; // {value}
const EXTRA_SLOTS_KEY = KEY_PREFIX + "extraSlots"; // {slots:[{id,time,themeId,scheme}]}
const CUSTOM_DAY_THEME_KEY = KEY_PREFIX + "customDayTheme"; // {json}
const CUSTOM_NIGHT_THEME_KEY = KEY_PREFIX + "customNightTheme"; // {json}
const RANDOM_POOL_KEY = KEY_PREFIX + "randomPool"; // {ids:[]}
const RANDOM_INTERVAL_KEY = KEY_PREFIX + "randomInterval"; // {hours}
const RANDOM_LAST_KEY = KEY_PREFIX + "randomLast"; // {ms, themeId, slot}
const APPLY_ON_FOCUS_KEY = KEY_PREFIX + "applyOnFocus"; // {check}
const SITE_OVERRIDES_KEY = KEY_PREFIX + "siteOverrides"; // {text}
const SYSTEM_DARK_KEY = KEY_PREFIX + "systemDark"; // {check}

// Context-menu item on the toolbar button (2.0.1): the plain click opens the
// settings, the menu keeps the one-click day/night switch of issues #24 / #36.
const MENU_TOGGLE = KEY_PREFIX + "-toggle-now";
const LAST_MODE_KEY = KEY_PREFIX + "lastMode"; // {mode}

const TICK_ALARM_NAME = KEY_PREFIX + "tick";

// How long the options page preview keeps a candidate theme on screen before
// the schedule is restored (issue #61).
const PREVIEW_DURATION_MS = 20000;

// Every browser call below is given a deadline (issue: "nothing works, not even
// the button, can't even preview").
//
// A single never-settling promise used to poison `switch_queue` for the rest of
// the session: every later tick, toolbar click and preview queued behind it and
// nothing ever happened again. Failing loudly after a few seconds keeps the
// extension alive and surfaces the stuck call instead of hiding it.
let with_timeout_ms = 5000;

// Tests run with a fake clock, so they need to move the deadline themselves.
function timeoutDeadline() {
    return typeof __with_timeout_ms === "number" ? __with_timeout_ms : with_timeout_ms;
}

// The deadline runs on the real clock even when the rest of the code is on a
// fake one (the test harness provides the hook).
function scheduleDeadline(callback, delay) {
    if (typeof __scheduleDeadline === "function") {
        return __scheduleDeadline(callback, delay);
    }
    return setTimeout(callback, delay);
}

function withTimeout(promise, label) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let deadline = timeoutDeadline();
        let timer = scheduleDeadline(() => {
            if (settled) {
                return;
            }
            settled = true;
            let error = new Error("timeout after " + deadline + "ms: " + label);
            pushEvent("timeout", label);
            logDebug(error.message);
            reject(error);
        }, deadline);
        Promise.resolve(promise).then((value) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            resolve(value);
        }, (error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
    });
}

// Theme values that are not installed theme ids.
const CUSTOM_THEME_PREFIX = "custom:";
const CUSTOM_DAY = CUSTOM_THEME_PREFIX + "day";
const CUSTOM_NIGHT = CUSTOM_THEME_PREFIX + "night";

const CHANGE_MODES = ["manual-suntimes", "location-suntimes", "system-theme"];
const DEFAULT_CHANGE_MODE = "manual-suntimes";
const DEFAULT_CHECK_TIME_STARTUP_ONLY = false;
const DEFAULT_SUNRISE_TIME = "08:00";
const DEFAULT_SUNSET_TIME = "20:00";
const DEFAULT_DEBUG_MODE = false;
const DEFAULT_APPLY_ON_FOCUS = true;
// Jo (m01265): the default must follow the operating system, in every mode.
const DEFAULT_SCHEME = "system";
const SCHEME_VALUES = ["auto", "light", "dark", "system", "off"];

// Reasons a tick may run. With "change only on start-up" enabled, only the
// reasons in this set are allowed to switch anything.
const FORCED_REASONS = ["startup", "settings", "toolbar", "install"];
// An OS light/dark flip must re-apply even in "change on startup only" mode, but
// it must NOT bypass the "nothing to do" shortcut: our own setEnabled() fires
// theme.onUpdated, and forcing there would loop forever.
const STARTUP_BYPASS_REASONS = FORCED_REASONS.concat(["os-change"]);

// Keys whose change requires re-evaluating the schedule.
const REACTIVE_KEYS = [
    CHANGE_MODE_KEY, CHECK_TIME_STARTUP_ONLY_KEY, DAYTIME_THEME_KEY,
    NIGHTTIME_THEME_KEY, SUNRISE_TIME_KEY, SUNSET_TIME_KEY,
    SUNRISE_OFFSET_KEY, SUNSET_OFFSET_KEY, TIMEZONE_OFFSET_KEY,
    MANUAL_LATITUDE_KEY, MANUAL_LONGITUDE_KEY, USE_MANUAL_LOCATION_KEY,
    DAY_SCHEME_KEY, NIGHT_SCHEME_KEY, EXTRA_SLOTS_KEY,
    CUSTOM_DAY_THEME_KEY, CUSTOM_NIGHT_THEME_KEY,
    RANDOM_POOL_KEY, RANDOM_INTERVAL_KEY, APPLY_ON_FOCUS_KEY
];

let DEBUG_MODE = false;

// Default themes, filled in from the user's currently enabled theme.
let DEFAULT_DAYTIME_THEME = "";
let DEFAULT_NIGHTTIME_THEME = "";

// Every theme switch funnels through this queue so only one runs at a time:
// the alarm, the focus listener, a content-script scheme report and the
// options page can otherwise interleave and repaint the wrong theme.
let switch_queue = Promise.resolve();
let preview_timer = null;

// What we last applied, so that re-running a tick is a no-op (theme churn was
// what unchecked the DRM setting for some Linux users, issue #26).
let last_applied = { slot: null, themeId: null, scheme: null, mode: null };

// Whether our own theme.update() overlay (the color_scheme workaround) is
// currently painted, and whether it embeds images we had to rewrite.
let overlay_applied = false;
let repaint_attempted_theme = null;

// Last value written to browserSettings.overrideContentColorScheme.
let last_content_scheme = null;

// Last OS colour scheme reported by a content script.
let system_dark = null;

// Today's computed sunrise/sunset (minutes since local midnight).
let suntimes_cache = null;

const BUILT_IN_THEME_IDS = [
    "default-theme@mozilla.org",
    "firefox-compact-light@mozilla.org",
    "firefox-compact-dark@mozilla.org"
];

// ---------------------------------------------------------------------------
// Feature detection — lets the same build load in Firefox, Firefox for
// Android and Thunderbird (issue #29) instead of throwing on a missing API.
// ---------------------------------------------------------------------------

const caps = {
    theme: typeof browser !== "undefined" && !!browser.theme,
    management: typeof browser !== "undefined" && !!browser.management,
    browserSettings: typeof browser !== "undefined" && !!browser.browserSettings,
    browserAction: typeof browser !== "undefined" && !!browser.browserAction,
    menus: typeof browser !== "undefined" && !!(browser.menus && browser.menus.create),
    windows: typeof browser !== "undefined" && !!browser.windows
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function numberSetting(obj, key, fallback) {
    let value = obj[key];
    if (value && typeof value === "object" && typeof value.minutes === "number") {
        return value.minutes;
    }
    if (value && typeof value === "object" && typeof value.value === "number") {
        return value.value;
    }
    return fallback;
}

function boolSetting(obj, key, fallback) {
    let value = obj[key];
    if (value && typeof value === "object" && typeof value.check === "boolean") {
        return value.check;
    }
    return fallback;
}

function stringSetting(obj, key, fallback) {
    let value = obj[key];
    if (value && typeof value === "object" && typeof value.value === "string" && value.value !== "") {
        return value.value;
    }
    if (value && typeof value === "object" && typeof value.time === "string" && value.time !== "") {
        return value.time;
    }
    if (value && typeof value === "object" && typeof value.themeId === "string" && value.themeId !== "") {
        return value.themeId;
    }
    return fallback;
}

// changeMode is stored as {mode: "..."} — not as {value}/{time}/{themeId}, so
// it needs its own reader (an unknown mode falls back to the default).
function modeSetting(obj) {
    let value = obj[CHANGE_MODE_KEY];
    let mode = value && typeof value.mode === "string" ? value.mode : "";
    return CHANGE_MODES.indexOf(mode) === -1 ? DEFAULT_CHANGE_MODE : mode;
}

function schemeSetting(obj, key) {
    let value = stringSetting(obj, key, DEFAULT_SCHEME);
    return SCHEME_VALUES.indexOf(value) === -1 ? DEFAULT_SCHEME : value;
}

function getSettings() {
    return browser.storage.local.get(null).then((obj) => {
        let tzOverride = obj[TIMEZONE_OFFSET_KEY] ? obj[TIMEZONE_OFFSET_KEY].minutes : null;
        let latitude = numberSetting(obj, MANUAL_LATITUDE_KEY, null);
        let longitude = numberSetting(obj, MANUAL_LONGITUDE_KEY, null);

        return {
            debugMode: boolSetting(obj, DEBUG_MODE_KEY, DEFAULT_DEBUG_MODE),
            currentMode: obj[CURRENT_MODE_KEY] ? obj[CURRENT_MODE_KEY].mode : null,
            changeMode: modeSetting(obj),
            startupOnly: boolSetting(obj, CHECK_TIME_STARTUP_ONLY_KEY, DEFAULT_CHECK_TIME_STARTUP_ONLY),
            dayThemeId: stringSetting(obj, DAYTIME_THEME_KEY, ""),
            nightThemeId: stringSetting(obj, NIGHTTIME_THEME_KEY, ""),
            sunriseTime: stringSetting(obj, SUNRISE_TIME_KEY, DEFAULT_SUNRISE_TIME),
            sunsetTime: stringSetting(obj, SUNSET_TIME_KEY, DEFAULT_SUNSET_TIME),
            sunriseOffset: numberSetting(obj, SUNRISE_OFFSET_KEY, 0),
            sunsetOffset: numberSetting(obj, SUNSET_OFFSET_KEY, 0),
            // null = use the browser's own offset
            timezoneOffset: typeof tzOverride === "number" ? tzOverride : null,
            geoLatitude: obj[GEOLOCATION_LATITUDE_KEY] ? obj[GEOLOCATION_LATITUDE_KEY].latitude : null,
            geoLongitude: obj[GEOLOCATION_LONGITUDE_KEY] ? obj[GEOLOCATION_LONGITUDE_KEY].longitude : null,
            manualLatitude: latitude,
            manualLongitude: longitude,
            useManualLocation: boolSetting(obj, USE_MANUAL_LOCATION_KEY, false),
            dayScheme: schemeSetting(obj, DAY_SCHEME_KEY),
            nightScheme: schemeSetting(obj, NIGHT_SCHEME_KEY),
            extras: (obj[EXTRA_SLOTS_KEY] && Array.isArray(obj[EXTRA_SLOTS_KEY].slots))
                ? obj[EXTRA_SLOTS_KEY].slots
                : [],
            customDayTheme: obj[CUSTOM_DAY_THEME_KEY] ? obj[CUSTOM_DAY_THEME_KEY].json : null,
            customNightTheme: obj[CUSTOM_NIGHT_THEME_KEY] ? obj[CUSTOM_NIGHT_THEME_KEY].json : null,
            randomPool: (obj[RANDOM_POOL_KEY] && Array.isArray(obj[RANDOM_POOL_KEY].ids))
                ? obj[RANDOM_POOL_KEY].ids
                : [],
            randomInterval: (obj[RANDOM_INTERVAL_KEY] && typeof obj[RANDOM_INTERVAL_KEY].hours === "number")
                ? obj[RANDOM_INTERVAL_KEY].hours
                : 0,
            randomLast: obj[RANDOM_LAST_KEY] || null,
            applyOnFocus: boolSetting(obj, APPLY_ON_FOCUS_KEY, DEFAULT_APPLY_ON_FOCUS),
            siteOverrides: obj[SITE_OVERRIDES_KEY] ? (obj[SITE_OVERRIDES_KEY].text || "") : ""
        };
    });
}

// ---------------------------------------------------------------------------
// Sunrise / sunset
// ---------------------------------------------------------------------------

function tzOffset(s) {
    return typeof s.timezoneOffset === "number"
        ? s.timezoneOffset
        : browserOffsetMinutes(new Date());
}

function locationFor(s) {
    if (s.useManualLocation && typeof s.manualLatitude === "number"
        && typeof s.manualLongitude === "number") {
        return { latitude: s.manualLatitude, longitude: s.manualLongitude };
    }
    if (typeof s.geoLatitude === "number" && typeof s.geoLongitude === "number") {
        return { latitude: s.geoLatitude, longitude: s.geoLongitude };
    }
    if (typeof s.manualLatitude === "number" && typeof s.manualLongitude === "number") {
        return { latitude: s.manualLatitude, longitude: s.manualLongitude };
    }
    return null;
}

// Compute today's sunrise/sunset as minutes since local midnight, using the
// SunCalc library (v2). Returns {sunriseMin, sunsetMin, polarDay} where the
// minutes are null during polar day/night.
function calculateSuntimes(s, now) {
    let location = locationFor(s);
    if (!location) {
        return Promise.resolve({ sunriseMin: null, sunsetMin: null, polarDay: null });
    }

    let offset = tzOffset(s);
    let date = now || new Date();
    let cacheKey = [
        convertDateToString(date, offset), location.latitude, location.longitude, offset
    ].join("|");

    if (suntimes_cache && suntimes_cache.key === cacheKey) {
        return Promise.resolve(suntimes_cache.value);
    }

    let times;
    try {
        times = SunCalc.getTimes(date, location.latitude, location.longitude, 0, offset);
    } catch (e) {
        onError(e);
        return Promise.resolve({ sunriseMin: null, sunsetMin: null, polarDay: null });
    }

    let value = {
        sunriseMin: times.sunrise ? minutesOfDay(times.sunrise.getTime(), offset) : null,
        sunsetMin: times.sunset ? minutesOfDay(times.sunset.getTime(), offset) : null,
        polarDay: times.sunrise === null && times.sunset === null
            ? (times.alwaysUp === true)
            : null
    };
    suntimes_cache = { key: cacheKey, value: value };

    logDebug("Suntimes for " + cacheKey + ": " + JSON.stringify(value));
    return Promise.resolve(value);
}

// The stored manual sunrise/sunset (used by manual-suntimes mode).
function manualSuntimes(s) {
    return {
        sunriseMin: parseTimeToMinutes(s.sunriseTime),
        sunsetMin: parseTimeToMinutes(s.sunsetTime),
        polarDay: null
    };
}

// Build the config object consumed by computeSlot().
function buildSlotConfig(s, times) {
    let offset = tzOffset(s);
    return {
        mode: s.changeMode,
        systemDark: !!system_dark,
        tzOffsetMinutes: offset,
        sunriseMin: times.sunriseMin,
        sunsetMin: times.sunsetMin,
        sunriseOffset: s.sunriseOffset || 0,
        sunsetOffset: s.sunsetOffset || 0,
        safeMode: times.sunriseMin === null || times.sunsetMin === null,
        polarDay: times.polarDay,
        dayThemeId: s.dayThemeId,
        nightThemeId: s.nightThemeId,
        dayScheme: s.dayScheme,
        nightScheme: s.nightScheme,
        extras: s.extras
    };
}

// Apply the user's ±minutes offsets to the sunrise/sunset minutes.
function applyOffsets(times, s) {
    let effective = effectiveSunTimes({
        sunriseMin: times.sunriseMin,
        sunsetMin: times.sunsetMin,
        sunriseOffset: s.sunriseOffset || 0,
        sunsetOffset: s.sunsetOffset || 0
    });
    return {
        sunriseMin: effective.sunrise,
        sunsetMin: effective.sunset,
        polarDay: times.polarDay
    };
}

// ---------------------------------------------------------------------------
// Theme resolution
// ---------------------------------------------------------------------------

function themeSpecFor(themeId, s) {
    if (!themeId) {
        return null;
    }
    if (themeId === CUSTOM_DAY || themeId === CUSTOM_NIGHT) {
        let json = themeId === CUSTOM_DAY ? s.customDayTheme : s.customNightTheme;
        if (!json) {
            return null;
        }
        return { kind: "custom", id: themeId, json: json };
    }
    return { kind: "installed", id: themeId };
}

// Turn every image reference of a theme object into a data: URL.
//
// Firefox hands back moz-extension:// resource URLs from theme.getCurrent()
// and then refuses them in theme.update(): the whole update is rejected, so
// the color_scheme workaround never takes effect and appearance changes are
// missed (issues #64, #74). Inlining the bytes works around that.
function embedThemeImages(theme) {
    if (!theme.images || typeof theme.images !== "object") {
        return Promise.resolve(theme);
    }

    let jobs = [];
    Object.keys(theme.images).forEach((key) => {
        let value = theme.images[key];

        if (typeof value === "string") {
            jobs.push(embedOne(value).then((dataUrl) => {
                if (dataUrl) {
                    theme.images[key] = dataUrl;
                } else {
                    delete theme.images[key];
                }
            }));
        } else if (Array.isArray(value)) {
            jobs.push(Promise.all(value.map(embedOne))
                .then((results) => {
                    let kept = results.filter((r) => !!r);
                    if (kept.length) {
                        theme.images[key] = kept;
                    } else {
                        delete theme.images[key];
                    }
                }));
        }
    });

    return Promise.all(jobs).then(() => theme);
}

function embedOne(url) {
    if (!url || typeof url !== "string" || url.indexOf("data:") === 0) {
        return Promise.resolve(url || null);
    }

    return fetch(url)
        .then((response) => {
            if (!response.ok) {
                throw new Error("HTTP " + response.status);
            }
            return response.blob();
        })
        .then((blob) => {
            // A theme background can be an SVG that already inlines a raster
            // image. Turning it into a data: URL nests one giant data: URL in
            // another and theme.update() rejects the whole update ("Error
            // processing images.additional_backgrounds.0"), which killed the
            // color_scheme workaround on themes built that way.
            if (blob.type !== "image/svg+xml") {
                return blob;
            }
            return blob.text().then((text) => (text.indexOf("data:image/") !== -1
                ? null : blob));
        })
        .then((blob) => {
            if (blob === null) {
                logDebug("embedOne: dropping nested-image SVG " + url);
                throw new Error("nested data: URL");
            }
            return blob;
        })
        .then((blob) => new Promise((resolve, reject) => {
            let reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        }))
        .catch((error) => {
            logDebug("embedOne: dropping unusable image " + url + " (" + error + ")");
            return null;
        });
}

// The properties theme.update() accepts. Keeping only color_scheme used to
// strip the alignment/tiling of a themed background image, so an installed
// image theme came back looking like the plain default theme while its
// color_scheme workaround was in place.
const THEME_PROPERTY_KEYS = [
    "additional_backgrounds_alignment",
    "additional_backgrounds_tiling",
    "color_scheme",
    "content_color_scheme",
    "ntp_background_alignment",
    "ntp_background_tiling"
];

// Keep only the members theme.update() accepts.
function sanitizeTheme(theme) {
    let clean = {};
    if (theme.colors && typeof theme.colors === "object") {
        clean.colors = theme.colors;
    }
    if (theme.images && typeof theme.images === "object") {
        clean.images = theme.images;
    }
    if (theme.properties && typeof theme.properties === "object") {
        let props = {};
        THEME_PROPERTY_KEYS.forEach((key) => {
            if (typeof theme.properties[key] !== "undefined") {
                props[key] = cloneObject(theme.properties[key]);
            }
        });
        clean.properties = props;
    }
    return clean;
}

// Re-apply the built-in Light/Dark substitution: those themes pin the OS
// light/dark signal, which stops detection entirely.
function substituteBuiltInTheme(themeId, themeKey, s) {
    if (s.changeMode !== "system-theme") {
        return themeId;
    }
    // The built-in Light and Dark themes pin the OS light/dark signal: a page
    // (and the background query) then reports that pinned value forever, which
    // is how a light OS ended up painted dark. Neither belongs in system-theme
    // mode, whichever slot asks for it — the System theme follows the OS by
    // itself.
    if (themeId !== "firefox-compact-light@mozilla.org"
        && themeId !== "firefox-compact-dark@mozilla.org") {
        return themeId;
    }
    logDebug("substituteBuiltInTheme - " + themeId + " pins the OS scheme; using System theme (auto).");
    return "default-theme@mozilla.org";
}

// ---------------------------------------------------------------------------
// Content colour scheme (issues #9, #14, #19, #30, #62)
// ---------------------------------------------------------------------------

// "auto" means: mirror the slot the theme is for (dark at night, light by
// day) in time-based modes, and follow the OS in system-theme mode.
function resolveContentScheme(scheme, slot, mode, themeId) {
    if (scheme === "off") {
        return null;
    }
    // In system-theme mode the OS drives everything, so the page scheme stays
    // "system" even if the day/night slot carries a pinned value: pinning it
    // is what starved OS detection (every page then reported the pinned value,
    // and the theme froze on whatever the last slot happened to be).
    if (mode === "system-theme") {
        return "system";
    }
    if (scheme === "system") {
        return "system";
    }
    if (scheme === "light" || scheme === "dark") {
        return scheme;
    }
    // "auto" mirrors the theme actually picked for this slot when it is one of
    // the built-in ones: choosing Light for the night slot used to paint light
    // chrome over pages still forced to dark.
    if (themeId === "firefox-compact-light@mozilla.org") {
        return "light";
    }
    if (themeId === "firefox-compact-dark@mozilla.org") {
        return "dark";
    }
    return slot === SLOT_DAY ? "light" : "dark";
}

function applyContentScheme(value) {
    if (value === null || value === undefined || !caps.browserSettings
        || !browser.browserSettings.overrideContentColorScheme) {
        return Promise.resolve();
    }
    if (value === last_content_scheme) {
        return Promise.resolve();
    }
    last_content_scheme = value;
    logDebug("Setting overrideContentColorScheme to " + value);
    return browser.browserSettings.overrideContentColorScheme.set({ value: value })
        .catch(onError);
}

// ---------------------------------------------------------------------------
// Applying a theme
// ---------------------------------------------------------------------------

// `overlay_applied` only knows about overlays *this* session created: after
// the background page restarts, an overlay from the previous session is still
// painted while the flag says otherwise. Snapshotting then re-applies the old
// overlay's colours, so the newly enabled theme never shows up. Callers that
// are about to enable a static theme therefore force the reset.
function resetOverlay(force) {
    if (!caps.theme) {
        return Promise.resolve();
    }
    if (!overlay_applied && !force) {
        return Promise.resolve();
    }
    overlay_applied = false;
    setOverlayOwner(null);
    return browser.theme.reset().catch(onError);
}

// Which theme the painted overlay was built for. A module flag cannot survive a
// background restart, and without knowing the owner the extension cannot tell
// "my overlay already shows this theme" from "a stale overlay hides it".
const OVERLAY_OWNER_KEY = KEY_PREFIX + "overlayowner";

function overlayOwner() {
    return browser.storage.local.get(OVERLAY_OWNER_KEY)
        .then((obj) => (obj[OVERLAY_OWNER_KEY] ? obj[OVERLAY_OWNER_KEY].themeId : null))
        .catch(() => null);
}

function setOverlayOwner(themeId) {
    if (!browser.storage || !browser.storage.local) {
        return;
    }
    if (themeId) {
        browser.storage.local.set({[OVERLAY_OWNER_KEY]: {themeId: themeId}});
    } else {
        browser.storage.local.remove(OVERLAY_OWNER_KEY);
    }
}

// A theme.update() overlay always declares its own color_scheme, and a static
// theme only does when it follows the OS. Anything painted with an explicit
// scheme therefore means an overlay is on top and has to be dropped before a
// static theme can be shown.
function overlayLooksActive() {
    if (!caps.theme) {
        return Promise.resolve(false);
    }
    return browser.theme.getCurrent()
        .then((current) => !!(current && current.properties
            && typeof current.properties.color_scheme === "string"))
        .catch(() => false);
}

// The overlay is a snapshot of whatever theme.getCurrent() reports, so it has
// to run once the newly enabled theme is actually painted: called too early it
// snapshots the *previous* theme and repaints the old colours in the new slot
// ("it switches, but keeps the other theme"). Poll a few times before giving
// up rather than silently leaving the old colours in place.
const OVERLAY_PAINT_ATTEMPTS = 6;
const OVERLAY_PAINT_DELAY_MS = 150;

function paintedTheme(attempt) {
    return browser.theme.getCurrent().then((current) => {
        if (current && current.colors) {
            return current;
        }
        if (attempt >= OVERLAY_PAINT_ATTEMPTS) {
            logDebug("ensureColorSchemeSystem: nothing painted after "
                + OVERLAY_PAINT_ATTEMPTS + " attempts (built-in theme?).");
            return null;
        }
        return new Promise((resolve) => setTimeout(resolve, OVERLAY_PAINT_DELAY_MS))
            .then(() => paintedTheme(attempt + 1));
    });
}

// Make sure the enabled theme follows the OS, so that the OS signal can still
// be observed (issues #11, #42, #43, #64).
//
// `themeId` is only used to remember which theme the overlay belongs to: after
// a background restart a module flag knows nothing about a painted overlay, and
// `applyThemeId` needs that to tell "my overlay already shows this theme" from
// "a leftover overlay hides it".
function ensureColorSchemeSystem(themeId) {
    if (!caps.theme) {
        return Promise.resolve();
    }
    return paintedTheme(0)
        .then((current) => {
            if (!current || !current.colors) {
                // Built-in themes report no colors: there is nothing to
                // snapshot, and they follow the OS on their own.
                return;
            }
            // A theme that already follows the OS needs no overlay, and an
            // overlay we own is already in place.
            if (current.properties && current.properties.color_scheme === "system") {
                setOverlayOwner(null);
                return;
            }
            // A theme that declares no colour scheme at all already makes the
            // media query follow the OS, so the overlay buys nothing — and
            // theme.update() REPLACES the enabled theme, which is how a working
            // switch ended up painting the built-in "Par défaut" theme instead
            // of the user's (report at 18:32:12: apply night, enabled theme
            // default, color_scheme null).
            if (!current.properties || !current.properties.color_scheme) {
                setOverlayOwner(null);
                debugLog("overlay", "skipped: theme declares no color_scheme");
                return;
            }

            let theme = sanitizeTheme(cloneObject(current));
            theme.properties = theme.properties || {};
            theme.properties.color_scheme = "system";
            delete theme.properties.content_color_scheme;

            return embedThemeImages(theme).then((ready) => {
                overlay_applied = true;
                setOverlayOwner(themeId);
                return browser.theme.update(ready).catch((error) => {
                    // Some artwork cannot be re-sent at all. The overlay exists
                    // for color_scheme: "system", not for the images, so retry
                    // with the colours alone rather than losing the fix.
                    logDebug("color_scheme workaround rejected the artwork ("
                        + error + "), retrying without images.");
                    delete ready.images;
                    return browser.theme.update(ready)
                        .then(() => logDebug("Applied color_scheme workaround (colors only)."));
                });
            });
        })
        .catch(onError);
}

// Enable an installed theme if it is not already enabled. Never toggles a
// theme that is already enabled — the disable/enable churn is what used to
// flip Firefox's DRM checkbox on Linux (issue #26).
function enableInstalledTheme(themeId, mode) {
    // management.get() can refuse the built-in themes ("System", "Light",
    // "Dark") on some builds even though setEnabled() works. Falling back keeps
    // system-theme mode from silently staying on the previous theme.
    let info = browser.management.get(themeId)
        .catch((error) => {
            if (BUILT_IN_THEME_IDS.indexOf(themeId) === -1) {
                throw error;
            }
            logDebug("management.get refused " + themeId + " (" + error
                + "), enabling it anyway.");
            return { enabled: false };
        });

    return info
        .then((info) => {
            if (!info.enabled) {
                logDebug("Enabling theme " + themeId);
                return browser.management.setEnabled(themeId, true)
                    .then(() => {
                        if (mode === "system-theme") {
                            return ensureColorSchemeSystem(themeId);
                        }
                    });
            }
            logDebug(themeId + " is already enabled.");
            // Switching into system-theme mode while the right theme is
            // already enabled still needs the color_scheme workaround.
            return mode === "system-theme" ? ensureColorSchemeSystem(themeId) : undefined;
        })
        .catch(onError);
}

// management can report a theme as enabled while the default theme is what is
// actually painted: theme.reset() repaints the default theme (bug 1415267),
// and reloading the extension drops its theme.update() overlay. getCurrent()
// then reports no colors. Toggle the theme once to force a real repaint.
function ensurePainted(themeId) {
    if (BUILT_IN_THEME_IDS.indexOf(themeId) !== -1) {
        return Promise.resolve();
    }
    // Ask which theme is enabled, not whether *a* theme is painted: after
    // theme.reset() Firefox paints the default theme, which has colours of its
    // own, so "some colours are on screen" answered yes while the theme the
    // user picked was not on screen at all.
    return Promise.all([browser.theme.getCurrent(), enabledThemeId()])
        .then(([current, enabled]) => {
            debugLog("painted", (current && current.colors ? "colours" : "nothing")
                + " name=" + JSON.stringify(current && current.name)
                + " enabled=" + enabled
                + " scheme=" + JSON.stringify(current && current.properties
                    && current.properties.color_scheme));
            if (enabled === themeId) {
                repaint_attempted_theme = null;
                return;
            }
            if (repaint_attempted_theme === themeId) {
                return;
            }
            logDebug("ensurePainted - " + themeId + " is enabled but not painted. Re-enabling it.");
            repaint_attempted_theme = themeId;
            return browser.management.setEnabled(themeId, false)
                .then(() => browser.management.setEnabled(themeId, true))
                .then(() => browser.theme.getCurrent())
                .then((repainted) => {
                    if (repainted && repainted.colors) {
                        repaint_attempted_theme = null;
                    }
                });
        })
        .catch(onError);
}

function applyCustomTheme(spec, mode) {
    let json = spec.json;
    if (json && typeof json === "object" && json.theme) {
        json = json.theme;
    }
    let theme = sanitizeTheme(cloneObject(json || {}));
    if (mode === "system-theme") {
        theme.properties = theme.properties || {};
        theme.properties.color_scheme = "system";
    }

    // A dynamic theme overlays the enabled static theme; reset first so the
    // previous theme's artwork does not bleed through.
    //
    // The user's own JSON is passed through untouched: inlining images into
    // data: URLs made theme.update() reject the whole theme
    // ("images.additional_backgrounds.0 ... must either match
    // imageDataOrStrictRelativeUrl"), so a custom theme with an SVG background
    // could never be applied at all.
    return resetOverlay()
        .then(() => {
            overlay_applied = true;
            return browser.theme.update(theme);
        })
        .catch(onError);
}

// A theme that declares a literal color_scheme pins prefers-color-scheme for
// every page and for the background media query: the extension then reads its
// own last decision back as if it came from the OS, and two slots that disagree
// alternate forever (the 2.0.12/2.0.13 report of an infinite light/dark loop).
// So in system-theme mode the chrome theme itself has to declare "system":
// a user picking Light or Dark there gets the System theme, which is the only
// built-in one that follows the OS anyway.
const SYSTEM_FOLLOWING_THEME_ID = "default-theme@mozilla.org";

function systemFollowingThemeId(themeId, mode) {
    if (mode !== "system-theme" || !themeId) {
        return themeId;
    }
    if (themeId === "firefox-compact-light@mozilla.org"
        || themeId === "firefox-compact-dark@mozilla.org") {
        return SYSTEM_FOLLOWING_THEME_ID;
    }
    return themeId;
}

// What Firefox says is enabled right now, versus what we asked for.
//
// `management.setEnabled()` can resolve while the default theme stays on
// screen (theme.reset() repaints it — Firefox bug 1415267), and every log line
// we had reported the *intention*, never the result. The report « preview does
// not even work » is that gap: apply is journalised, nothing is painted.
function enabledThemeId() {
    if (!browser.management || !browser.management.getAll) {
        return Promise.resolve(null);
    }
    return browser.management.getAll().then((list) => {
        let enabled = (list || []).filter((entry) => entry.type === "theme" && entry.enabled);
        return enabled.length ? enabled[0].id : null;
    }, () => null);
}

// Make sure the theme we chose is the one the browser holds. Toggling only when
// it is not: a disable/enable cycle is what forces a real repaint (issue #26 is
// the reason we never toggle a theme that is already in place).
function describeTheme(themeId) {
    if (!browser.management || !browser.management.get) {
        return Promise.resolve("management unavailable");
    }
    return browser.management.get(themeId).then((info) => {
        if (!info) {
            return "not installed";
        }
        return "enabled=" + info.enabled + " type=" + info.type + " version=" + info.version
            + " mayDisable=" + info.mayDisable + " name=" + JSON.stringify(info.name);
    }, (error) => "management.get refused: " + (error && error.message));
}

function verifyEnabled(themeId, label) {
    return enabledThemeId().then((actual) => {
        pushEvent("verify", label + " expected=" + themeId + " enabled=" + actual);
        if (actual !== themeId) {
            // Which theme refused, and what Firefox thinks of it: a theme that
            // Firefox itself marks as broken cannot be fixed from here.
            describeTheme(themeId).then((description) => {
                pushEvent("verify", label + " wanted: " + description);
            }, () => {});
        }
        if (actual === themeId || BUILT_IN_THEME_IDS.indexOf(themeId) !== -1) {
            return actual === themeId;
        }
        if (!browser.management || !browser.management.setEnabled) {
            return false;
        }
        logDebug("verifyEnabled: " + themeId + " is not the enabled theme (" + actual
            + " is), toggling it back on.");
        return withTimeout(browser.management.setEnabled(themeId, false), "management.setEnabled")
            .then(() => withTimeout(browser.management.setEnabled(themeId, true),
                "management.setEnabled"))
            .then(() => enabledThemeId())
            .then((again) => {
                pushEvent("verify", label + " after toggle enabled=" + again);
                return again === themeId;
            }, (error) => {
                pushEvent("verify", label + " toggle failed: " + (error && error.message));
                return false;
            });
    });
}

function applyThemeId(themeId, mode, themeKey, s) {
    if (!caps.theme || !caps.management) {
        logDebug("applyThemeId: no theme API available (Thunderbird?), skipping.");
        return Promise.resolve();
    }

    if (!themeId) {
        logDebug("applyThemeId: no theme configured.");
        return Promise.resolve();
    }

    let resolvedId = systemFollowingThemeId(
        substituteBuiltInTheme(themeId, themeKey, s || {}), mode);
    let spec = themeSpecFor(resolvedId, s || {});
    if (!spec) {
        logDebug("applyThemeId: " + resolvedId + " is not available.");
        debugLog("apply", resolvedId + " is not available, nothing to enable");
        return Promise.resolve();
    }
    debugLog("apply", spec.kind + " " + spec.id + " mode=" + mode);

    if (spec.kind === "custom") {
        return withTimeout(applyCustomTheme(spec, mode), "theme.update (custom)");
    }

    // Enabling a static theme is one decision: exactly one theme must be the
    // enabled one. Everything else that used to happen here — dropping an
    // overlay with theme.reset(), rebuilding it with theme.update(), guessing
    // the paint from theme.getCurrent().colors — was machinery that could only
    // mis-report: theme.reset() repaints the default theme (Firefox bug
    // 1415267) and the default theme has colours, so "a theme with colours is
    // on screen" was true while the user's theme was not on screen at all.
    return applyStaticTheme(spec.id);
}

// Make `themeId` the one enabled theme, and check it rather than assume it.
function applyStaticTheme(themeId) {
    return enabledThemeId().then((actual) => {
        if (actual === themeId) {
            pushEvent("apply", "already enabled " + themeId);
            return true;
        }
        debugLog("apply", "enabling " + themeId + " (was " + actual + ")");
        return withTimeout(browser.management.setEnabled(themeId, true), "management.setEnabled")
            .then(() => enabledThemeId())
            .then((after) => {
                if (after === themeId) {
                    pushEvent("apply", "enabled " + themeId);
                    return true;
                }
                // management said yes, the browser holds something else: the
                // known "enabled but not painted" state. A single disable/enable
                // cycle is the only way to force a real repaint.
                pushEvent("apply", "not in effect (" + after + "), toggling " + themeId);
                return withTimeout(browser.management.setEnabled(themeId, false),
                    "management.setEnabled")
                    .then(() => withTimeout(browser.management.setEnabled(themeId, true),
                        "management.setEnabled"))
                    .then(() => enabledThemeId())
                    .then((again) => {
                        pushEvent("apply", "after toggle " + again);
                        return again === themeId;
                    });
            });
    }).catch((error) => {
        pushEvent("apply", "failed " + themeId + ": " + (error && error.message));
        throw error;
    });
}

// Exposed for the options page preview button (issue #61): the candidate theme
// stays on screen for PREVIEW_DURATION_MS, then the schedule is restored.
function previewTheme(themeId) {
    return getSettings().then((s) => {
        if (!themeId) {
            return undefined;
        }
        logDebug("previewTheme " + themeId);

        return applyThemeId(themeId, s.changeMode, DAYTIME_THEME_KEY, s).then(() => {
            if (preview_timer) {
                clearTimeout(preview_timer);
            }
            preview_timer = setTimeout(() => {
                preview_timer = null;
                // Forget the last applied state so the next tick re-applies the
                // scheduled theme even though the slot did not change.
                last_applied = { slot: null, themeId: null, scheme: null, mode: null };
                queueTick("preview-end");
            }, PREVIEW_DURATION_MS);
            return undefined;
        });
    });
}

// ---------------------------------------------------------------------------
// The tick: compute what should be on screen and make it so
// ---------------------------------------------------------------------------

function randomPick(s, slot) {
    let pool = (s.randomPool || []).filter((id) => !!id);
    if (pool.length === 0) {
        return null;
    }

    let recent = s.randomLast;
    let intervalMs = (s.randomInterval || 0) * 3600 * 1000;

    if (recent && recent.themeId && recent.slot === slot) {
        // Only re-roll when the interval elapsed (0 = only on a real switch,
        // which the caller signals by clearing randomLast).
        if (intervalMs <= 0 || (Date.now() - recent.ms) < intervalMs) {
            return recent.themeId;
        }
    }

    let candidates = pool.filter((id) => !recent || id !== recent.themeId);
    if (candidates.length === 0) {
        candidates = pool;
    }
    return candidates[Math.floor(Math.random() * candidates.length)];
}

function slotLabel(slot) {
    if (slot === SLOT_DAY) {
        return "day-mode";
    }
    if (slot === SLOT_NIGHT) {
        return "night-mode";
    }
    return slot;
}

function setCurrentMode(mode) {
    return browser.storage.local.get(CURRENT_MODE_KEY)
        .then((obj) => {
            if (!obj[CURRENT_MODE_KEY] || obj[CURRENT_MODE_KEY].mode !== mode) {
                return browser.storage.local.set({ [CURRENT_MODE_KEY]: { mode: mode } });
            }
        }, onError);
}

// Ring buffer of the last decisions, shown by the diagnostics panel: without it
// every "it still does not switch" report needs a guess.
const EVENTS_KEY = "autodarkevents";
const EVENTS_MAX = 40;
let recent_events = [];

function pushEvent(kind, detail) {
    debugLog("event", kind + " " + detail);
    recent_events.push({t: new Date().toISOString().slice(11, 19), kind: kind, detail: String(detail)});
    if (recent_events.length > EVENTS_MAX) {
        recent_events = recent_events.slice(-EVENTS_MAX);
    }
    try {
        browser.storage.local.set({[EVENTS_KEY]: {check: recent_events}});
    } catch (error) {
        // never let diagnostics break a tick
    }
}

// In system-theme mode the OS scheme is *read*, not inferred.
//
// Everything that listened for a change — the background media query event, the
// content scripts, the vote that waited for a second sighting — could miss one:
// the event page sleeps, our own pages run no content script, Firefox does not
// always deliver the media query event. Detection looked random because it was
// a chain of witnesses. Reading the value on a short timer cannot miss: in this
// mode the theme we keep active always declares color_scheme "system", so the
// query reports the OS and never our own colours.
const SCHEME_POLL_MS = 2000;
const POLL_BEATS_KEY = KEY_PREFIX + "pollBeats";
let scheme_poll_timer = null;
let poll_beats = 0;

function recordSystemDark(dark, reason) {
    debugLog("os-record", (dark ? "dark" : "light") + " (" + reason + "), was " + system_dark);
    if (system_dark === dark) {
        return Promise.resolve(false);
    }
    system_dark = dark;
    pushEvent("os", (dark ? "dark" : "light") + " <- " + reason);
    logDebug("System colour scheme is now " + (dark ? "dark" : "light") + " (" + reason + ")");
    return browser.storage.local.set({ [SYSTEM_DARK_KEY]: { check: dark } })
        .then(() => true, () => true);
}

// One report, one decision: a report that contradicts what we believe is the
// OS speaking (our own theme cannot: it declares color_scheme "system").
function handleSchemeReport(dark, reason) {
    return recordSystemDark(!!dark, reason);
}

// In system-theme mode the content-script reports are the reliable source for
// the OS scheme. They are unavailable on privileged pages (about:preferences,
// addons.mozilla.org) and unusable when the page scheme is pinned, so fall back
// to the background media query — it follows the browser theme since Firefox 95
// but still catches genuine OS changes in many setups.
const background_scheme_query = window.matchMedia("(prefers-color-scheme: dark)");

function syncSystemDarkFromBackground(mode, reason) {
    if (mode !== "system-theme") {
        return;
    }
    // In system-theme mode this query is the OS: either the theme we keep
    // active declares color_scheme "system", or we painted an overlay that
    // does. Trusting it on *every* tick is what makes detection reliable —
    // depending on a page to report made it look random, because it only
    // worked when a web page happened to be open and happened to fire its
    // change event (extension event page may be asleep, options page runs no
    // content script, about: pages have none at all).
    let live = background_scheme_query.matches;
    debugLog("os-sync", "reason=" + reason + " stored=" + system_dark + " live=" + live);
    if (live !== system_dark) {
        recordSystemDark(live, "background media query on " + reason);
    }
}

// Keep reading the OS scheme while system-theme mode is selected.
function startSchemePoll(mode) {
    if (mode !== "system-theme") {
        if (scheme_poll_timer !== null) {
            clearInterval(scheme_poll_timer);
            scheme_poll_timer = null;
            logDebug("OS scheme polling stopped.");
        }
        return;
    }
    if (scheme_poll_timer !== null || typeof setInterval !== "function") {
        return;
    }
    logDebug("OS scheme polling every " + SCHEME_POLL_MS + "ms.");
    scheme_poll_timer = setInterval(() => {
        poll_beats += 1;
        if (poll_beats % 10 === 0) {
            // A heartbeat, persisted: if this number grows the timer runs, if it
            // freezes the page was suspended and no polling can ever work.
            try {
                browser.storage.local.set({[POLL_BEATS_KEY]: {
                    count: poll_beats,
                    at: new Date().toISOString().slice(11, 19)
                }});
            } catch (error) {
                // diagnostics only
            }
        }
        let live = background_scheme_query.matches;
        if (live === system_dark) {
            return;
        }
        recordSystemDark(live, "poll").then((moved) => {
            if (moved) {
                queueTick("os-change");
            }
        });
    }, SCHEME_POLL_MS);
}

function tick(reason) {
    logDebug("Start tick (" + reason + ")");

    return getSettings().then((s) => {
        DEBUG_MODE = s.debugMode;

        // Read the OS scheme directly (and keep reading it while this mode is
        // on): no witness, no missed event.
        startSchemePoll(s.changeMode);
        syncSystemDarkFromBackground(s.changeMode, reason);

        if (s.startupOnly && STARTUP_BYPASS_REASONS.indexOf(reason) === -1) {
            logDebug("tick ignored: change-on-startup-only is enabled.");
            return;
        }

        let mode = s.changeMode;

        if ((mode === "location-suntimes" || mode === "manual-suntimes")
            && !s.dayThemeId && !s.nightThemeId) {
            logDebug("tick: no themes configured yet.");
            return;
        }

        let timesPromise = mode === "location-suntimes"
            ? calculateSuntimes(s)
            : Promise.resolve(manualSuntimes(s));

        return timesPromise.then((rawTimes) => {
            let times = applyOffsets(rawTimes, s);
            let config = buildSlotConfig(s, {
                sunriseMin: times.sunriseMin,
                sunsetMin: times.sunsetMin,
                polarDay: times.polarDay
            });

            let desired = computeSlot(config, Date.now());

            // The toolbar override wins until the schedule boundary moves.
            return browser.storage.local.get(KEY_PREFIX + "override").then((obj) => {
                let ov = obj[KEY_PREFIX + "override"];
                if (ov && ov.slot && ov.slot !== desired.slot) {
                    logDebug("tick: schedule moved to " + desired.slot + ", clearing toolbar override.");
                    ov = null;
                    return browser.storage.local.remove(KEY_PREFIX + "override").then(() => ov);
                }
                return ov || null;
            }).then((ov) => {
                return applyDesired(s, desired, ov, reason);
            });
        });
    }, onError);
}

function applyDesired(s, desired, override, reason) {
    let mode = s.changeMode;
    let slot = desired.slot;
    let themeId = desired.themeId;
    let schemeSetting = desired.scheme;

    if (override && override.slot === slot) {
        slot = override.mode === "day" ? SLOT_DAY : SLOT_NIGHT;
        themeId = override.mode === "day" ? s.dayThemeId : s.nightThemeId;
        schemeSetting = override.mode === "day" ? s.dayScheme : s.nightScheme;
        logDebug("tick: toolbar override active, showing the " + override.mode + " theme.");
    }

    // Random pool rotation (issue #52).
    if ((slot === SLOT_DAY || slot === SLOT_NIGHT) && s.randomPool.length > 0) {
        let rolled = randomPick(s, slot);
        if (rolled && rolled !== (s.randomLast && s.randomLast.themeId)) {
            themeId = rolled;
            browser.storage.local.set({
                [RANDOM_LAST_KEY]: { ms: Date.now(), themeId: rolled, slot: slot }
            });
        } else if (rolled) {
            themeId = rolled;
        }
    }

    let contentScheme = resolveContentScheme(schemeSetting, slot, mode, themeId);
    let themeKey = slot === SLOT_DAY ? DAYTIME_THEME_KEY : NIGHTTIME_THEME_KEY;

    let unchanged = last_applied.slot === slot
        && last_applied.themeId === themeId
        && last_applied.scheme === contentScheme
        && last_applied.mode === mode;

    if (unchanged && !s.applyOnFocus && FORCED_REASONS.indexOf(reason) === -1) {
        logDebug("tick: nothing to do (only switching on schedule changes).");
        debugLog("skip", "nothing to do (" + reason + ")");
        return;
    }

    logDebug("tick: " + slot + " / " + themeId + " / scheme=" + contentScheme
        + " (previous " + JSON.stringify(last_applied) + ")");
    debugLog("tick", "reason=" + reason + " slot=" + slot + " theme=" + themeId
        + " scheme=" + contentScheme + " os=" + system_dark
        + " mode=" + mode + " unchanged=" + unchanged);

    pushEvent("apply", slot + " " + themeId + " mode=" + mode + " os=" + system_dark
        + " reason=" + reason);
    let modeChanged = last_applied.mode !== mode;
    let switchedTheme = last_applied.slot !== slot || last_applied.themeId !== themeId;
    last_applied = { slot: slot, themeId: themeId, scheme: contentScheme, mode: mode };

    return withTimeout(applyContentScheme(contentScheme), "browserSettings.overrideContentColorScheme")
        .then(() => applyThemeId(themeId, mode, themeKey, s))
        .then(() => setCurrentMode(slotLabel(slot)))
        .then(() => (modeChanged ? browser.storage.local.set({ [LAST_MODE_KEY]: { mode: mode } }) : undefined))
        .then(() => {
            updateToolbarTitle(slot);
            syncSystemDarkFromBackground(mode, reason);
        })
        .catch((error) => {
            // Do not remember a theme we failed to apply: the next tick has to
            // try again instead of believing `unchanged` and doing nothing.
            last_applied = { slot: null, themeId: null, scheme: null, mode: null };
            onError(error);
        });
}

function queueTick(reason) {
    const result = switch_queue.then(() => tick(reason)).then((value) => {
        // Keep the event page alive until the trace is stored: writes fired just
        // before teardown were being dropped, which made a working run look like
        // an empty log.
        return debugFlush().then(() => value);
    });
    switch_queue = result.then(() => {}, onError);
    return result;
}

// ---------------------------------------------------------------------------
// Toolbar button (issues #24, #36)
// ---------------------------------------------------------------------------

function updateToolbarTitle(slot) {
    if (!caps.browserAction) {
        return;
    }
    let text = slot === SLOT_DAY
        ? "automaticDark: daytime theme — click to open the settings"
        : "automaticDark: nighttime theme — click to open the settings";
    let call = browser.browserAction.setTitle({ title: text });
    if (call && call.catch) {
        call.catch(() => {});
    }
}

// The toolbar button opens the settings page (2.0.1).
function openSettings() {
    logDebug("Toolbar button clicked: opening the settings page.");

    let call = browser.runtime.openOptionsPage();
    if (call && call.catch) {
        call.catch(onError);
    }
    return Promise.resolve(true);
}

// Right-click on the toolbar button: switch day/night without opening a page.
//
// Everything here is best-effort: browsers disagree on the context name
// (“action” is the Chrome/MV3 spelling, Firefox MV2 only knows
// “browser_action”) and a throwing menus.create must never take the click
// handler down with it — that is exactly what made 2.0.1 unclickable.
function setupToolbarMenu() {
    if (!caps.menus) {
        return;
    }

    try {
        let created = browser.menus.create({
            id: MENU_TOGGLE,
            title: "Switch to the other theme now",
            contexts: ["browser_action"]
        });
        if (created && created.catch) {
            created.catch((error) => {
                logDebug("menus.create: " + error);
            });
        }
    } catch (error) {
        logDebug("menus.create threw: " + error);
    }

    try {
        browser.menus.onClicked.addListener((info) => {
            if (info.menuItemId === MENU_TOGGLE) {
                toggleFromToolbar();
            }
        });
    } catch (error) {
        logDebug("menus.onClicked: " + error);
    }
}

function toggleFromToolbar() {
    logDebug("Toolbar button clicked.");

    return getSettings().then((s) => {
        let timesPromise = s.changeMode === "location-suntimes"
            ? calculateSuntimes(s)
            : Promise.resolve(manualSuntimes(s));

        return timesPromise.then((rawTimes) => {
            let times = applyOffsets(rawTimes, s);
            let desired = computeSlot(buildSlotConfig(s, times), Date.now());

            return browser.storage.local.get(KEY_PREFIX + "override").then((obj) => {
                let ov = obj[KEY_PREFIX + "override"];
                let showing = desired.slot === SLOT_DAY ? "day" : "night";

                // An override already in force for this slot is what the user
                // is looking at, so it has to be flipped back: toggling from
                // the schedule slot alone would ask for the same theme twice
                // and the second click would look dead.
                if (ov && ov.slot === desired.slot
                        && (ov.mode === "day" || ov.mode === "night")) {
                    showing = ov.mode;
                }

                let next = showing === "day" ? "night" : "day";

                return browser.storage.local.set({
                    [KEY_PREFIX + "override"]: { mode: next, slot: desired.slot }
                });
            }).then(() => {
                // Force a re-apply even though the slot did not change.
                last_applied = { slot: null, themeId: null, scheme: null, mode: null };
                return queueTick("toolbar");
            });
        });
    }, onError);
}

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------

// One minutely tick drives everything. A single short-period alarm replaces
// the per-sunrise/sunset alarms of 1.x and survives sleep/hibernate, missed
// events and drift (issues #5, #16, #53).
function ensureTickAlarm(s) {
    return browser.alarms.get(TICK_ALARM_NAME)
        .then((alarm) => {
            if (s.startupOnly) {
                if (alarm) {
                    browser.alarms.clear(TICK_ALARM_NAME);
                }
                return;
            }
            if (!alarm) {
                browser.alarms.create(TICK_ALARM_NAME, {
                    delayInMinutes: 1,
                    periodInMinutes: 1
                });
            }
        }, onError);
}

function alarmListener(alarmInfo) {
    if (!alarmInfo || alarmInfo.name !== TICK_ALARM_NAME) {
        return;
    }
    debugLog("alarm", "#" + (alarm_beats + 1) + " fired");
    alarm_beats += 1;
    try {
        browser.storage.local.set({[ALARM_BEATS_KEY]: {count: alarm_beats}});
    } catch (error) {
        // diagnostics only
    }
    // The alarm is the only thing that wakes this page up, so it cannot assume
    // init() already ran: wait for it, then tick.
    ensureInitialised().then(() => queueTick("alarm"), onError);
}

// How many times the minutely alarm actually fired. If this stops growing, the
// alarm is the problem; if it grows and the theme still does not switch, the
// problem is downstream. Without this number both cases look identical.
const ALARM_BEATS_KEY = KEY_PREFIX + "alarmBeats";
let alarm_beats = 0;

browser.storage.local.get(ALARM_BEATS_KEY).then((obj) => {
    let stored = obj && obj[ALARM_BEATS_KEY] && obj[ALARM_BEATS_KEY].count;
    if (typeof stored === "number" && stored > alarm_beats) {
        alarm_beats = stored;
    }
}, () => {});

// Firefox only honours an event listener that was registered *synchronously*
// while the background script is being evaluated. The alarm listener used to be
// added inside init(), after its first `await`, which is silently accepted and
// then never called — the minutely tick never fired, so an OS appearance change
// was only noticed when something else asked for a recheck by hand.
if (browser.alarms && browser.alarms.onAlarm) {
    browser.alarms.onAlarm.addListener(alarmListener);
}

// Resolves once init() has finished, so a waking alarm can wait on it.
let init_promise = null;

function ensureInitialised() {
    if (!init_promise) {
        init_promise = Promise.resolve(init()).catch(onError);
    }
    return init_promise;
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function setDefaultThemes() {
    logDebug("Start setDefaultThemes");

    if (!caps.management) {
        return Promise.resolve();
    }

    return browser.management.getAll()
        .then((extensions) => {
            const LIGHT = "firefox-compact-light@mozilla.org";
            const DARK = "firefox-compact-dark@mozilla.org";
            let enabledTheme = "";
            for (let extension of extensions) {
                if (extension.type === "theme" && extension.enabled) {
                    enabledTheme = extension.id;
                }
            }

            if (enabledTheme === DARK) {
                // Defaulting both slots to the dark theme made a fresh install
                // look permanently dark; pair it with the light one instead.
                DEFAULT_DAYTIME_THEME = LIGHT;
                DEFAULT_NIGHTTIME_THEME = DARK;
            } else if (enabledTheme === LIGHT) {
                DEFAULT_DAYTIME_THEME = LIGHT;
                DEFAULT_NIGHTTIME_THEME = DARK;
            } else {
                DEFAULT_DAYTIME_THEME = enabledTheme;
                DEFAULT_NIGHTTIME_THEME = enabledTheme;
            }
        }, onError);
}

// Prompt the user for their location and store the result.
//
// Must be called from a user gesture, otherwise Firefox shows no prompt at
// all (issues #59, #65).
function setGeolocation() {
    logDebug("Start setGeolocation");

    return new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            reject("Geolocation is not supported by your browser.");
            return;
        }
        navigator.geolocation.getCurrentPosition((position) => {
            setStorage({
                [GEOLOCATION_LATITUDE_KEY]: { latitude: position.coords.latitude },
                [GEOLOCATION_LONGITUDE_KEY]: { longitude: position.coords.longitude }
            }, true).then(() => resolve(position.coords), reject);
        }, (error) => {
            reject(error && error.message ? error.message : "Unable to fetch current location.");
        }, { timeout: 30000, maximumAge: 3600000 });
    });
}

function init() {
    logDebug("0 - Start init");
    debugLoad();
    debugLog("init", "startup: version " + (browser.runtime.getManifest
        ? browser.runtime.getManifest().version : "?"));

    return setStorage({
        [CHANGE_MODE_KEY]: { mode: DEFAULT_CHANGE_MODE },
        [CHECK_TIME_STARTUP_ONLY_KEY]: { check: DEFAULT_CHECK_TIME_STARTUP_ONLY },
        [DEBUG_MODE_KEY]: { check: DEFAULT_DEBUG_MODE },
        [SUNRISE_TIME_KEY]: { time: DEFAULT_SUNRISE_TIME },
        [SUNSET_TIME_KEY]: { time: DEFAULT_SUNSET_TIME },
        [APPLY_ON_FOCUS_KEY]: { check: DEFAULT_APPLY_ON_FOCUS },
        [DAY_SCHEME_KEY]: { value: DEFAULT_SCHEME },
        [NIGHT_SCHEME_KEY]: { value: DEFAULT_SCHEME }
    })
        .then(() => setDefaultThemes(), onError)
        .then(() => setStorage({
            [DAYTIME_THEME_KEY]: { themeId: DEFAULT_DAYTIME_THEME },
            [NIGHTTIME_THEME_KEY]: { themeId: DEFAULT_NIGHTTIME_THEME }
        }), onError)
        .then(() => browser.storage.local.get(SYSTEM_DARK_KEY))
        .then((obj) => {
            if (obj[SYSTEM_DARK_KEY] && typeof obj[SYSTEM_DARK_KEY].check === "boolean") {
                system_dark = obj[SYSTEM_DARK_KEY].check;
            }
        }, onError)
        .then(() => getSettings())
        .then((s) => {
            return ensureTickAlarm(s).then(() => s);
        })
        .then((s) => {
            // Leaving system-theme mode: drop any color_scheme overlay so the
            // plain theme is painted again.
            return browser.storage.local.get(LAST_MODE_KEY).then((obj) => {
                let previous = obj[LAST_MODE_KEY] ? obj[LAST_MODE_KEY].mode : null;
                if (previous === "system-theme" && s.changeMode !== "system-theme") {
                    logDebug("Left system-theme mode; clearing the theme overlay.");
                    return resetOverlay();
                }
            });
        })
        .then(() => {
            if (caps.windows) {
                browser.windows.onFocusChanged.addListener((windowId) => {
                    if (windowId !== browser.windows.WINDOW_ID_NONE) {
                        queueTick("focus");
                    }
                });
            }
            return queueTick("startup");
        })
        .catch(onError);
}

// ---------------------------------------------------------------------------
// Reacting to storage / runtime events
// ---------------------------------------------------------------------------

// Background-only wiring. The options page loads this file for the shared
// helpers, so the listeners live in a function that background.js calls.
function setupEventHandlers() {
    browser.storage.local.get(DEBUG_MODE_KEY)
        .then((obj) => {
            DEBUG_MODE = boolSetting(obj, DEBUG_MODE_KEY, DEFAULT_DEBUG_MODE);
        }, onError);

    // Firefox does not always deliver the change event for this query, but in
    // system-theme mode its value is the OS (see syncSystemDarkFromBackground),
    // so a change is believed immediately instead of waiting for a page.
    if (typeof background_scheme_query.addEventListener === "function") {
        background_scheme_query.addEventListener("change", () => {
            getSettings().then((s) => {
                if (s.changeMode !== "system-theme") {
                    return;
                }
                logDebug("Background media query changed to "
                    + (background_scheme_query.matches ? "dark" : "light"));
                recordSystemDark(background_scheme_query.matches, "media query change")
                    .then((moved) => {
                        if (moved) {
                            queueTick("os-change");
                        }
                    });
            }, onError);
        });
    }

if (browser.storage.onChanged) {
    let pending = null;

    browser.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") {
            return;
        }
        if (changes[DEBUG_MODE_KEY]) {
            DEBUG_MODE = boolSetting(changes[DEBUG_MODE_KEY].newValue
                ? { [DEBUG_MODE_KEY]: changes[DEBUG_MODE_KEY].newValue } : {},
                DEBUG_MODE_KEY, DEFAULT_DEBUG_MODE);
        }

        let relevant = Object.keys(changes).filter((key) => REACTIVE_KEYS.indexOf(key) !== -1);
        if (relevant.length === 0) {
            return;
        }

        // Coalesce a burst of writes (the options page sets several keys when
        // a setting changes) into one tick.
        if (pending) {
            clearTimeout(pending);
        }
        pending = setTimeout(() => {
            pending = null;
            if (changes[CHECK_TIME_STARTUP_ONLY_KEY]) {
                getSettings().then(ensureTickAlarm, onError);
            }
            queueTick("settings");
        }, 250);
    });
}

if (browser.runtime && browser.runtime.onMessage) {
    browser.runtime.onMessage.addListener((message) => {
        if (!message || typeof message !== "object") {
            return;
        }
        debugLog("message", message.type + (message.dark === undefined ? "" : " dark=" + message.dark)
            + (message.themeId ? " theme=" + message.themeId : ""));

        if (message.type === "autodark-scheme") {
            // Only trust content-script reports while pages actually follow
            // the OS — an explicit light/dark content override would make
            // every page report that fixed value instead.
            if (message.dark === system_dark) {
                return;
            }
            // A page only speaks for the OS while nothing pins its scheme:
            // with a literal light/dark content override every page reports
            // that fixed value, and trusting it made two themes ping-pong
            // forever (the 2.0.11 report).
            if (last_content_scheme && last_content_scheme !== "system") {
                logDebug("content script OS report ignored: pages are pinned to " + last_content_scheme);
                return Promise.resolve(true);
            }
            return handleSchemeReport(message.dark, "content script").then(() => {
                getSettings().then((s) => {
                    if (s.changeMode === "system-theme") {
                        queueTick("os-change");
                    }
                }, onError);
            });
        }

        if (message.type === "autodark-tick") {
            queueTick(message.reason || "settings");
            return Promise.resolve(true);
        }

        if (message.type === "autodark-toggle") {
            return toggleFromToolbar().then(() => true, () => false);
        }

        if (message.type === "autodark-preview") {
            return previewTheme(message.themeId).then(() => true, () => false);
        }

        // The trace lives here: this page is the only one that sees a tick.
        // Answer from storage: an event page that has just woken up has an
        // empty in-memory buffer and would report "no log at all".
        if (message.type === "autodark-debug") {
            return debugLoad()
                .then(() => browser.storage.local.get(DEBUG_LOG_KEY))
                .then((obj) => {
                    let stored = obj && obj[DEBUG_LOG_KEY] && obj[DEBUG_LOG_KEY].check;
                    let lines = Array.isArray(stored) ? stored : debugSnapshot();
                    return lines.length ? lines.join("\n") : debugText();
                });
        }
        if (message.type === "autodark-debug-clear") {
            return debugClear().then(() => true);
        }
    });
}
}

// Wired at load, outside setupEventHandlers(): a failure while reading the
// settings must not leave the toolbar button dead.
if (caps.browserAction) {
    // The click handler is registered first, unconditionally: the toolbar
    // button opening the settings is the primary interaction, the context menu
    // item is only a convenience.
    browser.browserAction.onClicked.addListener(() => {
        openSettings();
    });

    setupToolbarMenu();
}
