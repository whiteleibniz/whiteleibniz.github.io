---
title: "FM收音_SEEK与场强_实测结论"
date: 2026-09-23 12:16:40
search: true
categories:
- 硬件模块打通
- FM收音
tag:
- FM
- 收音机
---


# FM 收音 —— SEEK / 场强 / AT 文本直写 实测结论

> 设备：展讯 SC9832A（Alpine Linux / armv7l），FM 芯片 Unisoc Marlin2 combo，
> 驱动 `marlin_fm.ko`，节点 `/dev/fm`，ioctl 统一 `_IOWR(0xF5, nr, 4) = 0xC004F500 | nr`。
> 实测时间：2026-09-22。**全部结论均为设备实测，判真器是驱动自己的 dmesg（`fm_write_buf` / `parse_at_fm_cmd`）。**

---

## 0. 一句话结论

| 想做的事 | 能不能 | 原因 |
|---|---|---|
| 上电 / 调台 / 音量 / 静音 | ✅ | `POWER_UP(0x00)` / `TUNE(0x02)` / `SETVOL(0x04)` / `MUTE(0x06)` 真发 SDIO |
| **搜台（下一个电台）** | ❌ | `SEEK(0x03)` 的起点频率被驱动截断成 1 字节，带内频点传不进去；实测只有 2 个固定回值 |
| **读信号场强** | ❌ | 唯一真发 SDIO 的 `GETRSSI(0x07)` 恒超时 4.2s 且回值几乎不变；其余信号类命令全是空壳 |
| **写 AT 文本绕开 ioctl** | ❌ | `write(/dev/fm)` 恒定 `-1 / EINVAL(22)`，驱动不接收用户态 AT 文本 |

---

## 1. `SEEK (0x03)` —— 参数被截断，无法用来搜台

### 1.1 参数结构（与 TUNE 相同）
```c
typedef struct {
    unsigned char  zero;   /* offset 0 */
    unsigned char  band;   /* offset 1 */
    unsigned char  one;    /* offset 2 */
    unsigned char  pad;    /* offset 3 */
    unsigned short freq;   /* offset 4-5  —— 单位 0.1MHz（974 = 97.4MHz） */
    unsigned char  tail[26]; /* offset 6 起 */
} fm_arg_t;
```

### 1.2 驱动实际发出的 AT 帧

驱动把 `freq`（u16）**只取低字节**拼进 AT 帧（这是驱动的 bug）：

| 我们传 freq | 驱动实际发出 | 芯片回帧 | 驱动回写到 `tail[0..1]` 的"找到频点" |
|---|---|---|---|
| 974 (97.4MHz) | `at+fm=4,0,206` | `3,139,0,9250` | **925 = 92.5MHz** |
| 875 (87.5MHz) | `at+fm=4,0,107` | `3,139,0,9250` | **925** |
| 1080 (108.0MHz) | `at+fm=4,0,56` | `3,139,0,9250` | **925** |
| 900、1000 | `at+fm=4,0,132` / `,232` | `3,139,0,9250` | **925** |
| **0** | `at+fm=4,0,0` | `3,139,0,10310` | **1031 = 103.1MHz** |

- `at+fm=4,<p2>,<p3>` 的 **p2 恒为 0**：把 `zero/band/one/pad` 都改成 1/2 也不变。
- **p3 = `freq & 0xFF`**，所以带内频点（875~1080）永远传不进去。
- 结果与"当前频点"**无关**：先 `TUNE` 到 87.5 / 97.4 / 100.0 / 103.1，再 `SEEK(0)`，
  四次都回 **103.1**。

### 1.3 行为模型
- `p3 == 0`  → 恒返回 **92.5MHz 区间的另一极**（103.1MHz）
- `p3 != 0`  → 恒返回 **92.5MHz**

也就是说 SEEK 退化成"两个固定值二选一"，**不是"从当前频点向上/向下找下一个电台"**。
UI 上**不要**把它做成"搜台"按钮。

- 耗时：每次约 **1.43 s**（`at+fm=4` 发出 → `parse_at_fm_cmd: fm seek event have come freq=...`）。
- 驱动日志里那句 `FM seek freq =0` 里的值**恒为 0**，与传入的 freq 无关 → 别拿它当判据。
- `SEEK_NEW(0x3d)` 只打日志后发 `at+fm=12`（通用查询帧），`SCAN(0x08)` / `SCAN_NEW(0x3c)`
  返回 0 且**零 SDIO 流量** → 都是空壳/占位。
- `STOP_SCAN(0x09)` 恒 `-1 / EINVAL(22)`。

### 1.4 探针
- `ssh_tools/fm_seek_probe.c` + `fm_seek_probe_run.py` —— 参数变体矩阵 + 回写结构体 dump
- `ssh_tools/fm_seek_probe2.c` + `fm_seek_probe2_run.py` —— 起点/方向语义验证（配合 TUNE）

---

## 2. `write(/dev/fm)` 写 AT 文本 —— 被内核拒绝

驱动里有 `parse_at_fm_cmd` / `parse_at_fm_num`，Android 侧 `libengfm.so` 也只导出
一个 `fm_runcommand`，看起来像"可以直接写 AT 文本绕开 ioctl"。**实测不行**：

```
write(fd, "at+fm=1,9250", 12)  -> rc=-1 errno=22 (EINVAL)
write(fd, "at+fm=4,0,9740", 15)-> rc=-1 errno=22 (EINVAL)
write(fd, "at+fm=4,1,9740", 15)-> rc=-1 errno=22 (EINVAL)
write(fd, "at+fm=12", 8)       -> rc=-1 errno=22 (EINVAL)
```
dmesg 中**没有任何 `fm_write_buf` 记录** → 请求在进入驱动前就被拒了，没有 SDIO 流量。
**结论：此路不通，不要在这上面花时间。** 探针：`ssh_tools/fm_at_probe.c` + `fm_at_probe_run.py`。

---

## 3. 场强 / 信号类命令 —— 全部不可用

| 命令 | 命令号 | 实测判定 |
|---|---|---|
| `GETRSSI` | 0x07 | **唯一真发 SDIO**（`at+fm=13`），芯片回 123~125，但 ioctl **恒 `-1 / ETIMEDOUT(110)`，耗时恒 4.2s**；10 个频点上回值几乎不变 → 不能当场强表 |
| `SCAN_GETRSSI` | 0x24 | 空壳（只 printk） |
| `CQI_GET` | 0x27 | 空壳 |
| `GETMONOSTERO` | 0x0d | 空壳 |
| `GETGOODBCNT` / `GETBADBNT` | 0x0f / 0x10 | 空壳 |
| `GETBLERRATIO` | 0x11 | 空壳 |
| `IS_DESE_CHAN` | 0x2a | 空壳 |
| `SOFT_MUTE_TUNE` | 0x3f | 有作用（换台消爆音），但**不回写可用场强** |

**`TUNE` 应答里的第 2 个字段不是场强**：`at+fm=1,9740` → `0,164,0,9740`；
同一频点连调会得到 164 与 139 两个不同值；不同频点都在 139~140 附近；
**且驱动根本不把这个应答回写给用户态**（ioctl 返回后 arg 结构体没变化）。
→ 判定：不是稳定的场强指标，不能当信号表。

**下游影响**：收音机页**不应**再画"信号柱"。
现版本已改为固定文案「本机不提供场强查询」，并**移除**了每次调台后的
`rssi` 轮询（原来每次白等 4.2s）。

---

## 4. 相关：FM 音频输出也是死的

见 `FM收音ioctl命令表_逆向还原.md` 与 `outputs/FM收音机_进度快照_20260922.md`：
- FM 音频类 ioctl（`OVER_BT_ENABLE 0x1d` / `ANA_SWITCH 0x1e` / `I2S_SETTING 0x21` …）
  在 `marlin_fm.ko` 里**只 printk 就返回**（反汇编 `fm_ioctl` 的 `R_ARM_CALL` 只调 7 个函数，无音频通路函数）。
- 整机 codec（`sprdphone` card1）DAPM **路由表缺 HPL/HPR/SPKL/SPKR**，
  唯一可达终点是 `EAR`，且从不给 `Analog/Digital Power` 上电（`bias_level=Off` 恒 Off）。
- 8 个 capture 设备**全部 `readi -5 (EIO)`**；`read(/dev/fm)` 只返回 688B RDS 数据块。
→ **FM 音频既不能出声，也不能数字化进主机**。用户态无解。

---

## 5. 对应用设计的约束（可直接抄）

1. **UI 不要提供"搜台"按钮** —— SEEK 不可控，会让人以为搜到了电台。
2. **UI 不要画信号强度** —— 硬件不提供；画了就是说谎。
3. **不要轮询 `rssi`** —— 每次白等 4.2s。
4. **不要尝试写 AT 文本** —— EINVAL。
5. 可用且已验证的功能集：`state / on / off / tune <kHz> / vol <0-15> / mute <0|1> / chipid / rds`。
6. 任何"要不要为此改内核"的决策，都先看本文第 4 节 —— 出声的瓶颈在 codec 的 DAPM 路由，
   不在 FM 驱动。
---

> **版权声明**：本文为 whiteleibniz 原创文章（AI 协作整理），版权归 whiteleibniz 所有，转载请注明出处与原文链接：https://whiteleibniz.github.io
