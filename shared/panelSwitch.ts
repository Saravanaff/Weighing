/**
 * Ctrl+Alt+A moves between the admin portal and the staff terminal.
 *
 * The two terminals are separate single-page apps: the admin portal is served
 * at "/" and the staff terminal at "/staff/". Each one loads the item master
 * and the formula list once, when it mounts, so a switch has to hand the
 * operator a genuinely fresh page: an item or formula added on the other
 * terminal must be visible the moment they switch, never a stale copy.
 *
 * A plain location navigation is not enough on its own. When the target URL
 * has been visited before, the browser may answer it from the back/forward
 * cache and restore the old document without re-running any of its data loads,
 * so the newly added formula would be missing. Two things prevent that here:
 *
 *   1. Every switch targets a unique URL (a one-shot ?panel= stamp), so there
 *      is never a cached entry to restore.
 *   2. A pageshow listener turns any restore that does slip through into a
 *      real reload.
 *
 * In production one server hosts both apps on one origin, so the switch is a
 * path change. In development the two Vite servers run on separate ports
 * (5173 admin, 5174 staff), which this handles as well.
 */

const KEY = 'a';
const ADMIN_PATH = '/';
const STAFF_PATH = '/staff/';
const ADMIN_DEV_PORT = 5173;
const STAFF_DEV_PORT = 5174;

/** True when the current document is the staff terminal rather than the admin portal. */
export function onStaffTerminal(): boolean {
  const path = window.location.pathname;
  return path === '/staff' || path.startsWith('/staff/');
}

/**
 * URL of the terminal to switch to, always carrying a unique query stamp so the
 * browser cannot satisfy it from the back/forward cache.
 */
export function otherTerminalUrl(): string {
  const stamp = Date.now().toString(36);
  if (import.meta.env.DEV) {
    // Separate dev servers, so the switch is host+port rather than path.
    const host = window.location.hostname || 'localhost';
    const toStaff = !onStaffTerminal();
    const port = toStaff ? STAFF_DEV_PORT : ADMIN_DEV_PORT;
    const path = toStaff ? STAFF_PATH : ADMIN_PATH;
    return `http://${host}:${port}${path}?panel=${stamp}`;
  }
  return `${onStaffTerminal() ? ADMIN_PATH : STAFF_PATH}?panel=${stamp}`;
}

/** Install the Ctrl+Alt+A switch. Returns the uninstall function for a React effect. */
export function installPanelSwitch(): () => void {
  const onKey = (event: KeyboardEvent) => {
    if (!event.ctrlKey || !event.altKey) return;
    if (event.key.toLowerCase() !== KEY) return;
    event.preventDefault();
    // replace(), not assign(): the kiosk has no back affordance, and repeated
    // switching must not pile up history entries.
    window.location.replace(otherTerminalUrl());
  };

  const onPageShow = (event: PageTransitionEvent) => {
    // A document restored from the back/forward cache never re-runs its mount
    // effects, so its item master and formulas would be stale.
    if (event.persisted) window.location.reload();
  };

  window.addEventListener('keydown', onKey);
  window.addEventListener('pageshow', onPageShow);
  return () => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('pageshow', onPageShow);
  };
}
