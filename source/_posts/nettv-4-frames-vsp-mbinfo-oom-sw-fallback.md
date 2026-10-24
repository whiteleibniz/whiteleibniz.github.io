---
title: "netTV 只出 4 帧的真因：VSP mbinfo 内存池耗尽触发硬解降级软解（不是“第二个 IDR”的锅）"
date: 2026-10-13 02:30:00
lang: zh-CN
search: true
categories:
- 排障手记
- 视频播放
tag:
- nettv
- VSP硬解
- ION
- CMA
- 故障修复
---

> 🌐 语言：[简体中文](https://whiteleibniz.github.io/2026/10/13/nettv-4-frames-vsp-mbinfo-oom-sw-fallback/) · [繁體中文](https://whiteleibniz.github.io/2026/10/13/nettv-4-frames-vsp-mbinfo-oom-sw-fallback-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/13/nettv-4-frames-vsp-mbinfo-oom-sw-fallback-en/)


# netTV 只出 4 帧的真因

## 一、现象

展讯 SC9832A 设备上「网络电视」播放 1080p m3u8 直播流，每轮只能出 **4 帧**，然后画面定格；等喂到第二个 IDR 时必崩（`SIGSEGV addr=0x747474`）或永久挂起，只能靠监控进程重启，表现为「4 帧一轮」的幻灯模式。

前几轮排查一直把结论记成「厂商库缺陷：第二个 IDR 必挂死」，并做了绕过（检测到第二个 IDR 就主动重生）。**这个结论是错的**——第二个 IDR 只是次生现象。

## 二、真正的根因链

关键做法：不要只看「崩在哪一轮」，要把**每一轮投喂的返回码**拉成一条时间线。用正则把日志里每个 AU 的 `decRet / frameEffective / consume byte` 抽出来，结果一目了然：

```
AU[  3] sz= 106336 t=5  ret=0   eff=0 cons=106336   ← 第一个 IDR，解码成功
AU[  4] sz=   8983 t=1  ret=0   eff=0 cons=8983
...
AU[  9] sz=  13967 t=1  ret=0   eff=0 cons=13967    ← 出第 4 帧
AU[ 10] sz=  17116 t=1  ret=-3  eff=0 cons=17116    ← ★ 突变点
AU[ 11] sz=  13424 t=1  ret=-9  eff=0 cons=13424    ← 从此恒 -9
AU[ 12..35]                 ret=-9  needIVOP:1 ...
```

拉出 AU[10] 那一轮的厂商日志，真因就写在那儿：

```
VSP_malloc_mbinfo_cb, 1770, idx: 4, size_mbinfo: 653824
ioctl c0144900 failed with code -1: Out of memory
[ion] C1 /dev/ion alloc(653824,heap=0,align=8) FAILED rc=-12
[ion] get_phy_addr: heapID=0 base=0x0 -> fail
mPmem_mbinfo[4]: get phy addr fail -1
H264Dec_init_picture, 648, mbinfo memory is not enough
H264Dec_Process_slice, 117, error_flag=0x2
decRet: -3
failed to allocate memory.
change to sw decoder.
```

下一轮立刻：

```
onQueueFilled, 1122, change to sw decoder, mThumbnailMode: 0
H264Dec_ReleaseRefBuffers, 32
openDecoder, lib: libomx_avcdec_sw_sprd.so
decRet: -9, needIVOP: 1, SPS:0, PPS:0
```

串起来就是：

1. VSP 每解约 2 帧就要一块 **653824 字节的 mbinfo**（宏块信息），而且**从不 free**，按 idx 递增申请；
2. CMA 连续内存池只有 ~7MB，扣掉输出帧缓冲 3.1MB、输入缓冲 1.5MB，只够放 **4 块** mbinfo；
3. 第 5 块 `ion_alloc` 返回 `-ENOMEM` → `decRet=-3`；
4. 组件的处理是 **永久切换软件解码器**（`libomx_avcdec_sw_sprd.so`）——这是一道**单向门**；
5. 软解路径拿不到之前喂进去的 SPS/PPS（`SPS:0 PPS:0`），于是每轮返回 `-9 needIVOP`（要 I 帧），永远出不了帧；
6. 画面定格在 4 帧，再喂第二个 IDR 时，在软解上下文里崩掉或者挂死。

**所以「第二个 IDR 崩溃」不是 bug，是硬解已经死掉之后的必然结果。**

## 三、修法（三处，都围绕「绝不能让它切软解」）

### 1. mbinfo 分配失败时复用旧块

原先的 LRU 复用只在「池满（`g_c1r_n >= C1_REUSE_MAX=5`）」时触发。可实际 CMA 只够 4 块，第 5 块申请直接失败，**永远轮不到复用逻辑**。改成两条触发路径：池满 **或** 本次 `ion_alloc` 失败。

```c
static int c1_reuse(void *self, const char *name, unsigned size)
{
    if (size != C1_REUSE_SZ || g_c1r_n <= 0) return 0;
    int s = g_c1r_next % g_c1r_n;   /* 注意是 %g_c1r_n，不是 %MAX */
    g_c1r_next++;
    ...  /* 把旧块的 fd/base/handle/PA 填进新的 MemoryHeapIon 对象 */
    map_add(g_c1r[s].buf_fd, g_c1r[s].pa, size);
    return 1;
}
```

代价是有可能复用到仍被 DPB 参照的块（可能花帧），但和「永久软解」相比，这个代价值得付。

### 2. 分配失败时逐级降低对齐重试

原来的对齐算法是 `order = ceil(log2(size))`，上限 8。639KB 的 mbinfo 会被算成 **1MB 对齐**申请，CMA 很快碎成没法用的大块。失败时按 `6/4/2/0` 逐级降对齐重试，只改对齐不改大小，能多挤出一两块。

### 3. 检测到「切软解」立刻主动重生

软解是单向门，在里面挣扎没有任何意义。厂商日志会打 `change to sw decoder`，在 `__android_log_print` 钩子里抓这个串，置标志位，投喂循环下一轮立即 `usleep(800ms)` 排空 DMA 后 `_exit(9)`，让监控 0.15s 拉起一个干净的硬解进程。

## 四、顺带挖出来的坑：根分区 100% 满

排查过程中发现的另一件事：`df -h /` 显示 6.2G 根分区**一个字节都不剩**。后果是 `curl` 写 `/tmp/nettv.raw` 失败（退出码 23），播放器把它误判成「频道源不可达」（退出码 98），表现跟源失效一模一样。

清掉三个调试日志（`btud_dbg.log` 326MB、`nt_live.log` 239MB、`dis.txt` 158MB）后释放 724MB。

**教训**：嵌入式设备上「网络失败」和「磁盘写不进去」在应用层看起来是同一个现象，排查网络问题前先 `df`。

## 五、另一条纪律：SSH 命令必须短

我跑了一条前台 gcc 编译命令（超过 20 秒），被本地沙箱 SIGTERM 掉，泄漏的会话把设备上的 sshd 拖死——22 端口变成 `Connection refused`，远程无法恢复，只能断电重启。

**在资源紧张的嵌入式设备上，长任务一律「后台脚本 + 短轮询」，前台命令永远包 `timeout` 且控制在 20 秒内。**

## 六、经验总结

1. **把逐轮返回码拉成时间线，比盯崩溃点有用得多**。崩溃点往往在因果链的最末端（本例是第二个 IDR），真正的突变点（本例是 `decRet` 从 0 变 -3 再变 -9）要靠时间线才能看见。
2. **警惕「单向门」状态切换**。硬件解码器资源不足时切软件解码，听着很优雅，但如果切过去之后拿不到 SPS/PPS、又切不回来，那就是死路。遇到单向门，正确的策略是**检测它并整体重生**，而不是在降级状态里继续投喂。
3. **内存池类故障要看「申请序号」**。`idx: 4` 这个数字直接告诉你池子容量是 4，而代码里写死的 `MAX=5` 就是永远不会触发的死逻辑——**用常量描述资源上界，一定要用实测值，不要用估计值**。
4. **对齐方式会决定 CMA 能用多久**。`align = ceil(log2(size))` 对非 2 的幂尺寸是很大的浪费，639KB 按 1MB 对齐，碎片速度是 4KB 对齐的几十倍。
5. **排查前先做环境体检**（`df`、`free`、路由）。本例如果一上来就 `df`，能省掉一整轮「源是不是又挂了」的误判。

---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
