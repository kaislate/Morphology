# AudioFX Visualizer Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-mode cymatics visualizer with 10 independent 200×200px EnginesFX-style cards that composite together via a proper canvas pipeline.

**Architecture:** Each visualizer mode gets its own card component with a live canvas background, per-card state (sensitivity, smoothing, blend mode, render controls), and its own draw function. Active cards render to individual canvases, which are then composited onto the main output canvas in order using `globalCompositeOperation`. The audio analysis pipeline (tickAudio, analyser, band extraction) is untouched.

**Tech Stack:** React 18, inline styles (no Tailwind in card components — matches EnginesFX pattern), Canvas 2D API, `audBusRef` for audio data.

---

## File Structure

All changes are in `src/Morphology.jsx` (monolithic by design). The following sections are modified:

| Location | Change |
|----------|--------|
| ~L2784–2866 | Remove old `cy*` shared state; add `scopeCards` useState + `scopeCardsRef` |
| ~L2988–2994 | Remove old `cy*` from `R.current` sync; add `scopeCards` |
| ~L4179–5005 | Replace old cymatics draw block with new compositing pipeline |
| ~L2449 (before `Morphology()`) | Add `ScopeCard` component, `ScopeCardBack` component, 10 draw functions |
| ~L6511–6645 | Replace Column 3 cymatics JSX with scrollable card row |

Preserved unchanged:
- `tickAudio` (L3147–3225) — audio analysis, reads `rc.cySens`, `rc.cySmooth`, `rc.cyXover*`, `rc.cyLufsWindow` which stay in Column 1
- Column 1 Input/Levels/BPM JSX
- Column 2 LFO + Mod Matrix JSX

---

## Task 1: State Architecture

**Files:**
- Modify: `src/Morphology.jsx` ~L2784–2866 (cymatics state block)
- Modify: `src/Morphology.jsx` ~L2988–2994 (R.current sync useEffect)
- Modify: `src/Morphology.jsx` ~L2866 (cyAtDefaults derived value)

- [ ] **Step 1: Add scopeCards state after the existing cymatics state block**

Find the line:
```js
const [isCymatic,    setIsCymatic]    = useState(false);
```

Replace the entire cymatics state block (everything from `isCymatic` through `cyAtDefaults` at ~L2866) with:

```js
// ── Scope Cards (Visualizer) ──────────────────────────────────────────────
const mkCard=(id,color,extras={})=>({id,color,enabled:false,flipped:false,blend:'screen',sens:0.65,smooth:0.5,intensity:0.75,glow:true,...extras});
const [scopeCards,setScopeCards]=useState([
  mkCard('vscope',   '#22d3ee',{lineStyle:'line',mirror:false}),
  mkCard('polar',    '#67e8f9',{lineStyle:'line',mirror:false}),
  mkCard('wave3d',   '#3b82f6',{depth:0.5,grid:false}),
  mkCard('phosphor', '#22c55e',{persistence:0.7,glowAmt:0.8}),
  mkCard('spectral', '#a855f7',{freqLo:0,freqHi:1,orbitSpeed:0.5,trailLen:0.5}),
  mkCard('particles','#f59e0b',{count:0.5,size:0.5,decay:0.5}),
  mkCard('diff',     '#f97316',{lineStyle:'line',invert:false}),
  mkCard('fractal',  '#ec4899',{iterations:0.5,fracStyle:0}),
  mkCard('neural',   '#10b981',{nodeSize:0.5,edgeOpacity:0.5}),
  mkCard('shard',    '#ef4444',{shardCount:0.5,invert:false}),
]);
const scopeCardsRef=useRef(scopeCards);
const setScopeCard=(id,patch)=>setScopeCards(prev=>prev.map(c=>c.id===id?{...c,...patch}:c));

// Keep these for Column 1 Input section (used by tickAudio)
const [cyListen,     setCyListen]     = useState(false);
const [cyHideCanvas,   setCyHideCanvas]   = useState(false);
const [cyMicErr,     setCyMicErr]     = useState('');
const [cyResetFlash, setCyResetFlash] = useState(false);
const [cyFreqLo,       setCyFreqLo]       = useState(0);
const [cyFreqHi,       setCyFreqHi]       = useState(1);
const [cyFreqHz,     setCyFreqHz]     = useState(false);
const [cyFreqLoHz,   setCyFreqLoHz]   = useState(20);
const [cyFreqHiHz,   setCyFreqHiHz]   = useState(20000);
const [cySens,       setCySens]       = useState(0.65);
const [cySmooth,     setCySmooth]     = useState(0.72);
const [cyXoverSL,    setCyXoverSL]    = useState(80);
const [cyXoverLM,    setCyXoverLM]    = useState(500);
const [cyXoverMH,    setCyXoverMH]    = useState(4000);
const [cyLufsWindow, setCyLufsWindow] = useState(3);
const cyAtDefaults = !cyListen && cyFreqLo===0 && cyFreqHi===1 && cySens===0.65 && cySmooth===0.72;
```

- [ ] **Step 2: Sync scopeCardsRef in the R.current useEffect**

Find the `useEffect` that sets `R.current={...}` (~L2931). Inside it, after the closing `};`, add:

```js
scopeCardsRef.current=scopeCards;
```

Also add `scopeCards` to the dependency array of that useEffect.

Remove all old `cy*` keys from the `R.current = {...}` object except:
`cySens, cySmooth, cyFreqLo, cyFreqHi, cyFreqHz, cyFreqLoHz, cyFreqHiHz, cyXoverSL, cyXoverLM, cyXoverMH, cyLufsWindow, cyHideCanvas`

- [ ] **Step 3: Add per-card canvas refs array**

After `const cyCanvasRef = useRef(null);` (~L2851), add:

```js
const scopeCardCanvasRefs = useRef({});        // id → canvas element
const scopeOutputRef      = useRef(null);      // shared composite output canvas
const scopeSmWfRefs       = useRef({});        // id → Float32Array smoothed waveform
const scopeSmSpRefs       = useRef({});        // id → Float32Array smoothed spectrum
const scopeParticlesRef   = useRef({});        // id → particle array (for particle/shard modes)
const scopePersistRef     = useRef({});        // id → offscreen canvas (for phosphor persistence)
```

- [ ] **Step 4: Verify app still builds**

```bash
npm run dev
```
Expected: App loads, no console errors. The visualizer column will be broken (blank) until Task 9 — that's expected.

- [ ] **Step 5: Commit**

```bash
git add src/Morphology.jsx
git commit -m "refactor: replace shared cymatics state with scopeCards array"
```

---

## Task 2: ScopeCard Front Face Component

**Files:**
- Modify: `src/Morphology.jsx` — add `ScopeCard` component before the `Morphology()` function (~L2480)

- [ ] **Step 1: Add the ScopeCard component**

Insert before the `SplashScreen` function (or before `export default function Morphology`):

```jsx
const SCOPE_CARD_SIZE = 200;

function ScopeCard({ card, canvasRef, onToggle, onFlip }) {
  const { id, color, enabled, flipped } = card;
  const border   = enabled ? `1.5px solid ${color}88` : '1.5px solid #27272a';
  const shadow   = enabled
    ? `0 0 28px ${color}44, inset 0 0 0 1px ${color}22`
    : '0 0 10px rgba(0,0,0,0.5)';

  return (
    <div style={{
      position:'relative', width:SCOPE_CARD_SIZE, height:SCOPE_CARD_SIZE,
      borderRadius:16, overflow:'hidden', border, boxShadow:shadow,
      flexShrink:0, cursor:'default',
    }}>
      {/* Live canvas background */}
      <canvas
        ref={canvasRef}
        width={SCOPE_CARD_SIZE} height={SCOPE_CARD_SIZE}
        style={{
          position:'absolute', inset:0, width:'100%', height:'100%',
          opacity: enabled ? 1 : 0.18,
          display: flipped ? 'none' : 'block',
        }}
      />

      {/* Dark base when flipped */}
      {flipped && (
        <div style={{position:'absolute',inset:0,background:'#08080f'}}/>
      )}

      {/* Top overlay */}
      <div style={{
        position:'absolute', top:0, left:0, right:0, padding:'9px 11px',
        background:'linear-gradient(to bottom,rgba(0,0,0,0.82),transparent)',
        display:'flex', alignItems:'center', justifyContent:'space-between', zIndex:2,
      }}>
        <div style={{display:'flex',alignItems:'center',gap:5}}>
          {enabled && (
            <div style={{width:6,height:6,borderRadius:'50%',background:color,boxShadow:`0 0 8px ${color}`}}/>
          )}
          <span style={{color:enabled?'#fff':'#71717a',fontSize:8,fontWeight:900,fontFamily:'monospace',letterSpacing:'0.08em',textTransform:'uppercase'}}>
            {id}
          </span>
        </div>
        <button onClick={onFlip} style={{
          width:18,height:18,borderRadius:5,border:'1px solid #3f3f46',
          background:'rgba(0,0,0,0.5)',color:'#71717a',fontSize:9,cursor:'pointer',
          display:'flex',alignItems:'center',justifyContent:'center',
        }}>{flipped ? '⊟' : '⊞'}</button>
      </div>

      {/* Bottom bar */}
      <div style={{
        position:'absolute', bottom:0, left:0, right:0, padding:'7px 11px',
        background:'linear-gradient(to top,rgba(0,0,0,0.88),transparent)',
        backdropFilter:'blur(2px)', display:'flex', alignItems:'center',
        justifyContent:'space-between', zIndex:2,
      }}>
        <button onClick={onToggle} style={{
          background: enabled ? `${color}22` : 'rgba(0,0,0,0.3)',
          border: `1px solid ${enabled ? color+'55' : '#3f3f46'}`,
          borderRadius:4, padding:'2px 7px',
          color: enabled ? color : '#52525b',
          fontSize:7, fontWeight:900, fontFamily:'monospace', cursor:'pointer',
        }}>{enabled ? 'ON' : 'OFF'}</button>
        {enabled && (
          <span style={{color:`${color}99`,fontSize:7,fontWeight:900,fontFamily:'monospace',letterSpacing:'0.1em',textTransform:'uppercase'}}>
            {card.blend.toUpperCase()}
          </span>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify no lint errors**

```bash
npm run lint
```
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/Morphology.jsx
git commit -m "feat: add ScopeCard front face component"
```

---

## Task 3: ScopeCard Back Face Component

**Files:**
- Modify: `src/Morphology.jsx` — add `ScopeCardBack` component after `ScopeCard`

- [ ] **Step 1: Add blend mode selector + controls shell**

Insert after the `ScopeCard` function:

```jsx
const BLEND_MODES = [
  ['screen','Screen'],['lighter','Add'],['overlay','Overlay'],
  ['multiply','Multiply'],['source-over','Normal'],
];

function ScopeCardBack({ card, onChange, onFlip }) {
  const { id, color, enabled, blend } = card;
  const col = enabled ? color : '#52525b';

  return (
    <div style={{
      position:'absolute', inset:0, borderRadius:16, overflow:'hidden',
      background:'#08080f', border:`1.5px solid ${enabled?color+'88':'#3f3f46'}`,
      boxShadow: enabled ? `0 0 28px ${color}33` : 'none',
      display:'flex', flexDirection:'column', zIndex:3,
    }}>
      {/* Mini header strip */}
      <div style={{
        background:`linear-gradient(135deg,${color}22,transparent)`,
        borderBottom:`1px solid ${color}22`, padding:'8px 11px',
        display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0,
      }}>
        <span style={{color:col,fontSize:8,fontWeight:900,fontFamily:'monospace',letterSpacing:'0.1em',textTransform:'uppercase'}}>{id}</span>
        <button onClick={onFlip} style={{
          width:22,height:22,borderRadius:6,border:'1px solid #3f3f46',
          background:'rgba(0,0,0,0.5)',color:'#71717a',fontSize:10,cursor:'pointer',
          display:'flex',alignItems:'center',justifyContent:'center',
        }}>⊟</button>
      </div>

      {/* Blend mode row */}
      <div style={{padding:'6px 8px 4px',flexShrink:0}}>
        <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',marginBottom:4}}>Blend</div>
        <div style={{display:'flex',gap:3,flexWrap:'wrap'}}>
          {BLEND_MODES.map(([val,lbl])=>(
            <button key={val} onClick={()=>onChange({blend:val})} style={{
              padding:'2px 5px', borderRadius:4, fontSize:6, fontWeight:900,
              textTransform:'uppercase', cursor:'pointer',
              background: blend===val ? (enabled?`${color}22`:'rgba(80,80,80,0.2)') : 'rgba(0,0,0,0.3)',
              border: `1px solid ${blend===val?(enabled?color+'55':'#52525b'):'#3f3f46'}`,
              color: blend===val ? (enabled?color:'#a1a1aa') : '#52525b',
            }}>{lbl}</button>
          ))}
        </div>
      </div>

      {/* Divider */}
      <div style={{height:1,background:'#27272a',margin:'0 8px',flexShrink:0}}/>

      {/* Per-mode controls — scrollable */}
      <div style={{flex:1,overflowY:'auto',padding:'6px 8px'}}>
        <ScopeCardControls card={card} onChange={onChange} col={col} enabled={enabled}/>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add ScopeCardControls stub (per-mode controls, filled in Task 8)**

Insert after `ScopeCardBack`:

```jsx
function ScopeCardControls({ card, onChange, col, enabled }) {
  const sl=(label,key,min,max,step,def)=>(
    <div style={{marginBottom:5}}>
      <div style={{display:'flex',justifyContent:'space-between',marginBottom:2}}>
        <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.1em',color:'#52525b'}}>{label}</span>
        <span style={{fontSize:6,fontWeight:900,color:enabled?col:'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round(card[key]*100)}%</span>
      </div>
      <FSlider value={card[key]} min={min} max={max} step={step} defaultVal={def}
        onChange={v=>onChange({[key]:v})} color={card.color} enabled={enabled}/>
    </div>
  );
  const tog=(label,key)=>(
    <button key={key} onClick={()=>onChange({[key]:!card[key]})} style={{
      flex:1, padding:'3px 0', borderRadius:5, fontSize:6, fontWeight:900,
      textTransform:'uppercase', cursor:'pointer',
      background: card[key] ? (enabled?`${card.color}22`:'rgba(60,60,60,0.2)') : 'rgba(0,0,0,0.3)',
      border: `1px solid ${card[key]?(enabled?card.color+'55':'#52525b'):'#3f3f46'}`,
      color: card[key] ? (enabled?card.color:'#a1a1aa') : '#52525b',
    }}>{label}</button>
  );

  // Shared signal controls (all modes)
  return (
    <>
      {sl('Sensitivity','sens',0.1,2,0.01,0.65)}
      {sl('Smooth','smooth',0,0.97,0.01,0.5)}
      {sl('Intensity','intensity',0,1,0.01,0.75)}
      <div style={{display:'flex',gap:3,marginBottom:5}}>
        {tog('Glow','glow')}
      </div>
      {/* Mode-specific controls added in Task 8 */}
    </>
  );
}
```

- [ ] **Step 3: Wire ScopeCard to use both faces**

Update `ScopeCard` to render `ScopeCardBack` when `flipped` is true. Replace the `{flipped && <div.../>}` dark base block with:

```jsx
{flipped && (
  <ScopeCardBack card={card} onChange={patch=>setScopeCard(card.id,patch)} onFlip={onFlip}/>
)}
```

Note: `ScopeCard` needs access to `setScopeCard`. Pass it as a prop: add `setScopeCard` to `ScopeCard`'s props and thread it through.

- [ ] **Step 4: Lint check**

```bash
npm run lint
```
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/Morphology.jsx
git commit -m "feat: add ScopeCard back face with blend mode selector and controls shell"
```

---

## Task 4: Compositing Pipeline

**Files:**
- Modify: `src/Morphology.jsx` — rAF loop cymatics block (~L4179–5005)

- [ ] **Step 1: Add scopeOutputRef canvas initialization**

Find `if(!cyCanvasRef.current){...}` (~L4184). After the existing canvas init block, add:

```js
if(!scopeOutputRef.current){
  const c=document.createElement('canvas');
  c.width=D;c.height=D;
  scopeOutputRef.current=c;
}
```

- [ ] **Step 2: Replace the old cymatics draw block with the new compositing pipeline**

Find and replace the entire block from:
```js
if(rc.isCymatic&&audBusRef.current.active){
```
...through the end of the cymatics section (the matching closing brace, ~L5005) with:

```js
// ── Scope Cards: composite pipeline ──────────────────────────────────────
const activeCards=scopeCardsRef.current.filter(c=>c.enabled);
if(activeCards.length>0&&audBusRef.current.active){
  const bus=audBusRef.current;
  const outC=scopeOutputRef.current;
  const outX=outC.getContext('2d');
  outX.clearRect(0,0,D,D);

  for(const card of activeCards){
    // Ensure per-card canvas exists
    if(!scopeCardCanvasRefs.current[card.id]){
      const c=document.createElement('canvas');c.width=D;c.height=D;
      scopeCardCanvasRefs.current[card.id]=c;
    }
    const cardC=scopeCardCanvasRefs.current[card.id];
    const cardX=cardC.getContext('2d');
    cardX.clearRect(0,0,D,D);

    // Ensure per-card smoothing buffers exist
    if(!scopeSmWfRefs.current[card.id]){
      scopeSmWfRefs.current[card.id]=new Float32Array(bus.waveform?.length||2048);
    }
    if(!scopeSmSpRefs.current[card.id]){
      scopeSmSpRefs.current[card.id]=new Float32Array(bus.spectrum?.length||256);
    }

    // Apply per-card JS smoothing to waveform + spectrum
    const smAlpha=Math.max(0.01,1-Math.min(0.99,card.smooth));
    const smWf=scopeSmWfRefs.current[card.id];
    const smSp=scopeSmSpRefs.current[card.id];
    if(bus.waveform){for(let i=0;i<smWf.length&&i<bus.waveform.length;i++)smWf[i]=smWf[i]*(1-smAlpha)+bus.waveform[i]*smAlpha;}
    if(bus.spectrum){for(let i=0;i<smSp.length&&i<bus.spectrum.length;i++)smSp[i]=smSp[i]*(1-smAlpha)+bus.spectrum[i]*smAlpha;}

    // Dispatch to per-mode draw function
    SCOPE_DRAW[card.id]?.(cardX,D,D,smWf,smSp,bus,card,scopePersistRef,scopeParticlesRef,timeRef.current);

    // Copy result to the card's display canvas (the one in the React component)
    const displayC=scopeDisplayCanvasRefs.current[card.id];
    if(displayC){
      const dX=displayC.getContext('2d');
      dX.clearRect(0,0,SCOPE_CARD_SIZE,SCOPE_CARD_SIZE);
      dX.drawImage(cardC,0,0,SCOPE_CARD_SIZE,SCOPE_CARD_SIZE);
    }

    // Composite onto output canvas
    outX.globalCompositeOperation=card.blend;
    outX.drawImage(cardC,0,0,D,D);
  }

  // Draw composite output onto main render canvas
  ctx.save();
  ctx.globalCompositeOperation='screen';
  ctx.drawImage(outC,0,0,D,D);
  ctx.restore();
}
```

- [ ] **Step 3: Add scopeDisplayCanvasRefs alongside scopeCardCanvasRefs**

After `const scopeCardCanvasRefs = useRef({});`, add:

```js
const scopeDisplayCanvasRefs = useRef({});  // id → the canvas DOM element in the React card UI
```

Update `ScopeCard` to register its canvas in `scopeDisplayCanvasRefs`:

```jsx
// In ScopeCard, replace the canvas element:
<canvas
  ref={el=>{
    if(el){
      canvasRefCallback(id, el);
    }
  }}
  width={SCOPE_CARD_SIZE} height={SCOPE_CARD_SIZE}
  style={{...}}
/>
```

Pass `canvasRefCallback` as a prop to `ScopeCard`:
```js
const canvasRefCallback = useCallback((id, el) => {
  scopeDisplayCanvasRefs.current[id] = el;
}, []);
```

- [ ] **Step 4: Add empty SCOPE_DRAW dispatch table**

Before `ScopeCard` component, add:

```js
// Populated in Tasks 5-7
const SCOPE_DRAW = {};
```

- [ ] **Step 5: Verify compositing pipeline runs without errors**

```bash
npm run dev
```

Enable mic, then open the browser console. Expected: No errors. The card row is not wired yet (Task 9) so cards won't display — but the rAF loop should not throw.

- [ ] **Step 6: Commit**

```bash
git add src/Morphology.jsx
git commit -m "feat: add scope card compositing pipeline in rAF loop"
```

---

## Task 5: Draw Functions — Waveform Group (VScope, Polar, 3D Wave, Phosphor)

**Files:**
- Modify: `src/Morphology.jsx` — add draw functions before `const SCOPE_DRAW = {};`

- [ ] **Step 1: Add VScope (oscilloscope) draw function**

```js
function drawVScope(ctx, W, H, wf, sp, bus, card) {
  const { color, sens, intensity, glow, lineStyle, mirror } = card;
  const N = wf.length; if (!N) return;
  const amp = sens * intensity * (H / 2);
  ctx.save();
  if (glow) { ctx.shadowBlur = 12; ctx.shadowColor = color; }
  ctx.strokeStyle = color; ctx.lineWidth = lineStyle === 'thick' ? 2.5 : 1.5;
  ctx.beginPath();
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * W;
    const y = H / 2 - wf[i] * amp;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  if (mirror) {
    ctx.scale(1, -1); ctx.translate(0, -H);
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * W;
      const y = H / 2 - wf[i] * amp;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}
SCOPE_DRAW['vscope'] = drawVScope;
```

- [ ] **Step 2: Add Polar draw function**

```js
function drawPolar(ctx, W, H, wf, sp, bus, card) {
  const { color, sens, intensity, glow, lineStyle, mirror } = card;
  const N = wf.length; if (!N) return;
  const cx = W / 2, cy = H / 2;
  const baseR = Math.min(W, H) * 0.28;
  const amp = sens * intensity * baseR * 1.8;
  ctx.save();
  if (glow) { ctx.shadowBlur = 14; ctx.shadowColor = color; }
  ctx.strokeStyle = color; ctx.lineWidth = lineStyle === 'thick' ? 2 : 1.5;
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const idx = i % N;
    const angle = (idx / N) * Math.PI * 2 - Math.PI / 2;
    const r = baseR + wf[idx] * amp;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath(); ctx.stroke();
  if (mirror) {
    ctx.globalAlpha = 0.3; ctx.scale(-1, 1); ctx.translate(-W, 0);
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const idx = i % N;
      const angle = (idx / N) * Math.PI * 2 - Math.PI / 2;
      const r = baseR + wf[idx] * amp;
      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath(); ctx.stroke();
  }
  ctx.restore();
}
SCOPE_DRAW['polar'] = drawPolar;
```

- [ ] **Step 3: Add 3D Wave draw function**

```js
function draw3DWave(ctx, W, H, wf, sp, bus, card) {
  const { color, sens, intensity, glow, depth, grid } = card;
  const N = wf.length; if (!N) return;
  const layers = 18;
  const amp = sens * intensity * (H / 3.5);
  ctx.save();
  if (grid) {
    ctx.strokeStyle = '#ffffff18'; ctx.lineWidth = 0.5;
    for (let l = 0; l < layers; l++) {
      const oy = (H * 0.15) + (l / (layers - 1)) * (H * 0.6);
      ctx.beginPath(); ctx.moveTo(0, oy); ctx.lineTo(W, oy); ctx.stroke();
    }
  }
  for (let l = 0; l < layers; l++) {
    const t = l / (layers - 1);
    const oy = (H * 0.15) + t * (H * 0.6);
    const alpha = 0.15 + t * 0.7;
    const depthScale = 0.4 + t * 0.6 * (depth * 2);
    if (glow) { ctx.shadowBlur = 8 * t; ctx.shadowColor = color; }
    ctx.strokeStyle = color; ctx.lineWidth = 0.8 + t * 1.2; ctx.globalAlpha = alpha;
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * W;
      const y = oy - wf[i] * amp * depthScale;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}
SCOPE_DRAW['wave3d'] = draw3DWave;
```

- [ ] **Step 4: Add Phosphor draw function (with persistence)**

```js
function drawPhosphor(ctx, W, H, wf, sp, bus, card, persistRef) {
  const { id, color, sens, intensity, glow, persistence, glowAmt } = card;
  const N = wf.length; if (!N) return;
  const amp = sens * intensity * (H / 2);

  // Ensure persist canvas exists
  if (!persistRef.current[id]) {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    persistRef.current[id] = c;
  }
  const pC = persistRef.current[id];
  const pX = pC.getContext('2d');

  // Fade persist canvas
  pX.globalCompositeOperation = 'source-over';
  pX.fillStyle = `rgba(0,0,0,${1 - (persistence * 0.85 + 0.05)})`;
  pX.fillRect(0, 0, W, H);

  // Draw new waveform onto persist canvas
  pX.globalCompositeOperation = 'lighter';
  pX.strokeStyle = color; pX.lineWidth = 1.5;
  if (glow) { pX.shadowBlur = 16 * glowAmt; pX.shadowColor = color; }
  pX.beginPath();
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * W;
    const y = H / 2 - wf[i] * amp;
    i === 0 ? pX.moveTo(x, y) : pX.lineTo(x, y);
  }
  pX.stroke();

  // Blit persist canvas to output
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(pC, 0, 0);
}
SCOPE_DRAW['phosphor'] = (ctx, W, H, wf, sp, bus, card, persistRef, partsRef) =>
  drawPhosphor(ctx, W, H, wf, sp, bus, card, persistRef);
```

- [ ] **Step 5: Verify dev server, no errors**

```bash
npm run dev
```
Expected: No console errors.

- [ ] **Step 6: Commit**

```bash
git add src/Morphology.jsx
git commit -m "feat: add VScope, Polar, 3DWave, Phosphor draw functions"
```

---

## Task 6: Draw Functions — Spectral & Differential

**Files:**
- Modify: `src/Morphology.jsx` — add after Task 5 draw functions

- [ ] **Step 1: Add Spectral Orbit draw function**

```js
function drawSpectral(ctx, W, H, wf, sp, bus, card, persistRef, partsRef, t) {
  const { color, sens, intensity, glow, freqLo, freqHi, orbitSpeed, trailLen } = card;
  if (!sp || !sp.length) return;
  const cx = W / 2, cy = H / 2;
  const N = sp.length;
  const lo = Math.floor((freqLo ?? 0) * N);
  const hi = Math.ceil((freqHi ?? 1) * N);
  const bands = hi - lo; if (bands < 1) return;
  const baseR = Math.min(W, H) * 0.25;
  const maxR  = Math.min(W, H) * 0.46;

  // Ensure persist canvas for trails
  if (!persistRef.current[card.id]) {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    persistRef.current[card.id] = c;
  }
  const pC = persistRef.current[card.id];
  const pX = pC.getContext('2d');
  pX.fillStyle = `rgba(0,0,0,${1 - trailLen * 0.85})`;
  pX.fillRect(0, 0, W, H);

  const spin = t * orbitSpeed * 0.0008;
  if (glow) { ctx.shadowBlur = 10; ctx.shadowColor = color; }
  pX.strokeStyle = color; pX.lineWidth = 1.5;
  pX.beginPath();
  for (let i = 0; i < bands; i++) {
    const angle = spin + (i / bands) * Math.PI * 2;
    const v = sp[lo + i] / 255;
    const r = baseR + v * (maxR - baseR) * sens * intensity;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    i === 0 ? pX.moveTo(x, y) : pX.lineTo(x, y);
  }
  pX.closePath(); pX.stroke();
  ctx.drawImage(pC, 0, 0);
}
SCOPE_DRAW['spectral'] = drawSpectral;
```

- [ ] **Step 2: Add Differential draw function**

```js
function drawDiff(ctx, W, H, wf, sp, bus, card) {
  const { color, sens, intensity, glow, lineStyle, invert } = card;
  const N = wf.length; if (!N) return;
  const amp = sens * intensity * (H / 2) * 8;
  ctx.save();
  if (invert) { ctx.fillStyle = '#ffffff08'; ctx.fillRect(0, 0, W, H); }
  if (glow) { ctx.shadowBlur = 10; ctx.shadowColor = color; }
  ctx.strokeStyle = invert ? '#000000' : color;
  ctx.lineWidth = lineStyle === 'thick' ? 2 : 1.5;
  ctx.beginPath();
  for (let i = 1; i < N; i++) {
    const x = (i / (N - 1)) * W;
    const dy = (wf[i] - wf[i - 1]) * amp;
    const y = H / 2 - dy;
    i === 1 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}
SCOPE_DRAW['diff'] = drawDiff;
```

- [ ] **Step 3: Commit**

```bash
git add src/Morphology.jsx
git commit -m "feat: add Spectral Orbit and Differential draw functions"
```

---

## Task 7: Draw Functions — Generative Group (Particles, Fractal, Neural, Shard)

**Files:**
- Modify: `src/Morphology.jsx` — add after Task 6 draw functions

- [ ] **Step 1: Add Particles draw function**

```js
function drawParticles(ctx, W, H, wf, sp, bus, card, persistRef, partsRef) {
  const { id, color, sens, intensity, glow, count, size, decay } = card;
  const bass = (bus.bass || 0) * sens;

  if (!partsRef.current[id]) partsRef.current[id] = [];
  const parts = partsRef.current[id];
  const maxP = Math.round(count * 180 + 20);

  // Spawn particles on beat or continuously based on bass
  if (bass > 0.15 && parts.length < maxP) {
    const n = Math.round(bass * 8 * intensity);
    for (let i = 0; i < n; i++) {
      parts.push({
        x: W / 2 + (Math.random() - 0.5) * W * 0.4,
        y: H / 2 + (Math.random() - 0.5) * H * 0.4,
        vx: (Math.random() - 0.5) * bass * 4,
        vy: (Math.random() - 0.5) * bass * 4 - bass * 1.5,
        life: 1, r: (size * 3 + 1) * (0.5 + Math.random() * 0.5),
      });
    }
  }

  const damp = 1 - decay * 0.04;
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.x += p.vx; p.y += p.vy; p.vy += 0.04; p.vx *= damp; p.life -= 0.018 + decay * 0.02;
    if (p.life <= 0) { parts.splice(i, 1); continue; }
    if (glow) { ctx.shadowBlur = 8; ctx.shadowColor = color; }
    ctx.globalAlpha = p.life * intensity;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;
}
SCOPE_DRAW['particles'] = drawParticles;
```

- [ ] **Step 2: Add Fractal draw function**

```js
function drawFractal(ctx, W, H, wf, sp, bus, card, persistRef, partsRef, t) {
  const { color, sens, intensity, glow, iterations, fracStyle } = card;
  const bass = (bus.bass || 0) * sens;
  const treble = (bus.treble || 0) * sens;
  const cx = W / 2, cy = H / 2;
  const depth = Math.round(iterations * 5 + 3);
  const baseLen = Math.min(W, H) * 0.28 * (0.5 + bass * 0.8);

  if (glow) { ctx.shadowBlur = 14; ctx.shadowColor = color; }
  ctx.strokeStyle = color; ctx.lineWidth = 1;

  function branch(x, y, angle, len, d) {
    if (d === 0 || len < 1) return;
    const ex = x + Math.cos(angle) * len;
    const ey = y + Math.sin(angle) * len;
    ctx.globalAlpha = (d / depth) * intensity;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke();
    const spread = (Math.PI / 4) + treble * 0.5;
    const wave = Math.sin(t * 0.001 + d) * 0.3 * bass;
    branch(ex, ey, angle - spread + wave, len * 0.65, d - 1);
    branch(ex, ey, angle + spread + wave, len * 0.65, d - 1);
  }

  branch(cx, cy + baseLen * 0.8, -Math.PI / 2, baseLen, depth);
  ctx.globalAlpha = 1;
}
SCOPE_DRAW['fractal'] = drawFractal;
```

- [ ] **Step 3: Add Neural draw function**

```js
function drawNeural(ctx, W, H, wf, sp, bus, card, persistRef, partsRef, t) {
  const { color, sens, intensity, glow, nodeSize, edgeOpacity } = card;
  const bass = (bus.bass || 0) * sens;
  const mid  = (bus.mid  || 0) * sens;
  const treble=(bus.treble||0)*sens;

  if (!partsRef.current[card.id]) {
    partsRef.current[card.id] = Array.from({length:20},()=>({
      x: Math.random()*W, y: Math.random()*H,
      vx:(Math.random()-.5)*0.4, vy:(Math.random()-.5)*0.4,
    }));
  }
  const nodes = partsRef.current[card.id];
  const speed = 0.4 + bass * 2;
  nodes.forEach(n=>{
    n.x += n.vx * speed; n.y += n.vy * speed;
    if(n.x<0||n.x>W) n.vx*=-1;
    if(n.y<0||n.y>H) n.vy*=-1;
  });

  const maxDist = 60 + mid * 80;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dx = nodes[j].x - nodes[i].x, dy = nodes[j].y - nodes[i].y;
      const dist = Math.sqrt(dx*dx+dy*dy);
      if (dist < maxDist) {
        const alpha = (1 - dist / maxDist) * edgeOpacity * intensity;
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = color; ctx.lineWidth = 0.8 + treble;
        if(glow){ctx.shadowBlur=6;ctx.shadowColor=color;}
        ctx.beginPath(); ctx.moveTo(nodes[i].x,nodes[i].y); ctx.lineTo(nodes[j].x,nodes[j].y); ctx.stroke();
      }
    }
  }
  const r = nodeSize * 5 + 2 + bass * 4;
  nodes.forEach(n=>{
    ctx.globalAlpha = 0.7 * intensity;
    ctx.fillStyle = color;
    if(glow){ctx.shadowBlur=10;ctx.shadowColor=color;}
    ctx.beginPath(); ctx.arc(n.x,n.y,r,0,Math.PI*2); ctx.fill();
  });
  ctx.globalAlpha=1;
}
SCOPE_DRAW['neural'] = drawNeural;
```

- [ ] **Step 4: Add Shard draw function**

```js
function drawShard(ctx, W, H, wf, sp, bus, card, persistRef, partsRef, t) {
  const { color, sens, intensity, glow, shardCount, invert } = card;
  const bass   = (bus.bass   || 0) * sens;
  const treble = (bus.treble || 0) * sens;
  const rms    = (bus.rms    || 0) * sens;
  const cx = W / 2, cy = H / 2;
  const count = Math.round(shardCount * 12 + 4);

  if (invert) { ctx.fillStyle = '#ffffff06'; ctx.fillRect(0, 0, W, H); }
  if (glow) { ctx.shadowBlur = 12; ctx.shadowColor = color; }

  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + t * 0.0004 + bass * 0.5;
    const r1 = (0.15 + rms * 0.2 + bass * 0.15) * Math.min(W, H);
    const r2 = r1 * (0.3 + treble * 0.5 + Math.random() * 0.2);
    const spread = (Math.PI / count) * (0.3 + intensity * 0.5);
    ctx.globalAlpha = (0.4 + bass * 0.5) * intensity;
    ctx.strokeStyle = color; ctx.lineWidth = 1 + bass * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle - spread) * r1, cy + Math.sin(angle - spread) * r1);
    ctx.lineTo(cx + Math.cos(angle) * r2, cy + Math.sin(angle) * r2);
    ctx.lineTo(cx + Math.cos(angle + spread) * r1, cy + Math.sin(angle + spread) * r1);
    ctx.closePath(); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
SCOPE_DRAW['shard'] = drawShard;
```

- [ ] **Step 5: Lint and dev check**

```bash
npm run lint && npm run dev
```
Expected: 0 lint errors, app loads without console errors.

- [ ] **Step 6: Commit**

```bash
git add src/Morphology.jsx
git commit -m "feat: add Particles, Fractal, Neural, Shard draw functions"
```

---

## Task 8: Per-Card Back Controls (ScopeCardControls)

**Files:**
- Modify: `src/Morphology.jsx` — replace the `ScopeCardControls` stub from Task 3

- [ ] **Step 1: Replace ScopeCardControls with full per-mode controls**

Find the `ScopeCardControls` function added in Task 3 and replace it entirely:

```jsx
function ScopeCardControls({ card, onChange, col, enabled }) {
  const { id } = card;

  const sl = (label, key, min, max, step, def) => (
    <div key={key} style={{marginBottom:5}}>
      <div style={{display:'flex',justifyContent:'space-between',marginBottom:2}}>
        <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.1em',color:'#52525b'}}>{label}</span>
        <span style={{fontSize:6,fontWeight:900,color:enabled?col:'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round(card[key]*100)}%</span>
      </div>
      <FSlider value={card[key]} min={min} max={max} step={step} defaultVal={def}
        onChange={v=>onChange({[key]:v})} color={card.color} enabled={enabled}/>
    </div>
  );

  const tog = (label, key) => (
    <button key={key} onClick={()=>onChange({[key]:!card[key]})} style={{
      flex:1,padding:'3px 0',borderRadius:5,fontSize:6,fontWeight:900,
      textTransform:'uppercase',cursor:'pointer',
      background:card[key]?(enabled?`${card.color}22`:'rgba(60,60,60,0.2)'):'rgba(0,0,0,0.3)',
      border:`1px solid ${card[key]?(enabled?card.color+'55':'#52525b'):'#3f3f46'}`,
      color:card[key]?(enabled?card.color:'#a1a1aa'):'#52525b',
    }}>{label}</button>
  );

  const lineStyleRow = () => (
    <div style={{marginBottom:5}}>
      <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.1em',color:'#52525b',marginBottom:3}}>Line Style</div>
      <div style={{display:'flex',gap:3}}>
        {['line','thick','fill'].map(v=>(
          <button key={v} onClick={()=>onChange({lineStyle:v})} style={{
            flex:1,padding:'2px 0',borderRadius:4,fontSize:6,fontWeight:900,textTransform:'uppercase',cursor:'pointer',
            background:card.lineStyle===v?(enabled?`${card.color}22`:'rgba(60,60,60,0.2)'):'rgba(0,0,0,0.3)',
            border:`1px solid ${card.lineStyle===v?(enabled?card.color+'55':'#52525b'):'#3f3f46'}`,
            color:card.lineStyle===v?(enabled?card.color:'#a1a1aa'):'#52525b',
          }}>{v}</button>
        ))}
      </div>
    </div>
  );

  // Shared signal controls
  const sharedSignal = <>
    {sl('Sensitivity','sens',0.1,2,0.01,0.65)}
    {sl('Smooth','smooth',0,0.97,0.01,0.5)}
    {sl('Intensity','intensity',0,1,0.01,0.75)}
  </>;

  const glowToggle = <div style={{display:'flex',gap:3,marginBottom:5}}>{tog('Glow','glow')}</div>;

  if (id === 'vscope' || id === 'polar') return <>{sharedSignal}{lineStyleRow()}<div style={{display:'flex',gap:3,marginBottom:5}}>{tog('Mirror','mirror')}{tog('Glow','glow')}</div></>;
  if (id === 'wave3d') return <>{sharedSignal}{sl('Depth','depth',0,1,0.01,0.5)}<div style={{display:'flex',gap:3,marginBottom:5}}>{tog('Grid','grid')}{tog('Glow','glow')}</div></>;
  if (id === 'phosphor') return <>{sharedSignal}{sl('Persistence','persistence',0,0.99,0.01,0.7)}{sl('Glow Amt','glowAmt',0,1,0.01,0.8)}{glowToggle}</>;
  if (id === 'spectral') return <>{sharedSignal}{sl('Orbit Speed','orbitSpeed',0,1,0.01,0.5)}{sl('Trail Length','trailLen',0,0.99,0.01,0.5)}{sl('Freq Lo','freqLo',0,1,0.01,0)}{sl('Freq Hi','freqHi',0,1,0.01,1)}{glowToggle}</>;
  if (id === 'particles') return <>{sharedSignal}{sl('Count','count',0,1,0.01,0.5)}{sl('Size','size',0,1,0.01,0.5)}{sl('Decay','decay',0,1,0.01,0.5)}{glowToggle}</>;
  if (id === 'diff') return <>{sharedSignal}{lineStyleRow()}<div style={{display:'flex',gap:3,marginBottom:5}}>{tog('Invert','invert')}{tog('Glow','glow')}</div></>;
  if (id === 'fractal') {
    return <>{sharedSignal}{sl('Iterations','iterations',0,1,0.01,0.5)}
      <div style={{marginBottom:5}}>
        <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#52525b',marginBottom:3}}>Style</div>
        <div style={{display:'flex',gap:3}}>{[0,1,2,3,4].map(n=>(
          <button key={n} onClick={()=>onChange({fracStyle:n})} style={{flex:1,padding:'2px 0',borderRadius:4,fontSize:7,fontWeight:900,cursor:'pointer',
            background:card.fracStyle===n?(enabled?`${card.color}22`:'rgba(60,60,60,0.2)'):'rgba(0,0,0,0.3)',
            border:`1px solid ${card.fracStyle===n?(enabled?card.color+'55':'#52525b'):'#3f3f46'}`,
            color:card.fracStyle===n?(enabled?card.color:'#a1a1aa'):'#52525b',
          }}>{n+1}</button>
        ))}</div>
      </div>{glowToggle}</>;
  }
  if (id === 'neural') return <>{sharedSignal}{sl('Node Size','nodeSize',0,1,0.01,0.5)}{sl('Edge Opacity','edgeOpacity',0,1,0.01,0.5)}{glowToggle}</>;
  if (id === 'shard') return <>{sharedSignal}{sl('Shard Count','shardCount',0,1,0.01,0.5)}<div style={{display:'flex',gap:3,marginBottom:5}}>{tog('Invert','invert')}{tog('Glow','glow')}</div></>;
  return sharedSignal;
}
```

- [ ] **Step 2: Lint check**

```bash
npm run lint
```
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/Morphology.jsx
git commit -m "feat: add per-mode controls to ScopeCardControls"
```

---

## Task 9: Replace Column 3 JSX with Card Row

**Files:**
- Modify: `src/Morphology.jsx` — Column 3 cymatics JSX (~L6511–6645)

- [ ] **Step 1: Find the Column 3 cymatics JSX block**

Locate:
```jsx
{/* ── Column 3: Vectorscope / Cymatics ──────────────────────────── */}
<div className={`border rounded-xl p-3 ...`}>
```
Through the RESET AUDIOFX button and closing `</div>` (~L6645).

- [ ] **Step 2: Replace the entire Column 3 block**

Replace with:

```jsx
{/* ── Scope Cards ─────────────────────────────────────────────────── */}
<div style={{
  overflowX:'auto', overflowY:'visible',
  paddingBottom:8, paddingTop:4,
  marginTop:4,
}}>
  <div style={{display:'flex',gap:10,width:'max-content',minWidth:'100%'}}>
    {scopeCards.map(card=>(
      <div key={card.id} style={{position:'relative',width:SCOPE_CARD_SIZE,height:SCOPE_CARD_SIZE,flexShrink:0}}>
        <ScopeCard
          card={card}
          canvasRefCallback={canvasRefCallback}
          onToggle={()=>setScopeCard(card.id,{enabled:!card.enabled})}
          onFlip={()=>setScopeCard(card.id,{flipped:!card.flipped})}
          setScopeCard={setScopeCard}
        />
        {card.flipped&&(
          <ScopeCardBack
            card={card}
            onChange={patch=>setScopeCard(card.id,patch)}
            onFlip={()=>setScopeCard(card.id,{flipped:false})}
          />
        )}
      </div>
    ))}
  </div>
</div>
```

- [ ] **Step 3: Add canvasRefCallback to the Morphology component**

After the `scopeDisplayCanvasRefs` ref declaration, add:

```js
const canvasRefCallback = useCallback((id, el) => {
  scopeDisplayCanvasRefs.current[id] = el;
}, []);
```

Ensure `useCallback` is imported (it should already be, since React hooks are imported at the top).

- [ ] **Step 4: Verify visually in dev server**

```bash
npm run dev
```

1. Open the app — splash screen should appear and fade
2. Scroll down to the AudioFX section
3. 10 visualizer cards should appear in a scrollable row — all showing OFF state
4. Enable mic (Column 1) and grant permission
5. Click ON for VScope — card should glow cyan and show live waveform in background
6. Click ON for Polar — second card activates, both composite together
7. Flip any card — back face with controls should appear
8. Adjust Sensitivity on a card — only that card's response changes
9. Change blend mode — compositing behavior updates

- [ ] **Step 5: Commit**

```bash
git add src/Morphology.jsx
git commit -m "feat: replace cymatics Column 3 JSX with ScopeCard row"
```

---

## Task 10: Cleanup — Remove Orphaned State & Lint

**Files:**
- Modify: `src/Morphology.jsx` — remove remaining unused `cy*` state variables and references

- [ ] **Step 1: Find and remove unused cymatics state**

Search for any remaining `cy*` state variables that are no longer referenced in the JSX or logic. The following should now be fully unused and safe to remove:

```
isCymatic / setIsCymatic
cyMode / setCyMode
cyBlend / setCyBlend
cyAmt / setCyAmt
cyColor / setCyColor
cyColorMode / setCyColorMode
cyMirror / setCyMirror
cyFill / setCyFill
cyGlow / setCyGlow
cyAutoGain / setCyAutoGain / cyAutoGainRef
cyStereoWidth / setCyStereoWidth
cyPhaseOff / setCyPhaseOff
cyTrails / setCyTrails
cyScopeZoom / setCyScopeZoom
cyScopeRot / setCyScopeRot
cySpinRate / setCySpinRate / cySpinRef
cyWarpAmt / setCyWarpAmt
cyNoise / setCyNoise
cyDecay / setCyDecay
cyFracStyle / setCyFracStyle
cyLiquidMode / setCyLiquidMode
cyPrisLink / setCyPrisLink
cyFluxLink / setCyFluxLink
cyRender / setCyRender
cyGridlines / setCyGridlines
cyInvert / setCyInvert
cyGlowAmt / setCyGlowAmt
cyXYSwap / setCyXYSwap
cyFreqBands / setCyFreqBands
cyLissMode / setCyLissMode
cyScopeDecay / setCyScopeDecay
cyScopeLine / setCyScopeLine
cySymLink / setCySymLink
cySymApply / setCySymApply
cySymHide / setCySymHide
cySymCanvasRef
cyPersistRef
cyPostTempRef
cyWaterfallRef
cyFabBassRef / cyFabRmsRef / cyFabTrebRef / cyFabMidRef
cySmWfRef / cySmSpRef
cyPartsRef
```

Run lint after each deletion batch to catch accidental breakage:

```bash
npm run lint
```

- [ ] **Step 2: Remove old cymatics references from R.current sync**

In the `R.current = {...}` object, remove all old `cy*` keys (they were removed from state in Task 1 but may still be referenced). Keep only:
`cySens, cySmooth, cyFreqLo, cyFreqHi, cyFreqHz, cyFreqLoHz, cyFreqHiHz, cyXoverSL, cyXoverLM, cyXoverMH, cyLufsWindow, cyHideCanvas`

- [ ] **Step 3: Update the RESET AUDIOFX button**

The old reset button (~L6643) called `setIsCymatic`, `setCyMode`, etc. Replace its `onClick` handler with one that only resets what remains — the Column 1 controls and the scopeCards:

```js
onClick={()=>{
  stopAudio();
  setScopeCards(prev=>prev.map(c=>({...c,enabled:false,flipped:false,blend:'screen',sens:0.65,smooth:0.5,intensity:0.75,glow:true})));
  setAudPins(()=>{const m={};AUD_SOURCES.forEach(s=>{m[s]={};AUD_TARGETS.forEach(t=>{m[s][t]=false;});});return m;});
  setLfos([{enabled:false,rate:0.3,depth:0.7,shape:0,phase:0,bpmSync:false,bpmDiv:1},{enabled:false,rate:0.3,depth:0.7,shape:0,phase:0,bpmSync:false,bpmDiv:2},{enabled:false,rate:0.3,depth:0.7,shape:0,phase:0,bpmSync:false,bpmDiv:4},{enabled:false,rate:0.3,depth:0.7,shape:0,phase:0,bpmSync:false,bpmDiv:8}]);
  setCyResetFlash(true); setTimeout(()=>setCyResetFlash(false),300);
}}
```

- [ ] **Step 4: Final lint + dev verification**

```bash
npm run lint
npm run dev
```

Final checklist:
- [ ] 0 lint errors
- [ ] App loads with splash screen
- [ ] All 10 scope cards render in a scrollable row
- [ ] VScope shows live waveform when mic is active and card is ON
- [ ] Two cards active simultaneously composite correctly
- [ ] Blend mode change on back face updates compositing
- [ ] Flipping a card shows per-mode controls
- [ ] Per-card sensitivity is independent
- [ ] Disabling all cards clears the composite output
- [ ] Column 1 (Input/Levels/BPM) is unaffected
- [ ] Column 2 (LFO + Mod Matrix) is unaffected

- [ ] **Step 5: Final commit**

```bash
git add src/Morphology.jsx
git commit -m "feat: complete AudioFX visualizer redesign — 10 independent scope cards with compositing pipeline"
```
