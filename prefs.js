// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Mirrors the helper interface exported by extension.js, used to list
// open windows so their WM_CLASS can be picked instead of typed in.
const HelperIface = `
<node>
  <interface name="org.gnome.Shell.Extensions.GameDPI">
    <method name="GetWindowList">
      <arg name="windows" direction="out" type="a(ss)"/>
    </method>
  </interface>
</node>`;
const HelperProxy = Gio.DBusProxy.makeProxyWrapper(HelperIface);

// Just enough of Mutter's DisplayConfig to read the scales the current
// display actually supports.
const DisplayConfigIface = `
<node>
  <interface name="org.gnome.Mutter.DisplayConfig">
    <method name="GetCurrentState">
      <arg name="serial" direction="out" type="u"/>
      <arg name="monitors" direction="out" type="a((ssss)a(siiddada{sv})a{sv})"/>
      <arg name="logical_monitors" direction="out" type="a(iiduba(ssss)a{sv})"/>
      <arg name="properties" direction="out" type="a{sv}"/>
    </method>
  </interface>
</node>`;
const DisplayConfigProxy = Gio.DBusProxy.makeProxyWrapper(DisplayConfigIface);

const FALLBACK_SCALES = [1.0, 1.25, 1.5, 1.75, 2.0];

function unpackMaybeVariant(v) {
    return v instanceof GLib.Variant ? v.deep_unpack() : v;
}

export default class GameDpiPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        window.add(page);

        const generalGroup = new Adw.PreferencesGroup({title: _('Behavior')});
        page.add(generalGroup);

        const fullscreenRow = new Adw.SwitchRow({
            title: _('Treat fullscreen windows as games'),
            subtitle: _('Apply the game scale to any fullscreen window automatically'),
        });
        settings.bind('treat-fullscreen-as-game', fullscreenRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(fullscreenRow);

        const scaleRow = new Adw.ComboRow({
            title: _('Scale while a game is focused'),
            subtitle: _('Only scales your display currently supports are offered'),
        });
        generalGroup.add(scaleRow);
        this._populateScaleRow(scaleRow, settings);

        const activeMonitorRow = new Adw.SwitchRow({
            title: _('Only rescale the monitor showing the game'),
            subtitle: _('Leave other monitors at their current scale (multi-monitor, non-mirrored setups only)'),
        });
        settings.bind('only-scale-active-monitor', activeMonitorRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        generalGroup.add(activeMonitorRow);

        this._buildIdListSection(page, settings, {
            key: 'game-app-ids',
            groupTitle: _('Game windows'),
            groupDescription: _('Windows whose WM_CLASS matches an entry below are always treated as games, even when windowed.'),
            addTitle: _('WM_CLASS to add'),
        });

        this._buildIdListSection(page, settings, {
            key: 'ignored-app-ids',
            groupTitle: _('Never treat as games'),
            groupDescription: _('Windows whose WM_CLASS matches an entry below are never treated as a game, even fullscreen. Useful for browsers and video players.'),
            addTitle: _('WM_CLASS to add'),
        });
    }

    _populateScaleRow(scaleRow, settings) {
        const applyScales = scales => {
            const model = new Gtk.StringList();
            for (const s of scales)
                model.append(`${Math.round(s * 100)}%`);
            scaleRow.model = model;

            const current = settings.get_double('game-scale');
            let closestIndex = 0;
            let closestDiff = Infinity;
            scales.forEach((s, i) => {
                const diff = Math.abs(s - current);
                if (diff < closestDiff) {
                    closestDiff = diff;
                    closestIndex = i;
                }
            });
            scaleRow.selected = closestIndex;

            scaleRow.connect('notify::selected', () => {
                const idx = scaleRow.selected;
                if (idx >= 0 && idx < scales.length)
                    settings.set_double('game-scale', scales[idx]);
            });
        };

        try {
            const proxy = new DisplayConfigProxy(Gio.DBus.session,
                'org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig');
            const [, monitors] = proxy.GetCurrentStateSync();

            const scaleSet = new Set();
            for (const [, modes] of monitors) {
                const current = modes.find(m => unpackMaybeVariant(m[6]['is-current']) === true);
                if (current)
                    current[5].forEach(s => scaleSet.add(Math.round(s * 1000) / 1000));
            }

            const scales = scaleSet.size > 0 ? [...scaleSet].sort((a, b) => a - b) : FALLBACK_SCALES;
            applyScales(scales);
        } catch (e) {
            console.error(`GameDPI: could not query supported display scales, offering common defaults: ${e}`);
            applyScales(FALLBACK_SCALES);
        }
    }

    _buildIdListSection(page, settings, {key, groupTitle, groupDescription, addTitle}) {
        const group = new Adw.PreferencesGroup({title: groupTitle, description: groupDescription});
        page.add(group);

        const addRow = new Adw.EntryRow({title: addTitle});

        const pickButton = new Gtk.Button({
            icon_name: 'find-location-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: _('Pick from an open window'),
        });
        addRow.add_suffix(pickButton);

        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
            tooltip_text: _('Add to the list'),
        });
        addRow.add_suffix(addButton);
        group.add(addRow);

        const listGroup = new Adw.PreferencesGroup();
        page.add(listGroup);

        const addId = id => {
            id = id.trim();
            if (!id)
                return;
            const ids = settings.get_strv(key);
            if (!ids.includes(id)) {
                ids.push(id);
                settings.set_strv(key, ids);
            }
        };

        const removeId = id => {
            settings.set_strv(key, settings.get_strv(key).filter(i => i !== id));
        };

        const rows = new Map();
        const rebuildRows = () => {
            for (const row of rows.values())
                listGroup.remove(row);
            rows.clear();

            for (const id of settings.get_strv(key)) {
                const row = new Adw.ActionRow({title: id});
                const removeButton = new Gtk.Button({
                    icon_name: 'list-remove-symbolic',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                removeButton.connect('clicked', () => removeId(id));
                row.add_suffix(removeButton);
                listGroup.add(row);
                rows.set(id, row);
            }
        };

        settings.connect(`changed::${key}`, rebuildRows);
        rebuildRows();

        addButton.connect('clicked', () => {
            addId(addRow.get_text());
            addRow.set_text('');
        });
        addRow.connect('entry-activated', () => {
            addId(addRow.get_text());
            addRow.set_text('');
        });

        pickButton.connect('clicked', () => this._showWindowPicker(pickButton, addRow));
    }

    _showWindowPicker(anchorButton, addRow) {
        let windows;
        try {
            const proxy = new HelperProxy(Gio.DBus.session, 'org.gnome.Shell',
                '/org/gnome/Shell/Extensions/GameDPI');
            [windows] = proxy.GetWindowListSync();
        } catch (e) {
            console.error(`GameDPI: could not list open windows (is the extension enabled?): ${e}`);
            return;
        }

        if (!windows || windows.length === 0)
            return;

        const dialog = new Adw.Dialog({
            title: _('Choose a Window'),
            content_width: 440,
            content_height: 520,
        });

        const listBox = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            margin_top: 12, margin_bottom: 12, margin_start: 12, margin_end: 12,
        });
        listBox.add_css_class('boxed-list');

        for (const [wmClass, title] of windows) {
            const row = new Adw.ActionRow({title, subtitle: wmClass, activatable: true});
            row.connect('activated', () => {
                addRow.set_text(wmClass);
                dialog.close();
            });
            listBox.append(row);
        }

        const scroller = new Gtk.ScrolledWindow({child: listBox, vexpand: true});

        const toolbarView = new Adw.ToolbarView();
        toolbarView.add_top_bar(new Adw.HeaderBar());
        toolbarView.set_content(scroller);

        dialog.set_child(toolbarView);
        dialog.present(anchorButton);
    }
}
