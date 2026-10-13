---
title: "wifi"
date: 2026-09-13 15:27:33
lang: en
permalink: en/2026/09/13/ht0-references-wifi-md/
search: true
categories:
- AI工作流
- 可复用资产
tag:
- HT0
- WCN
- 技能
---


# Bringing Up WiFi on the Spreadtrum SC9832A Device (HT0) — AI Execution Guide

> **Audience**: AI assistants (Doubao / other large models) that need to quickly resolve WiFi-unavailable / cannot-connect problems on similar devices (Spreadtrum SC9832A, Android kernel + Alpine user space)
> **How to use**: read §1–§3 first to build context → follow the standard procedure in §5 → verify per §6 → on failure, consult the decision table in §7
> **Core value**: every command in this article is taken from the `wifi.start` boot script that was verified working on the device; following it lets you bring up WiFi directly on similar devices and avoid repeating the same pitfalls
> **Related**: WiFi and Bluetooth share the same Marlin combo chip, and WiFi is the physical prerequisite for Bluetooth (see the Bluetooth AI guide)

---

## 1. Device and Environment at a Glance

| Item | Value |
|---|---|
| Device model | HT0 (reference machine: H709, running Android 6.0, usable as an information source) |
| Hostname / kernel | `spd-box` / `Linux 3.10.65 #13 SMP PREEMPT armv7l` |
| System combination | **Keep the Android 6.0 kernel + switchroot to Alpine Linux** (critical!) |
| SSH | `root@<设备IP>` (RNDIS debug port) / `<WiFi-IP>` after WiFi is connected |
| WiFi chip | Spreadtrum **Marlin combo WCN** (SC2331, WiFi + Bluetooth on the same chip, SDIO interface) |
| WiFi interface | `wlan0` (drivers sprdwl.ko + marlin_fm.ko) |
| Firmware download | stock Android `download` binary, run inside the chroot `/tmp/aand` |
| Current status | WiFi is up: download → driver → wpa_supplicant → DHCP; the boot script has been pinned |

> ⚠️ After a reboot, SSH may be briefly unreachable (USB port switching); poll and retry. `/tmp` survives reboots (the chroot environment and the tools are all there).

---

## 2. Confirmed Hard Facts (No Need to Re-investigate — Trust Them Directly)

1. **WiFi firmware must be flashed by the stock Android `download` binary**: `chroot /tmp/aand /bin/download -i wlan0`; only then does the chip have firmware to run. The WiFi and Bluetooth firmware are a single unit, so **WiFi up = the Bluetooth firmware is also ready**.
2. **`download` depends on a complete chroot Android user space**: `/tmp/aand` must contain the Android libs (including libiwnpi.so), the `/etc/marlinba/*.ini` configs, device nodes, and partition symlinks (by-name: wcnfdl→mmcblk0p14, wcnmodem→mmcblk0p15, boot→mmcblk0p16). `wifi.start` sets all of these up automatically.
3. **SDIO enumeration is the sign of a successful firmware download**: `/sys/bus/sdio/devices/mmc2:8800:1` appears with device=**0x2331**.
4. **Driver load order is a hard constraint**: `marlin_fm.ko` **must be loaded before** `sprdwl.ko` (sprdwl depends on the `fm_read` symbol exported by marlin_fm); reversing the order reports Unknown symbol.
5. **`download` must stay resident**: killing all download/logdw processes corrupts the chip firmware state; only a full reboot can recover.
6. **wpa_supplicant configuration**: `/etc/wpa_supplicant/wpa_supplicant.conf`, with `ctrl_interface=/run/wpa_supplicant` and `update_config=1`; the LVGL network page interacts with this configuration through `wpa_cli`.
7. **LVGL network settings page** (`lv_pages/network_page.c`): toggle = ip link up/down, scan = `wpa_cli -i wlan0 scan` + `scan_results`, connect = `add_network`→`set_network`→`select_network`→`save_config`→`reconnect`.
8. **The boot script has been pinned**: `/etc/local.d/wifi.start` (idempotent by design; already-completed steps are skipped automatically), with a git copy at `shell/wifi.start`.
9. **DHCP**: use `udhcpc -i wlan0` (the Alpine default); if it stays "acquiring", check the wpa connection status and the drivers first.
10. **Time issue**: the device RTC once fell back to 2016; it has been fixed with hwclock/ntpd and pinned in a script such as `/etc/local.d/time_sync.start`. If the date is wrong, fix the time before debugging the network (certificates/handshakes are affected by the date).

---

## 3. Verified Dead Ends (Do Not Retry — It Wastes Turns)

| Route | Result | Reason |
|---|---|---|
| Kill download/logdw for a "clean restart" | The chip firmware state is corrupted, and WiFi/Bluetooth fail together | A full reboot is the only recovery; the correct approach is to let wifi.start re-run idempotently |
| Replace the Android kernel with a mainline Linux kernel | Not adopted | The Android kernel contains Spreadtrum-specific customizations (SDIO/power/firmware timing) with no mainline equivalent; extremely risky |
| Change the USB OTG / network mode | Explicitly forbidden by the user | It would break the RNDIS debug port / network topology |
| insmod sprdwl.ko directly without loading marlin_fm | Load fails with Unknown symbol | Module symbol dependency; the order cannot be reversed |
| Repeatedly reconnect the same IP when port 22 is unreachable after reboot | Ineffective | Caused by USB port switching; poll and retry both IPs |
| Write a custom download to replace the stock Android one | High risk, not adopted | The firmware download sequence (power_ctl power-on sequence + UART handshake + SDIO bulk writes) is a chip trade secret; the stock binary is the most reliable |

---

## 4. System Model: Layers + Per-Layer Verification Criteria

```
① 固件/物理层    logdw + download → 芯片上电 + 固件烧录
                 验证: cat /sys/bus/sdio/devices/mmc2:8800:1/device → 0x2331
② 驱动层         insmod marlin_fm.ko → insmod sprdwl.ko → wlan0 出现
                 验证: lsmod | grep sprdwl; ls /sys/class/net/wlan0
③ 协议层         ip link up → wpa_supplicant → 扫描/连接
                 验证: iwconfig wlan0（ESSID 关联）; wpa_cli status
④ 网络层         DHCP → IPv4 地址
                 验证: ip addr show wlan0 有 inet 地址 + 默认路由
```

**Debugging discipline**: when a layer fails verification, look for the cause only in that layer and its upstream. Example: when WiFi will not connect, check the wpa_supplicant status first (③), rather than re-flashing the firmware (①).

---

## 5. Standard Execution Procedure (Ready to Copy)

### 5.1 Full Chain (Corresponds to wifi.start; Relying on the Idempotent Re-run of the Boot Script Is Recommended)

```sh
# 直接重跑开机脚本（幂等，安全）
sh /etc/local.d/wifi.start 2>&1 | tail -20
# 日志: /var/log/wifi_boot.log
```

### 5.2 Manual Step-by-Step (For Debugging)

```sh
# 1) 环境（若 /tmp/aand 不存在，wifi.start 会自动搭建；手动确认）
ls /tmp/aand/bin/download /tmp/aand/lib/libiwnpi.so /tmp/aand/etc/marlinba/connectivity_configure.ini
mountpoint -q /tmp/aand/dev || mount --bind /dev /tmp/aand/dev
mountpoint -q /tmp/aand/proc || mount -t proc proc /tmp/aand/proc

# 2) 杀净残留 + 启动 logdw + download（常驻）
for p in $(ps -eo pid,comm | awk '$2=="download"||$2=="logdw"{print $1}'); do kill -9 "$p"; done
setsid /tmp/logdw >/tmp/logdw.log 2>&1 &
sleep 1
setsid chroot /tmp/aand /bin/download -i wlan0 >/tmp/dl.log 2>&1 &
sleep 2
ps -eo pid,comm | grep download    # 确认 download 在跑

# 3) 等 SDIO 枚举（最多 90s）
for i in $(seq 1 18); do
  [ -e /sys/bus/sdio/devices/mmc2:8800:1 ] && break
  sleep 5
done
cat /sys/bus/sdio/devices/mmc2:8800:1/device    # 期望 0x2331

# 4) 驱动（顺序不能反）
lsmod | grep -q marlin_fm || insmod /lib/modules/marlin_fm.ko
sleep 1
lsmod | grep -q sprdwl || insmod /lib/modules/sprdwl.ko
sleep 2
ls /sys/class/net/wlan0 || { rmmod sprdwl 2>/dev/null; rmmod marlin_fm 2>/dev/null; sleep 1;
                             insmod /lib/modules/marlin_fm.ko; sleep 1; insmod /lib/modules/sprdwl.ko; sleep 4; }

# 5) 接口 up + wpa_supplicant
ip link set wlan0 up
sleep 2
pgrep -x wpa_supplicant || wpa_supplicant -B -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant.conf

# 6) DHCP
udhcpc -i wlan0 -q -n 2>&1 | tail -5
ip addr show wlan0 | grep inet
```

### 5.3 Connecting to WiFi (wpa_cli Interaction, the Same Logic as the LVGL Network Page)

```sh
wpa_cli -i wlan0 scan                              # 触发扫描
sleep 3
wpa_cli -i wlan0 scan_results                      # 查看热点
# 添加/配置网络
ID=$(wpa_cli -i wlan0 add_network | tail -1)
wpa_cli -i wlan0 set_network $ID ssid '"MySSID"'
wpa_cli -i wlan0 set_network $ID psk '"<WiFi密码>"'
wpa_cli -i wlan0 set_network $ID scan_ssid 1
wpa_cli -i wlan0 set_network $ID priority 10
wpa_cli -i wlan0 enable_network $ID
wpa_cli -i wlan0 select_network $ID
wpa_cli -i wlan0 save_config
udhcpc -i wlan0 -q
```

---

## 6. Verification Checklist (Confirm Item by Item)

| # | Check | Expected |
|---|---|---|
| 1 | `cat /sys/bus/sdio/devices/mmc2:8800:1/device` | `0x2331` |
| 2 | `lsmod \| grep sprdwl` | sprdwl + marlin_fm (dependency: 1 sprdwl) |
| 3 | `ip -br link show wlan0` | `UP` |
| 4 | `iwconfig wlan0` | ESSID associated / no ESSID means not connected |
| 5 | `pgrep -x wpa_supplicant` | the process exists |
| 6 | `wpa_cli -i wlan0 status` | `wpa_state=COMPLETED` |
| 7 | `ip addr show wlan0 \| grep 'inet '` | has an IPv4 address |
| 8 | `ip route` | has a default via gateway |
| 9 | LVGL network page | toggle/scan/saved/nearby list/connect all work |

---

## 7. Failure → Root Cause → Fix Decision Table

| Symptom | Most likely root cause | Fix |
|---|---|---|
| Log `ERROR: SDIO not enumerated, download may have failed` | Firmware download did not complete (timing/permission/node issue) | Check the tail of `/tmp/logdw.log`; confirm /dev/power_ctl is writable and the by-name symlinks exist; re-run wifi.start |
| Log `bind logdw failed: No such file or directory` | logdw is not in place (/tmp/logdw does not exist or is not executable) | `ls -la /tmp/logdw`; re-copy it from /mnt/android_sys/bin/ |
| `download started pid=` (pid empty) | The download process did not start | `ps -eo pid,comm \| grep download`; check whether the chroot environment is complete |
| wlan0 does not appear after the drivers load | Driver load failed / chip not enumerated | `dmesg \| tail`; first confirm SDIO 0x2331; rmmod and reload |
| Scan returns empty | wpa_supplicant is not running / the interface is not up | `pgrep wpa_supplicant`; `ip link set wlan0 up`; run `wpa_cli scan` and then `scan_results` |
| Connected but the IP stays "acquiring" | DHCP did not run / wpa is not COMPLETED | Check wpa_state with `wpa_cli status`; run `udhcpc -i wlan0 -q -n` manually |
| SSH unreachable after reboot | The RNDIS port did not recover / the IP changed | Poll both `<设备IP>` and `<WiFi-IP>`; wait for the boot script to finish |
| Date shows 2016 | The RTC is not synchronized | Sync with hwclock -s / ntpd and write it into an /etc/local.d boot script (already pinned; do not repeat) |
| WiFi works but Bluetooth will not start | The Bluetooth chain was not run | See §5 of the Bluetooth AI guide (mdbg permissions / wcnd / bt_once / btwrite) |

---

## 8. Component Architecture (Required Reading for Changes/Maintenance)

```
开机
 └─ /etc/local.d/wifi.start（幂等）
      ├─ 挂载 /mnt/android_sys（mmcblk0p17, Android system 只读）
      ├─ 搭建 chroot /tmp/aand（bin/lib/etc/marlinba + bind /dev /proc /sys + 分区 mknod + by-name 软链）
      ├─ 杀净残留 download/logdw
      ├─ setsid /tmp/logdw
      ├─ setsid chroot /tmp/aand /bin/download -i wlan0   ← 常驻
      ├─ 等 SDIO 枚举 mmc2:8800:1 = 0x2331（≤90s）
      ├─ insmod marlin_fm.ko → sprdwl.ko（顺序硬约束）
      ├─ ip link set wlan0 up
      └─ wpa_supplicant -B -i wlan0 -c /etc/wpa_supplicant/wpa_supplicant.conf
之后
 ├─ LVGL 网络页（network_page.c）通过 wpa_cli 扫描/连接
 └─ udhcpc 取 IP（Alpine 网络栈）
```

**Key chroot nodes** (required by download; missing any of them means SDIO enumeration fails):
- `/tmp/aand/bin/download` (stock Android version)
- `/tmp/aand/lib/libiwnpi.so` + the full set of Android libs
- `/tmp/aand/etc/marlinba/connectivity_configure.ini` (firmware path/calibration configuration, also contains the Bluetooth pskey)
- `/tmp/aand/dev/block/platform/sdio_emmc/by-name/{wcnfdl→mmcblk0p14, wcnmodem→mmcblk0p15, boot→mmcblk0p16}`
- `/dev/power_ctl` (download writes the SLEEP→POWER_ON→POWER_RST power-on sequence)

**LVGL network page** (`lv_pages/network_page.c`, 1677 lines, the WiFi settings UI template):
- Toggle: `ip link set wlan0 up/down` + `wpa_cli disconnect/reconnect`
- Scan: `wpa_cli scan` → wait 3s → `wpa_cli scan_results` → parse bssid/signal/flags/ssid
- Connect: add_network / set_network (ssid/psk/key_mgmt/scan_ssid/priority) / select_network / save_config
- Saved list: `wpa_cli list_networks`

---

## 9. Red Lines and Operational Discipline

1. **Never kill `download`, which must stay resident** — killing all of them corrupts the chip firmware state; only a full reboot recovers.
2. **Driver order**: `marlin_fm.ko` first, `sprdwl.ko` second.
3. **wifi.start is idempotent** — to start over, just run `sh /etc/local.d/wifi.start`; it kills leftovers first and then brings everything up. Do not operate manually piece by piece.
4. **Do not change the USB OTG / network mode configuration** (an explicit user constraint).
5. **Do not switch to a mainline kernel** — the Spreadtrum-specific customizations (SDIO/power/firmware) depend on the Android kernel.
6. **The date must be correct** — WiFi handshakes/certificates are affected by the system time; fix the time before debugging the network.
7. **Use `pkill -9 -x <name>` to clean up processes**; do not use the inline `ps | grep` pattern (it can kill your own shell).

---

## 10. Inventory of Tools/Files Already on the Device (Reuse Them — Do Not Rebuild)

| Tool/file | Location | Purpose |
|---|---|---|
| wifi.start | `/etc/local.d/wifi.start` (git: `shell/wifi.start`) | WiFi auto-start at boot + the full chain (idempotent) |
| Boot log | `/var/log/wifi_boot.log` | wifi.start output (first choice for troubleshooting) |
| download | `/tmp/aand/bin/download` | firmware download (inside the chroot) |
| logdw | `/tmp/logdw` | firmware download log daemon |
| Android user space | `/mnt/android_sys` (mmcblk0p17) | read-only mount of the Android system (source of libs/configs) |
| Drivers | `/lib/modules/marlin_fm.ko`, `/lib/modules/sprdwl.ko` | WiFi drivers (precompiled on the device) |
| wpa config | `/etc/wpa_supplicant/wpa_supplicant.conf` | wpa_supplicant configuration (including saved networks) |
| Network page | `lv_pages/network_page.c` (LVGL project) | WiFi settings UI (wpa_cli interaction template) |
| DHCP | `udhcpc` (bundled with Alpine) | obtain an IP |

---

## 11. Future Enhancement Directions (Currently Incomplete)

| Item | Description | Suggested approach |
|---|---|---|
| IPv4 stability | In some scenarios IPv6 has an address but IPv4 is not obtained | Run udhcpc immediately after checking wpa_state=COMPLETED, and add `-n` retries and logging |
| Auto-reconnect strategy | After a disconnect, only wpa_supplicant's automatic reconnect is relied on | A "disconnect/reconnect" button and a signal-strength display can be added to the network page (scan_results already provides signal) |
| Multi-network priority | Currently a single network configuration | Extend wpa_cli list_networks management + a sorting UI |
| Coexistence with Bluetooth | WiFi stays resident + Bluetooth scanning runs in parallel | They share download/wcnd; testing shows no conflict, but mutually exclusive power management can be added |

---

## 12. 5-Minute Quick Acceptance Path

```sh
# 1) 三层状态一条命令
cat /sys/bus/sdio/devices/mmc2:8800:1/device && ip -br link show wlan0 && pgrep -x wpa_supplicant
# 2) 连接状态
wpa_cli -i wlan0 status | grep -E 'wpa_state|ip_address'
# 3) IPv4
ip addr show wlan0 | grep 'inet '
```

If all of the above pass, the full WiFi chain (physical + protocol + network) is OK; if not, locate the problem item by item using the §7 decision table.

---

*Document version: v1.0 (distilled after WiFi was brought up)*
*Related documents: WiFi Operation Manual (for humans), WiFi Boot Process Comparison, WiFi Working Process Summary, Bluetooth Bring-Up AI Guide*
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
