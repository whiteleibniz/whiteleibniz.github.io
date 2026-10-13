---
title: "Mali400_擺脫安卓可行性分析"
date: 2026-09-30 18:50:38
lang: zh-TW
search: true
categories:
- 硬件模块打通
- Mali GPU
tag:
- Mali
- GPU
permalink: zh-tw/2026/09/30/mali-02-mali400-md/
---


# 展訊 SC9832A Mali-400 —— 擺脫安卓可行性分析

> 目標：評估能否**完全不依賴安卓(bionic)用戶態**來驅動 Mali-400 GPU。  
> 環境：Alpine/musl（根 OS，armv7l）+ 展訊 SC9832A + 內核 3.10.65。  
> 數據來源：2026-09-30 對設備的只讀探測（uname / lsmod / readelf / strings / mount / find）。

---

## 0. 一句話結論

**技術可行，但有兩條路線，難度天差地別：**

- **方案①（閉源、省力）**：換一組"Linux 原生"的 Mali 用戶態庫（同版本 Utgard DDK 的 Linux 變體），去掉 bionic 依賴。**難點在獲取匹配版本的閉源 DDK**，不是技術。
- **方案②（全開源、徹底）**：用設備已裝好的 **Mesa 24.2.8 + Lima** 驅動 Mali-400。**只差內核 DRM 節點**（`/dev/dri`），需在 3.10.65 上補 `lima` + 顯示 DRM 驅動——工程量最大，但能 100% 去安卓、且去 shim 黑魔法。

> 一個被忽視的事實：**`mali.ko` 本身是 ARM 閉源內核 blob**。所以方案①只是"用戶態非安卓"，內核仍依賴閉源模塊；只有方案②才徹底開源。無論哪條路，當前都卡在**內核側接口**——用戶態庫（bionic 那套 / mesa 那套）反而都齊了。

---

## 1. 現狀硬證據（探測所得）

| 項         | 發現                                                                                                                                             | 含義                              |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 內核        | `3.10.65 #13 SMP PREEMPT ... armv7l`                                                                                                           | 老舊 vendor 內核                    |
| GPU 節點    | `/dev/mali0` 存在；**`/dev/dri` 不存在**                                                                                                             | 只有專有 UDD 接口，無 DRM               |
| 內核模塊      | `mali.ko`（446KB，已加載）；源自 `vendor/sprd/modules/libgpu/gpu/utgard/...`（`wzp_1.5_0703` BSP）                                                        | **Utgard 專有 blob，不含 DRM 子系統**   |
| DRM 子系統   | `/sys/class/drm` 不存在；`cat /proc/filesystems` 無 drm                                                                                             | 運行內核根本沒編 DRM                    |
| 當前用戶態     | `/system/lib/libEGL.so`→`/mnt/android_sys/lib/libEGL.so`；interpreter=`/system/bin/linker`；NEEDED=`libcutils/libutils/liblog/libc++.so/libc.so` | **Android DDK**，鏈接 bionic HAL 庫 |
| bionic 來源 | `/mnt/android_sys`（`/dev/mmcblk0p17`，ext4，**ro 掛載**的原安卓分區）；`/system/bin/linker`、`/system/lib/libc.so` 均指向它                                     | 安卓用戶態完全外掛，根 OS 是 musl           |
| Mesa 現狀   | `/usr/lib/libGL.so.`<u>`1.2.0`</u>→**Mesa 24.2.8**；`/usr/lib/xorg/modules/dri/lima_dri.so`、`panfrost_dri.so` 均存在                               | **Lima 用戶態已就緒**，只缺內核 DRM        |
| 內核構建環境    | `/lib/modules/3.10.65/build` 不存在；`/usr/src` 不存在；僅有 `/usr/bin/gcc`（host）                                                                        | **無法就地編內核模塊**，需外部 BSP 源碼樹       |

---

## 2. "擺脫安卓"的三種終態

- **方案① ARM Mali Linux DDK（閉源用戶態，非 Android）**：把 Android `libEGL/libGLESv2` 換成**同一 Utgard DDK 的 Linux 構建**（鏈接 musl/glibc + `libump`，走 fbdev/DRM 窗口，**不**依賴 `libcutils/libutils/liblog`）。
- **方案② Mesa Lima（全開源）**：用已裝好的 Mesa+`lima_dri.so` 驅動 Mali-400，經標準 EGL/GL + DRM/KMS 出圖。
- **方案③ 維持現狀混合橋**（bionic 庫 + `bionic_shim` + musl-gcc `-Wl,--entry=main`）：當前唯一能跑的，**不算擺脫**。

---

## 3. 兩條路線逐層可行性

### 3.1 內核側（兩條路共用前提）

`mali.ko` 是內核模塊，libc 無關，Alpine 照常 `insmod`。但它只給 `/dev/mali0`（UDD ioctl），**Lima 用戶態不認這個接口**——Lima 要的是 `drm_lima_*` ioctl（`/dev/dri`）。所以：

- 方案① 保留 `mali.ko`，只換用戶態 → **內核側零改動**。
- 方案② 必須**替換** `mali.ko` 為 lima DRM 驅動 → 內核側大改。

### 3.2 方案① 明細

- 動作：取得 **Utgard Linux DDK**（含 `libEGL.so`/`libGLESv2.so`/`libump.so`，glibc/musl 版），放到 `/usr/lib`，刪掉 `/system` 軟鏈與 `bionic_shim`。
- 窗口系統：Linux DDK 支持 **fbdev**（無 DRM 也能跑），正好匹配本機只有 `/dev/fb0`。
- 回讀：Linux DDK 的 pbuffer/fbdev 讀回語義正常，**之前 gpu_bench 的黑屏/陳舊紅問題大概率消失**。
- **阻塞點（唯一）**：用戶態 DDK 與內核 `mali.ko` 必須**同 DDK 版本**（如 r4p0↔r4p0）。模塊來自 sprd `wzp_1.5_0703` BSP，需從該 BSP 取出**對應版本的 Linux 用戶態**。ARM 早已停止公開分發經典 Utgard DDK（UMPL 許可，~2014 r4p0 末版），公開獲取困難；**若該 BSP 打包時帶了 linux 變體則一擊即中，否則 procurement 是硬卡點**。

### 3.3 方案② 明細

- 動作：內核加 `drivers/gpu/drm/lima` + 一個顯示 DRM 驅動（SPRD 顯示控制器，或包一層 dumb DRM 複用現有 fb），編進 3.10.65 並加載，得 `/dev/dri/card0`；用戶態已齊（Mesa 24.2.8 + lima）。
- payoff：100% 開源、標準接口、`glReadPixels` 正常、徹底告別 shim/ctor/TLS/dlsym 黑魔法；PSP 前端、gpu_bench 都可直接用標準 EGL。
- **阻塞點（最大）**：lima 上游要求較新內核，往 3.10.65 **backport 是重活**；且需配套顯示 DRM 驅動（本機顯示目前是裸 fbdev，沒有 DRM 封裝）。**無在機內核源碼/構建環境**，需先取得 SC9832A 的 3.10.65 BSP 源碼樹。
- 性能：Lima 的 GLES2 在 Mali-400 上可用，但通常略低於專有 blob；對跑分/演示足夠，PSP 模擬可能比專有前端略低。

---

## 4. 關鍵認知（容易踩的坑）

1. **兩條路都卡在"內核側接口"**：方案① 卡"匹配版本的閉源用戶態"，方案② 卡"補開源內核 DRM"。用戶態庫（bionic 那套 / mesa 那套）反而都齊了。
2. **mali.ko 閉源** → 方案① 只是"用戶態非安卓"，內核仍依賴 ARM blob；只有方案② 全開源。
3. **android_sys 可卸載**：`/mnt/android_sys` 是 ro 掛載的原安卓分區，僅當前 Mali 棧需要；擺脫後不掛它、刪 `/system` 軟鏈即可，根 OS（Alpine/musl）不受影響。
4. **不能"用 mesa 但留 mali.ko"**：Mesa Lima 與專有 `mali.ko` 用的是兩套不兼容的內核 UAPI，無法混用。
5. **不能"給 bionic libEGL 套 shim 偽裝成 Linux"**：它依賴 `libcutils/libutils/liblog`（Android HAL：property/hw_get_module/ashmem/binder），重實現這些等於重寫 Android HAL，正是要擺脫的東西，且極脆。

---

## 5. 推薦與決策樹

```
能否從 SC9832A BSP(wzp_1.5_0703) 拿到 同版本 Utgard Linux DDK 用戶態?
├─ 能 ──► 方案①：換 .so、去 bionic、fbdev 出圖。最省力，順手解決回讀黑屏。
└─ 不能 ─► 想要"真正徹底非安卓"才值得上 方案②：
           取得 3.10.65 BSP 源碼 → 加 lima+顯示 DRM 驅動 → 編內核 → /dev/dri → Mesa Lima。
           （工程量大，但一勞永逸，且能摘掉所有 shim 黑魔法）
```

**務實建議**：先確認 BSP 裡有沒有 Linux 版 `libEGL/libGLESv2`（往往和 Android 版放在同一 vendor 包的不同目錄）。有就走方案①，性價比最高；沒有且你堅持"徹底去安卓"，再投入方案②。

---

## 6. 下一步最小驗證（驗證歸用戶）

1. **查 BSP 是否含 linux 版 Mali 用戶態**：在 `wzp_1.5_0703/idh.code/vendor/sprd/modules/libgpu/` 及 `out/.../system/lib/` 裡找 `libEGL.so`/`libGLESv2.so` 的 **非 bionic** 構建（readelf 看 interpreter 是否為 `/system/bin/linker`，NEEDED 是否含 `libcutils`）。
2. **探 3.10.65 能否補 DRM**：確認能否取得該內核源碼樹；grep 是否已有 `drivers/gpu/drm/lima` 或 SPRD 顯示 DRM 雛形，評估 backport 工作量。
3. **快速證偽**：在現有環境 `EGL_PLATFORM=surfaceless` + Mesa 試跑，確認確因缺 `/dev/dri` 而失敗（驗證"只差 DRM"這個判斷）。

---

## 附錄 A：`/lib/modules` 裡幾個模塊是幹什麼的

| 文件 | 證據（strings/modinfo） | 幹什麼 | 運行必需 |
|---|---|---|---|
| **mali.ko** | `utgard/driver/mali`（sprd `wzp_1.5_0703` BSP） | Mali-400 GPU 內核驅動 → `/dev/mali0` | ✅ GPU |
| **sprdwl.ko** | `description=SPRD sc2331 Wireless Network Adapter`，`author=jinglong.chen` | 展訊 **Wi-Fi** 驅動（Marlin combo 芯片） | ✅ Wi-Fi |
| **marlin_fm.ko** | `fm_read_rds_data` / `parse_at_fm_cmd` / `fm_sdio_*` | **FM 收音機**驅動（SDIO/AT） | 僅用 FM |
| **pskey_bt.txt** | `device_class`/`default_ahb_clk`/`feature_set`/增益功率表；"HEX 修改、0x 開頭" | **非驅動**：藍牙芯片 **PSKEY 持久化配置**（NVM） | 用 BT 時 |
| **autotst.ko** | `author=anli.wei`；含 `sprdfb` 串 | 出廠**自檢**模塊 | ❌ 調試 |
| **gator.ko** | `gator_get_time` / `ARM1136…ARMv7 Cortex-` | **ARM Streamline** 性能剖析模塊 | ❌ 剖析 |
| **mmc_test.ko** | `author=Pierre Ossman`，`kernel/drivers/mmc/card/mmc_test.c` | 主線 **MMC/SD/eMMC 壓測**模塊 | ❌ 拷機 |

> marlin_fm / sprdwl / pskey_bt 是一套：**Marlin = 展訊 combo 連接芯片（Wi-Fi/藍牙/FM/GPS 合一）**。

---

## 附錄 B：DRM 同名陷阱 —— 安卓那個 `/lib/drm` 不是 GPU 的 DRM

**發現**：`/mnt/android_sys/lib/drm/` 裡只有 **`libdrmomaplugin.so`**（OMA DRM 插件）。

**兩個 DRM 完全是兩回事（最容易帶偏排查）**：

| 縮寫 | 全稱 | 領域 | 本機在哪 |
|---|---|---|---|
| **DRM** | **Direct Rendering Manager** | **內核 GPU/顯示子系統**，給 `/dev/dri`、`GEM/TTM` 顯存、命令提交、`KMS` 模式設置 | ❌ 本機沒有（無 `/dev/dri`） |
| **DRM** | **Digital Rights Management** | **數字版權保護**（加密媒體、OMA/Widevine） | ✅ 安卓側有：`lib/drm/libdrmomaplugin.so`、`libdrmframework.so`、`libdrmdecrypt.so`、`libdrmntp.so` |

**安卓確實沒有用內核 DRM（Direct Rendering Manager）——證據鏈：**

1. 無 `/dev/dri`、無 `/sys/class/drm`，內核根本沒編 DRM；
2. 圖形走 **HAL 替代方案**：`gralloc.sc8830.so`（顯存分配，**替代 GEM**）+ `hwcomposer.sc8830.so`（顯示合成，**替代 KMS**）；
3. Mali 只暴露 **`/dev/mali0`**（專有 UDD ioctl），不走 `/dev/dri`；
4. 安卓側**沒有**通用 `libdrm.so`（GPU 那版），只有 `libdrmframework*.so`（版權那版）；
5. 系統 = **Android 6.0（MRA58K）**，老式 vendor HAL 模型（遠早於 Treble，更不可能用主線 DRM）。
6. 反證：GPU 版 libdrm 只存在於 Alpine/mesa 側（`/usr/lib/libdrm_intel.so.1`，Intel 目標、且同樣需要 DRM 節點才有用）。

**結論**：找到 `/lib/drm` **不代表**安卓用了內核 DRM，純屬縮寫撞名。正因為安卓用 gralloc+hwcomposer+`/dev/mali0` 繞開了 DRM，才導致——現成的 Mesa Lima 無 `/dev/dri` 可用、方案②必須先在 3.10.65 上補 DRM 驅動。這也是"擺脫安卓"卡在內核側的根因之一。

### 追加：`/mnt/android_sys/vendor/lib` 下的同名文件也全是數字版權

實抽符號坐實（均為 Google **Widevine** / **MediaDrm** 內容解密，與 GPU 無關）：

| 文件 | 實抽符號 | 真身 |
|---|---|---|
| `libwvm.so` | `android::DrmManagerClient::decrypt` / `DecryptHandle` | 安卓 DRM 框架客戶端 |
| `libwvdrm_L3.so` | `WidevineMediaKit::Component::HandleStreamInfoSource` | **Widevine L3**（軟件級版權） |
| `libWVStreamControlAPI_L3.so` | `WidevineMediaKit::MemoryChunk` | Widevine 流控 API L3 |
| `vendor/lib/drm/libdrmwvmplugin.so` | `android::DrmConstraints` | 老安卓 DRM 插件（WVM） |
| `vendor/lib/mediadrm/libdrmclearkeyplugin.so` | `clearkeydrm::AesCtrDecryptor`、`createDrmFactory` | **MediaDrm** ClearKey 插件 |
| `vendor/lib/mediadrm/libwvdrmengine.so` | `wvdrm::getCDM` | **MediaDrm** Widevine 引擎 |
| `vendor/lib/libbt-vendor.so` | `sprd_bt_power_ctrl`、`bt_vendor_cbacks` | 展訊**藍牙** vendor HAL |

> **識別口訣**：安卓側凡是名字帶 `drm` 的（`libdrmframework / libdrmdecrypt / libdrmwvmplugin / mediadrm / libwvdrm*`）**一律是數字版權/媒體解密**。
> **真正跟 GPU 相關的名字裡從來沒有 drm**：用戶態是 `libEGL.so` / `libGLESv2.so` / `libGLESv1_CM.so`，HAL 是 `gralloc.sc8830.so` + `hwcomposer.sc8830.so`，內核是 `mali.ko`。
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
