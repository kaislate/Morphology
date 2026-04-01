# Field Modes Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the five non-Wind field mode branches with six brand-new magnetic-themed pure flow fields, and update the UI labels to match.

**Architecture:** Each mode computes a flow angle `th` from position and time using only `Math.sin`/`Math.cos`/`Math.atan2`, then steps the particle by `cos(th)*fMag*0.12, sin(th)*fMag*0.12` — identical architecture to Wind. Mode count increases from 6 to 7.

**Tech Stack:** React, canvas 2D, vanilla JS math

---

### Task 1: Replace the field mode computation block

**Files:**
- Modify: `src/Morphology.jsx:3625-3657`

> No unit tests exist for this canvas simulation. Verification is a build check plus visual inspection in the browser.

- [ ] **Step 1: Locate the target block**

  In `src/Morphology.jsx`, find line 3625 which reads:
  ```
  if(fm2===0){// Gravity — inward spiral flow field
  ```
  The block ends at line 3657 with `        }` (closing `fm2===5`).

- [ ] **Step 2: Replace lines 3625–3657 with the new 7-mode block**

  Replace the entire `if(fm2===0){...}` through the closing `}` of `fm2===5` with:

  ```js
          if(fm2===0){// Aurora — layered magnetic band flow
            const th=Math.sin(curX*0.006+t*0.5)*Math.PI
                     +Math.sin(curY*0.004+t*0.3)*Math.PI*0.5
                     +Math.sin(curX*0.003-curY*0.002+t*0.2)*Math.PI*0.3;
            curX+=Math.cos(th)*fMag*0.12;curY+=Math.sin(th)*fMag*0.12;
          }else if(fm2===1){// Plasma — high-frequency magnetic turbulence
            const a1=Math.sin(curX*0.015+t*0.7)*Math.PI*2;
            const a2=Math.sin(curY*0.012-t*0.5)*Math.PI*2;
            const a3=Math.sin(curX*0.005-curY*0.008+t*0.4)*Math.PI;
            const th=a1+a2*0.5+a3*0.3;
            curX+=Math.cos(th)*fMag*0.12;curY+=Math.sin(th)*fMag*0.12;
          }else if(fm2===2){// Lattice — geometric alternating vortex grid
            const freq=0.018;
            const th=Math.atan2(Math.sin(curY*freq+t*0.15),Math.sin(curX*freq+t*0.1));
            curX+=Math.cos(th)*fMag*0.12;curY+=Math.sin(th)*fMag*0.12;
          }else if(fm2===3){// Interference — two-source magnetic wave interference
            const s1x=DIMENSION*0.35+Math.cos(t*0.3)*DIMENSION*0.1;
            const s1y=DIMENSION*0.5+Math.sin(t*0.2)*DIMENSION*0.08;
            const s2x=DIMENSION*0.65+Math.cos(t*0.25+1.0)*DIMENSION*0.1;
            const s2y=DIMENSION*0.5+Math.sin(t*0.3+0.5)*DIMENSION*0.08;
            const r1=Math.sqrt((curX-s1x)*(curX-s1x)+(curY-s1y)*(curY-s1y));
            const r2=Math.sqrt((curX-s2x)*(curX-s2x)+(curY-s2y)*(curY-s2y));
            const th=Math.sin(r1*0.05-t*0.6)*Math.PI+Math.sin(r2*0.05-t*0.4)*Math.PI;
            curX+=Math.cos(th)*fMag*0.12;curY+=Math.sin(th)*fMag*0.12;
          }else if(fm2===4){// Wind — smooth Perlin-like vector field (unchanged)
            const nx2=curX*0.008+t*0.4,ny2=curY*0.008+t*0.3;
            const flow=Math.sin(nx2*2.1+ny2*1.7)*Math.PI*2;
            curX+=Math.cos(flow)*fMag*0.12;curY+=Math.sin(flow)*fMag*0.12;
          }else if(fm2===5){// Magrev — magnetic flux reversal domains
            const th=Math.sin(curX*0.01+t*0.3)*Math.cos(curY*0.01-t*0.2)*Math.PI*2;
            curX+=Math.cos(th)*fMag*0.12;curY+=Math.sin(th)*fMag*0.12;
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

- [ ] **Step 3: Run build to verify no errors**

  ```bash
  npm run build
  ```
  Expected: `✓ built in` with no errors.

- [ ] **Step 4: Commit**

  ```bash
  git add src/Morphology.jsx
  git commit -m "feat: replace field modes with magnetic flow fields (Aurora/Plasma/Lattice/Interference/Magrev/Poles)"
  ```

---

### Task 2: Update UI labels and mode count

**Files:**
- Modify: `src/Morphology.jsx:2624` (state comment)
- Modify: `src/Morphology.jsx:6014` (modeLabel array, modeCount)
- Modify: `src/Morphology.jsx:6025` (button labels array)

- [ ] **Step 1: Update the fieldMode state comment at line 2624**

  Find:
  ```js
    const [fieldMode,setFieldMode]=useState(0); // 0=Gravity Well 1=Repulsor 2=Dipole 3=Attractor Web 4=Flow Field 5=Orbital
  ```
  Replace with:
  ```js
    const [fieldMode,setFieldMode]=useState(0); // 0=Aurora 1=Plasma 2=Lattice 3=Interference 4=Wind 5=Magrev 6=Poles
  ```

- [ ] **Step 2: Update modeLabel array and modeCount at line 6014**

  Find:
  ```js
              modeKey={fieldMode} modeLabel={['Gravity','Repulsor','Dipole','Attract','Wind','Orbit'][fieldMode]||'—'} modeCount={6} onModeChange={v=>setFieldMode(v)}
  ```
  Replace with:
  ```js
              modeKey={fieldMode} modeLabel={['Aurora','Plasma','Lattice','Interfere','Wind','Magrev','Poles'][fieldMode]||'—'} modeCount={7} onModeChange={v=>setFieldMode(v)}
  ```

- [ ] **Step 3: Update the button labels array at line 6025**

  Find:
  ```js
                {[['Gravity',0],['Repulsor',1],['Dipole',2],['Attract',3],['Wind',4],['Orbit',5]].map(([lbl,id])=>(
  ```
  Replace with:
  ```js
                {[['Aurora',0],['Plasma',1],['Lattice',2],['Interfere',3],['Wind',4],['Magrev',5],['Poles',6]].map(([lbl,id])=>(
  ```

- [ ] **Step 4: Run build to verify no errors**

  ```bash
  npm run build
  ```
  Expected: `✓ built in` with no errors.

- [ ] **Step 5: Commit**

  ```bash
  git add src/Morphology.jsx
  git commit -m "feat: update field module UI labels and mode count to 7"
  ```
