---
title: netTV 硬解攻堅(29)：把 23 毫秒的渲染攤到 4 個核——fork 常駐並行渲染池
date: 2026-10-29 02:45:00
tags:
  - 嵌入式
  - 展讯 SC9832A
  - VSP 硬解
  - 多进程
  - 性能剖析
categories:
  - [项目实战, netTV 硬解]
  - [嵌入式, 展讯平台]
copyright: 原创文章，遵循 CC BY-NC-SA 4.0 版权协议，转载请注明出处：whiteleibniz.github.io
permalink: zh-tw/2026/10/29/nettv-29-fork-resident-parallel-render-pool/
---

> 🌐 語言：[簡體中文](https://whiteleibniz.github.io/2026/10/29/nettv-29-fork-resident-parallel-render-pool/) · [繁體中文](https://whiteleibniz.github.io/2026/10/29/zh-tw/nettv-29-fork-resident-parallel-render-pool-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/29/nettv-29-fork-resident-parallel-render-pool-en/)

> 系列第 29 篇。前面幾輪把「選段 5 秒」砍到 0.3 秒、把「音頻排空 5 秒」做成異步泵之後，幀率的下一道牆就露出來了：**每幀渲染 23~32 毫秒，而且它只吃了一個核**。本篇記錄把渲染拆成多進程的完整思路，重點是三個「不崩、但悄悄錯」的坑。

## 一、為什麼現在是渲染

翻一下這一路的賬單（同一臺四核 Cortex-A7 設備、同一條 1080p25 直播流）：

| 階段 | 耗時 | 狀態 |
|---|---|---|
| `bsOnMsg`（廠商同步解碼） | 14.1 ms | 硬底線，動不了 |
| 選段 | 4981 ms → 225 ms | 已修（窗口內順序推進） |
| 音頻排空 | 5231 ms → 1 ms | 已修（異步泵，待部署） |
| **渲染 `fb_render`** | **23~32 ms** | **本次目標** |

解碼 14.1 + 渲染 23.2 ≈ 37 ms，換算上限只有 27 fps。換句話說：**就算把供數做到零等待，也摸不到「流暢」那條線**。渲染成了唯一剩下的大塊。

而這裡有個刺眼的事實：這臺設備是真四核（我們早在 10-23 就用吞吐反推翻了案——`sysfs` 的 `online`/`offline` 和 `/proc/cpuinfo` 全是謊報，別讀文件，跑基準）。渲染卻只吃了一個核，另外三個在旁邊看著。

## 二、能不能並行：先看寫側撞不撞

渲染做的是 NV12 → ARGB → 旋轉 90° 寫 framebuffer，輸出 720×1280。核心循環是按「帶（band）」組織的：

```c
for (oy0 = 0; oy0 < 1280; oy0 += bandh) {      /* 每帶 bandh 行，默認 64 */
    for (int i = 0; i < 720; i++) {
        int r = 1079 - i*3/2;                   /* 源行 */
        yuv2px8_neon(Y + r*1920 + c0, C + (r>>1)*1920 + (c0 & ~1),
                     colbase + i, 720, bandh);
    }
}
```

拆開看兩側的訪存：

- **寫側**：第 `oy0` 帶只寫輸出行 `[oy0, oy0+bandh)`。帶與帶之間**行區間完全不相交**。
- **讀側**：源 NV12 全程只讀。

這就夠了——**寫不相交 + 源只讀 = 不需要任何鎖**。既不原子操作也不用 semaphore，把 1280 行按帶切成 N 段扔給 N 個執行體即可。這是那種「看一眼就知道能並行，但真動手才發現有三個坑」的活。

## 三、坑一：渲染側一律 fork，不許裸 clone

這條是這個項目的鐵律，代價是兩次設備重啟換來的。

早先我們為了省 `fork` 的開銷，用裸 `clone(CLONE_VM|CLONE_FS|CLONE_FILES|CLONE_SIGHAND|CLONE_THREAD)` 起渲染線程。問題是**沒有 `CLONE_SETTLS`**：父子共用同一份 TLS。bionic 的 stdio 裡 `snprintf`/`vsnprintf` 走的是 `__nbuf` 這個 TLS 緩衝池，子線程一調用，就把父線程的線程結構踩壞了。

表現還特別有迷惑性：不是穩定的崩，而是「喂第二個 IDR 必 SIGSEGV，地址是個像 `0x747474` 的怪值」。我們曾經一路查 NAL 投餵 buffer 複用、SPS/PPS 重發時序，全查錯方向。

所以這次並行，我**一個 `clone` 都沒用**，老老實實 `fork()`。fork 出來的子進程有完整的私有 TLS 副本，踩不到父進程。

## 四、坑二：最危險的不是崩，是「畫面錯但不報錯」

這是本次設計裡我認為最值得記的一條。

並行渲染的子進程要讀當前這一幀。而這一幀在我們的鏈路裡，是先從 ION 緩衝 `memcpy` 到一塊「staging 暫存區」再渲染的（ION 是非緩存映射，逐字節讀實測 500 ms/幀，必須先順序搬進緩存）。問題在於這塊 staging 原本是這麼來的：

```c
if (!g_stage) g_stage = (unsigned char *)malloc(ST_SIZE);
```

`malloc` 出來的是**私有內存**。`fork()` 之後子進程拿到的是一份**凍結副本**——地址一樣，值卻是 fork 那一刻的舊內容。後果是什麼？不崩、不報錯、不告警，只是畫面永遠慢一拍甚至錯亂。這種 bug 在真機上能讓排查成本翻十倍。

修法一行：

```c
void *sm = mmap(0, ST_SIZE, PROT_READ|PROT_WRITE, MAP_SHARED|MAP_ANONYMOUS, -1, 0);
g_stage = (sm == MAP_FAILED || !sm) ? malloc(ST_SIZE) : sm;
g_stage_shared = (sm != MAP_FAILED && sm);
```

`MAP_SHARED` 匿名映射，父子共用同一批物理頁。單進程下行為和 `malloc` 完全一致，所以串行路徑零改變。

順手加了個保險：如果 `mmap` 失敗退化回 `malloc`，就**直接禁用並行池**（`g_stage_shared == 0`）。寧可慢，不要錯。

## 五、坑三：每幀 fork 一次是判負的

那是不是「每幀 fork N 個子進程」就行了？不行，這條路我們 10-22 走過一次並判負了：當時的檔 2 fork 流水線實測 17.5 fps，反而輸給單線程的 21.8 fps。懷疑是每幀 3 MB 幀數據跨進程往返的代價蓋過了並行收益。

所以這次改成**常駐池**：啟動時 `fork` 一次，之後靠 `pipe` 收發任務，每幀只傳 20 字節的結構體：

```c
struct rp_job { const unsigned char *nv; unsigned long dst; int y0, y1; };
```

子進程主體就三行邏輯，而且**不碰任何 libc 的 TLS 相關入口**：

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

父進程派發時先把 N 個任務全部寫出去（pipe 緩衝放得下），再按序收 N 個完成字節。任一步失敗就整幀串行重做並**永久回退**——現場不能因為優化把直播搞掛。

子進程還設了 `PR_SET_PDEATHSIG = SIGKILL`，父進程沒了內核會收走它們，不留孤兒。

## 六、首幀自檢：讓「靜默錯畫面」無處可藏

既然坑二告訴我們這類錯誤是不報錯的，那就**主動造一個會報錯的機制**。

首幀進並行路徑時，先串行渲染一遍到 framebuffer 的草稿頁（我們映射了 3 頁，播放只用 1/2 頁，第 0 頁空閒），算一個 FNV-1a 哈希；再走並行渲染到真頁，再算一次哈希。兩者不等就判定並行有問題，打印告警並永久回退串行：

```c
fb_render_range(nv, scr, 0, 1280);   unsigned h1 = rp_hash(scr);
fb_render_pool (nv, dst);            unsigned h2 = rp_hash(dst);
if (h1 != h2) { P("[rpool] 自檢失敗 串=%08x 並=%08x → 永久回退串行\n", h1, h2); ... }
```

代價只在首幀：多一次渲染 + 一次 3.6 MB 哈希（約 1~2 ms）。換來的是「只要並行結果和串行不等，就一定會被抓到」。**對這類無鎖並行改動，我認為這個自檢比優化本身更重要。**

## 七、重構：把帶循環區間化

為了讓同一段代碼既能串行跑也能被子進程分段跑，把 `fb_render` 的內層帶循環抽成區間函數：

```c
static void fb_render_range(const unsigned char *nv, unsigned *dst, int y0, int y1);
```

串行時調 `(0, 1280)`，與舊路徑**逐位等價**；並行時每個子進程調自己那段。這裡有個細節：渲染配置原本是 `fb_render` 裡的 `static`（`g_bandh`、`use_neon`、`use_lut`…），子進程是不會去調 `render_cfg_init()` 的，所以我把它們**提升為文件作用域全局變量**，靠 `fork` 繼承。稍有疏忽（比如漏掉 `g_prof`）就會出現「某個 env 開關悄悄失效」——這類靜默失效和坑二是一類病。

另外幀率度量也順手對齊了：舊的採樣換算係數寫錯過一次（`[perf]` 報 25 ms 而 AU 段報 32.3 ms 自相矛盾），這次按區間實際的帶數/採樣數還原，不再依賴固定係數。

## 八、怎麼驗：唯一變量 + 硬門檻

門控是 `NETTV_RPOOL=N`（1~8，默認 **0 = 原串行路徑**，行為零改變）。A/B 三臂背靠背：0 / 2 / 4，同二進制、同源、同臂長。

判據我設了四條，其中第二條是硬門檻：

1. `[STAT] fps_x10` 明顯高於基線；
2. **`[rpool] 自檢通過 串/並一致`**——不一致直接判負，幀率再高也不算贏；
3. `/tmp/nettv_segv.log` 無 `signal=11`；
4. ION clients 不增長（並行渲染不應該額外佔 ION）。

第二條為什麼這麼硬：並行渲染最壞的情況不是變慢，是**畫面悄悄錯**。幀率漲了、畫面花了，這種「優化」上線就是事故。

## 九、當前狀態與下一步

本篇寫於設備離線期間（連續第三輪沒聯上機），所以**以上都是設計與靜態審查的結論，還沒有實測數字**。已經落地的產物：

- 源碼 v30（v29 的異步音頻泵修復 + 本篇的並行渲染池）；
- 設備端構建腳本與三臂 A/B 腳本；
- 首幀自檢、非共享 staging 自動禁用、子進程失效永久回退三道保險。

上電後的順序是：先跑異步音頻泵的 A/B（上一輪就準備好的），確認段間隙降到 6 秒以內、幀率上到 22 fps 以上；再跑本篇的並行池 A/B。兩者都過了，才談部署——因為異步音頻泵帶一個「起播延遲 +18 秒」的取捨，得先讓用戶確認能不能接受。

> 待驗證清單見文末。這類改動的驗證必須上真機：fps 數字、畫面正確性、長時間穩定性，三樣都得看。

## 待用戶驗證清單

1. 編譯：`_b30.sh` 是否 `BUILD_OK`（v30 新增 `pipe`/`fork` 路徑，先看有無編譯錯誤）。
2. 自檢：日誌裡是否出現 `[rpool] 自檢通過 串/並一致`，**不是** `自檢失敗`。
3. 幀率：三臂 `[STAT] fps_x10` 對比，開臂是否明顯高於基線 `0`。
4. 畫面：真機肉眼看有無色帶、橫條、錯行（哈希自檢只能保證與串行一致，不能保證串行本身對）。
5. 穩定性：`signal=11` 計數為 0、ION clients 不增長、收尾 `left=0`。
