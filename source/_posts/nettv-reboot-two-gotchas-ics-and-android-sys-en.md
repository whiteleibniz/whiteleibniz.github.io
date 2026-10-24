---
title: "netTV Completely Down After a Device Reboot: Two Unavoidable Pits — ICS Re-binding and the /mnt/android_sys Mount"
date: 2026-10-14 02:30:00
tags:
  - nettv
  - VSP Hardware Decoding
  - ICS
  - bionic
  - Environment Dependencies
  - Bug Fix
categories:
  - Troubleshooting Notes
  - Video Playback
copyright: "Original article, licensed under CC BY-NC-SA 4.0. Please credit the source when reposting: whiteleibniz.github.io"
lang: en
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/10/14/nettv-reboot-two-gotchas-ics-and-android-sys/) · [繁體中文](https://whiteleibniz.github.io/2026/10/14/nettv-reboot-two-gotchas-ics-and-android-sys-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/14/nettv-reboot-two-gotchas-ics-and-android-sys-en/)

> Copyright: This article is original work by the author, licensed under CC 4.0 BY-SA. Please include the original source link and this statement when reposting.

# netTV Completely Down After a Device Reboot

## 1. Symptom: One Reboot, Three Things Broken at Once

After the Spreadtrum SC9832A device was power-cycled due to the previous sshd incident, I wanted to continue verifying the fix for "4 frames / second IDR crash" — but the environment wouldn't even come up:

| Symptom | Criterion | First Reaction (Wrong) |
|---|---|---|
| Device can't reach the internet | `curl` returns `000`, but `ip route` still has `default via <RNDIS-GW>` | Assumed the channel sources were down again |
| Player won't start | `CANNOT LINK EXECUTABLE: library "libc.so" not found` | Assumed the binary was corrupted |

Neither is true: **the sources are not down, and the binary is not broken**. What broke is the "shared internet connection" layer between the two machines, and one mount point that was forgotten after the device rebooted.

## 2. Pit #1: ICS Re-binding Must "Clear the IP First, Private Before Public"

The device's internet path is `USB RNDIS (RNDIS subnet) → PC ICS NAT → PC WiFi`. The PC itself gets 200, the device gets 000, and the routing table is still there — this is a textbook **ICS lost binding**.

The old script's approach: find the WLAN (public) and RNDIS (private) connections, then `DisableSharing` followed by `EnableSharing`. This time it failed outright:

```
EnableSharing(0) → COMException 0x80040201
```

Worse was the remediation: manually setting `<RNDIS-GW>/24` on the RNDIS NIC with `New-NetIPAddress` — the address did appear, pinging the device worked, but the device still couldn't reach the internet. Because **ICS does not recognize the manually set address** — when it takes over the NIC it reconfigures it itself; the manual address gets pushed off, the NIC degenerates to **APIPA 169.254.x**, and the NAT table is never established at all.

The correct order (now baked into a script):

```powershell
# 1. Find public(WLAN/Intel 9462) and private(USB RNDIS Adapter)
# 2. DisableSharing() on both
# 3. ★ Delete ALL IPv4 addresses on the private NIC — leave even one and ICS won't reconfigure
# 4. private.EnableSharing(1)   ← private first
# 5. public.EnableSharing(0)    ← then public
# 6. Wait 10s; ICS configures private to <RNDIS-GW>/24 on its own
```

There is only one verification point: the ICS private address appears in `Get-NetIPAddress -InterfaceAlias Ethernet`. It appears → connected; it doesn't appear → it didn't happen. Don't use "ping works" as the criterion.

**Lesson**: the private-side address of Windows ICS must be created by ICS itself. An address you set for it, it does not recognize, and it will sling the NIC off to 169.254.

## 3. Pit #2: The bionic Runtime Environment Depends on the /mnt/android_sys Mount

With ICS fixed, I ran the player excitedly, and:

```
WARNING: linker: /usr/local/bin/nettv_player: unused DT entry: type 0x1d
CANNOT LINK EXECUTABLE: library "libc.so" not found
```

`/system/lib/libc.so` clearly exists — but it is a symlink:

```
/system/lib/libc.so -> /mnt/android_sys/lib/libc.so
```

And `/mnt/android_sys` is a mount point of **`/dev/mmcblk0p17` (ext4, read-only)**; after the reboot nobody mounts it, so all several hundred `.so` symlinks under `/system/lib` dangle.

Why does nobody mount it after a reboot? Because the mount points were all torn apart by historical changes:

- `01_wifi.start` — disabled long ago
- `01_mali.start` — deleted for "Mali de-scripting"
- `wifi_bringup.c:296` — only mounts when the user turns the WiFi switch on
- `gpu_env.c` — **only creates symlinks, with no mount fallback** (it assumes /mnt is already mounted)

One command saved the day:

```sh
mkdir -p /mnt/android_sys
mount -t ext4 -o ro /dev/mmcblk0p17 /mnt/android_sys
```

**Remaining to-do**: bake this into a boot script `00_android_sys.start`. Otherwise, after every reboot all bionic programs (nettv_player, the PSP frontend, WCN-related) fail linking.

## 4. The Actual Business: The 10-13 mbinfo Reuse Fix Passes Preliminary Verification

With the environment fixed, I reran the Luxian source (`timeout -s KILL 80`); the criteria at about 50 seconds:

| Criterion | Old Version | New Version |
|---|---|---|
| `change to sw decoder` | always (one-way gate) | **0 times** |
| `[ion] ... FAILED rc=` | -12 on block 5, always | **0 times** |
| `reuse block #` | none | **93 times** |
| Process survival | crash/hang after 4 frames | **>50s, frames flowing** |

In other words, the causal chain settled on 10-13 holds: **it was never "the second IDR always crashes"; rather, VSP's mbinfo (653824B per block) only fits 4 blocks in the ~7MB CMA pool; block 5 gets ENOMEM → `decRet=-3` → the component permanently switches to software decoding → and after that it is permanently `-9 needIVOP`**. With all three of "reuse + alignment-downgraded retry + detect the one-way gate and actively respawn" done, the second IDR is no longer the end of the line.

Still to verify: exact frame count, continuous duration across multiple GOPs, and whether the picture shows artifacts (`C1_REUSE_MAX` may need tuning).

## 5. The Most Expensive Lesson This Time: Don't SIGSTOP the UI Main Process

To keep LVGL from fighting the player for the framebuffer, I added one line to the test script: `kill -STOP $(pgrep -x lvgl_demo)`.

Then, while polling, SSH died: `Error reading SSH protocol banner [WinError 10054]`; retesting gave **TCP 22 Connection refused** (ping still worked), and 5555/23/8022 all timed out. sshd was dead; the device had no remote channel left.

The real disaster is here: **lvgl_demo sits in SIGSTOP state, and nobody will SIGCONT it**. The device watchdog had been disbanded long ago; the watchdog won't revive it, and nobody else will come to recover it. So a device that is "networked but SSH-dead, UI frozen" has only one way out: the power cord.

In unattended automation, this is an iron law:

> **Never send STOP/TERM to the UI main process.** The framebuffer contention you save is nowhere near worth gambling the whole device's reachability. If you want to test the player, let it fight for the screen; the picture flickers a few times, and the UI recovers on its own once the test is done.

## 6. Lessons Learned

1. **A reboot is the most dangerous action for an embedded device**; it exposes all at once the "implicit dependencies that no longer exist in the boot scripts". When changing boot scripts (especially deleting), you must explicitly migrate the non-obvious duties carried by the deleted scripts (mounts, symlink creation, environment variables).
2. For system-managed configuration like ICS, **a manual substitute is always fake**. The address is there, ping works, but that doesn't mean NAT is there. Criteria must use **functional truth values** (can traffic actually get out), not configuration appearances (whether the address exists).
3. **The first suspect for `library "xxx.so" not found` is the mount point, not the file**. When the dynamic linker reports a missing library, first check whether the symlink's target directory is empty — especially in environments full of symlinks like small set-top boxes / chroot / Android compatibility layers.
4. **"Background + short polling" for long tasks is discipline; sending signals to the main process is not**. The former is for dodging sandbox timeouts; the latter is actively manufacturing an unrecoverable state — two different things.
5. **After fixing a root cause, re-verify with criteria immediately**. This time's three counts — reuse blocks = 93 / sw = 0 / FAILED = 0 — are far more reliable than "looks like it's playing". Write criteria as greppable counts, and next time you can confirm in minutes.

---

> **Copyright**: This article is original work by whiteleibniz (with AI-assisted editing). Copyright belongs to whiteleibniz. Please credit the source and link to the original article when reposting: https://whiteleibniz.github.io
