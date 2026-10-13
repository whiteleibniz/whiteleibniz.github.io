---
title: "藍牙芯片打通_操作手冊"
date: 2026-09-13 15:27:33
lang: zh-TW
search: true
categories:
- 硬件模块打通
- 蓝牙
tag:
- 蓝牙
- WCN
permalink: zh-tw/2026/09/13/bt-06-md/
---


# 展訊 SC9832A 藍牙芯片打通 —— 人工操作手冊

> 適用範圍：保留安卓內核 + switchroot 到 Alpine Linux 的展訊 SC9832A 設備（hostname `spd-box`，內核 `Linux 3.10.65`）
> 目的：在不依賴 AI 助手的情況下，人工手動完成藍牙底層拉起、HCI 通道驗證、用戶態守護進程部署與開機自啟
> 本文所有命令均已在設備上實測通過

---

## 0. 前置概念（30 秒建立直覺）

這臺設備的 WiFi 和藍牙是**同一顆展訊 Marlin combo 芯片**（WCN），SDIO 承載數據通道，UART（ttyS0）承載藍牙 HCI 控制通道。芯片固件不在系統裡"常駐"，每次開機都必須由安卓原版 `download` 引導器把固件燒進芯片，之後芯片才能工作。

```
開機 → download 燒固件 → SDIO 枚舉 → 藍牙固件由 wcnd 觸發 BT-OPEN → btwrite 週期性喚醒 → HCI 通道可用
```

| 角色 | 文件/進程 | 幹什麼 |
|---|---|---|
| 固件燒錄 | `/tmp/aand/bin/download`（chroot 安卓環境） | 把 wcnfdl/wcnmodem 分區固件經 SDIO 燒進芯片，芯片上電啟動 |
| 上電序列 | `/tmp/aand/bin/wcnd` | 收到 BT-OPEN 命令後驅動藍牙子系統上電 |
| 上電確認 | `/tmp/bt_once 900` | 發送 BT-OPEN，返回 `WCNBTWIFI-CMD OK` 即成功 |
| 週期性喚醒 | `/tmp/bt_wake.sh` | 每 1.5~2 秒向 `/proc/bluetooth/sleep/btwrite` 寫 1，防止藍牙引擎休眠 |
| HCI 服務 | `/usr/local/bin/bt_user_daemon` | 打開 /dev/ttyS0（3M+CRTSCTS）走 H4 協議，提供 unix socket 供應用查詢 |

---

## 1. 環境準備

### 1.1 設備狀態確認

```sh
# SSH 登錄
ssh root@<設備IP>        # 
# 或
ssh root@<WiFi-IP>           # WiFi 網絡地址

# 確認內核與主機名
uname -a                        # 期望: Linux 3.10.65 ... armv7l
hostname                        # 期望: spd-box

# 確認 chroot 安卓環境存在（download 依賴它）
ls /tmp/aand/bin/download /tmp/aand/bin/wcnd
ls /tmp/aand/etc/marlinba/     # 期望有 connectivity_configure.ini 等
```

> ⚠️ 若 `/tmp/aand` 不存在：需重新搭建 Android 用戶態 chroot 環境（建目錄、鋪 Android system 庫、mount --bind /dev、建 wcnfdl/wcnmodem 分區軟鏈）。詳見 WiFi 操作手冊第 4 章。

### 1.2 工具清單

| 工具 | 用途 | 位置 |
|---|---|---|
| `download` | 固件下載引導器 | `/tmp/aand/bin/download`（chroot 內執行） |
| `wcnd` | 藍牙/WiFi 上電守護 | `/tmp/aand/bin/wcnd`（chroot 內執行） |
| `bt_once` | BT-OPEN 一次性上電觸發 | `/tmp/bt_once` |
| `bt_wake.sh` | btwrite 週期喚醒腳本 | `/tmp/bt_wake.sh` |
| `bt_probe_full` | HCI 全序列探針（診斷） | `/tmp/bt_probe_full` |
| `hci_3m` | 3M 波特率 HCI 原始測試 | `/tmp/hci_3m`（早期診斷用） |
| `bt_user_daemon` | 用戶態 HCI 守護（生產） | `/usr/local/bin/bt_user_daemon` |
| python3 | unix socket 客戶端 | 設備自帶 |

---

## 2. 第一步：拉起 WiFi（藍牙前提，不能跳過）

藍牙芯片與 WiFi 共用同一固件與電源域，**必須先把 WiFi 芯片拉起來**，藍牙才有物理基礎。

```sh
# 1) 清理殘留（不要殺 download！）
pkill -9 -f logdw 2>/dev/null
pkill -9 -f 'wcnd' 2>/dev/null
pkill -9 -x bt_once 2>/dev/null

# 2) 啟動固件下載通道守護
setsid /tmp/logdw >/dev/null 2>&1 </dev/null &

# 3) 固件下載（WiFi 模式，常駐勿殺）
setsid chroot /tmp/aand /bin/download -i wlan0 >/tmp/dl_run.log 2>&1 </dev/null &

# 4) 等待 SDIO 枚舉（10~30 秒）
cat /sys/bus/sdio/devices/mmc2:8800:1/device    # 期望: 0x2331
ls /sys/bus/sdio/devices/                        # 期望出現 mmc2:8800:1

# 5) 加載 WiFi 驅動（順序不能反）
insmod /lib/modules/marlin_fm.ko
insmod /lib/modules/sprdwl.ko
ip link set wlan0 up
ip link show wlan0                              # 出現 wlan0 即成功
```

> 驗證標準：`mmc2:8800:1` 設備號 `0x2331`，`wlan0` 接口存在。

---

## 3. 第二步：藍牙上電序列（BT-OPEN）

### 3.1 修復 mdbg 權限（關鍵！重啟後必做）

BT-OPEN 失敗的頭號原因：chroot 內 `/tmp/aand/proc/mdbg/*` 權限為 600，導致上電命令無響應。

```sh
chmod 666 /tmp/aand/proc/mdbg/* 2>/dev/null
chmod 666 /proc/mdbg/* 2>/dev/null
echo 0 > /proc/mdbg/wdtirq 2>/dev/null
```

### 3.2 啟動 wcnd + 觸發 BT-OPEN

```sh
# wcnd（藍牙/WiFi 上電守護）
ps -ef | grep -q '[w]cnd' || setsid chroot /tmp/aand /bin/wcnd >/tmp/wcnd_console.log 2>&1 </dev/null &
sleep 2

# BT-OPEN 一次性觸發，期望輸出 push(17): WCNBTWIFI-CMD OK
setsid /tmp/bt_once 900 >/tmp/bt_once.log 2>&1 </dev/null &
sleep 3
cat /tmp/bt_once.log          # 看到 "WCNBTWIFI-CMD OK" 即上電成功
```

> 若輸出 `FAIL`：重新執行 3.1 的 chmod（多半是權限問題），再重跑本步。

---

## 4. 第三步：btwrite 週期性喚醒（缺了它 HCI 無響應）

藍牙固件上電後默認進入省電模式，**必須週期性喚醒**才有 HCI 響應。

```sh
# 啟動週期喚醒腳本（每 1.5~2 秒寫 1）
setsid /bin/sh /tmp/bt_wake.sh >/dev/null 2>&1 </dev/null &

# 手動驗證喚醒節點存在且可寫
cat /proc/bluetooth/sleep/btwrite          # 應返回 0 或 1
echo 1 > /proc/bluetooth/sleep/btwrite && echo WRITE_OK
```

> 缺這一步的典型症狀：`bt_probe_full` 發 HCI Reset 後收不到任何響應（或只收到一次 `55 7e ... 53 50 52 44 33`（SPRD3）身份幀後無後續）。

---

## 5. 第四步：HCI 通道診斷（可選，驗證底層）

```sh
# 完整 HCI 探針：六步全通 = 底層 OK
/tmp/bt_probe_full 20 2>&1 | tail -30

# 期望看到：
#   Reset            → 04 0e 04 01 03 0c 00
#   Read Local Ver   → HCI 6.0, 製造商標識 0x1380（展訊）
#   Read BD_ADDR     → 11:22:14:31:93:27
#   Read Buffer Size / Features → ff ff 8d fe（與 pskey feature_set 一致）
#   Write Scan Enable → 成功
```

| 探針步驟 | 意義 |
|---|---|
| HCI Reset | 芯片 HCI 引擎啟動 |
| Read Local Version | 固件版本 / 廠商識別 |
| Read BD_ADDR | 芯片藍牙 MAC |
| Read Buffer Size | HCI 緩衝能力 |
| Read Features | 特性集（驗證 pskey 是否生效） |
| Set Event Mask + Write Scan Enable | 為掃描做準備 |

---

## 6. 第五步：部署用戶態 HCI 守護進程（生產方案）

> 說明：為什麼不用內核 hci_uart 驅動？該設備內核是 3.10.65 安卓定製內核，用戶編譯的 hci_uart.ko 硬編碼 tty_struct 偏移不匹配，hci0 能註冊但 `TX=0`、`hciconfig up` 超時，驅動路線不通。用戶態方案直接讀寫 /dev/ttyS0，不依賴內核協議棧，最可靠。

### 6.1 編譯 daemon

源碼 `bt_user_daemon.c`（本地保存），在設備上編譯：

```sh
gcc -O2 -o /usr/local/bin/bt_user_daemon /tmp/bt_user_daemon.c -lpthread
```

關鍵實現要點（維護時參考）：
- 打開 `/dev/ttyS0`：`B3000000`（3M）+ `CRTSCTS`，`VMIN=1`（阻塞讀）
- H4 協議：按幀頭 `buf[1]=evt / buf[2]=len` 讀取完整幀
- 掃描前必須先發 `Write Scan Enable (0x0c1a, 0x03)` 再發 Inquiry（GIAC `0x33 0x8b 0x9e`），否則固件不回 Inquiry Result
- unix socket `/tmp/bt_ctl.sock`（0666），文本命令：`state` / `on` / `off` / `scan <N>` / `list` / `connect <bd>`

### 6.2 部署 + 自啟（openrc）

```sh
# 單實例啟動
pkill -9 -x bt_user_daemon 2>/dev/null
setsid /usr/local/bin/bt_user_daemon >/tmp/btud.log 2>&1 </dev/null &

# openrc 自啟
cat > /etc/init.d/bt_daemon << 'EOF'
#!/sbin/openrc-run
command="/usr/local/bin/bt_user_daemon"
command_background=yes
pidfile="/run/bt_daemon.pid"
EOF
chmod +x /etc/init.d/bt_daemon
rc-update add bt_daemon default
rc-service bt_daemon start
```

### 6.3 驗證（unix socket 客戶端）

設備端 python3（無 socat）：

```sh
# 查狀態
printf 'state\n' | timeout 5 python3 -c "
import socket,sys
s=socket.socket(socket.AF_UNIX); s.connect('/tmp/bt_ctl.sock')
s.sendall(sys.stdin.buffer.read()); s.shutdown(socket.SHUT_WR)
print(s.recv(4096).decode())"
# 期望: OK ON

# 掃描 15 秒（讀到 EOF）
printf 'scan 15\n' | timeout 25 python3 -c "
import socket,sys
s=socket.socket(socket.AF_UNIX); s.connect('/tmp/bt_ctl.sock')
s.sendall(sys.stdin.buffer.read()); s.shutdown(socket.SHUT_WR)
d=b''
while True:
    x=s.recv(4096)
    if not x: break
    d+=x
print(d.decode())"
# 期望: OK <N>  + 每行一個設備:  bd_addr class rssi
# 實測:  OK 1 / 48:f1:ae:25:7e:48 5a420c 0
```

---

## 7. 開機自啟鏈路（重啟後全自動）

設備重啟後由 `/etc/local.d/` 腳本鏈自動拉起：

```
/etc/local.d/wifi.start    → logdw + download（常駐）+ WiFi 驅動 + wlan0
/etc/local.d/lvgl_demo.start → 啟動 LVGL 桌面（/usr/local/bin/lvgl_demo）
/etc/init.d/bt_daemon      → bt_user_daemon（openrc）
```

> 關鍵紅線：
> - **download 常駐勿殺** —— 全殺會破壞 WiFi/藍牙固件狀態，需要重啟設備才能恢復
> - 重啟後必須重新執行 3.1 的 `chmod 666 /tmp/aand/proc/mdbg/*`（腳本里已自動做）
> - 進程清理一律用 `pkill -9 -x bt_user_daemon`，不要用 `ps | grep` 內嵌模式（會誤殺執行命令的 shell 自身）

---

## 8. 常見故障速查

| 現象 | 原因 | 處理 |
|---|---|---|
| BT-OPEN 返回 FAIL | `/tmp/aand/proc/mdbg/*` 權限 600 | `chmod 666 /tmp/aand/proc/mdbg/*` 後重試 |
| HCI 無響應 / 只回一次 SPRD3 幀 | 缺 btwrite 喚醒 | 啟動 `/tmp/bt_wake.sh`，確認 `/proc/bluetooth/sleep/btwrite` 可寫 |
| 掃描不出設備 | 未先發 Write Scan Enable | 走 daemon 的 `scan` 命令（內部已處理），勿裸發 Inquiry |
| socket connect 失敗 | daemon 多實例搶 socket | `pkill -9 -x bt_user_daemon` 後單實例重啟 |
| daemon 日誌報 "Not a tty" | tty ldisc 被佔 | python `fcntl.ioctl(fd, 0x5421, b'\x00\x00\x00\x00')` 恢復 N_TTY |
| 內核 hci0 註冊但 TX=0 | 3.10 內核 hci_uart 偏移不匹配 | 放棄內核驅動，使用用戶態 daemon |
| WiFi 起不來 | download 被誤殺 | 重啟設備，按第 2 章重新拉起 |

---

## 9. 涉及的關鍵節點 / 參數速查

| 項目 | 值 |
|---|---|
| SDIO 設備 | `/sys/bus/sdio/devices/mmc2:8800:1`，device=0x2331 |
| HCI 串口 | `/dev/ttyS0`，波特率 3M（B3000000）+ CRTSCTS，H4 協議 |
| 喚醒節點 | `/proc/bluetooth/sleep/btwrite`（寫 1，每 1.5~2s） |
| UART 配置節點 | `/sys/devices/70000000.uart/uart_conf`（0x1a1=115200，0x341=57600） |
| socket | `/tmp/bt_ctl.sock`（0666） |
| 調試日誌 | `/tmp/btud_dbg.log`（TX/RX hex）、`/tmp/btud.log`（stdout） |
| 固件真實 MAC | `11:22:14:31:93:27`（固件響應，非偽造） |
| pskey | `/mnt/android_sys/lib/modules/pskey_bt.txt`（feature_set/device_addr），download 經 `connectivity_configure.ini` [SETCTION 6] 下發 |
| 已知可掃設備 | `48:f1:ae:25:7e:48`（class=5a420c 手機） |
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
