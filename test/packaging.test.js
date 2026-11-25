'use strict';

// Packaging sanity checks: everything the manifest and the options page
// reference must exist, and every element the options script touches must be
// in the HTML. Cheap because a typo there only shows up at runtime in the
// browser.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

function read(file) {
    return fs.readFileSync(path.join(ROOT, file), "utf8");
}

function exists(file) {
    return fs.existsSync(path.join(ROOT, file));
}

const manifest = JSON.parse(read("manifest.json"));

function manifestFiles() {
    let files = [];
    Object.keys(manifest.icons || {}).forEach((size) => files.push(manifest.icons[size]));
    (manifest.background && manifest.background.scripts || []).forEach((f) => files.push(f));
    (manifest.content_scripts || []).forEach((entry) => {
        (entry.js || []).forEach((f) => files.push(f));
        (entry.css || []).forEach((f) => files.push(f));
    });
    if (manifest.browser_action && manifest.browser_action.default_icon) {
        let icon = manifest.browser_action.default_icon;
        if (typeof icon === "string") {
            files.push(icon);
        } else {
            Object.keys(icon).forEach((size) => files.push(icon[size]));
        }
    }
    if (manifest.options_ui) {
        files.push(manifest.options_ui.page);
    }
    return files;
}

test("every file referenced by the manifest exists", () => {
    let missing = manifestFiles().filter((file) => !exists(file));
    assert.deepStrictEqual(missing, []);
});

test("the manifest is installable on the current AMO requirements", () => {
    assert.strictEqual(manifest.manifest_version, 2);
    assert.ok(manifest.browser_specific_settings.gecko.id, "a stable id is required for signing");
    assert.ok(manifest.browser_specific_settings.gecko.data_collection_permissions,
        "AMO requires a data collection declaration");
    assert.deepStrictEqual(
        manifest.browser_specific_settings.gecko.data_collection_permissions.required, ["none"]);
    assert.ok(manifest.browser_specific_settings.gecko_android, "Firefox for Android support");
    assert.ok(!JSON.stringify(manifest.permissions).includes("<all_urls>"),
        "host permissions should be narrowed to http(s)");
});

test("no remote code is loaded (AMO rejects it)", () => {
    let html = read("html/options.html");
    // Anchors are fine; what matters is that no <script src> or <link href>
    // points at another origin.
    let remoteScripts = [...html.matchAll(/<script[^>]+src="(https?:[^"]+)"/g)].map((m) => m[1]);
    let remoteStyles = [...html.matchAll(/<link[^>]+href="(https?:[^"]+)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(remoteScripts.concat(remoteStyles), []);
});

test("every element the options script looks up exists in the HTML", () => {
    let html = read("html/options.html");
    let script = read("js/options.js");

    let ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));

    let referenced = new Set();
    [...script.matchAll(/\$\("([^"]+)"\)/g)].forEach((match) => referenced.add(match[1]));
    [...script.matchAll(/data-target="([^"]+)"/g)].forEach((match) => referenced.add(match[1]));
    [...html.matchAll(/data-target="([^"]+)"/g)].forEach((match) => referenced.add(match[1]));

    let missing = [...referenced].filter((id) => !ids.has(id));
    assert.deepStrictEqual(missing, []);
});

test("every script and stylesheet the options page loads exists", () => {
    let html = read("html/options.html");
    let sources = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1])
        .concat([...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((match) => match[1]));

    sources.forEach((src) => {
        let file = path.normalize(path.join("html", src));
        assert.ok(exists(file), "missing " + file);
    });
});

test("the options page loads the shared modules the background page uses", () => {
    let html = read("html/options.html");
    ["js/utils.js", "js/schedule.js", "js/common.js", "js/options.js"].forEach((file) => {
        assert.ok(html.includes(file), "options page should load " + file);
    });
});
