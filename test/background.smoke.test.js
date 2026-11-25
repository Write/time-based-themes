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

function run() {
    let storage = makeStorage();
    let calls = {
        setEnabled: [],
        themeUpdate: [],
        themeReset: 0,
        overrides: [],
        title: [],
        alarms: {},
        getCurrentCount: 0
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
            onClicked: {addListener() {}},
            setTitle(details) {
                calls.title.push(details.title);
                return Promise.resolve();
            }
        },
        windows: {
            WINDOW_ID_NONE: -1,
            onFocusChanged: {addListener() {}}
        },
        runtime: {
            onMessage: {addListener() {}},
            onInstalled: {addListener() {}},
            openOptionsPage() {},
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
        setTimeout: setTimeout,
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
