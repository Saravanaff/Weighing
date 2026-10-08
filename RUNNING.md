# Running Naveen Farms — Windows & Linux

The app runs identically on Windows and Linux. One server process serves
**everything** (API + UI) on **http://localhost:3001**.

## First run on a machine (either OS)

```bash
npm install        # pulls THIS OS's native binaries (serialport, rollup, esbuild)
```

> ⚠️ Never copy `node_modules` between Windows and Linux machines — the native
> binaries are OS-specific. Copy the whole project folder **without**
> `node_modules`, then `npm install` on the target. Everything else
> (code, `data.db`, configs, TTS audio) is portable as-is.

## Start

| Windows | Linux |
|---|---|
| `start.bat` | `./start.sh` |

Both do the same: check Node → install deps if missing → build UI if missing →
run `node server/index.ts`. Open **http://localhost:3001**.

**Requires Node 24+** (the server is TypeScript run directly by Node).

## Hardware config — set once per machine, then it persists

| What | Where | Persisted in |
|---|---|---|
| Scale COM port | SCALE pill → dropdown → connect | `server/scale-config.json` |
| PLC IP address | SCALE pill → PLC IP field → Save | `server/plc-config.json` |

Port names differ per OS (Windows `COM1`…, Linux `/dev/ttyS1`, `/dev/ttyUSB0`…)
— that's why each machine remembers its **own** selection. The scale
reconnects automatically every 2 s once plugged in.

## Kiosk mode

- **Linux**: use the existing `scripts/kiosk*.sh` (systemd unit + Chrome).
- **Windows**: use `scripts/kiosk-start.bat` (Chrome/Edge `--kiosk` at
  localhost:3001). For auto-launch at login, drop shortcuts to `start.bat`
  and `kiosk-start.bat` into `shell:startup`.

## Switching OS later (Windows ↔ Linux)

1. Copy the project folder (skip `node_modules`).
2. `npm install` on the new machine.
3. `start.bat` / `./start.sh` — data, formulas, history, TTS and both
   hardware configs carry over untouched.

## Verify an install

```bash
npm test           # unit + API tests
npm run typecheck  # TypeScript compile check
npm run build:all  # production build of main + staff apps
```
