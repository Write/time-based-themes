# Privacy policy — automaticDark

automaticDark collects nothing and sends nothing anywhere.

## What the add-on stores

Everything is written to the extension's own local storage
(`browser.storage.local`) on your machine, and never leaves it:

- your sunrise/sunset times, or the position used to compute them;
- the sunrise/sunset offsets and the optional timezone override;
- the themes and colour schemes you selected, extra slots, random pool;
- the list of hosts you added to the per-site colour-scheme override;
- the last applied slot, so a restart does not re-apply anything unnecessarily;
- the debug-log toggle.

None of this is transmitted, synchronised or backed up by the add-on.

## Location

If you choose the automatic sunrise/sunset mode, the add-on asks Firefox for your
position once (`navigator.geolocation.getCurrentPosition`). The coordinates are converted
locally into sunrise and sunset times with the bundled SunCalc library; the position
itself is only stored if you keep the automatic mode, and you can skip the request
entirely by typing latitude and longitude yourself.

## Network

The add-on makes no network requests. There is no telemetry, no analytics, no crash
reporting, no remote configuration, and no third-party code fetched at runtime — the only
external libraries (SunCalc) are bundled in the package.

## Permissions

| Permission | Why |
| --- | --- |
| `theme` | Read the current theme and switch between the ones you selected. |
| `management` | List your installed themes and enable/disable one. |
| `storage` | Keep your settings on your machine. |
| `alarms` | Wake up once a minute to check the schedule. |
| `browserSettings` | Set the page colour scheme (`light`/`dark`/`system`). |
| `idle` | Catch up after the machine was suspended. |
| `http://*/*`, `https://*/*` | Apply the per-site colour-scheme overrides you configured. |

## Firefox for Android

The add-on is installable on Firefox for Android but declares no Android-specific data
handling; the options above apply unchanged.

Developers: the browser API surface used is the one documented on MDN
(`browser.theme`, `browser.management`, `browser.browserSettings`, `browser.alarms`,
`browser.storage`, `browser.idle`, `browser.browserAction`).

## Contact

Open an issue in this repository's fork of the project.
