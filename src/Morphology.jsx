import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'

const DIMENSION = 300;
const ENG_CARD = 250; // Engine card size in px — change here to resize all cards uniformly

// ── GIF encoder (pure JS, no workers) ────────────────────────────────────────
// Accepts frames:{pixels:Uint8ClampedArray,delay:number}[], builds a shared
// palette across all frames then encodes each with GIF89a-compliant LZW.
function encodeGIF(frames, width, height, loop = true) {
  const out = [];
  const wb  = v => out.push(v & 0xff);
  const ws  = s => { for (let i = 0; i < s.length; i++) wb(s.charCodeAt(i)); };
  const w16 = v => { wb(v & 0xff); wb((v >> 8) & 0xff); };

  // ── Build a global palette sampled across ALL frames ──────────────────────
  // Collect ~3000 colour samples evenly spread across every frame,
  // sort by luminance, then pick 256 evenly-spaced entries (index 0 = black).
  const buildGlobalPalette = () => {
    const samples = [];
    const frameSample = Math.max(1, Math.floor(frames.length / 8) || 1);
    for (let fi = 0; fi < frames.length; fi += frameSample) {
      const px = frames[fi].pixels;
      const pixStep = Math.max(1, Math.floor(px.length / 4 / 400));
      for (let i = 0; i < px.length / 4; i += pixStep)
        samples.push([px[i*4], px[i*4+1], px[i*4+2]]);
    }
    samples.sort((a, b) => (a[0]*299+a[1]*587+a[2]*114) - (b[0]*299+b[1]*587+b[2]*114));
    const pal = new Uint8Array(256 * 3); // index 0 stays black (0,0,0)
    const step = Math.max(1, Math.floor(samples.length / 255));
    for (let i = 0; i < 255; i++) {
      const s = samples[Math.min(i * step, samples.length - 1)];
      pal[(i+1)*3] = s[0]; pal[(i+1)*3+1] = s[1]; pal[(i+1)*3+2] = s[2];
    }
    return pal;
  };
  const palette = buildGlobalPalette();

  // ── Header ────────────────────────────────────────────────────────────────
  ws('GIF89a');
  w16(width); w16(height);
  wb(0xf7); // Global Colour Table flag=1, colour resolution=7, sort=0, GCT size=7 (→256 entries)
  wb(0); wb(0); // background colour index, pixel aspect ratio
  for (let i = 0; i < 768; i++) wb(palette[i]); // 256 × 3 bytes

  // ── Netscape looping extension ────────────────────────────────────────────
  if (loop) {
    wb(0x21); wb(0xff); wb(0x0b);
    ws('NETSCAPE2.0');
    wb(0x03); wb(0x01); w16(0); wb(0x00); // loop count = 0 (forever)
  }

  // ── Nearest-palette-index lookup (Euclidean, early-exit on exact match) ──
  const nearestIdx = (r, g, b) => {
    let best = 0, bestD = 0x7fffffff;
    for (let i = 0; i < 256; i++) {
      const dr = r - palette[i*3], dg = g - palette[i*3+1], db = b - palette[i*3+2];
      const d  = dr*dr + dg*dg + db*db;
      if (d < bestD) { bestD = d; best = i; if (d === 0) break; }
    }
    return best;
  };

  // ── GIF LZW encoder ───────────────────────────────────────────────────────
  // minCodeSize for 256-colour GIF must be 8 per spec (not 2).
  const lzwEncode = indices => {
    const MIN = 8;                   // minimum code size for 256-colour GIF
    const CLEAR = 1 << MIN;          // 256
    const EOI   = CLEAR + 1;         // 257
    let codeSize = MIN + 1;          // start at 9 bits
    let limit    = 1 << codeSize;    // 512

    // String table: key = "prevCode,symbol" → newCode
    let table = new Map();
    let nextCode = EOI + 1;
    const initTable = () => {
      table.clear();
      codeSize = MIN + 1; limit = 1 << codeSize; nextCode = EOI + 1;
    };

    // Bit-packing output
    const bytes = []; let bitBuf = 0, bitLen = 0;
    const emit = code => {
      bitBuf |= code << bitLen; bitLen += codeSize;
      while (bitLen >= 8) { bytes.push(bitBuf & 0xff); bitBuf >>>= 8; bitLen -= 8; }
    };

    initTable();
    emit(CLEAR);

    let prev = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const sym = indices[i];
      const key = prev + ',' + sym;        // faster than template literal in hot loop
      if (table.has(key)) {
        prev = table.get(key);
      } else {
        emit(prev);
        if (nextCode < 4096) {
          table.set(key, nextCode++);
          if (nextCode > limit && codeSize < 12) { codeSize++; limit <<= 1; }
        } else {
          emit(CLEAR); initTable();
        }
        prev = sym;
      }
    }
    emit(prev);
    emit(EOI);
    if (bitLen > 0) bytes.push(bitBuf & 0xff);
    return bytes;
  };

  // ── Per-frame encoding ────────────────────────────────────────────────────
  const palMap = new Uint8Array(width * height);
  for (const { pixels, delay } of frames) {
    // Map every pixel to palette index
    for (let i = 0; i < width * height; i++)
      palMap[i] = nearestIdx(pixels[i*4], pixels[i*4+1], pixels[i*4+2]);

    // Graphic Control Extension (delay in centiseconds)
    const cs = Math.max(2, Math.round(delay / 10)); // ≥2 cs so browsers don't ignore it
    wb(0x21); wb(0xf9); wb(0x04);
    wb(0x04); // disposal = do not dispose (keeps frame visible)
    w16(cs);
    wb(0x00); wb(0x00);

    // Image Descriptor
    wb(0x2c);
    w16(0); w16(0); w16(width); w16(height);
    wb(0x00); // local colour table flag = 0

    // LZW-compressed pixel data
    wb(8); // minimum LZW code size
    const compressed = lzwEncode(Array.from(palMap));
    for (let pos = 0; pos < compressed.length; ) {
      const len = Math.min(255, compressed.length - pos);
      wb(len);
      for (let j = 0; j < len; j++) wb(compressed[pos++]);
    }
    wb(0x00); // block terminator
  }

  wb(0x3b); // GIF trailer
  return new Uint8Array(out);
}

// ── Icons ────────────────────────────────────────────────────────────────────
const I = {
  Upload:     () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>,
  Shuffle:    () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>,
  Zap:        () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  Layers:     () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>,
  RefreshCcw: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><polyline points="1 4 1 10 7 10"/><polyline points="23 20 23 14 17 14"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg>,
  Move:       () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg>,
  Sparkles:   () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M5 3l.5 1.5L7 5l-1.5.5L5 7l-.5-1.5L3 5l1.5-.5z"/><path d="M19 13l.5 1.5L21 15l-1.5.5L19 17l-.5-1.5L17 15l1.5-.5z"/></svg>,
  Wind:       () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><path d="M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2"/></svg>,
  Waves:      () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/></svg>,
  Columns:    () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><rect x="3" y="3" width="8" height="18"/><rect x="13" y="3" width="8" height="18"/></svg>,
  Rows:       () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><rect x="3" y="3" width="18" height="8"/><rect x="3" y="13" width="18" height="8"/></svg>,
  Ghost:      () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><path d="M9 10h.01M15 10h.01M12 2a8 8 0 0 0-8 8v12l3-3 2.5 3L12 19l2.5 3L17 19l3 3V10a8 8 0 0 0-8-8z"/></svg>,
  Droplets:   () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><path d="M7 16.3c2.2 0 4-1.83 4-4.05 0-1.16-.57-2.26-1.71-3.19S7.29 6.75 7 5.3c-.29 1.45-1.14 2.84-2.29 3.76S3 11.1 3 12.25c0 2.22 1.8 4.05 4 4.05z"/><path d="M12.56 6.6A10.97 10.97 0 0 0 14 3.02c.5 2.5 2 4.9 4 6.5s3 3.5 3 5.5a6.98 6.98 0 0 1-11.91 4.97"/></svg>,
  Flame:      () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>,
  Video:      () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>,
  Image:      () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>,
  Stop:       () => <svg viewBox="0 0 24 24" fill="currentColor" className="w-full h-full"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>,
  Prism:      () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><polygon points="12 2 22 20 2 20"/><line x1="12" y1="2" x2="7" y2="20"/><line x1="12" y1="2" x2="17" y2="20"/></svg>,
  Droplet:    () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>,
  Activity:   () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
  RotateCw:   () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>,
  ArrowRight: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>,
  ArrowLeftRight: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><polyline points="17 11 21 7 17 3"/><line x1="21" y1="7" x2="9" y2="7"/><polyline points="7 21 3 17 7 13"/><line x1="3" y1="17" x2="15" y2="17"/></svg>,
  Music:      () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>,
  Magnet:     () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><path d="M6 15A6 6 0 0 0 6 3"/><path d="M18 15A6 6 0 0 0 18 3"/><line x1="6" y1="3" x2="18" y2="3"/><line x1="6" y1="15" x2="6" y2="21"/><line x1="18" y1="15" x2="18" y2="21"/></svg>,
  Orbit:      () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><circle cx="12" cy="12" r="3"/><ellipse cx="12" cy="12" rx="10" ry="4"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/></svg>,
  Undo:       () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>,
  Type:       () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>,
  Triangle:   () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><polyline points="3 20 12 4 21 20 3 20"/></svg>,
  Square:     () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><polyline points="3 20 3 4 21 4 21 20 3 20"/></svg>,
  Download:   () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
  Film:       () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg>,
  Check:      () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><polyline points="20 6 9 17 4 12"/></svg>,
  Settings:   () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  Mic:        () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><rect x="9" y="2" width="6" height="11" rx="3"/><path d="M19 10a7 7 0 0 1-14 0"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>,
  TrendingUp: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>,
  Monitor:    () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-full h-full"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>,
};

const PRISM_TYPES = [
  {id:0,label:'Burn'},{id:1,label:'Grid'},{id:2,label:'Decay'},{id:3,label:'Solar'},{id:4,label:'RGB'},{id:5,label:'Warp'},
];
const PRESETS = ['noise','gradient','checker','stripes','radial','sine'];

function buildTextMask(phrase, opts={}) {
  const {fontSize=0.6, spacing=0.5, outline=false} = opts;
  const c = document.createElement('canvas'); c.width=DIMENSION; c.height=DIMENSION;
  const ctx=c.getContext('2d'); ctx.fillStyle='#000'; ctx.fillRect(0,0,DIMENSION,DIMENSION);
  // Font size: fontSize 0=10px, 1=fill canvas width. Start from target, shrink until fits.
  const targetSz=Math.max(10, Math.round(10 + fontSize*100));
  let sz=targetSz;
  // Letter spacing: CSS letterSpacing in px
  const lsPx=Math.round((spacing-0.5)*20); // -10 to +10px
  if('letterSpacing' in ctx) ctx.letterSpacing=`${lsPx}px`;
  while(sz>8){ctx.font=`900 ${sz}px monospace`;if(ctx.measureText(phrase).width<DIMENSION-8)break;sz-=2;}
  ctx.textAlign='center'; ctx.textBaseline='middle';
  if(outline){
    ctx.strokeStyle='#fff'; ctx.lineWidth=Math.max(1, sz*0.06);
    ctx.strokeText(phrase,DIMENSION/2,DIMENSION/2);
  } else {
    ctx.fillStyle='#fff';
    ctx.fillText(phrase,DIMENSION/2,DIMENSION/2);
  }
  const d=ctx.getImageData(0,0,DIMENSION,DIMENSION).data;
  const mask=[];
  for(let y=0;y<DIMENSION;y++) for(let x=0;x<DIMENSION;x++) if(d[(y*DIMENSION+x)*4]>32) mask.push({x,y});
  return mask;
}

function applyPreset(type,size){
  const c=document.createElement('canvas');c.width=size;c.height=size;
  const ctx=c.getContext('2d');const id=ctx.createImageData(size,size);const d=id.data;
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const i=(y*size+x)*4;let r=0,g=0,b=0;const nx=x/size,ny=y/size;
    if(type==='noise'){r=Math.random()*255;g=Math.random()*255;b=Math.random()*255;}
    else if(type==='gradient'){r=nx*255;g=ny*255;b=(1-nx)*255;}
    else if(type==='checker'){const s=Math.floor(nx*8)+Math.floor(ny*8);r=g=b=s%2===0?220:30;}
    else if(type==='stripes'){r=g=b=Math.floor(nx*12)%2===0?210:40;}
    else if(type==='radial'){const dx=nx-.5,dy=ny-.5;const v=(1-Math.sqrt(dx*dx+dy*dy)*2)*255;r=g=b=Math.max(0,Math.min(255,v));}
    else if(type==='sine'){r=g=b=(Math.sin(nx*Math.PI*6+ny*Math.PI*4)*.5+.5)*255;}
    d[i]=r;d[i+1]=g;d[i+2]=b;d[i+3]=255;
  }
  ctx.putImageData(id,0,0);return c.toDataURL();
}

const GlobalStyles=()=>(
  <style>{`
    .gl-orange{box-shadow:0 0 12px 3px rgba(249,115,22,.45);}
    .gl-blue  {box-shadow:0 0 12px 3px rgba(59,130,246,.45);}
    .gl-purple{box-shadow:0 0 12px 3px rgba(168,85,247,.45);}
    .gl-amber {box-shadow:0 0 12px 3px rgba(245,158,11,.45);}
    .gl-teal  {box-shadow:0 0 12px 3px rgba(20,184,166,.45);}
    .gl-cyan  {box-shadow:0 0 12px 3px rgba(6,182,212,.45);}
    .gl-violet{box-shadow:0 0 12px 3px rgba(139,92,246,.45);}
    .gl-rose  {box-shadow:0 0 12px 3px rgba(244,63,94,.45);}
    .fslider{-webkit-appearance:none;appearance:none;height:6px;border-radius:999px;cursor:pointer;outline:none;}
    .fslider::-webkit-slider-thumb{-webkit-appearance:none;width:13px;height:13px;border-radius:50%;background:#fff;border:2px solid var(--tc,#fff);box-shadow:0 0 4px rgba(0,0,0,.5);cursor:pointer;transition:transform .1s;}
    .fslider::-webkit-slider-thumb:hover{transform:scale(1.3);}
    .fslider::-moz-range-thumb{width:13px;height:13px;border-radius:50%;background:#fff;border:2px solid var(--tc,#fff);cursor:pointer;}
    @keyframes engGapPulse{0%,100%{box-shadow:0 0 20px rgba(124,58,237,0.15),0 0 0 0 rgba(124,58,237,0.3);}50%{box-shadow:0 0 30px rgba(124,58,237,0.3),0 0 0 6px rgba(124,58,237,0.1);}}
    @keyframes sparkleRing{0%{opacity:0.9;transform:scale(0.6);}60%{opacity:0.6;}100%{opacity:0;transform:scale(1.5);}}
    @keyframes sparkleDot{0%{opacity:1;transform:translate(0,0) scale(1);}100%{opacity:0;transform:translate(var(--dx),var(--dy)) scale(0);}}
    .eng-sparkle-dot{position:absolute;width:3px;height:3px;border-radius:50%;pointer-events:none;animation:sparkleDot 0.55s ease-out forwards;}
    /* Scrollbar arrows suppressed via negative-margin clip technique in PrismaticFlipCard */
  `}</style>
);

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
  const loRef=useRef(lo);
  const hiRef=useRef(hi);
  const minRef=useRef(min);
  const maxRef=useRef(max);
  useEffect(()=>{loRef.current=lo;},[lo]);
  useEffect(()=>{hiRef.current=hi;},[hi]);
  useEffect(()=>{minRef.current=min;},[min]);
  useEffect(()=>{maxRef.current=max;},[max]);

  const onDbl=e=>{e.preventDefault();if(defaultVal!==undefined)onChangeRef.current(defaultVal);};
  const onMouseDown=(handle,e)=>{e.preventDefault();e.stopPropagation();dragRef.current=handle;};

  useEffect(()=>{
    const getFrac=e=>{
      if(!trackRef.current) return 0;
      const r=trackRef.current.getBoundingClientRect();
      return Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));
    };
    const mm=e=>{
      if(!dragRef.current||!trackRef.current)return;
      const f=getFrac(e);
      if(dragRef.current==='lo')onRangeChangeRef.current({lo:Math.min(f,hiRef.current-0.04),hi:hiRef.current});
      else if(dragRef.current==='hi')onRangeChangeRef.current({lo:loRef.current,hi:Math.max(f,loRef.current+0.04)});
      else onChangeRef.current(minRef.current+(maxRef.current-minRef.current)*f);
    };
    const mu=()=>{dragRef.current=null;};
    window.addEventListener('mousemove',mm);window.addEventListener('mouseup',mu);
    return()=>{window.removeEventListener('mousemove',mm);window.removeEventListener('mouseup',mu);};
  },[]);

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

const clamp=(v,mn,mx)=>Math.max(mn,Math.min(mx,v));
// BracketSlider — same visual as FSlider's LFO bracket mode but standalone.
// Used by Margin card in A|B split mode. Orange handles, no value labels.
const BracketSlider=({lo,hi,onLoChange,onHiChange,color='#f59e0b'})=>{
  const trackRef=useRef(null);
  const dragRef=useRef(null);
  // Callback refs — same pattern as FSliderLFO. Prevents stale closures when parent
  // passes inline lambdas, and avoids re-registering listeners on every render.
  const onLoRef=useRef(onLoChange);
  const onHiRef=useRef(onHiChange);
  const loRef=useRef(lo);
  const hiRef=useRef(hi);
  useEffect(()=>{onLoRef.current=onLoChange;},[onLoChange]);
  useEffect(()=>{onHiRef.current=onHiChange;},[onHiChange]);
  useEffect(()=>{loRef.current=lo;},[lo]);
  useEffect(()=>{hiRef.current=hi;},[hi]);
  const onMouseDown=(handle,e)=>{e.preventDefault();e.stopPropagation();dragRef.current=handle;};
  useEffect(()=>{
    const getFrac=e=>{if(!trackRef.current)return 0;const r=trackRef.current.getBoundingClientRect();return clamp((e.clientX-r.left)/r.width,0,1);};
    const mm=e=>{if(!dragRef.current||!trackRef.current)return;const f=getFrac(e);if(dragRef.current==='lo')onLoRef.current(clamp(f,0,hiRef.current-0.04));else onHiRef.current(clamp(f,loRef.current+0.04,1));};
    const mu=()=>{dragRef.current=null;};
    window.addEventListener('mousemove',mm);window.addEventListener('mouseup',mu);
    return()=>{window.removeEventListener('mousemove',mm);window.removeEventListener('mouseup',mu);};
  },[]);
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


const RangeSlider=({lo,hi,onLoChange,onHiChange,color='#06b6d4',enabled=true})=>{
  const trackRef=useRef(null);
  const dragRef=useRef(null);
  // Callback refs — same pattern as FSliderLFO and BracketSlider.
  const onLoRef=useRef(onLoChange);
  const onHiRef=useRef(onHiChange);
  const loRef=useRef(lo);
  const hiRef=useRef(hi);
  useEffect(()=>{onLoRef.current=onLoChange;},[onLoChange]);
  useEffect(()=>{onHiRef.current=onHiChange;},[onHiChange]);
  useEffect(()=>{loRef.current=lo;},[lo]);
  useEffect(()=>{hiRef.current=hi;},[hi]);
  const onMouseDown=(handle,e)=>{e.preventDefault();e.stopPropagation();dragRef.current=handle;};
  useEffect(()=>{
    const getFrac=e=>{if(!trackRef.current)return 0;const rect=trackRef.current.getBoundingClientRect();return clamp((e.clientX-rect.left)/rect.width,0,1);};
    const mm=e=>{if(!dragRef.current||!trackRef.current)return;const f=getFrac(e);if(dragRef.current==='lo')onLoRef.current(clamp(f,0,hiRef.current-0.02));else onHiRef.current(clamp(f,loRef.current+0.02,1));};
    const mu=()=>{dragRef.current=null;};
    window.addEventListener('mousemove',mm);window.addEventListener('mouseup',mu);
    return()=>{window.removeEventListener('mousemove',mm);window.removeEventListener('mouseup',mu);};
  },[]);
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

// ── SpectrumAnalyser ──────────────────────────────────────────────────────────
// ── SIGNAL Section — audio meters ───────────────────────────────────────────

// ── Shared popout helper ─────────────────────────────────────────────────────
// ── PrismaticFlipCard ─────────────────────────────────────────────────────────
// 400×400 flip card. Front = collapsed animated chip. Back = full controls.
// The flip is a CSS 3D rotateY(180deg) transition triggered by collapsed state.
const SectionLabel=({children,accent})=>(
  <div className="flex items-center gap-2 mb-3">
    <span className={`text-[9px] font-black uppercase tracking-[0.2em] px-2 py-0.5 rounded-sm border ${accent}`}>{children}</span>
    <div className="flex-1 h-px bg-zinc-800"/>
  </div>
);

// ── Stable module-level components for EngFX collapse system ─────────────────
// MUST live outside the PixelAlchemist component so React sees a stable type
// every render — if defined inside the component or an IIFE they get remounted
// on every RAF tick, causing hover flashes and broken interactions.
// ── ModuleCollapsedCard ──────────────────────────────────────────────────────
// Richly animated 200×200px collapsed card for each EngineFX module.
// Full-bleed canvas background showing the current mode animation.
// Glass overlay at bottom for controls. Floating header with active state.
function drawEngineCard(ctx,t,id,S,m,act,color){
    ctx.clearRect(0,0,S,S);

    // Base dark gradient
    const bg=ctx.createRadialGradient(S/2,S/2,0,S/2,S/2,S*0.8);
    bg.addColorStop(0,'rgba(15,15,20,0.92)');
    bg.addColorStop(1,'rgba(5,5,8,0.97)');
    ctx.fillStyle=bg;ctx.fillRect(0,0,S,S);

    const alpha=act?0.85:0.35;
    ctx.globalAlpha=alpha;

    if(id==='transform'){
      // Spinning concentric rings with zoom pulse
      const rings=5;
      for(let i=0;i<rings;i++){
        const r=20+i*18+Math.sin(t*0.8+i)*6;
        const angle=t*0.4*(i%2===0?1:-1)+i*0.5;
        ctx.strokeStyle=`hsl(${210+i*12},80%,${50+i*8}%)`;
        ctx.lineWidth=act?1.8:0.8;
        ctx.globalAlpha=alpha*(0.3+0.7*(1-i/rings));
        ctx.save();ctx.translate(S/2,S/2);ctx.rotate(angle);
        ctx.beginPath();
        for(let a=0;a<Math.PI*2;a+=0.05){
          const wobble=r+Math.sin(a*4+t)*4*act;
          const x=Math.cos(a)*wobble,y=Math.sin(a)*wobble;
          a<0.05?ctx.moveTo(x,y):ctx.lineTo(x,y);
        }
        ctx.closePath();ctx.stroke();ctx.restore();
      }
      // Rotation needle
      if(act){
        ctx.globalAlpha=0.9;
        ctx.strokeStyle=color;ctx.lineWidth=2;
        ctx.save();ctx.translate(S/2,S/2);ctx.rotate(t*1.2);
        ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(0,-70);ctx.stroke();
        ctx.beginPath();ctx.arc(0,-70,4,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();
        ctx.restore();
      }
    }
    else if(id==='symmetry'){
      // Kaleidoscope wedges based on symmetry type
      const folds=Math.max(2,m||4);
      const wedge=Math.PI*2/folds;
      for(let f=0;f<folds;f++){
        ctx.save();ctx.translate(S/2,S/2);ctx.rotate(f*wedge+t*0.15);
        ctx.globalAlpha=alpha*0.7;
        const grad=ctx.createLinearGradient(0,-80,0,0);
        grad.addColorStop(0,`hsl(${280+f*15},70%,60%)`);
        grad.addColorStop(1,'rgba(120,50,200,0)');
        ctx.fillStyle=grad;
        ctx.beginPath();ctx.moveTo(0,0);
        ctx.arc(0,0,90,-wedge/2,wedge/2);ctx.closePath();ctx.fill();
        // Inner line
        ctx.globalAlpha=alpha*0.5;
        ctx.strokeStyle=`hsl(${260+f*20},80%,70%)`;ctx.lineWidth=0.8;
        ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(0,-88);ctx.stroke();
        ctx.restore();
      }
      // Centre burst
      ctx.globalAlpha=act?0.9:0.3;
      const burst=ctx.createRadialGradient(S/2,S/2,0,S/2,S/2,30);
      burst.addColorStop(0,'rgba(180,100,255,0.8)');
      burst.addColorStop(1,'rgba(120,50,200,0)');
      ctx.fillStyle=burst;ctx.beginPath();ctx.arc(S/2,S/2,30,0,Math.PI*2);ctx.fill();
    }
    else if(id==='glyph'){
      // Floating letter particles orbiting
      const phrase=m||'MORPH';
      const chars=phrase.slice(0,6).split('');
      ctx.font=`900 ${act?22:14}px monospace`;
      chars.forEach((ch,i)=>{
        const angle=(i/chars.length)*Math.PI*2+t*0.5;
        const r=55+Math.sin(t*1.2+i)*12;
        const x=S/2+Math.cos(angle)*r,y=S/2+Math.sin(angle)*r;
        ctx.globalAlpha=alpha*(0.5+0.5*Math.sin(t*2+i));
        ctx.fillStyle=`hsl(${340+i*20},80%,65%)`;
        ctx.fillText(ch,x,y);
      });
      // Central letter, large
      ctx.globalAlpha=act?0.5:0.15;
      ctx.font='900 64px monospace';
      ctx.fillStyle=color;
      ctx.textAlign='center';ctx.textBaseline='middle';
      ctx.fillText(phrase[0]||'M',S/2,S/2);
      ctx.textAlign='start';ctx.textBaseline='alphabetic';
    }
    else if(id==='entropy'){
      // Chaos particles scattering based on entropy type
      const seed=Math.floor(t*3)%7;
      const count=act?28:12;
      for(let i=0;i<count;i++){
        const base=(i/count)*Math.PI*2;
        let x,y;
        const mode=m;
        if(mode===0){// Walk
          x=S/2+Math.sin(t*0.7+i*0.8)*60+Math.cos(t*0.3+i)*20;
          y=S/2+Math.cos(t*0.5+i*0.9)*60+Math.sin(t*0.4+i)*20;
        } else if(mode===1){// Pulse
          const pulse=0.4+0.6*Math.abs(Math.sin(t*2));
          x=S/2+Math.cos(base)*55*pulse;y=S/2+Math.sin(base)*55*pulse;
        } else if(mode===4){// Magnet
          const mx=S/2+Math.sin(t*0.4)*30,my=S/2+Math.cos(t*0.3)*20;
          x=mx+Math.cos(base+t*0.8)*(20+i*2);y=my+Math.sin(base+t*0.8)*(20+i*2);
        } else {// default orbit/drift
          x=S/2+Math.cos(base+t*(0.3+i*0.05))*50;
          y=S/2+Math.sin(base+t*(0.3+i*0.05))*50;
        }
        const size=act?2.5+Math.sin(t+i)*1.5:1.5;
        ctx.globalAlpha=alpha*(0.4+0.6*(i/count));
        ctx.fillStyle=`hsl(${30+i*8},90%,${50+i*2}%)`;
        ctx.beginPath();ctx.arc(x,y,size,0,Math.PI*2);ctx.fill();
        if(act&&i<count-1){
          ctx.globalAlpha=0.12;ctx.strokeStyle=color;ctx.lineWidth=0.5;
          ctx.beginPath();ctx.moveTo(x,y);
          const nx=S/2+Math.cos(base+t*(0.3+(i+1)*0.05))*50;
          const ny=S/2+Math.sin(base+t*(0.3+(i+1)*0.05))*50;
          ctx.lineTo(nx,ny);ctx.stroke();
        }
      }
    }
    else if(id==='prismatic'){
      const mode=m; // 0=Burn 1=Grid 2=Decay 3=Solar 4=RGB 5=Warp
      if(mode===0){// Burn — rising ember columns, luma to orange-hot embers
        for(let x=0;x<S;x+=6){
          const h=10+Math.sin(t*1.2+x*0.08)*S*0.35*act+Math.random()*15*act;
          const hue=20+Math.random()*20;
          ctx.fillStyle=`hsl(${hue},100%,${40+h/S*40}%)`;
          ctx.globalAlpha=alpha*(0.3+Math.random()*0.5);
          ctx.fillRect(x,S-h,5,h);
        }
        // Sparks
        if(act)for(let i=0;i<12;i++){
          const x=Math.random()*S,y=S-Math.random()*S*0.5;
          ctx.fillStyle=`hsl(${30+Math.random()*30},100%,80%)`;
          ctx.globalAlpha=alpha*Math.random()*0.8;
          ctx.beginPath();ctx.arc(x,y,1+Math.random(),0,Math.PI*2);ctx.fill();
        }
      } else if(mode===1){// Grid — pixel lattice snapping
        const gridSize=8+Math.round(Math.sin(t*0.8)*4*act);
        for(let y=0;y<S;y+=gridSize)for(let x=0;x<S;x+=gridSize){
          const h=(Math.sin(x*0.07+t*1.5)*Math.cos(y*0.07+t*1.1)+1)/2;
          ctx.fillStyle=`hsl(${40+h*60},80%,${30+h*40}%)`;
          ctx.globalAlpha=alpha*(0.4+h*0.4);
          ctx.fillRect(x+0.5,y+0.5,gridSize-1,gridSize-1);
        }
      } else if(mode===2){// Decay — pixels randomly dropping to black
        ctx.globalAlpha=alpha*0.6;
        const density=0.25+act*0.4;
        for(let i=0;i<180;i++){
          const x=Math.random()*S,y=Math.random()*S;
          if(Math.random()<density){
            ctx.fillStyle='rgba(0,0,0,0.85)';
            ctx.fillRect(x,y,3+Math.random()*8,2);
          } else {
            ctx.fillStyle=`hsl(${200+Math.random()*40},60%,40%)`;
            ctx.beginPath();ctx.arc(x,y,1,0,Math.PI*2);ctx.fill();
          }
        }
      } else if(mode===3){// Solar — radial streaks + pulsing core
        const cx2=S/2,cy2=S/2;
        for(let i=0;i<24;i++){
          const angle=i/24*Math.PI*2+t*0.3;
          const len=act?45+Math.sin(t*2+i)*22:28;
          ctx.globalAlpha=alpha*(0.3+0.7*(i%2===0?1:0.4));
          ctx.strokeStyle=`hsl(${45+i*4},95%,${55+i%3*10}%)`;ctx.lineWidth=1.5;
          ctx.beginPath();ctx.moveTo(cx2,cy2);
          ctx.lineTo(cx2+Math.cos(angle)*len,cy2+Math.sin(angle)*len);ctx.stroke();
        }
        const pulse=0.7+0.3*Math.abs(Math.sin(t*2.5))*act;
        const sg=ctx.createRadialGradient(S/2,S/2,0,S/2,S/2,35*pulse);
        sg.addColorStop(0,'rgba(255,220,50,0.9)');sg.addColorStop(0.5,'rgba(255,120,0,0.4)');sg.addColorStop(1,'rgba(255,50,0,0)');
        ctx.globalAlpha=alpha*0.8;ctx.fillStyle=sg;ctx.beginPath();ctx.arc(S/2,S/2,35*pulse,0,Math.PI*2);ctx.fill();
      } else if(mode===4){// RGB — channel split oscillating rings
        ['#ff2255','#22ff66','#2266ff'].forEach((c,ci)=>{
          ctx.strokeStyle=c;ctx.lineWidth=act?2:1;
          const off=(ci-1)*Math.sin(t*1.4)*18*(act?1:0.2);
          ctx.save();ctx.translate(S/2+off,S/2);
          ctx.globalAlpha=alpha*0.7;
          for(let r=18;r<88;r+=16){ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.stroke();}
          ctx.restore();
        });
      } else {// Warp (mode 5) — spatial distortion tiles
        const warp=act?18:6;
        for(let y=0;y<S;y+=12)for(let x=0;x<S;x+=12){
          const dx=Math.sin(x*0.08+t*1.6)*warp;const dy=Math.cos(y*0.09+t*1.3)*warp;
          ctx.fillStyle=`hsl(${180+dx*3},70%,${45+Math.abs(dy)}%)`;
          ctx.globalAlpha=alpha*(0.25+Math.abs(dx+dy)*0.015);
          ctx.fillRect(x+dx,y+dy,10,10);
        }
      }
    }
    else if(id==='flux'){
      // Each flux mode gets its own animation
      const mode=m;
      const pts=[];
      if(mode===0){// Wave
        for(let x=0;x<S;x+=3){
          const y=S/2+Math.sin((x/S)*Math.PI*4+t*2)*30*(act?1:0.3);
          pts.push([x,y]);
        }
        ctx.strokeStyle=color;ctx.lineWidth=act?2:1;ctx.globalAlpha=alpha;
        ctx.beginPath();pts.forEach(([x,y],i)=>i===0?ctx.moveTo(x,y):ctx.lineTo(x,y));ctx.stroke();
        // Echo waves
        [0.6,0.35].forEach((amp,ei)=>{
          ctx.globalAlpha=alpha*amp*0.5;
          ctx.beginPath();
          pts.forEach(([x],i)=>{
            const y=S/2+Math.sin((x/S)*Math.PI*4+t*2-(ei+1)*0.6)*30*(act?1:0.3);
            i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
          });ctx.stroke();
        });
      } else if(mode===1){// Vortex
        for(let i=0;i<60;i++){
          const angle=i/60*Math.PI*2+t*(act?1.5:0.3);
          const r=10+i*1.3;
          ctx.fillStyle=`hsl(${170+i*2},80%,55%)`;
          ctx.globalAlpha=alpha*(0.4+0.6*(i/60));
          ctx.beginPath();ctx.arc(S/2+Math.cos(angle)*r,S/2+Math.sin(angle)*r,1.5,0,Math.PI*2);ctx.fill();
        }
      } else if(mode===4){// Noise
        const step=10;
        for(let y=0;y<S;y+=step)for(let x=0;x<S;x+=step){
          const v=Math.sin(x*0.08+t*1.2)*Math.cos(y*0.09+t*0.9);
          ctx.globalAlpha=alpha*(0.15+Math.abs(v)*0.5);
          ctx.fillStyle=`hsl(${170+v*40},70%,${50+v*20}%)`;
          ctx.fillRect(x,y,step,step);
        }
      } else if(mode===2){// Pull
        for(let i=0;i<30;i++){
          const angle=(i/30)*Math.PI*2+t*0.1;
          const r=act?80-t%2*20+i*0.5:70;
          const speed=act?1+i*0.05:0.3;
          const cx=S/2+Math.cos(angle)*r*(1-t*speed%1*0.5);
          const cy=S/2+Math.sin(angle)*r*(1-t*speed%1*0.5);
          ctx.globalAlpha=alpha*(0.5+0.5*(1-i/30));
          ctx.fillStyle=color;
          ctx.beginPath();ctx.arc(cx,cy,2,0,Math.PI*2);ctx.fill();
        }
      } else if(mode===3){// Shear
        for(let y=0;y<S;y+=6){
          const shift=Math.sin(y*0.12+t*1.8)*(act?25:8);
          ctx.fillStyle=`hsl(${170+y*0.8},70%,50%)`;
          ctx.globalAlpha=alpha*0.5;
          ctx.fillRect(shift,y,S,3);
        }
      } else if(mode===5){// Twist
        for(let i=0;i<50;i++){
          const angle=i/50*Math.PI*6+t*(act?2:0.5);
          const r=i*1.6;
          ctx.fillStyle=`hsl(${170+i*3},80%,55%)`;
          ctx.globalAlpha=alpha*(0.4+0.6*(i/50));
          ctx.beginPath();ctx.arc(S/2+Math.cos(angle)*r,S/2+Math.sin(angle)*r,1.8,0,Math.PI*2);ctx.fill();
        }
      } else if(mode===6){// Glass
        const grid=20;
        for(let y=0;y<S;y+=grid)for(let x=0;x<S;x+=grid){
          const refr=Math.sin((x+y)*0.05+t)*(act?8:2);
          ctx.fillStyle=`hsl(${170},60%,${40+refr*2}%)`;
          ctx.globalAlpha=alpha*(0.2+Math.abs(refr)*0.04);
          ctx.fillRect(x+refr,y,grid-1,grid-1);
        }
      } else {// Ripple (mode 7)
        for(let ring=1;ring<=6;ring++){
          const phase=(t*0.8+ring*0.25)%(1)*S*0.5;
          ctx.strokeStyle=color;ctx.lineWidth=act?1.5:0.6;
          ctx.globalAlpha=alpha*Math.max(0,1-phase/(S*0.5))*0.8;
          ctx.beginPath();ctx.arc(S/2,S/2,phase,0,Math.PI*2);ctx.stroke();
        }
      }
    }
    else if(id==='glitch'){
      const mode=m; // 0=Slice 1=Databend 2=Pixel Sort 3=Scan Tear 4=Corrupt 5=VHS
      // Draw a base scene to glitch
      const grad=ctx.createLinearGradient(0,0,S,S);
      grad.addColorStop(0,'#0a0a14');grad.addColorStop(1,'#14001a');
      ctx.fillStyle=grad;ctx.fillRect(0,0,S,S);
      ctx.globalAlpha=alpha;
      if(mode===0){// Slice — stacked horizontal bands shifting
        for(let b=0;b<12;b++){
          const y=b*(S/12);const h=S/12-1;
          const shift=(Math.sin(t*3+b*1.4)*40*act*(b%3===0?1:0.3));
          ctx.fillStyle=`hsl(${180+b*15},70%,${30+b*3}%)`;
          ctx.globalAlpha=alpha*(0.4+0.3*(b%2));
          ctx.fillRect(shift,y,S,h);
          if(act&&b%4===0){ctx.fillStyle='rgba(255,0,100,0.4)';ctx.fillRect(shift+Math.random()*20,y,S*0.3,2);}
        }
      } else if(mode===1){// Databend — channel aberration waves
        for(let y=0;y<S;y+=3){
          const shift=Math.sin(y*0.08+t*4)*20*act;
          ctx.fillStyle=`rgba(255,0,100,0.3)`;ctx.globalAlpha=alpha*0.5;
          ctx.fillRect(shift,y,S,2);
          ctx.fillStyle=`rgba(0,200,255,0.3)`;
          ctx.fillRect(-shift,y+1,S,1);
        }
      } else if(mode===2){// Pixel Sort — vertical brightness cascade
        for(let x=0;x<S;x+=4){
          const sorted=Math.sin(x*0.1+t)*0.5+0.5;
          const h=S*sorted*act;
          ctx.fillStyle=`hsl(${200+sorted*60},80%,${20+sorted*40}%)`;
          ctx.globalAlpha=alpha*sorted;
          ctx.fillRect(x,S-h,3,h);
        }
      } else if(mode===3){// Scan Tear — horizontal glowing tears
        for(let i=0;i<8;i++){
          const y=((t*60+i*30)*act)%S;
          ctx.strokeStyle=`hsl(${300+i*10},100%,70%)`;ctx.lineWidth=1+(i%3===0?2:0.5);
          ctx.globalAlpha=alpha*(0.5+0.5*(i%2));
          ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(S,y);ctx.stroke();
        }
      } else if(mode===4){// Corrupt — random neon rectangles
        for(let i=0;i<(act?18:6);i++){
          const x=(Math.sin(t*2.3+i*0.7)*0.5+0.5)*S;
          const y=(Math.cos(t*1.8+i*1.1)*0.5+0.5)*S;
          ctx.fillStyle=`hsl(${Math.random()*360},100%,60%)`;
          ctx.globalAlpha=alpha*(0.2+Math.random()*0.4);
          ctx.fillRect(x,y,5+Math.random()*30,2+Math.random()*8);
        }
      } else {// VHS (mode 5) — scanlines + color bleed + noise band
        for(let y=0;y<S;y+=2){
          ctx.fillStyle=`rgba(0,0,0,0.3)`;ctx.globalAlpha=alpha*0.5;
          ctx.fillRect(0,y,S,1);
        }
        // Color bleed
        for(let y=0;y<S;y+=4){
          const bleed=Math.sin(y*0.05+t*2)*15*act;
          ctx.fillStyle=`rgba(255,0,120,0.08)`;ctx.globalAlpha=alpha*0.6;
          ctx.fillRect(bleed,y,S,3);
          ctx.fillStyle=`rgba(0,200,255,0.08)`;
          ctx.fillRect(-bleed,y+2,S,2);
        }
        // Head switch bar
        const barY=((t*act*50))%S;
        ctx.fillStyle='rgba(255,255,255,0.15)';ctx.globalAlpha=alpha;
        ctx.fillRect(0,barY,S,3);
      }
    }
    else if(id==='retro'){
      const mode=m;
      const cx=S/2,cy=S/2;
      if(mode===0){
        // ── GRID: Neon laser floor — two-pass bloom ──
        const vy=S*0.44;
        [[3,0.08*alpha],[0.9,0.65*alpha]].forEach(([lw,al])=>{
          ctx.lineWidth=lw;ctx.strokeStyle=color;
          for(let i=-9;i<=9;i++){
            ctx.globalAlpha=al*(0.3+Math.abs(i)/9*0.55);
            ctx.beginPath();ctx.moveTo(cx,vy);ctx.lineTo(cx+i*S*0.14,S);ctx.stroke();
          }
          for(let j=0;j<12;j++){
            const p=Math.pow((j+((t*0.9)%1))/12,1.8);
            const y=vy+(S-vy)*p;const hw=(S*0.5)*p;
            ctx.globalAlpha=al*(0.1+p*0.9);
            ctx.beginPath();ctx.moveTo(cx-hw,y);ctx.lineTo(cx+hw,y);ctx.stroke();
          }
        });
        // Horizon glow
        const hg=ctx.createLinearGradient(0,vy-1,0,vy+2);
        hg.addColorStop(0,'rgba(0,0,0,0)');hg.addColorStop(0.5,color);hg.addColorStop(1,'rgba(0,0,0,0)');
        ctx.globalAlpha=alpha*0.85;ctx.fillStyle=hg;ctx.fillRect(0,vy-2,S,4);

      } else if(mode===1){
        // ── SUN: Outrun sun — atmosphere + gradient disc + animated blinds ──
        const sunCX=cx,sunCY=S*0.42,sunR=S*0.28;
        // Atmosphere bloom layers
        [[sunR*2,0.05],[sunR*1.5,0.1],[sunR*1.15,0.18]].forEach(([r,al])=>{
          const ag=ctx.createRadialGradient(sunCX,sunCY,sunR*0.5,sunCX,sunCY,r);
          ag.addColorStop(0,color+'aa');ag.addColorStop(1,'rgba(0,0,0,0)');
          ctx.globalAlpha=alpha*al;ctx.fillStyle=ag;
          ctx.beginPath();ctx.arc(sunCX,sunCY,r,0,Math.PI*2);ctx.fill();
        });
        // Gradient disc: color→amber→gold
        const sg=ctx.createLinearGradient(sunCX,sunCY-sunR,sunCX,sunCY+sunR);
        sg.addColorStop(0,color);sg.addColorStop(0.45,'hsl(30,100%,68%)');sg.addColorStop(1,'hsl(48,100%,55%)');
        ctx.globalAlpha=alpha;ctx.fillStyle=sg;
        ctx.beginPath();ctx.arc(sunCX,sunCY,sunR,0,Math.PI*2);ctx.fill();
        // Animated blind slices — clipped + destination-out for true gaps
        ctx.save();
        ctx.beginPath();ctx.arc(sunCX,sunCY,sunR,0,Math.PI*2);ctx.clip();
        ctx.globalCompositeOperation='destination-out';
        ctx.fillStyle='rgba(0,0,0,1)';
        const bH=sunR*0.14;
        for(let b=0;b<7;b++){
          const by=sunCY+sunR*(0.06+b*0.14);
          const anim=((t*0.12+b*0.11)%0.12)*sunR;
          ctx.globalAlpha=1;
          ctx.fillRect(sunCX-sunR,by-anim,sunR*2,bH*(0.5+b*0.07));
        }
        ctx.restore();
        // Specular highlight
        const spec=ctx.createRadialGradient(sunCX-sunR*0.18,sunCY-sunR*0.28,0,sunCX,sunCY,sunR*0.9);
        spec.addColorStop(0,'rgba(255,255,255,0.3)');spec.addColorStop(0.4,'rgba(255,255,255,0.04)');spec.addColorStop(1,'rgba(0,0,0,0)');
        ctx.globalAlpha=alpha*0.75;ctx.fillStyle=spec;
        ctx.beginPath();ctx.arc(sunCX,sunCY,sunR,0,Math.PI*2);ctx.fill();

      } else if(mode===2){
        // ── SYNTHWAVE: Starfield + nebula + mountain silhouette + city glow ──
        // Stars — deterministic twinkle
        for(let s=0;s<100;s++){
          const sx=(s*317+11)%S,sy=(s*193+7)%(S*0.62);
          const tw=0.3+0.7*Math.abs(Math.sin(t*0.9+s*2.3));
          ctx.globalAlpha=alpha*tw*(0.3+((s*11)%5)*0.12);
          ctx.fillStyle=s%7===0?'#88aaff':s%5===0?color:'#ffffff';
          ctx.beginPath();ctx.arc(sx,sy,0.5+((s*73)%3)*0.4,0,Math.PI*2);ctx.fill();
        }
        // Nebula clouds
        [[cx*0.35,S*0.18,S*0.38,'#5500bb'],[cx*1.65,S*0.14,S*0.3,'#0044cc'],[cx,S*0.3,S*0.22,color]].forEach(([nx,ny,nr,nc])=>{
          const ng=ctx.createRadialGradient(nx,ny,0,nx,ny,nr);
          ng.addColorStop(0,nc+'40');ng.addColorStop(0.5,nc+'15');ng.addColorStop(1,'rgba(0,0,0,0)');
          ctx.globalAlpha=alpha*0.55;ctx.fillStyle=ng;ctx.fillRect(0,0,S,S);
        });
        // Mountain silhouettes
        [[S*0.56,0.20,'rgba(18,0,36,0.88)'],[S*0.66,0.13,'rgba(8,0,18,0.96)']].forEach(([mH,jitter,fill],mi)=>{
          ctx.globalAlpha=alpha;ctx.fillStyle=fill;
          ctx.beginPath();ctx.moveTo(0,S);
          for(let mx=0;mx<=28;mx++){
            const f=mx/28;
            const ny=mH+Math.sin(f*11+mi*3.7)*Math.cos(f*7+mi)*jitter*S;
            ctx.lineTo(f*S,ny);
          }
          ctx.lineTo(S,S);ctx.closePath();ctx.fill();
        });
        // City glow on horizon
        const hg=ctx.createLinearGradient(0,S*0.6,0,S*0.72);
        hg.addColorStop(0,color+'44');hg.addColorStop(1,'rgba(0,0,0,0)');
        ctx.globalAlpha=alpha*0.65;ctx.fillStyle=hg;ctx.fillRect(0,S*0.6,S,S*0.12);

      } else if(mode===3){
        // ── CRT: Scanlines + vignette + phosphor bloom + chromatic aberration + glare ──
        // Barrel vignette
        const vig=ctx.createRadialGradient(cx,cy,S*0.12,cx,cy,S*0.82);
        vig.addColorStop(0,'rgba(255,255,255,1)');vig.addColorStop(0.6,'rgba(180,180,180,0.8)');vig.addColorStop(1,'rgba(0,0,0,0)');
        ctx.globalCompositeOperation='multiply';ctx.globalAlpha=alpha*0.88;ctx.fillStyle=vig;ctx.fillRect(0,0,S,S);
        // Scanlines
        ctx.globalCompositeOperation='multiply';ctx.fillStyle='rgba(0,0,0,0.40)';
        ctx.globalAlpha=alpha;for(let y=0;y<S;y+=2)ctx.fillRect(0,y,S,1);
        // Flicker
        const flick=0.97+0.03*Math.sin(t*160+0.5);
        ctx.globalAlpha=alpha*(1-flick)*0.5;ctx.fillStyle='rgba(0,0,0,1)';ctx.fillRect(0,0,S,S);
        // Phosphor bloom
        ctx.globalCompositeOperation='screen';
        const ph=ctx.createLinearGradient(0,0,S,0);
        ph.addColorStop(0,'rgba(0,255,80,0)');ph.addColorStop(0.5,'rgba(0,255,80,0.04)');ph.addColorStop(1,'rgba(0,255,80,0)');
        ctx.globalAlpha=alpha*0.5;ctx.fillStyle=ph;ctx.fillRect(0,0,S,S);
        // Chromatic aberration
        const shift=Math.round(S*0.007);
        ctx.globalAlpha=alpha*0.14;
        ctx.fillStyle='rgba(255,0,0,1)';ctx.fillRect(-shift,0,S,S);
        ctx.fillStyle='rgba(0,0,255,1)';ctx.fillRect(shift,0,S,S);
        // Glare
        const glare=ctx.createRadialGradient(S*0.1,S*0.07,0,S*0.1,S*0.07,S*0.38);
        glare.addColorStop(0,'rgba(255,255,255,0.10)');glare.addColorStop(0.4,'rgba(255,255,255,0.03)');glare.addColorStop(1,'rgba(0,0,0,0)');
        ctx.globalAlpha=alpha*0.65;ctx.fillStyle=glare;ctx.fillRect(0,0,S,S);
        ctx.globalCompositeOperation='source-over';

      } else if(mode===4){
        // ── VOID: Neon plasma vortex — spinning rings + core + particle sparks ──
        ctx.globalCompositeOperation='source-over';
        // Black void core
        const vg=ctx.createRadialGradient(cx,cy,0,cx,cy,S*0.44);
        vg.addColorStop(0,'rgba(0,0,0,0.95)');vg.addColorStop(0.5,'rgba(5,0,15,0.55)');vg.addColorStop(1,'rgba(0,0,0,0)');
        ctx.globalAlpha=alpha;ctx.fillStyle=vg;ctx.fillRect(0,0,S,S);
        // Plasma rings — two passes per ring
        for(let r=0;r<11;r++){
          const ringR=S*(0.05+r*0.033);
          const spd=(0.3+r*0.14)*(r%2===0?1:-1);
          const off=t*spd+r*0.55;
          const hue=(r/11)*340+t*15;
          const arcL=Math.PI*(0.35+0.5*(r%3)/2);
          const bright=0.5+0.5*Math.sin(t*1.8+r);
          ctx.lineWidth=3.5+r*0.35;ctx.strokeStyle=`hsla(${hue},100%,${50+bright*20}%,${alpha*0.07})`;
          ctx.beginPath();ctx.arc(cx,cy,ringR,off,off+arcL);ctx.stroke();
          ctx.lineWidth=1.1;ctx.strokeStyle=`hsla(${hue},100%,${70+bright*22}%,${alpha*0.65*bright})`;
          ctx.beginPath();ctx.arc(cx,cy,ringR,off,off+arcL);ctx.stroke();
        }
        // Central energy core pulse
        const coreR=S*(0.035+0.015*Math.abs(Math.sin(t*2.5)));
        const cg=ctx.createRadialGradient(cx,cy,0,cx,cy,coreR*3.5);
        cg.addColorStop(0,'rgba(255,255,255,0.9)');cg.addColorStop(0.3,color+'cc');cg.addColorStop(1,'rgba(0,0,0,0)');
        ctx.globalAlpha=alpha;ctx.fillStyle=cg;ctx.beginPath();ctx.arc(cx,cy,coreR*3.5,0,Math.PI*2);ctx.fill();
        // Orbiting sparks
        for(let sp=0;sp<18;sp++){
          const sa=(sp/18)*Math.PI*2+t*(0.4+sp*0.025);
          const sr=S*(0.07+sp*0.016);
          ctx.globalAlpha=alpha*(0.25+0.75*Math.abs(Math.sin(t*1.2+sp)));
          ctx.fillStyle=`hsl(${(sp*19+t*60)%360},100%,78%)`;
          ctx.beginPath();ctx.arc(cx+Math.cos(sa)*sr,cy+Math.sin(sa)*sr,1.2+Math.random(),0,Math.PI*2);ctx.fill();
        }

      } else {
        // ── OUTRUN: Full scene — sky + sun + grid + speed lines ──
        const horizon=S*0.46;
        // Deep violet sky
        const sky=ctx.createLinearGradient(0,0,0,horizon);
        sky.addColorStop(0,'rgba(8,0,24,0.92)');sky.addColorStop(1,color+'30');
        ctx.globalAlpha=alpha;ctx.fillStyle=sky;ctx.fillRect(0,0,S,horizon);
        // Sun disc
        const sunR=S*0.2,sunCY=horizon-sunR*0.3;
        const sg=ctx.createLinearGradient(cx,sunCY-sunR,cx,sunCY+sunR);
        sg.addColorStop(0,color);sg.addColorStop(0.5,'#ff8800');sg.addColorStop(1,'#ffee00');
        ctx.globalAlpha=alpha;ctx.fillStyle=sg;
        ctx.beginPath();ctx.arc(cx,sunCY,sunR,0,Math.PI*2);ctx.fill();
        // Sun halo
        const sh=ctx.createRadialGradient(cx,sunCY,sunR*0.7,cx,sunCY,sunR*2);
        sh.addColorStop(0,color+'55');sh.addColorStop(1,'rgba(0,0,0,0)');
        ctx.globalAlpha=alpha*0.55;ctx.fillStyle=sh;ctx.fillRect(0,0,S,horizon);
        // Sun blind slices — clipped to circle, destination-out for true gaps
        ctx.save();
        ctx.beginPath();ctx.arc(cx,sunCY,sunR,0,Math.PI*2);ctx.clip();
        ctx.globalCompositeOperation='destination-out';
        ctx.fillStyle='rgba(0,0,0,1)';
        for(let b=0;b<5;b++){
          const by=sunCY+sunR*(0.08+b*0.18);
          const anim=((t*0.12+b*0.1)%0.12)*sunR;
          ctx.globalAlpha=1;
          ctx.fillRect(cx-sunR,by-anim,sunR*2,sunR*0.13);
        }
        ctx.restore();
        // Horizon glow
        const hp=ctx.createLinearGradient(0,horizon-1,0,horizon+2);
        hp.addColorStop(0,'rgba(0,0,0,0)');hp.addColorStop(0.5,color);hp.addColorStop(1,'rgba(0,0,0,0)');
        ctx.globalAlpha=alpha*(0.5+0.5*Math.sin(t*3.5));ctx.fillStyle=hp;ctx.fillRect(0,horizon-2,S,4);
        // Floor grid — two passes
        [[3,0.08*alpha],[0.9,0.65*alpha]].forEach(([lw,al])=>{
          ctx.lineWidth=lw;ctx.strokeStyle=color;
          const fl=(t*1.2)%1;
          for(let i=-8;i<=8;i++){
            ctx.globalAlpha=al*(0.3+Math.abs(i)/8*0.55);
            ctx.beginPath();ctx.moveTo(cx+(cx*i*0.01/8),horizon);ctx.lineTo(cx+i*S*0.12,S);ctx.stroke();
          }
          for(let j=0;j<9;j++){
            const p=Math.pow((j+fl)/9,1.7);const y=horizon+(S-horizon)*p;const hw=S*0.5*p;
            ctx.globalAlpha=al*(0.12+p*0.8);
            ctx.beginPath();ctx.moveTo(cx-hw,y);ctx.lineTo(cx+hw,y);ctx.stroke();
          }
        });
        // Speed streaks
        for(let sl=0;sl<10;sl++){
          const phase=(t*(0.75+sl*0.05)+sl*0.1)%1;
          const sy=S*(0.5+phase*0.5);const slen=S*(0.03+phase*0.18);
          const sx=(sl%2===0?0:S)+(sl%2===0?phase*S*0.25:-phase*S*0.25);
          ctx.globalAlpha=alpha*(1-phase)*0.65;
          ctx.strokeStyle=`hsl(${300+sl*12},100%,68%)`;ctx.lineWidth=1.2*(1-phase);
          ctx.beginPath();ctx.moveTo(sx,sy);ctx.lineTo(sx+(sl%2===0?slen:-slen),sy);ctx.stroke();
        }
      }
      ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';
    }
    else if(id==='warp'){
      // Each warp mode shows the geometric distortion effect live
      const mode=m;
      // Draw a grid of lines to show the distortion
      ctx.strokeStyle=color;ctx.lineWidth=act?1.2:0.5;
      const gridStep=16;
      if(mode===0||mode===1){// Bulge / Pinch — curved grid
        const k=mode===0?0.5:-0.5;const sign=mode===0?1:-1;
        ctx.globalAlpha=alpha*0.7;
        for(let gx=0;gx<=S;gx+=gridStep){
          ctx.beginPath();
          for(let gy=0;gy<=S;gy+=4){
            const dx=(gx-S/2)/( S/2),dy=(gy-S/2)/(S/2);
            const r2=Math.sqrt(dx*dx+dy*dy);const bfact=1+k*(r2*r2)*(0.7+0.3*Math.sin(t*1.2));
            const px2=S/2+dx*S/2/bfact,py2=S/2+dy*S/2/bfact;
            gy===0?ctx.moveTo(px2,py2):ctx.lineTo(px2,py2);
          }ctx.stroke();
        }
        for(let gy=0;gy<=S;gy+=gridStep){
          ctx.beginPath();
          for(let gx=0;gx<=S;gx+=4){
            const dx=(gx-S/2)/(S/2),dy=(gy-S/2)/(S/2);
            const r2=Math.sqrt(dx*dx+dy*dy);const bfact=1+k*(r2*r2)*(0.7+0.3*Math.sin(t*1.2));
            const px2=S/2+dx*S/2/bfact,py2=S/2+dy*S/2/bfact;
            gx===0?ctx.moveTo(px2,py2):ctx.lineTo(px2,py2);
          }ctx.stroke();
        }
      }else if(mode===2){// Ripple — undulating rings
        ctx.globalAlpha=alpha*0.7;
        for(let ring=2;ring<S/2;ring+=gridStep/2){
          ctx.beginPath();
          for(let a=0;a<=Math.PI*2;a+=0.08){
            const r2=ring+Math.sin(ring*0.12-t*3)*8*act;
            ctx.lineTo(S/2+Math.cos(a)*r2,S/2+Math.sin(a)*r2);
          }ctx.closePath();ctx.stroke();
        }
      }else if(mode===3){// Twist — spiral grid
        ctx.globalAlpha=alpha*0.65;
        for(let r2=8;r2<S/2;r2+=gridStep/2){
          ctx.beginPath();
          for(let a=0;a<=Math.PI*2;a+=0.05){
            const twist=(act*1.2)*(1-r2/(S/2))+t*0.4;
            ctx.lineTo(S/2+Math.cos(a+twist)*r2,S/2+Math.sin(a+twist)*r2);
          }ctx.closePath();ctx.stroke();
        }
      }else if(mode===4){// Mirror Fold — left half mirrored
        ctx.globalAlpha=alpha*0.7;
        for(let gy=0;gy<S;gy+=gridStep){
          ctx.beginPath();ctx.moveTo(0,gy);ctx.lineTo(S,gy);ctx.stroke();
        }
        ctx.strokeStyle='#fff';ctx.globalAlpha=alpha*0.4;ctx.lineWidth=2;
        ctx.setLineDash([4,4]);ctx.beginPath();ctx.moveTo(S/2,0);ctx.lineTo(S/2,S);ctx.stroke();ctx.setLineDash([]);
      }else{// Kaleid Seed (mode 5)
        const segs=6;ctx.globalAlpha=alpha*0.65;
        for(let i=0;i<segs;i++){
          const a=i/segs*Math.PI*2+t*0.2;
          ctx.beginPath();ctx.moveTo(S/2,S/2);ctx.lineTo(S/2+Math.cos(a)*90,S/2+Math.sin(a)*90);ctx.stroke();
        }
        for(let r2=20;r2<90;r2+=20){
          ctx.beginPath();ctx.arc(S/2,S/2,r2,0,Math.PI*2);ctx.stroke();
        }
      }
    }
    else if(id==='field'){
      const mode=m;
      const fwx=S/2,fwy=S/2; // well at centre for preview
      ctx.globalAlpha=alpha;
      // Draw vector field arrows
      const step=18;
      for(let y=step/2;y<S;y+=step)for(let x=step/2;x<S;x+=step){
        const dx=x-fwx,dy=y-fwy;const dist=Math.sqrt(dx*dx+dy*dy)||1;
        let vx=0,vy=0;
        if(mode===0){vx=-dx/dist;vy=-dy/dist;}// Gravity Well
        else if(mode===1){vx=dx/dist;vy=dy/dist;}// Repulsor
        else if(mode===2){// Dipole
          const d1x=x-S*0.35,d1y=y-S/2,d2x=x-S*0.65,d2y=y-S/2;
          const dd1=Math.sqrt(d1x*d1x+d1y*d1y)||1,dd2=Math.sqrt(d2x*d2x+d2y*d2y)||1;
          vx=-d1x/dd1+d2x/dd2;vy=-d1y/dd1+d2y/dd2;
          const vm=Math.sqrt(vx*vx+vy*vy)||1;vx/=vm;vy/=vm;
        }else if(mode===3){vx=-dx/dist*0.5;vy=-dy/dist*0.5;}// Attractor Web
        else if(mode===4){// Flow Field
          const flow=Math.sin(x*0.04+t*0.8)*Math.PI*2;vx=Math.cos(flow);vy=Math.sin(flow);
        }else{// Orbital — perpendicular
          vx=-dy/dist;vy=dx/dist;
        }
        const len=6*(act?1:0.4);const ax=x+vx*len,ay=y+vy*len;
        const hue=mode===0?220:mode===1?0:mode===2?280:mode===3?160:mode===4?60:140;
        ctx.strokeStyle=`hsl(${hue+dist},70%,${50+act*15}%)`;
        ctx.lineWidth=0.8;ctx.globalAlpha=alpha*(0.3+0.7*(1-dist/S));
        ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(ax,ay);ctx.stroke();
      }
      // Well indicator
      if(mode===0||mode===1||mode===5){
        ctx.globalAlpha=act?0.9:0.4;
        ctx.fillStyle=color;ctx.beginPath();ctx.arc(fwx,fwy,act?5+Math.sin(t*3)*2:3,0,Math.PI*2);ctx.fill();
      }
    }
    else if(id==='prismatic'){
      // Prismatic draw — same 6 modes as drawPrismatic, normalised to S
      const alpha=act?0.85:0.35;
      ctx.globalAlpha=alpha;
      const SS=S;
      if(m===0){
        // Burn — orange-hot embers with rising sparks
        for(let x=0;x<SS;x+=Math.max(3,SS*0.03)){
          const h=10+Math.sin(t*1.2+x*0.08)*SS*0.35*act;
          ctx.fillStyle=`hsl(${20+Math.sin(x*0.1)*20},100%,${40+h/SS*40}%)`;
          ctx.globalAlpha=alpha*(0.3+Math.sin(t+x*0.2)*0.3+0.2);
          ctx.fillRect(x,SS-h,Math.max(2,SS*0.025),h);
        }
        if(act)for(let i=0;i<12;i++){
          const sx2=(Math.sin(i*137.5+t)*0.5+0.5)*SS;
          const sy2=SS-(((t*0.4+i*0.17)%1)*SS*0.55);
          ctx.fillStyle=`hsl(${30+i*10},100%,80%)`;
          ctx.globalAlpha=alpha*((1-(sy2/SS))*0.7);
          ctx.beginPath();ctx.arc(sx2,sy2,1.5,0,Math.PI*2);ctx.fill();
        }
      } else if(m===1){
        // Grid — animated pixel lattice
        const g=Math.max(4,Math.round((8+Math.sin(t*0.8)*4*act)*S/200));
        for(let y=0;y<SS;y+=g)for(let x=0;x<SS;x+=g){
          const h=(Math.sin(x*0.07+t*1.5)*Math.cos(y*0.07+t*1.1)+1)/2;
          ctx.fillStyle=`hsl(${40+h*60},80%,${30+h*40}%)`;
          ctx.globalAlpha=alpha*(0.4+h*0.4);
          ctx.fillRect(x+.5,y+.5,g-1,g-1);
        }
      } else if(m===2){
        // Decay — signal dropout noise
        ctx.globalAlpha=alpha*0.6;
        const den=0.25+act*0.4;
        for(let i=0;i<180;i++){
          const x=(Math.sin(i*73+t)*0.5+0.5)*SS;
          const y=(Math.cos(i*37)*0.5+0.5)*SS;
          if((i*17+Math.floor(t*3))%7<4){
            ctx.fillStyle='rgba(0,0,0,0.85)';
            ctx.fillRect(x,y,3+((i*11)%9),2);
          } else {
            ctx.fillStyle=`hsl(${200+i%40},60%,40%)`;
            ctx.beginPath();ctx.arc(x,y,1,0,Math.PI*2);ctx.fill();
          }
        }
      } else if(m===3){
        // Solar — radial streaks + pulsing core
        const cx2=SS/2,cy2=SS/2;
        for(let i=0;i<24;i++){
          const a=i/24*Math.PI*2+t*0.3;
          const len=act?SS*0.225+Math.sin(t*2+i)*SS*0.11:SS*0.14;
          ctx.globalAlpha=alpha*(0.3+0.7*(i%2===0?1:0.4));
          ctx.strokeStyle=`hsl(${45+i*4},95%,${55+i%3*10}%)`;
          ctx.lineWidth=1.5;
          ctx.beginPath();ctx.moveTo(cx2,cy2);ctx.lineTo(cx2+Math.cos(a)*len,cy2+Math.sin(a)*len);ctx.stroke();
        }
        const pulse=0.7+0.3*Math.abs(Math.sin(t*2.5))*act;
        const pr=SS*0.175*pulse;
        const sg=ctx.createRadialGradient(cx2,cy2,0,cx2,cy2,pr);
        sg.addColorStop(0,'rgba(255,220,50,0.9)');sg.addColorStop(.5,'rgba(255,120,0,0.4)');sg.addColorStop(1,'rgba(255,50,0,0)');
        ctx.globalAlpha=alpha*0.8;ctx.fillStyle=sg;ctx.beginPath();ctx.arc(cx2,cy2,pr,0,Math.PI*2);ctx.fill();
      } else if(m===4){
        // RGB rings — chromatic separation
        ['#ff2255','#22ff66','#2266ff'].forEach((c2,ci)=>{
          ctx.strokeStyle=c2;ctx.lineWidth=act?2:1;
          const off=(ci-1)*Math.sin(t*1.4)*SS*0.09*(act?1:0.2);
          ctx.save();ctx.translate(SS/2+off,SS/2);ctx.globalAlpha=alpha*0.7;
          for(let r=SS*0.09;r<SS*0.44;r+=SS*0.08){ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.stroke();}
          ctx.restore();
        });
      } else {
        // Warp — flow field distortion
        const warp=act?SS*0.09:SS*0.03;
        const gs=Math.max(8,Math.round(SS*0.06));
        for(let y=0;y<SS;y+=gs)for(let x=0;x<SS;x+=gs){
          const dx=Math.sin(x*0.08+t*1.6)*warp;
          const dy=Math.cos(y*0.09+t*1.3)*warp;
          ctx.fillStyle=`hsl(${180+dx*3},70%,${45+Math.abs(dy)}%)`;
          ctx.globalAlpha=alpha*(0.25+Math.abs(dx+dy)*0.015);
          ctx.fillRect(x+dx,y+dy,gs-1,gs-1);
        }
      }
      ctx.globalAlpha=1;
    }
        else if(id==='ascii'){
      // ASCII Art preview — animated character grid on dark bg
      const mode=m;const cellPx=10;
      const cols=Math.floor(S/cellPx),rows=Math.floor(S/cellPx);
      const BLOCK=[' ','░','▒','▓','█'];
      const MATRIX='アカサタナハマヤラワ0123456789ABCDEF';
      const RUNES=['ᚠ','ᚢ','ᚦ','ᚨ','ᚱ','ᚲ','ᚷ','ᚹ','ᛁ','ᛃ','ᛇ','ᛈ','ᛊ','ᛏ','ᛒ','ᛖ','ᛗ','ᛚ','ᛜ','ᛞ','ᛟ'];
      const CIRCUIT=['·','─','│','┼','╋','┤','├','┬','┴'];
      const BRAILLE=['⠀','⠄','⠆','⠇','⡇','⣇','⣧','⣿'];
      const NOISE=['╱','╲','│','─','·','○'];
      ctx.textBaseline='middle';ctx.textAlign='center';
      const fs=cellPx-1;ctx.font=`900 ${fs}px monospace`;
      for(let row=0;row<rows;row++){
        for(let col=0;col<cols;col++){
          const cx2=col*cellPx+cellPx/2,cy2=row*cellPx+cellPx/2;
          // Animated luma wave
          const wave=(Math.sin(col*0.3+t*1.2)+Math.cos(row*0.25+t*0.9)+2)/4;
          const luma=act?wave:(wave*0.5+0.25);
          let ch='',hue=120;
          if(mode===0){const bi=Math.min(BRAILLE.length-1,Math.floor(luma*BRAILLE.length));ch=BRAILLE[bi];hue=80;}
          else if(mode===1){const bi=Math.min(BLOCK.length-1,Math.floor(luma*BLOCK.length));ch=BLOCK[bi];hue=60;}
          else if(mode===2){const si=Math.abs((col*17+row*31+Math.floor(t*(3+luma*5)))%MATRIX.length);ch=MATRIX[si];hue=140;}
          else if(mode===3){const chars='ABCDEFGabcdefg0123456789!@#$';const si=Math.abs((col*13+row*7+Math.floor(t*2))%chars.length);ch=chars[si];hue=0;}
          else if(mode===4){const ms=[' ','·','-','·-','-·'];ch=ms[Math.min(4,Math.floor(luma*5))];hue=50;}
          else if(mode===5){const ci=Math.floor((Math.sin(col*0.4+t)+1)/2*CIRCUIT.length);ch=CIRCUIT[Math.abs(ci)%CIRCUIT.length];hue=200;}
          else if(mode===6){const ri=Math.abs(Math.floor((luma+t*0.08+col*0.03)%1*RUNES.length))%RUNES.length;ch=RUNES[ri];hue=270;}
          else{const ni=Math.abs(Math.round(((Math.atan2(Math.cos(row*0.3+t),Math.sin(col*0.3+t))+Math.PI)/(Math.PI*2))*NOISE.length))%NOISE.length;ch=NOISE[ni];hue=180;}
          ctx.globalAlpha=alpha*(0.3+luma*0.7);
          ctx.fillStyle=`hsl(${hue},${act?75:40}%,${act?55+luma*30:35+luma*20}%)`;
          ctx.fillText(ch,cx2,cy2);
        }
      }
    }

    ctx.globalAlpha=1;
  };

const CAROUSEL_DURATION=0.32;// seconds for slide transition
const easeInOut=t=>t<0.5?2*t*t:1-Math.pow(-2*t+2,2)/2;

const ModuleCollapsedCard=({
  id,label,active,onToggle,color,bgColor,borderColor,glowColor,
  modeKey,modeLabel,modeCount=1,onModeChange,icon,children,
})=>{
  const canvasRef=useRef(null);
  const rafRef=useRef(null);
  const tRef=useRef(0);
  const modeRef=useRef(modeKey);
  const activeRef=useRef(active);
  // Carousel transition state
  const transRef=useRef(null);// {fromMode,toMode,dir,start} or null
  const [displayMode,setDisplayMode]=React.useState(modeKey);
  const displayModeRef=useRef(modeKey);

  // Keep refs in sync with props
  modeRef.current=modeKey;
  activeRef.current=active;

  // When modeKey changes externally (e.g. from back panel), snap display
  useEffect(()=>{
    if(transRef.current===null){
      displayModeRef.current=modeKey;
      setDisplayMode(modeKey);
    }
  },[modeKey]);

  const S=ENG_CARD;

  const triggerCarousel=(dir)=>{
    if(!onModeChange||modeCount<=1)return;
    const from=modeRef.current;
    const to=((from+dir)+modeCount)%modeCount;
    transRef.current={fromMode:from,toMode:to,dir,start:null};
    onModeChange(to);
  };

  useEffect(()=>{
    const canvas=canvasRef.current;if(!canvas)return;
    const ctx=canvas.getContext('2d');
    // Off-screen canvas for carousel: draw 2× wide, slide the viewport
    const dbl=document.createElement('canvas');dbl.width=S*2;dbl.height=S;
    const dblCtx=dbl.getContext('2d');
    let running=true;
    const tick=now=>{
      if(!running)return;
      tRef.current=now*0.001;
      const trans=transRef.current;
      if(trans){
        if(trans.start===null)trans.start=now*0.001;
        const elapsed=now*0.001-trans.start;
        const rawP=Math.min(1,elapsed/CAROUSEL_DURATION);
        const p=easeInOut(rawP);
        // Draw outgoing mode on left half, incoming on right (or vice versa for dir=-1)
        dblCtx.clearRect(0,0,S*2,S);
        if(trans.dir>0){
          // Next: outgoing slides left, incoming comes from right
          drawEngineCard(dblCtx,tRef.current,id,S,trans.fromMode,activeRef.current,color);
          dblCtx.save();dblCtx.translate(S,0);
          drawEngineCard(dblCtx,tRef.current,id,S,trans.toMode,activeRef.current,color);
          dblCtx.restore();
          // Blit sliding window: at p=0 show left half, at p=1 show right half
          ctx.clearRect(0,0,S,S);
          ctx.drawImage(dbl,p*S,0,S,S,0,0,S,S);
        } else {
          // Prev: outgoing slides right, incoming comes from left
          dblCtx.save();dblCtx.translate(S,0);
          drawEngineCard(dblCtx,tRef.current,id,S,trans.fromMode,activeRef.current,color);
          dblCtx.restore();
          drawEngineCard(dblCtx,tRef.current,id,S,trans.toMode,activeRef.current,color);
          ctx.clearRect(0,0,S,S);
          ctx.drawImage(dbl,S-p*S,0,S,S,0,0,S,S);
        }
        if(rawP>=1){
          // Transition done — show final mode cleanly
          displayModeRef.current=trans.toMode;
          setDisplayMode(trans.toMode);
          transRef.current=null;
          drawEngineCard(ctx,tRef.current,id,S,modeRef.current,activeRef.current,color);
        }
      } else {
        drawEngineCard(ctx,tRef.current,id,S,modeRef.current,activeRef.current,color);
      }
      rafRef.current=requestAnimationFrame(tick);
    };
    rafRef.current=requestAnimationFrame(tick);
    return()=>{running=false;if(rafRef.current)cancelAnimationFrame(rafRef.current);};
  },[]);

  const arrowBtn=(dir,label2)=>(
    <button
      onClick={e=>{e.stopPropagation();triggerCarousel(dir);}}
      title={label2}
      style={{
        position:'absolute',top:'50%',transform:'translateY(-50%)',
        [dir<0?'left':'right']:6,
        width:22,height:36,borderRadius:6,
        border:'1px solid rgba(255,255,255,0.08)',
        background:'rgba(0,0,0,0.45)',
        backdropFilter:'blur(4px)',
        color:active?color:'rgba(255,255,255,0.25)',
        fontSize:11,fontWeight:900,cursor:'pointer',
        display:'flex',alignItems:'center',justifyContent:'center',
        opacity: modeCount>1?0.7:0.2,
        transition:'opacity 0.15s,background 0.15s',
        pointerEvents:modeCount>1?'auto':'none',
        zIndex:10,
        lineHeight:1,
      }}
      onMouseEnter={e=>{if(modeCount>1){e.currentTarget.style.opacity='1';e.currentTarget.style.background='rgba(0,0,0,0.7)';}}}
      onMouseLeave={e=>{e.currentTarget.style.opacity='0.7';e.currentTarget.style.background='rgba(0,0,0,0.45)';}}>
      {dir<0?'◀':'▶'}
    </button>
  );

  const dotIndicators=modeCount>1&&(
    <div style={{
      position:'absolute',bottom:42,left:'50%',transform:'translateX(-50%)',
      display:'flex',gap:4,alignItems:'center',pointerEvents:'none',zIndex:10,
    }}>
      {Array.from({length:modeCount},(_,i)=>{
        const isCurrent=i===modeKey;
        const isIncoming=transRef.current&&i===transRef.current.toMode;
        return(
          <div key={i} style={{
            width:isCurrent||isIncoming?6:4,
            height:isCurrent||isIncoming?6:4,
            borderRadius:'50%',
            background:isCurrent?(active?color:'#71717a'):isIncoming?color+'88':'rgba(255,255,255,0.18)',
            boxShadow:isCurrent&&active?`0 0 6px ${color}`:'none',
            transition:'all 0.25s',
          }}/>
        );
      })}
    </div>
  );

  return(
    <div style={{position:'relative',width:ENG_CARD,height:ENG_CARD,flexShrink:0,borderRadius:16,overflow:'hidden',border:`1.5px solid ${borderColor}`,boxShadow:active?`0 0 28px ${glowColor}44,inset 0 0 0 1px ${glowColor}22`:'0 0 10px rgba(0,0,0,0.5)'}}>
      {/* Animated canvas background */}
      <canvas ref={canvasRef} width={S} height={S} style={{position:'absolute',inset:0,width:'100%',height:'100%'}}/>

      {/* Prev / Next arrows */}
      {arrowBtn(-1,'Previous mode')}
      {arrowBtn(1,'Next mode')}

      {/* Dot indicators */}
      {dotIndicators}

      {/* Header: drag handle + name + toggle + collapse btn */}
      <div style={{position:'absolute',top:0,left:0,right:0,padding:'10px 12px',display:'flex',justifyContent:'space-between',alignItems:'center',background:'linear-gradient(to bottom,rgba(0,0,0,0.75) 0%,rgba(0,0,0,0) 100%)'}}>
        <div style={{display:'flex',alignItems:'center',gap:6}}>
          <div data-eng-handle="1"
            style={{display:'flex',flexDirection:'column',gap:2.5,padding:'2px 3px',cursor:'grab',borderRadius:3,
              opacity:0.45,transition:'opacity 0.15s'}}
            onMouseEnter={e=>e.currentTarget.style.opacity='1'}
            onMouseLeave={e=>e.currentTarget.style.opacity='0.45'}>
            <div style={{width:12,height:1.5,borderRadius:1,background:'#a1a1aa'}}/>
            <div style={{width:12,height:1.5,borderRadius:1,background:'#a1a1aa'}}/>
            <div style={{width:12,height:1.5,borderRadius:1,background:'#a1a1aa'}}/>
          </div>
          {active&&<div style={{width:7,height:7,borderRadius:'50%',background:color,boxShadow:`0 0 8px ${color}`}}/>}
          <span style={{fontSize:9,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.12em',color:active?'#fff':'#71717a'}}>{label}</span>
        </div>
        <div style={{display:'flex',gap:5,alignItems:'center'}}>
          <button onClick={onToggle}
            style={{minWidth:34,height:22,borderRadius:6,border:`1px solid ${active?color+'88':'#3f3f46'}`,background:active?color+'22':'rgba(0,0,0,0.5)',color:active?color:'#71717a',fontSize:8,fontWeight:900,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',padding:'0 4px'}}>
            {active?'ON':'OFF'}
          </button>
          <div style={{width:20,height:20}}>{icon}</div>
        </div>
      </div>

      {/* Mode badge — floating centre */}
      <div style={{position:'absolute',top:'50%',left:'50%',transform:'translate(-50%,-50%)',pointerEvents:'none',textAlign:'center'}}>
        <div style={{fontSize:13,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:active?color:'#52525b',textShadow:active?`0 0 24px ${color}`:'none',lineHeight:1}}>{modeLabel}</div>
      </div>

      {/* Glass bottom panel: controls */}
      <div style={{position:'absolute',bottom:0,left:0,right:0,padding:'10px 12px 12px',background:'linear-gradient(to top,rgba(0,0,0,0.88) 0%,rgba(0,0,0,0.55) 70%,rgba(0,0,0,0) 100%)',backdropFilter:'blur(2px)'}}>
        {children}
      </div>
    </div>
  );
};

// ── EngineFlipCard ─────────────────────────────────────────────────────────────
// Generic ENG_CARD×ENG_CARD flip card for all EngineFX modules.
// Front = animated canvas chip (ModuleCollapsedCard).
// Back = controls panel passed as backContent prop.
const EngineFlipCard=({
  id,collapsed,onToggleCollapse,
  label,active,onToggle,color,bgColor,borderColor,glowColor,
  modeKey,modeLabel,modeCount=1,onModeChange,frontBottomContent,backContent,
})=>{
  const backCanvasRef=useRef(null);
  const backRafRef=useRef(null);
  const modeRef=useRef(modeKey);
  const activeRef=useRef(active);
  modeRef.current=modeKey;
  activeRef.current=active;

  const MINI_H=Math.round(ENG_CARD*0.34);
  const darkBg='#080810';

  const handleFlip=()=>onToggleCollapse();

  // Back mini-strip — registered with master loop
  useEffect(()=>{
    const c=backCanvasRef.current;if(!c)return;
    const ctx=c.getContext('2d');
    const off=document.createElement('canvas');off.width=ENG_CARD;off.height=ENG_CARD;
    const offCtx=off.getContext('2d');
    const bid='efb_'+Math.random().toString(36).slice(2);
    let run=true;
    const tick=now=>{
      if(!run)return;
      drawEngineCard(offCtx,now*0.001,id,ENG_CARD,modeRef.current,activeRef.current,color);
      ctx.clearRect(0,0,c.width,c.height);
      ctx.drawImage(off,0,0,ENG_CARD,MINI_H,0,0,c.width,c.height);
      backRafRef.current=requestAnimationFrame(tick);
    };
    backRafRef.current=requestAnimationFrame(tick);
    return()=>{run=false;if(backRafRef.current)cancelAnimationFrame(backRafRef.current);};
  },[]);

  return(
    <div style={{width:ENG_CARD,height:ENG_CARD,flexShrink:0,perspective:900,position:'relative'}}>
      <div style={{
        width:'100%',height:'100%',position:'relative',
        transformStyle:'preserve-3d',
        transition:'transform 0.55s cubic-bezier(0.4,0,0.2,1)',
        transform:collapsed?'rotateY(0deg)':'rotateY(180deg)',
      }}>
        {/* FRONT */}
        <div style={{position:'absolute',inset:0,backfaceVisibility:'hidden',WebkitBackfaceVisibility:'hidden'}}>
          <ModuleCollapsedCard id={id} label={label} active={active} onToggle={onToggle}
            color={color} bgColor={bgColor} borderColor={borderColor} glowColor={glowColor}
            modeKey={modeKey} modeLabel={modeLabel} modeCount={modeCount} onModeChange={onModeChange}
            icon={<button onClick={handleFlip} title="Expand controls"
              style={{width:20,height:20,borderRadius:5,border:'1px solid #3f3f46',background:'rgba(0,0,0,0.5)',color:'#71717a',fontSize:10,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center'}}>⊞</button>}>
            {frontBottomContent}
          </ModuleCollapsedCard>
        </div>

        {/* BACK */}
        <div style={{
          position:'absolute',inset:0,
          backfaceVisibility:'hidden',WebkitBackfaceVisibility:'hidden',
          transform:'rotateY(180deg)',
          borderRadius:16,overflow:'hidden',
          background:darkBg,
          border:`1.5px solid ${active?color+'88':'#3f3f46'}`,
          boxShadow:active?`0 0 28px ${color}33`:'none',
          display:'flex',flexDirection:'column',
        }}>
          {/* ── Animated mini-strip header (same as PrismaticFlipCard) ── */}
          <div style={{position:'relative',flexShrink:0,height:MINI_H,overflow:'hidden'}}>
            <canvas ref={backCanvasRef} width={ENG_CARD} height={MINI_H}
              style={{display:'block',width:'100%',height:MINI_H}}/>
            {/* Overlay: scrim + title + buttons */}
            <div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'space-between',padding:'0 12px',background:'linear-gradient(to right,rgba(0,0,0,0.65),transparent 35%,transparent 65%,rgba(0,0,0,0.65))'}}>
              <div style={{display:'flex',alignItems:'center',gap:7}}>
                {/* Drag handle */}
                <div data-eng-handle="1" style={{display:'flex',flexDirection:'column',gap:2.5,padding:'2px 3px',cursor:'grab',borderRadius:3,opacity:0.5,transition:'opacity 0.15s'}}
                  onMouseEnter={e=>e.currentTarget.style.opacity='1'} onMouseLeave={e=>e.currentTarget.style.opacity='0.5'}>
                  {[0,1,2].map(i=><div key={i} style={{width:11,height:1.5,borderRadius:1,background:'#a1a1aa'}}/>)}
                </div>
                <div style={{display:'flex',flexDirection:'column',gap:1}}>
                  <span style={{fontSize:10,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.12em',color:'#fff',lineHeight:1}}>{label}</span>
                  <span style={{fontSize:6,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.1em',color:color,lineHeight:1.4}}>{modeLabel} · {active?'ON':'OFF'}</span>
                </div>
              </div>
              <div style={{display:'flex',gap:6,alignItems:'center'}}>
                <button onClick={onToggle}
                  style={{minWidth:46,height:28,borderRadius:8,border:`1px solid ${active?color:'#3f3f46'}`,background:active?color+'22':'rgba(0,0,0,0.5)',color:active?color:'#71717a',fontSize:8,fontWeight:900,cursor:'pointer',letterSpacing:'0.1em',textAlign:'center'}}>
                  {active?'ON':'OFF'}
                </button>
                <button onClick={handleFlip}
                  style={{width:28,height:28,borderRadius:8,border:'1px solid #3f3f46',background:'rgba(0,0,0,0.5)',color:'#71717a',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',fontSize:10}} title="Collapse">⊟</button>
              </div>
            </div>
            {/* Fade to body */}
            <div style={{position:'absolute',bottom:0,left:0,right:0,height:20,background:`linear-gradient(to bottom,transparent,${darkBg})`,pointerEvents:'none'}}/>
          </div>

          {/* Scrollable controls body — native scrollbar hidden via overflow clip */}
          <div style={{flex:1,overflow:'hidden',position:'relative'}}>
            <div style={{position:'absolute',inset:0,overflowY:'scroll',width:'calc(100% + 20px)'}}>
              <div style={{width:'calc(100% - 20px)',padding:'8px 12px 12px',display:'flex',flexDirection:'column',gap:8}}>
                {backContent}
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
};

const ModCollapseBtn=({id,collapsed,onToggle})=>(
  <button onClick={()=>onToggle(id)}
    title={collapsed?'Expand module':'Collapse module'}
    className="w-6 h-6 rounded flex items-center justify-center border border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-500 hover:text-white transition-all flex-shrink-0"
    style={{fontSize:'11px',lineHeight:1}}>{collapsed?'⊞':'⊟'}</button>
);
const ModMiniCard=({active,accent,border,children})=>(
  <div className={`border rounded-xl flex flex-col p-3 ${active?`${accent} ${border}`:'bg-zinc-950 border-zinc-800'}`}
    style={{width:ENG_CARD,height:ENG_CARD,flexShrink:0}}>
    {children}
  </div>
);
const ModRow=({children})=>(
  <div className="flex flex-wrap gap-3 mb-3">{children}</div>
);

// ── LfoWave: animated waveform preview for one LFO ───────────────────────────
// Draws the shape statically, then animates a playhead by reading lfoPhaseRef[idx].
// Lives at module level so it is a stable React type.
const LfoWave=({lfo,lfoPhaseRef,idx,color='#8b5cf6',w=120,h=40})=>{
  const canvasRef=useRef(null);
  const rafRef=useRef(0);
  useEffect(()=>{
    const c=canvasRef.current;if(!c)return;
    const ctx=c.getContext('2d');
    const draw=()=>{
      ctx.clearRect(0,0,w,h);
      ctx.fillStyle='#09090b';ctx.fillRect(0,0,w,h);
      // Centre grid line
      ctx.strokeStyle='#27272a';ctx.lineWidth=0.5;
      ctx.beginPath();ctx.moveTo(0,h/2);ctx.lineTo(w,h/2);ctx.stroke();
      // Build waveform points
      const shape=lfo.shape||0;
      const depth=lfo.depth??0.7;
      const pts=[];
      for(let x=0;x<w;x++){
        const ph=x/w;
        let raw=0;
        if(shape===0)raw=Math.sin(ph*Math.PI*2)*0.5+0.5;
        else if(shape===1)raw=ph<0.5?ph*2:2-ph*2;
        else if(shape===2)raw=ph<0.5?1:0;
        else if(shape===3)raw=ph;
        else if(shape===4)raw=1-ph;
        else{// S&H — draw as step function
          const steps=8;raw=Math.floor(ph*steps)/steps;
          // add randomness visual hint — alternate bands
          raw=(Math.floor(ph*steps)%3)/2;
        }
        pts.push(h-(raw*depth*(h-6)+3));
      }
      // Glow
      ctx.save();ctx.globalAlpha=lfo.enabled?0.25:0.08;ctx.strokeStyle=color;ctx.lineWidth=5;ctx.lineJoin='round';
      ctx.beginPath();pts.forEach((y,x)=>x===0?ctx.moveTo(x,y):ctx.lineTo(x,y));ctx.stroke();ctx.restore();
      // Main line
      ctx.strokeStyle=lfo.enabled?color:'#3f3f46';ctx.lineWidth=1.5;ctx.lineJoin='round';
      ctx.beginPath();pts.forEach((y,x)=>x===0?ctx.moveTo(x,y):ctx.lineTo(x,y));ctx.stroke();
      // Playhead
      const phase=(lfoPhaseRef.current||[])[idx]||0;
      const px=phase*w;
      const ptIdx=Math.min(w-1,Math.round(phase*(w-1)));
      const ptY=pts[ptIdx]??h/2;
      ctx.save();ctx.globalAlpha=lfo.enabled?0.7:0.2;
      ctx.strokeStyle='#ffffff';ctx.lineWidth=1;ctx.setLineDash([2,3]);
      ctx.beginPath();ctx.moveTo(px,0);ctx.lineTo(px,h);ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle=lfo.enabled?color:'#52525b';
      ctx.beginPath();ctx.arc(px,ptY,3,0,Math.PI*2);ctx.fill();
      ctx.restore();
    };
    // GIF preview uses master loop
    const gifId='gif_'+Math.random().toString(36).slice(2);
    let run=true;
    const tick=()=>{if(!run)return;draw();rafRef.current=requestAnimationFrame(tick);};
    rafRef.current=requestAnimationFrame(tick);
    return()=>{run=false;if(rafRef.current)cancelAnimationFrame(rafRef.current);};
  },[lfo.shape,lfo.depth,lfo.enabled,color,w,h,idx]);
  return <canvas ref={canvasRef} width={w} height={h} style={{display:'block',borderRadius:4}}/>;
};

const CoreKnob=({label,value,displayVal,min,max,step=1,onChange,title})=>(
  <div className="bg-zinc-950 border border-zinc-800 rounded-xl p-3 flex flex-col gap-2 hover:border-zinc-600 transition-colors" title={title}>
    <div className="flex justify-between items-baseline">
      <span className="text-[8px] font-black uppercase tracking-widest text-zinc-600">{label}</span>
      <span className="text-lg font-black tabular-nums leading-none text-white">{displayVal}</span>
    </div>
    <FSlider value={value} min={min} max={max} step={step} onChange={onChange} color="#e4e4e7" enabled={true}/>
  </div>
);

const StatsBars=({stats})=>(
  <div className="space-y-1.5 pt-1">
    {[['r',stats.r,'bg-red-500','text-red-500'],['g',stats.g,'bg-green-500','text-green-500'],['b',stats.b,'bg-blue-500','text-blue-500']].map(([ch,val,bg,tc])=>(
      <div key={ch} className="flex items-center gap-2">
        <span className={`text-[7px] font-black uppercase w-2 ${tc}`}>{ch}</span>
        <div className="flex-1 h-1.5 bg-zinc-900 rounded-full overflow-hidden"><div className={`h-full ${bg} rounded-full transition-all duration-500`} style={{width:`${(val/255)*100}%`}}/></div>
        <span className="text-[7px] font-black tabular-nums text-zinc-600 w-5 text-right">{Math.round(val)}</span>
      </div>
    ))}
    <div className="flex items-center gap-2 pt-0.5 border-t border-zinc-800/60">
      <span className="text-[7px] font-black uppercase text-zinc-600 w-2">L</span>
      <div className="flex-1 h-1.5 bg-zinc-900 rounded-full overflow-hidden"><div className="h-full bg-zinc-400 rounded-full transition-all duration-500" style={{width:`${stats.brightness*100}%`}}/></div>
      <span className="text-[7px] font-black tabular-nums text-zinc-500 w-5 text-right">{Math.round(stats.brightness*255)}</span>
    </div>
  </div>
);

// ── GIF Converter Component ─────────────────────────────────────────────────
// ── Rotation Wheel ────────────────────────────────────────────────────────────
const SNAP_OPTIONS=[0,15,30,45,90];

const RotWheel=({angleRef,onDrag,color='#3b82f6',size=88})=>{
  const [dispDeg,setDispDeg]=useState(0);
  const [editing,setEditing]=useState(false);
  const [editVal,setEditVal]=useState('');
  const [snap,setSnap]=useState(0);
  const dragging=useRef(false);
  const lastPointerAngle=useRef(0);
  // rawAccum advances freely so the needle always tracks the pointer;
  // snapping only affects what we commit, meaning large snap intervals
  // (45°, 90°) are crossed naturally as the user drags past each threshold.
  const rawAccum=useRef(0);
  const svgRef=useRef(null);
  const inputRef=useRef(null);

  const r=size/2, ringR=r-9, needleR=ringR-5;
  const toDeg=rad=>rad*180/Math.PI;
  const toRad=deg=>deg*Math.PI/180;

  const getPointerAngle=(e,el)=>{
    const rect=el.getBoundingClientRect();
    const cx=rect.left+rect.width/2,cy=rect.top+rect.height/2;
    return Math.atan2((e.clientY??cy)-cy,(e.clientX??cx)-cx);
  };

  const commit=newAngle=>{
    angleRef.current=newAngle;
    setDispDeg(((toDeg(newAngle)%360)+360)%360);
    onDrag();
  };

  const onPointerDown=e=>{
    if(editing)return;
    e.preventDefault();
    dragging.current=true;
    lastPointerAngle.current=getPointerAngle(e,svgRef.current);
    // Seed raw accumulator from current angle so first move is seamless
    rawAccum.current=angleRef.current||0;
    svgRef.current.setPointerCapture(e.pointerId);
  };

  const onPointerMove=e=>{
    if(!dragging.current)return;
    const a=getPointerAngle(e,svgRef.current);
    let delta=a-lastPointerAngle.current;
    if(delta>Math.PI)delta-=Math.PI*2;
    if(delta<-Math.PI)delta+=Math.PI*2;
    lastPointerAngle.current=a;
    // Always advance the raw accumulator freely
    rawAccum.current+=delta;
    // Snap the committed value, but raw always moves — so the user
    // naturally crosses the next snap threshold by continuing to drag
    let committed=rawAccum.current;
    if(snap>0){const sr=toRad(snap);committed=Math.round(rawAccum.current/sr)*sr;}
    commit(committed);
  };

  const onPointerUp=()=>{dragging.current=false;};

  // Double-click anywhere on wheel resets to 0
  const onDblClick=e=>{e.preventDefault();rawAccum.current=0;commit(0);};

  const openEdit=e=>{
    e.stopPropagation();
    setEditVal((((toDeg(angleRef.current||0)%360)+360)%360).toFixed(1));
    setEditing(true);
    setTimeout(()=>inputRef.current?.select(),10);
  };
  const applyEdit=()=>{
    const v=parseFloat(editVal);
    if(!isNaN(v)){
      let rad=toRad(v);
      if(snap>0){const sr=toRad(snap);rad=Math.round(rad/sr)*sr;}
      rawAccum.current=rad;
      commit(rad);
    }
    setEditing(false);
  };

  const normDeg=((dispDeg%360)+360)%360;
  const needleAngle=toRad(normDeg)-Math.PI/2;
  const nx=Math.cos(needleAngle),ny=Math.sin(needleAngle);

  const ticks=[];
  for(let d=0;d<360;d+=15){
    const a=toRad(d-90),maj=d%90===0;
    ticks.push(<line key={d}
      x1={r+Math.cos(a)*(ringR-(maj?8:4))} y1={r+Math.sin(a)*(ringR-(maj?8:4))}
      x2={r+Math.cos(a)*(ringR+(maj?2:0))} y2={r+Math.sin(a)*(ringR+(maj?2:0))}
      stroke={maj?'#52525b':'#3f3f46'} strokeWidth={maj?1.5:1}/>);
  }
  const snapDots=snap>0?Array.from({length:Math.round(360/snap)},(_,i)=>{
    const a=toRad(i*snap-90);
    return <circle key={i} cx={r+Math.cos(a)*(ringR+5)} cy={r+Math.sin(a)*(ringR+5)} r="2.5" fill={color} fillOpacity="0.6"/>;
  }):null;

  return(
    <div className="flex flex-col items-center gap-1 select-none">
      <div className="relative" style={{width:size,height:size}}>
        <svg ref={svgRef} width={size} height={size}
          style={{cursor:editing?'default':'grab',touchAction:'none',display:'block'}}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove}
          onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
          onDoubleClick={onDblClick}>
          <circle cx={r} cy={r} r={ringR+6} fill="#18181b" stroke="#27272a" strokeWidth="1"/>
          <circle cx={r} cy={r} r={ringR} fill="none" stroke="#27272a" strokeWidth="8"/>
          <circle cx={r} cy={r} r={ringR} fill="none" stroke={color} strokeWidth="2" strokeOpacity="0.35"/>
          {ticks}
          {snapDots}
          <line x1={r+nx*6} y1={r+ny*6} x2={r+nx*needleR} y2={r+ny*needleR}
            stroke={color} strokeWidth="2.5" strokeLinecap="round"/>
          <circle cx={r+nx*needleR} cy={r+ny*needleR} r="4" fill={color} fillOpacity="0.9"/>
          {/* Center button — click=edit, dblclick bubbles up to SVG for reset */}
          <circle cx={r} cy={r} r="16" fill="#09090b" stroke="#3f3f46" strokeWidth="1.5"
            style={{cursor:'pointer'}} onClick={openEdit}/>
        </svg>
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          {editing
            ?<input ref={inputRef} type="text" value={editVal}
                onChange={e=>setEditVal(e.target.value)}
                onBlur={applyEdit}
                onKeyDown={e=>{if(e.key==='Enter')applyEdit();if(e.key==='Escape')setEditing(false);}}
                className="w-9 text-center font-black bg-transparent border-0 outline-none text-white pointer-events-auto"
                style={{fontSize:9}}/>
            :<span onClick={openEdit} className="font-black tabular-nums pointer-events-auto cursor-pointer"
                style={{color,fontSize:8,lineHeight:1}}>{normDeg.toFixed(0)}°</span>
          }
        </div>
      </div>
      {/* Snap row */}
      <div className="flex gap-0.5">
        {SNAP_OPTIONS.map(s=>(
          <button key={s} onClick={()=>setSnap(s)}
            className="px-1 py-0.5 rounded text-[5.5px] font-black uppercase border transition-all"
            style={snap===s?{backgroundColor:color+'33',borderColor:color,color}:{background:'#09090b',borderColor:'#3f3f46',color:'#71717a'}}>
            {s===0?'Free':`${s}°`}
          </button>
        ))}
      </div>
      <p className="text-[5px] text-zinc-700 text-center leading-snug">dbl-click=reset · click °=type</p>
    </div>
  );
};

const GifConverter=()=>{
  const [status,setStatus]=useState('');
  const [progress,setProgress]=useState(0);
  const [busy,setBusy]=useState(false);
  const [gifFps,setGifFps]=useState(15);
  const [gifQuality,setGifQuality]=useState(2); // 1=high 3=low (palette sample step)
  const [gifLoop,setGifLoop]=useState(true);
  const [gifScale,setGifScale]=useState(1.0);
  const fileRef=useRef(null);

  const convert=async()=>{
    const file=fileRef.current?.files?.[0];
    if(!file){setStatus('⚠ Pick a .webm file first');return;}
    setBusy(true);setStatus('Loading video…');setProgress(0);

    const url=URL.createObjectURL(file);
    const video=document.createElement('video');
    video.muted=true;video.playsInline=true;video.preload='metadata';video.src=url;

    // Wait for metadata (duration available after this)
    await new Promise((res,rej)=>{
      video.onloadedmetadata=res;
      video.onerror=()=>rej(new Error('Video load failed'));
      setTimeout(()=>res(),5000); // fallback timeout
    });

    let dur=video.duration;
    // Some WebM files report Infinity until seeked to end
    if(!isFinite(dur)||dur<=0){
      setStatus('Probing duration…');
      await new Promise(res=>{
        video.onseeked=res;
        video.currentTime=1e9; // seek past end — browser clamps to actual end
      });
      dur=video.currentTime;
    }
    if(!isFinite(dur)||dur<=0){setStatus('⚠ Could not read video duration');setBusy(false);URL.revokeObjectURL(url);return;}
    // Calculate exact frame count from actual duration - no arbitrary cap
    const maxFrames=Math.min(Math.round(dur*gifFps), gifFps*30); // cap at 30 seconds worth
    const totalFrames=maxFrames;
    const frameInterval=dur/totalFrames; // evenly space frames across full duration
    setStatus(`${dur.toFixed(1)}s video → ${totalFrames} frames @ ${gifFps}fps`);
    const W=Math.round(DIMENSION*gifScale);
    const H=Math.round(DIMENSION*gifScale);

    const offscreen=document.createElement('canvas');offscreen.width=W;offscreen.height=H;
    const octx=offscreen.getContext('2d');

    const frames=[];
    setStatus(`Sampling ${totalFrames} frames…`);

    // Seek & snapshot each frame
    for(let f=0;f<totalFrames;f++){
      const t=f*frameInterval;
      video.currentTime=t;
      await new Promise(res=>{video.onseeked=res;});
      octx.drawImage(video,0,0,W,H);
      const id=octx.getImageData(0,0,W,H);
      frames.push({pixels:new Uint8ClampedArray(id.data),delay:Math.round(1000/gifFps)});
      setProgress(Math.round((f+1)/totalFrames*70));
    }
    URL.revokeObjectURL(url);

    setStatus('Encoding GIF…');setProgress(75);
    await new Promise(r=>setTimeout(r,10)); // yield so progress bar renders

    const gif=encodeGIF(frames,W,H,gifLoop);
    setProgress(100);
    setStatus('✓ Done! Saving…');

    const blob=new Blob([gif],{type:'image/gif'});
    const link=document.createElement('a');
    link.download=`pixel-alchemist-${Date.now()}.gif`;
    link.href=URL.createObjectURL(blob);link.click();
    URL.revokeObjectURL(link.href);
    setBusy(false);setStatus('✓ GIF saved!');
    setTimeout(()=>setStatus(''),4000);
  };

  return(
    <div className="border border-zinc-700 rounded-xl p-3 bg-zinc-950 space-y-3">
      <div className="flex items-center gap-2">
        <span style={{width:13,height:13}} className="text-zinc-400"><I.Film /></span>
        <span className="text-[9px] font-black uppercase tracking-widest text-zinc-400">WebM → GIF Converter</span>
        <span className="ml-auto text-[6px] text-zinc-600 leading-snug">Pure-JS encoder — no server needed.</span>
      </div>
      <div>
        <label className="block text-[7px] font-black uppercase text-zinc-600 mb-1">Select .webm file</label>
        <input ref={fileRef} type="file" accept="video/webm,.webm" disabled={busy}
          className="w-full text-[8px] text-zinc-400 file:mr-2 file:py-1 file:px-2 file:rounded-lg file:border-0 file:text-[8px] file:font-black file:bg-zinc-800 file:text-zinc-300 hover:file:bg-zinc-700 cursor-pointer disabled:opacity-50"/>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <div className="flex justify-between mb-0.5"><span className="text-[7px] font-black uppercase text-zinc-600">FPS</span><span className="text-[7px] font-black text-zinc-400">{gifFps}</span></div>
          <FSlider value={gifFps} min={5} max={30} step={1} onChange={setGifFps} color="#a78bfa" enabled={!busy}/>
        </div>
        <div>
          <div className="flex justify-between mb-0.5"><span className="text-[7px] font-black uppercase text-zinc-600">Quality</span><span className="text-[7px] font-black text-zinc-400">{gifQuality===1?'High':gifQuality===2?'Mid':'Low'}</span></div>
          <FSlider value={gifQuality} min={1} max={3} step={1} onChange={setGifQuality} color="#a78bfa" enabled={!busy}/>
        </div>
        <div>
          <div className="flex justify-between mb-0.5"><span className="text-[7px] font-black uppercase text-zinc-600">Scale</span><span className="text-[7px] font-black text-zinc-400">{gifScale.toFixed(1)}×</span></div>
          <FSlider value={gifScale} min={0.25} max={1} step={0.25} onChange={setGifScale} color="#a78bfa" enabled={!busy}/>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button onClick={()=>setGifLoop(!gifLoop)} className={`px-3 py-1 rounded-lg border text-[7px] font-black uppercase tracking-widest transition-all ${gifLoop?'bg-violet-600 border-violet-500 text-white':'bg-zinc-800 border-zinc-700 text-zinc-500 hover:border-zinc-600'}`}>Loop {gifLoop?'●':'○'}</button>
        <button onClick={convert} disabled={busy} className={`flex-1 py-1.5 rounded-lg border text-[8px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 ${busy?'bg-zinc-800 border-zinc-700 text-zinc-600 cursor-not-allowed':'bg-violet-600 border-violet-500 text-white hover:bg-violet-500'}`}>
          <span style={{width:11,height:11}}><I.Download /></span>
          {busy?'Working…':'Encode GIF'}
        </button>
      </div>
      {(status||busy)&&(
        <div className="space-y-1">
          {progress>0&&<div className="h-1.5 bg-zinc-900 rounded-full overflow-hidden"><div className="h-full bg-violet-500 rounded-full transition-all" style={{width:`${progress}%`}}/></div>}
          <span className={`text-[8px] font-black ${status.startsWith('✓')?'text-green-400':status.startsWith('⚠')?'text-yellow-400':'text-violet-300 animate-pulse'}`}>{status}</span>
        </div>
      )}
    </div>
  );
};

// ── Main App ─────────────────────────────────────────────────────────────────
// ── CoreParamCard ─────────────────────────────────────────────────────────────
// 100px-wide card with animated diagram + slider. 3D chip/coin look via
// layered box-shadows: right+bottom extrusion, top+left highlight, surface sheen.
const CoreParamCard=({id,label,value,value2,displayVal,min,max,step=1,onChange,title,accentColor='#e4e4e7',labelRight,sliderOverride})=>{
  const canvasRef=useRef(null);
  const rafRef=useRef(null);
  const tRef=useRef(0);
  const valRef=useRef(value);
  valRef.current=value;
  if(value2!==undefined)valRef.current2=value2;
  else valRef.current2=undefined;
  const W=84,H=44;

  const drawDiagram=(ctx,t2)=>{
    const v=valRef.current;
    const norm=Math.max(0,Math.min(1,(v-min)/(max-min)));
    ctx.clearRect(0,0,W,H);
    ctx.fillStyle='#09090b';ctx.fillRect(0,0,W,H);

    if(id==='speed'){
      const speed=(1-norm)*0.85+0.05;
      const bars=14;const bw=W/bars;
      for(let i=0;i<bars;i++){
        const prog=((i/bars)+t2*speed*0.8)%1;
        const h2=Math.round(4+Math.pow(Math.sin(prog*Math.PI),2)*(H-8));
        ctx.fillStyle=`rgba(228,228,231,${(0.25+prog*0.75).toFixed(2)})`;
        ctx.fillRect(Math.round(i*bw)+1,H-h2,Math.round(bw)-2,h2);
      }
      const xLine=((t2*speed*55)%W);
      ctx.strokeStyle=accentColor;ctx.lineWidth=1;ctx.globalAlpha=0.65;
      ctx.beginPath();ctx.moveTo(xLine,0);ctx.lineTo(xLine,H);ctx.stroke();
      ctx.globalAlpha=1;
    } else if(id==='margin'){
      // value = normalized 0-1 A margin; value2 = normalized 0-1 B margin (or undefined)
      const normA=v;
      const normB=valRef.current2!==undefined?valRef.current2:v;
      const holdA=Math.round(normA*(W*0.42));
      const holdB=Math.round(normB*(W*0.42));
      ctx.fillStyle='#27272a';ctx.fillRect(0,H/2-6,W,12);
      ctx.fillStyle='#52525b';ctx.fillRect(0,H/2-6,Math.max(2,holdA),12);
      ctx.fillStyle='#3f3f46';ctx.fillRect(W-Math.max(2,holdB),H/2-6,Math.max(2,holdB),12);
      const activeW=Math.max(0,W-Math.max(2,holdA)-Math.max(2,holdB));
      ctx.fillStyle=accentColor;ctx.globalAlpha=0.45;
      ctx.fillRect(Math.max(2,holdA),H/2-4,activeW,8);
      ctx.globalAlpha=1;
      const activeStart=Math.max(2,holdA);
      const ph=activeStart+(activeW>0?((t2*0.32)%activeW):0);
      ctx.fillStyle='#fff';ctx.fillRect(Math.round(ph)-1,H/2-9,2,18);
      ctx.fillStyle='#a1a1aa';ctx.font='bold 5px monospace';
      ctx.fillText('A',2,H/2+2);ctx.fillText('B',W-8,H/2+2);
    } else if(id==='density'){
      const count=Math.round(8+norm*80);
      ctx.fillStyle=accentColor;
      for(let i=0;i<count;i++){
        const a=(i*2.618)*137.508;
        const r=Math.sqrt(i/count)*(Math.min(W,H)*0.48);
        const x=W/2+Math.cos(a)*r;const y=H/2+Math.sin(a)*r;
        const pulse=0.5+0.5*Math.sin(t2*2+i*0.4);
        ctx.globalAlpha=(0.4+norm*0.5)*pulse;
        ctx.beginPath();ctx.arc(x,y,1.4,0,Math.PI*2);ctx.fill();
      }
      ctx.globalAlpha=1;
    } else if(id==='size'){
      const sz=1+norm*3;
      const cols=Math.floor(W/(sz*3+4));const rows=Math.floor(H/(sz*3+4));
      const padX=(W-(cols*(sz*2+4)))/2;const padY=(H-(rows*(sz*2+4)))/2;
      ctx.fillStyle=accentColor;
      for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
        const pulse=0.6+0.4*Math.sin(t2*1.5+(r*cols+c)*0.6);
        ctx.globalAlpha=pulse;
        ctx.beginPath();ctx.arc(padX+c*(sz*2+4)+sz,padY+r*(sz*2+4)+sz,sz,0,Math.PI*2);ctx.fill();
      }
      ctx.globalAlpha=1;
    }
  };

  useEffect(()=>{
    const canvas=canvasRef.current;if(!canvas)return;
    const ctx=canvas.getContext('2d');
    const id='diag_'+Math.random().toString(36).slice(2);
    let running=true;
    const tick=now=>{if(!running)return;tRef.current=now*0.001;drawDiagram(ctx,tRef.current);rafRef.current=requestAnimationFrame(tick);};
    rafRef.current=requestAnimationFrame(tick);
    return()=>{running=false;if(rafRef.current){cancelAnimationFrame(rafRef.current);rafRef.current=null;}};
  },[]);

  // 3D chip — heavily exaggerated coin/hardware chip look
  // Stepped right+bottom extrusion creates thick raised slab feel
  // Top-left rim light + surface angle sheen + deep inner contrast
  const chipShadow=[
    '1px 1px 0 #2a2a2e',
    '2px 2px 0 #222226',
    '3px 3px 0 #1a1a1e',
    '4px 4px 0 #141418',
    '5px 5px 0 #0e0e12',
    '6px 6px 0 #09090c',
    '7px 7px 0 #050508',
    '8px 8px 0 #020204',
    // Outer ambient shadow beneath the slab
    '8px 12px 18px rgba(0,0,0,0.9)',
    '4px 6px 8px rgba(0,0,0,0.7)',
    // Top-left rim light
    '-1px -1px 0 rgba(255,255,255,0.12)',
    '-2px -2px 0 rgba(255,255,255,0.05)',
    // Inner surface contrast
    'inset 0 1px 0 rgba(255,255,255,0.10)',
    'inset 0 2px 4px rgba(255,255,255,0.04)',
    'inset 0 -2px 4px rgba(0,0,0,0.6)',
  ].join(',');

  return(
    <div style={{width:100,userSelect:'none',boxShadow:chipShadow,borderRadius:12,position:'relative',
      transform:'translateZ(0)',// GPU layer
    }}
      className="border-2 border-zinc-600 bg-zinc-950 rounded-xl flex flex-col transition-all duration-150 hover:translate-y-[-3px] hover:translate-x-[-1px]"
      title={title}
    >
      {/* Top face angle gradient — light hits top-left corner */}
      <div style={{position:'absolute',inset:0,borderRadius:10,pointerEvents:'none',
        background:'linear-gradient(135deg, rgba(255,255,255,0.09) 0%, rgba(255,255,255,0.03) 35%, transparent 60%)',
      }}/>
      {/* Bottom edge darkening — underside of raised slab */}
      <div style={{position:'absolute',bottom:0,left:0,right:0,height:'30%',borderRadius:'0 0 10px 10px',pointerEvents:'none',
        background:'linear-gradient(to top, rgba(0,0,0,0.35), transparent)',
      }}/>
      {/* Label + value */}
      <div className="flex items-baseline justify-between px-2 pt-1.5 pb-0.5 flex-shrink-0">
        <span className="text-[6.5px] font-black uppercase tracking-widest text-zinc-500">{label}</span>
        {labelRight??<span className="text-[9px] font-black tabular-nums text-white leading-none">{displayVal}</span>}
      </div>
      {/* Animated diagram */}
      <div style={{margin:'0 6px 4px',borderRadius:4,overflow:'hidden'}}>
        <canvas ref={canvasRef} width={W} height={H} style={{display:'block',width:'100%',height:H}}/>
      </div>
      {/* Slider — fixed height container so all cards match regardless of control type */}
      <div className="px-2 pb-2" style={{height:28,display:'flex',alignItems:'center'}}>
        {sliderOverride??<FSlider value={value} min={min} max={max} step={step} onChange={onChange} color={accentColor} enabled={true}/>}
      </div>
    </div>
  );
};

// ── FXPreview ────────────────────────────────────────────────────────────────
// Mini canvas preview of each CoreFX effect. Works standalone — no morph needed.
// Dim + greyscale when idle, full-color + animated on hover or when active.
// Params are passed via a ref so changing sliders never restarts the rAF loop.
const FXPreview=({id,active,params,accentColor='#ffffff'})=>{
  const canvasRef=useRef(null);
  const rafRef=useRef(null);
  const tRef=useRef(0);
  const paramsRef=useRef(params);
  const activeRef=useRef(active);
  const W=84,H=48;
  paramsRef.current=params;
  activeRef.current=active;

  const drawBase=(ctx)=>{
    const id2=ctx.createImageData(W,H);const d=id2.data;
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){
      const i=(y*W+x)*4;
      const gr=Math.round((x/W)*180);
      const dx=x-W*0.35,dy=y-H*0.5,r2=Math.sqrt(dx*dx+dy*dy);
      const blob=Math.max(0,1-r2/(H*0.38));
      const stripe=((x+y)%12<3)?0.18:0;
      const dx2=x-W*0.72,dy2=y-H*0.45,r3=Math.sqrt(dx2*dx2+dy2*dy2);
      const blob2=Math.max(0,1-r3/(H*0.28));
      d[i]=Math.min(255,Math.round(gr*0.5+blob*220+stripe*160+blob2*80));
      d[i+1]=Math.min(255,Math.round(gr*0.3+blob*120+blob2*180));
      d[i+2]=Math.min(255,Math.round(gr*0.8+blob*60+blob2*220));
      d[i+3]=255;
    }
    ctx.putImageData(id2,0,0);
  };

  const drawFrame=(ctx,t2)=>{
    const p=paramsRef.current;
    drawBase(ctx);
    const px=ctx.getImageData(0,0,W,H);const d=px.data;
    if(id==='trails'){
      // Animated ghost trail — subject orbits, leaving fading echoes behind
      const echo=p.strength??0.5;
      const spd=0.65;
      const cx=W*0.18+Math.sin(t2*spd)*W*0.56;
      const cy=H*0.5+Math.cos(t2*spd*0.7)*H*0.28;
      for(let g=6;g>=1;g--){
        const age=g*0.11;
        const gx=W*0.18+Math.sin((t2-age)*spd)*W*0.56;
        const gy=H*0.5+Math.cos((t2-age)*spd*0.7)*H*0.28;
        ctx.globalAlpha=(1-g/7)*echo*0.75;
        ctx.fillStyle=`hsl(${190+g*15},75%,${60-g*5}%)`;
        ctx.beginPath();ctx.arc(gx,gy,4.5-g*0.5,0,Math.PI*2);ctx.fill();
      }
      ctx.globalAlpha=1;
      ctx.shadowColor='#06b6d4';ctx.shadowBlur=10;
      ctx.fillStyle='#ffffff';ctx.beginPath();ctx.arc(cx,cy,5,0,Math.PI*2);ctx.fill();
      ctx.fillStyle='#06b6d4';ctx.beginPath();ctx.arc(cx,cy,3,0,Math.PI*2);ctx.fill();
      ctx.shadowBlur=0;
    }else if(id==='smoke'){
      // Rising smoke columns drifting upward
      const rise=p.rise??0.5;const str=p.strength??0.5;
      for(let i=0;i<9;i++){
        const phase=((t2*0.35+i/9)%1);
        const x=W*0.15+Math.sin(i*2.4+t2*0.5)*W*0.3+i*(W*0.075);
        const baseY=H*(1.05-phase);
        const size=2+phase*9;const alpha=(1-phase)*str*0.65;
        if(alpha<0.01)continue;
        ctx.globalAlpha=alpha;
        const g=ctx.createRadialGradient(x,baseY,0,x,baseY,size);
        g.addColorStop(0,'rgba(200,170,240,0.9)');g.addColorStop(1,'rgba(80,50,140,0)');
        ctx.fillStyle=g;ctx.beginPath();ctx.arc(x,baseY,size,0,Math.PI*2);ctx.fill();
      }
      ctx.globalAlpha=1;
    }else if(id==='chroma'){
      // RGB channels drift apart and back in sync
      const amt=p.amt??0.4;
      const shift=Math.round(amt*14*(0.5+0.5*Math.sin(t2*1.3)));
      const out=new Uint8ClampedArray(d.length);
      for(let y2=0;y2<H;y2++)for(let x2=0;x2<W;x2++){
        const i=(y2*W+x2)*4;
        out[i]=d[(y2*W+Math.min(W-1,x2+shift))*4];
        out[i+1]=d[i+1];
        out[i+2]=d[(y2*W+Math.max(0,x2-shift))*4+2];
        out[i+3]=255;
      }
      px.data.set(out);ctx.putImageData(px,0,0);
      ctx.font='bold 6px monospace';ctx.globalAlpha=0.75;
      ctx.fillStyle='#ff5555';ctx.fillText('R',Math.max(1,W/2-shift-4),H-3);
      ctx.fillStyle='#55ff55';ctx.fillText('G',W/2-2,H-3);
      ctx.fillStyle='#5599ff';ctx.fillText('B',Math.min(W-9,W/2+shift),H-3);
      ctx.globalAlpha=1;
    }else if(id==='vignette'){
      // Breathing vignette — pulses gently in and out
      const amt=p.amt??0.5;
      const pulse=amt*(0.82+0.18*Math.sin(t2*1.6));
      const grad=ctx.createRadialGradient(W/2,H/2,H*(0.06+0.16*(1-pulse)),W/2,H/2,H*(0.46+pulse*0.66));
      grad.addColorStop(0,'rgba(0,0,0,0)');
      grad.addColorStop(0.55,'rgba(0,0,0,0)');
      grad.addColorStop(1,`rgba(0,0,0,${Math.min(0.96,0.48+pulse*0.48).toFixed(2)})`);
      ctx.fillStyle=grad;ctx.fillRect(0,0,W,H);
      ctx.strokeStyle='rgba(255,255,255,0.12)';ctx.lineWidth=0.5;
      ctx.beginPath();ctx.arc(W/2,H/2,H*(0.26+0.1*(1-pulse)),0,Math.PI*2);ctx.stroke();
    }else if(id==='grade'){
      // Hue slowly cycles, sat/bri applied — colour wheel strip animates
      const hShift=Math.round(t2*20)%360;
      const hue=Math.round((p.hue??0)*180)+hShift;
      ctx.filter=`hue-rotate(${hue}deg) saturate(${(p.sat??1).toFixed(2)}) brightness(${(p.bri??1).toFixed(2)})`;
      ctx.drawImage(ctx.canvas,0,0);ctx.filter='none';
      for(let x2=0;x2<W;x2++){
        ctx.fillStyle=`hsl(${(hue+x2*2)%360},90%,55%)`;
        ctx.globalAlpha=0.55;ctx.fillRect(x2,H-4,1,4);
      }
      ctx.globalAlpha=1;
    }else if(id==='scan'){
      // Scanlines with a bright phosphor beam sweeping down
      const spacing=Math.round(2+(p.size??0.3)*6);
      const dark=0.55+(p.amt??0.5)*0.4;
      ctx.fillStyle=`rgba(0,0,0,${dark.toFixed(2)})`;
      for(let y2=0;y2<H;y2+=spacing)ctx.fillRect(0,y2,W,Math.max(1,Math.floor(spacing*0.45)));
      const beamY=(t2*20)%H;
      const bg=ctx.createLinearGradient(0,beamY-5,0,beamY+5);
      bg.addColorStop(0,'rgba(140,255,140,0)');
      bg.addColorStop(0.5,'rgba(140,255,140,0.38)');
      bg.addColorStop(1,'rgba(140,255,140,0)');
      ctx.fillStyle=bg;ctx.fillRect(0,beamY-5,W,10);
    }else if(id==='lino'){
      // Edge detect with animated threshold — edges breathe
      const thresh=Math.round((p.amt??0.5)*110+25+Math.sin(t2*1.5)*28);
      const out=new Uint8ClampedArray(d.length);
      for(let j=0;j<d.length;j++)out[j]=d[j];
      for(let y2=1;y2<H-1;y2++)for(let x2=1;x2<W-1;x2++){
        const i=(y2*W+x2)*4;
        const gx=-d[(y2-1)*W*4+(x2-1)*4]-2*d[y2*W*4+(x2-1)*4]-d[(y2+1)*W*4+(x2-1)*4]+d[(y2-1)*W*4+(x2+1)*4]+2*d[y2*W*4+(x2+1)*4]+d[(y2+1)*W*4+(x2+1)*4];
        const gy=-d[(y2-1)*W*4+(x2-1)*4]-2*d[(y2-1)*W*4+x2*4]-d[(y2-1)*W*4+(x2+1)*4]+d[(y2+1)*W*4+(x2-1)*4]+2*d[(y2+1)*W*4+x2*4]+d[(y2+1)*W*4+(x2+1)*4];
        const mag=Math.sqrt(gx*gx+gy*gy);
        if(mag>thresh){out[i]=0;out[i+1]=0;out[i+2]=0;out[i+3]=255;}
        else if(mag>thresh*0.55){const fade=1-(mag-thresh*0.55)/(thresh*0.45);out[i]=Math.round(180*fade);out[i+1]=out[i];out[i+2]=out[i];out[i+3]=180;}
      }
      px.data.set(out);ctx.putImageData(px,0,0);
    }else if(id==='half'){
      // Halftone dots rippling outward in a wave
      const grid=Math.round(3+(p.size??0.3)*8);
      ctx.fillStyle='#0a0a0a';ctx.fillRect(0,0,W,H);
      for(let y2=0;y2<H;y2+=grid)for(let x2=0;x2<W;x2+=grid){
        const ci=Math.min(y2+Math.floor(grid/2),H-1)*W*4+Math.min(x2+Math.floor(grid/2),W-1)*4;
        const luma=(d[ci]*0.299+d[ci+1]*0.587+d[ci+2]*0.114)/255;
        const dist2=Math.sqrt((x2+grid/2-W/2)**2+(y2+grid/2-H/2)**2);
        const wave=0.82+0.18*Math.sin(t2*2.8-dist2*0.22);
        const r2=luma*(grid*0.52)*wave;
        if(r2<0.5)continue;
        ctx.fillStyle=`rgb(${d[ci]},${d[ci+1]},${d[ci+2]})`;
        ctx.beginPath();ctx.arc(x2+grid/2,y2+grid/2,r2,0,Math.PI*2);ctx.fill();
      }
    }else if(id==='smear'){
      // Directional smear with animated arrow showing direction
      const angle=(p.angle??0.5)*Math.PI*2;
      const dist=Math.round(2+(p.amt??0.4)*12);
      const steps=Math.max(2,Math.round(dist*0.5));
      const phase=0.65+0.35*Math.abs(Math.sin(t2*1.9));
      for(let s=1;s<=steps;s++){
        ctx.globalAlpha=0.28*(1-s/steps)*phase;
        ctx.drawImage(ctx.canvas,Math.round(Math.cos(angle)*dist*(s/steps)),Math.round(Math.sin(angle)*dist*(s/steps)));
      }
      ctx.globalAlpha=1;
      // Direction arrow
      const ax=W/2,ay=H/2,ah=5,aa=0.45;
      const ex=ax+Math.cos(angle)*(dist+5),ey=ay+Math.sin(angle)*(dist+5);
      ctx.strokeStyle='rgba(255,255,255,0.75)';ctx.lineWidth=1.5;ctx.lineCap='round';
      ctx.beginPath();ctx.moveTo(ax-Math.cos(angle)*dist*0.5,ay-Math.sin(angle)*dist*0.5);ctx.lineTo(ex,ey);ctx.stroke();
      ctx.fillStyle='rgba(255,255,255,0.75)';
      ctx.beginPath();ctx.moveTo(ex,ey);
      ctx.lineTo(ex-Math.cos(angle-aa)*ah,ey-Math.sin(angle-aa)*ah);
      ctx.lineTo(ex-Math.cos(angle+aa)*ah,ey-Math.sin(angle+aa)*ah);
      ctx.closePath();ctx.fill();
    }else if(id==='dots'){
      // Dot matrix with ripple wave expanding from centre
      const grid=Math.round(4+(p.size??0.3)*8);
      ctx.fillStyle='#0a0a0a';ctx.fillRect(0,0,W,H);
      for(let y2=0;y2<H;y2+=grid)for(let x2=0;x2<W;x2+=grid){
        let rr=0,gg=0,bb=0,cnt=0;
        for(let dy2=0;dy2<grid&&y2+dy2<H;dy2++)for(let dx2=0;dx2<grid&&x2+dx2<W;dx2++){
          const i2=((y2+dy2)*W+(x2+dx2))*4;rr+=d[i2];gg+=d[i2+1];bb+=d[i2+2];cnt++;
        }
        if(!cnt)continue;
        const dist2=Math.sqrt((x2+grid/2-W/2)**2+(y2+grid/2-H/2)**2);
        const wave=0.68+0.32*Math.sin(t2*3.2-dist2*0.28);
        ctx.globalAlpha=Math.max(0,wave)*0.92;
        ctx.fillStyle=`rgb(${Math.round(rr/cnt)},${Math.round(gg/cnt)},${Math.round(bb/cnt)})`;
        ctx.beginPath();ctx.arc(x2+grid/2,y2+grid/2,grid*0.42*Math.max(0.1,wave),0,Math.PI*2);ctx.fill();
      }
      ctx.globalAlpha=1;
    }  };

  useEffect(()=>{
    const canvas=canvasRef.current;if(!canvas)return;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    const id='frm_'+Math.random().toString(36).slice(2);
    let running=true;
    const tick=now=>{if(!running)return;tRef.current=now*0.001;drawFrame(ctx,tRef.current);rafRef.current=requestAnimationFrame(tick);};
    rafRef.current=requestAnimationFrame(tick);
    return()=>{running=false;if(rafRef.current){cancelAnimationFrame(rafRef.current);rafRef.current=null;}};
  },[]);

  return(
    <div style={{position:'relative',borderRadius:6,overflow:'hidden'}}>
      <canvas ref={canvasRef} width={W} height={H}
        style={{display:'block',width:'100%',height:H}}/>
      {/* Accent glow border when active */}
      {active&&<div style={{position:'absolute',inset:0,borderRadius:6,boxShadow:`inset 0 0 0 1px ${accentColor}88`,pointerEvents:'none'}}/>}
    </div>
  );
};

// ── DraggableEngineGrid ──────────────────────────────────────────────────────
// Drag-to-reorder grid for EngineFX collapsed/expanded module cards.
// Features: pickup lift animation, floating ghost, drop indicator line,
// rubber-band wave ripple across siblings, spring snap-on-drop.
const DraggableEngineGrid=({order,setOrder,renderCard})=>{
  // ── State ───────────────────────────────────────────────────────────────────
  const [dragIdx,setDragIdx]=useState(null);
  const [dropIdx,setDropIdx]=useState(null);
  const [ghostPos,setGhostPos]=useState({x:0,y:0});
  const [tilt,setTilt]=useState({rx:0,ry:0}); // 3D tilt angles in deg
  const containerRef=useRef(null);
  const dragIdxRef=useRef(null);
  const dropIdxRef=useRef(null);
  const offsetRef=useRef({x:0,y:0});
  const rafRef=useRef(null);
  const velRef=useRef({x:0,y:0}); // ghost velocity for tilt
  const prevPosRef=useRef({x:0,y:0});
  const prevTimeRef=useRef(0);
  const tiltRef=useRef({rx:0,ry:0}); // current tilt (for smooth decay)

  // ── Drop index — uses closest insertion gap across all rows ──────────────
  const getDropIdx=(cx,cy)=>{
    if(!containerRef.current)return null;
    const cards=[...containerRef.current.querySelectorAll('[data-eng-idx]')];
    const n=cards.length;
    if(!n)return 0;
    // Find insertion point: for each gap (before card 0, between cards, after last card)
    // compute distance from cursor to gap midpoint (considering row layout)
    let bestIdx=0,bestDist=Infinity;
    // Before first card
    {const r=cards[0].getBoundingClientRect();
     const gx=r.left,gy=r.top+r.height/2;
     const d=Math.hypot(cx-gx,cy-gy);
     if(d<bestDist){bestDist=d;bestIdx=0;}}
    // Between cards
    for(let i=0;i<n-1;i++){
      const ra=cards[i].getBoundingClientRect();
      const rb=cards[i+1].getBoundingClientRect();
      // Gap midpoint — if on different rows, use end of ra row
      const sameRow=Math.abs(ra.top-rb.top)<ra.height*0.5;
      const gx=sameRow?(ra.right+rb.left)/2:ra.right+4;
      const gy=sameRow?(ra.top+ra.bottom)/2:ra.top+ra.height/2;
      const d=Math.hypot(cx-gx,cy-gy);
      if(d<bestDist){bestDist=d;bestIdx=i+1;}
    }
    // After last card
    {const r=cards[n-1].getBoundingClientRect();
     const gx=r.right,gy=r.top+r.height/2;
     const d=Math.hypot(cx-gx,cy-gy);
     if(d<bestDist){bestDist=d;bestIdx=n;}}
    return bestIdx;
  };

  // ── rAF loop — smooth tilt decay ────────────────────────────────────────
  const tickTilt=()=>{
    if(dragIdxRef.current===null)return;
    // Decay tilt toward zero
    tiltRef.current.rx*=0.88;
    tiltRef.current.ry*=0.88;
    setTilt({rx:tiltRef.current.rx,ry:tiltRef.current.ry});
    rafRef.current=requestAnimationFrame(tickTilt);
  };

  // ── Handlers ────────────────────────────────────────────────────────────
  const onPointerDown=(e,i)=>{
    // Only initiate drag from the handle zone
    if(!e.target.closest('[data-eng-handle]'))return;
    e.preventDefault();e.stopPropagation();
    dragIdxRef.current=i;setDragIdx(i);
    dropIdxRef.current=i;setDropIdx(i);
    const card=containerRef.current?.querySelector(`[data-eng-idx="${i}"]`);
    if(card){
      const r=card.getBoundingClientRect();
      offsetRef.current={x:e.clientX-r.left,y:e.clientY-r.top};
    }
    prevPosRef.current={x:e.clientX,y:e.clientY};
    prevTimeRef.current=performance.now();
    velRef.current={x:0,y:0};
    tiltRef.current={rx:0,ry:0};
    setGhostPos({x:e.clientX-offsetRef.current.x,y:e.clientY-offsetRef.current.y});
    containerRef.current?.setPointerCapture(e.pointerId);
    rafRef.current=requestAnimationFrame(tickTilt);
  };

  const onPointerMove=(e)=>{
    if(dragIdxRef.current===null)return;
    const now=performance.now();
    const dt=Math.max(1,now-prevTimeRef.current);
    // Velocity in px/ms
    const vx=(e.clientX-prevPosRef.current.x)/dt;
    const vy=(e.clientY-prevPosRef.current.y)/dt;
    velRef.current={x:vx,y:vy};
    prevPosRef.current={x:e.clientX,y:e.clientY};
    prevTimeRef.current=now;
    // Tilt: moving right → positive ry (rotate around Y), moving down → negative rx
    // Clamp to ±20deg, proportional to velocity (max effect at ~3px/ms)
    const speed=Math.hypot(vx,vy);
    const maxTilt=20;
    tiltRef.current.ry=Math.max(-maxTilt,Math.min(maxTilt,vx*6));
    tiltRef.current.rx=Math.max(-maxTilt,Math.min(maxTilt,-vy*6));
    setGhostPos({x:e.clientX-offsetRef.current.x,y:e.clientY-offsetRef.current.y});
    const slot=getDropIdx(e.clientX,e.clientY);
    dropIdxRef.current=slot;setDropIdx(slot);
  };

  const onPointerUp=()=>{
    if(dragIdxRef.current===null)return;
    if(rafRef.current)cancelAnimationFrame(rafRef.current);
    const from=dragIdxRef.current;
    const to=dropIdxRef.current;
    dragIdxRef.current=null;dropIdxRef.current=null;
    setDragIdx(null);setDropIdx(null);
    setTilt({rx:0,ry:0});tiltRef.current={rx:0,ry:0};
    if(to!==null&&to!==from&&to!==from+1){
      setOrder(prev=>{
        const next=[...prev];
        const [m]=next.splice(from,1);
        // Adjust insertion index after removal
        const ins=to>from?to-1:to;
        next.splice(ins,0,m);
        return next;
      });
    }
  };

  return(
    <div style={{position:'relative',userSelect:'none'}}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}>

      {/* Ghost card — floats at cursor, tilts with velocity */}
      {dragIdx!==null&&(
        <div style={{
          position:'fixed',
          left:ghostPos.x,top:ghostPos.y,
          pointerEvents:'none',zIndex:9999,
          transform:`perspective(600px) rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg) scale(1.04)`,
          filter:'drop-shadow(0 24px 48px rgba(0,0,0,0.8)) drop-shadow(0 0 16px rgba(255,255,255,0.06))',
          opacity:0.88,
          transition:'transform 0.05s linear',
          willChange:'transform',
        }}>
          {renderCard(order[dragIdx],dragIdx,true,()=>{})}
        </div>
      )}

      {/* Card grid */}
      <div ref={containerRef} className="flex flex-wrap gap-3">
        {order.map((moduleIdx,i)=>{
          const isDragging=i===dragIdx;
          // Drop indicator: show a gap before card i when dropIdx===i
          const showGap=dragIdx!==null&&dropIdx===i&&i!==dragIdx;
          const showGapAfter=dragIdx!==null&&dropIdx===order.length&&i===order.length-1;
          return(
            <React.Fragment key={moduleIdx}>
              {/* Insertion gap BEFORE card i */}
              {showGap&&(
                <div style={{
                  width:4,alignSelf:'stretch',borderRadius:2,flexShrink:0,
                  background:'linear-gradient(to bottom,transparent,#a78bfa,#7c3aed,#a78bfa,transparent)',
                  boxShadow:'0 0 12px 4px rgba(124,58,237,0.6)',
                  animation:'engGapPulse 1s ease-in-out infinite',
                }}/>
              )}
              <div
                data-eng-idx={i}
                style={{
                  opacity:isDragging?0.15:1,
                  transition:'opacity 0.1s',
                  willChange:'opacity',
                  cursor:isDragging?'grabbing':'default',
                }}
                onPointerDown={e=>onPointerDown(e,i)}
              >
                {renderCard(moduleIdx,i,false,onPointerDown)}
              </div>
              {/* Insertion gap AFTER last card */}
              {showGapAfter&&(
                <div style={{
                  width:4,alignSelf:'stretch',borderRadius:2,flexShrink:0,
                  background:'linear-gradient(to bottom,transparent,#a78bfa,#7c3aed,#a78bfa,transparent)',
                  boxShadow:'0 0 12px 4px rgba(124,58,237,0.6)',
                  animation:'engGapPulse 1s ease-in-out infinite',
                }}/>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};


const SCOPE_CARD_SIZE = 200;

const BLEND_MODES = [
  ['screen','Screen'],['lighter','Add'],['overlay','Overlay'],
  ['multiply','Multiply'],['source-over','Normal'],
];

function ScopeCard({ card, canvasRefCallback, onToggle, onFlip, setScopeCard }) {
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
        ref={el=>{if(el)canvasRefCallback(id,el);}}
        width={SCOPE_CARD_SIZE} height={SCOPE_CARD_SIZE}
        style={{
          position:'absolute', inset:0, width:'100%', height:'100%',
          opacity: enabled ? 1 : 0.18,
          display: flipped ? 'none' : 'block',
        }}
      />

      {/* Back face */}
      {flipped && (
        <ScopeCardBack card={card} onChange={patch=>setScopeCard(card.id,patch)} onFlip={onFlip}/>
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
      {!flipped && (
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
      )}
    </div>
  );
}

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

  return (
    <>
      {sl('Sensitivity','sens',0.1,2,0.01,0.65)}
      {sl('Smooth','smooth',0,0.97,0.01,0.5)}
      {sl('Intensity','intensity',0,1,0.01,0.75)}
      <div style={{display:'flex',gap:3,marginBottom:5}}>
        {tog('Glow','glow')}
      </div>
    </>
  );
}

function SplashScreen({onDone}){
  const [fading,setFading]=useState(false);
  useEffect(()=>{
    const showTimer=setTimeout(()=>setFading(true),5800);
    const doneTimer=setTimeout(()=>onDone(),6600);
    return()=>{clearTimeout(showTimer);clearTimeout(doneTimer);};
  },[onDone]);
  return(
    <div style={{
      position:'fixed',inset:0,zIndex:9999,
      display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:24,
      background:'#09090b',
      opacity:fading?0:1,
      transition:'opacity 0.8s ease-out',
      pointerEvents:fading?'none':'all',
    }}>
      <img src="/morphology_logo_M_1.gif" alt="Morphology logo"
        style={{width:220,height:220,objectFit:'contain'}}/>
      <div style={{textAlign:'center',lineHeight:1}}>
        <div style={{
          fontSize:48,fontWeight:900,letterSpacing:'-0.03em',
          textTransform:'uppercase',color:'#e4e4e7',fontStyle:'italic',
        }}>MORPHOLOGY</div>
        <div className="pre-beta-shine" style={{
          fontSize:13,fontWeight:900,letterSpacing:'0.25em',
          textTransform:'uppercase',marginTop:10,
        }}>PRE-BETA</div>
      </div>
    </div>
  );
}

export default function Morphology(){
  const [showSplash,setShowSplash]=useState(true);
  const [isPortrait,setIsPortrait]=useState(false);
  const [collapsed,setCollapsed]=useState({transform:true,symmetry:true,glyph:true,entropy:true,prismatic:true,flux:true,glitch:true,retro:true,warp:true,field:true,ascii:true});
  const toggleCollapse=id=>setCollapsed(c=>({...c,[id]:!c[id]}));
  const collapseAll=()=>setCollapsed({transform:true,symmetry:true,glyph:true,entropy:true,prismatic:true,flux:true,glitch:true,retro:true,warp:true,field:true,ascii:true});
  const expandAll=()=>setCollapsed({transform:false,symmetry:false,glyph:false,entropy:false,prismatic:false,flux:false,glitch:false,retro:false,warp:false,field:false,ascii:false});

  // Source images
  const [imageA,setImageA]=useState(null);
  const [imageB,setImageB]=useState(null);
  const [statsA,setStatsA]=useState({brightness:0,r:0,g:0,b:0});
  const [statsB,setStatsB]=useState({brightness:0,r:0,g:0,b:0});
  const [showColorA,setShowColorA]=useState(false);
  const [showColorB,setShowColorB]=useState(false);
  // Per-source color grade (applied before morph pixel extraction)
  const [gradeA,setGradeA]=useState({hue:0,sat:1,bri:1});   // hue: -180–180°, sat: 0–2, bri: 0–2
  const [gradeB,setGradeB]=useState({hue:0,sat:1,bri:1});
  const [showGradeA,setShowGradeA]=useState(false);
  const [showGradeB,setShowGradeB]=useState(false);
  const [hoverA,setHoverA]=useState(false);
  const [hoverB,setHoverB]=useState(false);
  const [isSwapping,setIsSwapping]=useState(false);
  const [undoStack,setUndoStack]=useState([]);

  // Morph core
  const [isMorphing,setIsMorphing]=useState(false);
  const [isPaused,setIsPaused]=useState(false);
  const [progress,setProgress]=useState(0);
  const [duration,setDuration]=useState(3000);
  const [isLooping,setIsLooping]=useState(false);
  const [easingEnabled,setEasingEnabled]=useState(true);
  const [pixelationMargin,setPixelationMargin]=useState(0);
  const [splitMargin,setSplitMargin]=useState(false);  // split A/B margin mode
  const [marginA,setMarginA]=useState(0);              // A-side hold (0–40%)
  const [marginB,setMarginB]=useState(0);              // B-side hold (0–40%)
  const [particleDensity,setParticleDensity]=useState(1);
  const [pointSize,setPointSize]=useState(1);
  const [highRefreshMode,setHighRefreshMode]=useState(0);
  const [currentStats,setCurrentStats]=useState({brightness:0,r:0,g:0,b:0});

  // Trails/Smoke
  const [trailsEnabled,setTrailsEnabled]=useState(false);
  const [trailStrength,setTrailStrength]=useState(0.5);
  const [trailPre,setTrailPre]=useState(false);
  const [trailPost,setTrailPost]=useState(true);
  const [smokeEnabled,setSmokeEnabled]=useState(false);
  const [smokeStrength,setSmokeStrength]=useState(0.5);
  const [smokePre,setSmokePre]=useState(false);
  const [smokePost,setSmokePost]=useState(true);
  const [smokeRise,setSmokeRise]=useState(0.5);

  // BPM
  const [bpm,setBpm]=useState(120);
  const [bpmEnabled,setBpmEnabled]=useState(false);
  const [beatFlash,setBeatFlash]=useState(false);

  // Entropy
  const [isEntropy,setIsEntropy]=useState(false);
  const [entropyType,setEntropyType]=useState(0);
  const [entropyStr,setEntropyStr]=useState(0.5);
  const [entropyBpmMode,setEntropyBpmMode]=useState('steady');
  const [entropyManualBpm,setEntropyManualBpm]=useState(120);
  const [isEntropyActive,setIsEntropyActive]=useState(false);
  const [entropyResetFlash,setEntropyResetFlash]=useState(false);

  // Glyph
  const [isText,setIsText]=useState(false);
  const [textPhrase,setTextPhrase]=useState('MORPH');
  const [textPhraseInput,setTextPhraseInput]=useState('MORPH'); // draft before Apply
  const [textStrength,setTextStrength]=useState(0.99);
  const [textMotion,setTextMotion]=useState(0);
  const [textMotionAmp,setTextMotionAmp]=useState(0.4);
  const [textBpmMode,setTextBpmMode]=useState('steady');
  const [textManualBpm,setTextManualBpm]=useState(120);
  // Glyph LFO
  const [glyphLfoEnabled,setGlyphLfoEnabled]=useState(false);
  const [glyphLfoShape,setGlyphLfoShape]=useState(0); // 0=sine 1=tri 2=square
  const [glyphLfoRatePull,setGlyphLfoRatePull]=useState(0.3);
  const [glyphLfoRateAmp,setGlyphLfoRateAmp]=useState(0.3);
  const [glyphLfoDepthPull,setGlyphLfoDepthPull]=useState(0.5);
  const [glyphLfoDepthAmp,setGlyphLfoDepthAmp]=useState(0.5);
  const [glyphLfoPull,setGlyphLfoPull]=useState(true);
  const [glyphLfoAmp,setGlyphLfoAmp]=useState(false);
  const [glyphApplyTime,setGlyphApplyTime]=useState(0.5); // 0=instant, >0 = seconds to transition
  const [glyphFontSize,setGlyphFontSize]=useState(0.6);   // 0=tiny 1=fill canvas
  const [glyphSpacing,setGlyphSpacing]=useState(0.5);     // letter spacing 0=tight 1=wide
  const [glyphOutline,setGlyphOutline]=useState(false);   // draw outline instead of fill
  const [glyphColorMode,setGlyphColorMode]=useState('white'); // white|source|invert
  const [textResetFlash,setTextResetFlash]=useState(false);
  const textMaskRef=useRef(null);
  const textMaskNextRef=useRef(null);   // mask being transitioned TO
  const textMaskDirtyRef=useRef(true);
  const textMaskPhraseRef=useRef('MORPH'); // sync ref — avoids React setState delay on Apply
  const glyphLfoPhaseRef=useRef(0);
  const glyphLfoPullPhaseRef=useRef(0);
  const glyphLfoAmpPhaseRef=useRef(0);
  const glyphTransitionRef=useRef(0);  // 0..1 progress of mask crossfade

  // Transform
  const [isRotation,setIsRotation]=useState(false);
  const [rotationSpeed,setRotationSpeed]=useState(0.5);
  const [isPostRotation,setIsPostRotation]=useState(false);
  const [postRotationSpeed,setPostRotationSpeed]=useState(0.5);
  const [rotationBoost,setRotationBoost]=useState(false);
  const [postRotationOffset,setPostRotationOffset]=useState(0);
  const [zoom,setZoom]=useState(1.0);
  const [resetModuleFlash,setResetModuleFlash]=useState(false);

  // Symmetry — simplified
  const [isSymmetry,setIsSymmetry]=useState(false);
  const [symmetryType,setSymmetryType]=useState(1); // 1=X 2=Y 3=Tri 4=Quad 5=K3 6=K6 7=K8 8=K12 9=Fan 10=Radial 11=Tile 12=Shard
  const [symMirrorInner,setSymMirrorInner]=useState(false);
  const [symAnimAxes,setSymAnimAxes]=useState(false);
  const [symAnimRate,setSymAnimRate]=useState(0.3);
  const [symCreativeAmt,setSymCreativeAmt]=useState(0.5); // creative-mode amp: 0-1
  const [symBlend,setSymBlend]=useState('source-over');   // segment composite mode
  const [symOpacity,setSymOpacity]=useState(1.0);         // per-segment alpha
  const [symCenterHole,setSymCenterHole]=useState(0);     // 0=no hole, 1=full radius
  const [symMask,setSymMask]=useState('none');               // 'none'|'circle'|'star'|'triangle'|'diamond'|'custom'
  const [symMaskCustomUrl,setSymMaskCustomUrl]=useState(null);
  const [symmetryResetFlash,setSymmetryResetFlash]=useState(false);
  const symMaskCanvasRef=useRef(null);

  // Prismatic
  const [isAlch,setIsAlch]=useState(false);
  const [alchType,setAlchType]=useState(1);
  const [alchMod,setAlchMod]=useState(0.5);
  const [boost,setBoost]=useState(false);
  const [alchTimeline,setAlchTimeline]=useState('morph');
  const [alchRate,setAlchRate]=useState(0.5);
  const [alchShape,setAlchShape]=useState(0);
  const [prismaticResetFlash,setPrismaticResetFlash]=useState(false);

  // Flux
  const [isFlux,setIsFlux]=useState(false);
  const [fluxMode,setFluxMode]=useState(0);
  const [fluxAmp,setFluxAmp]=useState(0.4);
  const [fluxTimeline,setFluxTimeline]=useState('morph');
  const [fluxRate,setFluxRate]=useState(0.5);
  const [fluxShape,setFluxShape]=useState(0);
  const [fluxBpmSync,setFluxBpmSync]=useState(false);
  const [fluxResetFlash,setFluxResetFlash]=useState(false);

  // Manual rotation display state — mirrors angleRef values for UI display in collapsed card
  const [preRotDeg,setPreRotDeg]=useState(0);
  const [postRotDeg,setPostRotDeg]=useState(0);

  // Glitch module
  const [isGlitch,setIsGlitch]=useState(false);
  const [glitchMode,setGlitchMode]=useState(0); // 0=Slice 1=Databend 2=Pixel Sort 3=Scan Tear 4=Corrupt 5=VHS
  const [glitchAmt,setGlitchAmt]=useState(0.5);
  const [glitchRate,setGlitchRate]=useState(0.5);
  const [glitchTimeline,setGlitchTimeline]=useState('morph');
  const [glitchResetFlash,setGlitchResetFlash]=useState(false);

  // Retro module
  const [isRetro,setIsRetro]=useState(false);
  const [retroMode,setRetroMode]=useState(0); // 0=Grid Plane 1=Retro Sun 2=Synthwave 3=CRT 4=Void 5=Outrun
  const [retroAmt,setRetroAmt]=useState(0.6);
  const [retroColor,setRetroColor]=useState('#ff00ff');
  const [retroSpeed,setRetroSpeed]=useState(0.5);
  const [retroResetFlash,setRetroResetFlash]=useState(false);
  const [retroLayer,setRetroLayer]=useState(1); // 0=Behind 1=During(pre-sym) 2=Front(post-sym)

  // Warp module — pre-sym spatial lens distortion on rawCanvas
  const [isWarp,setIsWarp]=useState(false);
  const [warpMode,setWarpMode]=useState(0); // 0=Lens 1=Pinch 2=Ripple 3=Swirl 4=Mirror 5=Kaleid
  const [warpAmt,setWarpAmt]=useState(0.5);
  const [warpRate,setWarpRate]=useState(0.5);
  const [warpResetFlash,setWarpResetFlash]=useState(false);

  // Field module — vector field shaping particle trajectories pre-sym
  const [isField,setIsField]=useState(false);
  const [fieldMode,setFieldMode]=useState(0); // 0=Aurora 1=Plasma 2=Lattice 3=Interference 4=Wind 5=Magrev 6=Poles
  const [fieldAmt,setFieldAmt]=useState(0.5);
  const [fieldX,setFieldX]=useState(0.5); // 0-1 normalized well position X
  const [fieldY,setFieldY]=useState(0.5); // 0-1 normalized well position Y
  const [fieldResetFlash,setFieldResetFlash]=useState(false);
  const [chromaEnabled,setChromaEnabled]=useState(false);
  const [chromaAmt,setChromaAmt]=useState(0.4);       // 0-1 → pixel offset
  const [chromaRgbMode,setChromaRgbMode]=useState(false); // true = true RGB channel split
  const [vignetteEnabled,setVignetteEnabled]=useState(false);
  const [vignetteAmt,setVignetteAmt]=useState(0.5);    // 0-1 → darkness at edge
  const [colorGradeEnabled,setColorGradeEnabled]=useState(false);
  const [colorGradeHue,setColorGradeHue]=useState(0);  // -1 to 1 hue rotate (mapped to css deg)
  const [colorGradeSat,setColorGradeSat]=useState(1);  // 0-2 saturation
  const [colorGradeBri,setColorGradeBri]=useState(1);  // 0.5-1.5 brightness

  // Post-FX: Scanlines, Linocut, Halftone, Smear, Dot Matrix
  const [scanlinesEnabled,setScanlinesEnabled]=useState(false);
  const [scanlinesAmt,setScanlinesAmt]=useState(0.5);    // 0-1 darkness of lines
  const [scanlinesSize,setScanlinesSize]=useState(0.3);  // 0-1 → maps to 2-8px spacing
  const [linocutEnabled,setLinocutEnabled]=useState(false);
  const [linocutAmt,setLinocutAmt]=useState(0.5);        // 0-1 edge threshold
  const [halftoneEnabled,setHalftoneEnabled]=useState(false);
  const [halftoneSize,setHalftoneSize]=useState(0.3);    // 0-1 → dot size 3-14px
  const [smearEnabled,setSmearEnabled]=useState(false);
  const [smearAmt,setSmearAmt]=useState(0.4);            // 0-1 smear length
  const [smearAngle,setSmearAngle]=useState(0.5);        // 0-1 → 0-360°
  const [dotMatrixEnabled,setDotMatrixEnabled]=useState(false);
  const [dotMatrixSize,setDotMatrixSize]=useState(0.3);  // 0-1 → grid size
  // Drag order for CoreFX grid (indices into the cards array)

  // ASCII Art module — overlays character-based rendering pre-sym (or post-sym when bypassSym)
  const [isAscii,setIsAscii]=useState(false);
  const [asciiMode,setAsciiMode]=useState(0); // 0=Braille 1=Block 2=Matrix 3=Typewriter 4=Morse 5=Circuit 6=Runic 7=NoiseField
  const [asciiAmt,setAsciiAmt]=useState(0.8);  // blend strength 0-1
  const [asciiSize,setAsciiSize]=useState(0.4); // cell size
  const [asciiColor,setAsciiColor]=useState('#84cc16'); // char colour (overrides source when not 'source' mode)
  const [asciiColorMode,setAsciiColorMode]=useState('source'); // 'source'|'fixed'|'invert'
  const [asciiBypassSym,setAsciiBypassSym]=useState(false); // true = apply post-sym
  const [asciiResetFlash,setAsciiResetFlash]=useState(false);
  const asciiAtDefaults=!isAscii&&asciiMode===0&&asciiAmt===0.8&&asciiSize===0.4&&!asciiBypassSym;
  const [engineOrder,setEngineOrder]=useState([0,1,2,3,4,5,6,7,8,9,10]);


  // Capture
  const [isRecording,setIsRecording]=useState(false);
  const [exportStatus,setExportStatus]=useState('');
  const [recIn,setRecIn]=useState('A');
  const [recOut,setRecOut]=useState('B');
  const [recCycle,setRecCycle]=useState(false);
  const [showGifConverter,setShowGifConverter]=useState(false);

  // Derived
  const entropyAtDefaults=!isEntropy&&entropyStr===0.5&&entropyBpmMode==='steady'&&entropyManualBpm===120;
  const symmetryAtDefaults=!isSymmetry&&symmetryType===1&&!symMirrorInner&&!symAnimAxes&&symMask==='none';
  const prismaticAtDefaults=!isAlch&&alchType===1&&alchMod===0.5&&!boost&&alchTimeline==='morph';
  const fluxAtDefaults=!isFlux&&fluxMode===0&&fluxAmp===0.4&&fluxTimeline==='morph'&&fluxRate===0.5&&fluxShape===0&&!fluxBpmSync;
  const moduleAtDefaults=!isRotation&&!isPostRotation&&rotationSpeed===0.5&&postRotationSpeed===0.5&&!rotationBoost&&postRotationOffset===0&&zoom===1.0;
  const textAtDefaults=!isText&&textPhrase==='MORPH'&&textStrength===0.99&&glyphApplyTime===0.5&&textMotion===0&&textMotionAmp===0.4&&textBpmMode==='steady'&&textManualBpm===120&&!glyphLfoEnabled;

  // Popout
  const popoutWindowRef=useRef(null);
  const openPopout=scale=>{
    if(popoutWindowRef.current&&!popoutWindowRef.current.closed)popoutWindowRef.current.close();
    const dim=DIMENSION*scale;
    const bg=R.current.canvasBg||'#000000';
    const pop=window.open('','MorphologyVP',`width=${dim},height=${dim},menubar=no,toolbar=no,location=no,status=no,resizable=yes`);
    if(!pop){alert('Please allow popups.');return;}
    popoutWindowRef.current=pop;
    // zoom:1 on <html> defeats OS display scaling (125%, 150% etc) so the canvas
    // renders at exactly dim×dim logical pixels — 1 morph pixel = 1 screen pixel at 1×.
    // Canvas width/height attrs = dim (logical) so drawImage maps 1:1 at 1× scale.
    pop.document.write(`<!DOCTYPE html><html><head><title>Morphology ${scale}x</title><style>html{zoom:1;-ms-high-contrast:none;}*{margin:0;padding:0;}html,body{width:${dim}px;height:${dim}px;overflow:hidden;background:${bg};}canvas{display:block;width:${dim}px;height:${dim}px;image-rendering:pixelated;image-rendering:crisp-edges;}</style></head><body><canvas id="v" width="${dim}" height="${dim}"></canvas><script>(function(){window.resizeTo(${dim}+window.outerWidth-window.innerWidth,${dim}+window.outerHeight-window.innerHeight);})();<\/script></body></html>`);
    pop.document.close();
  };

  // Canvas refs
  const canvasRef=useRef(null);
  const rawCanvasRef=useRef(null);
  const postProcessCanvasRef=useRef(null);
  const postEffectTempRef=useRef(null);
  const pixelReadScratchRef=useRef(null); // dedicated read-back canvas for Halftone/Linocut/DotMatrix
  const trailBufferRef=useRef(null);
  const smokeBufferRef=useRef(null);
  const preSnapRawRef=useRef(null);
  const progressBarRef=useRef(null);
  const progressBarFillRef=useRef(null);

  // Animation refs
  const pixelsRef=useRef([]);
  const animationRef=useRef(0);
  const isMorphingRef=useRef(false);
  const isPausedRef=useRef(false);
  const progressRef=useRef(0);
  const lastTimeRef=useRef(0);
  const loopDirectionRef=useRef(1);
  const rotationAngleRef=useRef(0);
  const livePostRotationAngleRef=useRef(0);
  const zoomRef=useRef(1.0);
  const timeRef=useRef(0);
  const frameCountRef=useRef(0);
  const imgDataRef=useRef(null);
  const bufRef=useRef(null);
  const ctxRef=useRef(null);
  const rCtxRef=useRef(null);
  const pendingStatsRef=useRef(null);
  const driftLiveRef=useRef(false);
  const beatFlashRef=useRef(false);
  const isEntropyActiveRef=useRef(false);
  const orbitCenterRef=useRef({x:150,y:150,vx:0.4,vy:0.25});
  const mediaRecorderRef=useRef(null);
  const recordedChunksRef=useRef([]);
  const recCycleCountRef=useRef(0);
  const symAnimAngleRef=useRef(0);

  // ── Audio Engine ──────────────────────────────────────────────────────────────
  // Single shared "audio bus" — written once per rAF tick, read by renderFrame & routing
  const audioCtxRef    = useRef(null);
  const analyserRef    = useRef(null);
  const audioSrcRef    = useRef(null);
  const audioStreamRef = useRef(null);
  const audioFreqRef   = useRef(null);   // Uint8Array frequency bins
  const audioWaveRef   = useRef(null);   // Float32Array waveform
  const audBusRef = useRef({bass:0,sub:0,low:0,mid:0,treble:0,rms:0,beat:false,beatAge:9999,spectrum:null,waveform:null,active:false});
  const audBeatCoolRef = useRef(0);
  const audThreshRef   = useRef(0.15);

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
  const lufsAccRef       = useRef([]);
  const [lufsAvg,        setLufsAvg]        = useState(-70);
  const [canvasBg,       setCanvasBg]       = useState('#000000');
  const cyAtDefaults = scopeCards.every(c=>!c.enabled) && !cyListen && cySens===0.65 && cySmooth===0.72;
  const cyCanvasRef    = useRef(null);
  const scopeCardCanvasRefs = useRef({});
  const scopeDisplayCanvasRefs = useRef({});
  const scopeOutputRef      = useRef(null);
  const scopeSmWfRefs       = useRef({});
  const scopeSmSpRefs       = useRef({});
  const scopeParticlesRef   = useRef({});
  const scopePersistRef     = useRef({});

  // ── Pin Matrix: audPins[source][target] = true/false ─────────────────────────
  // Sources: bass mid treble peak rms beat lufs lfo1 lfo2 lfo3 lfo4
  // Targets: zoom rotation postRotation entropy fluxAmp chroma symPhase symType glyphPull vignette prismatic smoke trails speed bpm flash
  const AUD_SOURCES=['bass','sub','low','mid','treble','rms','beat','lufs','lfo1','lfo2','lfo3','lfo4'];
  const AUD_TARGETS=['zoom','rotation','postRot','entropy','fluxAmp','chroma','symPhase','symType','glyphPull','vignette','prismatic','smoke','trails','speed','bpm','flash','warpAmt','fieldAmt','glitchAmt','retroAmt'];
  const AUD_TARGET_LABELS=['Zoom','Rot','PostRot','Entropy','FlxAmp','Chroma','SymPhase','SymType','GlyphPull','Vignette','Prismatic','Smoke','Trails','Speed','BPM','Flash','Warp','Field','Glitch','Retro'];
  const AUD_SOURCE_LABELS=['Bass','Sub Bass','Low','Mid','High','RMS','Beat','LUFS','LFO 1','LFO 2','LFO 3','LFO 4'];
  const [audPins, setAudPins] = useState(()=>{
    const m={};
    AUD_SOURCES.forEach(s=>{m[s]={};AUD_TARGETS.forEach(t=>{m[s][t]=false;});});
    return m;
  });
  const audPinsRef = useRef(audPins);
  useEffect(()=>{audPinsRef.current=audPins;},[audPins]);
  const togglePin=(src,tgt)=>setAudPins(prev=>{
    const next={...prev,[src]:{...prev[src],[tgt]:!prev[src][tgt]}};
    return next;
  });

  // ── LFO Range brackets: per-target lo/hi sweep range (0–1 normalised) ────────
  // Only targets that have a corresponding slider in the UI. When an LFO is
  // pinned to a target that has a range, the routing uses absolute interpolation
  // (lerp lo→hi) rather than additive offset.
  const [lfoRanges,setLfoRanges]=useState(()=>{
    const defaults={zoom:{lo:0.1,hi:0.9},rotation:{lo:0.1,hi:0.9},postRot:{lo:0.1,hi:0.9},
      entropy:{lo:0.0,hi:1.0},fluxAmp:{lo:0.0,hi:1.0},chroma:{lo:0.0,hi:1.0},
      glyphPull:{lo:0.0,hi:1.0},vignette:{lo:0.0,hi:1.0},prismatic:{lo:0.0,hi:1.0},
      smoke:{lo:0.0,hi:1.0},trails:{lo:0.0,hi:1.0},speed:{lo:0.1,hi:0.9}};
    return defaults;
  });
  const lfoRangesRef=useRef(lfoRanges);
  useEffect(()=>{lfoRangesRef.current=lfoRanges;},[lfoRanges]);
  const setLfoRange=(tgt,range)=>setLfoRanges(prev=>({...prev,[tgt]:range}));

  // Returns lfoRange+onRangeChange props for a slider when an LFO is pinned to that target.
  // Pass spread into FSlider: <FSlider {...lfoRP('zoom')} .../>
  const lfoRP=tgt=>isLfoPinned(tgt)?{lfoRange:lfoRanges[tgt],onRangeChange:r=>setLfoRange(tgt,r)}:{};

  // Map AUD_TARGETS key → {min, max} for normalisation display in FSlider
  const TGT_SLIDER_META={
    zoom:      {min:0.25,max:3.0},
    rotation:  {min:0,   max:1},
    postRot:   {min:0,   max:1},
    entropy:   {min:0,   max:1},
    fluxAmp:   {min:0,   max:1},
    chroma:    {min:0,   max:1},
    glyphPull: {min:0,   max:1},
    vignette:  {min:0,   max:1},
    prismatic: {min:0,   max:1},
    smoke:     {min:0,   max:1},
    trails:    {min:0,   max:1},
    speed:     {min:0,   max:1},
    warpAmt:   {min:0,   max:1},
    fieldAmt:  {min:0,   max:1},
    glitchAmt: {min:0,   max:1},
    retroAmt:  {min:0,   max:1},
  };

  // Returns true if ANY lfo source is currently pinned to this target
  const isLfoPinned=tgt=>['lfo1','lfo2','lfo3','lfo4'].some(src=>audPins[src]?.[tgt]);
  // Returns the blended LFO output (0–1 unscaled) for a target (uses all pinned LFOs, max blend)
  // Used in render to drive absolute param values
  const getLfoValForTarget=tgt=>{
    let out=0;
    ['lfo1','lfo2','lfo3','lfo4'].forEach((src,i)=>{
      if(audPins[src]?.[tgt])out=Math.max(out,lfoValsRef.current[i]||0);
    });
    return out; // already depth-scaled 0..depth
  };

  // ── LFO bank: 4 independent LFOs ─────────────────────────────────────────────
  const LFO_SHAPES=['Sine','Tri','Square','Saw','RevSaw','SmpHold'];
  const [lfos,setLfos]=useState([
    {enabled:false,rate:0.3,depth:0.7,shape:0,phase:0,bpmSync:false,bpmDiv:1},
    {enabled:false,rate:0.3,depth:0.7,shape:0,phase:0,bpmSync:false,bpmDiv:2},
    {enabled:false,rate:0.3,depth:0.7,shape:0,phase:0,bpmSync:false,bpmDiv:4},
    {enabled:false,rate:0.3,depth:0.7,shape:0,phase:0,bpmSync:false,bpmDiv:8},
  ]);
  const lfoPhaseRef=useRef([0,0,0,0]); // per-LFO phase accumulators (0–1)
  const lfoSHRef   =useRef([0,0,0,0]); // sample-and-hold last values
  const lfoSHTrigRef=useRef([0,0,0,0]);// sample-and-hold trigger times
  const lfosRef    =useRef(lfos);
  const lfoValsRef =useRef([0,0,0,0]); // live output for UI display
  const lfoAbsRef  =useRef({});        // tgt→absolute override value from LFO range brackets
  useEffect(()=>{lfosRef.current=lfos;},[lfos]);
  const setLfo=(i,patch)=>setLfos(prev=>prev.map((l,idx)=>idx===i?{...l,...patch}:l));

  // ── Audio mod bus: separate "mod" values that decay to 0 each frame ──────────
  const audModRef = useRef({zoom:0,rotation:0,postRotation:0,entropy:0,flux:0,chroma:0,glyph:0,vignette:0,prismatic:0,symPhase:0,smoke:0,trails:0,speed:0,bpm:0,flash:0});
  const [cyBeatFlash, setCyBeatFlash] = useState(false);  // separate from BPM flash
  // Throttled UI state for the level meters (updated ~15fps from the RAF loop)
  const [audLevels, setAudLevels] = useState({bass:0,sub:0,low:0,mid:0,treble:0,rms:0,beat:false,lufs:-70,lufsNorm:0,lufsInt:-70});
  const audLevelsLastRef = useRef(0);

  // Synced refs (all the mutable state needed inside rAF)
  const R=useRef({});
  useEffect(()=>{
    R.current={
      duration,isLooping,pixelationMargin,splitMargin,marginA,marginB,particleDensity,pointSize,easingEnabled,highRefreshMode,
      trailsEnabled,trailStrength,trailPre,trailPost,smokeEnabled,smokeStrength,smokePre,smokePost,smokeRise,
      isEntropy,entropyType,entropyStr,entropyBpmMode,entropyManualBpm,bpm,bpmEnabled,
      isRotation,rotationSpeed,isPostRotation,postRotationSpeed,rotationBoost,postRotationOffset,zoom,
      isSymmetry,symmetryType,symMirrorInner,symAnimAxes,symAnimRate,symCreativeAmt,symBlend,symOpacity,symCenterHole,symMask,
      isAlch,alchType,alchMod,boost,alchTimeline,alchRate,alchShape,
      isFlux,fluxMode,fluxAmp,fluxTimeline,fluxRate,fluxShape,fluxBpmSync,
      isGlitch,glitchMode,glitchAmt,glitchRate,glitchTimeline,
      isRetro,retroMode,retroAmt,retroColor,retroSpeed,retroLayer,
      isWarp,warpMode,warpAmt,warpRate,
      isField,fieldMode,fieldAmt,fieldX,fieldY,
      isAscii,asciiMode,asciiAmt,asciiSize,asciiColor,asciiColorMode,asciiBypassSym,
      recIn,recOut,recCycle,
      isText,textStrength,textMotion,textMotionAmp,textBpmMode,textManualBpm,glyphApplyTime,glyphFontSize,glyphSpacing,glyphOutline,glyphColorMode,
      glyphLfoEnabled,glyphLfoShape,glyphLfoRatePull,glyphLfoRateAmp,glyphLfoDepthPull,glyphLfoDepthAmp,glyphLfoPull,glyphLfoAmp,
      chromaEnabled,chromaAmt,chromaRgbMode,vignetteEnabled,vignetteAmt,
      colorGradeEnabled,colorGradeHue,colorGradeSat,colorGradeBri,
      scanlinesEnabled,scanlinesAmt,scanlinesSize,
      linocutEnabled,linocutAmt,
      halftoneEnabled,halftoneSize,
      smearEnabled,smearAmt,smearAngle,
      dotMatrixEnabled,dotMatrixSize,
      cySens,cySmooth,cyFreqLo,cyFreqHi,cyFreqHz,cyFreqLoHz,cyFreqHiHz,
      cyXoverSL,cyXoverLM,cyXoverMH,cyLufsWindow,cyHideCanvas,canvasBg,
    };
    scopeCardsRef.current=scopeCards;
  });

  const alchPhaseRef=useRef(0);
  const fluxPhaseRef=useRef(0);

  useEffect(()=>{textMaskDirtyRef.current=true;},[textPhrase]);
  useEffect(()=>{textMaskDirtyRef.current=true;},[glyphFontSize,glyphSpacing,glyphOutline]);

  // Build symmetry shape mask canvas
  useEffect(()=>{
    const D=DIMENSION;
    if(!symMaskCanvasRef.current){symMaskCanvasRef.current=document.createElement('canvas');symMaskCanvasRef.current.width=D;symMaskCanvasRef.current.height=D;}
    const mc=symMaskCanvasRef.current;
    const mCtx=mc.getContext('2d');
    mCtx.clearRect(0,0,D,D);
    if(symMask==='none')return;
    if(symMask==='custom'&&symMaskCustomUrl){
      const img=new Image();img.onload=()=>{mCtx.clearRect(0,0,D,D);mCtx.drawImage(img,0,0,D,D);};img.src=symMaskCustomUrl;
      return;
    }
    mCtx.fillStyle='#fff';
    const cx=D/2,cy=D/2,r=D/2-2;
    mCtx.beginPath();
    if(symMask==='circle'){mCtx.arc(cx,cy,r,0,Math.PI*2);}
    else if(symMask==='diamond'){mCtx.moveTo(cx,2);mCtx.lineTo(D-2,cy);mCtx.lineTo(cx,D-2);mCtx.lineTo(2,cy);}
    else if(symMask==='triangle'){mCtx.moveTo(cx,4);mCtx.lineTo(D-4,D-4);mCtx.lineTo(4,D-4);}
    else if(symMask==='star'){
      const spikes=5,outer=r,inner=r*.4;
      for(let i=0;i<spikes*2;i++){const a=i*Math.PI/spikes-Math.PI/2;const rr=i%2===0?outer:inner;mCtx.lineTo(cx+Math.cos(a)*rr,cy+Math.sin(a)*rr);}
    }
    else if(symMask==='hex'){
      for(let i=0;i<6;i++){const a=i*Math.PI/3-Math.PI/6;mCtx.lineTo(cx+Math.cos(a)*r,cy+Math.sin(a)*r);}
    }
    mCtx.closePath();mCtx.fill();
  },[symMask,symMaskCustomUrl]);

  // Popout sync
  useEffect(()=>{
    let last=0;
    let rafId=null;
    const sync=now=>{
      if(popoutWindowRef.current&&!popoutWindowRef.current.closed){
        const pc=popoutWindowRef.current.document.getElementById('v');
        const mc=canvasRef.current;
        if(pc&&mc){
          const iv=R.current.highRefreshMode===2?6.94:R.current.highRefreshMode===1?8.33:16.67;
          if(now-last>=iv){
            pc.getContext('2d',{alpha:false}).drawImage(mc,0,0,pc.width,pc.height);
            last=now;
            // Sync background colour for chroma key
            const bg=R.current.canvasBg||'#000000';
            if(popoutWindowRef.current.document.body.style.background!==bg)
              popoutWindowRef.current.document.body.style.background=bg;
          }
        }
      }
      rafId=requestAnimationFrame(sync);
    };
    rafId=requestAnimationFrame(sync);
    return()=>{cancelAnimationFrame(rafId);if(popoutWindowRef.current&&!popoutWindowRef.current.closed)popoutWindowRef.current.close();};
  },[]);

  const ensureCanvas=ref=>{
    if(!ref.current){ref.current=document.createElement('canvas');ref.current.width=DIMENSION;ref.current.height=DIMENSION;}
    return ref.current.getContext('2d',{alpha:false,willReadFrequently:true});
  };
  const clearFeedbackBuffers=()=>{
    [preSnapRawRef,trailBufferRef,smokeBufferRef].forEach(r=>{
      if(r.current){const c=r.current.getContext('2d',{alpha:false});c.fillStyle='#000';c.fillRect(0,0,DIMENSION,DIMENSION);}
      r._ctx=null;
    });
    imgDataRef.current=null;bufRef.current=null;
  };
  const getPixelData=(url,grade)=>new Promise(resolve=>{
    const img=new Image();img.onload=()=>{
      const c=document.createElement('canvas');c.width=DIMENSION;c.height=DIMENSION;
      const ctx=c.getContext('2d');
      // Apply per-source grade via canvas filter (non-destructive)
      if(grade&&(grade.hue!==0||grade.sat!==1||grade.bri!==1)){
        ctx.filter=`hue-rotate(${grade.hue}deg) saturate(${grade.sat}) brightness(${grade.bri})`;
      }
      ctx.drawImage(img,0,0,DIMENSION,DIMENSION);
      ctx.filter='none';
      const data=ctx.getImageData(0,0,DIMENSION,DIMENSION).data;
      let rT=0,gT=0,bT=0;
      for(let i=0;i<data.length;i+=4){rT+=data[i];gT+=data[i+1];bT+=data[i+2];}
      const pc=DIMENSION*DIMENSION;
      resolve({data,stats:{brightness:(rT+gT+bT)/(3*pc*255),r:rT/pc,g:gT/pc,b:bT/pc}});
    };img.src=url;
  });

  const syncPixels=async()=>{
    if(!imageA||!imageB)return;
    clearFeedbackBuffers();
    const {data:dA}=await getPixelData(imageA,gradeA);const {data:dB}=await getPixelData(imageB,gradeB);
    const pixels=[];
    for(let i=0;i<dA.length;i+=4){
      const x=(i/4)%DIMENSION,y=Math.floor((i/4)/DIMENSION);
      const luma=(dA[i]*.299+dA[i+1]*.587+dA[i+2]*.114)/255;
      pixels.push({r:dA[i],g:dA[i+1],b:dA[i+2],x,y,tx:x,ty:y,tr:dB[i],tg:dB[i+1],tb:dB[i+2],vx:0,vy:0,driftX:0,driftY:0,idx:i/4,mass:0.4+(1-luma)*2.1});
    }
    const sA=[...pixels].sort((a,b)=>{const vA=a.r*.299+a.g*.587+a.b*.114,vB=b.r*.299+b.g*.587+b.b*.114;return vA!==vB?vA-vB:a.idx-b.idx;});
    const tB=Array.from({length:DIMENSION*DIMENSION},(_,i)=>({tr:dB[i*4],tg:dB[i*4+1],tb:dB[i*4+2],tx:i%DIMENSION,ty:Math.floor(i/DIMENSION),idx:i})).sort((a,b)=>{const vA=a.tr*.299+a.tg*.587+a.tb*.114,vB=b.tr*.299+b.tg*.587+b.tb*.114;return vA!==vB?vA-vB:a.idx-b.idx;});
    sA.forEach((p,i)=>{p.tx=tB[i].tx;p.ty=tB[i].ty;p.tr=tB[i].tr;p.tg=tB[i].tg;p.tb=tB[i].tb;});
    pixelsRef.current=sA;
    renderFrame(0);renderFrame(0.5);renderFrame(progressRef.current);
  };
  useEffect(()=>{syncPixels();},[imageA,imageB,gradeA,gradeB]);

  // ── Audio engine functions ───────────────────────────────────────────────────
  const stopAudio=()=>{
    if(audioStreamRef.current){audioStreamRef.current.getTracks().forEach(t=>t.stop());audioStreamRef.current=null;}
    if(audioSrcRef.current){try{audioSrcRef.current.disconnect();}catch(e){}audioSrcRef.current=null;}
    if(audioCtxRef.current){try{audioCtxRef.current.close();}catch(e){}audioCtxRef.current=null;}
    analyserRef.current=null;audioFreqRef.current=null;audioWaveRef.current=null;
    audBusRef.current={bass:0,sub:0,low:0,mid:0,treble:0,rms:0,beat:false,beatAge:9999,spectrum:null,waveform:null,active:false};
    lufsAccRef.current=[];
    setCyListen(false);
    setAudLevels({bass:0,sub:0,low:0,mid:0,treble:0,rms:0,beat:false,lufs:-70,lufsNorm:0,lufsInt:-70});
  };

  const startMic=async()=>{
    stopAudio();
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:true,video:false});
      audioStreamRef.current=stream;
      const actx=new(window.AudioContext||window.webkitAudioContext)();
      audioCtxRef.current=actx;
      const analyser=actx.createAnalyser();
      analyser.fftSize=2048;
      analyser.smoothingTimeConstant=R.current.cySmooth??0.72;
      analyserRef.current=analyser;
      audioFreqRef.current=new Uint8Array(analyser.frequencyBinCount);
      audioWaveRef.current=new Float32Array(analyser.fftSize);
      const src=actx.createMediaStreamSource(stream);
      src.connect(analyser);
      audioSrcRef.current=src;
      // AudioContext may start suspended (browser autoplay policy) — must resume on user gesture
      if(actx.state==='suspended')await actx.resume();
      audBusRef.current.active=true;
      setCyMicErr('');
      setCyListen(true);
    }catch(e){
      setCyMicErr(e.name==='NotAllowedError'?'Mic permission denied':'Mic error: '+e.message);
      setCyListen(false);
    }
  };


  // Called once per rAF tick — pure math, no React setState
  const tickAudio=(dt,rc)=>{
    const analyser=analyserRef.current;
    if(!analyser)return;
    analyser.smoothingTimeConstant=Math.max(0,Math.min(0.99,rc.cySmooth??0.72));
    const freq=audioFreqRef.current;
    const wave=audioWaveRef.current;
    analyser.getByteFrequencyData(freq);
    analyser.getFloatTimeDomainData(wave);
    const N=freq.length; // = fftSize/2 = 1024
    const sens=rc.cySens??0.65;
    // ── Frequency window ────────────────────────────────────────────────────
    // Hz mode: convert cutoffs to bin indices using Nyquist (sampleRate/2 spread over N bins)
    // % mode: direct fraction of N bins
    let wStart,wEnd;
    if(rc.cyFreqHz){
      const nyquist=(analyser.context?.sampleRate??44100)/2;
      wStart=Math.max(0,Math.floor((rc.cyFreqLoHz??20)/nyquist*N));
      wEnd  =Math.min(N,Math.max(wStart+1,Math.ceil((rc.cyFreqHiHz??20000)/nyquist*N)));
    }else{
      const lo=rc.cyFreqLo??0;
      const hi=rc.cyFreqHi??1;
      wStart=Math.floor(lo*N);
      wEnd  =Math.max(wStart+1,Math.floor(hi*N));
    }
    const wN=Math.max(1,wEnd-wStart);
    // ── Band crossovers — stored in Hz, converted to bin indices ───────────────
    const nyquist=(analyser.context?.sampleRate??44100)/2;
    const hzToBin=hz=>Math.max(0,Math.min(N-1,Math.round(hz/nyquist*N)));
    // Crossovers clamp within the analysis window
    const subEndBin=Math.max(wStart+1, Math.min(hzToBin(rc.cyXoverSL??80),  wEnd-3));
    const lowEndBin=Math.max(subEndBin+1,Math.min(hzToBin(rc.cyXoverLM??500),wEnd-2));
    const midEndBin=Math.max(lowEndBin+1,Math.min(hzToBin(rc.cyXoverMH??4000),wEnd-1));
    let subSum=0,lowSum=0,midSum=0,hiSum=0;
    for(let i=wStart;   i<subEndBin;i++)subSum+=freq[i];
    for(let i=subEndBin;i<lowEndBin;i++)lowSum+=freq[i];
    for(let i=lowEndBin;i<midEndBin;i++)midSum+=freq[i];
    for(let i=midEndBin;i<wEnd;     i++)hiSum +=freq[i];
    const subN=subEndBin-wStart, lowN=lowEndBin-subEndBin, midN=midEndBin-lowEndBin, hiN=wEnd-midEndBin;
    // Legacy mapping: bass=sub, mid=low+mid combined, treble=high — keeps mod routing working
    const sub   =Math.min(1,(subSum/(Math.max(1,subN)*255))*sens*3.2);
    const low   =Math.min(1,(lowSum/(Math.max(1,lowN)*255))*sens*3.0);
    const mid   =Math.min(1,(midSum/(Math.max(1,midN)*255))*sens*2.5);
    const treble=Math.min(1,(hiSum /(Math.max(1,hiN )*255))*sens*2.2);
    const bass=sub; // bass alias for mod routing compat
    let rmsAcc=0;for(let i=0;i<wave.length;i++)rmsAcc+=wave[i]*wave[i];
    const rms=Math.min(1,Math.sqrt(rmsAcc/wave.length)*sens*5);
    // ── LUFS (short-term, ITU-R BS.1770 approx) ────────────────────────────
    const meanSq=rmsAcc/wave.length;
    const lufs=meanSq>1e-10?Math.max(-70,-0.691+10*Math.log10(meanSq)):-70;
    const lufsNorm=Math.max(0,Math.min(1,(lufs+70)/64));
    // ── LUFS integrated average ─────────────────────────────────────────────
    const now=performance.now();
    const winMs=(rc.cyLufsWindow??3)*1000;
    const acc=lufsAccRef.current;
    acc.push({v:lufs,t:now});
    // Prune samples older than window
    let oldest=now-winMs;
    while(acc.length>1&&acc[0].t<oldest)acc.shift();
    // Integrated LUFS = power average of samples → convert back
    let pwrSum=0,pwrN=0;
    for(const s of acc){const p=Math.pow(10,(s.v+0.691)/10);pwrSum+=p;pwrN++;}
    const lufsIntegrated=pwrN>0?Math.max(-70,-0.691+10*Math.log10(pwrSum/pwrN)):-70;
    // ── Beat onset ──────────────────────────────────────────────────────────
    audBeatCoolRef.current=Math.max(0,audBeatCoolRef.current-dt);
    const thr=audThreshRef.current;
    const beat=bass>thr+0.16&&audBeatCoolRef.current<=0;
    if(beat)audBeatCoolRef.current=200;
    audThreshRef.current=thr*0.93+bass*0.07;
    // ── Spectrum: 256 bins remapped to analysis window ───────────────────────
    if(!audBusRef.current.spectrum)audBusRef.current.spectrum=new Float32Array(256);
    const spec=audBusRef.current.spectrum;
    for(let i=0;i<256;i++){
      const srcBin=wStart+Math.floor((i/256)*wN);
      spec[i]=Math.min(1,(freq[Math.min(srcBin,N-1)]/255)*sens*1.8);
    }
    const prev=audBusRef.current;
    audBusRef.current={bass,sub,low,mid,treble,rms,beat,lufs,lufsNorm,lufsInt:lufsIntegrated,
      beatAge:beat?0:Math.min(9999,prev.beatAge+dt),spectrum:spec,waveform:wave,active:true};
  };

  useEffect(()=>()=>stopAudio(),[]);
  // Auto-clear beat flash after 80ms
  useEffect(()=>{if(cyBeatFlash){const t=setTimeout(()=>setCyBeatFlash(false),80);return()=>clearTimeout(t);}},[cyBeatFlash]);

  const renderFrame=p=>{
    const canvas=canvasRef.current;
    if(!canvas||pixelsRef.current.length===0)return;
    if(!ctxRef.current)ctxRef.current=canvas.getContext('2d',{alpha:false});
    const ctx=ctxRef.current;
    if(!rCtxRef.current){rCtxRef.current=ensureCanvas(rawCanvasRef);imgDataRef.current=null;bufRef.current=null;}
    const rCtx=rCtxRef.current;
    if(!preSnapRawRef.current){ensureCanvas(preSnapRawRef);}
    if(!trailBufferRef.current){ensureCanvas(trailBufferRef);}
    if(!smokeBufferRef.current){ensureCanvas(smokeBufferRef);}

    const rc=R.current;
    // ── applyRetro — defined at renderFrame scope so all layer call-sites can reach it ──
    const applyRetro=(targetCtx,D)=>{

      const rm=rc.retroMode||0;const ra=rcRetroAmt;const T2=timeRef.current;
      const rc2=rc.retroColor||'#ff00ff';const rs=rc.retroSpeed||0.5;
      const cx=D/2,cy=D/2;
      targetCtx.save();

      if(rm===0){
        // ── GRID: Neon Laser Floor — infinite receding wireframe with bloom glow ──
        targetCtx.globalCompositeOperation='screen';
        const vy=D*0.52;// horizon line
        const scroll=(T2*rs*80)%D;
        const nLines=16;// vertical perspective lines
        const nHoriz=14;// horizontal lines
        // Deep space gradient above horizon
        const skyG=targetCtx.createLinearGradient(0,0,0,vy);
        skyG.addColorStop(0,'rgba(0,0,0,0)');
        skyG.addColorStop(1,`${rc2}22`);
        targetCtx.globalAlpha=ra;targetCtx.fillStyle=skyG;targetCtx.fillRect(0,0,D,vy);
        // Draw each line twice: faint wide glow pass + sharp bright pass
        [[3.5,0.12],[1,0.75]].forEach(([lw,al])=>{
          targetCtx.lineWidth=lw;
          // Vertical perspective lines radiating from vanishing point
          for(let i=0;i<=nLines;i++){
            const t=i/nLines;
            const bx=(t-0.5)*D*1.6+cx;// spread at bottom
            targetCtx.globalAlpha=ra*al*(0.4+t*0.6);
            targetCtx.strokeStyle=rc2;
            targetCtx.beginPath();targetCtx.moveTo(cx,vy);targetCtx.lineTo(bx,D);targetCtx.stroke();
          }
          // Horizontal perspective lines (receding floor)
          for(let j=0;j<nHoriz;j++){
            const p=Math.pow((j+((T2*rs*1.2)%1))/nHoriz,1.8);
            const y2=vy+(D-vy)*p;
            const halfW=(D*0.8)*p;
            targetCtx.globalAlpha=ra*al*(0.15+p*0.85);
            targetCtx.strokeStyle=rc2;
            targetCtx.beginPath();targetCtx.moveTo(cx-halfW,y2);targetCtx.lineTo(cx+halfW,y2);targetCtx.stroke();
          }
        });
        // Bright horizon glow line
        const hg=targetCtx.createLinearGradient(0,vy-2,0,vy+2);
        hg.addColorStop(0,'rgba(0,0,0,0)');hg.addColorStop(0.5,rc2);hg.addColorStop(1,'rgba(0,0,0,0)');
        targetCtx.globalAlpha=ra*0.9;targetCtx.fillStyle=hg;targetCtx.fillRect(0,vy-3,D,6);

      }else if(rm===1){
        // ── SUN: Outrun Retro Sun — magenta→yellow gradient with animated blind slices ──
        targetCtx.globalCompositeOperation='screen';
        const sunCX=cx,sunCY=D*0.42;
        const sunR=D*0.32;
        // Outer atmosphere bloom — multiple radial passes
        [[sunR*2.2,0.04],[sunR*1.6,0.08],[sunR*1.2,0.16]].forEach(([r,al])=>{
          const ag=targetCtx.createRadialGradient(sunCX,sunCY,sunR*0.6,sunCX,sunCY,r);
          ag.addColorStop(0,`${rc2}88`);ag.addColorStop(1,'rgba(0,0,0,0)');
          targetCtx.globalAlpha=ra*al;targetCtx.fillStyle=ag;
          targetCtx.beginPath();targetCtx.arc(sunCX,sunCY,r,0,Math.PI*2);targetCtx.fill();
        });
        // Main sun disc: gradient from rc2 (top, typically magenta/pink) to golden yellow
        const sg=targetCtx.createLinearGradient(sunCX,sunCY-sunR,sunCX,sunCY+sunR);
        sg.addColorStop(0,rc2);
        sg.addColorStop(0.45,`hsl(30,100%,70%)`);// warm amber mid
        sg.addColorStop(1,`hsl(50,100%,55%)`);  // golden bottom
        targetCtx.globalAlpha=ra;
        targetCtx.fillStyle=sg;
        targetCtx.beginPath();targetCtx.arc(sunCX,sunCY,sunR,0,Math.PI*2);targetCtx.fill();
        // Horizontal blind slices — clipped to circle so edges curve with the disc
        const nBands=8;const bandH=sunR*0.13;
        targetCtx.save();
        targetCtx.beginPath();targetCtx.arc(sunCX,sunCY,sunR,0,Math.PI*2);targetCtx.clip();
        targetCtx.fillStyle='rgba(0,0,0,1)';
        targetCtx.globalCompositeOperation='source-over';
        for(let b=0;b<nBands;b++){
          const frac=b/nBands;
          const sliceY=sunCY+sunR*(0.1+frac*0.88);
          if(sliceY>sunCY+sunR)continue;
          const anim=((T2*rs*0.15+b*0.12)%0.15)*sunR;
          const sy=sliceY-anim;
          targetCtx.globalAlpha=ra*(1-frac*0.5);
          targetCtx.fillRect(sunCX-sunR,sy,sunR*2,bandH*(0.55+frac*0.45));
        }
        targetCtx.restore();
        targetCtx.globalCompositeOperation='screen';
        // Inner specular highlight on top of disc
        const spec=targetCtx.createRadialGradient(sunCX-sunR*0.2,sunCY-sunR*0.3,0,sunCX,sunCY,sunR*0.9);
        spec.addColorStop(0,'rgba(255,255,255,0.35)');spec.addColorStop(0.4,'rgba(255,255,255,0.04)');spec.addColorStop(1,'rgba(0,0,0,0)');
        targetCtx.globalAlpha=ra*0.8;targetCtx.fillStyle=spec;
        targetCtx.beginPath();targetCtx.arc(sunCX,sunCY,sunR,0,Math.PI*2);targetCtx.fill();

      }else if(rm===2){
        // ── SYNTHWAVE: Deep space — starfield + nebula + mountain silhouette ──
        targetCtx.globalCompositeOperation='screen';
        // Starfield — randomly placed dots that twinkle
        targetCtx.globalAlpha=ra;
        const starSeed=42;
        for(let s=0;s<120;s++){
          const sx=((s*317+starSeed)%D);
          const sy=((s*193+starSeed)%Math.round(D*0.65));
          const twinkle=0.4+0.6*Math.abs(Math.sin(T2*rs*1.2+s*2.4));
          const sz=0.4+((s*73)%3)*0.5;
          targetCtx.globalAlpha=ra*twinkle*(0.4+((s*11)%5)*0.1);
          targetCtx.fillStyle=s%7===0?'#a0c8ff':s%5===0?rc2:'#ffffff';
          targetCtx.beginPath();targetCtx.arc(sx,sy,sz,0,Math.PI*2);targetCtx.fill();
        }
        // Nebula clouds — soft radial glows in violet/cyan
        [[cx*0.4,D*0.2,D*0.45,'#6600cc'],[cx*1.6,D*0.15,D*0.35,'#0066ff'],
         [cx*0.9,D*0.35,D*0.28,rc2]].forEach(([nx,ny,nr,nc])=>{
          const ng=targetCtx.createRadialGradient(nx,ny,0,nx,ny,nr);
          ng.addColorStop(0,nc+'44');ng.addColorStop(0.5,nc+'18');ng.addColorStop(1,'rgba(0,0,0,0)');
          targetCtx.globalAlpha=ra*0.6;targetCtx.fillStyle=ng;targetCtx.fillRect(0,0,D,D);
        });
        // Mountain silhouette ranges — two layers, foreground darker
        [[D*0.58,0.22,'rgba(20,0,40,0.85)'],[D*0.68,0.14,'rgba(10,0,20,0.95)']].forEach(([mH,jitter,fill],mi)=>{
          targetCtx.globalAlpha=ra;targetCtx.fillStyle=fill;
          targetCtx.beginPath();targetCtx.moveTo(0,D);
          const steps=32;
          for(let mx=0;mx<=steps;mx++){
            const mfrac=mx/steps;
            const noise=Math.sin(mfrac*11+mi*3.7)*Math.cos(mfrac*7+mi)*jitter*D;
            const my=mH+noise;
            targetCtx.lineTo(mfrac*D,my);
          }
          targetCtx.lineTo(D,D);targetCtx.closePath();targetCtx.fill();
        });
        // City glow on horizon
        const hg2=targetCtx.createLinearGradient(0,D*0.6,0,D*0.72);
        hg2.addColorStop(0,rc2+'55');hg2.addColorStop(1,'rgba(0,0,0,0)');
        targetCtx.globalAlpha=ra*0.7;targetCtx.fillStyle=hg2;targetCtx.fillRect(0,D*0.6,D,D*0.12);

      }else if(rm===3){
        // ── CRT: Vintage monitor — scanlines + barrel distortion + phosphor glow + chromatic aberration ──
        targetCtx.globalCompositeOperation='multiply';
        // Barrel vignette — darkens corners like a curved CRT tube
        const vig=targetCtx.createRadialGradient(cx,cy,D*0.15,cx,cy,D*0.88);
        vig.addColorStop(0,'rgba(255,255,255,1)');
        vig.addColorStop(0.6,'rgba(200,200,200,0.85)');
        vig.addColorStop(1,'rgba(0,0,0,0.0)');
        targetCtx.globalAlpha=ra*0.9;targetCtx.fillStyle=vig;targetCtx.fillRect(0,0,D,D);
        // Scanlines — alternating dark bands at 2px pitch
        targetCtx.globalCompositeOperation='multiply';
        targetCtx.fillStyle='rgba(0,0,0,0.42)';
        targetCtx.globalAlpha=ra;
        for(let y2=0;y2<D;y2+=2)targetCtx.fillRect(0,y2,D,1);
        // Subtle horizontal screen flicker
        const flick=0.96+0.04*Math.sin(T2*rs*180+0.5);
        targetCtx.globalCompositeOperation='multiply';
        targetCtx.globalAlpha=ra*(1-flick)*0.6;
        targetCtx.fillStyle='rgba(0,0,0,1)';targetCtx.fillRect(0,0,D,D);
        // Phosphor bloom — green channel slight horizontal smear
        targetCtx.globalCompositeOperation='screen';
        const ph=targetCtx.createLinearGradient(0,0,D,0);
        ph.addColorStop(0,'rgba(0,255,80,0.0)');ph.addColorStop(0.5,'rgba(0,255,80,0.04)');ph.addColorStop(1,'rgba(0,255,80,0.0)');
        targetCtx.globalAlpha=ra*0.5;targetCtx.fillStyle=ph;targetCtx.fillRect(0,0,D,D);
        // Chromatic aberration — slight R/B channel fringe at edges
        targetCtx.globalCompositeOperation='screen';
        const shift=Math.round(D*0.008);
        targetCtx.globalAlpha=ra*0.18;
        targetCtx.fillStyle='rgba(255,0,0,1)';targetCtx.fillRect(-shift,0,D,D);
        targetCtx.fillStyle='rgba(0,0,255,1)';targetCtx.fillRect(shift,0,D,D);
        // Reflective screen glare — top-left arc
        targetCtx.globalCompositeOperation='screen';
        const glare=targetCtx.createRadialGradient(D*0.12,D*0.08,0,D*0.12,D*0.08,D*0.4);
        glare.addColorStop(0,'rgba(255,255,255,0.12)');glare.addColorStop(0.4,'rgba(255,255,255,0.03)');glare.addColorStop(1,'rgba(0,0,0,0)');
        targetCtx.globalAlpha=ra*0.7;targetCtx.fillStyle=glare;targetCtx.fillRect(0,0,D,D);

      }else if(rm===4){
        // ── VOID: Neon plasma vortex — swirling energy rings with chromatic bloom ──
        targetCtx.globalCompositeOperation='screen';
        // Deep void background — radial black core
        const vg=targetCtx.createRadialGradient(cx,cy,0,cx,cy,D*0.5);
        vg.addColorStop(0,'rgba(0,0,0,0.95)');vg.addColorStop(0.5,'rgba(5,0,15,0.6)');vg.addColorStop(1,'rgba(0,0,0,0)');
        targetCtx.globalAlpha=ra;targetCtx.fillStyle=vg;targetCtx.fillRect(0,0,D,D);
        // Animated neon plasma rings — many arcs spinning at different speeds
        const nRings=12;
        for(let r2=0;r2<nRings;r2++){
          const ringR=D*(0.06+r2*0.035);
          const speed=rs*(0.3+r2*0.15)*(r2%2===0?1:-1);
          const offset=T2*speed+r2*0.52;
          const hue=(r2/nRings)*340+T2*rs*20;
          const arcLen=Math.PI*(0.4+0.5*(r2%3)/2);
          const brightness=0.5+0.5*Math.sin(T2*rs*2+r2);
          // Glow pass — wide dim
          targetCtx.lineWidth=4+r2*0.4;
          targetCtx.strokeStyle=`hsla(${hue},100%,${50+brightness*20}%,${ra*0.08})`;
          targetCtx.globalAlpha=1;
          targetCtx.beginPath();targetCtx.arc(cx,cy,ringR,offset,offset+arcLen);targetCtx.stroke();
          // Core pass — sharp bright
          targetCtx.lineWidth=1.2;
          targetCtx.strokeStyle=`hsla(${hue},100%,${70+brightness*25}%,${ra*0.7*brightness})`;
          targetCtx.beginPath();targetCtx.arc(cx,cy,ringR,offset,offset+arcLen);targetCtx.stroke();
        }
        // Pulsing central energy core
        const coreR=D*(0.04+0.02*Math.abs(Math.sin(T2*rs*3)));
        const cg=targetCtx.createRadialGradient(cx,cy,0,cx,cy,coreR*3);
        cg.addColorStop(0,'rgba(255,255,255,0.9)');
        cg.addColorStop(0.3,`${rc2}cc`);
        cg.addColorStop(1,'rgba(0,0,0,0)');
        targetCtx.globalAlpha=ra;targetCtx.fillStyle=cg;targetCtx.beginPath();targetCtx.arc(cx,cy,coreR*3,0,Math.PI*2);targetCtx.fill();
        // Particle sparks — tiny bright dots orbiting at random radii
        for(let sp=0;sp<20;sp++){
          const sa=(sp/20)*Math.PI*2+T2*rs*(0.4+sp*0.03);
          const sr2=D*(0.08+sp*0.018);
          const sx=cx+Math.cos(sa)*sr2,sy=cy+Math.sin(sa)*sr2;
          targetCtx.globalAlpha=ra*(0.3+0.7*Math.abs(Math.sin(T2*rs+sp)));
          targetCtx.fillStyle=`hsl(${(sp*17+T2*rs*80)%360},100%,80%)`;
          targetCtx.beginPath();targetCtx.arc(sx,sy,1+Math.random()*1.5,0,Math.PI*2);targetCtx.fill();
        }

      }else if(rm===5){
        // ── OUTRUN: Full synthwave scene — neon grid + retro sun + colour streaks ──
        targetCtx.globalCompositeOperation='screen';
        const horizon=D*0.48;
        // Sky: deep violet→black gradient
        const sky=targetCtx.createLinearGradient(0,0,0,horizon);
        sky.addColorStop(0,'rgba(10,0,30,0.9)');sky.addColorStop(1,`${rc2}33`);
        targetCtx.globalAlpha=ra;targetCtx.fillStyle=sky;targetCtx.fillRect(0,0,D,horizon);
        // Retro sun — magenta disc with sliced blinds
        const sunR2=D*0.24;const sunCY2=horizon-sunR2*0.35;
        const sunG=targetCtx.createLinearGradient(cx,sunCY2-sunR2,cx,sunCY2+sunR2);
        sunG.addColorStop(0,rc2);sunG.addColorStop(0.5,'#ff8800');sunG.addColorStop(1,'#ffee00');
        targetCtx.globalAlpha=ra;targetCtx.fillStyle=sunG;
        targetCtx.beginPath();targetCtx.arc(cx,sunCY2,sunR2,0,Math.PI*2);targetCtx.fill();
        // Sun glow halo
        const shalo=targetCtx.createRadialGradient(cx,sunCY2,sunR2*0.7,cx,sunCY2,sunR2*2.2);
        shalo.addColorStop(0,rc2+'55');shalo.addColorStop(1,'rgba(0,0,0,0)');
        targetCtx.globalAlpha=ra*0.6;targetCtx.fillStyle=shalo;targetCtx.fillRect(0,0,D,horizon);
        // Blind slices on sun — clipped to circle
        targetCtx.save();
        targetCtx.beginPath();targetCtx.arc(cx,sunCY2,sunR2,0,Math.PI*2);targetCtx.clip();
        targetCtx.fillStyle='rgba(0,0,0,1)';targetCtx.globalCompositeOperation='source-over';
        const bH=sunR2*0.15;
        for(let b=0;b<6;b++){
          const by=sunCY2+sunR2*(0.05+b*0.16);
          const anim=((T2*rs*0.12+b*0.1)%0.12)*sunR2;
          targetCtx.globalAlpha=ra;
          targetCtx.fillRect(cx-sunR2,by-anim,sunR2*2,bH);
        }
        targetCtx.restore();
        targetCtx.globalCompositeOperation='screen';
        // Floor grid
        const fl=(T2*rs*1.5)%1;
        [[3,0.1],[1,0.7]].forEach(([lw,al])=>{
          targetCtx.lineWidth=lw;
          for(let i=-10;i<=10;i++){
            const bx=cx+i*(D*0.08);
            targetCtx.globalAlpha=ra*al*(0.3+Math.abs(i)/10*0.5);
            targetCtx.strokeStyle=rc2;targetCtx.beginPath();targetCtx.moveTo(cx+(bx-cx)*0.01,horizon);targetCtx.lineTo(bx,D);targetCtx.stroke();
          }
          for(let j=0;j<10;j++){
            const p=Math.pow((j+fl)/10,1.6);
            const y2=horizon+(D-horizon)*p;const hw=(D*0.5)*p;
            targetCtx.globalAlpha=ra*al*(0.1+p*0.7);
            targetCtx.strokeStyle=rc2;targetCtx.beginPath();targetCtx.moveTo(cx-hw,y2);targetCtx.lineTo(cx+hw,y2);targetCtx.stroke();
          }
        });
        // Bright horizon pulse
        const hpulse=0.5+0.5*Math.sin(T2*rs*4);
        const hp=targetCtx.createLinearGradient(0,horizon-1,0,horizon+2);
        hp.addColorStop(0,'rgba(0,0,0,0)');hp.addColorStop(0.5,rc2);hp.addColorStop(1,'rgba(0,0,0,0)');
        targetCtx.globalAlpha=ra*hpulse;targetCtx.fillStyle=hp;targetCtx.fillRect(0,horizon-2,D,4);
        // Speed lines — neon streaks flying past
        for(let sl=0;sl<12;sl++){
          const phase=(T2*rs*(0.8+sl*0.06)+sl*0.08)%1;
          const sy2=D*(0.5+phase*0.5);
          const slen=D*(0.04+phase*0.22);
          const sx2=(sl%2===0?0:D)+(sl%2===0?phase*D*0.3:-phase*D*0.3);
          const hue2=300+sl*15;
          targetCtx.globalAlpha=ra*(1-phase)*0.7;
          targetCtx.strokeStyle=`hsl(${hue2},100%,70%)`;targetCtx.lineWidth=1.5*(1-phase);
          targetCtx.beginPath();targetCtx.moveTo(sx2,sy2);targetCtx.lineTo(sx2+(sl%2===0?slen:-slen),sy2);targetCtx.stroke();
        }
      }

      targetCtx.globalAlpha=1;targetCtx.globalCompositeOperation='source-over';
      targetCtx.restore();
    };
    // ── Apply audio mod bus (non-destructive — never mutates base state) ─────
    const mod=audModRef.current;
    const abs=lfoAbsRef.current; // LFO range-bracket absolute overrides
    // When an LFO range bracket is active, abs[tgt] holds the exact target value;
    // otherwise fall through to the additive mod-bus formula.
    const rcZ        =abs.zoom      !==undefined?abs.zoom       :rc.zoom          +(mod.zoom      ||0);
    const rcEntStr   =Math.min(1,abs.entropy   !==undefined?abs.entropy    :(rc.entropyStr  ||0)+(mod.entropy  ||0));
    const rcFluxAmp  =Math.min(1,abs.fluxAmp   !==undefined?abs.fluxAmp    :(rc.fluxAmp     ||0)+(mod.flux     ||0));
    const rcChromaAmt=Math.min(1,abs.chroma    !==undefined?abs.chroma     :(rc.chromaAmt   ||0)+(mod.chroma   ||0));
    const rcGlyphStr =Math.min(1,abs.glyphPull !==undefined?abs.glyphPull  :(rc.textStrength||0)+(mod.glyph    ||0));
    const rcVigAmt   =Math.min(1,abs.vignette  !==undefined?abs.vignette   :(rc.vignetteAmt ||0)+(mod.vignette ||0));
    const rcAlchMod  =Math.min(1,abs.prismatic !==undefined?abs.prismatic  :(rc.alchMod     ||0)+(mod.prismatic||0));
    const rcRotSpd   =Math.min(1,abs.rotation  !==undefined?abs.rotation   :(rc.rotationSpeed||0.5)+(mod.rotation||0));
    const rcSmokeStr =Math.min(0.99,abs.smoke  !==undefined?abs.smoke      :(rc.smokeStrength||0)+(mod.smoke||0)+(mod.trails||0)*0.3);
    const rcSymPhase =(mod.symPhase||0);
    // Warp / Field / Glitch / Retro mod bus
    const rcWarpAmt  =Math.min(1,abs.warpAmt  !==undefined?abs.warpAmt   :(rc.warpAmt  ||0)+(mod.warpAmt  ||0));
    const rcFieldAmt =Math.min(1,abs.fieldAmt !==undefined?abs.fieldAmt  :(rc.fieldAmt ||0)+(mod.fieldAmt ||0));
    const rcGlitchAmt=Math.min(1,abs.glitchAmt!==undefined?abs.glitchAmt :(rc.glitchAmt||0)+(mod.glitchAmt||0));
    const rcRetroAmt =Math.min(1,abs.retroAmt !==undefined?abs.retroAmt  :(rc.retroAmt ||0)+(mod.retroAmt ||0));
    // Modulated duration: mod.speed shrinks morph time (speeds it up)
    const rcDuration =Math.max(200,(rc.duration||3000)*(1-Math.min(0.8,mod.speed||0)));
    const drawP=Math.max(0,Math.min(1,p));
    const isAtBoundary=drawP<=0||drawP>=1;
    const density=isAtBoundary?1:rc.particleDensity;
    const pxSize=isAtBoundary?1:rc.pointSize;
    const ease=!rc.easingEnabled?drawP:drawP*drawP*(3-2*drawP);
    const midFactor=Math.sin(ease*Math.PI);
    const t=timeRef.current;
    const doStats=(frameCountRef.current%20)===0;

    // Prismatic LFO env
    const doAlch=rc.isAlch;const aType=rc.alchType;const aMod=rcAlchMod;const aBst=rc.boost;
    const gridSize=doAlch&&aType===1?Math.max(2,2+aMod*14):1;
    const gridOffX=doAlch&&aType===1?Math.sin(t*0.4)*gridSize*0.5:0;
    const gridOffY=doAlch&&aType===1?Math.cos(t*0.3)*gridSize*0.5:0;
    let alchEnv=1.0;
    if(rc.alchTimeline==='morph')alchEnv=Math.max(0.05,midFactor);
    else if(rc.alchTimeline==='free'){const ph=alchPhaseRef.current;if(rc.alchShape===0)alchEnv=Math.sin(ph)*.5+.5;else if(rc.alchShape===1)alchEnv=1-Math.abs(((ph/Math.PI)%2)-1);else alchEnv=(ph%(Math.PI*2))<Math.PI?1:0;}

    // Glyph LFO — separate phase accumulators approximated from shared phase + rate ratio
    const glPhPull=glyphLfoPhaseRef.current*(rc.glyphLfoPull?1:0);
    const glPhAmp=glyphLfoPhaseRef.current*(rc.glyphLfoAmp?1:0);
    let glLfoPull=1.0,glLfoAmp=1.0;
    if(rc.glyphLfoEnabled){
      const sh=rc.glyphLfoShape;
      const evalLfo=(ph)=>{if(sh===0)return Math.sin(ph)*.5+.5;else if(sh===1)return 1-Math.abs(((ph/Math.PI)%2)-1);else return(ph%(Math.PI*2))<Math.PI?1:0;};
      if(rc.glyphLfoPull)glLfoPull=evalLfo(glyphLfoPullPhaseRef.current);
      if(rc.glyphLfoAmp)glLfoAmp=evalLfo(glyphLfoAmpPhaseRef.current);
    }
    const effectivePull=rc.isText?(rcGlyphStr*(rc.glyphLfoEnabled&&rc.glyphLfoPull?1-rc.glyphLfoDepthPull+glLfoPull*rc.glyphLfoDepthPull*2:1)):0;
    const effectiveAmp=rc.textMotionAmp*(rc.glyphLfoEnabled&&rc.glyphLfoAmp?glLfoAmp:1);

    if(!imgDataRef.current){imgDataRef.current=rCtx.createImageData(DIMENSION,DIMENSION);bufRef.current=new Uint32Array(imgDataRef.current.data.buffer);}
    const buf=bufRef.current;buf.fill(0xFF000000);
    const pixels=pixelsRef.current;
    // Smooth probabilistic density: each pixel has density% chance to render.
    // This avoids the coarse integer-step staircase of Math.round(1/density).
    // At density=1 every pixel renders; at density=0.5 roughly half render, evenly distributed.
    const useProbDensity=density<1;
    let sumR=0,sumG=0,sumB=0,sumCount=0;

    const _doText=rc.isText;
    if(_doText&&textMaskDirtyRef.current){
      // Use textMaskPhraseRef so Apply is instant (setTextPhrase is async)
      const newMask=buildTextMask(textMaskPhraseRef.current||textPhrase, {fontSize:rc.glyphFontSize,spacing:rc.glyphSpacing,outline:rc.glyphOutline});
      if(rc.glyphApplyTime>0&&textMaskRef.current){
        // Gradual transition: keep old mask, set next, reset progress
        textMaskNextRef.current=newMask;
        glyphTransitionRef.current=0;
      } else {
        textMaskRef.current=newMask;
        textMaskNextRef.current=null;
        glyphTransitionRef.current=1;
      }
      textMaskDirtyRef.current=false;
    }
    // Advance transition
    if(textMaskNextRef.current&&glyphTransitionRef.current<1){
      const speed=rc.glyphApplyTime>0?(1/(rc.glyphApplyTime*60)):1;
      glyphTransitionRef.current=Math.min(1,glyphTransitionRef.current+speed);
      if(glyphTransitionRef.current>=1){textMaskRef.current=textMaskNextRef.current;textMaskNextRef.current=null;}
    }
    const _textMask=_doText?textMaskRef.current:null;
    const _textMaskNext=_doText?textMaskNextRef.current:null;
    const _tBlend=glyphTransitionRef.current;

    for(let i=0;i<pixels.length;i++){
      if(useProbDensity&&Math.random()>density)continue;
      const px=pixels[i];
      let curX=px.x+(px.tx-px.x)*ease+px.driftX;
      let curY=px.y+(px.ty-px.y)*ease+px.driftY;

      // Glyph
      if(_doText&&_textMask&&_textMask.length>0){
        const target=_textMask[i%_textMask.length];
        let tX=target.x,tY=target.y;
        // Blend toward next mask if transitioning
        if(_textMaskNext&&_textMaskNext.length>0&&_tBlend<1){
          const nt=_textMaskNext[i%_textMaskNext.length];
          tX=tX+(nt.x-tX)*_tBlend;tY=tY+(nt.y-tY)*_tBlend;
        }
        const mo=rc.textMotion;
        if(mo===1){const s=1+Math.sin(t*2)*effectiveAmp*0.3;tX=DIMENSION/2+(tX-DIMENSION/2)*s;tY=DIMENSION/2+(tY-DIMENSION/2)*s;}
        else if(mo===2){tX+=Math.sin(tY*0.1+t*3)*effectiveAmp*20;tY+=Math.cos(tX*0.08+t*2)*effectiveAmp*8;}
        else if(mo===3){tX+=Math.sin(t*7+i*0.03)*effectiveAmp*25;tY+=Math.cos(t*5+i*0.02)*effectiveAmp*25;}
        else if(mo===4){tX+=Math.cos(t*2+i*0.01)*effectiveAmp*18;tY+=Math.sin(t*2+i*0.01)*effectiveAmp*18;}
        curX=curX+(tX-curX)*effectivePull;curY=curY+(tY-curY)*effectivePull;
      }

      // Positional Prismatic
      if(doAlch&&aType===1){const str=aMod*alchEnv*(aBst?1.0:0.7);const snX=Math.round((curX-gridOffX)/gridSize)*gridSize+gridOffX;const snY=Math.round((curY-gridOffY)/gridSize)*gridSize+gridOffY;curX+=(snX-curX)*str;curY+=(snY-curY)*str;}
      if(doAlch&&aType===5){const warp=12*aMod*(aBst?3:1)*alchEnv;curX+=Math.cos(curY*0.05+t*aMod*6)*warp*alchEnv;curY+=Math.sin(curX*0.05+t*aMod*6)*warp*alchEnv;}
      if(doAlch&&aType===2&&Math.random()<0.05*aMod*alchEnv)curX+=(Math.random()-.5)*80*(aBst?2:1);

      // Flux
      if(rc.isFlux){
        let fEnv;
        if(rc.fluxTimeline==='morph')fEnv=Math.max(0.05,midFactor);
        else if(rc.fluxTimeline==='steady')fEnv=1.0;
        else{const ph=fluxPhaseRef.current;if(rc.fluxShape===0)fEnv=Math.sin(ph)*.5+.5;else if(rc.fluxShape===1)fEnv=1-Math.abs(((ph/Math.PI)%2)-1);else fEnv=(ph%(Math.PI*2))<Math.PI?1:0;}
        const mag=rcFluxAmp*fEnv*80;const fm=rc.fluxMode;
        if(fm===0){curX+=Math.sin(curY*0.05+t*2)*mag;curY+=Math.cos(curX*0.05+t*2)*mag;}
        else if(fm===1){const cx=curX-DIMENSION/2,cy=curY-DIMENSION/2;const ang=Math.atan2(cy,cx);const rad=Math.sqrt(cx*cx+cy*cy);const spin=mag*0.03*(1-Math.min(1,rad/200));curX+=-Math.sin(ang+spin)*spin*8;curY+=Math.cos(ang+spin)*spin*8;}
        else if(fm===2){const cx=curX-DIMENSION/2,cy=curY-DIMENSION/2;const dist=Math.sqrt(cx*cx+cy*cy)||1;curX-=(cx/dist)*mag*0.6*(1-dist/250);curY-=(cy/dist)*mag*0.6*(1-dist/250);}
        else if(fm===3){const band=Math.floor(curY/20);curX+=Math.sin(band*1.3+t*3)*mag*0.7;curY+=Math.cos(curX*0.03+t)*mag*0.3;}
        else if(fm===4){const nx=curX*0.02,ny=curY*0.02;curX+=(Math.sin(nx*3.1+t*1.7)*.5+Math.sin(nx*7.3+ny*2.1+t)*.3+Math.sin(ny*5.2+t*2.3)*.2)*mag;curY+=(Math.cos(ny*2.8+t*1.3)*.5+Math.cos(nx*4.1+ny*6.3+t*.9)*.3+Math.cos(nx*3.7+t*1.8)*.2)*mag;}
        else if(fm===5){const cx=curX-DIMENSION/2,cy=curY-DIMENSION/2;const rad=Math.sqrt(cx*cx+cy*cy);const ang=Math.atan2(cy,cx);const twist=mag*0.02*(1-Math.min(1,rad/200));curX=DIMENSION/2+Math.cos(ang+twist)*rad;curY=DIMENSION/2+Math.sin(ang+twist)*rad;}
        else if(fm===6){const bs=10+(1-rc.fluxAmp)*60;const gX=Math.floor(curX/bs),gY=Math.floor(curY/bs);const seed=gX*137+gY*313+Math.floor(t*2);curX+=(Math.sin(seed)-.5)*mag;curY+=(Math.cos(seed*1.618)-.5)*mag;}
        else if(fm===7){const cx=curX-DIMENSION/2,cy=curY-DIMENSION/2;const dist=Math.sqrt(cx*cx+cy*cy);const ripple=Math.sin(dist*0.1-t*5)*mag*0.5;const angle=Math.atan2(cy,cx);curX+=Math.cos(angle)*ripple;curY+=Math.sin(angle)*ripple;}
      }

      // Field — velocity field: each mode assigns a flow direction at particle position
      if(rc.isField){
        const fMag=rcFieldAmt*60;
        const fm2=rc.fieldMode||0;
        const fwx=(rc.fieldX||0.5)*DIMENSION, fwy=(rc.fieldY||0.5)*DIMENSION;
        const fcx=curX-fwx, fcy=curY-fwy;
        const fdist=Math.sqrt(fcx*fcx+fcy*fcy)||1;
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
          for(let pi=0;pi<4;pi++){
            const ang=ph+pi*Math.PI*0.5;
            const px=fwx+Math.cos(ang)*sep,py=fwy+Math.sin(ang)*sep;
            const dx=curX-px,dy=curY-py;
            const d=Math.sqrt(dx*dx+dy*dy)+soft;
            const sign=(pi%2===0)?1:-1;
            sumFx+=sign*dx/d;sumFy+=sign*dy/d;
          }
          const th=Math.atan2(sumFy,sumFx)+Math.sin(t*0.25)*0.3;
          curX+=Math.cos(th)*fMag*0.12;curY+=Math.sin(th)*fMag*0.12;
        }
      }

      let r=(px.r+(px.tr-px.r)*ease)|0,g=(px.g+(px.tg-px.g)*ease)|0,b=(px.b+(px.tb-px.b)*ease)|0;
      if(doAlch){
        if(aType===0){const luma=(r*.299+g*.587+b*.114)/255;if(luma>0.45+Math.sin(t)*.1){r=255;g=(180+alchEnv*75)|0;b=(alchEnv*60)|0;}else if(luma<0.2){r=35;g=35;b=35;}}
        if(aType===1){const cX=(curX/gridSize+.5)|0,cY=(curY/gridSize+.5)|0;const h=(cX*73+cY*137)%255;const ta=aMod*.3*alchEnv*(aBst?2:1);r=Math.min(255,Math.max(0,r+(h%80-40)*ta))|0;g=Math.min(255,Math.max(0,g+((h*3)%80-40)*ta))|0;b=Math.min(255,Math.max(0,b+((h*7)%80-40)*ta))|0;}
        if(aType===2){if(Math.random()<(0.1+aMod*0.35)*alchEnv){if(Math.random()>.5){r=(Math.random()*255)|0;g=(Math.random()*255)|0;b=(Math.random()*255)|0;}else{r=0;g=0;b=0;}}}
        if(aType===3){const luma=(r*.299+g*.587+b*.114)/255;if(luma>(0.3+alchEnv*.4)){r=((255-r)*.5+127*alchEnv)|0;g=((255-g)*.8+50)|0;b=255;}}
        if(aType===4){const hue=(i*.005+t*aMod*4)%(Math.PI*2);const mix=(.4+alchEnv*.5)*alchEnv*(aBst?1.0:.7);r=(r*(1-mix)+(Math.sin(hue)*127+128)*mix)|0;g=(g*(1-mix)+(Math.sin(hue+2.1)*127+128)*mix)|0;b=(b*(1-mix)+(Math.sin(hue+4.2)*127+128)*mix)|0;}
      }
      r=r<0?0:r>255?255:r;g=g<0?0:g>255?255:g;b=b<0?0:b>255?255:b;
      // Glyph color mode: only modifies pixels that are within text mask target
      if(_doText&&rc.glyphColorMode&&rc.glyphColorMode!=='white'){
        const inGlyph=textMaskRef.current&&textMaskRef.current.some?false:false; // lightweight: apply globally
        if(rc.glyphColorMode==='invert'){r=255-r;g=255-g;b=255-b;}
        // 'source' mode: colors come from source image naturally, no transform needed
      }
      if(doStats){sumR+=r;sumG+=g;sumB+=b;sumCount++;}
      const bX=(curX+.5)|0,bY=(curY+.5)|0;
      if(bX>=0&&bX<DIMENSION&&bY>=0&&bY<DIMENSION){
        const color=(255<<24)|(b<<16)|(g<<8)|r;
        for(let ox=0;ox<pxSize;ox++)for(let oy=0;oy<pxSize;oy++)if(bX+ox<DIMENSION&&bY+oy<DIMENSION)buf[(bY+oy)*DIMENSION+(bX+ox)]=color;
      }
    }
    rCtx.putImageData(imgDataRef.current,0,0);

    if(!isAtBoundary){
      if(rc.trailsEnabled&&rc.trailPre){rCtx.save();rCtx.globalCompositeOperation='screen';rCtx.globalAlpha=rc.trailStrength*0.4;rCtx.drawImage(preSnapRawRef.current,0,0);rCtx.restore();}
      if(rc.smokeEnabled&&rc.smokePre){rCtx.save();rCtx.globalCompositeOperation='screen';rCtx.globalAlpha=rcSmokeStr*0.4;rCtx.drawImage(preSnapRawRef.current,0,-(rc.smokeRise*6));rCtx.restore();}
    }

    // ── PRE-SYM EFFECTS: Warp, Glitch, Retro — run on rawCanvas before symmetry reads it ──
    if(!isAtBoundary){
      const D2=DIMENSION;
      // Ensure scratch canvas exists
      if(!postEffectTempRef.current){postEffectTempRef.current=document.createElement('canvas');postEffectTempRef.current.width=D2;postEffectTempRef.current.height=D2;}
      const scratchTmp=postEffectTempRef.current;
      const scratchCtx=scratchTmp.getContext('2d',{willReadFrequently:true});

      // ── Warp: spatial lens distortion on rawCanvas ──────────────────────
      if(rc.isWarp){
        scratchCtx.drawImage(rawCanvasRef.current,0,0);
        const src2=scratchCtx.getImageData(0,0,D2,D2);const sd=src2.data;
        const dst=rCtx.createImageData(D2,D2);const dd=dst.data;
        const wm=rc.warpMode||0;const wa=rcWarpAmt;const T2=timeRef.current;
        const cx2=D2/2,cy2=D2/2;
        for(let y=0;y<D2;y++)for(let x=0;x<D2;x++){
          const dx=(x-cx2)/cx2,dy=(y-cy2)/cy2; // -1..1
          const dist2=Math.sqrt(dx*dx+dy*dy);
          let sx=x,sy=y;
          if(wm===0){// Bulge — barrel lens outward
            const r2=dist2;const k=wa*0.7;const bfact=1+k*r2*r2;
            sx=cx2+dx*cx2/bfact;sy=cy2+dy*cy2/bfact;
          }else if(wm===1){// Pinch — reverse barrel inward
            const r2=dist2;const k=wa*0.6;const bfact=1-k*r2*r2;
            sx=cx2+dx*cx2*bfact;sy=cy2+dy*cy2*bfact;
          }else if(wm===2){// Ripple — concentric sine rings
            if(dist2>0.01){const ripple=Math.sin(dist2*12-T2*3)*wa*18;sx=x+dx/dist2*ripple;sy=y+dy/dist2*ripple;}
          }else if(wm===3){// Twist — rotation gradient from centre
            const ang=Math.atan2(dy,dx);const twist=wa*Math.PI*(1-Math.min(1,dist2));
            sx=cx2+Math.cos(ang+twist)*dist2*cx2;sy=cy2+Math.sin(ang+twist)*dist2*cy2;
          }else if(wm===4){// Mirror Fold — fold left half onto right
            sx=x<cx2?(cx2+(cx2-x)):x;
          }else if(wm===5){// Kaleid Seed — rotate+flip into one segment and tile
            const ang=Math.atan2(dy,dx);const seg=Math.PI/3;
            const a2=((ang%(seg*2))+seg*2)%(seg*2);const foldedA=a2>seg?seg*2-a2:a2;
            sx=cx2+Math.cos(foldedA)*dist2*cx2;sy=cy2+Math.sin(foldedA)*dist2*cy2;
          }
          const ix=Math.max(0,Math.min(D2-1,Math.round(sx)));
          const iy=Math.max(0,Math.min(D2-1,Math.round(sy)));
          const si=(iy*D2+ix)*4;const di=(y*D2+x)*4;
          dd[di]=sd[si];dd[di+1]=sd[si+1];dd[di+2]=sd[si+2];dd[di+3]=sd[si+3];
        }
        rCtx.putImageData(dst,0,0);
      }

      // ── Glitch: per-mode disruption on rawCanvas ─────────────────────────
      if(rc.isGlitch){
        const amt=rcGlitchAmt;const gm=rc.glitchMode||0;const T2=timeRef.current;
        scratchCtx.drawImage(rawCanvasRef.current,0,0);
        const id2=scratchCtx.getImageData(0,0,D2,D2);const d=id2.data;
        if(gm===0){// Slice
          const bands=Math.round(4+amt*12);const bh=Math.ceil(D2/bands);
          for(let b=0;b<bands;b++){
            if(Math.random()<amt*0.6){
              const shift=Math.round((Math.random()-0.5)*amt*60);
              rCtx.drawImage(scratchTmp,0,b*bh,D2,bh,shift,b*bh,D2,bh);
            }
          }
        }else if(gm===1){// Databend
          const out=new Uint8ClampedArray(d.length);for(let j=0;j<d.length;j++)out[j]=d[j];
          const shift=Math.round(amt*30);
          for(let j=0;j<d.length;j+=4){out[j]=d[Math.min(d.length-4,j+shift*4)];out[j+2]=d[Math.max(0,j-shift*4)+2];}
          const od=rCtx.createImageData(D2,D2);od.data.set(out);rCtx.putImageData(od,0,0);
        }else if(gm===2){// Pixel sort
          const sortW=Math.round(D2*amt*0.3);
          for(let x=0;x<sortW;x+=2){
            const col=x%D2;const pixels2=[];
            for(let y=0;y<D2;y++){const j=(y*D2+col)*4;pixels2.push({r:d[j],g:d[j+1],b:d[j+2],luma:d[j]*.299+d[j+1]*.587+d[j+2]*.114});}
            pixels2.sort((a2,b2)=>a2.luma-b2.luma);
            pixels2.forEach((p,y)=>{const j=(y*D2+col)*4;d[j]=p.r;d[j+1]=p.g;d[j+2]=p.b;});
          }
          scratchCtx.putImageData(id2,0,0);rCtx.drawImage(scratchTmp,0,0);
        }else if(gm===3){// Scan Tear
          const tearCount=Math.round(2+amt*8);
          for(let j=0;j<tearCount;j++){
            const y=Math.round(Math.sin(T2*3.1+j*1.7)*D2*0.4+D2*0.5);
            const h2=Math.round(1+amt*4);const shift=Math.round(Math.sin(T2*5+j)*amt*80);
            rCtx.drawImage(scratchTmp,0,y,D2,h2,shift,y,D2,h2);
          }
        }else if(gm===4){// Corrupt
          const blocks=Math.round(amt*20);
          for(let j=0;j<blocks;j++){
            const sx=Math.round(Math.random()*D2),sy=Math.round(Math.random()*D2);
            const sw=Math.round(10+Math.random()*60),sh=Math.round(4+Math.random()*20);
            const dx=Math.round(Math.random()*D2),dy=Math.round(Math.random()*D2);
            rCtx.drawImage(scratchTmp,sx%D2,sy%D2,Math.min(sw,D2-sx%D2),Math.min(sh,D2-sy%D2),dx%D2,dy%D2,Math.min(sw,D2-dx%D2),Math.min(sh,D2-dy%D2));
          }
        }else if(gm===5){// VHS
          const bleed=Math.round(amt*12);const out=new Uint8ClampedArray(d.length);for(let j=0;j<d.length;j++)out[j]=d[j];
          for(let y=0;y<D2;y++)for(let x=0;x<D2;x++){
            const j=(y*D2+x)*4;
            out[j]=d[(y*D2+Math.min(D2-1,x+bleed))*4];out[j+2]=d[(y*D2+Math.max(0,x-bleed))*4+2];
            if(Math.random()<0.02*amt){out[j]=out[j+1]=out[j+2]=Math.round(Math.random()*255);}
          }
          const barY2=Math.round((T2*80)%D2);for(let x=0;x<D2;x++){const j=(barY2*D2+x)*4;out[j]=out[j+1]=out[j+2]=200;}
          const od2=rCtx.createImageData(D2,D2);od2.data.set(out);rCtx.putImageData(od2,0,0);
        }
      }
      if(rc.isRetro&&(rc.retroLayer===undefined||rc.retroLayer===1))applyRetro(rCtx,D2);

    }


    // ── ASCII Art: character overlay (pre-sym or post-sym depending on bypassSym) ──
    const applyAsciiArt=(targetCtx,W)=>{
      if(!rc.isAscii||isAtBoundary)return;
      const cellPx=Math.max(4,Math.round(4+rc.asciiSize*20));
      const amt2=rc.asciiAmt;
      const cols=Math.floor(W/cellPx);const rows=Math.floor(W/cellPx);
      const T3=timeRef.current;
      const mode=rc.asciiMode||0;
      let srcData=null;
      try{srcData=targetCtx.getImageData(0,0,W,W).data;}catch(e){}
      const getLuma=(x,y)=>{
        if(!srcData)return 0;
        const xi=Math.min(W-1,Math.max(0,Math.round(x))),yi=Math.min(W-1,Math.max(0,Math.round(y)));
        const i=(yi*W+xi)*4;return(srcData[i]*.299+srcData[i+1]*.587+srcData[i+2]*.114)/255;
      };
      const getCol=(x,y)=>{
        if(rc.asciiColorMode==='fixed')return rc.asciiColor||'#84cc16';
        if(!srcData)return '#84cc16';
        const xi=Math.min(W-1,Math.max(0,Math.round(x))),yi=Math.min(W-1,Math.max(0,Math.round(y)));
        const i=(yi*W+xi)*4;
        if(rc.asciiColorMode==='invert')return`rgb(${255-srcData[i]},${255-srcData[i+1]},${255-srcData[i+2]})`;
        return`rgb(${srcData[i]},${srcData[i+1]},${srcData[i+2]})`;
      };
      const BRAILLE=['⠀','⠄','⠆','⠇','⡇','⣇','⣧','⣿'];
      const BLOCK=[' ','░','▒','▓','█'];
      const MATRIX_CHARS='アイウエオカキクケコサシスセソタチツテトナニヌネノ0123456789ABCDEF';
      const MORSE=[' ','·','-','·-','-·','·-·','-·-'];
      const CIRCUIT=['·','─','│','┼','╋','┤','├','┬','┴','╬'];
      const RUNES=['ᚠ','ᚢ','ᚦ','ᚨ','ᚱ','ᚲ','ᚷ','ᚹ','ᚺ','ᚾ','ᛁ','ᛃ','ᛇ','ᛈ','ᛉ','ᛊ','ᛏ','ᛒ','ᛖ','ᛗ','ᛚ','ᛜ','ᛞ','ᛟ'];
      const NOISE=['╱','╲','│','─','·','○','×','◦'];
      const aOff=document.createElement('canvas');aOff.width=W;aOff.height=W;
      const aCtx=aOff.getContext('2d',{willReadFrequently:true});
      aCtx.clearRect(0,0,W,W);aCtx.textBaseline='middle';aCtx.textAlign='center';
      const fs=Math.max(cellPx-1,4);aCtx.font=`900 ${fs}px monospace`;
      for(let row=0;row<rows;row++){
        for(let col=0;col<cols;col++){
          const cx4=col*cellPx+cellPx/2,cy4=row*cellPx+cellPx/2;
          const luma=getLuma(cx4,cy4);
          if(luma<0.015&&mode!==2)continue;
          const color4=getCol(cx4,cy4);
          let ch='';
          if(mode===0){const bi=Math.min(BRAILLE.length-1,Math.floor(luma*BRAILLE.length));ch=BRAILLE[bi];}
          else if(mode===1){const bi=Math.min(BLOCK.length-1,Math.floor(luma*BLOCK.length));ch=BLOCK[bi];}
          else if(mode===2){
            const seed=Math.abs((col*17+row*31+Math.floor(T3*(3+luma*8)))%MATRIX_CHARS.length);
            ch=MATRIX_CHARS[seed];
            aCtx.globalAlpha=amt2*(0.3+luma*0.7);
            aCtx.fillStyle=luma>0.5?'#86efac':luma>0.2?color4:'#166534';
            aCtx.fillText(ch,cx4,cy4);aCtx.globalAlpha=1;continue;
          }
          else if(mode===3){
            const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()';
            const seed2=Math.abs((col*13+row*7+Math.floor(T3*2+luma*5))%chars.length);
            ch=chars[seed2];
            const bx=Math.sin(col*3.7+T3)*1.2*amt2,by=Math.cos(row*2.9+T3)*1.2*amt2;
            aCtx.globalAlpha=amt2*(0.4+luma*0.6);aCtx.fillStyle=color4;
            aCtx.fillText(ch,cx4+bx,cy4+by);
            if(luma>0.6){aCtx.globalAlpha=amt2*0.25;aCtx.fillText(ch,cx4+bx+1,cy4+by+1);}
            aCtx.globalAlpha=1;continue;
          }
          else if(mode===4){const mi=Math.min(MORSE.length-1,Math.floor(luma*MORSE.length));ch=MORSE[mi];}
          else if(mode===5){
            const lumaR=getLuma(cx4+cellPx,cy4),lumaD=getLuma(cx4,cy4+cellPx);
            const dx2=Math.abs(lumaR-luma),dy2=Math.abs(lumaD-luma);
            const ci=(dx2>0.1&&dy2>0.1)?3:dx2>0.05?1:dy2>0.05?2:luma>0.7?4:luma>0.4?0:9;
            ch=CIRCUIT[Math.min(CIRCUIT.length-1,ci)];
          }
          else if(mode===6){
            const ri=Math.abs(Math.floor(((luma+T3*0.1+col*0.05+row*0.03)%1)*RUNES.length))%RUNES.length;
            ch=RUNES[ri];
          }
          else{
            const lumaR=getLuma(cx4+cellPx,cy4),lumaD=getLuma(cx4,cy4+cellPx);
            const ang=Math.atan2(lumaD-luma,lumaR-luma);
            const ni=Math.abs(Math.round(((ang+Math.PI)/(Math.PI*2))*NOISE.length))%NOISE.length;
            ch=NOISE[ni];
          }
          aCtx.globalAlpha=amt2*(0.25+luma*0.75);aCtx.fillStyle=color4;
          aCtx.fillText(ch,cx4,cy4);aCtx.globalAlpha=1;
        }
      }
      targetCtx.save();targetCtx.globalCompositeOperation='screen';targetCtx.drawImage(aOff,0,0);targetCtx.restore();
    };

    // ASCII pre-sym
    if(!rc.asciiBypassSym)applyAsciiArt(rCtx,DIMENSION);

    // Symmetry
    const offCtx=ensureCanvas(postProcessCanvasRef);
    offCtx.fillStyle=rc.canvasBg||'#000000';offCtx.fillRect(0,0,DIMENSION,DIMENSION);
    if(rc.isSymmetry){
      const s=rc.symmetryType;
      const cx=DIMENSION/2,cy=DIMENSION/2;
      const axisAngle=(rc.symAnimAxes?symAnimAngleRef.current:0)+rcSymPhase;
      const flip=rc.symMirrorInner;
      offCtx.globalCompositeOperation='source-over';

      // Helper: draw rawCanvas centered, with optional pre-rotation
      const stamp=(ctx,rot=0,sx=1,sy=1)=>{
        ctx.save();ctx.translate(cx,cy);
        if((rc.isRotation&&!isAtBoundary)||Math.abs(rotationAngleRef.current)>0.0001)ctx.rotate(rotationAngleRef.current);
        ctx.rotate(axisAngle+rot);
        if(rcZ!==1.0)ctx.scale(rcZ,rcZ);
        ctx.scale(sx,sy);
        ctx.drawImage(rawCanvasRef.current,-cx,-cy);
        ctx.restore();
      };

      if(s===1){
        // X mirror: left half from source, right half is horizontal flip
        offCtx.save();offCtx.beginPath();offCtx.rect(0,0,cx,DIMENSION);offCtx.clip();stamp(offCtx);offCtx.restore();
        offCtx.save();offCtx.beginPath();offCtx.rect(cx,0,cx,DIMENSION);offCtx.clip();stamp(offCtx,0,-1,1);offCtx.restore();
      } else if(s===2){
        // Y mirror: top half from source, bottom half is vertical flip
        offCtx.save();offCtx.beginPath();offCtx.rect(0,0,DIMENSION,cy);offCtx.clip();stamp(offCtx);offCtx.restore();
        offCtx.save();offCtx.beginPath();offCtx.rect(0,cy,DIMENSION,cy);offCtx.clip();stamp(offCtx,0,1,-1);offCtx.restore();
      } else if(s===3){
        // Tri: 3 pie segments each rotated 120°, alternating flip
        const ts=Math.PI*2/3;
        for(let ii=0;ii<3;ii++){
          offCtx.save();offCtx.translate(cx,cy);offCtx.rotate(ii*ts);
          offCtx.beginPath();offCtx.moveTo(0,0);offCtx.arc(0,0,DIMENSION*1.5,-ts/2-.01,ts/2+.01);offCtx.closePath();offCtx.clip();
          offCtx.rotate(-ii*ts);// undo the outer rotate so stamp adds its own
          offCtx.restore();
          // stamp into the clipped region
          offCtx.save();offCtx.translate(cx,cy);offCtx.rotate(ii*ts);
          offCtx.beginPath();offCtx.moveTo(0,0);offCtx.arc(0,0,DIMENSION*1.5,-ts/2-.01,ts/2+.01);offCtx.closePath();offCtx.clip();
          if((rc.isRotation&&!isAtBoundary)||Math.abs(rotationAngleRef.current)>0.0001)offCtx.rotate(rotationAngleRef.current);
          offCtx.rotate(axisAngle);
          if(flip&&ii%2===1)offCtx.scale(-1,1);
          if(rcZ!==1.0)offCtx.scale(rcZ,rcZ);
          offCtx.drawImage(rawCanvasRef.current,-cx,-cy);
          offCtx.restore();
        }
      } else if(s===4){
        // Quad: true 4-quadrant mirror — top-left is canonical, others are reflections
        // Each quadrant gets the image scaled to half-size, mirrored at the axes
        const hw=DIMENSION/2,hh=DIMENSION/2;
        [{rx:0,ry:0,sx:1,sy:1},{rx:hw,ry:0,sx:-1,sy:1},{rx:0,ry:hh,sx:1,sy:-1},{rx:hw,ry:hh,sx:-1,sy:-1}].forEach(({rx,ry,sx,sy})=>{
          offCtx.save();
          offCtx.beginPath();offCtx.rect(rx,ry,hw,hh);offCtx.clip();
          offCtx.translate(rx+hw/2,ry+hh/2);
          if((rc.isRotation&&!isAtBoundary)||Math.abs(rotationAngleRef.current)>0.0001)offCtx.rotate(rotationAngleRef.current);
          offCtx.rotate(axisAngle);
          offCtx.scale(sx*0.5*(rcZ||1),sy*0.5*(rcZ||1));
          offCtx.drawImage(rawCanvasRef.current,-cx,-cy);
          offCtx.restore();
        });
      } else if(s>=5&&s<=8){
        // Kaleidoscope: s=5→K3(6-pt), s=6→K6(12-pt), s=7→K8(16-pt), s=8→K12(24-pt)
        const sides=[6,12,16,24][s-5];
        const slice=(Math.PI*2)/sides;
        const segBlend=rc.symBlend||'source-over';
        const segAlpha=rc.symOpacity!==undefined?rc.symOpacity:1;
        for(let ii=0;ii<sides;ii++){
          offCtx.save();offCtx.translate(cx,cy);offCtx.rotate(ii*slice+axisAngle);
          if(flip&&ii%2===1)offCtx.scale(1,-1);
          offCtx.beginPath();offCtx.moveTo(0,0);offCtx.arc(0,0,DIMENSION,-slice/2-.01,slice/2+.01);offCtx.closePath();offCtx.clip();
          offCtx.globalCompositeOperation=segBlend;
          offCtx.globalAlpha=segAlpha;
          if((rc.isRotation&&!isAtBoundary)||Math.abs(rotationAngleRef.current)>0.0001)offCtx.rotate(rotationAngleRef.current);
          if(rcZ!==1.0)offCtx.scale(rcZ,rcZ);
          offCtx.drawImage(rawCanvasRef.current,-cx,-cy);
          offCtx.restore();
        }
        offCtx.globalCompositeOperation='source-over';offCtx.globalAlpha=1;
      } else if(s===9){
        // Fan/Pinwheel: N rotated copies, screen-blended. Amt controls blade count + opacity
        const blades=flip?8:5;
        const step=Math.PI*2/blades;
        const amt=rc.symCreativeAmt;
        offCtx.globalCompositeOperation='screen';
        offCtx.globalAlpha=0.3+amt*0.6; // amt: dim/transparent → bright/opaque
        for(let ii=0;ii<blades;ii++)stamp(offCtx,ii*step+(amt*0.4)); // amt rotates the phase offset
        offCtx.globalAlpha=1.0;offCtx.globalCompositeOperation='source-over';
      } else if(s===10){
        // Radial wedges: amt controls gap between wedges (tight → spread)
        const spokes=flip?12:6;
        const step=Math.PI*2/spokes;
        const amt=rc.symCreativeAmt;
        const gap=amt*0.18; // how much to shrink each wedge's angular span
        for(let ii=0;ii<spokes;ii++){
          offCtx.save();offCtx.translate(cx,cy);offCtx.rotate(ii*step+axisAngle);
          offCtx.beginPath();offCtx.moveTo(0,0);offCtx.arc(0,0,DIMENSION*1.5,-step/2+gap,step/2-gap);offCtx.closePath();offCtx.clip();
          if((rc.isRotation&&!isAtBoundary)||Math.abs(rotationAngleRef.current)>0.0001)offCtx.rotate(rotationAngleRef.current);
          if(rcZ!==1.0)offCtx.scale(rcZ,rcZ);
          offCtx.drawImage(rawCanvasRef.current,-cx,-cy);offCtx.restore();
        }
      } else if(s===11){
        // Tile2 (flip=off): left copy + right mirrored copy, full height
        // Tile4 (flip=on): 2×2 grid, each quadrant is a scaled-down copy
        if(!flip){
          // Tile2: two equal-width halves side-by-side. Left=normal, Right=h-flipped.
          // symCreativeAmt zooms both tiles identically.
          const zBoost=1+rc.symCreativeAmt*0.8;
          const sc=0.5*zBoost*(rcZ||1);
          offCtx.save();offCtx.beginPath();offCtx.rect(0,0,cx,DIMENSION);offCtx.clip();
          offCtx.translate(cx/2,cy);
          if((rc.isRotation&&!isAtBoundary)||Math.abs(rotationAngleRef.current)>0.0001)offCtx.rotate(rotationAngleRef.current);
          offCtx.rotate(axisAngle);offCtx.scale(sc,sc);
          offCtx.drawImage(rawCanvasRef.current,-cx,-cy);offCtx.restore();
          offCtx.save();offCtx.beginPath();offCtx.rect(cx,0,cx,DIMENSION);offCtx.clip();
          offCtx.translate(cx+cx/2,cy);
          if((rc.isRotation&&!isAtBoundary)||Math.abs(rotationAngleRef.current)>0.0001)offCtx.rotate(rotationAngleRef.current);
          offCtx.rotate(axisAngle);offCtx.scale(-sc,sc);
          offCtx.drawImage(rawCanvasRef.current,-cx,-cy);offCtx.restore();
        } else {
          // Tile4: 4 quadrants, amt adds a slight inward zoom per tile
          const zBoost=1+rc.symCreativeAmt*0.8;
          [{rx:0,ry:0,sx:1,sy:1},{rx:cx,ry:0,sx:1,sy:1},{rx:0,ry:cy,sx:1,sy:1},{rx:cx,ry:cy,sx:1,sy:1}].forEach(({rx,ry})=>{
            offCtx.save();offCtx.beginPath();offCtx.rect(rx,ry,cx,cy);offCtx.clip();
            offCtx.translate(rx+cx/2,ry+cy/2);
            if((rc.isRotation&&!isAtBoundary)||Math.abs(rotationAngleRef.current)>0.0001)offCtx.rotate(rotationAngleRef.current);
            offCtx.rotate(axisAngle);offCtx.scale(0.5*zBoost*(rcZ||1),0.5*zBoost*(rcZ||1));
            offCtx.drawImage(rawCanvasRef.current,-cx,-cy);offCtx.restore();
          });
        }
      } else if(s===12){
        // Shard: irregular angular segments. Amt controls rotation gap between shards
        const shards=7;
        const angles=[0,0.9,1.8,2.5,3.4,4.2,5.1,Math.PI*2];
        const rotGap=rc.symCreativeAmt*0.35; // amt: subtle → dramatic rotational offset per shard
        for(let ii=0;ii<shards;ii++){
          const a0=angles[ii]+axisAngle,a1=angles[ii+1]+axisAngle;
          offCtx.save();offCtx.translate(cx,cy);
          offCtx.beginPath();offCtx.moveTo(0,0);offCtx.arc(0,0,DIMENSION*1.5,a0-.01,a1+.01);offCtx.closePath();offCtx.clip();
          if((rc.isRotation&&!isAtBoundary)||Math.abs(rotationAngleRef.current)>0.0001)offCtx.rotate(rotationAngleRef.current);
          offCtx.rotate(axisAngle+ii*(flip?rotGap*2:rotGap));
          if(rcZ!==1.0)offCtx.scale(rcZ,rcZ);
          offCtx.drawImage(rawCanvasRef.current,-cx,-cy);offCtx.restore();
        }
      }

      // Shape mask
      if(rc.symMask&&rc.symMask!=='none'){
        const mc=symMaskCanvasRef.current;
        if(mc){offCtx.save();offCtx.globalCompositeOperation='destination-in';offCtx.drawImage(mc,0,0);offCtx.restore();}
      }
      // Center hole: punch transparent circle from center
      if(rc.symCenterHole>0){
        const holeR=rc.symCenterHole*Math.min(cx,cy)*0.98;
        offCtx.save();offCtx.globalCompositeOperation='destination-out';
        offCtx.beginPath();offCtx.arc(cx,cy,holeR,0,Math.PI*2);offCtx.fill();
        offCtx.restore();
      }
      offCtx.globalCompositeOperation='source-over';
    } else {
      offCtx.save();offCtx.translate(DIMENSION/2,DIMENSION/2);
      if((rc.isRotation&&!isAtBoundary)||Math.abs(rotationAngleRef.current)>0.0001)offCtx.rotate(rotationAngleRef.current);
      else if(!rc.isRotation&&Math.abs(rotationAngleRef.current)>0.0001)offCtx.rotate(rotationAngleRef.current);
      if(rcZ!==1.0)offCtx.scale(rcZ,rcZ);
      offCtx.drawImage(rawCanvasRef.current,-DIMENSION/2,-DIMENSION/2);offCtx.restore();
    }

    // ASCII post-sym (bypass mode)
    if(rc.asciiBypassSym&&!isAtBoundary)applyAsciiArt(offCtx,DIMENSION);

    if(!isAtBoundary){
      const hasT=rc.trailsEnabled&&rc.trailPost;const hasS=rc.smokeEnabled&&rc.smokePost;
      if(hasT||hasS){
        if(!trailBufferRef._ctx)trailBufferRef._ctx=trailBufferRef.current.getContext('2d',{alpha:false});
        if(!smokeBufferRef._ctx)smokeBufferRef._ctx=smokeBufferRef.current.getContext('2d',{alpha:false});
        if(hasT){
          // Decay trail buffer toward black, then stamp current frame onto it
          const tCtx=trailBufferRef._ctx;
          const decay=1-rc.trailStrength*0.92; // how fast it fades
          tCtx.globalCompositeOperation='source-over';
          tCtx.fillStyle=`rgba(0,0,0,${decay})`;
          tCtx.fillRect(0,0,DIMENSION,DIMENSION);
          tCtx.globalCompositeOperation='screen'; // screen = no brightness overshoot
          tCtx.globalAlpha=0.6;
          tCtx.drawImage(postProcessCanvasRef.current,0,0);
          tCtx.globalAlpha=1.0;
          tCtx.globalCompositeOperation='source-over';
          // Blend trail behind current frame using screen so it never overbrighten
          offCtx.globalCompositeOperation='screen';
          offCtx.globalAlpha=rc.trailStrength*0.55;
          offCtx.drawImage(trailBufferRef.current,0,0);
          offCtx.globalAlpha=1.0;
          offCtx.globalCompositeOperation='source-over';
        } else {
          trailBufferRef._ctx.fillStyle='#000';trailBufferRef._ctx.fillRect(0,0,DIMENSION,DIMENSION);
        }
        if(hasS){
          // Smoke: shift upward each frame, decay, stamp current frame
          const sCtx=smokeBufferRef._ctx;
          const rise=Math.floor(rc.smokeRise*6);
          // Shift existing smoke upward (copy with offset, not lighten)
          sCtx.globalCompositeOperation='copy';
          sCtx.drawImage(smokeBufferRef.current,0,-rise);
          // Decay toward black
          const decay=1-rcSmokeStr*0.88;
          sCtx.globalCompositeOperation='source-over';
          sCtx.fillStyle=`rgba(0,0,0,${decay})`;
          sCtx.fillRect(0,0,DIMENSION,DIMENSION);
          // Stamp current frame into smoke buffer (screen to avoid overbright)
          sCtx.globalCompositeOperation='screen';
          sCtx.globalAlpha=0.5;
          sCtx.drawImage(postProcessCanvasRef.current,0,0);
          sCtx.globalAlpha=1.0;
          sCtx.globalCompositeOperation='source-over';
          // Composite smoke behind current frame
          offCtx.globalCompositeOperation='screen';
          offCtx.globalAlpha=rcSmokeStr*0.5;
          offCtx.drawImage(smokeBufferRef.current,0,0);
          offCtx.globalAlpha=1.0;
          offCtx.globalCompositeOperation='source-over';
        } else {
          smokeBufferRef._ctx.fillStyle='#000';smokeBufferRef._ctx.fillRect(0,0,DIMENSION,DIMENSION);
        }
      }
    }

    // ── Retro: Behind layer (layer=0) — sits under everything ──────────────────
    if(rc.isRetro&&rc.retroLayer===0&&!isAtBoundary){
      const savedComp=offCtx.globalCompositeOperation;
      offCtx.globalCompositeOperation='destination-over';
      applyRetro(offCtx,DIMENSION);
      offCtx.globalCompositeOperation=savedComp;
    }
    // ── Retro: Front layer (layer=2) — overlaid over final composited frame ──
    if(rc.isRetro&&rc.retroLayer===2&&!isAtBoundary){
      applyRetro(offCtx,DIMENSION);
    }

        const totalPostAngle=livePostRotationAngleRef.current+rc.postRotationOffset;
    if(Math.abs(totalPostAngle)>0.0001){
      if(!postEffectTempRef.current){postEffectTempRef.current=document.createElement('canvas');postEffectTempRef.current.width=DIMENSION;postEffectTempRef.current.height=DIMENSION;}
      const tCtx=postEffectTempRef.current.getContext('2d',{alpha:false});
      tCtx.globalCompositeOperation='copy';tCtx.save();tCtx.translate(DIMENSION/2,DIMENSION/2);tCtx.rotate(totalPostAngle);tCtx.drawImage(postProcessCanvasRef.current,-DIMENSION/2,-DIMENSION/2);tCtx.restore();
      offCtx.globalCompositeOperation='copy';offCtx.drawImage(postEffectTempRef.current,0,0);offCtx.globalCompositeOperation='source-over';
    }
    // Single atomic blit — 'copy' overwrites without clearing first, so display canvas is never blank
    // cyHideCanvas: black out particles but keep raw canvas intact for SRC color sampling
    if(rc.cyHideCanvas){
      ctx.fillStyle=rc.canvasBg||'#000000';ctx.fillRect(0,0,DIMENSION,DIMENSION);
    } else {
      ctx.globalCompositeOperation='copy';ctx.drawImage(postProcessCanvasRef.current,0,0);ctx.globalCompositeOperation='source-over';
    }

    // ── Vectorscope / Cymatics Visualiser ────────────────────────────────────
    // Fabric (mode 11) renders without audio — all other modes need active mic
    if(rc.isCymatic&&audBusRef.current.active){
      const aud=audBusRef.current;
      const D=DIMENSION,CX=D/2,CY=D/2;

      // Ensure canvases
      if(!cyCanvasRef.current){const c=document.createElement('canvas');c.width=D;c.height=D;cyCanvasRef.current=c;}
      if(!cyPersistRef.current){const c=document.createElement('canvas');c.width=D;c.height=D;cyPersistRef.current=c;}
      if(!cySymCanvasRef.current){const c=document.createElement('canvas');c.width=D;c.height=D;cySymCanvasRef.current=c;}
      const cc=cyCanvasRef.current;
      const cCtx=cc.getContext('2d',{alpha:true});
      const pCtx=cyPersistRef.current.getContext('2d',{alpha:true});

      // ── Source signal prep ──────────────────────────────────────────────────
      const rawWf=aud.waveform;
      const spec=aud.spectrum;
      if(!rawWf){return;}

      // Auto-gain: track running peak, normalise waveform
      const amt=rc.cyAmt||0.75;
      const gain=rc.cyAutoGain?cyAutoGainRef.current:1;
      const N=rawWf?Math.min(rawWf.length,1024):0;
      if(rawWf){
        const rawPeak=rawWf.reduce((mx,v)=>Math.max(mx,Math.abs(v)),0.0001);
        if(rc.cyAutoGain){
          cyAutoGainRef.current=cyAutoGainRef.current*0.985+(1/(rawPeak||0.0001))*0.015;
          cyAutoGainRef.current=Math.min(cyAutoGainRef.current,12);
        }
      }

      // ── Waveform smoothing (EMA) ──────────────────────────────────────────
      const smoothAmt=rc.cySmooth??0.5;
      const smAlpha=1-smoothAmt*0.93;
      if(N>0){
        if(!cySmWfRef.current||cySmWfRef.current.length!==N){cySmWfRef.current=new Float32Array(N);}
        if(!cySmSpRef.current||cySmSpRef.current.length!==(spec?.length||0)){cySmSpRef.current=new Float32Array(spec?.length||0);}
        const smWf=cySmWfRef.current;
        for(let i=0;i<N;i++)smWf[i]=smWf[i]*(1-smAlpha)+rawWf[i]*smAlpha;
        if(spec&&cySmSpRef.current){const smSp=cySmSpRef.current;for(let i=0;i<spec.length;i++)smSp[i]=smSp[i]*(1-smAlpha)+spec[i]*smAlpha;}
      }
      const wfSrc=cySmWfRef.current||new Float32Array(1024);
      const spSrc=(spec&&cySmSpRef.current)?cySmSpRef.current:null;

      // Build pseudo-stereo L/R
      const phOff=Math.round((rc.cyPhaseOff??0.25)*Math.max(N,1));
      const sw=rc.cyStereoWidth??0.5;
      const wL=new Float32Array(Math.max(N,1)),wR=new Float32Array(Math.max(N,1));
      for(let i=0;i<N;i++){
        const raw=wfSrc[i]*gain*amt;
        const delayed=wfSrc[(i+phOff)%N]*gain*amt;
        wL[i]=raw*(1-sw*0.5)+delayed*sw*0.5;
        wR[i]=raw*(1-sw*0.5)-delayed*sw*0.5+(Math.random()-0.5)*sw*0.015;
      }

      // Color helpers
      const baseCol=rc.cyColor||'#00ffcc';
      const hr=parseInt(baseCol.slice(1,3)||'00',16);
      const hg=parseInt(baseCol.slice(3,5)||'ff',16);
      const hb=parseInt(baseCol.slice(5,7)||'cc',16);
      const colMode=rc.cyColorMode||'fixed';
      const pickCol=(frac,al=1)=>{
        if(colMode==='rainbow')return `hsla(${Math.round(frac*300)},100%,65%,${al})`;
        if(colMode==='spectrum')return `hsla(${Math.round((1-frac)*240)},100%,60%,${al})`;
        if(colMode==='source'&&rCtxRef.current){
          try{const d=rCtxRef.current.getImageData(Math.min(Math.round(frac*D),D-1),Math.min(Math.round(D*0.5),D-1),1,1).data;return `rgba(${d[0]},${d[1]},${d[2]},${al})`;}
          catch{return baseCol;}
        }
        return `rgba(${hr},${hg},${hb},${al})`;
      };
      const glow=rc.cyGlow!==false;
      const glowMul=(rc.cyGlowAmt??0.5)*2.5; // 0→0  0.5→1.25  1→2.5
      const sg=(c2d,col,blur=8)=>{if(glow){c2d.shadowColor=col;c2d.shadowBlur=blur*glowMul;}else c2d.shadowBlur=0;};
      // applyInvert: post-pass difference-blend white fill to invert drawn content
      const applyInvert=(c2d)=>{
        if(!rc.cyInvert)return;
        c2d.save();c2d.globalCompositeOperation='difference';c2d.globalAlpha=1;
        c2d.fillStyle='#ffffff';c2d.fillRect(0,0,D,D);c2d.restore();
      };

      // ── Grid/graticule helper ───────────────────────────────────────────────
      // Grid is now always drawn to cCtx (never pCtx), so it never accumulates.
      // Grid alpha capped at (1-trails) so it can't accumulate faster than trail fade clears it
      const gridFadeAlpha=Math.min(0.12, 1-(rc.cyTrails??0.30));
      const drawGrid=(c2d,cx=CX,cy=CY,r=CX*0.88)=>{
        if(!rc.cyGridlines)return;
        c2d.save();c2d.strokeStyle='#ffffff';c2d.lineWidth=0.5;
        c2d.globalAlpha=gridFadeAlpha;
        c2d.beginPath();c2d.moveTo(cx-r,cy);c2d.lineTo(cx+r,cy);
        c2d.moveTo(cx,cy-r);c2d.lineTo(cx,cy+r);c2d.stroke();
        [0.25,0.5,0.75,1].forEach(f=>{
          c2d.globalAlpha=Math.min(f===1?0.20:0.08, gridFadeAlpha);
          c2d.beginPath();c2d.arc(cx,cy,r*f,0,Math.PI*2);c2d.stroke();
        });
        c2d.globalAlpha=Math.min(0.07, gridFadeAlpha);
        c2d.beginPath();c2d.moveTo(cx-r*0.707,cy-r*0.707);c2d.lineTo(cx+r*0.707,cy+r*0.707);
        c2d.moveTo(cx+r*0.707,cy-r*0.707);c2d.lineTo(cx-r*0.707,cy+r*0.707);c2d.stroke();
        c2d.restore();
      };

      // ── Scope transform: apply zoom/rotation from controls or EngFX link ───
      // When cySymLink (Eng Xform ON):
      //   scopeZ  = EngFX zoom (rcZ) × manual scope zoom
      //   totalRot = motor spin angle + manual scope rot + auto-spin
      //   post-rotation (wheel/offset) is applied separately as a canvas transform below
      // When cySymLink OFF: only manual scope controls apply.
      const scopeZ=(rc.cySymLink?rcZ:1)*(rc.cyScopeZoom||1);
      const engRot=rc.cySymLink
        ? (rotationAngleRef.current%(Math.PI*2))
        : 0;
      const scopeRot=(rc.cyScopeRot||0)*Math.PI/180 + engRot;
      // Auto-spin
      if(rc.cySpinRate>0){cySpinRef.current=(cySpinRef.current+(rc.cySpinRate*0.002))%(Math.PI*2);}
      const totalRot=scopeRot+cySpinRef.current;
      const renderMode=rc.cyRender||'line';
      const usePoints=renderMode==='point';
      const useThick=renderMode==='thick';
      const useFilled=renderMode==='filled';

      // ── Clear work canvas ───────────────────────────────────────────────────
      cCtx.clearRect(0,0,D,D);

      // ── Warp distortion helper (barrel/pincushion) ──────────────────────────
      const warpPt=(x,y,cx,cy)=>{
        if(!rc.cyWarpAmt)return {x,y};
        const nx=(x-cx)/(CX),ny=(y-cy)/(CY);
        const r2=nx*nx+ny*ny;
        const w=rc.cyWarpAmt*0.4;
        return {x:cx+nx*(1+w*r2)*CX, y:cy+ny*(1+w*r2)*CY};
      };

      // Scope scale
      const SC=CX*0.84*scopeZ;

      // ── Shared vectorscope trace helper (L vs R) used by modes 0, 6 ─────────
      // Bands: number of simultaneous passes at staggered phase offsets.
      //   1 band = single L/R trace  (clean Lissajous)
      //   2 bands = two traces offset 45°, different color  (figure-8 overtones)
      //   3-4 bands = layered harmonic echoes, each dimmer and phase-shifted
      const drawVscope=(c2d,S)=>{
        const bands=Math.max(1,Math.min(rc.cyFreqBands||1,4));
        const lw=useThick?2.8:1.2;
        for(let b=0;b<bands;b++){
          const bPhShift=b===0?0:Math.floor(N*(b*0.125)); // 0° 45° 90° 135°
          const bAlpha=(b===0?0.88:0.5/b);
          // Collect all points for this band
          const pts=[];
          for(let i=0;i<N;i++){
            const l=wL[(i+bPhShift)%N];
            const r=wR[(i+bPhShift)%N];
            const xi=rc.cyXYSwap?r:l;
            const yi=rc.cyXYSwap?l:r;
            pts.push(warpPt(CX+xi*S,CY-yi*S,CX,CY));
          }
          if(usePoints){
            for(let i=0;i<N;i+=2){
              const p=pts[i];
              c2d.fillStyle=pickCol((b/bands)+(i/N)/bands,bAlpha*0.85);
              c2d.globalAlpha=bAlpha*0.85;
              sg(c2d,pickCol(b/bands),3);
              const sz=useThick?2.2:1.1;
              c2d.beginPath();c2d.arc(p.x,p.y,sz,0,Math.PI*2);c2d.fill();
            }
          } else {
            // Filled polygon underneath the line
            if(useFilled){
              c2d.beginPath();
              pts.forEach((p,i)=>i===0?c2d.moveTo(p.x,p.y):c2d.lineTo(p.x,p.y));
              c2d.closePath();
              c2d.fillStyle=pickCol(b/bands,0.12-b*0.02);
              c2d.globalAlpha=1;
              sg(c2d,pickCol(b/bands),12);
              c2d.fill();
            }
            // Colored line trace in chunks
            const chunks=8;const step=Math.ceil(N/chunks);
            c2d.lineWidth=useFilled?0.7:lw;c2d.lineJoin='round';
            for(let c=0;c<chunks;c++){
              const col=pickCol((b/bands)+(c/chunks)/bands,bAlpha);
              c2d.strokeStyle=col;c2d.globalAlpha=bAlpha;
              sg(c2d,col,6+aud.rms*10);
              c2d.beginPath();
              for(let i=c*step;i<Math.min((c+1)*step+1,N);i++){
                const p=pts[i];if(!p)continue;
                i===c*step?c2d.moveTo(p.x,p.y):c2d.lineTo(p.x,p.y);
              }
              c2d.stroke();
            }
          }
          // Mirror: true 4-fold reflection (X and Y axes) — creates full diamond/butterfly
          if(rc.cyMirror){
            // Draw 3 additional reflections: flip-X, flip-Y, flip-XY
            const mirrors=[[1,-1],[-1,1],[-1,-1]];
            mirrors.forEach(([sx,sy],mi)=>{
              const mPts=pts.map(p=>warpPt(CX+(p.x-CX)*sx,CY+(p.y-CY)*sy,CX,CY));
              const mAlpha=bAlpha*0.55;
              const mCol=pickCol((b/bands)+(mi+1)*0.22,mAlpha);
              if(usePoints){
                for(let i=0;i<N;i+=2){
                  c2d.fillStyle=mCol;c2d.globalAlpha=mAlpha;sg(c2d,mCol,2);
                  c2d.beginPath();c2d.arc(mPts[i].x,mPts[i].y,useThick?1.8:0.9,0,Math.PI*2);c2d.fill();
                }
              } else {
                c2d.lineWidth=useFilled?0.5:lw*0.75;c2d.strokeStyle=mCol;c2d.globalAlpha=mAlpha;sg(c2d,mCol,4);
                c2d.beginPath();mPts.forEach((p,i)=>i===0?c2d.moveTo(p.x,p.y):c2d.lineTo(p.x,p.y));c2d.stroke();
              }
            });
          }
        }
        c2d.shadowBlur=0;c2d.globalAlpha=1;
      };

      // ════════════════════════════════════════════════════════════════════════
      const mode=rc.cyMode||0;

      // ── Persistence canvas zoom-shrink decay ────────────────────────────────
      // When cyDecay > 0: each frame the persistence canvas shrinks very slightly
      // toward centre, creating a "zoom-out fade" instead of a plain trail fade.
      // decayScale per frame = 1 - decay * 0.006 (at 60fps: ~0 to ~26% shrink/sec)
      const decayAmt=rc.cyDecay||0;
      const applyDecay=(targetCtx)=>{
        if(decayAmt<0.01)return;
        const ds=1-decayAmt*0.015;
        if(!cyPostTempRef.current){
          cyPostTempRef.current=document.createElement('canvas');
          cyPostTempRef.current.width=D;cyPostTempRef.current.height=D;
        }
        const tmp=cyPostTempRef.current;
        // NOTE: never reassign tmp.width — that triggers GPU reallocation every frame
        const tCtx=tmp.getContext('2d');
        tCtx.globalCompositeOperation='source-over';tCtx.globalAlpha=1;
        tCtx.clearRect(0,0,D,D);tCtx.drawImage(targetCtx.canvas,0,0);
        targetCtx.globalCompositeOperation='source-over';targetCtx.globalAlpha=1;
        targetCtx.clearRect(0,0,D,D);
        targetCtx.save();targetCtx.translate(CX,CY);targetCtx.scale(ds,ds);targetCtx.translate(-CX,-CY);
        targetCtx.drawImage(tmp,0,0);targetCtx.restore();
      };

      if(mode===0){
        // ── Classic Vectorscope (Lissajous L vs R / stereometer) ──────────────
        // L on X-axis, R on Y-axis. Mono = diagonal line at 45°.
        // Wide stereo = broad ellipse. Out-of-phase = horizontal ellipse.
        const trails=rc.cyTrails??0.30;
        pCtx.globalCompositeOperation='source-over';
        applyDecay(pCtx);
        pCtx.globalAlpha=1-trails;pCtx.fillStyle='#000';pCtx.fillRect(0,0,D,D);
        pCtx.globalAlpha=1;
        pCtx.save();
        pCtx.translate(CX,CY);pCtx.rotate(totalRot);pCtx.translate(-CX,-CY);
        drawGrid(pCtx);
        drawVscope(pCtx,SC);
        pCtx.restore();
        applyInvert(pCtx);

      }else if(mode===1){
        // ── Polar Vectorscope ─────────────────────────────────────────────────
        const trails=rc.cyTrails??0.30;
        applyDecay(pCtx);
        pCtx.globalAlpha=1-trails;pCtx.fillStyle='#000';pCtx.fillRect(0,0,D,D);
        pCtx.globalAlpha=1;
        pCtx.save();pCtx.translate(CX,CY);pCtx.rotate(totalRot);pCtx.translate(-CX,-CY);
        drawGrid(pCtx);
        const lw1=useThick?2.5:1.2;
        const bands1=Math.max(1,Math.min(rc.cyFreqBands||1,4));
        for(let b=0;b<bands1;b++){
          const bPhShift=b===0?0:Math.floor(N*(b*0.125));
          const bAlpha=b===0?0.82:0.5/b;
          const pts=[];
          for(let i=0;i<N;i++){
            const l=wL[(i+bPhShift)%N],r=wR[(i+bPhShift)%N];
            const sum=Math.abs(l)+Math.abs(r)||0.0001;
            const angle=Math.atan2(l-r,l+r);
            const radius=(sum*0.5)*SC;
            pts.push(warpPt(CX+Math.cos(angle)*radius,CY+Math.sin(angle)*radius,CX,CY));
          }
          if(useFilled){
            pCtx.beginPath();pts.forEach((p,i)=>i===0?pCtx.moveTo(p.x,p.y):pCtx.lineTo(p.x,p.y));pCtx.closePath();
            pCtx.fillStyle=pickCol(b/bands1,0.10-b*0.02);pCtx.globalAlpha=1;sg(pCtx,pickCol(b/bands1),12);pCtx.fill();
          }
          if(usePoints){
            for(let i=0;i<N;i+=2){
              const p=pts[i];const col=pickCol((b/bands1)+(i/N)/bands1,bAlpha*0.85);
              pCtx.fillStyle=col;pCtx.globalAlpha=bAlpha*0.85;sg(pCtx,col,3);
              pCtx.beginPath();pCtx.arc(p.x,p.y,useThick?2:1.1,0,Math.PI*2);pCtx.fill();
            }
          } else {
            const chunks=6;const step=Math.ceil(N/chunks);
            pCtx.lineWidth=useFilled?0.7:lw1;pCtx.lineJoin='round';
            for(let c=0;c<chunks;c++){
              const col=pickCol((b/bands1)+(c/chunks)/bands1,bAlpha);
              pCtx.strokeStyle=col;pCtx.globalAlpha=bAlpha;sg(pCtx,col,5+aud.rms*8);
              pCtx.beginPath();
              for(let i=c*step;i<Math.min((c+1)*step+1,N);i++){const p=pts[i];if(p)i===c*step?pCtx.moveTo(p.x,p.y):pCtx.lineTo(p.x,p.y);}
              pCtx.stroke();
            }
          }
          if(rc.cyMirror){
            pCtx.save();pCtx.translate(CX,CY);pCtx.rotate(Math.PI);pCtx.translate(-CX,-CY);
            pCtx.lineWidth=lw1*0.6;pCtx.globalAlpha=bAlpha*0.3;
            const col2=pickCol(1-b/bands1,bAlpha*0.3);pCtx.strokeStyle=col2;sg(pCtx,col2,4);
            pCtx.beginPath();pts.forEach((p,i)=>i===0?pCtx.moveTo(p.x,p.y):pCtx.lineTo(p.x,p.y));pCtx.stroke();
            pCtx.restore();
          }
        }
        pCtx.shadowBlur=0;pCtx.globalAlpha=1;pCtx.restore();
        applyInvert(pCtx);

      }else if(mode===2){
        // ── 3D Waterfall: time as Z-axis, perspective projected ────────────────
        // scopeZ scales FOV (zoom). totalRot/post-rotation applied as canvas transform after draw.
        const buf=cyWaterfallRef.current;
        const maxSlices=40;
        buf.unshift(Array.from(wL));
        if(buf.length>maxSlices)buf.pop();
        cCtx.clearRect(0,0,D,D);
        if(rc.cyInvert){cCtx.fillStyle='#fff';cCtx.fillRect(0,0,D,D);}
        drawGrid(cCtx);
        const fov=420*scopeZ, baseY=CY*1.1;
        for(let si=buf.length-1;si>=0;si--){
          const slice=buf[si];
          const zFrac=si/maxSlices;
          const z=zFrac*500+80;
          const perspective=fov/(fov+z);
          const yOff=baseY-(baseY*0.7*perspective);
          const xScale=perspective*SC*1.2;
          const alpha=(1-zFrac*0.7)*amt*0.85;
          const col=pickCol(zFrac,alpha);
          cCtx.globalAlpha=alpha;
          const lw2=Math.max(0.4,(useThick?2.4:1.4)*perspective);
          if(usePoints){
            cCtx.fillStyle=col;sg(cCtx,col,2);
            const SN=Math.min(slice.length,256);
            for(let i=0;i<SN;i+=3){
              const {x,y}=warpPt(CX+(i/(SN-1)*2-1)*xScale,yOff-slice[i]*perspective*CX*0.5,CX,CY);
              cCtx.beginPath();cCtx.arc(x,y,useThick?2:1,0,Math.PI*2);cCtx.fill();
            }
          }else{
            cCtx.strokeStyle=col;cCtx.lineWidth=lw2;sg(cCtx,col,(1-zFrac)*8+(aud.rms||0)*6);
            cCtx.beginPath();
            const SN=Math.min(slice.length,256);
            for(let i=0;i<SN;i++){
              const {x,y}=warpPt(CX+(i/(SN-1)*2-1)*xScale,yOff-slice[i]*perspective*CX*0.5,CX,CY);
              i===0?cCtx.moveTo(x,y):cCtx.lineTo(x,y);
            }
            cCtx.stroke();
            if(useFilled&&si<buf.length-1){
              const prev=buf[si+1];
              const z2=(si+1)/maxSlices*500+80;const persp2=fov/(fov+z2);
              const yOff2=baseY-(baseY*0.7*persp2);
              cCtx.globalAlpha=alpha*0.1;cCtx.fillStyle=col;
              cCtx.beginPath();
              for(let i=0;i<SN;i++){const xN=(i/(SN-1))*2-1;cCtx.lineTo(CX+xN*xScale,yOff-slice[i]*perspective*CX*0.5);}
              for(let i=SN-1;i>=0;i--){const xN=(i/(SN-1))*2-1;cCtx.lineTo(CX+xN*persp2*SC*1.2,yOff2-(prev[i]||0)*persp2*CX*0.5);}
              cCtx.closePath();cCtx.fill();
            }
            if(rc.cyMirror){
              // Mirror: draw the waterfall reflected horizontally (flip X around centre)
              // This creates a symmetric double-waterfall — same perspective, mirrored
              cCtx.save();
              cCtx.translate(D,0);cCtx.scale(-1,1);
              cCtx.globalAlpha=alpha*0.55;
              cCtx.strokeStyle=pickCol(1-zFrac,alpha*0.55);cCtx.lineWidth=lw2*0.7;sg(cCtx,col,((1-zFrac)*6+(aud.rms||0)*4)*0.6);
              cCtx.beginPath();
              const SN3=Math.min(slice.length,256);
              for(let i=0;i<SN3;i++){
                const {x,y}=warpPt(CX+(i/(SN3-1)*2-1)*xScale,yOff-slice[i]*perspective*CX*0.5,CX,CY);
                i===0?cCtx.moveTo(x,y):cCtx.lineTo(x,y);
              }
              cCtx.stroke();
              cCtx.restore();
            }
          }
        }
        cCtx.globalAlpha=1;cCtx.shadowBlur=0;
        // NOTE: rotation for mode 2 is applied post-composite (after symmetry)
        // to avoid the mirror-rotation direction conflict. See post-composite block below.

      }else if(mode===3){
        // ── Phosphor Scope CRT — classic glowing oscilloscope with persistence ─
        const trails=rc.cyTrails??0.30;
        pCtx.globalCompositeOperation='source-over';
        applyDecay(pCtx);
        pCtx.globalAlpha=1-trails;pCtx.fillStyle='#000';pCtx.fillRect(0,0,D,D);pCtx.globalAlpha=1;
        pCtx.save();pCtx.translate(CX,CY);pCtx.rotate(totalRot);pCtx.translate(-CX,-CY);
        drawGrid(pCtx);
        const glowCol=pickCol(0.5);
        const lw3=useThick?2.5:1.2;
        if(usePoints){
          for(let i=0;i<N;i+=2){
            const x=(i/(N-1))*D,y=CY-wL[i]*SC;
            const col=pickCol(i/N,0.9);pCtx.fillStyle=col;pCtx.globalAlpha=0.9;sg(pCtx,col,5);
            pCtx.beginPath();pCtx.arc(x,y,useThick?2:1,0,Math.PI*2);pCtx.fill();
          }
        } else {
          // Soft glow halo
          pCtx.globalCompositeOperation='screen';
          pCtx.strokeStyle=glowCol;pCtx.lineWidth=lw3*4;pCtx.globalAlpha=0.07;sg(pCtx,glowCol,22+aud.rms*28);
          pCtx.beginPath();for(let i=0;i<N;i++){const x=(i/(N-1))*D,y=CY-wL[i]*SC;i===0?pCtx.moveTo(x,y):pCtx.lineTo(x,y);}pCtx.stroke();
          // Sharp colored trace in chunks
          const chunks=6;const step=Math.ceil(N/chunks);
          for(let c=0;c<chunks;c++){
            const col=pickCol(c/chunks,0.92);pCtx.strokeStyle=col;pCtx.lineWidth=lw3;pCtx.globalAlpha=0.92;sg(pCtx,col,4);
            pCtx.beginPath();for(let i=c*step;i<Math.min((c+1)*step+1,N);i++){const x=(i/(N-1))*D,y=CY-wL[i]*SC;i===c*step?pCtx.moveTo(x,y):pCtx.lineTo(x,y);}pCtx.stroke();
          }
          if(useFilled){
            pCtx.globalAlpha=1;pCtx.beginPath();
            for(let i=0;i<N;i++){pCtx.lineTo((i/(N-1))*D,CY-wL[i]*SC);}
            pCtx.lineTo(D,CY);pCtx.lineTo(0,CY);pCtx.closePath();
            pCtx.fillStyle=pickCol(0.5,0.09);sg(pCtx,glowCol,10);pCtx.fill();
          }
          if(rc.cyMirror){
            pCtx.globalCompositeOperation='screen';
            const mirCol=pickCol(0.75,0.55);pCtx.strokeStyle=mirCol;pCtx.lineWidth=lw3*0.8;pCtx.globalAlpha=0.55;sg(pCtx,mirCol,5);
            pCtx.beginPath();for(let i=0;i<N;i++){const x=(i/(N-1))*D,y=CY+wL[i]*SC;i===0?pCtx.moveTo(x,y):pCtx.lineTo(x,y);}pCtx.stroke();
          }
        }
        pCtx.globalCompositeOperation='source-over';pCtx.shadowBlur=0;pCtx.globalAlpha=1;
        pCtx.restore();
        applyInvert(pCtx);

      }else if(mode===4){
        // ── Spectral Orbit — freq bands as orbital rings driven by spectrum ─────
        const trails=rc.cyTrails??0.30;
        applyDecay(pCtx);
        pCtx.globalAlpha=1-trails;pCtx.fillStyle='#000';pCtx.fillRect(0,0,D,D);pCtx.globalAlpha=1;
        pCtx.save();pCtx.translate(CX,CY);pCtx.rotate(totalRot);pCtx.translate(-CX,-CY);
        drawGrid(pCtx);
        if(spSrc){
          const nbands=Math.max(1,Math.min(rc.cyFreqBands||3,4));
          for(let b=0;b<nbands;b++){
            const bFrac=b/nbands;
            const loIdx=Math.floor(bFrac*spSrc.length);
            const hiIdx=Math.floor(((b+1)/nbands)*spSrc.length);
            const npts=hiIdx-loIdx;
            const baseR=CX*(0.15+bFrac*0.65)*scopeZ;
            const col=pickCol(bFrac);
            const orbitPts=[];
            for(let i=0;i<=npts;i++){
              const angle=(i/npts)*Math.PI*2-Math.PI/2;
              const energy=spSrc[loIdx+i]||0;
              const r=baseR+energy*CX*0.35*amt;
              orbitPts.push(warpPt(CX+Math.cos(angle)*r,CY+Math.sin(angle)*r,CX,CY));
            }
            if(useFilled){
              pCtx.beginPath();orbitPts.forEach((p,i)=>i===0?pCtx.moveTo(p.x,p.y):pCtx.lineTo(p.x,p.y));pCtx.closePath();
              pCtx.fillStyle=pickCol(bFrac,0.1-bFrac*0.03);pCtx.globalAlpha=1;sg(pCtx,col,10);pCtx.fill();
            }
            pCtx.strokeStyle=col;pCtx.lineWidth=useThick?2.5:1.2;sg(pCtx,col,6+aud.rms*12);
            pCtx.beginPath();orbitPts.forEach((p,i)=>i===0?pCtx.moveTo(p.x,p.y):pCtx.lineTo(p.x,p.y));
            pCtx.closePath();pCtx.globalAlpha=0.85;pCtx.stroke();
            if(rc.cyMirror){
              pCtx.save();pCtx.translate(CX,CY);pCtx.scale(1,-1);pCtx.translate(-CX,-CY);
              pCtx.strokeStyle=pickCol(1-bFrac,0.3);pCtx.lineWidth=0.8;pCtx.globalAlpha=0.3;sg(pCtx,col,4);
              pCtx.beginPath();orbitPts.forEach((p,i)=>i===0?pCtx.moveTo(p.x,p.y):pCtx.lineTo(p.x,p.y));pCtx.closePath();pCtx.stroke();
              pCtx.restore();
            }
          }
        }
        pCtx.globalAlpha=0.8;pCtx.fillStyle=baseCol;sg(pCtx,baseCol,16+aud.bass||0*20);
        pCtx.beginPath();pCtx.arc(CX,CY,3+aud.bass||0*CX*0.1,0,Math.PI*2);pCtx.fill();
        pCtx.shadowBlur=0;pCtx.globalAlpha=1;
        pCtx.restore();applyInvert(pCtx);

      }else if(mode===5){
        // ── Particle Field ────────────────────────────────────────────────────
        const parts=cyPartsRef.current;
        const audRms=aud.rms||0;
        const audBass=aud.bass||0;
        for(let i=0;i<N;i+=8){
          if(Math.random()>audRms*3*amt)continue;
          const {x,y}=warpPt(CX+wL[i]*SC,CY-wR[i]*SC,CX,CY);
          parts.push({x,y,vx:(Math.random()-.5)*audBass*2.5,vy:(Math.random()-.5)*audBass*2.5,
            age:0,life:30+Math.random()*50,col:pickCol(Math.random()),sz:1+(useThick?1.5:0)+audRms*2.5});
        }
        if(aud.beat){for(let i=0;i<20;i++){const a=Math.random()*Math.PI*2,r=Math.random()*SC*0.7;parts.push({x:CX+Math.cos(a)*r,y:CY+Math.sin(a)*r,vx:Math.cos(a)*2,vy:Math.sin(a)*2,age:0,life:40+Math.random()*60,col:pickCol(Math.random()),sz:2+audBass*3});}}
        cCtx.clearRect(0,0,D,D);
        if(rc.cyInvert){cCtx.fillStyle='#fff';cCtx.fillRect(0,0,D,D);}
        drawGrid(cCtx);
        for(let pi=parts.length-1;pi>=0;pi--){
          const p=parts[pi];p.age++;
          if(p.age>=p.life){parts.splice(pi,1);continue;}
          p.vx*=0.96;p.vy*=0.96;p.x+=p.vx;p.y+=p.vy;
          const al=amt*(1-p.age/p.life)*(0.4+audRms*0.6);
          cCtx.fillStyle=p.col;cCtx.globalAlpha=al;sg(cCtx,p.col,6);
          cCtx.beginPath();cCtx.arc(p.x,p.y,p.sz,0,Math.PI*2);cCtx.fill();
          if(rc.cyMirror){
            cCtx.globalAlpha=al*0.3;cCtx.beginPath();cCtx.arc(D-p.x,D-p.y,p.sz*0.7,0,Math.PI*2);cCtx.fill();
          }
        }
        if(parts.length>1200)parts.splice(0,parts.length-1200);
        cCtx.globalAlpha=1;cCtx.shadowBlur=0;

      }else if(mode===6){
        // ── Differential Lissajous — multiple phase-offset copies ─────────────
        // Bands controls how many Lissajous figures are layered at different
        // phase offsets (45°, 90°, 135°), creating Bowditch / figure-8 shapes.
        const trails=rc.cyTrails??0.30;
        applyDecay(pCtx);
        pCtx.globalAlpha=1-trails;pCtx.fillStyle='#000';pCtx.fillRect(0,0,D,D);pCtx.globalAlpha=1;
        pCtx.save();pCtx.translate(CX,CY);pCtx.rotate(totalRot);pCtx.translate(-CX,-CY);
        drawGrid(pCtx);
        const nbands6=Math.min(Math.max(1,rc.cyFreqBands||3),4);
        for(let b=0;b<nbands6;b++){
          const pOff=Math.floor(N*(0.125+b*0.125));
          const bAlpha=b===0?0.85:0.55/b;
          const sc6=SC*(1-b*0.1);
          const pts=[];
          for(let i=0;i<N-pOff;i++)pts.push(warpPt(CX+wL[i]*sc6,CY-wL[i+pOff]*sc6,CX,CY));
          if(useFilled){
            pCtx.beginPath();pts.forEach((p,i)=>i===0?pCtx.moveTo(p.x,p.y):pCtx.lineTo(p.x,p.y));pCtx.closePath();
            pCtx.fillStyle=pickCol(b/nbands6,0.09-b*0.02);pCtx.globalAlpha=1;sg(pCtx,pickCol(b/nbands6),10);pCtx.fill();
          }
          const col6=pickCol(b/nbands6,bAlpha);
          pCtx.strokeStyle=col6;pCtx.lineWidth=useFilled?0.7:(useThick?2.2:1.1);sg(pCtx,col6,4+b*2+aud.rms*8);
          pCtx.globalAlpha=bAlpha;pCtx.beginPath();pts.forEach((p,i)=>i===0?pCtx.moveTo(p.x,p.y):pCtx.lineTo(p.x,p.y));pCtx.stroke();
          if(rc.cyMirror){
            pCtx.save();pCtx.translate(CX,CY);pCtx.scale(-1,1);pCtx.translate(-CX,-CY);
            pCtx.strokeStyle=pickCol(1-b/nbands6,bAlpha*0.35);pCtx.lineWidth=(useThick?1.5:0.8);pCtx.globalAlpha=bAlpha*0.35;sg(pCtx,col6,3);
            pCtx.beginPath();pts.forEach((p,i)=>i===0?pCtx.moveTo(p.x,p.y):pCtx.lineTo(p.x,p.y));pCtx.stroke();
            pCtx.restore();
          }
        }
        pCtx.shadowBlur=0;pCtx.globalAlpha=1;pCtx.restore();applyInvert(pCtx);

      }else if(mode===7){
        // ── Fractal Engine — 5 styles: Tree, Coral, Mandala, Plasma Web, Snowflake ─
        const trails=rc.cyTrails??0.30;
        applyDecay(pCtx);
        pCtx.globalCompositeOperation='source-over';
        pCtx.globalAlpha=1-trails;pCtx.fillStyle=rc.cyInvert?'#fff':'#000';pCtx.fillRect(0,0,D,D);
        pCtx.globalAlpha=1;
        pCtx.save();pCtx.translate(CX,CY);pCtx.rotate(totalRot);pCtx.translate(-CX,-CY);
        drawGrid(pCtx);
        const fStyle=rc.cyFracStyle||0;
        const audBassV=aud.bass||0;const audMidV=aud.mid||0;const audRmsV=aud.rms||0;const audTrebV=aud.treble||0;

        if(fStyle===0){
          // ── Tree: classic recursive branching, spectrum-driven spread
          if(spSrc){
            const depth=3+Math.floor(audRmsV*4);
            const drawBranch=(c2d,x,y,angle,len,d)=>{
              if(d<=0||len<1.5)return;
              const si=Math.floor((1-d/8)*spSrc.length);
              const energy=spSrc[si]||0;
              const col=pickCol(d/8,0.65+energy*0.35);
              const spread=0.28+energy*0.75+audBassV*0.25*(d===depth?1:0);
              const ex=x+Math.cos(angle)*len,ey=y+Math.sin(angle)*len;
              c2d.strokeStyle=col;c2d.lineWidth=Math.max(0.3,d*(useFilled?0.6:0.38));
              c2d.globalAlpha=0.45+energy*0.5;sg(c2d,col,d*2+energy*8);
              c2d.beginPath();c2d.moveTo(x,y);c2d.lineTo(ex,ey);c2d.stroke();
              if(useFilled){c2d.fillStyle=col;c2d.globalAlpha=0.035;c2d.beginPath();c2d.arc(ex,ey,len*0.28,0,Math.PI*2);c2d.fill();}
              const twist=(audMidV*0.35+t*0.18*(d%2===0?1:-1))*amt;
              drawBranch(c2d,ex,ey,angle-spread+twist,  len*0.67,d-1);
              drawBranch(c2d,ex,ey,angle+spread-twist*0.6,len*0.71,d-1);
              if(d>depth-2)drawBranch(c2d,ex,ey,angle+twist*0.4,len*0.52,d-2);
            };
            const rootLen=CX*0.30*scopeZ*(0.65+audBassV*0.7*amt);
            drawBranch(pCtx,CX,CY*1.55+audRmsV*8,-Math.PI/2+audBassV*0.18*amt,rootLen,depth);
            if(rc.cyMirror)drawBranch(pCtx,CX,CY*0.45-audRmsV*8,Math.PI/2-audBassV*0.18*amt,rootLen,depth);
          }

        }else if(fStyle===1){
          // ── Coral: radial tree sprouting from centre in all directions
          if(spSrc){
            const branches=rc.cyMirror?12:6;
            const depth=3+Math.floor(audRmsV*3);
            const drawCoral=(c2d,x,y,angle,len,d,hue)=>{
              if(d<=0||len<1.2)return;
              const si=Math.floor((d/6)*spSrc.length*0.7);
              const energy=spSrc[si]||0;
              const col=`hsla(${(hue+d*18)%360},85%,${55+energy*25}%,${0.55+energy*0.35})`;
              const ex=x+Math.cos(angle)*len,ey=y+Math.sin(angle)*len;
              c2d.strokeStyle=col;c2d.lineWidth=Math.max(0.4,d*0.45*(useFilled?1.4:1));
              c2d.globalAlpha=0.5+energy*0.4;sg(c2d,col,d*1.8+energy*7);
              c2d.beginPath();c2d.moveTo(x,y);c2d.lineTo(ex,ey);c2d.stroke();
              const curv=0.22+energy*0.6+audBassV*0.2;
              const wave=Math.sin(t*1.2+d*0.7)*audMidV*0.3*amt;
              drawCoral(c2d,ex,ey,angle-curv+wave,len*0.72,d-1,hue+20);
              drawCoral(c2d,ex,ey,angle+curv+wave,len*0.68,d-1,hue-15);
            };
            for(let b=0;b<branches;b++){
              const baseAngle=(b/branches)*Math.PI*2;
              const hue=(b/branches)*360;
              const rootLen=CX*0.22*scopeZ*(0.7+(spSrc[Math.floor(b/branches*spSrc.length)]||0)*0.8*amt);
              drawCoral(pCtx,CX,CY,baseAngle,rootLen,depth,hue);
            }
          }

        }else if(fStyle===2){
          // ── Mandala: N-fold rotational lace, spectrum as petal amplitude
          if(spSrc){
            const petals=rc.cyMirror?12:6;
            const rings=4;
            for(let ring=0;ring<rings;ring++){
              const rFrac=(ring+1)/rings;
              const baseR=CX*0.15*rFrac*scopeZ;
              const loIdx=Math.floor((ring/rings)*spSrc.length*0.8);
              const hiIdx=Math.floor(((ring+1)/rings)*spSrc.length*0.8);
              let energy=0;for(let k=loIdx;k<hiIdx;k++)energy+=spSrc[k]||0;
              energy/=Math.max(1,hiIdx-loIdx);
              const col=pickCol(rFrac,0.6+energy*0.35);
              pCtx.strokeStyle=col;pCtx.lineWidth=(useFilled?2:1.1)+energy*3;
              sg(pCtx,col,4+energy*14+audBassV*6);
              pCtx.globalAlpha=0.45+energy*0.45;
              pCtx.beginPath();
              for(let p=0;p<=petals*2+1;p++){
                const a=(p/(petals*2))*Math.PI*2;
                const petalPulse=Math.cos(p*Math.PI)*0.5+0.5;
                const r=baseR+(energy*CX*0.18+audBassV*CX*0.06)*petalPulse*amt;
                const wobble=Math.sin(a*petals+t*1.5+ring)*audMidV*CX*0.04*amt;
                const px=CX+Math.cos(a)*(r+wobble),py=CY+Math.sin(a)*(r+wobble);
                p===0?pCtx.moveTo(px,py):pCtx.lineTo(px,py);
              }
              pCtx.closePath();pCtx.stroke();
              if(useFilled){pCtx.globalAlpha=energy*0.08;pCtx.fillStyle=col;pCtx.fill();}
            }
          }

        }else if(fStyle===3){
          // ── Plasma Web: recursive midpoint-subdivision "lightning" web
          const webDepth=3+Math.floor(audRmsV*2);
          const webLines=rc.cyMirror?8:4;
          const drawLightning=(c2d,x1,y1,x2,y2,d,dispAmt)=>{
            if(d<=0){
              const col=pickCol(Math.random(),0.7+audTrebV*0.25);
              c2d.strokeStyle=col;c2d.lineWidth=0.5+audBassV*1.2;
              c2d.globalAlpha=0.4+audRmsV*0.45;sg(c2d,col,3+audTrebV*10);
              c2d.beginPath();c2d.moveTo(x1,y1);c2d.lineTo(x2,y2);c2d.stroke();
              return;
            }
            const mx=(x1+x2)/2+(Math.random()-0.5)*dispAmt;
            const my=(y1+y2)/2+(Math.random()-0.5)*dispAmt;
            drawLightning(c2d,x1,y1,mx,my,d-1,dispAmt*0.55);
            drawLightning(c2d,mx,my,x2,y2,d-1,dispAmt*0.55);
            if(Math.random()<0.25+audBassV*0.3)
              drawLightning(c2d,mx,my,mx+(Math.random()-0.5)*dispAmt*1.8,my+(Math.random()-0.5)*dispAmt*1.8,d-2,dispAmt*0.4);
          };
          const disp=CX*(0.4+audRmsV*0.5)*scopeZ*amt;
          for(let w=0;w<webLines;w++){
            const a1=(w/webLines)*Math.PI*2+t*0.1;
            const a2=a1+Math.PI*(0.4+audMidV*0.3);
            const r=CX*(0.6+audBassV*0.25)*scopeZ;
            drawLightning(pCtx,CX+Math.cos(a1)*r,CY+Math.sin(a1)*r,CX+Math.cos(a2)*r*0.8,CY+Math.sin(a2)*r*0.8,webDepth,disp);
          }

        }else if(fStyle===4){
          // ── Snowflake: L-system Koch-like hexagonal fractal
          if(spSrc){
            const kDepth=2+Math.floor(audRmsV*2);
            const drawKoch=(c2d,x1,y1,x2,y2,d)=>{
              if(d===0){
                const si=Math.floor(Math.random()*spSrc.length*0.6);
                const energy=spSrc[si]||0;
                const col=pickCol(energy,0.5+energy*0.45);
                c2d.strokeStyle=col;c2d.lineWidth=0.8+energy*2;
                c2d.globalAlpha=0.4+energy*0.5;sg(c2d,col,2+energy*12+audTrebV*6);
                c2d.beginPath();c2d.moveTo(x1,y1);c2d.lineTo(x2,y2);c2d.stroke();
                return;
              }
              const dx=x2-x1,dy=y2-y1;
              const ax=x1+dx/3,ay=y1+dy/3;
              const bx=x1+2*dx/3,by=y1+2*dy/3;
              const ang=Math.atan2(dy,dx)-Math.PI/3;
              const len=Math.sqrt(dx*dx+dy*dy)/3;
              const cx2=ax+Math.cos(ang)*len,cy2=ay+Math.sin(ang)*len;
              const wobble=audBassV*len*0.3*Math.sin(t*2+d);
              drawKoch(c2d,x1,y1,ax,ay,d-1);
              drawKoch(c2d,ax,ay,cx2+wobble,cy2+wobble,d-1);
              drawKoch(c2d,cx2+wobble,cy2+wobble,bx,by,d-1);
              drawKoch(c2d,bx,by,x2,y2,d-1);
            };
            const arms=rc.cyMirror?6:3;
            const r=CX*(0.55+audBassV*0.2)*scopeZ;
            for(let a=0;a<arms;a++){
              const ang=(a/arms)*Math.PI*2+t*0.05;
              const px1=CX+Math.cos(ang)*r,py1=CY+Math.sin(ang)*r;
              const px2=CX+Math.cos(ang+Math.PI*2/arms)*r,py2=CY+Math.sin(ang+Math.PI*2/arms)*r;
              drawKoch(pCtx,px1,py1,px2,py2,kDepth);
            }
          }
        }

        pCtx.restore();pCtx.globalAlpha=1;pCtx.shadowBlur=0;
        applyInvert(pCtx);

      }else if(mode===8){
        // ── Neural Flow — liquid paths connecting vectorscope nodes ──────────
        const trails=rc.cyTrails??0.30;
        applyDecay(pCtx);
        pCtx.globalAlpha=1-trails;pCtx.fillStyle='#000';pCtx.fillRect(0,0,D,D);pCtx.globalAlpha=1;
        pCtx.save();pCtx.translate(CX,CY);pCtx.rotate(totalRot);pCtx.translate(-CX,-CY);
        drawGrid(pCtx);
        const nodeCount=12+Math.floor(aud.rms*8);
        const nodes=[];
        for(let i=0;i<nodeCount;i++){
          const idx=Math.floor((i/nodeCount)*N);
          const {x,y}=warpPt(CX+wL[idx]*SC,CY-wR[idx]*SC,CX,CY);
          nodes.push({x,y,e:(Math.abs(wL[idx])+Math.abs(wR[idx]))*0.5});
        }
        if(rc.cyMirror){nodes.slice(0,nodeCount).forEach(n=>nodes.push({x:D-n.x,y:D-n.y,e:n.e*0.5}));}
        for(let a=0;a<nodes.length;a++){
          for(let b=a+1;b<nodes.length;b++){
            const dx=nodes[a].x-nodes[b].x,dy=nodes[a].y-nodes[b].y;
            const dist=Math.sqrt(dx*dx+dy*dy);
            const thresh=CX*0.45*(0.5+aud.rms*0.5);
            if(dist>thresh)continue;
            const str=1-dist/thresh;
            const col=pickCol((a+b)/(nodes.length*2),str*0.7);
            pCtx.strokeStyle=col;pCtx.lineWidth=useThick?2:str*1.5;pCtx.globalAlpha=str*0.6*amt;sg(pCtx,col,4+str*10);
            const mx=(nodes[a].x+nodes[b].x)/2+Math.sin(t*0.8+a)*20*aud.mid;
            const my=(nodes[a].y+nodes[b].y)/2+Math.cos(t*0.6+b)*20*aud.mid;
            pCtx.beginPath();pCtx.moveTo(nodes[a].x,nodes[a].y);pCtx.quadraticCurveTo(mx,my,nodes[b].x,nodes[b].y);pCtx.stroke();
          }
        }
        nodes.forEach((n,i)=>{
          const col=pickCol(i/nodes.length);pCtx.fillStyle=col;pCtx.globalAlpha=0.8*(0.3+n.e*2);sg(pCtx,col,4+n.e*12);
          pCtx.beginPath();pCtx.arc(n.x,n.y,1.5+n.e*5*amt,0,Math.PI*2);pCtx.fill();
          if(useFilled){pCtx.globalAlpha=0.04;pCtx.beginPath();pCtx.arc(n.x,n.y,(1.5+n.e*5*amt)*4,0,Math.PI*2);pCtx.fill();}
        });
        pCtx.shadowBlur=0;pCtx.globalAlpha=1;pCtx.restore();applyInvert(pCtx);

      }else if(mode===9){
        // ── Shard Mirror — kaleidoscopic N-fold wedge decomposition ──────────
        cCtx.clearRect(0,0,D,D);
        if(rc.cyInvert){cCtx.fillStyle='#fff';cCtx.fillRect(0,0,D,D);}
        drawGrid(cCtx);
        const shards=rc.cyMirror?8:4;
        const segAngle=Math.PI*2/shards;
        cCtx.save();
        for(let s=0;s<shards;s++){
          cCtx.save();cCtx.translate(CX,CY);cCtx.rotate(s*segAngle+totalRot);
          cCtx.beginPath();cCtx.moveTo(0,0);cCtx.arc(0,0,SC,0,segAngle);cCtx.closePath();cCtx.clip();
          const step=Math.max(1,Math.floor(N/256));
          const pts=[];
          for(let i=0;i<N-1;i+=step)pts.push(warpPt(wL[i]*SC,-wR[i]*SC,0,0));
          if(useFilled&&pts.length>2){
            cCtx.beginPath();pts.forEach((p,i)=>i===0?cCtx.moveTo(p.x,p.y):cCtx.lineTo(p.x,p.y));cCtx.closePath();
            cCtx.fillStyle=pickCol(s/shards,0.12);cCtx.globalAlpha=1;sg(cCtx,pickCol(s/shards),8);cCtx.fill();
          }
          const col10=pickCol(s/shards,0.8);cCtx.strokeStyle=col10;cCtx.lineWidth=useThick?2:1.2;
          sg(cCtx,col10,6+aud.rms*10);cCtx.globalAlpha=0.75;
          cCtx.beginPath();pts.forEach((p,i)=>i===0?cCtx.moveTo(p.x,p.y):cCtx.lineTo(p.x,p.y));cCtx.stroke();
          cCtx.restore();
        }
        cCtx.restore();cCtx.globalAlpha=1;cCtx.shadowBlur=0;
      } // end mode===9


      // ── usePersist must be declared BEFORE post-rotation and symmetry ────────
      // pCtx (persistence buffer): 0,1,3,4,6,7,9  |  cCtx (clear each frame): 2,5,8,10,11,12
      const usePersist=mode===0||mode===1||mode===3||mode===4||mode===6||mode===7||mode===8;
      const srcCan=usePersist?cyPersistRef.current:cc;

      // ── Cymatic post-rotation: rotate the whole output canvas ─────────────
      // Skipped for mode 2 (3D Wave) which applies its own canvas spin internally.
      const cyPostAngle = livePostRotationAngleRef.current + rc.postRotationOffset;
      if(mode!==2 && Math.abs(cyPostAngle) > 0.0001 && rc.isCymatic && rc.cySymLink){
        if(!cyPostTempRef.current){cyPostTempRef.current=document.createElement('canvas');cyPostTempRef.current.width=D;cyPostTempRef.current.height=D;}
        const tmp=cyPostTempRef.current;
        const tCtx=tmp.getContext('2d');
        tCtx.globalCompositeOperation='source-over';tCtx.globalAlpha=1;
        tCtx.clearRect(0,0,D,D);
        tCtx.save();tCtx.translate(CX,CY);tCtx.rotate(cyPostAngle);tCtx.translate(-CX,-CY);
        tCtx.drawImage(srcCan,0,0);tCtx.restore();
        const wb=srcCan.getContext('2d');
        wb.globalCompositeOperation='source-over';wb.globalAlpha=1;
        wb.clearRect(0,0,D,D);wb.drawImage(tmp,0,0);
      }

      if(rc.cySymApply&&rc.isSymmetry){
        const sType=rc.symmetryType||1;
        const nFold=sType===1?2:sType===2?2:sType===3?3:sType===4?4:sType===5?3:sType===6?6:sType===7?8:sType===8?12:sType===9?6:sType===10?8:4;
        const symCan=cySymCanvasRef.current;
        const sCtx=symCan.getContext('2d');

        // ── Build symCan from ONLY the transformed copies (NOT the original) ──
        // The original trace is drawn separately so Hide Src can suppress it cleanly.
        // Each copy: full alpha, screen blend — bright, not dim.
        sCtx.clearRect(0,0,D,D);
        if(sType===1){
          // X mirror: one horizontally flipped copy
          sCtx.save();sCtx.globalAlpha=1;sCtx.globalCompositeOperation='source-over';
          sCtx.translate(D,0);sCtx.scale(-1,1);sCtx.drawImage(srcCan,0,0);
          sCtx.restore();
        }else if(sType===2){
          // Y mirror: one vertically flipped copy
          sCtx.save();sCtx.globalAlpha=1;sCtx.globalCompositeOperation='source-over';
          sCtx.translate(0,D);sCtx.scale(1,-1);sCtx.drawImage(srcCan,0,0);
          sCtx.restore();
        }else{
          // N-fold rotational: copies at angles 1..(nFold-1) — skip angle 0 (that's the original)
          for(let i=1;i<nFold;i++){
            const angle=(Math.PI*2/nFold)*i;
            sCtx.save();
            sCtx.globalCompositeOperation=i===1?'source-over':'screen';
            sCtx.globalAlpha=1;
            sCtx.translate(CX,CY);sCtx.rotate(angle);sCtx.translate(-CX,-CY);
            sCtx.drawImage(srcCan,0,0);sCtx.restore();
          }
        }
        sCtx.globalCompositeOperation='source-over';sCtx.globalAlpha=1;

        // ── Composite onto main visible canvas ──────────────────────────────
        ctx.globalCompositeOperation=rc.cyBlend||'screen';
        ctx.globalAlpha=amt;
        if(!rc.cySymHide){
          // Show raw trace first (underneath)
          ctx.drawImage(srcCan,0,0);
        }
        // Draw only the symmetry copies on top
        ctx.drawImage(symCan,0,0);
        ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';
      } else {
        // ── No symmetry — composite srcCan directly ─────────────────────────
        ctx.globalCompositeOperation=rc.cyBlend||'screen';
        ctx.globalAlpha=amt;
        ctx.drawImage(srcCan,0,0);
        ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';
      }

      // ── Mode 2 (3D Wave): rotate ctx AFTER composite so symmetry + trace spin together ──
      if(mode===2){
        const postAngle2=livePostRotationAngleRef.current+rc.postRotationOffset;
        const spin2=postAngle2+(rc.cySymLink?0:totalRot);
        if(Math.abs(spin2)>0.0001){
          if(!cyPostTempRef.current){cyPostTempRef.current=document.createElement('canvas');cyPostTempRef.current.width=D;cyPostTempRef.current.height=D;}
          const t2=cyPostTempRef.current;const x2=t2.getContext('2d');
          x2.clearRect(0,0,D,D);x2.save();x2.translate(CX,CY);x2.rotate(spin2);x2.translate(-CX,-CY);
          x2.drawImage(ctx.canvas,0,0);x2.restore();
          ctx.save();ctx.globalCompositeOperation='copy';ctx.drawImage(t2,0,0);ctx.restore();
        }
      }

    }

    // ── CoreFX: applied directly to visible canvas after blit ────────────────
    // Chroma / RGB Bloom
    if(rc.chromaEnabled&&!isAtBoundary){
      const shift=Math.round(rcChromaAmt*18)+1;
      if(rc.chromaRgbMode){
        // RGB Bloom: isolate each color channel via multiply, offset separately, screen-blend back
        // We need an offscreen canvas per channel
        if(!postEffectTempRef.current){postEffectTempRef.current=document.createElement('canvas');postEffectTempRef.current.width=DIMENSION;postEffectTempRef.current.height=DIMENSION;}
        const tCtx=postEffectTempRef.current.getContext('2d',{alpha:false,willReadFrequently:true});
        const src=postProcessCanvasRef.current;
        ctx.save();
        // Red channel: shift left, screen-add to display
        tCtx.globalCompositeOperation='copy';tCtx.drawImage(src,0,0);
        tCtx.globalCompositeOperation='multiply';tCtx.fillStyle='#ff0000';tCtx.fillRect(0,0,DIMENSION,DIMENSION);
        ctx.globalCompositeOperation='screen';ctx.globalAlpha=rcChromaAmt*0.9+0.1;
        ctx.drawImage(postEffectTempRef.current,-shift,0);
        // Green channel: slight up
        tCtx.globalCompositeOperation='copy';tCtx.drawImage(src,0,0);
        tCtx.globalCompositeOperation='multiply';tCtx.fillStyle='#00ff00';tCtx.fillRect(0,0,DIMENSION,DIMENSION);
        ctx.drawImage(postEffectTempRef.current,0,-Math.round(shift*0.5));
        // Blue channel: shift right
        tCtx.globalCompositeOperation='copy';tCtx.drawImage(src,0,0);
        tCtx.globalCompositeOperation='multiply';tCtx.fillStyle='#0000ff';tCtx.fillRect(0,0,DIMENSION,DIMENSION);
        ctx.drawImage(postEffectTempRef.current,shift,0);
        ctx.globalAlpha=1.0;ctx.globalCompositeOperation='source-over';ctx.restore();
      } else {
        // Diagonal lens aberration
        ctx.save();ctx.globalCompositeOperation='screen';ctx.globalAlpha=0.28;
        ctx.drawImage(postProcessCanvasRef.current,-shift,-shift);
        ctx.drawImage(postProcessCanvasRef.current,shift,shift);
        ctx.globalAlpha=1.0;ctx.globalCompositeOperation='source-over';ctx.restore();
      }
    }
    // Vignette: radial gradient overlay — inner starts at 0 (center), reaches edge + beyond for extreme darkness
    if(rc.vignetteEnabled){
      const cx=DIMENSION/2,cy=DIMENSION/2;
      // Inner radius shrinks with amt (tighter vignette at high settings)
      const innerR=DIMENSION*(0.35-rcVigAmt*0.35); // 0.35 at 0% → 0 at 100%
      const outerR=DIMENSION*(0.55+rcVigAmt*0.7);  // 0.55 at 0% → 1.25 at 100%
      const grad=ctx.createRadialGradient(cx,cy,innerR,cx,cy,outerR);
      grad.addColorStop(0,'rgba(0,0,0,0)');
      grad.addColorStop(1,`rgba(0,0,0,${Math.min(1,rcVigAmt*1.2)})`);
      ctx.fillStyle=grad;
      ctx.fillRect(0,0,DIMENSION,DIMENSION);
    }
    // Color Grade: CSS filter on canvas element (zero-cost pixel loop)
    if(rc.colorGradeEnabled){
      const hue=Math.round(rc.colorGradeHue*180);
      const sat=rc.colorGradeSat.toFixed(2);
      const bri=rc.colorGradeBri.toFixed(2);
      const filterStr=`hue-rotate(${hue}deg) saturate(${sat}) brightness(${bri})`;
      canvas.style.filter=filterStr;
      // Also apply to popout window canvas
      if(popoutWindowRef.current&&!popoutWindowRef.current.closed){
        const pc=popoutWindowRef.current.document.getElementById('v');
        if(pc)pc.style.filter=filterStr;
      }
    } else {
      if(canvas.style.filter)canvas.style.filter='';
      // Clear popout filter too
      if(popoutWindowRef.current&&!popoutWindowRef.current.closed){
        const pc=popoutWindowRef.current.document.getElementById('v');
        if(pc&&pc.style.filter)pc.style.filter='';
      }
    }

    // ── Scanlines: horizontal CRT line overlay ───────────────────────────────
    if(rc.scanlinesEnabled){
      const spacing=Math.round(2+rc.scanlinesSize*6); // 2–8px
      const darkness=0.55+rc.scanlinesAmt*0.4;
      ctx.fillStyle=`rgba(0,0,0,${darkness.toFixed(2)})`;
      for(let y=0;y<DIMENSION;y+=spacing){ctx.fillRect(0,y,DIMENSION,Math.max(1,Math.floor(spacing*0.45)));}
    }

    // ── Linocut: edge-detect + threshold → woodcut engraving look ──────────
    if(rc.linocutEnabled&&!isAtBoundary){
      const D2=DIMENSION;
      if(!pixelReadScratchRef.current){pixelReadScratchRef.current=document.createElement('canvas');pixelReadScratchRef.current.width=D2;pixelReadScratchRef.current.height=D2;}
      const tmp=pixelReadScratchRef.current;const tCtx=tmp.getContext('2d',{willReadFrequently:true});
      tCtx.drawImage(canvas,0,0);
      const id=tCtx.getImageData(0,0,D2,D2);const px=id.data;
      const thresh=Math.round(rc.linocutAmt*180)+20;
      // Sobel edge detect → darken edges (linocut = dark lines on light)
      const out=new Uint8ClampedArray(px.length);
      for(let i=0;i<px.length;i++)out[i]=px[i];
      for(let y=1;y<D2-1;y++){for(let x=1;x<D2-1;x++){
        const i=(y*D2+x)*4;
        const gx=(-px[(y-1)*D2*4+(x-1)*4]-2*px[y*D2*4+(x-1)*4]-px[(y+1)*D2*4+(x-1)*4]+px[(y-1)*D2*4+(x+1)*4]+2*px[y*D2*4+(x+1)*4]+px[(y+1)*D2*4+(x+1)*4]);
        const gy=(-px[(y-1)*D2*4+(x-1)*4]-2*px[(y-1)*D2*4+x*4]-px[(y-1)*D2*4+(x+1)*4]+px[(y+1)*D2*4+(x-1)*4]+2*px[(y+1)*D2*4+x*4]+px[(y+1)*D2*4+(x+1)*4]);
        const mag=Math.sqrt(gx*gx+gy*gy);
        if(mag>thresh){out[i]=0;out[i+1]=0;out[i+2]=0;out[i+3]=255;}
      }}
      id.data.set(out);tCtx.putImageData(id,0,0);
      ctx.drawImage(tmp,0,0);
    }

    // ── Halftone: sample luma → draw circles on grid ─────────────────────────
    if(rc.halftoneEnabled&&!isAtBoundary){
      const D2=DIMENSION;
      if(!pixelReadScratchRef.current){pixelReadScratchRef.current=document.createElement('canvas');pixelReadScratchRef.current.width=D2;pixelReadScratchRef.current.height=D2;}
      const tmp=pixelReadScratchRef.current;const tCtx=tmp.getContext('2d',{willReadFrequently:true});
      // Capture BEFORE blacking out ctx — avoids reading blacked canvas
      tCtx.drawImage(canvas,0,0);
      const id=tCtx.getImageData(0,0,D2,D2);const px=id.data;
      const grid=Math.round(3+rc.halftoneSize*11); // 3–14px grid
      // Now safe to black out
      ctx.fillStyle='#000';ctx.fillRect(0,0,D2,D2);
      for(let y=0;y<D2;y+=grid){for(let x=0;x<D2;x+=grid){
        const cx2=Math.min(x+Math.floor(grid/2),D2-1),cy2=Math.min(y+Math.floor(grid/2),D2-1);
        const i=(cy2*D2+cx2)*4;
        const luma=(px[i]*0.299+px[i+1]*0.587+px[i+2]*0.114)/255;
        const r2=luma*(grid*0.52);
        if(r2<0.5)continue;
        ctx.fillStyle=`rgb(${px[i]},${px[i+1]},${px[i+2]})`;
        ctx.beginPath();ctx.arc(x+grid/2,y+grid/2,r2,0,Math.PI*2);ctx.fill();
      }}
    }

    // ── Smear: directional motion-blur streak ────────────────────────────────
    if(rc.smearEnabled&&!isAtBoundary){
      const angle=rc.smearAngle*Math.PI*2;
      const dist=Math.round(2+rc.smearAmt*18);
      const dx=Math.round(Math.cos(angle)*dist),dy=Math.round(Math.sin(angle)*dist);
      const steps=Math.max(2,Math.round(dist*0.5));
      ctx.save();
      for(let s=1;s<=steps;s++){
        ctx.globalAlpha=0.18*(1-s/steps);
        ctx.drawImage(canvas,dx*(s/steps),dy*(s/steps));
      }
      ctx.globalAlpha=1;ctx.restore();
    }

    // ── Dot Matrix: pixelate to grid of uniform dots ─────────────────────────
    if(rc.dotMatrixEnabled&&!isAtBoundary){
      const D2=DIMENSION;
      if(!pixelReadScratchRef.current){pixelReadScratchRef.current=document.createElement('canvas');pixelReadScratchRef.current.width=D2;pixelReadScratchRef.current.height=D2;}
      const tmp=pixelReadScratchRef.current;const tCtx=tmp.getContext('2d',{willReadFrequently:true});
      tCtx.drawImage(canvas,0,0);
      const id=tCtx.getImageData(0,0,D2,D2);const px=id.data;
      const grid=Math.round(4+rc.dotMatrixSize*12); // 4–16px cells
      ctx.fillStyle='#000';ctx.fillRect(0,0,D2,D2);
      const r2=grid*0.42;
      for(let y=0;y<D2;y+=grid){for(let x=0;x<D2;x+=grid){
        // Average color over cell
        let rr=0,gg=0,bb=0,cnt=0;
        for(let dy2=0;dy2<grid&&y+dy2<D2;dy2++){for(let dx2=0;dx2<grid&&x+dx2<D2;dx2++){
          const i=((y+dy2)*D2+(x+dx2))*4;rr+=px[i];gg+=px[i+1];bb+=px[i+2];cnt++;
        }}
        if(cnt){rr/=cnt;gg/=cnt;bb/=cnt;}
        ctx.fillStyle=`rgb(${Math.round(rr)},${Math.round(gg)},${Math.round(bb)})`;
        ctx.beginPath();ctx.arc(x+grid/2,y+grid/2,r2,0,Math.PI*2);ctx.fill();
      }}
    }

    if(!preSnapRawRef._ctx)preSnapRawRef._ctx=preSnapRawRef.current.getContext('2d',{alpha:false,willReadFrequently:true});
    preSnapRawRef._ctx.globalCompositeOperation='copy';preSnapRawRef._ctx.drawImage(rawCanvasRef.current,0,0);
    if(doStats&&sumCount>0)pendingStatsRef.current={brightness:(sumR+sumG+sumB)/(3*sumCount*255),r:sumR/sumCount,g:sumG/sumCount,b:sumB/sumCount};
  };

  const isRotationRef=useRef(false);
  useEffect(()=>{isRotationRef.current=isRotation;},[isRotation]);

  const animate=()=>{
    if(animationRef.current)cancelAnimationFrame(animationRef.current);
    let statsDue=false;let progressDue=false;let beatWas=beatFlashRef.current;let entropyActivWas=isEntropyActiveRef.current;
    const loop=now=>{
      if(lastTimeRef.current===0)lastTimeRef.current=now;
      const rc=R.current;
      const rawDt=now-lastTimeRef.current;
      lastTimeRef.current=now;
      // Clamp to max 100ms (avoids giant jumps from tab-hidden wakeup)
      // but use real dt otherwise — do NOT cap to 16ms because that causes
      // the near-zero next-dt stutter we already fought to fix
      const dt=Math.min(rawDt,100);
      timeRef.current+=dt*.001;
      frameCountRef.current++;

      // ── Audio tick + routing ─────────────────────────────────────────────────
      if(analyserRef.current)tickAudio(dt,rc);
      const aud=audBusRef.current;
      if(aud.active&&now-audLevelsLastRef.current>150){
        audLevelsLastRef.current=now;
        setAudLevels({bass:aud.bass,sub:aud.sub||0,low:aud.low||0,mid:aud.mid,treble:aud.treble,rms:aud.rms,beat:aud.beat,lufs:aud.lufs??-70,lufsNorm:aud.lufsNorm??0,lufsInt:aud.lufsInt??-70});
      }
      const mod=audModRef.current;
      // Decay all mod values toward 0 each frame (exponential decay, ~200ms half-life)
      const decay=Math.pow(0.985, dt/16.67);
      for(const k in mod)mod[k]*=decay;

      // ── LFO tick ─────────────────────────────────────────────────────────────
      const lfoVals=[0,0,0,0];
      const lfoBank=lfosRef.current;
      const bpmHz=(rc.bpm||120)/60;
      for(let i=0;i<4;i++){
        const l=lfoBank[i];
        if(!l.enabled){lfoVals[i]=0;continue;}
        const hz=l.bpmSync?(bpmHz/(l.bpmDiv||1)):(0.05*Math.pow(40,l.rate||0.3));
        lfoPhaseRef.current[i]=(lfoPhaseRef.current[i]+(hz*dt*0.001))%1;
        const ph=lfoPhaseRef.current[i];
        let raw=0;
        const shape=l.shape||0;
        if(shape===0)raw=Math.sin(ph*Math.PI*2)*0.5+0.5;             // Sine  0–1
        else if(shape===1)raw=ph<0.5?ph*2:2-ph*2;                    // Tri   0–1
        else if(shape===2)raw=ph<0.5?1:0;                            // Square
        else if(shape===3)raw=ph;                                     // Saw   0–1
        else if(shape===4)raw=1-ph;                                   // RevSaw
        else{// Sample & Hold
          if(now-lfoSHTrigRef.current[i]>1000/hz){lfoSHRef.current[i]=Math.random();lfoSHTrigRef.current[i]=now;}
          raw=lfoSHRef.current[i];
        }
        lfoVals[i]=raw*(l.depth||0.7);
      }
      lfoValsRef.current=[...lfoVals];

      // ── Pin matrix routing ────────────────────────────────────────────────────
      const pins=audPinsRef.current;
      const ranges=lfoRangesRef.current;
      // Gather source values (audio + LFOs)
      const srcVals={
        bass: aud.active?aud.bass:0,
        sub:  aud.active?(aud.sub||0):0,
        low:  aud.active?(aud.low||0):0,
        mid:  aud.active?aud.mid:0,
        treble:aud.active?aud.treble:0,
        rms:  aud.active?aud.rms:0,
        beat: aud.active&&aud.beat?1:0,
        lufs: aud.active?aud.lufsNorm:0,
        lfo1: lfoVals[0], lfo2: lfoVals[1], lfo3: lfoVals[2], lfo4: lfoVals[3],
      };
      // Scale factors per target (additive mode — used when no LFO range bracket is set or for audio sources)
      const TGT_SCALE={zoom:1.2,rotation:0.4,postRot:0.3,entropy:0.9,fluxAmp:0.8,chroma:0.7,symPhase:0.5,symType:1,glyphPull:0.6,vignette:0.9,prismatic:0.7,smoke:0.8,trails:0.6,speed:0.5,bpm:20,flash:1,warpAmt:0.8,fieldAmt:0.9,glitchAmt:0.8,retroAmt:0.7};
      // Accumulate contributions into mod bus
      const AUD_SRC_KEYS=['bass','sub','low','mid','treble','rms','beat','lufs','lfo1','lfo2','lfo3','lfo4'];
      // For LFO→rangeable targets: compute the highest LFO output per target (depth-scaled 0..depth)
      // then use absolute lerp: actual_value = lerp(lo_abs, hi_abs, lfoNorm)
      // We store the desired absolute value in mod as a special marker (NaN sentinel not needed —
      // instead we write the direct absolute value override into a separate lfoAbsRef each frame
      // and read it in renderFrame).
      const lfoAbsOverrides={}; // tgt → absolute value (overrides rc[stateKey] in renderFrame)
      const RANGEABLE_TARGETS=['zoom','rotation','postRot','entropy','fluxAmp','chroma','glyphPull','vignette','prismatic','smoke','trails','speed','warpAmt','fieldAmt','glitchAmt','retroAmt'];
      for(const tgt of RANGEABLE_TARGETS){
        const rng=ranges[tgt];if(!rng)continue;
        // Find max LFO value across all LFOs pinned to this target
        let lfoOut=0;
        for(let i=0;i<4;i++){
          const lfoKey='lfo'+(i+1);
          if(pins[lfoKey]?.[tgt]){
            lfoOut=Math.max(lfoOut,lfoVals[i]||0);
          }
        }
        if(lfoOut===0)continue;
        // lfoOut is depth-scaled (0..depth). Normalise back to 0..1 for lerp position
        const maxDepth=Math.max(...lfosRef.current.filter((_,i)=>pins['lfo'+(i+1)]?.[tgt]).map(l=>l.depth||0.7),0.001);
        const t=lfoOut/maxDepth; // 0..1 — position within the range brackets
        const meta=TGT_SLIDER_META?.[tgt];
        if(!meta)continue;
        const loAbs=meta.min+(meta.max-meta.min)*rng.lo;
        const hiAbs=meta.min+(meta.max-meta.min)*rng.hi;
        lfoAbsOverrides[tgt]=loAbs+(hiAbs-loAbs)*t;
      }
      lfoAbsRef.current=lfoAbsOverrides;

      for(const src of AUD_SRC_KEYS){
        const sv=srcVals[src];
        if(!sv)continue;
        const row=pins[src];if(!row)continue;
        const isLfo=src.startsWith('lfo');
        // For LFO sources with range brackets, absolute override handles it — skip additive mod
        if(row.zoom&&!(isLfo&&lfoAbsOverrides.zoom!==undefined))       mod.zoom      =Math.min(1.5,mod.zoom      +sv*TGT_SCALE.zoom);
        if(row.rotation&&!(isLfo&&lfoAbsOverrides.rotation!==undefined)) mod.rotation =Math.min(0.5,mod.rotation  +sv*TGT_SCALE.rotation);
        if(row.postRot&&!(isLfo&&lfoAbsOverrides.postRot!==undefined))   mod.postRotation=Math.min(0.5,mod.postRotation+sv*TGT_SCALE.postRot);
        if(row.entropy&&!(isLfo&&lfoAbsOverrides.entropy!==undefined))   mod.entropy   =Math.min(1,mod.entropy    +sv*TGT_SCALE.entropy);
        if(row.fluxAmp&&!(isLfo&&lfoAbsOverrides.fluxAmp!==undefined))   mod.flux      =Math.min(0.8,mod.flux     +sv*TGT_SCALE.fluxAmp);
        if(row.chroma&&!(isLfo&&lfoAbsOverrides.chroma!==undefined))     mod.chroma    =Math.min(0.8,mod.chroma   +sv*TGT_SCALE.chroma);
        if(row.symPhase)  mod.symPhase  =Math.min(2,mod.symPhase    +sv*TGT_SCALE.symPhase);
        if(row.glyphPull&&!(isLfo&&lfoAbsOverrides.glyphPull!==undefined)) mod.glyph  =Math.min(0.8,mod.glyph    +sv*TGT_SCALE.glyphPull);
        if(row.vignette&&!(isLfo&&lfoAbsOverrides.vignette!==undefined))  mod.vignette =Math.min(0.8,mod.vignette +sv*TGT_SCALE.vignette);
        if(row.prismatic&&!(isLfo&&lfoAbsOverrides.prismatic!==undefined)) mod.prismatic=Math.min(0.8,mod.prismatic+sv*TGT_SCALE.prismatic);
        if(row.smoke&&!(isLfo&&lfoAbsOverrides.smoke!==undefined))        mod.smoke    =Math.min(0.8,mod.smoke    +sv*TGT_SCALE.smoke);
        if(row.trails&&!(isLfo&&lfoAbsOverrides.trails!==undefined))      mod.trails   =Math.min(0.8,mod.trails   +sv*TGT_SCALE.trails);
        if(row.speed&&!(isLfo&&lfoAbsOverrides.speed!==undefined))        mod.speed    =Math.min(0.6,mod.speed    +sv*TGT_SCALE.speed);
        if(row.bpm)       mod.bpm       =Math.min(60,mod.bpm        +sv*TGT_SCALE.bpm);
        // Beat/flash: only on transient beat signal, not continuous sources
        if(row.flash&&src==='beat'&&sv>0.5) setCyBeatFlash(true);
        if(row.symType&&src==='beat'&&sv>0.5) mod.symPhase=Math.min(3,mod.symPhase+1.2);
        // Warp / Field / Glitch / Retro — new pre-sym modules
        if(row.warpAmt&&!(isLfo&&lfoAbsOverrides.warpAmt!==undefined))    mod.warpAmt  =Math.min(1,mod.warpAmt  +sv*TGT_SCALE.warpAmt);
        if(row.fieldAmt&&!(isLfo&&lfoAbsOverrides.fieldAmt!==undefined))   mod.fieldAmt =Math.min(1,mod.fieldAmt +sv*TGT_SCALE.fieldAmt);
        if(row.glitchAmt&&!(isLfo&&lfoAbsOverrides.glitchAmt!==undefined)) mod.glitchAmt=Math.min(1,mod.glitchAmt+sv*TGT_SCALE.glitchAmt);
        if(row.retroAmt&&!(isLfo&&lfoAbsOverrides.retroAmt!==undefined))   mod.retroAmt =Math.min(1,mod.retroAmt +sv*TGT_SCALE.retroAmt);
      }

      // ── State updates: batch and throttle so React re-renders don't stall canvas ──
      // Progress bar: update at most every 150ms, not every 6 frames
      if(isMorphingRef.current){
        if(now-progressRef._lastUIUpdate>150){
          progressDue=true;
          progressRef._lastUIUpdate=now;
        }
      }
      // Stats: every 500ms
      if(now-(pendingStatsRef._lastUIUpdate||0)>500&&pendingStatsRef.current){
        statsDue=true;
        pendingStatsRef._lastUIUpdate=now;
      }

      const getBeat=bv=>{const ms=60000/bv;return(now%ms)<(ms/2);};

      // Beat flash — only trigger setState on edge transition, not every frame
      if(rc.bpmEnabled){
        const on=getBeat(rc.bpm);
        if(on!==beatWas){beatWas=on;beatFlashRef.current=on;setBeatFlash(on);}
      }

      const eActive=rc.isEntropy&&(rc.entropyBpmMode==='steady'||(rc.entropyBpmMode==='global'&&rc.bpmEnabled&&getBeat(rc.bpm))||(rc.entropyBpmMode==='manual'&&getBeat(rc.entropyManualBpm)));
      if(eActive!==entropyActivWas){entropyActivWas=eActive;isEntropyActiveRef.current=eActive;setIsEntropyActive(eActive);if(eActive)driftLiveRef.current=true;}

      // Phase advances
      if(rc.isFlux&&rc.fluxTimeline==='free'){
        const ok=!rc.fluxBpmSync||!rc.bpmEnabled||getBeat(rc.bpm);
        if(ok)fluxPhaseRef.current+=(dt*.001)*(0.2*Math.pow(20,rc.fluxRate))*Math.PI*2;
      }
      if(rc.isAlch&&rc.alchTimeline==='free')alchPhaseRef.current+=(dt*.001)*(0.2*Math.pow(20,rc.alchRate))*Math.PI*2;
      if(rc.glyphLfoEnabled){
        if(rc.glyphLfoPull)glyphLfoPullPhaseRef.current+=(dt*.001)*(0.1*Math.pow(30,rc.glyphLfoRatePull))*Math.PI*2;
        if(rc.glyphLfoAmp)glyphLfoAmpPhaseRef.current+=(dt*.001)*(0.1*Math.pow(30,rc.glyphLfoRateAmp))*Math.PI*2;
      }
      if(rc.isSymmetry&&rc.symAnimAxes)symAnimAngleRef.current+=(dt*.001)*rc.symAnimRate;

      // Entropy — only iterate pixels if entropy is actually doing something
      if(rc.isEntropy&&pixelsRef.current.length>0){
        const type=rc.entropyType,str=rc.entropyStr,tt=timeRef.current;
        if(type===5){const oc=orbitCenterRef.current;oc.x+=oc.vx;oc.y+=oc.vy;if(oc.x<20||oc.x>280)oc.vx*=-1;if(oc.y<20||oc.y>280)oc.vy*=-1;}
        for(let _i=0;_i<pixelsRef.current.length;_i++){
          const px=pixelsRef.current[_i];
          if(eActive){
            if(type===0){px.vx+=(Math.random()-.5)*2.5*str;px.vy+=(Math.random()-.5)*2.5*str;}
            else if(type===1){const d=Math.sqrt(px.driftX*px.driftX+px.driftY*px.driftY)||1;px.vx+=(px.driftX/d)*1.5*str;px.vy+=(px.driftY/d)*1.5*str;}
            else if(type===2){px.vx+=1.5*str;px.vy+=Math.sin(now*.005+px.y*.025)*str;}
            else if(type===3){px.vx+=(Math.random()-.5)*8*str;px.vy+=(Math.random()-.5)*8*str;}
            else if(type===4){const luma=(px.r*.299+px.g*.587+px.b*.114)/255;const f=(luma-.5)*3*str;const dx=150-(px.x+px.driftX),dy=150-(px.y+px.driftY);const dist=Math.sqrt(dx*dx+dy*dy)||1;px.vx+=(dx/dist)*f;px.vy+=(dy/dist)*f;const hue=Math.atan2(px.b-px.g,px.r-px.b);px.vx+=Math.cos(hue+tt)*.5*str;px.vy+=Math.sin(hue+tt)*.5*str;}
            else if(type===5){const oc=orbitCenterRef.current;const dx=(px.x+px.driftX)-oc.x,dy=(px.y+px.driftY)-oc.y;const dist=Math.sqrt(dx*dx+dy*dy)||1;px.vx+=(-dy/dist)*2*str;px.vy+=(dx/dist)*2*str;const tR=50+35*Math.sin(tt*.4);px.vx+=(dx/dist)*(tR-dist)*.012*str;px.vy+=(dy/dist)*(tR-dist)*.012*str;}
            driftLiveRef.current=true;px.driftX+=px.vx;px.driftY+=px.vy;
            const damp=.86+.1*(1-1/((px.mass||1)*.5+.5));px.vx*=damp;px.vy*=damp;
            if(px.x+px.driftX<0)px.driftX=-px.x;if(px.x+px.driftX>DIMENSION)px.driftX=DIMENSION-px.x;
            if(px.y+px.driftY<0)px.driftY=-px.y;if(px.y+px.driftY>DIMENSION)px.driftY=DIMENSION-px.y;
          }else{px.driftX*=.94;px.driftY*=.94;if(Math.abs(px.driftX)<.01)px.driftX=0;if(Math.abs(px.driftY)<.01)px.driftY=0;}
        }
      } else if(driftLiveRef.current){
        let any=false;
        for(let i=0;i<pixelsRef.current.length;i++){const px=pixelsRef.current[i];if(px.driftX!==0||px.driftY!==0){px.driftX*=.95;px.driftY*=.95;px.vx*=.9;px.vy*=.9;if(Math.abs(px.driftX)<.01)px.driftX=0;if(Math.abs(px.driftY)<.01)px.driftY=0;if(px.driftX!==0||px.driftY!==0)any=true;}}
        driftLiveRef.current=any;
      }

      const sm=rc.rotationBoost?.2:.05;
      if(rc.isRotation){const d=rc.rotationSpeed-.5;rotationAngleRef.current+=Math.sign(d)*Math.pow(Math.abs(d)*2,2)*sm;}
      if(rc.isPostRotation){const d=rc.postRotationSpeed-.5;livePostRotationAngleRef.current+=Math.sign(d)*Math.pow(Math.abs(d)*2,2)*sm;}

      if(isMorphingRef.current&&!isPausedRef.current){
        const _modSpeed=audModRef.current.speed||0;
        const rcDuration=Math.max(200,(rc.duration||3000)*(1-Math.min(0.8,_modSpeed)));
        let nextP=progressRef.current+(dt/rcDuration)*loopDirectionRef.current;
        const minP=rc.splitMargin?(rc.marginA||0)/100:(rc.pixelationMargin||0)/100;
        const maxP=rc.splitMargin?1-(rc.marginB||0)/100:1-(rc.pixelationMargin||0)/100;
        let bounced=false;
        if(nextP>=maxP){nextP=maxP;if(rc.isLooping){loopDirectionRef.current=-1;bounced=true;}else{isMorphingRef.current=false;setIsMorphing(false);}}
        else if(nextP<=minP){nextP=minP;if(rc.isLooping){loopDirectionRef.current=1;bounced=true;}else{isMorphingRef.current=false;setIsMorphing(false);}}
        progressRef.current=nextP;
        if(mediaRecorderRef.current?.state==='recording'){
          const mv2A=rc.splitMargin?(rc.marginA||0)/100:(rc.pixelationMargin||0)/100;
          const mv2B=rc.splitMargin?(rc.marginB||0)/100:(rc.pixelationMargin||0)/100;
          const lo2=mv2A,hi2=1-mv2B,mid2=(lo2+hi2)/2;
          if(rc.recCycle){if(bounced){recCycleCountRef.current++;if(recCycleCountRef.current>=1){const iF=rc.recIn==='A'?lo2:rc.recIn==='B'?hi2:mid2;if(Math.abs(nextP-iF)<.01){mediaRecorderRef.current.stop();setIsRecording(false);}}}}
          else if(rc.recOut!=='free'){const oF=rc.recOut==='A'?lo2:rc.recOut==='B'?hi2:mid2;if(loopDirectionRef.current>0?(nextP>=oF):(nextP<=oF)){mediaRecorderRef.current.stop();setIsRecording(false);}}
        }
      }

      try{renderFrame(progressRef.current);}catch(e){console.error('[PixelAlchemist] renderFrame error:',e);}

      // Drive progress bar fill directly — bypasses React, updates every frame
      if(progressBarFillRef.current){
        progressBarFillRef.current.style.width=`${Math.max(0,Math.min(1,progressRef.current))*100}%`;
      }

      // Flush deferred React state updates AFTER render, so they don't stall it
      if(progressDue){setProgress(Math.max(0,Math.min(1,progressRef.current))*100);progressDue=false;}
      if(statsDue&&pendingStatsRef.current){setCurrentStats(pendingStatsRef.current);pendingStatsRef.current=null;statsDue=false;}

      animationRef.current=requestAnimationFrame(loop);
    };
    progressRef._lastUIUpdate=0;
    animationRef.current=requestAnimationFrame(loop);
  };

  const pushUndo=()=>setUndoStack(s=>[...s.slice(-9),{imageA,imageB,statsA,statsB}]);
  const handleUndo=()=>setUndoStack(s=>{if(!s.length)return s;const p=s[s.length-1];setImageA(p.imageA);setImageB(p.imageB);setStatsA(p.statsA);setStatsB(p.statsB);return s.slice(0,-1);});
  useEffect(()=>{const h=e=>{if((e.ctrlKey||e.metaKey)&&e.key==='z'){e.preventDefault();handleUndo();}};window.addEventListener('keydown',h);return()=>window.removeEventListener('keydown',h);},[undoStack]);

  const tapRef=useRef([]);const eTapRef=useRef([]);const tTapRef=useRef([]);
  const tap=(ref,set)=>{const now=performance.now();const r=ref.current.filter(t=>now-t<3000);r.push(now);ref.current=r;if(r.length>=2){const avg=r.slice(1).reduce((a,t,i)=>a+(t-r[i]),0)/(r.length-1);set(Math.max(20,Math.min(300,Math.round(60000/avg))));} };

  const handleUpload=async(e,side)=>{const file=e.target.files?.[0];if(!file)return;pushUndo();const url=URL.createObjectURL(file);const {stats}=await getPixelData(url,side==='A'?gradeA:gradeB);side==='A'?(setImageA(url)||setStatsA(stats)):(setImageB(url)||setStatsB(stats));};
  const handlePreset=async(type,side)=>{pushUndo();const url=applyPreset(type,DIMENSION);const {stats}=await getPixelData(url,side==='A'?gradeA:gradeB);side==='A'?(setImageA(url)||setStatsA(stats)):(setImageB(url)||setStatsB(stats));};
  const swapImages=()=>{if(isSwapping)return;pushUndo();setIsSwapping(true);setTimeout(()=>{const ti=imageA,ts=statsA;setImageA(imageB);setStatsA(statsB);setImageB(ti);setStatsB(ts);},250);setTimeout(()=>setIsSwapping(false),500);};
  // Render current glyph text as a white-on-black source image
  const renderTextToSource=async(side)=>{
    pushUndo();
    const c=document.createElement('canvas');c.width=DIMENSION;c.height=DIMENSION;
    const cx=c.getContext('2d');
    cx.fillStyle='#000';cx.fillRect(0,0,DIMENSION,DIMENSION);
    cx.fillStyle='#fff';
    let sz=80;
    while(sz>10){cx.font=`900 ${sz}px monospace`;if(cx.measureText(textPhraseInput).width<DIMENSION-16)break;sz-=2;}
    cx.textAlign='center';cx.textBaseline='middle';cx.fillText(textPhraseInput,DIMENSION/2,DIMENSION/2);
    const url=c.toDataURL('image/png');
    const {stats}=await getPixelData(url);
    if(side==='A'){setImageA(url);setStatsA(stats);}else{setImageB(url);setStatsB(stats);}
  };
  const startMorph=()=>{if(!imageA||!imageB)return;const mv=splitMargin?marginA/100:pixelationMargin/100;progressRef.current=mv;loopDirectionRef.current=1;clearFeedbackBuffers();isPausedRef.current=false;setIsPaused(false);setIsMorphing(true);isMorphingRef.current=true;lastTimeRef.current=0;animate();};
  const togglePause=()=>{const n=!isPaused;setIsPaused(n);isPausedRef.current=n;if(!n)lastTimeRef.current=0;};
  const handleProgressClick=e=>{const bar=progressBarRef.current;if(!bar)return;const rect=bar.getBoundingClientRect();const frac=Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width));const lo=splitMargin?marginA/100:pixelationMargin/100;const hi=splitMargin?1-marginB/100:1-pixelationMargin/100;const c=lo+frac*(hi-lo);progressRef.current=c;setProgress(c*100);renderFrame(c);};
  const exportFrame=()=>{const canvas=canvasRef.current;if(!canvas)return;const link=document.createElement('a');link.download=`pixel-alchemist-frame-${Date.now()}.png`;link.href=canvas.toDataURL('image/png');link.click();setExportStatus('✓ Frame saved!');setTimeout(()=>setExportStatus(''),2000);};
  const startRecording=()=>{
    const canvas=canvasRef.current;if(!canvas)return;
    const mv=pixelationMargin/100;
    const lo=splitMargin?marginA/100:mv;
    const hi=splitMargin?1-marginB/100:1-mv;
    const mid=(lo+hi)/2;
    const res=v=>v==='A'?lo:v==='B'?hi:v==='mid'?mid:null;
    const inPt=res(recIn);
    if(inPt!==null){progressRef.current=inPt;setProgress(inPt*100);const outPt=res(recOut);if(outPt!==null&&inPt>outPt)loopDirectionRef.current=-1;else loopDirectionRef.current=1;if(!isMorphingRef.current){clearFeedbackBuffers();isMorphingRef.current=true;setIsMorphing(true);isPausedRef.current=false;setIsPaused(false);lastTimeRef.current=0;animate();}}
    recCycleCountRef.current=0;
    const stream=canvas.captureStream(30);
    let opts;
    if(MediaRecorder.isTypeSupported('video/webm;codecs=vp9'))opts={mimeType:'video/webm;codecs=vp9',videoBitsPerSecond:25000000};
    else if(MediaRecorder.isTypeSupported('video/webm;codecs=vp8'))opts={mimeType:'video/webm;codecs=vp8',videoBitsPerSecond:20000000};
    else opts={mimeType:'video/webm',videoBitsPerSecond:15000000};
    const recorder=new MediaRecorder(stream,opts);recordedChunksRef.current=[];
    recorder.ondataavailable=e=>{if(e.data.size>0)recordedChunksRef.current.push(e.data);};
    recorder.onstop=()=>{
      const blob=new Blob(recordedChunksRef.current,{type:'video/webm'});
      const url=URL.createObjectURL(blob);const link=document.createElement('a');
      link.download=`pixel-alchemist-${Date.now()}.webm`;link.href=url;link.click();URL.revokeObjectURL(url);
      setExportStatus('✓ WebM saved!');setTimeout(()=>setExportStatus(''),3000);
    };
    recorder.start(100);mediaRecorderRef.current=recorder;setIsRecording(true);setExportStatus('● REC');
  };
  const stopRecording=()=>{if(mediaRecorderRef.current?.state&&mediaRecorderRef.current.state!=='inactive')mediaRecorderRef.current.stop();setIsRecording(false);};
  const resetModule=()=>{setIsRotation(false);setIsPostRotation(false);setRotationSpeed(.5);setPostRotationSpeed(.5);setRotationBoost(false);setPostRotationOffset(0);rotationAngleRef.current=0;livePostRotationAngleRef.current=0;setZoom(1.0);setResetModuleFlash(true);setTimeout(()=>setResetModuleFlash(false),300);};

  // ── RENDER SECTIONS ──────────────────────────────────────────────────────────

  const engineFX=(()=>{
    /* ── Helper: current mode label strings ─────────────────────────────── */
    const symLabel=[,'X-Mirror','Y-Mirror','Tri','Quad','K3','K6','K8','K12','Fan','Radial','Tile','Shard'][symmetryType]||'—';
    const entropyLabel=['Walk','Pulse','Drift','Chaos','Magnet','Orbit'][entropyType]||'—';
    const prismLabel=PRISM_TYPES.find(m=>m.id===alchType)?.label||'—';
    const fluxLabel=['Wave','Vortex','Pull','Shear','Noise','Twist','Glass','Ripple'][fluxMode]||'—';
    const motionLabel=['Static','Breath','Wave','Scatter','Orbit'][textMotion]||'—';

    return (
    <div className="bg-zinc-900/40 border border-zinc-800 rounded-2xl p-4" style={{position:"relative"}}>
      <SectionLabel accent="text-orange-400 border-orange-500/40 bg-orange-500/10">ENGINEFX</SectionLabel>

      {(()=>{
        const moduleCards={
      0: ()=>(
          <EngineFlipCard
            id="transform" collapsed={collapsed.transform}
            onToggleCollapse={()=>toggleCollapse('transform')}
            label="Transform" active={isRotation||isPostRotation} onToggle={()=>setIsRotation(v=>!v)}
            color="#3b82f6" bgColor="#172554" borderColor={isRotation||isPostRotation?"#3b82f6":"#27272a"} glowColor="#3b82f6"
            modeKey={null} modeLabel={isRotation&&isPostRotation?"PRE+POST":isRotation?"PRE":"POST"}
            frontBottomContent={<>
              <div style={{display:'flex',gap:6,justifyContent:'space-between',marginBottom:4}}>
                {[['PRE',preRotDeg,rotationAngleRef,setPreRotDeg],['POST',postRotDeg,livePostRotationAngleRef,setPostRotDeg]].map(([lbl,deg,ref,setDeg])=>(
                  <div key={lbl} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:1}}>
                    <span style={{fontSize:5.5,fontWeight:900,textTransform:'uppercase',color:'#6b7280'}}>{lbl}</span>
                    <svg width={28} height={28} style={{cursor:'pointer'}} onDoubleClick={()=>{ref.current=0;setDeg(0);renderFrame(progressRef.current);}}>
                      <circle cx={14} cy={14} r={11} fill="none" stroke="#27272a" strokeWidth={1.5}/>
                      <line x1={14} y1={14} x2={14+Math.sin(deg*Math.PI/180)*9} y2={14-Math.cos(deg*Math.PI/180)*9} stroke="#3b82f6" strokeWidth={1.5} strokeLinecap="round"/>
                      <circle cx={14} cy={14} r={2} fill="#3b82f6" fillOpacity={0.8}/>
                    </svg>
                    <span style={{fontSize:5,fontWeight:900,color:deg!==0?'#3b82f6':'#52525b',fontVariantNumeric:'tabular-nums'}}>{deg}°</span>
                  </div>
                ))}
                <div style={{flex:1,display:'flex',flexDirection:'column',justifyContent:'center',gap:2}}>
                  <span style={{fontSize:5.5,fontWeight:900,textTransform:'uppercase',color:'#6b7280'}}>Zoom</span>
                  <span style={{fontSize:7,fontWeight:900,color:'#3b82f6',fontVariantNumeric:'tabular-nums'}}>{zoom.toFixed(2)}×</span>
                  <FSlider value={zoom} min={0.25} max={3.0} step={0.01} onChange={setZoom} defaultVal={1.0} color="#3b82f6" enabled={true}/>
                </div>
              </div>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#6b7280'}}>Speed</span>
                <span style={{fontSize:7,fontWeight:900,color:isRotation?'#3b82f6':'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round((rotationSpeed-.5)*200)}%</span>
              </div>
              <FSlider value={rotationSpeed} min={0} max={1} step={0.001} onChange={setRotationSpeed} defaultVal={0.5} color="#3b82f6" enabled={isRotation} {...lfoRP("rotation")}/>
            </>}
            backContent={<>
              <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',marginBottom:5}}>Pre-Sym Auto</div>
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}><span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}>CCW</span><button onClick={()=>setIsRotation(!isRotation)} style={{minWidth:36,height:20,borderRadius:5,border:`1px solid ${isRotation?'#3b82f688':'#3f3f46'}`,background:isRotation?'#3b82f622':'rgba(0,0,0,0.5)',color:isRotation?'#3b82f6':'#71717a',fontSize:7,fontWeight:900,cursor:'pointer'}}>{isRotation?'ON':'OFF'}</button><span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}>CW</span></div>
              <FSlider value={rotationSpeed} min={0} max={1} step={0.001} onChange={setRotationSpeed} defaultVal={0.5} color="#3b82f6" enabled={isRotation} {...lfoRP("rotation")}/>
              <div style={{display:'flex',gap:4,marginTop:4,marginBottom:10}}>
                {[{l:'−S',v:.45},{l:'●',v:.5},{l:'+S',v:.55}].map(p=>(<button key={p.l} onClick={()=>setRotationSpeed(p.v)} style={{flex:1,padding:'4px 0',borderRadius:5,border:`1px solid ${rotationSpeed===p.v?'#3b82f6':'#3f3f46'}`,background:rotationSpeed===p.v?'#3b82f622':'rgba(0,0,0,0.3)',color:rotationSpeed===p.v?'#93c5fd':'#71717a',fontSize:7,fontWeight:900,cursor:'pointer'}}>{p.l}</button>))}
              </div>
              <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',marginBottom:5}}>Post-Fx Auto</div>
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}><span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}>CCW</span><button onClick={()=>setIsPostRotation(!isPostRotation)} style={{minWidth:36,height:20,borderRadius:5,border:`1px solid ${isPostRotation?'#3b82f688':'#3f3f46'}`,background:isPostRotation?'#3b82f622':'rgba(0,0,0,0.5)',color:isPostRotation?'#3b82f6':'#71717a',fontSize:7,fontWeight:900,cursor:'pointer'}}>{isPostRotation?'ON':'OFF'}</button><span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}>CW</span></div>
              <FSlider value={postRotationSpeed} min={0} max={1} step={0.001} onChange={setPostRotationSpeed} defaultVal={0.5} color="#3b82f6" enabled={isPostRotation} {...lfoRP("postRot")}/>
              <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',margin:'8px 0 4px'}}>Zoom</div>
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}><span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}>0.25×</span><span style={{fontSize:7,fontWeight:900,color:'#93c5fd',fontVariantNumeric:'tabular-nums'}}>{zoom.toFixed(2)}×</span><span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}>3×</span></div>
              <FSlider value={zoom} min={0.25} max={3.0} step={0.01} onChange={setZoom} defaultVal={1.0} color="#3b82f6" enabled={true} {...lfoRP("zoom")}/>
              <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',margin:'8px 0 4px'}}>Manual Rotation</div>
              <div style={{display:'flex',flexDirection:'column',gap:6,marginBottom:8}}>
                {[['Pre-Sym',rotationAngleRef,preRotDeg,setPreRotDeg],['Post-Fx',livePostRotationAngleRef,postRotDeg,setPostRotDeg]].map(([lbl,ref,deg,setDeg])=>(
                  <div key={lbl} style={{display:'flex',alignItems:'center',gap:8,padding:'6px 8px',borderRadius:8,background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.06)'}}>
                    <RotWheel angleRef={ref} onDrag={()=>{renderFrame(progressRef.current);setDeg(Math.round(((ref.current*180/Math.PI)%360+360)%360));}} color="#3b82f6" size={60}/>
                    <div style={{flex:1,display:'flex',flexDirection:'column',gap:3}}>
                      <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}>{lbl}</span>
                      <span style={{fontSize:11,fontWeight:900,color:'#93c5fd',fontVariantNumeric:'tabular-nums',lineHeight:1}}>{deg}°</span>
                      <button onClick={()=>{ref.current=0;setDeg(0);renderFrame(progressRef.current);}} style={{padding:'3px 0',borderRadius:5,border:'1px solid #3f3f46',background:'rgba(0,0,0,0.3)',color:'#71717a',fontSize:6,fontWeight:900,textTransform:'uppercase',cursor:'pointer'}}>Reset 0°</button>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:4,marginBottom:8}}>
                {[{lbl:'0°',val:0},{lbl:'90°',val:Math.PI/2},{lbl:'180°',val:Math.PI},{lbl:'270°',val:Math.PI*1.5}].map(o=>(
                  <button key={o.lbl} onClick={()=>{livePostRotationAngleRef.current=0;R.current.postRotationOffset=o.val;setPostRotationOffset(o.val);renderFrame(progressRef.current);}} style={{padding:'5px 0',borderRadius:6,border:`1px solid ${postRotationOffset===o.val?'#3b82f6':'#3f3f46'}`,background:postRotationOffset===o.val?'#3b82f622':'rgba(0,0,0,0.3)',color:postRotationOffset===o.val?'#93c5fd':'#71717a',fontSize:7,fontWeight:900,cursor:'pointer'}}>{o.lbl}</button>
                ))}
              </div>
              <button onClick={resetModule} disabled={moduleAtDefaults} style={{width:'100%',padding:'6px 0',borderRadius:7,border:`1px solid ${resetModuleFlash?'#1e40af':moduleAtDefaults?'#27272a':'#3f3f46'}`,background:resetModuleFlash?'rgba(30,64,175,0.3)':moduleAtDefaults?'transparent':'rgba(0,0,0,0.3)',color:resetModuleFlash?'#93c5fd':moduleAtDefaults?'#3f3f46':'#71717a',fontSize:7,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.18em',cursor:moduleAtDefaults?'not-allowed':'pointer'}}>RESET</button>
            </>}
          />
        ),
      1: ()=>(
          <EngineFlipCard
            id="symmetry" collapsed={collapsed.symmetry}
            onToggleCollapse={()=>toggleCollapse('symmetry')}
            label="Symmetry" active={isSymmetry} onToggle={()=>setIsSymmetry(v=>!v)}
            color="#a855f7" bgColor="#3b0764" borderColor={isSymmetry?"#a855f7":"#27272a"} glowColor="#a855f7"
            modeKey={symmetryType} modeLabel={symLabel} modeCount={13} onModeChange={v=>setSymmetryType(v)}
            frontBottomContent={<>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:2}}>
                <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#6b7280'}}>Opacity</span>
                <span style={{fontSize:7,fontWeight:900,color:isSymmetry?'#a855f7':'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round(symOpacity*100)}%</span>
              </div>
              <FSlider value={symOpacity} min={0.1} max={1} step={0.01} defaultVal={1} onChange={setSymOpacity} color="#a855f7" enabled={isSymmetry}/>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:4}}>
                <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#6b7280'}}>Axis Spd</span>
                <span style={{fontSize:7,fontWeight:900,color:isSymmetry&&symAnimAxes?'#a855f7':'#52525b',fontVariantNumeric:'tabular-nums'}}>{symAnimRate.toFixed(2)}</span>
              </div>
              <FSlider value={symAnimRate} min={0.01} max={2} step={0.01} defaultVal={0.3} onChange={setSymAnimRate} color="#a855f7" enabled={isSymmetry&&symAnimAxes}/>
            </>}
            backContent={<>
              <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',marginBottom:4}}>Mirror</div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:4,marginBottom:4}}>
                {[{lbl:'X',t:1},{lbl:'Y',t:2},{lbl:'Tri',t:3},{lbl:'Quad',t:4}].map(m=>(
                  <button key={m.t} onClick={()=>setSymmetryType(m.t)} style={{padding:'5px 0',borderRadius:6,border:`1px solid ${symmetryType===m.t?(isSymmetry?'#a855f7':'#a855f744'):'#3f3f46'}`,background:symmetryType===m.t?(isSymmetry?'rgba(168,85,247,0.15)':'rgba(168,85,247,0.06)'):'rgba(0,0,0,0.3)',color:symmetryType===m.t?(isSymmetry?'#d8b4fe':'#a855f7'):'#71717a',fontSize:7,fontWeight:900,textTransform:'uppercase',cursor:'pointer'}}>{m.lbl}</button>
                ))}
              </div>
              <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',marginBottom:4}}>Kaleidoscope</div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:4,marginBottom:4}}>
                {[{lbl:'K3',t:5},{lbl:'K6',t:6},{lbl:'K8',t:7},{lbl:'K12',t:8}].map(m=>(
                  <button key={m.t} onClick={()=>setSymmetryType(m.t)} style={{padding:'5px 0',borderRadius:6,border:`1px solid ${symmetryType===m.t?(isSymmetry?'#a855f7':'#a855f744'):'#3f3f46'}`,background:symmetryType===m.t?(isSymmetry?'rgba(168,85,247,0.15)':'rgba(168,85,247,0.06)'):'rgba(0,0,0,0.3)',color:symmetryType===m.t?(isSymmetry?'#d8b4fe':'#a855f7'):'#71717a',fontSize:7,fontWeight:900,textTransform:'uppercase',cursor:'pointer'}}>{m.lbl}</button>
                ))}
              </div>
              <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',marginBottom:4}}>Creative</div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:4,marginBottom:6}}>
                {[{lbl:'Fan',t:9},{lbl:'Radial',t:10},{lbl:'Tile',t:11},{lbl:'Shard',t:12}].map(m=>(
                  <button key={m.t} onClick={()=>setSymmetryType(m.t)} style={{padding:'5px 0',borderRadius:6,border:`1px solid ${symmetryType===m.t?(isSymmetry?'#a855f7':'#a855f744'):'#3f3f46'}`,background:symmetryType===m.t?(isSymmetry?'rgba(168,85,247,0.15)':'rgba(168,85,247,0.06)'):'rgba(0,0,0,0.3)',color:symmetryType===m.t?(isSymmetry?'#d8b4fe':'#a855f7'):'#71717a',fontSize:7,fontWeight:900,textTransform:'uppercase',cursor:'pointer'}}>{m.lbl}</button>
                ))}
              </div>
              <div style={{display:'flex',gap:5,marginBottom:6}}>
                <button onClick={()=>setSymAnimAxes(a=>!a)} style={{flex:1,padding:'5px 0',borderRadius:6,border:`1px solid ${symAnimAxes?(isSymmetry?'#a855f7':'#a855f744'):'#3f3f46'}`,background:symAnimAxes?(isSymmetry?'rgba(168,85,247,0.15)':'rgba(168,85,247,0.06)'):'rgba(0,0,0,0.3)',color:symAnimAxes?(isSymmetry?'#d8b4fe':'#a855f7'):'#71717a',fontSize:7,fontWeight:900,textTransform:'uppercase',cursor:'pointer'}}>Spin</button>
                <button onClick={()=>setSymMirrorInner(f=>!f)} style={{flex:1,padding:'5px 0',borderRadius:6,border:`1px solid ${symMirrorInner?(isSymmetry?'#a855f7':'#a855f744'):'#3f3f46'}`,background:symMirrorInner?(isSymmetry?'rgba(168,85,247,0.15)':'rgba(168,85,247,0.06)'):'rgba(0,0,0,0.3)',color:symMirrorInner?(isSymmetry?'#d8b4fe':'#a855f7'):'#71717a',fontSize:7,fontWeight:900,textTransform:'uppercase',cursor:'pointer'}}>Flip</button>
              </div>
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}>Opacity</span>
                <span style={{fontSize:7,fontWeight:900,color:isSymmetry?'#d8b4fe':'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round(symOpacity*100)}%</span>
              </div>
              <FSlider value={symOpacity} min={0.1} max={1} step={0.01} defaultVal={1} onChange={setSymOpacity} color="#a855f7" enabled={isSymmetry}/>
              <div style={{display:'flex',justifyContent:'space-between',margin:'6px 0 3px'}}>
                <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}>Axis Speed</span>
                <span style={{fontSize:7,fontWeight:900,color:symAnimAxes&&isSymmetry?'#d8b4fe':'#52525b',fontVariantNumeric:'tabular-nums'}}>{symAnimRate.toFixed(2)}</span>
              </div>
              <FSlider value={symAnimRate} min={0.01} max={2} step={0.01} defaultVal={0.3} onChange={setSymAnimRate} color="#a855f7" enabled={isSymmetry&&symAnimAxes}/>
              <button onClick={()=>{setIsSymmetry(false);setSymmetryType(1);setSymMirrorInner(false);setSymAnimAxes(false);setSymAnimRate(.3);setSymCreativeAmt(0.5);setSymBlend('source-over');setSymOpacity(1);setSymCenterHole(0);setSymMask('none');setSymMaskCustomUrl(null);setSymmetryResetFlash(true);setTimeout(()=>setSymmetryResetFlash(false),300);}} disabled={symmetryAtDefaults} style={{width:'100%',padding:'6px 0',borderRadius:7,marginTop:8,border:`1px solid ${symmetryResetFlash?'#581c87':symmetryAtDefaults?'#27272a':'#3f3f46'}`,background:symmetryResetFlash?'rgba(88,28,135,0.3)':symmetryAtDefaults?'transparent':'rgba(0,0,0,0.3)',color:symmetryResetFlash?'#d8b4fe':symmetryAtDefaults?'#3f3f46':'#71717a',fontSize:7,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.18em',cursor:symmetryAtDefaults?'not-allowed':'pointer'}}>RESET</button>
            </>}
          />
        ),

      2: ()=>(
          <EngineFlipCard
            id="glyph" collapsed={collapsed.glyph}
            onToggleCollapse={()=>toggleCollapse('glyph')}
            label="Glyph" active={isText} onToggle={()=>setIsText(v=>!v)}
            color="#f43f5e" bgColor="#4c0519" borderColor={isText?"#f43f5e":"#27272a"} glowColor="#f43f5e"
            modeKey={textMotion} modeLabel={motionLabel} modeCount={5} onModeChange={v=>setTextMotion(v)}
            frontBottomContent={<>
              <div style={{display:'flex',alignItems:'center',gap:4,marginBottom:4}}>
                <input value={textPhraseInput} onChange={e=>setTextPhraseInput(e.target.value)}
                  onKeyDown={e=>{if(e.key==='Enter'){const v=e.target.value.trim().toUpperCase()||'MORPH';setTextPhrase(v);setTextPhraseInput(v);textMaskPhraseRef.current=v;textMaskDirtyRef.current=true;}}}
                  style={{flex:1,padding:'2px 6px',borderRadius:5,border:`1px solid ${isText?'#f43f5e44':'#3f3f46'}`,background:'rgba(0,0,0,0.5)',color:isText?'#fda4af':'#71717a',fontSize:8,fontWeight:900,textTransform:'uppercase',outline:'none'}} maxLength={12} placeholder="MORPH"/>
                <button onClick={()=>{const v=textPhraseInput.trim().toUpperCase()||'MORPH';setTextPhrase(v);setTextPhraseInput(v);textMaskPhraseRef.current=v;textMaskDirtyRef.current=true;}}
                  style={{padding:'2px 6px',borderRadius:5,border:`1px solid ${isText?'#f43f5e':'#3f3f46'}`,background:isText?'rgba(244,63,94,0.2)':'rgba(0,0,0,0.5)',color:isText?'#fda4af':'#71717a',fontSize:6,fontWeight:900,textTransform:'uppercase',cursor:'pointer',whiteSpace:'nowrap'}}>Apply</button>
              </div>
              <div style={{display:'flex',gap:3,marginBottom:4}}>
                {['A','B'].map(side=>(
                  <button key={side} onClick={()=>renderTextToSource(side)}
                    style={{flex:1,padding:'3px 0',borderRadius:5,border:'1px solid #3f3f46',background:'rgba(0,0,0,0.3)',color:'#71717a',fontSize:6,fontWeight:900,textTransform:'uppercase',cursor:'pointer'}}>→ {side}</button>
                ))}
              </div>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:2}}>
                <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#6b7280'}}>Strength</span>
                <span style={{fontSize:7,fontWeight:900,color:isText?'#f43f5e':'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round(textStrength*100)}%</span>
              </div>
              <FSlider value={textStrength} min={0} max={1} step={0.01} onChange={setTextStrength} defaultVal={0.99} color="#f43f5e" enabled={isText} {...lfoRP("glyphPull")}/>
            </>}
            backContent={<>
              {/* Phrase */}
              <div>
                <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',marginBottom:4}}>Phrase</div>
                <input value={textPhraseInput} onChange={e=>setTextPhraseInput(e.target.value)}
                  onKeyDown={e=>{if(e.key==='Enter'){const v=e.target.value.trim().toUpperCase()||'MORPH';setTextPhrase(v);setTextPhraseInput(v);textMaskPhraseRef.current=v;textMaskDirtyRef.current=true;}}}
                  style={{width:'100%',padding:'5px 8px',borderRadius:6,border:`1px solid ${isText?'#f43f5e44':'#3f3f46'}`,background:'rgba(0,0,0,0.5)',color:isText?'#fda4af':'#71717a',fontSize:9,fontWeight:900,textTransform:'uppercase',outline:'none',boxSizing:'border-box',marginBottom:5}} maxLength={12} placeholder="MORPH"/>
                <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:4}}>
                  <button onClick={()=>{const v=textPhraseInput.trim().toUpperCase()||'MORPH';setTextPhrase(v);setTextPhraseInput(v);textMaskPhraseRef.current=v;textMaskDirtyRef.current=true;}}
                    style={{padding:'5px 0',borderRadius:6,border:`1px solid ${isText?'#f43f5e':'#3f3f46'}`,background:isText?'rgba(244,63,94,0.2)':'rgba(0,0,0,0.3)',color:isText?'#fda4af':'#71717a',fontSize:7,fontWeight:900,textTransform:'uppercase',cursor:'pointer'}}>Apply</button>
                  {['A','B'].map(side=>(
                    <button key={side} onClick={()=>renderTextToSource(side)}
                      style={{padding:'5px 0',borderRadius:6,border:'1px solid #3f3f46',background:'rgba(0,0,0,0.3)',color:'#71717a',fontSize:7,fontWeight:900,textTransform:'uppercase',cursor:'pointer'}}>→ {side}</button>
                  ))}
                </div>
              </div>
              {/* Strength */}
              <div>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                  <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}>Strength</span>
                  <span style={{fontSize:7,fontWeight:900,color:isText?'#fda4af':'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round(textStrength*100)}%</span>
                </div>
                <FSlider value={textStrength} min={0} max={1} step={0.01} onChange={setTextStrength} defaultVal={0.99} color="#f43f5e" enabled={isText} {...lfoRP("glyphPull")}/>
              </div>
              {/* Motion mode + amplitude */}
              <div>
                <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',marginBottom:4}}>Motion</div>
                <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:3,marginBottom:5}}>
                  {[['Static',0],['Breath',1],['Wave',2],['Scatter',3],['Orbit',4]].map(([lbl,id])=>(
                    <button key={id} onClick={()=>setTextMotion(id)} style={{padding:'5px 0',borderRadius:6,border:`1px solid ${textMotion===id?(isText?'#f43f5e':'#f43f5e44'):'#3f3f46'}`,background:textMotion===id?(isText?'rgba(244,63,94,0.15)':'rgba(244,63,94,0.06)'):'rgba(0,0,0,0.3)',color:textMotion===id?(isText?'#fda4af':'#f43f5e'):'#71717a',fontSize:7,fontWeight:900,textTransform:'uppercase',cursor:'pointer'}}>{lbl}</button>
                  ))}
                </div>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                  <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}>Amplitude</span>
                  <span style={{fontSize:7,fontWeight:900,color:isText&&textMotion>0?'#fda4af':'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round(textMotionAmp*100)}%</span>
                </div>
                <div style={{opacity:textMotion>0?1:0.3,pointerEvents:textMotion>0?'auto':'none'}}>
                  <FSlider value={textMotionAmp} min={0} max={1} step={0.01} onChange={setTextMotionAmp} defaultVal={0.4} color="#f43f5e" enabled={isText&&textMotion>0}/>
                </div>
              </div>
              {/* Timeline / BPM */}
              <div>
                <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',marginBottom:4}}>Timeline</div>
                <div style={{display:'flex',gap:4,marginBottom:textBpmMode==='manual'?5:0}}>
                  {[['steady','Steady'],['manual','Manual'],['global','Global']].map(([val,lbl])=>(
                    <button key={val} onClick={()=>setTextBpmMode(val)} style={{flex:1,padding:'5px 0',borderRadius:6,border:`1px solid ${textBpmMode===val?(isText?'#f43f5e':'#f43f5e44'):'#3f3f46'}`,background:textBpmMode===val?(isText?'rgba(244,63,94,0.15)':'rgba(244,63,94,0.06)'):'rgba(0,0,0,0.3)',color:textBpmMode===val?(isText?'#fda4af':'#f43f5e'):'#71717a',fontSize:6,fontWeight:900,textTransform:'uppercase',cursor:'pointer'}}>{lbl}</button>
                  ))}
                </div>
                {textBpmMode==='manual'&&(
                  <div style={{display:'flex',alignItems:'center',gap:6}}>
                    <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}>BPM</span>
                    <input type="number" min={20} max={300} value={textManualBpm} onChange={e=>setTextManualBpm(Math.max(20,Math.min(300,Number(e.target.value))))} style={{width:52,padding:'3px 6px',borderRadius:5,border:`1px solid ${isText?'#f43f5e44':'#3f3f46'}`,background:'rgba(0,0,0,0.5)',color:isText?'#fda4af':'#71717a',fontSize:8,fontWeight:900,textTransform:'uppercase',outline:'none',textAlign:'center'}}/>
                  </div>
                )}
              </div>
              {/* Font typography */}
              <div>
                <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',marginBottom:4}}>Typography</div>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:2}}>
                  <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}>Size</span>
                  <span style={{fontSize:7,fontWeight:900,color:isText?'#fda4af':'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round(glyphFontSize*100)}%</span>
                </div>
                <FSlider value={glyphFontSize} min={0} max={1} step={0.01} onChange={setGlyphFontSize} defaultVal={0.6} color="#f43f5e" enabled={isText}/>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:2,marginTop:5}}>
                  <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}>Spacing</span>
                  <span style={{fontSize:7,fontWeight:900,color:isText?'#fda4af':'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round((glyphSpacing-0.5)*200)}%</span>
                </div>
                <FSlider value={glyphSpacing} min={0} max={1} step={0.01} onChange={setGlyphSpacing} defaultVal={0.5} color="#f43f5e" enabled={isText}/>
                <div style={{display:'flex',gap:4,marginTop:5}}>
                  <button onClick={()=>setGlyphOutline(v=>!v)} style={{flex:1,padding:'5px 0',borderRadius:6,border:`1px solid ${glyphOutline?(isText?'#f43f5e':'#f43f5e44'):'#3f3f46'}`,background:glyphOutline?(isText?'rgba(244,63,94,0.15)':'rgba(244,63,94,0.06)'):'rgba(0,0,0,0.3)',color:glyphOutline?(isText?'#fda4af':'#f43f5e'):'#71717a',fontSize:7,fontWeight:900,textTransform:'uppercase',cursor:'pointer'}}>Outline</button>
                  {[['white','White'],['source','Source'],['invert','Invert']].map(([val,lbl])=>(
                    <button key={val} onClick={()=>setGlyphColorMode(val)} style={{flex:1,padding:'5px 0',borderRadius:6,border:`1px solid ${glyphColorMode===val?(isText?'#f43f5e':'#f43f5e44'):'#3f3f46'}`,background:glyphColorMode===val?(isText?'rgba(244,63,94,0.15)':'rgba(244,63,94,0.06)'):'rgba(0,0,0,0.3)',color:glyphColorMode===val?(isText?'#fda4af':'#f43f5e'):'#71717a',fontSize:6,fontWeight:900,textTransform:'uppercase',cursor:'pointer'}}>{lbl}</button>
                  ))}
                </div>
              </div>
              {/* Apply time */}
              <div>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:2}}>
                  <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}>Apply Time</span>
                  <span style={{fontSize:7,fontWeight:900,color:isText?'#fda4af':'#52525b',fontVariantNumeric:'tabular-nums'}}>{glyphApplyTime===0?'Instant':`${glyphApplyTime.toFixed(1)}s`}</span>
                </div>
                <FSlider value={glyphApplyTime} min={0} max={4} step={0.1} onChange={setGlyphApplyTime} defaultVal={0.5} color="#f43f5e" enabled={isText}/>
              </div>
              {/* Glyph LFO */}
              <div style={{borderTop:'1px solid rgba(244,63,94,0.15)',paddingTop:6}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
                  <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#52525b',letterSpacing:'0.15em'}}>Glyph LFO</span>
                  <button onClick={()=>setGlyphLfoEnabled(v=>!v)} style={{minWidth:36,height:20,borderRadius:5,border:`1px solid ${glyphLfoEnabled?(isText?'#f43f5e88':'#f43f5e44'):'#3f3f46'}`,background:glyphLfoEnabled?(isText?'rgba(244,63,94,0.2)':'rgba(244,63,94,0.06)'):'rgba(0,0,0,0.5)',color:glyphLfoEnabled?(isText?'#fda4af':'#f43f5e'):'#71717a',fontSize:7,fontWeight:900,cursor:'pointer'}}>{glyphLfoEnabled?'ON':'OFF'}</button>
                </div>
                <div style={{opacity:glyphLfoEnabled?1:0.3,pointerEvents:glyphLfoEnabled?'auto':'none'}}>
                  {/* LFO shape */}
                  <div style={{display:'flex',gap:4,marginBottom:5}}>
                    {[[0,'∿','Sine'],[1,'△','Tri'],[2,'□','Pulse']].map(([id,sym,lbl])=>(
                      <button key={id} onClick={()=>setGlyphLfoShape(id)} style={{flex:1,padding:'4px 0',borderRadius:6,border:`1px solid ${glyphLfoShape===id?(isText?'#f43f5e':'#f43f5e44'):'#3f3f46'}`,background:glyphLfoShape===id?(isText?'rgba(244,63,94,0.15)':'rgba(244,63,94,0.06)'):'rgba(0,0,0,0.3)',color:glyphLfoShape===id?(isText?'#fda4af':'#f43f5e'):'#71717a',fontSize:10,cursor:'pointer',textAlign:'center'}}>
                        <div>{sym}</div><div style={{fontSize:5,fontWeight:900,textTransform:'uppercase'}}>{lbl}</div>
                      </button>
                    ))}
                  </div>
                  {/* Pull target row */}
                  <div style={{display:'flex',alignItems:'center',gap:5,marginBottom:3}}>
                    <button onClick={()=>setGlyphLfoPull(v=>!v)} style={{minWidth:34,height:18,borderRadius:4,border:`1px solid ${glyphLfoPull?'#f43f5e88':'#3f3f46'}`,background:glyphLfoPull?'rgba(244,63,94,0.15)':'rgba(0,0,0,0.3)',color:glyphLfoPull?'#fda4af':'#71717a',fontSize:5.5,fontWeight:900,textTransform:'uppercase',cursor:'pointer'}}>Pull</button>
                    <div style={{flex:1}}>
                      <FSlider value={glyphLfoRatePull} min={0} max={1} step={0.01} onChange={setGlyphLfoRatePull} defaultVal={0.3} color="#f43f5e" enabled={glyphLfoEnabled&&glyphLfoPull}/>
                    </div>
                    <div style={{flex:1}}>
                      <FSlider value={glyphLfoDepthPull} min={0} max={1} step={0.01} onChange={setGlyphLfoDepthPull} defaultVal={0.5} color="#f43f5e" enabled={glyphLfoEnabled&&glyphLfoPull}/>
                    </div>
                  </div>
                  {/* Amp target row */}
                  <div style={{display:'flex',alignItems:'center',gap:5}}>
                    <button onClick={()=>setGlyphLfoAmp(v=>!v)} style={{minWidth:34,height:18,borderRadius:4,border:`1px solid ${glyphLfoAmp?'#f43f5e88':'#3f3f46'}`,background:glyphLfoAmp?'rgba(244,63,94,0.15)':'rgba(0,0,0,0.3)',color:glyphLfoAmp?'#fda4af':'#71717a',fontSize:5.5,fontWeight:900,textTransform:'uppercase',cursor:'pointer'}}>Amp</button>
                    <div style={{flex:1}}>
                      <FSlider value={glyphLfoRateAmp} min={0} max={1} step={0.01} onChange={setGlyphLfoRateAmp} defaultVal={0.3} color="#f43f5e" enabled={glyphLfoEnabled&&glyphLfoAmp}/>
                    </div>
                    <div style={{flex:1}}>
                      <FSlider value={glyphLfoDepthAmp} min={0} max={1} step={0.01} onChange={setGlyphLfoDepthAmp} defaultVal={0.5} color="#f43f5e" enabled={glyphLfoEnabled&&glyphLfoAmp}/>
                    </div>
                  </div>
                  <div style={{display:'flex',justifyContent:'space-between',marginTop:3}}>
                    <span style={{fontSize:5,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}>Rate →</span>
                    <span style={{fontSize:5,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}>← Depth</span>
                  </div>
                </div>
              </div>
              {/* Reset */}
              <button onClick={()=>{setIsText(false);setTextPhrase('MORPH');setTextPhraseInput('MORPH');textMaskPhraseRef.current='MORPH';setTextStrength(0.99);setTextMotion(0);setTextMotionAmp(.4);setTextBpmMode('steady');setTextManualBpm(120);setGlyphLfoEnabled(false);setGlyphLfoShape(0);setGlyphLfoRatePull(.3);setGlyphLfoRateAmp(.3);setGlyphLfoDepthPull(.5);setGlyphLfoDepthAmp(.5);setGlyphLfoPull(true);setGlyphLfoAmp(false);setGlyphApplyTime(0.5);setGlyphFontSize(0.6);setGlyphSpacing(0.5);setGlyphOutline(false);setGlyphColorMode('white');textMaskDirtyRef.current=true;setTextResetFlash(true);setTimeout(()=>setTextResetFlash(false),300);}} disabled={textAtDefaults} style={{width:'100%',padding:'6px 0',borderRadius:7,border:`1px solid ${textResetFlash?'#881337':textAtDefaults?'#27272a':'#3f3f46'}`,background:textResetFlash?'rgba(136,19,55,0.3)':textAtDefaults?'transparent':'rgba(0,0,0,0.3)',color:textResetFlash?'#fda4af':textAtDefaults?'#3f3f46':'#71717a',fontSize:7,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.18em',cursor:textAtDefaults?'not-allowed':'pointer'}}>RESET</button>
            </>}
          />
        ),

      3: ()=>(
          <EngineFlipCard
            id="entropy" collapsed={collapsed.entropy}
            onToggleCollapse={()=>toggleCollapse('entropy')}
            label="Entropy" active={isEntropy} onToggle={()=>setIsEntropy(v=>!v)}
            color="#f97316" bgColor="#431407" borderColor={isEntropy?"#f97316":"#27272a"} glowColor="#f97316"
            modeKey={entropyType} modeLabel={entropyLabel} modeCount={6} onModeChange={v=>setEntropyType(v)}
            frontBottomContent={<>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:2}}>
                <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#6b7280'}}>Strength</span>
                <span style={{fontSize:7,fontWeight:900,color:isEntropy?'#f97316':'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round(entropyStr*100)}%</span>
              </div>
              <FSlider value={entropyStr} min={0} max={1} step={0.01} onChange={setEntropyStr} defaultVal={0.5} color="#f97316" enabled={isEntropy}/>
            </>}
            backContent={<>
              <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',marginBottom:4}}>Mode</div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:4,marginBottom:6}}>
                {[['Walk',0],['Pulse',1],['Drift',2],['Chaos',3],['Magnet',4],['Orbit',5]].map(([lbl,id])=>(
                  <button key={id} onClick={()=>setEntropyType(id)} style={{padding:'5px 0',borderRadius:6,border:`1px solid ${entropyType===id?(isEntropy?'#f97316':'#f9731644'):'#3f3f46'}`,background:entropyType===id?(isEntropy?'rgba(249,115,22,0.15)':'rgba(249,115,22,0.06)'):'rgba(0,0,0,0.3)',color:entropyType===id?(isEntropy?'#fdba74':'#f97316'):'#71717a',fontSize:7,fontWeight:900,textTransform:'uppercase',cursor:'pointer'}}>{lbl}</button>
                ))}
              </div>
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}>Strength</span>
                <span style={{fontSize:7,fontWeight:900,color:isEntropy?'#fdba74':'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round(entropyStr*100)}%</span>
              </div>
              <FSlider value={entropyStr} min={0} max={1} step={0.01} onChange={setEntropyStr} defaultVal={0.5} color="#f97316" enabled={isEntropy}/>
              <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',margin:'7px 0 4px'}}>Timeline</div>
              <div style={{display:'flex',gap:4,marginBottom:6}}>
                {[['steady','Steady'],['manual','Manual'],['global','Global']].map(([val,lbl])=>(
                  <button key={val} onClick={()=>setEntropyBpmMode(val)} style={{flex:1,padding:'5px 0',borderRadius:6,border:`1px solid ${entropyBpmMode===val?(isEntropy?'#f97316':'#f9731644'):'#3f3f46'}`,background:entropyBpmMode===val?(isEntropy?'rgba(249,115,22,0.15)':'rgba(249,115,22,0.06)'):'rgba(0,0,0,0.3)',color:entropyBpmMode===val?(isEntropy?'#fdba74':'#f97316'):'#71717a',fontSize:6,fontWeight:900,textTransform:'uppercase',cursor:'pointer'}}>{lbl}</button>
                ))}
              </div>
              <button onClick={()=>{setIsEntropy(false);setEntropyStr(.5);setEntropyBpmMode('steady');setEntropyManualBpm(120);setEntropyResetFlash(true);setTimeout(()=>setEntropyResetFlash(false),300);}} disabled={entropyAtDefaults} style={{width:'100%',padding:'6px 0',borderRadius:7,border:`1px solid ${entropyResetFlash?'#7c2d12':entropyAtDefaults?'#27272a':'#3f3f46'}`,background:entropyResetFlash?'rgba(124,45,18,0.3)':entropyAtDefaults?'transparent':'rgba(0,0,0,0.3)',color:entropyResetFlash?'#fdba74':entropyAtDefaults?'#3f3f46':'#71717a',fontSize:7,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.18em',cursor:entropyAtDefaults?'not-allowed':'pointer'}}>RESET</button>
            </>}
          />
        ),

      4: ()=>(
          <EngineFlipCard
            id="prismatic" collapsed={collapsed.prismatic}
            onToggleCollapse={()=>toggleCollapse('prismatic')}
            label="Prismatic" active={isAlch} onToggle={()=>setIsAlch(v=>!v)}
            color="#f59e0b" bgColor="#1c1009" borderColor={isAlch?"#f59e0b":"#27272a"} glowColor="#f59e0b"
            modeKey={alchType} modeLabel={prismLabel} modeCount={6} onModeChange={v=>setAlchType(v)}
            frontBottomContent={<>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:2}}>
                <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#6b7280'}}>Mod</span>
                <span style={{fontSize:7,fontWeight:900,color:isAlch?'#f59e0b':'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round(alchMod*100)}%</span>
              </div>
              <FSlider value={alchMod} min={0} max={1} defaultVal={0.5} onChange={setAlchMod} color="#f59e0b" enabled={isAlch} {...lfoRP('prismatic')}/>
            </>}
            backContent={<>
              <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',marginBottom:4}}>Mode</div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:4,marginBottom:6}}>
                {PRISM_TYPES.map(m=>(
                  <button key={m.id} onClick={()=>setAlchType(m.id)}
                    style={{padding:'5px 0',borderRadius:6,border:`1px solid ${alchType===m.id?(isAlch?'#f59e0b':'#f59e0b44'):'#3f3f46'}`,background:alchType===m.id?(isAlch?'rgba(245,158,11,0.15)':'rgba(245,158,11,0.06)'):'rgba(0,0,0,0.3)',color:alchType===m.id?(isAlch?'#fbbf24':'#f59e0b'):'#71717a',fontSize:6.5,fontWeight:900,textTransform:'uppercase',cursor:'pointer'}}>{m.label}</button>
                ))}
              </div>
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b'}}>Mod Amount</span>
                <span style={{fontSize:7,fontWeight:900,color:isAlch?'#f59e0b':'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round(alchMod*100)}%</span>
              </div>
              <FSlider value={alchMod} min={0} max={1} defaultVal={0.5} onChange={setAlchMod} color="#f59e0b" enabled={isAlch} {...lfoRP('prismatic')}/>
              <div style={{marginTop:6,fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',marginBottom:4}}>Timeline</div>
              <div style={{display:'flex',gap:4,marginBottom:6}}>
                {[['morph','Morph'],['steady','Steady'],['free','Free']].map(([val,lbl])=>(
                  <button key={val} onClick={()=>setAlchTimeline(val)}
                    style={{flex:1,padding:'5px 0',borderRadius:6,border:`1px solid ${alchTimeline===val?(isAlch?'#f59e0b':'#f59e0b44'):'#3f3f46'}`,background:alchTimeline===val?(isAlch?'rgba(245,158,11,0.15)':'rgba(245,158,11,0.06)'):'rgba(0,0,0,0.3)',color:alchTimeline===val?(isAlch?'#fbbf24':'#f59e0b'):'#71717a',fontSize:6.5,fontWeight:900,textTransform:'uppercase',cursor:'pointer'}}>{lbl}</button>
                ))}
              </div>
              <div style={{opacity:alchTimeline==='free'?1:0.3,pointerEvents:alchTimeline==='free'?'auto':'none',transition:'opacity 0.2s'}}>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                  <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b'}}>Rate</span>
                  <span style={{fontSize:7,fontWeight:900,color:isAlch&&alchTimeline==='free'?'#f59e0b':'#52525b'}}>{(0.2*Math.pow(20,alchRate)).toFixed(1)} Hz</span>
                </div>
                <FSlider value={alchRate} min={0} max={1} defaultVal={0.5} onChange={setAlchRate} color="#f59e0b" enabled={isAlch&&alchTimeline==='free'}/>
                <div style={{display:'flex',gap:4,marginTop:6}}>
                  {[[0,'∿','Sine'],[1,'△','Tri'],[2,'□','Pulse']].map(([sid,sym,lbl])=>(
                    <button key={sid} onClick={()=>setAlchShape(sid)}
                      style={{flex:1,padding:'5px 0',borderRadius:6,border:`1px solid ${alchShape===sid?(isAlch&&alchTimeline==='free'?'#f59e0b':'#f59e0b44'):'#3f3f46'}`,background:alchShape===sid?(isAlch&&alchTimeline==='free'?'rgba(245,158,11,0.15)':'rgba(245,158,11,0.06)'):'rgba(0,0,0,0.3)',color:alchShape===sid?(isAlch&&alchTimeline==='free'?'#fbbf24':'#f59e0b'):'#71717a',fontSize:9,cursor:'pointer'}}>
                      <div>{sym}</div><div style={{fontSize:5,fontWeight:900,textTransform:'uppercase'}}>{lbl}</div>
                    </button>
                  ))}
                </div>
              </div>
              <div style={{display:'flex',alignItems:'center',gap:6,marginTop:6,padding:'6px 8px',borderRadius:6,border:`1px solid ${boost&&isAlch?'#fbbf2444':'#3f3f4644'}`,background:boost&&isAlch?'rgba(251,191,36,0.08)':'transparent'}}>
                <button onClick={()=>setBoost(v=>!v)} disabled={!isAlch}
                  style={{flex:1,padding:'5px 0',borderRadius:6,border:`1px solid ${boost&&isAlch?'#fbbf24':'#3f3f46'}`,background:boost&&isAlch?'rgba(251,191,36,0.2)':'rgba(0,0,0,0.3)',color:boost&&isAlch?'#fbbf24':'#52525b',cursor:isAlch?'pointer':'not-allowed',opacity:isAlch?1:0.4,fontSize:7,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.1em'}}>🔥 Boost {boost&&isAlch?'ON':'OFF'}</button>
              </div>
              <button onClick={()=>{setIsAlch(false);setAlchType(1);setAlchMod(.5);setBoost(false);setAlchTimeline('morph');setAlchRate(.5);setAlchShape(0);setPrismaticResetFlash(true);setTimeout(()=>setPrismaticResetFlash(false),300);}}
                disabled={prismaticAtDefaults}
                style={{width:'100%',marginTop:6,padding:'6px 0',borderRadius:7,border:`1px solid ${prismaticResetFlash?'#78350f':prismaticAtDefaults?'#27272a':'#3f3f46'}`,background:prismaticResetFlash?'rgba(120,53,15,0.3)':prismaticAtDefaults?'transparent':'rgba(0,0,0,0.3)',color:prismaticResetFlash?'#fbbf24':prismaticAtDefaults?'#3f3f46':'#71717a',fontSize:7,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.18em',cursor:prismaticAtDefaults?'not-allowed':'pointer'}}>
                RESET
              </button>
            </>}
          />
        ),
      5: ()=>(
          <EngineFlipCard
            id="flux" collapsed={collapsed.flux}
            onToggleCollapse={()=>toggleCollapse('flux')}
            label="Flux" active={isFlux} onToggle={()=>setIsFlux(v=>!v)}
            color="#14b8a6" bgColor="#042f2e" borderColor={isFlux?"#14b8a6":"#27272a"} glowColor="#14b8a6"
            modeKey={fluxMode} modeLabel={fluxLabel} modeCount={6} onModeChange={v=>setFluxMode(v)}
            frontBottomContent={<>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:2}}>
                <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#6b7280'}}>Amp</span>
                <span style={{fontSize:7,fontWeight:900,color:isFlux?'#14b8a6':'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round(fluxAmp*100)}%</span>
              </div>
              <FSlider value={fluxAmp} min={0} max={1} defaultVal={0.4} onChange={setFluxAmp} color="#14b8a6" enabled={isFlux} {...lfoRP("fluxAmp")}/>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:4}}>
                <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#6b7280'}}>Rate</span>
                <span style={{fontSize:7,fontWeight:900,color:isFlux&&fluxTimeline==='free'?'#14b8a6':'#52525b',fontVariantNumeric:'tabular-nums'}}>{(0.2*Math.pow(20,fluxRate)).toFixed(1)}hz</span>
              </div>
              <FSlider value={fluxRate} min={0} max={1} defaultVal={0.5} onChange={setFluxRate} color="#14b8a6" enabled={isFlux&&fluxTimeline==='free'}/>
            </>}
            backContent={<>
              <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',marginBottom:4}}>Mode</div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:4,marginBottom:6}}>
                {[['Wave',0],['Vrtx',1],['Pull',2],['Shear',3],['Noise',4],['Twist',5],['Glass',6],['Rippl',7]].map(([lbl,id])=>(
                  <button key={id} onClick={()=>setFluxMode(id)} style={{padding:'5px 0',borderRadius:6,border:`1px solid ${fluxMode===id?(isFlux?'#14b8a6':'#14b8a644'):'#3f3f46'}`,background:fluxMode===id?(isFlux?'rgba(20,184,166,0.15)':'rgba(20,184,166,0.06)'):'rgba(0,0,0,0.3)',color:fluxMode===id?(isFlux?'#5eead4':'#14b8a6'):'#71717a',fontSize:7,fontWeight:900,textTransform:'uppercase',cursor:'pointer'}}>{lbl}</button>
                ))}
              </div>
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}>Amplitude</span>
                <span style={{fontSize:7,fontWeight:900,color:isFlux?'#5eead4':'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round(fluxAmp*100)}%</span>
              </div>
              <FSlider value={fluxAmp} min={0} max={1} defaultVal={0.4} onChange={setFluxAmp} color="#14b8a6" enabled={isFlux} {...lfoRP("fluxAmp")}/>
              <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',margin:'7px 0 4px'}}>Timeline</div>
              <div style={{display:'flex',gap:4,marginBottom:6}}>
                {[['morph','Morph'],['steady','Steady'],['free','Free']].map(([val,lbl])=>(
                  <button key={val} onClick={()=>setFluxTimeline(val)} style={{flex:1,padding:'5px 0',borderRadius:6,border:`1px solid ${fluxTimeline===val?(isFlux?'#14b8a6':'#14b8a644'):'#3f3f46'}`,background:fluxTimeline===val?(isFlux?'rgba(20,184,166,0.15)':'rgba(20,184,166,0.06)'):'rgba(0,0,0,0.3)',color:fluxTimeline===val?(isFlux?'#5eead4':'#14b8a6'):'#71717a',fontSize:6,fontWeight:900,textTransform:'uppercase',cursor:'pointer'}}>{lbl}</button>
                ))}
              </div>
              <div style={{opacity:fluxTimeline==='free'?1:0.3,pointerEvents:fluxTimeline==='free'?'auto':'none'}}>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                  <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}>Rate</span>
                  <span style={{fontSize:7,fontWeight:900,color:isFlux&&fluxTimeline==='free'?'#5eead4':'#52525b',fontVariantNumeric:'tabular-nums'}}>{(0.2*Math.pow(20,fluxRate)).toFixed(1)} Hz</span>
                </div>
                <FSlider value={fluxRate} min={0} max={1} defaultVal={0.5} onChange={setFluxRate} color="#14b8a6" enabled={isFlux&&fluxTimeline==='free'}/>
                <div style={{display:'flex',gap:4,marginTop:5}}>
                  {[[0,'∿','Sine'],[1,'△','Tri'],[2,'□','Pulse']].map(([id,sym,lbl])=>(
                    <button key={id} onClick={()=>setFluxShape(id)} style={{flex:1,padding:'4px 0',borderRadius:6,border:`1px solid ${fluxShape===id?(isFlux&&fluxTimeline==='free'?'#14b8a6':'#14b8a644'):'#3f3f46'}`,background:fluxShape===id?(isFlux&&fluxTimeline==='free'?'rgba(20,184,166,0.15)':'rgba(20,184,166,0.06)'):'rgba(0,0,0,0.3)',color:fluxShape===id?(isFlux&&fluxTimeline==='free'?'#5eead4':'#14b8a6'):'#71717a',fontSize:10,cursor:'pointer'}}>
                      <div>{sym}</div><div style={{fontSize:5,fontWeight:900,textTransform:'uppercase'}}>{lbl}</div>
                    </button>
                  ))}
                </div>
              </div>
              <button onClick={()=>{setIsFlux(false);setFluxMode(0);setFluxAmp(.4);setFluxTimeline('morph');setFluxRate(.5);setFluxShape(0);setFluxBpmSync(false);setFluxResetFlash(true);setTimeout(()=>setFluxResetFlash(false),300);}} disabled={fluxAtDefaults} style={{width:'100%',padding:'6px 0',borderRadius:7,marginTop:8,border:`1px solid ${fluxResetFlash?'#134e4a':fluxAtDefaults?'#27272a':'#3f3f46'}`,background:fluxResetFlash?'rgba(19,78,74,0.3)':fluxAtDefaults?'transparent':'rgba(0,0,0,0.3)',color:fluxResetFlash?'#5eead4':fluxAtDefaults?'#3f3f46':'#71717a',fontSize:7,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.18em',cursor:fluxAtDefaults?'not-allowed':'pointer'}}>RESET</button>
            </>}
          />
        ),

      6: ()=>(
          <EngineFlipCard
            id="glitch" collapsed={collapsed.glitch}
            onToggleCollapse={()=>toggleCollapse('glitch')}
            label="Glitch" active={isGlitch} onToggle={()=>setIsGlitch(v=>!v)}
            color="#ff2d78" bgColor="#2d0018" borderColor={isGlitch?"#ff2d78":"#27272a"} glowColor="#ff2d78"
            modeKey={glitchMode} modeLabel={['Slice','Databend','PxSort','ScanTear','Corrupt','VHS'][glitchMode]||'—'} modeCount={6} onModeChange={v=>setGlitchMode(v)}
            frontBottomContent={<>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:2}}>
                <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#6b7280'}}>Amount</span>
                <span style={{fontSize:7,fontWeight:900,color:isGlitch?'#ff2d78':'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round(glitchAmt*100)}%</span>
              </div>
              <FSlider value={glitchAmt} min={0} max={1} step={0.01} onChange={setGlitchAmt} defaultVal={0.5} color="#ff2d78" enabled={isGlitch}/>
            </>}
            backContent={<>
              <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',marginBottom:4}}>Mode</div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:4,marginBottom:6}}>
                {[['Slice',0],['Databend',1],['Px Sort',2],['Scan Tear',3],['Corrupt',4],['VHS',5]].map(([lbl,id])=>(
                  <button key={id} onClick={()=>setGlitchMode(id)} style={{padding:'5px 0',borderRadius:6,border:`1px solid ${glitchMode===id?(isGlitch?'#ff2d78':'#ff2d7844'):'#3f3f46'}`,background:glitchMode===id?(isGlitch?'rgba(255,45,120,0.15)':'rgba(255,45,120,0.06)'):'rgba(0,0,0,0.3)',color:glitchMode===id?(isGlitch?'#ff79a8':'#ff2d78'):'#71717a',fontSize:6.5,fontWeight:900,textTransform:'uppercase',cursor:'pointer'}}>{lbl}</button>
                ))}
              </div>
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}>Amount</span>
                <span style={{fontSize:7,fontWeight:900,color:isGlitch?'#ff79a8':'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round(glitchAmt*100)}%</span>
              </div>
              <FSlider value={glitchAmt} min={0} max={1} step={0.01} onChange={setGlitchAmt} defaultVal={0.5} color="#ff2d78" enabled={isGlitch}/>
              <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',margin:'7px 0 4px'}}>Timeline</div>
              <div style={{display:'flex',gap:4,marginBottom:6}}>
                {[['morph','Morph'],['free','Free']].map(([val,lbl])=>(
                  <button key={val} onClick={()=>setGlitchTimeline(val)} style={{flex:1,padding:'5px 0',borderRadius:6,border:`1px solid ${glitchTimeline===val?(isGlitch?'#ff2d78':'#ff2d7844'):'#3f3f46'}`,background:glitchTimeline===val?(isGlitch?'rgba(255,45,120,0.15)':'rgba(255,45,120,0.06)'):'rgba(0,0,0,0.3)',color:glitchTimeline===val?(isGlitch?'#ff79a8':'#ff2d78'):'#71717a',fontSize:6,fontWeight:900,textTransform:'uppercase',cursor:'pointer'}}>{lbl}</button>
                ))}
              </div>
              <div style={{opacity:glitchTimeline==='free'?1:0.3,pointerEvents:glitchTimeline==='free'?'auto':'none'}}>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                  <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}>Rate</span>
                  <span style={{fontSize:7,fontWeight:900,color:isGlitch&&glitchTimeline==='free'?'#ff79a8':'#52525b',fontVariantNumeric:'tabular-nums'}}>{(0.2*Math.pow(20,glitchRate)).toFixed(1)} Hz</span>
                </div>
                <FSlider value={glitchRate} min={0} max={1} step={0.01} onChange={setGlitchRate} defaultVal={0.5} color="#ff2d78" enabled={isGlitch&&glitchTimeline==='free'}/>
              </div>
              <button onClick={()=>{setIsGlitch(false);setGlitchMode(0);setGlitchAmt(0.5);setGlitchRate(0.5);setGlitchTimeline('morph');setGlitchResetFlash(true);setTimeout(()=>setGlitchResetFlash(false),300);}} style={{width:'100%',padding:'6px 0',borderRadius:7,marginTop:8,border:`1px solid ${glitchResetFlash?'#9f1239':'#3f3f46'}`,background:glitchResetFlash?'rgba(159,18,57,0.3)':'rgba(0,0,0,0.3)',color:glitchResetFlash?'#ff79a8':'#71717a',fontSize:7,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.18em',cursor:'pointer'}}>RESET</button>
            </>}
          />
        ),

      7: ()=>(
          <EngineFlipCard
            id="retro" collapsed={collapsed.retro}
            onToggleCollapse={()=>toggleCollapse('retro')}
            label="Retro" active={isRetro} onToggle={()=>setIsRetro(v=>!v)}
            color="#d946ef" bgColor="#3b0764" borderColor={isRetro?"#d946ef":"#27272a"} glowColor="#d946ef"
            modeKey={retroMode} modeLabel={['Grid','Sun','Synthwave','CRT','Void','Outrun'][retroMode]||'—'} modeCount={6} onModeChange={v=>setRetroMode(v)}
            frontBottomContent={<>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:2}}>
                <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#6b7280'}}>Amount</span>
                <span style={{fontSize:7,fontWeight:900,color:isRetro?'#d946ef':'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round(retroAmt*100)}%</span>
              </div>
              <FSlider value={retroAmt} min={0} max={1} step={0.01} onChange={setRetroAmt} defaultVal={0.5} color="#d946ef" enabled={isRetro}/>
            </>}
            backContent={<>
              <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',marginBottom:4}}>Mode</div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:4,marginBottom:6}}>
                {[['Grid',0],['Sun',1],['Synthwave',2],['CRT',3],['Void',4],['Outrun',5]].map(([lbl,id])=>(
                  <button key={id} onClick={()=>setRetroMode(id)} style={{padding:'5px 0',borderRadius:6,border:`1px solid ${retroMode===id?(isRetro?'#d946ef':'#d946ef44'):'#3f3f46'}`,background:retroMode===id?(isRetro?'rgba(217,70,239,0.15)':'rgba(217,70,239,0.06)'):'rgba(0,0,0,0.3)',color:retroMode===id?(isRetro?'#e879f9':'#d946ef'):'#71717a',fontSize:6.5,fontWeight:900,textTransform:'uppercase',cursor:'pointer'}}>{lbl}</button>
                ))}
              </div>
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}>Amount</span>
                <span style={{fontSize:7,fontWeight:900,color:isRetro?'#e879f9':'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round(retroAmt*100)}%</span>
              </div>
              <FSlider value={retroAmt} min={0} max={1} step={0.01} onChange={setRetroAmt} defaultVal={0.5} color="#d946ef" enabled={isRetro}/>
              <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',margin:'7px 0 4px'}}>Speed</div>
              <FSlider value={retroSpeed} min={0} max={1} step={0.01} onChange={setRetroSpeed} defaultVal={0.5} color="#d946ef" enabled={isRetro}/>
              <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',margin:'7px 0 4px'}}>Colour</div>
              <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:6}}>
                <input type="color" value={retroColor} onChange={e=>setRetroColor(e.target.value)} style={{width:32,height:28,borderRadius:6,border:'1px solid #3f3f46',cursor:'pointer',background:'#09090b',padding:2}}/>
                <span style={{fontSize:7,fontWeight:900,color:'#a1a1aa'}}>{retroColor}</span>
              </div>
              {/* Layer toggle */}
              <div style={{borderTop:'1px solid rgba(217,70,239,0.15)',paddingTop:6}}>
                <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',marginBottom:4}}>Layer</div>
                <div style={{display:'flex',gap:4,marginBottom:6}}>
                  {[['Behind',0],['During',1],['Front',2]].map(([lbl,val])=>(
                    <button key={val} onClick={()=>setRetroLayer(val)}
                      style={{flex:1,padding:'5px 0',borderRadius:6,
                        border:`1px solid ${retroLayer===val?(isRetro?'#d946ef':'#d946ef44'):'#3f3f46'}`,
                        background:retroLayer===val?(isRetro?'rgba(217,70,239,0.15)':'rgba(217,70,239,0.06)'):'rgba(0,0,0,0.3)',
                        color:retroLayer===val?(isRetro?'#e879f9':'#d946ef'):'#71717a',
                        fontSize:6.5,fontWeight:900,textTransform:'uppercase',cursor:'pointer'}}>
                      {lbl}
                    </button>
                  ))}
                </div>
                <div style={{padding:'4px 7px',borderRadius:5,background:'rgba(0,0,0,0.3)',border:'1px solid rgba(217,70,239,0.08)',marginBottom:6}}>
                  <span style={{fontSize:5.5,color:'#52525b',lineHeight:1.5,display:'block'}}>
                    {['Behind: effect underlays morph particles','During: effect blends with particles pre-symmetry','Front: effect overlays the final composite'][retroLayer]}
                  </span>
                </div>
              </div>
              <button onClick={()=>{setIsRetro(false);setRetroMode(0);setRetroAmt(0.5);setRetroSpeed(0.5);setRetroColor('#ff6ec7');setRetroLayer(1);setRetroResetFlash(true);setTimeout(()=>setRetroResetFlash(false),300);}} style={{width:'100%',padding:'6px 0',borderRadius:7,border:`1px solid ${retroResetFlash?'#701a75':'#3f3f46'}`,background:retroResetFlash?'rgba(112,26,117,0.3)':'rgba(0,0,0,0.3)',color:retroResetFlash?'#e879f9':'#71717a',fontSize:7,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.18em',cursor:'pointer'}}>RESET</button>
            </>}
          />
        ),

      8: ()=>(
          <EngineFlipCard
            id="warp" collapsed={collapsed.warp}
            onToggleCollapse={()=>toggleCollapse('warp')}
            label="Warp" active={isWarp} onToggle={()=>setIsWarp(v=>!v)}
            color="#06b6d4" bgColor="#083344" borderColor={isWarp?"#06b6d4":"#27272a"} glowColor="#06b6d4"
            modeKey={warpMode} modeLabel={['Lens','Pinch','Ripple','Swirl','Mirror','Kaleid'][warpMode]||'—'} modeCount={6} onModeChange={v=>setWarpMode(v)}
            frontBottomContent={<>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:2}}>
                <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#6b7280'}}>Amount</span>
                <span style={{fontSize:7,fontWeight:900,color:isWarp?'#06b6d4':'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round(warpAmt*100)}%</span>
              </div>
              <FSlider value={warpAmt} min={0} max={1} step={0.01} onChange={setWarpAmt} defaultVal={0.5} color="#06b6d4" enabled={isWarp} {...lfoRP("warpAmt")}/>
            </>}
            backContent={<>
              <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',marginBottom:4}}>Mode</div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:4,marginBottom:6}}>
                {[['Lens',0],['Pinch',1],['Ripple',2],['Swirl',3],['Mirror',4],['Kaleid',5]].map(([lbl,id])=>(
                  <button key={id} onClick={()=>setWarpMode(id)} style={{padding:'5px 0',borderRadius:6,border:`1px solid ${warpMode===id?(isWarp?'#06b6d4':'#06b6d444'):'#3f3f46'}`,background:warpMode===id?(isWarp?'rgba(6,182,212,0.15)':'rgba(6,182,212,0.06)'):'rgba(0,0,0,0.3)',color:warpMode===id?(isWarp?'#67e8f9':'#06b6d4'):'#71717a',fontSize:7,fontWeight:900,textTransform:'uppercase',cursor:'pointer'}}>{lbl}</button>
                ))}
              </div>
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}>Amount</span>
                <span style={{fontSize:7,fontWeight:900,color:isWarp?'#67e8f9':'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round(warpAmt*100)}%</span>
              </div>
              <FSlider value={warpAmt} min={0} max={1} step={0.01} onChange={setWarpAmt} defaultVal={0.5} color="#06b6d4" enabled={isWarp} {...lfoRP("warpAmt")}/>
              <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',margin:'7px 0 4px'}}>Rate</div>
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}></span>
                <span style={{fontSize:7,fontWeight:900,color:isWarp?'#67e8f9':'#52525b',fontVariantNumeric:'tabular-nums'}}>{(0.2*Math.pow(20,warpRate)).toFixed(1)} Hz</span>
              </div>
              <FSlider value={warpRate} min={0} max={1} step={0.01} onChange={setWarpRate} defaultVal={0.5} color="#06b6d4" enabled={isWarp}/>
              <button onClick={()=>{setIsWarp(false);setWarpMode(0);setWarpAmt(0.5);setWarpRate(0.5);setWarpResetFlash&&setWarpResetFlash(true)&&setTimeout(()=>setWarpResetFlash(false),300);}} style={{width:'100%',padding:'6px 0',borderRadius:7,marginTop:8,border:'1px solid #3f3f46',background:'rgba(0,0,0,0.3)',color:'#71717a',fontSize:7,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.18em',cursor:'pointer'}}>RESET</button>
            </>}
          />
        ),

      9: ()=>(
          <EngineFlipCard
            id="field" collapsed={collapsed.field}
            onToggleCollapse={()=>toggleCollapse('field')}
            label="Field" active={isField} onToggle={()=>setIsField(v=>!v)}
            color="#22c55e" bgColor="#052e16" borderColor={isField?"#22c55e":"#27272a"} glowColor="#22c55e"
            modeKey={fieldMode} modeLabel={['Aurora','Plasma','Lattice','Interfere','Wind','Magrev','Poles'][fieldMode]||'—'} modeCount={7} onModeChange={v=>setFieldMode(v)}
            frontBottomContent={<>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:2}}>
                <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#6b7280'}}>Amount</span>
                <span style={{fontSize:7,fontWeight:900,color:isField?'#22c55e':'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round(fieldAmt*100)}%</span>
              </div>
              <FSlider value={fieldAmt} min={0} max={1} step={0.01} onChange={setFieldAmt} defaultVal={0.5} color="#22c55e" enabled={isField} {...lfoRP("fieldAmt")}/>
            </>}
            backContent={<>
              <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',marginBottom:4}}>Mode</div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:4,marginBottom:6}}>
                {[['Aurora',0],['Plasma',1],['Lattice',2],['Interfere',3],['Wind',4],['Magrev',5],['Poles',6]].map(([lbl,id])=>(
                  <button key={id} onClick={()=>setFieldMode(id)} style={{padding:'5px 0',borderRadius:6,border:`1px solid ${fieldMode===id?(isField?'#22c55e':'#22c55e44'):'#3f3f46'}`,background:fieldMode===id?(isField?'rgba(34,197,94,0.15)':'rgba(34,197,94,0.06)'):'rgba(0,0,0,0.3)',color:fieldMode===id?(isField?'#86efac':'#22c55e'):'#71717a',fontSize:7,fontWeight:900,textTransform:'uppercase',cursor:'pointer'}}>{lbl}</button>
                ))}
              </div>
              <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}>Amount</span>
                <span style={{fontSize:7,fontWeight:900,color:isField?'#86efac':'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round(fieldAmt*100)}%</span>
              </div>
              <FSlider value={fieldAmt} min={0} max={1} step={0.01} onChange={setFieldAmt} defaultVal={0.5} color="#22c55e" enabled={isField} {...lfoRP("fieldAmt")}/>
              <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',margin:'7px 0 4px'}}>Origin</div>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:5,marginBottom:6}}>
                <div>
                  <div style={{display:'flex',justifyContent:'space-between',marginBottom:2}}><span style={{fontSize:5.5,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}>X</span><span style={{fontSize:6,fontWeight:900,color:isField?'#86efac':'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round(fieldX*100)}%</span></div>
                  <FSlider value={fieldX} min={0} max={1} step={0.01} onChange={setFieldX} defaultVal={0.5} color="#22c55e" enabled={isField}/>
                </div>
                <div>
                  <div style={{display:'flex',justifyContent:'space-between',marginBottom:2}}><span style={{fontSize:5.5,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}>Y</span><span style={{fontSize:6,fontWeight:900,color:isField?'#86efac':'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round(fieldY*100)}%</span></div>
                  <FSlider value={fieldY} min={0} max={1} step={0.01} onChange={setFieldY} defaultVal={0.5} color="#22c55e" enabled={isField}/>
                </div>
              </div>
              <button onClick={()=>{setIsField(false);setFieldMode(0);setFieldAmt(0.5);setFieldX(0.5);setFieldY(0.5);setFieldResetFlash(true);setTimeout(()=>setFieldResetFlash(false),300);}} style={{width:'100%',padding:'6px 0',borderRadius:7,border:`1px solid ${fieldResetFlash?'#14532d':'#3f3f46'}`,background:fieldResetFlash?'rgba(20,83,45,0.3)':'rgba(0,0,0,0.3)',color:fieldResetFlash?'#86efac':'#71717a',fontSize:7,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.18em',cursor:'pointer'}}>RESET</button>
            </>}
          />
        ),

      10: ()=>(
          <EngineFlipCard
            id="ascii" collapsed={collapsed.ascii}
            onToggleCollapse={()=>toggleCollapse('ascii')}
            label="ASCII" active={isAscii} onToggle={()=>setIsAscii(v=>!v)}
            color="#84cc16" bgColor="#1a2e05" borderColor={isAscii?"#84cc16":"#27272a"} glowColor="#84cc16"
            modeKey={asciiMode} modeLabel={['Braille','Block','Matrix','Typewrtr','Morse','Circuit','Runic','Noise'][asciiMode]||'—'} modeCount={8} onModeChange={v=>setAsciiMode(v)}
            frontBottomContent={<>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:2}}>
                <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#6b7280'}}>Blend</span>
                <span style={{fontSize:7,fontWeight:900,color:isAscii?'#84cc16':'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round(asciiAmt*100)}%</span>
              </div>
              <FSlider value={asciiAmt} min={0} max={1} step={0.01} onChange={setAsciiAmt} defaultVal={0.8} color="#84cc16" enabled={isAscii}/>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:4}}>
                <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#6b7280'}}>Cell</span>
                <span style={{fontSize:7,fontWeight:900,color:isAscii?'#84cc16':'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round(asciiSize*100)}%</span>
              </div>
              <FSlider value={asciiSize} min={0} max={1} step={0.01} onChange={setAsciiSize} defaultVal={0.4} color="#84cc16" enabled={isAscii}/>
            </>}
            backContent={<>
              {/* Mode grid */}
              <div>
                <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',marginBottom:4}}>Mode</div>
                <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:4,marginBottom:5}}>
                  {[['Braille',0],['Block',1],['Matrix',2],['Typewrtr',3],['Morse',4],['Circuit',5],['Runic',6],['Noise',7]].map(([lbl,id])=>(
                    <button key={id} onClick={()=>setAsciiMode(id)}
                      style={{padding:'5px 0',borderRadius:6,
                        border:`1px solid ${asciiMode===id?(isAscii?'#84cc16':'#84cc1644'):'#3f3f46'}`,
                        background:asciiMode===id?(isAscii?'rgba(132,204,22,0.15)':'rgba(132,204,22,0.06)'):'rgba(0,0,0,0.3)',
                        color:asciiMode===id?(isAscii?'#bef264':'#84cc16'):'#71717a',
                        fontSize:6.5,fontWeight:900,textTransform:'uppercase',cursor:'pointer'}}>
                      {lbl}
                    </button>
                  ))}
                </div>
                {/* Mode description */}
                <div style={{padding:'5px 8px',borderRadius:6,background:'rgba(132,204,22,0.05)',border:'1px solid rgba(132,204,22,0.12)',marginBottom:6}}>
                  <span style={{fontSize:6,color:'#52525b',lineHeight:1.6,display:'block'}}>
                    {['Maps pixel luma to Braille dot density — a stippled living texture.',
                      'Classic block gradient: ░▒▓█ ordered by brightness.',
                      'Falling katakana & hex digits — each column scrolls at luma speed.',
                      'Typewriter chars with animated ink-bleed micro-offset.',
                      'Dots and dashes distributed by luma density bands.',
                      'Box-drawing chars wired by local gradient — circuit traces.',
                      'Elder Futhark runes cycle through luma and time.',
                      'Direction chars oriented by local luminance gradient angle.'][asciiMode]||''}
                  </span>
                </div>
              </div>
              {/* Blend */}
              <div>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                  <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}>Blend</span>
                  <span style={{fontSize:7,fontWeight:900,color:isAscii?'#bef264':'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round(asciiAmt*100)}%</span>
                </div>
                <FSlider value={asciiAmt} min={0} max={1} step={0.01} onChange={setAsciiAmt} defaultVal={0.8} color="#84cc16" enabled={isAscii}/>
              </div>
              {/* Cell size */}
              <div>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
                  <span style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#52525b'}}>Cell Size</span>
                  <span style={{fontSize:7,fontWeight:900,color:isAscii?'#bef264':'#52525b',fontVariantNumeric:'tabular-nums'}}>{Math.round(4+asciiSize*20)}px</span>
                </div>
                <FSlider value={asciiSize} min={0} max={1} step={0.01} onChange={setAsciiSize} defaultVal={0.4} color="#84cc16" enabled={isAscii}/>
              </div>
              {/* Colour mode */}
              <div>
                <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.15em',color:'#52525b',marginBottom:4}}>Char Colour</div>
                <div style={{display:'flex',gap:4,marginBottom:asciiColorMode==='fixed'?5:0}}>
                  {[['source','Source'],['fixed','Fixed'],['invert','Invert']].map(([val,lbl])=>(
                    <button key={val} onClick={()=>setAsciiColorMode(val)}
                      style={{flex:1,padding:'5px 0',borderRadius:6,
                        border:`1px solid ${asciiColorMode===val?(isAscii?'#84cc16':'#84cc1644'):'#3f3f46'}`,
                        background:asciiColorMode===val?(isAscii?'rgba(132,204,22,0.15)':'rgba(132,204,22,0.06)'):'rgba(0,0,0,0.3)',
                        color:asciiColorMode===val?(isAscii?'#bef264':'#84cc16'):'#71717a',
                        fontSize:6,fontWeight:900,textTransform:'uppercase',cursor:'pointer'}}>
                      {lbl}
                    </button>
                  ))}
                </div>
                {asciiColorMode==='fixed'&&(
                  <div style={{display:'flex',alignItems:'center',gap:6,marginTop:5}}>
                    <input type="color" value={asciiColor} onChange={e=>setAsciiColor(e.target.value)}
                      style={{width:32,height:28,borderRadius:6,border:'1px solid #3f3f46',cursor:'pointer',background:'#09090b',padding:2}}/>
                    <span style={{fontSize:7,fontWeight:900,color:'#a1a1aa'}}>{asciiColor}</span>
                  </div>
                )}
              </div>
              {/* Bypass Symmetry */}
              <div style={{borderTop:'1px solid rgba(132,204,22,0.15)',paddingTop:6}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
                  <div>
                    <div style={{fontSize:6,fontWeight:900,textTransform:'uppercase',color:'#52525b',letterSpacing:'0.12em'}}>Bypass Symmetry</div>
                    <div style={{fontSize:5,color:'#52525b',marginTop:1}}>Apply after symmetry instead of before</div>
                  </div>
                  <button onClick={()=>setAsciiBypassSym(v=>!v)}
                    style={{minWidth:46,height:26,borderRadius:7,
                      border:`1px solid ${asciiBypassSym?(isAscii?'#84cc16':'#84cc1644'):'#3f3f46'}`,
                      background:asciiBypassSym?(isAscii?'rgba(132,204,22,0.2)':'rgba(132,204,22,0.06)'):'rgba(0,0,0,0.5)',
                      color:asciiBypassSym?(isAscii?'#bef264':'#84cc16'):'#71717a',
                      fontSize:8,fontWeight:900,cursor:'pointer',textAlign:'center'}}>
                    {asciiBypassSym?'POST':'PRE'}
                  </button>
                </div>
                <div style={{padding:'4px 7px',borderRadius:5,background:'rgba(0,0,0,0.3)',border:'1px solid rgba(132,204,22,0.08)'}}>
                  <span style={{fontSize:5.5,color:'#52525b',lineHeight:1.5,display:'block'}}>
                    {asciiBypassSym
                      ?'POST: ASCII overlays the final composited image — symmetry patterns are visible through the character grid.'
                      :'PRE: ASCII is applied to raw particles before symmetry — the character grid is then symmetry-folded.'}
                  </span>
                </div>
              </div>
              {/* Reset */}
              <button onClick={()=>{setIsAscii(false);setAsciiMode(0);setAsciiAmt(0.8);setAsciiSize(0.4);setAsciiColorMode('source');setAsciiColor('#84cc16');setAsciiBypassSym(false);setAsciiResetFlash(true);setTimeout(()=>setAsciiResetFlash(false),300);}}
                disabled={asciiAtDefaults}
                style={{width:'100%',padding:'6px 0',borderRadius:7,
                  border:`1px solid ${asciiResetFlash?'#365314':asciiAtDefaults?'#27272a':'#3f3f46'}`,
                  background:asciiResetFlash?'rgba(54,83,20,0.3)':asciiAtDefaults?'transparent':'rgba(0,0,0,0.3)',
                  color:asciiResetFlash?'#bef264':asciiAtDefaults?'#3f3f46':'#71717a',
                  fontSize:7,fontWeight:900,textTransform:'uppercase',letterSpacing:'0.18em',
                  cursor:asciiAtDefaults?'not-allowed':'pointer'}}>
                RESET ASCII
              </button>
            </>}
          />
        ),

        };
        return(
          <DraggableEngineGrid
            order={engineOrder}
            setOrder={setEngineOrder}
            renderCard={(moduleIdx,slotIdx,isGhost,onPD)=>moduleCards[moduleIdx]()}
          />
        );
      })()}
    </div>
    );
  })();

  // ── AUDIOFX panel ─────────────────────────────────────────────────────────
  const audioFX=(
    <div className="grid gap-4" style={{gridTemplateColumns:'220px minmax(0,1fr) 300px'}}>

        {/* ── Column 1: Input + Levels ─────────────────────────────────── */}
        <div className="space-y-3">
          {/* Input card */}
          <div className={`border rounded-xl p-3 ${cyListen?'bg-cyan-950/30 border-cyan-500/50':'bg-zinc-950 border-zinc-800'}`}>
            <div className="flex justify-between items-center mb-2">
              <div className="flex items-center gap-1.5">
                <span className="text-[9px] font-black uppercase text-zinc-400 tracking-widest">Input</span>
                {cyListen&&<div className={`w-2 h-2 rounded-full transition-all duration-75 ${audLevels.beat?'bg-cyan-200 shadow-[0_0_8px_rgba(34,211,238,1)]':'bg-cyan-700'}`}/>}
              </div>
              <div className="flex gap-1">
                <button onClick={()=>cyListen?stopAudio():startMic()} title={cyListen?'Stop mic':'Start mic'}
                  className={`px-2.5 h-7 rounded-lg flex items-center gap-1.5 border text-[7px] font-black uppercase transition-all ${cyListen?'bg-red-500 border-red-400 text-white':'bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-cyan-500/60 hover:text-cyan-400'}`}>
                  <span style={{width:10,height:10}}><I.Mic /></span>{cyListen?'Stop':'Mic'}
                </button>
                <button onClick={()=>setCyHideCanvas(v=>!v)} title="Blackout morph — audio visuals only (SRC color still samples)"
                  className={`w-7 h-7 rounded-lg flex items-center justify-center border text-[7px] font-black transition-all ${cyHideCanvas?'bg-zinc-900 border-zinc-400 text-white':'bg-zinc-800 border-zinc-700 text-zinc-500 hover:border-zinc-500'}`}>
                  <span className="text-[10px]">{cyHideCanvas?'◼':'◻'}</span>
                </button>
                <button onClick={()=>setIsCymatic(v=>!v)}
                  className={`w-7 h-7 rounded-lg flex items-center justify-center border transition-all ${isCymatic?'bg-cyan-500 border-cyan-400 text-white':'bg-zinc-800 border-zinc-700 text-zinc-500 hover:border-cyan-500/50'}`}
                  title="Enable Cymatics visualiser">
                  <span style={{width:12,height:12}}><I.Activity /></span>
                </button>
              </div>
            </div>
            {cyMicErr&&<p className="text-[6px] text-red-400 mb-1.5">{cyMicErr}</p>}
            {!cyListen&&<p className="text-[6px] text-zinc-700 mb-1 leading-snug">Click Mic → grant browser permission → play audio.</p>}
            {cyListen&&<p className="text-[6px] text-cyan-600 mb-1 leading-snug">● Listening</p>}
            <div className="mt-2">
              <div className="flex justify-between items-center text-[6px] font-black uppercase text-zinc-600 mb-1">
                <span>Freq Window</span>
                <div className="flex items-center gap-1">
                  <button onClick={()=>setCyFreqHz(false)} className={`px-1.5 py-0.5 rounded border text-[5px] font-black transition-all ${!cyFreqHz?'bg-cyan-500 border-cyan-400 text-white':'bg-zinc-900 border-zinc-700 text-zinc-500'}`}>%</button>
                  <button onClick={()=>setCyFreqHz(true)}  className={`px-1.5 py-0.5 rounded border text-[5px] font-black transition-all ${cyFreqHz?'bg-cyan-500 border-cyan-400 text-white':'bg-zinc-900 border-zinc-700 text-zinc-500'}`}>Hz</button>
                </div>
              </div>
              {!cyFreqHz?(
                <>
                  <RangeSlider lo={cyFreqLo} hi={cyFreqHi} onLoChange={setCyFreqLo} onHiChange={setCyFreqHi} color="#06b6d4" enabled={cyListen}/>
                  <p className="text-[5.5px] text-zinc-700 mt-1 tabular-nums">{Math.round(cyFreqLo*100)}% – {Math.round(cyFreqHi*100)}% of spectrum</p>
                </>
              ):(
                <div className="space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="text-[5.5px] font-black uppercase text-zinc-700 w-4">Lo</span>
                    <div className="flex-1"><FSlider value={Math.log10(Math.max(20,cyFreqLoHz))} min={Math.log10(20)} max={Math.log10(20000)} step={0.01} defaultVal={Math.log10(20)} onChange={v=>setCyFreqLoHz(Math.round(Math.pow(10,v)))} color="#06b6d4" enabled={cyListen}/></div>
                    <span className="text-[5.5px] font-black tabular-nums text-cyan-500 w-12 text-right">{cyFreqLoHz>=1000?`${(cyFreqLoHz/1000).toFixed(1)}kHz`:`${cyFreqLoHz}Hz`}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[5.5px] font-black uppercase text-zinc-700 w-4">Hi</span>
                    <div className="flex-1"><FSlider value={Math.log10(Math.max(20,cyFreqHiHz))} min={Math.log10(20)} max={Math.log10(20000)} step={0.01} defaultVal={Math.log10(20000)} onChange={v=>setCyFreqHiHz(Math.round(Math.pow(10,v)))} color="#06b6d4" enabled={cyListen}/></div>
                    <span className="text-[5.5px] font-black tabular-nums text-cyan-500 w-12 text-right">{cyFreqHiHz>=1000?`${(cyFreqHiHz/1000).toFixed(1)}kHz`:`${cyFreqHiHz}Hz`}</span>
                  </div>
                  <p className="text-[5.5px] text-zinc-700">Log scale · 20Hz–20kHz</p>
                </div>
              )}
            </div>
          </div>

          {/* BPM card (moved from EngFX) */}
          <div className={`border rounded-xl p-3 ${bpmEnabled?'bg-orange-950/20 border-orange-500/40':'bg-zinc-950 border-zinc-800'}`}>
            <div className="flex justify-between items-center mb-2">
              <span className="text-[9px] font-black uppercase text-zinc-500 tracking-widest">BPM Clock</span>
              <div className="flex items-center gap-1.5">
                <div className={`w-2 h-2 rounded-full transition-all duration-75 ${bpmEnabled?(beatFlash?'bg-orange-300 shadow-[0_0_6px_2px_rgba(249,115,22,.8)]':'bg-orange-700'):'bg-zinc-700'}`}/>
                <button onClick={()=>setBpmEnabled(!bpmEnabled)} className={`w-7 h-7 rounded-lg flex items-center justify-center transition-all ${bpmEnabled?'bg-orange-500 text-white':'bg-zinc-800 text-zinc-600 border border-zinc-700 hover:border-zinc-500'}`}><span style={{width:12,height:12}}><I.Music /></span></button>
              </div>
            </div>
            <div className="flex items-center gap-2 mb-1">
              <div className="flex-1"><FSlider value={bpm} min={20} max={300} step={1} defaultVal={120} onChange={setBpm} color="#f97316" enabled={bpmEnabled}/></div>
              <span className={`text-base font-black tabular-nums w-8 text-right flex-shrink-0 ${bpmEnabled?'text-orange-400':'text-zinc-600'}`}>{bpm}</span>
            </div>
            <button onClick={()=>tap(tapRef,setBpm)} className={`w-full py-1 rounded-lg border text-[8px] font-black uppercase tracking-widest transition-all ${bpmEnabled?'bg-zinc-800 border-orange-500/50 text-orange-400 hover:bg-orange-500/10':'bg-zinc-800 border-zinc-700 text-zinc-600'}`}>TAP</button>
          </div>

          {/* Levels card */}
          <div className="border border-zinc-800 rounded-xl p-3 bg-zinc-950">
            <span className="text-[8px] font-black uppercase text-zinc-600 tracking-widest block mb-2">Levels</span>
            {[['Sub Bass','bass','#818cf8'],['Low','low','#06b6d4'],['Mid','mid','#22d3ee'],['High','treble','#67e8f9'],['RMS','rms','#cffafe']].map(([lbl,key,col])=>(
              <div key={key} className="flex items-center gap-2 mb-1">
                <span className="text-[6px] font-black uppercase w-10 text-zinc-600 flex-shrink-0">{lbl}</span>
                <div className="flex-1 h-2 bg-zinc-900 rounded-full overflow-hidden">
                  <div className="h-full rounded-full" style={{width:`${Math.round((audLevels[key]||0)*100)}%`,background:col,opacity:cyListen?1:0.25,transition:'width 66ms linear'}}/>
                </div>
                <span className="text-[6px] font-black tabular-nums text-zinc-600 w-5 text-right">{cyListen?Math.round((audLevels[key]||0)*100):0}</span>
              </div>
            ))}
            {/* LUFS — integrated average */}
            <div className="mt-1.5 pt-1.5 border-t border-zinc-800/60">
              <div className="flex items-center gap-1 mb-1">
                <span className="text-[6px] font-black uppercase text-zinc-600 flex-1">LUFS Int.</span>
                <div className="flex gap-0.5">
                  {[1,3,10,30].map(s=>(
                    <button key={s} onClick={()=>setCyLufsWindow(s)}
                      className={`px-1 py-0.5 rounded border text-[5px] font-black transition-all ${cyLufsWindow===s?(cyListen?'bg-cyan-500 border-cyan-400 text-white':'bg-zinc-700 border-cyan-400/40 text-cyan-300'):'bg-zinc-900 border-zinc-700 text-zinc-500'}`}>{s}s</button>
                  ))}
                  <button onClick={()=>{lufsAccRef.current=[];setLufsAvg(-70);}}
                    className="px-1 py-0.5 rounded border text-[5px] font-black bg-zinc-900 border-zinc-700 text-zinc-500 hover:border-red-500/50 hover:text-red-400 transition-all">RST</button>
                </div>
                <span className={`text-[6px] font-black tabular-nums w-10 text-right ${cyListen?(audLevels.lufsNorm>0.8?'text-red-400':audLevels.lufsNorm>0.55?'text-yellow-400':'text-green-400'):'text-zinc-600'}`}>
                  {cyListen?(audLevels.lufsInt??-70).toFixed(1):'-∞'}
                </span>
              </div>
              <div className="flex-1 h-2 bg-zinc-900 rounded-full overflow-hidden relative mb-1.5">
                <div className="absolute inset-0 rounded-full" style={{background:'linear-gradient(to right,#22c55e 0%,#22c55e 55%,#eab308 55%,#eab308 80%,#ef4444 80%,#ef4444 100%)',opacity:0.15}}/>
                <div className="h-full rounded-full transition-none" style={{width:`${Math.round((audLevels.lufsNorm||0)*100)}%`,background:audLevels.lufsNorm>0.8?'#ef4444':audLevels.lufsNorm>0.55?'#eab308':'#22c55e',opacity:cyListen?0.9:0.2}}/>
              </div>
            </div>
            {/* Band crossovers */}
            <div className="pt-1.5 border-t border-zinc-800/60">
              <span className="text-[6px] font-black uppercase text-zinc-700 block mb-1">Crossovers</span>
              <div className="space-y-1">
                {[
                  ['Sub/Low', cyXoverSL, setCyXoverSL, 20,   300,  80],
                  ['Low/Mid', cyXoverLM, setCyXoverLM, 100,  2000, 500],
                  ['Mid/High',cyXoverMH, setCyXoverMH, 1000, 16000,4000],
                ].map(([lbl,val,set,mn,mx,def])=>{
                  const logVal=Math.log10(Math.max(mn,val));
                  const logMin=Math.log10(mn), logMax=Math.log10(mx);
                  const hzStr=val>=1000?`${(val/1000).toFixed(1)}k`:`${val}`;
                  return(
                    <div key={lbl} className="flex items-center gap-2">
                      <span className="text-[5.5px] font-black uppercase text-zinc-700 w-11 flex-shrink-0">{lbl}</span>
                      <div className="flex-1"><FSlider value={logVal} min={logMin} max={logMax} step={0.01} defaultVal={Math.log10(def)} onChange={v=>set(Math.round(Math.pow(10,v)))} color="#06b6d4" enabled={cyListen}/></div>
                      <span className="text-[5.5px] font-black tabular-nums text-cyan-500 w-9 text-right">{hzStr}Hz</span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 mt-2 pt-2 border-t border-zinc-800/60">
              <div><div className="flex justify-between text-[6px] font-black uppercase text-zinc-700 mb-0.5"><span>Sens</span><span className="text-cyan-500">{Math.round(cySens*100)}%</span></div><FSlider value={cySens} min={0.1} max={2} step={0.01} defaultVal={0.65} onChange={setCySens} color="#06b6d4" enabled={cyListen}/></div>
              <div><div className="flex justify-between text-[6px] font-black uppercase text-zinc-700 mb-0.5"><span>Smooth</span><span className="text-cyan-500">{Math.round(cySmooth*100)}%</span></div><FSlider value={cySmooth} min={0} max={0.97} step={0.01} defaultVal={0.72} onChange={setCySmooth} color="#06b6d4" enabled={cyListen}/></div>
            </div>
          </div>
        </div>

        {/* ── Column 2: LFO Bank + Pin Matrix ──────────────────────────── */}
        <div className="space-y-3">

          {/* LFO Bank — Ableton-style: waveform preview + playhead per LFO */}
          <div className="border border-zinc-800 rounded-xl p-3 bg-zinc-950">
            <span className="text-[9px] font-black uppercase text-zinc-400 tracking-widest block mb-3">LFO Bank</span>
            <div className="grid grid-cols-2 gap-3">
              {lfos.map((lfo,i)=>(
                <div key={i} className={`border rounded-xl p-2.5 flex flex-col gap-2 ${lfo.enabled?'border-violet-500/50 bg-violet-950/20':'border-zinc-800 bg-zinc-900/20'}`}>
                  {/* Header: label + shape symbols + on/off */}
                  <div className="flex items-center justify-between gap-1">
                    <span className={`text-[8px] font-black uppercase tracking-widest flex-shrink-0 ${lfo.enabled?'text-violet-300':'text-zinc-600'}`}>LFO {i+1}</span>
                    {/* Shape selector — icon buttons */}
                    <div className="flex gap-0.5 flex-1 justify-center">
                      {[['∿',0,'Sine'],['△',1,'Tri'],['□',2,'Sq'],['↗',3,'Saw'],['↘',4,'Rev'],['S/H',5,'S&H']].map(([sym,si,title])=>(
                        <button key={si} onClick={()=>setLfo(i,{shape:si})} title={title}
                          className={`w-6 h-5 rounded flex items-center justify-center border transition-all ${lfo.shape===si?(lfo.enabled?'bg-violet-500 border-violet-400 text-white':'bg-zinc-800 border-violet-400/50 text-violet-400'):'bg-zinc-900 border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300'}`}
                          style={{fontSize:'8px',fontWeight:'900'}}>{sym}</button>
                      ))}
                    </div>
                    <button onClick={()=>setLfo(i,{enabled:!lfo.enabled})}
                      className={`w-7 h-5 rounded flex items-center justify-center border text-[6px] font-black uppercase transition-all flex-shrink-0 ${lfo.enabled?'bg-violet-500 border-violet-400 text-white':'bg-zinc-800 border-zinc-700 text-zinc-500 hover:border-violet-500/40'}`}>
                      {lfo.enabled?'ON':'OFF'}</button>
                  </div>

                  {/* Waveform preview with live playhead */}
                  <div className="rounded-lg overflow-hidden border border-zinc-800/60">
                    <LfoWave lfo={lfo} lfoPhaseRef={lfoPhaseRef} idx={i} color="#8b5cf6" w={200} h={44}/>
                  </div>

                  {/* Rate + Depth sliders */}
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <div className="flex justify-between mb-0.5">
                        <span className="text-[5.5px] font-black uppercase text-zinc-600">Rate</span>
                        <span className={`text-[5.5px] font-black tabular-nums ${lfo.enabled?'text-violet-400':'text-zinc-700'}`}>
                          {lfo.bpmSync?`÷${lfo.bpmDiv}`:`${(0.05*Math.pow(40,lfo.rate)).toFixed(2)}hz`}</span>
                      </div>
                      <FSlider value={lfo.rate} min={0} max={1} step={0.01} onChange={v=>setLfo(i,{rate:v})} color="#8b5cf6" enabled={lfo.enabled&&!lfo.bpmSync}/>
                    </div>
                    <div>
                      <div className="flex justify-between mb-0.5">
                        <span className="text-[5.5px] font-black uppercase text-zinc-600">Depth</span>
                        <span className={`text-[5.5px] font-black tabular-nums ${lfo.enabled?'text-violet-400':'text-zinc-700'}`}>{Math.round(lfo.depth*100)}%</span>
                      </div>
                      <FSlider value={lfo.depth} min={0} max={1} step={0.01} onChange={v=>setLfo(i,{depth:v})} color="#8b5cf6" enabled={lfo.enabled}/>
                    </div>
                  </div>

                  {/* BPM sync row */}
                  <div className="flex items-center gap-1 pt-1 border-t border-zinc-800/40">
                    <button onClick={()=>setLfo(i,{bpmSync:!lfo.bpmSync})}
                      className={`px-2 py-0.5 rounded border text-[5.5px] font-black uppercase tracking-widest transition-all flex-shrink-0 ${lfo.bpmSync&&bpmEnabled?(lfo.enabled?'bg-orange-500 border-orange-400 text-white':'bg-zinc-800 border-orange-400/50 text-orange-400'):'bg-zinc-800 border-zinc-700 text-zinc-500 hover:border-zinc-600'}`}>
                      BPM Sync</button>
                    {lfo.bpmSync&&[1,2,4,8,16].map(d=>(
                      <button key={d} onClick={()=>setLfo(i,{bpmDiv:d})}
                        className={`flex-1 py-0.5 rounded border text-center transition-all ${lfo.bpmDiv===d?(lfo.enabled&&bpmEnabled?'bg-orange-500 border-orange-400 text-white':'bg-zinc-800 border-orange-400/50 text-orange-400'):'bg-zinc-800 border-zinc-700 text-zinc-500 hover:border-zinc-600'}`}
                        style={{fontSize:'5.5px',fontWeight:'900'}}>÷{d}</button>
                    ))}
                    {/* Live value bar */}
                    <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden ml-1">
                      <div className="h-full rounded-full transition-none"
                        style={{width:`${Math.round((lfoValsRef.current[i]||0)*100/(lfos[i].depth||0.7)||0)}%`,
                                background:lfo.enabled?'#8b5cf6':'#3f3f46',
                                opacity:lfo.enabled?0.9:0.3}}/>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Pin Matrix — fixed-column grid, no rotated text */}
          <div className="border border-zinc-800 rounded-xl p-3 bg-zinc-950">
            <div className="flex justify-between items-center mb-2">
              <span className="text-[9px] font-black uppercase text-zinc-400 tracking-widest">Mod Matrix</span>
              <button onClick={()=>setAudPins(()=>{const m={};AUD_SOURCES.forEach(s=>{m[s]={};AUD_TARGETS.forEach(t=>{m[s][t]=false;});});return m;})}
                className="px-2 py-0.5 rounded border text-[6px] font-black uppercase text-zinc-600 border-zinc-700 hover:border-zinc-500 hover:text-zinc-400 transition-all">Clear</button>
            </div>

            {/* Target header row — labels sit directly above their column */}
            <div style={{display:'grid',gridTemplateColumns:`56px repeat(${AUD_TARGETS.length},1fr)`,gap:'1px',marginBottom:'2px'}}>
              <div/>
              {AUD_TARGET_LABELS.map((lbl,ti)=>(
                <div key={ti} style={{textAlign:'center',fontSize:'4.5px',fontWeight:'900',textTransform:'uppercase',color:'#52525b',
                  letterSpacing:'0.03em',lineHeight:1.1,padding:'2px 1px',wordBreak:'break-all'}}>
                  {lbl.replace(/([A-Z])/g,' $1').trim()}
                </div>
              ))}
            </div>

            {/* Source rows */}
            {AUD_SOURCES.map((src,si)=>{
              const isLfo=src.startsWith('lfo');
              const isActive=isLfo?(lfos[parseInt(src[3])-1]?.enabled):(cyListen&&(audLevels[src]||0)>0.01);
              const srcVal=isLfo?(lfoValsRef.current[parseInt(src[3])-1]||0):((audLevels[src]||0));
              return(
                <div key={src} style={{display:'grid',gridTemplateColumns:`56px repeat(${AUD_TARGETS.length},1fr)`,gap:'1px',
                  background:si%2===0?'rgba(39,39,42,0.3)':'transparent',borderRadius:'3px',marginBottom:'1px'}}>
                  {/* Source label + mini level bar */}
                  <div style={{display:'flex',alignItems:'center',gap:'3px',padding:'3px 2px'}}>
                    <span style={{fontSize:'5.5px',fontWeight:'900',textTransform:'uppercase',width:'22px',flexShrink:0,
                      color:isActive?(isLfo?'#a78bfa':'#22d3ee'):(isLfo?'#6d28d9':'#3f3f46')}}>
                      {AUD_SOURCE_LABELS[si]}</span>
                    <div style={{flex:1,height:'3px',background:'#27272a',borderRadius:'9999px',overflow:'hidden',minWidth:'12px'}}>
                      <div style={{height:'100%',borderRadius:'9999px',
                        width:`${Math.round((srcVal||0)*100)}%`,
                        background:isLfo?'#8b5cf6':'#06b6d4',
                        opacity:isActive?0.9:0.15,transition:'none'}}/>
                    </div>
                  </div>
                  {/* Pin buttons — one per target */}
                  {AUD_TARGETS.map((tgt,ti)=>{
                    const on=audPins[src]?.[tgt]||false;
                    return(
                      <div key={tgt} style={{display:'flex',alignItems:'center',justifyContent:'center',padding:'2px 1px'}}>
                        <button onClick={()=>togglePin(src,tgt)}
                          title={`${AUD_SOURCE_LABELS[si]} → ${AUD_TARGET_LABELS[ti]}`}
                          style={{width:'14px',height:'14px',borderRadius:'3px',border:`1px solid ${on?(isLfo?'#7c3aed':'#0891b2'):'#3f3f46'}`,
                            background:on?(isLfo?'#7c3aed33':'#0891b233'):'#09090b',
                            boxShadow:on?(isLfo?'0 0 4px rgba(139,92,246,0.5)':'0 0 4px rgba(6,182,212,0.5)'):'none',
                            cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                          {on&&<span style={{width:'6px',height:'6px',borderRadius:'50%',
                            background:isLfo?'#a78bfa':'#22d3ee',display:'block'}}/>}
                        </button>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

        </div>

        {/* ── Column 3: Vectorscope / Cymatics ──────────────────────────── */}
        <div className={`border rounded-xl p-3 ${isCymatic?'bg-cyan-950/20 border-cyan-400/40':'bg-zinc-950 border-zinc-800'}`}>
          {/* Header */}
          <div className="flex justify-between items-center mb-2">
            <span className="text-[9px] font-black uppercase text-zinc-400 tracking-widest">Visualizer</span>
            <div className="flex gap-1 items-center">
              <span className="text-[6px] font-black uppercase text-zinc-700">Blend</span>
              {[['screen','Scr'],['add','Add'],['overlay','Ovr'],['source-over','Ovr2']].map(([val,lbl])=>(
                <button key={val} onClick={()=>setCyBlend(val)}
                  className={`px-1 py-0.5 rounded border text-[5px] font-black uppercase transition-all ${cyBlend===val?(isCymatic?'bg-cyan-500 border-cyan-400 text-white':'bg-zinc-800 border-cyan-400/50 text-cyan-300'):'bg-zinc-800 border-zinc-700 text-zinc-500 hover:border-zinc-600'}`}>{lbl}</button>
              ))}
            </div>
          </div>

          {/* Mode grid */}
          <div className="grid grid-cols-4 gap-1 mb-2">
            {[['VScope',0],['Polar',1],['3D Wave',2],['Phosphor',3],['Spc Orbit',4],['Particles',5],['Diffrnl',6],['Fractal',7],['Neural',8],['Shard',9]].map(([lbl,id])=>(
              <button key={id} onClick={()=>setCyMode(id)}
                className={`py-1 rounded border text-[5px] font-black uppercase leading-tight transition-all ${cyMode===id?(isCymatic?'bg-cyan-500 border-cyan-400 text-white':'bg-zinc-800 border-cyan-400/60 text-cyan-300'):'bg-zinc-800 border-zinc-700 text-zinc-500 hover:border-zinc-600'}`}>{lbl}</button>
            ))}
          </div>
          {(()=>{
            // ── Per-mode capability map ────────────────────────────────────────
            // Defines which controls are meaningful for each mode.
            const m=cyMode;
            const hasWaveform    =[0,1,2,3,4,6,9].includes(m); // uses L/R waveform
            const hasSpectrum    =[4,5,7,8].includes(m);        // uses FFT spectrum
            const hasTrails      =[0,1,3,4,6,7,8,9].includes(m); // pCtx persistence
            const hasDecay       =[0,1,3,4,6,7,8,9].includes(m);
            const hasBands       =[0,1,6].includes(m);           // multi-band phase echoes
            const hasWidth       =[0,1,2,3,6,9].includes(m);     // stereo width matters
            const hasPhase       =[0,1,2,3,6,9].includes(m);     // phase offset
            const hasFreqWindow  =[4,5,7,8].includes(m);         // spectrum window
            const hasMirror      =[0,1,2,3,4,6,9].includes(m);
            const hasFill        =[0,1,3,6].includes(m);
            const hasWarp        =[0,1,3,4,6,9].includes(m);     // barrel warp
            const hasSpin        =true;                           // all modes
            const hasNoise       =[0,1,3,4,6,9].includes(m);
            const dim=(has)=>has?'':'opacity-40 pointer-events-none select-none';
            return(<>
            {/* ── Signal ── */}
            <div className="border border-zinc-800/60 rounded-lg p-2 mb-2 space-y-1.5">
              <div className="flex gap-1 mb-1">
                <span className="text-[6px] font-black uppercase text-zinc-600 self-center flex-1">Signal</span>
                <button onClick={()=>setCyAutoGain(v=>!v)} className={`px-2 py-0.5 rounded border text-[5.5px] font-black uppercase transition-all ${cyAutoGain?(isCymatic?'bg-cyan-500 border-cyan-400 text-white':'bg-zinc-700 border-cyan-400/50 text-cyan-300'):'bg-zinc-900 border-zinc-700 text-zinc-500'}`}>Auto Gain</button>
                <button onClick={()=>setCyXYSwap(v=>!v)} className={`px-2 py-0.5 rounded border text-[5.5px] font-black uppercase transition-all ${cyXYSwap?(isCymatic?'bg-cyan-500 border-cyan-400 text-white':'bg-zinc-700 border-cyan-400/50 text-cyan-300'):'bg-zinc-900 border-zinc-700 text-zinc-500'}`}>X/Y Swap</button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className={dim(hasWidth)}><div className="flex justify-between mb-0.5"><span className="text-[5.5px] font-black uppercase text-zinc-700">Width</span><span className={`text-[5.5px] font-black ${isCymatic?'text-cyan-400':'text-zinc-600'}`}>{Math.round(cyStereoWidth*100)}%</span></div><FSlider value={cyStereoWidth} min={0} max={1} step={0.01} defaultVal={0.5} onChange={setCyStereoWidth} color="#06b6d4" enabled={isCymatic}/></div>
                <div className={dim(hasPhase)}><div className="flex justify-between mb-0.5"><span className="text-[5.5px] font-black uppercase text-zinc-700">Phase</span><span className={`text-[5.5px] font-black ${isCymatic?'text-cyan-400':'text-zinc-600'}`}>{Math.round(cyPhaseOff*360)}°</span></div><FSlider value={cyPhaseOff} min={0} max={1} step={0.01} defaultVal={0.25} onChange={setCyPhaseOff} color="#06b6d4" enabled={isCymatic}/></div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className={dim(hasWaveform||hasFreqWindow)}><div className="flex justify-between mb-0.5"><span className="text-[5.5px] font-black uppercase text-zinc-700">Freq Window</span><span className={`text-[5.5px] font-black ${isCymatic?'text-cyan-400':'text-zinc-600'}`}>{cyFreqHz?(cyFreqLoHz>=1000?`${(cyFreqLoHz/1000).toFixed(0)}k`:`${cyFreqLoHz}`)+'–'+(cyFreqHiHz>=1000?`${(cyFreqHiHz/1000).toFixed(0)}k`:`${cyFreqHiHz}`)+'Hz':`${Math.round(cyFreqLo*100)}–${Math.round(cyFreqHi*100)}%`}</span></div><RangeSlider lo={cyFreqHz?Math.log10(Math.max(20,cyFreqLoHz))/Math.log10(20000):cyFreqLo} hi={cyFreqHz?Math.log10(Math.max(20,cyFreqHiHz))/Math.log10(20000):cyFreqHi} onLoChange={v=>cyFreqHz?setCyFreqLoHz(Math.round(Math.pow(10,v*Math.log10(20000)))):setCyFreqLo(v)} onHiChange={v=>cyFreqHz?setCyFreqHiHz(Math.round(Math.pow(10,v*Math.log10(20000)))):setCyFreqHi(v)} color="#06b6d4" enabled={isCymatic}/></div>
                <div><div className="flex justify-between mb-0.5"><span className="text-[5.5px] font-black uppercase text-zinc-700">Intensity</span><span className={`text-[5.5px] font-black ${isCymatic?'text-cyan-400':'text-zinc-600'}`}>{Math.round(cyAmt*100)}%</span></div><FSlider value={cyAmt} min={0} max={1} step={0.01} defaultVal={0.75} onChange={setCyAmt} color="#06b6d4" enabled={isCymatic}/></div>
              </div>
              <div><div className="flex justify-between mb-0.5"><span className="text-[5.5px] font-black uppercase text-zinc-700">Smooth</span><span className={`text-[5.5px] font-black ${isCymatic?'text-cyan-400':'text-zinc-600'}`}>{cySmooth===0?'Raw':cySmooth<0.4?'Lo':cySmooth<0.7?'Med':'Hi'} {Math.round(cySmooth*100)}%</span></div><FSlider value={cySmooth} min={0} max={1} step={0.01} defaultVal={0.5} onChange={setCySmooth} color="#06b6d4" enabled={isCymatic}/></div>
            </div>

            {/* ── Render ── */}
            <div className="border border-zinc-800/60 rounded-lg p-2 mb-2 space-y-1.5">
              <div className="flex gap-1 mb-0.5">
                <span className="text-[6px] font-black uppercase text-zinc-600 self-center flex-1">Render</span>
                {[['line','Line'],['point','Dots'],['thick','Thick'],['filled','Fill']].map(([val,lbl])=>(
                  <button key={val} onClick={()=>setCyRender(val)} className={`flex-1 py-0.5 rounded border text-[5.5px] font-black uppercase transition-all ${cyRender===val?(isCymatic?'bg-cyan-500 border-cyan-400 text-white':'bg-zinc-800 border-cyan-400/50 text-cyan-300'):'bg-zinc-800 border-zinc-700 text-zinc-500 hover:border-zinc-600'}`}>{lbl}</button>
                ))}
              </div>
              <div className="grid grid-cols-3 gap-1">
                {[['Glow',cyGlow,()=>setCyGlow(v=>!v),true],['Mirror',cyMirror,()=>setCyMirror(v=>!v),hasMirror],['Grid',cyGridlines,()=>setCyGridlines(v=>!v),true],['Invert',cyInvert,()=>setCyInvert(v=>!v),true]].map(([lbl,on,fn,has])=>(
                  <button key={lbl} onClick={has?fn:undefined} className={`py-0.5 rounded border text-[5.5px] font-black uppercase transition-all ${!has?'opacity-40 cursor-default':''} ${on&&has?(isCymatic?'bg-cyan-500 border-cyan-400 text-white':'bg-zinc-800 border-cyan-400/50 text-cyan-300'):'bg-zinc-800 border-zinc-700 text-zinc-500 hover:border-zinc-600'}`}>{lbl}</button>
                ))}
              </div>
              {cyGlow&&(<div><div className="flex justify-between mb-0.5"><span className="text-[5.5px] font-black uppercase text-zinc-700">Glow Amt</span><span className={`text-[5.5px] font-black ${isCymatic?'text-cyan-400':'text-zinc-600'}`}>{Math.round(cyGlowAmt*100)}%</span></div><FSlider value={cyGlowAmt} min={0} max={1} step={0.01} defaultVal={0.5} onChange={setCyGlowAmt} color="#06b6d4" enabled={isCymatic}/></div>)}
            </div>

            {/* ── Engine Links ── */}
            <div className="border border-zinc-700/60 rounded-lg p-2 mb-2">
              <span className="text-[6px] font-black uppercase text-zinc-500 tracking-widest block mb-1.5">Engine Links</span>
              <div className="grid grid-cols-2 gap-1">
                <button onClick={()=>setCySymLink(v=>!v)} className={`py-1 rounded border text-[5.5px] font-black uppercase transition-all ${cySymLink?(isCymatic?'bg-blue-600 border-blue-400 text-white':'bg-zinc-800 border-blue-400/50 text-blue-300'):'bg-zinc-900 border-zinc-700 text-zinc-500 hover:border-zinc-600'}`}>Eng Xform</button>
                <button onClick={()=>setCySymApply(v=>!v)} className={`py-1 rounded border text-[5.5px] font-black uppercase transition-all ${cySymApply?(isCymatic?'bg-purple-600 border-purple-400 text-white':'bg-zinc-800 border-purple-400/50 text-purple-300'):'bg-zinc-900 border-zinc-700 text-zinc-500 hover:border-zinc-600'}`}>Symmetry</button>
              </div>
              {cySymApply&&(<div className="mt-1.5"><button onClick={()=>setCySymHide(v=>!v)} className={`w-full py-0.5 rounded border text-[5px] font-black uppercase transition-all ${cySymHide?'bg-orange-600 border-orange-400 text-white':'bg-zinc-900 border-zinc-700 text-zinc-500'}`}>Hide Src</button></div>)}
            </div>

            {/* ── Transform ── */}
            <div className="border border-zinc-800/60 rounded-lg p-2 mb-2 space-y-1.5">
              <span className="text-[6px] font-black uppercase text-zinc-600 block mb-1">Transform</span>
              <div className="grid grid-cols-2 gap-2">
                <div><div className="flex justify-between mb-0.5"><span className="text-[5.5px] font-black uppercase text-zinc-700">Zoom</span><span className={`text-[5.5px] font-black ${isCymatic?'text-cyan-400':'text-zinc-600'}`}>{cyScopeZoom.toFixed(2)}×</span></div><FSlider value={cyScopeZoom} min={0.2} max={4.0} step={0.01} defaultVal={1.0} onChange={setCyScopeZoom} color="#06b6d4" enabled={isCymatic}/></div>
                <div><div className="flex justify-between mb-0.5"><span className="text-[5.5px] font-black uppercase text-zinc-700">Rotate</span><span className={`text-[5.5px] font-black ${isCymatic?'text-cyan-400':'text-zinc-600'}`}>{Math.round(cyScopeRot)}°</span></div><FSlider value={cyScopeRot} min={0} max={360} step={1} defaultVal={0} onChange={setCyScopeRot} color="#06b6d4" enabled={isCymatic}/></div>
                <div><div className="flex justify-between mb-0.5"><span className="text-[5.5px] font-black uppercase text-zinc-700">Spin</span><span className={`text-[5.5px] font-black ${isCymatic?'text-cyan-400':'text-zinc-600'}`}>{Math.round(cySpinRate*100)}%</span></div><FSlider value={cySpinRate} min={0} max={1} step={0.01} defaultVal={0} onChange={setCySpinRate} color="#06b6d4" enabled={isCymatic}/></div>
                <div className={dim(hasWarp)}><div className="flex justify-between mb-0.5"><span className="text-[5.5px] font-black uppercase text-zinc-700">Warp</span><span className={`text-[5.5px] font-black ${isCymatic?'text-cyan-400':'text-zinc-600'}`}>{Math.round(cyWarpAmt*100)}%</span></div><FSlider value={cyWarpAmt} min={0} max={1} step={0.01} defaultVal={0} onChange={setCyWarpAmt} color="#06b6d4" enabled={isCymatic}/></div>
              </div>
            </div>

            {/* ── Fractal Style (mode 7 only) ── */}
            {cyMode===7&&(<div className="border border-emerald-900/50 rounded-lg p-2 mb-2 bg-emerald-950/10">
              <span className="text-[6px] font-black uppercase text-emerald-700 block mb-1.5">Fractal Style</span>
              <div className="grid grid-cols-5 gap-1">
                {[['Tree',0],['Coral',1],['Mandala',2],['Web',3],['Flake',4]].map(([lbl,id])=>(
                  <button key={id} onClick={()=>setCyFracStyle(id)} className={`py-1 rounded border text-[5px] font-black uppercase leading-tight transition-all ${cyFracStyle===id?(isCymatic?'bg-emerald-500 border-emerald-400 text-white':'bg-zinc-800 border-emerald-400/60 text-emerald-300'):'bg-zinc-900 border-zinc-700 text-zinc-500 hover:border-zinc-600'}`}>{lbl}</button>
                ))}
              </div>
              <p className="text-[5px] text-zinc-700 mt-1">{['Recursive tree · spectrum spread','Radial coral · chromatic arms','Mandala lace · petal rings','Plasma web · lightning mesh','Snowflake · Koch subdivision'][cyFracStyle]||''}</p>
            </div>)}

            {/* ── Visual Style ── */}
            <div className="border border-zinc-800/60 rounded-lg p-2 mb-2 space-y-1.5">
              <div className="flex justify-between mb-1"><span className="text-[6px] font-black uppercase text-zinc-600">Style</span><span className={`text-[5.5px] font-black tabular-nums ${isCymatic?'text-cyan-400':'text-zinc-600'}`}>Trails {Math.round(cyTrails*100)}%</span></div>
              <div className={dim(hasTrails)}><FSlider value={cyTrails} min={0} max={0.99} step={0.01} defaultVal={0.30} onChange={setCyTrails} color="#06b6d4" enabled={isCymatic}/></div>
              <div className="flex justify-between mt-1"><span className="text-[5.5px] font-black uppercase text-zinc-600">Decay ⓘ</span><span className={`text-[5.5px] font-black tabular-nums ${isCymatic?'text-cyan-400':'text-zinc-600'}`}>{Math.round(cyDecay*100)}%</span></div>
              <div className={dim(hasDecay)}><FSlider value={cyDecay} min={0} max={1} step={0.01} defaultVal={0} onChange={setCyDecay} color="#a78bfa" enabled={isCymatic}/></div>
              <div className="grid grid-cols-2 gap-2 pt-1">
                <div className={dim(hasBands)}>
                  <div className="flex justify-between mb-0.5"><span className="text-[5.5px] font-black uppercase text-zinc-700">Bands</span><span className={`text-[5.5px] font-black ${isCymatic?'text-cyan-400':'text-zinc-600'}`}>{cyFreqBands}</span></div>
                  <div className="flex gap-0.5">{[1,2,3,4].map(n=>(<button key={n} onClick={()=>setCyFreqBands(n)} className={`flex-1 py-0.5 rounded border text-[6px] font-black transition-all ${cyFreqBands===n?(isCymatic?'bg-cyan-500 border-cyan-400 text-white':'bg-zinc-700 border-cyan-400/50 text-cyan-300'):'bg-zinc-900 border-zinc-700 text-zinc-500'}`}>{n}</button>))}</div>
                </div>
                <div className={dim(hasNoise)}>
                  <div className="flex justify-between mb-0.5"><span className="text-[5.5px] font-black uppercase text-zinc-700">Noise</span><span className={`text-[5.5px] font-black ${isCymatic?'text-cyan-400':'text-zinc-600'}`}>{Math.round(cyNoise*100)}%</span></div>
                  <FSlider value={cyNoise} min={0} max={1} step={0.01} defaultVal={0} onChange={setCyNoise} color="#06b6d4" enabled={isCymatic}/>
                </div>
              </div>
              <div className="pt-1 border-t border-zinc-800/40">
                <div className="flex items-center gap-1">
                  <input type="color" value={cyColor} onChange={e=>setCyColor(e.target.value)} className="w-6 h-5 rounded cursor-pointer bg-zinc-900 border border-zinc-700 flex-shrink-0"/>
                  {[['fixed','Fix'],['rainbow','RGB'],['spectrum','Spc'],['source','Src']].map(([val,lbl])=>(<button key={val} onClick={()=>setCyColorMode(val)} className={`flex-1 py-0.5 rounded border text-[5.5px] font-black uppercase transition-all ${cyColorMode===val?(isCymatic?'bg-cyan-500 border-cyan-400 text-white':'bg-zinc-800 border-cyan-400/50 text-cyan-300'):'bg-zinc-800 border-zinc-700 text-zinc-500 hover:border-zinc-600'}`}>{lbl}</button>))}
                </div>
              </div>
            </div>
            </>);})()}
          {/* Reset */}
          <div className="pt-1">
            <button onClick={()=>{setIsCymatic(false);stopAudio();setCyMode(0);setCyAmt(0.75);setCySmooth(0.72);setCySens(0.65);setCyColor('#00ffcc');setCyColorMode('fixed');setCyMirror(false);setCyFill(false);setCyGlow(true);setCyBlend('screen');setCyHideCanvas(false);setCyFreqLo(0);setCyFreqHi(1);setCyLissMode(0);setCyScopeDecay(0.85);setCyScopeLine(true);setCyRender('line');setCyAutoGain(true);setCyStereoWidth(0.5);setCyPhaseOff(0.25);setCyTrails(0.30);setCyScopeZoom(1.0);setCyScopeRot(0);setCySymLink(false);setCySymApply(false);setCyGridlines(false);setCyInvert(false);setCyXYSwap(false);setCyFreqBands(3);setCySpinRate(0);setCyWarpAmt(0);setCyNoise(0);setCyDecay(0);setCyFracStyle(0);setCyLiquidMode(0);setCyPrisLink(false);setCyFluxLink(false);cyPartsRef.current=[];cyWaterfallRef.current=[];cyAutoGainRef.current=1;cySpinRef.current=0;cyFabBassRef.current=0;cyFabRmsRef.current=0;cyFabTrebRef.current=0;cyFabMidRef.current=0;audModRef.current={zoom:0,rotation:0,postRotation:0,entropy:0,flux:0,chroma:0,glyph:0,vignette:0,prismatic:0,symPhase:0,smoke:0,trails:0,speed:0,bpm:0,flash:0,warpAmt:0,fieldAmt:0,glitchAmt:0,retroAmt:0};setAudPins(()=>{const m={};AUD_SOURCES.forEach(s=>{m[s]={};AUD_TARGETS.forEach(t=>{m[s][t]=false;});});return m;});setLfos([{enabled:false,rate:0.3,depth:0.7,shape:0,phase:0,bpmSync:false,bpmDiv:1},{enabled:false,rate:0.3,depth:0.7,shape:0,phase:0,bpmSync:false,bpmDiv:2},{enabled:false,rate:0.3,depth:0.7,shape:0,phase:0,bpmSync:false,bpmDiv:4},{enabled:false,rate:0.3,depth:0.7,shape:0,phase:0,bpmSync:false,bpmDiv:8}]);setCyResetFlash(true);setTimeout(()=>setCyResetFlash(false),300);}}
              disabled={cyAtDefaults}
              className={`w-full py-1.5 rounded-xl border text-[7px] font-black uppercase tracking-widest transition-all ${cyResetFlash?'bg-cyan-900 border-cyan-800 text-cyan-300':!cyAtDefaults?'bg-zinc-800 border-zinc-700 text-zinc-500 hover:border-zinc-600':'bg-zinc-900 border-zinc-800 text-zinc-700 opacity-40 cursor-not-allowed'}`}>RESET AUDIOFX</button>
          </div>
        </div>

      </div>
  );

  const coreFX=(()=>{

    return(
      <div className="bg-zinc-900/40 border border-zinc-700 rounded-2xl p-4">
        <SectionLabel accent="text-zinc-300 border-zinc-500/40 bg-zinc-500/10">COREFX</SectionLabel>
        {/* Core morph param cards */}
        <div className="flex flex-wrap gap-2 mb-4 items-start">
          <CoreParamCard id="speed" label="Speed" value={duration} displayVal={duration>=1000?Math.round(duration/1000)+'s':duration+'ms'} min={300} max={30000} onChange={setDuration} title="Total morph duration" accentColor="#e4e4e7"/>
          {/* Margin chip */}
          <CoreParamCard
            id="margin"
            label="Margin"
            value={splitMargin?marginA/40:pixelationMargin/40}
            value2={splitMargin?marginB/40:undefined}
            displayVal=""
            min={0} max={1} step={0.01}
            onChange={v=>{if(!splitMargin)setPixelationMargin(Math.round(v*40));}}
            title="Morph hold margin"
            accentColor="#a1a1aa"
            labelRight={
              <button onClick={()=>setSplitMargin(v=>!v)}
                style={{lineHeight:'9px',fontSize:'5px',fontWeight:900,padding:'0 3px',borderRadius:3,border:`1px solid ${splitMargin?'#d97706':'#3f3f46'}`,background:splitMargin?'#f59e0b':'#27272a',color:splitMargin?'#000':'#71717a',cursor:'pointer',transition:'all 0.15s'}}>
                A|B
              </button>
            }
            sliderOverride={
              splitMargin
                ? <BracketSlider lo={marginA/40} hi={1-marginB/40} onLoChange={v=>setMarginA(Math.round(v*40))} onHiChange={v=>setMarginB(Math.round((1-v)*40))} color="#f59e0b"/>
                : <FSlider value={pixelationMargin} min={0} max={40} step={1} onChange={setPixelationMargin} color="#a1a1aa" enabled={true}/>
            }
          />
          <CoreParamCard id="density" label="Density" value={particleDensity} displayVal={Math.round(particleDensity*100)+'%'} min={0.01} max={1} step={0.01} onChange={setParticleDensity} title="Fraction of pixels rendered" accentColor="#94a3b8"/>
          <CoreParamCard id="size" label="Size" value={pointSize} displayVal={pointSize+'px'} min={1} max={4} onChange={setPointSize} title="Particle draw size" accentColor="#cbd5e1"/>
          <div className="flex flex-col gap-2">
            <button onClick={()=>setEasingEnabled(v=>!v)} className={`w-[46px] h-[46px] rounded-xl border-2 flex flex-col items-center justify-center gap-0.5 transition-all ${easingEnabled?'bg-zinc-100 text-black border-zinc-200':'bg-zinc-950 text-zinc-500 border-zinc-700 hover:border-zinc-500'}`} title="Ease morph interpolation"><span style={{width:14,height:14}}><I.TrendingUp/></span><span className="text-[5.5px] font-black uppercase tracking-widest">Ease</span></button>
            <button onClick={()=>setHighRefreshMode((highRefreshMode+1)%3)} className={`w-[46px] h-[46px] rounded-xl border-2 flex flex-col items-center justify-center gap-0.5 transition-all ${highRefreshMode===2?'bg-purple-500 text-white border-purple-400':highRefreshMode===1?'bg-emerald-500 text-white border-emerald-400':'bg-zinc-950 text-zinc-500 border-zinc-700 hover:border-zinc-500'}`} title="High refresh mode"><span style={{width:14,height:14}}><I.Monitor/></span><span className="text-[5.5px] font-black uppercase tracking-widest">{highRefreshMode===0?'60':highRefreshMode===1?'120':'144'}Hz</span></button>
          </div>
        </div>

        {/* FX module cards — inline, no wrapper component, sliders work natively */}
        <div className="flex flex-wrap gap-2">

          {/* Trails */}
          <div style={{width:100,minHeight:110}} className={`relative border rounded-xl flex flex-col ${trailsEnabled?'bg-cyan-950/30 border-cyan-500/60':'bg-zinc-950 border-zinc-800'}`}>
            <div className="flex items-center gap-1 px-2 pt-1.5 pb-1">
              <span className="text-[6.5px] font-black uppercase text-zinc-400 tracking-widest flex-1">Trails</span>
              <button onClick={()=>setTrailsEnabled(v=>!v)} className={`w-5 h-5 rounded flex items-center justify-center border text-[6px] font-black transition-all ${trailsEnabled?'bg-cyan-500 border-cyan-400 text-white':'bg-zinc-800 text-zinc-600 border-zinc-700'}`}>T</button>
            </div>
            <div className="px-1.5 pb-1 flex-shrink-0"><FXPreview id="trails" active={trailsEnabled} params={{strength:trailStrength}} accentColor="#06b6d4"/></div>
            <div className="px-2 pb-2 flex-1 flex flex-col justify-end gap-1">
              <div><div className="flex justify-between mb-0.5"><span className="text-[5px] font-black uppercase text-zinc-700">Str</span><span className={`text-[5px] font-black tabular-nums ${trailsEnabled?'text-cyan-400':'text-zinc-700'}`}>{Math.round(trailStrength*100)}%</span></div>
              <FSlider value={trailStrength} min={0} max={0.99} color="#06b6d4" enabled={trailsEnabled} defaultVal={0.5} onChange={setTrailStrength} {...lfoRP("trails")}/></div>
              <div className="flex gap-1 mt-0.5">{[['Pre',trailPre,()=>setTrailPre(v=>!v)],['Post',trailPost,()=>setTrailPost(v=>!v)]].map(([l,a,fn])=>(<button key={l} onClick={fn} className={`flex-1 py-0.5 rounded text-[5px] font-black uppercase border transition-all ${a?(trailsEnabled?'bg-cyan-500 border-transparent text-white':'bg-zinc-700 border-zinc-600 text-zinc-300'):'bg-zinc-800 border-zinc-700 text-zinc-600'}`}>{l}</button>))}</div>
            </div>
          </div>

          {/* Smoke */}
          <div style={{width:100,minHeight:110}} className={`relative border rounded-xl flex flex-col ${smokeEnabled?'bg-violet-950/30 border-violet-500/60':'bg-zinc-950 border-zinc-800'}`}>
            <div className="flex items-center gap-1 px-2 pt-1.5 pb-1">
              <span className="text-[6.5px] font-black uppercase text-zinc-400 tracking-widest flex-1">Smoke</span>
              <button onClick={()=>setSmokeEnabled(v=>!v)} className={`w-5 h-5 rounded flex items-center justify-center border text-[6px] font-black transition-all ${smokeEnabled?'bg-violet-500 border-violet-400 text-white':'bg-zinc-800 text-zinc-600 border-zinc-700'}`}>S</button>
            </div>
            <div className="px-1.5 pb-1 flex-shrink-0"><FXPreview id="smoke" active={smokeEnabled} params={{rise:smokeRise,strength:smokeStrength}} accentColor="#8b5cf6"/></div>
            <div className="px-2 pb-2 flex-1 flex flex-col justify-end gap-1">
              <div><div className="flex justify-between mb-0.5"><span className="text-[5px] font-black uppercase text-zinc-700">Str</span><span className={`text-[5px] font-black tabular-nums ${smokeEnabled?'text-violet-400':'text-zinc-700'}`}>{Math.round(smokeStrength*100)}%</span></div>
              <FSlider value={smokeStrength} min={0} max={0.99} color="#8b5cf6" enabled={smokeEnabled} defaultVal={0.5} onChange={setSmokeStrength} {...lfoRP("smoke")}/></div>
              <div><div className="flex justify-between mb-0.5"><span className="text-[5px] font-black uppercase text-zinc-700">Rise</span><span className={`text-[5px] font-black tabular-nums ${smokeEnabled?'text-violet-400':'text-zinc-700'}`}>{Math.round(smokeRise*100)}%</span></div>
              <FSlider value={smokeRise} min={0} max={1} color="#7c3aed" enabled={smokeEnabled} defaultVal={0.5} onChange={setSmokeRise}/></div>
              <div className="flex gap-1 mt-0.5">{[['Pre',smokePre,()=>setSmokePre(v=>!v)],['Post',smokePost,()=>setSmokePost(v=>!v)]].map(([l,a,fn])=>(<button key={l} onClick={fn} className={`flex-1 py-0.5 rounded text-[5px] font-black uppercase border transition-all ${a?(smokeEnabled?'bg-violet-500 border-transparent text-white':'bg-zinc-700 border-zinc-600 text-zinc-300'):'bg-zinc-800 border-zinc-700 text-zinc-600'}`}>{l}</button>))}</div>
            </div>
          </div>

          {/* Chroma */}
          <div style={{width:100,minHeight:110}} className={`relative border rounded-xl flex flex-col ${chromaEnabled?'bg-rose-950/20 border-rose-500/50':'bg-zinc-950 border-zinc-800'}`}>
            <div className="flex items-center gap-1 px-2 pt-1.5 pb-1">
              <span className="text-[6.5px] font-black uppercase text-zinc-400 tracking-widest flex-1">Chroma</span>
              <button onClick={()=>setChromaEnabled(v=>!v)} className={`w-5 h-5 rounded flex items-center justify-center border text-[6px] font-black transition-all ${chromaEnabled?'bg-rose-500 border-rose-400 text-white':'bg-zinc-800 text-zinc-600 border-zinc-700'}`}>CA</button>
            </div>
            <div className="px-1.5 pb-1 flex-shrink-0"><FXPreview id="chroma" active={chromaEnabled} params={{amt:chromaAmt}} accentColor="#f43f5e"/></div>
            <div className="px-2 pb-2 flex-1 flex flex-col justify-end gap-1">
              <div><div className="flex justify-between mb-0.5"><span className="text-[5px] font-black uppercase text-zinc-700">Amt</span><span className={`text-[5px] font-black tabular-nums ${chromaEnabled?'text-rose-400':'text-zinc-700'}`}>{Math.round(chromaAmt*100)}%</span></div>
              <FSlider value={chromaAmt} min={0} max={1} color="#f43f5e" enabled={chromaEnabled} defaultVal={0.4} onChange={setChromaAmt} {...lfoRP("chroma")}/></div>
              <button onClick={()=>setChromaRgbMode(v=>!v)} className={`mt-1 w-full py-0.5 rounded border text-[5px] font-black uppercase transition-all ${chromaRgbMode?(chromaEnabled?'bg-rose-600 border-rose-500 text-white':'bg-zinc-700 border-zinc-600 text-zinc-300'):'bg-zinc-800 border-zinc-700 text-zinc-600'}`}>RGB Bloom</button>
            </div>
          </div>

          {/* Vignette */}
          <div style={{width:100,minHeight:110}} className={`relative border rounded-xl flex flex-col ${vignetteEnabled?'bg-zinc-900 border-zinc-400/50':'bg-zinc-950 border-zinc-800'}`}>
            <div className="flex items-center gap-1 px-2 pt-1.5 pb-1">
              <span className="text-[6.5px] font-black uppercase text-zinc-400 tracking-widest flex-1">Vignette</span>
              <button onClick={()=>setVignetteEnabled(v=>!v)} className={`w-5 h-5 rounded flex items-center justify-center border text-[6px] font-black transition-all ${vignetteEnabled?'bg-zinc-300 border-zinc-200 text-black':'bg-zinc-800 text-zinc-600 border-zinc-700'}`}>VG</button>
            </div>
            <div className="px-1.5 pb-1 flex-shrink-0"><FXPreview id="vignette" active={vignetteEnabled} params={{amt:vignetteAmt}} accentColor="#a1a1aa"/></div>
            <div className="px-2 pb-2 flex-1 flex flex-col justify-end gap-1">
              <div><div className="flex justify-between mb-0.5"><span className="text-[5px] font-black uppercase text-zinc-700">Depth</span><span className={`text-[5px] font-black tabular-nums ${vignetteEnabled?'text-zinc-300':'text-zinc-700'}`}>{Math.round(vignetteAmt*100)}%</span></div>
              <FSlider value={vignetteAmt} min={0} max={1} color="#a1a1aa" enabled={vignetteEnabled} defaultVal={0.5} onChange={setVignetteAmt} {...lfoRP("vignette")}/></div>
            </div>
          </div>

          {/* Grade */}
          <div style={{width:100,minHeight:110}} className={`relative border rounded-xl flex flex-col ${colorGradeEnabled?'bg-amber-950/20 border-amber-500/50':'bg-zinc-950 border-zinc-800'}`}>
            <div className="flex items-center gap-1 px-2 pt-1.5 pb-1">
              <span className="text-[6.5px] font-black uppercase text-zinc-400 tracking-widest flex-1">Grade</span>
              <button onClick={()=>setColorGradeEnabled(v=>!v)} className={`w-5 h-5 rounded flex items-center justify-center border text-[6px] font-black transition-all ${colorGradeEnabled?'bg-amber-500 border-amber-400 text-black':'bg-zinc-800 text-zinc-600 border-zinc-700'}`}>CG</button>
            </div>
            <div className="px-1.5 pb-1 flex-shrink-0"><FXPreview id="grade" active={colorGradeEnabled} params={{hue:colorGradeHue,sat:colorGradeSat,bri:colorGradeBri}} accentColor="#f59e0b"/></div>
            <div className="px-2 pb-2 flex-1 flex flex-col justify-end gap-1">
              <div><div className="flex justify-between mb-0.5"><span className="text-[5px] font-black uppercase text-zinc-700">Hue</span><span className={`text-[5px] font-black tabular-nums ${colorGradeEnabled?'text-amber-400':'text-zinc-700'}`}>{Math.round(colorGradeHue*180)}°</span></div>
              <FSlider value={colorGradeHue} min={-1} max={1} color="#f59e0b" enabled={colorGradeEnabled} defaultVal={0} onChange={setColorGradeHue}/></div>
              <div><div className="flex justify-between mb-0.5"><span className="text-[5px] font-black uppercase text-zinc-700">Sat</span><span className={`text-[5px] font-black tabular-nums ${colorGradeEnabled?'text-amber-400':'text-zinc-700'}`}>{Math.round(colorGradeSat*100)}%</span></div>
              <FSlider value={colorGradeSat} min={0} max={2} color="#f59e0b" enabled={colorGradeEnabled} defaultVal={1} onChange={setColorGradeSat}/></div>
              <div><div className="flex justify-between mb-0.5"><span className="text-[5px] font-black uppercase text-zinc-700">Bri</span><span className={`text-[5px] font-black tabular-nums ${colorGradeEnabled?'text-amber-400':'text-zinc-700'}`}>{Math.round(colorGradeBri*100)}%</span></div>
              <FSlider value={colorGradeBri} min={0.3} max={1.7} color="#f59e0b" enabled={colorGradeEnabled} defaultVal={1} onChange={setColorGradeBri}/></div>
            </div>
          </div>

          {/* Scanlines */}
          <div style={{width:100,minHeight:110}} className={`relative border rounded-xl flex flex-col ${scanlinesEnabled?'bg-green-950/20 border-green-500/50':'bg-zinc-950 border-zinc-800'}`}>
            <div className="flex items-center gap-1 px-2 pt-1.5 pb-1">
              <span className="text-[6.5px] font-black uppercase text-zinc-400 tracking-widest flex-1">Scanlines</span>
              <button onClick={()=>setScanlinesEnabled(v=>!v)} className={`w-5 h-5 rounded flex items-center justify-center border text-[6px] font-black transition-all ${scanlinesEnabled?'bg-green-500 border-green-400 text-white':'bg-zinc-800 text-zinc-600 border-zinc-700'}`}>SC</button>
            </div>
            <div className="px-1.5 pb-1 flex-shrink-0"><FXPreview id="scan" active={scanlinesEnabled} params={{amt:scanlinesAmt,size:scanlinesSize}} accentColor="#22c55e"/></div>
            <div className="px-2 pb-2 flex-1 flex flex-col justify-end gap-1">
              <div><div className="flex justify-between mb-0.5"><span className="text-[5px] font-black uppercase text-zinc-700">Dark</span><span className={`text-[5px] font-black tabular-nums ${scanlinesEnabled?'text-green-400':'text-zinc-700'}`}>{Math.round(scanlinesAmt*100)}%</span></div>
              <FSlider value={scanlinesAmt} min={0} max={1} color="#22c55e" enabled={scanlinesEnabled} defaultVal={0.5} onChange={setScanlinesAmt}/></div>
              <div><div className="flex justify-between mb-0.5"><span className="text-[5px] font-black uppercase text-zinc-700">Size</span><span className={`text-[5px] font-black tabular-nums ${scanlinesEnabled?'text-green-400':'text-zinc-700'}`}>{Math.round(scanlinesSize*100)}%</span></div>
              <FSlider value={scanlinesSize} min={0} max={1} color="#22c55e" enabled={scanlinesEnabled} defaultVal={0.3} onChange={setScanlinesSize}/></div>
            </div>
          </div>

          {/* Linocut */}
          <div style={{width:100,minHeight:110}} className={`relative border rounded-xl flex flex-col ${linocutEnabled?'bg-orange-950/20 border-orange-500/50':'bg-zinc-950 border-zinc-800'}`}>
            <div className="flex items-center gap-1 px-2 pt-1.5 pb-1">
              <span className="text-[6.5px] font-black uppercase text-zinc-400 tracking-widest flex-1">Linocut</span>
              <button onClick={()=>setLinocutEnabled(v=>!v)} className={`w-5 h-5 rounded flex items-center justify-center border text-[6px] font-black transition-all ${linocutEnabled?'bg-orange-500 border-orange-400 text-white':'bg-zinc-800 text-zinc-600 border-zinc-700'}`}>LN</button>
            </div>
            <div className="px-1.5 pb-1 flex-shrink-0"><FXPreview id="lino" active={linocutEnabled} params={{amt:linocutAmt}} accentColor="#f97316"/></div>
            <div className="px-2 pb-2 flex-1 flex flex-col justify-end gap-1">
              <div><div className="flex justify-between mb-0.5"><span className="text-[5px] font-black uppercase text-zinc-700">Edge</span><span className={`text-[5px] font-black tabular-nums ${linocutEnabled?'text-orange-400':'text-zinc-700'}`}>{Math.round(linocutAmt*100)}%</span></div>
              <FSlider value={linocutAmt} min={0} max={1} color="#f97316" enabled={linocutEnabled} defaultVal={0.5} onChange={setLinocutAmt}/></div>
            </div>
          </div>

          {/* Halftone */}
          <div style={{width:100,minHeight:110}} className={`relative border rounded-xl flex flex-col ${halftoneEnabled?'bg-sky-950/20 border-sky-500/50':'bg-zinc-950 border-zinc-800'}`}>
            <div className="flex items-center gap-1 px-2 pt-1.5 pb-1">
              <span className="text-[6.5px] font-black uppercase text-zinc-400 tracking-widest flex-1">Halftone</span>
              <button onClick={()=>setHalftoneEnabled(v=>!v)} className={`w-5 h-5 rounded flex items-center justify-center border text-[6px] font-black transition-all ${halftoneEnabled?'bg-sky-500 border-sky-400 text-white':'bg-zinc-800 text-zinc-600 border-zinc-700'}`}>HT</button>
            </div>
            <div className="px-1.5 pb-1 flex-shrink-0"><FXPreview id="half" active={halftoneEnabled} params={{size:halftoneSize}} accentColor="#0ea5e9"/></div>
            <div className="px-2 pb-2 flex-1 flex flex-col justify-end gap-1">
              <div><div className="flex justify-between mb-0.5"><span className="text-[5px] font-black uppercase text-zinc-700">Size</span><span className={`text-[5px] font-black tabular-nums ${halftoneEnabled?'text-sky-400':'text-zinc-700'}`}>{Math.round(halftoneSize*100)}%</span></div>
              <FSlider value={halftoneSize} min={0} max={1} color="#0ea5e9" enabled={halftoneEnabled} defaultVal={0.3} onChange={setHalftoneSize}/></div>
            </div>
          </div>

          {/* Smear */}
          <div style={{width:100,minHeight:110}} className={`relative border rounded-xl flex flex-col ${smearEnabled?'bg-purple-950/20 border-purple-500/50':'bg-zinc-950 border-zinc-800'}`}>
            <div className="flex items-center gap-1 px-2 pt-1.5 pb-1">
              <span className="text-[6.5px] font-black uppercase text-zinc-400 tracking-widest flex-1">Smear</span>
              <button onClick={()=>setSmearEnabled(v=>!v)} className={`w-5 h-5 rounded flex items-center justify-center border text-[6px] font-black transition-all ${smearEnabled?'bg-purple-500 border-purple-400 text-white':'bg-zinc-800 text-zinc-600 border-zinc-700'}`}>SM</button>
            </div>
            <div className="px-1.5 pb-1 flex-shrink-0"><FXPreview id="smear" active={smearEnabled} params={{amt:smearAmt,angle:smearAngle}} accentColor="#a855f7"/></div>
            <div className="px-2 pb-2 flex-1 flex flex-col justify-end gap-1">
              <div><div className="flex justify-between mb-0.5"><span className="text-[5px] font-black uppercase text-zinc-700">Amt</span><span className={`text-[5px] font-black tabular-nums ${smearEnabled?'text-purple-400':'text-zinc-700'}`}>{Math.round(smearAmt*100)}%</span></div>
              <FSlider value={smearAmt} min={0} max={1} color="#a855f7" enabled={smearEnabled} defaultVal={0.4} onChange={setSmearAmt}/></div>
              <div><div className="flex justify-between mb-0.5"><span className="text-[5px] font-black uppercase text-zinc-700">Angle</span><span className={`text-[5px] font-black tabular-nums ${smearEnabled?'text-purple-400':'text-zinc-700'}`}>{Math.round(smearAngle*360)}°</span></div>
              <FSlider value={smearAngle} min={0} max={1} color="#a855f7" enabled={smearEnabled} defaultVal={0.5} onChange={setSmearAngle}/></div>
            </div>
          </div>

          {/* Dot Matrix */}
          <div style={{width:100,minHeight:110}} className={`relative border rounded-xl flex flex-col ${dotMatrixEnabled?'bg-teal-950/20 border-teal-500/50':'bg-zinc-950 border-zinc-800'}`}>
            <div className="flex items-center gap-1 px-2 pt-1.5 pb-1">
              <span className="text-[6.5px] font-black uppercase text-zinc-400 tracking-widest flex-1">Dot Matrix</span>
              <button onClick={()=>setDotMatrixEnabled(v=>!v)} className={`w-5 h-5 rounded flex items-center justify-center border text-[6px] font-black transition-all ${dotMatrixEnabled?'bg-teal-500 border-teal-400 text-white':'bg-zinc-800 text-zinc-600 border-zinc-700'}`}>DM</button>
            </div>
            <div className="px-1.5 pb-1 flex-shrink-0"><FXPreview id="dots" active={dotMatrixEnabled} params={{size:dotMatrixSize}} accentColor="#14b8a6"/></div>
            <div className="px-2 pb-2 flex-1 flex flex-col justify-end gap-1">
              <div><div className="flex justify-between mb-0.5"><span className="text-[5px] font-black uppercase text-zinc-700">Size</span><span className={`text-[5px] font-black tabular-nums ${dotMatrixEnabled?'text-teal-400':'text-zinc-700'}`}>{Math.round(dotMatrixSize*100)}%</span></div>
              <FSlider value={dotMatrixSize} min={0} max={1} color="#14b8a6" enabled={dotMatrixEnabled} defaultVal={0.3} onChange={setDotMatrixSize}/></div>
            </div>
          </div>

        </div>
      </div>
    );
  })();



  // ── Stage/Source split ────────────────────────────────────────────────────
  // splitRatio: fraction of available width given to MORPH panel (0.35–0.70)
  const [canvasDisplaySize,setCanvasDisplaySize]=React.useState(DIMENSION);
  const [showSource,setShowSource]=React.useState(true);
  const [showCapture,setShowCapture]=React.useState(false);
  const [showSourceFlyout,setShowSourceFlyout]=React.useState(false);

  const stageCanvas=(
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[9px] font-black uppercase tracking-[0.2em] px-2 py-0.5 rounded-sm border text-zinc-300 border-zinc-500/40 bg-zinc-500/10">MORPH</span>
        <div className="flex-1 h-px bg-zinc-800"/>
        {!showSource&&(
          <button onClick={()=>setShowSource(true)}
            className="flex items-center gap-1 px-2 h-5 rounded border text-[6px] font-black uppercase bg-zinc-800 border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-white transition-all" title="Show source panel">
            Source
          </button>
        )}
      </div>
      {/* Canvas — exact pixel size, always square */}
      <div className="relative flex-shrink-0"
        style={{
          width:canvasDisplaySize,height:canvasDisplaySize,
          background:canvasBg,borderRadius:12,
          border:`2px solid ${canvasBg!=='#000000'?canvasBg+'66':'#18181b'}`,
          overflow:'hidden',
          boxShadow:`0 0 0 1px #18181b,0 8px 32px rgba(0,0,0,0.8)${canvasBg!=='#000000'?`,0 0 20px ${canvasBg}44`:''}`,
        }}>
        <canvas ref={canvasRef} width={DIMENSION} height={DIMENSION} style={{width:'100%',height:'100%'}}/>
        {cyBeatFlash&&<div className="absolute inset-0 pointer-events-none" style={{background:'rgba(255,255,255,0.22)',borderRadius:'inherit'}}/>}
        {!imageA&&!imageB&&<div className="absolute inset-0 flex items-center justify-center text-zinc-700 text-[9px] font-black uppercase tracking-widest text-center px-2">Upload Images<br/>to Begin</div>}
        <div className="absolute bottom-1.5 right-1.5 pointer-events-none">
          <span className={`text-[5.5px] font-black tabular-nums tracking-widest px-1.5 py-0.5 rounded`}
            style={{background:'rgba(0,0,0,0.6)',color:canvasDisplaySize===DIMENSION?'#4ade80':'#52525b'}}>
            {canvasDisplaySize===DIMENSION?'● 1:1 NATIVE':canvasDisplaySize<DIMENSION?`½× (${canvasDisplaySize}px)`:`2× (${canvasDisplaySize}px)`}
          </span>
        </div>
      </div>
      {/* Progress bar — matches canvas width exactly */}
      <div className="flex items-center gap-2 flex-shrink-0" style={{width:canvasDisplaySize}}>
        <span className="text-[8px] font-black text-zinc-700 uppercase">A</span>
        <div ref={progressBarRef} onClick={handleProgressClick} className="h-2 flex-1 bg-zinc-900 rounded-full overflow-hidden cursor-pointer hover:bg-zinc-800 relative border border-zinc-800" title="Click to scrub">
          <div ref={progressBarFillRef} className="h-full bg-white shadow-[0_0_10px_white] rounded-full" style={{width:`${progress}%`}}/>
          {(recIn!=='free'||recOut!=='free')&&(()=>{const mv=pixelationMargin/100;const lo=splitMargin?marginA/100:mv;const hi=splitMargin?1-marginB/100:1-mv;const mid=(lo+hi)/2;const res=v=>v==='A'?lo:v==='B'?hi:v==='mid'?mid:null;const iF=res(recIn)??0;const oF=res(recOut)??1;const left=Math.min(iF,oF)*100;const width=Math.abs(oF-iF)*100;return(<><div className="absolute inset-y-0 bg-red-500/20 border-x border-red-500/40" style={{left:`${left}%`,width:`${width}%`}}/></>);})()}
        </div>
        <span className="text-[8px] font-black text-zinc-700 uppercase">B</span>
      </div>
      {/* Transport — unconstrained width, wraps naturally under canvas */}
      <div className="flex items-center gap-1 flex-shrink-0 flex-wrap">
        {[[DIMENSION*0.5,'½×'],[DIMENSION,'1×'],[DIMENSION*2,'2×']].map(([sz,lbl])=>(
          <button key={sz} onClick={()=>setCanvasDisplaySize(sz)}
            className={`px-2 h-8 rounded-xl font-black text-[8px] border transition-all flex-shrink-0 ${canvasDisplaySize===sz?'bg-zinc-200 text-black border-zinc-200':'bg-zinc-900 text-zinc-500 border-zinc-800 hover:border-zinc-600'}`}>
            {lbl}
          </button>
        ))}
        <div className="w-px h-5 bg-zinc-800 flex-shrink-0"/>
        <button onClick={handleUndo} disabled={!undoStack.length} className="w-8 h-8 rounded-xl flex items-center justify-center bg-zinc-900 border border-zinc-800 text-zinc-500 hover:border-zinc-600 hover:text-white disabled:opacity-20 disabled:cursor-not-allowed transition-all flex-shrink-0" title="Undo"><span style={{width:12,height:12}}><I.Undo /></span></button>
        <button onClick={()=>setIsLooping(!isLooping)} className={`px-2 h-8 rounded-xl font-black text-[8px] tracking-widest border transition-all flex-shrink-0 ${isLooping?'bg-zinc-200 text-black border-zinc-200':'bg-zinc-900 text-zinc-500 border-zinc-800 hover:border-zinc-600'}`}>LOOP {isLooping?'●':'○'}</button>
        <button onClick={startMorph} disabled={!imageA||!imageB} className="bg-white text-black px-4 h-8 rounded-xl font-black text-[10px] tracking-widest shadow-[0_0_20px_rgba(255,255,255,0.25)] disabled:opacity-30 disabled:cursor-not-allowed transition-all flex-shrink-0">MORPH</button>
        <button onClick={togglePause} className={`px-2.5 h-8 rounded-xl font-black text-[8px] tracking-widest border transition-all flex-shrink-0 ${isPaused?'bg-zinc-900 text-zinc-500 border-zinc-800':'bg-red-500 text-white border-red-500 shadow-[0_0_12px_rgba(239,68,68,0.4)]'}`}>{isPaused?'RESUME':'STOP'}</button>
        <span className="text-sm font-black italic text-white tabular-nums flex-shrink-0 w-9 text-right">{Math.round(progress)}%</span>
      </div>
    </div>
  );


  const sourcePanel=(
    <div className="bg-zinc-900/40 border border-zinc-800 rounded-2xl p-3 flex flex-col gap-2 relative h-full" style={{width:DIMENSION,flexShrink:0}}>
      {/* Header */}
      <div className="flex items-center gap-2">
        <span className="text-[9px] font-black uppercase tracking-[0.2em] px-2 py-0.5 rounded-sm border text-zinc-300 border-zinc-500/40 bg-zinc-500/10">SOURCE</span>
        <div className="flex-1 h-px bg-zinc-800"/>
        {/* Flyout toggle — presets + grade */}
        <button onClick={()=>setShowSourceFlyout(v=>!v)}
          className={`flex items-center gap-1 px-2 h-5 rounded border text-[6px] font-black uppercase transition-all ${showSourceFlyout?'bg-amber-500/20 border-amber-500/40 text-amber-400':'bg-zinc-800 border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300'}`}
          title="Presets + grade controls">
          ⚙
        </button>
        <button onClick={()=>setShowSource(false)}
          className="flex items-center gap-1 px-2 h-5 rounded border text-[6px] font-black uppercase bg-zinc-800 border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300 transition-all">
          Hide
        </button>
      </div>

      {/* A / B thumbnails + RGBL bars — always visible */}
      <div className="grid grid-cols-2 gap-2">
        {/* A */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <span className="text-[7px] font-black uppercase text-zinc-500">A</span>
            <div className="flex gap-0.5">
              <button onClick={swapImages} disabled={!imageA||!imageB} className="w-4 h-4 rounded flex items-center justify-center border bg-zinc-800 text-zinc-500 border-zinc-700 hover:border-zinc-500 hover:text-white disabled:opacity-25 transition-all" title="Swap"><span style={{width:8,height:8}}><I.ArrowLeftRight/></span></button>
              <button onClick={()=>setShowColorA(!showColorA)} className={`w-4 h-4 rounded flex items-center justify-center border transition-all ${showColorA?'bg-white text-black border-white':'bg-zinc-800 text-zinc-600 border-zinc-700 hover:border-zinc-500'}`} title="Full colour preview"><span style={{width:8,height:8}}><I.Layers/></span></button>
            </div>
          </div>
          <div className={`relative bg-black border border-zinc-800 rounded-lg overflow-hidden ${isSwapping?'opacity-0':'opacity-100'}`} style={{aspectRatio:'1/1'}} onMouseEnter={()=>setHoverA(true)} onMouseLeave={()=>setHoverA(false)}>
            {imageA
              ?<img src={imageA} alt="A" className="w-full h-full object-cover pointer-events-none"
                  style={{filter:showColorA?`hue-rotate(${gradeA.hue}deg) saturate(${gradeA.sat}) brightness(${gradeA.bri})`:hoverA?'grayscale(100%) brightness(1)':'grayscale(100%) brightness(0.3)'}}/>
              :<div className="absolute inset-0 flex items-center justify-center text-zinc-700"><span style={{width:18,height:18}}><I.Upload/></span></div>}
            <input type="file" accept="image/*" className="absolute inset-0 opacity-0 cursor-pointer" onChange={e=>handleUpload(e,'A')}/>
          </div>
          <StatsBars stats={statsA}/>
          {/* RGBL grade bars — always visible */}
          <div className="space-y-0.5 mt-0.5">
            {[['H',gradeA.hue,v=>setGradeA(g=>({...g,hue:v})),-180,180,0,'#92400e'],['S',gradeA.sat,v=>setGradeA(g=>({...g,sat:v})),0,2,1,'#3f6212'],['L',gradeA.bri,v=>setGradeA(g=>({...g,bri:v})),0,2,1,'#71717a']].map(([lbl,val,fn,mn,mx,def,col])=>(
              <div key={lbl} className="flex items-center gap-1">
                <span className="text-[5.5px] font-black w-3 flex-shrink-0" style={{color:col}}>{lbl}</span>
                <div className="flex-1"><FSlider value={val} min={mn} max={mx} step={lbl==='H'?1:0.01} defaultVal={def} onChange={fn} color={col} enabled={true}/></div>
                <span className="text-[5px] font-black tabular-nums w-7 text-right" style={{color:val===def?'#3f3f46':col}}>{lbl==='H'?Math.round(val)+'°':val.toFixed(1)}</span>
              </div>
            ))}
            <button onClick={()=>setGradeA({hue:0,sat:1,bri:1})} className="text-[4.5px] font-black uppercase text-zinc-700 hover:text-amber-400 transition-colors w-full text-right">↺ reset</button>
          </div>
        </div>
        {/* B */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <span className="text-[7px] font-black uppercase text-zinc-500">B</span>
            <button onClick={()=>setShowColorB(!showColorB)} className={`w-4 h-4 rounded flex items-center justify-center border transition-all ${showColorB?'bg-white text-black border-white':'bg-zinc-800 text-zinc-600 border-zinc-700 hover:border-zinc-500'}`} title="Full colour preview"><span style={{width:8,height:8}}><I.Layers/></span></button>
          </div>
          <div className={`relative bg-black border border-zinc-800 rounded-lg overflow-hidden ${isSwapping?'opacity-0':'opacity-100'}`} style={{aspectRatio:'1/1'}} onMouseEnter={()=>setHoverB(true)} onMouseLeave={()=>setHoverB(false)}>
            {imageB
              ?<img src={imageB} alt="B" className="w-full h-full object-cover pointer-events-none"
                  style={{filter:showColorB?`hue-rotate(${gradeB.hue}deg) saturate(${gradeB.sat}) brightness(${gradeB.bri})`:hoverB?'grayscale(100%) brightness(1)':'grayscale(100%) brightness(0.3)'}}/>
              :<div className="absolute inset-0 flex items-center justify-center text-zinc-700"><span style={{width:18,height:18}}><I.Upload/></span></div>}
            <input type="file" accept="image/*" className="absolute inset-0 opacity-0 cursor-pointer" onChange={e=>handleUpload(e,'B')}/>
          </div>
          <StatsBars stats={statsB}/>
          <div className="space-y-0.5 mt-0.5">
            {[['H',gradeB.hue,v=>setGradeB(g=>({...g,hue:v})),-180,180,0,'#92400e'],['S',gradeB.sat,v=>setGradeB(g=>({...g,sat:v})),0,2,1,'#3f6212'],['L',gradeB.bri,v=>setGradeB(g=>({...g,bri:v})),0,2,1,'#71717a']].map(([lbl,val,fn,mn,mx,def,col])=>(
              <div key={lbl} className="flex items-center gap-1">
                <span className="text-[5.5px] font-black w-3 flex-shrink-0" style={{color:col}}>{lbl}</span>
                <div className="flex-1"><FSlider value={val} min={mn} max={mx} step={lbl==='H'?1:0.01} defaultVal={def} onChange={fn} color={col} enabled={true}/></div>
                <span className="text-[5px] font-black tabular-nums w-7 text-right" style={{color:val===def?'#3f3f46':col}}>{lbl==='H'?Math.round(val)+'°':val.toFixed(1)}</span>
              </div>
            ))}
            <button onClick={()=>setGradeB({hue:0,sat:1,bri:1})} className="text-[4.5px] font-black uppercase text-zinc-700 hover:text-amber-400 transition-colors w-full text-right">↺ reset</button>
          </div>
        </div>
      </div>

      {/* Flyout — presets + grade (above, absolutely positioned) */}
      {showSourceFlyout&&(
        <div className="absolute z-30 bg-zinc-900 border border-zinc-700 rounded-2xl p-3 shadow-[0_8px_32px_rgba(0,0,0,0.8)]"
          style={{top:'100%',left:0,minWidth:DIMENSION,marginTop:4}}>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[8px] font-black uppercase text-zinc-400 tracking-widest">Presets</span>
            <div className="flex-1 h-px bg-zinc-800"/>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className="text-[6px] font-black uppercase text-zinc-600 block mb-1">A</span>
              <div className="grid grid-cols-3 gap-0.5">{PRESETS.map(t=>(<button key={t} onClick={()=>handlePreset(t,'A')} className="text-[4.5px] py-0.5 bg-zinc-800 border border-zinc-700 rounded hover:bg-zinc-700 uppercase font-black transition-all text-zinc-500 hover:text-zinc-300">{t}</button>))}</div>
            </div>
            <div>
              <span className="text-[6px] font-black uppercase text-zinc-600 block mb-1">B</span>
              <div className="grid grid-cols-3 gap-0.5">{PRESETS.map(t=>(<button key={t} onClick={()=>handlePreset(t,'B')} className="text-[4.5px] py-0.5 bg-zinc-800 border border-zinc-700 rounded hover:bg-zinc-700 uppercase font-black transition-all text-zinc-500 hover:text-zinc-300">{t}</button>))}</div>
            </div>
          </div>
          <button onClick={()=>setShowSourceFlyout(false)} className="mt-2 w-full text-[5px] font-black uppercase text-zinc-700 hover:text-zinc-400 transition-colors text-center">Close ✕</button>
        </div>
      )}
    </div>
  );


  // AudioFX collapsible state
  const [audioExpanded,setAudioExpanded]=React.useState(false);

  return(
    <div style={{fontFamily:'monospace'}} className="flex flex-col items-center min-h-screen bg-zinc-950 text-zinc-100 overflow-auto">
      {showSplash&&<SplashScreen onDone={()=>setShowSplash(false)}/>}
      <GlobalStyles/>

      {/* ── TOPBAR ────────────────────────────────────────────────────────── */}
      <div className="w-full sticky top-0 z-50 bg-zinc-950/95 backdrop-blur-sm border-b border-zinc-900">
        <div className="max-w-[1800px] mx-auto px-4 h-12 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 flex-shrink-0">
            <span style={{width:18,height:18}} className="text-zinc-400"><I.Shuffle /></span>
            <h1 className="text-[11px] font-black uppercase italic tracking-tighter text-zinc-300 whitespace-nowrap">MORPHOLOGY <span className="text-zinc-600">// PIXEL ALCHEMIST</span></h1>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-[6px] font-black uppercase text-zinc-700 tracking-widest hidden sm:block">Engine</span>
            <button onClick={expandAll} title="Expand all modules" className="flex items-center gap-1 px-2 h-7 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300 transition-all">
              <span className="text-[9px] font-black">⊞</span><span className="text-[6px] font-black uppercase tracking-widest">All</span>
            </button>
            <button onClick={collapseAll} title="Collapse all modules" className="flex items-center gap-1 px-2 h-7 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300 transition-all">
              <span className="text-[9px] font-black">⊟</span><span className="text-[6px] font-black uppercase tracking-widest">All</span>
            </button>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            {/* Panel toggles */}
            <button onClick={()=>setShowCapture(v=>!v)}
              className={`flex items-center gap-1.5 px-2.5 h-7 rounded-lg border font-black text-[6px] uppercase tracking-widest transition-all ${showCapture?'bg-red-500/20 border-red-500/40 text-red-400':'bg-zinc-900 border-zinc-800 text-zinc-500 hover:border-red-700/60 hover:text-red-400'}`}>
              <span style={{width:11,height:11}}>{isRecording?<I.Stop/>:<I.Video/>}</span>Capture
              {isRecording&&<span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse"/>}
            </button>
            <button onClick={()=>setShowGifConverter(v=>!v)}
              className={`flex items-center gap-1.5 px-2.5 h-7 rounded-lg border font-black text-[6px] uppercase tracking-widest transition-all ${showGifConverter?'bg-violet-600/30 border-violet-500/50 text-violet-300':'bg-zinc-900 border-zinc-800 text-zinc-500 hover:border-violet-700/60 hover:text-violet-400'}`}>
              <span style={{width:11,height:11}}><I.Film/></span>GIF
            </button>
            <div className="w-px h-6 bg-zinc-800"/>
            {/* Frame + Popout */}
            <button onClick={exportFrame} className="flex items-center gap-1.5 px-2.5 h-7 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300 transition-all"><span style={{width:11,height:11}}><I.Image /></span><span className="text-[6px] font-black uppercase tracking-widest">Frame</span></button>
            <div className="flex gap-1">{[0.5,1,2].map(sc=>(<button key={sc} onClick={()=>openPopout(sc)} className="px-1.5 h-7 rounded-lg border text-[6px] font-black uppercase bg-zinc-900 border-zinc-800 text-zinc-500 hover:border-zinc-700 hover:text-zinc-300 transition-all">{sc}×</button>))}</div>
            <div className="w-px h-6 bg-zinc-800"/>
            <div className="text-right leading-none">
              <div className="pre-beta-shine text-[10px] font-black uppercase tracking-wider">PRE-BETA</div>
              <div className="text-[11px] font-black text-zinc-500 tracking-tight">Build 855</div>
            </div>
          </div>
        </div>
      </div>

      <div className="w-full max-w-[1800px] px-4 py-4 flex flex-col gap-4">

        {/* ── STAGE + SOURCE — flex row, SOURCE hideable ────────────────── */}
        <div className="flex gap-4 items-stretch">

          {/* MORPH panel — auto-width, shrinks to canvas size */}
          <div className="bg-zinc-900/40 border border-zinc-800 rounded-2xl p-4 flex-shrink-0">
            {stageCanvas}
          </div>

          {/* SOURCE panel — toggleable */}
          {showSource&&(
            <div className="flex-1 min-w-0">
              {sourcePanel}
            </div>
          )}

        </div>

        {/* ── CAPTURE panel (toggleable from topbar) ────────────────────── */}
        {showCapture&&(
          <div className="bg-zinc-900/40 border border-zinc-800 rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[9px] font-black uppercase tracking-[0.2em] px-2 py-0.5 rounded-sm border text-red-400 border-red-500/40 bg-red-500/10">CAPTURE</span>
              <div className="flex-1 h-px bg-zinc-800"/>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {/* Record controls */}
              <div className="flex items-center gap-2">
                <button onClick={isRecording?stopRecording:startRecording}
                  className={`flex items-center gap-2 px-4 h-9 rounded-xl border font-black text-[9px] uppercase tracking-widest transition-all ${isRecording?'bg-red-500 border-red-400 text-white shadow-[0_0_16px_rgba(239,68,68,0.5)]':'bg-zinc-900 border-zinc-700 text-zinc-400 hover:border-red-500/60 hover:text-red-400'}`}>
                  <span style={{width:12,height:12}}>{isRecording?<I.Stop/>:<I.Video/>}</span>{isRecording?'Stop':'Rec WebM'}
                </button>
                {exportStatus&&<span className={`text-[9px] font-black tracking-widest ${exportStatus.startsWith('●')?'text-red-400 animate-pulse':'text-zinc-400'}`}>{exportStatus}</span>}
              </div>
              <div className="w-px h-8 bg-zinc-800"/>
              {/* In/Out points */}
              <div className="flex items-center gap-1.5">
                <span className="text-[8px] font-black uppercase text-zinc-600 w-4">In</span>
                <div className="flex gap-1">{[['A','Phase A'],['mid','Mid'],['B','Phase B'],['free','Free']].map(([v,title])=>(<button key={v} onClick={()=>setRecIn(v)} title={title} className={`px-2 py-1 rounded-lg border text-[8px] font-black uppercase transition-all ${recIn===v?'bg-red-500 border-red-400 text-white':'bg-zinc-900 border-zinc-700 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300'}`}>{v==='mid'?'Mid':v==='free'?'—':v}</button>))}</div>
              </div>
              <span style={{width:12,height:12}} className="text-zinc-700"><I.ArrowRight /></span>
              <div className="flex items-center gap-1.5">
                <span className="text-[8px] font-black uppercase text-zinc-600 w-5">Out</span>
                <div className="flex gap-1">{[['A','Phase A'],['mid','Mid'],['B','Phase B'],['free','Free']].map(([v,title])=>(<button key={v} onClick={()=>setRecOut(v)} title={title} className={`px-2 py-1 rounded-lg border text-[8px] font-black uppercase transition-all ${recOut===v?'bg-red-500 border-red-400 text-white':'bg-zinc-900 border-zinc-700 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300'}`}>{v==='mid'?'Mid':v==='free'?'—':v}</button>))}</div>
              </div>
              <button onClick={()=>setRecCycle(!recCycle)} className={`px-3 py-1.5 rounded-xl border text-[8px] font-black uppercase tracking-widest transition-all ${recCycle?'bg-red-500 border-red-400 text-white':'bg-zinc-900 border-zinc-700 text-zinc-500 hover:border-zinc-600'}`}>Cycle</button>
              <div className="w-px h-8 bg-zinc-800"/>
              {/* Popout */}
              <div className="flex items-center gap-2">
                <span className="text-[8px] font-black uppercase text-zinc-600">Popout</span>
                <div className="flex gap-1">{[0.5,1,2,3].map(sc=>(<button key={sc} onClick={()=>openPopout(sc)} className="px-2 py-1 rounded-lg border text-[8px] font-black uppercase bg-zinc-900 border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-white transition-all">{sc}×</button>))}</div>
              </div>
              <div className="w-px h-8 bg-zinc-800"/>
              {/* BG / Chroma Key */}
              <div className="flex items-center gap-1.5">
                <span className="text-[8px] font-black uppercase text-zinc-600 tracking-widest">BG</span>
                {[['#000000','Black'],['#00ff00','Chroma Green'],['#ff00ff','Chroma Magenta']].map(([col,label])=>(
                  <button key={col} onClick={()=>setCanvasBg(col)} title={label}
                    className="w-7 h-7 rounded-lg border flex items-center justify-center transition-all"
                    style={{background:canvasBg===col?col+'33':'#18181b',borderColor:canvasBg===col?col:'#3f3f46',boxShadow:canvasBg===col?`0 0 8px ${col}55`:'none'}}>
                    <span style={{width:10,height:10,borderRadius:'50%',background:col,border:col==='#000000'?'1px solid #52525b':'none',display:'block',boxShadow:canvasBg===col&&col!=='#000000'?`0 0 6px ${col}`:''}}/>
                  </button>
                ))}
                <input type="color" value={canvasBg} onChange={e=>setCanvasBg(e.target.value)}
                  className="w-7 h-7 rounded-lg border border-zinc-700 cursor-pointer bg-zinc-900" style={{padding:'2px'}}
                  title="Custom BG colour"/>
              </div>
            </div>
            {/* Record range indicator */}
            {(recIn!=='free'||recOut!=='free')&&(
              <div className="mt-3 relative h-2 bg-zinc-900 rounded-full overflow-hidden border border-zinc-800">
                {(()=>{const mv=pixelationMargin/100;const lo=splitMargin?marginA/100:mv;const hi=splitMargin?1-marginB/100:1-mv;const mid=(lo+hi)/2;const res=v=>v==='A'?lo:v==='B'?hi:v==='mid'?mid:null;const iF=res(recIn)??0;const oF=res(recOut)??1;const left=Math.min(iF,oF)*100;const width=Math.abs(oF-iF)*100;return(<><div className="absolute inset-y-0 bg-red-500/25 border-x border-red-500/50" style={{left:`${left}%`,width:`${width}%`}}/><div className="absolute inset-y-0 w-0.5 bg-white/30" style={{left:`${progress}%`}}/></>);})()}
              </div>
            )}
          </div>
        )}

        {/* ── GIF Converter panel (toggleable from topbar) ──────────────── */}
        {showGifConverter&&(
          <div className="bg-zinc-900/40 border border-violet-900/40 rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-[9px] font-black uppercase tracking-[0.2em] px-2 py-0.5 rounded-sm border text-violet-400 border-violet-500/40 bg-violet-500/10">GIF CONVERTER</span>
              <div className="flex-1 h-px bg-zinc-800"/>
              <button onClick={()=>setShowGifConverter(false)} className="text-[8px] font-black text-zinc-600 hover:text-zinc-400 transition-colors">✕</button>
            </div>
            <GifConverter/>
          </div>
        )}

        {/* ── ENGINE RACK ───────────────────────────────────────────────── */}
        {engineFX}

        {/* ── SIGNAL CHAIN (CoreFX) ─────────────────────────────────────── */}
        {coreFX}

        {/* ── SIGNAL — full width audio meters, always mounted ────────────── */}

        {/* ── AUDIO MATRIX (collapsible — titlebar matches SectionLabel style) ── */}
        <div className="bg-zinc-900/40 border border-cyan-900/40 rounded-2xl overflow-hidden">
          <button onClick={()=>setAudioExpanded(v=>!v)}
            className="w-full flex items-center gap-2 px-4 pt-3 pb-3 hover:bg-cyan-950/10 transition-all"
          >
            <span className="text-[9px] font-black uppercase tracking-[0.2em] px-2 py-0.5 rounded-sm border text-cyan-400 border-cyan-500/40 bg-cyan-500/10 whitespace-nowrap flex items-center gap-1.5">
              AUDIOFX
              {cyListen&&<span className="w-1.5 h-1.5 rounded-full bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.8)] animate-pulse inline-block"/>}
            </span>
            <div className="flex-1 h-px bg-zinc-800"/>
            <span className={`text-[8px] font-black tabular-nums ml-1 transition-colors ${audioExpanded?'text-cyan-500':'text-zinc-600'}`}>{audioExpanded?'▲':'▼'}</span>
          </button>
          {audioExpanded&&(
            <div className="border-t border-cyan-900/40 px-4 pb-4">
              {audioFX}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
