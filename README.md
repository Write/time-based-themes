# automaticDark - Time-Based Theme Changer

Automatically switch your Firefox theme at sunrise and sunset, at times you choose, or
together with your operating system's light/dark mode.

This is the 2.0.0 branch: the extension was rewritten around a single scheduling
routine, and the 38 open issues of the original project are addressed (see
[Issue status](#issue-status) below). It keeps the original name, id-free options page and
data model, so settings from 1.x still load.

- Options page: `about:addons` → automaticDark → Preferences.
- The toolbar button toggles the day/night theme manually; the icon tooltip shows which
  slot is currently active.
- Nothing leaves your machine, no telemetry, no remote requests: see [PRIVACY.md](PRIVACY.md).

---

## Features

### Scheduling (`Change theme…`)
| Mode | What it does |
| --- | --- |
| **Automatic (sunrise/sunset)** | Asks the browser for your position once, converts the coordinates with SunCalc on every tick, and switches at sunrise and sunset. Polar day/night is detected instead of producing NaN times. |
| **Manual times** | Type the sunrise and sunset times yourself. |
| **System theme** | Follow the operating system: the theme you pick for “night” is used whenever the system is dark. |

Extras that apply to every mode:

- **Offsets** – move sunrise and sunset by ± N minutes (`#57`, `#28`).
- **Timezone override** – compensate for `privacy.resistFingerprinting`, which hides the
  real timezone from the browser (`#5`).
- **Extra slots** – additional theme/time pairs, e.g. an “evening” theme at 22:00 (`#7`,
  `#46`). Slots may cross midnight; the last slot that started wins.
- **Random pool** – a set of themes plus an interval in hours; one of them is picked for
  each slot and re-rolled every N hours (`#52`).

Schedules are evaluated from the *last started slot* rather than by comparing
`now < sunset`, so times that wrap past midnight behave correctly and a missed transition
(closed lid, sleep, browser restart) is caught up on the next tick (`#16`, `#53`).

### Content colour scheme
`browserSettings.overrideContentColorScheme` is set per slot — *follow theme*, *always
light* or *always dark* — so web pages, `about:` pages, Reader mode and the devtools
light/dark choice follow the same schedule as the toolbar (`#9`, `#14`, `#19`, `#30`,
`#62`). Per-site overrides accept a list of host patterns for “always dark” / “always
light” websites (`#20`).

### Themes
- Any installed theme can be selected as the daytime or nighttime theme.
- **Preview** applies a candidate theme for 20 seconds and restores the schedule
  afterwards, so you can try a theme without committing (`#61`).
- The theme list is searchable (`#60`).
- **Firefox Color** themes (and any theme JSON) can be pasted straight into the custom
  day/night fields and used without installing them (`#48`, `#56`).
- New tab background images of the current theme survive the switch: `moz-extension://`
  references are inlined as `data:` URLs before `theme.update()`, which Firefox requires
  (`#63`).

### Behaviour
- Only transitions cause work. A tick that finds the same theme/scheme as the previous one
  does nothing, so the add-on no longer flips themes on every event — which is what
  unchecked the DRM checkbox on some systems (`#26`, `#17`).
- Ticks are driven by a 1-minute alarm *and* by `windows.onFocusChanged`,
  `theme.onUpdated`, startup and resume, so a theme change is never waiting for user
  interaction (`#12`, `#53`, `#64`).
- Toolbar button for a manual day/night override, without touching the schedule (`#24`, `#36`).
- Firefox for Android is a declared target (`gecko_android`, `#66`) and every optional API
  is feature-detected, so a missing `browserAction` degrades quietly.

---

## Install (self-hosted / unlisted)

Firefox only installs signed add-ons permanently, so the flow is: build → sign once on
addons.mozilla.org (unlisted, free) → host the signed file yourself.

```bash
./build.sh                     # tests + lint + dist/automaticdark-2.0.0.{xpi,zip}
```

1. Upload `dist/automaticdark-2.0.0.zip` at <https://addons.mozilla.org/developers/> →
   *Submit a new add-on* → **On your own** (self-distribution). First submission can take
   a review cycle; subsequent versions are usually signed automatically.
2. Download the signed XPI that AMO returns. Install it in Firefox via
   *Settings → Extensions → gear icon → Install Add-on From File…*, or serve it over HTTPS
   for other devices.
3. Optional — automatic updates for your users:

   ```bash
   ./tools/mkupdates.sh dist/automaticdark-2.0.1.xpi https://example.com/addons/
   # paste the JSON into https://example.com/addons/updates.json
   UPDATE_URL=https://example.com/addons/updates.json ./build.sh
   ```

   The `update_url` is written into the packaged manifest, so the shipped build points at
   your server. Bump `version` in `manifest.json` for every release: the update manifest
   compares versions.

The add-on id lives in `manifest.json` → `browser_specific_settings.gecko.id`. Change it
once, before the first signing, if you want your fork to be a separate add-on rather than
an update path for the upstream listing.

Temporary install without signing, for development:

```bash
web-ext run --source-dir .          # or about:debugging → Load Temporary Add-on
```

---

## Development

```bash
node --test test/     # 27 tests: schedule unit tests, background smoke test, packaging
./build.sh            # tests + lint + package
./build.sh --fast     # package only
```

| Path | Purpose |
| --- | --- |
| `js/schedule.js` | Pure scheduling: settings → slot → theme/scheme. No browser API. |
| `js/utils.js` | Time and storage helpers, no DOM, no browser API beyond `storage`. |
| `js/common.js` | Everything that touches the browser: theme application, colour scheme, alarms, toolbar, messaging. |
| `js/background.js` | Event wiring and startup. |
| `js/content.js` | Per-site colour-scheme override, and reports the page-level `prefers-color-scheme` value back to the background page. |
| `js/options.js` | Options page (no framework, no build step). |
| `lib/suncalc.js` | SunCalc v2.1.4, wrapped for classic-script use. |
| `test/` | `node --test` suites; not shipped. |
| `build.sh`, `tools/` | Packaging and the self-hosted update manifest helper. |

`dist/` is a symlink to `~/dev/_noupload/time-based-themes/dist` so build artefacts never
land in the synced tree.

---

## Issue status

All 38 issues open at the time of the rewrite, and what happened to each one. “Fixed”
means a code path now behaves as the report asked; “documented” means the request is
answered in the README or in the UI instead of the code.

| # | Issue | Status |
| --- | --- | --- |
| [#75](https://github.com/skhzhang/time-based-themes/issues/75) | Outdated SunCalc version | **Fixed** — SunCalc v2.1.4 vendored. |
| [#66](https://github.com/skhzhang/time-based-themes/issues/66) | Firefox for Android install | **Fixed** — `gecko_android` declared, optional APIs feature-detected. |
| [#65](https://github.com/skhzhang/time-based-themes/issues/65) | Cannot select the automatic option after granting location | **Fixed** — the mode is selectable while the position request is pending, and it falls back to manual coordinates on refusal or timeout. |
| [#64](https://github.com/skhzhang/time-based-themes/issues/64) | System theme detected but never re-applied | **Fixed** — `theme.onUpdated` + 1-minute tick, and the OS value is re-read instead of cached in storage. |
| [#63](https://github.com/skhzhang/time-based-themes/issues/63) | New tab wallpaper colour not switched | **Fixed** — theme images are inlined before `theme.update()` so the new tab background survives. |
| [#62](https://github.com/skhzhang/time-based-themes/issues/62) | Theme changes but the light/dark scheme does not | **Fixed** — `overrideContentColorScheme` is applied together with the theme. |
| [#61](https://github.com/skhzhang/time-based-themes/issues/61) | Preview themes | **Fixed** — Preview button applies the candidate theme for 20 s then restores the schedule. |
| [#60](https://github.com/skhzhang/time-based-themes/issues/60) | Search bar for the theme list | **Fixed** — filter box above both theme pickers. |
| [#59](https://github.com/skhzhang/time-based-themes/issues/59) | Location permission cannot be granted | **Fixed** — request happens on a click from the options page, with an explicit error and a manual fallback. |
| [#57](https://github.com/skhzhang/time-based-themes/issues/57) | Offset in minutes from sunrise/sunset | **Fixed** — ± N minutes for both, wrapping across midnight. |
| [#56](https://github.com/skhzhang/time-based-themes/issues/56) | Solarized Dark/Light support | **Fixed** — any installed theme, or the Solarized theme JSON pasted into the custom fields. |
| [#53](https://github.com/skhzhang/time-based-themes/issues/53) | Theme not changed without user interaction | **Fixed** — alarm, startup, resume and install all tick; no interaction needed. |
| [#52](https://github.com/skhzhang/time-based-themes/issues/52) | Random theme chooser | **Fixed** — random pool + interval in hours. |
| [#51](https://github.com/skhzhang/time-based-themes/issues/51) | Manual location | **Fixed** — latitude/longitude fields, no geolocation needed. |
| [#49](https://github.com/skhzhang/time-based-themes/issues/49) | Choice of time-switch | **Fixed** — sunrise/sunset, manual times, system theme, plus arbitrary extra slots. |
| [#48](https://github.com/skhzhang/time-based-themes/issues/48) | Firefox Color support | **Fixed** — paste a Firefox Color JSON as a custom day/night theme. |
| [#47](https://github.com/skhzhang/time-based-themes/issues/47) | HMC Console Interface Web | **Documented** — the report describes an unrelated web console, not this extension; no code change was possible. |
| [#46](https://github.com/skhzhang/time-based-themes/issues/46) | Theme switch | **Fixed** — toolbar toggle and extra slots cover switching on demand and on a schedule. |
| [#45](https://github.com/skhzhang/time-based-themes/issues/45) | System theme does not work on 1.4.1 | **Fixed** — same root cause as #43/#64. |
| [#43](https://github.com/skhzhang/time-based-themes/issues/43) | System theme detection does not work | **Fixed** — OS state is read from the active theme and from `theme.onUpdated`. |
| [#42](https://github.com/skhzhang/time-based-themes/issues/42) | System theme not working on Ubuntu | **Fixed** — detection no longer depends on a `storage.onChanged` event that never fired. |
| [#37](https://github.com/skhzhang/time-based-themes/issues/37) | Personal data collection policy | **Fixed** — [PRIVACY.md](PRIVACY.md) and `data_collection_permissions: none`. |
| [#36](https://github.com/skhzhang/time-based-themes/issues/36) | Toolbar toggle for a temporary override | **Fixed** — click toggles day/night until the next transition. |
| [#30](https://github.com/skhzhang/time-based-themes/issues/30) | Override web page colour scheme | **Fixed** — per-slot *always light / always dark / follow theme*. |
| [#29](https://github.com/skhzhang/time-based-themes/issues/29) | Thunderbird support | **Documented** — Thunderbird's theme API is incompatible; out of scope for this package. |
| [#28](https://github.com/skhzhang/time-based-themes/issues/28) | Offset in automatic mode | **Fixed** — offsets apply to computed sun times too. |
| [#26](https://github.com/skhzhang/time-based-themes/issues/26) | DRM checkbox gets unchecked | **Fixed** — the theme is only re-applied on a real change, never on every event. |
| [#24](https://github.com/skhzhang/time-based-themes/issues/24) | Toolbar button to toggle two themes | **Fixed** — same as #36. |
| [#20](https://github.com/skhzhang/time-based-themes/issues/20) | Whitelist | **Fixed** — per-site colour-scheme override list. |
| [#19](https://github.com/skhzhang/time-based-themes/issues/19) | Reader mode light/dark themes | **Fixed** — Reader follows `overrideContentColorScheme`. |
| [#17](https://github.com/skhzhang/time-based-themes/issues/17) | Change only once a day | **Fixed** — transitions only; unchanged ticks are no-ops. |
| [#16](https://github.com/skhzhang/time-based-themes/issues/16) | Switch missed when the OS changes theme during sleep | **Fixed** — the state is recomputed on resume/focus and applied if it differs. |
| [#14](https://github.com/skhzhang/time-based-themes/issues/14) | Devtools not affected | **Fixed** — devtools follow the content colour scheme. |
| [#12](https://github.com/skhzhang/time-based-themes/issues/12) | macOS needs window focus to switch | **Fixed** — the alarm ticks in the background; focus is only an extra trigger. |
| [#11](https://github.com/skhzhang/time-based-themes/issues/11) | System theme not working on macOS | **Fixed** — same root cause as #43. |
| [#9](https://github.com/skhzhang/time-based-themes/issues/9) | Set `ui.systemUsesDarkTheme` over time | **Fixed** — replaced by `overrideContentColorScheme`, which is the supported API. |
| [#7](https://github.com/skhzhang/time-based-themes/issues/7) | Additional themes/times | **Fixed** — extra slots with their own time, theme and scheme. |
| [#5](https://github.com/skhzhang/time-based-themes/issues/5) | Times are offset | **Fixed** — DST-safe local minutes plus an explicit timezone override. |

---

## Credits

- Original extension by [Simon Zhang](https://github.com/skhzhang).
- Sun position by [SunCalc](https://github.com/mourner/suncalc) (BSD-2-Clause).
- Licence: MPL-2.0, see [LICENSE](LICENSE).
