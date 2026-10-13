---
title: "ht0-wcn-radio Skill Documentation"
date: 2026-09-13 16:05:17
lang: en
permalink: en/2026/09/13/ht0-skill-md/
search: true
categories:
- AI工作流
- 可复用资产
tag:
- HT0
- WCN
- 技能
---


---
name: ht0-wcn-radio
description: "Operations troubleshooting and bring-up for the WiFi/Bluetooth combo chip (Marlin WCN) on Spreadtrum SC9832A devices (HT0, Android kernel + Alpine user space). Use it when the user reports that WiFi will not come up on such a device, the device cannot connect to the network, Bluetooth is unresponsive, WiFi/Bluetooth needs to be brought up again, or download firmware download / SDIO enumeration / driver loading / HCI channel problems need to be diagnosed. It includes one-click bring-up scripts, a layered verification checklist, a failure decision table, and a complete reference manual. Trigger scenarios: WiFi scan returns empty, the IP stays "acquiring", no Bluetooth devices are found, BT-OPEN fails, SDIO not enumerated, hci is unresponsive, wireless does not work after boot, and HT0/H709/SC9832A/Marlin/sprdwl related tasks."
---

# HT0 WCN Radio — Operations for the Spreadtrum SC9832A WiFi/Bluetooth Combo Chip

## When to Use

Use this Skill when the user mentions HT0 / H709 / SC9832A / spd-box / Alpine + Android kernel / Marlin / sprdwl / download firmware / WiFi will not come up / no Bluetooth devices are found, or asks to "bring up WiFi / Bluetooth", "auto-start WiFi/Bluetooth at boot", or "wireless does not work".

## Device at a Glance (30-Second Context)

| Item | Value |
|---|---|
| Device | HT0 (the reference machine H709 runs Android 6.0 and can serve as an information source) |
| Kernel/system | Linux 3.10.65 (Android-customized kernel) + Alpine user space, **keeping the Android kernel and switchrooting** |
| SSH | `root@<设备IP>` (RNDIS debug port) / `<WiFi-IP>` after WiFi is connected; the password is in the environment records |
| Chip | Spreadtrum Marlin combo WCN (WiFi + Bluetooth on the same chip, SDIO for data + ttyS0 UART for HCI) |
| WiFi | wlan0 (sprdwl.ko + marlin_fm.ko); the firmware is flashed by the chroot Android download |
| Bluetooth | /dev/ttyS0 3M+CRTSCTS H4, woken by btwrite; the user-space daemon provides the unix socket `/tmp/bt_ctl.sock` |

## Red Lines (Violating Them Requires a Full Reboot)

1. **Never kill download/logdw, which must stay resident** — killing all of them corrupts the chip firmware state; only a full reboot recovers.
2. **Driver order**: `marlin_fm.ko` first, `sprdwl.ko` second (symbol dependency on fm_read).
3. **Bluetooth BT-OPEN prerequisite**: after a reboot, always run `chmod 666 /tmp/aand/proc/mdbg/*`.
4. **Bluetooth scan prerequisite**: `Write Scan Enable (0x0c1a,0x03)` must be sent before Inquiry; otherwise there will be no Inquiry Result.
5. Use `pkill -9 -x <name>` to kill processes; do not use the inline `ps | grep` pattern (it can kill your own shell).
6. Do not change the USB OTG / network mode; do not switch to a mainline kernel (the Spreadtrum-specific customizations depend on the Android kernel).

## Workflow

### A. One-Click WiFi Bring-Up

```bash
python scripts/wifi_bringup.py --host <设备IP> --password '<pwd>'
```

Or manually (idempotent, safe): `sh /etc/local.d/wifi.start`, with logs at `/var/log/wifi_boot.log`.

### B. One-Click Bluetooth Full-Chain Check

```bash
python scripts/bt_status.py --host <设备IP> --password '<pwd>' [--scan 8]
```

### C. SSH Polling Recovery

After a device reboot, USB port switching makes port 22 briefly unreachable:

```bash
python scripts/ssh_wait.py --hosts <设备IP>,<WiFi-IP> --password '<pwd>' --timeout 180
```

## Layered Verification (Whichever Layer Fails, Investigate That Layer)

```
① 固件/物理层   download 烧录 → SDIO 枚举 0x2331
                cat /sys/bus/sdio/devices/mmc2:8800:1/device  → 0x2331
② 上电层(蓝牙)  wcnd + bt_once → /tmp/bt_once.log 含 "WCNBTWIFI-CMD OK"
③ 驱动/接口层   lsmod | grep sprdwl; ip -br link show wlan0 → UP
④ 协议层        pgrep wpa_supplicant; wpa_cli -i wlan0 status → wpa_state=COMPLETED
⑤ 网络层        ip addr show wlan0 | grep 'inet ' → 有 IPv4
⑥ 引擎层(蓝牙)  /tmp/bt_probe_full 六步全通（Reset/Ver/BD_ADDR/Buffer/Features/Scan Enable）
⑦ 应用层(蓝牙)  socket state → OK ON; scan N → OK <count> + 设备行
```

## Failure Decisions (Quick Reference; See the References for Details)

| Symptom | Root cause | Fix |
|---|---|---|
| BT-OPEN FAIL | mdbg permissions are 600 | `chmod 666 /tmp/aand/proc/mdbg/*` |
| HCI is unresponsive / only replies SPRD3 once | missing btwrite wake-up | start `/tmp/bt_wake.sh` |
| Bluetooth scan returns no results | Write Scan Enable was not sent first | use the daemon scan (handled internally) |
| WiFi SDIO not enumerated | firmware download failed | check /tmp/logdw.log; confirm the by-name symlinks; re-run wifi.start |
| bind logdw failed | /tmp/logdw is missing | re-copy it from /mnt/android_sys/bin/ |
| WiFi is connected but the IP stays "acquiring" | DHCP did not run / wpa is not COMPLETED | check with `wpa_cli status`; run `udhcpc -i wlan0 -q` |
| socket connect fails | multiple daemon instances | run `pkill -9 -x bt_user_daemon` and keep a single instance |
| daemon reports "Not a tty" | the ldisc is occupied | restore N_TTY with the python call `fcntl.ioctl(fd,0x5421,b'\0'*4)` |
| SSH is unreachable after reboot | USB port switching | poll both IPs with ssh_wait.py |

## Reference Documents (Read on Demand — Do Not Load Them All)

- **Complete WiFi manual**: `references/wifi.md` — the full WiFi process, the wifi.start script structure, wpa_cli interaction, the verification checklist, and the failure table
- **Complete Bluetooth manual**: `references/bluetooth.md` — the full Bluetooth process, the daemon architecture/socket protocol, key HCI points, the verification checklist, and the failure table
- **Quick acceptance**: section 12 of both manuals (the 5-minute acceptance path); two commands in each confirm the chain

## Scripts (Run Locally, Connecting to the Device Directly with paramiko)

| Script | Purpose | Key output |
|---|---|---|
| `scripts/wifi_bringup.py` | bring up WiFi in one click and verify it | SDIO 0x2331 / wlan0 UP / wpa status |
| `scripts/bt_status.py` | check the full Bluetooth chain in one click (optionally with scanning) | per-layer status + socket results |
| `scripts/ssh_wait.py` | poll and wait for SSH to recover | the available host + a connection-success flag |

The scripts depend on the local `paramiko`; credentials such as passwords are passed via the `--password` argument or environment variables and must not be hardcoded.

## Document Synchronization Rules (Versioned; Synced When Tagging)

Documents are **not updated with every iteration** (to avoid spending effort on small changes); they are synced uniformly at a **version release (when a tag is created)**:

1. Daily iteration: commit only code/script/config changes, and describe the changes in the commit message; **do not touch the documents**.
2. When tagging a release (the user confirms the feature is complete/stable), do all of the following at once:
   - Sync and update the affected document families: docs documents (operation manuals / troubleshooting manuals / AI guides / deployment delivery documents / process comparisons / work summaries) + references/*.md + this SKILL.md (workflow / red lines / decision table, if involved)
   - When files are added/renamed/deleted, also update the AI工作流/README.md directory specification
   - **Verification**: the commands, paths, and artifacts in the documents must match the actual device runtime state (every changed layer must have been tested on the device)
   - Create the tag: git tag <vX.Y.Z>, with a Chinese remark stating "release scope + the list of synced documents"
3. A tag commit should include or be immediately followed by the document updates, guaranteeing that "one tag = one complete document snapshot" is traceable.

## Privacy Red Lines (Mandatory)

- The project is public: **no real SSH passwords, accounts, or real IP addresses may appear in any document, git remark, or archived file**.
- Always use placeholders: `<设备IP>` / `<WiFi-IP>` / `<密码>`; credentials are provided only in runtime arguments or environment variables.
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
