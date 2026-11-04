---
title: 設備重啟後 netTV 全線癱瘓：ICS 重綁與 /mnt/android_sys 掛載這兩個必踩坑
date: 2026-10-14 02:30:00
tags:
  - nettv
  - VSP 硬解
  - ICS
  - bionic
  - 環境依賴
  - 故障修復
categories:
  - 排障手記
  - 影片播放
copyright: 原創文章，遵循 CC BY-NC-SA 4.0 版權協議，轉載請註明出處：whiteleibniz.github.io
lang: zh-TW
---

> 🌐 語言切換：[简体中文](https://whiteleibniz.github.io/2026/10/14/nettv-reboot-two-gotchas-ics-and-android-sys/) · [繁體中文](https://whiteleibniz.github.io/2026/10/14/nettv-reboot-two-gotchas-ics-and-android-sys-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/14/nettv-reboot-two-gotchas-ics-and-android-sys-en/)

> 版權聲明：本文為筆者原創文章，遵循 CC 4.0 BY-SA 版權協議，轉載請附上原文出處連結和本聲明。

# 設備重啟後 netTV 全線癱瘓

## 一、現象：一次重啟，三件事同時壞

展訊 SC9832A 設備因為上一次的 sshd 事故斷電重啟之後，想繼續驗證「4 影格 / 第二個 IDR 崩潰」的修復效果，結果連環境都起不來：

| 現象 | 判準 | 第一反應（錯的） |
|---|---|---|
| 設備不上外網 | `curl` 回傳 `000`，但 `ip route` 裡 `default via <RNDIS-GW>` 還在 | 以為頻道源又掛了 |
| 播放器起不來 | `CANNOT LINK EXECUTABLE: library "libc.so" not found` | 以為二進位被改壞了 |

兩條都不是真的：**源沒掛，二進位也沒壞**。壞的是兩台機器之間那層「共享上網」，以及設備重啟後被遺忘的一個掛載點。

## 二、坑一：ICS 重綁必須「先清 IP、先私後公」

設備上網鏈路是 `USB RNDIS（RNDIS 網段） → PC ICS NAT → PC WiFi`。PC 自己上網 200，設備 000，路由表也在——這就是標準的 **ICS 掉綁定**。

舊腳本的做法是：找到 WLAN（public）和 RNDIS（private）兩個連線，`DisableSharing` 之後 `EnableSharing`。這次它直接失敗：

```
EnableSharing(0) → COMException 0x80040201
```

更坑的是補救動作：手動用 `New-NetIPAddress` 給 RNDIS 網卡設上 `<RNDIS-GW>/24`，地址確實出現了，ping 設備也通，但設備照樣上不了網。因為 **ICS 不認這個手動地址**——它接管網卡時會自己重新配置，手動地址會被頂掉，網卡退化成 **APIPA 169.254.x**，NAT 表根本沒建立。

正確順序（已固化成腳本）：

```powershell
# 1. 找到 public(WLAN/Intel 9462) 與 private(USB RNDIS Adapter)
# 2. 兩邊 DisableSharing()
# 3. ★ 把 private 網卡上【所有】IPv4 地址刪乾淨 —— 留任何一個 ICS 都不重配
# 4. private.EnableSharing(1)   ← 先私
# 5. public.EnableSharing(0)    ← 後公
# 6. 等 10s，ICS 自行把 private 配成 <RNDIS-GW>/24
```

驗證點只有一個：`Get-NetIPAddress -InterfaceAlias 以太網` 裡出現 ICS 私有地址。出現即通，不出現就是沒成，別拿 ping 通當判準。

**教訓**：Windows ICS 的私有側地址必須由 ICS 自己建立。你替它設好的地址，它不認，還會把網卡甩到 169.254 去。

## 三、坑二：bionic 執行環境依賴 /mnt/android_sys 掛載

ICS 修好後興沖沖跑播放器，結果：

```
WARNING: linker: /usr/local/bin/nettv_player: unused DT entry: type 0x1d
CANNOT LINK EXECUTABLE: library "libc.so" not found
```

`/system/lib/libc.so` 明明存在——但它是個軟鏈結：

```
/system/lib/libc.so -> /mnt/android_sys/lib/libc.so
```

而 `/mnt/android_sys` 是 **`/dev/mmcblk0p17`（ext4 唯讀）的掛載點**，重啟之後沒人掛它，於是 `/system/lib` 底下幾百個 `.so` 軟鏈結全部懸空。

為什麼重啟後沒人掛？因為掛載點全被歷史改動拆掉了：

- `01_wifi.start` —— 早已 disabled
- `01_mali.start` —— 為了「Mali 去腳本化」已刪
- `wifi_bringup.c:296` —— 只在使用者打開 WiFi 開關時才掛
- `gpu_env.c` —— **只建軟鏈結，沒有掛載兜底**（它預設 /mnt 已經掛好了）

一行命令救回來：

```sh
mkdir -p /mnt/android_sys
mount -t ext4 -o ro /dev/mmcblk0p17 /mnt/android_sys
```

**遺留待辦**：把這條固化成開機腳本 `00_android_sys.start`。否則每次重啟，所有 bionic 程式（nettv_player、PSP 前端、WCN 相關）全部 linking 失敗。

## 四、正事：10-13 的 mbinfo 重用修復，初步驗證通過

環境修好後重跑瀘縣源（`timeout -s KILL 80`），約 50 秒時的判準：

| 判準 | 舊版 | 新版 |
|---|---|---|
| `change to sw decoder` | 必出（單向門） | **0 次** |
| `[ion] ... FAILED rc=` | 第 5 塊必出 -12 | **0 次** |
| `重用塊#` | 無 | **93 次** |
| 行程存活 | 4 影格後崩/掛死 | **>50s，持續出影格** |

也就是說，10-13 定案的因果鏈成立了：**根本不是「第二個 IDR 必崩」，而是 VSP 的 mbinfo（653824B/塊）在 ~7MB CMA 池裡只夠放 4 塊，第 5 塊 ENOMEM → `decRet=-3` → 元件永久切軟解 → 之後恆 `-9 needIVOP`**。把「重用 + 降對齊重試 + 檢測單向門主動重生」三件事做完，第二個 IDR 就不再是終點。

還差的驗證：精確影格數、多 GOP 連續時長、畫面是否花畫面（`C1_REUSE_MAX` 可能要調）。

## 五、本次最貴的教訓：別對 UI 主行程發 SIGSTOP

為了不讓 LVGL 跟播放器搶 framebuffer，我在測試腳本裡加了一句 `kill -STOP $(pgrep -x lvgl_demo)`。

然後輪詢的時候 SSH 掛了：`Error reading SSH protocol banner [WinError 10054]`，複測是 **TCP 22 Connection refused**（ping 仍通），5555/23/8022 全 Timeout。sshd 死了，設備上沒有任何遠端通道。

真正的災難在這裡：**lvgl_demo 停在 SIGSTOP 狀態，沒有人給它 SIGCONT**。設備 watchdog 早就裁撤了，看門狗不會拉它，也不會有人來恢復它。於是一臺「網路通但 SSH 死、UI 凍結」的設備，只剩斷電一條路。

在無人值守的自動化裡，這是一條鐵律：

> **不要對 UI 主行程發 STOP/TERM。** 省下的那點 framebuffer 爭用，遠不值得賭上整機失聯。要測播放器就讓它搶螢幕，畫面閃幾下而已，測完 UI 自己就恢復了。

## 六、經驗總結

1. **重啟是嵌入式設備最危險的動作**，它把「開機腳本裡已經不存在的隱含依賴」一次性全部暴露出來。改開機腳本（尤其是刪除）時，必須把被刪腳本承擔的非顯性職責（掛載、建軟鏈結、環境變數）顯式遷走。
2. **ICS 這類「系統託管」的配置，手動替代永遠是假的**。地址在、ping 通，不代表 NAT 在。判準要用**功能真值**（能不能出去），不要用配置表象（地址在不在）。
3. **`library "xxx.so" not found` 的第一嫌疑是掛載點，不是檔案**。動態連結器報缺庫時，先看看軟鏈結目標目錄是不是空的——特別是在小機上盒 / chroot / Android 相容層這種到處是軟鏈結的環境。
4. **長任務「背景 + 短輪詢」是紀律，但對主行程發訊號不是**。前者是為了躲沙箱超時，後者是主動製造不可恢復狀態，兩回事。
5. **修完根因要立刻用判準複驗**。本次 `重用塊#=93 / sw=0 / FAILED=0` 三個計數，比「看著在播」可靠得多——把判準寫成可 grep 的計數，下次幾分鐘就能確認。

---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文連結：https://whiteleibniz.github.io
