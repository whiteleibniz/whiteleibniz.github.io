---
title: "Mali-400 Working Principles: TBDR Deferred Rendering and Its Bad Temper"
date: 2026-10-12 18:10:00
lang: en
permalink: en/2026/10/12/mali-400-tbdr-working-principle/
search: true
categories:
- 嵌入式硬件
tag:
- Mali
- GPU
- TBDR
- OpenGL ES
---


# What the Mali-400 Is

The Mali-400 is an ARM-licensed embedded GPU IP core that appears in low-end SoCs such as the SC9832A in MP1 (single-core) form. It is not a discrete graphics card, but a coprocessor attached to the AMBA AXI bus: the CPU (Cortex-A7) and the GPU share the same DDR memory, and there is no dedicated video memory. The software stack from top to bottom is: OpenGL ES 2.0 application → libEGL/libGLESv2 user-space driver (usually the Android variant of the DDK) → the mali.ko kernel driver → hardware.

# The Dual-Core Architecture

The Mali-400 internally consists of two processors with different responsibilities:

- **GP (Geometry Processor)**: responsible for vertex shading and clipping, with only 1 vertex processing unit — when the geometry load is heavy, it is the bottleneck.
- **PP (Pixel Processor)**: responsible for fragment shading and rasterization, with a throughput of about 1 pixel/clock. At 500MHz the pure fill ceiling is about 500 million pixels/second.

The two stages are connected by the "Tiling" step, which is exactly the biggest difference between it and traditional PC graphics cards.

# TBDR: Bookkeeping First, Drawing All at Once Later

A traditional PC graphics card (IMR, immediate rendering) rasterizes a triangle the moment it arrives, and depth testing requires a round trip to DDR for every pixel to read the depth value, consuming enormous bandwidth. Mali-400 rendering happens in two passes:

1. **Geometry pass**: the GP only computes vertices and performs clipping, then does not draw — it registers each triangle into the list of the 16×16 tiles it covers.
2. **Pixel pass**: process tile by tile. Take out all the triangles involved in that tile, place the depth buffer and color buffer directly in the chip's internal high-speed storage to complete the computation, and write everything back to DDR in one go only after the whole tile is computed (on encountering resolve/flush).

For mobile SoCs with no dedicated video memory that compete with the CPU for DDR bandwidth, this bandwidth-saving design is a survival necessity. The cost is that "reading back intermediate results" is inherently unfriendly in the hardware contract.

# The Empirically Established DDK Contract

The following behaviors were established by measurement on the Mali-400 DDK (Android variant driver) of the SC9832A:

1. **glReadPixels readback from an FBO is always 0**: before the tiles are resolved, frame data exists only in the on-chip buffer, and this DDK's FBO readback path is effectively nonexistent — readback is 0 after glClear, and readback is also 0 after a real draw.
2. **glClear takes a special path**: in TBDR, clear only sets initial values for the tiles and can avoid touching memory entirely, taking effect only when the data is written back. Reading the memory midway naturally yields nothing.
3. **Readback after a real draw on a pbuffer surface is normal**: the pbuffer follows the driver's complete resolve swap path, so the data can land in memory.
4. **Feeding a bare framebuffer struct to eglCreateWindowSurface causes a segmentation fault**: this DDK is an Android ANativeWindow variant that depends on the buffer queue's dequeue/queue mechanism, and a bare fbdev window cannot support this process.

# Implications for Practical Development

- To extract what the GPU has drawn, do not use FBO readback; let the rendering land on a surface with a complete resolve path, such as a pbuffer/window surface, and read from there.
- For a "black screen", first distinguish three cases: nothing was rendered, readback failed, or page flipping failed — counting the non-zero pixel ratio of each framebuffer page is far more reliable than eyeballing screenshots.
- Check the geometry first for performance bottlenecks: the GP has only one vertex unit, so scenes with heavy vertex loads (such as an emulator's scaling pipeline) easily get stuck at the GP rather than the PP.

---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
