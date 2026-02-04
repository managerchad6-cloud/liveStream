# Performance Analysis & Findings

## Current Architecture Costs

### Per-Frame Cost Breakdown

| Operation | When it runs | Cost |
|-----------|-------------|------|
| Audio chunk | Every frame | ~0ms (pre-computed buffer slice) |
| Lip sync analysis | Every frame during speech | ~0.1ms (RMS + ZCR math) |
| Cached identical frame | Every idle frame | ~0ms (return buffer) |
| Character state change | Mouth/blink change | ~200ms (1 Sharp pipeline)* |
| TV content | Every frame when TV is on | ~200ms (adds 2nd Sharp pipeline)* |
| Lighting/emission blend | Only on settings change | Baked into static base at startup |
| Caption SVG | When caption is active | Folded into existing pipeline, ~free |

*\*These times are inflated by 90% CPU steal on current VPS. On dedicated hardware, expect ~15-25ms per pipeline.*

### Key Insight

The expensive operation is always **a Sharp pipeline** — any call to `sharp(buffer).composite(...).jpeg().toBuffer()` costs ~200ms on the current VPS (~15-25ms on honest hardware). The actual compositing (overlaying PNGs with blend modes) is cheap; the cost is JPEG decode + encode + vips pipeline setup.

### Workload Scenarios

| Scenario | Pipelines/frame | Cache hit rate | Notes |
|----------|-----------------|----------------|-------|
| Idle stream (no speech, no TV) | 0 | 100% | Runs fine anywhere |
| Speech only (lip sync) | ~0.3-0.5 avg | ~70% | Pipeline on mouth change (every 2-3 frames) |
| TV playing (video) | 1 | 0% | Every frame has new TV content, no caching possible |
| TV + speech | 1-2 | 0% | Most demanding scenario |

**TV content is the most demanding feature** — it forces a full decode+composite+encode every frame because the video content changes continuously.

---

## Current VPS Issue

### CPU Steal Time

```
%Cpu(s):  7.2 us,  1.4 sy,  0.0 ni,  0.0 id,  0.0 wa,  0.0 hi,  0.0 si, 91.3 st
```

The current VPS has **90% CPU steal time** — the hypervisor is giving other VMs 90% of the CPU cycles. The 3.25 GHz AMD EPYC cores are effectively running at ~300 MHz.

This is why:
- JPEG decode+encode takes 190ms instead of ~10ms
- FFmpeg encodes at 7.5fps instead of ~100fps
- Stream latency grows unbounded during speech

---

## Target Specifications

| Parameter | Target | Current |
|-----------|--------|---------|
| Resolution | 1920x1080 | 1280x720 |
| Framerate | 30 fps | 15 fps |
| Latency | < 5 seconds | 30-60 seconds |
| Stream codec | H.264 | H.264 |

### Budget Calculation for 1080p30

At 30fps with 5s latency target:
- Frame budget: **33ms per frame**
- With TV on: Need 1 Sharp pipeline (composite) + FFmpeg encode per frame
- Required pipeline speed: < 20ms (leaves 13ms for encode + overhead)

### Hardware Requirements

For 1080p30 with TV content:

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| vCPUs | 4 dedicated | 8 dedicated |
| RAM | 8 GB | 16 GB |
| CPU steal | < 5% | < 1% |

**Critical: Must be dedicated/guaranteed CPU, not shared/burstable.**

### Recommended VPS Providers (Dedicated CPU)

- **Hetzner** — Dedicated vCPU plans, ~$15-30/mo for 4-8 cores
- **OVH** — Dedicated CPU instances
- **Linode/Akamai** — Dedicated CPU plans
- **Vultr** — Dedicated cloud compute
- **DigitalOcean** — CPU-Optimized droplets

---

## Code Optimizations Completed

1. **Compositor consolidation**: 5 Sharp pipelines → 1 per frame
2. **Frame caching**: Identical frames return cached JPEG (0 pipelines)
3. **Character state cache**: Mouth/blink combinations pre-rendered as JPEG
4. **Baked lighting**: Emission layers + lights composited into static base at startup
5. **Unified render loop**: Eliminated CPU spin loop (setImmediate → single setTimeout)
6. **Pre-computed audio**: Full audio resampled at load time, per-frame is just a buffer slice
7. **Last-frame repeat**: FFmpeg starvation prevented by repeating last frame on underrun
8. **Sharp concurrency**: Set to 2 (was defaulting to 1)

### Results on Current VPS

- Node.js CPU: 38% → 9.3%
- Unique frame render rate: 0.75fps → 15fps (when not steal-limited)
- Cache hit rate on idle: 100%

---

## Future Optimizations (If Needed)

### If 1080p30 is still not achievable on dedicated hardware:

1. **GPU encoding** — Use NVENC/VA-API instead of libx264 (requires GPU VPS)
2. **WebGL compositing** — Move compositing to GPU via headless Chrome/Puppeteer
3. **Reduce TV frame rate** — Composite TV at 15fps, interpolate or hold frames
4. **Pre-render mouth cache at 1080p** — Cache all mouth/blink combinations at startup
5. **JPEG turbo** — Ensure Sharp is using libjpeg-turbo (it should be, but verify)

### Architectural alternatives:

1. **Split services** — Run compositor on one machine, FFmpeg on another
2. **Hardware encoder** — Dedicated streaming hardware (e.g., Elgato, Blackmagic)
3. **Cloud encoding** — AWS MediaLive, Cloudflare Stream for the HLS encoding step
