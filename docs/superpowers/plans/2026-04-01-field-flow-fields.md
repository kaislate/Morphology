# Field Flow Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the five non-Wind Field module mode branches with angle-based flow fields that produce wavy streaming motion shaped by each mode's characteristic magnetic pattern.

**Architecture:** Each mode computes a flow angle `th` at the particle's position using `Math.atan2` plus a time-varying sin wave, then steps the particle by `cos(th)*fMag*0.12, sin(th)*fMag*0.12` — identical to how Wind (mode 4) already works. Variables `fcx`, `fcy`, and `fdist` are already computed before the branch and can be reused directly for modes 0, 1, and 5.

**Tech Stack:** React, canvas 2D API, vanilla JS math (no new dependencies)

---

### Task 1: Replace all five non-Wind mode branches with flow fields

**Files:**
- Modify: `src/Morphology.jsx:3625-3665`

> Note: This is a pure canvas particle simulation. There are no unit-testable functions — verification is visual. Steps below include browser verification checkpoints.

- [ ] **Step 1: Open the file and locate the target block**

  In `src/Morphology.jsx`, find the block starting at line 3625:
  ```
  if(fm2===0){// Gravity Well — CW inward spiral; well drifts so stream never converges
  ```
  It ends at line 3665 with the closing `}` of the `fm2===5` branch.

- [ ] **Step 2: Replace the entire if/else-if chain (modes 0–5) with the flow field version**

  Replace lines 3625–3665 (the full `if(fm2===0){...}` block through the closing `}` of mode 5) with:

  ```js
          if(fm2===0){// Gravity — inward spiral flow field
            const th=Math.atan2(-fcy,-fcx)-0.4+Math.sin(t*0.45+fdist*0.014)*0.45;
            curX+=Math.cos(th)*fMag*0.12;curY+=Math.sin(th)*fMag*0.12;
          }else if(fm2===1){// Repulsor — outward spiral flow field
            const th=Math.atan2(fcy,fcx)+0.4+Math.sin(t*0.45+fdist*0.014)*0.45;
            curX+=Math.cos(th)*fMag*0.12;curY+=Math.sin(th)*fMag*0.12;
          }else if(fm2===2){// Dipole — iron-filings flow field
            const ph=t*0.22,sep=DIMENSION*0.15;
            const p1x=fwx+Math.cos(ph)*sep,p1y=fwy+Math.sin(ph)*sep;
            const p2x=fwx-Math.cos(ph)*sep,p2y=fwy-Math.sin(ph)*sep;
            const d1x=curX-p1x,d1y=curY-p1y,d1=Math.sqrt(d1x*d1x+d1y*d1y)||1;
            const d2x=curX-p2x,d2y=curY-p2y,d2=Math.sqrt(d2x*d2x+d2y*d2y)||1;
            const netFx=d1x/(d1*d1)-d2x/(d2*d2),netFy=d1y/(d1*d1)-d2y/(d2*d2);
            const th=Math.atan2(netFy,netFx)+Math.sin(t*0.3+fdist*0.01)*0.35;
            curX+=Math.cos(th)*fMag*0.12;curY+=Math.sin(th)*fMag*0.12;
          }else if(fm2===3){// Attractor Web — 9-vortex flow field
            const gSize=DIMENSION/3;let sumFx=0,sumFy=0;
            for(let gx=0;gx<3;gx++)for(let gy=0;gy<3;gy++){
              const nx=gSize*(gx+0.5)+Math.cos(t*0.5+gx*2.1+gy*1.7)*10;
              const ny=gSize*(gy+0.5)+Math.sin(t*0.5+gx*1.7+gy*2.4)*10;
              const cx=curX-nx,cy=curY-ny,d2=cx*cx+cy*cy||1;
              sumFx+=-cy/d2;sumFy+=cx/d2;
            }
            const th=Math.atan2(sumFy,sumFx)+Math.sin(t*0.35)*0.3;
            curX+=Math.cos(th)*fMag*0.12;curY+=Math.sin(th)*fMag*0.12;
          }else if(fm2===4){// Wind — smooth Perlin-like vector field (unchanged)
            const nx2=curX*0.008+t*0.4,ny2=curY*0.008+t*0.3;
            const flow=Math.sin(nx2*2.1+ny2*1.7)*Math.PI*2;
            curX+=Math.cos(flow)*fMag*0.12;curY+=Math.sin(flow)*fMag*0.12;
          }else if(fm2===5){// Orbital — concentric ring flow field
            const th=Math.atan2(fcy,fcx)+Math.PI*0.5+Math.sin(fdist*0.022+t*0.7)*0.5;
            curX+=Math.cos(th)*fMag*0.12;curY+=Math.sin(th)*fMag*0.12;
          }
  ```

- [ ] **Step 3: Verify in browser — Gravity (mode 0)**

  Enable Field, select Gravity. Expected: particles stream inward in a clockwise spiral with a visible pulse/wave travelling along the streams. Should look like a draining vortex with rippling lines, not a static clump.

- [ ] **Step 4: Verify in browser — Repulsor (mode 1)**

  Select Repulsor. Expected: mirror of Gravity — CCW outward spiral streams with the same wave pulsing outward from center.

- [ ] **Step 5: Verify in browser — Dipole (mode 2)**

  Select Dipole. Expected: classic figure-8 iron-filings pattern with particles flowing from one pole to the other in looping arcs, animated by the slowly rotating poles. Lines should stream, not clump.

- [ ] **Step 6: Verify in browser — Attractor Web (mode 3)**

  Select Attract. Expected: interlocking circular swirls at 9 grid positions, particles flowing in CCW loops between vortex centers, with a gentle global wave undulation.

- [ ] **Step 7: Verify in browser — Wind (mode 4)**

  Select Wind. Expected: unchanged — same smooth drifting Perlin-like flow as before.

- [ ] **Step 8: Verify in browser — Orbital (mode 5)**

  Select Orbit. Expected: particles orbit in concentric rings around center, with alternating rings appearing to pulse inward/outward due to the sin wave on distance.

- [ ] **Step 9: Commit**

  ```bash
  git add src/Morphology.jsx
  git commit -m "feat: convert field modes to angle-based flow fields"
  ```
