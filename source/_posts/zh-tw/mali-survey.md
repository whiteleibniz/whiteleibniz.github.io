---
title: "Mali400與硬件加速_勘察結論"
date: 2026-09-23 11:06:07
lang: zh-TW
search: true
categories:
- 硬件模块打通
- Mali GPU
tag:
- Mali
- GPU
permalink: zh-tw/2026/09/23/mali-survey/
---


# Mali-400 GPU 與硬件加速：勘察結論

> 日期：2026-09-23　設備：展訊 SC9832A（Alpine / 內核 3.10.65 原廠安卓內核 / 720x1280 fb）
> 問題：MPlayer 播放卡；Mali-400 有沒有用上；能不能用到顯示/視頻/UI 上。
> 性質：只讀勘察，**未執行任何播放驗證**（按約定驗證由用戶上機做）。

---

## 0. 先糾正兩個概念

1. **Mali-400 是 3D 渲染 GPU，不是顯示控制器。**
   顯示由 `20800000.fb`（sprdfb / dispc）硬件掃描輸出，`/dev/fb0` 就是最終輸出口。
   GPU **不能"接管顯示"**——它只能把圖畫進內存 buffer，再由 dispc 顯示（Android 靠
   SurfaceFlinger + hwcomposer 的 overlay 圖層完成這一步，本機沒有這套東西）。
2. **Marlin 不負責視頻。** Marlin2 是 WiFi / BT / FM / GNSS 的 combo 芯片。
   視頻硬解在 AP 側，叫 **VSP**（`/dev/sprd_vsp`，配 `sprd_coda7l`）。

---

## 1. 硬件與驅動現狀（實測）

| 部件 | 存在的證據 | 當前狀態 |
|---|---|---|
| Mali-400 GPU | 設備樹 `60000000.gpu`；`/lib/modules/mali.ko`（4.6 MB） | ❌ **完全沒用**：平臺設備**無 driver 綁定**，模塊未加載，**`/dev/mali` 不存在** |
| 顯示控制器 | `20800000.fb` → `/dev/fb0`，720x1280 32bpp，`accel false` | ✅ 在用（fbdev 軟件寫入） |
| VSP 視頻編解碼 | `/dev/sprd_vsp`、`/dev/sprd_coda7l`（misc 已註冊 = probe 成功） | ⚠️ 驅動在，**沒有任何程序用** |
| JPG 硬編解碼 | `/dev/sprd_jpg` | ⚠️ 同上 |
| GSP 2D 加速 | `/dev/sprd_gsp` + `/dev/sprd_iommu_gsp` | ⚠️ 同上（blit/縮放/旋轉/YUV→RGB） |
| ION 內存分配器 | `/dev/ion` + 3 個 ion-heap 平臺設備 | ✅ 可用（GPU/VSP/GSP 都依賴它） |

補充：`nproc = 2`（**只有 2 核在線**，非 4 核），最高 1.3 GHz，內存 916 MB。
mplayer 二進制在 `/home/lvgl_demo/lvgl_demo/libs/mplayer/mplayer`（13.7 MB，不在 PATH 裡）。

---

## 2. Mali-400 能不能用起來：不能

要用 GPU 必須三層齊全：**內核驅動 → 用戶態 EGL/GLES 庫 → 應用**。逐層看：

### 2.1 內核層：能點亮（但不是瓶頸）

```
mali.ko vermagic = 3.10.65 SMP preempt mod_unload modversions ARMv7
```

與當前內核**完全一致**（本機跑的本就是原廠安卓內核）。
所以 `insmod /lib/modules/mali.ko` 大概率成功，`60000000.gpu` 會綁定驅動、`/dev/mali` 會出現。
**這一步能做到，但沒用**——見下一條。

### 2.2 用戶態層：死結（bionic vs musl）

整機唯一存在的 Mali 用戶態 DDK 是安卓分區裡的
`/mnt/android_sys/lib/egl/libGLES_mali.so`（1.2 MB，內含 "Mali online shader compiler r6p0-01rel0"）。
它依賴的庫：

```
libc.so(→ bionic)  libc++.so  libbinder.so  libcutils.so  libhardware.so
libion.so  liblog.so  libui.so  libutils.so  libboost.so  libapplist.so
```

→ 是 **bionic 二進制，musl 加載不了**。
要救只能：搭 glibc chroot，再手搓 bionic 樁，還要實現 `libbinder`（Android IPC）——不現實。

### 2.3 開源 mesa-lima 路線：也不通

Alpine 裝了 mesa（`libEGL.so` / `libGLESv2.so` / `libgbm.so` 都在），但：

- `/usr/lib/dri/` 只有 `nouveau/r600/radeonsi/virtio_gpu_drv_video.so` —— 這 4 個是
  **VA-API 視頻驅動**，**沒有 `lima_dri.so`**（Mali-400/450 的開源 3D 驅動）；
- **`/dev/dri` 與 `/sys/class/drm` 都不存在** —— lima 是 DRM 驅動，需要內核 4.20+，
  本機是 3.10.65。移植等於把整個 DRM 子系統搬進 3.10，不現實。

**結論：Mali-400 在這臺機器上用不起來。** 內核側能點亮，但沒有任何可用的用戶態 GL 棧。

---

## 3. 就算 GPU 能用，也不是卡的原因

- **視頻卡頓的真因是 CPU 軟解碼**。2 核 1.3 GHz 軟解 H.264（尤其 720p / high profile / B 幀）
  必然吃不住，**GPU 不做視頻解碼**。
- **UI（LVGL）用 GPU 大概率更慢**：LVGL 現在 fbdev 直寫、只刷髒矩形（面積小），
  是最短路徑。改走 GLES 後要把結果 `glReadPixels` 回讀再寫 fb —— Mali-400 的回讀極慢，
  屬於典型的"加速反而變慢"。

---

## 4. 真正該用的兩個硬件（都在，且已 probe）

### 4.1 VSP —— 視頻硬解（解決"卡"的正解）

安卓分區裡有硬件編解碼 OMX 組件：

```
libomx_avcdec_hw_sprd.so        H.264 硬解
libomx_m4vh263dec_hw_sprd.so    MPEG4 / H.263 硬解
libomx_vpxdec_hw_sprd.so        VP8/VP9 硬解
libomx_avcenc_hw_sprd.so        H.264 硬編
libomxvpu.so                    VPU 封裝層
```

證明 **硬件解碼能力確實存在**，內核節點 `/dev/sprd_vsp`、`/dev/sprd_coda7l` 也都就位。
但這些 OMX 庫同樣是 bionic，不能直接用。

**唯一出路**：自己寫用戶態驅動，直接 ioctl `/dev/sprd_vsp`（展訊私有 ioctl，需要逆向；
工作量與之前逆向 FM ioctl 同一量級），再餵給 mplayer/自建播放器。

### 4.2 GSP —— 2D 加速（這才是"用到顯示上"的正解）

`/dev/sprd_gsp` + `/dev/sprd_iommu_gsp`，配合 `/dev/ion` 分配 buffer，能硬件做：

- **YUV → RGB 色彩轉換**
- **任意比例縮放**
- 旋轉、alpha 混合、blit

對 mplayer 的價值：省掉軟件縮放 + 色彩轉換（`-vf scale` / swscale），
這部分在軟解播放裡通常佔 **30~50% CPU**，是僅次於解碼的第二大頭。
對 LVGL：可做整屏合成，但 LVGL 本身軟件渲染，收益有限。

---

## 5. 不動內核、不逆向，立刻能做的（推薦先做這幾步）

1. **量化瓶頸**（決定後面走哪條路）：
   ```sh
   cd /home/lvgl_demo/lvgl_demo/libs
   ./mplayer/mplayer -benchmark -vo null -nosound 你的視頻.mp4
   ```
   - 若純解碼就能 ≥25 fps → 瓶頸在**縮放/寫 fb**：
     把視頻**預先轉碼成 720x1280 固定分辨率**再播（省掉運行時縮放，收益最大）；
     或降 `-vf scale` 的複雜度（`-sws 0` 最快）。
   - 若純解碼也只有 ~10 fps → 瓶頸是**解碼**：降規格或走 VSP 硬解。
2. **預轉碼為基線規格**（最省事、收益明確）：
   H.264 **baseline**、無 B 幀、720x1280（或 480x854）、≤1 Mbps、24~25 fps。
   baseline 無 CABAC/無 B 幀，軟解開銷能降一大截。
3. **播放參數減負**：`-framedrop -nosound -noautoquality -vo fbdev`；
   音頻解碼在 2 核機器上也是實打實的 CPU 開銷。

---

## 6. 後續可選路線（按性價比排序）

| # | 路線 | 收益 | 代價 |
|---|---|---|---|
| d | 預轉碼 + benchmark 定位瓶頸 | 中（很可能直接解決卡頓） | 幾乎為零 |
| b | 逆向 `/dev/sprd_gsp` 做硬件縮放/色彩轉換 | 中高（視頻播放明顯輕鬆） | 中（ioctl 逆向 + ION 分配） |
| a | 逆向 `/dev/sprd_vsp` 做硬解 | 高（根本解決解碼瓶頸） | 大（類比 FM ioctl 逆向） |
| c | `insmod mali.ko` 點亮內核層 | **幾乎為零**（無用戶態 GL 棧可用） | 小，但**不建議做** |
---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io
