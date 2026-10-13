---
title: "Mali400_Feasibility Analysis of Dropping Android"
date: 2026-09-30 18:50:38
lang: en
permalink: en/2026/09/30/mali-02-mali400-md/
search: true
categories:
- 硬件模块打通
- Mali GPU
tag:
- Mali
- GPU
---


# Spreadtrum SC9832A Mali-400 — Feasibility Analysis of Dropping Android

> Goal: assess whether it is possible to drive the Mali-400 GPU **without depending on the Android (bionic) user space at all**.  
> Environment: Alpine/musl (root OS, armv7l) + Spreadtrum SC9832A + kernel 3.10.65.  
> Data source: a read-only probe of the device on 2026-09-30 (uname / lsmod / readelf / strings / mount / find).

---

## 0. One-Sentence Conclusion

**Technically feasible, but there are two routes with vastly different difficulty:**

- **Option ① (closed-source, less effort)**: swap in a set of "Linux-native" Mali user-space libraries (the Linux variant of the same-version Utgard DDK) and remove the bionic dependency. **The difficulty lies in obtaining the matching version of the closed-source DDK**, not in the technology.
- **Option ② (fully open-source, thorough)**: drive the Mali-400 with the **Mesa 24.2.8 + Lima** already installed on the device. **Only the kernel DRM node (`/dev/dri`) is missing**, requiring `lima` + a display DRM driver to be added on 3.10.65 — the largest engineering effort, but it removes Android 100% and eliminates the shim black magic.

> An often-overlooked fact: **`mali.ko` itself is an ARM closed-source kernel blob**. So Option ① is only "non-Android user space"; the kernel still depends on a closed-source module. Only Option ② is fully open-source. Either way, everything is currently stuck on the **kernel-side interface** — the user-space libraries (the bionic set / the mesa set) are, ironically, all in place.

---

## 1. Current Hard Evidence (From the Probe)

| Item | Finding | Meaning |
|---|---|---|
| Kernel | `3.10.65 #13 SMP PREEMPT ... armv7l` | an old vendor kernel |
| GPU node | `/dev/mali0` exists; **`/dev/dri` does not exist** | only the proprietary UDD interface; no DRM |
| Kernel module | `mali.ko` (446KB, loaded); from `vendor/sprd/modules/libgpu/gpu/utgard/...` (`wzp_1.5_0703` BSP) | **a Utgard proprietary blob with no DRM subsystem** |
| DRM subsystem | `/sys/class/drm` does not exist; `cat /proc/filesystems` has no drm | the running kernel was not built with DRM at all |
| Current user space | `/system/lib/libEGL.so`→`/mnt/android_sys/lib/libEGL.so`; interpreter=`/system/bin/linker`; NEEDED=`libcutils/libutils/liblog/libc++.so/libc.so` | **the Android DDK**, linked against bionic HAL libraries |
| bionic source | `/mnt/android_sys` (`/dev/mmcblk0p17`, ext4, the original Android partition **mounted ro**); both `/system/bin/linker` and `/system/lib/libc.so` point to it | the Android user space is entirely external; the root OS is musl |
| Mesa status | `/usr/lib/libGL.so.`<u>`1.2.0`</u>→**Mesa 24.2.8**; both `/usr/lib/xorg/modules/dri/lima_dri.so` and `panfrost_dri.so` exist | **the Lima user space is ready**; only the kernel DRM is missing |
| Kernel build environment | `/lib/modules/3.10.65/build` does not exist; `/usr/src` does not exist; only `/usr/bin/gcc` (host) exists | **kernel modules cannot be compiled in place**; an external BSP source tree is needed |

---

## 2. Three Possible End States for "Dropping Android"

- **Option ① ARM Mali Linux DDK (closed-source user space, non-Android)**: replace the Android `libEGL/libGLESv2` with the **Linux build of the same Utgard DDK** (linked against musl/glibc + `libump`, using fbdev/DRM windows, and **not** depending on `libcutils/libutils/liblog`).
- **Option ② Mesa Lima (fully open-source)**: drive the Mali-400 with the already-installed Mesa + `lima_dri.so`, producing images via standard EGL/GL + DRM/KMS.
- **Option ③ keep the current hybrid bridge** (bionic libraries + `bionic_shim` + musl-gcc `-Wl,--entry=main`): the only thing that currently runs, and it **does not count as dropping Android**.

---

## 3. Layer-by-Layer Feasibility of the Two Routes

### 3.1 Kernel Side (a Shared Prerequisite for Both Routes)

`mali.ko` is a kernel module, independent of libc, and Alpine can `insmod` it as usual. But it provides only `/dev/mali0` (UDD ioctl), and **the Lima user space does not recognize this interface** — Lima wants `drm_lima_*` ioctls (`/dev/dri`). Therefore:

- Option ① keeps `mali.ko` and changes only the user space → **zero kernel-side changes**.
- Option ② must **replace** `mali.ko` with the lima DRM driver → major kernel-side changes.

### 3.2 Option ① Details

- Action: obtain the **Utgard Linux DDK** (containing `libEGL.so`/`libGLESv2.so`/`libump.so`, glibc/musl builds), place it in `/usr/lib`, and delete the `/system` symlinks and `bionic_shim`.
- Window system: the Linux DDK supports **fbdev** (it runs even without DRM), which matches this machine that has only `/dev/fb0`.
- Readback: the Linux DDK's pbuffer/fbdev readback semantics are normal, so **the previous gpu_bench black-screen/stale-red problem will most likely disappear**.
- **Blocker (the only one)**: the user-space DDK and the kernel `mali.ko` must be the **same DDK version** (e.g., r4p0↔r4p0). The module comes from the sprd `wzp_1.5_0703` BSP, so the **corresponding version of the Linux user space** must be extracted from that BSP. ARM stopped publicly distributing the classic Utgard DDK long ago (UMPL license, the final ~2014 r4p0 release), making public acquisition difficult; **if that BSP was packaged with the linux variant, it is a direct hit; otherwise procurement is a hard blocker**.

### 3.3 Option ② Details

- Action: add `drivers/gpu/drm/lima` + a display DRM driver to the kernel (the SPRD display controller, or a dumb DRM wrapper that reuses the existing fb), build it into 3.10.65 and load it to get `/dev/dri/card0`; the user space is already complete (Mesa 24.2.8 + lima).
- Payoff: 100% open-source, standard interfaces, normal `glReadPixels`, and a complete farewell to shim/ctor/TLS/dlsym black magic; the PSP frontend and gpu_bench can both use standard EGL directly.
- **Blocker (the largest)**: upstream lima requires a newer kernel, so **backporting to 3.10.65 is heavy work**; a matching display DRM driver is also needed (this machine's display is currently bare fbdev with no DRM wrapper). **There is no on-device kernel source/build environment**; the SC9832A 3.10.65 BSP source tree must be obtained first.
- Performance: Lima's GLES2 is usable on the Mali-400, but usually slightly slower than the proprietary blob; it is sufficient for benchmarks/demos, and PSP emulation may be slightly slower than with the proprietary frontend.

---

## 4. Key Insights (Easy-to-Trip Pitfalls)

1. **Both routes are stuck on the "kernel-side interface"**: Option ① is stuck on "the matching version of the closed-source user space", and Option ② is stuck on "adding the open-source kernel DRM". The user-space libraries (the bionic set / the mesa set) are, ironically, all in place.
2. **mali.ko is closed-source** → Option ① is only "non-Android user space"; the kernel still depends on the ARM blob; only Option ② is fully open-source.
3. **android_sys can be unmounted**: `/mnt/android_sys` is the ro-mounted original Android partition, needed only by the current Mali stack; after dropping Android, simply do not mount it and delete the `/system` symlinks; the root OS (Alpine/musl) is unaffected.
4. **You cannot "use mesa but keep mali.ko"**: Mesa Lima and the proprietary `mali.ko` use two incompatible kernel UAPIs that cannot be mixed.
5. **You cannot "put a shim around the bionic libEGL to disguise it as Linux"**: it depends on `libcutils/libutils/liblog` (Android HAL: property/hw_get_module/ashmem/binder), and reimplementing these amounts to rewriting the Android HAL — exactly what we want to drop, and it is extremely fragile.

---

## 5. Recommendation and Decision Tree

```
能否从 SC9832A BSP(wzp_1.5_0703) 拿到 同版本 Utgard Linux DDK 用户态?
├─ 能 ──► 方案①：换 .so、去 bionic、fbdev 出图。最省力，顺手解决回读黑屏。
└─ 不能 ─► 想要"真正彻底非安卓"才值得上 方案②：
           取得 3.10.65 BSP 源码 → 加 lima+显示 DRM 驱动 → 编内核 → /dev/dri → Mesa Lima。
           （工程量大，但一劳永逸，且能摘掉所有 shim 黑魔法）
```

**Pragmatic recommendation**: first confirm whether the BSP contains the Linux build of `libEGL/libGLESv2` (it is often placed in a different directory of the same vendor package as the Android build). If it does, go with Option ①, which has the best cost/benefit ratio; if not, and you insist on "completely dropping Android", then invest in Option ②.

---

## 6. Next-Step Minimal Verification (Verification Belongs to the User)

1. **Check whether the BSP contains the Linux build of the Mali user space**: look in `wzp_1.5_0703/idh.code/vendor/sprd/modules/libgpu/` and `out/.../system/lib/` for **non-bionic** builds of `libEGL.so`/`libGLESv2.so` (use readelf to check whether the interpreter is `/system/bin/linker` and whether NEEDED contains `libcutils`).
2. **Probe whether DRM can be added to 3.10.65**: confirm whether the kernel source tree can be obtained; grep for whether `drivers/gpu/drm/lima` or an SPRD display DRM prototype already exists, and assess the backport effort.
3. **Quick falsification**: try running `EGL_PLATFORM=surfaceless` + Mesa in the current environment, and confirm that it fails precisely because `/dev/dri` is missing (verifying the "only DRM is missing" judgment).

---

## Appendix A: What Several Modules in `/lib/modules` Do

| File | Evidence (strings/modinfo) | What it does | Required at runtime |
|---|---|---|---|
| **mali.ko** | `utgard/driver/mali` (sprd `wzp_1.5_0703` BSP) | Mali-400 GPU kernel driver → `/dev/mali0` | ✅ GPU |
| **sprdwl.ko** | `description=SPRD sc2331 Wireless Network Adapter`, `author=jinglong.chen` | Spreadtrum **Wi-Fi** driver (Marlin combo chip) | ✅ Wi-Fi |
| **marlin_fm.ko** | `fm_read_rds_data` / `parse_at_fm_cmd` / `fm_sdio_*` | **FM radio** driver (SDIO/AT) | only when using FM |
| **pskey_bt.txt** | `device_class`/`default_ahb_clk`/`feature_set`/gain power table; "HEX modification, 0x prefix" | **not a driver**: the Bluetooth chip's **PSKEY persistent configuration** (NVM) | when using BT |
| **autotst.ko** | `author=anli.wei`; contains the `sprdfb` string | factory **self-test** module | ❌ debugging |
| **gator.ko** | `gator_get_time` / `ARM1136…ARMv7 Cortex-` | **ARM Streamline** profiling module | ❌ profiling |
| **mmc_test.ko** | `author=Pierre Ossman`, `kernel/drivers/mmc/card/mmc_test.c` | mainline **MMC/SD/eMMC stress-test** module | ❌ burn-in testing |

> marlin_fm / sprdwl / pskey_bt form one set: **Marlin = the Spreadtrum combo connectivity chip (Wi-Fi/Bluetooth/FM/GPS combined)**.

---

## Appendix B: the DRM Name Collision Trap — Android's `/lib/drm` Is Not the GPU's DRM

**Finding**: `/mnt/android_sys/lib/drm/` contains only **`libdrmomaplugin.so`** (the OMA DRM plugin).

**The two DRMs are entirely different things (the easiest way to be led astray during troubleshooting)**:

| Abbreviation | Full name | Domain | Where it is on this machine |
|---|---|---|---|
| **DRM** | **Direct Rendering Manager** | **the kernel GPU/display subsystem**, providing `/dev/dri`, `GEM/TTM` video memory, command submission, and `KMS` mode setting | ❌ not on this machine (no `/dev/dri`) |
| **DRM** | **Digital Rights Management** | **digital rights protection** (encrypted media, OMA/Widevine) | ✅ present on the Android side: `lib/drm/libdrmomaplugin.so`, `libdrmframework.so`, `libdrmdecrypt.so`, `libdrmntp.so` |

**Android really does not use the kernel DRM (Direct Rendering Manager) — the evidence chain:**

1. No `/dev/dri` and no `/sys/class/drm`; the kernel was not built with DRM at all;
2. Graphics go through **HAL substitutes**: `gralloc.sc8830.so` (video memory allocation, **replacing GEM**) + `hwcomposer.sc8830.so` (display composition, **replacing KMS**);
3. Mali exposes only **`/dev/mali0`** (the proprietary UDD ioctl), not `/dev/dri`;
4. The Android side has **no** generic `libdrm.so` (the GPU version), only `libdrmframework*.so` (the rights version);
5. The system is **Android 6.0 (MRA58K)**, an old-style vendor HAL model (far predating Treble, so using mainline DRM is even less likely).
6. Counter-evidence: the GPU version of libdrm exists only on the Alpine/mesa side (`/usr/lib/libdrm_intel.so.1`, an Intel target that likewise needs a DRM node to be useful).

**Conclusion**: finding `/lib/drm` does **not** mean Android uses the kernel DRM; it is purely an abbreviation collision. Precisely because Android bypasses DRM with gralloc+hwcomposer+`/dev/mali0`, the ready-made Mesa Lima has no `/dev/dri` to use, and Option ② must first add a DRM driver on 3.10.65. This is also one of the root causes of "dropping Android" being stuck on the kernel side.

### Addendum: the Similarly Named Files Under `/mnt/android_sys/vendor/lib` Are Also All Digital Rights

Extracted symbols confirm this (all are Google **Widevine** / **MediaDrm** content decryption, unrelated to the GPU):

| File | Extracted symbols | True identity |
|---|---|---|
| `libwvm.so` | `android::DrmManagerClient::decrypt` / `DecryptHandle` | the Android DRM framework client |
| `libwvdrm_L3.so` | `WidevineMediaKit::Component::HandleStreamInfoSource` | **Widevine L3** (software-level rights) |
| `libWVStreamControlAPI_L3.so` | `WidevineMediaKit::MemoryChunk` | the Widevine stream-control API L3 |
| `vendor/lib/drm/libdrmwvmplugin.so` | `android::DrmConstraints` | an old Android DRM plugin (WVM) |
| `vendor/lib/mediadrm/libdrmclearkeyplugin.so` | `clearkeydrm::AesCtrDecryptor`, `createDrmFactory` | the **MediaDrm** ClearKey plugin |
| `vendor/lib/mediadrm/libwvdrmengine.so` | `wvdrm::getCDM` | the **MediaDrm** Widevine engine |
| `vendor/lib/libbt-vendor.so` | `sprd_bt_power_ctrl`, `bt_vendor_cbacks` | the Spreadtrum **Bluetooth** vendor HAL |

> **Identification rule of thumb**: on the Android side, anything with `drm` in its name (`libdrmframework / libdrmdecrypt / libdrmwvmplugin / mediadrm / libwvdrm*`) is **always digital rights/media decryption**.
> **Names that are truly GPU-related never contain drm**: the user space is `libEGL.so` / `libGLESv2.so` / `libGLESv1_CM.so`, the HAL is `gralloc.sc8830.so` + `hwcomposer.sc8830.so`, and the kernel is `mali.ko`.
---

> **Copyright**: This article is an original work by whiteleibniz (organized with AI assistance). All rights reserved. Please credit the source and keep the original link: https://whiteleibniz.github.io
