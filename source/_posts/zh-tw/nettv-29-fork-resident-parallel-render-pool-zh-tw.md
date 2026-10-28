---
title: netTV 硬解攻堅(29)：把 23 毫秒的渲染攤到 4 個核——fork 常駐並行渲染池
date: 2026-10-29 02:45:00
tags:
  - 嵌入式
  - 展訊 SC9832A
  - VSP 硬解
  - 多行程
  - 效能剖析
categories:
  - [專案實戰, netTV 硬解]
  - [嵌入式, 展訊平台]
copyright: 原創文章，遵循 CC BY-NC-SA 4.0 版權協議，轉載請註明出處：whiteleibniz.github.io
---

> 🌐 語言：[简体中文](https://whiteleibniz.github.io/2026/10/29/nettv-29-fork-resident-parallel-render-pool/) · [繁體中文](https://whiteleibniz.github.io/2026/10/29/nettv-29-fork-resident-parallel-render-pool-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/29/nettv-29-fork-resident-parallel-render-pool-en/)

> 系列第 29 篇。前面幾輪把「選段 5 秒」砍到 0.3 秒、把「音訊排空 5 秒」做成非同步泵之後，幀率的下一個瓶頸就浮出來了：**每幀渲染 23~32 毫秒，而且它只吃了一個核**。本篇記錄把渲染拆成多行程的完整思路，重點是三個「不崩、但悄悄錯」的坑。

## 一、為什麼現在是渲染

回顧這一路的帳單（同一台四核 Cortex-A7 設備、同一條 1080p25 直播流）：

| 階段 | 耗時 | 狀態 |
|---|---|---|
| `bsOnMsg`（廠商同步解碼） | 14.1 ms | 硬底線，動不了 |
| 選段 | 4981 ms → 225 ms | 已修（視窗內順序推進） |
| 音訊排空 | 5231 ms → 1 ms | 已修（非同步泵，待部署） |
| **渲染 `fb_render`** | **23~32 ms** | **本次目標** |

解碼 14.1 + 渲染 23.2 ≈ 37 ms，換算上限只有 27 fps。也就是說：**就算把供數做到零等待，也摸不到「流暢」那條線**。渲染是唯一剩下的大塊。

而這裡有個刺眼的事實：這台設備是真四核（我們早在 10-23 就用吞吐反推翻了案——`sysfs` 的 `online`/`offline` 和 `/proc/cpuinfo` 全是謊報，別讀檔案，跑基準）。渲染卻只吃了一個核，另外三個在旁邊看著。

## 二、能不能並行：先看寫側撞不撞

渲染做的是 NV12 → ARGB → 旋轉 90° 寫 framebuffer，輸出 720×1280。核心迴圈是按「帶（band）」組織的：

```c
for (oy0 = 0; oy0 < 1280; oy0 += bandh) {      /* 每帶 bandh 行，預設 64 */
    for (int i = 0; i < 720; i++) {
        int r = 1079 - i*3/2;                   /* 源行 */
        yuv2px8_neon(Y + r*1920 + c0, C + (r>>1)*1920 + (c0 & ~1),
                     colbase + i, 720, bandh);
    }
}
```

拆開看兩側的訪存：

- **寫側**：第 `oy0` 帶只寫輸出行 `[oy0, oy0+bandh)`。帶與帶之間**行區間完全不相交**。
- **讀側**：源 NV12 全程唯讀。

這就夠了——**寫不相交 + 源唯讀 = 不需要任何鎖**。既不原子操作也不用 semaphore，把 1280 行按帶切成 N 段丟給 N 個執行體即可。這是那種「看一眼就知道能並行，但真動手才發現有三個坑」的活。

## 三、坑一：渲染側一律 fork，不許裸 clone

這條是這個專案的鐵律，代價是兩次設備重啟換來的。

早先我們為了省 `fork` 的開銷，用裸 `clone(CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD)` 起渲染執行緒。問題是**沒有 `CLONE_SETTLS`**：父子共用同一份 TLS。bionic 的 stdio 裡 `snprintf`/`vsnprintf` 走的是 `__nbuf` 這個 TLS 緩衝池，子執行緒一呼叫，就把父執行緒的執行緒結構踩壞了。

表現還特別有迷惑性：不是穩定的崩，而是「餵第二個 IDR 必 SIGSEGV，地址是個像 `0x747474` 的怪值」。我們曾經一路查 NAL 投餵 buffer 複用、SPS/PPS 重送時序，全查錯方向。

所以這次並行，我**一個 `clone` 都沒用**，老老實實 `fork()`。fork 出來的子行程有完整的私有 TLS 副本，踩不到父行程。

## 四、坑二：最危險的不是崩，是「畫面錯但不報錯」

這是本次設計裡我認為最值得記的一條。

並行渲染的子行程要讀目前這一幀。而這一幀在我們的鏈路裡，是先從 ION 緩衝 `memcpy` 到一塊「staging 暫存區」再渲染的（ION 是非快取映射，逐位元組讀實測 500 ms/幀，必須先順序搬進快取）。問題在於這塊 staging 原本是這麼來的：

```c
if (!g_stage) g_stage = (unsigned char *)malloc(ST_SIZE);
```

`malloc` 出來的是**私有記憶體**。`fork()` 之後子行程拿到的是一份**凍結副本**——地址一樣，值卻是 fork 那一刻的舊內容。後果是什麼？不崩、不報錯、不告警，只是畫面永遠慢一拍甚至錯亂。這種 bug 在真機上能讓排查成本翻十倍。

修法一行：

```c
void *sm = mmap(0, ST_SIZE, PROT_READ|PROT_WRITE, MAP_SHARED|MAP_ANONYMOUS, -1, 0);
g_stage = (sm == MAP_FAILED || !sm) ? malloc(ST_SIZE) : sm;
g_stage_shared = (sm != MAP_FAILED && sm);
```

`MAP_SHARED` 匿名映射，父子共用同一批物理頁。單行程下行為和 `malloc` 完全一致，所以串列路徑零改變。

順手加了個保險：如果 `mmap` 失敗退化回 `malloc`，就**直接停用並行池**（`g_stage_shared == 0`）。寧可慢，不要錯。

## 五、坑三：每幀 fork 一次是判負的

那是不是「每幀 fork N 個子行程」就行了？不行，這條路我們 10-22 走過一次並判負了：當時的檔 2 fork 流水線實測 17.5 fps，反而輸給單執行緒的 21.8 fps。懷疑是每幀 3 MB 幀資料跨行程往返的代價蓋過了並行收益。

所以這次改成**常駐池**：啟動時 `fork` 一次，之後靠 `pipe` 收發任務，每幀只傳 20 位元組的結構：

```c
struct rp_job { const unsigned char *nv; unsigned long dst; int y0, int y1; };
```

子行程主體就三行邏輯，而且**不碰任何 libc 的 TLS 相關入口**：

```c
static void rpool_child(int rfd, int wfd) {
    for (;;) {
        struct rp_job j;
        if (read(rfd, &j, sizeof j) != (long)sizeof j) break;   /* 0 = 父關閉 */
        fb_render_range(j.nv, (unsigned *)j.dst, j.y0, j.y1);
        if (write(wfd, &ack, 1) != 1) break;
    }
    _exit(0);
}
```

父行程派發時先把 N 個任務全部寫出去（pipe 緩衝放得下），再按序收 N 個完成位元組。任一步失敗就整幀串列重做並**永久回退**——現場不能因為最佳化把直播搞掛。

子行程還設了 `PR_SET_PDEATHSIG = SIGKILL`，父行程沒了核心會收走它們，不留孤兒。

## 六、首幀自檢：讓「靜默錯畫面」無處可藏

既然坑二告訴我們這類錯誤是不報錯的，那就**主動造一個會報錯的機制**。

首幀進並行路徑時，先串列渲染一遍到 framebuffer 的草稿頁（我們映射了 3 頁，播放只用 1/2 頁，第 0 頁空閒），算一個 FNV-1a 雜湊；再走並行渲染到真頁，再算一次雜湊。兩者不等就判定並行有問題，列印告警並永久回退串列：

```c
fb_render_range(nv, scr, 0, 1280);   unsigned h1 = rp_hash(scr);
fb_render_pool (nv, dst);            unsigned h2 = rp_hash(dst);
if (h1 != h2) { P("[rpool] 自检失败 串=%08x 并=%08x → 永久回退串行\n", h1, h2); ... }
```

代價只在首幀：多一次渲染 + 一次 3.6 MB 雜湊（約 1~2 ms）。換來的是「只要並行結果和串列不等，就一定會被抓到」。**對這類無鎖並行改動，我認為這個自檢比最佳化本身更重要。**

## 七、重構：把帶迴圈區間化

為了讓同一段程式碼既能串列跑也能被子行程分段跑，把 `fb_render` 的內層帶迴圈抽成區間函式：

```c
static void fb_render_range(const unsigned char *nv, unsigned *dst, int y0, int y1);
```

串列時調 `(0, 1280)`，與舊路徑**逐位等價**；並行時每個子行程調自己那段。這裡有個細節：渲染設定原本是 `fb_render` 裡的 `static`（`g_bandh`、`use_neon`、`use_lut`…），子行程是不會去調 `render_cfg_init()` 的，所以我把它們**提升為檔案作用域全域變數**，靠 `fork` 繼承。稍有疏忽（比如漏掉 `g_prof`）就會出現「某個 env 開關悄悄失效」——這類靜默失效和坑二是同一類病。

另外幀率度量也順手對齊了：舊的取樣換算係數寫錯過一次（`[perf]` 報 25 ms 而 AU 段報 32.3 ms 自相矛盾），這次按區間實際的帶數/取樣數還原，不再依賴固定係數。

## 八、怎麼驗：唯一變數 + 硬門檻

門控是 `NETTV_RPOOL=N`（1~8，預設 **0 = 原串列路徑**，行為零改變）。A/B 三臂背靠背：0 / 2 / 4，同二進位、同源、同臂長。

判據我設了四條，其中第二條是硬門檻：

1. `[STAT] fps_x10` 明顯高於基線；
2. **`[rpool] 自检通过 串/并一致`**——不一致直接判負，幀率再高也不算贏；
3. `/tmp/nettv_segv.log` 無 `signal=11`；
4. ION clients 不增長（並行渲染不應該額外佔 ION）。

第二條為什麼這麼硬：並行渲染最壞的情況不是變慢，是**畫面悄悄錯**。幀率漲了、畫面花了，這種「最佳化」上線就是事故。

## 九、目前狀態與下一步

本篇寫於設備離線期間（連續第三輪沒連上機），所以**以上都是設計與靜態審查的結論，還沒有實測數字**。已經落地的產物：

- 原始碼 v30（v29 的非同步音訊泵修復 + 本篇的並行渲染池）；
- 設備端建置腳本與三臂 A/B 腳本；
- 首幀自檢、非共享 staging 自動停用、子行程失效永久回退三道保險。

上電後的順序是：先跑非同步音訊泵的 A/B（上一輪就準備好的），確認段間隙降到 6 秒以內、幀率上到 22 fps 以上；再跑本篇的並行池 A/B。兩者都過了，才談部署——因為非同步音訊泵帶一個「起播延遲 +18 秒」的取捨，得先讓使用者確認能不能接受。

> 待驗證清單見文末。這類改動的驗證必須上真機：fps 數字、畫面正確性、長時間穩定性，三樣都得看。

## 待使用者驗證清單

1. 編譯：`_b30.sh` 是否 `BUILD_OK`（v30 新增 `pipe`/`fork` 路徑，先看有無編譯錯誤）。
2. 自檢：日誌裡是否出現 `[rpool] 自检通过 串/并一致`，**不是** `自检失败`。
3. 幀率：三臂 `[STAT] fps_x10` 對比，開臂是否明顯高於基線 `0`。
4. 畫面：真機肉眼看有無色帶、橫條、錯行（雜湊自檢只能保證與串列一致，不能保證串列本身對）。
5. 穩定性：`signal=11` 計數為 0、ION clients 不增長、收尾 `left=0`。
