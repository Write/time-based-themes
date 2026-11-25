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
const LAST_MODE_KEY = KEY_PREFIX + "lastMode"; // {mode}

const TICK_ALARM_NAME = KEY_PREFIX + "tick";

// How long the options page preview keeps a candidate theme on screen before
// the schedule is restored (issue #61).
const PREVIEW_DURATION_MS = 20000;

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
const DEFAULT_SCHEME = "auto";
const SCHEME_VALUES = ["auto", "light", "dark", "system", "off"];

// Reasons a tick may run. With "change only on start-up" enabled, only the
// reasons in this set are allowed to switch anything.
const FORCED_REASONS = ["startup", "settings", "toolbar", "install"];

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
        clean.properties = {
            color_scheme: theme.properties.color_scheme,
            content_color_scheme: theme.properties.content_color_scheme
        };
    }
    return clean;
}

// Re-apply the built-in Light/Dark substitution: those themes pin the OS
// light/dark signal, which stops detection entirely.
function substituteBuiltInTheme(themeId, themeKey, s) {
    let aligned =
        (themeKey === DAYTIME_THEME_KEY && themeId === "firefox-compact-light@mozilla.org")
        || (themeKey === NIGHTTIME_THEME_KEY && themeId === "firefox-compact-dark@mozilla.org");
    if (!aligned) {
        return themeId;
    }
    if (s.changeMode === "system-theme"
        && s.dayThemeId && s.nightThemeId
        && s.dayThemeId !== s.nightThemeId) {
        logDebug("substituteBuiltInTheme - " + themeId + " pins the OS scheme; using System theme (auto).");
        return "default-theme@mozilla.org";
    }
    return themeId;
}

// ---------------------------------------------------------------------------
// Content colour scheme (issues #9, #14, #19, #30, #62)
// ---------------------------------------------------------------------------

// "auto" means: mirror the slot the theme is for (dark at night, light by
// day) in time-based modes, and follow the OS in system-theme mode.
function resolveContentScheme(scheme, slot, mode) {
    if (scheme === "off") {
        return null;
    }
    if (scheme === "system") {
        return "system";
    }
    if (scheme === "light" || scheme === "dark") {
        return scheme;
    }
    if (mode === "system-theme") {
        return "system";
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

function resetOverlay() {
    if (!caps.theme || !overlay_applied) {
        return Promise.resolve();
    }
    overlay_applied = false;
    return browser.theme.reset().catch(onError);
}

// Make sure the enabled theme follows the OS, so that the OS signal can still
// be observed (issues #11, #42, #43, #64).
function ensureColorSchemeSystem() {
    if (!caps.theme) {
        return Promise.resolve();
    }
    return browser.theme.getCurrent()
        .then((current) => {
            if (!current || !current.colors) {
                // Built-in themes and theme.update() overlays report no colors.
                // Colors surfacing later means an earlier repaint worked.
                return;
            }
            if (current.properties && current.properties.color_scheme === "system"
                && overlay_applied) {
                return;
            }

            let theme = sanitizeTheme(cloneObject(current));
            theme.properties = theme.properties || {};
            theme.properties.color_scheme = "system";
            delete theme.properties.content_color_scheme;

            return embedThemeImages(theme).then((ready) => {
                overlay_applied = true;
                return browser.theme.update(ready).then(() => {
                    logDebug("Applied color_scheme workaround.");
                });
            });
        })
        .catch(onError);
}

// Enable an installed theme if it is not already enabled. Never toggles a
// theme that is already enabled — the disable/enable churn is what used to
// flip Firefox's DRM checkbox on Linux (issue #26).
function enableInstalledTheme(themeId, mode) {
    return browser.management.get(themeId)
        .then((info) => {
            if (!info.enabled) {
                logDebug("Enabling theme " + themeId);
                return browser.management.setEnabled(themeId, true)
                    .then(() => {
                        if (mode === "system-theme") {
                            return ensureColorSchemeSystem();
                        }
                    });
            }
            logDebug(themeId + " is already enabled.");
            // Switching into system-theme mode while the right theme is
            // already enabled still needs the color_scheme workaround.
            return mode === "system-theme" ? ensureColorSchemeSystem() : undefined;
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
    return browser.theme.getCurrent()
        .then((current) => {
            if (current && current.colors) {
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
    return resetOverlay()
        .then(() => embedThemeImages(theme))
        .then((ready) => {
            overlay_applied = true;
            return browser.theme.update(ready);
        })
        .catch(onError);
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

    let resolvedId = substituteBuiltInTheme(themeId, themeKey, s || {});
    let spec = themeSpecFor(resolvedId, s || {});
    if (!spec) {
        logDebug("applyThemeId: " + resolvedId + " is not available.");
        return Promise.resolve();
    }

    if (spec.kind === "custom") {
        return applyCustomTheme(spec, mode);
    }

    let hadOverlay = overlay_applied;
    return resetOverlay()
        .then(() => enableInstalledTheme(spec.id, mode))
        .then(() => (hadOverlay ? ensurePainted(spec.id) : undefined));
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

function recordSystemDark(dark, reason) {
    if (system_dark === dark) {
        return Promise.resolve(false);
    }
    system_dark = dark;
    logDebug("System colour scheme is now " + (dark ? "dark" : "light") + " (" + reason + ")");
    return browser.storage.local.set({ [SYSTEM_DARK_KEY]: { check: dark } })
        .then(() => true, () => true);
}

// In system-theme mode the content-script reports are the reliable source for
// the OS scheme. They are unavailable on privileged pages (about:preferences,
// addons.mozilla.org) and unusable when the page scheme is pinned, so fall back
// to the background media query — it follows the browser theme since Firefox 95
// but still catches genuine OS changes in many setups.
const background_scheme_query = window.matchMedia("(prefers-color-scheme: dark)");

function syncSystemDarkFromBackground(mode) {
    if (mode !== "system-theme" || last_content_scheme === "system") {
        return;
    }
    if (background_scheme_query.matches !== system_dark) {
        recordSystemDark(background_scheme_query.matches, "background media query");
    }
}

function tick(reason) {
    logDebug("Start tick (" + reason + ")");

    return getSettings().then((s) => {
        DEBUG_MODE = s.debugMode;

        if (s.startupOnly && FORCED_REASONS.indexOf(reason) === -1) {
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

    let contentScheme = resolveContentScheme(schemeSetting, slot, mode);
    let themeKey = slot === SLOT_DAY ? DAYTIME_THEME_KEY : NIGHTTIME_THEME_KEY;

    let unchanged = last_applied.slot === slot
        && last_applied.themeId === themeId
        && last_applied.scheme === contentScheme
        && last_applied.mode === mode;

    if (unchanged && !s.applyOnFocus && FORCED_REASONS.indexOf(reason) === -1) {
        logDebug("tick: nothing to do (only switching on schedule changes).");
        return;
    }

    logDebug("tick: " + slot + " / " + themeId + " / scheme=" + contentScheme
        + " (previous " + JSON.stringify(last_applied) + ")");

    let modeChanged = last_applied.mode !== mode;
    last_applied = { slot: slot, themeId: themeId, scheme: contentScheme, mode: mode };

    return applyContentScheme(contentScheme)
        .then(() => applyThemeId(themeId, mode, themeKey, s))
        .then(() => setCurrentMode(slotLabel(slot)))
        .then(() => (modeChanged ? browser.storage.local.set({ [LAST_MODE_KEY]: { mode: mode } }) : undefined))
        .then(() => {
            updateToolbarTitle(slot);
            syncSystemDarkFromBackground(mode);
        })
        .catch(onError);
}

function queueTick(reason) {
    const result = switch_queue.then(() => tick(reason));
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
        ? "automaticDark: showing the daytime theme — click for the nighttime theme"
        : "automaticDark: showing the nighttime theme — click for the daytime theme";
    let call = browser.browserAction.setTitle({ title: text });
    if (call && call.catch) {
        call.catch(() => {});
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
            let next = desired.slot === SLOT_DAY ? "night" : "day";

            return browser.storage.local.set({
                [KEY_PREFIX + "override"]: { mode: next, slot: desired.slot }
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
    if (alarmInfo && alarmInfo.name === TICK_ALARM_NAME) {
        queueTick("alarm");
    }
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
            for (let extension of extensions) {
                if (extension.type === "theme") {
                    if (extension.enabled) {
                        DEFAULT_DAYTIME_THEME = extension.id;
                        DEFAULT_NIGHTTIME_THEME = extension.id;
                    }
                    if (extension.id === "firefox-compact-dark@mozilla.org") {
                        DEFAULT_NIGHTTIME_THEME = extension.id;
                    }
                }
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
            }).then(() => resolve(position.coords), reject);
        }, (error) => {
            reject(error && error.message ? error.message : "Unable to fetch current location.");
        }, { timeout: 30000, maximumAge: 3600000 });
    });
}

function init() {
    logDebug("0 - Start init");

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
            browser.alarms.onAlarm.addListener(alarmListener);
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

        if (message.type === "autodark-scheme") {
            // Only trust content-script reports while pages actually follow
            // the OS — an explicit light/dark content override would make
            // every page report that fixed value instead.
            if (message.dark === system_dark) {
                return;
            }
            return recordSystemDark(!!message.dark, "content script").then(() => {
                getSettings().then((s) => {
                    if (s.changeMode === "system-theme" && last_content_scheme === "system") {
                        queueTick("scheme");
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
    });
}

if (caps.browserAction) {
    browser.browserAction.onClicked.addListener(() => {
        toggleFromToolbar();
    });
}
}
