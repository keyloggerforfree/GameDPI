// SPDX-License-Identifier: GPL-2.0-or-later
//
// GameDPI: forces display scaling to a fixed factor (100% by default)
// while a game window is focused, and restores the exact prior
// per-monitor configuration as soon as it loses focus.
//
// Scaling is changed through Mutter's org.gnome.Mutter.DisplayConfig
// D-Bus interface (the same one `gnome-randr`-style tools use), since
// the legacy org.gnome.desktop.interface scaling-factor gsettings key
// does not affect fractional/per-monitor scaling under Wayland. Every
// change is verified (DisplayConfig "Verify" method) before it is
// actually applied ("Temporary" method, never written to monitors.xml),
// so a layout Mutter would reject is skipped instead of failing loudly.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const DisplayConfigIface = `
<node>
  <interface name="org.gnome.Mutter.DisplayConfig">
    <method name="GetCurrentState">
      <arg name="serial" direction="out" type="u"/>
      <arg name="monitors" direction="out" type="a((ssss)a(siiddada{sv})a{sv})"/>
      <arg name="logical_monitors" direction="out" type="a(iiduba(ssss)a{sv})"/>
      <arg name="properties" direction="out" type="a{sv}"/>
    </method>
    <method name="ApplyMonitorsConfig">
      <arg name="serial" direction="in" type="u"/>
      <arg name="method" direction="in" type="u"/>
      <arg name="logical_monitors" direction="in" type="a(iiduba(ssa{sv}))"/>
      <arg name="properties" direction="in" type="a{sv}"/>
    </method>
    <signal name="MonitorsChanged"/>
  </interface>
</node>`;

const DisplayConfigProxy = Gio.DBusProxy.makeProxyWrapper(DisplayConfigIface);

// Small helper interface exported by this extension while it is enabled,
// purely so the preferences window (a separate process) can list open
// windows to pick a WM_CLASS from, without hunting through Looking Glass.
// Note: the prefs window itself is a normal window too and may show up
// in this list - nothing on the Shell side can reliably tell it apart
// from any other GTK app, so it's left to the user to recognize and
// ignore it.
const HelperIface = `
<node>
  <interface name="org.gnome.Shell.Extensions.GameDPI">
    <method name="GetWindowList">
      <arg name="windows" direction="out" type="a(ss)"/>
    </method>
  </interface>
</node>`;

const APPLY_METHOD_VERIFY = 0;
const APPLY_METHOD_TEMPORARY = 1;

// GLib.Variant values inside a{sv} dicts come back either already
// unpacked or as a GLib.Variant, depending on GJS version. Normalize.
function unpackMaybeVariant(v) {
    if (v instanceof GLib.Variant)
        return v.deep_unpack();
    return v;
}

export default class GameDpiExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._proxy = null;
        this._savedLogicalMonitors = null;
        this._gameModeActive = false;
        this._transitioning = false;
        this._focusWindow = null;
        this._fullscreenId = 0;
        this._monitorsChangedId = 0;
        this._retryId = 0;
        this._applyingOwnChange = false;

        this._createProxy();

        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(HelperIface, this);
        this._dbusImpl.export(Gio.DBus.session, '/org/gnome/Shell/Extensions/GameDPI');

        this._focusId = global.display.connect('notify::focus-window',
            () => this._onFocusChanged());
        this._onFocusChanged();
    }

    disable() {
        if (this._focusId) {
            global.display.disconnect(this._focusId);
            this._focusId = 0;
        }
        this._disconnectFullscreenWatch();

        if (this._retryId) {
            GLib.source_remove(this._retryId);
            this._retryId = 0;
        }

        if (this._proxy && this._monitorsChangedId) {
            this._proxy.disconnectSignal(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }

        if (this._dbusImpl) {
            this._dbusImpl.unexport();
            this._dbusImpl = null;
        }

        // Fire-and-forget the restore using the proxy/snapshot we already
        // have. Deliberately don't touch `this` from inside it (beyond
        // read-only helpers with no side effects) and don't null out
        // this._proxy until after kicking it off - the D-Bus round trip
        // outlives this call.
        if (this._gameModeActive && this._proxy && this._savedLogicalMonitors)
            this._restoreOnDisable(this._proxy, this._savedLogicalMonitors);

        this._proxy = null;
        this._settings = null;
        this._savedLogicalMonitors = null;
        this._gameModeActive = false;
        this._transitioning = false;
    }

    // --- D-Bus helper for prefs.js -----------------------------------

    GetWindowList() {
        const windows = global.display.get_tab_list(Meta.TabList.NORMAL, null);
        const seen = new Set();
        const result = [];
        for (const win of windows) {
            const wmClass = win.get_wm_class();
            if (!wmClass || seen.has(wmClass))
                continue;
            seen.add(wmClass);
            result.push([wmClass, win.get_title() || wmClass]);
        }
        return result;
    }

    // --- DisplayConfig proxy lifecycle -----------------------------------

    _createProxy() {
        new DisplayConfigProxy(
            Gio.DBus.session,
            'org.gnome.Mutter.DisplayConfig',
            '/org/gnome/Mutter/DisplayConfig',
            (proxy, error) => {
                if (error) {
                    console.error(`GameDPI: failed to connect to DisplayConfig, retrying in 5s: ${error}`);
                    this._retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
                        this._retryId = 0;
                        this._createProxy();
                        return GLib.SOURCE_REMOVE;
                    });
                    return;
                }
                this._proxy = proxy;
                this._monitorsChangedId = proxy.connectSignal('MonitorsChanged',
                    () => this._onMonitorsChanged());
            }
        );
    }

    _onMonitorsChanged() {
        // Ignore the signal caused by our own ApplyMonitorsConfig calls.
        if (this._applyingOwnChange)
            return;

        if (this._gameModeActive) {
            console.log('GameDPI: monitor configuration changed externally while active; dropping saved scale to avoid restoring a stale layout');
            this._savedLogicalMonitors = null;
            this._gameModeActive = false;
        }
    }

    // --- focus tracking -------------------------------------------------

    _disconnectFullscreenWatch() {
        if (this._focusWindow && this._fullscreenId)
            this._focusWindow.disconnect(this._fullscreenId);
        this._focusWindow = null;
        this._fullscreenId = 0;
    }

    _onFocusChanged() {
        this._disconnectFullscreenWatch();

        const win = global.display.focus_window;
        if (win) {
            this._focusWindow = win;
            // A window can go fullscreen (or leave it) without losing
            // focus, e.g. a game switching from windowed to fullscreen.
            this._fullscreenId = win.connect('notify::fullscreen',
                () => this._evaluate());
        }
        this._evaluate();
    }

    _isGameWindow(win) {
        if (!win || !this._settings)
            return false;

        const wmClass = (win.get_wm_class() || '').toLowerCase();

        const ignored = this._settings.get_strv('ignored-app-ids');
        if (wmClass && ignored.some(id => id.toLowerCase() === wmClass))
            return false;

        if (this._settings.get_boolean('treat-fullscreen-as-game') && win.is_fullscreen())
            return true;

        const ids = this._settings.get_strv('game-app-ids');
        if (!wmClass || ids.length === 0)
            return false;
        return ids.some(id => id.toLowerCase() === wmClass);
    }

    // --- scale switching --------------------------------------------------

    _evaluate() {
        if (this._transitioning || !this._settings)
            return;

        const desired = this._isGameWindow(global.display.focus_window);
        if (desired === this._gameModeActive)
            return;

        this._transitioning = true;
        const onDone = () => {
            this._transitioning = false;
            // Only recurse if the world actually moved on while we were
            // transitioning (e.g. fast alt-tabbing). If nothing changed,
            // stop here - otherwise a persistent failure (no proxy, every
            // config rejected, ...) would recurse forever.
            if (this._isGameWindow(global.display.focus_window) !== desired)
                this._evaluate();
        };

        if (desired)
            this._activateGameScale(onDone);
        else
            this._restoreScale(onDone);
    }

    _activateGameScale(onDone) {
        if (!this._proxy) {
            onDone();
            return;
        }

        const onlyActiveMonitor = this._settings.get_boolean('only-scale-active-monitor');
        const gameMonitorPos = onlyActiveMonitor
            ? this._getWindowMonitorPos(global.display.focus_window) : null;
        if (onlyActiveMonitor && !gameMonitorPos) {
            // Couldn't resolve which monitor the game is on; skip for now,
            // a later focus/fullscreen event will retry.
            onDone();
            return;
        }

        const targetScale = this._settings.get_double('game-scale');

        this._proxy.GetCurrentStateRemote((result, error) => {
            if (error) {
                console.error(`GameDPI: GetCurrentState failed: ${error}`);
                onDone();
                return;
            }

            const [serial, monitors, logicalMonitors, properties] = result;

            let layout;
            try {
                layout = this._computeGameLayout(
                    logicalMonitors, monitors, targetScale, onlyActiveMonitor, gameMonitorPos);
            } catch (e) {
                console.error(`GameDPI: ${e.message}`);
                onDone();
                return;
            }

            const snapshot = this._snapshotLogicalMonitors(logicalMonitors);

            if (!layout.changed) {
                // Every monitor that should change is already at the
                // target scale - nothing to apply. Still remember the
                // snapshot so unfocus restores whatever was there before.
                this._savedLogicalMonitors = snapshot;
                this._gameModeActive = true;
                onDone();
                return;
            }

            const applyProps = this._layoutModeProperties(properties);
            this._verifyAndApply(serial, layout.logicalMonitors, applyProps, ok => {
                if (ok) {
                    this._savedLogicalMonitors = snapshot;
                    this._gameModeActive = true;
                }
                onDone();
            });
        });
    }

    _restoreScale(onDone) {
        if (!this._proxy || !this._savedLogicalMonitors) {
            this._gameModeActive = false;
            this._savedLogicalMonitors = null;
            onDone();
            return;
        }

        const saved = this._savedLogicalMonitors;
        this._proxy.GetCurrentStateRemote((result, error) => {
            if (error) {
                console.error(`GameDPI: GetCurrentState (restore) failed: ${error}`);
                this._gameModeActive = false;
                this._savedLogicalMonitors = null;
                onDone();
                return;
            }

            const [serial, monitors, , properties] = result;

            let newLogicalMonitors;
            try {
                newLogicalMonitors = saved.map(({x, y, scale, transform, primary, connectors}) =>
                    this._buildLogicalMonitor(x, y, scale, transform, primary,
                        connectors.map(connector => [connector]), monitors));
            } catch (e) {
                console.error(`GameDPI: ${e.message}`);
                this._gameModeActive = false;
                this._savedLogicalMonitors = null;
                onDone();
                return;
            }

            const applyProps = this._layoutModeProperties(properties);
            this._verifyAndApply(serial, newLogicalMonitors, applyProps, () => {
                // Whether it succeeded or Mutter rejected it, we're done
                // trying to track the original config - don't keep
                // retrying against a config Mutter has already refused.
                this._gameModeActive = false;
                this._savedLogicalMonitors = null;
                onDone();
            });
        });
    }

    // Restore path used only from disable(). Deliberately takes proxy and
    // saved state as parameters and never reads or writes `this._proxy`,
    // `this._settings` etc., since disable() clears those before this
    // async chain finishes.
    _restoreOnDisable(proxy, saved) {
        proxy.GetCurrentStateRemote((result, error) => {
            if (error) {
                console.error(`GameDPI: GetCurrentState (disable-time restore) failed: ${error}`);
                return;
            }

            const [serial, monitors, , properties] = result;
            let newLogicalMonitors;
            try {
                newLogicalMonitors = saved.map(({x, y, scale, transform, primary, connectors}) =>
                    this._buildLogicalMonitor(x, y, scale, transform, primary,
                        connectors.map(connector => [connector]), monitors));
            } catch (e) {
                console.error(`GameDPI: ${e.message}`);
                return;
            }

            const applyProps = this._layoutModeProperties(properties);
            proxy.ApplyMonitorsConfigRemote(serial, APPLY_METHOD_VERIFY, newLogicalMonitors, applyProps,
                (r1, e1) => {
                    if (e1) {
                        console.error(`GameDPI: disable-time restore rejected: ${e1}`);
                        return;
                    }
                    proxy.ApplyMonitorsConfigRemote(serial, APPLY_METHOD_TEMPORARY, newLogicalMonitors, applyProps,
                        (r2, e2) => {
                            if (e2)
                                console.error(`GameDPI: disable-time restore failed: ${e2}`);
                        });
                });
        });
    }

    _verifyAndApply(serial, logicalMonitors, properties, onResult) {
        // Guards against disable() having run (and nulled the proxy)
        // while we were in the middle of an async GetCurrentState call.
        if (!this._proxy) {
            onResult(false);
            return;
        }

        this._applyingOwnChange = true;
        this._proxy.ApplyMonitorsConfigRemote(serial, APPLY_METHOD_VERIFY, logicalMonitors, properties,
            (result, error) => {
                if (error) {
                    this._applyingOwnChange = false;
                    console.error(`GameDPI: proposed monitor configuration was rejected, skipping: ${error}`);
                    onResult(false);
                    return;
                }
                this._proxy.ApplyMonitorsConfigRemote(serial, APPLY_METHOD_TEMPORARY, logicalMonitors, properties,
                    (result2, error2) => {
                        this._applyingOwnChange = false;
                        if (error2) {
                            console.error(`GameDPI: ApplyMonitorsConfig failed: ${error2}`);
                            onResult(false);
                            return;
                        }
                        onResult(true);
                    });
            });
    }

    // --- monitor/layout helpers -------------------------------------------

    // Position (in the layout coordinate space shared by Meta.Window's
    // monitor index and DisplayConfig's logical monitors) of the monitor
    // a window is currently on, or null if it can't be determined.
    _getWindowMonitorPos(win) {
        if (!win)
            return null;
        const index = win.get_monitor();
        if (index < 0)
            return null;
        const monitor = Main.layoutManager.monitors[index];
        return monitor ? {x: monitor.x, y: monitor.y} : null;
    }

    _samePos(pos, x, y) {
        return !!pos && pos.x === x && pos.y === y;
    }

    _layoutModeProperties(properties) {
        const layoutMode = unpackMaybeVariant(properties?.['layout-mode']);
        if (layoutMode === undefined || layoutMode === null)
            return {};
        return {'layout-mode': new GLib.Variant('u', layoutMode)};
    }

    _snapToSupportedScale(scale, mode) {
        const supported = mode[5];
        if (!supported || supported.length === 0)
            return scale;
        let best = supported[0];
        let bestDiff = Math.abs(supported[0] - scale);
        for (const s of supported) {
            const diff = Math.abs(s - scale);
            if (diff < bestDiff) {
                best = s;
                bestDiff = diff;
            }
        }
        return best;
    }

    // Builds the logical-monitor layout used to switch into game mode:
    // the target scale (snapped to a scale the monitor actually supports)
    // is applied to the monitor(s) that should change, and every logical
    // monitor's origin is recomputed from scratch so that monitors whose
    // logical size changed never end up overlapping - Mutter rejects
    // overlapping layouts outright. Monitors are grouped into rows by
    // overlap of their *original* vertical extent (not exact y equality -
    // monitors placed side by side but aligned by center/bottom, which is
    // the norm when they have different physical heights, have different
    // y origins despite being in the same visual row), then packed
    // row-major in their original relative order. This preserves ordinary
    // layouts (single monitor, a row, a stack, a grid) regardless of
    // vertical/horizontal alignment offsets.
    //
    // Returns {logicalMonitors, changed}; `changed` is false when every
    // monitor already had its target scale, so the caller can skip
    // reapplying (and repositioning) an unchanged configuration.
    _computeGameLayout(logicalMonitors, monitors, targetScale, onlyActiveMonitor, gameMonitorPos) {
        const entries = logicalMonitors.map(([x, y, origScale, transform, primary, lmMonitors]) => {
            const connector = lmMonitors[0]?.[0];
            const mode = connector ? this._findCurrentMode(monitors, connector) : null;
            if (!mode)
                throw new Error(`no current mode reported for monitor ${connector ?? '?'}`);

            const matchesGame = !onlyActiveMonitor || this._samePos(gameMonitorPos, x, y);
            const scale = matchesGame ? this._snapToSupportedScale(targetScale, mode) : origScale;

            const rem = transform % 4;
            const rotated = rem === 1 || rem === 3;
            const pixelW = mode[1];
            const pixelH = mode[2];
            // Extent at the *original* scale - used only to figure out
            // which monitors are currently side by side vs. stacked, so
            // clustering doesn't depend on what the new scale ends up being.
            const origH = Math.round((rotated ? pixelW : pixelH) / origScale);
            const logicalW = Math.round((rotated ? pixelH : pixelW) / scale);
            const logicalH = Math.round((rotated ? pixelW : pixelH) / scale);

            return {
                origX: x, origY: y, origH, origScale, scale, transform, primary, lmMonitors,
                modeId: mode[0], logicalW, logicalH,
            };
        });

        const changed = entries.some(e => e.scale !== e.origScale);

        const remaining = [...entries];
        const rows = [];
        while (remaining.length > 0) {
            const row = [remaining.shift()];
            let absorbed = true;
            while (absorbed) {
                absorbed = false;
                for (let i = remaining.length - 1; i >= 0; i--) {
                    const e = remaining[i];
                    const overlapsRow = row.some(r =>
                        r.origY < e.origY + e.origH && e.origY < r.origY + r.origH);
                    if (overlapsRow) {
                        row.push(e);
                        remaining.splice(i, 1);
                        absorbed = true;
                    }
                }
            }
            rows.push(row);
        }
        rows.sort((a, b) => Math.min(...a.map(e => e.origY)) - Math.min(...b.map(e => e.origY)));
        for (const row of rows)
            row.sort((a, b) => a.origX - b.origX);

        const output = [];
        let curY = 0;
        for (const row of rows) {
            let curX = 0;
            let rowHeight = 0;
            for (const e of row) {
                const monitorsInput = e.lmMonitors.map(([connector]) => [connector, e.modeId, {}]);
                output.push([curX, curY, e.scale, e.transform, e.primary, monitorsInput]);
                curX += e.logicalW;
                rowHeight = Math.max(rowHeight, e.logicalH);
            }
            curY += rowHeight;
        }
        return {logicalMonitors: output, changed};
    }

    // Turns a saved/original logical-monitor entry into the shape
    // ApplyMonitorsConfig expects: monitors identified by (connector,
    // mode_id, properties) rather than the full 4-tuple identifier. Used
    // for restoring, where the origin and scale are kept exactly as they
    // were (no relayout needed - it was a valid config when captured).
    _buildLogicalMonitor(x, y, scale, transform, primary, lmMonitors, monitors) {
        const monitorsInput = lmMonitors.map(([connector]) => {
            const mode = this._findCurrentMode(monitors, connector);
            if (!mode)
                throw new Error(`no current mode reported for monitor ${connector}`);
            return [connector, mode[0], {}];
        });
        return [x, y, scale, transform, primary, monitorsInput];
    }

    // Returns the full current-mode tuple for a connector, or null if
    // none is flagged current. Never falls back to an arbitrary mode -
    // that could silently change the monitor's resolution.
    _findCurrentMode(monitors, connector) {
        const entry = monitors.find(([ids]) => ids[0] === connector);
        if (!entry)
            return null;

        const [, modes] = entry;
        return modes.find(([, , , , , , props]) =>
            unpackMaybeVariant(props['is-current']) === true) ?? null;
    }

    _snapshotLogicalMonitors(logicalMonitors) {
        return logicalMonitors.map(([x, y, scale, transform, primary, lmMonitors]) => ({
            x, y, scale, transform, primary,
            connectors: lmMonitors.map(([connector]) => connector),
        }));
    }
}
