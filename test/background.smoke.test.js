'use strict';

// Smoke test for the background page: loads the real scripts against a fake
// `browser` API and checks that a tick enables the expected theme.
//
// It is not a unit test of the browser integration — it exists to catch
// reference errors and typos in code paths that unit tests cannot reach
// (theme application, the color_scheme workaround, message handling).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const FILES = ["js/utils.js", "js/schedule.js", "lib/suncalc.js", "js/common.js"];

function makeStorage() {
    let data = {};
    let listeners = [];
    return {
        data: data,
        listeners: listeners,
        api: {
            get(keys) {
                if (keys === null || keys === undefined) {
                    return Promise.resolve(Object.assign({}, data));
                }
                if (typeof keys === "string") {
                    return Promise.resolve(keys in data ? {[keys]: data[keys]} : {});
                }
                if (Array.isArray(keys)) {
                    let out = {};
                    keys.forEach((key) => {
                        if (key in data) {
                            out[key] = data[key];
                        }
                    });
                    return Promise.resolve(out);
                }
                let out = {};
                Object.keys(keys).forEach((key) => {
                    out[key] = key in data ? data[key] : keys[key];
                });
                return Promise.resolve(out);
            },
            set(values) {
                let changes = {};
                Object.keys(values).forEach((key) => {
                    changes[key] = {oldValue: data[key], newValue: values[key]};
                    data[key] = values[key];
                });
                listeners.forEach((listener) => listener(changes, "local"));
                return Promise.resolve();
            },
            remove(key) {
                delete data[key];
                return Promise.resolve();
            },
            clear() {
                Object.keys(data).forEach((key) => delete data[key]);
                return Promise.resolve();
            }
        },
        onChanged: {
            addListener(listener) {
                listeners.push(listener);
            }
        }
    };
}

function run(options) {
    options = options || {};
    let storage = makeStorage();
    let calls = {
        setEnabled: [],
        themeUpdate: [],
        themeReset: 0,
        overrides: [],
        title: [],
        alarms: {},
        getCurrentCount: 0,
        actionClicks: [],
        menus: [],
        menuCreated: [],
        messageListeners: [],
        openOptions: 0,
        setMediaDark(value, fire) {
            media.matches = !!value;
            if (fire !== false) {
                media.listeners.slice().forEach((fn) => fn());
            }
        }
    };

    let enabledThemes = {};
    // The OS scheme as the browser reports it to media queries. Tests move it
    // with calls.setMediaDark() to simulate a real system appearance switch.
    let media = {matches: !!options.mediaDark, listeners: []};

    const browser = {
        storage: {local: storage.api, onChanged: storage.onChanged},
        alarms: {
            get: () => Promise.resolve(calls.alarms.created ? {name: "autodark-tick"} : null),
            create: (name) => {
                calls.alarms.created = name;
            },
            clear: () => Promise.resolve(true),
            onAlarm: {
                addListener(fn) {
                    calls.alarmListeners = (calls.alarmListeners || []).concat(fn);
                }
            }
        },
        management: {
            getAll: () => Promise.resolve([
                {id: "default-theme@mozilla.org", name: "System theme — auto", type: "theme",
                    enabled: enabledThemes["default-theme@mozilla.org"] === true},
                {id: "firefox-compact-light@mozilla.org", name: "Light", type: "theme",
                    enabled: enabledThemes["firefox-compact-light@mozilla.org"] === true},
                {id: "firefox-compact-dark@mozilla.org", name: "Dark", type: "theme",
                    enabled: enabledThemes["firefox-compact-dark@mozilla.org"] === true},
                {id: "my-day@x", name: "Day", type: "theme",
                    enabled: enabledThemes["my-day@x"] === true},
                {id: "my-night@x", name: "Night", type: "theme",
                    enabled: enabledThemes["my-night@x"] === true},
                {id: "some-addon@x", name: "Add-on", type: "extension", enabled: true}
            ]),
            get: (id) => Promise.resolve({id: id, enabled: enabledThemes[id] === true}),
            setEnabled: (id, enabled) => {
                calls.setEnabled.push([id, enabled]);
                if (options.hangSetEnabled) {
                    // A browser call that never settles: this is what used to
                    // freeze the whole switch queue for the rest of the session.
                    return new Promise(() => {});
                }
                if (enabled) {
                    // Firefox keeps a single theme enabled: activating one
                    // deactivates the others.
                    Object.keys(enabledThemes).forEach((other) => {
                        enabledThemes[other] = other === id;
                    });
                }
                enabledThemes[id] = enabled;
                return Promise.resolve();
            }
        },
        theme: {
            getCurrent() {
                calls.getCurrentCount++;
                if (typeof options.getCurrent === "function") {
                    return Promise.resolve(options.getCurrent(calls.getCurrentCount));
                }
                return Promise.resolve(options.themeCurrent || {
                    colors: {frame: "#1c1b22", toolbar: "#1c1b22"},
                    images: {theme_ntp_background: "moz-extension://abc/ntp.png"},
                    properties: {color_scheme: "dark"}
                });
            },
            update(theme) {
                calls.themeUpdate.push(theme);
                return Promise.resolve();
            },
            reset() {
                calls.themeReset++;
                return Promise.resolve();
            }
        },
        browserSettings: {
            overrideContentColorScheme: {
                set({value}) {
                    calls.overrides.push(value);
                    return Promise.resolve();
                }
            }
        },
        browserAction: {
            onClicked: {
                addListener(fn) {
                    calls.actionClicks.push(fn);
                }
            },
            setTitle(details) {
                calls.title.push(details.title);
                return Promise.resolve();
            }
        },
        menus: {
            create(details) {
                calls.menuCreated.push(details);
                if (options.menusThrow) {
                    // Firefox MV2 rejects the Chrome/MV3 context spelling.
                    throw new Error("Invalid value for argument 1: contexts");
                }
                return Promise.resolve(details.id);
            },
            onClicked: {
                addListener(fn) {
                    calls.menus.push(fn);
                }
            }
        },
        windows: {
            WINDOW_ID_NONE: -1,
            onFocusChanged: {addListener() {}}
        },
        runtime: {
            onMessage: {
                addListener(fn) {
                    calls.messageListeners.push(fn);
                }
            },
            onInstalled: {addListener() {}},
            openOptionsPage() {
                calls.openOptions++;
            },
            sendMessage: () => Promise.resolve(true)
        },
        idle: {onStateChanged: {addListener() {}}}
    };

    class FileReaderStub {
        readAsDataURL() {
            this.result = "data:image/png;base64,AAAA";
            if (this.onloadend) {
                this.onloadend();
            }
        }
    }

    const sandbox = {
        browser: browser,
        console: console,
        // Real timers, but every delay is clamped: the preview restore in
        // previewTheme() then becomes observable in milliseconds.
        setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 5)),
        // Real-clock deadline for withTimeout(): not clamped to the fake clock,
        // and unref'd so it never keeps the test runner alive.
        __scheduleDeadline: (fn, ms) => {
            let timer = setTimeout(fn, ms);
            if (timer && typeof timer.unref === "function") {
                timer.unref();
            }
            return timer;
        },
        clearTimeout: clearTimeout,
        Promise: Promise,
        Date: Date,
        Math: Math,
        JSON: JSON,
        Object: Object,
        Array: Array,
        Number: Number,
        String: String,
        isNaN: isNaN,
        fetch: (url) => Promise.resolve({
            ok: true,
            status: 200,
            blob: () => Promise.resolve({type: "image/png", size: 1, url: url})
        }),
        FileReader: FileReaderStub,
        window: {
            matchMedia: () => ({
                get matches() {
                    return media.matches;
                },
                addEventListener(kind, fn) {
                    media.listeners.push(fn);
                },
                addListener(fn) {
                    media.listeners.push(fn);
                }
            })
        },
        URL: URL,
        navigator: {}
    };
    vm.createContext(sandbox);
    // The harness clamps setTimeout to 5ms so retry loops finish fast; that also
    // arms the withTimeout() deadline immediately, so it is parked far away here
    // and only the timeout tests bring it back.


    // One script: the background page shares a single global lexical scope
    // between its classic scripts, so the files are concatenated.
    const source = FILES
        .map((file) => fs.readFileSync(path.join(ROOT, file), "utf8"))
        .join("\n;\n");
    vm.runInContext(source, sandbox, {filename: "background-bundle.js"});

    // The harness clamps setTimeout to 5ms so retry loops finish fast; park the
    // withTimeout() deadline far away, the timeout tests bring it back.
    sandbox.__with_timeout_ms = 60000;

    return {sandbox: sandbox, storage: storage, calls: calls, enabledThemes: enabledThemes};
}

test("background page boots and applies the daytime theme", async () => {
    const {sandbox, storage, calls} = run();

    // A fixed local noon, expressed in minutes so the test is timezone-proof.
    const noonMs = Date.now() - (Date.now() % 86400000);
    sandbox.__fixedNow = noonMs + 12 * 3600000;
    vm.runInContext("Date.now = () => __fixedNow;", sandbox);

    await storage.api.set({
        "autodarkchangeMode": {mode: "manual-suntimes"},
        "autodarkdaytimeTheme": {themeId: "my-day@x"},
        "autodarknighttimeTheme": {themeId: "my-night@x"},
        "autodarksunriseTime": {time: "08:00"},
        "autodarksunsetTime": {time: "20:00"},
        "autodarkdayScheme": {value: "auto"},
        "autodarknightScheme": {value: "auto"}
    });

    await vm.runInContext("init().then(() => switch_queue)", sandbox);

    assert.ok(calls.setEnabled.some(([id, on]) => id === "my-day@x" && on === true),
        "daytime theme should be enabled at noon");
    assert.ok(!calls.setEnabled.some(([id, on]) => id === "my-night@x" && on === true),
        "nighttime theme should not be enabled at noon");
    assert.deepStrictEqual(calls.overrides, ["light"],
        "web pages should be told to render light during the day");
    assert.ok(calls.alarms.created, "the minutely alarm should be created");
    assert.strictEqual(calls.themeReset, 0, "nothing to reset on a cold start");
});

test("a tick at night switches to the nighttime theme once", async () => {
    const {sandbox, storage, calls} = run();
    const noonMs = Date.now() - (Date.now() % 86400000);

    await storage.api.set({
        "autodarkchangeMode": {mode: "manual-suntimes"},
        "autodarkdaytimeTheme": {themeId: "my-day@x"},
        "autodarknighttimeTheme": {themeId: "my-night@x"},
        "autodarksunriseTime": {time: "08:00"},
        "autodarksunsetTime": {time: "20:00"},
        "autodarkdayScheme": {value: "auto"},
        "autodarknightScheme": {value: "auto"}
    });

    vm.runInContext("__fixedNow = " + (noonMs + 12 * 3600000) + "; Date.now = () => __fixedNow;", sandbox);
    await vm.runInContext("init().then(() => switch_queue)", sandbox);

    vm.runInContext("__fixedNow = " + (noonMs + 23 * 3600000) + ";", sandbox);
    await vm.runInContext("queueTick('alarm')", sandbox);

    assert.strictEqual(calls.setEnabled.filter(([id]) => id === "my-night@x").length, 1);

    // A second tick with nothing to change must not touch the theme again —
    // the enable/disable churn is what broke the DRM setting (issue #26).
    await vm.runInContext("queueTick('alarm')", sandbox);
    assert.strictEqual(calls.setEnabled.filter(([id]) => id === "my-night@x").length, 1,
        "the same theme must not be re-enabled on every tick");

    assert.deepStrictEqual(calls.overrides.slice(-1), ["dark"]);
});

test("a never-settling browser call fails instead of freezing the queue", async () => {
    const {sandbox, storage, calls} = run({hangSetEnabled: true});
    await systemSettings(storage);
    sandbox.__with_timeout_ms = 15;

    await vm.runInContext("init()", sandbox);
    assert.strictEqual(calls.themeUpdate.length, 0, "nothing was painted");

    // The tick gave up, and - the point of the deadline - the queue is free:
    // a later tick still works instead of waiting forever.
    await vm.runInContext("queueTick('toolbar').catch((e) => e.message)", sandbox);
    assert.ok(calls.setEnabled.length >= 2, "the next tick ran instead of hanging behind it");
});

// A deadline is only useful if the caller sees it: preview and toolbar clicks
// used to wait on a promise that never settled, so the UI silently did nothing.
test("withTimeout rejects with the stuck call's name", async () => {
    const {sandbox} = run();
    sandbox.__with_timeout_ms = 15;
    const message = await vm.runInContext(
        "withTimeout(new Promise(() => {}), 'theme.update').then(() => 'resolved', (e) => e.message)",
        sandbox);
    assert.strictEqual(message, "timeout after 15ms: theme.update");
});


test("an explicit light scheme wins during the night", async () => {
    const {sandbox, storage, calls} = run();
    const noonMs = Date.now() - (Date.now() % 86400000);

    await storage.api.set({
        "autodarkchangeMode": {mode: "manual-suntimes"},
        "autodarkdaytimeTheme": {themeId: "my-day@x"},
        "autodarknighttimeTheme": {themeId: "my-night@x"},
        "autodarksunriseTime": {time: "08:00"},
        "autodarksunsetTime": {time: "20:00"},
        "autodarknightScheme": {value: "light"}
    });

    vm.runInContext("__fixedNow = " + (noonMs + 23 * 3600000) + "; Date.now = () => __fixedNow;", sandbox);
    await vm.runInContext("init().then(() => switch_queue)", sandbox);

    assert.strictEqual(calls.overrides[calls.overrides.length - 1], "light",
        "a user-chosen light scheme must be honoured at night");
});

test("no theme configured is a no-op instead of an error", async () => {
    const {sandbox, storage, calls} = run();
    const noonMs = Date.now() - (Date.now() % 86400000);

    await storage.api.set({
        "autodarkchangeMode": {mode: "manual-suntimes"},
        "autodarkdaytimeTheme": {themeId: ""},
        "autodarknighttimeTheme": {themeId: ""}
    });

    vm.runInContext("__fixedNow = " + (noonMs + 12 * 3600000) + "; Date.now = () => __fixedNow;", sandbox);
    await vm.runInContext("init().then(() => switch_queue)", sandbox);

    assert.strictEqual(calls.setEnabled.length, 0);
});

test("the preview theme is reverted to the schedule afterwards", async () => {
    const {sandbox, storage, calls} = run();
    const noonMs = Date.now() - (Date.now() % 86400000);

    await storage.api.set({
        "autodarkchangeMode": {mode: "manual-suntimes"},
        "autodarkdaytimeTheme": {themeId: "my-day@x"},
        "autodarknighttimeTheme": {themeId: "my-night@x"},
        "autodarksunriseTime": {time: "08:00"},
        "autodarksunsetTime": {time: "20:00"}
    });

    vm.runInContext("__fixedNow = " + (noonMs + 12 * 3600000) + "; Date.now = () => __fixedNow;", sandbox);
    await vm.runInContext("init().then(() => switch_queue)", sandbox);

    // Preview a theme that is not scheduled for this slot.
    await vm.runInContext("previewTheme('firefox-compact-light@mozilla.org')", sandbox);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const previewed = calls.setEnabled.some(([id, on]) => id === "firefox-compact-light@mozilla.org" && on === true);
    assert.ok(previewed, "the previewed theme should be enabled");

    const last = calls.setEnabled[calls.setEnabled.length - 1];
    assert.deepStrictEqual(last, ["my-day@x", true],
        "after the preview the scheduled theme must be restored");
});

test("the toolbar button opens the settings page", async () => {
    const {calls} = run();

    assert.strictEqual(calls.actionClicks.length, 1,
        "the background page should register exactly one toolbar click handler");

    await calls.actionClicks[0]();

    assert.strictEqual(calls.openOptions, 1,
        "clicking the toolbar button must open the options page");
});

test("a failing context menu leaves the toolbar click working", async () => {
    // 2.0.1 registered the menu before the click handler; an invalid context
    // made the click do nothing at all.
    const {calls} = run({menusThrow: true});

    assert.strictEqual(calls.actionClicks.length, 1,
        "the click handler must be registered even when menus.create throws");

    await calls.actionClicks[0]();

    assert.strictEqual(calls.openOptions, 1, "the settings page still opens");
});

test("the toolbar menu keeps the day/night switch", async () => {
    const {sandbox, storage, calls} = run();
    const noonMs = Date.now() - (Date.now() % 86400000);

    await storage.api.set({
        "autodarkchangeMode": {mode: "manual-suntimes"},
        "autodarkdaytimeTheme": {themeId: "my-day@x"},
        "autodarknighttimeTheme": {themeId: "my-night@x"},
        "autodarksunriseTime": {time: "08:00"},
        "autodarksunsetTime": {time: "20:00"}
    });

    vm.runInContext("__fixedNow = " + (noonMs + 12 * 3600000) + "; Date.now = () => __fixedNow;", sandbox);
    await vm.runInContext("init().then(() => switch_queue)", sandbox);

    assert.strictEqual(calls.menuCreated.length, 1, "one toolbar menu item is created");
    // MV2 spelling: "action" is the Chrome/MV3 name and Firefox rejects it.
    assert.strictEqual(Array.from(calls.menuCreated[0].contexts).join(","), "browser_action",
        "the item belongs to the toolbar button");
    assert.strictEqual(calls.menus.length, 1, "the menu click handler is registered");

    // The daytime theme is active at noon: the menu switches to night now.
    calls.menus[0]({menuItemId: calls.menuCreated[0].id});
    await new Promise((resolve) => setTimeout(resolve, 20));

    const last = calls.setEnabled[calls.setEnabled.length - 1];
    assert.deepStrictEqual(last, ["my-night@x", true],
        "the menu override must switch to the nighttime theme immediately");
});

test("clicking the manual switch twice goes back to the scheduled theme", async () => {
    const {sandbox, storage, calls} = run();
    const noonMs = Date.now() - (Date.now() % 86400000);

    await storage.api.set({
        "autodarkchangeMode": {mode: "manual-suntimes"},
        "autodarkdaytimeTheme": {themeId: "my-day@x"},
        "autodarknighttimeTheme": {themeId: "my-night@x"},
        "autodarksunriseTime": {time: "08:00"},
        "autodarksunsetTime": {time: "20:00"}
    });

    vm.runInContext("__fixedNow = " + (noonMs + 12 * 3600000) + "; Date.now = () => __fixedNow;", sandbox);
    await vm.runInContext("init().then(() => switch_queue)", sandbox);

    await vm.runInContext("toggleFromToolbar().then(() => switch_queue)", sandbox);
    assert.deepStrictEqual(calls.setEnabled[calls.setEnabled.length - 1], ["my-night@x", true],
        "the first click shows the other theme");

    // The bug: the second click asked for the same theme again, so nothing
    // happened and the button looked dead.
    await vm.runInContext("toggleFromToolbar().then(() => switch_queue)", sandbox);
    assert.deepStrictEqual(calls.setEnabled[calls.setEnabled.length - 1], ["my-day@x", true],
        "the second click must go back to the scheduled theme");
});

// ---------------------------------------------------------------------------
// system-theme mode: "When my operating system switches between light and dark"
// ---------------------------------------------------------------------------

function systemSettings(storage, extra) {
    return storage.api.set(Object.assign({
        "autodarkchangeMode": {mode: "system-theme"},
        "autodarkdaytimeTheme": {themeId: "my-day@x"},
        "autodarknighttimeTheme": {themeId: "my-night@x"},
        "autodarksunriseTime": {time: "08:00"},
        "autodarksunsetTime": {time: "20:00"}
    }, extra || {}));
}

function lastTheme(calls) {
    let enabled = calls.setEnabled.filter(([, on]) => on === true);
    return enabled.length ? enabled[enabled.length - 1][0] : null;
}

// "There is 0 log written": the trace has to exist in storage after a tick and
// be served to the settings page, otherwise the diagnostic channel is theatre.
test("the debug trace exists after a tick and is served to the page", async () => {
    const {sandbox, storage, calls} = run();
    await systemSettings(storage);
    await vm.runInContext("init().then(() => switch_queue)", sandbox);
    vm.runInContext("setupEventHandlers()", sandbox);
    await new Promise((resolve) => setTimeout(resolve, 30));

    let stored = storage.data["autodarkdebug"];
    assert.ok(stored && Array.isArray(stored.check) && stored.check.length > 0,
        "a tick must leave a trace in storage");

    assert.ok(calls.messageListeners.length > 0,
        "a message listener must be registered (got " + calls.messageListeners.length + ")");
    let listener = calls.messageListeners[0];
    let text = await listener({type: "autodark-debug"});
    assert.ok(typeof text === "string" && text.length > 0, "the page must receive the trace");
    assert.match(text, /tick|os-sync|apply/, "the trace has to name what it did");
});

test("the alarm listener is registered while the background script is evaluated", () => {
    const {calls} = run();
    assert.strictEqual((calls.alarmListeners || []).length, 1,
        "an alarm listener added after init() resolves is never called by Firefox");
});

test("system mode applies the daytime theme while the OS is light", async () => {
    const {sandbox, storage, calls} = run();
    await systemSettings(storage);

    await vm.runInContext("init().then(() => switch_queue)", sandbox);

    assert.strictEqual(lastTheme(calls), "my-day@x",
        "a light OS must use the daytime theme, whatever the clock says");
    assert.deepStrictEqual(calls.overrides.slice(-1), ["auto"],
        "pages must be left on the OS scheme in system mode");
});

test("a content script report flips the theme without waiting for an alarm", async () => {
    // A page only speaks for the OS when the browser is not showing it a theme
    // with a literal color_scheme, so this theme follows the system.
    const {sandbox, storage, calls} = run({
        themeCurrent: {colors: {frame: "#1c1b22"}, properties: {color_scheme: "system"}}
    });
    await systemSettings(storage);

    await vm.runInContext("init().then(() => switch_queue)", sandbox);
    assert.strictEqual(lastTheme(calls), "my-day@x");

    // background.js wires the message listener through setupEventHandlers().
    vm.runInContext("setupEventHandlers()", sandbox);

    // The user switches the OS to dark: the browser updates the media query and
    // every open page reports it.
    calls.setMediaDark(true, false);
    const listener = calls.messageListeners[0];
    assert.ok(listener, "the background must listen for content script messages");
    await listener({type: "autodark-scheme", dark: true});
    // The tick is coalesced behind a short timer.
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.strictEqual(lastTheme(calls), "my-night@x",
        "a dark OS report must switch to the nighttime theme immediately");
});

// Reloading the extension must re-read the OS instead of trusting the stored
// value: the stored one describes the previous run, so a reload during the night
// used to come back with the daytime theme and stay there.
test("a reload corrects a stale stored OS scheme", async () => {
    const {sandbox, storage, calls} = run();
    // Storage says "dark" (the OS was dark last time), the live query says light.
    await systemSettings(storage, {"autodarksystemDark": {check: true}});

    await vm.runInContext("init().then(() => switch_queue)", sandbox);

    assert.strictEqual(lastTheme(calls), "my-day@x",
        "the live OS scheme must win over the stored one at startup");
    assert.strictEqual(storage.data["autodarksystemDark"].check, false,
        "the corrected value must be persisted for the next start");
});

// The stored scheme is a hint, not the truth: a restart must re-read the OS.
// (Keeping the stored value regardless is what made a reload during the night
// come back on the daytime theme.)
// The media query is authoritative in system-theme mode, so any tick re-reads
// it. Detection therefore never depends on a web page being open and firing a
// change event — that dependency is what made it look random.
test("a plain periodic tick re-reads the OS scheme", async () => {
    // The enabled theme follows the OS, so the media query can see it.
    const themeCurrent = {properties: {color_scheme: "system"}};
    const {sandbox, storage, calls} = run({getCurrent: () => themeCurrent});
    await systemSettings(storage, {"autodarksystemDark": {check: false}});
    await vm.runInContext("init().then(() => switch_queue)", sandbox);
    assert.strictEqual(lastTheme(calls), "my-day@x");

    // The user switched the system to dark; no page reported anything.
    calls.setMediaDark(true, false);
    await vm.runInContext("tick(\"alarm\").then(() => switch_queue)", sandbox);

    assert.strictEqual(lastTheme(calls), "my-night@x",
        "a scheduled tick must notice the OS switch on its own");
});

test("a cold start follows the live OS scheme, not the stored one", async () => {
    const {sandbox, storage, calls} = run();
    await systemSettings(storage, {"autodarksystemDark": {check: true}});

    await vm.runInContext("init().then(() => switch_queue)", sandbox);

    assert.strictEqual(lastTheme(calls), "my-day@x",
        "the live query says light, so the stored dark value must not survive");
});

test("system mode keeps pages on the OS scheme even when one is pinned", async () => {
    const {sandbox, storage, calls} = run();
    // A pinned day/night scheme used to pin every page too, which stopped the
    // content scripts from ever reporting an OS change (the "always dark"
    // report of issue #28).
    await systemSettings(storage, {
        "autodarkdayScheme": {value: "dark"},
        "autodarknightScheme": {value: "dark"}
    });

    await vm.runInContext("init().then(() => switch_queue)", sandbox);

    assert.deepStrictEqual(calls.overrides.slice(-1), ["auto"],
        "system mode must leave pages on the OS scheme");
});

test("system mode never paints a built-in light/dark theme", async () => {
    const {sandbox, storage, calls} = run();
    await systemSettings(storage, {
        "autodarkdaytimeTheme": {themeId: "firefox-compact-dark@mozilla.org"},
        "autodarknighttimeTheme": {themeId: "firefox-compact-dark@mozilla.org"}
    });

    await vm.runInContext("init().then(() => switch_queue)", sandbox);

    assert.ok(!calls.setEnabled.some(([id, on]) => on === true
        && (id === "firefox-compact-dark@mozilla.org" || id === "firefox-compact-light@mozilla.org")),
        "the built-in dark theme pins the OS signal and must not be enabled");
    assert.ok(!calls.setEnabled.some(([id, on]) => on === true && id === "my-night@x"),
        "the configured night theme was the built-in one, so nothing else is painted");
});

test("a fresh install does not default both slots to the dark theme", async () => {
    const {sandbox, enabledThemes} = run();
    enabledThemes["firefox-compact-dark@mozilla.org"] = true;

    await vm.runInContext("setDefaultThemes().then(() => switch_queue)", sandbox);

    assert.strictEqual(vm.runInContext("DEFAULT_DAYTIME_THEME", sandbox),
        "firefox-compact-light@mozilla.org",
        "the daytime default must be the light theme, not the dark one");
    assert.strictEqual(vm.runInContext("DEFAULT_NIGHTTIME_THEME", sandbox),
        "firefox-compact-dark@mozilla.org");
});

test("setStorage leaves an existing value alone unless overrideDefault is set", async () => {
    const {sandbox, storage} = run();

    await storage.api.set({"autodarkchangeMode": {mode: "manual-suntimes"}});

    await vm.runInContext(
        'setStorage({"autodarkchangeMode": {mode: "location-suntimes"}})', sandbox);
    assert.strictEqual(storage.data["autodarkchangeMode"].mode, "manual-suntimes",
        "the start-up defaults must not overwrite a stored value");

    await vm.runInContext(
        'setStorage({"autodarkchangeMode": {mode: "location-suntimes"}}, true)', sandbox);
    assert.strictEqual(storage.data["autodarkchangeMode"].mode, "location-suntimes",
        "an explicit override must replace the stored value");
});

test("the options page writes its settings with overrideDefault", () => {
    // Regression: persist() used to call setStorage(values) without the
    // override flag, so every edit was silently dropped as soon as init() had
    // created the key — the page looked like it saved and changed nothing.
    const source = fs.readFileSync(path.join(ROOT, "js/options.js"), "utf8");
    const start = source.indexOf("function persist(");
    assert.notStrictEqual(start, -1, "js/options.js must still define persist()");
    const body = source.slice(start, source.indexOf("function saveRandomPool("));

    assert.match(body, /setStorage\(values, true\)/,
        "persist() must pass overrideDefault, otherwise every edit is dropped");
});

test("geolocation updates both stored coordinates", () => {
    const source = fs.readFileSync(path.join(ROOT, "js/common.js"), "utf8");
    const start = source.indexOf("function setGeolocation(");
    const body = source.slice(start, source.indexOf("function ", start + 10));

    assert.match(body, /\}, true\)\.then\(\(\) => resolve\(position\.coords\)/,
        "a second location lookup must overwrite the first one");
});

test("a built-in light theme is honoured at night", async () => {
    const {sandbox, storage, calls} = run();
    const noonMs = Date.now() - (Date.now() % 86400000);
    const LIGHT = "firefox-compact-light@mozilla.org";

    await storage.api.set({
        "autodarkchangeMode": {mode: "manual-suntimes"},
        "autodarkdaytimeTheme": {themeId: "my-day@x"},
        "autodarknighttimeTheme": {themeId: LIGHT},
        "autodarksunriseTime": {time: "08:00"},
        "autodarksunsetTime": {time: "20:00"},
        "autodarkdayScheme": {value: "auto"},
        "autodarknightScheme": {value: "auto"}
    });

    vm.runInContext("__fixedNow = " + (noonMs + 12 * 3600000) + "; Date.now = () => __fixedNow;", sandbox);
    await vm.runInContext("init().then(() => switch_queue)", sandbox);

    vm.runInContext("__fixedNow = " + (noonMs + 23 * 3600000) + ";", sandbox);
    await vm.runInContext("queueTick('alarm')", sandbox);

    const last = calls.setEnabled[calls.setEnabled.length - 1];
    assert.deepStrictEqual(last, [LIGHT, true],
        "picking the built-in light theme for the night slot must enable it");
    assert.deepStrictEqual(calls.overrides.slice(-1), ["light"],
        "the night slot must pin the content scheme to light");
});

test("a built-in dark theme pins the content scheme to dark by day", async () => {
    const {sandbox, storage, calls} = run();
    const noonMs = Date.now() - (Date.now() % 86400000);
    const DARK = "firefox-compact-dark@mozilla.org";

    await storage.api.set({
        "autodarkchangeMode": {mode: "manual-suntimes"},
        "autodarkdaytimeTheme": {themeId: DARK},
        "autodarknighttimeTheme": {themeId: DARK},
        "autodarksunriseTime": {time: "08:00"},
        "autodarksunsetTime": {time: "20:00"},
        "autodarkdayScheme": {value: "auto"},
        "autodarknightScheme": {value: "auto"}
    });

    vm.runInContext("__fixedNow = " + (noonMs + 12 * 3600000) + "; Date.now = () => __fixedNow;", sandbox);
    await vm.runInContext("init().then(() => switch_queue)", sandbox);

    assert.deepStrictEqual(calls.overrides.slice(-1), ["dark"],
        "dark chrome must not sit over light pages");
});

// Pinned slot schemes used to make every page report the pinned value, which the
// extension read back as an OS signal: the two slots then alternated forever
// (the 2.0.11/2.0.12 ping-pong). In system-theme mode the content override is
// now forced to "system", so pages follow the OS whatever the slots declare and
// the echo cannot happen.
test("pinned slot schemes cannot make pages echo a fixed value", async () => {
    const {sandbox, storage, calls} = run();
    await systemSettings(storage, {
        "autodarkdayScheme": {value: "light"},
        "autodarknightScheme": {value: "light"}
    });

    await vm.runInContext("init().then(() => switch_queue)", sandbox);

    assert.ok(calls.overrides.includes("auto"),
        "system-theme mode must force overrideContentColorScheme to system, got: "
        + JSON.stringify(calls.overrides));
    assert.ok(!calls.overrides.includes("light") && !calls.overrides.includes("dark"),
        "a pinned slot scheme must never be written as the content override");
});

// A theme that declares a literal color_scheme makes every page report that
// value, so the extension reads its own decision back as an OS signal and the
// two slots alternate forever. In system-theme mode the active theme must
// therefore be one that follows the OS.
test("system-theme mode never keeps a literal-scheme built-in theme active", async () => {
    const {sandbox, storage, calls} = run();
    sandbox.__fixedNow = Date.now() - (Date.now() % 86400000) + 12 * 3600000;
    vm.runInContext("Date.now = () => __fixedNow;", sandbox);

    await systemSettings(storage, {
        "autodarkdaytimeTheme": {themeId: "firefox-compact-light@mozilla.org"}
    });
    await vm.runInContext("init().then(() => switch_queue)", sandbox);

    assert.ok(!calls.setEnabled.some(([id, on]) => on === true
        && (id === "firefox-compact-light@mozilla.org" || id === "firefox-compact-dark@mozilla.org")),
        "a literal-scheme theme must not be enabled in system-theme mode");
    assert.strictEqual(lastTheme(calls), "default-theme@mozilla.org",
        "the System theme is the only built-in one that follows the OS");
});




// Applying a static theme is one decision: exactly one theme enabled, verified.
// No overlay, no theme.reset(): theme.update() replaces the enabled theme and
// theme.reset() repaints the default one, and both made a working switch paint
// something else than the theme the user picked.
test("applying a static theme never paints an overlay", async () => {
    const {sandbox, storage, calls} = run({mediaDark: true});
    const noonMs = Date.now() - (Date.now() % 86400000);

    await storage.api.set({
        "autodarkchangeMode": {mode: "system-theme"},
        "autodarkdaytimeTheme": {themeId: "my-day@x"},
        "autodarknighttimeTheme": {themeId: "my-night@x"},
        "autodarksystemDark": {check: true}
    });

    vm.runInContext("__fixedNow = " + (noonMs + 12 * 3600000) + "; Date.now = () => __fixedNow;", sandbox);
    await vm.runInContext("init().then(() => switch_queue)", sandbox);

    assert.strictEqual(calls.themeUpdate.length, 0,
        "no theme.update() overlay: it replaces the enabled theme");
    assert.strictEqual(calls.themeReset, 0,
        "no theme.reset(): it repaints the default theme");
    assert.strictEqual(lastTheme(calls), "my-night@x", "the night theme is the enabled one");
});

test("a theme that is already the enabled one is left alone", async () => {
    const {sandbox, calls} = run();
    await vm.runInContext("browser.management.setEnabled('my-night@x', true)", sandbox);
    calls.setEnabled.length = 0;

    const ok = await vm.runInContext('applyStaticTheme("my-night@x")', sandbox);

    assert.strictEqual(ok, true);
    assert.strictEqual(calls.setEnabled.length, 0,
        "re-enabling an enabled theme is the churn that broke Firefox's DRM checkbox");
});

test("a theme that is enabled but not in effect is toggled once", async () => {
    // Firefox can report a theme as enabled while the default theme is what is
    // actually painted (bug 1415267). A single disable/enable cycle is the fix,
    // and it has to be decided from the enabled theme, not from getCurrent().
    const {sandbox, calls} = run();
    vm.runInContext(`__attempts = [];
        browser.management.setEnabled = (id, on) => {
            __attempts.push([id, on]);
            return Promise.resolve();
        };`, sandbox);

    const ok = await vm.runInContext('applyStaticTheme("my-night@x")', sandbox);
    const attempts = vm.runInContext("__attempts", sandbox);

    assert.strictEqual(ok, false, "the theme never became the enabled one");
    assert.strictEqual(JSON.stringify(attempts),
        JSON.stringify([["my-night@x", true], ["my-night@x", false], ["my-night@x", true]]),
        "enable, then one disable/enable cycle");
});

test("apply records the enabled theme in the diagnostics events", async () => {
    const {sandbox, storage} = run();
    await vm.runInContext("browser.management.setEnabled('my-day@x', true)", sandbox);
    await vm.runInContext('applyStaticTheme("my-night@x")', sandbox);

    const events = await storage.api.get("autodarkevents");
    const list = (events["autodarkevents"] || {}).check || [];
    assert.ok(list.some((entry) => entry.kind === "apply" && String(entry.detail).indexOf("my-night@x") !== -1),
        "the events must say which theme was really enabled");
});

test("a stale overlay is not touched when the slot theme is applied", async () => {
    const stale = {colors: {frame: "#000"}, properties: {color_scheme: "system"}};
    const {sandbox, calls} = run({themeCurrent: stale});
    await vm.runInContext("browser.management.setEnabled('my-day@x', true)", sandbox);

    await vm.runInContext('applyStaticTheme("my-night@x")', sandbox);

    assert.strictEqual(calls.themeReset, 0, "the overlay is not dropped with theme.reset()");
    assert.strictEqual(lastTheme(calls), "my-night@x");
});

test("no overlay is applied when the theme already follows the OS", async () => {
    const following = {
        colors: {frame: "#1c1b22", toolbar: "#1c1b22"},
        properties: {color_scheme: "system"}
    };
    const {sandbox, storage, calls} = run({themeCurrent: following});
    const noonMs = Date.now() - (Date.now() % 86400000);

    await storage.api.set({
        "autodarkchangeMode": {mode: "system-theme"},
        "autodarkdaytimeTheme": {themeId: "my-day@x"},
        "autodarknighttimeTheme": {themeId: "my-night@x"},
        "autodarksystemDark": {check: true}
    });

    vm.runInContext("__fixedNow = " + (noonMs + 12 * 3600000) + "; Date.now = () => __fixedNow;", sandbox);
    await vm.runInContext("init().then(() => switch_queue)", sandbox);

    assert.strictEqual(calls.themeUpdate.length, 0,
        "a theme that follows the OS must not be re-sent as an overlay");
    assert.deepStrictEqual(calls.overrides.slice(-1), ["auto"]);
});

test("the page colour scheme follows the OS by default", async () => {
    // Jo (m01265): with nothing configured, pages must follow the operating
    // system — day and night, whatever themes are installed.
    const {sandbox, storage, calls} = run();
    const noonMs = Date.now() - (Date.now() % 86400000);

    await storage.api.set({
        "autodarkchangeMode": {mode: "manual-suntimes"},
        "autodarkdaytimeTheme": {themeId: "my-day@x"},
        "autodarknighttimeTheme": {themeId: "my-night@x"},
        "autodarksunriseTime": {time: "08:00"},
        "autodarksunsetTime": {time: "20:00"}
    });

    vm.runInContext("__fixedNow = " + (noonMs + 12 * 3600000) + "; Date.now = () => __fixedNow;", sandbox);
    await vm.runInContext("init().then(() => switch_queue)", sandbox);
    assert.deepStrictEqual(calls.overrides.slice(-1), ["auto"],
        "the day slot must leave the page scheme to the OS");

    vm.runInContext("__fixedNow = " + (noonMs + 23 * 3600000) + ";", sandbox);
    await vm.runInContext("queueTick('alarm')", sandbox);
    assert.deepStrictEqual(calls.overrides.slice(-1), ["auto"],
        "the night slot must leave the page scheme to the OS");
});

