'use strict';

// Background page entry point.
//
// init() runs first: it fills in default settings, picks up the currently
// enabled theme as the default day/night theme, starts the minutely alarm and
// applies the right theme. setupEventHandlers() then wires the storage,
// message and toolbar listeners.

ensureInitialised();
setupEventHandlers();

browser.runtime.onInstalled.addListener((details) => {
    logDebug("0 - Installed - Reason: " + details.reason
        + ", Previous Version: " + details.previousVersion + ".");

    if (details.reason === "install") {
        logDebug("0 - Just installed. Open the options page.");
        browser.runtime.openOptionsPage();
    }

    // Upgrading from 1.x: make sure the new settings exist and the theme is
    // re-applied with the new logic.
    queueTick("install");
});

// Re-apply after a sleep/hibernate resume: the alarm may have been coalesced
// into a single late event (issue #53).
if (browser.idle && browser.idle.onStateChanged) {
    browser.idle.onStateChanged.addListener((state) => {
        if (state === "active") {
            queueTick("focus");
        }
    });
}
