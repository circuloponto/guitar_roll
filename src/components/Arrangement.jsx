import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Eye, EyeOff, Volume2, VolumeX, MoreHorizontal } from 'lucide-react';
import ConfirmDialog from './ConfirmDialog';
import { TrackControls, TrackMenu } from './TrackParts';
import { beatToX, xToBeat, gridTotalWidth, barStartBeats } from '../utils/barLayout';
import { getClips, clipEndBeat } from '../utils/audioClips';
import { CELL_WIDTH, SUBDIVISIONS } from '../utils/constants';
import { TRACK_GROUP_COLOURS } from '../utils/trackGroups';

const ROW_MIN = 20, ROW_MAX = 180, ROW_DEFAULT = 46;
const ROW_KEY = 'guitar-roll-arrangement-row-height';
const GROUP_H = 44;
const RULER_H = 22;
const SECTION_H = 22;
const TOP_H = RULER_H + SECTION_H;
const OPEN = [40, 45, 50, 55, 59, 64];

// Arrangement: one horizontal lane per track, like Ableton's arrangement view. The header on the
// left holds the track's controls and its lane on the right shows its notes (or waveform) on the
// same bar grid, scroll and zoom as the Timeline, so a track and its music are visually one row.
export default function Arrangement({
  tracks, trackGroups = [], activeTrackId, bodyRef, barSubdivisions, timelineZoom, tempoMap,
  loop, loopStart, loopEnd, selectedBeat, currentBeat, playing, onSelectBeat,
  // everything the Tracks window can do (the same handlers it gets)
  selectedTrackIds = new Set(), onSelectTrack, onToggleMute, onToggleSolo, onSetVolume, onToggleVisible, onSetBgOpacity,
  onSetTrackScheme, sessionSchemes, onAddTrack, onDeleteTrack, onDuplicateTrack, onReorderTracks, onRenameTrack,
  onToggleTrackGroup, onTrackGroupFlag, onTrackGroupSet, onRenameTrackGroup, onSetTrackGroupColour, onRemoveTrackGroup, onGroupTracks, onUngroupTracks,
  onTranscribe, onLearn, onToggleHeat, heatTracks, onTogglePhantomShow, onTogglePhantomEdit, onLoadAudio, missingAudioIds, onRemoveAudio, onSetAudioOptions,
  onNudgeBpm, onDetectTempo, bpm, onAutoSync, onClearSyncPoints,
  markers = [], onUpdateMarker, onAddMarker, onDeleteMarker, selectedSectionId = null, onSelectSection,
  sectionActions = null,
  songPlan = { order: [], mode: false }, onSongPlanChange,
}) {
  const lanesRef = useRef(null);
  const canvasRef = useRef(null);
  const rulerRef = useRef(null);
  const scrollRef = useRef(null);
  const [size, setSize] = useState({ w: 600, h: 200 });
  const [scrollX, setScrollX] = useState(0);   // the Arrangement's own horizontal scroll (px)
  const [arrCell, setArrCell] = useState(4);     // and its own zoom: px per grid column
  const autoFitRef = useRef(true);                // keeps showing the whole song until you zoom or scroll yourself
  const [tlView, setTlView] = useState({ sl: 0, cw: 0 }); // what the Timeline is showing
  const [ctxMenu, setCtxMenu] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [dragIndex, setDragIndex] = useState(null);
  const [overIndex, setOverIndex] = useState(null);
  const [opts, setOpts] = useState(null); // the options popover of a track: { id, x, y }
  const clickMode = (e) => (e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'range' : 'single');
  const commitRename = () => { if (editingId && editName.trim()) onRenameTrack(editingId, editName.trim()); setEditingId(null); };
  const askDelete = (t) => { if ((t.notes && t.notes.length > 0) || t.audioFileName) setConfirmDelete(t); else onDeleteTrack(t.id); };
  const [orderDrag, setOrderDrag] = useState(null);
  const optsTrack = opts ? tracks.find(t => t.id === opts.id) : null;
  useEffect(() => {
    if (!opts) return undefined;
    const close = (e) => { if (!e.target.closest?.('.arr-opts')) setOpts(null); };
    const key = (e) => { if (e.key === 'Escape') setOpts(null); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', key); };
  }, [opts]);
  const [rowH, setRowH] = useState(() => {
    try { const v = Number(localStorage.getItem(ROW_KEY)); return v >= ROW_MIN && v <= ROW_MAX ? v : ROW_DEFAULT; } catch { return ROW_DEFAULT; }
  });
  const changeRowH = useCallback((fn) => {
    setRowH((h) => {
      const v = Math.round(Math.min(ROW_MAX, Math.max(ROW_MIN, typeof fn === 'function' ? fn(h) : fn)));
      try { localStorage.setItem(ROW_KEY, String(v)); } catch { /* ignore */ }
      return v;
    });
  }, []);
  const cellWidth = arrCell;
  const scrollLeft = scrollX;
  const tlCell = CELL_WIDTH * timelineZoom;
  const totalCols = barSubdivisions.reduce((a, b) => a + b, 0);
  const regionSet = loop || loopStart > 0 || loopEnd < totalCols; // an inactive region stays visible, greyed

  // watch the Timeline's scroll and size: the dashed box marks that range
  useEffect(() => {
    let el = null, ro = null, raf = 0, tries = 0;
    const on = () => setTlView({ sl: el.scrollLeft, cw: el.clientWidth });
    const attach = () => {
      el = bodyRef?.current;
      if (!el) { if (tries++ < 600) raf = requestAnimationFrame(attach); return; }
      on();
      el.addEventListener('scroll', on, { passive: true });
      ro = new ResizeObserver(on);
      ro.observe(el);
    };
    attach();
    return () => { cancelAnimationFrame(raf); if (el) el.removeEventListener('scroll', on); if (ro) ro.disconnect(); };
  }, [bodyRef]);

  useEffect(() => {
    const el = lanesRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setSize({ w: Math.max(100, el.clientWidth), h: Math.max(60, el.clientHeight) }));
    ro.observe(el);
    setSize({ w: Math.max(100, el.clientWidth), h: Math.max(60, el.clientHeight) });
    return () => ro.disconnect();
  }, []);

  const groupById = (id) => trackGroups.find(g => g.id === id) || null;
  const colourOf = (track, index) => {
    const g = track.groupId ? groupById(track.groupId) : null;
    return g ? g.colour : TRACK_GROUP_COLOURS[index % TRACK_GROUP_COLOURS.length];
  };

  // rows: a header row for each group, then its tracks (hidden while the group is collapsed)
  const rows = useMemo(() => {
    const out = [];
    let y = 0;
    tracks.forEach((track, index) => {
      const grp = track.groupId ? groupById(track.groupId) : null;
      const first = grp && (index === 0 || tracks[index - 1].groupId !== track.groupId);
      if (first) {
        const gh = grp.collapsed ? Math.max(GROUP_H, Math.round(rowH * 0.8)) : GROUP_H;
        out.push({ kind: 'group', grp, y, h: gh, members: tracks.filter(t => t.groupId === grp.id) });
        y += gh;
      }
      if (grp && grp.collapsed) return;
      out.push({ kind: 'track', track, index, y, h: rowH });
      y += rowH;
    });
    return { list: out, total: y };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, trackGroups, rowH]);

  const fitHeight = () => {
    const tracksShown = rows.list.filter(r => r.kind === 'track').length;
    const groups = rows.list.filter(r => r.kind === 'group').length;
    if (!tracksShown) return;
    const avail = (lanesRef.current?.clientHeight || size.h) - groups * GROUP_H - 2;
    changeRowH(avail / tracksShown);
  };
  // the song's end: the last note or audio clip
  const extent = useMemo(() => {
    let e = 0;
    tracks.forEach((t) => {
      if (t.type === 'audio') {
        const m = tempoMap ? tempoMap.forTrack(t) : null;
        if (m) getClips(t).forEach((c) => { e = Math.max(e, clipEndBeat(c, m)); });
      } else t.notes.forEach((n) => { e = Math.max(e, n.beat + n.duration); });
    });
    return e;
  }, [tracks, tempoMap]);
  const songBars = useMemo(() => {
    const starts = barStartBeats(barSubdivisions);
    let n = 1;
    for (let i = 0; i < starts.length; i++) if (starts[i] < extent - 1e-6) n = i + 1;
    return Math.max(n, 2);
  }, [extent, barSubdivisions]);
  const sections = useMemo(() => {
    const ms = [...markers].sort((a, b) => a.beat - b.beat);
    const starts = barStartBeats(barSubdivisions);
    const songEnd = starts[songBars] ?? barSubdivisions.reduce((a, b) => a + b, 0);
    return ms.map((m, i) => ({
      id: m.id, name: m.name, color: m.color, start: m.beat,
      end: i + 1 < ms.length ? ms[i + 1].beat : Math.max(songEnd, m.beat + 1),
    }));
  }, [markers, barSubdivisions, songBars]);
  const fitSong = useCallback(() => {
    autoFitRef.current = true;
    setArrCell(Math.min(60, Math.max(0.4, (size.w - 12) / (SUBDIVISIONS * songBars))));
    setScrollX(0);
  }, [size.w, songBars]);
  useEffect(() => { if (autoFitRef.current) fitSong(); }, [fitSong]);
  const zoomArr = useCallback((f, anchorX = size.w / 2) => {
    autoFitRef.current = false;
    const next = Math.min(80, Math.max(0.4, arrCell * f));
    const k = next / arrCell;
    setScrollX(Math.max(0, (scrollX + anchorX) * k - anchorX));
    setArrCell(next);
  }, [arrCell, scrollX, size.w]);
  const tlBeats = tlView.cw > 0 ? {
    b0: xToBeat(tlView.sl, barSubdivisions, tlCell, false),
    b1: xToBeat(tlView.sl + tlView.cw, barSubdivisions, tlCell, false),
  } : null;
  const scrollTimelineTo = (beat) => { if (bodyRef?.current) bodyRef.current.scrollLeft = Math.max(0, beatToX(beat, barSubdivisions, tlCell)); };
  const gridW = gridTotalWidth(barSubdivisions, cellWidth);
  const headBeat = playing && currentBeat != null ? currentBeat : selectedBeat;
  const X = useCallback((b) => beatToX(b, barSubdivisions, cellWidth) - scrollLeft, [barSubdivisions, cellWidth, scrollLeft]);

  // ruler
  useEffect(() => {
    const cv = rulerRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.floor(size.w * dpr); cv.height = Math.floor(TOP_H * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(cv);
    const col = (n, d) => css.getPropertyValue(n).trim() || d;
    g.fillStyle = col('--raise', '#15151b'); g.fillRect(0, 0, size.w, TOP_H);
    g.font = '10px monospace'; g.textBaseline = 'middle';
    const starts = barStartBeats(barSubdivisions);
    starts.forEach((b, i) => {
      const x = X(b);
      if (x < -60 || x > size.w) return;
      g.strokeStyle = col('--hairline', '#2a2a33'); g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, RULER_H); g.stroke();
      g.fillStyle = col('--soft', '#bbb'); g.fillText(String(i + 1), x + 4, RULER_H / 2);
    });
    if (regionSet) {
      const x0 = X(loopStart), x1 = X(loopEnd);
      g.fillStyle = loop ? col('--accent', '#8a4fff') : col('--mute', '#888'); g.globalAlpha = loop ? 0.55 : 0.35;
      g.fillRect(x0, RULER_H - 5, Math.max(1, x1 - x0), 5);
      g.globalAlpha = 1;
    }
    // sections: each marker starts a named span that runs to the next marker
    g.font = 'bold 10px sans-serif'; g.textBaseline = 'middle';
    g.strokeStyle = col('--hairline', '#2a2a33'); g.beginPath(); g.moveTo(0, RULER_H + 0.5); g.lineTo(size.w, RULER_H + 0.5); g.stroke();
    sections.forEach((sec) => {
      const sx0 = X(sec.start), sx1 = X(sec.end);
      if (sx1 < 0 || sx0 > size.w) return;
      const on = sec.id === selectedSectionId;
      g.fillStyle = sec.color || '#b24fcc'; g.globalAlpha = on ? 0.6 : 0.32;
      g.fillRect(sx0 + 1, RULER_H + 2, Math.max(2, sx1 - sx0 - 2), SECTION_H - 4); g.globalAlpha = 1;
      g.fillStyle = sec.color || '#b24fcc'; g.fillRect(sx0 + 1, RULER_H + 2, 3, SECTION_H - 4);
      if (on) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.strokeRect(sx0 + 1.5, RULER_H + 2.5, Math.max(2, sx1 - sx0 - 3), SECTION_H - 5); g.lineWidth = 1; }
      g.save(); g.beginPath(); g.rect(sx0 + 6, RULER_H, Math.max(0, sx1 - sx0 - 8), SECTION_H); g.clip();
      g.fillStyle = col('--fg', '#eee'); g.fillText(sec.name, sx0 + 8, RULER_H + SECTION_H / 2 + 0.5);
      g.restore();
    });
    if (tlBeats) {
      const bx0 = X(tlBeats.b0), bx1 = X(tlBeats.b1);
      g.fillStyle = col('--accent', '#8a4fff'); g.globalAlpha = 0.28; g.fillRect(bx0, 0, Math.max(2, bx1 - bx0), RULER_H); g.globalAlpha = 1;
      g.strokeStyle = col('--accent-hi', '#b06cff'); g.lineWidth = 1.5; g.strokeRect(bx0 + 0.5, 1, Math.max(2, bx1 - bx0), RULER_H - 2); g.lineWidth = 1;
    }
  }, [size, X, barSubdivisions, loop, loopStart, loopEnd, regionSet, tlBeats?.b0, tlBeats?.b1, sections, selectedSectionId]);

  // lanes
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const H = Math.max(rows.total, 1);
    cv.width = Math.floor(size.w * dpr); cv.height = Math.floor(H * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(cv);
    const col = (n, d) => css.getPropertyValue(n).trim() || d;
    const ink = col('--ink', '#0b0b0f'), hair = col('--hairline', '#2a2a33'), accent = col('--accent', '#8a4fff');
    g.fillStyle = ink; g.fillRect(0, 0, size.w, H);
    // row backgrounds
    rows.list.forEach((r) => {
      if (r.kind === 'group') { g.fillStyle = r.grp.colour; g.globalAlpha = 0.14; g.fillRect(0, r.y, size.w, r.h); g.globalAlpha = 1; return; }
      if (r.track.id === activeTrackId) { g.fillStyle = accent; g.globalAlpha = 0.1; g.fillRect(0, r.y, size.w, r.h); g.globalAlpha = 1; }
      g.strokeStyle = hair; g.beginPath(); g.moveTo(0, r.y + r.h - 0.5); g.lineTo(size.w, r.y + r.h - 0.5); g.stroke();
    });
    // bar lines (and beat lines when there is room)
    const starts = barStartBeats(barSubdivisions);
    starts.forEach((b, i) => {
      const x = X(b);
      if (x < -2 || x > size.w) return;
      g.strokeStyle = hair; g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, H); g.stroke();
      const per = (X(b + barSubdivisions[i]) - x) / barSubdivisions[i];
      if (per >= 14) {
        g.globalAlpha = 0.35;
        for (let c = 1; c < barSubdivisions[i]; c++) { const xc = x + per * c; g.beginPath(); g.moveTo(xc + 0.5, 0); g.lineTo(xc + 0.5, H); g.stroke(); }
        g.globalAlpha = 1;
      }
    });
    // loop region
    if (regionSet) {
      const x0 = X(loopStart), x1 = X(loopEnd);
      g.fillStyle = loop ? accent : col('--mute', '#888'); g.globalAlpha = loop ? 0.1 : 0.06;
      g.fillRect(x0, 0, Math.max(1, x1 - x0), H); g.globalAlpha = 1;
    }
    // each track's content
    const drawTrack = (track, y0, h0, colour) => {
      const dim = track.muted ? 0.35 : 1;
      if (track.type === 'audio') {
        const peaks = track.waveformPeaks;
        const m = tempoMap ? tempoMap.forTrack(track) : null;
        if (!peaks || !m || !track.audioDuration) return;
        getClips(track).forEach((clip) => {
          const xs = X(clip.start), xe = X(clipEndBeat(clip, m));
          if (xe < 0 || xs > size.w || xe - xs < 1) return;
          g.fillStyle = colour; g.globalAlpha = 0.18 * dim;
          g.fillRect(xs, y0 + 3, xe - xs, h0 - 7); g.globalAlpha = 0.9 * dim;
          const a = Math.max(0, Math.floor(xs)), b = Math.min(size.w, Math.ceil(xe));
          const mid = y0 + h0 / 2;
          for (let px = a; px < b; px++) {
            const frac = (px - xs) / (xe - xs);
            const t = clip.srcStart + frac * (clip.srcEnd - clip.srcStart);
            const p = peaks[Math.min(peaks.length - 1, Math.max(0, Math.floor((t / track.audioDuration) * peaks.length)))] || 0;
            const hh = Math.max(0.5, p * (h0 / 2 - 5));
            g.fillRect(px, mid - hh, 1, hh * 2);
          }
          g.globalAlpha = 1;
        });
        return;
      }
      if (!track.notes.length) return;
      const pitches = track.notes.map(n => OPEN[n.stringIndex] + n.fret);
      const lo = Math.min(...pitches), hi = Math.max(...pitches, lo + 1);
      g.fillStyle = colour; g.globalAlpha = 0.95 * dim;
      track.notes.forEach((n, k) => {
        const x0 = X(n.beat), x1 = X(n.beat + n.duration);
        if (x1 < 0 || x0 > size.w) return;
        const y = y0 + 7 + (1 - (pitches[k] - lo) / (hi - lo)) * (h0 - 17);
        g.fillRect(x0, y, Math.max(2, x1 - x0 - 1), 4);
      });
      g.globalAlpha = 1;
    };
    rows.list.forEach((r) => {
      if (r.kind === 'track') drawTrack(r.track, r.y, r.h, colourOf(r.track, r.index));
      // a collapsed group shows all its tracks laid over one another, like Ableton
      else if (r.grp.collapsed) r.members.forEach((m) => drawTrack(m, r.y, r.h, r.grp.colour));
    });
    // the part of the song the Timeline is showing
    if (tlBeats) {
      const bx0 = X(tlBeats.b0), bx1 = X(tlBeats.b1);
      g.fillStyle = accent; g.globalAlpha = 0.08; g.fillRect(bx0, 0, Math.max(2, bx1 - bx0), H); g.globalAlpha = 1;
      g.strokeStyle = accent; g.setLineDash([5, 4]); g.lineWidth = 1;
      g.strokeRect(bx0 + 0.5, 0.5, Math.max(2, bx1 - bx0), Math.max(1, H - 1)); g.setLineDash([]);
    }
    // playhead
    const px = X(headBeat);
    if (px >= 0 && px <= size.w) { g.strokeStyle = '#fff'; g.beginPath(); g.moveTo(px + 0.5, 0); g.lineTo(px + 0.5, H); g.stroke(); }
  }, [size, rows, X, tlBeats?.b0, tlBeats?.b1, barSubdivisions, tempoMap, loop, loopStart, loopEnd, regionSet, headBeat, activeTrackId, tracks, trackGroups]);

  // Pointer on the lanes or the ruler. Inside the dashed box a drag scrolls the Timeline; outside it a
  // drag pans this view; a plain click on a lane selects the track and places the playhead, and a
  // click on the ruler jumps the Timeline there.
  const snapBeat = (beat, alt) => {
    if (alt) return Math.max(0, Math.round(beat));
    const starts = barStartBeats(barSubdivisions);
    let best = 0;
    for (const b of starts) if (Math.abs(b - beat) < Math.abs(best - beat)) best = b;
    return best;
  };
  const sectionAt = (x) => {
    const hit = sections.find(sec => x >= X(sec.start) - 1 && x < X(sec.end));
    return hit || null;
  };
  const startPointer = (e, fromRuler) => {
    if (e.button !== 0) return;
    const el = fromRuler ? rulerRef.current : canvasRef.current;
    const rect = el.getBoundingClientRect();
    const x0 = e.clientX - rect.left, y0 = e.clientY - rect.top;
    if (fromRuler && y0 >= RULER_H) {
      // the sections band: click selects, the left edge drags the marker
      const sec = sectionAt(x0);
      if (!sec) return;
      if (onSelectSection) onSelectSection(sec.id);
      const onEdge = Math.abs(x0 - X(sec.start)) <= 6;
      if (!onEdge) {
        // drag the body: move the whole section (needs the section actions)
        if (sectionActions?.move) {
          let dropBeat = null;
          const mv = (ev) => { dropBeat = snapBeat(xToBeat(ev.clientX - rect.left + scrollX, barSubdivisions, cellWidth, false), ev.altKey); };
          const up = (ev) => {
            window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
            if (dropBeat != null && Math.abs(ev.clientX - e.clientX) > 4) sectionActions.move(sec.id, dropBeat);
          };
          window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
        }
        return;
      }
      const move = (ev) => {
        const b = snapBeat(xToBeat(ev.clientX - rect.left + scrollX, barSubdivisions, cellWidth, false), ev.altKey);
        if (b !== sec.start && onUpdateMarker) onUpdateMarker(sec.id, { beat: b });
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      return;
    }
    const inBox = tlBeats && x0 >= X(tlBeats.b0) - 2 && x0 <= X(tlBeats.b1) + 2;
    const span = tlBeats ? tlBeats.b1 - tlBeats.b0 : 0;
    const startBeat0 = tlBeats ? tlBeats.b0 : 0;
    const startScrollX = scrollX;
    let moved = false;
    const move = (ev) => {
      const dx = ev.clientX - e.clientX;
      if (!moved && Math.abs(dx) < 3 && Math.abs(ev.clientY - e.clientY) < 3) return;
      moved = true;
      if (inBox || fromRuler) {
        const b = xToBeat(Math.max(0, beatToX(startBeat0, barSubdivisions, cellWidth) + (fromRuler && !inBox ? x0 + scrollX - beatToX(startBeat0 + span / 2, barSubdivisions, cellWidth) : 0) + dx), barSubdivisions, cellWidth, false);
        scrollTimelineTo(Math.max(0, b));
      } else {
        autoFitRef.current = false;
        setScrollX(Math.max(0, startScrollX - dx));
      }
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) return;
      const beat = Math.max(0, xToBeat(x0 + scrollX, barSubdivisions, cellWidth, false));
      if (fromRuler) { scrollTimelineTo(Math.max(0, beat - span / 2)); return; }
      const row = rows.list.find(q => y0 >= q.y && y0 < q.y + q.h);
      if (row && row.kind === 'track') onSelectTrack(row.track.id, clickMode(ev));
      onSelectBeat(beat);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const onTopDoubleClick = (e) => {
    const r = rulerRef.current.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (y < RULER_H) return;
    const sec = sectionAt(x);
    if (sec) {
      const n = window.prompt('Section name', sec.name);
      if (n && n.trim() && onUpdateMarker) onUpdateMarker(sec.id, { name: n.trim() });
    } else if (onAddMarker) {
      onAddMarker(snapBeat(xToBeat(x + scrollX, barSubdivisions, cellWidth, false), e.altKey), 'Section');
    }
  };
  const [secMenu, setSecMenu] = useState(null);
  const onTopContextMenu = (e) => {
    const r = rulerRef.current.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (y < RULER_H) return;
    e.preventDefault();
    const sec = sectionAt(x);
    if (sec) { if (onSelectSection) onSelectSection(sec.id); setSecMenu({ id: sec.id, at: snapBeat(xToBeat(x + scrollX, barSubdivisions, cellWidth, false), e.altKey), x: e.clientX, y: e.clientY }); }
    else setSecMenu({ add: snapBeat(xToBeat(x + scrollX, barSubdivisions, cellWidth, false), e.altKey), x: e.clientX, y: e.clientY });
  };
  useEffect(() => {
    if (!secMenu) return undefined;
    const close = () => setSecMenu(null);
    const key = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('mousedown', close); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', key); };
  }, [secMenu]);

  // wheel: Ctrl+wheel zooms this view, Ctrl+Shift+wheel changes the track height, sideways wheel pans
  const lastZoomAt = useRef(0);
  const onWheel = (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      if (e.shiftKey) { changeRowH(h => h * (1 - e.deltaY * 0.005)); return; }
      const now = performance.now();
      if (now - lastZoomAt.current < 40) return;
      lastZoomAt.current = now;
      const r = lanesRef.current.getBoundingClientRect();
      zoomArr(Math.exp(-e.deltaY * 0.01), e.clientX - r.left);
      return;
    }
    const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : (e.shiftKey ? e.deltaY : 0);
    if (!dx) return;
    e.preventDefault();
    autoFitRef.current = false;
    setScrollX(x => Math.max(0, x + dx));
  };
  useEffect(() => {
    const el = lanesRef.current;
    if (!el) return undefined;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });
  void gridW;

  return (
    <div className="arr">
      <div className="arr-top" style={{ height: TOP_H }}>
        <div className="arr-head-spacer arr-zoombar">
          <span title="Zoom in time (Ctrl + scroll)">⇔</span>
          <button className="arr-btn" onClick={() => zoomArr(1 / 1.3)} title="Zoom out (Ctrl + scroll)">−</button>
          <button className="arr-btn" onClick={() => zoomArr(1.3)} title="Zoom in (Ctrl + scroll)">+</button>
          <button className="arr-btn arr-fit" onClick={fitSong} title="Fit the whole song in the window">Song</button>
          <span title="Track height (Ctrl + Shift + scroll)">⇕</span>
          <button className="arr-btn" onClick={() => changeRowH(h => h / 1.2)} title="Shorter tracks (Ctrl + Shift + scroll)">−</button>
          <button className="arr-btn" onClick={() => changeRowH(h => h * 1.2)} title="Taller tracks (Ctrl + Shift + scroll)">+</button>
          <button className="arr-btn arr-fit" onClick={fitHeight} title="Fit all tracks into the window height">Fit</button>
        </div>
        <canvas ref={rulerRef} className="arr-ruler" style={{ width: size.w, height: TOP_H, cursor: 'pointer' }} onPointerDown={(e) => startPointer(e, true)} onDoubleClick={onTopDoubleClick} onContextMenu={onTopContextMenu} />
      </div>
      {sections.length > 0 && onSongPlanChange && (
        <div className="arr-order">
          <label className="arr-order-mode" title="When on, Play follows this order: each section is stored once, so a section that comes back plays the same notes and an edit changes every repeat.">
            <input type="checkbox" checked={songPlan.mode} onChange={(e) => onSongPlanChange({ ...songPlan, mode: e.target.checked })} />
            Song order
          </label>
          <div className="arr-order-chips">
            {songPlan.order.map((id, i) => {
              const sec = sections.find(x => x.id === id);
              if (!sec) return null;
              return (
                <span
                  key={`${id}-${i}`} className={`arr-chip${sec.id === selectedSectionId ? ' on' : ''}`} style={{ '--c': sec.color || '#b24fcc' }}
                  draggable onDragStart={() => setOrderDrag(i)} onDragOver={(e) => e.preventDefault()}
                  onDrop={() => { if (orderDrag === null || orderDrag === i) return; const o = [...songPlan.order]; const [m] = o.splice(orderDrag, 1); o.splice(i, 0, m); onSongPlanChange({ ...songPlan, order: o }); setOrderDrag(null); }}
                  onClick={() => onSelectSection && onSelectSection(sec.id)}
                  title="Drag to reorder, click to select this section"
                >
                  {sec.name}
                  <button className="arr-chip-x" onClick={(e) => { e.stopPropagation(); onSongPlanChange({ ...songPlan, order: songPlan.order.filter((_, k) => k !== i) }); }} title="Take this out of the order">×</button>
                </span>
              );
            })}
            {!songPlan.order.length && <span className="arr-order-empty">Add sections in the order they should play, e.g. Intro, Head, Solo, Head, Outro</span>}
          </div>
          <select
            className="arr-order-add" value="" title="Add a section to the end of the order"
            onChange={(e) => { if (e.target.value) onSongPlanChange({ ...songPlan, order: [...songPlan.order, e.target.value] }); }}
          >
            <option value="">+ section</option>
            {sections.map(sec => <option key={sec.id} value={sec.id}>{sec.name}</option>)}
          </select>
          <button className="arr-btn arr-fit" onClick={() => onSongPlanChange({ ...songPlan, order: sections.map(x => x.id) })} title="Use every section once, in song order">All</button>
        </div>
      )}
      <div className="arr-scroll" ref={scrollRef}>
        <div className="arr-heads">
          {rows.list.map((r) => (r.kind === 'group' ? (
            <div
              key={`g-${r.grp.id}`} className="arr-group" style={{ height: r.h, '--c': r.grp.colour }}
              onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ kind: 'group', id: r.grp.id, x: e.clientX, y: e.clientY }); }}
            >
              <div className="arr-g1">
              <button className="arr-caret" onClick={() => onToggleTrackGroup(r.grp.id)} title={r.grp.collapsed ? 'Expand group' : 'Collapse group'}>{r.grp.collapsed ? '▸' : '▾'}</button>
              <span
                className="arr-gname" title="Double-click to rename"
                onDoubleClick={() => { const n = window.prompt('Group name', r.grp.name); if (n && n.trim()) onRenameTrackGroup(r.grp.id, n.trim()); }}
              >{r.grp.name}</span>
              <span className="arr-gcount">{r.members.length}</span>
              <button className="arr-btn arr-ungroup" onClick={() => onRemoveTrackGroup(r.grp.id)} title="Ungroup these tracks (Ctrl+Shift+G)">✕</button>
              </div>
              <div className="arr-g2">
              <button className={`arr-btn ${r.members.every(t => t.muted) ? 'on-red' : ''}`} onClick={() => onTrackGroupFlag(r.grp.id, 'muted')} title="Mute the whole group">M</button>
              <button className={`arr-btn ${r.members.every(t => t.solo) ? 'on-yellow' : ''}`} onClick={() => onTrackGroupFlag(r.grp.id, 'solo')} title="Solo the whole group">S</button>
              <input type="range" className="arr-vol" min={0} max={100} value={Math.round(Math.max(...r.members.map(t => t.volume)) * 100)}
                onChange={(e) => onTrackGroupSet(r.grp.id, 'volume', Number(e.target.value) / 100)}
                title="Volume of the whole group (the balance between its tracks is kept)" />
              </div>
            </div>
          ) : (
            <div
              key={r.track.id}
              className={`arr-head${r.h < 34 ? ' compact' : ''}${r.track.id === activeTrackId ? ' active' : ''}${selectedTrackIds.has(r.track.id) && selectedTrackIds.size > 1 ? ' selected' : ''}${r.track.muted ? ' muted' : ''}${r.track.groupId ? ' grouped' : ''}${overIndex === r.index ? ' drag-over' : ''}`}
              style={{ height: r.h, '--c': colourOf(r.track, r.index) }}
              onClick={(e) => onSelectTrack(r.track.id, clickMode(e))}
              onContextMenu={(e) => {
                e.preventDefault();
                if (!selectedTrackIds.has(r.track.id)) onSelectTrack(r.track.id, 'single');
                setCtxMenu({ kind: 'track', id: r.track.id, x: e.clientX, y: e.clientY });
              }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOverIndex(r.index); }}
              onDragLeave={() => setOverIndex(null)}
              onDrop={(e) => { e.preventDefault(); if (dragIndex !== null && dragIndex !== r.index) onReorderTracks(dragIndex, r.index); setDragIndex(null); setOverIndex(null); }}
            >
              <span
                className="arr-grip" draggable title="Drag to reorder this track"
                onClick={(e) => e.stopPropagation()}
                onDragStart={(e) => { setDragIndex(r.index); e.dataTransfer.effectAllowed = 'move'; const row = e.currentTarget.closest('.arr-head'); if (row) e.dataTransfer.setDragImage(row, 12, 12); }}
                onDragEnd={() => { setDragIndex(null); setOverIndex(null); }}
              >⠿</span>
              <span className="arr-dot" />
              {editingId === r.track.id ? (
                <input
                  className="arr-name-input" value={editName} autoFocus
                  onChange={(e) => setEditName(e.target.value)} onBlur={commitRename}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditingId(null); e.stopPropagation(); }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="arr-name" title={`${r.track.name} (double-click to rename)`} onDoubleClick={(e) => { e.stopPropagation(); setEditingId(r.track.id); setEditName(r.track.name); }}>
                  {r.track.type === 'audio' ? '🎵 ' : ''}{r.track.name}
                </span>
              )}
              {(() => {
                // one speaker: on = you will hear this track, off = muted or silenced by another track's solo
                const silenced = !r.track.muted && !r.track.solo && tracks.some(t => t.solo);
                const audible = !r.track.muted && !silenced;
                return (
                  <button
                    className={`arr-btn arr-speaker ${audible ? '' : 'off'}`}
                    onClick={(e) => { e.stopPropagation(); onToggleMute(r.track.id); }}
                    title={r.track.muted ? 'Muted: click to unmute' : silenced ? 'Silent because another track is soloed: click to mute' : 'Click to mute'}
                  >{audible ? <Volume2 size={13} /> : <VolumeX size={13} />}</button>
                );
              })()}
              <button className={`arr-btn ${r.track.solo ? 'on-yellow' : ''}`} onClick={(e) => { e.stopPropagation(); onToggleSolo(r.track.id); }} title="Solo">S</button>
              {r.track.phantomRow && (
                <>
                  <button className="arr-btn" onClick={(e) => { e.stopPropagation(); onToggleVisible(r.track.id); }} title={r.track.phantomShow ? 'Hide phantom notes' : 'Show phantom notes'}>
                    {!r.track.phantomShow ? <EyeOff size={12} /> : <Eye size={12} />}
                  </button>
                  <input
                    type="range" className="arr-vol arr-vol-op" min={5} max={100} value={Math.round((r.track.phantomOpacity ?? 0.85) * 100)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => onSetBgOpacity(r.track.id, Number(e.target.value) / 100)}
                    title={`Phantom notes opacity: ${Math.round((r.track.phantomOpacity ?? 0.85) * 100)}%`}
                  />
                </>
              )}
              <input
                type="range" className="arr-vol" min={0} max={100} value={Math.round(r.track.volume * 100)}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => onSetVolume(r.track.id, Number(e.target.value) / 100)}
                title={`Volume ${Math.round(r.track.volume * 100)}%`}
              />
              <button
                className="arr-btn" title="More options for this track"
                onClick={(e) => { e.stopPropagation(); const b = e.currentTarget.getBoundingClientRect(); setOpts({ id: r.track.id, x: b.left, y: b.bottom + 4 }); }}
              ><MoreHorizontal size={13} /></button>
            </div>
          )))}
          <div className="arr-adds">
            <button className="arr-add" onClick={onAddTrack} title="Add a track">+ Track</button>
            <button
              className="arr-add" disabled={selectedTrackIds.size < 2} onClick={() => onGroupTracks()}
              title={selectedTrackIds.size < 2 ? 'Select two or more tracks first: Ctrl/Cmd or Shift + click their headers' : 'Group the selected tracks (Ctrl+G)'}
            >Group{selectedTrackIds.size > 1 ? ` ${selectedTrackIds.size} tracks` : ''}</button>
            {trackGroups.length > 0 && (
              <button
                className="arr-add" onClick={() => { const anyOpen = trackGroups.some(g => !g.collapsed); trackGroups.forEach(g => { if (!g.collapsed === anyOpen) onToggleTrackGroup(g.id); }); }}
                title="Collapse or expand all groups"
              >{trackGroups.some(g => !g.collapsed) ? 'Collapse groups' : 'Expand groups'}</button>
            )}
          </div>
        </div>
        <div className="arr-lanes" ref={lanesRef}>
          <canvas ref={canvasRef} className="arr-canvas" style={{ width: size.w, height: Math.max(rows.total, 1) }} onPointerDown={(e) => startPointer(e, false)} />
        </div>
      </div>
      {optsTrack && (
        <div className="arr-opts" style={{ left: Math.min(opts.x, window.innerWidth - 460), top: Math.min(opts.y, window.innerHeight - 260) }} onMouseDown={(e) => e.stopPropagation()}>
          <div className="arr-opts-title">{optsTrack.name}</div>
          <div className="arr-opts-body track-row-controls">
            <TrackControls
              track={optsTrack} isActive={optsTrack.id === activeTrackId}
              onToggleMute={onToggleMute} onToggleSolo={onToggleSolo} onSetVolume={onSetVolume}
              onToggleVisible={onToggleVisible} onSetBgOpacity={onSetBgOpacity} onSetTrackScheme={onSetTrackScheme}
              sessionSchemes={sessionSchemes} missingAudioIds={missingAudioIds} onLoadAudio={onLoadAudio}
              onSetAudioOptions={onSetAudioOptions} onNudgeBpm={onNudgeBpm} onDetectTempo={onDetectTempo} bpm={bpm}
              onAutoSync={onAutoSync} onClearSyncPoints={onClearSyncPoints}
            />
            <button className="track-btn-lg" onClick={() => { onDuplicateTrack(optsTrack.id); setOpts(null); }} title="Duplicate this track">Duplicate</button>
            <button className="track-btn-lg" onClick={() => { askDelete(optsTrack); setOpts(null); }} title="Delete this track" style={{ color: 'var(--danger)' }}>Delete</button>
          </div>
        </div>
      )}
      {secMenu && (() => {
        const stop = (e) => e.stopPropagation();
        const pos = { left: Math.min(secMenu.x, window.innerWidth - 230), top: Math.min(secMenu.y, window.innerHeight - 280) };
        if (secMenu.add !== undefined) {
          return (
            <div className="tab-context-menu" style={pos} onMouseDown={stop}>
              <button className="tab-context-menu-item" onClick={() => { onAddMarker(secMenu.add, 'Section'); setSecMenu(null); }}>New section here</button>
            </div>
          );
        }
        const sec = sections.find(x => x.id === secMenu.id);
        if (!sec) return null;
        const act = sectionActions || {};
        const item = (label, fn, extra) => <button className="tab-context-menu-item" onClick={() => { fn(); setSecMenu(null); }}>{label}{extra ? <span className="tab-context-menu-key">{extra}</span> : null}</button>;
        return (
          <div className="tab-context-menu" style={pos} onMouseDown={stop}>
            <div className="tab-context-menu-title">{sec.name}</div>
            {onAddMarker && secMenu.at > sec.start && item('Start a new section here', () => onAddMarker(secMenu.at, 'Section'))}
            {item('Rename', () => { const n = window.prompt('Section name', sec.name); if (n && n.trim()) onUpdateMarker(sec.id, { name: n.trim() }); })}
            <label className="tab-context-menu-colour-picker">
              <span className="tab-context-menu-label">Colour</span>
              <span className="tab-context-menu-colour-swatch" style={{ background: sec.color }} />
              <input type="color" value={sec.color || '#b24fcc'} onChange={(e) => onUpdateMarker(sec.id, { color: e.target.value })} onMouseDown={stop} aria-label="Pick section colour" />
            </label>
            <div className="tab-context-menu-divider" />
            {act.select && item('Select its notes', () => act.select(sec.id))}
            {act.loop && item('Loop this section', () => act.loop(sec.id), 'J')}
            {act.duplicate && item('Duplicate (insert a copy after)', () => act.duplicate(sec.id))}
            {act.remove && item('Delete section and close the gap', () => act.remove(sec.id))}
            <div className="tab-context-menu-divider" />
            {item('Remove section marker only', () => onDeleteMarker(sec.id))}
          </div>
        );
      })()}
      <TrackMenu
        menu={ctxMenu} onClose={() => setCtxMenu(null)} tracks={tracks} trackGroups={trackGroups} selectedTrackIds={selectedTrackIds}
        onGroupTracks={onGroupTracks} onUngroupTracks={onUngroupTracks} onDuplicateTrack={onDuplicateTrack}
        onLoadAudio={onLoadAudio} missingAudioIds={missingAudioIds} onTranscribe={onTranscribe} onLearn={onLearn}
        onTogglePhantomShow={onTogglePhantomShow} onTogglePhantomEdit={onTogglePhantomEdit} onToggleHeat={onToggleHeat} heatTracks={heatTracks} onRemoveAudio={onRemoveAudio} onAskDelete={askDelete}
        onRename={(id) => { const t = tracks.find(x => x.id === id); if (t) { setEditingId(t.id); setEditName(t.name); } }}
        onOptions={(id) => setOpts({ id, x: ctxMenu?.x || 300, y: ctxMenu?.y || 300 })}
        onRenameTrackGroup={onRenameTrackGroup} onToggleTrackGroup={onToggleTrackGroup}
        onSetTrackGroupColour={onSetTrackGroupColour} onRemoveTrackGroup={onRemoveTrackGroup}
      />
      {confirmDelete && (
        <ConfirmDialog
          message={confirmDelete.notes?.length ? `Delete track "${confirmDelete.name}" with ${confirmDelete.notes.length} note${confirmDelete.notes.length !== 1 ? 's' : ''}?` : `Delete track "${confirmDelete.name}"?`}
          onConfirm={() => { onDeleteTrack(confirmDelete.id); setConfirmDelete(null); }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
