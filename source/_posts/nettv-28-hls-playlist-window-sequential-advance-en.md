---
title: netTV Hardware Decoding (28): The 5-Second Segment-Pick Stall — What It Costs to Watch Only the Last Entry in the Playlist
date: 2026-10-26 02:45:00
tags:
  - 嵌入式
  - 展讯 SC9832A
  - VSP 硬解
  - HLS 直播
  - 性能剖析
categories:
  - [项目实战, netTV 硬解]
  - [嵌入式, 展讯平台]
copyright: 原创文章，遵循 CC BY-NC-SA 4.0 版权协议，转载请注明出处：whiteleibniz.github.io
---

> 🌐 Languages: [简体中文](https://whiteleibniz.github.io/2026/10/26/nettv-28-hls-playlist-window-sequential-advance/) · [繁體中文](https://whiteleibniz.github.io/2026/10/26/nettv-28-hls-playlist-window-sequential-advance-zh-tw/) · [English](https://whiteleibniz.github.io/2026/10/26/nettv-28-hls-playlist-window-sequential-advance-en/)

> Post 28 in the series. The previous one broke the 10.3-second inter-segment gap into "5.0s picking a segment + 5.2s draining audio". This post first **measures** those 5 seconds, then **cuts them down to 0.3s**. The root cause is a little embarrassing to admit: we were waiting for a segment that hadn't been generated yet, while four ready-to-play segments were sitting in the playlist window untouched.

## 1. Instrumenting Segment Selection

The instrumentation from the previous post stopped at `pick_seg()`. We knew "the pick takes 5.0 seconds in total", but we had no idea whether those 5 seconds went into **downloading**, **sleeping**, or **retrying**. So step one: time every playlist fetch inside `hls_pick()`, and record the segment count, the last segment name, and where `g_last_seg` matched.

Purely timers and logging — zero behavioral change. One run against the Luxian source produced this trace:

```
[hls] 拉列表 2330ms 段数=5 r=1 末=seg/Num15825010.ts 首=seg/Num15825006.ts
[hls] 选段 总=2330ms 拉列表=2330ms/1次 段数=5 命中=1 失败=0
[hls] 拉列表  215ms 段数=5 r=0 末=seg/Num15825010.ts 首=seg/Num15825006.ts
[hls] 拉列表  245ms 段数=5 r=0 末=seg/Num15825010.ts 首=seg/Num15825006.ts
[hls] 拉列表  245ms 段数=5 r=0 末=seg/Num15825010.ts 首=seg/Num15825006.ts
[hls] 拉列表  276ms 段数=5 r=0 末=seg/Num15825010.ts 首=seg/Num15825006.ts
[hls] 选段 总=4981ms 拉列表=981ms/4次 段数=5 命中=0 失败=0
>>> [hls] 无新段: 重播上一段保持画面
```

The bill came into focus immediately: **across 4 retries, fetching the playlist cost only 981ms in total (~250ms each); the remaining 4000ms was nothing but `sleep(1)` idling.** The network was never the bottleneck — our logic was.

## 2. The Real Shape of the 5-Second Stall

Put three lines of evidence side by side and the conclusion proves itself:

| Observation | Number |
|---|---|
| Segments in the playlist | **5** (Num15825006 ~ Num15825010) |
| What we actually take each round | **Only the last one**, Num15825010 |
| Result of the 4 retries | All `r=0` (last segment unchanged) |
| Fallback action | **Replay the previous segment** |

The old logic reads: take the last playlist entry → compare it with the previous one → if identical, sleep 1 second and retry 4 times → still identical, replay the previous segment. It carries an implicit assumption: **we are always playing right at the live edge, so only the newest segment is worth playing and the next chunk of content can only come from the server.**

But we were nowhere near the edge — a 10.3-second gap between segments against 5.96 seconds of actual content means we fall **further and further behind** live. Four unplayed segments sat ready in the window while we idled away and re-played the segment we had just finished.

That "replay the previous segment" fallback was originally written so the **picture wouldn't go black** (see post 15), but against a slow-refreshing source it degrades into "the picture loops in place". All 3 of 3 rounds in the log show `命中=0`.

One incidental discovery: **on the Luxian source, that day's pre-dawn last segment number, Num15825010, didn't budge across 15 minutes and two rounds** — the source had already stopped refreshing. That explains why every measurement came back at 15fps, and it's also a reminder that "testing one source to death" carries its own risk.

## 3. The Fix: Sequential Advance Inside the Window

The idea is straightforward — **stop staring at the last entry; find the previously played segment inside the window and play the one after it.**

```c
/* 列表全量解析进 g_segs[](不再只留 best) */
int at = -1;
for (int i = 0; i < g_segs_n; i++)
    if (!strcmp(g_segs[i], g_last_seg)) { at = i; break; }

if (at >= 0 && at + 1 < g_segs_n) {
    /* 窗口内还有下一段: 立刻前进, 零等待 */
    snprintf(full, sizeof full, "%s", g_segs[at + 1]);
} else if (at >= 0) {
    /* 已经播到窗口末尾: 只有末尾真的更新了才前进, 否则返回 0 等新段 */
    if (strcmp(g_segs[g_segs_n - 1], g_last_seg))
        snprintf(full, sizeof full, "%s", g_segs[g_segs_n - 1]);
    else { r = 0; goto done; }
} else {
    /* 首播 或 g_last_seg 已滑出窗口: 从倒数第 (1+HLSBUF) 段起播, 主动建缓冲 */
    int off = 1 + hlsbuf(); if (off > g_segs_n) off = g_segs_n;
    snprintf(full, sizeof full, "%s", g_segs[g_segs_n - off]);
}
```

Three branches, three situations: there's backlog in the window → take it for free; genuinely at the edge → only then wait; first play or slid out of the window → step back a few segments and **build a buffer**.

That last branch is the crux. `NETTV_HLSBUF` (default 3) makes the first segment pick start from "4th from the end", banking roughly 18 seconds of margin — about 3 segments — right from the start. After that, playback advances one slot at a time, so as long as the server ships segments at their nominal duration there is always a next segment ready — **waiting turns from the norm into the exception**.

## 4. Measurements

After the fix, on the Luxian source (the 4 backed-up segments in the window):

```
[hls] 选段 总=2311ms 拉列表=2311ms/1次 段数=5 命中=1 位=-1   ← 首播, 建缓冲
[hls] 选段 总= 225ms 拉列表= 225ms/1次 段数=5 命中=1 位=1
[hls] 选段 总= 202ms 拉列表= 202ms/1次 段数=5 命中=1 位=2
[hls] 选段 总= 225ms 拉列表= 225ms/1次 段数=5 命中=1 位=3
```

Segment selection went from **4981ms → 225ms (-95%)**, and "replay the previous segment" never fired once before the backlog ran dry. The corresponding inter-segment gaps:

```
[供数] 段2: 段间隙=6029ms  成分: 选段=250ms   预取=5557ms 音频=5009ms
[供数] 段3: 段间隙=6431ms  成分: 选段=481ms   预取=11541ms 音频=10987ms
[供数] 段4: 段间隙=6234ms  成分: 选段=705ms   预取=17333ms 音频=16774ms
```

Gap **10309ms → 6029~6431ms (-40%)**. The remaining ~5 seconds is `音频` across the board — that's the physical drain inside `audio_feed()` identified in the previous post, and it's the next cut.

To get a genuine steady state (Luxian had stopped refreshing), we switched to the Songpan source, which was still live, and ran for 120 seconds:

```
[hls] 选段 总=304ms 命中=1 段数=3      ← 11 段全部命中, 无一次重播
[hls] 选段 总=322ms 命中=1 段数=3
[hls] 选段 总=331ms 命中=1 段数=3
...
[STAT] frames=5125 real=2439 elapsed=111993ms fps_x10=217
signal=11 = 0
```

**21.7fps, zero crashes**, with segment selection holding steady around 310ms. The inter-segment gap still reads 11.2 seconds, but that's because a Songpan segment carries about 10 seconds of content and `音频` alone accounts for 8.6 seconds of it — **segment selection is no longer the bottleneck**.

Still, reporting only the post-fix numbers wouldn't be convincing, so we added an A/B comparison within the same binary family (v23 = the pre-fix selection logic), same Songpan source, same 120 seconds:

| | fps | Gap EMA | Segment pick | rb depth | Hit rate |
|---|---|---|---|---|---|
| v23 (old selection) | **14.2** | 19029ms | ~310ms | 296 → 146 (drained) | — |
| v28 (new selection) | **21.7** | 11400ms | 304~338ms | 377 → 489 (kept growing) | 11/11 |

Here's the interesting part: **the old logic didn't actually idle on the Songpan source** — this source refreshes fast enough that a new segment is always available when the playlist is fetched, so selection took 310ms there too. The difference doesn't come from the sleeps, it comes from **buffer depth**: the old logic hugged the live edge and rb got drained all the way down to 146 (the worker was starving); the new logic banks 2–3 segments of margin from the first play onward, and rb climbed to 489. So the real reason for the 53% frame-rate gap is that **feeding no longer stalls**, not the few `sleep(1)` calls we saved.

Put another way: on a fast-refreshing source this fix works by **building a buffer**, on a slow-refreshing one by **consuming the window backlog**. It covers both situations.

## 5. What It Costs

There's no such thing as a free frame rate. This fix trades "low latency but stuttering" for "smooth but higher latency": start-up deliberately steps back `HLSBUF` segments, which is ~18 seconds of latency at the default of 3.

For live TV I think it's a good trade: 18 seconds of latency is essentially invisible to the user, whereas "a stutter every 10 seconds plus the picture looping in place" is visibly bad. If you truly need to hug the live edge, `NETTV_HLSBUF=0` restores the old behavior.

One more caveat: **this logic depends on `g_last_seg` matching exactly inside the playlist.** If the source appends a volatile query string to the URL (auth tokens, `?m=` timestamps and the like), the match fails and behavior degrades into "jumping back to rebuild the buffer every round". The segments we tested used stable paths so we never hit it, but when switching sources it's worth glancing at the `[hls] 拉列表 ... 位=` column first — **it should read -1 once and then increment; if it stays at -1 forever, the matching is broken.**

## 6. The Next Cut

The inter-segment bill now looks like this:

| Item | Before | Now |
|---|---|---|
| Segment pick | 4918ms | **~320ms** |
| Audio drain | 5231ms | **5231ms (untouched)** |
| Download + enqueue | ~220ms | ~220ms |

77% of the black hole is now concentrated in `audio_feed()` alone. The **async audio pump** built in post 27 (`NETTV_AUDIO_ASYNC=1`, handing the whole segment over to a child process to feed slowly) was measured in isolation to compress audio from 5231ms down to 1ms and lift frame rate by 30%. Stack the two cuts and the segment period drops below the content duration, handing the bottleneck over to the worker side (23.2ms render) — that's when the real fight begins.

## Appendix: Two Pitfalls Hit This Round

1. **Logs truncated on respawn**: `child_log_bound()` opened `/tmp/nettv_child.log` with `O_TRUNC`, so every time the monitor restarted the child process all previous `[STAT]`/`[供数]` lines vanished. A 95-second run produced 973 frames, yet only one `[供数]` line survived — we nearly misread it as "crashed right out of the gate". Changed to `O_APPEND` with a separator marker written on each respawn.
2. **Don't test one source to death**: the Luxian source stopped refreshing before dawn; the same code measured 15fps there and 21.7fps on Songpan. **What invalidates a conclusion is often not the code but the state of the source.** To judge whether a source is alive, two m3u8 fetches nine seconds apart beat staring at the last segment number.
