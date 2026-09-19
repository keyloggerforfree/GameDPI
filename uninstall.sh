#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# Reverses install.sh: disables the extension and removes the symlink
# from the GNOME Shell extensions directory. Leaves this repo and your
# saved preferences (in dconf) untouched.
set -euo pipefail

UUID="gamedpi@keyloggerforfree"
DEST_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

gnome-extensions disable "$UUID" 2>/dev/null || true

if [ -L "$DEST_DIR" ]; then
    rm "$DEST_DIR"
    echo "Removed $DEST_DIR"
elif [ -e "$DEST_DIR" ]; then
    echo "error: $DEST_DIR exists but isn't a symlink; please remove it manually" >&2
    exit 1
else
    echo "Nothing installed at $DEST_DIR"
fi

echo "Your saved preferences are still in dconf under" \
     "/org/gnome/shell/extensions/gamedpi/ if you want to clear those too:"
echo "  dconf reset -f /org/gnome/shell/extensions/gamedpi/"
