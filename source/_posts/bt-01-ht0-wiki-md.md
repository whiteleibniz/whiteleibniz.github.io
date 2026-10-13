---
title: "HT0蓝牙原理与移植学习Wiki"
date: 2026-09-21 11:57:09
lang: zh-CN
search: true
categories:
- 硬件模块打通
- 蓝牙
tag:
- 蓝牙
- WCN
---


# HT0 蓝牙原理与移植学习 Wiki

> 这份文档不是操作手册，而是**原理课**：讲清楚这颗蓝牙芯片为什么这么启动、安卓原来怎么做、我们为什么改成现在这样、每一行关键代码在干什么。
> 读完你应该能：面对一台"安卓内核 + 别的用户态"的 combo 蓝牙设备，自己分析出该怎么把蓝牙拉起来。

---

## 0. 一句话先建立直觉

> 蓝牙不是一个"软件开关"，而是一颗**需要按特定时序上电、唤醒、喂固件、再讲 HCI 协议**的小处理器。
> 安卓用一整套服务（init + download + wcnd + libbt-vendor + Bluedroid）替你把这套时序做了；
> 我们把这套时序**用最少的代码重写了一遍**，跑在 Alpine 用户态上。

---

## 1. 硬件长什么样

这颗芯片叫 **Marlin combo WCN**（展讯 SC9832A 平台），"combo"= 一颗芯片同时做 WiFi 和蓝牙：

```
                ┌──────────────────────────────┐
                │      Marlin combo WCN        │
                │  ┌─────────┐   ┌───────────┐ │
                │  │ WiFi     │   │ Bluetooth │ │
                │  │ (wlan0)  │   │ (HCI 引擎)│ │
                │  └─────────┘   └───────────┘ │
                └────┬──────────────────┬──────┘
                     │ SDIO             │ UART
                     │ (数据/固件)       │ ttyS0 (HCI 控制)
              mmc2:8800:1         /proc/bluetooth/sleep/btwrite
              (设备ID 0x2331)      (写1=唤醒蓝牙引擎)
```

两条通道，分工完全不同，这是理解一切的基础：

| 通道 | 走什么 | 干什么用 |
|---|---|---|
| **SDIO** | 高速数据总线 | 烧固件（WiFi+蓝牙一体的固件镜像大块写进去）、WiFi 数据 |
| **UART ttyS0** | 3M 波特率 + 硬件流控(CRTSCTS) | 蓝牙的 **HCI 命令/事件通道**（发命令、收事件、传音频包） |
| **btwrite 节点** | 一个 proc 文件 | 写 `1` = 把蓝牙引擎从低功耗叫醒 |

**关键认知**：WiFi 和蓝牙**共用同一份固件**。所以"把 WiFi 拉起来"的同时，蓝牙固件也已经烧进芯片了——蓝牙缺的不是固件，而是**上电、唤醒、有人跟它说话**。

---

## 2. 蓝牙能用的五层模型（最重要的分析框架）

任何蓝牙设备能用，都要五层全通。**每一层都有明确的"验通标准"**，不通就停在那一层查，别跨层瞎试。

```
① 物理/固件层   固件烧进去了吗？芯片上电了吗？
                验通：SDIO 枚举出 0x2331；BT-OPEN 返回 OK
② 通道层        HCI 串口能读写吗？
                验通：往 ttyS0 发 Reset，能收到固件回的事件
③ 引擎层        蓝牙引擎醒着吗？跑起来了吗？
                验通：btwrite 唤醒后，固件回 "SPRD3" 身份帧
④ 协议层        标准 HCI 命令它认吗？
                验通：Read Version / Read BD_ADDR / Read Features 都回正常
⑤ 应用层        UI 怎么调用？音频怎么流？
                验通：扫描出设备、能连接、A2DP 能出声
```

我们这次几乎每踩一个坑，都是"误以为在上层，其实卡在下层"。比如：
- 扫描不出设备 → 不是协议问题，是**没先开扫描使能**（第④层的厂商隐藏要求）；
- 发命令没反应 → 不是命令错，是**没唤醒引擎**（第③层）；
- BT-OPEN 失败 → 不是命令错，是**chroot 里 proc 节点权限 600**（第①层的权限问题）。

---

## 3. 关键概念逐个讲透

### 3.1 HCI 和 H4 是什么

**HCI**（Host Controller Interface）= 主机（CPU）和蓝牙控制器（芯片）之间的标准对话协议。
**H4** = 在 UART 上传 HCI 的"打包格式"。每一包第一个字节是包类型：

| 首字节 | 含义 |
|---|---|
| `0x01` | Command（主机→芯片，命令） |
| `0x02` | ACL Data（双向，连接数据/音频） |
| `0x04` | Event（芯片→主机，事件/响应） |

所以我们的 daemon 干的事，本质就是：**往 ttyS0 写 `0x01 + 命令码 + 参数`，再从 ttyS0 读 `0x04 + 事件码 + 数据`**。

### 3.2 命令怎么编码

一个 HCI 命令 = 类型(1) + Opcode(2) + 参数长度(1) + 参数。
Opcode 拆成 OGF（组，高 6 位）和 OCF（命令，低 10 位）：

```c
opcode = (OGF << 10) | OCF
// 例如 Inquiry(扫描)：OGF=0x01(链路控制), OCF=0x0001
// → opcode = (0x01<<10)|0x0001 = 0x0401
```

源码里 `send_cmd()` 就是把这个拼出来：

```c
pkt[0] = H4_CMD;              // 0x01
pkt[1] = opcode & 0xff;       // opcode 低字节
pkt[2] = (opcode>>8) & 0xff;  // opcode 高字节
pkt[3] = plen;                // 参数长度
memcpy(pkt+4, params, plen);  // 参数
write(fd, pkt, 4+plen);
```

### 3.3 SPRD3 身份帧——"引擎活了"的信号

唤醒后，固件会主动吐出一串：
```
55 7e 00 81 00 06 53 50 52 44 33 00 57 0a 7e
                  └──── "SPRD3" = 展讯芯片的 ASCII 标识
```
看到 `SPRD3` 就说明：蓝牙引擎已经从引导状态跑起来了，HCI 通道是活的，可以开始发标准命令了。**这是第③层的验收标志。**

### 3.4 btwrite——为什么要反复写

蓝牙引擎有**低功耗睡眠**。空闲时它会睡，这时候你发命令它根本不理。
`/proc/bluetooth/sleep/btwrite` 写 `1` = 踹它一脚醒来。

- 安卓是每 30 秒周期性踹一次（libbt-vendor 干的）；
- 我们没有 libbt-vendor，所以自写脚本 **每 1.5~2 秒踹一次**，比安卓还勤，保证扫描/连接期间它别睡过去。

> 教训：早期所有"发命令没反应"的测试，根因都是**缺这一脚**。

### 3.5 pskey——蓝牙的"出厂个性化参数"

pskey 是芯片的个性化配置（蓝牙地址、功能位、UART 参数、发射功率等），结构是厂商定义的一大坨字段。
**关键认知**：我们没单独发 pskey，因为——

- `connectivity_configure.ini` 文件里的 `[SETCTION 6]` 就是这份 pskey；
- `download` 在烧固件时**自己读这个文件，已经把 pskey 下发了**；
- 实测 `Read Features` 返回的功能位和 pskey 文件里的完全一致 → **证明它已经生效了**。

所以"要不要补 pskey"是个伪问题。**用证据验证，别凭感觉死磕。**

### 3.6 一个厂商隐藏要求：Write Scan Enable 前置

标准蓝牙逻辑里，发 Inquiry 就能扫设备。但这颗展讯固件**不听话**：
直接发 Inquiry，它回"收到了"（CMD_STATUS=0），然后**永远不返回扫描结果**。

排查发现：必须**先发 `Write Scan Enable (0x0c1a)` 设成 `0x03`**（同时打开"可发现"+"可连接"），Inquiry 才会真正出结果。

> 这就是"厂商固件特性"——规范上没写，只能靠**对照实验**（哪次成功的那次多做了什么）反推出来。

---

## 4. 安卓原生是怎么干的（对照样本）

安卓开机时，`init` 按 `init.board.rc` 自动拉起这一串：

```
init
 ├─ download        烧 combo 固件（读 configure.ini，含 pskey）
 ├─ wcnd           蓝牙子系统上电（BT-OPEN 命令）
 ├─ btld / bt_rm   低功耗管理、射频管理
 └─ Bluedroid 协议栈
      ├─ libbt-vendor: 周期 btwrite 唤醒、发 pskey、管 UART 波特率
      └─ bluetooth.default.so: 完整 HCI/ATT/A2DP/RFCOMM 协议栈
           └─ BluetoothCtrl（你看到的设置界面）
```

**为什么安卓不用内核 hci_uart 驱动？** 因为展讯定制方案里，`libbt-vendor` 直接打开 UART 自己管 HCI，是"用户态直连"。这给了我们灵感。

---

## 5. 我们的 Alpine 方案：用最少代码替换一整套

### 5.1 启动链（开机自动跑）

```
开机
 ├─ wifi.start          ① chroot 安卓环境 + download 烧固件 + SDIO 0x2331 + WiFi 驱动
 ├─ bt_bringup.start   ② chmod 666 mdbg → wcnd → bt_once(BT-OPEN) → bt_wake.sh(btwrite 周期唤醒)
 ├─ bt_daemon(openrc)   ③ 自写用户态 daemon 打开 ttyS0，监听 unix socket
 └─ LVGL 桌面            ④ 蓝牙设置页通过 socket 发命令
```

### 5.2 三个关键决策（为什么这么选）

| 决策 | 我们选了 | 为什么 |
|---|---|---|
| 内核 hci_uart.ko vs 用户态直连 | **用户态直连** | 这内核是安卓定制 3.10.65，hci_uart.ko 里写死的 tty_struct 偏移对不上，`hciconfig up` 超时、TX=0（一个字节都发不出去）。用户态直接 `open("/dev/ttyS0")` 绕开内核协议栈，反而最稳——安卓 vendor 本来就这么干 |
| 移植 Bluedroid vs 自写最小 daemon | **自写 daemon** | Alpine 没有 Bluedroid 那一大串依赖（HAL、属性服务、共享库），完整移植成本远高于"只实现需要的几个 HCI 命令" |
| 自写 download vs 复用安卓原版 | **复用原版（chroot 里跑）** | download 的上电时序、握手、分区读取是芯片的"黑魔法"，自写风险极高。把安卓二进制连同它需要的库/节点/分区软链一起，在 chroot 里原样跑 |

> 核心思想：**能借就借（download/wcnd 直接用原版），要重写的只写最小必要部分（HCI 命令集）。**

### 5.3 那个"权限坑"

移植最容易踩的不是技术，是**权限**：
`wcnd` 在 chroot 里以 system 用户跑，要读 `/tmp/aand/proc/mdbg/*`，但那节点是 `600`（只有 root 能读）→ BT-OPEN 一直 FAIL。
`chmod 666` 一秒解决。这种"移植后权限模型变了"的问题，会反复出现。

---

## 6. 源码解读：daemon 在干什么

核心就三件事：**配串口、发命令、读事件**。

### 6.1 配串口（3M + 硬件流控）

```c
t.c_cflag = B3000000 | CS8 | CREAD | CLOCAL | CRTSCTS;
```
- `B3000000`：300 万波特率（蓝牙引擎初始化后切到这个高速档）
- `CRTSCTS`：开硬件流控（UART 两根线做流量控制，高速下不开会丢包）
- `VMIN=1`：阻塞读，读到至少 1 字节才返回——**这是早期帧截断 bug 的修复关键**

### 6.2 读一帧完整 H4 包

不能瞎 read，要按帧头长度读全：

```c
read(fd, buf, 1);              // 先读类型字节
if(buf[0] == H4_EVT) {         // 0x04 = 事件
    read(fd, buf+1, 2);        // 读 事件码(1) + 长度(1)
    plen = buf[2];
    while(没读够 plen) read(...); // 把参数读完
}
```

> 早期 bug：用非阻塞读，一次只读到 7 字节就返回，导致命令响应解析错乱。改成"按帧头长度读全"才稳。

### 6.3 扫描的完整流程

```c
send_cmd(0x0c1a, 0x03);        // ① 先开扫描使能（厂商隐藏要求！）
send_cmd(OGF_INQUIRY, inq);     // ② 发 Inquiry
while(没到超时) {
    read_pkt(...);
    if(事件是 Inquiry Result)  解析出 BD_ADDR / 设备类 / RSSI
    if(事件是 Inquiry Complete) break;
}
send_cmd(OCF_INQUIRY_CANCEL);   // ③ 取消扫描
```

### 6.4 对外接口：unix socket

daemon 不起复杂协议，就开一个 `/tmp/bt_ctl.sock`，GUI 连上来发一行文本命令：

```
state            → 返回 ON/OFF
on / off         → 开关
scan 8           → 扫 8 秒，返回 OK + 设备列表(BD_ADDR 设备类 RSSI)
connect <mac>    → 连接指定设备
```

GUI（LVGL 页面）只管发字符串、收字符串，**完全不用懂蓝牙**。这就是分层的价值。

---

## 7. A2DP 真实音频播放（v1.0.3 新增）

前面只是"能连接"。要真出声，得走 **A2DP**（高级音频分发协议）。

### 7.1 音频管线

```
屏幕点歌
  → mplayer -ao pcm:file=/tmp/bt_audio.fifo -format s16le
  → /tmp/bt_audio.fifo (命名管道)
  → daemon 读 PCM → SBC 编码 → 打成 ACL 数据包
  → UART → 蓝牙音箱 → 喇叭出声
```

为什么用**命名管道(fifo)**？因为 Alpine 没有 PulseAudio 这种音频服务器。最朴素的办法：
mplayer 把解码后的 PCM 不送声卡，而是写进一个文件（fifo），daemon 从这个文件里读 PCM，编码后发给音箱。

### 7.2 三个踩出来的关键参数

| 问题 | 现象 | 真相 |
|---|---|---|
| **字节序** | 能听出旋律，但全是雪花噪音 | mplayer 默认输出 **big-endian** PCM，daemon 按本机 **little-endian** int16 读 → 数据全乱。加 `-format s16le`（强制小端）就清晰了 |
| **判断时机** | 点歌没声，mplayer 走了 `-ao null` | 蓝牙状态判断 `bt_audio_connected()` 写在了 fork 子进程里、stdout 被 dup2 重定向之后，导致连 socket 失败。必须挪到 **fork 之前的父进程**里判断 |
| **帧参数** | 播几秒就断 | 按安卓金标准：SBC bitpool=35、每包 7 帧、20ms 单发、浅发送窗口、Start 前退出 Sniff 模式——照抄安卓才稳定 |

> 方法论：**"能出声但不对"要先怀疑数据格式（字节序/采样率/声道），不是协议错。**

---

## 8. 排障方法论（迁移时照这个查）

```
没反应/连不上
  ├─ 第①层：SDIO 枚举了吗？BT-OPEN OK 吗？权限够吗？
  ├─ 第②层：往 ttyS0 发 Reset，收得到事件吗？(收不到=串口/波特率/流控错)
  ├─ 第③层：btwrite 唤醒了吗？回 SPRD3 了吗？
  ├─ 第④层：标准命令 Read Version 正常吗？扫描前开 Scan Enable 了吗？
  └─ 第⑤层：UI 命令发对了吗？socket 连上 daemon 了吗？

有声不对
  ├─ 字节序(s16le)、采样率(44100)、声道(2)
  └─ SBC 参数(bitpool/每包帧数)

莫名复位
  └─ 看串口有没有回引导器帧(7e...7e)= 引擎崩了，多半是唤醒/发送时序问题
```

**对照机是金矿**：这台设备同款有一台跑原生安卓的机器。把它接上 ADB，抓它开机/开蓝牙时 ttyS0 的真实流量，比黑盒猜快十倍。我们的 `btwrite`、`Scan Enable`、SBC 参数，全是这么对照出来的。

---

## 9. 迁移到类似设备的通用清单

下次遇到"安卓内核 + 别的用户态，蓝牙要重拉"，照这个顺序：

1. **认芯片**：查是不是 combo 芯片，数据走 SDIO 还是别的，HCI 走 UART 还是 SDIO。
2. **找原厂时序**：读原厂 `init.*.rc` / `ueventd.rc`，找 download、上电、唤醒、HCI 节点。**能复用的二进制（download/wcnd）直接在 chroot 里复用。**
3. **验分层**：每层按 §2 的验收标准，一层一层验，不跳层。
4. **解决权限**：chroot 里 proc/sys 节点权限、属主，是移植头号坑。
5. **写最小 daemon**：只实现你要用的命令（开关/扫描/连接/音频），别上来就移植整套协议栈。
6. **抓对照包**：有同型号原厂机，ADB 抓真实流量重放，省无数黑盒时间。
7. **固化开机**：把整个链路写成开机脚本，重启自动拉起。

---

## 10. 这份 wiki 想让你记住的

- **蓝牙 = 一颗需要时序伺候的小处理器**，不是软件开关。
- **combo 芯片的固件是 WiFi+BT 一体的**，拉起 WiFi 常等于蓝牙固件已就位。
- **分层验证**是万能钥匙：每层一个验收标准，不通不跳层。
- **厂商隐藏要求**（Scan Enable、btwrite 周期唤醒、SBC 参数）只能靠**对照实验**和**原厂对照机**发现，规范书上没有。
- **移植 = 能借就借，重写最小**：原版二进制时序直接复用，只重写最必要的 HCI 层。
- **"没反应"先怀疑下层/权限/唤醒；"有声不对"先怀疑数据格式。**

---

> 配套文档：
> - `HT0蓝牙拉起_部署交付文档.md` —— 怎么在新设备上部署（操作层）
> - `蓝牙芯片打通_操作手册.md` —— 手工排障步骤
> - `蓝牙打通_工作过程总结.md` —— 这次踩坑的完整时间线
> - `蓝牙启动流程_安卓vsAlpine对比.md` —— 逐环节对照
> - 本文 —— 为什么这么做（原理层）
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
