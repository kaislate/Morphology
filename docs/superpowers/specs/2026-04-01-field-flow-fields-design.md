# Field Module — Flow Fields Design

**Date:** 2026-04-01  
**Status:** Approved

## Overview

Convert all Field module modes (except Wind, mode 4) from point-force mechanics to proper flow fields. Each mode derives a flow angle `θ` at every particle position and steps by `cos(θ)*fMag*0.12, sin(θ)*fMag*0.12` — identical to how Wind (mode 4) already works. Time `t` drives wave animation in every mode.

## Approach

Option A — pure angle-based flow fields. No shared noise layer. Each mode has one `θ` formula encoding its characteristic shape, plus a sin-based time term for the wavy flowing motion.

## Mode Designs

### Mode 0 — Gravity (inward spiral streams)
```
cx = curX - fwx, cy = curY - fwy, dist = sqrt(cx²+cy²)||1
θ = atan2(-cy, -cx) - 0.4 + sin(t*0.45 + dist*0.014) * 0.45
step: cos(θ)*fMag*0.12, sin(θ)*fMag*0.12
```
Points toward center, offset -0.4 rad for CW spiral. Sin wave makes streams pulse inward.

### Mode 1 — Repulsor (outward spiral streams)
```
cx = curX - fwx, cy = curY - fwy, dist = sqrt(cx²+cy²)||1
θ = atan2(cy, cx) + 0.4 + sin(t*0.45 + dist*0.014) * 0.45
step: cos(θ)*fMag*0.12, sin(θ)*fMag*0.12
```
Mirror of Gravity — outward CCW spiral, pulsing outward.

### Mode 2 — Dipole (iron-filings flow)
```
ph = t*0.22, sep = DIMENSION*0.15
p1 = (fwx + cos(ph)*sep, fwy + sin(ph)*sep)   // + pole (source)
p2 = (fwx - cos(ph)*sep, fwy - sin(ph)*sep)   // - pole (sink)
d1x = curX-p1x, d1y = curY-p1y, d1 = mag||1
d2x = curX-p2x, d2y = curY-p2y, d2 = mag||1
netFx = d1x/d1² - d2x/d2²
netFy = d1y/d1² - d2y/d2²
θ = atan2(netFy, netFx) + sin(t*0.3 + dist*0.01) * 0.35
step: cos(θ)*fMag*0.12, sin(θ)*fMag*0.12
```
Particles trace classic figure-8 looping field lines, animated by rotating poles.

### Mode 3 — Attractor Web (9-vortex swirl field)
```
9 grid vortices at (gSize*(gx+0.5) + cos(t*0.5+offset)*10, ...)
For each vortex i at (nx, ny):
  cx_i = curX-nx, cy_i = curY-ny, d_i = mag||1
  sumFx += -cy_i / (d_i*d_i)   // CCW tangential
  sumFy +=  cx_i / (d_i*d_i)
θ = atan2(sumFy, sumFx) + sin(t*0.35) * 0.3
step: cos(θ)*fMag*0.12, sin(θ)*fMag*0.12
```
Particles flow in interlocking circular streams between vortex centers.

### Mode 4 — Wind (unchanged)
Existing Perlin-like flow field — no changes.

### Mode 5 — Orbital (concentric ring streams)
```
cx = curX - fwx, cy = curY - fwy, dist = sqrt(cx²+cy²)||1
θ = atan2(cy, cx) + PI/2 + sin(dist*0.022 + t*0.7) * 0.5
step: cos(θ)*fMag*0.12, sin(θ)*fMag*0.12
```
Pure tangential — particles orbit in rings. Sin term makes alternating rings pulse.

## Changes

- Replace the entire body of each mode branch (0,1,2,3,5) inside the `if(rc.isField)` block in `src/Morphology.jsx` (around line 3625–3664)
- Remove old `sp`, `breathe`, `radial`, `f1/f2` force variables
- Well drift (`wx/wy` offset) removed from modes 0 and 1 — the sin wave term provides equivalent animation
- Step magnitude `fMag*0.12` matches Wind exactly

## Out of Scope

- No changes to UI labels, mode count, or controls
- No changes to Wind (mode 4)
- No changes to `fMag`, `fieldX/Y`, or any other field state
