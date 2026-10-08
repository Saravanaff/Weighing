#!/usr/bin/env bash
# Block desktop shortcuts while the weighing kiosk is up.
#
#   kiosk-shortcuts.sh lock       disable them (ExecStartPre of weighing-kiosk)
#   kiosk-shortcuts.sh unlock     put them back (ExecStopPost of weighing-kiosk)
#   kiosk-shortcuts.sh failsafe   restore them only if the kiosk is not up
#   kiosk-shortcuts.sh status     report whether they are locked right now
#
# The exit shortcut (Ctrl+Alt+Shift+F12) lives in
# org.gnome.settings-daemon.plugins.media-keys custom-keybindings, which this
# script never touches, so the terminal can always be escaped.

# No `set -u`: this script is the only thing standing between a hard power cut
# and a desktop with no shortcuts at all, so an unset-variable mistake must not
# abort the restore. The unit also runs both hooks with a leading `-`, so a
# failure here cannot take the weighing terminal down with it.
set -o pipefail

KIOSK_UNIT="${KIOSK_UNIT:-weighing-kiosk.service}"

WM=org.gnome.desktop.wm.keybindings
SHELL=org.gnome.shell.keybindings
MUTTER=org.gnome.mutter.keybindings
MUTTER_WL=org.gnome.mutter.wayland.keybindings
LOCKDOWN=org.gnome.desktop.lockdown

# Every binding in these schemas is a way out of the kiosk: window and workspace
# switching, the overview, the run dialog, screenshots, VT switching. Whole
# schemas are cleared rather than a hand-picked list, so a new GNOME release
# cannot quietly add an escape route this script forgot about.
SCHEMAS=("$WM" "$SHELL" "$MUTTER" "$MUTTER_WL")

# Alt+F2 run dialog, logout, user switching, and screen lock. The last is not
# an escape but a hazard: a lock screen in the middle of a weighing is a
# support call.
LOCKDOWN_KEYS=(disable-command-line disable-log-out disable-user-switching disable-lock-screen)

# This machine has Super+Left / Super+Right window tiling switched off on
# purpose. Unlock resets those schemas to the stock GNOME state, which would
# hand tiling back, so it is put back out again here.
PINNED_EMPTY=("$MUTTER toggle-tiled-left" "$MUTTER toggle-tiled-right")

log() { printf '%s shortcuts: %s\n' "$(date -Is)" "$*"; }

each_key() {
	local schema key
	for schema in "${SCHEMAS[@]}"; do
		while IFS= read -r key; do
			[ -n "$key" ] || continue
			printf '%s\t%s\n' "$schema" "$key"
		done < <(gsettings list-keys "$schema" 2>/dev/null)
	done
}

lock() {
	local schema key changed=0
	while IFS=$'\t' read -r schema key; do
		[ "$(gsettings get "$schema" "$key")" = "@as []" ] && continue
		gsettings set "$schema" "$key" "@as []" 2>/dev/null && changed=$((changed + 1))
	done < <(each_key)
	for key in "${LOCKDOWN_KEYS[@]}"; do
		gsettings set "$LOCKDOWN" "$key" true 2>/dev/null
	done
	log "locked ($changed bindings cleared)"
}

# Restore to the stock GNOME state instead of to values captured at lock time.
# Capturing worked, but the captured file is only as good as the machine's state
# when it was written: any other writer that has trimmed a binding first --
# switch-applications lost its <Alt>Tab that way, twice -- is then restored as
# trimmed, and one bad capture becomes the baseline for every unlock after it.
# A reset cannot inherit a bad value. The cost is any deliberate non-default
# binding, which is why PINNED_EMPTY exists.
unlock() {
	local schema key
	while IFS=$'\t' read -r schema key; do
		gsettings reset "$schema" "$key" 2>/dev/null
	done < <(each_key)
	local pinned
	for pinned in "${PINNED_EMPTY[@]}"; do
		# shellcheck disable=SC2086
		set -- $pinned
		gsettings set "$1" "$2" "@as []" 2>/dev/null
	done
	for key in "${LOCKDOWN_KEYS[@]}"; do
		gsettings reset "$LOCKDOWN" "$key" 2>/dev/null
	done
	log "unlocked (shortcuts back to stock GNOME state)"
}

# Locked is not a file any more -- unlock restores the stock GNOME state, so
# there is nothing on disk that says whether the lock is applied. The lockdown
# keys are what the lock actually sets, so they are what says so.
status() {
	local key
	for key in "${LOCKDOWN_KEYS[@]}"; do
		if [ "$(gsettings get "$LOCKDOWN" "$key" 2>/dev/null)" = "true" ]; then
			echo "LOCKED (weighing-shortcut-failsafe.timer restores them if the kiosk is not up)"
			return 0
		fi
	done
	echo "not locked"
}

# Run by weighing-shortcut-failsafe.timer, which is wanted by default.target and
# so fires from boot whether or not the kiosk ever came up. The dconf values
# outlive a hard power cut, so a machine switched off while locked comes back
# locked. If the kiosk is running that is the correct state and nothing is done;
# only when it is not running, and not on its way back, are the shortcuts
# restored. A fixed 12h unlock could not do that, and worse, it would fire under
# a kiosk that had been up all day and hand the desktop back mid-shift.
failsafe() {
	state="$(systemctl --user is-active "$KIOSK_UNIT" 2>/dev/null || true)"
	# activating is the window between a crash and Restart=always bringing the
	# kiosk back, and deactivating is a deliberate exit on its way out. Both are
	# still a kiosk that is up.
	case "$state" in
	active | activating | reloading | deactivating)
		log "kiosk is $state, staying locked"
		return 0
		;;
	esac
	log "kiosk is ${state:-unknown}, restoring shortcuts"
	unlock
}

case "${1:-status}" in
	lock) lock ;;
	unlock) unlock ;;
	failsafe) failsafe ;;
	status) status ;;
	*) echo "usage: $0 {lock|unlock|failsafe|status}" >&2; exit 2 ;;
esac
