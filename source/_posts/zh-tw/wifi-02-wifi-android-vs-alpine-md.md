---
title: "WiFi芯片啟動流程對比_Android_vs_Alpine"
date: 2026-09-13 15:27:33
lang: zh-TW
search: true
categories:
- 硬件模块打通
- WiFi
tag:
- WiFi
- SC2331
permalink: zh-tw/2026/09/13/wifi-02-wifi-android-vs-alpine-md/
---


# WiFi 芯片啟動流程對比 —— Android 原生 vs Alpine Linux（該設備）

> **主題**：Marlin SC2331 WiFi 芯片在 Android 6.0（出廠系統）與 Alpine Linux（switchroot 後）兩種環境下的啟動流程對比、原理差異，以及"如何在 Alpine 裡復刻 Android 的啟動序列"。
> **文檔版本**：v1.0　|　2026-09

---

## 1. 為什麼對比這兩者

- 該設備出廠跑 **Android 6.0**，WiFi/藍牙**正常**——說明硬件、固件、驅動本身沒問題。
- switchroot 到 **Alpine Linux 3.21**（保留 Android 內核 3.10.65）後，WiFi **徹底失效**，內核枚舉不出芯片。
- 硬件沒變、內核沒變，變的只是**根文件系統**。差異必然出在**用戶態啟動邏輯**上。
- 因此：把 Android 的啟動流程和 Alpine 的啟動流程逐環節對比，就能精確定位"Alpine 缺了什麼"。

---

## 2. 硬件與芯片背景

| 項目 | 說明 |
|---|---|
| SoC | 展銳 SC9832A（四核 ARMv7，集成 WCN 子系統控制器） |
| WiFi/BT 芯片 | Marlin SC2331（Combo 芯片），**SDIO 接口** |
| 內核枚舉地址 | `mmc2:8800:1`，device `0x2331` |
| 關鍵引腳 | GPIO94 = 芯片 READY 信號（上電完成後拉高） |
| 固件所在分區 | `wcnfdl`（p14）、`wcnmodem`（p15） |
| 電源/下載控制節點 | `/dev/power_ctl`、`/dev/download`（由內核驅動創建） |

> SC2331 的典型特性：**不先上電並下載固件，SDIO 總線上的從設備不會就緒**，內核自然枚舉不到。這是整條問題的物理根因。

---

## 3. Android 6.0 原生啟動流程

```
開機
  │
  ▼
內核啟動（boot 分區內核 + DTB）
  │  （DTB 描述 wlan 電源、時鐘、SDIO 控制器、GPIO94）
  ▼
驅動初始化
  ├─ sdio 控制器驅動枚舉 mmc2（此時芯片未上電，無從設備）
  ├─ power_ctl / download 字符設備註冊（由 WCN 控制器驅動創建）
  └─ ttyS0 串口（與芯片握手用）
  │
  ▼
Android init（init.rc）
  │
  ▼
【關鍵】常駐 download 服務（/system/bin/download）
  │  由 init 按 rc 文件啟動，開機常駐
  │
  ├─ 打開 /dev/power_ctl
  │    寫入上電序列：SLEEP → POWER_ON → POWER_RST（循環/時序控制）
  ├─ 打開 /dev/download
  │    按 /etc/marlinba/*.ini 裡的路徑配置，讀取 wcnfdl/wcnmodem 分區固件
  ├─ ttyS0 @115200 與芯片引導握手
  ├─ 通過 SDIO 把固件大塊寫入芯片（sprd_download_sdio_write，塊大小如 131080）
  │
  ▼
芯片完成啟動 → GPIO94 READY 拉高 → SDIO 從設備就緒
  │
  ▼
內核枚舉 mmc2:8800:1（device 0x2331）
  │
  ▼
wlan 驅動（sprdwl.ko + marlin_fm.ko）綁定 wlan0
  │
  ▼
wpa_supplicant（Android 自帶）→ 掃描/連接
```

**Android 流程的三個要點**：

1. **上電+固件下載是"用戶態服務"乾的**，不是內核開機自動完成的；
2. 服務讀取的固件、ini 配置、設備節點**全在 Android 文件系統裡**；
3. DTB 提供了正確的電源/時鐘描述，download 服務才能把電上對。

---

## 4. Alpine Linux（switchroot 後）原生啟動流程（失敗態）

```
開機
  │
  ▼
內核啟動（同一 Android 內核 3.10.65 + DTB）
  │   ↓ 若 DTB 是 Alpine 側改過的（電源屬性缺失/錯誤）→ 後續全錯
  ▼
驅動初始化（同 Android：sdio 控制器、power_ctl、download 節點）
  │
  ▼
Alpine init（openrc / busybox init）
  │
  ▼
【缺口】沒有 download 服務！
  ├─ /system/bin/download 不在 Alpine 根文件系統
  ├─ /dev/power_ctl 從未被寫入 → 芯片從未上電
  ├─ wcnfdl / wcnmodem 固件從未下載
  └─ 無人打開 ttyS0 與芯片握手
  │
  ▼
芯片保持斷電狀態 → GPIO94 READY 恆 0 → SDIO 從設備不存在
  │
  ▼
內核 dmesg 反覆：SDIO dev not ready
  │
  ▼
insmod sprdwl.ko → wlan0 不出現（或出現但無法工作）
```

**Alpine 失敗態的三個缺口**：

1. **缺上電動作**（無人寫 `/dev/power_ctl`）；
2. **缺固件下載**（無人讀 wcnfdl/wcnmodem 並寫入芯片）；
3. **缺正確的 DTB**（部分嘗試階段 Alpine 側 DTB 電源屬性不完整）。

---

## 5. 逐環節對比表

| 環節 | Android 6.0（正常） | Alpine（原始，失敗） | 差異性質 |
|---|---|---|---|
| 內核 | 3.10.65 Android 內核 | 同一內核 | ✅ 一致 |
| 設備樹 DTB | Android 原版（電源/時鐘完整） | 初始為 Android 原版，中途有被改壞的風險 | ⚠️ 需確保原版 |
| SDIO 控制器驅動 | 初始化 | 初始化 | ✅ 一致 |
| power_ctl / download 節點 | 註冊 | 註冊 | ✅ 一致 |
| **上電序列** | download 服務寫 `/dev/power_ctl` | **無人執行** | ❌ **核心缺口** |
| **固件下載** | download 服務讀 wcnfdl/wcnmodem 刷入芯片 | **無人執行** | ❌ **核心缺口** |
| ttyS0 芯片握手 | download 服務負責 | 無人執行 | ❌ 核心缺口 |
| GPIO94 READY | 上電完成後拉高 | 恆 0 | 結果差異 |
| SDIO 從設備枚舉 | `mmc2:8800:1`（0x2331） | 不存在 | 結果差異 |
| WiFi 驅動 | sprdwl.ko + marlin_fm.ko | 存在但加載無效（芯片沒起來） | 依賴前置 |
| 用戶態配置 | Android wpa_supplicant | 需另裝 Alpine 版 wpa_supplicant | 需要補齊 |
| 開機自啟 | init.rc 常駐 download | openrc 無對應服務 | 需要補齊 |

---

## 6. 原理分析：為什麼 Alpine 不能直接工作

### 6.1 直接原因

SC2331 芯片**上電不下載固件 = 不工作**，而下載固件這件事在 Android 裡由**用戶態常駐服務**完成，不是內核自動行為。Alpine 只是換掉了用戶態，沒人做這件事。

### 6.2 深層原因（為什麼不能簡單"裝個驅動"）

- 驅動 `sprdwl.ko` 依賴**芯片已枚舉**（`mmc2:8800:1` 存在）才能綁定；
- 芯片枚舉依賴**固件已下載**；
- 固件下載依賴**上電序列正確執行**；
- 上電序列依賴 **DTB 電源描述 + /dev/power_ctl 可寫 + Android 的 download 二進制及配套庫/固件**。

這就是一條**單向依賴鏈**，任何一環缺失都會讓 WiFi 表現為"硬件壞了"。

### 6.3 為什麼 Android 的 wpa_supplicant 不能直接用

曾嘗試在 Alpine chroot 裡直接跑 Android 的 wpa_supplicant 2.5：
- 報 `CANNOT LINK`（缺庫）→ 補了 `/mnt/android_sys/lib/*.so` 後仍 Aborted；
- 原因：Android Bionic libc 與 glibc/musl 環境、linker 機制不兼容，二進制無法穩定運行。
- 結論：**用戶態 supplicant 用 Alpine 原生包**（armhf），只複用 Android 的**底層固件下載邏輯**。

---

## 7. 解決方案的原理：在 Alpine 裡"借殼" Android

不重寫上電邏輯，而是**複用 Android 原版 download 二進制**，給它搭一個最小運行環境：

```
Alpine 側
  │
  ├─ /tmp/aand/  = 迷你 Android 用戶態（chroot 根）
  │    ├─ bin/download        （Android 原版上電+固件下載程序）
  │    ├─ lib/*.so            （Android system 庫）
  │    ├─ etc/marlinba/*.ini  （固件路徑配置）
  │    └─ dev/                （mount --bind /dev，含 power_ctl/download）
  │
  ├─ by-name 鏈接：wcnfdl → mmcblk0p14，wcnmodem → mmcblk0p15
  │
  └─ chroot /tmp/aand /bin/download -i wlan0
        = 在 Alpine 裡完整復刻 Android 的上電 + 固件下載序列
```

**為什麼能成功**：
- 上電序列的硬件操作（寫 power_ctl、ttyS0 握手、SDIO 寫固件）是**內核驅動的 ioctl/設備操作**，與用戶態 libc 無關；
- download 二進制只要能找到設備節點、固件、ini，就能驅動內核完成整套動作；
- 所以只要 chroot 環境**文件齊全 + 設備節點 bind + 固件分區鏈接**，Android 二進制在 Alpine 內核上可以原樣工作。

**原理上的分工總結**：

| 層 | 由誰負責 | 在 Alpine 裡如何獲得 |
|---|---|---|
| 電源/時鐘描述 | 內核 + DTB | 用 Android 原版 DTB |
| 上電時序 | Android download 用戶態 | chroot 複用 Android 二進制 |
| 固件下載 | Android download 用戶態 | chroot 複用 Android 二進制 |
| 芯片枚舉 | 內核（自動） | 前置完成後自動出現 |
| WiFi 數據通路 | sprdwl.ko 驅動 | Alpine 內核模塊（已備好） |
| 掃描/連接 | wpa_supplicant | Alpine armhf 原生包 |
| 開機自啟 | openrc | 自定義 /etc/local.d 腳本 |

---

## 8. 一次完整的"理想啟動時序"（打通後）

```
內核啟動（Android 原版 DTB）
  → sdio 控制器初始化，註冊 power_ctl/download 節點
  → [local 腳本] mount --bind /dev → chroot 跑 download
  → download: SLEEP→POWER_ON→POWER_RST → ttyS0 握手 → 刷 wcnfdl/wcnmodem
  → 芯片 READY 拉高 → 內核枚舉 mmc2:8800:1 (0x2331)
  → insmod marlin_fm.ko → insmod sprdwl.ko → wlan0 出現
  → ip link set wlan0 up
  → wpa_supplicant -i wlan0 -B
  → wpa_cli scan / connect
```

**關鍵區別一句話**：Android 靠 init.rc 常駐 download 服務完成芯片"初始化"；Alpine 用 chroot + local 腳本**人工復刻了這一步**，之後的一切（驅動、supplicant）都回到常規 Linux 流程。

---

*對比結論：硬件與內核相同，差異集中在用戶態"上電+固件下載"服務。復刻它，WiFi 即通。*
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
