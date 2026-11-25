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
        openOptions: 0
    };

    let enabledThemes = {};

    const browser = {
        storage: {local: storage.api, onChanged: storage.onChanged},
        alarms: {
            get: () => Promise.resolve(calls.alarms.created ? {name: "autodark-tick"} : null),
            create: (name) => {
                calls.alarms.created = name;
            },
            clear: () => Promise.resolve(true),
            onAlarm: {addListener() {}}
        },
        management: {
            getAll: () => Promise.resolve([
                {id: "default-theme@mozilla.org", name: "System theme — auto", type: "theme", enabled: false},
                {id: "firefox-compact-light@mozilla.org", name: "Light", type: "theme", enabled: false},
                {id: "my-day@x", name: "Day", type: "theme", enabled: false},
                {id: "my-night@x", name: "Night", type: "theme", enabled: false},
                {id: "some-addon@x", name: "Add-on", type: "extension", enabled: true}
            ]),
            get: (id) => Promise.resolve({id: id, enabled: enabledThemes[id] === true}),
            setEnabled: (id, enabled) => {
                calls.setEnabled.push([id, enabled]);
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
                return Promise.resolve({
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
            onMessage: {addListener() {}},
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
                matches: false,
                addEventListener() {},
                addListener() {}
            })
        },
        URL: URL,
        navigator: {}
    };
    vm.createContext(sandbox);

    // One script: the background page shares a single global lexical scope
    // between its classic scripts, so the files are concatenated.
    const source = FILES
        .map((file) => fs.readFileSync(path.join(ROOT, file), "utf8"))
        .join("\n;\n");
    vm.runInContext(source, sandbox, {filename: "background-bundle.js"});

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
        "autodarksunsetTime": {time: "20:00"}
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
        "autodarksunsetTime": {time: "20:00"}
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

test("system-theme mode keeps the OS signal observable with images inlined", async () => {
    const {sandbox, storage, calls} = run();
    const noonMs = Date.now() - (Date.now() % 86400000);

    await storage.api.set({
        "autodarkchangeMode": {mode: "system-theme"},
        "autodarkdaytimeTheme": {themeId: "my-day@x"},
        "autodarknighttimeTheme": {themeId: "my-night@x"},
        "autodarksystemDark": {check: true}
    });

    vm.runInContext("__fixedNow = " + (noonMs + 12 * 3600000) + "; Date.now = () => __fixedNow;", sandbox);
    await vm.runInContext("init().then(() => switch_queue)", sandbox);

    // The night theme is enabled and the color_scheme workaround is applied.
    assert.ok(calls.setEnabled.some(([id, on]) => id === "my-night@x" && on === true));
    assert.ok(calls.themeUpdate.length >= 1, "theme.update() should be used for the workaround");

    const overlay = calls.themeUpdate[calls.themeUpdate.length - 1];
    assert.strictEqual(overlay.properties.color_scheme, "system");
    assert.strictEqual(overlay.images.theme_ntp_background, "data:image/png;base64,AAAA",
        "moz-extension:// images must be inlined before theme.update()");
    assert.deepStrictEqual(calls.overrides.slice(-1), ["system"]);
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
