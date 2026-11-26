import { prepareScrub, scrubTarget, scrubHold, scrubStop } from '../utils/scrubVoice';
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
  onSetPin, onMovePin, onMoveStem, onRemovePin, onSelectBeat, onUndo, onRedo, onSetAudioOptions, onAddAtPlayhead, onAutoSync, onClearSync, onDetectTempo,
  loop = false, loopStart = 0, loopEnd = 0, setLoop, setLoopStart, setLoopEnd,
}) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const [size, setSize] = useState({ w: 600, h: 200 });
  // The grid is the fixed axis (like the Timeline): t0 = first visible timeline beat, pps = pixels per beat.
  // The recording is drawn stretched or squeezed against it by the sync points.
  const [view, setView] = useState({ t0: 0, pps: 30 });
  const [hover, setHover] = useState(null);
  const [snapOn, setSnapOn] = useState(true);
  const dragRef = useRef(null);

  const [audioChoice, setAudioChoice] = useState(null);
  const [pairOpen, setPairOpen] = useState(false);
  const audioList = useMemo(() => tracks.filter(t => t.type === 'audio' && getClips(t).length > 0), [tracks]);
  const audio = useMemo(() => {
    const chosen = audioList.find(t => t.id === audioChoice);
    if (chosen) return chosen;
    // the recording that owns the tempo map is the one whose sync points are in use
    if (tempoMap && tempoMap.active) { const ref = audioList.find(t => t.id === tempoMap.refId); if (ref) return ref; }
    return audioList.find(t => t.id === activeTrackId) || audioList[0] || null;
  }, [audioList, audioChoice, activeTrackId, tempoMap]);
  // Which note tracks are paired with this recording (its stems): chosen here, kept on the audio track.
  // Nothing chosen = the active note track, or the first one with notes.
  const noteTrackList = useMemo(() => tracks.filter(t => t.type !== 'audio'), [tracks]);
  const pairedIds = audio?.syncNotes;
  const pairedTracks = useMemo(() => {
    if (Array.isArray(pairedIds) && pairedIds.length) return noteTrackList.filter(t => pairedIds.includes(t.id));
    const auto = noteTrackList.find(t => t.id === activeTrackId && t.notes.length) || noteTrackList.find(t => t.notes.length) || noteTrackList[0];
    return auto ? [auto] : [];
  }, [noteTrackList, pairedIds, activeTrackId]);
  const noteSource = useMemo(() => pairedTracks.flatMap(t => t.notes), [pairedTracks]);
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
  const timeBeatRef = useRef(null);
  const timeBeat = useCallback((t) => (clip && m ? clipTimeToBeat(clip, t, m) : 0), [clip, m]);
  timeBeatRef.current = timeBeat;
  const playingNow = useRef(playing); playingNow.current = playing;
  const onSelectBeatRef = useRef(onSelectBeat); onSelectBeatRef.current = onSelectBeat;
  const anchor = tempoMap && tempoMap.active ? tempoMap.anchor : null;

  // stems: notes grouped by beat
  const stems = useMemo(() => {
    if (!noteSource.length || !clip || !m) return [];
    const by = new Map();
    noteSource.forEach((n) => {
      const key = Math.round(n.beat * 1000);
      if (!by.has(key)) by.set(key, { beat: n.beat, notes: [] });
      by.get(key).notes.push(n);
    });
    return [...by.values()].map(s => ({ ...s, time: beatTime(s.beat) })).filter(s => inSpan(s.time)).sort((a, b) => a.beat - b.beat);
  }, [noteSource, clip, m, beatTime, inSpan]);

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
    setView(v => ({ ...v, t0: Math.max(0, timeBeatRef.current ? timeBeatRef.current(tMin) : 0) }));
  }, [spanKey, tMin]);

  // file time <-> screen x, through the grid
  const tx = useCallback((t) => (timeBeat(t) - view.t0) * view.pps, [view, timeBeat]);
  const xt = useCallback((x) => beatTime(view.t0 + x / view.pps), [view, beatTime]);
  const bMin = timeBeat(tMin), bMax = timeBeat(tMax);

  // follow the playhead while playing: page to the right when it reaches the edge
  const followB = playing && currentBeat != null ? currentBeat : null;
  useEffect(() => {
    if (followB == null || !size.w) return;
    setView((v) => {
      const x = (followB - v.t0) * v.pps;
      if (x >= 0 && x <= size.w * 0.92) return v;
      return { ...v, t0: Math.max(0, followB - (size.w * 0.08) / v.pps) };
    });
  }, [followB, size.w]);

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
    const soft = col('--soft', '#bbb');
    g.fillStyle = ink; g.fillRect(0, 0, size.w, size.h);
    if (!audio || !buffer) {
      g.fillStyle = mute; g.font = '12px sans-serif';
      g.fillText('Load an audio track to line your notes up with the recording.', 16, 32);
      return;
    }
    // One strip like Soundslice's: the grey waveform behind, the notation on top of it, numbered
    // sync markers standing through both with a red cross at the bottom to remove them.
    const stripTop = HEAD_H + 4, stripBottom = size.h - 6;
    const stripH = Math.max(80, stripBottom - stripTop);
    const laneTop = stripTop, laneH = stripH * 0.72;
    const mid = stripTop + stripH * 0.58;   // the waveform's centre: the marker circles sit on it
    const hk = Math.max(0.9, Math.min(1.8, stripH / 240)); // everything below scales with the window
    g.fillStyle = col('--raise', '#15151b'); g.fillRect(0, stripTop - 2, size.w, stripH + 4);
    // ruler: seconds on top, the grid (bar.beat) underneath
    g.fillStyle = col('--raise', '#15151b'); g.fillRect(0, 0, size.w, HEAD_H);
    g.strokeStyle = hair; g.beginPath(); g.moveTo(0, ROW_H + 0.5); g.lineTo(size.w, ROW_H + 0.5); g.stroke();
    const secPx = Math.max(1e-6, Math.abs(tx(tMin + 1) - tx(tMin))) ; // pixels per second near the start
    const step = [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60].find(s => s * secPx >= 60) || 60;
    g.font = '10px monospace'; g.textBaseline = 'middle';
    for (let rt = Math.max(0, Math.ceil((beatTime(view.t0) - tMin) / step) * step); tx(tMin + rt) < size.w && rt <= tMax - tMin; rt += step) {
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
    g.fillStyle = soft; g.globalAlpha = 0.42;
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
    // ---- notation like Soundslice's rhythm view: heads on one baseline with stems, flags and beams,
    // standing on top of the waveform (no staff lines). Notes that sound together are stacked. ----
    const den = timeSignature[1] || 4;
    const fg = '#fff';
    const baseY = stripTop + Math.max(36, stripH * 0.27); // where the lowest head of a stack sits
    const STEM = 24 * hk, GAP = 7 * hk;
    const laid = stems.map((st) => {
      const x = tx(st.time);
      const heads = st.notes.map((n, i) => baseY - i * GAP);
      const q = Math.max(...st.notes.map(n => (n.duration * 4) / den)); // longest note, in quarter notes
      return { st, x, heads, q, top: Math.min(...heads) - STEM, bottom: baseY };
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
    const lw = (on) => (on ? 2 : 1.3);
    laid.forEach((l, k) => {
      const { st, x, heads, q } = l;
      if (x < -20 || x > size.w + 20) return;
      const on = hover?.kind === 'stem' && hover.beat === st.beat;
      g.strokeStyle = fg; g.fillStyle = fg; g.lineWidth = lw(on);
      const hasStem = q < 4;
      if (hasStem) { g.beginPath(); g.moveTo(x + 4 * hk, l.top); g.lineTo(x + 4 * hk, l.bottom); g.stroke(); }
      heads.forEach((y) => {
        g.save(); g.translate(x, y); g.rotate(-0.35);
        g.beginPath(); g.ellipse(0, 0, (on ? 4.6 : 4.1) * hk, (on ? 3.3 : 2.9) * hk, 0, 0, Math.PI * 2);
        if (q >= 2) { g.fillStyle = ink; g.fill(); g.lineWidth = 1.3; g.stroke(); } else g.fill();
        g.restore();
      });
      // flags for a short note that is not beamed to its neighbour
      const next = laid[k + 1], prev = laid[k - 1];
      const beamNext = next && q <= 0.5 && next.q <= 0.5 && next.st.beat - st.beat <= 1.0001;
      const beamPrev = prev && q <= 0.5 && prev.q <= 0.5 && st.beat - prev.st.beat <= 1.0001;
      g.strokeStyle = fg; g.fillStyle = fg;
      if (hasStem && q <= 0.5 && !beamNext && !beamPrev) {
        const flags = q <= 0.25 ? 2 : 1;
        for (let f = 0; f < flags; f++) {
          g.beginPath(); g.moveTo(x + 4 * hk, l.top + f * 4 * hk);
          g.quadraticCurveTo(x + 11 * hk, l.top + (6 + f * 4) * hk, x + 8 * hk, l.top + (13 + f * 4) * hk);
          g.lineWidth = 1.5 * Math.sqrt(hk); g.stroke();
        }
      }
      if (beamNext) {
        const n2 = next;
        const beams = Math.min(q, n2.q) <= 0.25 ? 2 : 1;
        for (let b2 = 0; b2 < beams; b2++) {
          g.beginPath();
          g.moveTo(x + 4 * hk, l.top + b2 * 4.5 * hk); g.lineTo(n2.x + 4 * hk, n2.top + b2 * 4.5 * hk);
          g.lineWidth = 2.6 * hk; g.stroke();
        }
      }
    });

    // ---- sync markers: a numbered circle on a line through the strip, a red cross to remove it ----
    const starts = barSubdivisions.length ? barStartBeats(barSubdivisions) : [];
    const barOf = (gridBeat) => {
      let bi = 0;
      for (let i = 0; i < starts.length; i++) if (starts[i] <= gridBeat + 1e-6) bi = i;
      return { bar: bi + 1, off: gridBeat - (starts[bi] ?? 0) };
    };
    const circleY = mid;
    // small dots on every grid beat (the reference the markers are pinned to)
    if (starts.length) {
      g.fillStyle = fg;
      for (let bi = 0; bi < barSubdivisions.length; bi++) {
        const x1 = tx(beatTime(starts[bi] + barSubdivisions[bi]));
        const x0 = tx(beatTime(starts[bi]));
        if (x1 < 0) continue;
        if (x0 > size.w) break;
        const per = (x1 - x0) / barSubdivisions[bi];
        if (per < 9) continue;
        for (let c = 0; c < barSubdivisions[bi]; c++) {
          const xc = x0 + per * c;
          if (pins.some(p => Math.abs(tx(pinTime(p)) - xc) < 5)) continue;
          g.globalAlpha = c === 0 ? 0.55 : 0.28;
          g.beginPath(); g.arc(xc + 0.5, circleY, (c === 0 ? 3.2 : 2.2) * hk, 0, Math.PI * 2); g.fill();
        }
      }
      g.globalAlpha = 1;
    }
    const R = Math.max(13, Math.min(34, stripH * 0.1)); // the marker circles grow with the window
    pins.forEach((p) => {
      const x = tx(pinTime(p));
      if (x < -20 || x > size.w + 20) return;
      const hot = hover?.kind === 'pin' && hover.id === p.id;
      g.strokeStyle = fg; g.globalAlpha = hot ? 0.95 : 0.55; g.lineWidth = hot ? 1.8 : 1;
      g.beginPath(); g.moveTo(x + 0.5, stripTop); g.lineTo(x + 0.5, stripBottom); g.stroke();
      g.globalAlpha = 1; g.lineWidth = 1;
      const gb = (anchor ?? 0) + p.beat;
      const { bar, off } = barOf(gb);
      const label = Math.abs(off) < 1e-3 ? String(bar) : `${bar}.${Math.round(off) + 1}`;
      g.fillStyle = fg; g.beginPath(); g.arc(x + 0.5, circleY, R, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#111'; g.font = `bold ${Math.round(R * (label.length > 4 ? 0.62 : label.length > 2 ? 0.76 : 0.95))}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(label, x + 0.5, circleY + 0.5); g.textAlign = 'start';
      // the red cross (click it, or right-click the marker, to remove it)
      const cy = stripBottom - 10 * hk, ax = 4 * hk, hotX = hover?.kind === 'pinx' && hover.id === p.id;
      g.strokeStyle = hotX ? '#ff8080' : '#ff4d4d'; g.lineWidth = (hotX ? 2.2 : 1.6) * Math.sqrt(hk);
      g.beginPath(); g.moveTo(x - ax, cy - ax); g.lineTo(x + ax, cy + ax); g.moveTo(x + ax, cy - ax); g.lineTo(x - ax, cy + ax); g.stroke(); g.lineWidth = 1;
    });

    // loop region: shaded across the strip, with handles on the ruler
    if (loopEnd > loopStart && (loop || loopStart > 0)) {
      const lx0 = tx(beatTime(loopStart)), lx1 = tx(beatTime(loopEnd));
      if (lx1 > 0 && lx0 < size.w) {
        const a = Math.max(0, lx0), b = Math.min(size.w, lx1);
        g.fillStyle = loop ? 'rgba(90,170,255,0.16)' : 'rgba(255,255,255,0.07)';
        g.fillRect(a, ROW_H, b - a, size.h - ROW_H);
        g.fillStyle = loop ? 'rgba(90,170,255,0.55)' : 'rgba(255,255,255,0.3)';
        g.fillRect(a, ROW_H, b - a, 4);
        g.fillRect(lx0 - 1, ROW_H, 3, size.h - ROW_H); g.fillRect(lx1 - 2, ROW_H, 3, size.h - ROW_H);
      }
    }

    // playhead (red) and the time readout
    const curT = Math.max(0, beatTime(headBeat) - tMin), totT = Math.max(0, tMax - tMin);
    const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
    const px = tx(beatTime(headBeat));
    if (px >= 0 && px <= size.w) { g.strokeStyle = '#ff4d4d'; g.lineWidth = 1.6; g.beginPath(); g.moveTo(px + 0.5, 0); g.lineTo(px + 0.5, size.h); g.stroke(); g.lineWidth = 1; }
    g.font = '10px monospace'; g.textBaseline = 'middle';
    const label = `${fmt(curT)} / ${fmt(totT).replace(/\.\d+$/, '')}`;
    const lwid = g.measureText(label).width + 12;
    g.fillStyle = 'rgba(0,0,0,0.7)'; g.fillRect(4, stripBottom - 20, lwid, 15);
    g.fillStyle = fg; g.fillText(label, 10, stripBottom - 12);
  }, [size, view, audio, buffer, stems, pins, onsets, hover, headBeat, beatTime, tx, xt, pinTime, loop, loopStart, loopEnd, playing]);

  // hit testing
  const hitAt = (x, y) => {
    // the red cross at the foot of a marker
    const hk0 = Math.max(0.9, Math.min(1.8, Math.max(80, size.h - 6 - HEAD_H - 4) / 240));
    if (y != null && y > size.h - (14 + 10 * hk0)) {
      const hit = pins.find(p => Math.abs(tx(pinTime(p)) - x) < 9 * hk0);
      if (hit) return { kind: 'pinx', id: hit.id };
    }
    // the numbered circle (or its line) is the sync point's handle and wins over a stem sitting at the same spot
    if (y != null) {
      const sTop = HEAD_H + 4, sH = Math.max(80, size.h - 6 - sTop);
      const cy = sTop + sH * 0.58, Rc = Math.max(13, Math.min(34, sH * 0.1));
      if (Math.abs(y - cy) <= Rc + 4) {
        const hitPin = pins.map(p => ({ p, d: Math.abs(tx(pinTime(p)) - x) })).filter(o => o.d <= Rc + 2).sort((a, b) => a.d - b.d)[0];
        if (hitPin) return { kind: 'pin', id: hitPin.p.id, beat: hitPin.p.beat, time: hitPin.p.time };
      }
    }
    let best = null, bestD = HIT;
    stems.forEach((s) => { const d = Math.abs(tx(s.time) - x); if (d < bestD) { bestD = d; best = { kind: 'stem', beat: s.beat, time: s.time }; } });
    if (!best) pins.forEach((p) => { const d = Math.abs(tx(pinTime(p)) - x); if (d < bestD) { bestD = d; best = { kind: 'pin', id: p.id, beat: p.beat, time: p.time }; } });
    return best;
  };
  const localX = (e) => e.clientX - canvasRef.current.getBoundingClientRect().left;
  const localY = (e) => e.clientY - canvasRef.current.getBoundingClientRect().top;

  const onDown = (e) => {
    if (!audio) return;
    const x = localX(e);
    const hit = hitAt(x, localY(e));
    if (hit?.kind === 'pinx' && e.button === 0) { e.preventDefault(); onRemovePin(audio.id, hit.id); setHover(null); return; }
    if (e.button === 2) {
      if (hit?.kind === 'pin') { e.preventDefault(); onRemovePin(audio.id, hit.id); }
      return;
    }
    if (e.button !== 0) return;
    // The ruler sets the loop region: drag an edge, or drag across empty ruler to draw a new one
    // (grid-snapped; Alt for free). A plain click there places the playhead.
    if (localY(e) < HEAD_H && setLoopStart && setLoopEnd) {
      e.preventDefault();
      const hasRegion = loopEnd > loopStart && (loop || loopStart > 0);
      const lxA = tx(beatTime(loopStart)), lxB = tx(beatTime(loopEnd));
      let mode = 'new';
      if (hasRegion && Math.abs(x - lxA) < 7) mode = 'left';
      else if (hasRegion && Math.abs(x - lxB) < 7) mode = 'right';
      const x0 = e.clientX;
      const startBeat = Math.max(0, timeBeat(xt(x)));
      let moved = false;
      const snapB = (b, alt) => (alt ? b : Math.round(b));
      const mv = (ev) => {
        if (!moved && Math.abs(ev.clientX - x0) < 4) return;
        moved = true;
        const lx = ev.clientX - canvasRef.current.getBoundingClientRect().left;
        const b = Math.max(0, snapB(timeBeat(xt(lx)), ev.altKey));
        if (mode === 'left') setLoopStart(Math.min(b, loopEnd - 1));
        else if (mode === 'right') setLoopEnd(Math.max(b, loopStart + 1));
        else {
          const a = snapB(startBeat, ev.altKey);
          setLoopStart(Math.min(a, b)); setLoopEnd(Math.max(Math.max(a, b), Math.min(a, b) + 1));
        }
        if (setLoop) setLoop(true);
      };
      const up = () => {
        window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
        document.body.classList.remove('dock-resizing'); dragRef.current = null;
        if (!moved) onSelectBeat(startBeat);
      };
      dragRef.current = true;
      document.body.classList.add('dock-resizing');
      window.addEventListener('pointermove', mv);
      window.addEventListener('pointerup', up);
      return;
    }
    if (!hit) {
      onSelectBeat(Math.max(0, timeBeat(xt(x))));
      if (playing || !buffer) return;
      // drag to scrub: the recording is heard under the pointer, tape style
      e.preventDefault();
      prepareScrub(buffer);
      const hear = (cx) => {
        const t = xt(cx - canvasRef.current.getBoundingClientRect().left);
        scrubTarget(buffer, t >= tMin && t <= tMax ? t : null, audio.volume ?? 1);
        return t;
      };
      hear(e.clientX);
      const x0s = e.clientX;
      let dragged = false;
      const sm = (ev) => {
        if (!dragged && Math.abs(ev.clientX - x0s) < 3) return;
        dragged = true;
        const t = hear(ev.clientX);
        onSelectBeat(Math.max(0, timeBeat(t)));
      };
      const su = () => {
        window.removeEventListener('pointermove', sm); window.removeEventListener('pointerup', su);
        scrubHold(buffer, false); scrubStop(buffer);
      };
      window.addEventListener('pointermove', sm);
      window.addEventListener('pointerup', su);
      return;
    }
    // A pin is dragged by the beat it pins (its file beat plus the file origin); a stem moves only its
    // notes. Nothing moves until the pointer travels a few pixels: a plain click puts the playhead there.
    const beat = hit.kind === 'stem' ? hit.beat : (anchor ?? 0) + hit.beat;
    e.preventDefault();
    const x0 = e.clientX;
    let started = false, travelled = false, curBeat = beat;
    const ids = pairedTracks.map(t => t.id);
    const move = (ev) => {
      if (!started && Math.abs(ev.clientX - x0) < 4) return;
      travelled = true;
      const lx = ev.clientX - canvasRef.current.getBoundingClientRect().left;
      if (hit.kind === 'stem') {
        const nb = Math.max(0, timeBeat(Math.max(0, xt(lx))));
        if (onMoveStem) onMoveStem(ids, curBeat, nb, started ? 'move' : 'start');
        curBeat = nb; started = true;
        return;
      }
      // The line follows the pointer along the grid and lands on round beats / measures (Alt = free); the
      // sound under it stays put, so the recording stretches or squeezes against the grid.
      const raw = view.t0 + lx / view.pps;
      const target = Math.max(0, ev.altKey ? raw : Math.round(raw));
      const ok = onMovePin(audio.id, hit.id, target, started ? 'move' : 'start');
      if (ok === false && !started) { cleanup(); return; } // refused: leave the playhead alone
      started = true;
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', cleanup);
      document.body.classList.remove('dock-resizing'); dragRef.current = null;
      if (!started && !travelled) onSelectBeat(Math.max(0, hit.kind === 'stem' ? hit.beat : timeBeat(hit.time)));
    };
    dragRef.current = true;
    document.body.classList.add('dock-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', cleanup);
  };

  const onMove = (e) => {
    if (dragRef.current) return;
    const h = hitAt(localX(e), localY(e));
    setHover(prev => (prev?.kind === h?.kind && prev?.id === h?.id && prev?.beat === h?.beat ? prev : h));
  };

  const onWheel = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const x = localX(e);
    if (e.ctrlKey || e.metaKey) {
      const f = Math.exp(-e.deltaY * 0.01);
      setView((v) => {
        const pps = Math.min(600, Math.max(0.5, v.pps * f));
        const b = v.t0 + x / v.pps;
        return { pps, t0: Math.max(0, b - x / pps) };
      });
    } else {
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      setView(v => ({ ...v, t0: Math.max(0, Math.min(bMax, v.t0 + dx / v.pps)) }));
    }
  };
  // non-passive wheel so the page does not scroll
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return undefined;
    cv.addEventListener('wheel', onWheel, { passive: false });
    return () => cv.removeEventListener('wheel', onWheel);
  });

  const fit = () => setView({ t0: Math.max(0, bMin), pps: Math.max(0.5, (size.w - 8) / Math.max(1, bMax - bMin)) });

  return (
    <div className="sync-editor">
      <div className="sync-bar">
        {audioList.length > 1 ? (
          <select className="sync-select" value={audio?.id || ''} onChange={(e) => setAudioChoice(e.target.value)} title="Which recording to sync">
            {audioList.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        ) : (
          <span className="sync-title">{audio ? audio.name : 'No audio track'}</span>
        )}
        {audio && (
          <span className="sync-pair">
            <button className="settings-btn-sm" onClick={() => setPairOpen(o => !o)} title="Which note tracks are synced with this recording">
              Notes: {pairedTracks.length ? pairedTracks.map(t => t.name).join(', ') : 'none'} ▾
            </button>
            {pairOpen && (
              <div className="sync-pair-menu" onMouseLeave={() => setPairOpen(false)}>
                {noteTrackList.length === 0 && <span className="ub-note">No note tracks yet</span>}
                {noteTrackList.map(t => (
                  <label key={t.id}>
                    <input
                      type="checkbox" checked={pairedTracks.some(x => x.id === t.id)}
                      onChange={(e) => {
                        const cur = Array.isArray(pairedIds) && pairedIds.length ? pairedIds : pairedTracks.map(x => x.id);
                        const next = e.target.checked ? [...new Set([...cur, t.id])] : cur.filter(x => x !== t.id);
                        if (onSetAudioOptions) onSetAudioOptions(audio.id, { syncNotes: next });
                      }}
                    />
                    {t.name}
                  </label>
                ))}
              </div>
            )}
          </span>
        )}
        <span className="sync-info">{pins.length} sync point{pins.length === 1 ? '' : 's'}</span>
        <span className="ub-spacer" />
        <button
          className="settings-btn-sm" disabled={!audio}
          onClick={() => audio && onAddAtPlayhead && onAddAtPlayhead(audio.id)}
          title="Add a sync point at the playhead (hotkey: I)"
        >+ Sync point <kbd className="sync-kbd">I</kbd></button>
        <button
          className="settings-btn-sm" disabled={!audio || !onAutoSync}
          onClick={() => audio && onAutoSync(audio.id)}
          title="Detect the beats in this recording and put sync points on the bar lines, so the grid follows the song (replaces existing ones; Ctrl+Z undoes)"
        >Auto sync</button>
        {audio && pins.length > 0 && onClearSync && (
          <button className="settings-btn-sm" onClick={() => onClearSync(audio.id)} title="Remove all sync points from this recording">Clear sync ({allPins.length})</button>
        )}
        {audio && onSetAudioOptions && (
          <button
            className={`settings-btn-sm${audio.followTempo ? ' active' : ''}`}
            onClick={() => onSetAudioOptions(audio.id, { followTempo: !audio.followTempo })}
            title={audio.followTempo ? 'Matching tempo: the BPM moves the grid and the song keeps its own speed. Click to lock.' : 'Match tempo: change the BPM until the song lines up with the grid (the song keeps its own speed).'}
          >{audio.followTempo ? 'Matching tempo' : 'Match tempo'}</button>
        )}
        {audio?.followTempo && onDetectTempo && (
          <button className="settings-btn-sm" onClick={() => onDetectTempo(audio.id)} title="Detect the song's tempo and put its first beat on the grid">Detect tempo</button>
        )}
        <button className="settings-btn-sm" onClick={onUndo} title="Undo (Ctrl+Z)" aria-label="Undo sync edit">↶ Undo</button>
        <button className="settings-btn-sm" onClick={onRedo} title="Redo (Ctrl+Y)" aria-label="Redo sync edit">↷ Redo</button>
        <button
          className={`settings-btn-sm${loop ? ' active' : ''}`} disabled={!audio || !setLoop}
          onClick={() => setLoop && setLoop(!loop)}
          title="Loop the region (drag on the ruler to set it)"
        >Loop</button>
        <button className="settings-btn-sm" onClick={fit} title="Fit the whole recording">Fit</button>
      </div>
      <div className="sync-canvas-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          style={{ width: size.w, height: size.h, cursor: hover?.kind === 'pinx' ? 'pointer' : hover ? 'ew-resize' : 'crosshair' }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerLeave={() => !dragRef.current && setHover(null)}
          onContextMenu={(e) => e.preventDefault()}
        />
      </div>
      <p className="sync-hint">
        Drag a stem to nudge its notes; drag a numbered circle (or its line) to a measure: it snaps to the grid (Alt = free) and the recording stretches or squeezes to match; + Sync point (I) pins the playhead. Drag on the ruler to set the loop region. Scroll to pan,
        Ctrl/⌘+scroll to zoom, click to place the playhead, right-click a yellow line to remove it.
      </p>
    </div>
  );
}
