# GameDPI

A GNOME Shell extension that switches display scaling to 100% (or
another scale you pick) while a game window is focused, and restores
the exact scaling from before as soon as it loses focus.

Wayland only — see "Known limitations" below.

## What this actually fixes

On GNOME Wayland, once your display scale is set to anything other than
100%, fullscreen games commonly end up rendering at a resolution well
above your monitor's native one, for no visual benefit — pure wasted
GPU work (lower framerates, more heat and fan noise, more power draw,
sometimes worse input latency). See "Why fractional scaling inflates
game resolution" under Technical details for the mechanism.

This extension sidesteps the problem entirely: while a game is focused
it forces the display scale to 100%, so the game gets a native-resolution
buffer with nothing to needlessly upscale, and switches your scale back
the moment you're done, so your regular desktop UI stays crisp.

## How it decides a window is "a game"

- **Fullscreen** — on by default. Any window that goes fullscreen is
  treated as a game, unless its WM_CLASS is on the ignore list below.
- **WM_CLASS list** — a list of window classes you maintain yourself in
  Preferences, for games you run windowed/borderless.
- **Ignore list** — WM_CLASS values that are *never* treated as a game,
  even fullscreen. Pre-seeded with common browsers and video players
  (Firefox, Chromium/Chrome, Brave, mpv, VLC), since "fullscreen" for
  those usually means a video, not a game. Takes priority over the
  other two rules.

Both lists have a picker button next to the add field that lists your
currently open windows so you can grab a WM_CLASS without having to
know it — note the Preferences window itself is a normal window too,
so it may show up in that list; just ignore it.

By default all monitors are rescaled together. If you have more than one
monitor and only want the one showing the game affected, turn on "Only
rescale the monitor showing the game" in Preferences — the extension
looks up which monitor the game window is on (`Meta.Window.get_monitor`)
and leaves every other monitor's scale untouched. This only makes sense
for extended (non-mirrored) layouts, and it's decided once when the game
gains focus — dragging the game to a different monitor mid-session
without any other focus change won't move the effect until focus
changes again.

## Install

```sh
./install.sh
gnome-extensions enable gamedpi@keyloggerforfree
```

`install.sh` symlinks this directory into
`~/.local/share/gnome-shell/extensions/` and compiles the gsettings
schema — it does **not** copy the files. Keep this repo where it is
after installing; moving, renaming, or deleting this directory breaks
the extension (GNOME will show it as missing/broken until you either
put it back or re-run `install.sh` from its new location). Re-run
`install.sh` whenever the schema changes. On Wayland you need to log
out and back in once after installing before GNOME picks up the
schema/extension.

Open settings with:

```sh
gnome-extensions prefs gamedpi@keyloggerforfree
```

## Known limitations

- **X11 sessions are not supported** — see Technical details.
- If GNOME Shell crashes, or the extension is force-disabled in a way
  that skips `disable()`, while a game is focused, the restore never
  fires — your monitors stay at the game scale until you fix it
  manually in Settings > Displays. A normal disable (including screen
  lock) does trigger the restore.
- If the monitor layout changes while a game is focused (a monitor is
  unplugged, or you change scaling yourself in Settings > Displays), the
  extension notices and gives up on restoring its own snapshot rather
  than clobbering your new setup — but it also won't try to reapply the
  game scale to the new layout until the next focus change.
- Multi-monitor setups: by default all monitors are scaled together;
  see "Only rescale the monitor showing the game" above for per-monitor
  behavior and its caveats. The relayout logic assumes non-mirrored,
  non-overlapping layouts (rows/columns/grids) — an unusual arrangement
  it can't reproduce safely is left unchanged and logged rather than
  guessed at.

## Technical details

### Why fractional scaling inflates game resolution

Most games (especially anything not natively Wayland/HiDPI-aware, which
includes most games running through Xwayland) don't participate in the
compositor's fractional scaling directly. GNOME instead hands them an
oversized backing buffer, scaled up so that after the compositor scales
it back down for the physical screen, it still looks "right" relative
to your desktop's UI scale.

Concretely: a 1920x1200 monitor running fractional scaling can end up
with a fullscreen game rendering internally at 3072x1920 — 1.6x the
actual pixel count in each dimension, i.e. roughly 2.5x the total
pixels the monitor can even display. That extra resolution is thrown
away by the downscale, so it buys nothing visually while still costing
GPU time every frame.

### How the scaling itself is changed

GNOME's legacy `org.gnome.desktop.interface scaling-factor` gsettings
key only supports whole-number scaling and is mostly ignored under
Wayland once fractional scaling is in play. So instead this talks
directly to Mutter's `org.gnome.Mutter.DisplayConfig` D-Bus interface
(the same API tools like `gnome-randr` use):

1. It reads the current monitor layout and snapshots it.
2. It builds a candidate layout with the target scale applied (snapped to
   whichever value your display's mode actually supports — Mutter only
   accepts a handful of discrete scales per mode, e.g. `1.0, 1.25, 1.333,
   1.5, 1.667, 2.0, 2.5`) and, since a monitor's logical size changes
   with its scale, recomputes every monitor's position so nothing
   overlaps.
3. It **verifies** that layout with Mutter (`ApplyMonitorsConfig`
   "Verify") before touching anything. If Mutter would reject it, the
   change is skipped and logged instead of failing loudly or leaving
   the extension stuck.
4. Only then does it apply it, as a **temporary** config, so nothing is
   ever written to `monitors.xml` — worst case is a scale that needs a
   manual nudge, never a corrupted saved display config.

On unfocus, the exact original snapshot is verified and re-applied the
same way. Preferences reads the same D-Bus interface to offer only
scales your display actually supports, instead of an arbitrary slider.

### Why X11 isn't supported

Under X11, Mutter's `DisplayConfig` interface reports a single global
integer `layout-mode` ("physical") instead of Wayland's per-monitor
logical/fractional scaling. This extension's whole approach — reading
and reapplying a per-monitor logical layout — assumes the Wayland
"logical" layout mode and doesn't handle the X11 case; it's written and
tested against Wayland's per-monitor fractional scaling only.
