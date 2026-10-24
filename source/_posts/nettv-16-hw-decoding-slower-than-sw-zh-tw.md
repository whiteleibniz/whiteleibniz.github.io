---
title: nettv-16：硬解比軟解還慢——一次把「解碼慢」這個假設徹底推翻的對照實驗
date: 2026-10-20 11:45:00
tags:
  - sprd
  - SC9832A
  - VSP
  - mplayer
  - OMX
  - 硬解
  - 軟解
  - ARM
  - 效能分析
categories:
  - [嵌入式, 網路電視硬解]
  - [Linux, 效能優化]
copyright: 原創文章，遵循 CC BY-NC-SA 4.0 版權協議，轉載請註明出處：whiteleibniz.github.io
lang: zh-TW
---

> 🌐 語言切換：[简体中文](https://whiteleibniz.github.io/2026/10/20/nettv-16-hw-decoding-slower-than-sw/) · [繁體中文](https://whiteleibniz.github.io/2026/10/20/nettv-16-hw-decoding-slower-than-sw-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/20/nettv-16-hw-decoding-slower-than-sw-en/)


## 一句話結論

我們花了三週把 VSP 硬解鏈路從「零幀」調到「15.7fps」，然後我用同一條流、同一個播放器二進位檔跑了一次軟解對照：

```
mplayer -vo null -nosound  →  25.0 fps   （純 H.264 解碼上限）
我們自研 VSP 硬解鏈路      →  15.7 fps   （解碼+取影格+渲染全鏈）
```

**CPU 軟解比 VSP 硬解還快。** 不是最佳化沒做好，是「解碼慢」這個前提從一開始就不成立。

---

## 一、先把 mplayer 這條路摸清楚

用戶提了個方向：「能不能讓 mplayer 走 H.264 硬解」。偵察結果分三塊。

### 1. 它在哪、有沒有硬解

```
$ ls /usr/bin/mplayer /usr/local/bin/mplayer
ls: cannot access: No such file or directory     ← 不在 PATH
$ find / -name 'mplayer*'
/home/lvgl_demo/lvgl_demo/libs/mplayer/mplayer     ← 專案自帶的靜態編譯二進位檔
```

```
$ mplayer -v
MPlayer 1.4-13 (C) 2000-2019 MPlayer Team
CPU: ARM
```

`strings` 掃一遍，硬解相關符號一個都沒有：

```bash
$ strings mplayer | grep -iE 'libvpu|sprd_vsp|vdsp|hwaccel'
（空）
```

唯一命中的 `"For hardware decoders"` 字串上下文是：

```
hwmpa
NicoDVB
For hardware decoders
Uncompressed PCM audio decoder          ← 音訊家族（libmpg123/ac3）
```

MPlayer 1.4 是 2019 年的分支，它的硬解支援只有一條路：**外部 ffmpeg 透過 `-vc ffmpeg:` 把解碼外包出去**。我們設備上沒裝 ffmpeg，裝了也沒用（見下文）。

### 2. 它能往哪兒輸出

```
$ mplayer -vo help
fbdev   fbdev2   lvfb   null   mpegpes   yuv4mpeg   png   tga   pnm   md5sum
```

注意這行的資訊量：**沒有 v4l2、沒有 dri、沒有任何 GL vo**。

這意味著即使 mplayer 解出了 NV12，它也只能自己用 CPU 轉成 RGB 再往 framebuffer 裡寫。VSP 解碼也好、DPU 合成也好，它一個都碰不到。**「-vo lvfb」是唯一值得試的選項**，那是這個專案自己寫的 LVGL 直寫 vo。

### 3. ffmpeg 也不救場

Alpine 儲存庫裡有：

```
ffmpeg-6.1.2-r1 armhf {ffmpeg} (GPL-2.0-or-later AND LGPL-2.1-or-later)
```

但 `which ffmpeg` 是空的——**只進了儲存庫索引，沒安裝**。而且就算裝了也沒意義：Alpine 的 ffmpeg 是社群建構，**不包含展訊 VSP 的 hwaccel 適配**（`h264_sprd` 這種 decoder 不是主線 ffmpeg 的東西）。裝了只能軟解，還是回到 mplayer 同一條路。

---

## 二、真正的對照實驗

偵察做完就該拿資料說話。從瀘縣源拉一段真實的 1080p TS（2.6MB），用三種方式跑。

### A 組：mplayer 純解碼上限

```bash
mplayer -benchmark -vo null -nosound -framedrop /tmp/mp.ts
```

```
FPS seems to be: 25.000000
VO: [null] 1920x1080 => 1920x1080 Planar YV12
BENCHMARKs: VC:   9.778s VO:   0.001s A:   0.000s Sys: 0.065s =  9.844s
BENCHMARK%: VC: 99.3308% VO: 0.0068% A: 0.0000% Sys: 0.6624% = 100.0000%
```

`VC` 是影片解碼（Video Codec）時間，佔 **99.33%**。10 秒解完 = **25fps = 40ms/影格**。

### B 組：現有軟解鏈路（y4m 中轉）

專案裡其實已經有一條軟解路徑：`curl → mplayer → yuv4mpeg → lv_canvas`（`/usr/local/bin/nettv_play.sh`），參數是這樣的：

```sh
$MP -cache 2048 -cache-min 5 -autosync 100 -mc 1 -quiet \
    -vo yuv4mpeg:file=/tmp/nettv.y4m -vf scale=640:360 $AOARGS -nolirc -
```

跑一遍同樣的 TS：

```bash
mplayer -vo yuv4mpeg:file=/tmp/t1.y4m -vf scale=640:360 -nosound -fps 60 -slave /tmp/mp.ts
# 18 秒後：y4m = 49421692 位元組
# 每影格 640×360×1.5 = 345600 位元組 → 142 影格
# → 7.9 fps
```

**25fps 的解碼能力，經過 y4m 落盤 + scale 濾鏡後只剩 7.9fps。** 丟掉的 17fps 全在 IO 和二次縮放上，跟解碼一點關係都沒有。

### C 組：我們自研 VSP 硬解

v16i 同輪 A/B 的定量（60s 穩態）：

```
單執行緒 15.7fps，牆鐘 116ms/AU
  = DRIVE 21.1ms + memcpy 43.4ms + 渲染 31.8ms
```

### 三組並排看

| 方案 | 影格率（fps） | 瓶頸在哪 |
|------|------|----------|
| mplayer `-vo null` | **25.0 fps** | 解碼本身，40ms/影格 |
| 自研 VSP 硬解全鏈 | 15.7 fps | 解碼 21ms，其餘 95ms 全在 memcpy+渲染 |
| 軟解 + y4m 落盤 | 7.9 fps | 檔案 IO + scale 濾鏡 |

**這張表最刺眼的地方**：廠商 VSP 硬體解碼只要 14ms（函式庫自己報的），我們整條硬解鏈路卻要 64ms/影格。省下的 27ms 全部被別的東西吃掉了，還倒虧。

---

## 三、這個結果為什麼反直覺

按理說硬解該碾壓軟解。差別在於**軟解的「慢」是集中在解碼裡的，硬解的「慢」是散落在 IO 裡的**。

A7 的軟解解碼器雖然慢，但它拿到的是普通 `malloc` 出來的記憶體——CPU 快取友好的、連續可預取的。而 VSP 輸出的是一塊 uncached 的 ION 記憶體，於是：

1. **3MB memcpy 43ms**——非快取記憶體逐位元組讀，每個位元組都是獨立交易
2. **fb_render 31ms**——NV12→ARGB + 90° 旋轉，1280×720 全靠標量算

軟解根本沒有第 1 步：解碼器直接寫進普通 buffer，第 2 步可以用 `-vo lvfb` 讓 mplayer 直接畫進 framebuffer，省掉中間環節。

**所以「用硬體解碼器」這個決策本身沒錯，錯的是硬解的產出物沒有一條高效率的消費路徑。** 硬體只負責把壓縮資料變成像素，剩下 95ms 的搬運和合成，一行都沒少。

順帶一個反證：之前我們試過 `NETTV_STAGE=0` 直讀 ION 省掉那次 memcpy，結果 **fb_render 從 33ms 飆到 335ms**（慢 10 倍），5.8fps。因為非快取記憶體的隨機讀比順序拷貝更可怕。**3MB memcpy 在當前映射屬性下已經是最佳解。**

---

## 四、順手發現的兩條真硬解路線

偵察時看到兩樣東西，比 mplayer 有價值得多。

### `libomx_avcdec_hw_sprd.so`

```
$ ls /mnt/android_sys/lib | grep -i omx
libomx_avcdec_hw_sprd.so        ← 展訊官方 H.264 硬體 OMX 外掛
libomx_avcdec_sw_sprd.so
libomx_avcenc_hw_sprd.so
libomx_m4vh263dec_hw_sprd.so
...
```

這才是真正的官方硬解通路。依賴很乾淨：

```bash
$ strings libomx_avcdec_hw_sprd.so | grep -E '^lib.*\.so' | sort -u
libc++.so   libc.so   libcutils.so   libdl.so
liblog.so   libm.so   libutils.so
```

全在 `/mnt/android_sys` 裡躺著（設備開機靠 `/etc/init.d/00_android_sys` 掛載，304 個函式庫）。

**但別急著樂觀**：它是 Android OMX 適配層，要正常運作需要 `OMXMaster` 註冊、`BufferQueue` 引用計數、`gralloc` buffer 三件套——這些都在 Android media stack 裡，我們的裸 bionic 播放器一樣都沒有。硬調 OMXCodec 的工作量很大，而且它對 ION handle 的語意假設（fd + offset + size 怎麼解釋）和我們自管 ION 時踩過的綠畫面坑是同一個域。

**結論：可做，成本高，排在 ION cached 後面。**

### ION cached 映射

這條路還是最划算的：把 VSP 輸出緩衝從 uncached 改成 cached（`ION_FLAG_CACHED = 1`），每影格用 `ION_IOC_SYNC` 做一次 invalidate。那 43ms 的 memcpy 理論上能掉到 10ms 上下，牆鐘 116ms → 75ms，直接摸到 20fps。

風險是 DMA 一致性：VSP 寫完到 CPU 讀到之間必須刷一次，漏了就是花畫面或綠畫面。這是灰度的理由，不是放棄的理由。

---

## 五、所以接下來做什麼

mplayer 這條路的定位現在很清楚了：

- **「mplayer 硬解」作廢**——它沒有硬解框架，也沒有任何 GPU 輸出路徑
- **「mplayer 軟解」有價值**——25fps 的解碼上限是真的，而且**不碰 VSP、不碰 ION，就沒有核心崩潰風險**

軟解路線三個改法，按性價比排：

1. **去掉 y4m 落盤**，直接 `-vo lvfb`（mplayer 自帶的 LVGL 直寫 vo）——省掉整個檔案 IO，預估 7.9 → ~20fps
2. **去掉 `-vf scale=640:360`**，讓 vo 直接輸出到目標尺寸——省一次 CPU 縮放
3. **去掉 `-autosync 100 -mc 1`**——這是 v4 為防 TS 段邊界 pts 跳變加的，而 ptsync 我們已經證明是負回饋的源頭

三條加起來，軟解很可能摸到 25fps，且零核心風險。**這比 ION cached 更適合當第一個灰度實驗。**

但要清楚它的天花板：25fps 是 mplayer 那一檔 CPU 的解碼上限，1080p 再往上就得上 720p 源或者降解析度。到那時候硬解還是得回頭修。

---

## 六、方法論層面的三條

**1. 「硬解 vs 軟解」不是信仰問題，是可以測的。**
一個 `mplayer -vo null -benchmark` 就把真相問出來了，不到兩分鐘。在為硬體加速投入三週之前，先花兩分鐘量一下軟解的天花板。

**2. 效能問題要算「錢花在哪」，不是「哪步最慢」。**
硬解的解碼從 64ms 降到 14ms 是巨大的勝利，但同期多了 95ms 的別的開銷，淨收益是負的。慢的那一步（memcpy 43ms）根本不是最初懷疑的那一步（解碼）。

**3. 第三方元件的能力邊界要靠看清單，不靠猜。**
`mplayer -vo help` 這一行列出十個 vo，沒有 v4l2 和 dri——mplayer 就不可能參與 GPU 合成，這是不需要讀一行原始碼就能確認的事實。而 `strings | grep hwaccel` 空著，就說明沒有硬解框架。比「我覺得 MPlayer 應該支援」可靠得多。

---

## 附：本文涉及的關鍵事實

- mplayer 位置：`/home/lvgl_demo/lvgl_demo/libs/mplayer/mplayer`，MPlayer 1.4-13 靜態編譯，**不在 PATH**
- 軟解上限 25.0fps / 40ms 每影格（`VC` 佔 99.33%）
- 現有 y4m 鏈路 7.9fps，真瓶頸是檔案 IO + scale 濾鏡
- 硬解基線 15.7fps，牆鐘 116ms（DRIVE 21.1 + memcpy 43.4 + 渲染 31.8）
- 直讀 ION 反證：fb_render 335ms，慢 10 倍
- `/mnt/android_sys/lib/libomx_avcdec_hw_sprd.so` 存在，但需要 Android media stack 才能用
- Alpine 的 ffmpeg 6.1.2 無 VSP hwaccel，且未安裝

---

> **版權聲明**：本文為 whiteleibniz 原創文章（AI 協作整理），版權歸 whiteleibniz 所有，轉載請註明出處與原文連結：https://whiteleibniz.github.io
