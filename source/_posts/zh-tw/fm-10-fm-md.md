---
title: "FM收音拉起_部署交付文檔"
date: 2026-09-23 12:16:40
lang: zh-TW
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
permalink: zh-tw/2026/09/23/fm-10-fm-md/
---


# FM 收音拉起 —— 部署交付文檔

> **讀者對象**：接手部署/維護的工程師
> **說明**：本文檔描述**目標交付態**。當前（2026-09-22）處於**設計與規劃完成、尚未實裝**階段，
>  文中標註「已存在」的均為實測確認項，標註「待產出」的為本次需要新建的交付物
> **核心價值**：把"到底要交付哪些東西、放到哪裡、怎麼驗證"一次說清

---

## 1. 鏈路全景（誰拉起誰）

```
開機 openrc
 │
 ├─ logdw
 ├─ download（常駐）          ← 【已存在】燒入 Marlin2 combo 固件（含 FM）
 ├─ wcnd（上電管理）          ← 【已存在】
 ├─ bt_once(BT-OPEN)          ← 【已存在】使芯片整體帶電
 ├─ bt_wake.sh                ← 【已存在】週期喚醒
 ├─ bt_user_daemon            ← 【已存在】/tmp/bt_ctl.sock
 │
 ├─ fm_radio_daemon           ← 【待產出】獨佔 /dev/fm → /tmp/fm_ctl.sock
 │                                        ★ 唯一新增後臺組件
 └─ lvgl_demo                 ← 【已存在】新增收音機頁 g_radio_page → socket
```

**關鍵依賴**：`fm_radio_daemon` 必須排在 WiFi/上電鏈**之後**。
因為 FM 與 WiFi/藍牙共享 SDIO（驅動自述 `share SDIO with BT/WIFI`），芯片沒上電時一切命令都會失敗。

---

## 2. 產物清單

### 2.1 設備端（已存在，實測核對 → 不要重複實施）

| 項目 | 現狀 | 核對命令 |
|---|---|---|
| SDIO 枚舉 | ✅ `0x2331` | `cat /sys/bus/sdio/devices/*/device` |
| FM 驅動 `marlin_fm` | ✅ 已加載 | `lsmod \| grep marlin_fm` |
| `/dev/fm` 節點 | ✅ misc 23 | `grep -w fm /proc/misc` |
| `/dev/log_radio` | ✅ misc 35 | `grep log_radio /proc/misc` |
| RDS 解析能力 | ✅ 驅動內置 | `nm /lib/modules/marlin_fm.ko \| grep rds_` |
| FM PCM | ✅ `01-04 Dfm sprd-codec-fm-4` | `cat /proc/asound/pcm \| grep -i fm` |
| Android 對照庫 | ✅ `/mnt/android_sys/lib/*.so` | `ls /mnt/android_sys/lib/libfm*` |
| FM 用戶態工具 | ❌ **不存在** | `ls /usr/bin \| grep fm`（無輸出） |

### 2.2 待產出（本次交付物）

| 類型 | 文件 | 放置位置 |
|---|---|---|
| **頭文件** | `fm_ioctl.h`（命令號已還原，可直接生成） | 設備 `/home/lvgl_demo/lvgl_demo/libs/fm/` |
| **daemon 源碼** | `fm_radio_daemon.c` | 同上 + 歸檔 `AI工作流/03_收音機/src/` |
| **LVGL 頁面** | `radio_page.c` / `radio_page.h` | 設備 `lv_pages/` + 歸檔 `src/` |
| **自啟腳本** | `fm_radio.start` 或 openrc service | 歸檔 `AI工作流/03_收音機/deploy/` |
| **配置** | `/etc/fm_radio.conf`（上次頻點/音量/收藏） | 設備運行時，源碼附默認模板 |
| **文檔** | 本文檔族共 8 份 | `AI工作流/03_收音機/docs/` |

> ⚠️ 項目約定：**只收能直接部署運行的最終產物**，臨時探查腳本不歸檔。
> 因此 `deploy/` 與 `src/` 目錄**在實現產出後再填充**，當前不建空目錄充數。

### 2.3 現有代碼的三處改動

按 `FM收音機_LVGL界面設計與交互規格.md` §3.2：

1. `lv_pages/launcher_page.c`：include 新增
2. `lv_pages/launcher_page.c`：`s_apps[]` 數組在藍牙項之後插入收音機
3. `lv_pages/launcher_page.c`：`open_app` switch 新增 `case LAUNCHER_APP_RADIO:`

不改動的文件：`main.c`（**注意它是本倉唯一 CRLF 文件，本次不受影響**）、
`lv_pm/lv_page_manager.h`、已打通的 WiFi/藍牙鏈路。

---

## 3. 新設備部署步驟（從零）

### Step 0 底層體檢（必須全綠）

```sh
cat /sys/bus/sdio/devices/*/device        # 期望 0x2331
lsmod | grep marlin_fm                    # 期望已加載
ls -l /dev/fm                             # 期望節點存在
ps | grep '[d]ownload'                    # 期望常駐
ip link show wlan0 | grep -o 'state [A-Z]*'   # 期望 UP/DORMANT
```

任一項不符 → 回到 `01_WiFi打通/docs/WiFi芯片打通操作手冊.md`，**不要繼續**。

### Step 1 拿到 ioctl 命令號（**已完成**）

> 結果見 [`FM收音ioctl命令表_逆向還原.md`](FM收音ioctl命令表_逆向還原.md)，可直接據此寫 `fm_ioctl.h`。

按 `FM收音打通_AI指導手冊.md` §8 三條路線（原廠頭文件 / Android 庫反推 / 受控試探），
產出 `fm_ioctl.h`。**沒有這一步，後面全部無法開始。**

### Step 2 編譯部署 FM daemon

```sh
scp fm_radio_daemon.c fm_ioctl.h root@<設備IP>:/tmp/
ssh root@<設備IP> 'cd /tmp && gcc -O2 -Wall -o fm_radio_daemon fm_radio_daemon.c -lpthread'
ssh root@<設備IP> 'install -m 755 /tmp/fm_radio_daemon /usr/local/bin/fm_radio_daemon'
ssh root@<設備IP> '/usr/local/bin/fm_radio_daemon > /tmp/fm_daemon.log 2>&1 &'
ssh root@<設備IP> 'ls -l /tmp/fm_ctl.sock'      # 期望 socket，權限 0666
```

### Step 3 socket 冒煙測試

```python
# 設備端 python3（本機沒有 socat）
import socket, time
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(5.0)
s.connect("/tmp/fm_ctl.sock")
def cmd(c):
    s.sendall((c+"\n").encode()); time.sleep(0.2)
    return s.recv(4096).decode().strip()
for c in ["state","open","tune 97400","rssi","vol 8"]:
    print("%-12s -> %s" % (c, cmd(c)))
```

期望：`OK OFF` → `OK ON` → `OK 97400` → `OK <值>` → `OK 8`。

### Step 4 音頻出聲（**人耳確認，不許用日誌代替**）

```sh
# 依次三條路徑，每條都要實際聽
#   1) ANA_SWITCH（默認候選）
#   2) I2S_SETTING
#   3) OVER_BT_ENABLE
```

同時確認：**是否需要插耳機當天線**（不插耳機 TUNE 到最強電臺試聽）。

### Step 5 編譯部署 LVGL 收音機頁

```sh
cd /home/lvgl_demo/lvgl_demo
cp /tmp/radio_page.c /tmp/radio_page.h lv_pages/
# 改 launcher_page.c 三處（見 §2.3）
make -j2 > /tmp/mk.log 2>&1; echo "MAKE_RC=$?"
grep -E 'error:' /tmp/mk.log | head -20
cp -f build/lvgl_demo /usr/local/bin/lvgl_demo && sync
killall -9 lvgl_demo; sleep 0.5
nohup /usr/local/bin/lvgl_demo > /tmp/lvgl_run.log 2>&1 &
```

> ⚠️ 判斷 make 成敗**不要**用 `make | tail` 的 `$?`（那是 tail 的退出碼），必須 `make > log 2>&1; echo MAKE_RC=$?`。

### Step 6 開機自啟

見 `FM收音芯片打通_操作手冊.md` §7 的 openrc service，`depend()` 裡務必聲明排在 WiFi/上電鏈之後。

---

## 4. 驗證標準（全部滿足 = 部署成功）

| # | 項 | 標準 | 判據 |
|---|---|---|---|
| 1 | 底層 | SDIO/驅動/節點三連 OK | §Step 0 命令 |
| 2 | daemon | socket 四條基本命令正常 | Step 3 期望輸出 |
| 3 | 調諧 | 能 TUNE 到本地已知強信號電臺 | `OK <freq>` |
| 4 | **出聲** | **人耳聽到廣播** | 不許用日誌代替 |
| 5 | 搜臺 | seek 能找到下一個電臺；掃描有進度且可中斷 | UI 現象 |
| 6 | 信號強度 | RSSI 隨頻點變化、有區分度 | 需先標定閾值 |
| 7 | 聲道仲裁 | FM/A2DP/本地兩兩切換**無串音** | 人耳 |
| 8 | 後臺播放 | 返回桌面不停臺 | 人耳 |
| 9 | UI | 桌面圖標在藍牙之後；頻點/指針/收藏顯示正確 | 人眼（含圖標字形，非豆腐塊） |
| 10 | 自啟 | 重啟後自動可用 | 重啟驗證 |

> 其中 **4、7、9 三項必須人眼/人耳確認**——本項目排障紀律明確規定不接受"日誌 OK"作為通過判據。

---

## 5. 本次交付的"已知未知"（誠實清單）

部署方接手時請先看這張表，它們是**尚未確認**的事項，不要當成既定事實：

| # | 未知項 | 為什麼重要 |
|---|---|---|
| 1 | ~~ioctl 命令號~~ | **已解決**（見《FM收音ioctl命令表_逆向還原》） |
| 2 | 是否依賴耳機天線 | 決定是否要有"請插入耳機"UI 態 |
| 3 | `OVER_BT_ENABLE` 語義 | 決定仲裁邏輯 |
| 4 | `SETVOL` 是模塊增益還是主音量 | 決定音量鏈路 |
| 5 | RSSI 原始值量綱與閾值 | 決定信號條繪製 |
| 6 | 系統 suspend 時 FM 行為 | 決定"息屏續聽"可行性 |
| 7 | 是否需要 48px 大字號點陣 | 決定主頻點顯示效果 |

---

## 6. 一句話總結

> **三層已就緒、兩層待建**。固件/驅動/設備節點全都現成，
> 本次真正要交付的是 **`fm_radio_daemon`（含 `fm_ioctl.h`）+ LVGL 收音機頁 + openrc 自啟** 這三樣；
> 開工前置條件 **ioctl 命令號** 已自行逆向取得，**本項目當前沒有阻塞項**，可直接進入實裝。
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
