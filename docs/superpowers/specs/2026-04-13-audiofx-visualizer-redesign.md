# AudioFX Visualizer Redesign

**Date:** 2026-04-13  
**Scope:** Visualizer section of the AudioFX panel only  
**File:** `src/Morphology.jsx`

---

## Overview

Replace the current single-mode cymatics visualizer (one mode active at a time, shared global controls) with 10 individual EnginesFX-style cards — one per visualizer mode. Multiple cards can be active simultaneously and composite together via a proper canvas layering pipeline.

---

## Card Structure

10 individual **200×200px cards** displayed in a scrollable horizontal row, matching the EnginesFX card visual language exactly.

### Front Face

- **Full-bleed live canvas** — the visualizer output is the card background. Animates in real time when active; dim/static when inactive.
- **Top overlay** — active glow dot + mode name label + collapse button (⊞)
- **Bottom bar** — ON/OFF toggle + active blend mode label
- **Active state** — colored border (1.5px) + box-shadow glow matching mode accent color + `inset 0 0 0 1px {color}22`
- **Inactive state** — `#27272a` border, `0 0 10px rgba(0,0,0,0.5)` shadow, canvas dimmed to ~20% opacity

### Back Face (flip on ⊞)

- Animated mini-strip header (same as EnginesFX back panels, height ~68px)
- Blend mode selector row (pill buttons): **Screen · Add · Overlay · Source-over · Multiply · Lighter**
- Per-mode signal + render controls (see Per-Card Controls section)
- Collapse button (⊟) to flip back

### Accent Colors

| Mode | Color |
|------|-------|
| VScope | Cyan `#22d3ee` |
| Polar | Sky `#67e8f9` |
| 3D Wave | Blue `#3b82f6` |
| Phosphor | Green `#22c55e` |
| Spectral Orbit | Purple `#a855f7` |
| Particles | Amber `#f59e0b` |
| Differential | Orange `#f97316` |
| Fractal | Pink `#ec4899` |
| Neural | Emerald `#10b981` |
| Shard | Red `#ef4444` |

---

## Compositing Pipeline

Each active card renders its visualizer to its own **offscreen `OffscreenCanvas`** (or regular canvas), then composites onto a single shared output canvas in left-to-right card order using `ctx.globalCompositeOperation`.

This replaces the current approach where CSS blend modes had no real effect on canvas output.

**Render order:**
1. Clear shared output canvas
2. For each active card (left to right):
   - Run that mode's draw function onto its offscreen canvas
   - Set `ctx.globalCompositeOperation = card.blend`
   - `outputCtx.drawImage(offscreenCanvas, 0, 0)`
3. Display shared output canvas in the UI

**Available blend modes per card:** `screen`, `lighter`, `overlay`, `multiply`, `source-over`, `add` (via `lighter`)

---

## Per-Card Controls (Back Face)

Each card back is a full independent rewrite. Shared signal controls are duplicated per card so each layer responds to audio independently. Render controls are trimmed to the 3–5 most useful for that mode.

| Mode | Signal Controls | Render Controls |
|------|----------------|-----------------|
| VScope | Sensitivity, Smoothing, Intensity | Line style (Line/Thick/Fill), Mirror, Glow |
| Polar | Sensitivity, Smoothing, Intensity | Line style, Mirror, Glow |
| 3D Wave | Sensitivity, Smoothing, Depth | Line style, Grid, Glow |
| Phosphor | Sensitivity, Smoothing, Persistence | Glow intensity, Invert |
| Spectral Orbit | Sensitivity, Freq window, Smooth | Orbit speed, Trail length, Glow |
| Particles | Sensitivity, Intensity | Count, Size, Decay, Glow |
| Differential | Sensitivity, Smoothing | Line style, Glow, Invert |
| Fractal | Sensitivity, Intensity | Iterations, Glow |
| Neural | Sensitivity, Intensity | Node size, Edge opacity, Glow |
| Shard | Sensitivity, Intensity | Shard count, Glow, Invert |

---

## State Architecture

The current shared cymatics state (`cyMode`, `cySens`, `cySmooth`, etc.) is replaced with an array of 10 independent card config objects.

```js
const DEFAULT_SCOPE_CARD = (id, color) => ({
  id,
  color,
  enabled: false,
  flipped: false,     // false = front face, true = back face (controls)
  blend: 'screen',
  sens: 0.7,
  smooth: 0.5,
  intensity: 0.7,
  // mode-specific extras added per card
});

const [scopeCards, setScopeCards] = useState([
  { ...DEFAULT_SCOPE_CARD('vscope',    '#22d3ee'), lineStyle: 'line', mirror: false, glow: true },
  { ...DEFAULT_SCOPE_CARD('polar',     '#67e8f9'), lineStyle: 'line', mirror: false, glow: true },
  { ...DEFAULT_SCOPE_CARD('wave3d',    '#3b82f6'), depth: 0.5, grid: false, glow: true },
  { ...DEFAULT_SCOPE_CARD('phosphor',  '#22c55e'), persistence: 0.7, glowAmt: 0.8, invert: false },
  { ...DEFAULT_SCOPE_CARD('spectral',  '#a855f7'), freqWindow: [0,1], orbitSpeed: 0.5, trailLen: 0.5, glow: true },
  { ...DEFAULT_SCOPE_CARD('particles', '#f59e0b'), count: 0.5, size: 0.5, decay: 0.5, glow: true },
  { ...DEFAULT_SCOPE_CARD('diff',      '#f97316'), lineStyle: 'line', glow: true, invert: false },
  { ...DEFAULT_SCOPE_CARD('fractal',   '#ec4899'), iterations: 0.5, glow: true },
  { ...DEFAULT_SCOPE_CARD('neural',    '#10b981'), nodeSize: 0.5, edgeOpacity: 0.5, glow: true },
  { ...DEFAULT_SCOPE_CARD('shard',     '#ef4444'), shardCount: 0.5, glow: true, invert: false },
]);
```

A helper `setScopeCard(id, patch)` merges partial updates into the array.

Each card also gets its own `useRef` offscreen canvas for rendering.

---

## What Is Removed

- `cyMode` state (single active mode integer)
- `isCymatic` boolean (replaced by per-card `enabled`)
- Shared `cySens`, `cySmooth`, `cyIntensity`, `cyBlend`, `cyMirror`, `cyGlow`, `cyInvert`, `cyGrid` state
- `cyLufsWindow`, `cyXoverSL`, `cyXoverLM`, `cyXoverMH` remain in the Input section (unchanged)
- Current cymatics JSX block (Column 3) — fully replaced

## What Is Preserved

- All audio analysis logic (`tickAudio`, analyser, band extraction, LUFS, beat detection) — untouched
- Input/Levels/BPM section (Column 1) — untouched
- LFO Bank + Mod Matrix (Column 2) — untouched
- `audBusRef` data contract — cards read from it the same way the old cymatics did

---

## Verification

1. `npm run lint` — zero errors
2. `npm run dev` — app loads, splash screen appears, no console errors
3. Enable VScope card — live waveform appears in card background
4. Enable Polar card simultaneously — both render and composite correctly
5. Change blend mode on Polar — compositing updates visually
6. Flip any card — back face shows correct trimmed controls
7. Adjust per-card sensitivity — only that card's response changes
8. Disable all cards — output canvas clears cleanly
