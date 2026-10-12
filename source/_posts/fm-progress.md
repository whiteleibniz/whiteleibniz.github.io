---
title: "FM收音机_进度快照_20260922"
date: 2026-09-22 23:28:06
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
---


# FM 收音机 —— 进度快照（2026-09-22）

> 范围：展讯 SC9832A / Alpine Linux / armv7l / 720×1280 竖屏 / LVGL 9.6.0
> 本文只讲**具体实现到什么程度**：哪些能跑、哪些已验收、哪些被实测否掉、还剩什么。

---

## 一、一句话结论

**FM 应用层已经做完并跑通：daemon + 收音机页面 + 桌面入口 + 开机自启，全链路可复现、可截图验收。**
**唯一无法在用户态解决的是「出声」** —— FM 音频在硬件上只流向 FM 芯片自己的模拟输出，
既不进整机 codec，也不进主机 capture，因此**既不能外放、也不能数字化后喂给蓝牙**。

---

## 二、已完成并验收（全部为设备实测）

### 2.1 FM daemon —— 完成度 100%（本机可用的命令）

设备端 `/usr/local/bin/fm_user_daemon`（19784 B），开机自启，单实例，常驻。

| 能力 | 实现方式 | 实测结果 |
|---|---|---|
| 打开 FM 通道 | 连 abstract unix socket `@wcnd` → 发 `wcn FM-OPEN` → **连接长期保持** | `wcn FM-OPEN -> WCNBTWIFI-CMD OK` |
| `/dev/fm` 句柄 | **常开不关**（close 会触发 `fm_release` → 发 `at+fm=12` 阻塞 ~4 s） | 一直持有 |
| 通道自愈 | 5 s 周期看门狗，通道掉了自动重开 | 已实现 |
| 控制协议 | unix socket `/tmp/fm_ctl.sock`，文本单行命令 | 见下表 |
| 命令超时保护 | `SO_SNDTIMEO/SO_RCVTIMEO`，回写用 `MSG_NOSIGNAL` + `SIGPIPE` 忽略 | 已修（见 §3.3） |

**协议与实测回执**：

```
state          -> OK off freq=97400 vol=5 mute=0 chipid=0x2341 rds=1
chipid         -> OK chipid 0x2341
rds            -> OK rds 1
on / off       -> OK on / OK off
tune 97400     -> OK tune 97400
vol 12         -> OK vol 12
mute 0         -> OK mute 0
ana 1          -> OK ana 1
rssi           -> OK rssi 123 rc=-1        ← 见 §4.2，此值不可用
```

`chipid=0x2341`、`rds=1` 是由芯片真实读回的值，证明整条 SDIO 通道是活的。

### 2.2 LVGL 收音机页面 —— 完成度 100%（8 分区全部正确渲染）

设备端 `lv_pages/radio_page.c`（34287 B）。**已用截图逐区人工校对通过**。

```
┌─ A 标题栏   返回 | 收音机 | 开/关 | 状态文字（收听中 / 已关闭）
├─ B 信息条   FM 87.5-108.0 MHz  100 kHz  RDS 可用  芯片 2341
├─ C 当前频点 97.4 MHz（montserrat_48）+ 台名行（无台名/RDS 未解析）
├─ D 刻度尺   88 92 96 100 104 108 六个标签 + 5 个收藏红方块 + 当前频点指针
├─ E 信号     条形图 + 「原始 N」 + 「正在收听 当前 97.4 MHz」
├─ F 控制区   -0.1 | ◀◀ | 静音 | ▶▶ | +0.1
├─ G 收藏列表 收藏频道 (5/16) + 收藏当前 + 每项「删除」
└─ H 音量     音量 12/15 滑块 + 音频通路状态 + 切换音频通路
```

**关键工程点（都踩过坑并已修）**：

1. **UI 线程绝不做 socket I/O** —— 独立 IO 线程 `rp_io_worker()` 跑阻塞命令，
   LVGL 定时器 `rp_poll_cb()`（700 ms）只做加锁 memcpy + 刷新控件。
   理由：`rssi` 单次要 4 s，直接在 UI 线程调用会卡死界面。
2. **刻度尺宽度不能问 LVGL** —— `lv_obj_get_width()` 在 `onCreate` 阶段返回缓存 `coords`（= 0），
   被兜底成 10 后所有刻度挤在最左边。改为自缓存宽度 `rp_ruler_width()` + 兜底值。
3. **刻度指针不能挂在会被 clean 的父对象下** —— 原来挂在 `marks` 下，
   `rebuild()` 里的 `lv_obj_clean(marks)` 会连指针一起删掉。改挂 `card`。
4. **刻度两端内缩** —— 满宽映射会把 `108` 标签和 `87.5` 红方块挤出可视区。
5. **生命周期**：`onPause` **只停 UI 轮询，绝不停 FM**（回桌面要继续放音）；
   `onDestroy` 只清自有句柄，**不删 root**（由页面管理器统一删）。

### 2.3 页面进入 / 返回 —— 本次已闭环验收

```
桌面（焦点在「收音机」）── ENTER ──▶ 收音机页 ✅
收音机页 ── 返回键(ESC) ──▶ 桌面，焦点框自动回到「收音机」✅
（期间 daemon 状态不变，FM 未被打断）✅
```

截图：`shots/re_0.png`（桌面，焦点框在收音机）、`shots/re_1.png`（收音机页）、
`shots/re_on.png`（FM 上电后的收音机页）、`shots/re_after_back.png`（返回后的桌面）。

> ⚠️ **之前"进不去页面"是我自己的操作失误**，不是程序缺陷：
> 应用表里 `LAUNCHER_APP_RADIO` 插在**索引 8**（设置/网络/蓝牙/收音机/图库），
> 而**启动时的初始焦点就是索引 8 = 收音机**。我先前按 `下→右→右→右→确认` 反而把焦点移走了。
> **正确操作：桌面直接按「确认」即进收音机页。**

### 2.4 桌面入口 —— 完成度 100%

- `s_apps[]` 新增 `{ LAUNCHER_APP_RADIO, "收音机", LV_SYMBOL_VOLUME_MAX, 0xe6614f }`（第 2 行第 4 格，蓝牙之后）。
- 图标用 **`LV_SYMBOL_VOLUME_MAX`（喇叭）**。
  实测本机 `lv_font_cn_16` 的 60 个 FontAwesome 图标里**没有任何"电台/天线/电波"字形**
  （`F519/F2CE/F7C0/F8CE/F09E/F130` 全渲染成 tofu 方框），故退用喇叭。
- `launcher_open_app()` 增加 `case LAUNCHER_APP_RADIO:` → `lv_start_activity(&g_radio_page, ...)`。

### 2.5 开机自启 —— 完成度 100%，已实测验过

`/etc/local.d/zz_fm.start`（1172 B）：等 `bt_user_daemon` 最多 180 s（代表 WCN 链已就绪）→
杀旧实例 → 清 socket → `setsid` 启动 → 6 s 后回报实例数/socket/日志。
设备冷启动后实测：`fm_user_daemon` 自动起来，`chipid=0x2341 rds=1`。

---

## 三、本次修正的旧结论（重要，别再按旧的做）

### 3.1 ~~"音频类 ioctl 可以配通音频通路"~~ → **全是空壳**

`OVER_BT_ENABLE 0x1D` / `ANA_SWITCH 0x1E` / `I2S_SETTING 0x21` / `GET_I2S_INFO 0x29` / `GET_AUDIO_INFO 0x30`
在 `marlin_fm.ko` 里**只 printk 就返回**，不产生任何 SDIO 流量。

**判据（本机最硬的证据）**：清空 `dmesg` 后调用它们，驱动只打印命令名，
**完全不出现 `fm_write_buf ... at+fm=xx` 的 SDIO 收发**；
而 `POWER_UP / TUNE / GETRSSI` 会打出 `at+fm=1,9740` / `at+fm=13` 的完整收发对。

> **通用经验：判断一个 ioctl 是不是空壳，就看它有没有产生真实的下层流量，而不是看 rc。**

### 3.2 ~~"按厂商 tiny_hw.xml 开 Speaker 就能出声"~~ → **内核里不存在该路由**

DAPM 图（137 个 widget）实测拓扑不完整：

- `DACL Switch` 的 out 只有 `EAR Mixer`；`DACR Switch` **无 out**；
- **`HPL/HPR/SPKL/SPKR Mixer` 零输入（完全孤立）** → 走 speaker 物理上不可能；
- **整机唯一可达的输出终点是 `EAR`（听筒）**。

即便按真实路径把 `Earpiece Function` 等 kcontrol 打开（实测 DAC→EAR 的 in 计数 0→2，**链路是通的**），
**整机 codec 依然全 Off、`bias_level=Off`** —— 通了，但没上电。

### 3.3 ~~"daemon 稳定"~~ → **曾因 SIGPIPE 静默退出，已修**

客户端（收音机页）先断开时，daemon 里裸 `write()` 触发 SIGPIPE，
默认动作是**终止进程** → daemon 无声无息死掉。已改为 `MSG_NOSIGNAL` + `signal(SIGPIPE, SIG_IGN)`。

### 3.4 ~~"`SEEK`/`SCAN` 可用，能搜台"~~ → **SEEK 参数被截断、SCAN 是空壳**（本轮新增）

- `SEEK (0x03)` 真发 SDIO，但驱动把 u16 的起点频率**只取低字节**拼进 AT 帧
  （974 → `at+fm=4,0,206`）→ 带内频点传不进去；实测只有 **92.5 / 103.1 两个固定回值**，
  且与当前频点**无关** → 不能做"下一个电台"。
- `SCAN(0x08)` / `SCAN_NEW(0x3c)`：返回 0 但**零 SDIO 流量**。
- `write(/dev/fm, "at+fm=...")` 想绕开驱动 bug → 恒 **`EINVAL(22)`**，无 SDIO 流量。

> 详细数据见 `radio_docs/FM收音_SEEK与场强_实测结论.md`。

### 3.5 ~~"信号强度可以读到"~~ → **拿不到可信场强**（本轮新增）

`GETRSSI(0x07)` 是唯一真发 SDIO 的信号类命令，但**恒 `ETIMEDOUT` 耗时 4.2 s**，
回值在 10 个频点上几乎不变（123~125）；其余（`SCAN_GETRSSI/CQI_GET/GETMONOSTERO/…`）全是空壳；
`TUNE` 应答第 2 字段（164/139）也不是稳定指标且**驱动不回写给用户态**。
→ 收音机页已**移除假信号柱**，改为「本机不提供场强查询」。

---

## 四、阻塞项与不可行项（用户态已无解）

### 4.1 FM 出声 —— ❌ 用户态无解（结论已定）

FM 音频的三条可能出口**全部被实测排除**：

| 出口 | 实测结果 |
|---|---|
| ① FM 芯片模拟输出 → 整机 codec → 喇叭/耳机 | DAPM 路由表缺 HPL/SPKL，唯一可达终点 EAR；且整机 codec `bias_level` 恒 `Off`、`Analog/Digital Power` 全 Off |
| ② `OVER_BT_ENABLE` / `ANA_SWITCH` / `I2S_SETTING` 切通路 | **空壳 ioctl**，无 SDIO 流量（§3.1） |
| ③ 主机 capture 录音 + 数字化后喂给蓝牙 A2DP | 8 个 capture 设备**全部 `readi -5 EIO`**（card0 的 4 个连 `set_params` 都 -524 ENODEV）；`read(/dev/fm)` 只返回 688 B RDS 块，**没有 PCM** |

**根因**：FM 音频在硬件上只流向 FM 芯片自己的模拟输出 → speaker/耳机，
**没有 FM 音频通道进 AGDSP**。因此既不能出声、也不能数字化接管。

**额外确认**：FM 上电 + 打开 `Dfm`(hw:1,4) 后再录 capture（最后一种组合）依然 EIO、DAPM 依然全 Off。

**走到这一步需要**（三选一，均超出用户态）：
- (a) 动内核：补 sprd-codec 的 DAPM route / 修 stream 触发事件，让整机 codec 上电；
- (b) 拿到 BT 固件的「FM 直通」入口（HCI 厂商命令）；
- (c) 索取新版 `bt_user_daemon` 源码（当前设备上的版本**不是**本地 `ref_src/` 里那份旧版）。

### 4.2 信号强度表 —— ❌ 硬件不提供可用的查询

本次扫了 **10 个频点** + 用探针 dump 了 ioctl 回写结构体，结论：

- `GETRSSI (0x07)`：**唯一**真的会去问芯片的信号类命令。芯片对 `at+fm=13` 回一个小整数（123~125），
  驱动把它写进 arg 缓冲区的**第 1 个字节**；
  **但 ioctl 每次都固定耗时 4.2 s 后返回 `-1 / ETIMEDOUT(110)`**，
  且该值**在 10 个频点上几乎不变** → **不能当信号表用**。
- `SCAN_GETRSSI 0x24`、`CQI_GET 0x27`、`GETMONOSTERO 0x0D`、`GETGOODBCNT 0x0F`、
  `GETBADBNT 0x10`、`GETBLERRATIO 0x11`、`IS_DESE_CHAN 0x2A`：**全部是空壳**（只 printk，无 SDIO 流量）。
- `TUNE` 的芯片应答 `0,<X>,0,9740` 里第 2 字段看似与频点相关（97.4→164、87.5→139），
  但**同一频点连调两次得到 164 与 139** → 不是稳定的场强指标，且驱动**不回写该应答**给用户态。
- `RDS`：数据通路是活的（能读回 688 B 块），但实测 `blk2=blk4=180` 恒定、`The PS is`（空）
  → **当前环境下收不到有效 RDS 台名**。

> 所以 UI 上那行「原始 N（查询超时）」现在是**如实反映硬件状态**，
> 但作为"信号表"是无意义的。已在 §5 完成改造（改为固定文案 + 移除轮询）。

### 4.3 搜台（SEEK）—— ❌ 参数被驱动截断，不能做"下一个电台"

`SEEK (0x03)` **确实真发 SDIO**（`at+fm=4,<p2>,<p3>`，每次约 1.43 s，能拿到
`fm seek event have come freq=...`），但**参数是坏的**：

| 我们传的起点 freq | 驱动实际发出 | 芯片回帧 | 驱动回写的"找到频点" |
|---|---|---|---|
| 974 (97.4MHz) | `at+fm=4,0,206` | `3,139,0,9250` | **925 = 92.5MHz** |
| 875 / 1080 / 900 / 1000 | `,0,107` / `,0,56` / `,0,132` / `,0,232` | `3,139,0,9250` | **925** |
| **0** | `at+fm=4,0,0` | `3,139,0,10310` | **1031 = 103.1MHz** |

- 驱动把 u16 的 freq **只取低字节**拼进 AT 帧 → 带内频点（875~1080）**永远传不进去**；
- AT 帧第 2 个参数**恒为 0**（把 `zero/band/one/pad` 改成 1/2 都不变）；
- 结果与**当前频点无关**：先 TUNE 到 87.5 / 97.4 / 100.0 / 103.1，再 `SEEK(0)`，四次都回 103.1。

→ **SEEK 退化成"92.5 或 103.1 二选一"，不是搜台。UI 不应提供"搜台"按钮。**

补充排除的两条路：
- `SCAN(0x08)` / `SCAN_NEW(0x3c)`：返回 0 但**零 SDIO 流量**（空壳）；`STOP_SCAN(0x09)` 恒 `EINVAL(22)`。
- `write(/dev/fm, "at+fm=4,0,9740")` 想直接写 AT 文本绕开驱动 bug → 恒定 **`-1 / EINVAL(22)`**，
  dmesg 无任何 `fm_write_buf` → **驱动不接收用户态 AT 文本，此路不通**。

> 取证脚本：`ssh_tools/fm_seek_probe.c` / `fm_seek_probe2.c` / `fm_at_probe.c`（含 `_run.py`）。
> 完整数据见 `AI工作流/05_收音机/docs/FM收音_SEEK与场强_实测结论.md`。

---

## 五、未完成 / 待办（★ 2026-09-22 深夜续做后的最新状态）

### 5.1 本轮已完成 ✅

| # | 事项 | 结果 |
|---|---|---|
| 5 | `/tmp/btud_dbg.log` 加轮转 | ✅ **129.9 MB → 65 KB**，根分区 77% → 75%；装了 busybox `crond`（整点跑 `/root/log_rotate.sh`）+ 开机自启 `/etc/local.d/zz_crond.start`；实测日志继续正常增长、非稀疏文件 |
| 1 | UI 场强区改诚实文案 | ✅ 删除 5 根假信号柱，改为「场强　本机不提供场强查询」；截图 `shots/dep_1E.png` 已验收 |
| 2 | 去掉 `rssi` 无谓轮询 | ✅ 移除 `want_rssi` 逻辑（原来每次调台后白等 4.2 s）；`rssi` 命令在 daemon 侧保留供实验 |
| — | 底部"音频通路"文案 | ✅ 改为「音频输出: 本机暂不可用（无可用通路）」，并**移除**了无效果的「切换音频通路」按钮（ANA_SWITCH 是空壳，留着只误导） |
| 4 | 整机音量控制 | ✅ 优雅降级：首次探测 `tinymix` 不存在即置"不可用"，**告警只出现一次**（原来是每次拖滑块 fork 一个必然返回 127 的 shell）；实测日志 `grep -c 'Volume System'` = **1** |
| 7 | `launcher_page.c` 过期注释 | ✅ 已改正（下标 8 现在是**收音机**，不是任务管理；保持行为不变） |
| 8 | `radio_docs/` 文档 | ✅ 新增 `FM收音_SEEK与场强_实测结论.md`；在 `FM收音ioctl命令表_逆向还原.md` 顶部加了 **§0.1 重要更正**（推翻"SCAN/SCAN_GETRSSI 可画频谱""SEEK 可搜台""可写 AT 文本"三条旧结论） |

**本轮验收截图**
| 截图 | 内容 |
|---|---|
| `shots/fin_0.png` | 桌面：12 个应用图标齐全，「收音机」喇叭图标正常，**焦点框（粉色描边）就落在「收音机」上** → 直观印证 `s_apps[]` 下标 8 = 收音机 |
| `shots/dep_1E.png` / `shots/fin_1.png` | 收音机页 8 分区全部正确；「场强 本机不提供场强查询」「音频输出: 本机暂不可用（无可用通路）」，无假信号柱、无 ANA 按钮 |

**进程终态（设备实测）**
`lvgl_demo 15468` + `lvgl_watchdog 15681`；`fm_user_daemon 2491` + `fm_watchdog 20199`；
`bt_user_daemon 1222`、`wcnd 1155`、`crond 20905`（整点轮转）

### 5.2 仍未完成 / 待用户决定 ⏳

| # | 事项 | 优先级 | 说明 |
|---|---|---|---|
| A | **FM 出声** | 阻塞（需拍板） | 用户态已无解，三条路任选：(a) 动内核补 sprd-codec 的 DAPM route / 修 stream 触发；(b) 拿 BT 固件的「FM 直通」入口（HCI 厂商命令）；(c) 接受"FM 仅 UI/控制可演示，无声音" |
| B | 索取新版 `bt_user_daemon` 源码 | 中 | 若走 (b) 需要它 |
| C | 源码入库 | 中 | 按 AGENTS.md：先给文件清单 + 中文提交说明并**获用户同意**，**禁止自动提交**。清单见下 |
| D | RDS 台名 | 低 | `read(/dev/fm)` 能读 688B 块，但实测 `The PS is` 为空 → 当前环境收不到有效台名 |
| E | 整机其它 `tinymix` 依赖 | 低 | 已优雅降级；真要修需先有 codec 播放音量控件（card1 的 120 个 kcontrol 里**没有任何播放音量控件**） |

### 5.3 待入库文件清单（等用户同意后再 commit）

**设备端仓库 `/home/lvgl_demo/lvgl_demo`（git 已跟踪）**
| 文件 | 改动 |
|---|---|
| `lv_pages/radio_page.c` | 页面本体（本会话：场强区诚实化、去掉假信号柱与 rssi 轮询、底部音频输出文案、移除 ANA 按钮） |
| `lv_pages/radio_page.h` | 新增 |
| `lv_pages/launcher_page.c` | 收音机入口三处 + 过期注释改正 |
| `lv_status_bar/volume_control.c` | tinymix 缺失时优雅降级（告警只出一次） |
| `AI工作流/05_收音机/docs/FM收音_SEEK与场强_实测结论.md` | 新增 |
| `AI工作流/05_收音机/docs/FM收音ioctl命令表_逆向还原.md` | 加 §0.1 重要更正 + 脚本表补充 |

**设备端仓库外的运行期产物（是否入库请定）**
`/usr/local/bin/fm_user_daemon`、`/etc/local.d/zz_fm.start`、`/root/fm_watchdog.sh`、
`/root/log_rotate.sh`、`/etc/local.d/zz_crond.start`、`/etc/crontabs/root`

**本地工程脚本 `ssh_tools/`（是否随仓库一起提交请定）**
`fm_user_daemon.c`、`radio_deploy.py`、`build_deploy.py`、`pull_file.py`、`log_rotate_install.py`、
`fm_seek_probe.c`/`fm_seek_probe2.c`/`fm_at_probe.c`（含 `_run.py`）、`fm_tune_probe.c`（含 `_run.py`）、
`fm_live_check.py`、`fm_rssi_sweep.py`、`fm_rssi_trace.py`、`fm_sigcmd_trace.py`、`fm_any.c`、`pcm_rec.c`、`dapm_graph2.py`

---

## 六、验收命令速查

```sh
# 设备: <设备IP>   (root / <密码>，真实凭据只在运行参数里给，勿写入公开文档)

# FM 状态
python3 /root/fm_cli.py state

# 上电 / 调台 / 音量 / 静音
python3 /root/fm_cli.py on
python3 /root/fm_cli.py 'tune 97400'
python3 /root/fm_cli.py 'vol 12'
python3 /root/fm_cli.py 'mute 0'

# 看驱动真实收发（判断命令是不是空壳）
dmesg | grep -E 'FM_DRV|fm_sdio' | tail -40
```

**Windows 侧工具脚本**（`ssh_tools/`）：

| 脚本 | 用途 |
|---|---|
| `radio_enter_test.py [键序列]` | 停 watchdog → 干净重启应用 → 截图 → 按键 → 截图，并把应用日志 tail 出来 |
| `fm_live_check.py` | daemon 命令链 → 收音机页截图 → 返回键 → 桌面截图 |
| `fm_rssi_sweep.py` | 多频点 RSSI 扫描 |
| `fm_rssi_trace.py` | 抓单次 tune+RSSI 的完整 FM 驱动日志 |
| `fm_tune_probe.c` / `fm_tune_probe_run.py` | 直接 dump ioctl 回写的 32 字节结构体（判断驱动写了什么） |
| `fm_sigcmd_trace.py` | 干净 dmesg 下测试信号类命令，看是否有 SDIO 流量 |

---

## 七、下一步建议（已按本轮结果更新）

1. ~~先把磁盘救回来~~ ✅ **已完成**（129.9 MB → 65 KB，并装了整点轮转）。
2. ~~信号区改成诚实文案~~ ✅ **已完成**。
3. ~~补 `seek`/`scan`/`stopscan`~~ ❌ **已证伪，不做**：`SEEK` 参数被驱动截断、`SCAN` 是空壳，
   做了就是"假搜台"。**不要把不可靠的能力做成按钮**。
4. **出声需要用户拍板**（唯一真阻塞）：动内核补 DAPM 路由、去要新版蓝牙协议栈源码、
   还是接受"仅 UI/控制可演示"。
5. 源码入库走审批（AGENTS.md：先给清单 + 中文提交说明，**禁止自动提交**）——
   清单见 §5.3。
6. 可选小优化：把 `/root/log_rotate.sh` 的阈值（现 20 MB）与要监控的日志列表做成可配，
   方便以后加新 daemon 的日志。
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
