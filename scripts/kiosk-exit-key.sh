#!/usr/bin/env bash
# Keep the way out of the kiosk working.
#
#   kiosk-exit-key.sh repair   make sure the exit bindings are registered and
#                              the service that reads them is alive
#   kiosk-exit-key.sh status   report
#
# The kiosk's only exit is a GNOME custom keybinding, and on this GNOME version
# that binding is a single point of failure: the paths in
# org.gnome.settings-daemon.plugins.media-keys custom-keybindings must end with a
# slash, and anything that rewrites that array without one -- the Settings
# "Custom Shortcuts" dialog does exactly that -- makes gsd-media-keys dereference
# a NULL GSettings and die with SIGSEGV. systemd then gives up after a few
# restarts, and the effect is not "one shortcut is broken": every media key and
# custom shortcut on the desktop is dead, including the way out of the kiosk.
#
# So this is run from ExecStartPre of the kiosk unit. The terminal never comes up
# without a working exit.

set -uo pipefail

SCHEMA=org.gnome.settings-daemon.plugins.media-keys
BASE=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings
MEDIA_KEYS=org.gnome.SettingsDaemon.MediaKeys.service
MEDIA_KEYS_TARGET=org.gnome.SettingsDaemon.MediaKeys.target

log() { printf '%s exit-key: %s\n' "$(date -Is)" "$*"; }

# name|label|binding|command
#
# One exit, and one exit only. Ctrl+Alt+q used to be a second way out, which is
# the one thing that must not exist: it stopped the unit without disabling it, so
# the terminal looked escaped and came back at the next login anyway. The exit is
# Ctrl+Alt+Shift+F12 because four simultaneous keys cannot be hit by accident on
# a touchscreen terminal, and because it disables as well as stops, so leaving is
# deliberate. Ctrl+Alt+w only brings the kiosk back, so it is not a way out.
WANT=(
	"custom1|Kiosk resume|<Ctrl><Alt>w|/usr/bin/systemctl --user start weighing-kiosk.service"
	"custom2|Kiosk exit|<Ctrl><Alt><Shift>F12|/home/reem/Weighing/scripts/kiosk-exit.sh"
)

# Bindings this script used to own. They are deleted rather than left behind: a
# retired exit that survives in the array is a way out of the kiosk that nobody
# remembers, which is exactly what the single exit is meant to prevent.
RETIRED=(custom0)

write_binding() {
	local name=$1 label=$2 binding=$3 command=$4
	dconf write "$BASE/$name/name" "'$label'" 2>/dev/null
	dconf write "$BASE/$name/binding" "'$binding'" 2>/dev/null
	dconf write "$BASE/$name/command" "'$command'" 2>/dev/null
}

# The array is the only thing that can crash the service, so it is rebuilt rather
# than trusted: entries that lost their trailing slash get it back, entries of
# ours are guaranteed present, and anything else the operator added is kept.
repair_array() {
	local -a entries=() entry want gone
	local current
	current="$(gsettings get "$SCHEMA" custom-keybindings 2>/dev/null)"

	while IFS= read -r entry; do
		[ -n "$entry" ] || continue
		[[ $entry == */ ]] || entry="$entry/"
		local name="${entry#"$BASE/"}"
		name="${name%/}"
		for gone in "${RETIRED[@]}"; do
			[ "$name" = "$gone" ] && continue 2
		done
		entries+=("'$entry'")
	done < <(printf '%s' "$current" | tr -d "[]" | sed "s/'/\n/g" | grep '^/' || true)

	for want in "${WANT[@]}"; do
		want="${want%%|*}"
		entries+=("'$BASE/$want/'")
	done

	# dedupe, keep order
	printf -v joined '['
	local first=1 item seen=" "
	for item in "${entries[@]}"; do
		[[ $seen == *" $item "* ]] && continue
		seen+="$item "
		[ $first -eq 1 ] || joined+=', '
		joined+="$item"
		first=0
	done
	joined+=']'

	# gsettings prints the canonical form, which separates elements with ", ".
	# Compare with spaces removed so an unchanged array is not rewritten on every
	# kiosk start.
	local before
	before="$(gsettings get "$SCHEMA" custom-keybindings 2>/dev/null | tr -d ' ')"
	[ "$before" = "$(printf '%s' "$joined" | tr -d ' ')" ] && return 0
	gsettings set "$SCHEMA" custom-keybindings "$joined" 2>/dev/null
	log "rebuilt custom-keybindings (was $before, now $joined)"
}

repair() {
	local spec name label binding command gone
	for spec in "${WANT[@]}"; do
		IFS='|' read -r name label binding command <<<"$spec"
		write_binding "$name" "$label" "$binding" "$command"
	done
	# Clear the retired ones out of dconf as well as the array, so a stale value
	# is not left one manual gsettings away from becoming a way out again.
	for gone in "${RETIRED[@]}"; do
		dconf reset "$BASE/$gone/name" 2>/dev/null || true
		dconf reset "$BASE/$gone/binding" 2>/dev/null || true
		dconf reset "$BASE/$gone/command" 2>/dev/null || true
	done
	repair_array

	if ! systemctl --user is-active --quiet "$MEDIA_KEYS"; then
		log "gsd-media-keys is down, restarting it"
		systemctl --user reset-failed "$MEDIA_KEYS" 2>/dev/null
		systemctl --user start "$MEDIA_KEYS_TARGET" 2>/dev/null
		sleep 3
	fi

	if systemctl --user is-active --quiet "$MEDIA_KEYS"; then
		log "exit bindings armed: $(gsettings get "$SCHEMA" custom-keybindings 2>/dev/null)"
	else
		log "WARNING: $MEDIA_KEYS is still down; the keyboard shortcuts are not working"
	fi
}

status() {
	echo "media-keys: $(systemctl --user is-active "$MEDIA_KEYS" 2>/dev/null || echo unknown)"
	echo "bindings:   $(gsettings get "$SCHEMA" custom-keybindings 2>/dev/null)"
	local spec name label binding command
	for spec in "${WANT[@]}"; do
		IFS='|' read -r name label binding command <<<"$spec"
		local got
		got="$(dconf read "$BASE/$name/binding" 2>/dev/null)"
		printf '  %-9s %-14s %-24s %s\n' "$name" "$label" "$got" "$command"
	done
	# Anything in the array that is not ours is the operator's own, which is
	# allowed. A retired name of ours showing up again is not.
	local base="${BASE}/" entry
	while IFS= read -r entry; do
		[ -n "$entry" ] || continue
		entry="${entry#"$base"}"
		entry="${entry%/}"
		for name in "${RETIRED[@]}"; do
			[ "$entry" = "$name" ] &&
				echo "  WARNING: retired binding '$name' is back in the array -- run repair"
		done
	done < <(gsettings get "$SCHEMA" custom-keybindings 2>/dev/null | tr -d "[]" | sed "s/'/\n/g" | grep '^/' || true)
}

case "${1:-status}" in
	repair) repair ;;
	status) status ;;
	*) echo "usage: $0 {repair|status}" >&2; exit 2 ;;
esac