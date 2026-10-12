---
title: "WiFi芯片打通工作过程与思路总结"
date: 2026-09-13 15:27:33
search: true
categories:
- 硬件模块打通
- WiFi
tag:
- WiFi
- SC2331
---


# WiFi 芯片打通 —— 工作过程与思路总结

> **主题**：从"Alpine 下 WiFi 完全失效"到"可扫描、可连接"的完整排查与解决过程复盘。
> **文档目标**：记录我（执行者）的**分析思路、逐步拆解、关键决策与原因**，方便复盘和迁移到类似问题。
> **文档版本**：v1.0　|　2026-09

---

## 1. 问题定义（先做对题目）

**现象**：
- 设备 spd-box（SC9832A，Android 6 内核 3.10.65 + Alpine Linux 3.21 armhf）；
- WiFi/蓝牙在 Android 下可用；
- switchroot 后 WiFi 失效：`dmesg` 反复 `SDIO dev not ready`，GPIO94 READY 恒 0，内核枚举不到芯片。

**我做的第一件事是"界定问题边界"**：
- 硬件坏了吗？→ 用户明确说 Android 下可用，且有一台同型号 H709 正常 → **排除硬件故障**。
- 内核错了吗？→ 内核还是 Android 3.10.65，没换 → **内核大概率不是根因**。
- 那差异只剩两个：**根文件系统（用户态）** 和 **DTB/配置**。

这个"先排除不可能项"的界定，让后续排查没有走弯路去重编内核或怀疑硬件。

---

## 2. 第一阶段：正面尝试（约 6 类方案全部失败）

在拿到对照机之前，我先尝试在 Alpine 里"手工模拟"上电，全部失败，记录如下：

| # | 尝试方案 | 结果 | 失败原因（事后归因） |
|---|---|---|---|
| 1 | 手动 ioctl 组合（POWER_ON/POWER_RST 各种顺序） | 无效 | 上电时序不是简单 ioctl 能复刻的，需完整状态机 |
| 2 | 往 DTB 注入电源属性（vddwifipa/vddcon/always-on/runtime） | 无效 | 属性本身不缺，缺的是"用户态驱动固件下载"这个动作 |
| 3 | GPIO 采样引导（跟踪引脚电平找时机） | 无效 | READY 恒 0 说明芯片根本没被激活 |
| 4 | /dev/mem mmap 直写寄存器 | 无效 | 寄存器级操作无法替代芯片引导协议 |
| 5 | 设备上编内核模块（想加驱动逻辑） | 失败 | 设备无 kernel build 目录，交叉编译链不可用 |
| 6 | p21（recovery）dtb 修改 | 无效 | 非活动分区，改了不生效 |

**关键认知（为什么我停下来了）**：
- 失败 1-4 的共同点是"我在**模仿**一个我不知道完整细节的协议"；
- 芯片的上电+固件下载是**厂商私有协议**，逆向它成本极高、成功率低；
- **换思路**：既然 Android 里有现成实现（download 服务），**与其模仿，不如复用**。

> 方法论一：遇到"协议未知"的问题，优先寻找"现成实现"而不是逆向协议。

---

## 3. 第二阶段：对照机取证（用事实代替猜测）

用户提出关键建议：有一台**同型号、Android 正常**的设备，可以做对照实验。这解决了"不知道正确行为是什么"的问题。

### 3.1 连接与取证

通过 WatchTools adb（`AndroidWatch_ADB_ToolBox\adb\adb.exe`）连接 H709（root=Magisk）：

拿到的事实：

| 项目 | 值 |
|---|---|
| 分区映射 | boot=p16、wcnfdl=p14、wcnmodem=p15、system=p17、recovery=p21 |
| boot 镜像 | `boot_p16_android.img`（20MB，`ANDROID!` 头，FDT @0xB71800） |
| 原版 DTB | `android_orig.dtb`（53,967 字节） |
| 上电程序 | `/system/bin/download` + `/system/lib/libiwnpi.so` |
| 固件分区 | wcnfdl（p14）、wcnmodem（p15） |
| 用户态配置 | `/etc/marlinba/*.ini` |

**为什么这些是决定性的**：
- 分区映射告诉我"固件在哪、boot 在哪"；
- download 二进制告诉我"Android 是怎么给芯片上电的"；
- 原版 DTB 告诉我"硬件应该被怎么描述"。

> 方法论二：对照"已知正确的系统"取证，把猜测变成可验证的事实。取证要拿**能跑的东西**（二进制、固件、配置），不只是看日志。

### 3.2 关键决策：chroot 复用 Android 二进制

观察 Android 的架构后我判断：
- download 服务的硬件操作（写 `/dev/power_ctl`、ttyS0 握手、SDIO 写固件）**都通过内核驱动完成**；
- 它本身是**普通 ELF**，只要能加载进内存并找到设备节点/固件，就能驱动内核干活；
- 它需要 Android 的库和 linker → 用 **chroot** 提供迷你 Android 文件系统即可。

**于是方案定型**：
```
在 Alpine 里搭 /tmp/aand/ 迷你 Android 环境
  → chroot 进去跑 download
  → 芯片上电 + 固件下载
  → 回到 Alpine 继续
```

> 方法论三：遇到"用户态组件依赖特定根文件系统"的问题，chroot 是低成本的隔离复用手段——不用改主系统，只搭最小依赖集。

---

## 4. 第三阶段：逐个击破 chroot 运行的障碍（strace 驱动）

`chroot` 后第一次运行 download 必然报错。我采用 **strace 定位法**（不猜，看系统调用）：

| 报错信号（strace 看到） | 根因 | 修复 |
|---|---|---|
| `open("/dev/power_ctl")` 失败 | chroot 内 /dev 是空的 | `mount --bind /dev /tmp/aand/dev` |
| `open(...wcnfdl)` 失败 | download 按 by-name 找固件分区 | 建链接 `wcnfdl → /dev/block/mmcblk0p14`、`wcnmodem → /dev/block/mmcblk0p15` |
| 缺 .so 库 | 迷你环境不完整 | 从 `/mnt/android_sys/lib/` 复制全套 `.so` |

**关键突破点**：`mount --bind /dev` 后，download 能打开内核节点；链接 wcnfdl/wcnmodem 后它能找到固件。**跑通后 dmesg 出现决定性证据**：

```
mmc2: new high speed SDIO card at address 8800
mmc2:8800:1
device 0x2331
sprd_download_sdio_write ... 131080 ...   （大块固件写入）
```

**这一刻意味着**：
- 芯片被成功上电；
- 固件被成功写入；
- GPIO94 READY 拉高；
- 内核枚举出 SDIO 从设备。

> 方法论四：用 `strace` 看"它到底在找什么"，每个 ENOENT 都是一条精确的修复指令。比读文档/猜配置高效得多。

---

## 5. 第四阶段：DTB 修正（消除隐性变量）

**现象**：download 跑通有时仍不稳定。进一步核查发现 p16 的 dtb 曾有被改过的痕迹（早期尝试注入电源属性）。

**决策**：直接用 Android 原版 DTB 覆盖 p16 中 dtb 段：

```sh
dd if=/tmp/android_orig.dtb of=/dev/block/mmcblk0p16 bs=512 seek=20008 conv=notrunc
```

- `seek=20008`（512B 块）对应 boot 内 dtb 的字节偏移 `0x9C5000`；
- 换回原版后，电源/时钟描述与 Android 一致，消除 DTB 这一隐性变量。

**为什么必须做**：download 的上电时序设计时是**对着 Android 原版 DTB 的电源模型**来的；DTB 被改过之后，即使程序逻辑对，硬件描述也对不上。

> 方法论五：当"程序对但行为不对"时，检查**环境描述层**（DTB/配置文件）是否被改过。先恢复原厂基线，再谈优化。

---

## 6. 第五阶段：驱动与用户态 supplicant

芯片枚举成功 ≠ WiFi 可用，还要走完数据通路：

### 6.1 驱动加载（顺序敏感）

```sh
insmod /lib/modules/marlin_fm.ko   # 先：提供 fm_read 等符号
insmod /lib/modules/sprdwl.ko      # 后：主 WiFi 驱动
```

- 顺序反了会报 `Unknown symbol`；
- 成功后出现 `wlan0`（MAC `a2:d2:f3:bf:8c:10`）→ 驱动绑定成功。

### 6.2 wpa_supplicant（踩过坑的决策）

**第一次尝试**：直接在 Alpine chroot 里跑 **Android 原版 wpa_supplicant 2.5**：
- 报 `CANNOT LINK`（缺库）→ 复制 `/mnt/android_sys/lib/*.so` 后仍 `Aborted`；
- 根因：**Android Bionic libc 与 glibc/musl 环境不兼容**，linker 机制不同。

**决策转向**：不再复用 Android 的 supplicant，改用 **Alpine armhf 原生包**：
- `wpa_supplicant-2.10-r11.apk` + `libnl3.apk` + `pcsc-lite-libs-2.2.3-r1.apk`；
- Alpine 官方/镜像源当时不可用（证书/到期），从电脑端下载 apk 后 `apk add --allow-untrusted` 装到设备。

**配置**：
```
ctrl_interface=/run/wpa_supplicant
update_config=1
country=CN
```

**为什么这个分工合理**：
- **底层固件下载**（厂商私有、内核相关）→ 复用 Android 二进制（chroot）；
- **用户态 supplicant**（标准网络协议、与 libc 相关）→ 用 Alpine 原生包。

> 方法论六：按"与内核/硬件的耦合度"切分复用边界——硬件私有的复用原厂，标准化的用新系统原生实现。两边都不硬凑。

### 6.3 扫描成功

```sh
wpa_cli -i wlan0 scan
wpa_cli -i wlan0 scan_results
# CMCC-dtGM(-29) / CMCC-PcZt(-42) / CMCC-xxfS(-51) ... 共 6~11 个热点
```

**至此 WiFi 芯片完全打通**：上电 → 固件 → 枚举 → 驱动 → 扫描。

---

## 7. 时间线总览

| 阶段 | 关键动作 | 结果 |
|---|---|---|
| 界定问题 | 排除硬件/内核，锁定用户态+DTB | 方向正确 |
| 正面尝试 | 6 类手工模拟上电 | 全部失败（私有协议不可模仿） |
| 对照取证 | adb 连 H709，拿分区/固件/download/DTB | 拿到"正确行为的全套素材" |
| chroot 方案 | 搭 /tmp/aand 迷你 Android 环境 | 方案定型 |
| strace 排障 | bind /dev + 固件链接 + 补库 | download 跑通，芯片枚举 |
| DTB 修正 | 恢复 Android 原版 dtb | 消除隐性变量 |
| 驱动 | marlin_fm.ko → sprdwl.ko | wlan0 出现 |
| supplicant | Alpine armhf 原生包 | 扫描/连接可用 |
| UI 层 | launcher 网络页接线 | 用户在界面上可操作 |

---

## 8. 方法论沉淀（可迁移到其他板子/芯片）

1. **先排除不可能项**（硬件/内核/系统），再集中火力在真实差异层；
2. **私有协议不要逆向，要复用**——找原系统的现成实现（二进制/服务）；
3. **对照机取证**：同型号正常设备是"正确行为"的最权威来源，尽量拿能跑的素材；
4. **chroot 隔离复用**：为第三方二进制搭最小依赖集，不污染主系统；
5. **strace 驱动排障**：每个 open/ENOENT 都是精确修复指令，不靠猜；
6. **恢复原厂基线**：环境描述层（DTB/配置）被改过就先还原，再做新改动；
7. **按耦合度切分复用边界**：硬件私有的复用原厂，标准化的用原生实现；
8. **单向依赖链思维**：上电→固件→枚举→驱动→supplicant 逐级验证，每级有 dmesg/日志证据再进下一级。

---

## 9. 遗留事项与后续方向

- **开机自启动固化**：download 上电 + 驱动加载 + wpa_supplicant 已通过 local 脚本/模块配置固化（详见《操作手册》4.10）；
- **蓝牙**：SC2331 是 Combo 芯片，蓝牙同源同路，可参考同一套"chroot download + 驱动 + 用户态"流程打通（尚未展开）；
- **连接稳定性**：扫描已稳定，连接/漫游行为需实网长测；
- **UI 层**：launcher 网络配置页已能扫描、显示列表、连接，后续可加"已保存网络管理、信号强度排序优化"。

---

*本总结复盘了从"现象"到"根因"再到"解决方案"的完整链路。核心一句话：芯片没坏、内核没坏，坏在"Alpine 缺了 Android 的芯片初始化服务"——用 chroot 把这一步借回来，链路即通。*
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
