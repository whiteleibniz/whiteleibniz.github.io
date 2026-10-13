---
title: "FM收音拉起_部署交付文档"
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


# FM 收音拉起 —— 部署交付文档

> **读者对象**：接手部署/维护的工程师
> **说明**：本文档描述**目标交付态**。当前（2026-09-22）处于**设计与规划完成、尚未实装**阶段，
>  文中标注「已存在」的均为实测确认项，标注「待产出」的为本次需要新建的交付物
> **核心价值**：把"到底要交付哪些东西、放到哪里、怎么验证"一次说清

---

## 1. 链路全景（谁拉起谁）

```
开机 openrc
 │
 ├─ logdw
 ├─ download（常驻）          ← 【已存在】烧入 Marlin2 combo 固件（含 FM）
 ├─ wcnd（上电管理）          ← 【已存在】
 ├─ bt_once(BT-OPEN)          ← 【已存在】使芯片整体带电
 ├─ bt_wake.sh                ← 【已存在】周期唤醒
 ├─ bt_user_daemon            ← 【已存在】/tmp/bt_ctl.sock
 │
 ├─ fm_radio_daemon           ← 【待产出】独占 /dev/fm → /tmp/fm_ctl.sock
 │                                        ★ 唯一新增后台组件
 └─ lvgl_demo                 ← 【已存在】新增收音机页 g_radio_page → socket
```

**关键依赖**：`fm_radio_daemon` 必须排在 WiFi/上电链**之后**。
因为 FM 与 WiFi/蓝牙共享 SDIO（驱动自述 `share SDIO with BT/WIFI`），芯片没上电时一切命令都会失败。

---

## 2. 产物清单

### 2.1 设备端（已存在，实测核对 → 不要重复实施）

| 项目 | 现状 | 核对命令 |
|---|---|---|
| SDIO 枚举 | ✅ `0x2331` | `cat /sys/bus/sdio/devices/*/device` |
| FM 驱动 `marlin_fm` | ✅ 已加载 | `lsmod \| grep marlin_fm` |
| `/dev/fm` 节点 | ✅ misc 23 | `grep -w fm /proc/misc` |
| `/dev/log_radio` | ✅ misc 35 | `grep log_radio /proc/misc` |
| RDS 解析能力 | ✅ 驱动内置 | `nm /lib/modules/marlin_fm.ko \| grep rds_` |
| FM PCM | ✅ `01-04 Dfm sprd-codec-fm-4` | `cat /proc/asound/pcm \| grep -i fm` |
| Android 对照库 | ✅ `/mnt/android_sys/lib/*.so` | `ls /mnt/android_sys/lib/libfm*` |
| FM 用户态工具 | ❌ **不存在** | `ls /usr/bin \| grep fm`（无输出） |

### 2.2 待产出（本次交付物）

| 类型 | 文件 | 放置位置 |
|---|---|---|
| **头文件** | `fm_ioctl.h`（命令号已还原，可直接生成） | 设备 `/home/lvgl_demo/lvgl_demo/libs/fm/` |
| **daemon 源码** | `fm_radio_daemon.c` | 同上 + 归档 `AI工作流/03_收音机/src/` |
| **LVGL 页面** | `radio_page.c` / `radio_page.h` | 设备 `lv_pages/` + 归档 `src/` |
| **自启脚本** | `fm_radio.start` 或 openrc service | 归档 `AI工作流/03_收音机/deploy/` |
| **配置** | `/etc/fm_radio.conf`（上次频点/音量/收藏） | 设备运行时，源码附默认模板 |
| **文档** | 本文档族共 8 份 | `AI工作流/03_收音机/docs/` |

> ⚠️ 项目约定：**只收能直接部署运行的最终产物**，临时探查脚本不归档。
> 因此 `deploy/` 与 `src/` 目录**在实现产出后再填充**，当前不建空目录充数。

### 2.3 现有代码的三处改动

按 `FM收音机_LVGL界面设计与交互规格.md` §3.2：

1. `lv_pages/launcher_page.c`：include 新增
2. `lv_pages/launcher_page.c`：`s_apps[]` 数组在蓝牙项之后插入收音机
3. `lv_pages/launcher_page.c`：`open_app` switch 新增 `case LAUNCHER_APP_RADIO:`

不改动的文件：`main.c`（**注意它是本仓唯一 CRLF 文件，本次不受影响**）、
`lv_pm/lv_page_manager.h`、已打通的 WiFi/蓝牙链路。

---

## 3. 新设备部署步骤（从零）

### Step 0 底层体检（必须全绿）

```sh
cat /sys/bus/sdio/devices/*/device        # 期望 0x2331
lsmod | grep marlin_fm                    # 期望已加载
ls -l /dev/fm                             # 期望节点存在
ps | grep '[d]ownload'                    # 期望常驻
ip link show wlan0 | grep -o 'state [A-Z]*'   # 期望 UP/DORMANT
```

任一项不符 → 回到 `01_WiFi打通/docs/WiFi芯片打通操作手册.md`，**不要继续**。

### Step 1 拿到 ioctl 命令号（**已完成**）

> 结果见 [`FM收音ioctl命令表_逆向还原.md`](FM收音ioctl命令表_逆向还原.md)，可直接据此写 `fm_ioctl.h`。

按 `FM收音打通_AI指导手册.md` §8 三条路线（原厂头文件 / Android 库反推 / 受控试探），
产出 `fm_ioctl.h`。**没有这一步，后面全部无法开始。**

### Step 2 编译部署 FM daemon

```sh
scp fm_radio_daemon.c fm_ioctl.h root@<设备IP>:/tmp/
ssh root@<设备IP> 'cd /tmp && gcc -O2 -Wall -o fm_radio_daemon fm_radio_daemon.c -lpthread'
ssh root@<设备IP> 'install -m 755 /tmp/fm_radio_daemon /usr/local/bin/fm_radio_daemon'
ssh root@<设备IP> '/usr/local/bin/fm_radio_daemon > /tmp/fm_daemon.log 2>&1 &'
ssh root@<设备IP> 'ls -l /tmp/fm_ctl.sock'      # 期望 socket，权限 0666
```

### Step 3 socket 冒烟测试

```python
# 设备端 python3（本机没有 socat）
import socket, time
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(5.0)
s.connect("/tmp/fm_ctl.sock")
def cmd(c):
    s.sendall((c+"\n").encode()); time.sleep(0.2)
    return s.recv(4096).decode().strip()
for c in ["state","open","tune 97400","rssi","vol 8"]:
    print("%-12s -> %s" % (c, cmd(c)))
```

期望：`OK OFF` → `OK ON` → `OK 97400` → `OK <值>` → `OK 8`。

### Step 4 音频出声（**人耳确认，不许用日志代替**）

```sh
# 依次三条路径，每条都要实际听
#   1) ANA_SWITCH（默认候选）
#   2) I2S_SETTING
#   3) OVER_BT_ENABLE
```

同时确认：**是否需要插耳机当天线**（不插耳机 TUNE 到最强电台试听）。

### Step 5 编译部署 LVGL 收音机页

```sh
cd /home/lvgl_demo/lvgl_demo
cp /tmp/radio_page.c /tmp/radio_page.h lv_pages/
# 改 launcher_page.c 三处（见 §2.3）
make -j2 > /tmp/mk.log 2>&1; echo "MAKE_RC=$?"
grep -E 'error:' /tmp/mk.log | head -20
cp -f build/lvgl_demo /usr/local/bin/lvgl_demo && sync
killall -9 lvgl_demo; sleep 0.5
nohup /usr/local/bin/lvgl_demo > /tmp/lvgl_run.log 2>&1 &
```

> ⚠️ 判断 make 成败**不要**用 `make | tail` 的 `$?`（那是 tail 的退出码），必须 `make > log 2>&1; echo MAKE_RC=$?`。

### Step 6 开机自启

见 `FM收音芯片打通_操作手册.md` §7 的 openrc service，`depend()` 里务必声明排在 WiFi/上电链之后。

---

## 4. 验证标准（全部满足 = 部署成功）

| # | 项 | 标准 | 判据 |
|---|---|---|---|
| 1 | 底层 | SDIO/驱动/节点三连 OK | §Step 0 命令 |
| 2 | daemon | socket 四条基本命令正常 | Step 3 期望输出 |
| 3 | 调谐 | 能 TUNE 到本地已知强信号电台 | `OK <freq>` |
| 4 | **出声** | **人耳听到广播** | 不许用日志代替 |
| 5 | 搜台 | seek 能找到下一个电台；扫描有进度且可中断 | UI 现象 |
| 6 | 信号强度 | RSSI 随频点变化、有区分度 | 需先标定阈值 |
| 7 | 声道仲裁 | FM/A2DP/本地两两切换**无串音** | 人耳 |
| 8 | 后台播放 | 返回桌面不停台 | 人耳 |
| 9 | UI | 桌面图标在蓝牙之后；频点/指针/收藏显示正确 | 人眼（含图标字形，非豆腐块） |
| 10 | 自启 | 重启后自动可用 | 重启验证 |

> 其中 **4、7、9 三项必须人眼/人耳确认**——本项目排障纪律明确规定不接受"日志 OK"作为通过判据。

---

## 5. 本次交付的"已知未知"（诚实清单）

部署方接手时请先看这张表，它们是**尚未确认**的事项，不要当成既定事实：

| # | 未知项 | 为什么重要 |
|---|---|---|
| 1 | ~~ioctl 命令号~~ | **已解决**（见《FM收音ioctl命令表_逆向还原》） |
| 2 | 是否依赖耳机天线 | 决定是否要有"请插入耳机"UI 态 |
| 3 | `OVER_BT_ENABLE` 语义 | 决定仲裁逻辑 |
| 4 | `SETVOL` 是模块增益还是主音量 | 决定音量链路 |
| 5 | RSSI 原始值量纲与阈值 | 决定信号条绘制 |
| 6 | 系统 suspend 时 FM 行为 | 决定"息屏续听"可行性 |
| 7 | 是否需要 48px 大字号点阵 | 决定主频点显示效果 |

---

## 6. 一句话总结

> **三层已就绪、两层待建**。固件/驱动/设备节点全都现成，
> 本次真正要交付的是 **`fm_radio_daemon`（含 `fm_ioctl.h`）+ LVGL 收音机页 + openrc 自启** 这三样；
> 开工前置条件 **ioctl 命令号** 已自行逆向取得，**本项目当前没有阻塞项**，可直接进入实装。
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
