---
title: "藍牙打通_AI指導手冊"
date: 2026-09-13 15:27:33
lang: zh-TW
search: true
categories:
- 硬件模块打通
- 蓝牙
tag:
- 蓝牙
- WCN
permalink: zh-tw/2026/09/13/bt-04-ai-md/
---


# 展訊 SC9832A 設備（HT0）藍牙打通 —— AI 執行指導手冊

> **讀者對象**：AI 助手（豆包 / 其他大模型），需在同類設備（展訊 SC9832A，安卓內核 + Alpine 用戶態）上快速解決藍牙不可用問題
> **使用方式**：先讀 §1–§3 建立上下文 → 按 §5 標準流程執行 → 按 §6 驗證 → 遇故障查 §7 決策表
> **核心價值**：本文所有事實均已實測驗證；照著做最快 5 分鐘確認底層是否通，避免重複數天踩坑

---

## 1. 設備與環境速覽

| 項目 | 值 |
|---|---|
| 設備型號 | HT0（對照機：H709，跑安卓 6.0，可作信息源） |
| 主機名 / 內核 | `spd-box` / `Linux 3.10.65 #13 SMP PREEMPT armv7l` |
| 系統組合 | **保留安卓 6.0 內核 + switchroot 到 Alpine Linux**（關鍵！） |
| SSH | `root@<設備IP>`（RNDIS 調試口，密碼見環境記錄）/ WiFi: `<WiFi-IP>` |
| 無線芯片 | 展訊 **Marlin combo WCN**（WiFi + 藍牙同一顆芯片） |
| 藍牙 HCI | `/dev/ttyS0`，3M 波特率 + CRTSCTS，H4 協議 |
| 藍牙喚醒 | `/proc/bluetooth/sleep/btwrite`（寫 1） |
| 當前狀態 | 底層已打通，用戶態 daemon + LVGL 藍牙設置頁已部署，開機自啟 |

> ⚠️ 重啟後 SSH 可能短暫不可達（USB 口切換），需輪詢重試；`/tmp` 目錄重啟後保留（chroot 環境、工具都在）。

---

## 2. 已確認的硬事實（無需重新探查，直接信任）

1. **藍牙固件隨 WiFi 一起下載**：執行 `chroot /tmp/aand /bin/download -i wlan0` 時，combo 固件（含藍牙部分）已整體燒入芯片 → **WiFi 拉起 = 藍牙固件已就緒**，不需要單獨燒藍牙固件。
2. **pskey 已生效**：download 讀 `/tmp/aand/etc/marlinba/connectivity_configure.ini` 的 [SETCTION 6] 下發藍牙 pskey；實測 Read Features 返回 `ff ff 8d fe` 與 `pskey_bt.txt` 的 feature_set 完全一致 → **不要糾結"缺 pskey"，不需要單獨發**。
3. **BT-OPEN 失敗頭號根因**：chroot 內 `/tmp/aand/proc/mdbg/*` 權限 600 → `chmod 666 /tmp/aand/proc/mdbg/*` 後返回 `WCNBTWIFI-CMD OK`。重啟後必做。
4. **btwrite 是 HCI 有響應的前提**：藍牙引擎省電休眠，必須週期性（1.5~2s）寫 1 喚醒；缺它 → HCI 無響應或只回一次 SPRD3 身份幀。
5. **SPRD3 身份幀 = 引擎啟動信號**：`55 7e 00 81 00 06 53 50 52 44 33 00 57 0a 7e`（"SPRD3"=展訊標識），收到它說明 HCI 通道活了。
6. **掃描前置**：必須**先發 Write Scan Enable（0x0c1a, 0x03）再發 Inquiry**（GIAC `0x33 0x8b 0x9e`），否則 Inquiry 被接受（CMD_STATUS 0x00）但永遠無 Inquiry Result。
7. **固件真實 MAC**：`11:22:14:31:93:27`（探針響應值，不是偽造）。
8. **波特率**：固件 BT 初始化後 115200→3M；daemon 直接以 3M 打開 ttyS0。
9. **已掃到設備樣例**：`48:f1:ae:25:7e:48 class=5a420c`（手機，BR/EDR）。
10. **進程鏈**：`logdw → download(常駐) → wcnd → bt_once(BT-OPEN) → bt_wake.sh(btwrite) → bt_user_daemon(socket)`。

---

## 3. 已驗證死路（不要重試，浪費輪次）

| 路線 | 結果 | 原因 |
|---|---|---|
| 內核 `hci_uart.ko` 驅動 | hci0 能註冊（DOWN INIT RUNNING）但 `hciconfig up` 超時、TX=0 | 3.10 安卓定製內核，tty_struct 偏移與驅動不匹配；Alpine gcc14.2 編老內核模塊報 invalid module format |
| vhci 虛擬方案 | 用戶明令否決 | — |
| 反覆黑盒試引導命令序列 | 不完整、狀態不穩定 | 引導協議需對照機抓包，且**不影響掃描功能達成**，不值得死磕 |
| `ps \| grep` 內嵌模式殺 daemon | 誤殺執行命令的 shell 自身 | 用 `pkill -9 -x bt_user_daemon` |
| `/tmp/reset_tty` 恢復 ldisc | 段錯誤 | 用 python `fcntl.ioctl(fd, 0x5421, b'\x00\x00\x00\x00')`（TIOCSETD=0x5421, N_TTY=0） |
| 殺掉 download "重啟乾淨環境" | 破壞 WiFi/藍牙固件狀態，需整機重啟恢復 | **download 常駐勿殺** |

---

## 4. 系統模型：四層 + 每層驗證標準

```
① 固件/物理層    download 燒固件 → SDIO 枚舉 0x2331
                 驗證: cat /sys/bus/sdio/devices/mmc2:8800:1/device  → 0x2331
② 上電層         wcnd + BT-OPEN → WCNBTWIFI-CMD OK
                 驗證: cat /tmp/bt_once.log 含 "WCNBTWIFI-CMD OK"
③ 引擎層         btwrite 喚醒 → HCI 響應 + SPRD3 幀
                 驗證: bt_probe_full 收到 Reset 響應 04 0e 04 01 03 0c 00
④ 應用層         daemon socket → LVGL 頁面
                 驗證: printf 'scan 15\n' 客戶端 → OK N + 設備行
```

**排查紀律**：哪一層驗證不過，就只在這一層及其上游找原因，不要跨層瞎試。

---

## 5. 標準執行流程（可直接複製）

### 5.1 確認環境

```sh
uname -a; hostname
ls /tmp/aand/bin/download /tmp/aand/bin/wcnd /tmp/bt_once /tmp/bt_wake.sh
ls /usr/local/bin/bt_user_daemon /tmp/bt_probe_full
```

### 5.2 拉起 WiFi（藍牙前提）

```sh
pkill -9 -f logdw 2>/dev/null; pkill -9 -f 'wcnd' 2>/dev/null; pkill -9 -x bt_once 2>/dev/null
setsid /tmp/logdw >/dev/null 2>&1 </dev/null &
setsid chroot /tmp/aand /bin/download -i wlan0 >/tmp/dl_run.log 2>&1 </dev/null &
sleep 15
cat /sys/bus/sdio/devices/mmc2:8800:1/device     # 期望 0x2331
insmod /lib/modules/marlin_fm.ko; insmod /lib/modules/sprdwl.ko
ip link set wlan0 up
```

### 5.3 藍牙上電 + 喚醒 + daemon

```sh
chmod 666 /tmp/aand/proc/mdbg/* 2>/dev/null
chmod 666 /proc/mdbg/* 2>/dev/null
echo 0 > /proc/mdbg/wdtirq 2>/dev/null

ps -ef | grep -q '[w]cnd' || setsid chroot /tmp/aand /bin/wcnd >/tmp/wcnd_console.log 2>&1 </dev/null &
sleep 2
ps -ef | grep -q '[b]t_once' || setsid /tmp/bt_once 900 >/tmp/bt_once.log 2>&1 </dev/null &
sleep 3
grep -q 'CMD OK' /tmp/bt_once.log || echo "BT-OPEN FAIL, 檢查 chmod 是否生效"

ps -ef | grep -q '[b]t_wake' || setsid /bin/sh /tmp/bt_wake.sh >/dev/null 2>&1 </dev/null &

pgrep -x bt_user_daemon >/dev/null || setsid /usr/local/bin/bt_user_daemon >/tmp/btud.log 2>&1 </dev/null &
```

### 5.4 驗證（設備端 python3，無 socat）

```sh
printf 'state\n' | timeout 5 python3 -c "
import socket,sys
s=socket.socket(socket.AF_UNIX); s.connect('/tmp/bt_ctl.sock')
s.sendall(sys.stdin.buffer.read()); s.shutdown(socket.SHUT_WR)
print(s.recv(4096).decode())"                    # 期望 OK ON

printf 'scan 15\n' | timeout 25 python3 -c "
import socket,sys
s=socket.socket(socket.AF_UNIX); s.connect('/tmp/bt_ctl.sock')
s.sendall(sys.stdin.buffer.read()); s.shutdown(socket.SHUT_WR)
d=b''
while True:
    x=s.recv(4096)
    if not x: break
    d+=x
print(d.decode())"                                # 期望 OK N + 設備行
```

---

## 6. 驗證標準清單（逐項確認）

| # | 檢查 | 期望 |
|---|---|---|
| 1 | `cat /sys/bus/sdio/devices/mmc2:8800:1/device` | `0x2331` |
| 2 | `grep 'CMD OK' /tmp/bt_once.log` | `push(17): WCNBTWIFI-CMD OK` |
| 3 | `/tmp/bt_probe_full 20` | 六步全通（Reset/Ver/BD_ADDR/Buffer/Features/Scan Enable） |
| 4 | `cat /proc/bluetooth/sleep/btwrite` 可寫 | `echo 1 > ...` 返回 WRITE_OK |
| 5 | socket `state` | `OK ON` |
| 6 | socket `scan 15` | `OK N` + 設備行（無設備則 N=0，不算失敗） |
| 7 | `pgrep -x bt_user_daemon` | 單實例 |
| 8 | LVGL 桌面"藍牙"圖標 → 開關/搜索/列表 | 頁面正常 |

---

## 7. 故障 → 根因 → 修復 決策表

| 症狀 | 大概率根因 | 修復 |
|---|---|---|
| BT-OPEN FAIL | mdbg 權限 600 | `chmod 666 /tmp/aand/proc/mdbg/*` 重試 |
| HCI 無響應 / 只回一次 SPRD3 | 缺 btwrite 喚醒 | 啟動 bt_wake.sh；確認 btwrite 可寫 |
| 掃描無結果 | 未先 Write Scan Enable | 用 daemon scan 命令（內部已處理） |
| socket connect 失敗 | daemon 多實例搶 socket | `pkill -9 -x bt_user_daemon` → 單實例重啟 |
| daemon 日誌 "Not a tty" | tty ldisc 被佔 | python ioctl TIOCSETD=0x5421 恢復 N_TTY |
| WiFi/藍牙一起沒了 | download 被殺 | 整機重啟，按 §5.2 重拉 |
| 屏幕程序反覆"變回舊版" | watchdog/開機腳本指向 build 路徑 | 統一改為 `/usr/local/bin/lvgl_demo`（已做） |
| 重啟後 22 端口不通 | USB 口切換 | 輪詢重連（本機可複用 bt_auto_resume.py） |

---

## 8. 用戶態 daemon 架構（改動/維護必讀）

```
┌─────────────┐   unix socket    ┌──────────────────────────┐
│ LVGL 藍牙頁 │  /tmp/bt_ctl.sock │  bt_user_daemon           │
│ (C, LVGL9)  │ ────────────────► │  ┌────────────────────┐  │
└─────────────┘   state/on/off/   │  │ H4 HCI 引擎         │  │
                  scan/list/      │  │ ttyS0 3M+CRTSCTS    │  │
                  connect         │  └─────────┬──────────┘  │
                                  │            │ HCI 幀       │
                                  │     ┌──────▼──────┐      │
                                  │     │ Marlin 芯片  │      │
                                  │     └─────────────┘      │
                                  └──────────────────────────┘
```

**協議**（文本行，客戶端 shutdown(SHUT_WR) 後讀到 EOF）：
- `state` → `OK ON` / `OK OFF`
- `on` / `off` → 開關藍牙（HCI Reset + Scan Enable 使能/關閉）
- `scan N` → 掃描 N 秒，返回 `OK <count>` + 每行 `bd_addr class rssi`
- `list` → 列出最近掃描結果
- `connect <bd>` → 嘗試連接（BR/EDR 對方未接受時返回 RC -2，屬預期）

**實現要點**（重構時勿破壞）：
- `B3000000` + `CRTSCTS`，`VMIN=1` 阻塞讀
- 幀讀取按 H4 幀頭：`buf[1]=evt`、`buf[2]=len`，select 超時保護
- 掃描流程固定為：`Write Scan Enable(0x0c1a,0x03)` → `Inquiry(0x0401, 33 8b 9e)` → 收 Inquiry Result
- socket 0666，單實例（openrc command_background 管理）
- 日誌：`/tmp/btud.log`（stdout）、`/tmp/btud_dbg.log`（TX/RX hex）

---

## 9. 紅線與運維紀律

1. **download 常駐勿殺** —— 全殺破壞固件狀態，只能整機重啟恢復。
2. **驅動加載順序**：`marlin_fm.ko` 先、`sprdwl.ko` 後（符號依賴）。
3. **殺進程**：一律 `pkill -9 -x <名字>`，禁止 `ps | grep` 內嵌模式。
4. **重啟後必做**：mdbg chmod 666（開機腳本已自動做，手動調試時別忘）。
5. **藍牙掃描時保持 btwrite 喚醒**（bt_wake.sh 別停）。
6. **不要動 USB OTG / 網絡模式配置**（用戶明確約束）。
7. 多實例打架 = 先 `pkill` 清乾淨再起，別在殘留上疊加。

---

## 10. 設備上已有工具清單（複用，勿重造）

| 工具 | 位置 | 用途 |
|---|---|---|
| bt_user_daemon | `/usr/local/bin/bt_user_daemon` | 生產 daemon（已部署） |
| bt_probe_full | `/tmp/bt_probe_full` | HCI 六步探針診斷 |
| hci_3m | `/tmp/hci_3m` | 3M 原始 HCI 測試 |
| bt_once | `/tmp/bt_once` | BT-OPEN 觸發 |
| bt_wake.sh | `/tmp/bt_wake.sh` | btwrite 週期喚醒 |
| bt_daemon | `/etc/init.d/bt_daemon` | openrc 自啟（rc-update add default） |
| wifi.start | `/etc/local.d/wifi.start` | 開機 WiFi + download 鏈 |
| lvgl_demo | `/usr/local/bin/lvgl_demo` | LVGL 桌面（含藍牙頁，git 已提交） |
| pskey_bt.txt | `/mnt/android_sys/lib/modules/pskey_bt.txt` | 藍牙參數權威值 |
| btud_dbg.log | `/tmp/btud_dbg.log` | daemon TX/RX hex 日誌 |

---

## 11. 後續增強方向（當前未完成）

| 項 | 說明 | 建議路徑 |
|---|---|---|
| 真實配對/連接 | daemon `connect` 只在 BR/EDR 層測試過（RC -2 屬預期） | 抓對照機 H709 藍牙開啟時 ttyS0 完整流量，重放初始化序列（含引導命令） |
| BLE 支持 | 當前只驗證 BR/EDR 掃描 | 擴展 HCI LE 命令（LE Set Scan Parameters/Enable） |
| 音頻 A2DP | 無協議棧，暫不可用 | 需引入 BlueZ 或輕量 A2DP 棧 |
| daemon 連接狀態持久化 | 當前連接嘗試不保存 | 頁面可加"已連接設備"狀態展示 |

---

## 12. 5 分鐘快速驗收路徑

```sh
# 1) 三層狀態一條命令
grep 'CMD OK' /tmp/bt_once.log && cat /sys/bus/sdio/devices/mmc2:8800:1/device && pgrep -x bt_user_daemon
# 2) 應用層一次 socket 調用
printf 'scan 8\n' | timeout 15 python3 -c "
import socket,sys
s=socket.socket(socket.AF_UNIX); s.connect('/tmp/bt_ctl.sock')
s.sendall(sys.stdin.buffer.read()); s.shutdown(socket.SHUT_WR)
d=b''
while True:
    x=s.recv(4096)
    if not x: break
    d+=x
print(d.decode())"
```

以上兩條通過 → 藍牙底層 + 應用鏈路全部 OK，直接進入"增強方向"工作；不通過 → 按 §7 決策表逐項定位。

---

*文檔版本：v1.0（藍牙打通後沉澱）*
*關聯文檔：操作手冊（人用）、啟動流程對比、工作過程總結*
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
