import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import ConfirmDialog from './ConfirmDialog';
import { TrackControls, TrackMenu } from './TrackParts';
import { beatToX, xToBeat, gridTotalWidth, barStartBeats } from '../utils/barLayout';
import { getClips, clipEndBeat } from '../utils/audioClips';
import { CELL_WIDTH } from '../utils/constants';
import { TRACK_GROUP_COLOURS } from '../utils/trackGroups';

const ROW_MIN = 20, ROW_MAX = 180, ROW_DEFAULT = 46;
const ROW_KEY = 'guitar-roll-arrangement-row-height';
const GROUP_H = 44;
const RULER_H = 22;
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
  onTranscribe, onLearn, onToggleHeat, heatTracks, onLoadAudio, missingAudioIds, onRemoveAudio, onSetAudioOptions,
  onNudgeBpm, onDetectTempo, bpm, onAddSyncPoint, onAutoSync, onClearSyncPoints,
  extraTop = null, extraBottom = null,
}) {
  const lanesRef = useRef(null);
  const canvasRef = useRef(null);
  const rulerRef = useRef(null);
  const scrollRef = useRef(null);
  const [size, setSize] = useState({ w: 600, h: 200 });
  const [scrollLeft, setScrollLeft] = useState(0);
  const [ctxMenu, setCtxMenu] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [dragIndex, setDragIndex] = useState(null);
  const [overIndex, setOverIndex] = useState(null);
  const [inspOpen, setInspOpen] = useState(() => { try { return localStorage.getItem('guitar-roll-arrangement-inspector') !== '0'; } catch { return true; } });
  const toggleInsp = () => setInspOpen((o) => { try { localStorage.setItem('guitar-roll-arrangement-inspector', o ? '0' : '1'); } catch { /* ignore */ } return !o; });
  const clickMode = (e) => (e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'range' : 'single');
  const commitRename = () => { if (editingId && editName.trim()) onRenameTrack(editingId, editName.trim()); setEditingId(null); };
  const askDelete = (t) => { if ((t.notes && t.notes.length > 0) || t.audioFileName) setConfirmDelete(t); else onDeleteTrack(t.id); };
  const activeTrack = tracks.find(t => t.id === activeTrackId) || null;
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
  // horizontal zoom is the Timeline's (they share the grid): ask it to zoom around the playhead
  const zoomH = (dir) => window.dispatchEvent(new CustomEvent('timeline-zoom', { detail: { dir } }));
  const cellWidth = CELL_WIDTH * timelineZoom;
  const totalCols = barSubdivisions.reduce((a, b) => a + b, 0);
  const regionSet = loop || loopStart > 0 || loopEnd < totalCols; // an inactive region stays visible, greyed

  // follow the Timeline's horizontal scroll
  useEffect(() => {
    let el = null;
    let raf = 0;
    let tries = 0;
    const on = () => setScrollLeft(el.scrollLeft);
    const attach = () => {
      el = bodyRef?.current;
      if (!el) { if (tries++ < 600) raf = requestAnimationFrame(attach); return; }
      on();
      el.addEventListener('scroll', on, { passive: true });
    };
    attach();
    return () => { cancelAnimationFrame(raf); if (el) el.removeEventListener('scroll', on); };
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
  const gridW = gridTotalWidth(barSubdivisions, cellWidth);
  const headBeat = playing && currentBeat != null ? currentBeat : selectedBeat;
  const X = useCallback((b) => beatToX(b, barSubdivisions, cellWidth) - scrollLeft, [barSubdivisions, cellWidth, scrollLeft]);

  // ruler
  useEffect(() => {
    const cv = rulerRef.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.floor(size.w * dpr); cv.height = Math.floor(RULER_H * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(cv);
    const col = (n, d) => css.getPropertyValue(n).trim() || d;
    g.fillStyle = col('--raise', '#15151b'); g.fillRect(0, 0, size.w, RULER_H);
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
  }, [size, X, barSubdivisions, loop, loopStart, loopEnd, regionSet]);

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
    // playhead
    const px = X(headBeat);
    if (px >= 0 && px <= size.w) { g.strokeStyle = '#fff'; g.beginPath(); g.moveTo(px + 0.5, 0); g.lineTo(px + 0.5, H); g.stroke(); }
  }, [size, rows, X, barSubdivisions, tempoMap, loop, loopStart, loopEnd, regionSet, headBeat, activeTrackId, tracks, trackGroups]);

  const onLaneDown = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const row = rows.list.find(q => y >= q.y && y < q.y + q.h);
    if (row && row.kind === 'track') onSelectTrack(row.track.id, clickMode(e));
    onSelectBeat(Math.max(0, xToBeat(x + scrollLeft, barSubdivisions, cellWidth, false)));
  };
  // wheel: Ctrl+wheel zooms horizontally (the Timeline), Ctrl+Shift+wheel changes the track height,
  // horizontal wheel moves the Timeline too
  const lastZoomAt = useRef(0);
  const onWheel = (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      if (e.shiftKey) { changeRowH(h => h * (1 - e.deltaY * 0.005)); return; }
      const now = performance.now();
      if (now - lastZoomAt.current < 60) return;
      lastZoomAt.current = now;
      zoomH(e.deltaY < 0 ? 1 : -1);
      return;
    }
    const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : (e.shiftKey ? e.deltaY : 0);
    if (!dx || !bodyRef?.current) return;
    e.preventDefault();
    bodyRef.current.scrollLeft += dx;
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
      {extraTop}
      <div className="arr-top" style={{ height: RULER_H }}>
        <div className="arr-head-spacer arr-zoombar">
          <span title="Zoom in time (Ctrl + scroll)">⇔</span>
          <button className="arr-btn" onClick={() => zoomH(-1)} title="Zoom out in time (Ctrl + scroll)">−</button>
          <button className="arr-btn" onClick={() => zoomH(1)} title="Zoom in on time (Ctrl + scroll)">+</button>
          <span title="Track height (Ctrl + Shift + scroll)">⇕</span>
          <button className="arr-btn" onClick={() => changeRowH(h => h / 1.2)} title="Shorter tracks (Ctrl + Shift + scroll)">−</button>
          <button className="arr-btn" onClick={() => changeRowH(h => h * 1.2)} title="Taller tracks (Ctrl + Shift + scroll)">+</button>
          <button className="arr-btn arr-fit" onClick={fitHeight} title="Fit all tracks into the window height">Fit</button>
        </div>
        <canvas ref={rulerRef} className="arr-ruler" style={{ width: size.w, height: RULER_H }} />
      </div>
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
              <button className="arr-btn" onClick={() => onTrackGroupSet(r.grp.id, 'visible', r.members.every(t => t.visible === false))}
                title={r.members.every(t => t.visible === false) ? 'Show the whole group' : 'Hide the whole group'}>
                {r.members.every(t => t.visible === false) ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
              <input type="range" className="arr-vol" min={0} max={100} value={Math.round(Math.max(...r.members.map(t => t.volume)) * 100)}
                onChange={(e) => onTrackGroupSet(r.grp.id, 'volume', Number(e.target.value) / 100)}
                title="Volume of the whole group (the balance between its tracks is kept)" />
              <input type="range" className="arr-vol arr-vol-op" min={5} max={100}
                value={Math.round(r.members.reduce((x, t) => x + (t.bgOpacity ?? 0.2), 0) / r.members.length * 100)}
                onChange={(e) => onTrackGroupSet(r.grp.id, 'bgOpacity', Number(e.target.value) / 100)}
                title="Opacity of the whole group's notes in the background" />
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
              <input
                type="checkbox" className="arr-check"
                checked={selectedTrackIds.has(r.track.id) && selectedTrackIds.size > 1}
                onClick={(e) => e.stopPropagation()}
                onChange={() => onSelectTrack(r.track.id, 'toggle')}
                title="Tick several tracks, then press Group (or Ctrl/⌘+click, Shift+click)"
              />
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
              <button className={`arr-btn ${r.track.muted ? 'on-red' : ''}`} onClick={(e) => { e.stopPropagation(); onToggleMute(r.track.id); }} title="Mute">M</button>
              <button className={`arr-btn ${r.track.solo ? 'on-yellow' : ''}`} onClick={(e) => { e.stopPropagation(); onToggleSolo(r.track.id); }} title="Solo">S</button>
              <button className="arr-btn" onClick={(e) => { e.stopPropagation(); onToggleVisible(r.track.id); }} title={r.track.visible === false ? 'Show in the roll' : 'Hide from the roll'}>
                {r.track.visible === false ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
              <input
                type="range" className="arr-vol" min={0} max={100} value={Math.round(r.track.volume * 100)}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => onSetVolume(r.track.id, Number(e.target.value) / 100)}
                title={`Volume ${Math.round(r.track.volume * 100)}%`}
              />
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
          <canvas ref={canvasRef} className="arr-canvas" style={{ width: size.w, height: Math.max(rows.total, 1) }} onPointerDown={onLaneDown} />
        </div>
      </div>
      {extraBottom}
      <div className={`arr-inspector${inspOpen ? ' open' : ''}`}>
        <button className="arr-insp-toggle" onClick={toggleInsp} title="The options of the selected track">
          {inspOpen ? '▾' : '▸'} {activeTrack ? `${activeTrack.name}: options` : 'Track options'}
        </button>
        {inspOpen && activeTrack && (
          <div className="arr-insp-body track-row-controls">
            <TrackControls
              track={activeTrack} isActive
              onToggleMute={onToggleMute} onToggleSolo={onToggleSolo} onSetVolume={onSetVolume}
              onToggleVisible={onToggleVisible} onSetBgOpacity={onSetBgOpacity} onSetTrackScheme={onSetTrackScheme}
              sessionSchemes={sessionSchemes} missingAudioIds={missingAudioIds} onLoadAudio={onLoadAudio}
              onSetAudioOptions={onSetAudioOptions} onNudgeBpm={onNudgeBpm} onDetectTempo={onDetectTempo} bpm={bpm}
              onAddSyncPoint={onAddSyncPoint} onAutoSync={onAutoSync} onClearSyncPoints={onClearSyncPoints}
            />
            <button className="track-btn-lg" onClick={() => onDuplicateTrack(activeTrack.id)} title="Duplicate this track">Duplicate</button>
            <button className="track-btn-lg" onClick={() => askDelete(activeTrack)} title="Delete this track" style={{ color: 'var(--danger)' }}>Delete</button>
          </div>
        )}
      </div>
      <TrackMenu
        menu={ctxMenu} onClose={() => setCtxMenu(null)} tracks={tracks} trackGroups={trackGroups} selectedTrackIds={selectedTrackIds}
        onGroupTracks={onGroupTracks} onUngroupTracks={onUngroupTracks} onDuplicateTrack={onDuplicateTrack}
        onLoadAudio={onLoadAudio} missingAudioIds={missingAudioIds} onTranscribe={onTranscribe} onLearn={onLearn}
        onToggleHeat={onToggleHeat} heatTracks={heatTracks} onRemoveAudio={onRemoveAudio} onAskDelete={askDelete}
        onRename={(id) => { const t = tracks.find(x => x.id === id); if (t) { setEditingId(t.id); setEditName(t.name); } }}
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
