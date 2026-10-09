"""Windows kiosk keyboard lock for the Naveen weighing terminal.

Swallows the system keys that would let an operator escape the kiosk browser:
the Win key (and every Win shortcut pressed while it is held, including
Win+Tab), Alt+Tab, Alt+Esc, Ctrl+Esc and Alt+F4. Everything else types
normally so the weighing app stays fully usable.

Escape combo: Ctrl+Alt+Shift+F12  (same as the Linux kiosk exit shortcut).
Pressing it closes the kiosk browser and exits the locker, restoring the
desktop. A crash or power cut also restores everything automatically - the
lock lives only in memory, there is nothing on disk to clean up.

Pure ctypes, no third-party packages required.
"""

import ctypes
import subprocess
import sys
from ctypes import wintypes

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

WH_KEYBOARD_LL = 13
VK_TAB = 0x09
VK_ESCAPE = 0x1B
VK_F4 = 0x73
VK_F12 = 0x7B
VK_LWIN = 0x5B
VK_RWIN = 0x5C
VK_CONTROL = 0x11
VK_MENU = 0x12
VK_SHIFT = 0x10
LLKHF_ALTDOWN = 0x20

KIOSK_PROFILE_MARK = "naveen-kiosk-profile"


class KBDLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [
        ("vkCode", wintypes.DWORD),
        ("scanCode", wintypes.DWORD),
        ("flags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.POINTER(wintypes.ULONG)),
    ]


HOOKPROC = ctypes.WINFUNCTYPE(
    ctypes.c_ssize_t, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM
)

hook = None


def _key_down(vk: int) -> bool:
    return bool(user32.GetAsyncKeyState(vk) & 0x8000)


def _exit_combo(vk: int) -> bool:
    return (
        vk == VK_F12
        and _key_down(VK_CONTROL)
        and _key_down(VK_MENU)
        and _key_down(VK_SHIFT)
    )


def shutdown_kiosk() -> None:
    """Close the kiosk browser (its dedicated profile marks it) and stop the lock."""
    print("[Kiosk Lock] exit combo - closing kiosk browser and unlocking.")
    ps = (
        "Get-CimInstance Win32_Process | "
        "Where-Object { ($_.Name -match 'chrome|msedge') -and "
        f"($_.CommandLine -match '{KIOSK_PROFILE_MARK}') }} | "
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
    )
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True)
    global hook
    if hook:
        user32.UnhookWindowsHookEx(hook)
        hook = None
    user32.PostQuitMessage(0)


def low_level_keyboard_proc(nCode, wParam, lParam):
    if nCode == 0:  # HC_ACTION
        kb = ctypes.cast(lParam, ctypes.POINTER(KBDLLHOOKSTRUCT)).contents
        vk = kb.vkCode
        alt_down = bool(kb.flags & LLKHF_ALTDOWN)

        if _exit_combo(vk):
            shutdown_kiosk()
            return 1

        # Swallowed keys: anything that jumps out of the kiosk.
        if vk in (VK_LWIN, VK_RWIN):
            return 1  # the Win key itself: Start menu and every Win shortcut
        # Win+Tab (Task View) is the classic escape attempt once Alt+Tab is
        # blocked. The Win key is already swallowed above, but the whole held-
        # Win window is guarded as well so no Win+? combo can slip through even
        # if a future Windows version re-routes one of them (Win+E, Win+R,
        # Win+D, ...). GetAsyncKeyState reads the physical key, so this clears
        # the moment the operator lets go of the Win key.
        if _key_down(VK_LWIN) or _key_down(VK_RWIN):
            return 1
        if alt_down and vk in (VK_TAB, VK_ESCAPE, VK_F4):
            return 1  # Alt+Tab, Alt+Esc, Alt+F4
        if vk == VK_ESCAPE and _key_down(VK_CONTROL):
            return 1  # Ctrl+Esc opens Start

    return user32.CallNextHookEx(None, nCode, wParam, lParam)


def main() -> int:
    global hook
    proc = HOOKPROC(low_level_keyboard_proc)  # keep a reference alive
    hook = user32.SetWindowsHookExW(
        WH_KEYBOARD_LL, proc, kernel32.GetModuleHandleW(None), 0
    )
    if not hook:
        print("[Kiosk Lock] failed to install keyboard hook", file=sys.stderr)
        return 1
    print("[Kiosk Lock] system keys locked. Exit: Ctrl+Alt+Shift+F12")

    msg = wintypes.MSG()
    while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
        user32.TranslateMessage(ctypes.byref(msg))
        user32.DispatchMessageW(ctypes.byref(msg))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
