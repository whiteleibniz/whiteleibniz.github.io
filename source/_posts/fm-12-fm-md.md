---
title: "FM收音芯片打通_操作手册"
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


# 展讯 SC9832A FM 收音打通 —— 人工操作手册

> **读者对象**：在设备上实操的工程师
> **使用方式**：按顺序 Step 0 → Step 6 执行；每步都有"期望输出"，不符就停下查 `FM收音芯片打通_故障排查手册.md`
> **核心价值**：把 AI 指导手册里的判断变成可一条条敲的命令，保证不同人做出来的结果一致

---

## 0. 前置概念（30 秒建立直觉）

**FM 收音机在本机上不是"新加一个硬件"，而是"把一颗已经能用的芯片上的第三个功能接出来"。**

- Marlin2 是一颗 **WiFi + 蓝牙 + FM 三合一**芯片，三者**共享 SDIO 总线**。
- WiFi 打通时，`download` 已经把**包含 FM 部分在内的整套 combo 固件**烧进芯片了 → **不需要再给 FM 烧固件**。
- `marlin_fm.ko` 驱动**已经加载**，`/dev/fm` 节点**已经存在**。
- 所以我们**不用碰固件和驱动**，只需要写一层用户态 daemon 去操作 `/dev/fm`，再画一个 UI。

```
已就绪（不要重复做）            本手册要做的（Step 3 起）
─────────────────────          ─────────────────────────
✓ SDIO 枚举 0x2331              ✓ 探明 ioctl 命令号（47 条，见《FM收音ioctl命令表_逆向还原》）
✓ combo 固件已烧入              □ 写 FM daemon（socket 封装）
✓ marlin_fm.ko 已加载           □ 确认音频通路并出声
✓ /dev/fm 已注册                □ LVGL 收音机页
✓ RDS 解析能力已具备            □ 声道仲裁 + 后台播放
```

---

## 1. 环境准备

### 1.1 设备状态确认

```sh
# SSH 登录（IP 与密码见环境记录，勿写进交付物）
ssh root@<设备IP>

# 确认内核与主机名
uname -a                 # 期望：Linux 3.10.65  armv7l
hostname                 # 期望：spd-box
```

### 1.2 一键状态体检

```sh
echo '--- 1. SDIO 是否枚举 ---'
cat /sys/bus/sdio/devices/*/device          # 期望：0x2331

echo '--- 2. FM 驱动是否加载 ---'
lsmod | grep marlin_fm                      # 期望：marlin_fm ... Used by sprdwl

echo '--- 3. FM 设备节点 ---'
ls -l /dev/fm                               # 期望：crw-rw---- ... 10, 23
grep -w fm /proc/misc                       # 期望： 23 fm

echo '--- 4. Android 分区（对照样本）---'
ls /mnt/android_sys/lib/libengfm.so         # 期望：文件存在

echo '--- 5. WiFi（FM 的前置）---'
ps | grep '[d]ownload' | head -2            # 期望：至少 1 行常驻
ip link show wlan0 | grep -o 'state [A-Z]*' # 期望：UP 或 DORMANT

echo '--- 6. 音频环境 ---'
cat /proc/asound/pcm | grep -i fm           # 期望：01-04: Dfm sprd-codec-fm-4
ls /usr/lib/libasound.so.2                  # 期望：文件存在
command -v amixer                           # 期望：无输出（本机没有 amixer）
```

> ⚠️ 若第 1–3 项有缺失，说明**底层还没就绪**，先按 `01_WiFi打通/docs/WiFi芯片打通操作手册.md` 把 WiFi 拉起来，
> 不要在这里硬做 FM——因为 FM 依赖同一份 combo 固件。

---

## 2. Step 1：提取驱动能力清单（已固化，可不跑）

```sh
# 命令名清单（AI 指导手册 §2.2 的来源）
strings /lib/modules/marlin_fm.ko | grep -- '----' | sed 's/.*----//;s/----//' | sort

# RDS 函数清单（AI 指导手册 §2.3 的来源）
nm /lib/modules/marlin_fm.ko | grep ' T ' | grep rds_

# 核心控制函数
nm /lib/modules/marlin_fm.ko | grep -E ' T fm_'

# 确认与 WiFi/BT 共享 SDIO 的官方描述
strings /lib/modules/marlin_fm.ko | grep description=
```

期望：得到 TUNE / SEEK / SCAN / GETRSSI / MUTE / SETVOL / ANA_SWITCH / I2S_SETTING / OVER_BT_ENABLE / RDS_* 等命令名，
以及 `rds_get_ps` / `rds_get_rt` / `rds_get_pty` / `rds_get_af` 等 RDS 函数。

> **注意**：这一步只拿到**命令名**。命令号见 Step 2，**已在本项目完成**，
> 结果直接查 [`FM收音ioctl命令表_逆向还原.md`](FM收音ioctl命令表_逆向还原.md)。

---

## 3. Step 2：拿到 ioctl 命令号 —— **已完成**（原头号阻塞项）

> 结果见 [`FM收音ioctl命令表_逆向还原.md`](FM收音ioctl命令表_逆向还原.md)：统一编码 `_IOWR(0xF5, nr, 4)` = `0xC004F500 | nr`，
> 47 条中 45 条已实测确认。**下面的内容保留为方法论记录**（换别的外设时可复用）。

三种手段，按推荐度：

### 路线 A（首选）：向原厂/方案商索取头文件

索取目标：Marlin2 平台的 FM 用户态头文件（`fm.h` / `sprd_fm.h`）与配套 lib。拿到后跳到 Step 3。

### 路线 B：从 Android 侧二进制反推

```sh
# 看 engfm 导出了什么（已知只有 fm_runcommand）
nm -D --defined-only /mnt/android_sys/lib/libengfm.so

# 看 FM HAL 用了哪些 pcm / 线程结构（推断音频架构）
nm -D --defined-only /mnt/android_sys/lib/libFMHalSource.so | grep -i 'read\|start\|stop\|pcm'

# 进阶：在 Android chroot 内对原生 FM APK 做一次 strace（如环境具备）
# 目标：抓出 open("/dev/fm") 之后紧跟的一组 ioctl(fd, CMD, ...) 的第一个参数值
```

> ⚠️ 这条路得到的是**推断值**，必须再上真机用 Step 3 的探针验证：发对了才能在 `dmesg` 看到对应的 `----<命令名>----` 打印。

### 路线 C：受控试探

```sh
# 建议做法：写一个小 C 程序，按候选编号逐个 ioctl，观察返回值与内核打印
dmesg -c > /dev/null                 # 先清空，便于观察新日志
./fm_probe                           # 你的试探程序
dmesg | tail -40                     # 看是否出现 ----TUNE---- 之类打印
```

> 🔒 **铁律**：
> 1. 试探前确保 WiFi/蓝牙**不承载业务**（乱发 ioctl 可能导致固件状态异常）；
> 2. 每次只试探一个编号，不要循环狂发；
> 3. 异常立即 `rmmod`/`insmod` 复位 `marlin_fm`（注意它被 `sprdwl` 依赖，需一并处理）。

**产出物**：`fm_ioctl.h`，内含全部命令号与数据结构。这是后续所有工作的输入。

---

## 4. Step 3：编译并部署 FM daemon

```sh
# 上传源码（从本机到设备）
scp fm_radio_daemon.c root@<设备IP>:/tmp/
scp fm_ioctl.h        root@<设备IP>:/tmp/

# 设备端编译
cd /tmp
gcc -O2 -Wall -o fm_radio_daemon fm_radio_daemon.c -lpthread

# 单实例启动（先手动验证，不自启）
pkill -x fm_radio_daemon 2>/dev/null; sleep 0.3
./fm_radio_daemon > /tmp/fm_daemon.log 2>&1 &
sleep 1
ls -l /tmp/fm_ctl.sock        # 期望：srwxrwxrwx socket
```

### 4.1 socket 自测（设备端 python3，本机没有 socat）

```python
import socket, time
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(5.0)                       # ★ 必须设超时
s.connect("/tmp/fm_ctl.sock")
def cmd(c):
    s.sendall((c + "\n").encode()); time.sleep(0.2)
    return s.recv(4096).decode().strip()
for c in ["state", "open", "tune 97400", "rssi", "vol 8"]:
    print("%-12s -> %s" % (c, cmd(c)))
```

期望：`OK OFF` → `OK ON` → `OK 97400` → `OK <rssi值>` → `OK 8`。

---

## 5. Step 4：确认音频通路（必须人耳确认）

```sh
# 先查当前音频状态（若 daemon 已封装）
python3 -c "
import socket,time
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); s.settimeout(5)
s.connect('/tmp/fm_ctl.sock')
s.sendall(b'audioinfo\n'); time.sleep(0.3); print(s.recv(4096).decode())
"
```

按三条路径依次试，**每条都要用耳朵确认是否出声**：

| # | 路径 | 对应 ioctl | 适用 |
|---|---|---|---|
| 1 | 模拟/内部 codec 直通 | `ANA_SWITCH` | 扬声器直出（默认候选） |
| 2 | I2S | `I2S_SETTING` / `GET_I2S_INFO` | 需外挂 codec 时用 |
| 3 | Over BT | `OVER_BT_ENABLE` | FM 声音从蓝牙设备出 |

```sh
# ALSA 侧参照（本机没有 amixer，只能看节点）
cat /proc/asound/pcm | grep -i fm       # 01-04: Dfm sprd-codec-fm-4（仅 playback）
cat /proc/asound/pcm | grep i2s         # card0 四路 i2s.x 双向
```

> ⚠️ **这块不许凭日志判断是否成功**：
> - TUNE 成功返回 OK **不等于**有声音；
> - 必须实际听。建议先盯住本地最强的那个电台做基准测试。
> - 同时确认**要不要插耳机当天线**：不插耳机 TUNE 到强信号，若能出声则不依赖耳机。

---

## 6. Step 5：部署 LVGL 收音机页

```sh
cd /home/lvgl_demo/lvgl_demo

# 1) 新增文件
#    lv_pages/radio_page.c
#    lv_pages/radio_page.h

# 2) 修改 launcher_page.c 三处（详见《FM收音机_LVGL界面设计与交互规格.md》§3.2）
#    a) include          : #include "lv_pages/radio_page.h"
#    b) s_apps[] 数组     : 在蓝牙条目之后插入收音机项
#    c) open_app switch  : case LAUNCHER_APP_RADIO: lv_start_activity(&g_radio_page, ...)

# 3) 编译部署
make -j2 > /tmp/mk.log 2>&1; echo "MAKE_RC=$?"
grep -E 'error:' /tmp/mk.log | head -20

cp -f build/lvgl_demo /usr/local/bin/lvgl_demo && sync
killall -9 lvgl_demo; sleep 0.5
cd /home/lvgl_demo/lvgl_demo && nohup /usr/local/bin/lvgl_demo > /tmp/lvgl_run.log 2>&1 &
```

> ⚠️ **编译成败不要靠 `make | tail` 的 `$?`**（那是 tail 的退出码），必须 `make > log 2>&1; echo MAKE_RC=$?`。
> 另：`extern/miniretro/` 无 Makefile，用 `sh build.sh`（与本任务无关，别顺手误触）。

---

## 7. Step 6：开机自启（openrc）

```sh
cat > /etc/init.d/fm-radio <<'EOF'
#!/sbin/openrc-run
# FM 收音 daemon —— 必须晚于 WiFi 上电链
depend() {
    need localmount
    after bootmisc
    # ★ 关键：必须在 download/wcnd 之后，否则芯片未上电
}
start() {
    ebegin "Starting FM radio daemon"
    start-stop-daemon --start --background \
        --exec /usr/local/bin/fm_radio_daemon \
        --make-pidfile --pidfile /run/fm_radio.pid
    eend $?
}
stop() {
    ebegin "Stopping FM radio daemon"
    start-stop-daemon --stop --pidfile /run/fm_radio.pid
    eend $?
}
EOF

chmod +x /etc/init.d/fm-radio
rc-update add fm-radio default
rc-service fm-radio start
```

> ⚠️ 自启顺序是本衔接最容易翻车的地方：`download → wcnd → bt_once → bt_wake → bt_user_daemon → fm_radio_daemon`。
> 若重启后 FM 失效，先查是不是起得太早（芯片还没上电）。

---

## 8. 常用节点与参数速查

| 项目 | 值 |
|---|---|
| SDIO modalias | `sdio:c00v0000d2331` |
| SDIO 路径 | `/sys/bus/sdio/devices/mmc2:8800:1` |
| 驱动模块 | `/lib/modules/marlin_fm.ko`（`Used by sprdwl`） |
| 控制节点 | `/dev/fm`（misc 23） |
| 日志节点 | `/dev/log_radio`（misc 35） |
| FM PCM | `hw:1,4` = `01-04 Dfm sprd-codec-fm-4`（playback） |
| I2S PCM | card0 `i2s.0`~`i2s.3`（playback + capture） |
| daemon socket | `/tmp/fm_ctl.sock`（`chmod 0666`） |
| daemon 日志 | `/tmp/fm_daemon.log` |
| Android 对照库 | `/mnt/android_sys/lib/{libengfm,libFMHalSource,libfmjni}.so` |
| RDS 主要字段 | PS(8 字台名) / RT(64 字文本) / PTY / AF / CT / EWS |

---

## 9. 一句话总结

> 底层（①固件 ②上电 ③驱动）**全是现成的**，命令号也已逆向还原完毕（§3 / 另见《FM收音ioctl命令表_逆向还原》）。
> **本项目已无阻塞项**，从 Step 3 起按部就班推进即可。
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
