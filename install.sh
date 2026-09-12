#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Symlinks this repo into the GNOME Shell extensions directory and
# compiles its gsettings schema. Re-run after pulling changes.
set -euo pipefail

UUID="gamedpi@keyloggerforfree"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$(dirname "$DEST_DIR")"

if [ -e "$DEST_DIR" ] && [ ! -L "$DEST_DIR" ]; then
    echo "error: $DEST_DIR already exists and is not a symlink; remove it first" >&2
    exit 1
fi

ln -sfn "$SRC_DIR" "$DEST_DIR"
glib-compile-schemas "$SRC_DIR/schemas"

echo "Installed to $DEST_DIR"
echo "Now log out and back in (Wayland) or press Alt+F2, r, Enter (X11),"
echo "then run: gnome-extensions enable $UUID"
