'use strict';

// ---------------------------------------------------------------------------
// Options page.
//
// Everything is written straight to storage and the background page is asked
// to re-evaluate the schedule, so a change takes effect immediately (issue #39:
// the old page asked users to restart Firefox).
// ---------------------------------------------------------------------------

const SCHEME_CHOICES = [
    ["auto", "Match the theme (light by day, dark at night)"],
    ["light", "Always light"],
    ["dark", "Always dark"],
    ["system", "Follow my operating system"],
    ["off", "Leave Firefox's setting alone"]
];

let installedThemes = [];
let themeFilter = "";
let currentSettings = null;
let saving = false;

function $(id) {
    return document.getElementById(id);
}

function on(element, event, handler) {
    if (element) {
        element.addEventListener(event, handler);
    }
}

function showMessage(id, text, isError) {
    let element = $(id);
    if (!element) {
        return;
    }
    element.textContent = text || "";
    element.className = "message" + (isError ? " error" : "");
    if (text) {
        clearTimeout(element._timer);
        element._timer = setTimeout(() => {
            element.textContent = "";
        }, 6000);
    }
}

function formatMinutesLabel(minutes) {
    if (typeof minutes !== "number" || isNaN(minutes)) {
        return "—";
    }
    return formatMinutes(((minutes % 1440) + 1440) % 1440);
}

function timezoneLabel(minutes) {
    let sign = minutes < 0 ? "-" : "+";
    let absolute = Math.abs(minutes);
    let hours = Math.floor(absolute / 60);
    let mins = absolute % 60;
    return "UTC" + sign + hours + (mins ? ":" + addLeadZero(mins) : "");
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

function themeDisplayName(theme) {
    return theme.name || theme.id;
}

// `management.getAll()` only reports the theme that is currently enabled, so a
// profile with no extra theme installed listed exactly one entry and the
// dropdowns were unusable. The three built-in themes are part of Firefox
// itself; catalogue them and merge whatever the API does return.
const BUILT_IN_THEMES = [
    {id: "default-theme@mozilla.org", name: "System theme (follows Firefox)"},
    {id: "firefox-compact-light@mozilla.org", name: "Light"},
    {id: "firefox-compact-dark@mozilla.org", name: "Dark"}
];

function loadThemes() {
    let fromApi = browser.management
        ? browser.management.getAll().then((extensions) => extensions
            .filter((extension) => extension.type === "theme"), (error) => {
            onError(error);
            return [];
        })
        : Promise.resolve([]);

    return fromApi.then((extensions) => {
        let byId = new Map(extensions.map((theme) => [theme.id, theme]));
        let merged = BUILT_IN_THEMES.map((theme) => {
            let installed = byId.get(theme.id);
            byId.delete(theme.id);
            return {id: theme.id, name: (installed && installed.name) || theme.name};
        });
        let others = Array.from(byId.values())
            .filter((theme) => BUILT_IN_THEME_IDS.indexOf(theme.id) === -1)
            .sort((a, b) => themeDisplayName(a).localeCompare(themeDisplayName(b)));
        installedThemes = merged.concat(others);
        return installedThemes;
    });
}

// Themes matching the filter box (issue #60: the list of installed themes
// grows fast and there was no way to search it).
function visibleThemes() {
    if (!themeFilter) {
        return installedThemes;
    }
    let needle = themeFilter.toLowerCase();
    return installedThemes.filter((theme) => {
        return themeDisplayName(theme).toLowerCase().indexOf(needle) !== -1
            || theme.id.toLowerCase().indexOf(needle) !== -1;
    });
}

function fillThemeSelect(select, selectedId, customValue, customLabel) {
    if (!select) {
        return;
    }
    select.textContent = "";

    let themes = visibleThemes();
    let ids = installedThemes.map((theme) => theme.id);

    // Never hide the theme that is currently selected.
    if (selectedId && ids.indexOf(selectedId) !== -1
        && themes.every((theme) => theme.id !== selectedId)) {
        themes = installedThemes.filter((theme) => theme.id === selectedId).concat(themes);
    }
    let unknown = selectedId && ids.indexOf(selectedId) === -1
        && selectedId !== customValue;

    if (unknown) {
        let option = document.createElement("option");
        option.value = selectedId;
        option.textContent = selectedId + " (not installed)";
        select.appendChild(option);
    }

    themes.forEach((theme) => {
        let option = document.createElement("option");
        option.value = theme.id;
        option.textContent = themeDisplayName(theme)
            + (BUILT_IN_THEME_IDS.indexOf(theme.id) !== -1 ? " (built-in)" : "");
        select.appendChild(option);
    });

    if (customValue) {
        let option = document.createElement("option");
        option.value = customValue;
        option.textContent = customLabel;
        select.appendChild(option);
    }

    if (selectedId) {
        select.value = selectedId;
    } else if (select.options.length) {
        select.selectedIndex = 0;
    }
}

function fillAllThemeSelects(s) {
    fillThemeSelect($("daytime-theme-list"), s.dayThemeId,
        s.customDayTheme ? CUSTOM_DAY : null, "Custom daytime theme (advanced)");
    fillThemeSelect($("nighttime-theme-list"), s.nightThemeId,
        s.customNightTheme ? CUSTOM_NIGHT : null, "Custom nighttime theme (advanced)");

    renderExtraSlots(s);
    renderRandomPool(s);
    if ($("theme-filter") && $("theme-filter").value.trim() !== themeFilter) {
        themeFilter = $("theme-filter").value.trim();
    }
}

function renderRandomPool(s) {
    let container = $("random-pool");
    if (!container) {
        return;
    }
    container.textContent = "";

    if (!installedThemes.length) {
        container.textContent = "No themes found.";
        return;
    }

    installedThemes.forEach((theme) => {
        let label = document.createElement("label");
        label.className = "pool-item";

        let checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = theme.id;
        checkbox.checked = s.randomPool.indexOf(theme.id) !== -1;
        checkbox.addEventListener("change", () => {
            saveRandomPool();
        });

        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(" " + themeDisplayName(theme)));
        container.appendChild(label);
    });
}

// ---------------------------------------------------------------------------
// Extra time slots
// ---------------------------------------------------------------------------

function renderExtraSlots(s) {
    let container = $("extra-slots");
    if (!container) {
        return;
    }
    container.textContent = "";

    let slots = (s.extras || []).slice().sort((a, b) => {
        return parseTimeToMinutes(a.time) - parseTimeToMinutes(b.time);
    });

    if (!slots.length) {
        let empty = document.createElement("p");
        empty.className = "hint";
        empty.textContent = "No extra slots.";
        container.appendChild(empty);
        return;
    }

    slots.forEach((slot) => {
        let row = document.createElement("div");
        row.className = "slot";

        let start = document.createElement("label");
        start.textContent = "From";
        row.appendChild(start);

        let timeInput = document.createElement("input");
        timeInput.type = "time";
        timeInput.value = slot.time || "21:00";
        timeInput.addEventListener("change", () => {
            updateSlot(slot.id, {time: timeInput.value});
        });
        row.appendChild(timeInput);

        let themeLabel = document.createElement("label");
        themeLabel.textContent = "use";
        row.appendChild(themeLabel);

        let select = document.createElement("select");
        installedThemes.forEach((theme) => {
            let option = document.createElement("option");
            option.value = theme.id;
            option.textContent = themeDisplayName(theme);
            select.appendChild(option);
        });
        if (slot.themeId && installedThemes.every((t) => t.id !== slot.themeId)) {
            let option = document.createElement("option");
            option.value = slot.themeId;
            option.textContent = slot.themeId + " (not installed)";
            select.appendChild(option);
        }
        select.value = slot.themeId || "";
        select.addEventListener("change", () => {
            updateSlot(slot.id, {themeId: select.value});
        });
        row.appendChild(select);

        let schemeLabel = document.createElement("label");
        schemeLabel.textContent = "web pages";
        row.appendChild(schemeLabel);

        let schemeSelect = document.createElement("select");
        SCHEME_CHOICES.forEach(([value, text]) => {
            let option = document.createElement("option");
            option.value = value;
            option.textContent = value === "auto" ? "match the theme" : text;
            schemeSelect.appendChild(option);
        });
        schemeSelect.value = slot.scheme || "auto";
        schemeSelect.addEventListener("change", () => {
            updateSlot(slot.id, {scheme: schemeSelect.value});
        });
        row.appendChild(schemeSelect);

        let remove = document.createElement("button");
        remove.type = "button";
        remove.className = "link";
        remove.textContent = "Remove";
        remove.addEventListener("click", () => {
            let remaining = (currentSettings.extras || []).filter((x) => x.id !== slot.id);
            persist({[EXTRA_SLOTS_KEY]: {slots: remaining}});
        });
        row.appendChild(remove);

        container.appendChild(row);
    });
}

function updateSlot(id, patch) {
    let slots = (currentSettings.extras || []).map((slot) => {
        if (slot.id !== id) {
            return slot;
        }
        let updated = Object.assign({}, slot, patch);
        return updated;
    });
    persist({[EXTRA_SLOTS_KEY]: {slots: slots}});
}

function addSlot() {
    let slots = (currentSettings.extras || []).slice();
    slots.push({
        id: "slot-" + Date.now(),
        time: "21:00",
        themeId: currentSettings.nightThemeId || (installedThemes[0] && installedThemes[0].id) || "",
        scheme: "auto"
    });
    persist({[EXTRA_SLOTS_KEY]: {slots: slots}});
}

// ---------------------------------------------------------------------------
// Persisting
// ---------------------------------------------------------------------------

// There is no Save button: every control persists on its change event. Say so
// visibly, otherwise the page looks like it silently swallows edits (#28).
let flashTimer = 0;

function flashSaved() {
    let line = $("save-state");
    if (!line) {
        return;
    }
    line.textContent = "Saved \u2713 \u2014 every change is stored automatically.";
    line.classList.add("saved");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
        line.textContent = "Every change is saved automatically as soon as you leave the field.";
        line.classList.remove("saved");
    }, 2500);
}

function persist(values) {
    saving = true;
    // overrideDefault is mandatory here: setStorage() only fills *missing* keys,
    // which is right for the start-up defaults but meant every edit made in this
    // page was silently dropped once init() had created the key.
    return setStorage(values, true)
        .then(() => getSettings())
        .then((s) => {
            currentSettings = s;
            updateSuntimesInfo(s);
            updateStatus(s);
            return browser.runtime.sendMessage({type: "autodark-tick", reason: "settings"});
        })
        .catch(onError)
        .then(() => {
            saving = false;
            flashSaved();
        });
}

function saveRandomPool() {
    let container = $("random-pool");
    if (!container) {
        return;
    }
    let ids = Array.prototype.slice.call(container.querySelectorAll("input:checked"))
        .map((input) => input.value);
    persist({[RANDOM_POOL_KEY]: {ids: ids}});
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

function describeNextChange(s) {
    if (s.changeMode === "system-theme") {
        return "The theme follows your operating system's light/dark setting.";
    }

    let timesPromise = s.changeMode === "location-suntimes"
        ? calculateSuntimes(s)
        : Promise.resolve(manualSuntimes(s));

    return timesPromise.then((raw) => {
        let times = s.changeMode === "location-suntimes" ? applyOffsets(raw, s) : raw;
        let config = buildSlotConfig(s, times);
        let now = Date.now();
        let slot = computeSlot(config, now).slot;
        let label = slot === SLOT_DAY ? "daytime theme" : "nighttime theme";

        if (s.startupOnly) {
            return "Showing the " + label + ". Automatic switching is off (start-up only).";
        }

        // Minute-by-minute scan for the next boundary; a day is at most 1440
        // iterations and this only runs when the page is open.
        for (let minute = 1; minute <= 1440; minute++) {
            let when = now + minute * 60000;
            let next = computeSlot(config, when).slot;
            if (next !== slot) {
                let at = new Date(when);
                let hhmm = addLeadZero(at.getHours()) + ":" + addLeadZero(at.getMinutes());
                return "Showing the " + label + ". Next change at " + hhmm + ".";
            }
        }
        return "Showing the " + label + ".";
    }, () => "Showing the " + (computeSlot(buildSlotConfig(s, manualSuntimes(s)), Date.now()).slot));
}

function updateStatus(s) {
    let element = $("status");
    if (!element) {
        return;
    }
    let promise = describeNextChange(s);
    Promise.resolve(promise).then((text) => {
        element.textContent = text;
    }, () => {
        element.textContent = "";
    });
}

function updateSuntimesInfo(s) {
    let element = $("suntimes-info");
    if (!element) {
        return;
    }
    if (s.changeMode !== "location-suntimes") {
        element.textContent = "";
        return;
    }
    if (!locationFor(s)) {
        element.textContent = "";
        showLocationWarning(true);
        return;
    }
    showLocationWarning(false);
    calculateSuntimes(s).then((times) => {
        if (times.sunriseMin === null || times.sunsetMin === null) {
            element.textContent = times.polarDay === null
                ? "Sunrise and sunset cannot be computed for these coordinates."
                : (times.polarDay
                    ? "The sun does not set today at this location."
                    : "The sun does not rise today at this location.");
            return;
        }
        element.textContent = "Today: sunrise "
            + formatMinutesLabel(times.sunriseMin + (s.sunriseOffset || 0))
            + ", sunset "
            + formatMinutesLabel(times.sunsetMin + (s.sunsetOffset || 0))
            + ".";
    }, (error) => {
        onError(error);
    });
}

function showLocationWarning(show) {
    let warning = $("location-warning");
    if (!warning) {
        return;
    }
    let useRadio = $("mode-location");
    let visible = show && useRadio && useRadio.checked;
    warning.className = "warning" + (visible ? "" : " hidden");
}

// ---------------------------------------------------------------------------
// Filling the form
// ---------------------------------------------------------------------------

function fillForm(s) {
    currentSettings = s;

    $("mode-location").checked = s.changeMode === "location-suntimes";
    $("mode-manual").checked = s.changeMode === "manual-suntimes";
    $("mode-system").checked = s.changeMode === "system-theme";

    $("sunrise-time").value = s.sunriseTime;
    $("sunset-time").value = s.sunsetTime;
    $("sunrise-offset").value = s.sunriseOffset || 0;
    $("sunset-offset").value = s.sunsetOffset || 0;

    $("manual-latitude").value = typeof s.manualLatitude === "number" ? s.manualLatitude : "";
    $("manual-longitude").value = typeof s.manualLongitude === "number" ? s.manualLongitude : "";
    $("use-manual-location").checked = !!s.useManualLocation;

    fillTimezoneSelect(s);
    fillAllThemeSelects(s);
    let info = $("build-info");
    if (info) {
        info.textContent = installedThemes.length + " theme"
            + (installedThemes.length === 1 ? "" : "s") + " available";
    }

    $("random-interval").value = s.randomInterval || 0;
    $("day-scheme").value = s.dayScheme;
    $("night-scheme").value = s.nightScheme;
    $("site-overrides").value = s.siteOverrides || "";

    $("check-startup-only").checked = !!s.startupOnly;
    $("apply-on-focus").checked = !!s.applyOnFocus;
    $("debug-mode").checked = !!s.debugMode;

    $("custom-day-json").value = s.customDayTheme ? JSON.stringify(s.customDayTheme, null, 2) : "";
    $("custom-night-json").value = s.customNightTheme ? JSON.stringify(s.customNightTheme, null, 2) : "";

    document.body.className = "mode-" + s.changeMode;
    showLocationWarning(!locationFor(s));
    updateSuntimesInfo(s);
    updateStatus(s);
}

function fillTimezoneSelect(s) {
    let select = $("timezone-offset");
    if (!select) {
        return;
    }
    if (!select.options.length) {
        let auto = document.createElement("option");
        auto.value = "auto";
        auto.textContent = "Use this computer's time zone";
        select.appendChild(auto);

        for (let minutes = -12 * 60; minutes <= 14 * 60; minutes += 30) {
            let option = document.createElement("option");
            option.value = String(minutes);
            option.textContent = timezoneLabel(minutes);
            select.appendChild(option);
        }
    }
    select.value = typeof s.timezoneOffset === "number" ? String(s.timezoneOffset) : "auto";
}

function fillSchemeSelects() {
    [["day-scheme"], ["night-scheme"]].forEach(([id]) => {
        let select = $(id);
        if (!select) {
            return;
        }
        select.textContent = "";
        SCHEME_CHOICES.forEach(([value, text]) => {
            let option = document.createElement("option");
            option.value = value;
            option.textContent = text;
            select.appendChild(option);
        });
    });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function wireModeRadios() {
    ["mode-location", "mode-manual", "mode-system"].forEach((id) => {
        on($(id), "change", (event) => {
            if (!event.target.checked) {
                return;
            }
            persist({[CHANGE_MODE_KEY]: {mode: event.target.value}});
        });
    });
}

function wireTimes() {
    on($("sunrise-time"), "change", (event) => {
        persist({[SUNRISE_TIME_KEY]: {time: event.target.value}});
    });
    on($("sunset-time"), "change", (event) => {
        persist({[SUNSET_TIME_KEY]: {time: event.target.value}});
    });
    on($("sunrise-offset"), "change", (event) => {
        persist({[SUNRISE_OFFSET_KEY]: {minutes: Number(event.target.value) || 0}});
    });
    on($("sunset-offset"), "change", (event) => {
        persist({[SUNSET_OFFSET_KEY]: {minutes: Number(event.target.value) || 0}});
    });
    on($("timezone-offset"), "change", (event) => {
        let value = event.target.value;
        persist({[TIMEZONE_OFFSET_KEY]: {minutes: value === "auto" ? null : Number(value)}});
    });
}

function wireLocation() {
    // Same override as the toolbar menu item, for people who never right-click
    // (issues #24, #36).
    on($("toggle-now"), "click", () => {
        browser.runtime.sendMessage({type: "autodark-toggle"})
            .then(() => showMessage("toggle-message", "Theme switched."))
            .catch(onError);
    });

    on($("locate-btn"), "click", () => {
        showMessage("locate-message", "Asking Firefox for your location…");
        setGeolocation().then(() => {
            showMessage("locate-message", "Location saved.");
            return getSettings().then(fillForm);
        }).catch((error) => {
            showMessage("locate-message", String(error), true);
        });
    });

    on($("manual-latitude"), "change", saveManualCoordinates);
    on($("manual-longitude"), "change", saveManualCoordinates);
    on($("use-manual-location"), "change", (event) => {
        persist({[USE_MANUAL_LOCATION_KEY]: {check: event.target.checked}});
    });
}

function saveManualCoordinates() {
    let latitude = Number($("manual-latitude").value);
    let longitude = Number($("manual-longitude").value);

    if ($("manual-latitude").value === "" || $("manual-longitude").value === "") {
        persist({
            [MANUAL_LATITUDE_KEY]: {value: null},
            [MANUAL_LONGITUDE_KEY]: {value: null}
        });
        return;
    }
    if (isNaN(latitude) || isNaN(longitude)
        || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
        showMessage("locate-message", "Latitude must be -90…90 and longitude -180…180.", true);
        return;
    }
    persist({
        [MANUAL_LATITUDE_KEY]: {value: latitude},
        [MANUAL_LONGITUDE_KEY]: {value: longitude}
    });
}

function wireThemes() {
    on($("daytime-theme-list"), "change", (event) => {
        persist({[DAYTIME_THEME_KEY]: {themeId: event.target.value}});
    });
    on($("nighttime-theme-list"), "change", (event) => {
        persist({[NIGHTTIME_THEME_KEY]: {themeId: event.target.value}});
    });

    Array.prototype.forEach.call(document.querySelectorAll("button.preview"), (button) => {
        button.addEventListener("click", () => {
            let select = $(button.getAttribute("data-target"));
            if (!select) {
                return;
            }
            browser.runtime.sendMessage({type: "autodark-preview", themeId: select.value})
                .then(() => showMessage("locate-message", ""))
                .catch(onError);
        });
    });

    on($("theme-filter"), "input", (event) => {
        themeFilter = event.target.value.trim();
        if (currentSettings) {
            fillAllThemeSelects(currentSettings);
        }
    });
    on($("add-slot"), "click", addSlot);
    on($("random-interval"), "change", (event) => {
        let hours = Number(event.target.value);
        persist({[RANDOM_INTERVAL_KEY]: {hours: isNaN(hours) || hours < 0 ? 0 : hours}});
    });
}

function wireScheme() {
    on($("day-scheme"), "change", (event) => {
        persist({[DAY_SCHEME_KEY]: {value: event.target.value}});
    });
    on($("night-scheme"), "change", (event) => {
        persist({[NIGHT_SCHEME_KEY]: {value: event.target.value}});
    });
    on($("site-overrides"), "change", (event) => {
        persist({[SITE_OVERRIDES_KEY]: {text: event.target.value}});
    });
}

function wireBehaviour() {
    on($("check-startup-only"), "change", (event) => {
        persist({[CHECK_TIME_STARTUP_ONLY_KEY]: {check: event.target.checked}});
    });
    on($("apply-on-focus"), "change", (event) => {
        persist({[APPLY_ON_FOCUS_KEY]: {check: event.target.checked}});
    });
    on($("debug-mode"), "change", (event) => {
        persist({[DEBUG_MODE_KEY]: {check: event.target.checked}});
    });
    on($("reset-default-btn"), "click", () => {
        browser.storage.local.clear().then(() => {
            return getSettings();
        }).then((s) => {
            // Re-apply the defaults immediately rather than asking for a
            // restart (issue #39).
            return browser.runtime.sendMessage({type: "autodark-tick", reason: "settings"})
                .catch(() => {})
                .then(() => loadThemes())
                .then(() => fillForm(s));
        }).then(() => {
            showMessage("reset-message", "Defaults restored.");
        }).catch(onError);
    });
}

function parseCustomTheme(text) {
    if (!text || !text.trim()) {
        return null;
    }
    let parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") {
        throw new Error("The theme must be a JSON object.");
    }
    if (parsed.theme && typeof parsed.theme === "object") {
        parsed = parsed.theme;
    }
    if (!parsed.colors && !parsed.images) {
        throw new Error("A theme needs at least a \"colors\" or an \"images\" member.");
    }
    return parsed;
}

function wireCustomThemes() {
    [["validate-day", "custom-day-json", CUSTOM_DAY_THEME_KEY, "Daytime"],
     ["validate-night", "custom-night-json", CUSTOM_NIGHT_THEME_KEY, "Nighttime"]]
        .forEach(([buttonId, textareaId, storageKey, label]) => {
            on($(buttonId), "click", () => {
                let theme;
                try {
                    theme = parseCustomTheme($(textareaId).value);
                } catch (error) {
                    showMessage("custom-message", label + ": " + error.message, true);
                    return;
                }
                persist({[storageKey]: {json: theme}}).then(() => {
                    showMessage("custom-message", label + " theme saved.");
                    if (theme) {
                        return browser.runtime.sendMessage({
                            type: "autodark-preview",
                            themeId: storageKey === CUSTOM_DAY_THEME_KEY ? CUSTOM_DAY : CUSTOM_NIGHT
                        }).catch(() => {});
                    }
                });
            });
        });
}

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

// "Which version am I actually running?" was an unanswerable question while
// chasing the reload bugs: print it.
// Everything needed to answer "why did the theme not follow the OS?" without a
// round trip: what the extension thinks the OS is, what it last applied, and
// what the browser reports right now.
function renderDiagnostics() {
    let node = $("diagnostics");
    if (!node) {
        return;
    }
    let lines = [];
    lines.push("version: " + browser.runtime.getManifest().version);

    let calls = [
        browser.storage.local.get(null).catch((e) => ({error: String(e)})),
        browser.theme && browser.theme.getCurrent
            ? browser.theme.getCurrent().catch((e) => ({error: String(e)}))
            : Promise.resolve(null),
        browser.browserSettings && browser.browserSettings.overrideContentColorScheme
            ? browser.browserSettings.overrideContentColorScheme.get({})
                .catch((e) => ({error: String(e)}))
            : Promise.resolve(null),
        browser.management && browser.management.getAll
            ? browser.management.getAll().catch(() => [])
            : Promise.resolve([])
    ];

    Promise.all(calls).then(([storage, current, override, extensions]) => {
        lines.push("media query (prefers-color-scheme: dark): "
            + (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
        lines.push("changeMode: " + JSON.stringify(storage["autodarkchangeMode"]));
        lines.push("systemDark stored: " + JSON.stringify(storage["autodarksystemDark"]));
        lines.push("currentMode: " + JSON.stringify(storage["autodarkcurrentMode"]));
        lines.push("lastMode: " + JSON.stringify(storage["autodarklastMode"]));
        lines.push("dayTheme: " + JSON.stringify(storage["autodarkdaytimeTheme"]));
        lines.push("nightTheme: " + JSON.stringify(storage["autodarknighttimeTheme"]));
        lines.push("dayScheme: " + JSON.stringify(storage["autodarkdayScheme"]));
        lines.push("nightScheme: " + JSON.stringify(storage["autodarknightScheme"]));
        lines.push("startupOnly: " + JSON.stringify(storage["autodarkstartupOnly"]));
        lines.push("overrideContentColorScheme: "
            + JSON.stringify(override && (override.value || override.error)));
        let scheme = current && current.properties && current.properties.color_scheme;
        lines.push("theme.getCurrent color_scheme: " + JSON.stringify(scheme || null));
        let enabled = (extensions || []).filter((e) => e.type === "theme" && e.enabled)
            .map((e) => e.name + " <" + e.id + ">");
        lines.push("enabled themes: " + (enabled.join(", ") || "none reported"));
        let events = storage["autodarkevents"];
        lines.push("recent events (newest last):");
        ((events && events.check) || []).slice(-15).forEach((event) => {
            lines.push("  " + event.t + "  " + event.kind + "  " + event.detail);
        });
        node.textContent = lines.join("\n");
    }, (error) => {
        node.textContent = "diagnostics failed: " + error;
    });
}

function showVersion() {
    let node = $("app-version");
    if (!node) {
        return;
    }
    let manifest = browser.runtime && browser.runtime.getManifest
        ? browser.runtime.getManifest() : null;
    node.textContent = manifest && manifest.version ? "v" + manifest.version : "";
}

function start() {
    fillSchemeSelects();
    wireModeRadios();
    wireTimes();
    wireLocation();
    wireThemes();
    wireScheme();
    wireBehaviour();
    wireCustomThemes();
    showVersion();
    renderDiagnostics();
    on($("force-tick"), "click", () => {
        browser.runtime.sendMessage({type: "autodark-tick", reason: "settings"})
            .then(() => showMessage("force-message", "tick requested"))
            .then(() => setTimeout(renderDiagnostics, 800))
            .catch(onError);
    });

    loadThemes()
        .then(() => getSettings())
        .then((s) => {
            fillForm(s);
        })
        .catch(onError);

    // Keep the status line fresh while the page is open.
    setInterval(() => {
        if (currentSettings && !saving) {
            updateStatus(currentSettings);
        }
    }, 30000);
}

// A field being edited when the tab closes never fires its change event, so a
// freshly typed coordinate used to be lost. Commit everything on the way out.
window.addEventListener("pagehide", () => {
    document.querySelectorAll("input, select, textarea").forEach((element) => {
        if (element.type === "checkbox" || element.type === "radio") {
            return;
        }
        element.dispatchEvent(new Event("change"));
    });
});

start();
