---
title: "藍牙芯片打通_故障排查手冊"
date: 2026-09-13 15:58:12
lang: zh-TW
search: true
categories:
- 硬件模块打通
- 蓝牙
tag:
- 蓝牙
- WCN
permalink: zh-tw/2026/09/13/bt-07-md/
---


# 展訊 SC9832A 藍牙故障排查手冊 —— HT0 / spd-box

> **用途**：藍牙起不來、掃不到、沒響應時，按本手冊定位根因。每一行命令均取自設備實測。
> **使用方式**：先看 §1 分層速查總表定位到層 → 跳到對應章節 → 用「定位命令」確認 → 按「修復」處理。
> **配套**：人工操作手冊（第 8 章速查表）、AI 指導手冊（§7 決策表）為精簡版；本文是全量版。

---

## 0. 排障紀律（先讀，違反會浪費時間）

1. **分層定位，不跨層瞎試**：四層模型——①固件/物理（download→SDIO 0x2331）→ ②上電（wcnd+BT-OPEN→CMD OK）→ ③引擎（btwrite 喚醒→HCI 響應）→ ④應用（daemon→socket→LVGL）。哪層不過只查該層及其上游。
2. **先看日誌再看進程**：日誌順序 `/var/log/wifi_boot.log`（wifi 鏈）→ `/tmp/bt_once.log`（BT-OPEN）→ `/tmp/btud.log` + `/tmp/btud_dbg.log`（daemon）→ `dmesg | tail`。
3. **download 常駐勿殺**：全殺會破壞 WiFi/藍牙固件狀態，只能整機重啟恢復。
4. **殺進程一律 `pkill -9 -x <名字>`**，禁止 `ps | grep` 內嵌模式（會誤殺執行命令的 shell 自身）。
5. **重啟後必做 mdbg chmod**（開機腳本已自動做，手動調試時別忘）：
   `chmod 666 /tmp/aand/proc/mdbg/*; chmod 666 /proc/mdbg/*; echo 0 > /proc/mdbg/wdtirq`
6. **先確認 WiFi 層**：藍牙與 WiFi 同芯片，WiFi 沒拉起來藍牙必掛。`cat /sys/bus/sdio/devices/mmc2:8800:1/device` 必須為 `0x2331`。

---

## 1. 分層故障速查總表（一頁定位）

| 現象（症狀） | 大概率根因 | 定位命令 | 章節 |
|---|---|---|---|
| `SDIO not enumerated, download may have failed` | 固件下載未完成 / chroot 環境不全 | `cat /sys/bus/sdio/devices/mmc2:8800:1/device` | §2 |
| `bind logdw failed: No such file or directory` | logdw 未就位 | `ls -la /tmp/logdw` | §2 |
| download 卡住 / pid 為空 | chroot 缺庫/節點/軟鏈 | `ps -eo pid,comm \| grep download` | §2 |
| BT-OPEN 返回 FAIL | mdbg 權限 600 | `cat /tmp/bt_once.log` | §3 |
| wcnd 沒起 / bt_once 無輸出 | 進程沒起來 / 時序 | `ps -ef \| grep '[w]cnd'` | §3 |
| HCI 無響應 / 只回一次 SPRD3 幀 | 缺 btwrite 喚醒 | `[ -w /proc/bluetooth/sleep/btwrite ]` | §4 |
| daemon 日誌 "Not a tty" | tty ldisc 被佔 | `cat /tmp/btud.log` | §4 |
| 掃描無結果（scan 返回 OK 0） | 未先 Write Scan Enable | 用 daemon `scan` 命令 | §5 |
| socket connect 失敗 / state 無響應 | daemon 多實例 / 瞬時窗口 | `ps -eo comm \| grep '[b]t_user_daemon'` | §5 |
| 重啟後藍牙不自動拉起 | 自啟鏈缺失 / 順序錯 | `rc-update show` | §6 |
| LVGL 藍牙頁反覆變回舊版 | watchdog 指向 build 路徑 | `cat /root/lvgl_watchdog.sh` | §6 |
| WiFi/藍牙一起沒了 | download 被殺 | `dmesg \| tail` | §7 |
| SSH 重啟後不通 | USB 口切換 | 輪詢 `<設備IP>` / `<WiFi-IP>` | §7 |

---

## 2. 物理 / 固件層（① download → SDIO）

### 2.1 `SDIO not enumerated, download may have failed`

- **定位**：`cat /sys/bus/sdio/devices/mmc2:8800:1/device`（空 = 未枚舉）；`tail -20 /tmp/logdw.log`；`dmesg | tail -30`
- **可能根因與修復**：

| 根因 | 確認 | 修復 |
|---|---|---|
| chroot 環境不全 | `ls /tmp/aand/bin/download /tmp/aand/lib/libiwnpi.so /tmp/aand/etc/marlinba/connectivity_configure.ini` | 重建 chroot（見 WiFi 操作手冊 4.4）或重跑 `sh /etc/local.d/wifi.start` |
| `/dev/power_ctl` 不可寫 | `[ -w /dev/power_ctl ] && echo OK` | 檢查節點權限；download 靠它寫 SLEEP→POWER_ON→POWER_RST 上電序列 |
| by-name 軟鏈缺失 | `ls -l /tmp/aand/dev/block/platform/sdio_emmc/by-name/` | `ln -sf /dev/block/mmcblk0p14 .../wcnfdl; ln -sf /dev/block/mmcblk0p15 .../wcnmodem` |
| 掛載缺失 | `mountpoint -q /tmp/aand/dev || echo NOT` | `mount --bind /dev /tmp/aand/dev; mount -t proc proc /tmp/aand/proc` |
| DTB 不對（boot 分區） | `dmesg \| grep -i sdio` | 確認 p16 已寫 Android 原版 dtb（WiFi 操作手冊 4.3） |
| download 沒起來 | `ps -eo pid,comm \| grep download` | `setsid chroot /tmp/aand /bin/download -i wlan0 >/tmp/dl.log 2>&1 &` |

### 2.2 `bind logdw failed: No such file or directory`

- **根因**：`/tmp/logdw` 不存在或不可執行（logdw 是 download 的日誌守護）。
- **修復**：`ls -la /tmp/logdw`；缺失則 `cp /mnt/android_sys/bin/logdw /tmp/logdw 2>/dev/null || cp /mnt/android_sys/bin/download_logd /tmp/logdw; chmod +x /tmp/logdw`。

### 2.3 download 進程反覆退出 / pid 為空

- **定位**：`ps -eo pid,comm | grep download`；`tail -30 /tmp/dl_run.log`
- **修復**：先 `pkill -9 -f logdw; pkill -9 -f 'wcnd'` 清殘留，再 `setsid /tmp/logdw &`、`setsid chroot /tmp/aand /bin/download -i wlan0 &`；若仍退，用 `strace chroot /tmp/aand /bin/download -i wlan0 2>&1 | grep -E "open|ENOENT"` 看缺什麼。

---

## 3. 藍牙上電層（② wcnd + BT-OPEN）

### 3.1 BT-OPEN 返回 FAIL（頭號問題）

- **定位**：`cat /tmp/bt_once.log`（期望 `push(17): WCNBTWIFI-CMD OK`；FAIL 則 600 權限問題）
- **根因**：chroot 內 `/tmp/aand/proc/mdbg/*` 權限 600，wcnd 無權限操作調制解調器調試節點。
- **修復**：
  ```sh
  chmod 666 /tmp/aand/proc/mdbg/* 2>/dev/null
  chmod 666 /proc/mdbg/* 2>/dev/null
  echo 0 > /proc/mdbg/wdtirq 2>/dev/null
  # 重啟 wcnd + 重發 BT-OPEN
  pkill -9 -f 'wcnd'; sleep 1
  setsid chroot /tmp/aand /bin/wcnd >/tmp/wcnd_console.log 2>&1 </dev/null &
  sleep 2
  setsid /tmp/bt_once 900 >/tmp/bt_once.log 2>&1 </dev/null &
  sleep 3; cat /tmp/bt_once.log
  ```
- **提示**：此權限**重啟後必丟**，開機腳本 `bt_bringup.start` 已自動執行；手動調試時勿忘。

### 3.2 wcnd 沒起來 / bt_once 無任何輸出

- **定位**：`ps -ef | grep '[w]cnd'`（wcnd 是 chroot 內進程，`comm` 可能顯示為別的名字，用 `-ef` 看完整命令行）
- **修復**：確保 WiFi 已拉起（SDIO 0x2331）後按 3.1 的啟動序列重跑；注意 wcnd 依賴 `/tmp/aand` 環境和 download 常駐。

---

## 4. 引擎 / 喚醒層（③ btwrite → HCI）

### 4.1 HCI 無響應 / 只回一次 SPRD3 幀（關鍵！）

- **現象**：`bt_probe_full` 發 HCI Reset 收不到響應；或只收到一次 `55 7e 00 81 00 06 53 50 52 44 33 00 57 0a 7e`（SPRD3 身份幀）後無後續。
- **根因**：藍牙引擎上電後默認省電休眠，**必須週期性 btwrite 喚醒**才有 HCI 響應。
- **定位**：`[ -w /proc/bluetooth/sleep/btwrite ] && echo WRITABLE || echo NO`；`ps -eo args | grep '[b]t_wake.sh'`
- **修復**：啟動喚醒腳本（每 1.5~2s 寫 1）：
  ```sh
  setsid /bin/sh /tmp/bt_wake.sh >/dev/null 2>&1 </dev/null &
  echo 1 > /proc/bluetooth/sleep/btwrite && echo WRITE_OK
  ```
- **注意**：`bt_wake.sh` 必須在藍牙工作期間一直跑；掃描時尤其不能停。

### 4.2 SPRD3 幀的含義

- `55 7e 00 81 ... 53 50 52 44 33 ...` 中的 `SPRD3` 是展訊啟動標識——**收到它說明 HCI 通道活了、固件在跑**。此時若標準 HCI 命令無響應，優先查喚醒（4.1）與 daemon 波特率（4.3）。

### 4.3 daemon 日誌 "Not a tty" / HCI 全無響應

- **根因**：ttyS0 的 line discipline（ldisc）被佔/被破壞（早期測試殘留），打開失敗或收發異常。
- **定位**：`tail -10 /tmp/btud.log`
- **修復**：用 python 恢復 N_TTY（TIOCSETD=0x5421，N_TTY=0）：
  ```sh
  python3 -c "import fcntl; f=open('/dev/ttyS0',2); fcntl.ioctl(f,0x5421,b'\x00\x00\x00\x00')"
  pkill -9 -x bt_user_daemon; sleep 1
  setsid /usr/local/bin/bt_user_daemon >/tmp/btud.log 2>&1 </dev/null &
  ```
- **死路**：`/tmp/reset_tty` 恢復 ldisc 會段錯誤，勿用。

### 4.4 波特率 / UART 配置問題

- **節點**：`/sys/devices/70000000.uart/uart_conf`（`0x1a1`=115200、`0x341`=57600、daemon 用 3M）
- **規則**：daemon 直接以 `B3000000 + CRTSCTS` 打開 ttyS0；**不要**在固件初始化後擅自改 uart_conf，否則固件與 daemon 波特率失配 → HCI 無響應。
- **定位**：`cat /tmp/btud_dbg.log | tail -20`（看 TX/RX hex 是否亂碼）。

### 4.5 內核 hci0 註冊但 TX=0

- **根因**：3.10.65 安卓定製內核與自編 `hci_uart.ko` 的 tty_struct 偏移不匹配；Alpine gcc14.2 編老內核模塊報 `invalid module format`。
- **結論（死路）**：**放棄內核驅動路線**，使用用戶態 daemon（讀寫 /dev/ttyS0，不依賴內核藍牙協議棧）。

---

## 5. 應用層（④ daemon → socket → LVGL）

### 5.1 socket connect 失敗

- **定位**：`[ -S /tmp/bt_ctl.sock ] && echo YES || echo NO`；`ps -eo comm | grep '[b]t_user_daemon'`
- **根因**：daemon 多實例搶 socket / socket 文件殘留。
- **修復**：
  ```sh
  pkill -9 -x bt_user_daemon; sleep 1
  rm -f /tmp/bt_ctl.sock
  setsid /usr/local/bin/bt_user_daemon >/tmp/btud.log 2>&1 </dev/null &
  ```

### 5.2 state 查詢無響應（Terminated）/ 重啟後瞬時無響應

- **現象**：重啟後 socket 存在但 `state` 查詢 6s 超時被殺（返回 Terminated）；稍等幾秒後又正常。
- **根因**：daemon 啟動與藍牙上電鏈（bt_bringup.start）無先後保證，daemon 在引擎未就緒時先打開 ttyS0 進入初始化，瞬時阻塞。
- **修復（已固化）**：`/etc/init.d/bt_daemon` 的 `depend()` 應含 `after local`（確保上電鏈先完成）；驗證：
  ```sh
  cat /etc/init.d/bt_daemon | grep -A4 depend
  rc-service bt_daemon restart
  # 若仍無響應，等 10~15s 重試 state；仍不行按 5.1 單實例重啟
  ```
- **快速重試命令**：
  ```sh
  printf 'state\n' | timeout 5 python3 -c "import socket,sys
  s=socket.socket(socket.AF_UNIX); s.connect('/tmp/bt_ctl.sock')
  s.sendall(sys.stdin.buffer.read()); s.shutdown(socket.SHUT_WR)
  print(s.recv(4096).decode())"
  ```

### 5.3 掃描無結果（OK 0）

- **根因**：未先發 `Write Scan Enable` 就發 Inquiry——固件接受 Inquiry（CMD_STATUS 0x00）但永不回 Inquiry Result。
- **修復**：**走 daemon 的 `scan` 命令**（內部已處理順序），勿裸發 Inquiry：
  ```sh
  printf 'scan 15\n' | timeout 25 python3 -c "import socket,sys
  s=socket.socket(socket.AF_UNIX); s.connect('/tmp/bt_ctl.sock')
  s.sendall(sys.stdin.buffer.read()); s.shutdown(socket.SHUT_WR)
  d=b''
  while True:
      x=s.recv(4096)
      if not x: break
      d+=x
  print(d.decode())"
  # 期望 OK <N> + 每行 bd_addr class rssi
  ```
- 若環境確實無藍牙設備，N=0 不算故障。

### 5.4 藍牙頁開關無反應

- **定位**：確認 daemon 單實例 + state 返回 `OK ON`（先過 5.1/5.2）；再看 LVGL 日誌 `/tmp/lvgl_demo.log` 是否有 socket 報錯。
- **修復**：多為 daemon 側問題，按 5.1 重置；頁面本身只做 socket 文本交互，不持有 HCI 狀態。

---

## 6. 系統 / 自啟層

### 6.1 重啟後藍牙不自動拉起

- **定位**：`rc-update show | grep -E 'bt_daemon|local'`；`ls /etc/local.d/`（應有 wifi.start、bt_bringup.start、lvgl_demo.start）
- **修復**：
  ```sh
  # 缺上電鏈腳本則創建（內容見 AI工作流 deploy/bt_bringup.start）
  # 缺 daemon 自啟則：
  rc-update add bt_daemon default
  rc-service bt_daemon start
  ```
- **完整自啟鏈**：`wifi.start`（WiFi 前提）→ `bt_bringup.start`（sleep 8 + mdbg + wcnd + bt_once + bt_wake）→ `bt_daemon`（openrc，`after local`）。

### 6.2 daemon 與上電鏈順序錯亂

- **症狀**：重啟後 daemon 進程在但 state 長期無響應。
- **修復**：確認 `/etc/init.d/bt_daemon` 的 `depend()` 含 `after local`；改後 `rc-update del bt_daemon default; rc-update add bt_daemon default; reboot` 驗證。

### 6.3 LVGL 藍牙頁反覆變回舊版 / 頁面缺失

- **根因**：watchdog / 開機腳本指向 `build/` 舊路徑。
- **修復**：統一指向 `/usr/local/bin/lvgl_demo`；確認 `bluetooth_page.c/h` 已編譯進鏡像並註冊（launcher 圖標）。

---

## 7. 通用系統問題

| 症狀 | 根因 | 修復 |
|---|---|---|
| WiFi/藍牙一起沒了 | download 被殺 / 固件狀態破壞 | **整機重啟**，別手動"乾淨重來"；重啟後自動鏈恢復 |
| 重啟後 SSH 不通 | USB 口複用切換 | 輪詢 `<設備IP>` 與 `<WiFi-IP>`（本機可用 skill 的 ssh_wait.py） |
| 日期退回 2016 | RTC 未同步 | `hwclock -s` / ntpd；確認 `/etc/local.d/time_sync.start` 存在 |
| 藍牙掃描時 WiFi 掉 | 罕見共存問題 | 確認 download 常駐 + 重啟後優先拉起 WiFi 鏈 |

---

## 8. 診斷工具箱（關鍵節點速查）

| 項目 | 路徑/命令 | 期望 |
|---|---|---|
| SDIO 枚舉 | `cat /sys/bus/sdio/devices/mmc2:8800:1/device` | `0x2331` |
| 固件下載日誌 | `/var/log/wifi_boot.log`、`/tmp/logdw.log`、`/tmp/dl_run.log` | download 完成、無 ERROR |
| BT-OPEN 結果 | `grep 'CMD OK' /tmp/bt_once.log` | `WCNBTWIFI-CMD OK` |
| 喚醒節點 | `[ -w /proc/bluetooth/sleep/btwrite ]` | WRITABLE |
| UART 配置 | `cat /sys/devices/70000000.uart/uart_conf` | daemon 用 3M 打開 |
| HCI 探針 | `/tmp/bt_probe_full 20` | 六步全通 |
| daemon 進程 | `ps -eo comm \| grep '[b]t_user_daemon'` | 單實例 |
| daemon 日誌 | `/tmp/btud.log`（stdout）、`/tmp/btud_dbg.log`（TX/RX hex） | 無 Not a tty、有 RX |
| socket | `[ -S /tmp/bt_ctl.sock ]` | YES |
| 開機腳本 | `ls /etc/local.d/`、`rc-update show` | wifi.start / bt_bringup.start / bt_daemon 均在 default |

**進程鏈**：`logdw → download(常駐) → wcnd → bt_once(BT-OPEN) → bt_wake.sh(btwrite) → bt_user_daemon(socket)`

---

## 9. 已驗證死路（不要重試）

| 路線 | 結果 |
|---|---|
| 內核 `hci_uart.ko` | hci0 能註冊但 TX=0 / up 超時，驅動偏移不匹配 |
| vhci 虛擬方案 | 用戶否決 |
| 反覆黑盒試引導命令序列 | 不完整、狀態不穩定，且不影響掃描功能 |
| `/tmp/reset_tty` 恢復 ldisc | 段錯誤，用 python ioctl |
| 殺 download "重啟乾淨環境" | 破壞固件狀態，整機重啟才恢復 |
| `ps \| grep` 內嵌殺進程 | 誤殺 shell 自身 |

---

## 10. 紅線（任何情況下）

1. **download 常駐勿殺**。
2. **驅動順序**：`marlin_fm.ko` 先、`sprdwl.ko` 後。
3. 殺進程：`pkill -9 -x <名字>`。
4. 重啟後 mdbg chmod 666（腳本自動做）。
5. 藍牙工作期間 `bt_wake.sh` 不停。
6. 不修改 USB OTG / 網絡模式配置。

---

*配套：藍牙芯片打通_操作手冊（人用）、藍牙打通_AI指導手冊（AI 用）、HT0藍牙拉起_部署交付文檔（部署用）*
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
