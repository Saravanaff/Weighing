#!/usr/bin/env python3
import select
import sys
import time

from evdev import InputDevice, UInput, ecodes, list_devices


ADMIN_SHORTCUT = {
    ecodes.KEY_LEFTCTRL,
    ecodes.KEY_RIGHTCTRL,
    ecodes.KEY_LEFTALT,
    ecodes.KEY_RIGHTALT,
    ecodes.KEY_A,
}


def find_keyboards():
    keyboards = []
    for path in list_devices():
        try:
            device = InputDevice(path)
            keys = device.capabilities().get(ecodes.EV_KEY, [])
            if ecodes.KEY_A in keys and ecodes.KEY_H in keys:
                keyboards.append(device)
        except Exception:
            pass
    return keyboards


def main() -> int:
    keyboards = find_keyboards()
    if not keyboards:
        print('No keyboards found to lock.')
        return 0

    try:
        virtual_keyboard = UInput(
            {
                ecodes.EV_KEY: [
                    ecodes.KEY_LEFTCTRL,
                    ecodes.KEY_LEFTALT,
                    ecodes.KEY_A,
                ]
            },
            name='weighing-admin-shortcut',
        )
    except Exception as error:
        print(f'Cannot create admin shortcut device: {error}', file=sys.stderr)
        return 1

    pressed_keys = set()
    locked = True
    relock_after_shortcut = False
    shortcut_sent = False
    last_shortcut_time = 0.0

    def grab_all() -> None:
        nonlocal locked
        for device in keyboards:
            try:
                device.grab()
            except Exception as error:
                print(f'Error grabbing {device.path}: {error}', file=sys.stderr)
        locked = True

    def ungrab_all() -> None:
        nonlocal locked
        for device in keyboards:
            try:
                device.ungrab()
            except Exception:
                pass
        locked = False

    for device in keyboards:
        try:
            device.grab()
        except Exception as error:
            print(f'Error grabbing {device.path}: {error}', file=sys.stderr)

    print('[Kiosk Lock] Keyboard locked; only Ctrl+Alt+A is forwarded.')

    def admin_shortcut_is_down() -> bool:
        return (
            bool(pressed_keys & {ecodes.KEY_LEFTCTRL, ecodes.KEY_RIGHTCTRL})
            and bool(pressed_keys & {ecodes.KEY_LEFTALT, ecodes.KEY_RIGHTALT})
            and ecodes.KEY_A in pressed_keys
        )

    def send_admin_shortcut() -> None:
        virtual_keyboard.write(ecodes.EV_KEY, ecodes.KEY_LEFTCTRL, 1)
        virtual_keyboard.write(ecodes.EV_KEY, ecodes.KEY_LEFTALT, 1)
        virtual_keyboard.write(ecodes.EV_KEY, ecodes.KEY_A, 1)
        virtual_keyboard.write(ecodes.EV_KEY, ecodes.KEY_A, 0)
        virtual_keyboard.write(ecodes.EV_KEY, ecodes.KEY_LEFTALT, 0)
        virtual_keyboard.write(ecodes.EV_KEY, ecodes.KEY_LEFTCTRL, 0)
        virtual_keyboard.syn()

    try:
        while True:
            ready, _, _ = select.select(keyboards, [], [], 1.0)
            for device in ready:
                try:
                    for event in device.read():
                        if event.type != ecodes.EV_KEY:
                            continue
                        if event.value in (1, 2):
                            pressed_keys.add(event.code)
                        elif event.value == 0:
                            pressed_keys.discard(event.code)

                        if admin_shortcut_is_down() and not shortcut_sent:
                            now = time.monotonic()
                            if now - last_shortcut_time > 0.5:
                                if locked:
                                    send_admin_shortcut()
                                    ungrab_all()
                                else:
                                    relock_after_shortcut = True
                                last_shortcut_time = now
                                shortcut_sent = True
                        elif not admin_shortcut_is_down():
                            shortcut_sent = False
                            if relock_after_shortcut:
                                grab_all()
                                relock_after_shortcut = False
                                pressed_keys.clear()
                except Exception:
                    pass
    finally:
        for device in keyboards:
            try:
                device.ungrab()
            except Exception:
                pass
        virtual_keyboard.close()


if __name__ == '__main__':
    raise SystemExit(main())