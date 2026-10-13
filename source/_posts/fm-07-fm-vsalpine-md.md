---
title: "FM收音启动流程_安卓vsAlpine对比"
date: 2026-09-23 12:16:40
lang: zh-CN
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
---


# 展讯 SC9832A FM 收音启动流程 —— 安卓 vs Alpine（本设备）对比

> **读者对象**：需要理解"为什么我们在 Alpine 上要这么干"的人
> **核心价值**：安卓原生有一整套框架，我们在 Alpine 上要用尽量少的代码替换它——本文把两边的每个环节对齐，
> 让你清楚**哪一段被我们替掉了、替代的依据是什么**

---

## 1. 芯片物理架构（两种系统共用）

无论安卓还是 Alpine，**底下三层完全一样**，这是能互相对照的前提：

```
┌─ 硬件层   Marlin2 combo 芯片，SDIO vendor 0x0000 / device 0x2331
│            WiFi + BT + FM 三合一，共享 SDIO 总线
├─ 固件层   download 一次性烧入 combo 固件（含 FM 部分）
├─ 驱动层   marlin_fm.ko → 注册 misc 设备 /dev/fm（minor 23）
│
│  ← 以下开始分道扬镳 →
```

**实测取值**（`spd-box`，本机）：

| 项 | 值 |
|---|---|
| SDIO modalias | `sdio:c00v0000d2331` |
| FM 驱动 | `marlin_fm`（`Used by sprdwl`） |
| FM 设备节点 | `/dev/fm`（misc 23）、`/dev/log_radio`（misc 35） |
| FM PCM | `01-04: Dfm sprd-codec-fm-4`（playback） |
| 内核 | Linux 3.10.65 |

> 驱动自述：`SDIO radio driver for marlin2 FM Radio Receivers, share SDIO with BT/WIFI`
> ——这句话在两种系统下都成立，是分析共享资源问题的出发点。

---

## 2. 安卓 6.0 原生 FM 启动流程

### 2.1 启动链

```
开机
 └─ init / ueventd
     ├─ insmod sprdwl.ko → 连带 marlin_fm.ko
     ├─ download（与 WiFi 共用，烧 combo 固件）
     ├─ wcnd（WiFi/蓝牙/FM 统一的上电管理）
     └─ SystemServer
         └─ BroadcastRadioService
             └─ 加载 FM HAL
                 ├─ libradio.so / libradioservice.so（HAL 接口）
                 ├─ libFMHalSource.so（音频源，起线程从 PCM 读）
                 ├─ libfmjni.so（JNI 桥）
                 └─ libengfm.so（工程模式，只导出 fm_runcommand）
                     └─ 打开 /dev/fm，发命令
         └─ FM App（radio_interactor_service.apk 等）
             └─ AudioFlinger ← FMHalSource → TinyALSA → PCM
```

### 2.2 安卓关键点

| 环节 | 安卓的做法 |
|---|---|
| **权限/访问控制** | SELinux + 设备节点权限，`/dev/fm` 只允许 radio 组访问 |
| **音频路由** | `FMHalSource` 持 `pcmHandle`，`FMHalThread::threadLoop()` 读 PCM → `RingBuffer` → AudioFlinger 混音 |
| **状态管理** | `BroadcastRadioService` 统一管理 radios，向 App 提供 `RadioManager` API |
| **RDS 处理** | HAL 内部解析（`rds_parser` 在驱动或 HAL 侧），经 `RadioMetadata` 上报给 App |
| **多 App 竞争** | 服务层统一仲裁，App 通过 API client 使用 |
| **中间层厚度** | 很厚：App → RadioManager → BroadcastRadioService → JNI → HAL → /dev/fm |

**证据来源**（本机可从 Android 分区直接读到）：

```sh
ls /mnt/android_sys/lib/{libFMHalSource,libengfm,libfmjni,libradio,libradioservice}.so
ls /mnt/android_sys/priv-app/radio_interactor_service/radio_interactor_service.apk
nm -D /mnt/android_sys/lib/libengfm.so                 # 只有 fm_runcommand
nm -D /mnt/android_sys/lib/libFMHalSource.so | grep -i 'pcm\|thread\|RingBuffer'
```

---

## 3. Alpine（本设备）FM 方案

### 3.1 目标：用最少代码替换一整套

我们在 Alpine 上**没有** binder / SystemServer / AudioFlinger / SELinux radio 策略。
所以要替换的是第 ④、⑤ 两层，**保留 ①–③ 层原样**。

### 3.2 拟定的启动链

```
开机
 └─ openrc
     ├─ sprdwl.ko → marlin_fm.ko（继承现有 WiFi 链路）
     ├─ logdw
     ├─ download（烧 combo 固件，含 FM）        ← 复用既有
     ├─ wcnd（上电）                            ← 复用既有
     ├─ bt_once(BT-OPEN) → bt_wake.sh           ← 复用既有
     ├─ bt_user_daemon  /tmp/bt_ctl.sock        ← 复用既有
     ├─ fm_radio_daemon /tmp/fm_ctl.sock        ← 【新增】替换安卓整套中间层
     └─ lvgl_demo → 收音机页 g_radio_page        ← 【新增】替换安卓 FM App
```

### 3.3 Alpine 侧的对应关系

| 安卓组件 | Alpine 替代方案 | 说明 |
|---|---|---|
| insmod + 节点权限 | 继承既有 WiFi 链路，无需额外动作 | `/dev/fm` 已可用 |
| BroadcastRadioService | **无** | 用 daemon 的单实例互斥代替服务层仲裁 |
| FM HAL (`libFMHalSource.so`) | **`fm_radio_daemon` 内的音频线程** | 逻辑同构：读 PCM → 缓冲 → 输出 |
| JNI / `libfmjni.so` | **无** | UI 与 daemon 之间用 unix socket 文本协议 |
| `libengfm.so`(`fm_runcommand`) | **自己实现命令封装** | 提示可采用 AT 命令风格 |
| RadioManager API | **socket 文本命令** | 命令少、好调试、和蓝牙 daemon 一致 |
| AudioFlinger 混音/焦点 | **自己写音频焦点仲裁** | 必须做，否则 FM/A2DP/本地会串音 |
| FM App (APK) | **LVGL `radio_page`** | 720×1280 竖屏，31px 行高网格 |

---

## 4. 逐环节对比表

| 环节 | 安卓 | Alpine（本机） | 差异要点 |
|---|---|---|---|
| **固件下载** | download in init | download via openrc | 基本相同；Alpine 依赖 WiFi 自启链 |
| **上电管理** | wcnd 统一管理 | wcnd 同上 | 相同 |
| **驱动加载** | insmod sprdwl → marlin_fm | 同（自动加载） | 注意 `marlin_fm` 被 `sprdwl` 依赖 |
| **设备节点** | `/dev/fm`（受限访问） | `/dev/fm`（misc 23） | Alpine 下 root 直连，无 SELinux 约束 |
| **命令接口** | HAL 封装 ioctl/AT | daemon 直发 | **命令号已逆向还原**（`0xC004F500 \| nr`，47 条） |
| **音频源** | `FMHalSource` + `FMHalThread` + RingBuffer | daemon 自建读线程 | 架构同构，实现从简 |
| **音频混音** | AudioFlinger | **需自建焦点仲裁** | 安卓由框架兜底，Alpine 必须自己写 |
| **RDS 上报** | `RadioMetadata` → App | socket 文本字段 | RDS 解析能力驱动里已有，直接取 |
| **UI** | APK + 完整 FM App | LVGL 收音机页 | 受限于 MCU 级资源，按 720×1280 精简设计 |
| **多 App 竞争** | 服务层仲裁 | **单 daemon 独占 + 上层仲裁** | 简单但够用 |
| **命令行工具** | `amixer`/`tinymix`/`tinyplay`（安卓自带） | **全部没有** | 只能写 C 走 libasound.so.2 |

---

## 5. 原理要点（为什么这样能通）

1. **组合芯片共享 SDIO 是关键约束**：
   固件一次烧入、上电统一管理，所以**不可能单独给 FM 烧固件或单独上电**。
   这也是"WiFi 不通 ⇒ FM 一定不通"的根因。

2. **驱动已经把复杂的射频/解调/RDS 全做完了**：
   用户态不需要实现任何 FM 协议，只需要按命令集操作。
   所以 Alpine 侧用"一个薄 daemon"替代安卓"一整套 HAL+服务+JNI"是可行的。

3. **音频是唯一必须自己补的框架能力**：
   安卓有 AudioFlinger 做混音与焦点管理；Alpine 侧没有任何东西负责这件事，
   **必须显式实现 FM / A2DP / 本地播放的三方仲裁**，否则用户必定遇到串音。

4. **socket 文本协议是刻意的选择**：
   与既有蓝牙 daemon（`/tmp/bt_ctl.sock`，`state`/`on`/`off`）保持一致，
   团队已有认知、已有踩坑经验（尤其是"必须设 socket 超时，否则冻 UI"）。

---

## 6. 一句话总结

> 安卓用**一整套框架**（Service + HAL + JNI + AudioFlinger）托住 FM；
> 我们在 Alpine 上保留同样的**底下三层**（硬件/固件/驱动），
> 用一个 **`fm_radio_daemon`** 替掉中间层，用一个 **LVGL 收音机页**替掉 App，
> 并**自己补上安卓由框架兜底的那块——音频焦点仲裁**。
> 原先唯一的不确定性 **ioctl 命令号** 已解除（见《FM收音ioctl命令表_逆向还原》），整条链已可跑通。
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
