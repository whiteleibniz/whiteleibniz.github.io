---
title: 展訊 SC9832A 網路電視攻堅（三）：修好硬解之後，畫面為什麼永遠在迴圈同一段
date: 2026-10-15 02:00:00
tags:
  - VSP
  - 硬解
  - HLS
  - OMX
  - LVGL
  - 展訊
categories:
  - [嵌入式, 展訊平台]
  - [嵌入式, 影音]
copyright: 原創文章，遵循 CC BY-NC-SA 4.0 版權協議，轉載請註明出處：whiteleibniz.github.io
lang: zh-TW
---

> 🌐 語言切換：[简体中文](https://whiteleibniz.github.io/2026/10/15/nettv-workaround-poison-gop-restart/) · [繁體中文](https://whiteleibniz.github.io/2026/10/15/nettv-workaround-poison-gop-restart-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/15/nettv-workaround-poison-gop-restart-en/)

> 版權聲明：本文為筆者原創文章，遵循 CC 4.0 BY-SA 版權協議，轉載請附上原文出處連結和本聲明。

前兩篇把 1080p 直播流在 SC9832A 上用 VSP 硬解跑通了，也修掉了「第 5 塊 mbinfo 分配失敗 → 元件永久切軟解」的真因。按理說接下來就該是絲滑播放了，結果真機上畫面永遠是**同一段 2.7 秒反覆迴圈**。這篇記錄怎麼把這最後一層窗戶紙捅破的。

## 一、現象與量化工具

先給播放器加了個影格率心跳（裸 bionic 下別用 %f，純整數最穩）：

```c
static void frame_beat(void) {          /* 每解 25 影格打一條 */
    if (!g_t0ms) g_t0ms = sys_time_ms();
    if ((++g_fr % 25) != 0) return;
    long el = sys_time_ms() - g_t0ms;
    P("    [STAT] frames=%u elapsed=%ldms fps_x10=%lu\n",
      g_fr, el, g_fr * 10000UL / el);
}
```

跑 40 秒抓日誌，結果非常詭異：

```
[STAT] frames=25 elapsed=2660ms fps_x10=93
[STAT] frames=25 elapsed=2667ms fps_x10=93
[STAT] frames=25 elapsed=2690ms fps_x10=92
```

**永遠是 frames=25**，連 elapsed 都幾乎不變。也就是說：行程每活 2.7 秒就死一次，然後新行程把完全相同的 AU[23] 再解一遍。

## 二、真兇：一年前的繞過手段變成了毒藥

翻原始碼，找到了 10-09 埋的這段：

```c
/* ★★ 廠商函式庫缺陷(2026-10-09 定案): 第 2 個 GOP 的 IDR 餵入
 * empty(thisBuffer) 必永久掛死……繞過 = 偵測到第二個 IDR 立即 _exit(9)
 * 主動重生: 父行程 0.15s 內拉起新子行程, 畫面只斷 1~2s。 */
if (nt2 == 5) {
    static int idr_seen = 0;
    idr_seen++;
    if (idr_seen > 1) { P("*** GOP#%d IDR 到来, 主动重生…"); _exit(9); }
}
```

時間軸還原一下，這是個教科書級的「繞過手段過期」案例：

1. **10-09**：不知道為什麼第二個 IDR 會掛死，於是來了個狠的——一到第二個 IDR 就整個行程自殺重啟。畫面確實能看了（只斷 1~2 秒），當時看是「解藥」。
2. **10-13**：查明真因是 CMA 池只夠 4 塊 mbinfo → ENOMEM → 元件永久切軟解。做了 mbinfo 重用修復，切軟解的現象消失了。
3. **10-15**：但那個「一到第二個 IDR 就自殺」還在。於是現在是：**硬解已經能繼續跑了，行程卻還是按老規矩在第一個 GOP 邊界自殺**。更糟的是，m3u8 的已播段記錄（`g_last_seg`）跟著行程一起歸零，新行程一上來又拉同一個段——所以畫面永遠是同一段。

**教訓**：繞過手段（workaround）一定要帶上「為什麼」和「什麼時候可以刪」的註解，並且在修掉真因之後**回頭清理**。它不會自己過期。

修法：預設改成原生續解，`NETTV_RESPAWN=1` 保留逃生門：

```c
static int respawn_on = -1;
if (respawn_on < 0) {
    const char *ev = getenv("NETTV_RESPAWN");
    respawn_on = (ev && ev[0] == '1') ? 1 : 0;
}
if (respawn_on) { P("*** 主动重生(NETTV_RESPAWN=1) ***"); _exit(9); }
P("*** GOP#%d IDR: 原生续解(3s 挂死看门狗兜底) ***", idr_seen);
```

## 三、順手踩的坑：`gcc | head` 會把編譯掐死

順手還修了個建置腳本 bug，值得單獨記一筆：

```sh
gcc ... 2>&1 | head -14     # ❌ 診斷行超過 14 條時，head 關閉管道
                             #    gcc 收到 SIGPIPE 被殺死 → 不產出目標檔案
                             #    腳本報 BUILD FAIL，真錯誤被 head 吃掉
```

改成輸出重定向到檔案再 `tail`，一次見效。凡是「建置突然開始失敗、但報錯資訊殘缺」的場景，先懷疑管道下游。

## 四、結果：好消息和壞消息

改完後 100 秒實測（瀘縣 1080p 源）：

```
影格回呼 280 次（≈140 真影格）/ 4 段 m3u8 / 0 次切軟解 / 0 SIGSEGV
[STAT] 穩態 fps_x10=87~93
```

畫面能推進了，抓 framebuffer 也抓到了真實圖像（街道、臺標都對，rot90 正常）。**但**：

1. GOP#2 能原生餵過去了，**GOP#3 的 IDR 還是掛死**（`DRIVE empty(全量)` 永不返回）——所謂「第二個 IDR 掛死」沒消失，只是被 mbinfo 修復多撐了一個 GOP。
2. 更有意思的是：**SIGALRM 看門狗在掛死期間完全不送達**（`alarm(3)`、`alarm(6)` 都沒觸發，行程狀態是 S 不是 D）。訊號這條路在這台設備的廠商函式庫裡走不通，最後是讓 monitor 父行程在 shm 裡立旗標（`shm[4]=1` 表示正在餵 IDR），把停滯寬限從 8 秒壓到 2 秒，靠 kill+重啟兜底。
3. 抓影格看，畫面約 2/3 乾淨、1/3 是塊狀馬賽克——和日誌裡「重用塊 pa=0x00000000」（mbinfo 重用塊拿到的是假物理地址）完全吻合，這是下一個要攻的點。

## 五、下一步

- 給 mbinfo 重用塊拿真物理地址（或查清 653824B 的塊為什麼 `0xc008602a` 和 cmd0 都拿不到 PA）——注意直接換 heap mask 會核心崩潰，別碰。
- 掛死根除後做多 GOP 長穩 + 換臺資源回收。
- 然後才是提影格率：13-20fps → 25fps。

一句話總結：**修 bug 的時候，把當年的繞過手段一起清掉，不然它會在你意想不到的地方變成新 bug。**
