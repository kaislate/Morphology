# Field Modes Redesign — Magnetic Flow Fields

**Date:** 2026-04-01  
**Status:** Approved

## Overview

Replace the five non-Wind Field module modes with six brand-new pure flow fields, all magnetic-themed with chaotic/geometric aesthetics. Every mode — including Wind — follows the same architecture: derive a flow angle `th` at the particle's position using only `Math.sin`/`Math.cos`/`Math.atan2` and time `t`, then step by `Math.cos(th)*fMag*0.12, Math.sin(th)*fMag*0.12`. No point forces, no distance-based pulls.

Total mode count goes from 6 → 7.

## Architecture

Same as Wind. Per-particle, per-frame:
```
th = f(curX, curY, t)          // angle field formula — different per mode
curX += Math.cos(th) * fMag * 0.12
curY += Math.sin(th) * fMag * 0.12
```

Variables available in scope: `curX`, `curY`, `t`, `fMag`, `fwx`, `fwy`, `fcx`, `fcy`, `fdist`, `DIMENSION`.

## Mode Designs

### Mode 0 — Aurora
Shimmering horizontal bands like the Northern Lights. Three layered sine waves at offset frequencies and speeds create iridescent drifting streams. Low chaos, high fluidity.

```js
if(fm2===0){// Aurora — layered magnetic band flow
  const th=Math.sin(curX*0.006+t*0.5)*Math.PI
           +Math.sin(curY*0.004+t*0.3)*Math.PI*0.5
           +Math.sin(curX*0.003-curY*0.002+t*0.2)*Math.PI*0.3;
  curX+=Math.cos(th)*fMag*0.12;curY+=Math.sin(th)*fMag*0.12;
}
```

### Mode 1 — Plasma
High-frequency overlapping turbulence like solar plasma. Three sine waves at different scales and tempos add together, producing unpredictably shifting chaotic flow.

```js
}else if(fm2===1){// Plasma — high-frequency magnetic turbulence
  const a1=Math.sin(curX*0.015+t*0.7)*Math.PI*2;
  const a2=Math.sin(curY*0.012-t*0.5)*Math.PI*2;
  const a3=Math.sin(curX*0.005-curY*0.008+t*0.4)*Math.PI;
  const th=a1+a2*0.5+a3*0.3;
  curX+=Math.cos(th)*fMag*0.12;curY+=Math.sin(th)*fMag*0.12;
}
```

### Mode 2 — Lattice
Geometric checkerboard of alternating CW/CCW swirl cells. `atan2(sin(y*freq), sin(x*freq))` tiles the space with a grid of opposing vortices that slowly drift over time.

```js
}else if(fm2===2){// Lattice — geometric alternating vortex grid
  const freq=0.018;
  const th=Math.atan2(Math.sin(curY*freq+t*0.15),Math.sin(curX*freq+t*0.1));
  curX+=Math.cos(th)*fMag*0.12;curY+=Math.sin(th)*fMag*0.12;
}
```

### Mode 3 — Interference
Two slowly drifting source points generate circular wave fronts that overlap. Where waves align, flow is strong and organized; where they cancel, it goes chaotic — classic physics-demo interference pattern.

```js
}else if(fm2===3){// Interference — two-source magnetic wave interference
  const s1x=DIMENSION*0.35+Math.cos(t*0.3)*DIMENSION*0.1;
  const s1y=DIMENSION*0.5+Math.sin(t*0.2)*DIMENSION*0.08;
  const s2x=DIMENSION*0.65+Math.cos(t*0.25+1.0)*DIMENSION*0.1;
  const s2y=DIMENSION*0.5+Math.sin(t*0.3+0.5)*DIMENSION*0.08;
  const r1=Math.sqrt((curX-s1x)*(curX-s1x)+(curY-s1y)*(curY-s1y));
  const r2=Math.sqrt((curX-s2x)*(curX-s2x)+(curY-s2y)*(curY-s2y));
  const th=Math.sin(r1*0.05-t*0.6)*Math.PI+Math.sin(r2*0.05-t*0.4)*Math.PI;
  curX+=Math.cos(th)*fMag*0.12;curY+=Math.sin(th)*fMag*0.12;
}
```

### Mode 4 — Wind
Unchanged.

```js
}else if(fm2===4){// Wind — smooth Perlin-like vector field (unchanged)
  const nx2=curX*0.008+t*0.4,ny2=curY*0.008+t*0.3;
  const flow=Math.sin(nx2*2.1+ny2*1.7)*Math.PI*2;
  curX+=Math.cos(flow)*fMag*0.12;curY+=Math.sin(flow)*fMag*0.12;
}
```

### Mode 5 — Magrev
Magnetic reversal: `sin(x+t) * cos(y-t) * 2π`. Large smooth domains of organized flow separated by chaotic boundary zones where the field direction flips. Geometric at macro scale, wild at the seams.

```js
}else if(fm2===5){// Magrev — magnetic flux reversal domains
  const th=Math.sin(curX*0.01+t*0.3)*Math.cos(curY*0.01-t*0.2)*Math.PI*2;
  curX+=Math.cos(th)*fMag*0.12;curY+=Math.sin(th)*fMag*0.12;
}
```

### Mode 6 — Poles
4 poles in a slowly rotating square (alternating +/− polarity). Each pole contributes a softened unit-vector push; the superposition of all 4 creates a dense geometric web of interlocking streams that shifts as the square turns.

```js
}else if(fm2===6){// Poles — 4 rotating alternating-polarity field sources
  const ph=t*0.25,sep=DIMENSION*0.25,soft=DIMENSION*0.1;
  let sumFx=0,sumFy=0;
  for(let i=0;i<4;i++){
    const ang=ph+i*Math.PI*0.5;
    const px=fwx+Math.cos(ang)*sep,py=fwy+Math.sin(ang)*sep;
    const dx=curX-px,dy=curY-py;
    const d=Math.sqrt(dx*dx+dy*dy)+soft;
    const sign=(i%2===0)?1:-1;
    sumFx+=sign*dx/d;sumFy+=sign*dy/d;
  }
  const th=Math.atan2(sumFy,sumFx)+Math.sin(t*0.25)*0.3;
  curX+=Math.cos(th)*fMag*0.12;curY+=Math.sin(th)*fMag*0.12;
}
```

## UI Changes

**`fieldMode` comment** (line ~2624):
```js
const [fieldMode,setFieldMode]=useState(0); // 0=Aurora 1=Plasma 2=Lattice 3=Interference 4=Wind 5=Magrev 6=Poles
```

**Mode labels** (line ~6022):
```js
modeLabel={['Aurora','Plasma','Lattice','Interfere','Wind','Magrev','Poles'][fieldMode]||'—'}
modeCount={7}
```

**Mode button labels** in the selector (the `['Gravity','Repulsor','Dipole','Attract','Wind','Orbit']` array):
```js
['Aurora','Plasma','Lattice','Interfere','Wind','Magrev','Poles']
```

## Changes Summary

- **Modify:** `src/Morphology.jsx`
  - Replace the entire `if(fm2===0)` … `}` block (modes 0–5) with the new 7-mode block (modes 0–6)
  - Update `fieldMode` state comment
  - Update `modeLabel` array and `modeCount` from 6 → 7
  - Update mode button labels array

## Out of Scope

- No changes to `fieldAmt`, `fieldX/Y`, or any other field state
- No changes to any other module
- Wind (mode 4) is bit-for-bit identical to current implementation
