#!/usr/bin/env bash
# Leave the staff weighing terminal, on purpose.
#
# Bound to Ctrl+Alt+Shift+F12 as the one GNOME custom keybinding the kiosk
# answers. Everything else that can close Chrome -- Ctrl+Shift+Q, Ctrl+W,
# Alt+F4, F11, a stray devtools key, a crashed renderer -- is not an exit: the
# unit restarts on any non-zero exit, so the terminal comes straight back and
# the operator is where they were. This is the only path that stops it for good.
#
# It disables as well as stops, so an exit meant to last does not quietly
# return at the next boot. scripts/kiosk-start.sh, or `npm run kiosk:start`,
# brings it back.

set -euo pipefail

KIOSK_UNIT="${KIOSK_UNIT:-weighing-kiosk.service}"
PROFILE_DIR="${PROFILE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/weighing-kiosk}"

log() { printf '%s kiosk-exit: %s\n' "$(date -Is)" "$*"; }

log "leaving the kiosk on request"

# --now stops the unit, which is what tears the inhibitor down and takes Chrome
# with it. disable is separate and has to happen after the stop succeeds, so a
# kiosk that refused to stop is left enabled and visibly still up rather than
# silently disarmed for the next boot.
if systemctl --user stop "$KIOSK_UNIT"; then
  systemctl --user disable "$KIOSK_UNIT"
  log "stopped and disabled $KIOSK_UNIT"
else
  log "could not stop $KIOSK_UNIT, leaving it enabled"
  exit 1
fi

# The stop kills the cgroup, but a Chrome that was mid-exec when the signal
# arrived can survive as an orphan and keep the profile lock. That lock is what
# makes the next kiosk start open a tab in a dead window, so clear it here.
if pgrep -f -- "--user-data-dir=${PROFILE_DIR}" > /dev/null 2>&1; then
  pkill -f -- "--user-data-dir=${PROFILE_DIR}" || true
  for _ in $(seq 1 10); do
    pgrep -f -- "--user-data-dir=${PROFILE_DIR}" > /dev/null 2>&1 || break
    sleep 1
  done
  pkill -9 -f -- "--user-data-dir=${PROFILE_DIR}" > /dev/null 2>&1 || true
fi
rm -rf "${PROFILE_DIR}/SingletonLock" "${PROFILE_DIR}/SingletonCookie" "${PROFILE_DIR}/SingletonSocket"

log "staff terminal is closed; the desktop is yours"
log "to bring it back: systemctl --user enable --now $KIOSK_UNIT"
