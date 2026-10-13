---
title: "FM收音ioctl命令表_逆向还原"
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


# 展讯 SC9832A FM 收音机 —— ioctl 命令表逆向还原（含实测确认）

> **读者对象**：负责 FM daemon / UI 的工程师；后续接其他外设时想复用本手法的工程师。
> **使用方式**：写 `/dev/fm` 相关代码时**直接查本文表格取命令号**，不要再猜、也不要再等原厂头文件。
> **核心价值**：把此前的"头号阻塞项"变成一张**可直接编码的常量表**，并给出可复用的取证方法。

---

## 0. 一句话总结

> `marlin_fm.ko` **未被 strip**，命令号就写在 `fm_ioctl()` 的机器码里。
> 全部命令统一编码为 **`_IOWR(0xF5, nr, 4)` = `0xC004F500 | nr`**；
> 47 条命令中 **45 条已由设备实测（内核日志打印出命令名）确认**，另 2 条为静态反汇编推断。
> **唯一的硬阻塞已解除，可以开始写 daemon。**

---

## 0.1 ⚠️ 重要更正（2026-09-22 补充，用前必读）

命令号表本身**仍然准确**，但下面三条**能力层面的结论已被后续实测推翻**，别再按旧结论设计：

| 旧结论（本文原稿） | 实测更正 |
|---|---|
| `SCAN 0x08` + `SCAN_GETRSSI 0x24` 可用，能画频谱/场强 | ❌ **两者都是空壳**：调用返回 0 但**零 SDIO 流量**；`GETRSSI 0x07` 是唯一真发 SDIO 的信号类命令，但恒 `ETIMEDOUT` 耗 4.2s 且回值几乎不变 → **本机拿不到可信场强** |
| `SEEK 0x03` 可"向上/下搜索下一个电台" | ❌ **起点频率被驱动截断成 1 字节**（`freq & 0xFF` 进 AT 帧），带内频点传不进去；实测只有 **92.5MHz / 103.1MHz 两个固定回值**，与当前频点无关 → **不能做搜台** |
| 可用 `write(/dev/fm)` 写 AT 文本绕开 ioctl | ❌ 恒定 `-1 / EINVAL(22)`，无任何 SDIO 流量 |

另外，`OVER_BT_ENABLE 0x1d` / `ANA_SWITCH 0x1e` / `I2S_SETTING 0x21` 等**音频类命令全是空壳**
（反汇编 `fm_ioctl` 的 `R_ARM_CALL` 只调 7 个函数，无任何音频通路函数）。

→ **详细实测数据见 `FM收音_SEEK与场强_实测结论.md`。**

---

## 1. 结论表（可直接当 `fm_ioctl.h` 用）

编码：`cmd = 0xC004F500 | nr`，即 `_IOWR(magic=0xF5, nr, size=4)`。

| nr | 命令号 | 命令名 | 确认方式 | 本机实测返回值 | 用途 |
|---|---|---|---|---|---|
| 0x00 | `0xC004F500` | `power up` | **实测** | 0 | 上电（**注意不是 `TUNE`**） |
| 0x01 | `0xC004F501` | `power down` | **实测** | 0 | 下电 |
| 0x02 | `0xC004F502` | `TUNE` | **实测** | -1 (`ETIMEDOUT`) | 调到指定频率（参数 = 频率） |
| 0x03 | `0xC004F503` | `SEEK` | **实测** | 0 | 向上/下搜索下一个电台 |
| 0x04 | `0xC004F504` | `SETVOL` | **实测** | 0 | 设音量 |
| 0x05 | `0xC004F505` | `GETVOL` | **实测** | 0 | 读音量 |
| 0x06 | `0xC004F506` | `MUTE` | **实测** | 0 | 静音开关 |
| 0x07 | `0xC004F507` | `GETRSSI` | **实测** | 0 | **信号强度**（UI 信号条） |
| 0x08 | `0xC004F508` | `SCAN` | **实测** | 0 | 全频段扫描 |
| 0x09 | `0xC004F509` | `STOP_SCAN` | 静态推断 | -1（未打印日志） | 中断扫描 |
| 0x0a | `0xC004F50A` | `GETCHIPID` | **实测** | 0 | 芯片 ID（本机返回 `0x2341`） |
| 0x0b | `0xC004F50B` | `EM_TEST` | **实测** | 0 | 工程模式 |
| 0x0c | `0xC004F50C` | `RW_REG` | **实测** | 0 | 寄存器读写（调试） |
| 0x0d | `0xC004F50D` | `GETMONOSTERO` | **实测** | 0 | 单声道/立体声状态 |
| 0x0e | `0xC004F50E` | `GETCURPAMD` | **实测** | 0 | 当前 PAMD 值 |
| 0x0f | `0xC004F50F` | `GETGOODBCNT` | **实测** | 0 | 好块计数（音质统计） |
| 0x10 | `0xC004F510` | `GETBADBNT` | **实测** | 0 | 坏块计数 |
| 0x11 | `0xC004F511` | `GETBLERRATIO` | **实测** | 0 | 块误码率 |
| 0x12 | `0xC004F512` | `RDS_ONOFF` | **实测** | -1 | RDS 开关 |
| 0x13 | `0xC004F513` | `RDS_SUPPORT` | **实测** | 0 | 是否支持 RDS |
| 0x17 | `0xC004F517` | `SIM_DATA` | **实测** | 0 | 仿真数据（产测） |
| 0x18 | `0xC004F518` | `IS_FM_POWERED_UP` | **实测** | 0 | **是否已上电**（daemon 启动自检用） |
| 0x1d | `0xC004F51D` | `OVER_BT_ENABLE` | **实测** | 0 | **FM 音频走蓝牙**（声道仲裁关键） |
| 0x1e | `0xC004F51E` | `ANA_SWITCH` | **实测** | 0 | **模拟音频通路切换** |
| 0x1f | `0xC004F51F` | `GETCAPARRAY` | **实测** | 0 | 容值阵列（硬件标定） |
| 0x21 | `0xC004F521` | `I2S_SETTING` | **实测** | 0 | **I2S 音频通路设置** |
| 0x22 | `0xC004F522` | `RDS_GROUPCNT` | **实测** | 0 | RDS 组计数 |
| 0x23 | `0xC004F523` | `GET_LOG` | **实测** | 0 | 取驱动日志 |
| 0x24 | `0xC004F524` | `SCAN_GETRSSI` | **实测** | 0 | **扫描中逐点取场强**（画频谱用） |
| 0x25 | `0xC004F525` | `SETMONOSTERO` | **实测** | 0 | 强制单声道/立体声 |
| 0x26 | `0xC004F526` | `RDS_BC_RST` | **实测** | 0 | RDS 广播复位 |
| 0x27 | `0xC004F527` | `CQI_GET` | **实测** | 0 | 信道质量 |
| 0x28 | `0xC004F528` | `GET_HW_INFO` | **实测** | 0 | 硬件信息 |
| 0x29 | `0xC004F529` | `GET_I2S_INFO` | **实测** | 0 | I2S 当前状态 |
| 0x2a | `0xC004F52A` | `IS_DESE_CHAN` | **实测** | 0 | 是否处于去敏信道 |
| 0x2b | `0xC004F52B` | `TOP_RDWR` | **实测** | 0 | 顶层寄存器读写 |
| 0x2c | `0xC004F52C` | `HOST_RDWR` | **实测** | 0 | 主机侧读写 |
| 0x2d | `0xC004F52D` | `PRE_SEARCH` | **实测** | 0 | 预搜索 |
| 0x2e | `0xC004F52E` | `RESTORE_SEARCH` | **实测** | 0 | 恢复搜索 |
| 0x30 | `0xC004F530` | `GET_AUDIO_INFO` | **实测** | 0 | **当前音频通路状态** |
| 0x3c | `0xC004F53C` | `SCAN_NEW` | **实测** | 0 | 新版扫描 |
| 0x3d | `0xC004F53D` | `SEEK_NEW` | **实测** | 0 | 新版搜索 |
| 0x3e | `0xC004F53E` | `TUNE_NEW` | **实测** | 0 | 新版调谐 |
| 0x3f | `0xC004F53F` | `SOFT_MUTE_TUNE` | **实测** | 0 | **软静音调谐**（换台不炸音） |
| 0x40 | `0xC004F540` | `DESENSE_CHECK` | **实测** | 0 | 去敏检测 |
| 0x46 | `0xC004F546` | `FULL_CQI_LOG` | **实测** | 0 | 完整 CQI 日志 |
| 0xff | `0xC004F5FF` | `DUMP_REG` | 静态推断 | -1（未打印日志） | 转储寄存器 |

**统计**：47 条中 45 条**实测确认**（内核日志打印出该命令名），2 条（`STOP_SCAN` / `DUMP_REG`）为静态反汇编推断，调用时返回 -1 且未打印日志，**用前需再验一次**。

### 未定义区间（调用返回 -1 且无日志）

`nr = 0x14~0x16`、`0x19~0x1c`、`0x20`、`0x2f`、`0x31~0x3b`、`0x41~0x45`、`0x47~0xfe` 在驱动里没有对应分支，
`ioctl` 会走 "Unknown FM IOCTL!" 分支返回 `-EINVAL`。

---

## 2. 命令号是怎么算出来的

### 2.1 编码规则

拿到任意一个命令号，按 `_IOC` 宏解码即可验证：

```python
dir_ = (cmd >> 30) & 3        # 3 = READ|WRITE  => _IOWR
size = (cmd >> 16) & 0x3FFF   # 4
type = (cmd >>  8) & 0xFF     # 0xF5
nr   =  cmd        & 0xFF     # 命令序号
# 例：0xC004F509 -> _IOWR(0xF5, 9, 4)
```

**`type` 恒为 `0xF5`、`size` 恒为 `4`**，所以整套命令可以只用 `nr` 索引，
即 `#define FM_IOCTL(nr) (0xC004F500 | (nr))`。

### 2.2 静态路线：从 `fm_ioctl()` 的机器码读常量

```sh
file /lib/modules/marlin_fm.ko          # -> not stripped  ← 前提
objdump -d --disassemble=fm_ioctl /lib/modules/marlin_fm.ko
```

`fm_ioctl()` 被编译器编译成**二分查找**，每个 case 形如：

```asm
     d48: ldr  r3, [pc, #1756] @ 142c    ; 从字面量池取 32bit 常量
     d50: cmp  r1, r3                    ; r1 = 用户传入的 cmd
     d64: beq  12e8                      ; 命中则跳 handler
     d6c: sub  r3, r3, #19               ; 编译器用 add/sub 就近派生下一个比较点
     d70: cmp  r1, r3
```

**两个必踩的坑（都实际踩过）**：

| 坑 | 现象 | 正解 |
|---|---|---|
| **`movw` 只改低 16 位** | 只按 `movw r3, #62729` 取值会得到 `0xf509` 这种"半截数" | 必须把高 16 位（`movt` 或上一条 `sub` 链的结果）一起算，真值是 `0xc004f509` |
| **打印串不在 `.rodata`** | 按 `.rodata` 偏移取字符串取不到 | `objdump -r` 读重定位表：命令名的格式串在 **`.rodata.str1.1`** |

**命令名的取法**：每个 handler 块的固定形态是

```asm
     11ac: movw r2, #112           @ __LINE__
     11b0: ldr  r0, [pc, #792] @ 14d0   ; ← 格式串，一定在前 6 条指令内
     11b4: ldr  r1, [pc, #632] @ 1434   ; ← __func__ "fm_ioctl"
     11b8: bl   printk
```

且格式串模板恒为 `"FM_DRV: %s-%d -- ----<命令名>----"`，用整串正则即可精确取出名字。

### 2.3 动态路线：把 dmesg 当"判真器"（最终判据）

驱动里**每个 case 的第一件事就是打印自己的名字**，而且这行 `printk` **在真正 handler 之前**，
所以即使 handler 因参数非法失败，名字照样打得出来 —— 这是零成本、可判真的验证：

```
FM_DRV: fm_ioctl-72  -- ----TUNE----
FM_DRV: fm_ioctl-112 -- ----GETCHIPID----
```

探针极简（`ssh_tools/fmprobe.c`）：

```c
int fd = open("/dev/fm", O_RDWR);
unsigned char arg[64] = {0};          /* 全零参数：多数 handler 会因参数非法提前返回 */
int r = ioctl(fd, 0xC004F502 /*TUNE*/, arg);
```

**取内核日志的正确姿势**：`dmesg | wc -l` 前后比对**不可靠** —— 本机 `SDIOTRAN` 子系统在
高频刷屏，环形缓冲会回绕导致漏读（第一版扫描因此只认出 12/47）。
**必须先 `dmesg -c` 清空，再调用，再读**：

```python
subprocess.run(["dmesg", "-c"])            # 清空
subprocess.run(["/root/fmprobe", hex(cmd)])# 调一次
time.sleep(0.25)
body = subprocess.run(["dmesg"], capture_output=True, text=True).stdout
```

改用这个姿势后，**一次扫描就命名成功 45/47**。

### 2.4 交叉验证：去 Android 库里搜同一个常量

原厂 Android 分区的 `libfmjni.so` 里**存着同一批 `0xC004F5xx` 字面量**（裸字节搜到 18 处），
这从第三方独立证实了编码不是我们算错的：

```python
raw = open("/mnt/android_sys/lib/libfmjni.so", "rb").read()
b = (0xC004F500 | 0x0a).to_bytes(4, "little")   # 0a f5 04 c0
print(b in raw)                                  # True
```

> ⚠️ **直接 grep objdump 文本里的 `0xc004f5xx` 搜不到** —— `movw`/`movt` 会把它拆成两条指令。
> 要么裸搜字节，要么搜 `movt ... @ 0xc004`。

### 2.5 静态与动态的交叉结论

静态反汇编先行给出 47 个候选常量，其中 31 个直接解析出名字；
剩余 16 个（`0x02/0x05/0x08/0x0c/0x0f/0x12/0x18/0x1d/0x1f/0x23/0x26/0x29/0x2c/0x30/0x3e/0x46`）
先按"命令名在 `.rodata` 中的排列顺序 = `nr` 递增顺序"推断，再**全部通过实测逐一确认，无一错误**。

---

## 3. 附带发现：驱动其实是「AT 命令 + ioctl」双接口

实测 TUNE 时抓到的完整内核日志：

```
FM_DRV: fm_ioctl-72  -- ----TUNE----
FM_DRV: fm_write-348 -- fm_write_completion done=0X0
FM_DRV: fm_write_buf-310 -- fm start wake marlin
FM_DRV: fm_write_buf-337 -- * fmdev->write_buf: at+fm=1,0 *
fm_sdio_write size: 11
FM_DRV: fm_write-356 -- fm_write_after_completion done=0X0
```

三个可确认的事实：

1. **驱动通过 SDIO 向芯片下发的是 AT 文本**，格式为 **`at+fm=<opcode>,<param>`**
   （`at+fm=1,0` 共 10 字符 + NUL = 11 字节，与 `fm_sdio_write size: 11` 吻合）。
2. **AT opcode ≠ ioctl nr**：`TUNE` 的 ioctl nr 是 `0x02`，但 AT opcode 是 `1`。
   两者是两套编号，**不要混用**。
3. 驱动里有 `parse_at_fm_cmd` / `parse_at_fm_num`，说明 `/dev/fm` **也接受直接 `write()` AT 文本**
   —— 这是绕开 ioctl 的另一条路（`libengfm.so` 只导出一个 `fm_runcommand` 也印证了这一点）。

> ⚠️ **AT opcode 全表尚未标定**：目前只确认 `power up -> at+fm=0`、`TUNE -> at+fm=1,<freq>`。
> 且扫描中大量命令都打印出 `at+fm=12`，语义未确认（疑似通用查询帧）。
> **在没有把每个命令的 AT 帧都抓一遍之前，daemon 一律走 ioctl，不要走 AT 文本。**

### 3.1 一个重要行为：`TUNE` 会阻塞约 4 秒

`TUNE`（当时 arg=0，即频率非法）返回 `-1 / ETIMEDOUT`，日志时间戳跨度

```
[11448.618865] ----TUNE----      →  [11452.613128] fm_write_after_completion
```

即 **约 3.99 s**。对应驱动里那句 `seek Timeout(%d sec), fm seek end !`。

**设计影响**：
- daemon 里 TUNE/SEEK **必须放到独立线程**，不能让 UI 线程同步等；
- socket 接口要设超时（本项目蓝牙页踩过的坑：`SO_RCVTIMEO`）；
- UI 上要有"正在调谐"态与超时兜底。

---

## 4. 对下游设计的直接影响

| 之前的状态 | 现在 |
|---|---|
| `操作手册` Step 2 = "拿 ioctl 命令号（头号阻塞）" | **该步已完结**，Step 3 起可开工 |
| daemon 无法编码 | 可直接 `#define FM_IOCTL(nr) (0xC004F500 | (nr))` |
| `OVER_BT_ENABLE` / `ANA_SWITCH` 语义不明 | 命令号已确定（`0x1D` / `0x1E`），可开始 A/B 试听确认通路 |
| 扫描/取场强无接口 | `SCAN 0x08` + `SCAN_GETRSSI 0x24` 可用，UI 频谱图可画 |
| 换台会炸音 | `SOFT_MUTE_TUNE 0x3F` 可用 |

**daemon 最小闭环（P0）只需要 8 个命令**：
`IS_FM_POWERED_UP(0x18)` → `power up(0x00)` → `TUNE(0x02)` / `TUNE_NEW(0x3E)` →
`GETRSSI(0x07)` → `SETVOL(0x04)` → `MUTE(0x06)` → `ANA_SWITCH(0x1E)` → `power down(0x01)`。

---

## 5. 已确认的硬事实（无需重新探查）

| 项 | 值 |
|---|---|
| 命令编码 | `_IOWR(0xF5, nr, 4)` = `0xC004F500 \| nr` |
| 命令总数 | 47 个有分支（45 实测 + 2 推断） |
| 命令名打印格式 | `FM_DRV: <func>-<line> -- ----<NAME>----` |
| 命令名打印时机 | **在真正 handler 之前**（故可当判真器） |
| 设备节点 | `/dev/fm`（misc 10:23） |
| 芯片通信 | SDIO，AT 文本 `at+fm=<opcode>,<param>` |
| `TUNE` 阻塞时长 | ≈ 3.99 s（失败路径，超时返回 `ETIMEDOUT`） |
| `GETCHIPID` 返回值 | `0x2341` |
| 静态工具可用性 | 设备自带 `objdump` / `readelf` / `nm` / `strings` / `gcc` / `python3` |
| Android 侧 | `libfmjni.so` 含同批常量；`libFMHalSource.so` 负责 PCM（`/dev/snd/controlC%i`） |

## 6. 已验证的死路（不要重试）

| 做法 | 结果 |
|---|---|
| 在设备上找 FM 驱动源码 | ❌ 没有；`/tmp/linux-3.10.65` 是 **vanilla 内核树**，无展讯私有 FM 源码 |
| 找 `fm.h` / `sprd_fm.h` 头文件 | ❌ 全盘无（`find / -name '*.h' \| grep -i fm` 只命中无关文件） |
| 直接 grep objdump 文本找 `0xc004f5xx` | ❌ `movw`/`movt` 拆分导致搜不到，**必须裸搜字节或搜 `movt @ 0xc004`** |
| 按 `.rodata` 取命令名格式串 | ❌ 实际在 **`.rodata.str1.1`**，要读重定位表 |
| 用 `dmesg \| wc -l` 前后比对取日志 | ❌ 被 `SDIOTRAN` 刷屏回绕，会静默漏读；**必须 `dmesg -c` 先清空** |
| 复用 Android FM 用户态库 | ❌ 依赖 Android 运行时（`libcutils`/`libutils`/`binder`），不可直接搬 |

## 7. 仍未确认（不要当事实用）

| 项 | 为什么要等实测 |
|---|---|
| AT opcode 全表 | 只确认 2 个；`at+fm=12` 语义未知 |
| `STOP_SCAN` / `DUMP_REG` 的确切命令号 | 静态推断，未实测打印 |
| 各 ioctl 参数的结构/量纲 | 本次全部用零参数，未标定（如 TUNE 的频率单位、步长） |
| `ANA_SWITCH` / `I2S_SETTING` / `OVER_BT_ENABLE` 的取值语义 | 需**人耳** A/B 试听确认 |
| 是否依赖耳机当天线 | 需不插耳机 TUNE 强信号电台实测 |
| RSSI 有效区间与阈值 | 必须实测标定，**不要照搬网上通用阈值** |

---

## 8. 复现用脚本（`AI工作流` 之外的工程脚本）

| 脚本 | 作用 |
|---|---|
| `ssh_tools/fm_ioctl_extract.py` | 静态反汇编还原命令号↔命令名（含 movw 高位、`.rodata.str1.1` 两个坑的修正） |
| `ssh_tools/fm_re_full.py` | 命令名完整性核对 + Android 库裸字节交叉验证 |
| `ssh_tools/pull_disasm.py` | 把 `fm_ioctl` 反汇编拉到本地人工阅读 |
| `ssh_tools/fmprobe.c` | 设备端最小 ioctl 探针 |
| `ssh_tools/fmprobe_sweep.py` | 全量实测扫描（`dmesg -c` 清空法） |
| `ssh_tools/fm_any.c` | 通用 `/dev/fm` ioctl 探针（`fm_any --seq 30:0 29:0`） |
| `ssh_tools/fm_tune_probe.c` + `_run.py` | dump ioctl 回写的 32 字节 arg 结构体（判断驱动写了什么） |
| `ssh_tools/fm_seek_probe{,2}.c` + `_run.py` | SEEK 参数矩阵 / 起点与方向语义标定（**详见 0.1 与专文**） |
| `ssh_tools/fm_at_probe.c` + `_run.py` | 验证 `write(/dev/fm)` 写 AT 文本（结论：EINVAL） |
| `ssh_tools/fm_sigcmd_trace.py` | 干净 dmesg 下测信号类命令，看有无 SDIO 流量 |
| `ssh_tools/fm_rssi_sweep.py` / `fm_rssi_trace.py` | 多频点 RSSI 扫描 / 单次 tune+RSSI 完整驱动日志 |

> 同一套手法可直接复用到 GPS / NFC / 传感器等「有驱动、无源码」的外设上。

---

> **一句话总结**：命令号没丢，只是藏在 `.ko` 的机器码里；
> **静态反汇编定位候选 + 全零参数单步实测 + `dmesg -c` 清空取日志**，
> 三步就把 47 条命令全部落实 —— 唯一硬阻塞解除，可以开始写 daemon 了。
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
