---
title: "FM收音芯片打通_故障排查手册"
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


# 展讯 SC9832A FM 收音故障排查手册 —— spd-box

> **读者对象**：执行 FM 打通时遇到问题的工程师 / AI
> **排障铁律**：**自上而下分层定位**，不许跳层。任意一层没通就往上层猜，必然浪费时间
> **核心价值**：把"现象 → 最可能根因 → 验证命令 → 修复"串成一张决策表，5 分钟内定位到层

---

## 0. 排障纪律（先读，违反会浪费时间）

1. **先分层，后动手**。五层：①固件 ②上电 ③驱动 ④daemon ⑤UI。用 §1 速查表定位到层。
2. **显示/音频类结论必须人眼人耳确认**，不许用"日志返回 OK"代替"真的有画面/有声音"。
3. **每条路都先写一刀切的最小复现**，再谈修复。
4. **不要重复已确认的硬事实**（见 `FM收音打通_AI指导手册.md` §2），也不要重走已验证死路（§10）。

---

## 1. 分层故障速查总表（一页定位）

| 现象 | 层 | 首选验证命令 | 跳转 |
|---|---|---|---|
| `/dev/fm` 打不开（ENOENT） | ③ 驱动 | `ls /dev/fm && grep -w fm /proc/misc` | §3.1 |
| SDIO 读不到 `0x2331` | ①② 固件/上电 | `cat /sys/bus/sdio/devices/*/device` | §2.1 |
| WiFi 好，FM 无响应 | ② 上电 | `ps \| grep wcnd` | §2.2 |
| ioctl 返回 `-EINVAL` | ③ 命令号错 | `dmesg \| tail`（看有无 `----<命令名>----`） | §3.2 |
| ioctl OK 但**没声音** | ③/④ 音频通路 | `cat /proc/asound/pcm \| grep -i fm` | §4 |
| 有声音但**杂音/音量极小** | ④ 音量链路 | 比对 `GETVOL` 与实际听感 | §4.3 |
| RSSI 恒为 0 或极值 | ③/⑤ 调谐失败 | 针对已知强信号电台做单点 TUNE | §5.1 |
| seek 不返回 / 卡住 | ③ 驱动超时 | `dmesg \| grep 'seek Timeout'` | §5.2 |
| **LVGL 页面卡死** | ⑤ socket 阻塞 | 检查是否设了 `SO_RCVTIMEO` | §6.1 |
| FM 与蓝牙**同时出声** | ⑤ 缺仲裁 | 检查音频焦点模块 | §6.3 |
| 重启后 FM 失效 | 自启顺序 | `rc-service fm-radio status` | §7.1 |
| 息屏/后台**掉台** | ③ PM 挂起 | `dmesg \| grep -i suspend` | §7.3 |

---

## 2. 固件 / 上电层（①②）

### 2.1 SDIO 读不到 / `device` 不等于 `0x2331`

```sh
cat /sys/bus/sdio/devices/*/modalias   # 期望 sdio:c00v0000d2331
cat /sys/bus/sdio/devices/*/device     # 期望 0x2331
```

- **根因**：`download` 没跑起来或固件未烧入 → combo 芯片整体未在线，**FM 当然也不存在**。
- **修复**：先按 `01_WiFi打通` 文档把 WiFi 拉起来。`download` 必须**常驻**，不要杀。
- **备注**：SDIO 上只有这一个设备，WiFi/蓝牙/FM 三者共享它；**没有独立的"FM 枚举"**。

### 2.2 WiFi 正常但 FM 发命令无响应

```sh
ps | grep '[w]cnd'      # 期望有进程
ps | grep '[d]ownload'  # 期望常驻
```

- **根因**：缺少 wcnd 上电环节，芯片带电状态不完整（FM 部分尤其明显）。
- **修复**：补 `wcnd` + `bt_once(BT-OPEN)` 环节，参考 `02_蓝牙打通/docs/蓝牙芯片打通_操作手册.md` §3。

---

## 3. 驱动层（③）

### 3.1 `/dev/fm` 不存在

```sh
lsmod | grep marlin_fm            # 期望：marlin_fm ... Used by sprdwl
insmod /lib/modules/marlin_fm.ko
ls -l /dev/fm ; grep -w fm /proc/misc
```

- **注意**：`marlin_fm` 被 `sprdwl` 依赖（`lsmod` 里 `Used by sprdwl`），
  卸载时要一并处理依赖方，**不要对正在跑业务的 WiFi 贸然 rmmod**。
- 正常情况下这不该发生：该模块在 WiFi 打通时已经自动加载。

### 3.2 ioctl 返回 `-EINVAL` / `-ENOTTY`（**本项目头号故障**）

```sh
dmesg -c >/dev/null
# 再发一次你的 ioctl 命令
dmesg | tail -30
```

- **判断**：驱动为每个命令打 `----<命令名>----`。
  - 若发的是甲命令，`dmesg` 却打出 `/----乙----/` → **命令号映射错了**；
  - 若 `dmesg` 完全没有新打印 → **命令号根本没落到任何已知分支**。

- **修法**：查《FM收音ioctl命令表_逆向还原》的结论表核对 `nr`。命令号已全部还原，此处只剩"抄错"或"用了未定义区间"两种可能，**不再是阻塞项**。
- 🔒 **不要用暴力全量遍历**：乱发 ioctl 可能让固件进入异常状态。只做受控单步试探，并准备复位手段。

### 3.3 `dmesg` 出现 `seek Timeout(%d sec), fm seek end !`

- **这是驱动自带的 seek 超时机制**，不是 bug（字符串来自驱动源码）。
- **上层必须配套**：daemon/UI 也要有自己的超时兜底，并在超时后给出"未找到电台"提示，避免界面一直转圈。

---

## 4. 音频层（出声与否）—— 最容易"以为好了"的一层

### 4.1 ioctl 成功但没有声音

```sh
cat /proc/asound/pcm | grep -i fm
# 期望看到：01-04: Dfm sprd-codec-fm-4 : : playback 1
```

| 可能原因 | 排查 |
|---|---|
| 未选择正确的音频路径 | 依次试 `ANA_SWITCH`（默认）→ `I2S_SETTING` → `OVER_BT_ENABLE`，**每条都用耳朵确认** |
| 主输出音量没打开 | 本机没有 `amixer`，只能写代码用 `libasound.so.2` 查 mixer；`SETVOL` 可能只是 FM 模块内部增益 |
| **没插耳机而设计依赖耳机天线** | 不插耳机 TUNE 到最强电台试听；若必须插耳机，UI 要有明确提示 |
| 声道被别人占着（A2DP/本地播放） | 见 §6.3 |

> ⚠️ **不许用日志判定出声**。TUNE 返回 OK 与"听到广播"之间没有必然联系。

### 4.2 声音断续 / 有卡顿感

- 检查 `fm_suspend` / `fm_resume`：驱动实现了 dev_pm_ops，**系统挂起时 FM 很可能被一起挂起**（见 §7.3）。
- 检查 SDIO 带宽：FM 与 WiFi/蓝牙共享 SDIO，WiFi 高吞吐时可能有影响——这是共享芯片的固有特性，需实测评估。

### 4.3 音量不对 / `SETVOL` 无效

- 先确认 `GETVOL` 返回值是否随你写的值变化：
  - 变化 → FM 内部增益生效，但主输出（codec/扬声器）音量是另一条链路，需走 ALSA；
  - 不变 → 命令没成功或取值范围不对（取值范围需实测标定）。

---

## 5. 调谐 / 扫描层

### 5.1 RSSI 恒为 0 或恒定极值

```sh
# 用本地已知最强电台做单点基准
python3 - <<'EOF'
import socket,time
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); s.settimeout(5)
s.connect('/tmp/fm_ctl.sock')
def cmd(c):
    s.sendall((c+"\n").encode()); time.sleep(0.3); return s.recv(4096).decode().strip()
print(cmd("tune 97400"))   # 换成你手边最强的那个频点（单位 kHz）
print(cmd("rssi"))
EOF
```

- 单点都拿不到合理值 → 回到 §3.2（命令号）或 §4（天线/通路）。
- 单点 OK 但扫描不对 → 检查 `SCAN` / `SCAN_GETRSSI` 的用法。

### 5.2 扫描很慢 / 中途停不下来

- 全频段 87.5–108.0 MHz，步进 100 kHz ≈ 205 个频点，每点要驻留测量 → 慢是**正常的**。
- UI 必须：① 显示百分比进度；② 显示已发现台数；③ 提供可点击的**停止**按钮（`STOP_SCAN`）。
- daemon 侧也要设总体超时，不能无限等。

---

## 6. 应用层（④⑤ daemon → socket → LVGL）

### 6.1 LVGL 页面卡死 / 切页无响应

- **根因**：LVGL 定时器回调里做 socket I/O，而 daemon 没响应 → UI 线程被阻塞。
- **修复（必须）**：
  ```c
  struct timeval tv = { .tv_sec = 0, .tv_usec = 200*1000 };
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
  ```
- 这与蓝牙页踩过的坑完全一致。

### 6.2 `connect /tmp/fm_ctl.sock` 失败

```sh
ls -l /tmp/fm_ctl.sock          # 期望 socket 且权限 0666
ps | grep '[f]m_radio_daemon'   # 期望进程在
tail -30 /tmp/fm_daemon.log     # 看 daemon 启动有没有报错
```

- daemon 没起来 → 手工跑一次看输出（`./fm_radio_daemon` 前台跑）。
- socket 存在但连不上 → 检查是否残留旧 socket 文件（daemon 应在启动时 `unlink` 旧套接字）。

### 6.3 FM 与蓝牙 A2DP / 本地播放**同时出声**

- **根因**：三者共用一套音频输出，没有仲裁。
- **修复**：实现音频焦点模块（见 `FM收音机_LVGL界面设计与交互规格.md` §5.4）：
  - FM 遇 A2DP → 自动 **mute（不是 close）**，A2DP 结束后询问是否恢复；
  - A2DP 遇 FM → 弹确认框，用户同意后暂停/断开 A2DP 再由 FM 接管；
  - 本地播放与 FM 互相独占。
- ⚠️ 注意 `OVER_BT_ENABLE` 的语义尚未确认（是"FM 声音送给蓝牙"还是"允许共存"），**先实测再写仲裁**。

### 6.4 返回桌面后停台 / 息屏掉台

- `onPause` 里**不许**调用 close 或 mute，只停 UI 定时器/回调。
- 播放状态由 **daemon 持有**，与页面生命周期解耦。
- 若息屏掉台：查 `fm_suspend` 是否被系统 PM 触发（见 §7.3）。

---

## 7. 系统 / 自启层

### 7.1 重启后 FM 不自动可用

```sh
rc-service fm-radio status
rc-status | grep -E 'fm-radio|download|wcnd'
```

- **头号根因**：自启顺序早于 WiFi 上电链，FM 起来时芯片还没电。
- **修复**：openrc service 的 `depend()` 里声明 `after` WiFi/上电相关服务。
  正确链：**`logdw → download → wcnd → bt_once → bt_wake → bt_user_daemon → fm_radio_daemon`**。

### 7.2 daemon 反复重启

- 检查是否是`<设备上的 watchdog>`误判；调试期间注意按 PID 杀进程，
  **不要用 `pkill -f <pattern>`**——它会匹配到承载该命令的 shell 自身，把自己的 SSH 会话杀掉。

### 7.3 息屏 / 系统挂起后 FM 掉台

```sh
dmesg | grep -i 'suspend\|resume'
```

- 驱动符号里有 `fm_suspend` / `fm_resume`（静态函数，`nm` 显示为 `t`），说明实现了 dev_pm_ops。
- 若产品要求"息屏续听"，需要额外处理（持锁或阻止 suspend）——**这项必须实测确认，不可假定**。

---

## 8. 诊断工具箱（关键节点速查）

| 目的 | 命令 |
|---|---|
| 一次性体检 | 见 `操作手册.md` §1.2 六段脚本 |
| 驱动命令名清单 | `strings /lib/modules/marlin_fm.ko \| grep -- '----' \| sed 's/.*----//;s/----//' \| sort` |
| RDS 函数清单 | `nm /lib/modules/marlin_fm.ko \| grep ' T ' \| grep rds_` |
| 共享 SDIO 的证据 | `strings /lib/modules/marlin_fm.ko \| grep description=` |
| ioctl 是否落到正确分支 | `dmesg -c >/dev/null` → 发命令 → `dmesg \| tail` 看 `----<命令名>----` |
| FM PCM 是否存在 | `cat /proc/asound/pcm \| grep -i fm` |
| socket 连通性 | 见 §6.1 的 python3 片段 |
| seek 超时日志 | `dmesg \| grep 'seek Timeout'` |

---

## 9. 还需实测定标的项（当前**不是**既定事实）

| 项 | 为什么重要 |
|---|---|
| ioctl **命令号** | 阻塞全流程 |
| 是否依赖**耳机当天线** | 决定 UI 是否要"请插入耳机"提示 |
| `OVER_BT_ENABLE` 确切语义 | 决定声道仲裁怎么写 |
| `SETVOL` 与主输出音量的关系 | 决定音量控制走哪条链路 |
| **RSSI 阈值**分界 | 决定信号条几格怎么画（不要照搬网上 dBm 值，本机返回的是驱动原始值） |
| 系统 suspend 时 FM 行为 | 决定"息屏续听"可行性 |

---

## 10. 已验证死路（不要重试）

| 路线 | 结论 |
|---|---|
| 在 `/tmp/linux-3.10.65` 找展讯 FM 源码 | ❌ 那是 vanilla 树，没有私有 FM 源码 |
| 找现成 FM 命令行工具 | ❌ 全盘没有，必须自己写 daemon |
| 用 `amixer`/`tinymix` 切通路 | ❌ 本机没装这些工具，只能写代码调 ALSA lib |
| 直接动态加载 Android 的 `libFMHalSource.so` | ❌ 依赖 Android 运行时，Alpine 下跑不起来 |

---

## 11. 红线（任何情况下）

1. 文档中**禁止**写 SSH 密码/账号/真实 IP。
2. 音频/显示结论**必须人耳人眼确认**，不接受"日志 OK"作为通过判据。
3. LVGL 内做 socket I/O **必须**设超时。
4. 杀进程**按 PID**，禁止 `pkill -f` 匹配可能命中自身命令行的串。
5. 提交前核对 `git diff --stat` 与 `git diff --ignore-cr-at-eol --stat`（`main.c` 是全仓唯一 CRLF 文件）。
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
