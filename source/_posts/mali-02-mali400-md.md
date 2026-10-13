---
title: "Mali400_摆脱安卓可行性分析"
date: 2026-09-30 18:50:38
lang: zh-CN
search: true
categories:
- 硬件模块打通
- Mali GPU
tag:
- Mali
- GPU
---


# 展讯 SC9832A Mali-400 —— 摆脱安卓可行性分析

> 目标：评估能否**完全不依赖安卓(bionic)用户态**来驱动 Mali-400 GPU。  
> 环境：Alpine/musl（根 OS，armv7l）+ 展讯 SC9832A + 内核 3.10.65。  
> 数据来源：2026-09-30 对设备的只读探测（uname / lsmod / readelf / strings / mount / find）。

---

## 0. 一句话结论

**技术可行，但有两条路线，难度天差地别：**

- **方案①（闭源、省力）**：换一组"Linux 原生"的 Mali 用户态库（同版本 Utgard DDK 的 Linux 变体），去掉 bionic 依赖。**难点在获取匹配版本的闭源 DDK**，不是技术。
- **方案②（全开源、彻底）**：用设备已装好的 **Mesa 24.2.8 + Lima** 驱动 Mali-400。**只差内核 DRM 节点**（`/dev/dri`），需在 3.10.65 上补 `lima` + 显示 DRM 驱动——工程量最大，但能 100% 去安卓、且去 shim 黑魔法。

> 一个被忽视的事实：**`mali.ko` 本身是 ARM 闭源内核 blob**。所以方案①只是"用户态非安卓"，内核仍依赖闭源模块；只有方案②才彻底开源。无论哪条路，当前都卡在**内核侧接口**——用户态库（bionic 那套 / mesa 那套）反而都齐了。

---

## 1. 现状硬证据（探测所得）

| 项         | 发现                                                                                                                                             | 含义                              |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 内核        | `3.10.65 #13 SMP PREEMPT ... armv7l`                                                                                                           | 老旧 vendor 内核                    |
| GPU 节点    | `/dev/mali0` 存在；**`/dev/dri` 不存在**                                                                                                             | 只有专有 UDD 接口，无 DRM               |
| 内核模块      | `mali.ko`（446KB，已加载）；源自 `vendor/sprd/modules/libgpu/gpu/utgard/...`（`wzp_1.5_0703` BSP）                                                        | **Utgard 专有 blob，不含 DRM 子系统**   |
| DRM 子系统   | `/sys/class/drm` 不存在；`cat /proc/filesystems` 无 drm                                                                                             | 运行内核根本没编 DRM                    |
| 当前用户态     | `/system/lib/libEGL.so`→`/mnt/android_sys/lib/libEGL.so`；interpreter=`/system/bin/linker`；NEEDED=`libcutils/libutils/liblog/libc++.so/libc.so` | **Android DDK**，链接 bionic HAL 库 |
| bionic 来源 | `/mnt/android_sys`（`/dev/mmcblk0p17`，ext4，**ro 挂载**的原安卓分区）；`/system/bin/linker`、`/system/lib/libc.so` 均指向它                                     | 安卓用户态完全外挂，根 OS 是 musl           |
| Mesa 现状   | `/usr/lib/libGL.so.`<u>`1.2.0`</u>→**Mesa 24.2.8**；`/usr/lib/xorg/modules/dri/lima_dri.so`、`panfrost_dri.so` 均存在                               | **Lima 用户态已就绪**，只缺内核 DRM        |
| 内核构建环境    | `/lib/modules/3.10.65/build` 不存在；`/usr/src` 不存在；仅有 `/usr/bin/gcc`（host）                                                                        | **无法就地编内核模块**，需外部 BSP 源码树       |

---

## 2. "摆脱安卓"的三种终态

- **方案① ARM Mali Linux DDK（闭源用户态，非 Android）**：把 Android `libEGL/libGLESv2` 换成**同一 Utgard DDK 的 Linux 构建**（链接 musl/glibc + `libump`，走 fbdev/DRM 窗口，**不**依赖 `libcutils/libutils/liblog`）。
- **方案② Mesa Lima（全开源）**：用已装好的 Mesa+`lima_dri.so` 驱动 Mali-400，经标准 EGL/GL + DRM/KMS 出图。
- **方案③ 维持现状混合桥**（bionic 库 + `bionic_shim` + musl-gcc `-Wl,--entry=main`）：当前唯一能跑的，**不算摆脱**。

---

## 3. 两条路线逐层可行性

### 3.1 内核侧（两条路共用前提）

`mali.ko` 是内核模块，libc 无关，Alpine 照常 `insmod`。但它只给 `/dev/mali0`（UDD ioctl），**Lima 用户态不认这个接口**——Lima 要的是 `drm_lima_*` ioctl（`/dev/dri`）。所以：

- 方案① 保留 `mali.ko`，只换用户态 → **内核侧零改动**。
- 方案② 必须**替换** `mali.ko` 为 lima DRM 驱动 → 内核侧大改。

### 3.2 方案① 明细

- 动作：取得 **Utgard Linux DDK**（含 `libEGL.so`/`libGLESv2.so`/`libump.so`，glibc/musl 版），放到 `/usr/lib`，删掉 `/system` 软链与 `bionic_shim`。
- 窗口系统：Linux DDK 支持 **fbdev**（无 DRM 也能跑），正好匹配本机只有 `/dev/fb0`。
- 回读：Linux DDK 的 pbuffer/fbdev 读回语义正常，**之前 gpu_bench 的黑屏/陈旧红问题大概率消失**。
- **阻塞点（唯一）**：用户态 DDK 与内核 `mali.ko` 必须**同 DDK 版本**（如 r4p0↔r4p0）。模块来自 sprd `wzp_1.5_0703` BSP，需从该 BSP 取出**对应版本的 Linux 用户态**。ARM 早已停止公开分发经典 Utgard DDK（UMPL 许可，~2014 r4p0 末版），公开获取困难；**若该 BSP 打包时带了 linux 变体则一击即中，否则 procurement 是硬卡点**。

### 3.3 方案② 明细

- 动作：内核加 `drivers/gpu/drm/lima` + 一个显示 DRM 驱动（SPRD 显示控制器，或包一层 dumb DRM 复用现有 fb），编进 3.10.65 并加载，得 `/dev/dri/card0`；用户态已齐（Mesa 24.2.8 + lima）。
- payoff：100% 开源、标准接口、`glReadPixels` 正常、彻底告别 shim/ctor/TLS/dlsym 黑魔法；PSP 前端、gpu_bench 都可直接用标准 EGL。
- **阻塞点（最大）**：lima 上游要求较新内核，往 3.10.65 **backport 是重活**；且需配套显示 DRM 驱动（本机显示目前是裸 fbdev，没有 DRM 封装）。**无在机内核源码/构建环境**，需先取得 SC9832A 的 3.10.65 BSP 源码树。
- 性能：Lima 的 GLES2 在 Mali-400 上可用，但通常略低于专有 blob；对跑分/演示足够，PSP 模拟可能比专有前端略低。

---

## 4. 关键认知（容易踩的坑）

1. **两条路都卡在"内核侧接口"**：方案① 卡"匹配版本的闭源用户态"，方案② 卡"补开源内核 DRM"。用户态库（bionic 那套 / mesa 那套）反而都齐了。
2. **mali.ko 闭源** → 方案① 只是"用户态非安卓"，内核仍依赖 ARM blob；只有方案② 全开源。
3. **android_sys 可卸载**：`/mnt/android_sys` 是 ro 挂载的原安卓分区，仅当前 Mali 栈需要；摆脱后不挂它、删 `/system` 软链即可，根 OS（Alpine/musl）不受影响。
4. **不能"用 mesa 但留 mali.ko"**：Mesa Lima 与专有 `mali.ko` 用的是两套不兼容的内核 UAPI，无法混用。
5. **不能"给 bionic libEGL 套 shim 伪装成 Linux"**：它依赖 `libcutils/libutils/liblog`（Android HAL：property/hw_get_module/ashmem/binder），重实现这些等于重写 Android HAL，正是要摆脱的东西，且极脆。

---

## 5. 推荐与决策树

```
能否从 SC9832A BSP(wzp_1.5_0703) 拿到 同版本 Utgard Linux DDK 用户态?
├─ 能 ──► 方案①：换 .so、去 bionic、fbdev 出图。最省力，顺手解决回读黑屏。
└─ 不能 ─► 想要"真正彻底非安卓"才值得上 方案②：
           取得 3.10.65 BSP 源码 → 加 lima+显示 DRM 驱动 → 编内核 → /dev/dri → Mesa Lima。
           （工程量大，但一劳永逸，且能摘掉所有 shim 黑魔法）
```

**务实建议**：先确认 BSP 里有没有 Linux 版 `libEGL/libGLESv2`（往往和 Android 版放在同一 vendor 包的不同目录）。有就走方案①，性价比最高；没有且你坚持"彻底去安卓"，再投入方案②。

---

## 6. 下一步最小验证（验证归用户）

1. **查 BSP 是否含 linux 版 Mali 用户态**：在 `wzp_1.5_0703/idh.code/vendor/sprd/modules/libgpu/` 及 `out/.../system/lib/` 里找 `libEGL.so`/`libGLESv2.so` 的 **非 bionic** 构建（readelf 看 interpreter 是否为 `/system/bin/linker`，NEEDED 是否含 `libcutils`）。
2. **探 3.10.65 能否补 DRM**：确认能否取得该内核源码树；grep 是否已有 `drivers/gpu/drm/lima` 或 SPRD 显示 DRM 雏形，评估 backport 工作量。
3. **快速证伪**：在现有环境 `EGL_PLATFORM=surfaceless` + Mesa 试跑，确认确因缺 `/dev/dri` 而失败（验证"只差 DRM"这个判断）。

---

## 附录 A：`/lib/modules` 里几个模块是干什么的

| 文件 | 证据（strings/modinfo） | 干什么 | 运行必需 |
|---|---|---|---|
| **mali.ko** | `utgard/driver/mali`（sprd `wzp_1.5_0703` BSP） | Mali-400 GPU 内核驱动 → `/dev/mali0` | ✅ GPU |
| **sprdwl.ko** | `description=SPRD sc2331 Wireless Network Adapter`，`author=jinglong.chen` | 展讯 **Wi-Fi** 驱动（Marlin combo 芯片） | ✅ Wi-Fi |
| **marlin_fm.ko** | `fm_read_rds_data` / `parse_at_fm_cmd` / `fm_sdio_*` | **FM 收音机**驱动（SDIO/AT） | 仅用 FM |
| **pskey_bt.txt** | `device_class`/`default_ahb_clk`/`feature_set`/增益功率表；"HEX 修改、0x 开头" | **非驱动**：蓝牙芯片 **PSKEY 持久化配置**（NVM） | 用 BT 时 |
| **autotst.ko** | `author=anli.wei`；含 `sprdfb` 串 | 出厂**自检**模块 | ❌ 调试 |
| **gator.ko** | `gator_get_time` / `ARM1136…ARMv7 Cortex-` | **ARM Streamline** 性能剖析模块 | ❌ 剖析 |
| **mmc_test.ko** | `author=Pierre Ossman`，`kernel/drivers/mmc/card/mmc_test.c` | 主线 **MMC/SD/eMMC 压测**模块 | ❌ 拷机 |

> marlin_fm / sprdwl / pskey_bt 是一套：**Marlin = 展讯 combo 连接芯片（Wi-Fi/蓝牙/FM/GPS 合一）**。

---

## 附录 B：DRM 同名陷阱 —— 安卓那个 `/lib/drm` 不是 GPU 的 DRM

**发现**：`/mnt/android_sys/lib/drm/` 里只有 **`libdrmomaplugin.so`**（OMA DRM 插件）。

**两个 DRM 完全是两回事（最容易带偏排查）**：

| 缩写 | 全称 | 领域 | 本机在哪 |
|---|---|---|---|
| **DRM** | **Direct Rendering Manager** | **内核 GPU/显示子系统**，给 `/dev/dri`、`GEM/TTM` 显存、命令提交、`KMS` 模式设置 | ❌ 本机没有（无 `/dev/dri`） |
| **DRM** | **Digital Rights Management** | **数字版权保护**（加密媒体、OMA/Widevine） | ✅ 安卓侧有：`lib/drm/libdrmomaplugin.so`、`libdrmframework.so`、`libdrmdecrypt.so`、`libdrmntp.so` |

**安卓确实没有用内核 DRM（Direct Rendering Manager）——证据链：**

1. 无 `/dev/dri`、无 `/sys/class/drm`，内核根本没编 DRM；
2. 图形走 **HAL 替代方案**：`gralloc.sc8830.so`（显存分配，**替代 GEM**）+ `hwcomposer.sc8830.so`（显示合成，**替代 KMS**）；
3. Mali 只暴露 **`/dev/mali0`**（专有 UDD ioctl），不走 `/dev/dri`；
4. 安卓侧**没有**通用 `libdrm.so`（GPU 那版），只有 `libdrmframework*.so`（版权那版）；
5. 系统 = **Android 6.0（MRA58K）**，老式 vendor HAL 模型（远早于 Treble，更不可能用主线 DRM）。
6. 反证：GPU 版 libdrm 只存在于 Alpine/mesa 侧（`/usr/lib/libdrm_intel.so.1`，Intel 目标、且同样需要 DRM 节点才有用）。

**结论**：找到 `/lib/drm` **不代表**安卓用了内核 DRM，纯属缩写撞名。正因为安卓用 gralloc+hwcomposer+`/dev/mali0` 绕开了 DRM，才导致——现成的 Mesa Lima 无 `/dev/dri` 可用、方案②必须先在 3.10.65 上补 DRM 驱动。这也是"摆脱安卓"卡在内核侧的根因之一。

### 追加：`/mnt/android_sys/vendor/lib` 下的同名文件也全是数字版权

实抽符号坐实（均为 Google **Widevine** / **MediaDrm** 内容解密，与 GPU 无关）：

| 文件 | 实抽符号 | 真身 |
|---|---|---|
| `libwvm.so` | `android::DrmManagerClient::decrypt` / `DecryptHandle` | 安卓 DRM 框架客户端 |
| `libwvdrm_L3.so` | `WidevineMediaKit::Component::HandleStreamInfoSource` | **Widevine L3**（软件级版权） |
| `libWVStreamControlAPI_L3.so` | `WidevineMediaKit::MemoryChunk` | Widevine 流控 API L3 |
| `vendor/lib/drm/libdrmwvmplugin.so` | `android::DrmConstraints` | 老安卓 DRM 插件（WVM） |
| `vendor/lib/mediadrm/libdrmclearkeyplugin.so` | `clearkeydrm::AesCtrDecryptor`、`createDrmFactory` | **MediaDrm** ClearKey 插件 |
| `vendor/lib/mediadrm/libwvdrmengine.so` | `wvdrm::getCDM` | **MediaDrm** Widevine 引擎 |
| `vendor/lib/libbt-vendor.so` | `sprd_bt_power_ctrl`、`bt_vendor_cbacks` | 展讯**蓝牙** vendor HAL |

> **识别口诀**：安卓侧凡是名字带 `drm` 的（`libdrmframework / libdrmdecrypt / libdrmwvmplugin / mediadrm / libwvdrm*`）**一律是数字版权/媒体解密**。
> **真正跟 GPU 相关的名字里从来没有 drm**：用户态是 `libEGL.so` / `libGLESv2.so` / `libGLESv1_CM.so`，HAL 是 `gralloc.sc8830.so` + `hwcomposer.sc8830.so`，内核是 `mali.ko`。
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
