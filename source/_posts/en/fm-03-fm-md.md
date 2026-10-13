---
title: "FM power-up: script notes"
date: 2026-09-23 12:16:40
lang: en
permalink: en/2026/09/23/fm-03-fm-md/
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
---


# FM RF power-up script

> Date: 2026-09-23　Device <设备IP> (Alpine / SC9832A / Marlin2 combo)
> Background: `zz_fm.start` used to only bring up `fm_user_daemon` and **never sent `on`**,
> so after boot the device presented a "daemon present, `chipid=0x2341` normal, but RF `off`" false-available state.

---

## 1. Power-up chain (all links required)

```
01_wifi.start        download 烧 CP 固件 + SDIO 枚举 + insmod marlin_fm/sprdwl
   ↓
bt_bringup.start     重启 wcnd → 连 external_wcn → @wcnd 发 "wcn BT-OPEN"
   ↓
fm_user_daemon       向 @wcnd 发 "wcn FM-OPEN" 并【长期保持该连接】；常开 /dev/fm 的 fd
   ↓
fm_powerup.sh   ★    发 `on` → POWER_UP（本次新增的缺失环节）
```

The manifestation of any missing link is `ioctl -110` (`set_marlin_wakeup ack timeout`).

## 2. The three scripts

| File | Purpose |
|---|---|
| `/root/fm_powerup.sh` | **RF power-up**, idempotent. Usage `sh /root/fm_powerup.sh [freq_kHz] [vol]`, defaults to `97400 5` |
| `/etc/local.d/zz_fm.start` | boot autostart: start the daemon → call `fm_powerup.sh` → **start keep-alive** |
| `/root/fm_watchdog.sh` | checks the daemon every 5s; if it dies, restart the daemon **and asynchronously top up the power once** |

### `fm_powerup.sh` internal flow

1. Precondition check: `wcnd` is running and `/dev/fm` exists (otherwise FATAL exit with a prompt to run bt_bringup first)
2. Start the daemon if it is not running; poll and wait for `/tmp/fm_ctl.sock` to appear (at most 30s)
3. Read `state`; skip if already `on`; otherwise send `on`, retrying at most 3 times
   — on failure, **restart the daemon to rebuild @wcnd's long-lived FM-OPEN connection** and try again (this is the standard cure for -110)
4. On success, set `tune` / `vol` / `mute 0`, and print the final `state`
5. Logs are also written to `/var/log/fm_boot.log`

**Note**: the script deliberately does not call `rssi` — that ioctl blocks for a fixed ~4.2s each time before timing out.
Socket interactions uniformly go through python with `settimeout(6)`, to avoid hanging the script.

## 3. Measured results (2026-09-23)

```
===== begin: freq=97400 vol=5 =====
前置 OK: wcnd=1140 /dev/fm 存在
socket ready, daemon pid=1228
上电前 state=off
on 返回(第 1 次): OK on
state -> on
tune 97400 -> OK tune 97400
vol 5 -> OK vol 5
mute 0 -> OK mute 0
最终 state: OK on freq=97400 vol=5 mute=0 chipid=0x2341 rds=1
===== end: OK =====
```

Keep-alive: `pid=30867`; running the script again exits 0 by itself (the pid file single-instance takes effect).

## 4. Vulnerability fixed along the way

**`fm_watchdog.sh` used to have nobody responsible for starting it** (a global grep found its own name only inside its own file),
i.e. once the daemon died it would never self-heal. It is now started at the end of `zz_fm.start`, and after a restart it asynchronously tops up the power.

## 5. Pitfalls encountered

Using `ps -o pid,args | grep '[f]m_watchdog.sh'` to judge liveness will **misjudge it as "already running"** —
it hits **the `sh -c` process itself carrying this command** (PID 29166).
The `[f]` trick only avoids `grep` itself, not the shell's `sh -c`.
**Single-instance shell scripts should always use a pid file + `kill -0` to judge.**

## 6. Known side effects

After the FM RF powers up, the kernel continuously spams `(FM_RDS)` / `FM_DRV` logs and pushes up load (about 9 lines/second);
when debugging other kernel issues, first turn off the RF with `python3 /root/fm_cli.py off`.

---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
