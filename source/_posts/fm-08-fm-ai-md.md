---
title: "FM收音打通_AI指导手册"
date: 2026-09-23 12:16:40
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
---


# 展讯 SC9832A（spd-box）FM 收音打通 —— AI 执行指导手册

> **读者对象**：AI 助手 / 工程师，需在同类设备（展讯 SC9832A + Marlin2 combo 芯片，安卓内核 + Alpine 用户态）上把 FM 收音机做起来
> **使用方式**：先读 §1–§3 建立上下文 → 按 §5 分层验证 → 按 §6 执行 → 遇故障查 §7 决策表
> **核心价值**：本文所有硬件事实均已在设备上实测取得；照着做可**跳过全部底层探查**，直接进入"写 daemon + 画 UI"阶段；§3 明确标注了不要再走的死路

---

## 1. 设备与环境速览

| 项目 | 值 |
|---|---|
| 主机名 / 内核 | `spd-box` / `Linux 3.10.65` armv7l |
| 系统组合 | 保留安卓 6.0 内核 + switchroot 到 **Alpine Linux** 用户态 |
| 无线芯片 | **展讯 Marlin2 combo WCN** —— WiFi + 蓝牙 + FM **同一颗芯片，共享 SDIO** |
| SDIO 枚举 | `sdio:c00v0000d2331`，`/sys/bus/sdio/devices/mmc2:8800:1` 的 `device=0x2331` |
| FM 内核驱动 | **`marlin_fm`（已加载）**，/lib/modules/marlin_fm.ko，17554 字节 |
| FM 设备节点 | **`/dev/fm`**（misc，`/proc/misc` 中登记为 `23 fm`）、`/dev/log_radio`（`35`） |
| 显示 | 720×1280 竖屏 framebuffer，LVGL 9.6.0 |
| SSH | `root@<设备IP>`（密码与 IP 见环境记录，勿写入文档） |
| Android 原厂分区 | 已挂载在 `/mnt/android_sys`（可作为信息源与对照样本） |

> ⚠️ 隐私红线：所有交付物中**禁止**出现 SSH 密码、账号、真实 IP，一律写 `<设备IP>` / `<密码>` 占位符。

---

## 2. 已确认的硬事实（无需重新探查，直接信任）

> 以下每一条都注明了获取方式，**标 ✅ 的是实测结论，可直接当作设计依据**。

### 2.1 芯片与资源共享（最关键的一条）

1. ✅ **FM 与 WiFi/蓝牙共享 SDIO，同属一颗 Marlin2 芯片**。
   证据一：SDIO 总线上只有**一个**设备，modalias 为 `sdio:c00v0000d2331`。
   证据二：驱动模块描述原文（取自 `strings /lib/modules/marlin_fm.ko`）：
   ```
   description=SDIO radio driver for marlin2 FM Radio Receivers, share SDIO with BT/WIFI
   ```
   **这条直接决定了 FM 的可用性依赖 WiFi 上电链**（详见 §4）。

2. ✅ **FM 驱动已经加载，且 `marlin_fm` 被 `sprdwl` 依赖**（`lsmod` 显示 `marlin_fm 17554 1 sprdwl`）。
   说明它不是孤立模块，卸载/重载要注意 WiFi 的依赖关系。

3. ✅ **`/dev/fm` 已经存在且已注册**（`/proc/misc` 第 23 项），**不需要重新 insmod 或 mknod**。

### 2.2 驱动能力清单（来自 `strings marlin_fm.ko` 的调试输出）

驱动为每个 ioctl 命令打印 `----<命令名>----`，据此还原出完整命令集：

| 类别 | 命令 |
|---|---|
| **基础控制** | `TUNE`、`TUNE_NEW`、`SEEK`、`SEEK_NEW`、`MUTE`、`SETVOL`、`GETVOL`、`IS_FM_POWERED_UP` |
| **扫描** | `SCAN`、`SCAN_NEW`、`STOP_SCAN`、`SCAN_GETRSSI`、`PRE_SEARCH`、`RESTORE_SEARCH` |
| **信号** | `GETRSSI`、`GETMONOSTERO`、`SETMONOSTERO`、`SOFT_MUTE_TUNE`、`DESENSE_CHECK`、`IS_DESE_CHAN`、`CQI_GET`、`FULL_CQI_LOG` |
| **音频路径** | `ANA_SWITCH`、`I2S_SETTING`、`GET_I2S_INFO`、`GET_AUDIO_INFO`、`OVER_BT_ENABLE` |
| **RDS** | `RDS_SUPPORT`、`RDS_ONOFF`、`RDS_GROUPCNT`、`RDS_BC_RST` |
| **芯片信息** | `GETCHIPID`、`GET_HW_INFO`、`GETCAPARRAY`、`GETCURPAMD`、`GETGOODBCNT`、`GETBADBNT`、`GETBLERRATIO` |
| **调试/量产** | `RW_REG`、`TOP_RDWR`、`HOST_RDWR`、`DUMP_REG`、`EM_TEST`、`SIM_DATA`、`GET_LOG` |

> ⚠️ **诚实标注**：上表命令**名**来自驱动内部的调试打印字符串，可确信这些命令分支真实存在；
> **命令号已于 2026-09-22 全部逆向还原并实测确认**，见 [`FM收音ioctl命令表_逆向还原.md`](FM收音ioctl命令表_逆向还原.md)：
> 统一编码 `_IOWR(0xF5, nr, 4)` = `0xC004F500 | nr`，47 条中 45 条已由设备实测确认。
> 本节的分类表保留作功能视角，**具体数字一律查那份文档**，不要凭猜。

### 2.3 RDS 能力（来自 `nm marlin_fm.ko` 的函数符号）

驱动内含完整 RDS 解析器，**这是本项目 FM 功能的最大价值点**：

| 函数 | 含义 | UI 用途 |
|---|---|---|
| `rds_get_ps` | Program Service，**电台名 8 字符** | 主频点下显示台名 |
| `rds_get_rt` | Radio Text，**电台文本 64 字符** | 滚动字幕 |
| `rds_get_pty` | Program Type 节目类型 | 小标签（新闻/音乐/交通） |
| `rds_get_af` / `rds_get_af_method` | Alternative Frequency 备用频率 | 自动切强信号同台频率 |
| `rds_get_pi_code` | Programme Identification | 台标识 |
| `rds_get_tp_ta` | Traffic Program / Announcement | 交通广播标 |
| `rds_get_ct` | Clock Time 电台时钟 | 状态栏时间可选源 |
| `rds_get_di_ms` | Decoder ID / Music-Speech | 立体声/语音标 |
| `rds_get_ews` | Emergency Warning System | 紧急广播（有合规意义） |
| `rds_get_ptyn` / `rds_get_pin` / `rds_get_slc` | 节目类型名 / 条目号 / SLC | 扩展字段 |
| `rds_get_oda` / `rds_get_oda_aid` / `rds_get_tdc` | 开放数据应用 | 扩展字段 |
| `rds_get_eon` / `rds_get_eon_ta` | Enhanced Other Networks | 跨台信息 |
| `rds_parser` / `rds_parser_init` / `fm_read_rds_data` | 解析器主体 | — |

其他确认存在的函数符号：`fm_open`、`fm_ioctl`、`fm_read`、`fm_write`、`fm_tune`、`fm_seek`、`fm_getrssi`、`fm_mute`、`fm_powerup`、`fm_powerdown`、`fm_rds_onoff`、`fm_sdio_read`、`fm_sdio_write`、`receive_tasklet`、`fm_suspend`、`fm_resume`、`parse_at_fm_cmd`、`parse_at_fm_num`。

### 2.4 音频现状（决定了声道仲裁的设计）

| 事实 | 现状 |
|---|---|
| ALSA 声卡 | `0 [alli2s]` / `1 [sprdphone]` / `2 [saudiovoip]` / `3 [saudiolte]` |
| **FM 专用 PCM** | **`01-04: Dfm sprd-codec-fm-4`，仅 playback**（无对应 capture 节点） |
| 其他 PCM | card 0 有四路 `i2s.x null-codec-dai-x`，**均同时支持 playback + capture** |
| ALSA 用户态库 | ✅ 有 `libasound.so.2`（可写 C 直接操作 PCM 与 mixer） |
| ALSA **命令行工具** | ❌ 无 `amixer` / `tinymix` / `aplay` / `alsamixer` —— **必须写代码，不能用 shell 调 mixer** |

> 推论：FM 音频既有可能走内部 codec 直通（对应 `01-04`），也有可能经某路 I2S 进入 codec。
> **`ANA_SWITCH` 与 `I2S_SETTING` 二选一的取舍，必须实测后才能定**（见 §8 待办第 2 条）。

### 2.5 既有上电链（FM 必须挂靠其上）

蓝牙/WiFi 已固化的链路（`01_WiFi打通` / `02_蓝牙打通` 文档记录）：

```
logdw → download(常驻) → wcnd → bt_once(BT-OPEN) → bt_wake.sh(btwrite) → bt_user_daemon(socket)
```

其中 `download` 一次把 combo 固件（含 FM 部分）烧入芯片。

---

## 3. 已验证死路（不要重试，浪费轮次）

| 路线 | 结果 | 原因 |
|---|---|---|
| 在设备上找 `marlin_fm` 的**驱动源码** | ❌ 没有 | `/tmp/linux-3.10.65` 是 **vanilla 内核树**，只有 `wl128x`、`sf16fmr2` 等通用 radio 驱动，**没有**展讯私有 FM 源码；不要指望在设备上读到 `fm.h` |
| 找现成的 FM 用户态守护进程/命令行工具 | ❌ 没有 | `ls /usr/bin /usr/sbin /bin /sbin \| grep fm` 无输出，全盘也没找到 FM 可执行文件。**必须自己写 daemon** |
| 用 `amixer`/`tinymix` 切音频通路 | ❌ 装都没装 | 见 §2.4，只能写代码走 ALSA lib 或直接 ioctl |
| 指望 Android 层的 FM 库直接复用 | ❌ 不能直接跑 | `/mnt/android_sys/lib/` 下有 `libFMHalSource.so`、`libengfm.so`、`libfmjni.so`、`libradio*.so`，但它们依赖 Android 运行时（binder/ALooper/`sp<>` 等），**在 Alpine 上无法直接动态加载** |
| 误以为 RDS 不存在 | ❌ 恰恰相反 | 驱动里 RDS 解析函数很完整（§2.3），是本项目 FM 的差异化价值点，别丢掉 |

> **`libengfm.so` 值得单独说一句**：它只导出一个符号 `fm_runcommand`。这暗示原厂工程模式就是以"跑命令"的方式操作 FM
> （与驱动里的 `parse_at_fm_cmd` / `parse_at_fm_num` 呼应）→ 提示 FM 控制很可能走 **AT 命令风格**，这是探查 ioctl 数字之外的第二条可行路线。

---

## 4. 系统模型：五层 + 每层验证标准

```
┌─ ① 固件层    download 已把 combo 固件烧入 Marlin2
│      验证：WiFi 可用 ⇒ FM 固件就绪
├─ ② 上电层    wcnd / BT-OPEN 使芯片整体带电；FM 共享 SDIO，无独立上电步骤
│      验证：/sys/bus/sdio/devices/mmc2:8800:1 存在，device=0x2331
├─ ③ 驱动层    marlin_fm.ko 已加载并注册 misc 设备
│      验证：lsmod | grep marlin_fm   且   ls /dev/fm   且   grep fm /proc/misc
├─ ④ daemon 层 FM daemon 独占 /dev/fm，对外暴露 unix socket（★ 本任务要新建的唯一后台组件）
│      验证：socket 收发 command 返回 OK
└─ ⑤ UI 层     LVGL 收音机页，经 socket 与 daemon 通信（★ 本任务主体）
       验证：点击可调台、可出声、返回后台不停台
```

> **分层排障铁律**：任意一层不通，**不要往上层猜**。先按 §5 自上而下逐层确认，再动手改 UI。

---

## 5. 分层验证命令（可直接复制）

```sh
# ==== ①+②+③ 一次性确认 ====
ls /dev/fm && echo "设备节点 OK"
grep -w fm /proc/misc && echo "misc 注册 OK"
lsmod | grep marlin_fm && echo "驱动已加载 OK"
cat /sys/bus/sdio/devices/*/device && echo "SDIO 枚举 OK (应为 0x2331)"

# ==== ③ 驱动描述（确认共享 SDIO 的依据）====
modinfo marlin_fm 2>/dev/null || strings /lib/modules/marlin_fm.ko | grep description=

# ==== ② WiFi 作为 FM 的前置 ====
ip link show wlan0 | grep -o 'state [A-Z]*'     # 期望 UP / DORMANT，不是 DOWN
ps | grep -c '[d]ownload'                        # 期望 >=1，download 常驻

# ==== ③ 驱动能力清单复核（无需再看 .ko）====
# 见 §2.2 / §2.3 两张表，已固化在本文中
```

```python
# ==== ④/⑤ socket 层的设备端自测（Alpine 有 python3，无 socat）====
import socket, time
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(5.0)                 # ★ 必须设超时，否则 daemon 无响应会挂死
s.connect("/tmp/fm_ctl.sock")
def cmd(c):
    s.sendall((c + "\n").encode())
    time.sleep(0.2)
    return s.recv(4096).decode()
print("state  ->", cmd("state"))
print("open   ->", cmd("open"))
print("tune   ->", cmd("tune 97400"))
print("rssi   ->", cmd("rssi"))
```

> ⚠️ 上述 socket 路径 `/tmp/fm_ctl.sock` 是**本手册规定的设计目标**，当前尚未实现。

---

## 6. 执行流程

| 步骤 | 动作 | 产出 | 完成判据 |
|---|---|---|---|
| **Step 0** | 跑 §5 全部命令，确认 ①–③ 层状态 | 探查记录 | `/dev/fm` 存在、驱动已加载、WiFi 已拉起 |
| **Step 1** | ~~探明 ioctl 命令号~~ **已完成** | [`FM收音ioctl命令表_逆向还原.md`](FM收音ioctl命令表_逆向还原.md) | 能对 `/dev/fm` 发起一次成功的 `TUNE`（命令号：`0xC004F502`） |
| **Step 2** | 写 **FM daemon**：独占 `/dev/fm`，封装 ioctl → socket | `fm_radio_daemon.c` | `state` / `open` / `tune` / `rssi` 四条命令可用 |
| **Step 3** | 写**最小探针**验证 `SCAN` 与 RSSI，标定信号强度阈值 | 标定记录 | 能拿到 ≥3 个本地电台频点及场强值 |
| **Step 4** | **确认音频路径**（`ANA_SWITCH` vs `I2S_SETTING` vs `OVER_BT_ENABLE`） | 路径决策 | 扬声器确实出声（**必须人耳确认**） |
| **Step 5** | 实现**声道仲裁**（FM / A2DP / 本地播放互斥） | 仲裁模块 | 三者两两切换无串音 |
| **Step 6** | 画 **LVGL 收音机页** | `radio_page.c` | 见 `FM收音机_LVGL界面设计与交互规格.md` |
| **Step 7** | RDS 显示 + 收藏 + 持久化 + 后台播放 | 完整 App | 见同文档 §5 功能清单 |
| **Step 8** | openrc 自启（`depends on WiFi`） | service 文件 | 重启后自动可用 |

---

## 7. 故障 → 根因 → 修复 决策表

| 现象 | 最可能根因 | 修复 |
|---|---|---|
| `open /dev/fm` 失败 ENOENT | `marlin_fm` 未加载 | `insmod /lib/modules/marlin_fm.ko`，确认 `lsmod` |
| `SDIO not enumerated` / `device` 读不到 | download 没跑或固件未下成功 | 先修 WiFi：重启 `logdw → download` 链 |
| WiFi 好但 FM 无响应 | 缺 `wcnd` 上电或芯片整体未带电 | 检查 `ps \| grep wcnd`，重跑 BT-OPEN |
| ioctl 返回 `-EINVAL` | 命令号写错，或落进了**未定义区间**（`0x14~0x16`/`0x19~0x1c`/`0x31~0x3b` 等） | 查 [`FM收音ioctl命令表_逆向还原.md`](FM收音ioctl命令表_逆向还原.md) 的结论表核对 `nr`；再用 `dmesg \| grep FM_DRV` 看是否打出了**别的**命令名 |
| ioctl 成功但**没有声音** | 音频通路未打开 | Step 4：分别在三条路径上试，用 `GET_AUDIO_INFO` / `GET_I2S_INFO` 查当前状态 |
| 有杂音/声音极小 | 音量链路不对或 `SETVOL` 非主音量 | 检查是否还需通过 ALSA mixer 单独提主输出音量 |
| RSSI 一直为 0 / 极值 | 未真正 TUNE 成功，或耳机天线未接（若设计依赖耳机） | 先核实能否正常收到单个强信号电台；再排查天线依赖 |
| seek 卡住不返回 | 驱动有 seek 超时（日志 `(fmdrv) seek Timeout(%d sec), fm seek end !`） | 上层也要设超时兜底，并给出"未找到电台"UI |
| LVGL 页面卡死 | socket I/O 阻塞了 UI 线程 | **必须**设 `SO_RCVTIMEO`/`SO_SNDTIMEO`（200ms）——本项目蓝牙页踩过的坑 |
| 重启后 FM 失效 | 自启顺序早于 WiFi/上电链 | service 里声明依赖，Step 8 依序启动 |
| FM 与蓝牙 A2DP **同时出声** | 没有做声道仲裁 | Step 5，参考 UI 规格文档 §5.4 |

---

## 8. ioctl 命令号：已解决（原头号阻塞项）

**2026-09-22 已完结。** 具体结果见 [`FM收音ioctl命令表_逆向还原.md`](FM收音ioctl命令表_逆向还原.md)。

做法概括：`marlin_fm.ko` **未 strip** → 反汇编 `fm_ioctl()` 二分查找树读出常量候选，
再用「全零参数单步调用 + `dmesg -c` 清空取日志」逐条实测确认命令名。
下面三条**历史路线**保留作方法论备忘：

| 路线 | 做法 | 评价 |
|---|---|---|
| **A. 要原厂头文件**（最省事） | 向芯片原厂/方案商索取 Marlin2 平台的 FM 用户态头文件（通常叫 `fm.h` / `sprd_fm.h`）与 libfm 库 | ✅ **首选**。有它一切明确 |
| **B. 复用 Android 侧二进制反推** | Android 分区里有 `libengfm.so`（导出 `fm_runcommand`）与 `libFMHalSource.so`。用 `nm`/`readelf` 交叉看它们调用 open/ioctl 的方式，或在 Android chroot 内 **strace** 一次原生 FM APK 的操作序列 | ⚠️ 可行但要动 chroot 环境；注意这条路是**推断**，得到数字后仍要上机验证 |
| **C. 直接 ioctl 暴力试探** | 遍历候选命令号，观察 `/dev/fm` 的返回值与 `dmesg` 里 `----<命令名>----` 的打印，看哪个号打出了哪个命令名 | ⚠️ 可行但有风险：乱发 ioctl 可能让固件状态异常。**必须在 WiFi/蓝牙不承载业务时做，且有复位手段** |

> 🔒 **纪律**：无论走哪条路线，都**先在本机/Android 侧确认，不要把错误的命令号写进 daemon 再上模拟器盲调**。

其他待办：

1. **确认是否需要耳机当天线**：本机 ALSA 有独立的 FM PCM（`01-04`），暗示可以内部直通，但**没有实测**。
   判断依据：不插耳机时 TUNE 到强信号电台，看能否出声。
2. **确认 `OVER_BT_ENABLE` 的确切语义**：是"FM 音频送给已连接蓝牙设备"，还是"允许 FM 与 BT 共存"？
3. **确认 `SETVOL` 与实际输出音量的关系**：它可能只是 FM 模块内部增益。
4. **确认系统 suspend 时 FM 是否掉台**（驱动有 `fm_suspend`/`fm_resume`）——决定"息屏续听"能否实现。

---

## 9. 红线与运维纪律

1. **禁止**SFTP 回写 `main.c` 后不核对行尾直接提交：`main.c` 是本仓库**唯一**的 CRLF 文件，回写会被转成 LF，
   导致提交里出现 1618 行"整文件重写"的假改动。提交前必查：
   `git diff --stat` 与 `git diff --ignore-cr-at-eol --stat` 两个数字应一致。
2. **禁止**在文档中写入 SSH 密码/账号/真实 IP。
3. **禁止**"看起来对就算通过"：显示/颜色/音频类结论**必须人眼/人耳在实机上确认**，不能用"截图/解码结果自洽"自证。
4. **禁止**在没有超时的情况下让 LVGL 定时器回调做 socket I/O。
5. **禁止** pkill -f 匹配会命中自身命令行的字符串（会杀掉自己的 SSH 会话），一律按 PID 杀。
6. 修改 `/dev/fm` 相关逻辑前，确认 watchdog（`lvgl_watchdog.sh`）已按规程处理，避免干扰实验。

---

## 10. 设备上已有工具清单（复用，勿重造）

| 工具 | 用途 |
|---|---|
| `python3` | socket 自测、写探查脚本 |
| `nm` / `readelf` | 分析 `.ko` 与 `.so` 符号（§2 全部事实由此取得） |
| `strings` | 从 `.ko` 提取调试串（命令名由此取得） |
| `libasound.so.2` | 写 C 操作 PCM / mixer（没有 amixer，只能写代码） |
| `/mnt/android_sys` | Android 原厂分区，`lib/` 下有 FM 相关库可作为对照样本 |
| `/tmp/linux-3.10.65` | vanilla 内核树，**不含**展讯私有 FM 源码（见 §3 死路） |

---

## 11. 后续增强方向（当前未完成）

| 方向 | 说明 |
|---|---|
| RDS 深度利用 | PTY 标签、AF 自动切频、CT 电台时钟、EWS 紧急广播（驱动能力已在 §2.3） |
| 网络电台联动 | FM + WiFi 双模，WiFi 在线时可拉取电台增强信息 |
| 录音/回放 | FM 音频经 PCM capture 落盘（需先确认有可用 capture 节点） |
| 多地区频段 | 中国 87.5–108.0 / 日本 76–90 / 欧规 50 kHz 步进 |

---

## 12. 一句话总结

> **本机 FM 的硬件、驱动、RDS 解析能力全部已经现成在跑**（`marlin_fm.ko` 已加载、`/dev/fm` 已注册、
> 且与 WiFi/蓝牙共享同一颗 Marlin2 芯片），缺的只有"中间那一层"：
> **一个把 `/dev/fm` 的 ioctl 包装成 unix socket 的 FM daemon**，以及**一个画得下的收音机页**。
> 原先卡住动手的**唯一一件事**（ioctl 命令号）已经解除（§8），
> 现在剩下的全都是按部就班的工程活：写 daemon、定音频通路、做声道仲裁、画 UI。
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
