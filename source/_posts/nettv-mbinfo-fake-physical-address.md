---
title: 展讯 SC9832A 网络电视攻坚（四）：mbinfo 的「假物理地址」——画面 1/3 马赛克与 IDR 挂死的共同嫌疑
categories:
  - [嵌入式, 展讯平台]
  - [嵌入式, 音视频]
tags: [VSP, 硬解, ION, CMA, DMA, m3u8, 展讯]
date: 2026-10-16 02:00:00
---

> 🌐 语言：[简体中文](https://whiteleibniz.github.io/2026/10/16/nettv-mbinfo-fake-physical-address/) · [繁體中文](https://whiteleibniz.github.io/2026/10/16/nettv-mbinfo-fake-physical-address-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/16/nettv-mbinfo-fake-physical-address-en/)


> 版权声明：本文为博主原创文章，遵循 CC 4.0 BY-SA 版权协议，转载请附上原文出处链接和本声明。

前面三篇把 VSP 硬解从「切软解」里救了回来，画面也出来了。但真机上还有两个症状没解决：**抓屏有 1/3 的块状马赛克**，以及**播到第 3 个 GOP 的 IDR 时解码器永久挂死**。这篇记录怎么把这两件事收敛到同一个嫌疑——mbinfo 缓冲的**假物理地址**，以及对应的修法。

## 一、三条证据指向同一处

| 证据 | 观察 |
| --- | --- |
| 日志 | `复用块#n/5 (pa=0x00000000)` —— 复用的 mbinfo 块物理地址是 0 |
| 抓屏 | 画面 2/3 干净、1/3 块状马赛克，边界整齐，像"一部分数据没写到" |
| 时序 | 挂死点每次都出现在喂 IDR 时 `DRIVE empty(全量)` 永不返回 |

VSP 是 DMA 设备，它写宏块信息用的地址来自 `Get_phy_addr_from_ion` / `Get_iova`。如果这块地址是 0（或者干脆是 CPU 虚拟地址），DMA 就写到物理地址 0 附近的乱七八糟的地方——马赛克和挂死都能解释。

## 二、代码里的不对称：同一个库，两条路径

翻源码才发现一个很隐蔽的不对称：**静态版 `Get_iova` 有三层兜底，构造路径 `MemoryHeapIon::C1` 只有两层**。

```c
/* Get_iova：真查 → 查表 → mmap + pagemap    ← 有第三招 */
if (ion_phys(buf_fd, iova, sz) == 0) return 0;
if (map_get(buf_fd, &base, &size) != 0) {
    void *m = mmap(NULL, 0x400000, PROT_READ, MAP_SHARED, buf_fd, 0);
    base = pa_of(m);                       /* /proc/self/pagemap */
    ...
}

/* C1：0xc008602a → cmd0 → 直接把 CPU VA 当 PA 用   ← 缺了 pagemap */
map_add(buf_fd, (unsigned long)base, size);  /* 假 PA */
```

`0xc008602a` 与 `cmd0(0xc0084906)` 对某些 ION heap 恒返回 EINVAL（比如非 CMA 的 system heap），于是 mbinfo 一路走到"退回 CPU VA"分支——**假 PA 就是这么来的**。10-15 的日志里所有 mbinfo 块都在走这条分支。

## 三、修法：三级兜底 + 连续性抽验 + 复用块挑选

第一层补上 pagemap，第二层判断这块内存到底能不能给 DMA 用，第三层保证复用时不挑到坏块。

```c
/* ① 抽验物理连续性：非连续 = 系统堆，VSP DMA 必坏 */
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

/* ② 三级取址：0xc008602a → cmd0 → pagemap(+连续性) */
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

复用侧再加两条纪律：

- **绝不把 0 登记进 fd→PA 表**：`map_add(fd, pa ? pa : (unsigned long)base, size)`。以前写进 0，后面 `map_get` 命中就把 0 当物理地址用。
- **优先复用"有真 PA 且连续"的块**，复用时如果某块 `pa==0`，当场用三级取址再查一遍（成本极低，万一是 transient 失败）。

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

另外留了个**默认关闭**的实验开关 `NETTV_MBINFO_HEAP=1,2,3`，用来手动试探其它 ION heap id 能不能拿到 CMA 连续块。默认不试是有代价的教训：早期试过 mask8 裸分配，直接**内核崩溃、设备重启**。

## 四、怎么判断修没修好

补丁改完还没上机（当晚设备离线），判据先写死在脚本里，上机后按这个 grep 收：

| 判据 | 期望 |
| --- | --- |
| `grep -c '真PA='` | > 0（拿到真物理地址） |
| `grep -c '三级取址全失败'` | 0 |
| `grep -c '非连续'` | 0 |
| `grep '复用块' \| tail -5` | pa 非 0 且标"连续" |
| `grep -c 'change to sw decoder'` | 0 |
| `grep -c '\[STAT\]'` | 条数 × 25 ≈ 总帧数，末条给平均 fps |

## 五、一句话教训

> **同一件事在一个库里往往有两份实现，改了一份别忘了另一份。** 这次 `Get_iova` 早就补过 pagemap 兜底，而分配路径一直把 CPU 虚拟地址当物理地址喂给 DMA——两边差一层，症状就是"偶尔花屏 + 偶发挂死"这种最难查的东西。

## 六、上机验证结果（2026-10-16 晚间）

设备重启后重新联机，按上面的脚本上机实测（编译 `DEPLOY OK 83092B`，播放器带 UA+Referer 过 CloudWAF 拿到 m3u8，连续解码 150s）：

| 判据 | 期望 | 实测 |
| --- | --- | --- |
| `真PA=` | > 0 | **270** ✅ |
| `三级取址全失败` | 0 | **0** ✅ |
| `复用块` 末行 | pa 非 0 且连续 | `pa=0x9fdc1000,连续` ✅ |
| `change to sw decoder` | 0 | **0** ✅ |
| `SIGSEGV` | 0 | **0** ✅ |
| `FAILED rc=` | 0 | **0** ✅ |
| `[STAT]` | 持续 | 20 条（≈500 帧）✅ |

**两个核心症状都消失了**：① 第二个 IDR 的 `SIGSEGV(addr=0x747474)` 不再出现——假 PA（DMA 写到 CPU VA）正是崩的根因；② mbinfo 不再因 OOM 走 `change to sw decoder` 单向门，硬解链路保住了。

**但 GOP#3 的 `DRIVE empty(全量)` 挂死还在**：喂第 3 个 IDR 时解码器仍卡在"全量 DRIVE"不返回，只是现在被 monitor 父进程的停滞看门狗（2.2s 宽限）兜底重生，不再永久卡死。**这反过来证明：假 PA 不是 IDR 挂死的根因**——真凶是 IDR 切换时全量 DRIVE 调用的内部死锁，下一篇主攻它。

> 实测还有 10 处 `非连续` 块（CMA 给到的非连续内存），量级小、未触发花屏/挂死，留待后续抽验。
