# Visualizer Redesign — Removed & Missing Features

**Date:** 2026-04-13  
**Context:** Features present in the old single-mode cymatics system (on `main`) that are absent or reduced in the new 10-card scope card system (on `audiofx-visualizer-redesign`).

---

## 1. Engine Links (Removed)

### Eng Xform (cySymLink)
- **What it did:** Linked the EnginesFX Transform module (zoom + rotation) to the visualizer. When enabled, the scope canvas inherited the engine's zoom level and rotation angle, so the visualizer spun and zoomed in sync with the morph engine.
- **How it worked:** `scopeZ = EngFX zoom * manual scope zoom`, `totalRot = motor spin angle + manual scope rot + auto-spin`. Post-rotation (wheel/offset) applied as a separate canvas transform.
- **Status:** Fully removed. No per-card equivalent.

### Symmetry Apply (cySymApply)
- **What it did:** Applied the EnginesFX Symmetry module to the visualizer output. The visualizer trace was duplicated into N-fold rotational copies (2-fold mirror, 3-fold, 4-fold, 6-fold, 8-fold, 12-fold) matching the currently active symmetry type.
- **How it worked:** After drawing, the source canvas was composited into a symmetry canvas with rotated copies. X-mirror, Y-mirror, and N-fold rotational modes were all supported.
- **Status:** Fully removed. No per-card equivalent.

### Hide Source (cySymHide)
- **What it did:** When symmetry was applied, this hid the raw visualizer trace and showed only the symmetry copies. Created clean kaleidoscopic patterns without the underlying Lissajous.
- **Status:** Fully removed (depended on cySymApply).

---

## 2. Transform Controls (Removed)

### Scope Zoom (cyScopeZoom)
- **What it did:** Independent zoom for the visualizer canvas, 0.2× to 4.0×. Scaled the entire trace up or down without affecting the morph engine.
- **Status:** Removed. No per-card equivalent.

### Scope Rotation (cyScopeRot)
- **What it did:** Manual rotation of the visualizer canvas in degrees (0–360°). The entire trace rotated around the canvas center.
- **Status:** Removed. No per-card equivalent.

### Auto-Spin (cySpinRate)
- **What it did:** Continuous automatic rotation of the visualizer. Accumulated angle over time, creating a spinning Lissajous effect. Rate 0–100%.
- **How it worked:** `cySpinRef.current += cySpinRate * 0.002` per frame.
- **Status:** Removed. No per-card equivalent.

### Barrel Warp (cyWarpAmt)
- **What it did:** Barrel/pincushion distortion applied to all plotted points. Bent the vectorscope trace into a fishbowl or pinched shape.
- **How it worked:** `warpPt()` helper applied radial distortion: `r_new = r * (1 + warp * r²)`.
- **Modes affected:** VScope, Polar, Phosphor, Spectral, Differential, Shard.
- **Status:** Removed. No per-card equivalent.

---

## 3. Signal Processing Controls (Removed or Reduced)

### Auto-Gain (cyAutoGain)
- **What it did:** Tracked a running peak amplitude and auto-normalized the waveform so quiet audio still produced visible traces. Running EMA with cap at 12×.
- **How it worked:** `cyAutoGainRef.current = prev * 0.985 + (1/rawPeak) * 0.015`.
- **Status:** Removed. Cards use fixed `sens * intensity` gain. Quiet audio may produce very small traces.

### Stereo Width (cyStereoWidth)
- **What it did:** Controlled the simulated stereo spread (0–100%). At 0% the L and R channels were identical (mono = 45° diagonal). At 100% maximum separation with subtle noise added.
- **How it worked:** `wL = raw * (1 - sw*0.5) + delayed * sw*0.5`, `wR = raw * (1 - sw*0.5) - delayed * sw*0.5 + noise`.
- **Status:** Removed. Cards use a fixed 90° phase offset pseudo-stereo (`_stereo` helper) with no user control over width.

### Phase Offset (cyPhaseOff)
- **What it did:** Controlled the phase delay between L and R channels (0–360°). At 90° (default 0.25) created the classic circular Lissajous. Different angles created different Bowditch curve shapes.
- **Status:** Removed. Cards use a hardcoded 90° offset.

### X/Y Swap (cyXYSwap)
- **What it did:** Swapped the X and Y axes of the vectorscope, rotating the Lissajous 90°.
- **Status:** Removed.

### Frequency Bands (cyFreqBands)
- **What it did:** Layered 1–4 simultaneous Lissajous traces at staggered phase offsets (0°, 45°, 90°, 135°). Each band had different color and opacity, creating complex Bowditch/figure-8 shapes.
- **Modes affected:** VScope, Polar, Differential.
- **Status:** Removed. Cards draw a single band.

---

## 4. Visual Style Controls (Removed or Reduced)

### Trails / Persistence Amount (cyTrails)
- **What it did:** Controlled how quickly the persistence canvas faded. At 0% = no trails (instant clear). At 99% = very long glowing trails. Default 30%.
- **Status:** Partially present. Cards use a hardcoded `pX.globalAlpha = 0.15` fade per frame. No user-adjustable slider. The `persistence` control on Phosphor cards is separate and only affects that mode.

### Zoom-Shrink Decay (cyDecay)
- **What it did:** Each frame the persistence canvas zoomed slightly toward center, creating a "shrink into center" fade instead of a flat trail fade. Combined with trails for spiral decay effects.
- **How it worked:** `decayScale = 1 - decay * 0.015` applied as a canvas scale transform per frame.
- **Modes affected:** VScope, Polar, Phosphor, Spectral, Differential, Fractal, Neural, Shard.
- **Status:** Fully removed.

### Render Mode (cyRender)
- **What it did:** Global render style — Line, Dots, Thick, Filled. Dots rendered individual sample points. Filled drew a closed polygon underneath the line trace.
- **Status:** Partially mapped. Cards have `lineStyle: 'line' | 'thick' | 'fill'`, but **Dots/Point mode is missing**. Only VScope, Polar, and Differential cards expose this control.

### Glow Amount (cyGlowAmt)
- **What it did:** Controlled the shadow blur radius multiplier (0–100%). At 0% glow was off. At 100% = 2.5× base blur. Applied globally to all shadow operations.
- **Status:** Partially present. Cards have a binary `glow` toggle but no amount slider (except Phosphor which has `glowAmt`). The glow amount is not adjustable for most modes.

### Color Picker + Color Modes (cyColor, cyColorMode)
- **What it did:** Custom hex color picker + 4 color modes:
  - **Fixed:** Single user-chosen color
  - **Rainbow:** Hue cycles 0–300° across the trace length
  - **Spectrum:** Hue maps inversely from waveform position (blue→red)
  - **Source:** Samples pixel color from the morph engine canvas at corresponding positions
- **Status:** Removed. Cards use a fixed accent color per mode (cyan for VScope, sky for Polar, etc.). The `_col` helper provides slight hue variation but there's no user-selectable color or color mode.

### Gridlines (cyGridlines)
- **What it did:** Showed a vectorscope graticule overlay — crosshairs, concentric circles at 25/50/75/100%, and diagonal lines. Alpha-capped to prevent accumulation with trails.
- **Status:** Partially present. Only the 3D Waterfall card has a `grid` toggle (horizontal lines). No other modes have a grid option.

### Invert (cyInvert)
- **What it did:** Applied a difference-blend white fill to invert all drawn content. White background with dark traces instead of dark background with light traces.
- **Status:** Partially present. Only Differential and Shard cards have an `invert` toggle. Missing from all other modes.

### Noise (cyNoise)
- **What it did:** Added a noise texture overlay to the visualizer output.
- **Modes affected:** VScope, Polar, Phosphor, Spectral, Differential, Shard.
- **Status:** Fully removed.

---

## 5. Post-Processing (Removed)

### Post-Rotation
- **What it did:** After compositing the visualizer onto the main canvas, a secondary rotation was applied. For 3D Waterfall (mode 2) this was applied after symmetry so the entire waterfall + symmetry copies spun together.
- **Status:** Removed. No post-composite rotation.

### Symmetry Compositing
- **What it did:** After mode-specific drawing, the persistence or clear canvas was composited through the symmetry engine (if cySymApply was on). This created complex kaleidoscopic patterns from any mode.
- **Status:** Removed.

---

## 6. Modes Removed Entirely

### Quantum Foam / Fabric (mode 11)
- **What it was:** Listed in comments as mode 11. Had dedicated state: `cyFoamSpeed`, `cyFoamScale`, `cyFoamLayers`, `cyFoamFlow`, `cyFoamThresh`, `cyFoamBlend`. Rendered without audio.
- **Status:** No drawing code existed on `main` for this mode (only the state variables and UI controls). Not ported.

### Chromatic Rings (mode 7 label)
- **What it was:** The comment said mode 7 was "Chromatic Rings" but the actual code was the Fractal Engine with 5 sub-styles. The Chromatic Rings mode may have been renamed or merged.
- **Status:** Fractal Engine was ported. If Chromatic Rings was a distinct visual, it no longer exists.

---

## 7. UI/UX Differences

### Global vs Per-Card Controls
- **Old:** One set of shared controls affected whichever single mode was active. Controls were contextually dimmed based on which mode was selected.
- **New:** Each card has its own independent controls on the back face. Controls are trimmed to what's relevant per mode. But many controls from the old system were not carried over (see sections above).

### Single vs Multi-Mode
- **Old:** Only one mode active at a time. Global blend mode affected how the single mode composited onto the morph canvas.
- **New:** Multiple cards active simultaneously, each with its own blend mode. Cards composite left-to-right onto a shared output canvas, then that composites onto the main canvas via `screen` blend.

### Fill Mode (cyFill)
- **Old:** Separate toggle from render mode. Could have line + fill simultaneously.
- **New:** `lineStyle: 'fill'` replaces line with fill. Can't have both simultaneously.

---

## Summary — Priority Restore List

| Feature | Complexity | Impact |
|---------|-----------|--------|
| Trails slider (per card) | Low | High — currently hardcoded, was the most-used style control |
| Color picker + modes | Medium | High — every mode currently locked to one accent color |
| Auto-Gain toggle | Low | Medium — quiet audio produces barely visible traces |
| Stereo Width slider | Low | Medium — affects Lissajous shape character significantly |
| Phase Offset slider | Low | Medium — changes Lissajous curve shape |
| Scope Zoom (per card) | Low | Medium — no way to zoom traces |
| Glow Amount slider | Low | Low-Medium — binary on/off is limiting |
| Eng Xform link | Medium | Medium — sync with morph engine was a key creative feature |
| Symmetry Apply | High | High — the kaleidoscopic compositing was visually spectacular |
| Auto-Spin | Low | Low — easy to add, fun but not essential |
| Barrel Warp | Low | Low — niche but distinctive |
| Zoom-Shrink Decay | Medium | Low — niche spiral effect |
| Frequency Bands | Medium | Low — multi-band layering was subtle |
| Gridlines | Low | Low — reference overlay |
| Noise | Low | Low — texture effect |
| Invert (all modes) | Low | Low — niche |
