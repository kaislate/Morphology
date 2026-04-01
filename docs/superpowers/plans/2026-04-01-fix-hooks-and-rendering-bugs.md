# React Hooks & Rendering Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix five confirmed bugs in `src/PixelAlchemist.jsx` — a Rules of Hooks violation, three stale-closure useEffect dep arrays, a rAF memory leak, missing state in the render ref, and an unguarded non-universal Canvas API call.

**Architecture:** All five fixes are targeted edits to a single file. They are independent of each other and can be applied in any order, though the tasks below sequence them from most complex → simplest. No new files are needed. No external libraries required.

**Tech Stack:** React 18, Vite 6, Canvas 2D API, Web Audio API. No test framework exists — verification is manual via `npm run dev` in the browser.

**Issue #6 status:** Already resolved — `my-next-app/` was deleted. Not covered here.

---

## File Map

| File | What changes |
|---|---|
| `src/PixelAlchemist.jsx:257–333` | Replace `FSlider` with two components: `FSliderLFO` + simplified `FSlider` |
| `src/PixelAlchemist.jsx:337–364` | Add callback refs to `BracketSlider`, fix stale closure |
| `src/PixelAlchemist.jsx:367–395` | Add callback refs to `RangeSlider`, fix stale closure |
| `src/PixelAlchemist.jsx:2959–2981` | Store rAF ID, cancel on cleanup |
| `src/PixelAlchemist.jsx:2920` | Add 7 missing vars to `R.current` sync object |
| `src/PixelAlchemist.jsx:202` | Guard `ctx.letterSpacing` with feature-detect |

---

## Task 1 — Fix Rules of Hooks violation in `FSlider` (Issue #1 + FSlider portion of Issue #4)

**Problem:** `FSlider` at L257 calls `useRef` and `useEffect` *after* a conditional `return` at L262. React tracks hooks by call-order per render; when `lfoRange` is falsy the hooks are never called, breaking React's internal bookkeeping. React StrictMode will warn; in production behavior is undefined.

**Strategy:** Extract the LFO-mode rendering into its own component `FSliderLFO` (placed immediately before `FSlider`). The original `FSlider` becomes a clean dispatcher with no hooks of its own. The new `FSliderLFO` places all hooks unconditionally at the top, and uses the callback-ref pattern (two extra `useRef` + `useEffect` pairs) so the drag `useEffect` dep array stays minimal — fixing the stale-closure issue at the same time.

**Files:**
- Modify: `src/PixelAlchemist.jsx:257–333`

---

- [ ] **Step 1.1 — Open the file and locate the block to replace**

  In `src/PixelAlchemist.jsx`, find lines 257–333. The block starts with:
  ```
  const FSlider=({value,min,max,...
  ```
  and ends with the closing `};` on line 333.

- [ ] **Step 1.2 — Replace lines 257–333 with the two-component version**

  Delete the entire `FSlider` block (L257–333) and insert the following in its place:

  ```jsx
  // FSliderLFO — LFO bracket-mode slider. Extracted from FSlider to satisfy Rules of Hooks.
  // Hooks must be called unconditionally and at the top level; the original FSlider
  // had an early-return before its useRef/useEffect calls which violated that rule.
  const FSliderLFO=({value,min,max,step=0.01,onChange,color='#fff',enabled=true,defaultVal,lfoRange,onRangeChange})=>{
    const {lo,hi}=lfoRange;
    const pct=((value-min)/(max-min))*100;
    const fill=enabled?color:'#52525b';
    const loPct=lo*100; const hiPct=hi*100;
    const trackRef=useRef(null);
    const dragRef=useRef(null);
    // Callback refs — keep drag handler stable without re-registering listeners on every render.
    // The parent passes inline lambdas, so onChange/onRangeChange would be new references each render.
    // Storing them in refs lets the useEffect dep array stay as [lo,hi,min,max] while still
    // always calling the latest version of the callback.
    const onChangeRef=useRef(onChange);
    const onRangeChangeRef=useRef(onRangeChange);
    useEffect(()=>{onChangeRef.current=onChange;},[onChange]);
    useEffect(()=>{onRangeChangeRef.current=onRangeChange;},[onRangeChange]);

    const onDbl=e=>{e.preventDefault();if(defaultVal!==undefined)onChangeRef.current(defaultVal);};
    const onMouseDown=(handle,e)=>{e.preventDefault();e.stopPropagation();dragRef.current=handle;};

    useEffect(()=>{
      const getFrac=e=>{
        const r=trackRef.current.getBoundingClientRect();
        return Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));
      };
      const mm=e=>{
        if(!dragRef.current||!trackRef.current)return;
        const f=getFrac(e);
        if(dragRef.current==='lo')onRangeChangeRef.current({lo:Math.min(f,hi-0.04),hi});
        else if(dragRef.current==='hi')onRangeChangeRef.current({lo,hi:Math.max(f,lo+0.04)});
        else onChangeRef.current(min+(max-min)*f);
      };
      const mu=()=>{dragRef.current=null;};
      window.addEventListener('mousemove',mm);window.addEventListener('mouseup',mu);
      return()=>{window.removeEventListener('mousemove',mm);window.removeEventListener('mouseup',mu);};
    },[lo,hi,min,max]);

    return(
      <div ref={trackRef} className="relative w-full select-none" style={{height:'16px',cursor:'pointer'}}
        onDoubleClick={onDbl}>
        {/* Base track */}
        <div className="absolute rounded-full" style={{top:'50%',transform:'translateY(-50%)',left:0,right:0,height:'3px',background:'#3f3f46'}}/>
        {/* LFO range fill — violet tint */}
        <div className="absolute rounded-full" style={{top:'50%',transform:'translateY(-50%)',left:`${loPct}%`,width:`${hiPct-loPct}%`,height:'3px',background:'#7c3aed',opacity:0.45}}/>
        {/* Current value fill */}
        <div className="absolute rounded-full" style={{top:'50%',transform:'translateY(-50%)',left:0,width:`${pct}%`,height:'3px',background:fill,opacity:enabled?0.9:0.4}}/>
        {/* Value thumb — transparent, draggable via the whole track area */}
        <input type="range" min={min} max={max} step={step} value={value}
          onChange={e=>onChangeRef.current(Number(e.target.value))}
          className="fslider absolute inset-0 w-full opacity-0"
          style={{height:'100%',cursor:'ew-resize'}}/>
        {/* Lo bracket handle */}
        <div onMouseDown={e=>onMouseDown('lo',e)}
          className="absolute flex items-center justify-center cursor-ew-resize"
          style={{left:`${loPct}%`,top:'50%',transform:'translate(-50%,-50%)',width:'10px',height:'14px',zIndex:10}}>
          <div style={{width:'3px',height:'12px',background:'#a78bfa',borderRadius:'2px',
            boxShadow:'0 0 4px rgba(167,139,250,0.8)',border:'1px solid #7c3aed'}}/>
        </div>
        {/* Hi bracket handle */}
        <div onMouseDown={e=>onMouseDown('hi',e)}
          className="absolute flex items-center justify-center cursor-ew-resize"
          style={{left:`${hiPct}%`,top:'50%',transform:'translate(-50%,-50%)',width:'10px',height:'14px',zIndex:10}}>
          <div style={{width:'3px',height:'12px',background:'#a78bfa',borderRadius:'2px',
            boxShadow:'0 0 4px rgba(167,139,250,0.8)',border:'1px solid #7c3aed'}}/>
        </div>
        {/* Range labels */}
        <div className="absolute pointer-events-none" style={{left:`${loPct}%`,top:'-1px',fontSize:'4.5px',
          color:'#a78bfa',fontWeight:'900',transform:'translateX(-50%)',lineHeight:1,whiteSpace:'nowrap'}}>
          {(min+(max-min)*lo).toFixed(max-min<=1?2:1)}
        </div>
        <div className="absolute pointer-events-none" style={{left:`${hiPct}%`,top:'-1px',fontSize:'4.5px',
          color:'#a78bfa',fontWeight:'900',transform:'translateX(-50%)',lineHeight:1,whiteSpace:'nowrap'}}>
          {(min+(max-min)*hi).toFixed(max-min<=1?2:1)}
        </div>
      </div>
    );
  };

  // FSlider — filled-track slider. Dispatches to FSliderLFO when lfoRange is provided.
  // No hooks of its own — keeps this component trivially correct re: Rules of Hooks.
  const FSlider=({value,min,max,step=0.01,onChange,color='#fff',enabled=true,defaultVal,lfoRange,onRangeChange})=>{
    if(lfoRange){
      return <FSliderLFO value={value} min={min} max={max} step={step} onChange={onChange}
        color={color} enabled={enabled} defaultVal={defaultVal} lfoRange={lfoRange} onRangeChange={onRangeChange}/>;
    }
    const pct=((value-min)/(max-min))*100;
    const fill=enabled?color:'#52525b';
    const onDbl=e=>{e.preventDefault();if(defaultVal!==undefined)onChange(defaultVal);};
    return <input type="range" min={min} max={max} step={step} value={value}
      onChange={e=>onChange(Number(e.target.value))}
      onDoubleClick={onDbl}
      className="fslider w-full"
      style={{background:`linear-gradient(to right,${fill} ${pct}%,#3f3f46 ${pct}%)`,'--tc':fill}}/>;
  };
  ```

- [ ] **Step 1.3 — Run the dev server and verify basic slider behaviour**

  ```bash
  cd "C:/Documents/NEw project/Project 1/Morphology"
  npm run dev
  ```

  Open the app in the browser. Confirm:
  - All sliders without LFO pins still move and control their parameters.
  - Double-clicking a non-LFO slider resets it to its default value (where a `defaultVal` is wired up in the UI).
  - No console errors about "Rendered more hooks than during the previous render" or "Cannot read properties of null."

- [ ] **Step 1.4 — Verify LFO bracket mode**

  In the app, open the Cymatics or LFO routing panel. Pin an LFO source to a target that has a slider (e.g., pin LFO 1 → Zoom). The slider for that target should now show the violet bracket handles. Drag the lo/hi bracket handles — the bracket markers should move. The LFO should sweep the parameter between the bracket boundaries.

- [ ] **Step 1.5 — Verify StrictMode produces no hook-order warnings**

  Open browser DevTools → Console. Confirm there are no React warnings mentioning "Rendered more hooks" or "hook order." (React StrictMode is active in this project via `main.jsx`.)

- [ ] **Step 1.6 — Commit**

  ```bash
  cd "C:/Documents/NEw project/Project 1/Morphology"
  git -C src add -A
  git -C src commit -m "fix: extract FSliderLFO to resolve Rules of Hooks violation

  FSlider had useRef/useEffect calls after a conditional early return,
  violating React's hook call-order rule. Extracted LFO-mode rendering
  into a dedicated FSliderLFO component where all hooks are at the top
  level. FSlider itself now has no hooks. Also adds callback refs in
  FSliderLFO so the drag useEffect dep array stays stable.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 2 — Fix stale-closure useEffect deps in `BracketSlider` and `RangeSlider` (Issue #4)

**Problem:** Both `BracketSlider` (L343) and `RangeSlider` (L376) register global `mousemove`/`mouseup` listeners in a `useEffect` with dep array `[lo, hi]`. The handlers call `onLoChange` / `onHiChange` directly, but those callbacks are not in the dep array. If the parent re-renders and passes a new function reference (e.g., an inline arrow function), the handler silently calls the old stale closure instead.

**Strategy:** Same callback-ref pattern used in Task 1. Add `useRef` for each callback and a sync `useEffect` to keep the ref current. The drag `useEffect` then reads from the ref instead of the closure, so its dep array stays as `[lo, hi]` without re-registering listeners on every parent render.

**Files:**
- Modify: `src/PixelAlchemist.jsx:337–364` (`BracketSlider`)
- Modify: `src/PixelAlchemist.jsx:367–395` (`RangeSlider`)

---

- [ ] **Step 2.1 — Replace the `BracketSlider` block (L337–364)**

  Find lines 337–364 (from `const BracketSlider=` through its closing `};`) and replace with:

  ```jsx
  const BracketSlider=({lo,hi,onLoChange,onHiChange,color='#f59e0b'})=>{
    const trackRef=useRef(null);
    const dragRef=useRef(null);
    const clamp=(v,mn,mx)=>Math.max(mn,Math.min(mx,v));
    // Callback refs — see FSliderLFO for the rationale.
    const onLoRef=useRef(onLoChange);
    const onHiRef=useRef(onHiChange);
    useEffect(()=>{onLoRef.current=onLoChange;},[onLoChange]);
    useEffect(()=>{onHiRef.current=onHiChange;},[onHiChange]);
    const onMouseDown=(handle,e)=>{e.preventDefault();e.stopPropagation();dragRef.current=handle;};
    useEffect(()=>{
      const getFrac=e=>{const r=trackRef.current.getBoundingClientRect();return clamp((e.clientX-r.left)/r.width,0,1);};
      const mm=e=>{if(!dragRef.current||!trackRef.current)return;const f=getFrac(e);if(dragRef.current==='lo')onLoRef.current(clamp(f,0,hi-0.04));else onHiRef.current(clamp(f,lo+0.04,1));};
      const mu=()=>{dragRef.current=null;};
      window.addEventListener('mousemove',mm);window.addEventListener('mouseup',mu);
      return()=>{window.removeEventListener('mousemove',mm);window.removeEventListener('mouseup',mu);};
    },[lo,hi]);
    const loPct=lo*100,hiPct=hi*100;
    return(
      <div ref={trackRef} className="relative w-full select-none" style={{height:'16px',cursor:'ew-resize'}}>
        <div className="absolute rounded-full" style={{top:'50%',transform:'translateY(-50%)',left:0,right:0,height:'3px',background:'#3f3f46'}}/>
        <div className="absolute rounded-full" style={{top:'50%',transform:'translateY(-50%)',left:`${loPct}%`,width:`${hiPct-loPct}%`,height:'3px',background:color,opacity:0.5}}/>
        {[['lo',loPct],['hi',hiPct]].map(([h,pct])=>(
          <div key={h} onMouseDown={e=>onMouseDown(h,e)}
            className="absolute flex items-center justify-center cursor-ew-resize"
            style={{left:`${pct}%`,top:'50%',transform:'translate(-50%,-50%)',width:'10px',height:'14px',zIndex:10}}>
            <div style={{width:'3px',height:'12px',background:color,borderRadius:'2px',boxShadow:`0 0 4px ${color}cc`,border:`1px solid ${color}`}}/>
          </div>
        ))}
      </div>
    );
  };
  ```

- [ ] **Step 2.2 — Replace the `RangeSlider` block (L367–395)**

  Find lines 367–395 (from `const RangeSlider=` through its closing `};`) and replace with:

  ```jsx
  const RangeSlider=({lo,hi,onLoChange,onHiChange,color='#06b6d4',enabled=true})=>{
    const trackRef=useRef(null);
    const drag=useRef(null);
    const clamp=(v,mn,mx)=>Math.max(mn,Math.min(mx,v));
    // Callback refs — see FSliderLFO for the rationale.
    const onLoRef=useRef(onLoChange);
    const onHiRef=useRef(onHiChange);
    useEffect(()=>{onLoRef.current=onLoChange;},[onLoChange]);
    useEffect(()=>{onHiRef.current=onHiChange;},[onHiChange]);
    const onMouseDown=(handle,e)=>{e.preventDefault();drag.current=handle;};
    useEffect(()=>{
      const getFrac=e=>{
        const rect=trackRef.current.getBoundingClientRect();
        return clamp((e.clientX-rect.left)/rect.width,0,1);
      };
      const mm=e=>{if(!drag.current)return;const f=getFrac(e);if(drag.current==='lo')onLoRef.current(clamp(f,0,hi-0.02));else onHiRef.current(clamp(f,lo+0.02,1));};
      const mu=()=>{drag.current=null;};
      window.addEventListener('mousemove',mm);window.addEventListener('mouseup',mu);
      return()=>{window.removeEventListener('mousemove',mm);window.removeEventListener('mouseup',mu);};
    },[lo,hi]);
    const loPct=lo*100; const hiPct=hi*100;
    const col=enabled?color:'#52525b';
    return(
      <div ref={trackRef} className="relative h-3 flex items-center cursor-pointer select-none" style={{touchAction:'none'}}>
        <div className="absolute inset-x-0 h-1 rounded-full bg-zinc-800"/>
        <div className="absolute h-1 rounded-full" style={{left:`${loPct}%`,right:`${100-hiPct}%`,background:col,opacity:enabled?0.7:0.3}}/>
        {[['lo',loPct],['hi',hiPct]].map(([h,pct])=>(
          <div key={h} className="absolute w-3 h-3 rounded-full border-2 cursor-grab active:cursor-grabbing transition-shadow"
            style={{left:`${pct}%`,transform:'translateX(-50%)',background:'#18181b',borderColor:col,boxShadow:enabled?`0 0 6px ${col}40`:''}}
            onMouseDown={e=>onMouseDown(h,e)}/>
        ))}
      </div>
    );
  };
  ```

- [ ] **Step 2.3 — Verify in browser**

  With `npm run dev` still running:

  - Find the **Margin** slider in the morph controls area and enable A|B split mode. The orange bracket slider appears. Drag the lo and hi bracket handles — both should track the mouse accurately from drag start through drag end.
  - Find the **Frequency window** range slider in the Cymatics / Audio section (the dual-handle cyan slider). Drag both handles — the frequency band should update correctly.

- [ ] **Step 2.4 — Commit**

  ```bash
  git -C src add -A
  git -C src commit -m "fix: add callback refs to BracketSlider and RangeSlider useEffect

  Both components called onLoChange/onHiChange inside a useEffect whose
  dep array only listed [lo, hi]. If the parent passed inline lambdas the
  handlers would silently use stale closures. Replaced direct callback
  references with refs updated via their own useEffect, matching the
  pattern established in FSliderLFO.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 3 — Cancel popout rAF loop on unmount (Issue #3)

**Problem:** The popout-sync `useEffect` at L2959 starts a `requestAnimationFrame` loop that recurses indefinitely. The cleanup function (L2980) only closes the popup window — it never cancels the rAF. After the component unmounts, the loop keeps running for the lifetime of the tab, wasting CPU.

**Strategy:** Store the rAF return value in a `let` variable scoped to the effect closure; cancel it in the cleanup before closing the window.

**Files:**
- Modify: `src/PixelAlchemist.jsx:2959–2981`

---

- [ ] **Step 3.1 — Apply the fix**

  Find lines 2959–2981. The block looks like:

  ```js
  useEffect(()=>{
    let last=0;
    const sync=now=>{
      ...
      requestAnimationFrame(sync);
    };
    requestAnimationFrame(sync);
    return()=>{if(popoutWindowRef.current&&!popoutWindowRef.current.closed)popoutWindowRef.current.close();};
  },[]);
  ```

  Replace with:

  ```js
  useEffect(()=>{
    let last=0;
    let rafId;
    const sync=now=>{
      if(popoutWindowRef.current&&!popoutWindowRef.current.closed){
        const pc=popoutWindowRef.current.document.getElementById('v');
        const mc=canvasRef.current;
        if(pc&&mc){
          const iv=R.current.highRefreshMode===2?6.94:R.current.highRefreshMode===1?8.33:16.67;
          if(now-last>=iv){
            pc.getContext('2d',{alpha:false}).drawImage(mc,0,0,pc.width,pc.height);
            last=now;
            const bg=R.current.canvasBg||'#000000';
            if(popoutWindowRef.current.document.body.style.background!==bg)
              popoutWindowRef.current.document.body.style.background=bg;
          }
        }
      }
      rafId=requestAnimationFrame(sync);
    };
    rafId=requestAnimationFrame(sync);
    return()=>{
      cancelAnimationFrame(rafId);
      if(popoutWindowRef.current&&!popoutWindowRef.current.closed)popoutWindowRef.current.close();
    };
  },[]);
  ```

- [ ] **Step 3.2 — Verify in browser**

  Open DevTools → Performance tab. Record for ~3 seconds. Open the popout viewport (the "pop-out" button in the app), then close it. Record for another 3 seconds. In the flame chart, confirm the rAF callback stops appearing after the popout is closed. There should be no orphan `sync` frame callbacks continuing after closure.

  Alternatively: open the popout, close it, then open DevTools → Console and run `performance.now()` a few times while watching CPU usage in the browser task manager — usage should drop after popout close, not remain elevated.

- [ ] **Step 3.3 — Commit**

  ```bash
  git -C src add -A
  git -C src commit -m "fix: cancel popout rAF loop in useEffect cleanup

  The popout-sync loop called requestAnimationFrame unconditionally and
  never stored the ID. On unmount the cleanup only closed the window but
  the loop kept running forever. Now stores the ID in a closure variable
  and calls cancelAnimationFrame in the cleanup before closing the window.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 4 — Add missing Q.Foam and cyLiquidMode vars to `R.current` (Issue #2)

**Problem:** The `useEffect` that syncs React state into `R.current` (the ref read by the rAF render loop) is missing seven state variables declared at L2746–L2755: `cyLiquidMode`, `cyFoamSpeed`, `cyFoamScale`, `cyFoamLayers`, `cyFoamFlow`, `cyFoamThresh`, `cyFoamBlend`. Any render-loop code reading `rc.cyFoamSpeed` etc. gets `undefined`. UI sliders for Q.Foam controls appear to have no effect.

**Strategy:** Add the seven variables to the last line of the sync object, after `cyFluxLink`.

**Files:**
- Modify: `src/PixelAlchemist.jsx:2920`

---

- [ ] **Step 4.1 — Apply the one-line fix**

  Find line 2920, which currently reads:

  ```js
      cySymLink,cySymApply,cySymHide,cyGridlines,cyInvert,cyGlowAmt,cyXYSwap,cyFreqBands,cySpinRate,cyWarpAmt,cyNoise,cyDecay,cyFracStyle,cyPrisLink,cyFluxLink,
  ```

  Replace it with:

  ```js
      cySymLink,cySymApply,cySymHide,cyGridlines,cyInvert,cyGlowAmt,cyXYSwap,cyFreqBands,cySpinRate,cyWarpAmt,cyNoise,cyDecay,cyFracStyle,cyPrisLink,cyFluxLink,
      cyLiquidMode,cyFoamSpeed,cyFoamScale,cyFoamLayers,cyFoamFlow,cyFoamThresh,cyFoamBlend,
  ```

- [ ] **Step 4.2 — Verify in browser**

  In the app, open the Cymatics section. Switch the cymatic mode to one that uses Q.Foam / Quantum Foam controls (mode 11 — "Quantum Foam"). Adjust the **Speed**, **Scale**, **Layers**, **Flow**, **Thresh**, and **Blend** sliders. The visual output should now respond to each slider in real time. Before this fix, moving those sliders had no visible effect.

- [ ] **Step 4.3 — Commit**

  ```bash
  git -C src add -A
  git -C src commit -m "fix: add cyLiquidMode and Q.Foam vars to R.current render sync

  Seven state variables (cyLiquidMode, cyFoamSpeed, cyFoamScale,
  cyFoamLayers, cyFoamFlow, cyFoamThresh, cyFoamBlend) were declared but
  never included in the R.current sync object that the rAF render loop
  reads. Their UI controls had no visible effect. Added to the sync list.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Task 5 — Guard `canvas.letterSpacing` with a feature-detect (Issue #5)

**Problem:** `buildTextMask` at L202 sets `ctx.letterSpacing = \`${lsPx}px\``. `CanvasRenderingContext2D.letterSpacing` was added to the spec in 2022 (Chrome 99+, Firefox 112+, Safari 17.2+). On unsupported environments it silently does nothing — the spacing slider has no effect and no error is thrown, which is confusing to debug. The `measureText` loop that follows also uses the wrong width when `letterSpacing` is unsupported, potentially sizing text incorrectly.

**Strategy:** Wrap the assignment in a feature-detect (`'letterSpacing' in ctx`). When unsupported, skip the assignment — spacing will be 0, which is acceptable graceful degradation given the browser coverage.

**Files:**
- Modify: `src/PixelAlchemist.jsx:202`

---

- [ ] **Step 5.1 — Apply the guard**

  Find line 202, which currently reads:

  ```js
    ctx.letterSpacing=`${lsPx}px`;
  ```

  Replace with:

  ```js
    if('letterSpacing' in ctx) ctx.letterSpacing=`${lsPx}px`;
  ```

- [ ] **Step 5.2 — Verify in browser**

  In the app, enable the **Glyph** engine module and type a phrase into the text input. Move the **Spacing** slider left (tight) and right (wide). On a supported browser (any modern Chrome/Firefox/Safari), letter spacing should change visibly. The app should not crash or log any errors on unsupported environments.

- [ ] **Step 5.3 — Commit**

  ```bash
  git -C src add -A
  git -C src commit -m "fix: guard ctx.letterSpacing with feature-detect in buildTextMask

  letterSpacing on CanvasRenderingContext2D was added in 2022 and is
  not available in all environments. Without the guard, assignment silently
  fails and the spacing slider appears broken with no error. Added an
  in-operator check; unsupported environments fall back to default spacing.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  ```

---

## Self-Review Checklist

**Spec coverage:**
- Issue #1 (FSlider Rules of Hooks) → Task 1 ✓
- Issue #2 (Q.Foam missing from R.current) → Task 4 ✓
- Issue #3 (rAF not cancelled) → Task 3 ✓
- Issue #4 (missing useEffect deps — FSlider, BracketSlider, RangeSlider) → Tasks 1 + 2 ✓
- Issue #5 (letterSpacing non-universal) → Task 5 ✓
- Issue #6 (my-next-app version mismatch) → Already resolved, not in plan ✓

**Placeholder scan:** All steps contain complete replacement code. No "TBD" or "similar to above" entries.

**Type consistency:** `FSliderLFO` props mirror `FSlider`'s exactly. `onLoRef` / `onHiRef` naming is consistent between BracketSlider and RangeSlider tasks. `rafId` is referenced correctly in both the assignment and `cancelAnimationFrame` call.
