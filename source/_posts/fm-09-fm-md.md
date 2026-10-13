---
title: "FM收音打通_工作过程总结"
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


# 展讯 SC9832A FM 收音打通 —— 工作过程总结

> **读者对象**：需要了解"这个方案是怎么想出来的"的人（含后续接手的 AI）
> **阶段说明**：本文记录的是 **2026-09-22 的探索与设计阶段**，尚未进入实装与**声音/入耳验证**阶段
> **核心价值**：记录关键判断的依据、走了哪些弯路、以及**刻意没有做的事**——比"结论"本身更有复用价值

---

## 1. 任务背景与初始目标

WiFi 与蓝牙均已打通（同一颗 combo 芯片），现在要在同一个 LVGL demo 里**新增 FM 收音机功能**，
要求是"经典收音机 App 布局"，覆盖三块内容：**入口与图标、页面布局、功能清单**，
并按 `AI工作流/02_蓝牙打通/docs` 的文档类型产出一整套中文文档，放在 `03_收音机/docs` 下。

初始认知只有一个输入：**"本机 WiFi、蓝牙、FM 集成在同一块芯片（SDIO 枚举 0x2331）上"**。

---

## 2. 分析框架：先把"FM 能不能做"拆成五层

没有急着画界面，而是先建立一个判断能不能做的分层模型：

```
① 硬件：芯片是真的吗？        SDIO 0x2331 能枚举吗？
② 固件：FM 部分烧进去了吗？   要不要单独烧？
③ 驱动：有驱动吗？设备节点在吗？
④ daemon：有人管这个节点吗？  有没有现成工具？
⑤ UI：界面怎么画？
```

**这个分层的价值**：它让我们能在动手之前就判断出
"这是'从零造轮子'还是'把现成东西接出来'"——而答案决定了整个项目的性质和工作量。

---

## 3. 攻坚过程（按时间线）

### 阶段 A：确认硬件存在 —— SDIO 只有一个设备

```sh
cat /sys/bus/sdio/devices/*/modalias   # → sdio:c00v0000d2331
cat /sys/bus/sdio/devices/*/device     # → 0x2331
```

总线上的 SDIO 设备**只有一个**，印证了"三合一、共享 SDIO"的说法。

### 阶段 B：意外发现 —— FM 驱动早就加载了

```sh
lsmod | grep marlin_fm
# → marlin_fm  17554  1 sprdwl
```

**这是本次最重要的转折点**：原本以为 FM 是一块从没碰过的新功能，
结果发现驱动不仅存在、而且**被 WiFi 驱动 `sprdwl` 依赖**（说明加载是常态、自动的）。

紧接着：

```sh
ls -l /dev/fm            # → crw-rw---- 10, 23
grep -w fm /proc/misc    # → 23 fm
```

**设备节点已经注册好了。**

> 💡 **结论改变到这里已经很明确**：这活儿不是"打通 FM 芯片"，而是"接出一个已经在跑的功能"。

### 阶段 C：把驱动能力完整摸出来 —— 用 strings + nm 反推

因为设备上**没有厂商源码**（`/tmp/linux-3.10.65` 是 vanilla 树），只能用符号级取证：

```sh
strings /lib/modules/marlin_fm.ko | grep -- '----'     # 还原 ioctl 命令名表
nm /lib/modules/marlin_fm.ko | grep ' T '              # 还原函数符号表
strings /lib/modules/marlin_fm.ko | grep description=  # 拿到官方描述
```

三条命令拿到了全部关键事实：

1. **40+ 个命令名**（TUNE/SEEK/SCAN/GETRSSI/MUTE/SETVOL/ANA_SWITCH/I2S_SETTING/OVER_BT_ENABLE/RDS_*）
2. **完整 RDS 解析函数**（`rds_get_ps` 台名、`rds_get_rt` 文本、`rds_get_pty`、`rds_get_af` 备用频率、`rds_get_ct`、`rds_get_ews` 紧急广播…）
3. **官方描述**：`SDIO radio driver for marlin2 FM Radio Receivers, share SDIO with BT/WIFI`

最后一行是**决定性的**：它把"与 WiFi/蓝牙共享 SDIO"从推测变成了芯片厂商的正式表述，
直接支撑了后续的"固件依赖 WiFi、上电依赖既有链、自启必须排队"等一系列设计。

### 阶段 D：一个额外的线索 —— AT 命令风格

驱动里发现 `parse_at_fm_cmd` / `parse_at_fm_num`；Android 侧 `libengfm.so` **只导出一个符号 `fm_runcommand`**。

两者呼应，提示 FM 控制可能是 **AT 命令风格**（往节点写命令字符串）。
这条线索后来成了突破点：**同一套常量在 `libfmjni.so` 里以字面量存在**，
成为命令号编码的独立交叉验证（详见《FM收音ioctl命令表_逆向还原》§2.4）。

### 阶段 E：音频路由 —— 发现 FM 专用 PCM，也发现没有命令行工具

```sh
cat /proc/asound/pcm | grep -i fm
# → 01-04: Dfm sprd-codec-fm-4 : : playback 1
```

确认存在 FM 专用 PCM 设备（card 1 device 4，仅 playback）。

但同一轮发现：**没有 `amixer` / `tinymix` / `aplay`**，只有 `libasound.so.2`。
→ **结论：音频通路只能写 C 代码操作，不能靠命令行调试。这显著改变了音频层的工作方式。**

同时 Android 侧 `libFMHalSource.so` 的符号（`pcmHandle` + `FMHalThread::threadLoop` + `RingBuffer`）
揭示了安卓的音频架构：**起线程从 PCM 读 → 环形缓冲 → 输出**。我们自己的 daemon 要复刻同构逻辑。

### 阶段 F：确认"没有现成用户态"（防止重复造轮子）

```sh
ls /usr/bin /usr/sbin /bin /sbin | grep -i 'fm\|radio'   # 无输出
find / -maxdepth 4 -name '*fm*' -type f                  # 只有 .ko 和 Android 库
```

→ **必须自己写 daemon**。同时确认 Android 的 FM 库**不能直接用**（依赖 Android 运行时）。

### 阶段 G：UI 集成点 —— 照着蓝牙的模式做

读 `launcher_page.c` / `bluetooth_page.c` / `lv_page_manager.h`，确认三件事：

1. 桌面网格**顺序由 `s_apps[]` 数组决定**（不是枚举值），所以插在蓝牙项之后即可自动排到蓝牙后面；
2. 页面注册范式是 `lv_page_t g_xxx_page = { .onCreate, .onPause, .onDestroy, ... }`；
3. 页面管理器明确规定：**`onDestroy` 里必须自己清定时器/回调，但不要删 `page->root`**。
   这条直接决定了"后台播放"的设计：`onPause`/`onDestroy` 都**不能**停台。

### 阶段 H：字体约束 —— 一个容易翻车的点

查到 `lv_font_cn_16` 的真实 metrics：**`line_height = 31px，base_line = 9px`**（名义 16px）。
项目历史上已经有过"按 16px 硬编码行高导致中文被裁切"的返工。
→ **本次所有 y 坐标按 31px 网格重算**，并在文档里明确红线程（不许"视觉微调"成 16px 网格）。

---

## 4. 关键决策回顾（为什么这么做）

| 决策 | 理由 |
|---|---|
| **不重写协议栈，只写薄 daemon** | 射频/解调/RDS 全在芯片与驱动里做完了，用户态只需发命令 |
| **daemon 对外用 unix socket 文本协议** | 完全镜像已验证的 `bt_user_daemon`，团队零额外认知成本；且 socket 超时的坑已经踩过 |
| **系统性镜像蓝牙 daemon 的 socket 路径命名**（`/tmp/fm_ctl.sock`） | 一致性优先 |
| **声道仲裁列 P0** | 三者共用音频输出；不做必然串音，是用户必定踩到的问题 |
| **UI 用 RDS 数据**（PS 台名 / RT 滚动） | 驱动能力已有且是本方案差异化价值，不用就退化成"只有数字的界面" |
| **所有坐标按 31px 行高网格** | 避开本项目已有的中文裁切返工 |
| **额外增加一份界面规格文档** | 参考目录里没有 UI 类文档，但本次需求的核心就是 UI，不能套不存在的模板 |
| **把"未知项"明确列表** | 关键信息缺失时写"待确认"比假装知道更有工程价值；但**能自己算出来的就别列进未知项** |

---

## 5. 最终成果与沉淀

### 5.1 交付物

`AI工作流/03_收音机/docs/` 下 7 份文档：

| 文档 | 作用 |
|---|---|
| `FM收音机_LVGL界面设计与交互规格.md` | **核心**：入口图标 / 页面布局 / 功能清单（对应需求 ①②③） |
| `FM收音打通_AI指导手册.md` | 硬事实 + 执行流程 + 决策表，防止重复探查 |
| `FM收音芯片打通_操作手册.md` | Step-by-step 可执行命令 |
| `FM收音芯片打通_故障排查手册.md` | 分层速查表 |
| `HT0FM收音原理与移植学习Wiki.md` | 原理与迁移方法论 |
| `FM收音启动流程_安卓vsAlpine对比.md` | 安卓怎么干 vs 我们怎么干 |
| `FM收音拉起_部署交付文档.md` | 产物清单与部署步骤 |
| `FM收音打通_工作过程总结.md` | 本文 |

### 5.2 沉淀下来的硬事实（可直接复用）

- Marlin2 combo 芯片，`0x2331`，**WiFi/蓝牙/FM 共享 SDIO**（厂商描述为证）；
- `marlin_fm.ko` 已加载且被 `sprdwl` 依赖，`/dev/fm` = misc 23 已注册；
- 完整 ioctl 命令名清单 + 完整 RDS 函数清单；
- FM 专用 PCM：`01-04 Dfm sprd-codec-fm-4`（仅 playback）；
- 无 ALSA 命令行工具，只有 `libasound.so.2`；
- 无现成 FM 用户态，Android 库不可直接复用；
- `lv_font_cn_16` 行高 31px；页面 `onDestroy` 不许删 root。

---

## 6. 经验教训（可复用到其他模块）

1. **动手前先把"这是新造还是接出"判断清楚。** 一句话"FM 与 WiFi 共用芯片"里其实藏着"FM 可能已经就绪"的信息；不探查就按从零开始做，会浪费大量工作。本次靠 `lsmod` 一行命令就反转了整个项目性质。

2. **没源码不等于没信息。** `strings` + `nm` 对 `.ko` 的两刀就能还原出命令名表与函数表。比起到处找驱动源码（我们确认过设备上那份内核树是 vanilla 的，白找），这招快得多且更可靠。

3. **厂商写的 `description=` 是最好的证据。** 一句 `share SDIO with BT/WIFI` 直接定死了资源互斥与依赖关系的全部设计。找证据要优先找这种"作者自己写的话"。

4. **先找"现成工具"，再决定造不造。** 我们确认了全盘没有 FM 用户态工具，才决定写 daemon——避免了重复造轮子；同时确认了 Android 库不能直接用，避免了走弯路。

5. **不可用的工具要提前发现。** 没有 `amixer` 这件事，是在规划阶段就查出来的；如果到调试音频时才发现，会导致"以为能命令行调 mixer"的整套排障思路作废。

6. **把未知项显式列出来 —— 但要区分"真未知"和"懒得查"。**
   最初列了 6 项"待实测"，其中 **ioctl 命令号**后来被证明是**完全可自解**的：
   `.ko` 未 strip，反汇编 + 实测即可全部落实。
   教训：**"要向原厂索取"常常只是没找到取证路径**，不该这么早写进阻塞项。
   剩下 5 项（耳机天线、`OVER_BT_ENABLE` 语义、RSSI 阈值等）才是真正必须上机的。

7. **尊重既有范式。** UI 跳转用 `lv_start_activity`、daemon 用 socket 文本协议、页面用 `lv_page_t`，全部照抄既有成功方案。新模块里"创新"的部分越少，出错面越小。

---

## 7. 当前状态与下一步

**已完成**：硬件/驱动/音频/UI 集成点全线探明，设计方案与文档族产出完毕。

**原头号硬阻塞已解除**：**ioctl 命令号已全部逆向还原并实测确认**（追加阶段完成）。
命令名已知、编号未知。建议按优先级：

1. ~~向原厂索取头文件~~ → **不需要了**：已自行从 `.ko` 反汇编 + 实测取得全部 47 条命令号；
2. 从 Android 侧 `libengfm.so` / `libFMHalSource.so` 反推（配合 chroot 内 strace）；
3. 受控单步试探（看 `dmesg` 的 `----<命令名>----` 打印定位）。

命令号已到手，按 `FM收音芯片打通_操作手册.md` 的 Step 3→6 顺序推进即可，**其余环节均无障碍**。
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
