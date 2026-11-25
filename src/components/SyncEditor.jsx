import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { getClips, getSyncPoints, clipBeatToTime, clipTimeToBeat } from '../utils/audioClips';
import { onsetTimes } from '../utils/beatDetect';
import { barStartBeats } from '../utils/barLayout';

const ROW_H = 18;       // each ruler row
const HEAD_H = ROW_H * 2; // time (seconds) row + grid (bar.beat) row
const HIT = 6;          // px grab distance

// Sync editor: the recording's waveform with your notes as stems standing on it. Drag a stem to the
// spot where the sound really is and a sync point is made for that note, so you do not have to
// create and align many sync points by hand. Sync points are the yellow lines (right-click removes).
export default function SyncEditor({
  tracks, activeTrackId, tempoMap, timeSignature = [4, 4], barSubdivisions = [], selectedBeat, currentBeat, playing, getBuffer,
  onSetPin, onRemovePin, onSelectBeat, onUndo, onRedo,
}) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const [size, setSize] = useState({ w: 600, h: 200 });
  const [view, setView] = useState({ t0: 0, pps: 60 }); // first visible second, pixels per second
  const [hover, setHover] = useState(null);
  const [snapOn, setSnapOn] = useState(true);
  const dragRef = useRef(null);

  const audio = useMemo(() => {
    const list = tracks.filter(t => t.type === 'audio' && getClips(t).length > 0);
    // the recording that owns the tempo map is the one whose sync points the timeline shows
    if (tempoMap && tempoMap.active) { const ref = list.find(t => t.id === tempoMap.refId); if (ref) return ref; }
    return list.find(t => t.id === activeTrackId) || list[0] || null;
  }, [tracks, activeTrackId, tempoMap]);
  const noteTrack = useMemo(() => {
    const list = tracks.filter(t => t.type !== 'audio');
    return list.find(t => t.id === activeTrackId && t.notes.length) || list.find(t => t.notes.length) || list[0] || null;
  }, [tracks, activeTrackId]);
  const buffer = audio ? getBuffer(audio.id) : null;
  const duration = buffer ? buffer.duration : (audio?.audioDuration || 0);
  const clip = audio ? getClips(audio)[0] : null;
  const m = audio && tempoMap ? tempoMap.forTrack(audio) : null;
  const allPins = audio ? getSyncPoints(audio) : [];
  // Only the part of the recording that is still on the track is shown: trimming or cropping the clip
  // on the audio track (removing an intro, say) trims it here too.
  const spans = useMemo(() => (audio ? getClips(audio).map(c => [c.srcStart, c.srcEnd]) : []), [audio]);
  const tMin = spans.length ? Math.min(...spans.map(x => x[0])) : 0;
  const tMax = spans.length ? Math.max(...spans.map(x => x[1])) : duration;
  const inSpan = useCallback((t) => spans.some(([a, b]) => t >= a - 1e-6 && t <= b + 1e-6), [spans]);
  const pins = useMemo(() => allPins.filter(p => inSpan(p.time)), [allPins, inSpan]);

  const beatTime = useCallback((b) => (clip && m ? clipBeatToTime(clip, b, m) : 0), [clip, m]);
  const timeBeat = useCallback((t) => (clip && m ? clipTimeToBeat(clip, t, m) : 0), [clip, m]);
  const anchor = tempoMap && tempoMap.active ? tempoMap.anchor : null;

  // stems: notes grouped by beat
  const stems = useMemo(() => {
    if (!noteTrack || !clip || !m) return [];
    const by = new Map();
    noteTrack.notes.forEach((n) => {
      const key = Math.round(n.beat * 1000);
      if (!by.has(key)) by.set(key, { beat: n.beat, notes: [] });
      by.get(key).notes.push(n);
    });
    return [...by.values()].map(s => ({ ...s, time: beatTime(s.beat) })).filter(s => inSpan(s.time)).sort((a, b) => a.beat - b.beat);
  }, [noteTrack, clip, m, beatTime, inSpan]);

  const pinTime = useCallback((p) => p.time, []);
  const onsets = useMemo(() => {
    if (!buffer) return [];
    try { return onsetTimes(buffer); } catch { return []; }
  }, [buffer]);

  // size
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setSize({ w: Math.max(100, el.clientWidth), h: Math.max(80, el.clientHeight) }));
    ro.observe(el);
    setSize({ w: Math.max(100, el.clientWidth), h: Math.max(80, el.clientHeight) });
    return () => ro.disconnect();
  }, []);

  const spanKey = `${audio?.id}|${tMin.toFixed(3)}|${tMax.toFixed(3)}`;
  const lastSpan = useRef(null);
  useEffect(() => {
    if (lastSpan.current === spanKey) return;
    lastSpan.current = spanKey;
    setView(v => ({ ...v, t0: tMin }));
  }, [spanKey, tMin]);

  const tx = useCallback((t) => (t - view.t0) * view.pps, [view]);
  const xt = useCallback((x) => view.t0 + x / view.pps, [view]);

  // draw
  const headBeat = playing && currentBeat != null ? currentBeat : selectedBeat;
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.floor(size.w * dpr);
    cv.height = Math.floor(size.h * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(cv);
    const col = (n, d) => (css.getPropertyValue(n).trim() || d);
    const ink = col('--ink', '#0b0b0f'), hair = col('--hairline', '#2a2a33'), mute = col('--mute', '#888');
    const soft = col('--soft', '#bbb'), amber = col('--amber', '#f5a623');
    g.fillStyle = ink; g.fillRect(0, 0, size.w, size.h);
    if (!audio || !buffer) {
      g.fillStyle = mute; g.font = '12px sans-serif';
      g.fillText('Load an audio track to line your notes up with the recording.', 16, 32);
      return;
    }
    // the notation sits in a band above the waveform; the waveform has the rest
    const bandTop = HEAD_H + 4;
    const bandH = Math.max(76, Math.round(Math.max(80, Math.min(size.h * 0.5, 190)) / 3)); // a third of what it was
    const laneTop = bandTop + bandH + 4, laneH = Math.max(30, size.h - laneTop - 6);
    const mid = laneTop + laneH / 2;
    g.fillStyle = col('--raise', '#15151b'); g.globalAlpha = 0.5; g.fillRect(0, bandTop, size.w, bandH); g.globalAlpha = 1;
    g.strokeStyle = hair; g.beginPath(); g.moveTo(0, laneTop - 2.5); g.lineTo(size.w, laneTop - 2.5); g.stroke();
    // ruler: seconds on top, the grid (bar.beat) underneath
    g.fillStyle = col('--raise', '#15151b'); g.fillRect(0, 0, size.w, HEAD_H);
    g.strokeStyle = hair; g.beginPath(); g.moveTo(0, ROW_H + 0.5); g.lineTo(size.w, ROW_H + 0.5); g.stroke();
    const step = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60].find(s => s * view.pps >= 60) || 60;
    g.font = '10px monospace'; g.textBaseline = 'middle';
    for (let rt = Math.ceil((view.t0 - tMin) / step) * step; tx(tMin + rt) < size.w; rt += step) {
      const t = rt; const x = tx(tMin + rt);
      g.strokeStyle = hair; g.beginPath(); g.moveTo(x + 0.5, ROW_H - 5); g.lineTo(x + 0.5, ROW_H); g.stroke();
      g.fillStyle = mute; g.fillText(`${Math.floor(t / 60)}:${(t % 60).toFixed(step < 1 ? 1 : 0).padStart(step < 1 ? 4 : 2, '0')}`, x + 3, ROW_H / 2);
    }
    if (barSubdivisions.length) {
      const starts = barStartBeats(barSubdivisions);
      for (let bi = 0; bi < barSubdivisions.length; bi++) {
        const x0 = tx(beatTime(starts[bi]));
        const x1 = tx(beatTime(starts[bi] + barSubdivisions[bi]));
        if (x1 < 0) continue;
        if (x0 > size.w) break;
        // bar line through the whole editor
        g.strokeStyle = hair; g.globalAlpha = 0.7;
        g.beginPath(); g.moveTo(x0 + 0.5, ROW_H); g.lineTo(x0 + 0.5, size.h); g.stroke(); g.globalAlpha = 1;
        g.fillStyle = soft; g.font = 'bold 10px monospace';
        g.fillText(String(bi + 1), x0 + 3, ROW_H + ROW_H / 2);
        // the beats inside the bar, numbered when there is room
        const per = (x1 - x0) / barSubdivisions[bi];
        if (per >= 9) {
          g.font = '9px monospace';
          for (let c = 1; c < barSubdivisions[bi]; c++) {
            const xc = x0 + per * c;
            g.strokeStyle = hair; g.globalAlpha = 0.45;
            g.beginPath(); g.moveTo(xc + 0.5, ROW_H + 8); g.lineTo(xc + 0.5, HEAD_H); g.stroke(); g.globalAlpha = 1;
            if (per >= 26) { g.fillStyle = mute; g.fillText(`${bi + 1}.${c + 1}`, xc + 2, ROW_H + ROW_H / 2); }
          }
        }
      }
    }
    // waveform
    const d = buffer.getChannelData(0), sr = buffer.sampleRate;
    g.fillStyle = soft; g.globalAlpha = 0.55;
    for (let x = 0; x < size.w; x++) {
      if (!inSpan(xt(x))) continue;
      const a = Math.floor(xt(x) * sr), b = Math.floor(xt(x + 1) * sr);
      if (b < 0 || a >= d.length) continue;
      const stride = Math.max(1, Math.floor((b - a) / 200));
      let mn = 1, mx = -1;
      for (let i = Math.max(0, a); i < Math.min(d.length, b); i += stride) { if (d[i] < mn) mn = d[i]; if (d[i] > mx) mx = d[i]; }
      if (mx < mn) continue;
      g.fillRect(x, mid - mx * (laneH / 2), 1, Math.max(1, (mx - mn) * (laneH / 2)));
    }
    g.globalAlpha = 1;
    // attacks (faint ticks at the top)
    g.strokeStyle = mute; g.globalAlpha = 0.35;
    onsets.filter(inSpan).forEach((o) => { const x = tx(o); if (x >= 0 && x <= size.w) { g.beginPath(); g.moveTo(x + 0.5, laneTop); g.lineTo(x + 0.5, laneTop + 6); g.stroke(); } });
    g.globalAlpha = 1;
    // sync points
    pins.forEach((p) => {
      const x = tx(pinTime(p));
      if (x < -2 || x > size.w + 2) return;
      g.strokeStyle = amber; g.lineWidth = hover?.kind === 'pin' && hover.id === p.id ? 3 : 2;
      g.beginPath(); g.moveTo(x + 0.5, HEAD_H); g.lineTo(x + 0.5, size.h); g.stroke(); g.lineWidth = 1;
      g.fillStyle = amber; g.fillRect(x - 3, HEAD_H, 7, 5);
      // the grid beat this point sits on (quarter notes, from 1), to match the pin on the timeline
      const gb = ((anchor ?? 0) + p.beat) * 4 / (timeSignature[1] || 4) + 1;
      g.font = '10px monospace'; g.textBaseline = 'top';
      g.fillText(String(Math.round(gb * 100) / 100), x + 5, HEAD_H + 1);
    });
    // notation: every note is a head (hollow for half notes and longer, filled otherwise) on a stem,
    // with flags, and beams between neighbouring short notes
    const den = timeSignature[1] || 4;
    const allPitch = noteTrack ? noteTrack.notes.map(n => n.stringIndex * 24 + n.fret) : [0, 1];
    const pLo = Math.min(...allPitch), pHi = Math.max(...allPitch, pLo + 1);
    const headY = (n) => bandTop + 28 + (1 - ((n.stringIndex * 24 + n.fret) - pLo) / (pHi - pLo)) * Math.max(6, bandH - 38);
    const STEM = 20;
    const laid = stems.map((st) => {
      const x = tx(st.time);
      // notes that sound together are stacked on one stem, each head clearly above the one below
      const GAP = 9;
      const stack = st.notes.map(headY).sort((a, b) => b - a); // lowest head first
      for (let i = 1; i < stack.length; i++) stack[i] = Math.min(stack[i], stack[i - 1] - GAP);
      const lift = Math.max(0, (bandTop + STEM + 6) - stack[stack.length - 1]);
      const ys = stack.map(y => y + lift);
      const q = Math.max(...st.notes.map(n => (n.duration * 4) / den)); // longest note, in quarter notes
      return { st, x, ys, q, top: Math.min(...ys) - STEM, bottom: Math.max(...ys) };
    });
    // beamed runs share one flat beam level
    const linked = (a, b) => a && b && a.q <= 0.5 && b.q <= 0.5 && b.st.beat - a.st.beat <= 1.0001;
    for (let k = 0; k < laid.length;) {
      let e = k;
      while (linked(laid[e], laid[e + 1])) e++;
      if (e > k) {
        const top = Math.min(...laid.slice(k, e + 1).map(l => l.top));
        for (let j = k; j <= e; j++) laid[j].top = top;
      }
      k = e + 1;
    }
    const lw = (on) => (on ? 2 : 1.4);
    laid.forEach((l, k) => {
      const { st, x, ys, q } = l;
      if (x < -20 || x > size.w + 20) return;
      const on = hover?.kind === 'stem' && hover.beat === st.beat;
      g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = lw(on);
      // a faint line down to the waveform shows exactly which moment the note is pinned to
      g.globalAlpha = on ? 0.55 : 0.22;
      g.beginPath(); g.moveTo(x + 0.5, l.bottom); g.lineTo(x + 0.5, laneTop + laneH); g.stroke();
      g.globalAlpha = 1;
      const hasStem = q < 4;
      if (hasStem) { g.beginPath(); g.moveTo(x + 5, l.top); g.lineTo(x + 5, l.bottom); g.stroke(); }
      ys.forEach((y) => {
        g.save(); g.translate(x, y); g.rotate(-0.35);
        g.beginPath(); g.ellipse(0, 0, on ? 6.4 : 5.6, on ? 4.6 : 4, 0, 0, Math.PI * 2);
        if (q >= 2) { g.fillStyle = ink; g.fill(); g.lineWidth = 1.6; g.stroke(); } else g.fill();
        g.restore();
      });
      // flags for a short note that is not beamed to its neighbour
      const next = laid[k + 1], prev = laid[k - 1];
      const beamNext = next && q <= 0.5 && next.q <= 0.5 && next.st.beat - st.beat <= 1.0001;
      const beamPrev = prev && q <= 0.5 && prev.q <= 0.5 && st.beat - prev.st.beat <= 1.0001;
      if (hasStem && q <= 0.5 && !beamNext && !beamPrev) {
        const flags = q <= 0.25 ? 2 : 1;
        for (let f = 0; f < flags; f++) {
          g.beginPath(); g.moveTo(x + 5, l.top + f * 6);
          g.quadraticCurveTo(x + 14, l.top + 8 + f * 6, x + 10, l.top + 18 + f * 6);
          g.lineWidth = 1.8; g.stroke();
        }
      }
      if (beamNext) {
        const n2 = next;
        const beams = Math.min(q, n2.q) <= 0.25 ? 2 : 1;
        for (let b2 = 0; b2 < beams; b2++) {
          g.beginPath();
          g.moveTo(x + 5, l.top + b2 * 6); g.lineTo(n2.x + 5, n2.top + b2 * 6);
          g.lineWidth = 3.2; g.stroke();
        }
      }
    });
    // playhead
    const px = tx(beatTime(headBeat));
    if (px >= 0 && px <= size.w) { g.strokeStyle = '#fff'; g.beginPath(); g.moveTo(px + 0.5, 0); g.lineTo(px + 0.5, size.h); g.stroke(); }
  }, [size, view, audio, buffer, stems, pins, onsets, hover, headBeat, beatTime, tx, xt, noteTrack, pinTime]);

  // hit testing
  const hitAt = (x) => {
    let best = null, bestD = HIT;
    stems.forEach((s) => { const d = Math.abs(tx(s.time) - x); if (d < bestD) { bestD = d; best = { kind: 'stem', beat: s.beat, time: s.time }; } });
    if (!best) pins.forEach((p) => { const d = Math.abs(tx(pinTime(p)) - x); if (d < bestD) { bestD = d; best = { kind: 'pin', id: p.id, beat: p.beat, time: p.time }; } });
    return best;
  };
  const localX = (e) => e.clientX - canvasRef.current.getBoundingClientRect().left;

  const snapTime = (t, alt) => {
    if (!snapOn || alt || !onsets.length) return t;
    let best = null, bestPx = 7;
    for (const o of onsets) { const px = Math.abs(o - t) * view.pps; if (px < bestPx) { bestPx = px; best = o; } }
    return best != null ? best : t;
  };

  const onDown = (e) => {
    if (!audio) return;
    const x = localX(e);
    const hit = hitAt(x);
    if (e.button === 2) {
      if (hit?.kind === 'pin') { e.preventDefault(); onRemovePin(audio.id, hit.id); }
      return;
    }
    if (e.button !== 0) return;
    if (!hit) {
      onSelectBeat(Math.max(0, timeBeat(xt(x))));
      return;
    }
    // a pin is dragged by the beat it pins (its file beat plus the file origin)
    const beat = hit.kind === 'stem' ? hit.beat : (anchor ?? 0) + hit.beat;
    e.preventDefault();
    let started = false;
    const move = (ev) => {
      const lx = ev.clientX - canvasRef.current.getBoundingClientRect().left;
      const t = Math.max(0, snapTime(xt(lx), ev.altKey));
      const ok = onSetPin(audio.id, beat, t, started ? 'move' : 'start');
      if (ok === false && !started) { cleanup(); return; }
      started = true;
    };
    const cleanup = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', cleanup); document.body.classList.remove('dock-resizing'); dragRef.current = null; };
    dragRef.current = true;
    document.body.classList.add('dock-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', cleanup);
  };

  const onMove = (e) => {
    if (dragRef.current) return;
    const h = hitAt(localX(e));
    setHover(prev => (prev?.kind === h?.kind && prev?.id === h?.id && prev?.beat === h?.beat ? prev : h));
  };

  const onWheel = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const x = localX(e);
    if (e.ctrlKey || e.metaKey) {
      const f = Math.exp(-e.deltaY * 0.01);
      setView((v) => {
        const pps = Math.min(2000, Math.max(4, v.pps * f));
        const t = v.t0 + x / v.pps;
        return { pps, t0: Math.max(tMin - 1, t - x / pps) };
      });
    } else {
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      setView(v => ({ ...v, t0: Math.max(tMin - 1, Math.min(tMax, v.t0 + dx / v.pps)) }));
    }
  };
  // non-passive wheel so the page does not scroll
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return undefined;
    cv.addEventListener('wheel', onWheel, { passive: false });
    return () => cv.removeEventListener('wheel', onWheel);
  });

  const zoom = (f) => setView(v => ({ ...v, pps: Math.min(2000, Math.max(4, v.pps * f)) }));
  const fit = () => setView({ t0: tMin, pps: Math.max(4, (size.w - 8) / Math.max(0.5, tMax - tMin)) });

  return (
    <div className="sync-editor">
      <div className="sync-bar">
        <span className="sync-title">{audio ? audio.name : 'No audio track'}</span>
        <span className="sync-info">{pins.length} sync point{pins.length === 1 ? '' : 's'}</span>
        <span className="ub-spacer" />
        <button className="settings-btn-sm" onClick={onUndo} title="Undo (Ctrl+Z)" aria-label="Undo sync edit">↶ Undo</button>
        <button className="settings-btn-sm" onClick={onRedo} title="Redo (Ctrl+Y)" aria-label="Redo sync edit">↷ Redo</button>
        <label className="ub-check" title="Pull dragged stems onto the recording's attacks (hold Alt to switch off)">
          <input type="checkbox" checked={snapOn} onChange={(e) => setSnapOn(e.target.checked)} /> Snap to attacks
        </label>
        <button className="settings-btn-sm" onClick={() => zoom(0.7)} title="Zoom out">−</button>
        <button className="settings-btn-sm" onClick={() => zoom(1.4)} title="Zoom in">+</button>
        <button className="settings-btn-sm" onClick={fit} title="Fit the whole recording">Fit</button>
      </div>
      <div className="sync-canvas-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          style={{ width: size.w, height: size.h, cursor: hover ? 'ew-resize' : 'crosshair' }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerLeave={() => !dragRef.current && setHover(null)}
          onContextMenu={(e) => e.preventDefault()}
        />
      </div>
      <p className="sync-hint">
        Drag a stem to where its sound is in the waveform: that makes a sync point for that note. Scroll to pan,
        Ctrl/⌘+scroll to zoom, click to place the playhead, right-click a yellow line to remove it.
      </p>
    </div>
  );
}
