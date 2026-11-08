---
title: nettv-17：overlay recon 判負——當"唯一出路"被證偽時，我們剩下什麼
date: 2026-10-20 13:10:00
categories:
  - [嵌入式, 网络电视硬解]
  - [Linux, 性能优化]
tags:
  - sprd
  - SC9832A
  - fbdev
  - overlay
  - DPU
  - Mali
  - recon
permalink: zh-tw/2026/10/20/nettv-17-overlay-recon-negative/
---

> 🌐 語言：[簡體中文](https://whiteleibniz.github.io/2026/10/20/nettv-17-overlay-recon-negative/) · [繁體中文](https://whiteleibniz.github.io/2026/10/20/nettv-17-overlay-recon-negative-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/20/nettv-17-overlay-recon-negative-en/)


## 背景：一句話交代

昨天我們把幀率瓶頸精確定位到 **「YUV→RGB→framebuffer」這一步**（三條完全不同的鏈路撞同一堵牆），所以我把「顯示控制器硬件 overlay 直吃 NV12」列為唯一出路。

豆包的方案裡也是這麼說的：

> 棄用 Mali 做 YUV 轉換，改用顯示控制器硬件旋轉 + YUV 轉換。SC9832A 的顯示模塊本身支持 YUV 輸入和畫面旋轉。把 NV12 幀直接送顯示層，Mali 只用來疊加 UI 字幕。

聽起來很對。硬件在，芯片支持，理論上能省掉全部 CPU 像素路徑。**這輪就是去驗證它到底能不能做。**

結論先給：**硬件確實在，但用戶態接口一個都沒有。這條路被封死了。**

---

## 偵察手法：kallsyms 優先

沒有源碼、沒有驅動二進制、沒 root 調試器。這種情況下第一反應通常是去 `dmesg` 裡刨，或者找 `.ko` 文件 `strings`。**這兩條都是錯的。**

`dmesg` 裡能找到的只有：

```
c0 ###---- BIT_DISPC_EB still set ----###
c0 sprdfb: [sprdfb_dispc_check_esd] (4590, 0, 0)
```

`BIT_DISPC_EB` 是個誘人的線索，但只有這一個 bit 說明不了任何事。

**正確的入口是 `/proc/kallsyms`。** 內核符號表直接告訴你驅動實現了什麼：

```
$ grep sprdfb /proc/kallsyms | awk '{print $3}'
sprdfb_pan_display
sprdfb_ioctl                    ← 用戶態唯一的入口
sprdfb_check_var
sprdfb_probe
sprdfb_panel_change_fps
sprdfb_dispc_enable_overlay      ★
sprdfb_dispc_display_overlay     ★
sprdfb_dispc_logo_proc
sprdfb_dispc_ctrl
sprdfb_dispc_refresh
...
```

**DPU overlay 硬件確實存在**，`sprdfb_dispc_display_overlay` 和 `sprdfb_dispc_enable_overlay` 兩個函數明明白白在內核裡。

到這裡是個好消息。但接下來的問題才是關鍵：**這兩個函數，用戶態能不能調？**

---

## 死路一：反彙編這條路被堵死了

想把 `sprdfb_ioctl` 反匯編出來，看它的 ioctl 分派表裡有沒有 overlay 命令。需要拿到內核代碼。有三條路：

| 手段 | 結果 |
|---|---|
| `find / -name "sprdfb*.ko"` | **空** —— 驅動是**內建**進內核的，沒有模塊文件 |
| `dd if=/proc/kcore` | **0 字節** —— 內核沒開 `CONFIG_KCORE` 讀權限 |
| `dd if=/dev/mem` | **No such file** —— 設備根本沒創這個節點 |

三條全斷。

順帶說一箇中途的彎路：我原本寫了個「盲發 ioctl 掃描」的程序——對 `/dev/fb0` 遍歷 `'S'/'D'/'F'/'s'` 四個 magic × 96 個 nr × 三種編碼，約 700 個自定義 ioctl 全試一遍，看哪個不是 EINVAL。

**寫完我立刻把這個念頭掐了。** 顯示驅動的 ioctl 分支通常會直接解引用用戶指針，而我對它傳的是全零的假結構體。這和之前踩過的「FBIOPAN 用假短結構體導致內核崩」是同一類錯誤——**用一個可能觸發內核崩的手段去探測，代價太大，而且失敗了就什麼都沒學到。**

後來換成只讀方式（`GET_VSCREENINFO` / `GET_FSCREENINFO` / `PUT` 被拒就看 errno），風險為零，信息還更準。這才是對的做法。

---

## 關鍵證據：fbdev 能力探測

既然只能從 fbdev 接口反推，就老老實實測。設備上有 gcc，直接編譯一個探測程序（順便說一句，這個內核的 `fb.h` 是老版本，`FB_ROTATE_90` 和 `FB_ACTIVATE_ROTATE` 宏都不存在，得用字面值；`fb_fix_screeninfo` 裡也沒有 `flags` 字段，只有 `capabilities`——這種細節只有真去編譯才會撞到）：

```c
ioctl(fd, FBIOGET_VSCREENINFO, &v);
ioctl(fd, FBIOGET_FSCREENINFO, &f);
/* 試硬件旋轉 */
r.activate = FB_ACTIVATE_NOW | 0x100;  r.rotate = 1;
ioctl(fd, FBIOPUT_VSCREENINFO, &r);
/* 試各種像素格式 */
```

結果：

```
[VAR] 720x1280 virt 720x3840 bpp=32
[VAR] rotate=0 colorspace=0 nonstd=0
[VAR] rgb: 0/8 8/8 16/8 transp=0/0
[FIX] id="sprdfb" smem_start=0x9ed74000 smem_len=11059200 line_len=2880
[FIX] type=0 visual=2 accel=0x0 capabilities=0x0
[FIX] mmio_start=0x0 mmio_len=0
[FIX] panstep x=0 y=1 ywrap=0

ROTATE_90 : 拒絕 (errno=22)
bpp=16 : 接受    bpp=32 : 接受    bpp=24 : 接受
bpp=12 : 接受    bpp=15 : 接受
```

逐條讀：

| 行 | 含義 |
|---|---|
| `ROTATE_90 : 拒絕 (errno=22)` | **fbdev 層沒有硬件旋轉**。EINVAL 是驅動明確說「這個參數組合我不支持」 |
| `capabilities=0x0` | 驅動**一個能力位都沒聲明**（沒有 MMIO、沒有硬件加速、沒有 overlay） |
| `mmio_start=0x0 mmio_len=0` | **致命**——用戶態拿不到 DPU 寄存器基地址，等於沒有「自己配 overlay」的可能 |
| `accel=0x0` | 同上，無硬件加速標識 |
| `bpp=12 : 接受` | 這行是個**陷阱**。驅動根本不校驗像素格式，任何 bpp 都點頭。**不能拿它當「NV12 可用」的證據** |
| `virt 720x3840` | 3840 = 1280 × 3，**三緩衝**——我們一直用的 FBIOPAN 雙/三緩衝就是它 |
| `smem_len=11.06MB line_len=2880` | 2880 = 720 × 4 字節，ARGB8888，和我們的認知完全一致 |

**`mmio_start = 0` 這一條基本宣判了。** 即使 overlay 硬件在，沒有寄存器訪問權，用戶態連一個 bit 都改不了。

---

## 為什麼安卓能做到，我們做不到

安卓的 NV12 直送顯示層，是這麼實現的：

```
MediaCodec → 輸出到 gralloc buffer (NV12)
  → BufferQueue 交接 GraphicBuffer(fd)
    → SurfaceFlinger 收到，交給 HWC
      → libhwcomposer 決定用哪個 display layer
        → DPU 在硬件裡做 NV12→RGB + 縮放 + 合成
```

這裡面每一環都是**用戶態代碼**：SurfaceFlinger、libhwcomposer、gralloc。我們一樣都沒有。

我去安卓鏡像裡確認過：

```
$ ls /mnt/android_sys/lib | grep -iE "hwc|composer|display|overlay"
（空）
```

這個鏡像只帶了媒體相關的東西（`libomx_avcdec_hw_sprd.so`、`libmedia*.so` 等 304 個庫），**完全不含顯示合成棧**。它當初的設計用途就是「給 LVGL 提供 musl libc 和 bionic 庫」，不是跑完整 Android。

所以豆包方案的第 1、2、4 條在這臺設備上的問題是同一個：**它假設了一套我們沒有的用戶態基礎設施**。第 1 條說「VSP 輸出 dma-buf 共享給 Mali」，可我們播放器現在根本沒有 GL 上下文；第 4 條說「別用 glReadPixels 直接綁 fb0」，可我們從來沒用過它——那是 PSP 那條線的歷史問題。

---

## 定量封頂：CPU 路線的天花板

三條**完全獨立**的鏈路，實測撞的是同一堵牆：

| 鏈路 | 端到端 fps | 撞在哪 |
|---|---|---|
| 自研 VSP 硬解 | 15.7 | uncached ION memcpy 43.4ms + fb_render 31.8ms |
| ffmpeg 4 線程 + rgba | 10.2 | YUV→RGB ≈ 25ms + 旋轉縮放 ≈ 45ms |
| mplayer y4m 鏈路 | 7.9 | y4m 落盤 + scale 濾鏡 |

**解碼側已經榨乾了**——ffmpeg 多線程 `-threads 4 -f null` 能跑 **34.9fps**（4.3 秒解完 150 幀，比單線程的 10.7 秒快 2.5 倍），這是全項目最高的解碼吞吐。但一加上 `-vf scale,transpose -pix_fmt rgba`，立刻掉到 10.2fps。

**多線程掙來的 2.5 倍，全部被 CPU 像素轉換吃光。**

這就是結論：**只要畫面必須經過 CPU 像素路徑，不管軟解硬解、不管幾線程，天花板就是 13-16fps。** 這不是「優化得不夠」，是物理上的路徑決定。

---

## 還剩什麼：Mali

overlay 封了之後，唯一的 GPU 路徑是 **Mali**：

- `/dev/mali0` 設備節點在
- `insmod mali.ko` 可用（已驗證）
- 項目裡 `lv_hardware/gpu_env.c` 的 `gpu_env_ensure()` **已經實現**（未提交）
- 已知坑：pbuffer 的 `glReadPixels` 在 TBDR 架構上不可靠，必須**直渲 window surface**

做法是用 GLES shader 完成 NV12→RGB + 旋轉，然後直接畫進 window surface。這樣畫面就不再經過 CPU 的 YUV→RGB 標量計算，理論上能把那 45-70ms 的開銷轉移給 GPU。

**但我要誠實說明：這條路也不是保證成功的。** 顯存要裝得下 1080p NV12（3.1MB），Mali 在這塊板子上的實際帶寬和 shader 吞吐都還是未知數，shader 編譯/驅動的坑也沒趟過。它值得試，但它現在的狀態是「唯一可選」，不是「確定可行」。

**另一個誠實的選項是調整驗收標準。** 如果 GPU 這條路也走不通，就把幀率目標定在 15-20fps，然後做 ION cached 映射（memcpy 43→10ms）把硬解穩定推到 20fps 左右，剩下那 20ms 的 fb_render 靠 loop 展開和 8 像素預取榨一榨。**這是一個能交付的、不用賭的方案。**

---

## 方法論：這次偵察學到的三件事

**1. 「硬件在」不等於「你能用」。**
kallsyms 裡有 `sprdfb_dispc_display_overlay`，硬件是有的。但 `mmio_start=0`、沒有 ioctl、`capabilities=0x0`——用戶態用不了。**判斷一個能力可用，必須驗證到「用戶態能觸達的接口」這一層**，符號表只能證明第一層。

**2. 「驅動點頭」是最不可信的證據。**
`bpp=12 : 接受` 看起來像「NV12 支持」。但驅動連自己的格式都不校驗，說明它壓根沒在管格式這件事。**一個不校驗的接口，它的任何「同意」都不構成證據。** 相比之下 `ROTATE_90 : 拒絕 (errno=22)` 是硬證據——驅動明確表態了。

**3. 別用可能崩的手段去探測。**
盲發 700 個 ioctl 的計劃看起來很巧妙，但它可能讓內核崩，還換不來多少信息。只讀 ioctl（GET_*）加「試探 + 看 errno」是風險為零的等價方案。**探測的價值不取決於你有多大膽，取決於你有多精確。**

---

## 附：本文涉及的事實

- 內核符號：`sprdfb_dispc_display_overlay`@0xc024adcc、`sprdfb_dispc_enable_overlay`@0xc0249db4、`sprdfb_dispc_ctrl`@0xc088c1cc
- 驅動為內建（無 `sprdfb.ko`），`/proc/kcore` 與 `/dev/mem` 均不可讀
- fbdev：`rotate=90` 被拒（EINVAL）、`capabilities=0x0`、`mmio_start=0`、`accel=0x0`
- fbdev 實參：720×1280、virt 720×3840（三緩衝）、bpp32 ARGB8888、`smem_len=11.06MB`、`line_len=2880`
- `/mnt/android_sys/lib` 無 hwcomposer/libcomposer，該鏡像只含媒體庫
- 三鏈路端到端：硬解 15.7fps / ffmpeg 4線程+rgba 10.2fps / mplayer y4m 7.9fps
- ffmpeg `-threads 4` 純解碼 34.9fps（解碼側上限）

---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文鏈接：https://whiteleibniz.github.io