"""Set the Omron PLC output used by the Maize weighing workflow."""

import argparse
import os
import sys

from fins import FinsClient


PLC_IP = os.getenv("PLC_IP", "192.168.250.1")
PLC_PORT = int(os.getenv("PLC_PORT", "9600"))
PLC_MEMORY_AREA = os.getenv("PLC_MEMORY_AREA", "W0.00")


def set_output(state: str) -> None:
    value = b"\x01" if state == "on" else b"\x00"
    client = FinsClient(host=PLC_IP, port=PLC_PORT)
    try:
        client.connect()
        response = client.memory_area_write(PLC_MEMORY_AREA, value)
        print("Command status:", response.status_text)
        print("Is OK:", response.ok)
        if not response.ok:
            raise RuntimeError(response.status_text)
    finally:
        client.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Turn the weighing PLC output on or off.")
    parser.add_argument("state", choices=("on", "off"))
    args = parser.parse_args()
    try:
        set_output(args.state)
    except Exception as error:
        print(f"PLC command failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())