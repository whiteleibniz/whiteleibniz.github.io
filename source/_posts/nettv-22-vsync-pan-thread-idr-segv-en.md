---
title: "Spreadtrum SC9832A Network TV Deep Dive (22): a Page-Flipping Thread for 'Curing Smearing' That Crashes Every IDR"
date: 2026-10-22 02:00:00
tags:
  - VSP
  - Hardware Decoding
  - SIGSEGV
  - vsync
  - framebuffer
  - LVGL
  - Spreadtrum
  - Bare clone Thread
categories:
  - [Embedded, Spreadtrum Platform]
  - [Embedded, Audio/Video]
  - [Debugging Methods, A/B Experiments]
copyright: "Original article, licensed under CC BY-NC-SA 4.0. Please credit the source when reposting: whiteleibniz.github.io"
lang: en
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/10/22/nettv-22-vsync-pan-thread-idr-segv/) · [繁體中文](https://whiteleibniz.github.io/2026/10/22/nettv-22-vsync-pan-thread-idr-segv-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/22/nettv-22-vsync-pan-thread-idr-segv-en/)

> Copyright: This article is original work by the author, licensed under CC 4.0 BY-SA. Please include the original source link and this statement when reposting.

In the last part we pushed the frame rate from 14.3fps to 21.8fps, and along the way squeezed in two "user experience fixes": curl hardening for weak networks (curing stutter) and an **independent vsync page-flipping thread** (curing smearing). The next day, one run — **zero frames, SIGSEGV on every IDR fed, the watchdog rebooting forever**. This part covers how a clean back-to-back A/B pinned the real culprit, plus a more valuable lesson: **the logs at a crash scene are often the most deceptive layer of all**.

## 1. Symptom: 0 Frames + Infinite Reboots

Running the Luxian 1080p source with the default config, the parent process log has only this:

```
*** monitor: 子进程自退 st=0xb ***
*** monitor: 重启 (子进程 @0 帧)
（重复 6 次）
```

`st=0xb` = the child process was killed by signal 11 (SIGSEGV). The child log `/tmp/nettv_child.log` has only 16 lines, looking as if "the decoder never even came up".

## 2. The First Misjudgment: Reading child.log Will Fool You Badly

Conclusion first: **in this scenario the only trustworthy trace is `/tmp/phase.log`, not the child's stdout.**

There are three reasons, stacked together:

1. Under bare bionic (`nostdlib -Wl,--entry=main`), `_exit()` **does not flush stdio**; once the process crashes, everything in the buffer is lost;
2. stdout is 4KB fully buffered, hitting disk only once 4KB fills up — so what you see is often just "the first 4KB";
3. every time monitor restarts the child it `O_TRUNC`s child.log, wiping out all clues from the previous generations outright.

The `ph()` / `phx()` diagnostic functions, on the other hand, write directly via `open(O_APPEND|O_SYNC)`, losing not a single line even on a crash. So the correct posture for judging the crash point is:

```sh
grep -B3 'mon-child-signal=11' /tmp/phase.log
```

One check: seven crashes are **completely isomorphic**:

```
t=... DRIVE empty(in) 喂 IDR+SPS+PPS (Annex-B 全序列, nFlags=0)
t=... mon-child-signal=11 st=0xb
```

The crash point falls 100% after "feeding the IDR".

## 3. The Second Misjudgment: `g_gh_n=0` Does Not Mean "the ION Pool Is Drained"

The log contains this one line, easily mistaken for ironclad evidence:

```
[earlyion] 可用输出路数 g_nout=1 (g_gh_n=0)
```

My earlier notes did record it as "the ION pool was drained by a leak ⇒ the device must be rebooted". **That was a misreading.** Look at the code:

```c
int early = 0;                      /* NETTV_EARLY defaults to 0 */
for (char **ep = environ; *ep; ep++)
    if (!strncmp(*ep, "NETTV_EARLY=", 12)) early = atoi(*ep + 12);
for (int i = 0; i < early; i++) { ... g_gh_n++; }
```

With `early=0` by default, the loop never runs, so `g_gh_n` **is necessarily 0** — this is the normal behavior of the "components grab their memory first; output buffers are allocated after component init" decision settled on 10-18, and has nothing to do with whether the pool is empty.

While at it, I also falsified "is the pool actually empty"; these two commands are worth writing down:

```sh
cat /sys/kernel/debug/ion/clients          # empty ⇒ no process holds ION
cat /sys/kernel/debug/dma_buf/bufinfo      # Total 0 objects ⇒ no leaked dma_buf
```

Both are clean, so this time it is **not** "pool drained → reboot the device"; don't rush to prescribe the old remedy.

## 4. The Real Culprit: a Just-Added "Anti-Smearing" Thread

4f2f17f added two things: a curl rate-limit parameter (unrelated to decoding), and the **independent vsync page-flipping thread** — waiting for the `FBIO_WAITFORVSYNC` blanking interval before `FBIO_PAN_DRAW`, changing page flips from "random scan phase" to "flip within the blanking interval", curing tearing on moving pictures.

It has an env escape hatch `NETTV_VSYNCPAN=0`, so this is a natural single-variable A/B. Same binary, same TS segment, back to back:

| Group | env | signal=11 count | real frames | fps | wall clock |
|---|---|---|---|---|---|
| A | default (flip thread on) | **6** | 0 | — | — |
| B | `NETTV_VSYNCPAN=0` | 0 | 1094 | 21.6 | 41.9 ms |
| A2 (re-test) | default | **6** | 0 | — | — |
| B2 (re-test) | `NETTV_VSYNCPAN=0` | 0 | 1094 | 21.6 | 41.9 ms |

Four groups of data: both A runs crashed, both B runs lived, and the frame rate is exactly the 21.6fps we know so well. **Same binary, single variable, bidirectional reproduction** — no more arguing.

### It Is the Same Thing as "the Second IDR Always Crashes"

A counter-intuitive detail: the flip thread is created by `vspan_publish()` only **after the first frame is rendered**, so why does the crash happen at "the first IDR"?

Because what crashes is the **subsequent generations** after monitor's restarts. Each generation: comes up → outputs a few frames → creates the flip thread → feeds the next IDR → crashes; and child.log was O_TRUNC'd, erasing the previous generations' frame output, leaving only the illusion of a few lines from the last generation "died before outputting any frame".

Flipping back through historical notes — the 10-15 entry "the second IDR always crashes" [attributed at the time to a secondary crash from the ION pool drying up], the 10-21 entry "the second IDR always crashes — falsified" — **the real answer is neither "the IDR is poisonous" nor "the pool leaked", but this thread**. It was only added on the evening of 10-21, and the timeline lines up too.

## 5. Disposition: One Line, Flipping the Default to the Safe Side

```c
static inline void vspan_publish(int pg) {
    if (g_pan_off) return;
    if (g_vspan < 0) {
        const char *e = getenv("NETTV_VSYNCPAN");
-       g_vspan = (e && e[0] == '0') ? 0 : 1;
+       g_vspan = (e && e[0] == '1') ? 1 : 0;   /* 10-22: default off (always crashes), =1 to enable */
    }
    ...
}
```

After rebuilding and deploying, the default (**no env set at all**) runs a 60s acceptance:

```
signal=11 count = 0
final STAT   = [STAT] frames=2150 real=1022 elapsed=46533ms fps_x10=219
final perf   = [perf] AU#1000 均值: 墙钟=41.3 段循环=14.0 (bsOnMsg=14.1 睡眠=0.0)
            snap=0.0 读帧=2.6 渲染=23.8 (ms) pan=0
```

0 crashes, 1022 real frames, **21.9fps**, and the wall-clock breakdown matches the 21.8fps baseline of 10-21 exactly ⇒ the frame rate did not regress; we just turned the flip thread off.

The cost: **the smearing problem is back to its unfixed state**. This is a trade-off — first preserve "it plays", then talk about "it looks good".

## 6. Three Reusable Lessons

1. **The most trustworthy log layer at a crash scene is often not stdout.** Leave an `O_APPEND|O_SYNC` phase trace on the critical path; it will save you many times; conversely, judging "which line it died on" from "looks like nothing was printed" is basically rolling dice.
2. **Don't use "some variable equals 0" as a conclusion; look at why it equals 0.** I misread `g_gh_n=0` for two weeks; checking `ion/clients` + `dma_buf/bufinfo` takes ten seconds, and saves one round of "reboot the device and see".
3. **Adding a new feature means leaving an env escape hatch, and running both directions.** Without `NETTV_VSYNCPAN=0` this time, the only recourse would be "compile the previous binary" to bisect, at an order of magnitude higher cost. The default should pick "the side the user can use", not "the side that is technically better".

## 7. Next Steps

The flip thread still needs fixing; it just no longer blocks playback. Candidate approaches:

- Find the crash cause: what exactly gets stepped on when a bare clone (no `CLONE_SETTLS`) thread calls `ioctl(WAITFORVSYNC/PAN_DRAW)` and puts a `struct fb_var_screeninfo` on the stack, concurrent with VSP decoding;
- Downgrade approach: don't start a separate thread; change to "wait for vsync → synchronous PAN" inside the main thread, at a cost of 0~18ms more per frame (average about 9ms), with 21.9fps dropping to around 17fps.

First wait for the user to visually confirm "whether the smearing is actually obvious", then decide whether to pay that frame rate for it.

---

**Files involved in this article** (device-side repo `/home/lvgl_demo/lvgl_demo`): `deploy/nettv_player/sprd_msg_np.c` (`vspan_publish()` / `pan_thread()` / `thread_start()`), build script `deploy/nettv_player/build.sh`.
