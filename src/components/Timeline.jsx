import { useRef, useState, useEffect, useCallback } from 'react';
import {
  NUM_STRINGS, NUM_FRETS, NUM_BARS, SUBDIVISIONS,
  CELL_WIDTH
} from '../utils/constants';
import { getNoteName, playNote } from '../utils/audio';
import {
  TOTAL_PITCH_ROWS, PITCH_LIST, noteToPitchRow, pitchRowToMidi,
  midiToNoteName, getMidiNote, closestComboForPitch, pitchRowCombos
} from '../utils/pitchMap';
import { totalColumns, barStartBeats, beatToBar, beatLabel, isBarStart, remapNotes, beatToX, xToBeat, gridTotalWidth, colWidth, durationToWidth } from '../utils/barLayout';
import { matchesWheelHotkey } from '../utils/hotkeys';

const BLACK_NOTES = new Set(['C#', 'D#', 'F#', 'G#', 'A#']);
const TOTAL_FRETS_PER_STRING = NUM_FRETS + 1;
const totalRows = TOTAL_PITCH_ROWS;
const ROW_HEIGHT = 20; // pixels per pitch row
const GRID_TOTAL_HEIGHT = totalRows * ROW_HEIGHT;

// Convert stringIndex + fret to pixel position (bass at bottom)
function rowTopPx(stringIndex, fret) {
  const row = noteToPitchRow(stringIndex, fret);
  return (totalRows - 1 - row) * ROW_HEIGHT;
}

function pitchRowTopPx(pitchRow) {
  return (totalRows - 1 - pitchRow) * ROW_HEIGHT;
}

export default function Timeline({
  notes, backgroundNotes = [], setNotes, saveSnapshot, setNotesDrag, commitDrag, freeMode = false,
  timelineZoom = 1, setTimelineZoom,
  barSubdivisions, setBarSubdivisions,
  currentBeat, selectedBeat, setSelectedBeat,
  playing, onDeleteNote,
  loopStart, loopEnd, setLoopStart, setLoopEnd, loop, setLoop,
  selectedNotes, setSelectedNotes, stringColors, getNoteColor,
  hoveredNote, setHoveredNote,
  chordRoot, setChordRoot,
  verticalScroll, setVerticalScroll,
  eraserMode = false,
  machineGunMode = false,
  defaultVelocity = 0.8,
  noteDuration = 1,
  setNoteDuration,
  snapUnit = 1,
  subdivisions = 1,
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
  chordPreview,
  autoScroll,
}) {
  const bodyRef = useRef(null);
  const headerRef = useRef(null);
  const [headerScrollLeft, setHeaderScrollLeft] = useState(0);
  const cellWidth = CELL_WIDTH * timelineZoom;
  const totalCols = totalColumns(barSubdivisions);
  const gridWidth = gridTotalWidth(barSubdivisions, cellWidth);
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

  const yToPitch = useCallback((y) => {
    const rowFromTop = Math.floor(y / ROW_HEIGHT);
    const pitchRow = Math.max(0, Math.min(totalRows - 1, totalRows - 1 - rowFromTop));
    const midi = pitchRowToMidi(pitchRow);
    const combo = closestComboForPitch(midi, 0);
    return combo;
  }, []);

  // Track K key for cursor-only mode (deselect + place cursor, no note input)
  useEffect(() => {
    const down = (e) => { if (e.key === 'k' || e.key === 'K') { cursorModeRef.current = true; setCursorMode(true); } };
    const up = (e) => { if (e.key === 'k' || e.key === 'K') { cursorModeRef.current = false; setCursorMode(false); } };
    document.addEventListener('keydown', down);
    document.addEventListener('keyup', up);
    return () => { document.removeEventListener('keydown', down); document.removeEventListener('keyup', up); };
  }, []);

  const handleClick = useCallback((e) => {
    if (playing) return;
    if (draggingRef.current || noteDragRef.current) return;
    if (marqueeDidDragRef.current) { marqueeDidDragRef.current = false; return; }
    if (eraserMode || machineGunMode) return;

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
  }, [setSelectedBeat, setSelectedNotes, playing, freeMode, cellWidth, snapUnit, eraserMode, machineGunMode, totalCols, barSubdivisions]);

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

    const handleMouseMove = (moveE) => {
      if (!draggingRef.current) return;
      const dx = moveE.clientX - draggingRef.current.startX;
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

    const handleMouseUp = () => {
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
  }, [notes, setNotesDrag, saveSnapshot, commitDrag, selectedNotes, freeMode, snapUnit, onResizeDuration]);

  const handleNoteContextMenu = useCallback((e, noteIndex) => {
    e.preventDefault();
    e.stopPropagation();
    setNotes(prev => prev.filter((_, i) => i !== noteIndex));
    setSelectedNotes(prev => {
      if (!prev.has(noteIndex)) return prev;
      const next = new Set();
      prev.forEach(i => {
        if (i < noteIndex) next.add(i);
        else if (i > noteIndex) next.add(i - 1);
      });
      return next;
    });
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

    const handleMouseMove = (moveE) => {
      if (!noteDragRef.current) return;
      const d = noteDragRef.current;

      const dx = moveE.clientX - d.startX;
      const dy = moveE.clientY - d.startY;
      if (!d.didMove && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      d.didMove = true;

      const anchorBarIdx = beatToBar(d.startBeat, barSubdivisions).barIndex;
      const anchorCw = colWidth(anchorBarIdx, barSubdivisions, cellWidth);
      const deltaBeat = dx / anchorCw;

      const scrollTop = bodyRef.current.scrollTop;
      const mouseY = moveE.clientY - d.gridTop + scrollTop;
      const rowFromTop = Math.floor(mouseY / ROW_HEIGHT);
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
      d.isDuplicate = moveE.altKey;
      setDragPreview({
        affectedIndices: d.affectedIndices,
        deltaBeat,
        deltaRow,
        isDuplicate: moveE.altKey,
      });
    };

    const handleMouseUp = () => {
      const d = noteDragRef.current;
      if (d && d.didMove) {
        const { affectedIndices, startPositions, lastDeltaBeat, lastDeltaRow } = d;
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
      }
      setDragPreview(null);
      noteDragRef.current = null;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [notes, setNotes, selectedNotes, freeMode]);

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
        loopDragRef.current = { mode: 'new', startCol, didMove: false };
        setLoopStart(startCol);
        setLoopEnd(startCol + snap);
      }
    } else {
      const startCol = snapBeat(xToBeat(x, barSubdivisions, cellWidth, false));
      if (startCol < 0 || startCol >= totalCols) return;
      loopDragRef.current = { mode: 'new', startCol, didMove: false };
      setLoopStart(startCol);
      setLoopEnd(startCol + snap);
    }

    e.preventDefault();

    const handleMouseMove = (moveE) => {
      if (!loopDragRef.current) return;
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
        if (d.mode === 'new' && !d.didMove) {
          const ux = upE.clientX - rect.left + (bodyRef.current ? bodyRef.current.scrollLeft : scrollLeft);
          const rawBeat = xToBeat(ux, barSubdivisions, cellWidth, false);
          const beat = free ? rawBeat : snapBeat(rawBeat);
          setSelectedBeat(Math.max(0, Math.min(totalCols - 1, beat)));
          setLoop(false);
        } else if (d.mode === 'new' && d.didMove) {
          setLoop(true);
          setSelectedBeat(Math.min(d.startCol, d.lastCol));
        } else if (d.mode === 'move' && !d.didMove) {
          setLoop(false);
        }
      }
      loopDragRef.current = null;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [setLoopStart, setLoopEnd, setLoop, setSelectedBeat, loop, loopStart, loopEnd, cellWidth, totalCols, barSubdivisions, freeMode, snapUnit]);

  // Machine gun: convert mouse Y to string+fret
  // Marquee selection / machine gun on grid background
  const handleGridMouseDown = useCallback((e) => {
    if (e.target.closest('.timeline-note')) return;
    if (e.button !== 0) return;

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
    if (!eraserMode && !cursorModeRef.current && !e.shiftKey) {
      let beat;
      if (freeMode) {
        beat = xToBeat(x, barSubdivisions, cellWidth, false);
      } else {
        const rawBeat = xToBeat(x, barSubdivisions, cellWidth, false);
        beat = Math.round(rawBeat / snapUnit) * snapUnit;
      }
      if (beat >= 0 && beat < totalCols) {
        const combo = yToPitch(y);
        if (combo) {
          const finalBeat = Math.round(beat * 10000) / 10000;
          // Check if toggling off an existing note
          let toggled = false;
          setNotes(prev => {
            const exact = prev.findIndex(n =>
              n.stringIndex === combo.stringIndex && n.fret === combo.fret &&
              Math.abs(n.beat - finalBeat) < 0.001
            );
            if (exact >= 0) { toggled = true; return prev.filter((_, i) => i !== exact); }
            const filtered = prev.filter(n =>
              !(n.stringIndex === combo.stringIndex && Math.abs(n.beat - finalBeat) < 0.001)
            );
            return [...filtered, {
              stringIndex: combo.stringIndex,
              fret: combo.fret,
              beat: finalBeat,
              duration: noteDuration,
              velocity: defaultVelocity,
            }];
          });
          setSelectedBeat(beat);
          setSelectedNotes(new Set());
          playNote(combo.stringIndex, combo.fret, 0.2);
          marqueeDidDragRef.current = true; // prevent handleClick from also firing

          if (!toggled) {
            // Start drag-to-resize the newly placed note
            const isFree = freeMode;
            const snap = snapUnit;
            const startX = e.clientX;
            let didDrag = false;
            saveSnapshot();

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
              setNotes(prev => prev.map(n =>
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

    // Normal marquee selection
    marqueeRef.current = { startX: x, startY: y, didMove: false };
    if (!e.shiftKey) {
      setSelectedNotes(new Set());
    }

    const handleMouseMove = (moveE) => {
      if (!marqueeRef.current) return;
      const mx = moveE.clientX - rect.left + bodyRef.current.scrollLeft;
      const my = moveE.clientY - rect.top + bodyRef.current.scrollTop;
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
        const noteBottom = noteTop + ROW_HEIGHT;

        if (noteRight > x1 && noteLeft < x2 && noteBottom > y1 && noteTop < y2) {
          selected.add(i);
        }
      });
      setSelectedNotes(prev => {
        if (moveE.shiftKey) {
          const merged = new Set(prev);
          selected.forEach(i => merged.add(i));
          return merged;
        }
        return selected;
      });
    };

    const handleMouseUp = () => {
      // In eraser mode, delete all notes that were selected by the marquee
      if (eraserMode && marqueeRef.current && marqueeRef.current.didMove) {
        setSelectedNotes(prev => {
          if (prev.size > 0) {
            setNotes(old => old.filter((_, i) => !prev.has(i)));
          }
          return new Set();
        });
      }
      marqueeRef.current = null;
      setMarquee(null);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [playing, notes, setSelectedNotes, eraserMode, setNotes, machineGunMode, noteDuration, saveSnapshot, yToPitch, freeMode, snapUnit, cellWidth, barSubdivisions, totalCols, defaultVelocity, setSelectedBeat]);

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
    const noteBottom = noteTop + ROW_HEIGHT;
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

  // Scroll zoom — use document-level to prevent browser zoom
  const hotkeysRef = useRef(hotkeys);
  hotkeysRef.current = hotkeys;
  useEffect(() => {
    const handleWheel = (e) => {
      const hk = hotkeysRef.current;
      if (!hk || !matchesWheelHotkey(e, hk.zoomWheel)) return;
      if (!bodyRef.current) return;
      const rect = bodyRef.current.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right ||
          e.clientY < rect.top || e.clientY > rect.bottom) return;
      e.preventDefault();
      setTimelineZoom(z => {
        const newZ = z * (1 - e.deltaY * 0.005);
        return Math.max(0.2, Math.min(40, newZ));
      });
    };
    document.addEventListener('wheel', handleWheel, { passive: false });
    return () => document.removeEventListener('wheel', handleWheel);
  }, [setTimelineZoom]);

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
        const noteBottom = noteTop + ROW_HEIGHT;
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

  // Shift+wheel to pan horizontally, plain wheel scrolls vertically only
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const handleWheel = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return; // let zoom/velocity handlers take over
      if (e.shiftKey) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
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

  // Build piano roll rows from unique pitches (top = highest, bottom = lowest)
  const pianoRows = [];
  for (let r = totalRows - 1; r >= 0; r--) {
    const midi = pitchRowToMidi(r);
    const name = midiToNoteName(midi);
    const noteLetter = name.replace(/[0-9]/g, '');
    const isBlack = BLACK_NOTES.has(noteLetter);
    const isC = noteLetter === 'C';
    pianoRows.push({ pitchRow: r, midi, name, isBlack, isC });
  }

  return (
    <div className="timeline-container">
      {/* Header row: piano spacer + bar numbers */}
      <div style={{ display: 'flex', flexShrink: 0 }}>
        <div className="piano-spacer" />
        <div className="timeline-header" ref={headerRef} onMouseDown={handleHeaderMouseDown} style={{ flex: 1 }}
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
                  const scrollLeft = bodyRef.current ? bodyRef.current.scrollLeft : 0;

                  const handleMove = (moveE) => {
                    const x = moveE.clientX - headerRect.left + scrollLeft;
                    const rawBeat = xToBeat(x, barSubdivisions, cellWidth, false);
                    const beat = freeMode ? rawBeat : Math.round(rawBeat / snapUnit) * snapUnit;
                    const clamped = Math.max(0, Math.min(totalCols - 1, beat));
                    setSelectedBeat(clamped);
                  };
                  const handleUp = () => {
                    window.removeEventListener('mousemove', handleMove);
                    window.removeEventListener('mouseup', handleUp);
                  };
                  window.addEventListener('mousemove', handleMove);
                  window.addEventListener('mouseup', handleUp);
                }}
              />
            )}
            {/* Playhead in header */}
            {currentBeat !== null && playing && (
              <div className="header-playhead" style={{ left: beatToX(currentBeat, barSubdivisions, cellWidth) }} />
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
          <div className="piano-roll-inner" style={{ height: GRID_TOTAL_HEIGHT }}>
            {pianoRows.map((row, i) => {
              const isHovered = hoveredNote &&
                noteToPitchRow(hoveredNote.stringIndex, hoveredNote.fret) === row.pitchRow;
              const isChordRoot = chordRoot &&
                noteToPitchRow(chordRoot.stringIndex, chordRoot.fret) === row.pitchRow;
              const combos = pitchRowCombos(row.pitchRow);
              // Pick the combo with lowest fret (first position playing)
              const repCombo = combos.reduce((best, c) => (!best || c.fret < best.fret) ? c : best, null);
              return (
                <div
                  key={i}
                  className={`piano-key ${row.isBlack ? 'black' : 'white'} ${isHovered ? 'hovered' : ''} ${isChordRoot ? 'chord-root' : ''}`}
                  style={{
                    height: ROW_HEIGHT,
                    borderTop: row.isC ? '1px solid #555' : undefined,
                  }}
                  onMouseEnter={() => {
                    if (repCombo) {
                      setHoveredNote({ stringIndex: repCombo.stringIndex, fret: repCombo.fret });
                      if (hoverPreviewPiano) playNote(repCombo.stringIndex, repCombo.fret, 0.15, hoverVolume);
                    }
                  }}
                  onClick={() => {
                    if (repCombo && setChordRoot) {
                      // Toggle: click same key to deselect
                      if (chordRoot && noteToPitchRow(chordRoot.stringIndex, chordRoot.fret) === row.pitchRow) {
                        setChordRoot(null);
                      } else {
                        setChordRoot({ stringIndex: repCombo.stringIndex, fret: repCombo.fret });
                      }
                    }
                  }}
                >
                  <span className="piano-key-label">{row.name}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Grid body */}
        <div
          className="timeline-body"
          ref={bodyRef}
          onClick={handleClick}
          onMouseDown={handleGridMouseDown}
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
            const pos = { beat: snapped, stringIndex: combo.stringIndex, fret: combo.fret };
            setHoverPos(pos);
            if (onTimelineHover) onTimelineHover(pos);
          }}
          onMouseLeave={() => {
            setHoverPos(null);
            if (onTimelineHover) onTimelineHover(null);
          }}
          onScroll={(e) => { setVerticalScroll(e.target.scrollTop); setHeaderScrollLeft(e.target.scrollLeft); }}
          style={{ flex: 1, cursor: machineGunMode ? 'cell' : eraserMode ? 'crosshair' : undefined }}
        >
        <div className="timeline-grid" style={{ width: gridWidth, height: GRID_TOTAL_HEIGHT }}>
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

          {/* Octave separator lines at each C note */}
          {pianoRows.filter(r => r.isC).map(r => (
            <div
              key={`oct-${r.pitchRow}`}
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: pitchRowTopPx(r.pitchRow),
                height: '1px',
                background: '#444',
                zIndex: 1,
              }}
            />
          ))}

          {/* Hovered row highlight */}
          {hoveredNote && (
            <div style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: rowTopPx(hoveredNote.stringIndex, hoveredNote.fret),
              height: ROW_HEIGHT,
              background: 'rgba(100, 160, 255, 0.15)',
              pointerEvents: 'none',
              zIndex: 1,
            }} />
          )}

          {/* Vertical bar lines */}
          {Array.from({ length: totalCols }, (_, i) => (
            <div
              key={`col-${i}`}
              className={`grid-col ${starts.includes(i) ? 'bar-line' : ''}`}
              style={{ left: beatToX(i, barSubdivisions, cellWidth) }}
            />
          ))}

          {/* Tuplet subdivision lines */}
          {tupletLines.visible && subdivisions > 1 && Array.from({ length: totalCols }, (_, beat) => {
            const lines = [];
            for (let t = 1; t < subdivisions; t++) {
              const subBeat = beat + (t / subdivisions);
              if (subBeat >= totalCols) break;
              lines.push(
                <div
                  key={`tup-${beat}-${t}`}
                  className="grid-col tuplet-line"
                  style={{
                    left: beatToX(subBeat, barSubdivisions, cellWidth),
                    borderLeftColor: `rgba(230, 126, 34, ${tupletLines.opacity})`,
                  }}
                />
              );
            }
            return lines;
          })}


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

          {/* Cursor hover rectangle showing duration at mouse position */}
          {hoverPos && !playing && !cursorMode && (
            <div
              className="cursor-hover-rect"
              style={{
                left: beatToX(hoverPos.beat, barSubdivisions, cellWidth),
                top: rowTopPx(hoverPos.stringIndex, hoverPos.fret),
                width: durationToWidth(hoverPos.beat, noteDuration, barSubdivisions, cellWidth),
                height: ROW_HEIGHT,
              }}
            />
          )}

          {/* Duration preview on hovered row */}
          {hoveredNote && selectedBeat !== null && !playing && (
            <div
              className="duration-preview"
              style={{
                left: beatToX(selectedBeat, barSubdivisions, cellWidth),
                top: rowTopPx(hoveredNote.stringIndex, hoveredNote.fret),
                width: durationToWidth(selectedBeat, noteDuration, barSubdivisions, cellWidth),
                height: ROW_HEIGHT,
              }}
            />
          )}

          {/* Chord preview (blinking) */}
          {chordPreview && selectedBeat !== null && !playing && chordPreview.map((cn, i) => (
            <div
              key={`cp-${i}`}
              className="chord-preview-note"
              style={{
                left: beatToX(selectedBeat + (cn.beatOffset || 0), barSubdivisions, cellWidth),
                top: rowTopPx(cn.stringIndex, cn.fret),
                width: durationToWidth(selectedBeat + (cn.beatOffset || 0), cn.duration || noteDuration, barSubdivisions, cellWidth),
                height: ROW_HEIGHT,
              }}
            />
          ))}

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
                  height: ROW_HEIGHT,
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
            const color = getNoteColor(note.stringIndex, note.fret);
            return (
              <div key={`blur-${i}`} style={{
                position: 'absolute',
                left: beatToX(note.beat, barSubdivisions, cellWidth) + 1,
                top: topPx,
                width: noteWidth,
                height: ROW_HEIGHT,
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
            const color = getNoteColor(note.stringIndex, note.fret);
            const vel = note.velocity ?? 0.8;

            const isGhost = note.ghost;
            const hasBend = note.bend && note.bend > 0;
            const hasSlide = note.slideTo != null;

            return (
              <div
                key={i}
                className={`timeline-note ${selectedNotes.has(i) ? 'selected' : ''} ${isPlaying ? 'playing' : ''} ${isGhost ? 'ghost' : ''}`}
                style={{
                  left: beatToX(note.beat, barSubdivisions, cellWidth) + 1,
                  top: topPx,
                  width: noteWidth,
                  height: ROW_HEIGHT,
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
                  height: ROW_HEIGHT,
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
            <div className={`marquee-rect ${eraserMode ? 'eraser' : ''}`} style={{
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
          {currentBeat !== null && playing && (
            <div className="playhead" style={{ left: beatToX(currentBeat, barSubdivisions, cellWidth) }} />
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
