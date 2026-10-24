---
title: "设备重启后 netTV 全线瘫痪：ICS 重绑与 /mnt/android_sys 挂载这两个必踩坑"
date: 2026-10-14 02:30:00
lang: zh-CN
search: true
categories:
- 排障手记
- 视频播放
tag:
- nettv
- VSP硬解
- ICS
- bionic
- 环境依赖
- 故障修复
---

# 设备重启后 netTV 全线瘫痪

## 一、现象：一次重启，三件事同时坏

展讯 SC9832A 设备因为上一次的 sshd 事故断电重启之后，想继续验证「4 帧 / 第二个 IDR 崩溃」的修复效果，结果连环境都起不来：

| 现象 | 判据 | 第一反应（错的） |
|---|---|---|
| 设备不上外网 | `curl` 返回 `000`，但 `ip route` 里 `default via 192.168.137.1` 在 | 以为频道源又挂了 |
| 播放器起不来 | `CANNOT LINK EXECUTABLE: library "libc.so" not found` | 以为二进制被改坏了 |

两条都不是真的：**源没挂，二进制也没坏**。坏的是两台机器之间的那层「共享上网」，以及设备重启后被遗忘的一个挂载点。

## 二、坑一：ICS 重绑必须「先清 IP、先私后公」

设备上网链路是 `USB RNDIS (192.168.137.x) → PC ICS NAT → PC WiFi`。PC 自己上网 200，设备 000，路由表也在——这就是标准的 **ICS 掉绑定**。

旧脚本的做法是：找到 WLAN（public）和 RNDIS（private）两个连接，`DisableSharing` 之后 `EnableSharing`。这次它直接失败：

```
EnableSharing(0) → COMException 0x80040201
```

更坑的是补救动作：手工用 `New-NetIPAddress` 给 RNDIS 网卡设上 `192.168.137.1/24`，地址确实出现了，ping 设备也通，但设备照样上不了网。因为 **ICS 不认这个手工地址**——它接管网卡时会自己重新配置，手工地址会被顶掉，网卡退化成 **APIPA 169.254.x**，NAT 表压根没建立。

正确顺序（已固化成脚本）：

```powershell
# 1. 找到 public(WLAN/Intel 9462) 与 private(USB RNDIS Adapter)
# 2. 两边 DisableSharing()
# 3. ★ 把 private 网卡上【所有】IPv4 地址删干净 —— 留任何一个 ICS 都不重配
# 4. private.EnableSharing(1)   ← 先私
# 5. public.EnableSharing(0)    ← 后公
# 6. 等 10s，ICS 自行把 private 配成 192.168.137.1/24
```

验证点只有一个：`Get-NetIPAddress -InterfaceAlias 以太网` 里出现 `192.168.137.1`。出现即通，不出现就是没成，别拿 ping 通当判据。

**教训**：Windows ICS 的私有侧地址必须由 ICS 自己创建。你替它设好的地址，它不认，还会把网卡甩到 169.254 去。

## 三、坑二：bionic 运行环境依赖 /mnt/android_sys 挂载

ICS 修好后兴冲冲跑播放器，结果：

```
WARNING: linker: /usr/local/bin/nettv_player: unused DT entry: type 0x1d
CANNOT LINK EXECUTABLE: library "libc.so" not found
```

`/system/lib/libc.so` 明明存在——但它是个软链：

```
/system/lib/libc.so -> /mnt/android_sys/lib/libc.so
```

而 `/mnt/android_sys` 是 **`/dev/mmcblk0p17`（ext4 只读）的挂载点**，重启之后没人挂它，于是 `/system/lib` 下几百个 `.so` 软链全部悬空。

为什么重启后没人挂？因为挂载点全被历史改动拆掉了：

- `01_wifi.start` —— 早已 disabled
- `01_mali.start` —— 为了「Mali 去脚本化」已删
- `wifi_bringup.c:296` —— 只在用户打开 WiFi 开关时才挂
- `gpu_env.c` —— **只建软链，没有挂载兜底**（它默认 /mnt 已经挂好了）

一行命令救回来：

```sh
mkdir -p /mnt/android_sys
mount -t ext4 -o ro /dev/mmcblk0p17 /mnt/android_sys
```

**遗留待办**：把这条固化成开机脚本 `00_android_sys.start`。否则每次重启，所有 bionic 程序（nettv_player、PSP 前端、WCN 相关）全部 linking 失败。

## 四、正事：10-13 的 mbinfo 复用修复，初步验证通过

环境修好后重跑泸县源（`timeout -s KILL 80`），约 50 秒时的判据：

| 判据 | 旧版 | 新版 |
|---|---|---|
| `change to sw decoder` | 必出（单向门） | **0 次** |
| `[ion] ... FAILED rc=` | 第 5 块必出 -12 | **0 次** |
| `复用块#` | 无 | **93 次** |
| 进程存活 | 4 帧后崩/挂死 | **>50s，持续出帧** |

也就是说，10-13 定案的因果链成立了：**根本不是「第二个 IDR 必崩」，而是 VSP 的 mbinfo（653824B/块）在 ~7MB CMA 池里只够放 4 块，第 5 块 ENOMEM → `decRet=-3` → 组件永久切软解 → 之后恒 `-9 needIVOP`**。把「复用 + 降对齐重试 + 检测单向门主动重生」三件事做完，第二个 IDR 就不再是终点。

还差的验证：精确帧数、多 GOP 连续时长、画面是否花帧（`C1_REUSE_MAX` 可能要调）。

## 五、本次最贵的教训：别对 UI 主进程发 SIGSTOP

为了不让 LVGL 跟播放器抢 framebuffer，我在测试脚本里加了一句 `kill -STOP $(pgrep -x lvgl_demo)`。

然后轮询的时候 SSH 挂了：`Error reading SSH protocol banner [WinError 10054]`，复测是 **TCP 22 Connection refused**（ping 仍通），5555/23/8022 全 Timeout。sshd 死了，设备上没有任何远程通道。

真正的灾难在这里：**lvgl_demo 停在 SIGSTOP 状态，没有人给它 SIGCONT**。设备 watchdog 早就裁撤了，看门狗不会拉它，也不会有人来恢复它。于是一台「网络通但 SSH 死、UI 冻结」的设备，只剩断电一条路。

在无人值守的自动化里，这是一条铁律：

> **不要对 UI 主进程发 STOP/TERM。** 省下的那点 framebuffer 争用，远不值得赌上整机失联。要测播放器就让它抢屏，画面闪几下而已，测完 UI 自己就恢复了。

## 六、经验总结

1. **重启是嵌入式设备最危险的动作**，它把「开机脚本里已经不存在的隐含依赖」一次性全部暴露出来。改开机脚本（尤其是删除）时，必须把被删脚本承担的非显性职责（挂载、建软链、环境变量）显式迁走。
2. **ICS 这类「系统托管」的配置，手工替代永远是假的**。地址在、ping 通，不代表 NAT 在。判据要用**功能真值**（能不能出去），不要用配置表象（地址在不在）。
3. **`library "xxx.so" not found` 的第一嫌疑是挂载点，不是文件**。动态链接器报缺库时，先看软链目标目录是不是空的——尤其在小机顶盒 / chroot / Android 兼容层这种到处是软链的环境。
4. **长任务「后台 + 短轮询」是纪律**，但**对主进程发信号不是**。前者是为了躲沙箱超时，后者是主动制造不可恢复状态，两回事。
5. **修完根因要立刻用判据复验**。本次 `复用块#=93 / sw=0 / FAILED=0` 三个计数，比「看着在播」可靠得多——把判据写成可 grep 的计数，下次几分钟就能确认。

---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
