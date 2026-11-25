# automaticDark — time-based theme changer

Switch your Firefox theme at sunrise and sunset, at times you pick, or together with your
operating system's light/dark appearance.

This is a **fork** of [skhzhang/time-based-themes](https://github.com/skhzhang/time-based-themes).
It keeps the original name, data model and settings (1.x settings still load) and addresses
**all 38 issues that were open upstream** — [issue list](https://github.com/skhzhang/time-based-themes/issues?q=is%3Aissue+is%3Aopen+sort%3Aupdated-desc).
The 2.0.x line is a rewrite around one scheduling routine; most of the long-standing reports
turned out to share a handful of root causes.

## What the 38 issues changed

- **Scheduling** — sunrise/sunset, manual times, system appearance, plus extra slots with
  their own time, theme and scheme; offsets in minutes; “change once a day”; DST-safe local
  minutes with an optional timezone override.
- **System theme** — the OS appearance is read live (alarm, resume, focus) instead of being
  cached in storage, so it no longer needs a window click or a web page to be open, works on
  macOS, Linux and Windows, and survives sleep/wake.
- **Applying a theme** — the enabled theme is verified after every switch, so a theme that
  Firefox reports as “enabled” but has not painted is detected and forced; the extension
  never repaints a theme it was not asked to paint (which used to untick the DRM checkbox).
- **Location** — permission is requested from a real click, manual latitude/longitude work,
  polar day/night is detected instead of producing `NaN`.
- **Themes** — any installed theme, Solarized and Firefox Color JSON as custom themes, a
  search box in both pickers, a 20-second preview, and per-slot content scheme
  (always light / always dark / follow theme) with a per-site override list.
- **Toolbar** — the icon opens the settings; the context menu switches to the other theme
  until the next transition.
- **Privacy** — nothing leaves the machine: see [PRIVACY.md](PRIVACY.md).

Out of scope: [#29](https://github.com/skhzhang/time-based-themes/issues/29) (Thunderbird's
theme API is incompatible) and [#47](https://github.com/skhzhang/time-based-themes/issues/47)
(unrelated web console, not this extension).

## Install

Self-hosted: the package is signed on addons.mozilla.org as an **unlisted** add-on and
installed from here. Auto-updates are served by
[updates.json](https://git.drop.tf/Gliglue/time-based-themes/raw/branch/master/updates.json),
wired through `update_url` in the manifest.

```bash
./build.sh          # tests + lint + dist/automaticdark-<version>.zip
./build.sh --fast   # package only
```

Build output goes to `dist/` (a symlink outside the synced tree).

## Credits

- Original extension by [Simon Zhang](https://github.com/skhzhang).
- Sun position by [SunCalc](https://github.com/mourner/suncalc) (BSD-2-Clause).
- Licence: MPL-2.0, see [LICENSE](LICENSE).
