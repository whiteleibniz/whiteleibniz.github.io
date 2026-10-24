---
title: 展讯 SC9832A 网络电视攻坚（九）：一次 SIGKILL 把设备打成重启——VSP 解码中断的代价与两个连带坑
categories:
  - [嵌入式, 展讯平台]
  - [嵌入式, 音视频]
  - [调试技术, 内核与驱动]
tags: [VSP, 硬解, DMA, SIGKILL, 内核崩溃, OpenRC, stdio缓冲, 展讯, nettv]
date: 2026-10-19 02:00:00
---

> 🌐 语言：[简体中文](https://whiteleibniz.github.io/2026/10/19/nettv-09-sigkill-vsp-kernel-reboot/) · [繁體中文](https://whiteleibniz.github.io/2026/10/19/nettv-09-sigkill-vsp-kernel-reboot-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/19/nettv-09-sigkill-vsp-kernel-reboot-en/)


> 版权声明：本文为博主原创文章，遵循 CC 4.0 BY-SA 版权协议，转载请附上原文出处链接和本声明。

前几篇一直在跟「第二个 IDR 必挂死」死磕，日志断层、证据反复丢失。这次本来只想加一个诊断开关跑 60 秒，结果**把设备连着打成两次重启**。复盘下来，事故本身就是最有价值的结论：**解码中用 `kill -9` 打断 nettv_player，等于让内核去收拾 VSP 没排空的 DMA，直接崩**。顺带还清掉了两个长期误判。

## 一、事故现场

实验脚本按老习惯写的：起播放器，`( sleep 75; pkill -9 ... ) &` 兜底，`timeout -s KILL 90` 硬收尾。跑完一查：

```
$ uptime
 02:28:42 up 1 min,  0 users        ← 设备重启过
$ wc -c /tmp/v11.log
4096                                 ← 日志只有 4KB，且大半是 NUL
```

不是 sshd 会话耗尽，也不是"卡死"——**设备真的重启了**。 ping 一直通（协议栈中断驱动），SSH 不通（进程调度不起来），和 10-18 晚那次"ping 通但 sshd 无响应"是同一件事，当时判错了方向。

## 二、根因：VSP 的 DMA 必须让它自己排空

播放器的退出路径里一直有一句 `usleep(800000)`，注释写着"排空 DMA，防内核崩"。这是 10-09 就踩过的坑：VSP 硬件还在往 ion 连续内存里写帧的时候，如果进程被外力掐掉，驱动侧没有机会收回这次 DMA，接下来就是内核崩。

关键在于：**`SIGKILL` 不会走任何用户态退出路径**。`_exit()` 也不会。所以

- `pkill -9 -f nettv_player` ✗
- `timeout -s KILL 90 ...` ✗
- SIGKILL 之后那 800ms 排空代码一行都不会执行 ✓（崩给你看）

正确的停法只有两种：

1. **让它自己退出**：播放器第二个参数是「总帧数上限」（`g_arg2`，0 = 无限），达到就走正常退出流程：
   ```sh
   /usr/local/bin/nettv_player <m3u8-url> 400 > /tmp/v12.log 2>&1
   ```
2. **只发 SIGTERM**：播放器装了 SIGTERM 处理，会先停喂、排空 DMA 再退。SIGKILL 留作 3 秒后的兜底，但**正常情况下不该触发**。

改完之后脚本长这样（`outputs/r26.sh`）：全程没有 `-9`，靠帧数上限自退。

## 三、连带坑一：日志是 4KB 全缓冲，"行缓冲"的注释骗了自己

排查过程中最迷惑人的一点：进程明明跑了 75 秒，日志文件永远停在 4096 字节，`grep` 什么都搜不到。

原因很朴素：**stdout 重定向到文件后是 4KB 全缓冲**，代码注释里写的"已开行缓冲（`setvbuf _IOLBF`）"在这条路径上没生效。进程被 SIGKILL → 缓冲区永远不 flush → 你看到的日志是若干个 4KB 块，最后一截全丢。

所以：

- 实验日志**必须等进程自己正常退出**再看，别指望被杀的进程把尾部吐出来；
- 判定"程序是不是卡住了"，不能只看日志大小（4KB 一跳），要看 `pgrep` 和 `/proc/<pid>/stat`。

## 四、连带坑二：OpenRC 服务没有 `start()` 会被静默跳过

实验一开始报了个很唬人的错：

```
CANNOT LINK EXECUTABLE: library "libc.so" not found
```

查下去发现 `/system/lib/*.so` 全是悬空符号链接——它们指向 `/mnt/android_sys/lib/`，而 **android_sys 分区根本没挂**。

固化脚本 `/etc/init.d/00_android_sys` 是存在的，`rc-update show` 也显示在 default runlevel 里，但开机就是不执行。原因：OpenRC 的 runscript **必须定义 `start()`**（或者用 `command=` / `start_stop_daemon`），裸的一段 shell 会被静默跳过。改成标准 runscript 后立刻好了：

```sh
#!/sbin/openrc-run
depend() { need localmount; }
start() {
    mount | grep -q android_sys || mount -t ext4 -o ro /dev/mmcblk0p17 /mnt/android_sys
    printf 'nameserver 8.8.8.8\nnameserver 114.114.114.114\n' > /etc/resolv.conf
    ip route | grep -q default || route add default gw <RNDIS-GW>
}
```

`rc-service 00_android_sys start` → `mnt=304`，问题解决。以后看到 `library "libc.so" not found`，先查 `ls /mnt/android_sys/lib | wc -l`，别去动编译参数。

## 五、本次真想做的实验：给「第二个 IDR 挂死」做二分

事故归事故，诊断开关已经加进源码了（`outputs/sprd_msg_np_v2.c`，环境变量 `NETTV_IDRREPLAY`，默认 0 关闭）：

**思路**：现在的现象是每代 worker 都活到 AU[36]（GOP#2 的 IDR）然后 DRIVE 挂死 5~10 秒。这有两种可能——

- **A. 组件状态说**：流式态下 *任何* IDR 都会挂，跟喂了多少轮无关 → 修法是 GOP 边界做解码器软复位（flush + 重建缓冲区），不用重启进程；
- **B. 累积漂移说**：前 35 轮消耗掉了某种资源（ion/CMA、偏移、引用计数），IDR 只是恰好撞在爆点上 → 修法完全不同，得去查 36 轮里的泄漏。

**做法**：捕获第一个 IDR 之后，**紧接着连投 K 次同一份 IDR**（零累积、组件状态与 AU[36] 时一致）。如果重投第 1 次就挂死，A 成立；如果连投 3 次全过、仍然要等到 36 轮才挂，B 成立。

判据就两条：

```
grep -n "\[diag\]" /tmp/v12.log      # 捕获/重投的 IDR 行
grep -n "超时逃生\|alarm 超时" ...    # 紧跟其后有没有挂
```

二进制已经编好部署（`nettv_player` 118788 字节，旧版备份在 `.bak_1019`），但**实跑数据这次没拿到**——就是被上面两次重启拦下来的。

## 六、下一次开工的三条纪律

1. 起实验前先 `pgrep` 确认没有别的播放进程；**收尾只用 SIGTERM 或帧数上限**，任何 `-9` 都等于让设备重启。
2. 每次跑完先看 `uptime`，重启过的数据一律作废（日志不全、现场没了）。
3. 手动跑播放器前先停桌面（lvgl_demo 占着 fb，双写冲突），否则现象会被污染。

把这条放最后是因为它最贵：一次重启，前面半小时的取证全清零。
