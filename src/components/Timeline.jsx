import { useRef, useState, useEffect, useLayoutEffect, useCallback } from 'react';
import {
  NUM_STRINGS, NUM_FRETS, NUM_BARS, SUBDIVISIONS,
  CELL_WIDTH
} from '../utils/constants';
import { getNoteName, playNote, getAudioContext, getMasterOut } from '../utils/audio';
import {
  TOTAL_PITCH_ROWS, PITCH_LIST, noteToPitchRow, pitchRowToMidi, midiToPitchRow,
  midiToNoteName, getMidiNote, closestComboForPitch, pitchRowCombos, getComboForPosition
} from '../utils/pitchMap';
import { totalColumns, barStartBeats, beatToBar, beatLabel, isBarStart, remapNotes, beatToX as beatToXUtil, xToBeat as xToBeatUtil, gridTotalWidth, colWidth, durationToWidth as durationToWidthUtil, timeToBeat } from '../utils/barLayout';
import { matchesWheelHotkey } from '../utils/hotkeys';
import { createAutoPan } from '../utils/autoPan';
import { onsetTimes } from '../utils/beatDetect';
import { prepareScrub, scrubTarget, scrubStop, scrubHold } from '../utils/scrubVoice';
import { clipSpans, clipBeatToTime, clipTimeToBeat, linearMap } from '../utils/audioClips';

const TOTAL_FRETS_PER_STRING = NUM_FRETS + 1;
const totalRows = TOTAL_PITCH_ROWS;
const BASE_ROW_HEIGHT = 20; // pixels per pitch row at 1x vertical zoom
export const VERTICAL_ZOOM_MIN = 0.4;
export const VERTICAL_ZOOM_MAX = 4;

export default function Timeline({
  notes, backgroundNotes = [], setNotes, saveSnapshot, setNotesDrag, commitDrag, freeMode = false,
  timelineZoom = 1, setTimelineZoom,
  timelineVerticalZoom = 1, setTimelineVerticalZoom,
  showVerticalZoomButtons = true,
  barSubdivisions, setBarSubdivisions,
  currentBeat, playheadBeatRef, selectedBeat, setSelectedBeat,
  playing, onDeleteNote,
  loopStart, loopEnd, setLoopStart, setLoopEnd, loop, setLoop,
  selectedNotes, setSelectedNotes, stringColors, getNoteColor,
  hoveredNote, setHoveredNote,
  verticalScroll, setVerticalScroll,
  machineGunMode = false,
  defaultVelocity = 0.8,
  noteDuration = 1,
  setNoteDuration,
  snapUnit = 1,
  subdivisions = 1,
  rhythmMult = 1,
  rhythmUnit = 'beat',
  hotkeys,
  hoverPreviewPiano = false,
  hoverPreviewNotes = false,
  hoverVolume = 0.3,
  tupletLines = { visible: true, opacity: 0.35 },
  onTimelineHover,
  markers = [],
  onAddMarker,
  onUpdateMarker,
  onDeleteMarker,
  onResizeDuration,
  autoScroll,
  audioTracks = [],
  selectedClips = new Set(), setSelectedClips = () => {}, onUpdateClips = () => {}, onUpdateSyncPoints = () => {}, tempoMap = null, onAddSyncPointAt = null, onAuditionNotes = null,
  bpm = 120,
  timeSignature = [4, 4],
  bodyRefExternal,
  position = 0,
  setPosition,
  swing,
  swungDisplay,
  activeInstanceScheme = null,
  onGrowBars,
}) {
  const bodyRef = useRef(null);
  const headerRef = useRef(null);
  const [headerScrollLeft, setHeaderScrollLeft] = useState(0);
  const cellWidth = CELL_WIDTH * timelineZoom;
  const rowHeight = BASE_ROW_HEIGHT * timelineVerticalZoom;
  const gridTotalHeight = totalRows * rowHeight;
  const rowTopPx = (stringIndex, fret) => (totalRows - 1 - noteToPitchRow(stringIndex, fret)) * rowHeight;
  const pitchRowTopPx = (pitchRow) => (totalRows - 1 - pitchRow) * rowHeight;
  const totalCols = totalColumns(barSubdivisions);
  const swingActive = swungDisplay && swing !== 50;
  const beatToX = (beat, barSubs, cw) => beatToXUtil(beat, barSubs, cw, swingActive ? swing : null, swingActive);
  const xToBeat = (x, barSubs, cw, snap = true) => xToBeatUtil(x, barSubs, cw, snap, swingActive ? swing : null, swingActive);
  const durationToWidth = (beat, duration, barSubs, cw) => durationToWidthUtil(beat, duration, barSubs, cw, swingActive ? swing : null, swingActive);
  const gridWidth = swingActive ? beatToX(totalCols, barSubdivisions, cellWidth) : gridTotalWidth(barSubdivisions, cellWidth);
  const starts = barStartBeats(barSubdivisions);
  const draggingRef = useRef(null);   // resize drag
  const noteDragRef = useRef(null);   // note move drag
  const [dragPreview, setDragPreview] = useState(null);
  const loopDragRef = useRef(null);
  const marqueeRef = useRef(null);
  const marqueeDidDragRef = useRef(false);
  const [cursorMode, setCursorMode] = useState(false);
  const cursorModeRef = useRef(false);
  const [subdivMenu, setSubdivMenu] = useState(null); // { barIndex, x, y }
  const [marquee, setMarquee] = useState(null); // { x1, y1, x2, y2 } in px relative to grid
  const [hoverPos, setHoverPos] = useState(null); // { beat, stringIndex, fret } snapped position under mouse
  const [markerMenu, setMarkerMenu] = useState(null); // { x, y, beat, markerId } for context menu
  const [editingMarkerId, setEditingMarkerId] = useState(null);
  const [editingMarkerName, setEditingMarkerName] = useState('');
  const markerDragRef = useRef(null);
  const bodyPlayheadRef = useRef(null);
  const headerPlayheadRef = useRef(null);

  // Edge auto-pan during drags — see src/utils/autoPan.js
  const autoPan = useRef(createAutoPan(() => bodyRef.current)).current;
  // Scrubbing scrolls sideways only, at a gentler pace
  const scrubPan = useRef(createAutoPan(() => bodyRef.current, { horizontalOnly: true, max: 18 })).current;

  // Imperatively move playhead every frame during playback so it stays in sync with audio
  // even when the expensive timeline DOM is slow to re-render at high zoom-out.
  useEffect(() => {
    if (!playing || !playheadBeatRef) return;
    let raf;
    const tick = () => {
      const b = playheadBeatRef.current;
      if (b !== null && b !== undefined) {
        const x = beatToX(b, barSubdivisions, cellWidth);
        if (bodyPlayheadRef.current) bodyPlayheadRef.current.style.left = x + 'px';
        if (headerPlayheadRef.current) headerPlayheadRef.current.style.left = x + 'px';
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, playheadBeatRef, barSubdivisions, cellWidth]);

  const yToPitch = useCallback((y) => {
    const rowFromTop = Math.floor(y / rowHeight);
    const pitchRow = Math.max(0, Math.min(totalRows - 1, totalRows - 1 - rowFromTop));
    const midi = pitchRowToMidi(pitchRow);
    const result = getComboForPosition(midi, position);
    if (!result) return null;
    return { stringIndex: result.stringIndex, fret: result.fret, _newPosition: result.position };
  }, [rowHeight, position]);

  // Track K key for cursor-only mode (deselect + place cursor, no note input)
  useEffect(() => {
    const getKey = () => (hotkeysRef.current?.cursorMode?.key || 'k').toLowerCase();
    const down = (e) => { if (e.key.toLowerCase() === getKey()) { cursorModeRef.current = true; setCursorMode(true); } };
    const up = (e) => { if (e.key.toLowerCase() === getKey()) { cursorModeRef.current = false; setCursorMode(false); } };
    document.addEventListener('keydown', down);
    document.addEventListener('keyup', up);
    return () => { document.removeEventListener('keydown', down); document.removeEventListener('keyup', up); };
  }, []);

  const handleClick = useCallback((e) => {
    if (playing) return;
    if (draggingRef.current || noteDragRef.current) return;
    if (marqueeDidDragRef.current) { marqueeDidDragRef.current = false; return; }
    if (machineGunMode) return;

    // K held: cursor-only mode — deselect and place cursor
    if (cursorModeRef.current) {
      if (!e.shiftKey) setSelectedNotes(new Set());
      const rect = bodyRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left + bodyRef.current.scrollLeft;
      let beat;
      if (freeMode) {
        beat = xToBeat(x, barSubdivisions, cellWidth, false);
      } else {
        const rawBeat = xToBeat(x, barSubdivisions, cellWidth, false);
        beat = Math.round(rawBeat / snapUnit) * snapUnit;
      }
      if (beat >= 0 && beat < totalCols) setSelectedBeat(beat);
    }
  }, [setSelectedBeat, setSelectedNotes, playing, freeMode, cellWidth, snapUnit, machineGunMode, totalCols, barSubdivisions]);

  const handleNoteClick = useCallback((e, noteIndex) => {
    if (e.shiftKey) {
      e.stopPropagation();
      setSelectedNotes(prev => {
        const next = new Set(prev);
        if (next.has(noteIndex)) {
          next.delete(noteIndex);
        } else {
          next.add(noteIndex);
        }
        return next;
      });
      return;
    }
  }, [setSelectedNotes]);

  const handleResizeStart = useCallback((e, noteIndex) => {
    e.stopPropagation();
    e.preventDefault();
    const note = notes[noteIndex];
    const isSelected = selectedNotes.has(noteIndex);
    const affectedIndices = isSelected ? [...selectedNotes] : [noteIndex];
    const startDurations = new Map(
      affectedIndices.map(i => [i, notes[i].duration || 1])
    );

    draggingRef.current = {
      noteIndex,
      startX: e.clientX,
      startDuration: note.duration || 1,
      affectedIndices,
      startDurations,
    };
    saveSnapshot();
    const isFree = freeMode;
    const snap = snapUnit;

    const runResize = (clientX) => {
      if (!draggingRef.current) return;
      // Compensate for auto-pan: convert delta to content-space by including scrollLeft shift.
      const scrollDelta = (bodyRef.current?.scrollLeft ?? 0) - (draggingRef.current.startScroll ?? 0);
      const dx = (clientX - draggingRef.current.startX) + scrollDelta;
      const { affectedIndices, startDurations } = draggingRef.current;
      const noteBarIdx = beatToBar(notes[draggingRef.current.noteIndex].beat, barSubdivisions).barIndex;
      const cw = colWidth(noteBarIdx, barSubdivisions, cellWidth);
      const dBeats = dx / cw;

      const primaryBase = startDurations.get(draggingRef.current.noteIndex);
      const primaryRaw = primaryBase + dBeats;
      draggingRef.current.lastDuration = isFree ? Math.max(0.1, primaryRaw) : Math.max(snap, Math.round(primaryRaw / snap) * snap);

      setNotesDrag(prev => prev.map((n, i) => {
        if (!affectedIndices.includes(i)) return n;
        const baseDuration = startDurations.get(i);
        const rawDuration = baseDuration + dBeats;
        let newDuration = isFree ? Math.max(0.1, rawDuration) : Math.max(snap, Math.round(rawDuration / snap) * snap);
        const maxDuration = totalCols - n.beat;
        return { ...n, duration: Math.min(newDuration, maxDuration) };
      }));
    };
    draggingRef.current.startScroll = bodyRef.current?.scrollLeft ?? 0;

    const handleMouseMove = (moveE) => {
      autoPan.update(moveE.clientX, moveE.clientY);
      runResize(moveE.clientX);
    };
    autoPan.start(e.clientX, e.clientY, (cx) => runResize(cx));

    const handleMouseUp = () => {
      autoPan.stop();
      const finalDur = draggingRef.current?.lastDuration;
      commitDrag();
      if (finalDur != null && onResizeDuration) {
        onResizeDuration(finalDur);
      }
      setTimeout(() => { draggingRef.current = null; }, 0);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [notes, setNotesDrag, saveSnapshot, commitDrag, selectedNotes, freeMode, snapUnit, onResizeDuration, autoPan, barSubdivisions, cellWidth, totalCols]);

  // Resize from the left edge: moves start beat right/left while keeping the end fixed.
  const handleResizeStartLeft = useCallback((e, noteIndex) => {
    e.stopPropagation();
    e.preventDefault();
    const note = notes[noteIndex];
    const isSelected = selectedNotes.has(noteIndex);
    const affectedIndices = isSelected ? [...selectedNotes] : [noteIndex];
    const startStates = new Map(
      affectedIndices.map(i => [i, { beat: notes[i].beat, duration: notes[i].duration || 1 }])
    );

    draggingRef.current = {
      noteIndex,
      startX: e.clientX,
      affectedIndices,
      startStates,
      leftEdge: true,
    };
    saveSnapshot();
    const isFree = freeMode;
    const snap = snapUnit;

    draggingRef.current.startScroll = bodyRef.current?.scrollLeft ?? 0;
    const runLeftResize = (clientX) => {
      if (!draggingRef.current) return;
      const scrollDelta = (bodyRef.current?.scrollLeft ?? 0) - (draggingRef.current.startScroll ?? 0);
      const dx = (clientX - draggingRef.current.startX) + scrollDelta;
      const { affectedIndices, startStates } = draggingRef.current;
      const noteBarIdx = beatToBar(note.beat, barSubdivisions).barIndex;
      const cw = colWidth(noteBarIdx, barSubdivisions, cellWidth);
      const dBeats = dx / cw;

      setNotesDrag(prev => prev.map((n, i) => {
        if (!affectedIndices.includes(i)) return n;
        const base = startStates.get(i);
        const end = base.beat + base.duration;
        const rawBeat = base.beat + dBeats;
        let newBeat = isFree ? rawBeat : Math.round(rawBeat / snap) * snap;
        const prevEnd = prev
          .filter((m, j) => j !== i && m.stringIndex === n.stringIndex && m.beat + (m.duration || 1) <= end && m.beat < newBeat + 0.0001)
          .reduce((max, m) => {
            const e2 = m.beat + (m.duration || 1);
            return e2 > max ? e2 : max;
          }, 0);
        newBeat = Math.max(prevEnd, Math.min(newBeat, end - (isFree ? 0.01 : snap)));
        const newDuration = Math.max(isFree ? 0.01 : snap, end - newBeat);
        return { ...n, beat: newBeat, duration: newDuration };
      }));
    };

    const handleMouseMove = (moveE) => {
      autoPan.update(moveE.clientX, moveE.clientY);
      runLeftResize(moveE.clientX);
    };
    autoPan.start(e.clientX, e.clientY, (cx) => runLeftResize(cx));

    const handleMouseUp = () => {
      autoPan.stop();
      commitDrag();
      setTimeout(() => { draggingRef.current = null; }, 0);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [notes, setNotesDrag, saveSnapshot, commitDrag, selectedNotes, freeMode, snapUnit, barSubdivisions, cellWidth, autoPan]);

  const rightDragEraseRef = useRef(false);
  const handleNoteContextMenu = useCallback((e, noteIndex) => {
    e.preventDefault();
    e.stopPropagation();
    // The right-click-drag eraser already handled deletion on mousedown
    if (rightDragEraseRef.current) { rightDragEraseRef.current = false; return; }
    setNotes(prev => prev.filter((_, i) => i !== noteIndex));
    setSelectedNotes(new Set());
  }, [setNotes, setSelectedNotes]);

  const handleNoteDragStart = useCallback((e, noteIndex) => {
    if (e.shiftKey || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const note = notes[noteIndex];
    const rect = bodyRef.current.getBoundingClientRect();
    const gridTop = rect.top;
    // Determine which notes are being dragged
    const isSelected = selectedNotes.has(noteIndex);
    const affectedIndices = isSelected && selectedNotes.size > 1 ? [...selectedNotes] : [noteIndex];
    const startPositions = new Map(
      affectedIndices.map(i => [i, { beat: notes[i].beat, stringIndex: notes[i].stringIndex, fret: notes[i].fret }])
    );
    const anchorPitchRow = noteToPitchRow(note.stringIndex, note.fret);

    noteDragRef.current = {
      noteIndex,
      affectedIndices,
      startPositions,
      anchorPitchRow,
      startX: e.clientX,
      startY: e.clientY,
      startBeat: note.beat,
      startStringIndex: note.stringIndex,
      startFret: note.fret,
      lastSoundString: note.stringIndex,
      lastSoundFret: note.fret,
      lastDeltaBeat: 0,
      lastDeltaRow: 0,
      gridTop,
      didMove: false,
    };
    // Preview for all affected notes
    setDragPreview({
      affectedIndices,
      deltaBeat: 0,
      deltaRow: 0,
      isDuplicate: e.altKey,
    });

    const isFree = freeMode;

    noteDragRef.current.startScrollX = bodyRef.current.scrollLeft;

    const runNoteMove = (clientX, clientY, altKey) => {
      if (!noteDragRef.current) return;
      const d = noteDragRef.current;

      // Include auto-pan scroll delta so dragging past the edge keeps moving the note in content space.
      const scrollDeltaX = (bodyRef.current?.scrollLeft ?? 0) - (d.startScrollX ?? 0);
      const dx = (clientX - d.startX) + scrollDeltaX;
      const dy = clientY - d.startY;
      if (!d.didMove && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      d.didMove = true;

      const anchorBarIdx = beatToBar(d.startBeat, barSubdivisions).barIndex;
      const anchorCw = colWidth(anchorBarIdx, barSubdivisions, cellWidth);
      const deltaBeat = dx / anchorCw;

      const scrollTop = bodyRef.current.scrollTop;
      const mouseY = clientY - d.gridTop + scrollTop;
      const rowFromTop = Math.floor(mouseY / rowHeight);
      const currentPitchRow = Math.max(0, Math.min(totalRows - 1, totalRows - 1 - rowFromTop));
      const deltaRow = currentPitchRow - d.anchorPitchRow;

      // Play sound when anchor note pitch changes
      const anchorNewPitchRow = Math.max(0, Math.min(totalRows - 1, d.anchorPitchRow + deltaRow));
      const anchorNewMidi = pitchRowToMidi(anchorNewPitchRow);
      const combo = closestComboForPitch(anchorNewMidi, d.startStringIndex);
      if (combo && (combo.stringIndex !== d.lastSoundString || combo.fret !== d.lastSoundFret)) {
        playNote(combo.stringIndex, combo.fret, 0.2);
        d.lastSoundString = combo.stringIndex;
        d.lastSoundFret = combo.fret;
      }

      d.lastDeltaBeat = deltaBeat;
      d.lastDeltaRow = deltaRow;
      d.isDuplicate = altKey;
      setDragPreview({
        affectedIndices: d.affectedIndices,
        deltaBeat,
        deltaRow,
        isDuplicate: altKey,
      });
    };

    let lastAlt = false;
    const handleMouseMove = (moveE) => {
      lastAlt = moveE.altKey;
      autoPan.update(moveE.clientX, moveE.clientY);
      runNoteMove(moveE.clientX, moveE.clientY, moveE.altKey);
    };
    autoPan.start(e.clientX, e.clientY, (cx, cy) => runNoteMove(cx, cy, lastAlt));

    const handleMouseUp = () => {
      autoPan.stop();
      const d = noteDragRef.current;
      if (d && d.didMove) {
        const { affectedIndices, startPositions, lastDeltaBeat, lastDeltaRow } = d;
        const oldPitchRow = noteToPitchRow(startPositions.get(affectedIndices[0]).stringIndex, startPositions.get(affectedIndices[0]).fret);
        const newPitchRow = Math.max(0, Math.min(totalRows - 1, oldPitchRow + lastDeltaRow));
        const newMidi = pitchRowToMidi(newPitchRow);
        const smartCombo = newMidi != null ? getComboForPosition(newMidi, position) : null;
        if (d.isDuplicate) {
          // Duplicate: keep originals, add copies at new positions
          setNotes(old => {
            const copies = affectedIndices.map(i => {
              const n = old[i];
              const start = startPositions.get(i);
              const oldPitchRow = noteToPitchRow(start.stringIndex, start.fret);
              const newPitchRow = Math.max(0, Math.min(totalRows - 1, oldPitchRow + lastDeltaRow));
              const newMidi = pitchRowToMidi(newPitchRow);
              const combo = closestComboForPitch(newMidi, start.stringIndex);
              if (!combo) return null;
              const rawBeat = start.beat + lastDeltaBeat;
              const newBeat = Math.max(0, Math.min(totalCols - (n.duration || 1), isFree ? rawBeat : Math.round(rawBeat / snapUnit) * snapUnit));
              return { ...n, beat: newBeat, stringIndex: combo.stringIndex, fret: combo.fret };
            }).filter(Boolean);
            return [...old, ...copies];
          });
        } else {
          // Move: update existing notes
          setNotes(old => old.map((n, i) => {
            if (!affectedIndices.includes(i)) return n;
            const start = startPositions.get(i);
            const oldPitchRow = noteToPitchRow(start.stringIndex, start.fret);
            const newPitchRow = Math.max(0, Math.min(totalRows - 1, oldPitchRow + lastDeltaRow));
            const newMidi = pitchRowToMidi(newPitchRow);
            const combo = closestComboForPitch(newMidi, start.stringIndex);
            if (!combo) return n;
            const rawBeat = start.beat + lastDeltaBeat;
            const newBeat = Math.max(0, Math.min(totalCols - (n.duration || 1), isFree ? rawBeat : Math.round(rawBeat / snapUnit) * snapUnit));
            return { ...n, beat: newBeat, stringIndex: combo.stringIndex, fret: combo.fret };
          }));
        }
        if (smartCombo && smartCombo.position != null && smartCombo.position !== position && setPosition) {
          setPosition(smartCombo.position);
        }
      }
      // Plain click (no drag): select just this note, cancelling other selections.
      if (d && !d.didMove) setSelectedNotes(new Set([noteIndex]));
      setDragPreview(null);
      noteDragRef.current = null;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [notes, setNotes, setSelectedNotes, selectedNotes, freeMode, rowHeight, position, setPosition]);

  // ---- Scrubbing: dragging the playhead plays the recording under it, tape style (see
  // utils/scrubVoice.js): the sound follows the pointer's speed and direction smoothly. ----
  const scrubTo = (beat) => {
    audioTracks.forEach(at => {
      const buf = at.audioBuffer;
      if (!buf) return;
      const m = mapFor(at);
      const clip = at.muted ? null : (at.clips || []).find(c => beat >= c.start && beat <= clipTimeToBeat(c, c.srcEnd, m));
      scrubTarget(buf, clip ? clipBeatToTime(clip, beat, m) : null, at.volume ?? 1);
    });
  };
  const scrubEnd = () => audioTracks.forEach(at => { if (at.audioBuffer) { scrubHold(at.audioBuffer, false); scrubStop(at.audioBuffer); } });
  const scrubHoldAll = (on) => audioTracks.forEach(at => { if (at.audioBuffer) scrubHold(at.audioBuffer, on); });

  // Alt + Space: sound whatever is at the playhead (notes once, audio for as long as the keys are held).
  // Alt + Space + drag: the timeline moves under a playhead that stays where it is on screen,
  // and you keep hearing what is under it.
  const altSpaceRef = useRef(false);
  const audioTracksRef = useRef(audioTracks);
  audioTracksRef.current = audioTracks;
  const mapForRef = useRef(null);
  const selectedBeatLive = useRef(selectedBeat);
  selectedBeatLive.current = selectedBeat;
  const auditionRef = useRef(null);
  auditionRef.current = { onAuditionNotes, playing };
  useEffect(() => {
    const isTyping = (e) => e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT');
    const stop = () => {
      if (!altSpaceRef.current) return;
      altSpaceRef.current = false;
      document.body.classList.remove('altspace-held');
      audioTracksRef.current.forEach(at => { if (at.audioBuffer) { scrubHold(at.audioBuffer, false); scrubStop(at.audioBuffer); } });
    };
    const down = (e) => {
      if (e.code !== 'Space' || !e.altKey || isTyping(e)) return;
      e.preventDefault();
      if (e.repeat || altSpaceRef.current || auditionRef.current.playing) return;
      altSpaceRef.current = true;
      document.body.classList.add('altspace-held');
      const beat = selectedBeatLive.current;
      auditionRef.current.onAuditionNotes?.(beat);
      audioTracksRef.current.forEach(at => {
        if (!at.audioBuffer) return;
        prepareScrub(at.audioBuffer);
        const m = mapForRef.current(at);
        const clip = at.muted ? null : (at.clips || []).find(c => beat >= c.start && beat <= clipTimeToBeat(c, c.srcEnd, m));
        scrubTarget(at.audioBuffer, clip ? clipBeatToTime(clip, beat, m) : null, at.volume ?? 1);
        scrubHold(at.audioBuffer, true);
      });
    };
    const up = (e) => { if (e.code === 'Space' || e.key === 'Alt') stop(); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', stop);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', stop);
      stop();
    };
  }, []);

  const startContentDrag = (e) => {
    const body = bodyRef.current;
    if (!body) return;
    const startClientX = e.clientX;
    // The playhead keeps its place on screen for the whole drag. If it is scrolled out of view, bring
    // it to the middle first (its beat does not change).
    const headX = beatToX(selectedBeatLive.current, barSubdivisions, cellWidth);
    if (headX < body.scrollLeft + 8 || headX > body.scrollLeft + body.clientWidth - 8) {
      body.scrollLeft = Math.max(0, headX - body.clientWidth / 2);
    }
    const startScroll = body.scrollLeft;
    const playX = Math.max(0, Math.min(body.clientWidth - 1, headX - startScroll));
    const go = (clientX) => {
      const maxScroll = Math.max(0, body.scrollWidth - body.clientWidth);
      body.scrollLeft = Math.max(0, Math.min(maxScroll, startScroll - (clientX - startClientX)));
      const beat = Math.max(0, Math.min(totalCols - 1, xToBeat(playX + body.scrollLeft, barSubdivisions, cellWidth, false)));
      // pin the playhead line to its place on screen right now (state updates lag a frame behind the scroll)
      const line = body.querySelector('.playhead');
      if (line) line.style.left = `${playX + body.scrollLeft}px`;
      setSelectedBeat(beat);
      scrubTo(beat);
      scrubHoldAll(true);
    };
    const onMove = (me) => go(me.clientX);
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // keep sounding if the keys are still down, otherwise stop
      if (!altSpaceRef.current) scrubEnd();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const scrubPrepare = () => audioTracks.forEach(at => { if (at.audioBuffer) prepareScrub(at.audioBuffer); });
  // Warm the scrub voices shortly after audio appears so the first drag already has sound.
  const audioBufferKey = audioTracks.map(a => (a.audioBuffer ? a.trackId : '')).join(',');
  useEffect(() => {
    if (!audioBufferKey.replace(/,/g, '')) return;
    const t = setTimeout(() => scrubPrepare(), 800);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioBufferKey]);

  // Drag the playhead from a pointer: moves it freely (no grid snap when there is audio) and scrubs.
  const startScrubDrag = (e, rectEl) => {
    const rectOf = () => (rectEl || headerRef.current).getBoundingClientRect();
    const hasAudio = audioTracks.some(a => a.audioBuffer);
    const beatAt = (clientX) => {
      const px = clientX - rectOf().left + (bodyRef.current ? bodyRef.current.scrollLeft : 0);
      const raw = xToBeat(px, barSubdivisions, cellWidth, false);
      const b = hasAudio || freeMode ? raw : Math.round(raw / snapUnit) * snapUnit;
      return Math.max(0, Math.min(totalCols - 1, b));
    };
    if (hasAudio) scrubPrepare();
    const go = (clientX) => {
      const b = beatAt(clientX);
      setSelectedBeat(b);
      if (hasAudio && !playing) scrubTo(b);
    };
    go(e.clientX);
    // Past the edge of the timeline (or the window) the view keeps scrolling and the playhead
    // follows, even when the pointer is held still.
    scrubPan.start(e.clientX, e.clientY, (cx) => go(cx));
    const onMove = (me) => { scrubPan.update(me.clientX, me.clientY); go(me.clientX); };
    const onUp = () => {
      scrubPan.stop();
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      scrubEnd();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const startScrubDragRef = useRef(null);
  startScrubDragRef.current = startScrubDrag;

  // Loop region drag on header
  const handleHeaderMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    const rect = headerRef.current.getBoundingClientRect();
    const scrollLeft = bodyRef.current ? bodyRef.current.scrollLeft : 0;
    const x = e.clientX - rect.left + scrollLeft;
    const snap = snapUnit;
    const free = freeMode;

    // Snap a raw beat to the tuplet grid (or no snap in free mode)
    const snapBeat = (raw) => {
      if (free) return raw;
      return Math.round(raw / snap) * snap;
    };

    const edgeThreshold = Math.max(8, cellWidth * 0.5);
    const loopLeftX = beatToX(loopStart, barSubdivisions, cellWidth);
    const loopRightX = beatToX(loopEnd, barSubdivisions, cellWidth);

    if (loop) {
      const isNearLeft = Math.abs(x - loopLeftX) < edgeThreshold;
      const isNearRight = Math.abs(x - loopRightX) < edgeThreshold;
      const isInside = x > loopLeftX + edgeThreshold && x < loopRightX - edgeThreshold;

      if (isNearLeft) {
        loopDragRef.current = { mode: 'left', fixedEnd: loopEnd };
      } else if (isNearRight) {
        loopDragRef.current = { mode: 'right', fixedStart: loopStart };
      } else if (isInside) {
        loopDragRef.current = { mode: 'move', startX: x, origStart: loopStart, origEnd: loopEnd, loopLen: loopEnd - loopStart, didMove: false };
      } else {
        const startCol = snapBeat(xToBeat(x, barSubdivisions, cellWidth, false));
        if (startCol < 0 || startCol >= totalCols) return;
        // A plain click only places the playhead; the region is redrawn once dragging starts.
        loopDragRef.current = { mode: 'new', startCol, didMove: false };
      }
    } else {
      // Loop is off: the header places / scrubs the playhead (with sound when there is audio).
      e.preventDefault();
      startScrubDragRef.current(e);
      return;
    }

    e.preventDefault();

    const handleMouseMove = (moveE) => {
      if (!loopDragRef.current) return;
      if (!loopDragRef.current.didMove && Math.abs(moveE.clientX - e.clientX) < 3) return; // still a click
      const mx = moveE.clientX - rect.left + (bodyRef.current ? bodyRef.current.scrollLeft : scrollLeft);
      const rawCol = xToBeat(mx, barSubdivisions, cellWidth, false);
      const col = Math.max(0, Math.min(totalCols, snapBeat(rawCol)));
      const d = loopDragRef.current;
      d.didMove = true;

      if (d.mode === 'left') {
        const newStart = Math.min(col, d.fixedEnd - snap);
        setLoopStart(newStart);
        setSelectedBeat(newStart);
        setLoop(true);
      } else if (d.mode === 'right') {
        setLoopEnd(Math.max(col, d.fixedStart + snap));
        setLoop(true);
      } else if (d.mode === 'move') {
        const rawStart = xToBeat(beatToX(d.origStart, barSubdivisions, cellWidth) + (mx - d.startX), barSubdivisions, cellWidth, false);
        const snappedStart = snapBeat(rawStart);
        const deltaCols = snappedStart - d.origStart;
        let newStart = d.origStart + deltaCols;
        let newEnd = d.origEnd + deltaCols;
        if (newStart < 0) { newStart = 0; newEnd = d.loopLen; }
        if (newEnd > totalCols) { newEnd = totalCols; newStart = totalCols - d.loopLen; }
        setLoopStart(newStart);
        setLoopEnd(newEnd);
      } else {
        const anchor = d.startCol;
        if (col >= anchor) {
          setLoopStart(anchor);
          setLoopEnd(Math.max(col, anchor + snap));
          d.lastCol = col;
        } else {
          setLoopStart(col);
          setLoopEnd(anchor + snap);
          d.lastCol = col;
        }
        setLoop(true);
      }
    };

    const handleMouseUp = (upE) => {
      const d = loopDragRef.current;
      if (d) {
        if (!d.didMove) {
          // A plain click anywhere on the header (inside the loop, on its edges or outside) only places the playhead.
          const ux = upE.clientX - rect.left + (bodyRef.current ? bodyRef.current.scrollLeft : scrollLeft);
          const rawBeat = xToBeat(ux, barSubdivisions, cellWidth, false);
          const beat = free ? rawBeat : snapBeat(rawBeat);
          setSelectedBeat(Math.max(0, Math.min(totalCols - 1, beat)));
        } else if (d.mode === 'new' && d.didMove) {
          setSelectedBeat(Math.min(d.startCol, d.lastCol));
        }
      }
      loopDragRef.current = null;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [setLoopStart, setLoopEnd, setLoop, setSelectedBeat, loop, loopStart, loopEnd, cellWidth, totalCols, barSubdivisions, freeMode, snapUnit]);

  // ---- Audio clip interaction (active audio track) ----
  const activeAudio = audioTracks.find(a => a.isActive) || null;
  const clipSecPerBeat = (at) => 1 / timeToBeat(1, at.originalBpm || bpm, timeSignature[1]);
  // Beat <-> audio-time map for a track: the project tempo map when a recording drives the grid,
  // otherwise the track's own constant import tempo.
  const mapFor = (at) => (tempoMap && tempoMap.active ? tempoMap : linearMap(clipSecPerBeat(at)));
  mapForRef.current = mapFor;
  const clipPointerBeat = (clientX) => {
    const r = bodyRef.current.getBoundingClientRect();
    return xToBeat(clientX - r.left + bodyRef.current.scrollLeft, barSubdivisions, cellWidth, false);
  };
  const clipSnap = (b) => (freeMode ? b : Math.round(b / snapUnit) * snapUnit);

  const handleClipMouseDown = (e, at, clip) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    if (e.shiftKey) {
      setSelectedClips(prev => {
        const next = new Set(prev);
        if (next.has(clip.id)) next.delete(clip.id); else next.add(clip.id);
        return next;
      });
      return;
    }
    const wasSelected = selectedClips.has(clip.id);
    let ids = wasSelected ? new Set(selectedClips) : new Set([clip.id]);
    if (!wasSelected) setSelectedClips(ids);
    const startBeat = clipPointerBeat(e.clientX);
    let orig = new Map(at.clips.filter(c => ids.has(c.id)).map(c => [c.id, c.start]));
    const minStart = () => Math.min(...orig.values());
    let moved = false;
    let targets = ids; // ids being moved (copies after an Alt-drag duplicate)

    const onMove = (me) => {
      if (!moved && Math.abs(me.clientX - e.clientX) < 3) return;
      if (!moved) {
        moved = true;
        saveSnapshot();
        if (me.altKey) {
          // Alt-drag duplicates: originals stay, copies are dragged
          const copies = at.clips.filter(c => ids.has(c.id)).map(c => ({ ...c, id: crypto.randomUUID() }));
          const map = new Map();
          at.clips.filter(c => ids.has(c.id)).forEach((c, i) => map.set(copies[i].id, c.start));
          onUpdateClips(at.trackId, clips => [...clips, ...copies], false);
          targets = new Set(copies.map(c => c.id));
          orig = map;
          setSelectedClips(targets);
        }
      }
      const raw = clipPointerBeat(me.clientX) - startBeat;
      const anchor = orig.get([...targets][0]) ?? clip.start;
      let delta = clipSnap(anchor + raw) - anchor;
      delta = Math.max(delta, -minStart());
      onUpdateClips(at.trackId, clips => clips.map(c => (targets.has(c.id) ? { ...c, start: orig.get(c.id) + delta } : c)), false);
    };
    const onUp = () => {
      if (!moved && wasSelected && ids.size > 1) setSelectedClips(new Set([clip.id]));
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Find the recording's attacks ahead of time so the waveform handle can snap to them without a stall.
  const syncBuffer = tempoMap && tempoMap.active ? (audioTracks.find(a => a.trackId === tempoMap.refId)?.audioBuffer || null) : null;
  useEffect(() => {
    if (!syncBuffer) return;
    const t = setTimeout(() => { try { onsetTimes(syncBuffer); } catch { /* ignore */ } }, 400);
    return () => clearTimeout(t);
  }, [syncBuffer]);

  // ---- Sync points: pin the sound at a spot in the audio to a grid position ----
  const newPinId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
  const handleClipDoubleClick = (e, at, clip) => {
    e.stopPropagation();
    if (tempoMap && tempoMap.active && tempoMap.refId !== at.trackId) return; // another track owns the tempo map
    const m = mapFor(at);
    const beat = clipPointerBeat(e.clientX); // free position: pin exactly where the sound is
    onAddSyncPointAt && onAddSyncPointAt(at.trackId, clip, beat);
  };

  const handlePinMouseDown = (e, at, clip, pin) => {
    e.stopPropagation();
    e.preventDefault();
    if (e.button === 2) { onUpdateSyncPoints(at.trackId, pts => pts.filter(p => p.id !== pin.id)); return; }
    if (e.button !== 0 || !tempoMap || !tempoMap.active) return;
    const tm = tempoMap;
    // Top handle: which grid beat the pin sits on. The sound it is attached to stays put.
    const { prev, next } = pinNeighbours(at, pin);
    const spb0 = tm.spb0;
    let lo = prev.beat + Math.max(0.005, (pin.time - prev.time) / (MAX_RATE * spb0));
    let hi = Infinity;
    if (next) {
      lo = Math.max(lo, next.beat - (next.time - pin.time) / (MIN_RATE * spb0));
      hi = next.beat - Math.max(0.005, (next.time - pin.time) / (MAX_RATE * spb0));
    } else {
      hi = prev.beat + (pin.time - prev.time) / (MIN_RATE * spb0);
    }
    if (hi < lo) hi = lo;
    let saved = false;
    const onMove = (me) => {
      if (!saved) { saveSnapshot(); saved = true; }
      // Free movement; a light magnet pulls onto a grid line when you come within a few pixels (Alt = no magnet)
      let tb = clipPointerBeat(me.clientX);
      const line = Math.round(tb); // whole-beat / bar lines
      if (!me.altKey && Math.abs(line - tb) * cellWidth <= 6) tb = line;
      const fileBeat = Math.min(hi, Math.max(lo, tm.beatToFileBeat(tb)));
      onUpdateSyncPoints(at.trackId, pts => pts.map(p => (p.id === pin.id ? { ...p, beat: fileBeat } : p)), false);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Neighbours of a pin (the implicit file-start anchor counts as one) and the slowest / fastest
  // the audio may play between two pins, so a drag can't flatten or invert the grid.
  const MIN_RATE = 0.25, MAX_RATE = 4;
  const pinNeighbours = (at, pin) => {
    const sorted = [...(at.syncPoints || [])].sort((a, b) => a.time - b.time);
    const idx = sorted.findIndex(p => p.id === pin.id);
    return {
      prev: idx > 0 ? sorted[idx - 1] : { time: 0, beat: 0 },
      next: idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : null,
    };
  };

  // Bottom handle: which point of the waveform the pin is attached to. The grid beat stays put and
  // the waveform slides under the pin (drag right = the waveform moves right with the pointer).
  const handlePinWaveMouseDown = (e, at, clip, pin) => {
    e.stopPropagation();
    e.preventDefault();
    if (e.button !== 0 || !tempoMap || !tempoMap.active) return;
    const tm = tempoMap; // frozen for the whole drag
    const { prev, next } = pinNeighbours(at, pin);
    const spb0 = tm.spb0;
    const B = pin.beat;
    let lo = prev.time + Math.max(0.005, MIN_RATE * spb0 * (B - prev.beat));
    let hi = prev.time + MAX_RATE * spb0 * (B - prev.beat);
    if (next) {
      lo = Math.max(lo, next.time - MAX_RATE * spb0 * (next.beat - B));
      hi = Math.min(hi, next.time - Math.max(0.005, MIN_RATE * spb0 * (next.beat - B)));
    } else {
      hi = Math.min(hi, at.audioDuration || Infinity);
    }
    lo = Math.max(lo, 0);
    if (hi < lo) return;
    const onsets = at.audioBuffer ? onsetTimes(at.audioBuffer) : [];
    const startBeat = clipPointerBeat(e.clientX);
    let saved = false;
    const onMove = (me) => {
      if (!saved) { saveSnapshot(); saved = true; }
      const delta = clipPointerBeat(me.clientX) - startBeat;
      let t = tm.timeOfFileBeat(B - delta);
      // light magnet onto the nearest attack within a few pixels (Alt = none)
      if (!me.altKey && onsets.length) {
        let best = null, bestPx = 7;
        for (const o of onsets) {
          if (o < lo || o > hi) continue;
          const px = Math.abs(tm.fileBeatOfTime(o) - tm.fileBeatOfTime(t)) * cellWidth;
          if (px < bestPx) { bestPx = px; best = o; }
        }
        if (best != null) t = best;
      }
      t = Math.min(hi, Math.max(lo, t));
      onUpdateSyncPoints(at.trackId, pts => pts.map(p => (p.id === pin.id ? { ...p, time: t } : p)), false);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleClipTrimStart = (e, at, clip, side) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    if (!selectedClips.has(clip.id)) setSelectedClips(new Set([clip.id]));
    const spb = clipSecPerBeat(at);
    const m = mapFor(at);
    const minBeats = 0.02 / spb;
    const o = { start: clip.start, srcStart: clip.srcStart, srcEnd: clip.srcEnd };
    const oEnd = clipTimeToBeat(o, o.srcEnd, m);
    let saved = false;
    const onMove = (me) => {
      if (!saved) { saveSnapshot(); saved = true; }
      const beat = clipSnap(clipPointerBeat(me.clientX));
      if (side === 'left') {
        const lo = Math.max(0, clipTimeToBeat(o, 0, m)); // cannot reveal audio before the file start
        const nb = Math.min(Math.max(beat, lo), oEnd - minBeats);
        onUpdateClips(at.trackId, clips => clips.map(c => (c.id === clip.id
          ? { ...c, start: nb, srcStart: Math.max(0, clipBeatToTime(o, nb, m)) } : c)), false);
      } else {
        const hi = clipTimeToBeat(o, at.audioDuration, m); // cannot run past the file end
        const nb = Math.max(Math.min(beat, hi), o.start + minBeats);
        onUpdateClips(at.trackId, clips => clips.map(c => (c.id === clip.id
          ? { ...c, srcEnd: Math.min(at.audioDuration, clipBeatToTime(o, nb, m)) } : c)), false);
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Machine gun: convert mouse Y to string+fret
  // Marquee selection / machine gun on grid background
  const handleGridMouseDown = useCallback((e) => {
    // Active audio track: the grid is a clip lane. Empty space deselects clips and places the playhead.
    if (activeAudio) {
      if (e.button === 0 && !e.target.closest('.audio-clip')) {
        setSelectedClips(new Set());
        const r = bodyRef.current.getBoundingClientRect();
        const bx = e.clientX - r.left + bodyRef.current.scrollLeft;
        const raw = xToBeat(bx, barSubdivisions, cellWidth, false);
        const beat = freeMode ? raw : Math.round(raw / snapUnit) * snapUnit;
        setSelectedBeat(Math.max(0, Math.min(totalCols - 1, beat)));
        marqueeDidDragRef.current = true;
        // Keep dragging to scrub: the recording plays under the pointer.
        e.preventDefault();
        startScrubDragRef.current(e, bodyRef.current);
      }
      return;
    }
    // Shift + right-click drag: marquee-select erase (falls through to marquee logic below)
    // Plain right-click drag: brush-erase notes under the cursor
    if (e.button === 2 && !playing && !e.shiftKey) {
      e.preventDefault();
      rightDragEraseRef.current = true;
      saveSnapshot();
      const prevCursor = document.body.style.cursor;
      document.body.style.cursor = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'><rect x='3' y='11' width='14' height='8' rx='1.5' transform='rotate(-35 10 15)' fill='%23ff9999' stroke='black' stroke-width='1.5'/><rect x='3' y='11' width='5' height='8' rx='1.5' transform='rotate(-35 10 15)' fill='%23ffffff' stroke='black' stroke-width='1.5'/></svg>") 4 20, crosshair`;
      const eraseAt = (clientX, clientY) => {
        const el = document.elementFromPoint(clientX, clientY);
        const noteEl = el && el.closest && el.closest('.timeline-note');
        if (!noteEl) return;
        const idxAttr = noteEl.getAttribute('data-note-index');
        if (idxAttr == null) return;
        const idx = parseInt(idxAttr, 10);
        if (Number.isNaN(idx)) return;
        setNotes(prev => prev.filter((_, i) => i !== idx));
        setSelectedNotes(new Set());
      };
      eraseAt(e.clientX, e.clientY);
      marqueeDidDragRef.current = true;
      const handleMove = (moveE) => eraseAt(moveE.clientX, moveE.clientY);
      const handleUp = () => {
        document.body.style.cursor = prevCursor;
        window.removeEventListener('mousemove', handleMove);
        window.removeEventListener('mouseup', handleUp);
      };
      window.addEventListener('mousemove', handleMove);
      window.addEventListener('mouseup', handleUp);
      return;
    }
    // Shift+right-click: marquee-erase (continue into marquee code below with erase flag)
    const isMarqueeErase = e.button === 2 && e.shiftKey && !playing;
    if (isMarqueeErase) {
      e.preventDefault();
      rightDragEraseRef.current = true;
      marqueeDidDragRef.current = true;
    } else {
      if (e.target.closest('.timeline-note')) return;
      if (e.button !== 0) return;
    }

    const rect = bodyRef.current.getBoundingClientRect();
    const scrollLeft = bodyRef.current.scrollLeft;
    const scrollTop = bodyRef.current.scrollTop;
    const x = e.clientX - rect.left + scrollLeft;
    const y = e.clientY - rect.top + scrollTop;

    // Machine gun mode: paint notes by dragging
    if (machineGunMode) {
      const dur = noteDuration;
      const startBeat = Math.floor(xToBeat(x, barSubdivisions, cellWidth, true) / dur) * dur;
      const combo = yToPitch(y);
      if (!combo) return;

      saveSnapshot();
      const painted = new Map(); // beat -> { stringIndex, fret }
      painted.set(startBeat, combo);
      setNotes(prev => {
        // Remove any existing note at this beat+string, then add
        const filtered = prev.filter(n => !(Math.abs(n.beat - startBeat) < 0.001 && n.stringIndex === combo.stringIndex));
        return [...filtered, { stringIndex: combo.stringIndex, fret: combo.fret, beat: startBeat, duration: dur, velocity: defaultVelocity }];
      });
      playNote(combo.stringIndex, combo.fret, 0.15);

      const handleMouseMove = (moveE) => {
        const mx = moveE.clientX - rect.left + bodyRef.current.scrollLeft;
        const my = moveE.clientY - rect.top + bodyRef.current.scrollTop;
        const moveBeat = Math.floor(xToBeat(mx, barSubdivisions, cellWidth, true) / dur) * dur;
        const moveCombo = yToPitch(my);
        if (!moveCombo) return;
        if (moveBeat < 0 || moveBeat >= totalCols) return;

        // Fill all beats from start to current position
        const minBeat = Math.min(startBeat, moveBeat);
        const maxBeat = Math.max(startBeat, moveBeat);
        const newNotes = [];
        for (let b = minBeat; b <= maxBeat + 0.001; b += dur) {
          const beat = Math.round(b * 10000) / 10000; // avoid float drift
          if (beat >= totalCols) break;
          if (!painted.has(beat)) {
            // Interpolate pitch between start and current mouse Y
            const t = maxBeat > minBeat ? (beat - minBeat) / (maxBeat - minBeat) : 0;
            const interpY = y + (my - y) * ((beat - startBeat) / (moveBeat - startBeat || 1));
            const beatCombo = yToPitch(interpY);
            if (beatCombo) {
              painted.set(beat, beatCombo);
              newNotes.push({ stringIndex: beatCombo.stringIndex, fret: beatCombo.fret, beat, duration: dur, velocity: defaultVelocity });
              playNote(beatCombo.stringIndex, beatCombo.fret, 0.1);
            }
          }
        }
        if (newNotes.length > 0) {
          setNotes(prev => {
            // Remove existing at these beats+strings
            const beatSet = new Set(newNotes.map(n => `${n.beat.toFixed(4)}_${n.stringIndex}`));
            const filtered = prev.filter(n => !beatSet.has(`${n.beat.toFixed(4)}_${n.stringIndex}`));
            return [...filtered, ...newNotes];
          });
        }
      };

      const handleMouseUp = () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      marqueeDidDragRef.current = true;
      return;
    }

    // Click-and-drag to place a note and resize its duration
    if (!cursorModeRef.current && !e.shiftKey && e.button === 0) {
      let beat;
      if (freeMode) {
        beat = xToBeat(x, barSubdivisions, cellWidth, false);
      } else {
        const rawBeat = xToBeat(x, barSubdivisions, cellWidth, false);
        beat = Math.round(rawBeat / snapUnit) * snapUnit;
      }
      if (beat >= 0 && beat < totalCols) {
        // Pick a string that isn't already occupied at this beat so chords can be placed
        const finalBeatForCombo = Math.round(beat * 10000) / 10000;
        const rowFromTop = Math.floor(y / rowHeight);
        const pitchRow = Math.max(0, Math.min(totalRows - 1, totalRows - 1 - rowFromTop));
        const midiTarget = pitchRowToMidi(pitchRow);
        const allCombos = pitchRowCombos(pitchRow);
        const occupied = new Set(
          notes.filter((n, i) => Math.abs(n.beat - finalBeatForCombo) < 0.001
            // a selected note sounding here also holds its string, so the new note goes elsewhere
            || (selectedNotes.has(i) && n.beat < finalBeatForCombo && n.beat + (n.duration || 1) > finalBeatForCombo))
            .map(n => n.stringIndex)
        );

        const posEnd = Math.min(position + 4, NUM_FRETS);
        const inPosition = allCombos.filter(c => c.fret >= position && c.fret <= posEnd);
        const freeInPosition = inPosition.find(c => !occupied.has(c.stringIndex));
        const combo = freeInPosition || getComboForPosition(midiTarget, position);

        if (combo) {
          const finalBeat = finalBeatForCombo;
          // Check if toggling off an existing note
          let toggled = false;
          setNotes(prev => {
            const exact = prev.findIndex(n =>
              n.stringIndex === combo.stringIndex && n.fret === combo.fret &&
              Math.abs(n.beat - finalBeat) < 0.001
            );
            if (exact >= 0) { toggled = true; return prev.filter((_, i) => i !== exact); }
            // Truncate any earlier note on the same string that would overlap the new note
            // (selected notes are never trimmed by placing a new note)
            const truncated = prev.map((n, i) => {
              if (n.stringIndex !== combo.stringIndex || selectedNotes.has(i)) return n;
              const nEnd = n.beat + (n.duration || 1);
              if (n.beat < finalBeat && nEnd > finalBeat) {
                return { ...n, duration: Math.max(0.01, finalBeat - n.beat) };
              }
              return n;
            });
            // Cap the new note's duration at the next note on the same string
            const nextOnString = truncated
              .filter(n => n.stringIndex === combo.stringIndex && n.beat > finalBeat)
              .reduce((min, n) => n.beat < min ? n.beat : min, Infinity);
            const maxDur = Math.max(0.01, nextOnString - finalBeat);
            const newNote = {
              stringIndex: combo.stringIndex,
              fret: combo.fret,
              beat: finalBeat,
              duration: Math.min(noteDuration, maxDur),
              velocity: defaultVelocity,
            };
            if (activeInstanceScheme) {
              newNote.instanceSchemeName = activeInstanceScheme;
            }
            return [...truncated, newNote];
          });
          setSelectedBeat(beat);
          setSelectedNotes(new Set());
          playNote(combo.stringIndex, combo.fret, 0.2);
          marqueeDidDragRef.current = true; // prevent handleClick from also firing
          if (combo.position != null && combo.position !== position && setPosition) {
            setPosition(combo.position);
          }

          if (!toggled) {
            // Start drag-to-resize the newly placed note.
            // No extra snapshot here — the setNotes call above already pushed one,
            // so a single ctrl+z rolls back placement AND the drag-resize in one step.
            const isFree = freeMode;
            const snap = snapUnit;
            const startX = e.clientX;
            let didDrag = false;

            let lastDuration = noteDuration;
            const handleMouseMove = (moveE) => {
              const dx = moveE.clientX - startX;
              if (!didDrag && Math.abs(dx) < 5) return;
              didDrag = true;
              const noteBarIdx = beatToBar(finalBeat, barSubdivisions).barIndex;
              const cw = colWidth(noteBarIdx, barSubdivisions, cellWidth);
              const dBeats = dx / cw;
              const rawDuration = noteDuration + dBeats;
              const newDuration = isFree ? Math.max(0.1, rawDuration) : Math.max(snap, Math.round(rawDuration / snap) * snap);
              const maxDuration = totalCols - finalBeat;
              lastDuration = Math.min(newDuration, maxDuration);
              // setNotesDrag: update without pushing more undo snapshots during the drag
              setNotesDrag(prev => prev.map(n =>
                (n.stringIndex === combo.stringIndex && n.fret === combo.fret && Math.abs(n.beat - finalBeat) < 0.001)
                  ? { ...n, duration: lastDuration }
                  : n
              ));
            };

            const handleMouseUp = () => {
              if (didDrag && setNoteDuration) setNoteDuration(lastDuration);
              window.removeEventListener('mousemove', handleMouseMove);
              window.removeEventListener('mouseup', handleMouseUp);
            };

            window.addEventListener('mousemove', handleMouseMove);
            window.addEventListener('mouseup', handleMouseUp);
          }
          return;
        }
      }
    }

    // Normal marquee selection (or marquee-erase under Shift+RightClick).
    // Capture the selection at drag start so shift-drag can add-and-remove as the marquee grows/shrinks.
    const initialSelection = e.shiftKey && !isMarqueeErase
      ? new Set(selectedNotes)
      : new Set();
    marqueeRef.current = { startX: x, startY: y, didMove: false, erase: isMarqueeErase, initialSelection };
    const prevCursor = document.body.style.cursor;
    if (isMarqueeErase) document.body.style.cursor = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'><rect x='3' y='11' width='14' height='8' rx='1.5' transform='rotate(-35 10 15)' fill='%23ff9999' stroke='black' stroke-width='1.5'/><rect x='3' y='11' width='5' height='8' rx='1.5' transform='rotate(-35 10 15)' fill='%23ffffff' stroke='black' stroke-width='1.5'/></svg>") 4 20, crosshair`;
    if (!e.shiftKey || isMarqueeErase) {
      setSelectedNotes(new Set());
    }

    const runMarqueeMove = (clientX, clientY, shiftKey) => {
      if (!marqueeRef.current || !bodyRef.current) return;
      const rect2 = bodyRef.current.getBoundingClientRect();
      const mx = clientX - rect2.left + bodyRef.current.scrollLeft;
      const my = clientY - rect2.top + bodyRef.current.scrollTop;
      const dx = mx - marqueeRef.current.startX;
      const dy = my - marqueeRef.current.startY;
      if (!marqueeRef.current.didMove && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      marqueeRef.current.didMove = true;
      marqueeDidDragRef.current = true;

      const x1 = Math.min(marqueeRef.current.startX, mx);
      const y1 = Math.min(marqueeRef.current.startY, my);
      const x2 = Math.max(marqueeRef.current.startX, mx);
      const y2 = Math.max(marqueeRef.current.startY, my);
      setMarquee({ x1, y1, x2, y2 });

      // Select notes that overlap the marquee
      const selected = new Set();
      notes.forEach((note, i) => {
        const noteLeft = beatToX(note.beat, barSubdivisions, cellWidth);
        const noteRight = noteLeft + durationToWidth(note.beat, note.duration || 1, barSubdivisions, cellWidth);
        const noteTop = rowTopPx(note.stringIndex, note.fret);
        const noteBottom = noteTop + rowHeight;

        if (noteRight > x1 && noteLeft < x2 && noteBottom > y1 && noteTop < y2) {
          selected.add(i);
        }
      });
      // Shift-drag: final selection is (initialSelection ∪ currentlyInMarquee)
      // so shrinking the marquee deselects notes that are no longer inside it.
      if (shiftKey && !isMarqueeErase) {
        const merged = new Set(marqueeRef.current.initialSelection);
        selected.forEach(i => merged.add(i));
        setSelectedNotes(merged);
      } else {
        setSelectedNotes(selected);
      }
    };

    let lastShiftKey = e.shiftKey;
    const handleMouseMove = (moveE) => {
      lastShiftKey = moveE.shiftKey;
      autoPan.update(moveE.clientX, moveE.clientY);
      runMarqueeMove(moveE.clientX, moveE.clientY, moveE.shiftKey);
    };
    autoPan.start(e.clientX, e.clientY, (cx, cy) => runMarqueeMove(cx, cy, lastShiftKey));

    const handleMouseUp = () => {
      autoPan.stop();
      const wasErase = marqueeRef.current && marqueeRef.current.erase;
      if (wasErase && marqueeRef.current && marqueeRef.current.didMove) {
        setSelectedNotes(prev => {
          if (prev.size > 0) {
            setNotes(old => old.filter((_, i) => !prev.has(i)));
          }
          return new Set();
        });
      }
      if (isMarqueeErase) document.body.style.cursor = prevCursor;
      marqueeRef.current = null;
      setMarquee(null);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [playing, notes, selectedNotes, setSelectedNotes, setNotes, machineGunMode, noteDuration, saveSnapshot, yToPitch, freeMode, snapUnit, cellWidth, barSubdivisions, totalCols, defaultVelocity, setSelectedBeat, rowHeight, position, setPosition, activeInstanceScheme, activeAudio, setSelectedClips]);

  // Sync vertical scroll from external source (fretboard)
  useEffect(() => {
    if (bodyRef.current && Math.abs(bodyRef.current.scrollTop - verticalScroll) > 1) {
      bodyRef.current.scrollTop = verticalScroll;
    }
  }, [verticalScroll]);

  // Auto-scroll vertically to show hovered note
  useEffect(() => {
    if (!(autoScroll?.onInput ?? true)) return;
    if (!hoveredNote || !bodyRef.current) return;
    const noteTop = rowTopPx(hoveredNote.stringIndex, hoveredNote.fret);
    const noteBottom = noteTop + rowHeight;
    const container = bodyRef.current;
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;

    if (noteTop < viewTop) {
      const target = noteTop - 20;
      container.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    } else if (noteBottom > viewBottom) {
      const target = noteBottom - container.clientHeight + 20;
      container.scrollTo({ top: target, behavior: 'smooth' });
    }
  }, [hoveredNote, autoScroll]);

  // Scroll zoom — anchor at the mouse cursor.
  // We defer the scrollLeft adjustment to a useLayoutEffect so the DOM has already
  // been expanded to the new content width by the time we set scrollLeft.
  const hotkeysRef = useRef(hotkeys);
  hotkeysRef.current = hotkeys;
  const zoomRef = useRef(timelineZoom);
  const barSubsRef = useRef(barSubdivisions);
  const pendingZoomAnchorRef = useRef(null); // { beat, mouseX }
  const lastMouseOverRef = useRef(null); // { mouseX, timestamp } for keyboard zoom fallback
  barSubsRef.current = barSubdivisions;

  // Keyboard zoom (Ctrl+/-) — App dispatches a custom event; we anchor on the playhead
  // centered in the viewport, like Ableton Live does.
  useEffect(() => {
    const onZoomEvent = (ev) => {
      const dir = ev.detail?.dir > 0 ? 1 : -1;
      if (!bodyRef.current) return;
      const anchorBeat = (playing && currentBeat != null) ? currentBeat : (selectedBeat ?? 0);
      const viewportWidth = bodyRef.current.clientWidth;
      // Record the anchor: after commit, place this beat at viewport center.
      pendingZoomAnchorRef.current = { beat: anchorBeat, mouseX: viewportWidth / 2 };
      setTimelineZoom(z => {
        const factor = dir > 0 ? 1.25 : 1 / 1.25;
        return Math.max(0.02, Math.min(40, z * factor));
      });
    };
    window.addEventListener('timeline-zoom', onZoomEvent);
    return () => window.removeEventListener('timeline-zoom', onZoomEvent);
  }, [playing, currentBeat, selectedBeat, setTimelineZoom]);

  // Track last mouse position AND the beat under it continuously, so keyboard zoom
  // (Ctrl+/-) can anchor at the cursor even though App.jsx fires the state update.
  useEffect(() => {
    const onMove = (e) => {
      const el = bodyRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (e.clientX >= rect.left && e.clientX <= rect.right &&
          e.clientY >= rect.top && e.clientY <= rect.bottom) {
        const mouseX = e.clientX - rect.left;
        const cw = CELL_WIDTH * zoomRef.current;
        const beat = xToBeat(el.scrollLeft + mouseX, barSubsRef.current, cw, false);
        lastMouseOverRef.current = { mouseX, beat, timestamp: performance.now() };
      }
    };
    document.addEventListener('mousemove', onMove);
    return () => document.removeEventListener('mousemove', onMove);
  }, []);
  useEffect(() => {
    const handleWheel = (e) => {
      const hk = hotkeysRef.current;
      if (!hk || !bodyRef.current) return;
      const rect = bodyRef.current.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right ||
          e.clientY < rect.top || e.clientY > rect.bottom) return;
      // Ctrl+Shift+wheel → vertical zoom. Checked before Ctrl+wheel because the
      // vertical combo is a strict superset of the horizontal one.
      if (matchesWheelHotkey(e, hk.verticalZoomWheel)) {
        e.preventDefault();
        queueVerticalZoomAnchor();
        applyVerticalZoom(v => v * (1 - e.deltaY * 0.005));
        return;
      }
      if (!matchesWheelHotkey(e, hk.zoomWheel)) return;
      e.preventDefault();
      // Anchor wheel/trackpad zoom at the playhead centered in the viewport (Ableton-style).
      const anchorBeat = (playing && currentBeat != null) ? currentBeat : (selectedBeat ?? 0);
      pendingZoomAnchorRef.current = { beat: anchorBeat, mouseX: bodyRef.current.clientWidth / 2 };
      setTimelineZoom(z => Math.max(0.02, Math.min(40, z * (1 - e.deltaY * 0.005))));
    };
    document.addEventListener('wheel', handleWheel, { passive: false });
    return () => document.removeEventListener('wheel', handleWheel);
  }, [setTimelineZoom, playing, currentBeat, selectedBeat]);

  // Vertical zoom: custom event (keyboard) + shared helpers used by wheel handler.
  const pendingVZoomAnchorRef = useRef(null);
  const queueVerticalZoomAnchor = () => {
    const el = bodyRef.current;
    if (!el) return;
    const centerContentY = el.scrollTop + el.clientHeight / 2;
    const centerRow = centerContentY / (BASE_ROW_HEIGHT * timelineVerticalZoom);
    pendingVZoomAnchorRef.current = { row: centerRow };
  };
  const applyVerticalZoom = (fn) => {
    if (!setTimelineVerticalZoom) return;
    setTimelineVerticalZoom(v => {
      const raw = typeof fn === 'function' ? fn(v) : fn;
      return Math.max(VERTICAL_ZOOM_MIN, Math.min(VERTICAL_ZOOM_MAX, raw));
    });
  };
  useEffect(() => {
    const onVZoom = (ev) => {
      const dir = ev.detail?.dir > 0 ? 1 : -1;
      queueVerticalZoomAnchor();
      applyVerticalZoom(v => v * (dir > 0 ? 1.2 : 1 / 1.2));
    };
    window.addEventListener('timeline-vertical-zoom', onVZoom);
    return () => window.removeEventListener('timeline-vertical-zoom', onVZoom);
  }, [timelineVerticalZoom, setTimelineVerticalZoom]);

  // After vertical-zoom commits, snap scrollTop so the previously centered row stays centered.
  useLayoutEffect(() => {
    const anchor = pendingVZoomAnchorRef.current;
    pendingVZoomAnchorRef.current = null;
    const el = bodyRef.current;
    if (!anchor || !el) return;
    const newCenterY = anchor.row * (BASE_ROW_HEIGHT * timelineVerticalZoom);
    const target = Math.max(0, newCenterY - el.clientHeight / 2);
    el.scrollTop = target;
    if (typeof setVerticalScroll === 'function') setVerticalScroll(target);
  }, [timelineVerticalZoom]);

  // After every zoom commit, snap scrollLeft so the anchor beat sits under the mouse.
  // First render: no prior zoom to anchor against.
  const prevZoomRef = useRef(timelineZoom);
  useLayoutEffect(() => {
    const prevZoom = prevZoomRef.current;
    prevZoomRef.current = timelineZoom;
    zoomRef.current = timelineZoom;
    if (!bodyRef.current) return;

    let anchor = pendingZoomAnchorRef.current;
    pendingZoomAnchorRef.current = null;

    if (!anchor) {
      // Keyboard zoom (no wheel event): use the beat captured during mousemove.
      const last = lastMouseOverRef.current;
      if (last && performance.now() - last.timestamp < 10000) {
        anchor = { beat: last.beat, mouseX: last.mouseX };
      } else {
        return; // Nothing to anchor against.
      }
    }

    const newContentX = beatToX(anchor.beat, barSubsRef.current, CELL_WIDTH * timelineZoom);
    bodyRef.current.scrollLeft = newContentX - anchor.mouseX;
  }, [timelineZoom]);

  // Alt+scroll to adjust velocity on hovered/selected notes
  useEffect(() => {
    const handleWheel = (e) => {
      const hk = hotkeysRef.current;
      if (!hk || !matchesWheelHotkey(e, hk.velocityWheel)) return;
      if (!bodyRef.current) return;
      const rect = bodyRef.current.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right ||
          e.clientY < rect.top || e.clientY > rect.bottom) return;
      e.preventDefault();

      // Find which note the mouse is over
      const scrollLeft = bodyRef.current.scrollLeft;
      const scrollTop = bodyRef.current.scrollTop;
      const mx = e.clientX - rect.left + scrollLeft;
      const my = e.clientY - rect.top + scrollTop;

      const hoveredIndices = [];
      notes.forEach((note, i) => {
        const noteLeft = beatToX(note.beat, barSubdivisions, cellWidth);
        const noteRight = noteLeft + durationToWidth(note.beat, note.duration || 1, barSubdivisions, cellWidth);
        const noteTop = rowTopPx(note.stringIndex, note.fret);
        const noteBottom = noteTop + rowHeight;
        if (mx >= noteLeft && mx <= noteRight && my >= noteTop && my <= noteBottom) {
          hoveredIndices.push(i);
        }
      });

      // Adjust selected notes if any are selected, otherwise just the hovered note
      const targets = selectedNotes.size > 0 ? [...selectedNotes] : hoveredIndices;
      if (targets.length === 0) return;

      const delta = e.deltaY > 0 ? -0.05 : 0.05;
      setNotes(prev => prev.map((n, i) => {
        if (!targets.includes(i)) return n;
        const newVel = Math.max(0.05, Math.min(1, (n.velocity ?? 0.8) + delta));
        return { ...n, velocity: Math.round(newVel * 100) / 100 };
      }));
    };
    document.addEventListener('wheel', handleWheel, { passive: false });
    return () => document.removeEventListener('wheel', handleWheel);
  }, [notes, setNotes, selectedNotes, barSubdivisions, cellWidth]);

  // --- Auto-growing timeline -------------------------------------------------
  // Right edge behaves as a wall first. Growth only arms after the user has hit
  // the edge, paused EDGE_PAUSE_MS, and then started a *fresh* scroll stream
  // (inertia tails and continuous scrolling never arm it).
  const growRef = useRef({ edgeSince: 0, timer: null, timerDone: false, armed: false, lastT: 0, lastAbs: 0, pending: 0 });
  const growLiveRef = useRef({});
  growLiveRef.current = { onGrowBars, barWidth: cellWidth * (timeSignature?.[0] || 4), playing, noteCount: notes.length };

  const resetGrow = () => {
    const g = growRef.current;
    clearTimeout(g.timer);
    g.timer = null; g.timerDone = false; g.armed = false;
  };

  // Reset on play and on note entry
  useEffect(() => { if (playing) resetGrow(); }, [playing]);
  const prevNoteCount = useRef(notes.length);
  useEffect(() => {
    if (notes.length > prevNoteCount.current) resetGrow();
    prevNoteCount.current = notes.length;
  }, [notes.length]);
  useEffect(() => () => clearTimeout(growRef.current.timer), []);

  // Apply scroll that was requested while the grid was still too short
  useLayoutEffect(() => {
    const g = growRef.current;
    if (g.pending && bodyRef.current) {
      bodyRef.current.scrollLeft += g.pending;
      g.pending = 0;
    }
  }, [barSubdivisions.length]);

  // Shift+wheel (or horizontal trackpad) pans; plain wheel scrolls vertically only
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const EDGE_PAUSE_MS = 500;
    const STREAM_GAP_MS = 90;
    const MAX_BARS_PER_EVENT = 2;
    const handleWheel = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return; // let zoom/velocity handlers take over
      const g = growRef.current;
      const live = growLiveRef.current;

      // Track every wheel event so we can tell where a stream begins
      const mag = Math.max(Math.abs(e.deltaX), Math.abs(e.deltaY));
      const now = performance.now();
      const newStream = now - g.lastT > STREAM_GAP_MS || mag > g.lastAbs * 1.5 + 2;
      g.lastT = now; g.lastAbs = mag;

      let dx = 0;
      if (e.shiftKey) dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) dx = e.deltaX;
      else return; // vertical scroll — native

      if (e.shiftKey) { e.preventDefault(); el.scrollLeft += dx; }

      if (dx < 0) { resetGrow(); return; }               // scrolling left resets
      if (dx === 0) return;

      const atEdge = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
      if (!atEdge) return;                                // armed state survives while growing
      e.preventDefault();                                 // no rubber-band / back-swipe at the wall

      if (g.armed) {
        const bars = Math.min(MAX_BARS_PER_EVENT, Math.max(1, Math.ceil(dx / live.barWidth)));
        g.pending += dx;
        live.onGrowBars?.(bars);
        return;
      }
      if (!g.timer && !g.timerDone) {                     // first hit: start the pause timer
        g.timer = setTimeout(() => { g.timer = null; g.timerDone = true; }, EDGE_PAUSE_MS);
        return;
      }
      if (newStream) {
        if (g.timerDone) {                                // fresh stream after the pause → arm
          g.armed = true;
        } else {                                          // deliberate re-scroll before expiry → restart
          clearTimeout(g.timer);
          g.timer = setTimeout(() => { g.timer = null; g.timerDone = true; }, EDGE_PAUSE_MS);
        }
      }
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, []);

  // Auto-scroll to playhead during playback
  useEffect(() => {
    if (!(autoScroll?.onPlayback ?? true)) return;
    if (playing && bodyRef.current && currentBeat !== null) {
      const playheadX = beatToX(currentBeat, barSubdivisions, cellWidth);
      const container = bodyRef.current;
      const scrollLeft = container.scrollLeft;
      const visibleWidth = container.clientWidth;

      if (playheadX > scrollLeft + visibleWidth - 100 || playheadX < scrollLeft) {
        container.scrollLeft = playheadX - 100;
      }
    }
  }, [currentBeat, playing, autoScroll]);

  const loopLeftPx = beatToX(loopStart, barSubdivisions, cellWidth);
  const loopWidthPx = beatToX(loopEnd, barSubdivisions, cellWidth) - loopLeftPx;

  // Piano-look keys, all uniform: every white key is exactly 12/7 lanes
  // (seven equal keys tiling each octave) and every black key is exactly its
  // one-semitone lane (60% wide, overlapping the whites). Each key is its own
  // hover/click element, so hover/chord-root highlighting fills exactly the
  // key under the cursor; the grid echoes the note's lane with a subtle band.
  const lowestMidi = pitchRowToMidi(0);
  const highestMidi = pitchRowToMidi(totalRows - 1);
  const whiteKeyHeight = (12 / 7) * rowHeight;
  const WHITE_SEMITONES = [0, 2, 4, 5, 7, 9, 11]; // C D E F G A B
  const BLACK_KEY_SEMITONES = [1, 3, 6, 8, 10];
  const pianoKeys = [];
  for (let cMidi = Math.floor(lowestMidi / 12) * 12; cMidi <= highestMidi; cMidi += 12) {
    const cBottomY = (totalRows - (cMidi - lowestMidi)) * rowHeight;
    WHITE_SEMITONES.forEach((s, k) => {
      const midi = cMidi + s;
      if (midi < lowestMidi || midi > highestMidi) return;
      // Clamp faces partially cut off at the pane edges
      const top = Math.max(0, cBottomY - (k + 1) * whiteKeyHeight);
      const bottom = Math.min(gridTotalHeight, cBottomY - k * whiteKeyHeight);
      if (bottom <= top) return;
      pianoKeys.push({
        midi, name: midiToNoteName(midi), pitchRow: midiToPitchRow(midi),
        isBlack: false, top, height: bottom - top, isC: s === 0,
      });
    });
    BLACK_KEY_SEMITONES.forEach((s) => {
      const midi = cMidi + s;
      if (midi < lowestMidi || midi > highestMidi) return;
      pianoKeys.push({
        midi, name: midiToNoteName(midi), pitchRow: midiToPitchRow(midi),
        isBlack: true, top: cBottomY - (s + 1) * rowHeight, height: rowHeight, isC: false,
      });
    });
  }

  return (
    <div
      className="timeline-container"
      style={{ position: 'relative' }}
      onMouseDownCapture={(e) => {
        if (!altSpaceRef.current || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        startContentDrag(e);
      }}
    >
      {showVerticalZoomButtons && setTimelineVerticalZoom && (
        <div className="timeline-vzoom-dock" style={{
          position: 'absolute', top: 4, right: 8, zIndex: 5,
          display: 'flex', flexDirection: 'column', gap: 2, pointerEvents: 'auto',
        }}>
          <button
            className="timeline-vzoom-btn"
            title="Increase row height (Ctrl+Shift++)"
            onClick={() => { queueVerticalZoomAnchor(); applyVerticalZoom(v => v * 1.2); }}
            style={{ width: 22, height: 18, padding: 0, fontSize: 12, lineHeight: 1, cursor: 'pointer' }}
          >+</button>
          <button
            className="timeline-vzoom-btn"
            title="Decrease row height (Ctrl+Shift+-)"
            onClick={() => { queueVerticalZoomAnchor(); applyVerticalZoom(v => v / 1.2); }}
            style={{ width: 22, height: 18, padding: 0, fontSize: 12, lineHeight: 1, cursor: 'pointer' }}
          >−</button>
        </div>
      )}
      {/* Header row: piano spacer + bar numbers */}
      <div style={{ display: 'flex', flexShrink: 0 }}>
        <div className="piano-spacer" />
        <div className="timeline-header" ref={headerRef} onMouseDown={handleHeaderMouseDown} onMouseEnter={scrubPrepare} style={{ flex: 1 }}
          onMouseMove={(e) => {
            if (!loop || loopDragRef.current) return;
            const rect = headerRef.current.getBoundingClientRect();
            const scrollLeft = bodyRef.current ? bodyRef.current.scrollLeft : 0;
            const x = e.clientX - rect.left + scrollLeft;
            const edgeThreshold = Math.max(8, cellWidth * 0.5);
            const loopLeftX = beatToX(loopStart, barSubdivisions, cellWidth);
            const loopRightX = beatToX(loopEnd, barSubdivisions, cellWidth);
            if (Math.abs(x - loopLeftX) < edgeThreshold || Math.abs(x - loopRightX) < edgeThreshold) {
              headerRef.current.style.cursor = 'ew-resize';
            } else if (x > loopLeftX + edgeThreshold && x < loopRightX - edgeThreshold) {
              headerRef.current.style.cursor = 'grab';
            } else {
              headerRef.current.style.cursor = 'crosshair';
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            const rect = headerRef.current.getBoundingClientRect();
            const scrollLeft = bodyRef.current ? bodyRef.current.scrollLeft : 0;
            const x = e.clientX - rect.left + scrollLeft;
            // Check if clicking on a marker
            const clickedMarker = markers.find(m => {
              const mx = beatToX(m.beat, barSubdivisions, cellWidth);
              return Math.abs(mx - x) < 6;
            });
            if (clickedMarker) {
              setMarkerMenu({ x: e.clientX, y: e.clientY, markerId: clickedMarker.id });
              return;
            }
            const rawBeat = xToBeat(x, barSubdivisions, cellWidth, false);
            const snapped = Math.max(0, Math.round(rawBeat / snapUnit) * snapUnit);
            setMarkerMenu({ x: e.clientX, y: e.clientY, beat: snapped });
          }}
        >
          <div style={{ position: 'relative', transform: `translateX(-${headerScrollLeft}px)`, width: gridWidth, height: '100%' }}>
            {loop && <div
              className="loop-region-header"
              style={{ left: loopLeftPx, width: loopWidthPx }}
            />}
            {/* Markers */}
            {markers.map(marker => (
              <div
                key={marker.id}
                className="timeline-marker"
                style={{ left: beatToX(marker.beat, barSubdivisions, cellWidth) }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setMarkerMenu({ x: e.clientX, y: e.clientY, markerId: marker.id });
                }}
                onMouseDown={(e) => {
                  if (e.button !== 0) return;
                  e.stopPropagation();
                  const startX = e.clientX;
                  const startBeat = marker.beat;
                  let didMove = false;
                  const handleMove = (moveE) => {
                    const dx = moveE.clientX - startX;
                    if (Math.abs(dx) > 3) didMove = true;
                    const cw = colWidth(0, barSubdivisions, cellWidth);
                    const newBeat = Math.max(0, Math.min(totalCols - 1, Math.round((startBeat + dx / cw) / snapUnit) * snapUnit));
                    if (newBeat !== marker.beat && onUpdateMarker) {
                      onUpdateMarker(marker.id, { beat: newBeat });
                    }
                  };
                  const handleUp = () => {
                    window.removeEventListener('mousemove', handleMove);
                    window.removeEventListener('mouseup', handleUp);
                    if (!didMove) {
                      // Click without drag — start renaming
                      setEditingMarkerId(marker.id);
                      setEditingMarkerName(marker.name);
                    }
                  };
                  window.addEventListener('mousemove', handleMove);
                  window.addEventListener('mouseup', handleUp);
                }}
                title={`${marker.name} @ beat ${marker.beat + 1}`}
              >
                <div className="timeline-marker-line" style={{ background: marker.color }} />
                <div className="timeline-marker-label" style={{ background: marker.color }}>
                  {editingMarkerId === marker.id ? (
                    <input
                      className="marker-name-input"
                      value={editingMarkerName}
                      onChange={(e) => setEditingMarkerName(e.target.value)}
                      onBlur={() => {
                        if (editingMarkerName.trim() && onUpdateMarker) {
                          onUpdateMarker(marker.id, { name: editingMarkerName.trim() });
                        }
                        setEditingMarkerId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.target.blur();
                        if (e.key === 'Escape') setEditingMarkerId(null);
                        e.stopPropagation();
                      }}
                      onClick={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                      autoFocus
                    />
                  ) : (
                    marker.name
                  )}
                </div>
              </div>
            ))}
            {/* Beat labels and bar lines */}
            {Array.from({ length: totalCols }, (_, i) => {
              const isBar = starts.includes(i);
              return (
                <div
                  key={i}
                  className={`bar-number ${isBar ? 'bar-start' : ''}`}
                  style={{ left: beatToX(i, barSubdivisions, cellWidth) }}
                >
                  {beatLabel(i, barSubdivisions)}
                </div>
              );
            })}
            {/* Selected beat indicator in header — draggable */}
            {selectedBeat !== null && !playing && (
              <div
                className="header-beat-marker"
                style={{ left: beatToX(selectedBeat, barSubdivisions, cellWidth), cursor: 'ew-resize' }}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  const headerRect = headerRef.current.getBoundingClientRect();
                  const bodyRect = bodyRef.current ? bodyRef.current.getBoundingClientRect() : null;
                  const safeY = bodyRect ? bodyRect.top + bodyRect.height / 2 : e.clientY;

                  const runMove = (clientX) => {
                    const scrollLeft = bodyRef.current ? bodyRef.current.scrollLeft : 0;
                    const x = clientX - headerRect.left + scrollLeft;
                    const rawBeat = xToBeat(x, barSubdivisions, cellWidth, false);
                    const beat = freeMode ? rawBeat : Math.round(rawBeat / snapUnit) * snapUnit;
                    const clamped = Math.max(0, Math.min(totalCols - 1, beat));
                    setSelectedBeat(clamped);
                  };
                  const handleMove = (moveE) => {
                    autoPan.update(moveE.clientX, safeY);
                    runMove(moveE.clientX);
                  };
                  const handleUp = () => {
                    autoPan.stop();
                    window.removeEventListener('mousemove', handleMove);
                    window.removeEventListener('mouseup', handleUp);
                  };
                  autoPan.start(e.clientX, safeY, (cx) => runMove(cx));
                  window.addEventListener('mousemove', handleMove);
                  window.addEventListener('mouseup', handleUp);
                }}
              />
            )}
            {/* Grab handle on the playhead: drag it to scrub the audio, in any loop mode */}
            {!playing && selectedBeat !== null && (
              <div
                className="scrub-handle"
                style={{ left: beatToX(selectedBeat, barSubdivisions, cellWidth) }}
                title="Drag to scrub: the recording plays under the playhead"
                onMouseDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); e.preventDefault(); startScrubDrag(e); }}
              />
            )}
            {/* Playhead in header */}
            {playing && (
              <div ref={headerPlayheadRef} className="header-playhead" style={{ left: beatToX(currentBeat ?? 0, barSubdivisions, cellWidth) }} />
            )}
          </div>
        </div>
      </div>

      {/* Body row: piano roll + grid */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Piano roll - syncs vertical scroll */}
        <div className="piano-roll-scroll"
          onScroll={(e) => setVerticalScroll(e.target.scrollTop)}
          ref={el => {
            if (el && Math.abs(el.scrollTop - verticalScroll) > 1) el.scrollTop = verticalScroll;
          }}
          onMouseLeave={() => setHoveredNote(null)}
        >
          <div className="piano-roll-inner" style={{ height: gridTotalHeight }}>
            {pianoKeys.map((key) => {
              const isHovered = hoveredNote &&
                noteToPitchRow(hoveredNote.stringIndex, hoveredNote.fret) === key.pitchRow;
              const combos = pitchRowCombos(key.pitchRow);
              // Pick the combo with lowest fret (first position playing)
              const repCombo = combos.reduce((best, c) => (!best || c.fret < best.fret) ? c : best, null);
              return (
                <div
                  key={key.midi}
                  className={`piano-key ${key.isBlack ? 'black' : 'white'} ${isHovered ? 'hovered' : ''}`}
                  style={{
                    position: 'absolute',
                    top: key.top,
                    height: key.height,
                    left: 0,
                    right: key.isBlack ? undefined : 0,
                    // Octave marker on the C/B boundary, aligned with the grid's
                    borderBottomColor: key.isC ? '#46464a' : undefined,
                  }}
                  onMouseEnter={() => {
                    if (repCombo) {
                      setHoveredNote({ stringIndex: repCombo.stringIndex, fret: repCombo.fret });
                      if (hoverPreviewPiano) playNote(repCombo.stringIndex, repCombo.fret, 0.15, hoverVolume);
                    }
                  }}
                >
                  <span className="piano-key-label">{key.name}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Grid body */}
        <div
          className="timeline-body"
          ref={(el) => {
            bodyRef.current = el;
            if (bodyRefExternal) bodyRefExternal.current = el;
          }}
          onClick={handleClick}
          onMouseDown={handleGridMouseDown}
          onContextMenu={(e) => e.preventDefault()}
          onMouseMove={(e) => {
            if (playing) return;
            const rect = bodyRef.current.getBoundingClientRect();
            const x = e.clientX - rect.left + bodyRef.current.scrollLeft;
            const y = e.clientY - rect.top + bodyRef.current.scrollTop;
            const rawBeat = xToBeat(x, barSubdivisions, cellWidth, false);
            const snapped = freeMode ? rawBeat : Math.round(rawBeat / snapUnit) * snapUnit;
            if (snapped < 0 || snapped >= totalCols) {
              setHoverPos(null);
              if (onTimelineHover) onTimelineHover(null);
              return;
            }
            const combo = yToPitch(y);
            if (!combo) {
              setHoverPos(null);
              if (onTimelineHover) onTimelineHover(null);
              return;
            }
            setHoverPos({ beat: snapped, stringIndex: combo.stringIndex, fret: combo.fret });
            if (onTimelineHover) onTimelineHover(null);
          }}
          onMouseLeave={() => {
            setHoverPos(null);
            if (onTimelineHover) onTimelineHover(null);
          }}
          onScroll={(e) => { setVerticalScroll(e.target.scrollTop); setHeaderScrollLeft(e.target.scrollLeft); }}
          style={{ flex: 1, cursor: machineGunMode ? 'cell' : undefined }}
        >
        <div className="timeline-grid" style={{ width: gridWidth, height: gridTotalHeight }}>
          {/* Loop region highlight in grid */}
          {loop && <>
            <div
              className="loop-region-grid"
              style={{ left: loopLeftPx, width: loopWidthPx }}
            />

            {/* Dimmed areas outside loop */}
            {loopStart > 0 && (
              <div className="loop-dim" style={{ left: 0, width: loopLeftPx }} />
            )}
            {loopEnd < totalCols && (
              <div className="loop-dim" style={{ left: loopLeftPx + loopWidthPx, right: 0 }} />
            )}

            {/* Loop boundary lines */}
            <div className="loop-boundary" style={{ left: loopLeftPx }} />
            <div className="loop-boundary" style={{ left: loopLeftPx + loopWidthPx }} />
          </>}

          {/* Subtle stripes on white-note lanes, mirroring the keyboard so
              the key-to-lane correspondence is visible */}
          {pianoKeys.filter(k => !k.isBlack).map(k => (
            <div
              key={`lane-${k.pitchRow}`}
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: pitchRowTopPx(k.pitchRow),
                height: rowHeight,
                background: 'rgba(255, 255, 255, 0.04)',
                zIndex: 0,
                pointerEvents: 'none',
              }}
            />
          ))}

          {/* Hovered-note lane band, continuous with the keyboard's band */}
          {hoveredNote && (() => {
            const r = noteToPitchRow(hoveredNote.stringIndex, hoveredNote.fret);
            return r >= 0 && (
              <div
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: pitchRowTopPx(r),
                  height: rowHeight,
                  background: 'rgba(100, 160, 255, 0.12)',
                  zIndex: 1,
                  pointerEvents: 'none',
                }}
              />
            );
          })()}

          {/* Octave separator lines on each C/B boundary, matching the
              keyboard's octave marker */}
          {pianoKeys.filter(k => k.isC).map(k => (
            <div
              key={`oct-${k.pitchRow}`}
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: pitchRowTopPx(k.pitchRow) + rowHeight,
                height: '1px',
                background: '#2c2c31',
                zIndex: 1,
              }}
            />
          ))}

          {/* Vertical bar/beat lines — scale brightness with zoom */}
          {(() => {
            const zoomFactor = Math.min(1, Math.max(0, (cellWidth - 6) / 40));
            const beatAlpha = 0.03 + zoomFactor * 0.09;
            const barAlpha = 0.14 + zoomFactor * 0.26;
            return Array.from({ length: totalCols }, (_, i) => {
              const isBar = starts.includes(i);
              if (!isBar && beatAlpha <= 0.01) return null;
              return (
                <div
                  key={`col-${i}`}
                  className="grid-col"
                  style={{
                    left: beatToX(i, barSubdivisions, cellWidth),
                    borderLeftColor: isBar
                      ? `rgba(232, 230, 225, ${barAlpha})`
                      : `rgba(232, 230, 225, ${beatAlpha})`,
                  }}
                />
              );
            });
          })()}

          {/* Tuplet subdivision lines — fade in/out with zoom */}
          {tupletLines.visible && subdivisions > 1 && (() => {
            const subdivWidth = cellWidth / subdivisions;
            const zoomFactor = Math.min(1, Math.max(0, (subdivWidth - 4) / 20));
            const tupletAlpha = zoomFactor * (0.15 + zoomFactor * 0.45) * (tupletLines.opacity / 0.35);
            if (tupletAlpha <= 0.01) return null;
            return Array.from({ length: totalCols }, (_, beat) => {
              const lines = [];
              for (let t = 0; t < subdivisions; t++) {
                const subBeat = beat + (t / subdivisions);
                if (subBeat >= totalCols) break;
                lines.push(
                  <div
                    key={`tup-${beat}-${t}`}
                    className="grid-col tuplet-line"
                    style={{
                      left: beatToX(subBeat, barSubdivisions, cellWidth),
                      borderLeftColor: `rgba(230, 126, 34, ${tupletAlpha})`,
                    }}
                  />
                );
              }
              return lines;
            });
          })()}


          {/* Marker lines through grid */}
          {markers.map(marker => (
            <div
              key={`mline-${marker.id}`}
              className="timeline-marker-line-grid"
              style={{
                left: beatToX(marker.beat, barSubdivisions, cellWidth),
                background: marker.color,
              }}
            />
          ))}

          {/* Audio clips — DAW-style regions. Each clip draws its slice of the file in 1:1 pixel
              tiles. Width is locked to the track's originalBpm so tempo changes stretch playback
              but keep the clip aligned to the beat grid that was in effect at import.
              Clips of the active audio track are interactive (move / trim / select / split). */}
          {audioTracks.flatMap(at => {
            const refBpm = at.originalBpm || bpm;
            const spb = 1 / timeToBeat(1, refBpm, timeSignature[1]);
            const fileDur = at.audioDuration || 1;
            const color = at.isActive ? '#d9a6ec' : '#6b6b70';
            const peaks = at.waveformPeaks;
            const buffer = at.audioBuffer;
            const m = mapFor(at);
            const showPins = !!(tempoMap && tempoMap.active && tempoMap.refId === at.trackId);
            return (at.clips || []).map(clip => {
              const clipDur = clip.srcEnd - clip.srcStart;
              const lenBeats = clipTimeToBeat(clip, clip.srcEnd, m) - clip.start;
              const startX = beatToX(clip.start, barSubdivisions, cellWidth);
              const endX = beatToX(clip.start + lenBeats, barSubdivisions, cellWidth);
              const totalWidth = Math.max(1, endX - startX);
              const TILE_W = 4096;
              // Tiles per span between sync points; each span is stretched to its beat width.
              const tiles = [];
              clipSpans(clip, m).forEach(span => {
                const spanX0 = beatToX(clip.start + span.b0, barSubdivisions, cellWidth) - startX;
                const spanX1 = beatToX(clip.start + span.b1, barSubdivisions, cellWidth) - startX;
                const spanW = Math.max(0.5, spanX1 - spanX0);
                const n = Math.ceil(spanW / TILE_W);
                for (let ti = 0; ti < n; ti++) {
                  const off = ti * TILE_W;
                  const w = Math.min(TILE_W, spanW - off);
                  tiles.push({
                    left: spanX0 + off,
                    width: w,
                    fStart: (span.t0 + (off / spanW) * (span.t1 - span.t0)) / fileDur,
                    fEnd: (span.t0 + ((off + w) / spanW) * (span.t1 - span.t0)) / fileDur,
                  });
                }
              });
              const interactive = at.isActive;
              const isSel = selectedClips.has(clip.id);
              // Editable clips are a compact lane (waveform centred in view); inactive ones stay a faint full-height backdrop.
              const clipH = interactive ? Math.min(gridTotalHeight, 360) : gridTotalHeight;
              const canvases = [];
              for (let ti = 0; ti < tiles.length; ti++) {
                const { left: tileOffset, width: tileWidth, fStart, fEnd } = tiles[ti];
                canvases.push(
                  <canvas
                    key={`wf-${clip.id}-${ti}`}
                    width={Math.round(tileWidth)}
                    height={clipH}
                    style={{
                      position: 'absolute', left: tileOffset, top: 0,
                      width: tileWidth, height: clipH,
                      opacity: interactive ? 0.85 : (at.bgOpacity ?? 0.2),
                      pointerEvents: 'none',
                    }}
                    ref={el => {
                      if (!el) return;
                      const c2d = el.getContext('2d');
                      const w = el.width;
                      const h = el.height;
                      c2d.clearRect(0, 0, w, h);
                      c2d.fillStyle = color;
                      const mid = h / 2;
                      const precomputedInTile = peaks ? peaks.length * (fEnd - fStart) : 0;
                      if (buffer && precomputedInTile < w) {
                        const data = buffer.getChannelData(0);
                        const sampleStart = Math.floor(fStart * data.length);
                        const sampleEnd = Math.floor(fEnd * data.length);
                        const span = sampleEnd - sampleStart;
                        const samplesPerPixel = span / w;
                        if (samplesPerPixel >= 1) {
                          for (let i = 0; i < w; i++) {
                            const s0 = sampleStart + Math.floor(i * samplesPerPixel);
                            const e0 = sampleStart + Math.floor((i + 1) * samplesPerPixel);
                            let min = 0, max = 0;
                            for (let j = s0; j < e0; j++) {
                              const v = data[j];
                              if (v > max) max = v;
                              else if (v < min) min = v;
                            }
                            c2d.fillRect(i, mid - max * mid, 1, Math.max(1, (max - min) * mid));
                          }
                        } else {
                          c2d.strokeStyle = color;
                          c2d.lineWidth = 1;
                          c2d.beginPath();
                          for (let i = 0; i < w; i++) {
                            const pos = sampleStart + (i / (w - 1 || 1)) * Math.max(0, span - 1);
                            const i0 = Math.floor(pos);
                            const i1 = Math.min(i0 + 1, data.length - 1);
                            const v = data[i0] * (1 - (pos - i0)) + data[i1] * (pos - i0);
                            if (i === 0) c2d.moveTo(i, mid - v * mid); else c2d.lineTo(i, mid - v * mid);
                          }
                          c2d.stroke();
                        }
                      } else if (peaks) {
                        for (let i = 0; i < w; i++) {
                          const frac = fStart + (i / w) * (fEnd - fStart);
                          const peak = peaks[Math.min(peaks.length - 1, Math.floor(frac * peaks.length))] || 0;
                          c2d.fillRect(i, mid - peak * mid, 1, peak * mid * 2);
                        }
                      }
                    }}
                  />
                );
              }
              return (
                <div
                  key={`clip-${at.trackId}-${clip.id}`}
                  className={`audio-clip${interactive ? ' interactive' : ''}${isSel ? ' selected' : ''}`}
                  style={{ left: startX, width: totalWidth, height: clipH }}
                  onMouseDown={interactive ? (e) => handleClipMouseDown(e, at, clip) : undefined}
                  onDoubleClick={interactive ? (e) => handleClipDoubleClick(e, at, clip) : undefined}
                  title={interactive ? 'Double-click to add a sync point' : undefined}
                >
                  {canvases}
                  {showPins && (at.syncPoints || []).map(p => ({ p, beat: tempoMap.fileBeatToBeat(p.beat) }))
                    .filter(({ beat }) => beat >= clip.start - 1e-6 && beat <= clip.start + lenBeats + 1e-6)
                    .map(({ p, beat }) => {
                    // a pin sits on the grid beat it defines, so dragging it lands exactly on a line
                    const px = beatToX(beat, barSubdivisions, cellWidth) - startX;
                    return (
                      <div
                        key={p.id}
                        className={`sync-pin${interactive ? '' : ' passive'}`}
                        style={{ left: px }}
                        title={interactive ? 'Sync point: drag the top handle to move it along the grid (which beat this sound is on). Alt = no snapping. Right-click to remove.' : undefined}
                        onMouseDown={interactive ? (e) => handlePinMouseDown(e, at, clip, p) : undefined}
                        onContextMenu={interactive ? (e) => e.preventDefault() : undefined}
                        onDoubleClick={interactive ? (e) => e.stopPropagation() : undefined}
                      >
                        {interactive && (
                          <span
                            className="sync-pin-wave"
                            title="Waveform handle: slide the recording under this pin to put it on the exact hit (the beat stays). Alt = no snapping."
                            onMouseDown={(e) => handlePinWaveMouseDown(e, at, clip, p)}
                          />
                        )}
                      </div>
                    );
                  })}
                  {interactive && (
                    <>
                      <div className="audio-clip-label">{at.name || 'Audio'}</div>
                      <div className="audio-clip-handle left" onMouseDown={(e) => handleClipTrimStart(e, at, clip, 'left')} />
                      <div className="audio-clip-handle right" onMouseDown={(e) => handleClipTrimStart(e, at, clip, 'right')} />
                    </>
                  )}
                </div>
              );
            });
          })}

          {/* Cursor hover rectangle — visible when hovering the timeline */}
          {hoverPos && !playing && !cursorMode && (
            <div
              className="cursor-hover-rect"
              style={{
                left: beatToX(hoverPos.beat, barSubdivisions, cellWidth),
                top: rowTopPx(hoverPos.stringIndex, hoverPos.fret),
                width: durationToWidth(hoverPos.beat, noteDuration, barSubdivisions, cellWidth),
                height: rowHeight,
              }}
            />
          )}

          {/* Duration preview (green) — only visible when hovering the fretboard */}
          {hoveredNote && selectedBeat !== null && !playing && (
            <div
              className="duration-preview"
              style={{
                left: beatToX(selectedBeat, barSubdivisions, cellWidth),
                top: rowTopPx(hoveredNote.stringIndex, hoveredNote.fret),
                width: durationToWidth(selectedBeat, noteDuration, barSubdivisions, cellWidth),
                height: rowHeight,
              }}
            />
          )}

          {/* Background track notes (dimmed, non-interactive) */}
          {backgroundNotes.map((note, i) => {
            const topPx = rowTopPx(note.stringIndex, note.fret);
            const duration = note.duration || 1;
            const noteWidth = durationToWidth(note.beat, duration, barSubdivisions, cellWidth) - 2;
            return (
              <div
                key={`bg-${i}`}
                className="timeline-note background"
                style={{
                  left: beatToX(note.beat, barSubdivisions, cellWidth) + 1,
                  top: topPx,
                  width: noteWidth,
                  height: rowHeight,
                  minHeight: 4,
                  backgroundColor: note._trackColor || '#888',
                  opacity: note._trackOpacity ?? 0.2,
                  pointerEvents: 'none',
                }}
              >
                {getNoteName(note.stringIndex, note.fret)}
              </div>
            );
          })}

          {/* Note blur glows */}
          {notes.map((note, i) => {
            const isDragging = dragPreview && !dragPreview.isDuplicate && dragPreview.affectedIndices.includes(i);
            if (isDragging) return null;
            const topPx = rowTopPx(note.stringIndex, note.fret);
            const duration = note.duration || 1;
            const noteWidth = durationToWidth(note.beat, duration, barSubdivisions, cellWidth) - 2;
            const color = getNoteColor(note, i);
            return (
              <div key={`blur-${i}`} style={{
                position: 'absolute',
                left: beatToX(note.beat, barSubdivisions, cellWidth) + 1,
                top: topPx,
                width: noteWidth,
                height: rowHeight,
                minHeight: 4,
                background: color,
                filter: 'blur(8px)',
                opacity: 0.5,
                borderRadius: 2,
                pointerEvents: 'none',
                zIndex: 3,
              }} />
            );
          })}

          {/* Notes */}
          {notes.map((note, i) => {
            const isDragging = dragPreview && !dragPreview.isDuplicate && dragPreview.affectedIndices.includes(i);
            if (isDragging) return null;
            const topPx = rowTopPx(note.stringIndex, note.fret);
            const duration = note.duration || 1;
            const noteWidth = durationToWidth(note.beat, duration, barSubdivisions, cellWidth) - 2;
            const isPlaying = playing && currentBeat !== null &&
              currentBeat >= note.beat && currentBeat < note.beat + duration;
            const color = getNoteColor(note, i);
            const vel = note.velocity ?? 0.8;

            const isGhost = note.ghost;
            const hasBend = note.bend && note.bend > 0;
            const hasSlide = note.slideTo != null;

            return (
              <div
                key={i}
                data-note-index={i}
                className={`timeline-note ${selectedNotes.has(i) ? 'selected' : ''} ${isPlaying ? 'playing' : ''} ${isGhost ? 'ghost' : ''}`}
                style={{
                  left: beatToX(note.beat, barSubdivisions, cellWidth) + 1,
                  top: topPx,
                  width: noteWidth,
                  height: rowHeight,
                  minHeight: 4,
                  backgroundColor: isGhost ? 'transparent' : color,
                  borderColor: isGhost ? color : undefined,
                  opacity: isGhost ? 0.6 : (0.3 + vel * 0.7),
                  boxShadow: isPlaying ? `0 0 12px 4px ${color}, inset 0 0 6px rgba(255,255,255,0.3)` : undefined,
                }}
                title={`${isGhost ? '(ghost) ' : ''}${getNoteName(note.stringIndex, note.fret)} (${duration}) vel:${Math.round(vel * 100)}%${hasBend ? ` bend:${note.bend}` : ''}${hasSlide ? ` slide→${note.slideTo}` : ''}`}
                onClick={(e) => handleNoteClick(e, i)}
                onContextMenu={(e) => handleNoteContextMenu(e, i)}
                onMouseEnter={() => hoverPreviewNotes && playNote(note.stringIndex, note.fret, 0.15, hoverVolume)}
                onMouseDown={(e) => handleNoteDragStart(e, i)}
              >
                {isGhost ? 'x' : getNoteName(note.stringIndex, note.fret)}
                {hasBend && <span className="note-bend-indicator">↑{note.bend}</span>}
                {hasSlide && <span className="note-slide-indicator">↗</span>}
                <div
                    className="note-resize-handle-left"
                    onMouseDown={(e) => handleResizeStartLeft(e, i)}
                  />
                <div
                    className="note-resize-handle"
                    onMouseDown={(e) => handleResizeStart(e, i)}
                  />
              </div>
            );
          })}

          {/* Drag preview notes */}
          {dragPreview && dragPreview.affectedIndices.map(idx => {
            const note = notes[idx];
            if (!note) return null;
            const oldPitchRow = noteToPitchRow(note.stringIndex, note.fret);
            const newPitchRow = Math.max(0, Math.min(totalRows - 1, oldPitchRow + dragPreview.deltaRow));
            const newMidi = pitchRowToMidi(newPitchRow);
            const combo = closestComboForPitch(newMidi, note.stringIndex);
            if (!combo) return null;
            const newBeat = Math.max(0, Math.min(totalCols - (note.duration || 1), note.beat + dragPreview.deltaBeat));
            const topPct = pitchRowTopPx(newPitchRow);
            const duration = note.duration || 1;
            const noteWidth = durationToWidth(newBeat, duration, barSubdivisions, cellWidth) - 2;
            return (
              <div
                key={`preview-${idx}`}
                className="timeline-note"
                style={{
                  left: beatToX(newBeat, barSubdivisions, cellWidth) + 1,
                  backgroundColor: getNoteColor(combo.stringIndex, combo.fret),
                  top: topPct,
                  width: noteWidth,
                  height: rowHeight,
                  minHeight: 4,
                  opacity: 0.7,
                  zIndex: 20,
                  pointerEvents: 'none',
                }}
              >
                {midiToNoteName(newMidi)}
              </div>
            );
          })}

          {/* Marquee selection rectangle */}
          {marquee && (
            <div className={`marquee-rect ${marqueeRef.current && marqueeRef.current.erase ? 'eraser' : ''}`} style={{
              left: marquee.x1,
              top: marquee.y1,
              width: marquee.x2 - marquee.x1,
              height: marquee.y2 - marquee.y1,
            }} />
          )}

          {/* Selected beat line */}
          {selectedBeat !== null && !playing && (
            <div className="playhead" style={{ left: beatToX(selectedBeat, barSubdivisions, cellWidth), background: '#ffffff', width: 1 }} />
          )}

          {/* Playhead */}
          {playing && (
            <div ref={bodyPlayheadRef} className="playhead" style={{ left: beatToX(currentBeat ?? 0, barSubdivisions, cellWidth) }} />
          )}
        </div>
      </div>
      </div>

      {/* Marker context menu */}
      {markerMenu && (
        <div className="subdiv-menu-overlay" onClick={() => setMarkerMenu(null)}>
          <div
            className="subdiv-menu"
            style={{ left: markerMenu.x, top: markerMenu.y }}
            onClick={e => e.stopPropagation()}
          >
            {markerMenu.markerId ? (
              <>
                <div className="subdiv-menu-title">Marker</div>
                <button className="subdiv-menu-item" onClick={() => {
                  const m = markers.find(x => x.id === markerMenu.markerId);
                  if (m) {
                    setEditingMarkerId(m.id);
                    setEditingMarkerName(m.name);
                  }
                  setMarkerMenu(null);
                }}>Rename</button>
                <button className="subdiv-menu-item" onClick={() => {
                  if (onDeleteMarker) onDeleteMarker(markerMenu.markerId);
                  setMarkerMenu(null);
                }}>Delete</button>
              </>
            ) : (
              <>
                <div className="subdiv-menu-title">Beat {markerMenu.beat + 1}</div>
                <button className="subdiv-menu-item" onClick={() => {
                  if (onAddMarker) onAddMarker(markerMenu.beat);
                  setMarkerMenu(null);
                }}>+ Add Marker</button>
                <button className="subdiv-menu-item" onClick={() => {
                  const { barIndex } = beatToBar(markerMenu.beat, barSubdivisions);
                  setSubdivMenu({ barIndex, x: markerMenu.x, y: markerMenu.y });
                  setMarkerMenu(null);
                }}>Bar Subdivisions...</button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Subdivision context menu */}
      {subdivMenu && (
        <div className="subdiv-menu-overlay" onClick={() => setSubdivMenu(null)}>
          <div
            className="subdiv-menu"
            style={{ left: subdivMenu.x, top: subdivMenu.y }}
            onClick={e => e.stopPropagation()}
          >
            <div className="subdiv-menu-title">Bar {subdivMenu.barIndex + 1} divisions</div>
            {[2, 3, 4, 5, 6, 7, 8, 9].map(n => (
              <button
                key={n}
                className={`subdiv-menu-item ${barSubdivisions[subdivMenu.barIndex] === n ? 'active' : ''}`}
                onClick={() => {
                  const barIdx = subdivMenu.barIndex;
                  const oldSubs = barSubdivisions;
                  const newSubs = [...oldSubs];
                  newSubs[barIdx] = n;
                  const shift = n - oldSubs[barIdx];
                  const oldStarts = barStartBeats(oldSubs);
                  const barEnd = oldStarts[barIdx] + oldSubs[barIdx];
                  setBarSubdivisions(newSubs);
                  setNotes(prev => remapNotes(prev, oldSubs, newSubs, barIdx));
                  // Shift loop boundaries if they're after the changed bar
                  if (loopStart >= barEnd) setLoopStart(s => s + shift);
                  if (loopEnd >= barEnd) setLoopEnd(s => s + shift);
                  setSubdivMenu(null);
                }}
              >
                {n} beats
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
