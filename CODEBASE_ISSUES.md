# Codebase Issues & Inconsistencies

Potential bugs, anti-patterns, and inconsistencies found during review of the Morphology codebase. Grouped by severity.

---

## Critical

### 1. Rules of Hooks violation in `FSlider` (PixelAlchemist.jsx ~L257)

`FSlider` has an early `return` inside a conditional, and then calls `useRef` and `useEffect` *after* that return:

```jsx
const FSlider = ({ ..., lfoRange, onRangeChange }) => {
  const pct = ...;
  const fill = ...;
  const onDbl = ...;

  if (!lfoRange) {
    return <input type="range" ... />;  // ← early return
  }

  // These hooks are ONLY called when lfoRange is truthy — VIOLATION:
  const trackRef = useRef(null);   // ← L271
  const dragRef  = useRef(null);   // ← L272
  ...
  useEffect(() => { ... }, [lo, hi, min, max]);  // ← L281
};
```

**Why it's a problem:** React tracks hooks by call-order per render. When `lfoRange` changes between truthy/falsy, a different number of hooks are called, breaking React's internal state. React's strict mode will warn; without it the behavior is undefined (state association can silently corrupt).

**Fix:** Move `useRef` and `useEffect` to before the early return, or split into two separate components.

---

## High

### 2. Q.Foam / Cymatic Liquid state not synced into `R.current` (PixelAlchemist.jsx ~L2890)

The `useEffect` that syncs all state into `R.current` (the ref read by the rAF render loop) is missing several Cymatics state variables:

- `cyLiquidMode` (L2746)
- `cyFoamSpeed`, `cyFoamScale`, `cyFoamLayers`, `cyFoamFlow`, `cyFoamThresh`, `cyFoamBlend` (L2750–2755)

Any render-loop code that reads `rc.cyFoamSpeed` etc. will get `undefined`. Sliders for these controls will appear to have no effect.

**Fix:** Add the missing variables to the `R.current` sync object at ~L2891.

---

### 3. `requestAnimationFrame` loop in popout sync never cancelled (PixelAlchemist.jsx ~L2958)

```js
useEffect(() => {
  const sync = now => {
    // ... mirror canvas to popup ...
    requestAnimationFrame(sync);  // ← recurses forever
  };
  requestAnimationFrame(sync);
  return () => {
    if (popoutWindowRef.current && !popoutWindowRef.current.closed)
      popoutWindowRef.current.close();
    // ← rAF ID is never stored or cancelled
  };
}, []);
```

The cleanup function closes the popup window but does not cancel the `requestAnimationFrame` loop. After the component unmounts, `sync` keeps running indefinitely (each call schedules the next). This is a memory/CPU leak that persists for the lifetime of the browser tab.

**Fix:** Store the rAF handle and call `cancelAnimationFrame(id)` in the cleanup.

---

### 4. Missing `useEffect` dependencies in slider components

Three components have `useEffect` hooks with incomplete dependency arrays — captured callbacks will go stale:

| Component | Missing from deps | Location |
|---|---|---|
| `FSlider` (LFO range mode) | `onChange`, `onRangeChange` | ~L281 deps: `[lo,hi,min,max]` |
| `BracketSlider` | `onLoChange`, `onHiChange` | ~L343 deps: `[lo,hi]` |
| `RangeSlider` | `onLoChange`, `onHiChange` | ~L376 deps: `[lo,hi]` |

If the parent re-creates these callbacks (e.g. inline arrow functions), the event handlers inside the effect will hold a reference to the old closure version.

**Fix:** Add the missing callback props to each `useEffect` dependency array, or wrap parent callbacks in `useCallback`.

---

## Medium

### 5. `canvas.letterSpacing` used in `buildTextMask` — non-universal API (L202)

```js
ctx.letterSpacing = `${lsPx}px`;
```

`CanvasRenderingContext2D.letterSpacing` was only added to the Canvas 2D spec in 2022 and shipped in Chrome 99+ / Firefox 112+ / Safari 17.2+. In any older browser (or certain mobile WebViews) this silently does nothing — letter spacing is ignored without any error thrown.

**Fix:** Document the browser requirement, or fall back gracefully (e.g., render each character separately with manual `x` offsets for older browsers).

---

### 6. `my-next-app` version mismatch: `next@16.1.5` vs `eslint-config-next@15.4.6`

`my-next-app/package.json`:
```json
"next": "16.1.5",
"eslint-config-next": "15.4.6"
```

`eslint-config-next` should match the installed Next.js major version. Using a v15 config with a v16 Next.js install may skip new lint rules, or produce false positives/negatives. The `eslint-config-next` package peer-dep check will also likely log a warning on `npm install`.

**Fix:** Update `eslint-config-next` to `^16.x` to match `next`.

---

### 7. `next.config.ts` — `import` statement appears after `export default` (my-next-app/next.config.ts L11)

```ts
export default nextConfig;   // line 7

// ...
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";  // line 11
initOpenNextCloudflareForDev();
```

ES module `import` declarations are hoisted (executed before any other code), so this works at runtime. However, placing an import statement after `export default` is unconventional and can confuse static analysis tools, linters, and bundlers. Some tools will flag this as a parse-order issue.

**Fix:** Move both the `import` and the `initOpenNextCloudflareForDev()` call to the top of the file, before the `nextConfig` definition.

---

## Low / Informational

### 8. `ZApp.build.jsx` is an orphaned file (src/ZApp.build.jsx)

This file (~41K tokens) is an older version of the application that is never imported anywhere. `App.jsx` imports only `PixelAlchemist.jsx`. The file is included in the Vite build scan unnecessarily.

It also defines a different (simpler) version of `FSlider` and `FxModule` that don't include LFO range support, so it represents a snapshot of an earlier feature state rather than a divergent branch.

**Recommendation:** Move to `OLD PA files/` or delete if no longer needed for reference.

---

### 9. `src.worktrees/` directories are abandoned git worktrees

Two directories exist:
- `src.worktrees/copilot-worktree-2026-02-26T17-43-13/`
- `src.worktrees/copilot-worktree-2026-02-26T20-01-00/`

These are leftover worktrees from Copilot-assisted sessions. The worktrees contain their own `.git` pointer files and multiple old versions of `PixelAlchemist.jsx` (`.old0` through `.old9`, `.C0`–`.C2`, `.D0`–`.D1`, etc.).

These add significant clutter and their `.git` file pointers reference the `src/.git` repo, which means `git worktree list` will show them as active. If the worktree paths are no longer valid, the repo metadata is stale.

**Recommendation:** Run `git worktree remove src.worktrees/copilot-worktree-*` (from within the `src/` directory) to cleanly deregister them, then delete the folders.

---

### 10. `README.md` is the unchanged Vite template boilerplate

The root `README.md` is the default "React + Vite" template readme with no project-specific content. Given the complexity of this application, a real readme would be valuable.

---

### 11. `src/server.back.js` — uses `require('fs')` twice (L22)

```js
const { readFileSync, existsSync } = require('fs');  // top
// ...
if (!existsSync(filePath) || require('fs').statSync(filePath).isDirectory()) {  // ← duplicate require
```

`require('fs')` on L22 is a redundant call when `existsSync` is already destructured at the top. Minor, but `statSync` should also be destructured at the top.

---

### 12. `my-next-app` is not connected to the main Pixel Alchemist app

The `my-next-app/` subfolder is a vanilla Next.js scaffold configured for Cloudflare Workers via OpenNext. Its `src/app/page.tsx` is the unchanged Next.js starter template. It has no imports from the main `src/` app, no shared components, and no deployment wiring that points at the built Vite app.

It appears this was set up as a potential future deployment path (hosting Pixel Alchemist on Cloudflare Workers via Next.js), but that migration was never carried out.

**Recommendation:** Either wire it up (port `PixelAlchemist.jsx` into the Next.js app) or document its purpose so it's clear it's a future-state scaffold rather than production code.
