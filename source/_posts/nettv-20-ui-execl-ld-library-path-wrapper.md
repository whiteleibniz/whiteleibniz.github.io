---
title: nettv-20：点频道黑屏的第二张脸——bionic 不认 DT_RPATH，wrapper 一招救回 UI 链路
date: 2026-10-21 09:40:00
categories:
  - [嵌入式, 网络电视硬解]
  - [Linux, 动态链接]
  - [调试, 方法论]
tags:
  - sprd
  - SC9832A
  - bionic
  - LD_LIBRARY_PATH
  - dlopen
  - 软链

---

上午刚用「pkill 大法」把黑屏的电视救回来，下午用户又点了个频道——**还是黑的**。后台进程明明活着。得，这台设备的黑屏有两张完全不同的脸。

这篇记录第二张脸的抓捕过程：一个藏在动态链接器行为差异里的真 bug。

## 一、现场：进程活着，日志里写着「关键符号缺失」

抓进程树和日志，播放器 `nettv_player` 确实在跑，但 worker 子进程的日志停在一行刺眼的话上：

```
=== 符号解析 ===
  create=0x0 onMsgRecv=0xb5340731 empty=0xb533f90d ...
>>> 关键符号缺失, 无法继续
```

`create` 是组件工厂函数 `createSprdOMXComponent` 的地址，`0x0` = 没解析到。拿不到工厂函数就建不了解码器组件，后面全免谈。

第一反应是昨天（10-21 凌晨）刚修的那个坑：bionic 父进程 fork 出的 musl 子进程继承 `LD_LIBRARY_PATH` 导致 curl exec 失败。但这次症状相反——**失败的是父进程自己 dlopen**，而且日志里没有任何 `Error relocating`。

## 二、A/B 一刀切出根因

同样是 m3u8、同样无调优 env，唯一变量是 `LD_LIBRARY_PATH`：

| 跑法 | LD_LIBRARY_PATH | 结果 |
|---|---|---|
| 手动 + 带 env | `/system/lib:/mnt/android_sys/lib` | ✅ 89 帧，正常自退 |
| 手动 + 无 env | （空） | ❌ create=0x0，exit(1) |
| UI 点频道 | （空） | ❌ create=0x0，exit(1) |

一刀下去，根因现形：**UI 的 `execl` 不给播放器传 `LD_LIBRARY_PATH`**（`lv_pages/nettv_page.c:315`）。

```
pid = fork();
if (pid == 0) {
    setpgid(0, 0);
    execl(NT_PLAYER_BIN, "nettv_player", url, NULL);   /* 环境原样继承桌面, 没有 LD_LIBRARY_PATH */
    _exit(127);
}
```

为什么一个环境变量能让 `dlopen` 一个**绝对路径**失败？顺着线索查：

1. 代码里是 `dlopen("/system/lib/libstagefright_sprd_h264dec.so", RTLD_GLOBAL)`——绝对路径，稳；
2. 但 `/system/lib/libstagefright_sprd_h264dec.so` 是个 **51 字节的符号链接**，实体在 `/mnt/android_sys/lib/`（桌面启动时由 `gpu_env_ensure()` 把整个安卓 lib 目录软链到 `/system/lib`，这是这个项目的 bionic 运行环境搭建方式）；
3. 符号链接本身没问题，`ls /mnt/android_sys/lib` 304 个文件齐全；
4. 但 **h264dec 依赖链里（直接或间接）有只在 `/mnt/android_sys/lib` 才存在的库**——bionic linker 解析这些 NEEDED 时按顺序搜：`LD_LIBRARY_PATH` → `DT_RUNPATH` → 默认系统路径。没有 `LD_LIBRARY_PATH` 时，默认路径里翻不到安卓私有库，dlopen 整个失败，`create` 符号自然取不到。

也就是说：`/system/lib` 的软链只覆盖了"直接 dlopen 的那几个"，**依赖链是软的**。

## 三、第一个修复尝试：rpath，死得很难看

既然嫌 `LD_LIBRARY_PATH` 是运行时变量，那编译期焊死总行吧？给 `build.sh` 的链接参数加上：

```diff
-    -Wl,-rpath,/system/lib -Wl,--export-dynamic \
+    -Wl,-rpath,/system/lib:/mnt/android_sys/lib -Wl,--export-dynamic \
```

重新构建、部署、跑——**`create=0x0` 原样复现**。

原因：**bionic 的动态链接器不实现 DT_RPATH 语义**。这是 bionic 和 glibc/musl 的一个经典差异——glibc 下这招早就修好了，在安卓的 linker 上，`DT_RPATH` 基本被无视，搜索路径只认 `LD_LIBRARY_PATH` 和系统配置（`ld.config.txt` 那套）。

> **教训又攒了一条：跨 libc 搬经验，先确认对方认不认这套语义。** 这个项目裸 bionic 程序踩的坑（`-nostdlib` 的 `_exit`、musl/bionic 混跑、现在是 DT_RPATH），几乎全是"拿 musl/glibc 的常识往 bionic 上套"踩出来的。

## 四、真正的修复：一层 sh wrapper

UI 代码（`nettv_page.c`）在设备仓库里，改它要重编 `lvgl_demo` 桌面 + 重启桌面，动静大。最快且零侵入的办法：**把 `/usr/local/bin/nettv_player` 换成一个 wrapper**，真身挪到 `.real`：

```sh
#!/bin/sh
# /usr/local/bin/nettv_player
export LD_LIBRARY_PATH=/system/lib:/mnt/android_sys/lib
exec /usr/local/bin/nettv_player.real "$@"
```

UI 的 `execl("/usr/local/bin/nettv_player", ...)` 原封不动，wrapper 补上环境变量再 exec 真身，参数 `"$@"` 原样透传。和 10-21 凌晨那个 `musl_child_sanitize_env()`（播放器内部在 fork curl/mplayer 前摘掉 `LD_*`）也不冲突——一个在门口加，一个在里屋摘，各管一段。

无 env 实跑验证全绿：

```
create=0xb3ce99fc onMsgRecv=0xb3d3f731 ...     /* 符号解析通过 */
[http] reap status=0x0 (0=成功, 0x7f00=execl失败)  /* curl 子进程正常 */
*** monitor: 重启 (子进程 @89 帧)                /* 89 帧, 正常 */
```

**顺手堵了个未来的坑**：`build.sh` 的部署逻辑是 `mv $OUT /usr/local/bin/nettv_player`——下次谁再跑构建，wrapper 就被二进制覆盖没了。已把部署目标改成 `nettv_player.real`，wrapper 不动。

## 五、方法论：这次排掉的三个"假根因"

记录一下排查中被证据逐一排掉的猜测，这种"排除记录"和"定位记录"一样值钱：

1. **「ION 池又被泄漏吃干了」**——`/sys/kernel/debug/ion` 显示 `total 0 / orphaned 0`，池子是干净的，且 `free` 有 744MB 空闲；
2. **「设备又在反复休眠把内存搞坏了」**——`dmesg | grep -c "CPU1: shutdown"` 只有 1 次，且 `gcc -O0` 探针一次通过，内存健康；
3. **「worker 莫名暴毙」**——`monitor: 重启 (子进程 @89 帧)` 不是崩溃，是 worker 播满 90 帧上限后的**设计内自退**，monitor 循环重启也是设计行为。日志尾部"戛然而止"只是最后一轮刚起来就被外层 `timeout` 截断。

三个猜测都有当时的"证据"（黑屏、空转、dmesg 尾部热插拔记录），但都经不起针对性验证。**黑屏类问题的麻烦之处在于：现象全都长一个样，根因却各不相同**——所以每次都要重新取证，不能拿上次的结论套。

## 六、待办

- **辽宁移动源本身也播不了**：用户点的这个源（`zteottcdn.ln.chinamobile.com`）IDR 帧约 319KB，超过 VSP 输入 port 的 256KB 上限，属已知黑屏源。修完环境也要换台才能看到画面——**验证时请换四川/泸县类源**。
- 根治候选：`nettv_page.c` 的 child 里 `setenv("LD_LIBRARY_PATH", ...)` 后再 `execl`（本地已备份 `outputs/nettv_page_ui.c`），列入下次 git 提交清单。

---

> **版权声明**：本文为原创技术笔记，作者保留所有权利。转载请注明出处（whiteleibniz.github.io），禁止未授权商业用途。
> 文中涉及的设备、源码与结论来自个人嵌入式项目实战记录（展讯 SC9832A / Alpine Linux / LVGL），数据均为实测。
