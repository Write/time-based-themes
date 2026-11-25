'use strict';

// ---------------------------------------------------------------------------
// Content script.
//
// Two jobs, both of which used to be impossible from the background page:
//
// 1. Report OS light/dark changes. Since Firefox 95 the prefers-color-scheme
//    media query in extension pages follows the *browser theme*, not the OS
//    (bug 1741009), and the change event is frequently not delivered there at
//    all (issues #43, #44, #64). A page's media query does follow the OS (when
//    layout.css.prefers-color-scheme.content-override is "system"), which is
//    why Dark Reader collects these signals from tabs.
//
// 2. Apply per-site colour-scheme overrides (issue #20): the "always dark" /
//    "always light" site list in the options page.
// ---------------------------------------------------------------------------

const SITE_OVERRIDES_KEY = "autodarksiteOverrides";
const SCHEME_REPORT_TYPE = "autodark-scheme";

const schemeQuery = window.matchMedia("(prefers-color-scheme: dark)");

// --- 1. Report the OS colour scheme ----------------------------------------

function reportScheme() {
    try {
        let sent = browser.runtime.sendMessage({
            type: SCHEME_REPORT_TYPE,
            dark: schemeQuery.matches
        });
        if (sent && typeof sent.catch === "function") {
            // "Could not establish connection" while the background page is
            // starting up — harmless, the next tick re-syncs anyway.
            sent.catch(() => {});
        }
    } catch (e) {
        // Extension was reloaded/disabled; nothing to report to.
    }
}

reportScheme();

if (typeof schemeQuery.addEventListener === "function") {
    schemeQuery.addEventListener("change", reportScheme);
} else if (typeof schemeQuery.addListener === "function") {
    schemeQuery.addListener(reportScheme);
}

// --- 2. Per-site colour-scheme overrides -----------------------------------

const OVERRIDE_STYLE_ID = "autodark-site-scheme";

// "dark"/"light" -> matching rule; anything else -> no rule.
function parseSiteOverrides(text) {
    let rules = [];
    if (!text) {
        return rules;
    }
    text.split(/[\n,]+/).forEach((line) => {
        let trimmed = line.trim();
        if (!trimmed || trimmed.charAt(0) === "#") {
            return;
        }
        let parts = trimmed.split(/[\s:=,]+/);
        if (parts.length < 2) {
            return;
        }
        let host = parts[0].toLowerCase().replace(/^\*?\.?/, "").replace(/^www\./, "");
        let scheme = parts[1].toLowerCase();
        if (!host || (scheme !== "dark" && scheme !== "light")) {
            return;
        }
        rules.push({ host: host, scheme: scheme });
    });
    return rules;
}

function hostMatches(ruleHost, hostname) {
    let host = hostname.toLowerCase().replace(/^www\./, "");
    return host === ruleHost || host.endsWith("." + ruleHost);
}

function schemeForThisSite(rules) {
    for (let i = 0; i < rules.length; i++) {
        if (hostMatches(rules[i].host, location.hostname)) {
            return rules[i].scheme;
        }
    }
    return null;
}

function applySiteOverride(rules) {
    let scheme = schemeForThisSite(rules);
    let existing = document.getElementById(OVERRIDE_STYLE_ID);

    if (!scheme) {
        if (existing) {
            existing.remove();
        }
        return;
    }

    if (!existing) {
        existing = document.createElement("style");
        existing.id = OVERRIDE_STYLE_ID;
        existing.textContent =
            ":root, html { color-scheme: " + scheme + " !important; }";
        (document.documentElement || document.head || document).appendChild(existing);
    } else if (existing.textContent.indexOf(scheme) === -1) {
        existing.textContent =
            ":root, html { color-scheme: " + scheme + " !important; }";
    }
}

let siteRules = [];

function refreshSiteOverrides() {
    let got = browser.storage.local.get(SITE_OVERRIDES_KEY);
    if (got && typeof got.then === "function") {
        got.then((obj) => {
            let text = obj && obj[SITE_OVERRIDES_KEY] ? obj[SITE_OVERRIDES_KEY].text : "";
            siteRules = parseSiteOverrides(text);
            applySiteOverride(siteRules);
        }).catch(() => {});
    }
}

refreshSiteOverrides();

if (browser.storage && browser.storage.onChanged) {
    browser.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes[SITE_OVERRIDES_KEY]) {
            refreshSiteOverrides();
        }
    });
}
