import { useEffect, useRef } from 'react';
import { clipBeatToTime, clipTimeToBeat } from '../utils/audioClips';
import { midiToPitchRow } from '../utils/pitchMap';
import { MIDI_OFFSET } from '../utils/transcribe';

// A heat map of what the pitch model hears in a recording, drawn behind the piano roll: one row
// per piano-roll pitch, brighter where that pitch is more likely sounding. It lines up with the
// roll's rows and with the tempo map, so you can read the notes off it and paint them in.
const TILE = 4096;
const FPS = 22050 / 256;
const ANNOT_FRAMES = Math.floor(22050 / 256) * 2;
const WINDOW_OFFSET = (256 / 22050) * (ANNOT_FRAMES - (22050 * 2 - 256) / 256) + 0.0018;

// file time (s) -> model frame (inverse of the model's own time base)
const timeToFrame = (t) => (t + WINDOW_OFFSET * Math.floor((t * FPS) / ANNOT_FRAMES)) * FPS;

function accentRgb() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  const m = /^#([0-9a-f]{6})$/i.exec(raw);
  if (m) { const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  return [156, 54, 181];
}

export default function PitchHeat({
  analysis, clip, map, startX, widthPx, totalRows, rowHeight, xToBeat, beatToX, sig,
}) {
  const refs = useRef([]);
  // The map and the beat<->x functions are new objects on every render; the drawing only reruns
  // when `sig` (a string describing everything that affects the picture) changes.
  const latest = useRef(null);
  latest.current = { clip, map, startX, widthPx, totalRows, rowHeight, xToBeat, beatToX };
  const tiles = Math.max(1, Math.ceil(widthPx / TILE));
  const height = Math.round(totalRows * rowHeight);

  useEffect(() => {
    const { clip, map, startX, widthPx, totalRows, rowHeight, xToBeat, beatToX } = latest.current;
    if (!analysis || widthPx <= 0) return;
    const frames = analysis.frames;
    const nFrames = frames.length;
    const [r, g, b] = accentRgb();
    const rowOfCol = new Int32Array(88).fill(-1); // activation column -> piano-roll row
    for (let c = 0; c < 88; c++) rowOfCol[c] = midiToPitchRow(c + MIDI_OFFSET);

    for (let ti = 0; ti < tiles; ti++) {
      const canvas = refs.current[ti];
      if (!canvas) continue;
      const w = Math.min(TILE, Math.ceil(widthPx - ti * TILE));
      canvas.width = w;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(w, height);
      const px = img.data;
      // file time at each pixel edge of this tile
      const edge = (x) => {
        const beat = xToBeat(startX + ti * TILE + x);
        return clipBeatToTime(clip, beat, map);
      };
      let tPrev = edge(0);
      for (let x = 0; x < w; x++) {
        const tNext = edge(x + 1);
        const f0 = Math.max(0, Math.floor(timeToFrame(Math.min(tPrev, tNext))));
        const f1 = Math.min(nFrames - 1, Math.max(f0, Math.floor(timeToFrame(Math.max(tPrev, tNext)))));
        tPrev = tNext;
        if (f0 >= nFrames) continue;
        const step = Math.max(1, Math.ceil((f1 - f0 + 1) / 6)); // sample long ranges
        for (let c = 0; c < 88; c++) {
          const row = rowOfCol[c];
          if (row < 0 || row >= totalRows) continue;
          let v = 0;
          for (let f = f0; f <= f1; f += step) { const a = frames[f][c]; if (a > v) v = a; }
          if (v < 0.06) continue;
          const alpha = Math.min(1, Math.pow(Math.min(1, v * 1.35), 0.85)) * 0.85 * 255;
          const y0 = Math.round((totalRows - 1 - row) * rowHeight);
          const y1 = Math.min(height, Math.round((totalRows - row) * rowHeight));
          for (let y = y0; y < y1; y++) {
            const o = (y * w + x) * 4;
            px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = alpha;
          }
        }
      }
      ctx.putImageData(img, 0, 0);
      // thin white ticks where the attacks (plucks) were detected: a note should start on one
      if (analysis.attacks && beatToX) {
        ctx.fillStyle = 'rgba(255,255,255,0.28)';
        for (const t of analysis.attacks) {
          if (t < clip.srcStart || t > clip.srcEnd) continue;
          const x = Math.round(beatToX(clipTimeToBeat(clip, t, map)) - startX - ti * TILE);
          if (x >= 0 && x < w) ctx.fillRect(x, 0, 1, height);
        }
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis, sig, tiles, height]);

  return (
    <div className="pitch-heat" style={{ left: startX, top: 0, width: widthPx, height }}>
      {Array.from({ length: tiles }, (_, ti) => (
        <canvas
          key={ti}
          ref={(el) => { refs.current[ti] = el; }}
          style={{ position: 'absolute', left: ti * TILE, top: 0, height }}
        />
      ))}
    </div>
  );
}
