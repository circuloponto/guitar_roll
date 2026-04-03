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
import { totalColumns, barStartBeats, beatToBar, beatLabel, isBarStart } from '../utils/barLayout';

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
  notes, setNotes, saveSnapshot, setNotesDrag, commitDrag, freeMode = false,
  timelineZoom = 1, setTimelineZoom,
  barSubdivisions, setBarSubdivisions,
  currentBeat, selectedBeat, setSelectedBeat,
  playing, onDeleteNote,
  loopStart, loopEnd, setLoopStart, setLoopEnd, loop,
  selectedNotes, setSelectedNotes, stringColors, getNoteColor,
  hoveredNote, setHoveredNote,
  verticalScroll, setVerticalScroll,
}) {
  const bodyRef = useRef(null);
  const headerRef = useRef(null);
  const [headerScrollLeft, setHeaderScrollLeft] = useState(0);
  const cellWidth = CELL_WIDTH * timelineZoom;
  const totalCols = totalColumns(barSubdivisions);
  const gridWidth = totalCols * cellWidth;
  const starts = barStartBeats(barSubdivisions);
  const draggingRef = useRef(null);   // resize drag
  const noteDragRef = useRef(null);   // note move drag
  const [dragPreview, setDragPreview] = useState(null);
  const loopDragRef = useRef(null);
  const marqueeRef = useRef(null);
  const marqueeDidDragRef = useRef(false);
  const [subdivMenu, setSubdivMenu] = useState(null); // { barIndex, x, y }
  const [marquee, setMarquee] = useState(null); // { x1, y1, x2, y2 } in px relative to grid

  const handleClick = useCallback((e) => {
    if (playing) return;
    if (draggingRef.current || noteDragRef.current) return;
    if (marqueeDidDragRef.current) { marqueeDidDragRef.current = false; return; }
    if (!e.shiftKey) {
      setSelectedNotes(new Set());
    }
    const rect = bodyRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + bodyRef.current.scrollLeft;
    if (freeMode) {
      const beat = x / cellWidth;
      if (beat >= 0 && beat < totalCols) {
        setSelectedBeat(beat);
      }
    } else {
      const col = Math.floor(x / cellWidth);
      if (col >= 0 && col < totalCols) {
        setSelectedBeat(col);
      }
    }
  }, [setSelectedBeat, setSelectedNotes, playing, freeMode, cellWidth]);

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

    const handleMouseMove = (moveE) => {
      if (!draggingRef.current) return;
      const dx = moveE.clientX - draggingRef.current.startX;
      const dBeats = dx / cellWidth;
      const { affectedIndices, startDurations } = draggingRef.current;

      setNotesDrag(prev => prev.map((n, i) => {
        if (!affectedIndices.includes(i)) return n;
        const baseDuration = startDurations.get(i);
        const rawDuration = baseDuration + dBeats;
        let newDuration = isFree ? Math.max(0.1, rawDuration) : Math.max(1, Math.round(rawDuration));
        const maxDuration = totalCols - n.beat;
        return { ...n, duration: Math.min(newDuration, maxDuration) };
      }));
    };

    const handleMouseUp = () => {
      commitDrag();
      setTimeout(() => { draggingRef.current = null; }, 0);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [notes, setNotesDrag, saveSnapshot, commitDrag, selectedNotes, freeMode]);

  const handleNoteDragStart = useCallback((e, noteIndex) => {
    if (e.shiftKey) return;
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
    });

    const isFree = freeMode;

    const handleMouseMove = (moveE) => {
      if (!noteDragRef.current) return;
      const d = noteDragRef.current;

      const dx = moveE.clientX - d.startX;
      const dy = moveE.clientY - d.startY;
      if (!d.didMove && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      d.didMove = true;

      const deltaBeat = dx / cellWidth;

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
      setDragPreview({
        affectedIndices: d.affectedIndices,
        deltaBeat,
        deltaRow,
      });
    };

    const handleMouseUp = () => {
      const d = noteDragRef.current;
      if (d && d.didMove) {
        const { affectedIndices, startPositions, lastDeltaBeat, lastDeltaRow } = d;
        setNotes(old => old.map((n, i) => {
          if (!affectedIndices.includes(i)) return n;
          const start = startPositions.get(i);
          const oldPitchRow = noteToPitchRow(start.stringIndex, start.fret);
          const newPitchRow = Math.max(0, Math.min(totalRows - 1, oldPitchRow + lastDeltaRow));
          const newMidi = pitchRowToMidi(newPitchRow);
          const combo = closestComboForPitch(newMidi, start.stringIndex);
          if (!combo) return n;
          const rawBeat = start.beat + lastDeltaBeat;
          const newBeat = Math.max(0, Math.min(totalCols - (n.duration || 1), isFree ? rawBeat : Math.round(rawBeat)));
          return { ...n, beat: newBeat, stringIndex: combo.stringIndex, fret: combo.fret };
        }));
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
    if (e.button !== 0) return; // left click only
    const rect = headerRef.current.getBoundingClientRect();
    const scrollLeft = bodyRef.current ? bodyRef.current.scrollLeft : 0;
    const x = e.clientX - rect.left + scrollLeft;

    if (!loop) return; // only handle loop drags when loop is on

    const edgeThreshold = Math.max(8, cellWidth * 0.5);
    const loopLeftX = loopStart * cellWidth;
    const loopRightX = loopEnd * cellWidth;
    const isNearLeft = Math.abs(x - loopLeftX) < edgeThreshold;
    const isNearRight = Math.abs(x - loopRightX) < edgeThreshold;
    const isInside = x > loopLeftX + edgeThreshold && x < loopRightX - edgeThreshold;
    const loopLen = loopEnd - loopStart;

    if (isNearLeft) {
      loopDragRef.current = { mode: 'left', fixedEnd: loopEnd };
    } else if (isNearRight) {
      loopDragRef.current = { mode: 'right', fixedStart: loopStart };
    } else if (isInside) {
      loopDragRef.current = { mode: 'move', startX: x, origStart: loopStart, origEnd: loopEnd, loopLen };
    } else {
      // Click outside loop — create new selection
      const startCol = Math.floor(x / cellWidth);
      if (startCol < 0 || startCol >= totalCols) return;
      loopDragRef.current = { mode: 'new', startCol };
      setLoopStart(startCol);
      setLoopEnd(startCol + 1);
    }

    e.preventDefault();

    const handleMouseMove = (moveE) => {
      if (!loopDragRef.current) return;
      const mx = moveE.clientX - rect.left + (bodyRef.current ? bodyRef.current.scrollLeft : scrollLeft);
      const col = Math.max(0, Math.min(totalCols, Math.round(mx / cellWidth)));
      const d = loopDragRef.current;

      if (d.mode === 'left') {
        setLoopStart(Math.min(col, d.fixedEnd - 1));
      } else if (d.mode === 'right') {
        setLoopEnd(Math.max(col, d.fixedStart + 1));
      } else if (d.mode === 'move') {
        const dx = mx - d.startX;
        const deltaCols = Math.round(dx / cellWidth);
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
          setLoopEnd(Math.max(col, anchor + 1));
        } else {
          setLoopStart(col);
          setLoopEnd(anchor + 1);
        }
      }
    };

    const handleMouseUp = () => {
      loopDragRef.current = null;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [setLoopStart, setLoopEnd, loop, loopStart, loopEnd, cellWidth, totalCols]);

  // Marquee selection on grid background
  const handleGridMouseDown = useCallback((e) => {
    if (e.target.closest('.timeline-note')) return;
    if (e.button !== 0) return;

    const rect = bodyRef.current.getBoundingClientRect();
    const scrollLeft = bodyRef.current.scrollLeft;
    const scrollTop = bodyRef.current.scrollTop;
    const x = e.clientX - rect.left + scrollLeft;
    const y = e.clientY - rect.top + scrollTop;

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
        const noteLeft = note.beat * cellWidth;
        const noteRight = noteLeft + (note.duration || 1) * cellWidth;
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
      marqueeRef.current = null;
      setMarquee(null);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [playing, notes, setSelectedNotes]);

  // Sync vertical scroll from external source (fretboard)
  useEffect(() => {
    if (bodyRef.current && Math.abs(bodyRef.current.scrollTop - verticalScroll) > 1) {
      bodyRef.current.scrollTop = verticalScroll;
    }
  }, [verticalScroll]);

  // Auto-scroll vertically to show hovered note
  useEffect(() => {
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
  }, [hoveredNote]);

  // Ctrl+scroll zoom — use document-level to prevent browser zoom
  useEffect(() => {
    const handleWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      // Only handle if the mouse is over the timeline body
      if (!bodyRef.current) return;
      const rect = bodyRef.current.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right ||
          e.clientY < rect.top || e.clientY > rect.bottom) return;
      e.preventDefault();
      setTimelineZoom(z => {
        const newZ = z * (1 - e.deltaY * 0.002);
        return Math.max(0.2, Math.min(4, newZ));
      });
    };
    document.addEventListener('wheel', handleWheel, { passive: false });
    return () => document.removeEventListener('wheel', handleWheel);
  }, [setTimelineZoom]);

  // Auto-scroll to playhead during playback
  useEffect(() => {
    if (playing && bodyRef.current && currentBeat !== null) {
      const playheadX = currentBeat * cellWidth;
      const container = bodyRef.current;
      const scrollLeft = container.scrollLeft;
      const visibleWidth = container.clientWidth;

      if (playheadX > scrollLeft + visibleWidth - 100 || playheadX < scrollLeft) {
        container.scrollLeft = playheadX - 100;
      }
    }
  }, [currentBeat, playing]);

  const loopLeftPx = loopStart * cellWidth;
  const loopWidthPx = (loopEnd - loopStart) * cellWidth;

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
            const loopLeftX = loopStart * cellWidth;
            const loopRightX = loopEnd * cellWidth;
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
            const beat = Math.floor(x / cellWidth);
            const { barIndex } = beatToBar(beat, barSubdivisions);
            setSubdivMenu({ barIndex, x: e.clientX, y: e.clientY });
          }}
        >
          <div style={{ position: 'relative', transform: `translateX(-${headerScrollLeft}px)`, width: gridWidth, height: '100%' }}>
            {loop && <div
              className="loop-region-header"
              style={{ left: loopLeftPx, width: loopWidthPx }}
            />}
            {/* Beat labels and bar lines */}
            {Array.from({ length: totalCols }, (_, i) => {
              const isBar = starts.includes(i);
              return (
                <div
                  key={i}
                  className={`bar-number ${isBar ? 'bar-start' : ''}`}
                  style={{ left: i * cellWidth }}
                >
                  {beatLabel(i, barSubdivisions)}
                </div>
              );
            })}
            {/* Selected beat indicator in header — draggable */}
            {selectedBeat !== null && !playing && (
              <div
                className="header-beat-marker"
                style={{ left: selectedBeat * cellWidth, cursor: 'ew-resize' }}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  const headerRect = headerRef.current.getBoundingClientRect();
                  const scrollLeft = bodyRef.current ? bodyRef.current.scrollLeft : 0;

                  const handleMove = (moveE) => {
                    const x = moveE.clientX - headerRect.left + scrollLeft;
                    const beat = freeMode ? x / cellWidth : Math.floor(x / cellWidth);
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
              <div className="header-playhead" style={{ left: currentBeat * cellWidth }} />
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
              const combos = pitchRowCombos(row.pitchRow);
              // Pick the combo with lowest fret (first position playing)
              const repCombo = combos.reduce((best, c) => (!best || c.fret < best.fret) ? c : best, null);
              return (
                <div
                  key={i}
                  className={`piano-key ${row.isBlack ? 'black' : 'white'} ${isHovered ? 'hovered' : ''}`}
                  style={{
                    height: ROW_HEIGHT,
                    borderTop: row.isC ? '1px solid #555' : undefined,
                  }}
                  onMouseEnter={() => repCombo && setHoveredNote({ stringIndex: repCombo.stringIndex, fret: repCombo.fret })}
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
          onScroll={(e) => { setVerticalScroll(e.target.scrollTop); setHeaderScrollLeft(e.target.scrollLeft); }}
          style={{ flex: 1 }}
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
              style={{ left: i * cellWidth }}
            />
          ))}

          {/* Selected beat highlight */}
          {selectedBeat !== null && (
            freeMode && selectedBeat % 1 !== 0 ? (
              <div
                className="timeline-selected-line"
                style={{ left: selectedBeat * cellWidth }}
              />
            ) : (
              <div
                className="timeline-selected-col"
                style={{ left: Math.floor(selectedBeat) * cellWidth, width: cellWidth }}
              />
            )
          )}

          {/* Note blur glows */}
          {notes.map((note, i) => {
            const isDragging = dragPreview && dragPreview.affectedIndices.includes(i);
            if (isDragging) return null;
            const topPx = rowTopPx(note.stringIndex, note.fret);
            const duration = note.duration || 1;
            const noteWidth = duration * cellWidth - 2;
            const color = getNoteColor(note.stringIndex, note.fret);
            return (
              <div key={`blur-${i}`} style={{
                position: 'absolute',
                left: note.beat * cellWidth + 1,
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
            const isDragging = dragPreview && dragPreview.affectedIndices.includes(i);
            if (isDragging) return null;
            const topPx = rowTopPx(note.stringIndex, note.fret);
            const duration = note.duration || 1;
            const noteWidth = duration * cellWidth - 2;
            const isPlaying = playing && currentBeat !== null &&
              currentBeat >= note.beat && currentBeat < note.beat + duration;
            const color = getNoteColor(note.stringIndex, note.fret);

            return (
              <div
                key={i}
                className={`timeline-note ${selectedNotes.has(i) ? 'selected' : ''} ${isPlaying ? 'playing' : ''}`}
                style={{
                  left: note.beat * cellWidth + 1,
                  top: topPx,
                  width: noteWidth,
                  height: ROW_HEIGHT,
                  minHeight: 4,
                  backgroundColor: color,
                  boxShadow: isPlaying ? `0 0 12px 4px ${color}, inset 0 0 6px rgba(255,255,255,0.3)` : undefined,
                }}
                title={`${getNoteName(note.stringIndex, note.fret)} (${duration})`}
                onClick={(e) => handleNoteClick(e, i)}
                onMouseDown={(e) => handleNoteDragStart(e, i)}
              >
                {getNoteName(note.stringIndex, note.fret)}
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
            const noteWidth = duration * cellWidth - 2;
            return (
              <div
                key={`preview-${idx}`}
                className="timeline-note"
                style={{
                  left: newBeat * cellWidth + 1,
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
            <div className="marquee-rect" style={{
              left: marquee.x1,
              top: marquee.y1,
              width: marquee.x2 - marquee.x1,
              height: marquee.y2 - marquee.y1,
            }} />
          )}

          {/* Playhead */}
          {currentBeat !== null && playing && (
            <div className="playhead" style={{ left: currentBeat * cellWidth }} />
          )}
        </div>
      </div>
      </div>

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
                  setBarSubdivisions(prev => {
                    const next = [...prev];
                    next[barIdx] = n;
                    return next;
                  });
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
