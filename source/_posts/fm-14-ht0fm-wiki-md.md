---
title: "HT0FM收音原理与移植学习Wiki"
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


# HT0 FM 收音机原理与移植学习 Wiki

> **读者对象**：想搞懂"这颗芯片的 FM 到底怎么回事"、以及将来要迁移到别的平台的工程师
> **阅读方式**：§0–§2 建立直觉 → §3 理解软硬件分层 → §4 看安卓怎么干 → §5 看我们怎么干 → §8 排障方法论 → §9 迁移清单
> **核心价值**：把散落在 `.ko` 符号、ALSA 拓扑、Android 原厂库里的事实，整理成一条能读懂的知识链

---

## 0. 一句话先建立直觉

**FM 收音机在这颗芯片上，不是一块独立硬件，而是 Marlin2 这颗"三位一体"芯片里的第三个功能模块。**

它的射频、解调、RDS 解码都在芯片内部完成，对外只暴露一个 SDIO 上的控制通道和一个 `/dev/fm` 字符设备。
你在 Linux 用户态能做的，本质只有三件事：**给它命令、问它场强、把它产出的音频接到 codec 上**。

---

## 1. 硬件长什么样

### 1.1 一颗芯片，三个功能

```
                        ┌─────────────────────────┐
   SDIO 总线  ──────────▶  Unisoc(展讯) Marlin2   │
   (共享！)              │  ┌───────────────────┐ │
                         │  │ WiFi  (sprdwl)    │ │
                         │  ├───────────────────┤ │
                         │  │ Bluetooth (BT/UART)│ │
                         │  ├───────────────────┤ │
                         │  │ FM Radio (marlin_fm)│ │
                         │  └───────────────────┘ │
                         └───────────┬───────────┘
                                     │ 音频输出
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
              内部 codec 直通      I2S 总线      Over BT（走蓝牙）
```

**实测证据**：

| 事实 | 取值 | 获取方式 |
|---|---|---|
| SDIO modalias | `sdio:c00v0000d2331` | `cat /sys/bus/sdio/devices/*/modalias` |
| SDIO 设备路径 | `mmc2:8800:1` | `ls /sys/bus/sdio/devices/` |
| vendor / device | `0x0000` / `0x2331` | `cat .../vendor`、`.../device` |
| **共享 SDIO 官方表述** | `SDIO radio driver for marlin2 FM Radio Receivers, share SDIO with BT/WIFI` | `strings /lib/modules/marlin_fm.ko \| grep description=` |

最后一行是**最关键的一条**：驱动作者自己写明 FM 与 BT/WiFi **共享 SDIO**。
这条决定了 FM 的一切可用性依赖（固件、上电）都跟 WiFi/蓝牙绑在一起。

### 1.2 "共享 SDIO"意味着什么

| 影响面 | 说明 |
|---|---|
| **固件** | `download` 一次把 combo 固件整体烧入，**含 FM 部分**。没有独立的 FM 固件流程 |
| **上电** | 没有独立的 FM 上电开关，芯片整体带电即可（依赖 `wcnd` / BT-OPEN 那条链） |
| **带宽** | SDIO 是共享总线，WiFi 高吞吐时理论上可能影响 FM 数据流，**需实测评估** |
| **故障耦合** | WiFi 挂了 ⇒ SDIO 不枚举 ⇒ FM 必然不可用。**排障必须先确认 WiFi** |

---

## 2. 软件分层（五层模型）

```
⑤ UI 层      LVGL 收音机页         ← 本项目新增主体
      │ unix socket /tmp/fm_ctl.sock
④ daemon 层  fm_radio_daemon       ← 本项目新增，独占 /dev/fm
      │ ioctl / AT 命令
③ 驱动层      marlin_fm.ko → /dev/fm (misc 23)   ← 已存在
      │ SDIO 事务
② 固件层      Marlin2 combo 固件（含 FM）        ← 随 WiFi 一起烧好
      │ SDIO 物理链路
① 硬件层      Marlin2 芯片 FM 部件               ← 已存在
```

**每层对应的"验证标准"**（这是排障的分层依据）：

| 层 | 通过判据 |
|---|---|
| ① 硬件 | `cat /sys/bus/sdio/devices/*/device` 得到 `0x2331` |
| ② 固件 | WiFi 能起来（`download` 常驻） |
| ③ 驱动 | `lsmod \| grep marlin_fm` 且 `ls /dev/fm` 且 `grep -w fm /proc/misc` 得到 `23 fm` |
| ④ daemon | `connect /tmp/fm_ctl.sock` 成功，`state` 返回 `OK *` |
| ⑤ UI | 能调台、听到声音、返回桌面不停台 |

---

## 3. 驱动给能力的边界：命令清单与 RDS

### 3.1 控制命令（来自 `strings marlin_fm.ko` 的调试打印）

驱动为 ioctl 的每个分支打印 `----<命令名>----`，据此还原：

| 类别 | 命令 |
|---|---|
| 基础 | `TUNE`、`TUNE_NEW`、`SEEK`、`SEEK_NEW`、`MUTE`、`SETVOL`、`GETVOL`、`IS_FM_POWERED_UP` |
| 扫描 | `SCAN`、`SCAN_NEW`、`STOP_SCAN`、`SCAN_GETRSSI`、`PRE_SEARCH`、`RESTORE_SEARCH` |
| 信号 | `GETRSSI`、`GETMONOSTERO`、`SETMONOSTERO`、`SOFT_MUTE_TUNE`、`DESENSE_CHECK`、`IS_DESE_CHAN`、`CQI_GET`、`FULL_CQI_LOG` |
| 音频 | `ANA_SWITCH`、`I2S_SETTING`、`GET_I2S_INFO`、`GET_AUDIO_INFO`、`OVER_BT_ENABLE` |
| RDS | `RDS_SUPPORT`、`RDS_ONOFF`、`RDS_GROUPCNT`、`RDS_BC_RST` |
| 信息 | `GETCHIPID`、`GET_HW_INFO`、`GETCAPARRAY`、`GETCURPAMD`、`GETGOODBCNT`、`GETBADBNT`、`GETBLERRATIO` |
| 量产调试 | `RW_REG`、`TOP_RDWR`、`HOST_RDWR`、`DUMP_REG`、`EM_TEST`、`SIM_DATA`、`GET_LOG` |

> ✅ **更新（2026-09-22）**：命令号**已全部还原并实测确认**，见
> [`FM收音ioctl命令表_逆向还原.md`](FM收音ioctl命令表_逆向还原.md)。
> 编码统一为 `_IOWR(0xF5, nr, 4)` = `0xC004F500 | nr`，47 条中 45 条实测通过。
> 本节保留作**功能视角**的分类，取数字请查那份文档。

### 3.2 AT 命令风格 —— 已实测确认，而且是真的

驱动里有 `parse_at_fm_cmd` / `parse_at_fm_num` 两个函数；Android 侧 `libengfm.so` 只导出一个符号 `fm_runcommand`
（直译就是"跑一条 FM 命令"）。

**这不是猜测，实测抓到了 AT 帧**。调用 `TUNE` 时完整内核日志：

```
FM_DRV: fm_ioctl-72  -- ----TUNE----
FM_DRV: fm_write-348 -- fm_write_completion done=0X0
FM_DRV: fm_write_buf-337 -- * fmdev->write_buf: at+fm=1,0 *
fm_sdio_write size: 11
```

结论：

1. 驱动通过 SDIO 下发的确实是 **AT 文本**，格式 **`at+fm=<opcode>,<param>`**
   （`at+fm=1,0` 是 10 字符 + NUL = 11 字节，与 `fm_sdio_write size: 11` 对得上）。
2. **AT opcode 与 ioctl nr 是两套编号**：`TUNE` 的 ioctl nr 是 `0x02`，AT opcode 却是 `1`。
   目前只确认 `power up -> at+fm=0`、`TUNE -> at+fm=1,<freq>`。**AT 全表尚未标定，别混用**。
3. 另一条副产品：**`TUNE` 是阻塞调用**，失败路径耗时约 **3.99 s**（日志时间戳跨度
   `11448.618` → `11452.613`）。所以 daemon 必须把 TUNE/SEEK 放独立线程，socket 必须设超时。

### 3.3 RDS —— 本项目的差异化价值

`nm marlin_fm.ko` 显示出完整 RDS 解析器：

| 字段 | 函数 | 长度/含义 |
|---|---|---|
| **PS** | `rds_get_ps` | 电台名，**8 字符** |
| **RT** | `rds_get_rt` | 电台文本，**64 字符**（滚动字幕） |
| PTY | `rds_get_pty` | 节目类型（新闻/古典/摇滚…） |
| PI | `rds_get_pi_code` | 节目识别码 |
| **AF** | `rds_get_af` / `rds_get_af_method` | **备用频率**——信号变差时自动切到同一套节目的另一个频率 |
| TP/TA | `rds_get_tp_ta` | 交通节目 / 交通通告 |
| CT | `rds_get_ct` | 电台时钟 |
| DI/MS | `rds_get_di_ms` | 解码标识 / 音乐-语音 |
| **EWS** | `rds_get_ews` | **紧急广播**（有合规意义） |
| PTYN / PIN / SLC | `rds_get_ptyn` / `rds_get_pin` / `rds_get_slc` | 节目类型名 / 条目号 / SLC |
| ODA / TDC | `rds_get_oda` / `rds_get_oda_aid` / `rds_get_tdc` | 开放数据应用 / 透传数据通道 |
| EON | `rds_get_eon` / `rds_get_eon_ta` | 增强其他网络信息 |

**这意味着收音机 App 不只是"能出声"，而是能显示台名、滚动字幕、节目类型，还能自动追频**。
设计 UI 时务必把这些能力用起来，不要退化成一个只有频率数字的界面。

---

## 4. 安卓原生是怎么干的（对照样本）

设备上的 `/mnt/android_sys` 挂着原厂 Android 分区，可以直接翻：

| 组件 | 路径 | 说明 |
|---|---|---|
| FM HAL 音频源 | `/mnt/android_sys/lib/libFMHalSource.so` | `android::FMHalSource` 类 |
| 工程模式库 | `/mnt/android_sys/lib/libengfm.so` | **只导出 `fm_runcommand`** |
| JNI 桥 | `/mnt/android_sys/lib/libfmjni.so` | Java ↔ native |
| 广播服务 | `libradio.so` / `libradioservice.so` / `libradio_metadata.so` | 标准 broadcast radio HAL 栈 |
| 服务 APK | `/mnt/android_sys/priv-app/radio_interactor_service/` | 上层服务 |
| 驱动 | `/mnt/android_sys/lib/modules/marlin_fm.ko` | 与本机加载的同一份 |

### 4.1 从 `libFMHalSource.so` 读出来的音频架构

`nm -D` 显示该类持有：

- **`pcmHandle`**（tinyalsa PCM 句柄）
- `mSamplerate` / `mPeriodSize` / `mPeriodCount` / `mChannel`
- 一个后台线程 `FMHalThread::threadLoop()`
- 一个 `RingBuffer`（`GetData/PutData/GetBuf/PutBuf/BufCount`）

**结论**：安卓侧是**起线程从 PCM 读数据，经环形缓冲再交给音频输出**的一条典型音频管线。
我们自己在 Alpine 上写的 daemon，本质上要复刻这同一条链路（但可以用更简单的实现）。

### 4.2 为什么**不能直接复用**这些库

它们依赖 Android 运行时（binder、`sp<>` 智能指针、`ALooper`、`RingBuffer` 等 Android 基础设施），
在 Alpine 上**动态加载跑不起来**。只能当作**对照样本/事实来源**，不能当组件复用。

---

## 5. 我们的方案：在 Alpine 上用最少的代码替换一整套

### 5.1 设计取舍

| 决策 | 选择 | 理由 |
|---|---|---|
| 是否重写 FM 协议栈 | **否** | 芯片内已实现，我们只发命令 |
| 控制通道 | 写 FM daemon 独占 `/dev/fm` | 避免多进程竞争；与蓝牙 daemon 的做法保持一致 |
| 对外接口 | unix socket + 纯文本命令 | 完全镜像既有 `bt_user_daemon`（`/tmp/bt_ctl.sock`），团队认知成本最低 |
| 音频输出 | 优先试内部 codec 直通（`ANA_SWITCH`） | I2S 与 Over-BT 作为备选，**待实测** |
| UI 承载 | LVGL 收音机页 | 与桌面其它 App 同构 |

### 5.2 为什么"镜像 bt_user_daemon"是正确选择

蓝牙 daemon 已经是团队验证过的范式：

```
unix socket /tmp/bt_ctl.sock，文本命令，chmod 0666
    发 "state"  → 回 "OK ON" / "OK OFF"
    发 "on"     → 回 "OK ON"
    发 "off"    → 回 "OK OFF"
```

FM 照抄这套：**同样减少对莫名其妙新协议的认知负担，且 socket 超时、重连等坑已经踩过一遍**。

### 5.3 那个必须记住的坑：socket 超时

> 🔒 在 LVGL 定时器回调里做 socket I/O，**必须**设 `SO_RCVTIMEO` / `SO_SNDTIMEO`（建议 200ms）。
> 否则 daemon 一旦无响应，**整个 UI 线程冻结**。这是本项目蓝牙页已经踩过的硬教训，FM 不要再踩一次。

---

## 6. 音频通路：三种可能，必须实测选一

本机 ALSA 拓扑实测：

```
0 [alli2s]       00-00~00-03: i2s.0~i2s.3 null-codec-dai-N   playback + capture
1 [sprdphone]    01-00 HiFi sprd-codec-i2s-0                  playback + capture
                 01-01 Voice sprd-codec-vaudio-1              playback + capture
                 01-02 AuxRecord                              capture
                 01-03 AuxDSPCaptrue                          capture
                 01-04 Dfm sprd-codec-fm-4                    playback  ← FM 专用！
2 [saudiovoip]   ...
3 [saudiolte]    ...
```

对应驱动三个 ioctl：

| 路径 | ioctl | 状态 |
|---|---|---|
| 模拟/内部 codec 直通 | `ANA_SWITCH` | 默认候选 |
| I2S | `I2S_SETTING` / `GET_I2S_INFO` | 备选 |
| FM 音频走蓝牙 | `OVER_BT_ENABLE` | 语义待确认 |

**工具现状**：本机有 `libasound.so.2`，但**没有** `amixer` / `tinymix` / `aplay`
→ **不能靠命令行调 mixer，必须写 C 代码**。

**尚未确认**（不能当事实）：
1. FM 是否需要插耳机当天线（`01-04` 的存在暗示可以不插，但需实测）；
2. `OVER_BT_ENABLE` 的确切语义；
3. `SETVOL` 是 FM 模块内部增益还是主输出音量。

---

## 7. 三个字：不确定性

本 Wiki 中**尚未实测**的关键项，在正式动手前必须逐项确认（集中列在这里便于对照）：

| # | 待确认项 | 影响 |
|---|---|---|
| 1 | ioctl **命令号** | 全流程阻塞，拿不到就没法发命令 |
| 2 | 是否依赖耳机天线 | 决定 UI 是否要有"请插入耳机"态 |
| 3 | `OVER_BT_ENABLE` 语义 | 决定声道仲裁逻辑 |
| 4 | `SETVOL` 作用域 | 决定音量控制链路 |
| 5 | RSSI 原始值量纲与阈值 | 决定信号条怎么画 |
| 6 | 系统 suspend 时 FM 行为 | 决定"息屏续听"能否做 |

> 这个列表本身就是一份交付物：**把"知道不知道"讲清楚，比假装全知道更有工程价值。**

---

## 8. 排障方法论（迁移时照这个查）

1. **先分层**：①②固件上电 → ③驱动 → ④daemon → ⑤UI。任何一层不通都不要往上层猜。
2. **用节点说话**：`lsmod` / `ls /dev/fm` / `/proc/misc` / `sdio device` 四条命令判生死。
3. **ioctl 对不对看 dmesg**：驱动会打 `----<命令名>----`，这是判断命令号映射是否正确的唯一直接证据。
4. **音频不许用日志判定**：必须人耳听。
5. **UI 卡死先怀疑 socket 阻塞**：查是否设了超时。

---

## 9. 迁移到类似设备的通用清单

要把这套 FM 方案迁到另一台同类设备（展讯/Unisoc Marlin 系列），按顺序做：

1. **确认 SDIO 枚举**：`cat /sys/bus/sdio/devices/*/device`，看 device id 是否一致。
2. **确认驱动**：`lsmod | grep <fm 驱动名>`、`ls /dev/<fm 节点>`。
3. **确认共享关系**：`strings <fm驱动>.ko | grep description=`，搞清是否与 WiFi/BT 共享 SDIO。
4. **拉命令清单**：`strings <驱动>.ko | grep -- '----'`，以及 `nm <驱动>.ko | grep ' T '`。
   **再进一步——把命令号也反推出来**：`file <驱动>.ko` 看是否 `not stripped`，
   然后 `objdump -d --disassemble=<ioctl函数>`，读二分查找树里的常量。
   若驱动会打印 `----<命令名>----`，用「全零参数单步调用 + `dmesg -c` 清空取日志」逐条实测确认。
   **能自己算出来的，就不要列成"要向原厂索取"。**
5. **确认音频拓扑**：`cat /proc/asound/pcm | grep -i fm`。
6. **找 userspace 缺口**：有没有现成 FM 工具？（本机没有，需自己写 daemon）
7. **镜像既有 daemon 范式**：照抄本设备已验证成功的那个 socket daemon 的用法。
8. **重新跑一遍 §7 的六项待确认**——不同设备的答案可能不同，**不要照搬本机的结论**。

---

## 10. 这份 Wiki 想让你记住的

> **FM 是"现成的"，不是"要做的"。**
>
> 芯片里有 FM、固件里有 FM、驱动里躺着 FM、甚至 RDS 解析器都写好了——
> 我们真正要做的只有三件工程活：**把 `/dev/fm` 的操作包装成一个 daemon、把音频接到 codec 上、画一个能用 RDS 的界面**。
>
> **而"信息缺口"这件事，比想象中好解决得多。**
> 最初我们把"ioctl 命令号拿不到"列为头号硬阻塞，甚至准备去求原厂头文件。
> 最后发现：`.ko` **没被 strip**，命令号就明文躺在机器码里；
> 加上驱动会把每条命令的名字打进内核日志，**反汇编定位候选 + 全零参数单步实测**就把 47 条全部落实了。
>
> 所以第一优先级不是"去要头文件"，而是——**先看看它是不是根本不用要**。
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
