---
title: 展訊 SC9832A 網絡電視攻堅（四）：mbinfo 的「假物理地址」——畫面 1/3 馬賽克與 IDR 掛死的共同嫌疑
categories:
  - [嵌入式, 展讯平台]
  - [嵌入式, 音视频]
tags: [VSP, 硬解, ION, CMA, DMA, m3u8, 展讯]
date: 2026-10-16 02:00:00
permalink: zh-tw/2026/10/16/nettv-mbinfo-fake-physical-address/
---

> 🌐 語言：[簡體中文](https://whiteleibniz.github.io/2026/10/16/nettv-mbinfo-fake-physical-address/) · [繁體中文](https://whiteleibniz.github.io/2026/10/16/nettv-mbinfo-fake-physical-address-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/16/nettv-mbinfo-fake-physical-address-en/)


> 版權聲明：本文為博主原創文章，遵循 CC 4.0 BY-SA 版權協議，轉載請附上原文出處鏈接和本聲明。

前面三篇把 VSP 硬解從「切軟解」裡救了回來，畫面也出來了。但真機上還有兩個症狀沒解決：**抓屏有 1/3 的塊狀馬賽克**，以及**播到第 3 個 GOP 的 IDR 時解碼器永久掛死**。這篇記錄怎麼把這兩件事收斂到同一個嫌疑——mbinfo 緩衝的**假物理地址**，以及對應的修法。

## 一、三條證據指向同一處

| 證據 | 觀察 |
| --- | --- |
| 日誌 | `複用塊#n/5 (pa=0x00000000)` —— 複用的 mbinfo 塊物理地址是 0 |
| 抓屏 | 畫面 2/3 乾淨、1/3 塊狀馬賽克，邊界整齊，像"一部分數據沒寫到" |
| 時序 | 掛死點每次都出現在喂 IDR 時 `DRIVE empty(全量)` 永不返回 |

VSP 是 DMA 設備，它寫宏塊信息用的地址來自 `Get_phy_addr_from_ion` / `Get_iova`。如果這塊地址是 0（或者乾脆是 CPU 虛擬地址），DMA 就寫到物理地址 0 附近的亂七八糟的地方——馬賽克和掛死都能解釋。

## 二、代碼裡的不對稱：同一個庫，兩條路徑

翻源碼才發現一個很隱蔽的不對稱：**靜態版 `Get_iova` 有三層兜底，構造路徑 `MemoryHeapIon::C1` 只有兩層**。

```c
/* Get_iova：真查 → 查表 → mmap + pagemap    ← 有第三招 */
if (ion_phys(buf_fd, iova, sz) == 0) return 0;
if (map_get(buf_fd, &base, &size) != 0) {
    void *m = mmap(NULL, 0x400000, PROT_READ, MAP_SHARED, buf_fd, 0);
    base = pa_of(m);                       /* /proc/self/pagemap */
    ...
}

/* C1：0xc008602a → cmd0 → 直接把 CPU VA 當 PA 用   ← 缺了 pagemap */
map_add(buf_fd, (unsigned long)base, size);  /* 假 PA */
```

`0xc008602a` 與 `cmd0(0xc0084906)` 對某些 ION heap 恆返回 EINVAL（比如非 CMA 的 system heap），於是 mbinfo 一路走到"退回 CPU VA"分支——**假 PA 就是這麼來的**。10-15 的日誌裡所有 mbinfo 塊都在走這條分支。

## 三、修法：三級兜底 + 連續性抽驗 + 複用塊挑選

第一層補上 pagemap，第二層判斷這塊內存到底能不能給 DMA 用，第三層保證複用時不挑到壞塊。

```c
/* ① 抽驗物理連續性：非連續 = 系統堆，VSP DMA 必壞 */
static int pa_contiguous(void *base, unsigned size)
{
    unsigned long prev = pa_of(base);
    if (!prev) return 0;
    for (unsigned off = 4096; off < size; off += 4096) {
        unsigned long p = pa_of((char *)base + off);
        if (!p || p != prev + 4096) return 0;
        prev = p;
    }
    return 1;
}

/* ② 三級取址：0xc008602a → cmd0 → pagemap(+連續性) */
static unsigned long buf_real_pa(int buf_fd, void *base, unsigned size, int *contig)
{
    unsigned long pa = 0; unsigned sz = 0;
    if (buf_fd >= 0) {
        if (ion_phys_sprd(buf_fd, &pa, &sz) == 0 && pa) { *contig = 1; return pa; }
        if (ion_phys(buf_fd, &pa, &sz) == 0 && pa)       { *contig = 1; return pa; }
    }
    if (base && pa_contiguous(base, size)) { *contig = 1; return pa_of(base); }
    if (base) { unsigned long p0 = pa_of(base); if (p0) return p0; }
    return 0;
}
```

複用側再加兩條紀律：

- **絕不把 0 登記進 fd→PA 表**：`map_add(fd, pa ? pa : (unsigned long)base, size)`。以前寫進 0，後面 `map_get` 命中就把 0 當物理地址用。
- **優先複用"有真 PA 且連續"的塊**，複用時如果某塊 `pa==0`，當場用三級取址再查一遍（成本極低，萬一是 transient 失敗）。

```c
for (int k = 0; k < g_c1r_n; k++) {
    int i = (g_c1r_next + k) % g_c1r_n;
    if (!g_c1r[i].pa) {
        unsigned long pa = buf_real_pa(g_c1r[i].buf_fd, g_c1r[i].base, size, &cg);
        if (pa) { g_c1r[i].pa = pa; g_c1r[i].contig = cg; }
    }
    if (g_c1r[i].pa && g_c1r[i].contig) { s = i; break; }
}
```

另外留了個**默認關閉**的實驗開關 `NETTV_MBINFO_HEAP=1,2,3`，用來手動試探其它 ION heap id 能不能拿到 CMA 連續塊。默認不試是有代價的教訓：早期試過 mask8 裸分配，直接**內核崩潰、設備重啟**。

## 四、怎麼判斷修沒修好

補丁改完還沒上機（當晚設備離線），判據先寫死在腳本里，上機後按這個 grep 收：

| 判據 | 期望 |
| --- | --- |
| `grep -c '真PA='` | > 0（拿到真物理地址） |
| `grep -c '三級取址全失敗'` | 0 |
| `grep -c '非連續'` | 0 |
| `grep '複用塊' \| tail -5` | pa 非 0 且標"連續" |
| `grep -c 'change to sw decoder'` | 0 |
| `grep -c '\[STAT\]'` | 條數 × 25 ≈ 總幀數，末條給平均 fps |

## 五、一句話教訓

> **同一件事在一個庫裡往往有兩份實現，改了一份別忘了另一份。** 這次 `Get_iova` 早就補過 pagemap 兜底，而分配路徑一直把 CPU 虛擬地址當物理地址餵給 DMA——兩邊差一層，症狀就是"偶爾花屏 + 偶發掛死"這種最難查的東西。

## 六、上機驗證結果（2026-10-16 晚間）

設備重啟後重新聯機，按上面的腳本上機實測（編譯 `DEPLOY OK 83092B`，播放器帶 UA+Referer 過 CloudWAF 拿到 m3u8，連續解碼 150s）：

| 判據 | 期望 | 實測 |
| --- | --- | --- |
| `真PA=` | > 0 | **270** ✅ |
| `三級取址全失敗` | 0 | **0** ✅ |
| `複用塊` 末行 | pa 非 0 且連續 | `pa=0x9fdc1000,連續` ✅ |
| `change to sw decoder` | 0 | **0** ✅ |
| `SIGSEGV` | 0 | **0** ✅ |
| `FAILED rc=` | 0 | **0** ✅ |
| `[STAT]` | 持續 | 20 條（≈500 幀）✅ |

**兩個核心症狀都消失了**：① 第二個 IDR 的 `SIGSEGV(addr=0x747474)` 不再出現——假 PA（DMA 寫到 CPU VA）正是崩的根因；② mbinfo 不再因 OOM 走 `change to sw decoder` 單向門，硬解鏈路保住了。

**但 GOP#3 的 `DRIVE empty(全量)` 掛死還在**：喂第 3 個 IDR 時解碼器仍卡在"全量 DRIVE"不返回，只是現在被 monitor 父進程的停滯看門狗（2.2s 寬限）兜底重生，不再永久卡死。**這反過來證明：假 PA 不是 IDR 掛死的根因**——真兇是 IDR 切換時全量 DRIVE 調用的內部死鎖，下一篇主攻它。

> 實測還有 10 處 `非連續` 塊（CMA 給到的非連續內存），量級小、未觸發花屏/掛死，留待後續抽驗。
