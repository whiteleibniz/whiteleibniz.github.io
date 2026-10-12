---
title: "HT0蓝牙拉起_部署交付文档"
date: 2026-09-21 11:47:29
search: true
categories:
- 硬件模块打通
- 蓝牙
tag:
- 蓝牙
- WCN
---


# HT0 设备蓝牙拉起 —— 部署交付文档

> 目的：回答"整个蓝牙流程到底涉及哪些脚本/程序？在新设备上怎么部署才能拉起蓝牙？"
> 内容：① 链路全景 → ② 产物清单（设备端/本机/Git）→ ③ 新设备部署步骤 → ④ 验证 → ⑤ 常见问题
> 适用：同型号设备（HT0 / 展讯 SC9832A，安卓内核 + Alpine 用户态）

---

## 1. 蓝牙链路全景（谁拉起谁）

```
开机
 ├─ /etc/local.d/wifi.start       ① 挂载安卓 system + 搭 chroot + download 烧固件 + 驱动 + wlan0
 ├─ /etc/local.d/bt_bringup.start  ② mdbg 权限 + wcnd + bt_once(BT-OPEN) + bt_wake.sh(btwrite 唤醒)
 ├─ /etc/init.d/bt_daemon          ③ 用户态 HCI daemon（openrc 自启）
 └─ LVGL 桌面                     ④ 蓝牙设置页（socket 与 daemon 通信）
```

**依赖关系**：① 是 ②③④ 的前提（download 烧的 combo 固件含蓝牙部分）；② 是 ③ 的前提（上电 + 唤醒后 HCI 才响应）。

---

## 2. 产物清单

### 2.1 设备端已部署（HT0 现状，实测核对）

| 类别 | 路径 | 说明 |
|---|---|---|
| 固件下载链 | `/tmp/logdw` | download 日志守护（安卓原版拷贝） |
| | `/tmp/aand/bin/download` | 固件下载引导器（chroot 内） |
| | `/tmp/aand/bin/wcnd` | WiFi/蓝牙上电守护（chroot 内） |
| | `/tmp/aand/etc/marlinba/*.ini` | 固件配置（含蓝牙 pskey） |
| 蓝牙上电/唤醒 | `/tmp/bt_once` | BT-OPEN 触发（源码 /tmp/bt_once.c） |
| | `/tmp/bt_wake.sh` | btwrite 周期唤醒（每 2s 写 1） |
| HCI 诊断 | `/tmp/bt_probe_full` | HCI 六步探针（源码 /tmp/bt_probe_full.c） |
| | `/tmp/hci_3m` | 3M 波特率 HCI 原始测试（早期诊断） |
| **核心服务** | `/usr/local/bin/bt_user_daemon` | **用户态 HCI daemon（生产）**，源码 `/tmp/bt_user_daemon.c` |
| 自启配置 | `/etc/local.d/wifi.start` | 开机 WiFi 链（4991B，含 chroot 搭建） |
| | `/etc/local.d/bt_bringup.start` | 开机蓝牙上电链（mdbg+wcnd+bt_once+bt_wake） |
| | `/etc/init.d/bt_daemon` | daemon openrc 自启（已 `rc-update add default`） |
| | `/etc/local.d/lvgl_demo.start` | LVGL 桌面自启（指向 /usr/local/bin/lvgl_demo） |
| | `/root/lvgl_watchdog.sh` | 桌面看门狗（挂了自动拉起） |

### 2.2 本机（Windows 工作目录 `new-chat\`）源码与部署脚本

| 文件 | 用途 |
|---|---|
| `bt_user_daemon.c` | **daemon 源码（核心交付物）**——设备 /tmp 有同副本 |
| `bt_probe_full.c` / `bt_probe_inquiry.c` | HCI 探针源码 |
| `bt_deploy_v4.py` / `bt_deploy_all.py` / `bt_full_sequence_test.py` | paramiko 一键部署/测试脚本 |
| `bt_verify_scan.py` / `bt_sock_test.py` | 扫描/socket 验证脚本 |
| `bt_ssh_wait_8h.py` / `bt_auto_resume.py` | SSH 轮询重连 |
| `bluetooth_page.c` / `bluetooth_page.h` | **LVGL 蓝牙设置页（launcher 已注册）** |
| 四份文档 | 操作手册 / 流程对比 / 工作总结 / AI 指导手册 |

### 2.3 Git 提交（设备项目 /home/lvgl_demo/lvgl_demo）

```
973e3b5 新增蓝牙设置应用：launcher 注册蓝牙图标，蓝牙页含开关/搜索/设备列表，
        通过 unix socket 与 bt_user_daemon 通信；开机脚本与看门狗统一使用 /usr/local/bin/lvgl_demo
```
涉及：`lv_pages/bluetooth_page.c`、`lv_pages/bluetooth_page.h`、`lv_pages/launcher_page.c`（3 处注册）、`shell/wifi.start`

### 2.4 Skill 封装（可移植）

`workspace\.user_skills\ht0-wcn-radio\` —— 含 SKILL.md + references（WiFi/蓝牙手册）+ scripts（wifi_bringup/bt_status/ssh_wait），任何 AI 加载后可直接操作同型设备。

---

## 3. 新设备部署步骤（从零拉起蓝牙）

> 前提：同型号设备（HT0/SC9832A）、已 switchroot Alpine、SSH root 可用、WiFi 链路能起（`/tmp/aand` 环境存在或 wifi.start 能自动搭）。

### Step 0 确认基础环境（WiFi 前提）

```sh
ssh root@<设备IP>
# 确认安卓 system 可挂载、chroot 可搭（wifi.start 自动做）
sh /etc/local.d/wifi.start 2>&1 | tail -5    # 期望: SDIO ready 0x2331 + wlan0 UP
cat /sys/bus/sdio/devices/mmc2:8800:1/device  # 0x2331
```
> 若 wifi.start 不存在：先把 `/mnt/android_sys`（mmcblk0p17）挂载，从 `wifi.start` 内容重建 chroot（见 references/wifi.md）。

### Step 1 上传并部署基础工具

```sh
# 从本机 scp 到设备 /tmp/
scp bt_once bt_wake.sh bt_probe_full logdw root@<设备IP>:/tmp/
chmod +x /tmp/bt_once /tmp/bt_wake.sh /tmp/bt_probe_full /tmp/logdw

# logdw 也可从安卓 system 拷：
# cp /mnt/android_sys/bin/logdw /tmp/logdw 2>/dev/null || cp /mnt/android_sys/bin/download_logd /tmp/logdw
```

### Step 2 编译部署 HCI daemon（核心）

```sh
# 上传源码
scp bt_user_daemon.c root@<设备IP>:/tmp/
# 设备端编译
gcc -O2 -o /usr/local/bin/bt_user_daemon /tmp/bt_user_daemon.c -lpthread
# 单实例启动
pkill -9 -x bt_user_daemon 2>/dev/null; sleep 1
setsid /usr/local/bin/bt_user_daemon >/tmp/btud.log 2>&1 </dev/null &
```
> 若设备无 gcc：本机交叉编译（armv7 静态）或从已部署设备拷贝二进制（`/usr/local/bin/bt_user_daemon` 24KB，架构一致可直接用）。

### Step 3 配置开机自启

```sh
# 3a. 蓝牙上电链脚本
cat > /etc/local.d/bt_bringup.start << 'EOF'
#!/bin/sh
# 蓝牙上电链：mdbg 权限 -> wcnd -> bt_once(BT-OPEN) -> bt_wake(btwrite)
sleep 8
chmod 666 /tmp/aand/proc/mdbg/* 2>/dev/null
chmod 666 /proc/mdbg/* 2>/dev/null
echo 0 > /proc/mdbg/wdtirq 2>/dev/null
ps -ef | grep -q '[w]cnd' || setsid chroot /tmp/aand /bin/wcnd >/tmp/wcnd_console.log 2>&1 </dev/null &
sleep 2
ps -ef | grep -q '[b]t_once' || setsid /tmp/bt_once 900 >/tmp/bt_once.log 2>&1 </dev/null &
sleep 2
ps -ef | grep -q '[b]t_wake' || setsid /bin/sh /tmp/bt_wake.sh >/dev/null 2>&1 </dev/null &
EOF
chmod +x /etc/local.d/bt_bringup.start

# 3b. daemon openrc 自启
cat > /etc/init.d/bt_daemon << 'EOF'
#!/sbin/openrc-run
command="/usr/local/bin/bt_user_daemon"
command_background=yes
pidfile="/run/bt_daemon.pid"
EOF
chmod +x /etc/init.d/bt_daemon
rc-update add bt_daemon default
rc-service bt_daemon start
```

### Step 4（可选）LVGL 蓝牙设置页

```sh
# 上传页面文件到项目
scp bluetooth_page.c bluetooth_page.h root@<设备IP>:/home/lvgl_demo/lvgl_demo/lv_pages/
# 修改 launcher_page.c 三处：include / 枚举 LAUNCHER_APP_BLUETOOTH / s_apps 数组 / open_app switch
# 编译部署（4 线程）
cd /home/lvgl_demo/lvgl_demo && make -j4
install -m 755 build/lvgl_demo /usr/local/bin/lvgl_demo
pkill -9 -x lvgl_demo; setsid /usr/local/bin/lvgl_demo >/tmp/lvgl_demo.log 2>&1 </dev/null &
```
> 若新设备没有 LVGL 项目：先部署 wifi/蓝牙底层（Step 0–3），页面是最后的应用层。

### Step 5 验证

```sh
# 分层状态
cat /sys/bus/sdio/devices/mmc2:8800:1/device          # 0x2331
grep 'CMD OK' /tmp/bt_once.log                        # WCNBTWIFI-CMD OK
ps -eo comm | grep -c '[b]t_user_daemon'              # ≥1
# socket 查询（设备端 python3）
printf 'state\n' | timeout 5 python3 -c "
import socket,sys
s=socket.socket(socket.AF_UNIX); s.connect('/tmp/bt_ctl.sock')
s.sendall(sys.stdin.buffer.read()); s.shutdown(socket.SHUT_WR)
print(s.recv(4096).decode())"                          # OK ON
# 扫描
printf 'scan 15\n' | timeout 25 python3 -c "
import socket,sys
s=socket.socket(socket.AF_UNIX); s.connect('/tmp/bt_ctl.sock')
s.sendall(sys.stdin.buffer.read()); s.shutdown(socket.SHUT_WR)
d=b''
while True:
    x=s.recv(4096)
    if not x: break
    d+=x
print(d.decode())"                                     # OK N + 设备行
```
> 也可以直接用 Skill 的脚本：`python scripts/bt_status.py --host <IP> --password <pwd> --scan 8`（本机跑，需 paramiko）。

---

## 4. 验证标准（全部满足 = 部署成功）

| # | 检查 | 期望 |
|---|---|---|
| 1 | SDIO device | `0x2331` |
| 2 | /tmp/bt_once.log | 含 `WCNBTWIFI-CMD OK` |
| 3 | btwrite | 可写（bt_wake.sh 在跑） |
| 4 | daemon 进程 | ≥1（单实例） |
| 5 | socket state | `OK ON` |
| 6 | socket scan | `OK N` + 设备行（N=0 不算失败，环境无设备） |
| 7 | LVGL 蓝牙页（如有） | 开关/搜索/列表正常 |
| 8 | 重启后 | ①②③ 全自动拉起（不用手动） |

---

## 5. 常见问题（新设备部署时最可能踩的坑）

| 现象 | 原因 | 处理 |
|---|---|---|
| `BT-OPEN FAIL` | mdbg 权限 600 | `chmod 666 /tmp/aand/proc/mdbg/*`（bt_bringup.start 已含） |
| `SDIO not enumerated` | download 环境不全 | 确认 /tmp/aand 完整（bin/lib/marlinba/节点/软链），重跑 wifi.start |
| `bind logdw failed` | /tmp/logdw 缺失 | 从 /mnt/android_sys/bin/ 拷 |
| daemon 起不来（Not a tty） | tty ldisc 被占 | `python3 -c "import fcntl; f=open('/dev/ttyS0',2); fcntl.ioctl(f,0x5421,b'\0'*4)"` |
| 扫描无结果 | 未先 Write Scan Enable | 用 daemon scan（内部已处理），勿裸发 Inquiry |
| socket connect 失败 | daemon 多实例 | `pkill -9 -x bt_user_daemon` 后单实例 |
| gcc 不存在 | Alpine 精简安装 | `apk add build-base`，或直接拷贝已部署设备的二进制 |

---

## 6. 一句话总结部署路径

```
环境就绪(wifi.start) → 传 4 个工具(bt_once/bt_wake.sh/bt_probe_full/logdw)
→ 编译部署 daemon(bt_user_daemon.c) → 两条自启(bt_bringup.start + bt_daemon)
→ 验证(0x2331 + CMD OK + socket OK ON + scan)
→ 可选: LVGL 蓝牙页(bluetooth_page.c/h + launcher 注册 + make -j4)
```

所有产物都有本机副本（`new-chat\` 目录）和 Skill 封装（`ht0-wcn-radio`），新设备部署全程可复用。


---

## 6. A2DP 真实音频播放（v1.0.3 蓝牙音箱支持版新增）

> 目的：连上蓝牙音箱后，在桌面音乐/视频应用点歌，声音直接从蓝牙音箱出（不再是演示蜂鸣音）。

### 6.1 音频链路

```
桌面点歌(music/video_page)
  → 判断蓝牙已连(AF_UNIX socket /tmp/bt_ctl.sock 发 "conn")
  → mplayer -ao pcm:nowaveheader:fast:file=/tmp/bt_audio.fifo -srate 44100 -channels 2 -format s16le
  → /tmp/bt_audio.fifo (命名管道, 512字节/帧)
  → bt_user_daemon 媒体循环读 PCM → SBC 编码(bp35/7帧/20ms)
  → A2DP → 蓝牙音箱出声
```

### 6.2 关键部署点

| 项 | 值 | 说明 |
|---|---|---|
| fifo 管道 | `/tmp/bt_audio.fifo` | 开机脚本 `bt_bringup.start` 里 `mkfifo` 创建，重启后自动存在 |
| mplayer 音频参数 | `-ao pcm:nowaveheader:fast:file=/tmp/bt_audio.fifo -srate 44100 -channels 2 -format s16le` | **必须 `-format s16le`**，否则 big-endian 导致雪花噪音 |
| 蓝牙判断 | `bt_audio_connected()` | **必须在 fork 子进程之前(父进程)调用**；写在 fork 后 dup2 重定向 stdio 的子进程里会 connect 失败，退化成 `-ao null` |
| 未连蓝牙 | 保持 `-ao null` | 不影响进度/暂停/切歌控制 |

### 6.3 排查要点

- **点歌无声**：`ps | grep mplayer` 看起的参数是 `-ao null` 还是 fifo。若是 null → `bt_audio_connected()` 在父进程判断失败，确认 daemon 在跑、socket `/tmp/bt_ctl.sock` 存在。
- **能听出旋律但全是雪花噪音**：mplayer 缺 `-format s16le`（默认 big-endian PCM，daemon 按 little-endian int16 读）。
- **切歌/暂停/退出无声异常**：确认旧 mplayer 已被杀（新起时先 pkill mplayer），fifo 没被占。
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
