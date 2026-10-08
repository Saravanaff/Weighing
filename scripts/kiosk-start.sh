#!/usr/bin/env bash
# Bring the staff weighing terminal back after scripts/kiosk-exit.sh.
#
# The exit path disables the unit so an exit that was meant to last does not
# return at the next boot. This undoes that, and is the other half of
# Ctrl+Alt+Shift+F12.

set -euo pipefail

KIOSK_UNIT="${KIOSK_UNIT:-weighing-kiosk.service}"

log() { printf '%s kiosk-start: %s\n' "$(date -Is)" "$*"; }

# The display has to exist before Chrome does. kiosk.sh waits for it too, but
# a kiosk started from a plain terminal has no DISPLAY of its own to inherit,
# so the unit is started the same way the session starts it.
if [ -z "${WAYLAND_DISPLAY:-}" ] && [ -z "${DISPLAY:-}" ]; then
  log "no DISPLAY or WAYLAND_DISPLAY here, leaving that to kiosk.sh to resolve"
fi

log "enabling and starting $KIOSK_UNIT"
systemctl --user enable --now "$KIOSK_UNIT"
log "staff terminal is coming back"
