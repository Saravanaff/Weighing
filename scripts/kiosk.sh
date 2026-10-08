#!/usr/bin/env bash
# Launch the staff weighing terminal as a Chrome kiosk.
#
# Run by weighing-kiosk.service at boot. Waits for the display server and for
# the weighing server to answer, then puts Chrome in kiosk mode full screen with
# a dedicated profile so it never fights with a normal browsing session.

set -euo pipefail

APP_URL="${APP_URL:-http://127.0.0.1:3001/staff/}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3001/api/health}"
PROFILE_DIR="${PROFILE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/weighing-kiosk}"
CHROME="${CHROME:-/usr/bin/google-chrome-stable}"
RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
SERVER_WAIT_SECONDS="${SERVER_WAIT_SECONDS:-120}"

log() { printf '%s kiosk: %s\n' "$(date -Is)" "$*"; }

# --- pick a display ---------------------------------------------------------
# A user unit gets no DISPLAY/WAYLAND_DISPLAY, so resolve them at runtime.
ozone_args=()
if [ -n "${WAYLAND_DISPLAY:-}" ] && [ -S "${RUNTIME_DIR}/${WAYLAND_DISPLAY}" ]; then
  ozone_args+=(--ozone-platform=wayland)
elif compgen -G "${RUNTIME_DIR}/wayland-*" > /dev/null; then
  wayland_socket="$(compgen -G "${RUNTIME_DIR}/wayland-*" | head -n 1)"
  export WAYLAND_DISPLAY="$(basename "$wayland_socket")"
  ozone_args+=(--ozone-platform=wayland)
elif [ -n "${DISPLAY:-}" ]; then
  :
elif compgen -G /tmp/.X11-unix/X\* > /dev/null; then
  export DISPLAY=":$(basename "$(compgen -G '/tmp/.X11-unix/X*' | head -n 1)" | sed 's/^X//')"
else
  log "no Wayland or X display found yet, waiting"
  for _ in $(seq 1 60); do
    sleep 2
    if compgen -G "${RUNTIME_DIR}/wayland-*" > /dev/null || compgen -G '/tmp/.X11-unix/X*' > /dev/null; then
      exec "$0" "$@"   # re-resolve from the top with the display now present
    fi
  done
  log "giving up: no display appeared within 120s"
  exit 1
fi

if [ -n "${WAYLAND_DISPLAY:-}" ] && [ "${WAYLAND_DISPLAY}" != "" ]; then
  export XDG_RUNTIME_DIR="$RUNTIME_DIR"
fi
log "display: WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-none} DISPLAY=${DISPLAY:-none}"

# --- wait for the weighing server ------------------------------------------
log "waiting for $HEALTH_URL"
deadline=$(( $(date +%s) + SERVER_WAIT_SECONDS ))
until curl -fsS -o /dev/null --max-time 3 "$HEALTH_URL"; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    log "server not reachable after ${SERVER_WAIT_SECONDS}s, starting anyway"
    break
  fi
  sleep 2
done

if [ ! -x "$CHROME" ]; then
  log "chrome not found at $CHROME"
  exit 1
fi

# --- clear leftovers --------------------------------------------------------
# A Chrome left over from a previous boot still holds the profile lock, and the
# new one would then open a tab in a dead window instead of a kiosk.
if pgrep -f -- "--user-data-dir=${PROFILE_DIR}" > /dev/null 2>&1; then
  log "stopping leftover chrome for this profile"
  pkill -f -- "--user-data-dir=${PROFILE_DIR}" || true
  for _ in $(seq 1 15); do
    pgrep -f -- "--user-data-dir=${PROFILE_DIR}" > /dev/null 2>&1 || break
    sleep 1
  done
  pkill -9 -f -- "--user-data-dir=${PROFILE_DIR}" > /dev/null 2>&1 || true
fi
rm -rf "${PROFILE_DIR}/SingletonLock" "${PROFILE_DIR}/SingletonCookie" "${PROFILE_DIR}/SingletonSocket"
mkdir -p "$PROFILE_DIR"

# --- keep the screen awake --------------------------------------------------
# The terminal has to stay readable with no one touching the machine, so hold
# the idle/sleep inhibitors for as long as the kiosk is up.
systemd-inhibit --what=idle:sleep --who="Weighing kiosk" --why="Staff weighing terminal must stay awake" \
  sleep infinity > /dev/null 2>&1 &
inhibit_pid=$!
trap 'kill "$inhibit_pid" 2>/dev/null || true' EXIT

# --- launch -----------------------------------------------------------------
log "starting chrome kiosk on $APP_URL"
exec "$CHROME" \
  --kiosk \
  --app="$APP_URL" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-session-crashed-bubble \
  --disable-infobars \
  --noerrdialogs \
  --check-for-update-interval=31536000 \
  --password-store=basic \
  --use-mock-keychain \
  --autoplay-policy=no-user-gesture-required \
  --overscroll-history-navigation=0 \
  --disable-features=Translate,MediaRouter,OptimizationHints \
  "${ozone_args[@]}" \
  "$@"
