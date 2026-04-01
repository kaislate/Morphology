# Morphology — Project Overview

## What This Is

**Morphology** is a real-time pixel-art morphing tool built as a single-page React app. The centerpiece is a 300×300 canvas that animates a particle-by-particle morph between two source images (A → B). Every pixel in Image A travels to its luminance-matched position in Image B over a configurable duration, with a large suite of visual effects, audio reactivity, and animation modules layered on top.

The project name on-screen is **Pixel Alchemist**.

---

## Repository Layout

```
Morphology/
├── src/                        ← Active Vite/React app (main project)
│   ├── PixelAlchemist.jsx      ← Entire application (~460 KB, ~6000+ lines)
│   ├── App.jsx                 ← Thin wrapper: just renders <PixelAlchemist />
│   ├── main.jsx                ← React root entry point
│   ├── index.css               ← Single line: @import "tailwindcss"
│   ├── ZApp.build.jsx          ← Older alternate version (not imported, kept as reference)
│   ├── server.back.js          ← Standalone static server for serving /dist
│   └── assets/
│       ├── morphology_logo.gif
│       └── react.svg
├── my-next-app/                ← Separate Next.js 16 app (Cloudflare deployment scaffold)
│   └── src/app/page.tsx        ← Default Next.js starter page (not connected to PA)
├── OLD PA files/               ← ~30 archived versions of PixelAlchemist (v712–v740+)
├── src.worktrees/              ← Leftover git worktrees from Copilot sessions (Feb 2026)
├── dist/                       ← Vite build output
├── package.json                ← name: "morphology", React 18, Vite 6, Tailwind 4
├── vite.config.js
└── eslint.config.js
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | React 18.3 (Vite 6) |
| Styling | Tailwind CSS 4 (via `@tailwindcss/vite` plugin) |
| Canvas rendering | Native Canvas 2D API (no WebGL) |
| Audio | Web Audio API (`AudioContext`, `AnalyserNode`) |
| Build | Vite 6 + `@vitejs/plugin-react` (Babel) |
| Deployment option | `my-next-app` targets Cloudflare Workers via OpenNext |

---

## Core Architecture: PixelAlchemist.jsx

The entire application lives in one massive component file. It is deliberately monolithic — all state, all rendering logic, all sub-components, and all utility functions are co-located.

### Module-level helpers (before the main component)

| Function / Constant | Purpose |
|---|---|
| `encodeGIF(frames, w, h)` | Pure-JS GIF89a encoder with LZW compression — no server, no workers |
| `buildTextMask(phrase, opts)` | Renders text onto a canvas, returns `{x,y}[]` of lit pixels for the Glyph mask |
| `applyPreset(type, size)` | Generates procedural source images: noise, gradient, checker, stripes, radial, sine |
| `drawEngineCard(ctx, t, id, ...)` | Draws animated preview art for each engine module's collapsed card |
| `I` (icon object) | Inline SVG icon components (Upload, Zap, Flame, Film, etc.) |

### Sub-components (module-level, stable references)

| Component | Role |
|---|---|
| `GlobalStyles` | Injects CSS for glow classes, slider thumb styles, keyframe animations |
| `FSlider` | Filled-track range slider; extended with LFO bracket handles when `lfoRange` is provided |
| `BracketSlider` | Two-handle bracket slider (used by A/B split margin card) |
| `RangeSlider` | Dual-thumb range slider (used by frequency window in audio section) |
| `SectionLabel` | Styled section header with accent border and divider line |
| `ModuleCollapsedCard` | 200×200px animated card for each engine module in collapsed state |
| `EngineFlipCard` | CSS 3D flip card — front = collapsed card, back = full module controls |
| `DraggableEngineGrid` | Drag-to-reorder grid for the 11 engine module cards |
| `LfoWave` | Small animated waveform preview for each LFO |
| `CoreParamCard` | Primary parameter card (Duration, Density, Point Size, etc.) |
| `FXPreview` | Mini canvas preview for each post-FX module |
| `GifConverter` | Self-contained WebM → GIF converter UI |
| `RotWheel` | Circular drag wheel for manual pre/post rotation angle |
| `CoreKnob` | Labeled slider widget for core params |

---

## Main Component State (PixelAlchemist)

The main component has ~150+ state variables organized into logical groups:

### Source Images
- `imageA` / `imageB` — data URLs for source images
- `statsA` / `statsB` — per-image color stats (brightness, R/G/B averages)
- `gradeA` / `gradeB` — per-source color grade: hue (°), saturation, brightness
- `undoStack` — array of previous `{imageA, imageB}` states

### Morph Core
- `isMorphing`, `isPaused`, `progress` (0–1)
- `duration` — morph duration in ms (default 3000)
- `isLooping`, `easingEnabled`
- `pixelationMargin`, `splitMargin`, `marginA`, `marginB` — A/B hold margins
- `particleDensity`, `pointSize`, `highRefreshMode`

### Engine Modules (each has `is[Module]` toggle + mode/amount/rate params)
1. **Transform** — pre/post rotation, zoom, BPM boost
2. **Symmetry** — 12 types (X/Y/Tri/Quad/Kaleidoscope/Fan/Radial/Tile/Shard), mask shapes, creative mode
3. **Glyph (Text)** — text particle mask, font size, spacing, outline, LFO modulation, transition time
4. **Entropy** — particle randomization: Walk, Pulse, Drift, Scatter, Magnet, Swarm
5. **Prismatic** — color effect overlay: Burn, Grid, Decay, Solar, RGB, Warp
6. **Flux** — displacement oscillation with 6 modes, BPM sync
7. **Glitch** — 6 digital artifact modes: Slice, Databend, Pixel Sort, Scan Tear, Corrupt, VHS
8. **Retro** — 6 retro overlay modes: Grid Plane, Retro Sun, Synthwave, CRT, Void, Outrun
9. **Warp** — spatial lens distortion: Bulge, Pinch, Ripple, Twist, Mirror Fold, Kaleid Seed
10. **Field** — vector field shaping: Gravity Well, Repulsor, Dipole, Attractor Web, Flow Field, Orbital
11. **ASCII** — character overlay: Braille, Block, Matrix, Typewriter, Morse, Circuit, Runic, NoiseField

### Post-FX (global, applied after all modules)
- Chroma aberration, Vignette, Color Grade (hue/sat/bri)
- Scanlines, Linocut edge detect, Halftone, Smear, Dot Matrix

### Audio Engine
- Web Audio API pipeline: mic → `AnalyserNode` → frequency/waveform data
- Band analysis: Sub Bass / Low / Mid / High (adjustable crossover Hz)
- Beat onset detection with adaptive threshold
- LUFS short-term + integrated measurement
- Cymatics/Vectorscope visualization module (12 modes)

### LFO Bank (4 independent LFOs)
- Shapes: Sine, Triangle, Square, Saw, Reverse Saw, Sample & Hold
- BPM sync with divisor
- Range brackets: lo/hi sweep range per target
- 20 targets: zoom, rotation, postRotation, entropy, fluxAmp, chroma, symPhase, symType, glyphPull, vignette, prismatic, smoke, trails, speed, BPM, flash, warpAmt, fieldAmt, glitchAmt, retroAmt

### Audio Pin Matrix
- 12 sources × 20 targets modulation routing grid
- Sources: Bass, Sub Bass, Low, Mid, High, RMS, Beat, LUFS, LFO 1–4
- Absolute interpolation (lo→hi brackets) when LFO is pinned

---

## Rendering Pipeline

Each `requestAnimationFrame` tick:

1. **Time / BPM tick** — advance `timeRef`, beat flash check
2. **Audio tick** (`tickAudio`) — read analyser, compute bands/RMS/LUFS/beat
3. **LFO tick** — advance phase accumulators, compute output values
4. **Audio mod routing** — write `audModRef` and `lfoAbsRef` from pinned sources
5. **Pre-FX** (optional):
   - Retro layer (Behind)
   - Warp distortion
   - Field vector displacement
6. **Particle render** (`rawCanvas`) — plot each of 90,000 particles at interpolated position
7. **Glyph mask** — mask particles to text shape if enabled
8. **Symmetry** — fold/tile the raw canvas into the output canvas
9. **Post-FX** (in order):
   - Smoke buffer blend
   - Trail buffer blend
   - Retro (During or Front layer)
   - ASCII overlay
   - Chroma aberration
   - Color grade
   - Vignette
   - Scanlines / Linocut / Halftone / Smear / Dot Matrix
   - Cymatics overlay
10. **Popout sync** — mirror canvas to detached popup window

---

## GIF Export Flow

1. User starts a morph, clicks Record
2. `MediaRecorder` captures canvas stream to WebM chunks
3. User stops recording → WebM blob saved to disk
4. Optional: `GifConverter` component loads the WebM, seeks frame-by-frame, encodes each frame via `encodeGIF()`, saves as `.gif`

---

## The `my-next-app` Sub-project

A separate Next.js 16 app (scaffolded with `create-next-app`) configured for Cloudflare Workers deployment via `@opennextjs/cloudflare`. Currently contains only the default Next.js starter page — it has **no connection to Pixel Alchemist**. It appears to be a deployment scaffold that was set up but not yet populated with the main app.

---

## Key Constants

| Constant | Value | Meaning |
|---|---|---|
| `DIMENSION` | 300 | Canvas width/height in pixels |
| `ENG_CARD` | 250 | Engine module card size in px |
| Particle count | 90,000 | `DIMENSION × DIMENSION` |

---

## Development

```bash
# Run dev server (Vite app)
cd Morphology
npm run dev

# Build for production
npm run build

# Run built output with static server
node src/server.back.js
```
