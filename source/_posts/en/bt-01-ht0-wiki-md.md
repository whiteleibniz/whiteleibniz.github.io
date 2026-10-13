---
title: "HT0 Bluetooth Principles and Porting Learning Wiki"
date: 2026-09-21 11:57:09
lang: en
permalink: en/2026/09/21/bt-01-ht0-wiki-md/
search: true
categories:
- 硬件模块打通
- 蓝牙
tag:
- 蓝牙
- WCN
---


# HT0 Bluetooth Principles and Porting Learning Wiki

> This document is not an operation manual, but a **principles lesson**: it explains why this Bluetooth chip boots the way it does, how Android originally did it, why we changed it to the current design, and what every key line of code does.
> After reading it you should be able to: facing a combo Bluetooth device with "an Android kernel + a different userland", analyze on your own how to bring up Bluetooth.

---

## 0. Building Intuition in One Sentence

> Bluetooth is not a "software switch"; it is a small processor that **needs to be powered on in a specific sequence, woken up, fed firmware, and then spoken to using the HCI protocol**.
> Android uses a whole set of services (init + download + wcnd + libbt-vendor + Bluedroid) to perform this sequence for you;
> we **rewrote this sequence with the minimum amount of code**, running on the Alpine userland.

---

## 1. What the Hardware Looks Like

This chip is called **Marlin combo WCN** (Spreadtrum SC9832A platform); "combo" means one chip doing both WiFi and Bluetooth:

```
                ┌──────────────────────────────┐
                │      Marlin combo WCN        │
                │  ┌─────────┐   ┌───────────┐ │
                │  │ WiFi     │   │ Bluetooth │ │
                │  │ (wlan0)  │   │ (HCI 引擎)│ │
                │  └─────────┘   └───────────┘ │
                └────┬──────────────────┬──────┘
                     │ SDIO             │ UART
                     │ (数据/固件)       │ ttyS0 (HCI 控制)
              mmc2:8800:1         /proc/bluetooth/sleep/btwrite
              (设备ID 0x2331)      (写1=唤醒蓝牙引擎)
```

Two channels with completely different roles — this is the foundation for understanding everything:

| Channel | What it carries | What it is used for |
|---|---|---|
| **SDIO** | high-speed data bus | burning firmware (the combined WiFi+Bluetooth firmware image is written in large blocks), WiFi data |
| **UART ttyS0** | 3M baud rate + hardware flow control (CRTSCTS) | the Bluetooth **HCI command/event channel** (sending commands, receiving events, carrying audio packets) |
| **btwrite node** | a proc file | writing `1` = wake the Bluetooth engine from low power |

**Key insight**: WiFi and Bluetooth **share the same firmware**. So at the moment "you bring up WiFi", the Bluetooth firmware has already been burned into the chip — what Bluetooth lacks is not firmware, but **power-on, wake-up, and someone talking to it**.

---

## 2. The Five-Layer Model for a Working Bluetooth Device (the most important analytical framework)

For any Bluetooth device to work, all five layers must be connected. **Each layer has a clear "pass criterion"**; if a layer fails, stop at that layer and investigate it — do not skip layers and try blindly.

```
① 物理/固件层   固件烧进去了吗？芯片上电了吗？
                验通：SDIO 枚举出 0x2331；BT-OPEN 返回 OK
② 通道层        HCI 串口能读写吗？
                验通：往 ttyS0 发 Reset，能收到固件回的事件
③ 引擎层        蓝牙引擎醒着吗？跑起来了吗？
                验通：btwrite 唤醒后，固件回 "SPRD3" 身份帧
④ 协议层        标准 HCI 命令它认吗？
                验通：Read Version / Read BD_ADDR / Read Features 都回正常
⑤ 应用层        UI 怎么调用？音频怎么流？
                验通：扫描出设备、能连接、A2DP 能出声
```

Almost every pitfall we hit this time was "mistakenly thought the problem was at the upper layer, but it was actually stuck at the lower layer". For example:
- No devices found by scanning → not a protocol problem, but **the scan enable was not turned on first** (a vendor hidden requirement at layer ④);
- No response to commands → not a command error, but **the engine was not woken up** (layer ③);
- BT-OPEN failure → not a command error, but **proc node permissions of 600 inside the chroot** (a permission issue at layer ①).

---

## 3. Key Concepts Explained One by One

### 3.1 What HCI and H4 Are

**HCI** (Host Controller Interface) = the standard dialogue protocol between the host (CPU) and the Bluetooth controller (chip).
**H4** = the "packet format" for carrying HCI over UART. The first byte of each packet is the packet type:

| First byte | Meaning |
|---|---|
| `0x01` | Command (host→chip, command) |
| `0x02` | ACL Data (bidirectional, connection data/audio) |
| `0x04` | Event (chip→host, event/response) |

So what our daemon essentially does is: **write `0x01 + opcode + parameters` to ttyS0, then read `0x04 + event code + data` from ttyS0**.

### 3.2 How Commands Are Encoded

One HCI command = type(1) + Opcode(2) + parameter length(1) + parameters.
The Opcode splits into OGF (group, high 6 bits) and OCF (command, low 10 bits):

```c
opcode = (OGF << 10) | OCF
// 例如 Inquiry(扫描)：OGF=0x01(链路控制), OCF=0x0001
// → opcode = (0x01<<10)|0x0001 = 0x0401
```

In the source code, `send_cmd()` assembles this:

```c
pkt[0] = H4_CMD;              // 0x01
pkt[1] = opcode & 0xff;       // opcode 低字节
pkt[2] = (opcode>>8) & 0xff;  // opcode 高字节
pkt[3] = plen;                // 参数长度
memcpy(pkt+4, params, plen);  // 参数
write(fd, pkt, 4+plen);
```

### 3.3 The SPRD3 Identity Frame — the Signal That "the Engine Is Alive"

After wake-up, the firmware actively emits a sequence:
```
55 7e 00 81 00 06 53 50 52 44 33 00 57 0a 7e
                  └──── "SPRD3" = 展讯芯片的 ASCII 标识
```
Seeing `SPRD3` means: the Bluetooth engine has already booted from its boot state, the HCI channel is alive, and standard commands can now be sent. **This is the acceptance mark for layer ③.**

### 3.4 btwrite — Why Write It Repeatedly

The Bluetooth engine has **low-power sleep**. When idle it sleeps, and while asleep it simply ignores commands you send.
Writing `1` to `/proc/bluetooth/sleep/btwrite` = kick it awake.

- Android kicks it once every 30 seconds periodically (done by libbt-vendor);
- We have no libbt-vendor, so we wrote a script to **kick it once every 1.5~2 seconds**, more frequently than Android, ensuring it does not fall asleep during scanning/connecting.

> Lesson: the root cause of all early "no response to commands" tests was **this missing kick**.

### 3.5 pskey — the Bluetooth "Factory Personalization Parameters"

pskey is the chip's personalized configuration (Bluetooth address, feature bits, UART parameters, transmit power, etc.); its structure is a large blob of vendor-defined fields.
**Key insight**: we did not send pskey separately, because——

- the `[SETCTION 6]` section in the `connectivity_configure.ini` file is this pskey;
- **`download` reads this file itself while burning the firmware, and has already delivered the pskey**;
- the measured `Read Features` returned feature bits exactly matching the pskey file → **proving it is already in effect**.

So "do we need to add pskey" is a non-question. **Verify with evidence; do not grind on gut feeling.**

### 3.6 A Vendor Hidden Requirement: Write Scan Enable Must Come First

In standard Bluetooth logic, sending Inquiry scans for devices. But this Spreadtrum firmware **does not comply**:
send Inquiry directly and it replies "received" (CMD_STATUS=0), then **never returns scan results**.

Investigation found: you must **first send `Write Scan Enable (0x0c1a)` set to `0x03`** (enabling both "discoverable" and "connectable"), and only then will Inquiry actually produce results.

> This is "vendor firmware behavior" — it is not written in the specification, and can only be reverse-engineered through **controlled experiments** (what the successful attempt did extra).

---

## 4. How Native Android Does It (reference sample)

At Android boot, `init` automatically starts this chain according to `init.board.rc`:

```
init
 ├─ download        烧 combo 固件（读 configure.ini，含 pskey）
 ├─ wcnd            蓝牙子系统上电（BT-OPEN 命令）
 ├─ btld / bt_rm    低功耗管理、射频管理
 └─ Bluedroid 协议栈
      ├─ libbt-vendor: 周期 btwrite 唤醒、发 pskey、管 UART 波特率
      └─ bluetooth.default.so: 完整 HCI/ATT/A2DP/RFCOMM 协议栈
           └─ BluetoothCtrl（你看到的设置界面）
```

**Why does Android not use the kernel hci_uart driver?** Because in Spreadtrum's custom solution, `libbt-vendor` opens the UART directly and manages HCI itself — it is "userland direct connection". This gave us inspiration.

---

## 5. Our Alpine Approach: Replacing an Entire Suite with Minimal Code

### 5.1 Boot Chain (runs automatically at startup)

```
开机
 ├─ wifi.start          ① chroot 安卓环境 + download 烧固件 + SDIO 0x2331 + WiFi 驱动
 ├─ bt_bringup.start   ② chmod 666 mdbg → wcnd → bt_once(BT-OPEN) → bt_wake.sh(btwrite 周期唤醒)
 ├─ bt_daemon(openrc)   ③ 自写用户态 daemon 打开 ttyS0，监听 unix socket
 └─ LVGL 桌面            ④ 蓝牙设置页通过 socket 发命令
```

### 5.2 Three Key Decisions (why we chose this way)

| Decision | What we chose | Why |
|---|---|---|
| Kernel hci_uart.ko vs userland direct connection | **userland direct connection** | this kernel is a custom Android 3.10.65; the hardcoded tty_struct offsets in hci_uart.ko do not match, `hciconfig up` times out, TX=0 (not a single byte can be sent). Opening `/dev/ttyS0` directly from userland bypasses the kernel protocol stack and is instead the most stable — the Android vendor did exactly this |
| Porting Bluedroid vs writing a minimal daemon ourselves | **writing the daemon ourselves** | Alpine lacks that long chain of Bluedroid dependencies (HAL, property service, shared libraries); the cost of a full port is far higher than "implementing only the few HCI commands needed" |
| Writing download ourselves vs reusing the original Android version | **reusing the original version (running in chroot)** | download's power-on sequence, handshake, and partition reads are the chip's "black magic"; writing it ourselves is extremely risky. Run the Android binary as-is in the chroot, together with the libraries/nodes/partition symlinks it needs |

> Core idea: **borrow whatever can be borrowed (download/wcnd use the original versions directly), and rewrite only the minimal necessary part (the HCI command set).**

### 5.3 That "Permission Pitfall"

The easiest pitfall in porting is not technology, but **permissions**:
`wcnd` runs as the system user in the chroot and needs to read `/tmp/aand/proc/mdbg/*`, but that node is `600` (only root can read) → BT-OPEN keeps failing.
`chmod 666` solves it in one second. This kind of "the permission model changed after porting" problem will recur repeatedly.

---

## 6. Source Code Walkthrough: What the Daemon Does

Three things in essence: **configure the serial port, send commands, read events**.

### 6.1 Configuring the Serial Port (3M + hardware flow control)

```c
t.c_cflag = B3000000 | CS8 | CREAD | CLOCAL | CRTSCTS;
```
- `B3000000`: 3 million baud rate (the Bluetooth engine switches to this high-speed setting after initialization)
- `CRTSCTS`: enables hardware flow control (the two UART lines do flow control; without it at high speed, packets are dropped)
- `VMIN=1`: blocking read, returns only after reading at least 1 byte — **this was the key fix for the early frame-truncation bug**

### 6.2 Reading a Complete H4 Packet

You cannot read blindly; you must read the full length according to the frame header:

```c
read(fd, buf, 1);              // 先读类型字节
if(buf[0] == H4_EVT) {         // 0x04 = 事件
    read(fd, buf+1, 2);        // 读 事件码(1) + 长度(1)
    plen = buf[2];
    while(没读够 plen) read(...); // 把参数读完
}
```

> Early bug: with non-blocking reads, only 7 bytes were read at once and the function returned, causing garbled parsing of command responses. It became stable only after changing to "read the full length according to the frame header".

### 6.3 The Complete Scanning Flow

```c
send_cmd(0x0c1a, 0x03);        // ① 先开扫描使能（厂商隐藏要求！）
send_cmd(OGF_INQUIRY, inq);     // ② 发 Inquiry
while(没到超时) {
    read_pkt(...);
    if(事件是 Inquiry Result)  解析出 BD_ADDR / 设备类 / RSSI
    if(事件是 Inquiry Complete) break;
}
send_cmd(OCF_INQUIRY_CANCEL);   // ③ 取消扫描
```

### 6.4 External Interface: unix socket

The daemon does not speak a complex protocol; it just opens a `/tmp/bt_ctl.sock`, and the GUI connects and sends one-line text commands:

```
state            → 返回 ON/OFF
on / off         → 开关
scan 8           → 扫 8 秒，返回 OK + 设备列表(BD_ADDR 设备类 RSSI)
connect <mac>    → 连接指定设备
```

The GUI (LVGL page) only sends and receives strings and **does not need to understand Bluetooth at all**. This is the value of layering.

---

## 7. A2DP Real Audio Playback (new in v1.0.3)

What came before was only "able to connect". To actually produce sound, you must go through **A2DP** (Advanced Audio Distribution Profile).

### 7.1 Audio Pipeline

```
屏幕点歌
  → mplayer -ao pcm:file=/tmp/bt_audio.fifo -format s16le
  → /tmp/bt_audio.fifo (命名管道)
  → daemon 读 PCM → SBC 编码 → 打成 ACL 数据包
  → UART → 蓝牙音箱 → 喇叭出声
```

Why a **named pipe (fifo)**? Because Alpine has no audio server like PulseAudio. The simplest approach:
mplayer writes the decoded PCM not to the sound card but into a file (fifo), and the daemon reads PCM from this file, encodes it, and sends it to the speaker.

### 7.2 Three Key Parameters Found the Hard Way

| Problem | Symptom | Truth |
|---|---|---|
| **Byte order** | the melody is audible, but it is all static noise | mplayer outputs **big-endian** PCM by default, while the daemon reads it as native **little-endian** int16 → the data is completely garbled. Adding `-format s16le` (forcing little-endian) makes it clear |
| **Judgment timing** | clicking a song produces no sound, mplayer fell back to `-ao null` | the Bluetooth state check `bt_audio_connected()` was written inside the forked child process, after stdout was redirected with dup2, causing the socket connection to fail. It must be moved into the **parent process before fork** |
| **Frame parameters** | playback stops after a few seconds | following Android's gold standard: SBC bitpool=35, 7 frames per packet, 20ms single sends, shallow send window, exit Sniff mode before Start — only by copying Android exactly is it stable |

> Methodology: **when "sound comes out but it is wrong", first suspect the data format (byte order/sample rate/channels), not a protocol error.**

---

## 8. Troubleshooting Methodology (check this way when porting)

```
没反应/连不上
  ├─ 第①层：SDIO 枚举了吗？BT-OPEN OK 吗？权限够吗？
  ├─ 第②层：往 ttyS0 发 Reset，收得到事件吗？(收不到=串口/波特率/流控错)
  ├─ 第③层：btwrite 唤醒了吗？回 SPRD3 了吗？
  ├─ 第④层：标准命令 Read Version 正常吗？扫描前开 Scan Enable 了吗？
  └─ 第⑤层：UI 命令发对了吗？socket 连上 daemon 了吗？

有声不对
  ├─ 字节序(s16le)、采样率(44100)、声道(2)
  └─ SBC 参数(bitpool/每包帧数)

莫名复位
  └─ 看串口有没有回引导器帧(7e...7e)= 引擎崩了，多半是唤醒/发送时序问题
```

**The reference machine is a goldmine**: there is another machine of the same device model running native Android. Connect it via ADB and capture the real ttyS0 traffic when it boots/enables Bluetooth — this is ten times faster than black-box guessing. Our `btwrite`, `Scan Enable`, and SBC parameters were all reverse-engineered this way through comparison.

---

## 9. General Checklist for Porting to Similar Devices

Next time you encounter "an Android kernel + a different userland, with Bluetooth needing to be brought up again", follow this order:

1. **Identify the chip**: check whether it is a combo chip, whether data goes over SDIO or something else, and whether HCI goes over UART or SDIO.
2. **Find the vendor's original sequence**: read the vendor's original `init.*.rc` / `ueventd.rc` to find download, power-on, wake-up, and HCI nodes. **Reusable binaries (download/wcnd) can be reused directly in the chroot.**
3. **Verify layer by layer**: verify each layer according to the pass criteria in §2, one layer at a time, without skipping layers.
4. **Solve permissions**: proc/sys node permissions and ownership inside the chroot are the number one pitfall in porting.
5. **Write the minimal daemon**: implement only the commands you need (on/off/scan/connect/audio); do not port the entire protocol stack right away.
6. **Capture reference packets**: if you have a same-model vendor machine, use ADB to capture and replay real traffic, saving countless hours of black-box time.
7. **Harden the boot**: write the entire chain as a boot script so it comes up automatically after reboot.

---

## 10. What This Wiki Wants You to Remember

- **Bluetooth = a small processor that needs timing care**, not a software switch.
- **A combo chip's firmware is WiFi+BT combined**; bringing up WiFi often means the Bluetooth firmware is already in place.
- **Layer-by-layer verification** is the master key: each layer has one pass criterion; if it fails, do not skip layers.
- **Vendor hidden requirements** (Scan Enable, periodic btwrite wake-up, SBC parameters) can only be discovered through **controlled experiments** and **vendor reference machines**; they are not in the specification books.
- **Porting = borrow whatever can be borrowed, rewrite minimally**: reuse the original binaries' sequences directly, and rewrite only the most essential HCI layer.
- **When "no response", first suspect the lower layer/permissions/wake-up; when "sound is wrong", first suspect the data format.**

---

> Companion documents:
> - `HT0蓝牙拉起_部署交付文档.md` —— how to deploy on a new device (operations layer)
> - `蓝牙芯片打通_操作手册.md` —— manual troubleshooting steps
> - `蓝牙打通_工作过程总结.md` —— the complete timeline of pitfalls hit this time
> - `蓝牙启动流程_安卓vsAlpine对比.md` —— step-by-step comparison
> - this article —— why it is done this way (principles layer)
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
