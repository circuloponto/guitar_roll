import { useRef, useState, useEffect, useCallback } from 'react';
import {
  NUM_STRINGS, NUM_FRETS, NUM_BARS, SUBDIVISIONS,
  CELL_WIDTH, BAR_WIDTH
} from '../utils/constants';
import { getNoteName, playNote } from '../utils/audio';

const BLACK_NOTES = new Set(['C#', 'D#', 'F#', 'G#', 'A#']);

const totalCols = NUM_BARS * SUBDIVISIONS;
const TOTAL_FRETS_PER_STRING = NUM_FRETS + 1;

// Convert stringIndex + fret to a bottom-up row position (bass at bottom)
function rowTopPercent(stringIndex, fret, totalRows) {
  const row = stringIndex * TOTAL_FRETS_PER_STRING + fret;
  return ((totalRows - 1 - row) / totalRows) * 100;
}

function rowHeightPercent(totalRows) {
  return (1 / totalRows) * 100;
}

export default function Timeline({
  notes, setNotes, saveSnapshot, setNotesDrag, commitDrag,
  currentBeat, selectedBeat, setSelectedBeat,
  playing, eraser, onDeleteNote,
  loopStart, loopEnd, setLoopStart, setLoopEnd, loop,
  selectedNotes, setSelectedNotes, stringColors, getNoteColor,
  hoveredNote, setHoveredNote,
}) {
  const bodyRef = useRef(null);
  const headerRef = useRef(null);
  const totalRows = NUM_STRINGS * TOTAL_FRETS_PER_STRING;
  const gridWidth = totalCols * CELL_WIDTH;
  const draggingRef = useRef(null);   // resize drag
  const noteDragRef = useRef(null);   // note move drag
  const [dragPreview, setDragPreview] = useState(null);
  const loopDragRef = useRef(null);
  const marqueeRef = useRef(null);
  const marqueeDidDragRef = useRef(false);
  const [marquee, setMarquee] = useState(null); // { x1, y1, x2, y2 } in px relative to grid

  const handleClick = useCallback((e) => {
    if (playing) return;
    if (eraser && e.target.closest('.timeline-note')) return;
    if (draggingRef.current || noteDragRef.current) return;
    if (marqueeDidDragRef.current) { marqueeDidDragRef.current = false; return; }
    if (!e.shiftKey) {
      setSelectedNotes(new Set());
    }
    const rect = bodyRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + bodyRef.current.scrollLeft;
    const col = Math.floor(x / CELL_WIDTH);
    if (col >= 0 && col < totalCols) {
      setSelectedBeat(col);
    }
  }, [setSelectedBeat, setSelectedNotes, playing, eraser]);

  const handleNoteClick = useCallback((e, noteIndex) => {
    if (eraser) {
      e.stopPropagation();
      onDeleteNote(noteIndex);
      return;
    }
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
  }, [eraser, onDeleteNote, setSelectedNotes]);

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

    const handleMouseMove = (moveE) => {
      if (!draggingRef.current) return;
      const dx = moveE.clientX - draggingRef.current.startX;
      const dBeats = Math.round(dx / CELL_WIDTH);
      const { affectedIndices, startDurations } = draggingRef.current;

      setNotesDrag(prev => prev.map((n, i) => {
        if (!affectedIndices.includes(i)) return n;
        const baseDuration = startDurations.get(i);
        const newDuration = Math.max(1, baseDuration + dBeats);
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
  }, [notes, setNotesDrag, saveSnapshot, commitDrag, selectedNotes]);

  const handleNoteDragStart = useCallback((e, noteIndex) => {
    if (eraser || e.shiftKey) return;
    e.stopPropagation();
    e.preventDefault();
    const note = notes[noteIndex];
    const rect = bodyRef.current.getBoundingClientRect();
    const gridTop = rect.top;
    const gridHeight = rect.height;

    // Determine which notes are being dragged
    const isSelected = selectedNotes.has(noteIndex);
    const affectedIndices = isSelected && selectedNotes.size > 1 ? [...selectedNotes] : [noteIndex];
    const startPositions = new Map(
      affectedIndices.map(i => [i, { beat: notes[i].beat, stringIndex: notes[i].stringIndex, fret: notes[i].fret }])
    );
    const anchorRow = note.stringIndex * TOTAL_FRETS_PER_STRING + note.fret;

    noteDragRef.current = {
      noteIndex,
      affectedIndices,
      startPositions,
      anchorRow,
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
      gridHeight,
      didMove: false,
    };
    // Preview for all affected notes
    setDragPreview({
      affectedIndices,
      deltaBeat: 0,
      deltaRow: 0,
    });

    const handleMouseMove = (moveE) => {
      if (!noteDragRef.current) return;
      const d = noteDragRef.current;

      const dx = moveE.clientX - d.startX;
      const dy = moveE.clientY - d.startY;
      if (!d.didMove && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      d.didMove = true;

      const deltaBeat = Math.round(dx / CELL_WIDTH);

      const scrollTop = bodyRef.current.scrollTop;
      const mouseY = moveE.clientY - d.gridTop + scrollTop;
      const rowHeight = d.gridHeight * (1 / totalRows);
      const rowFromTop = Math.floor(mouseY / rowHeight);
      const currentRow = totalRows - 1 - rowFromTop;
      const deltaRow = currentRow - d.anchorRow;

      // Play sound when anchor note pitch changes
      const anchorNewRow = Math.max(0, Math.min(totalRows - 1, d.anchorRow + deltaRow));
      const newStringIndex = Math.floor(anchorNewRow / TOTAL_FRETS_PER_STRING);
      const newFret = anchorNewRow % TOTAL_FRETS_PER_STRING;
      if (newStringIndex !== d.lastSoundString || newFret !== d.lastSoundFret) {
        playNote(newStringIndex, newFret, 0.2);
        d.lastSoundString = newStringIndex;
        d.lastSoundFret = newFret;
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
          const oldRow = start.stringIndex * TOTAL_FRETS_PER_STRING + start.fret;
          const newRow = Math.max(0, Math.min(totalRows - 1, oldRow + lastDeltaRow));
          const newStringIndex = Math.floor(newRow / TOTAL_FRETS_PER_STRING);
          const newFret = newRow % TOTAL_FRETS_PER_STRING;
          const newBeat = Math.max(0, Math.min(totalCols - (n.duration || 1), start.beat + lastDeltaBeat));
          return { ...n, beat: newBeat, stringIndex: newStringIndex, fret: newFret };
        }));
      }
      setDragPreview(null);
      noteDragRef.current = null;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [notes, setNotes, eraser, selectedNotes]);

  // Loop region drag on header
  const handleHeaderMouseDown = useCallback((e) => {
    const rect = headerRef.current.getBoundingClientRect();
    const scrollLeft = bodyRef.current ? bodyRef.current.scrollLeft : 0;
    const x = e.clientX - rect.left + scrollLeft;
    const startCol = Math.floor(x / CELL_WIDTH);

    if (startCol < 0 || startCol >= totalCols) return;

    loopDragRef.current = { startCol };
    setLoopStart(startCol);
    setLoopEnd(startCol + 1);

    const handleMouseMove = (moveE) => {
      if (!loopDragRef.current) return;
      const mx = moveE.clientX - rect.left + scrollLeft;
      const col = Math.max(0, Math.min(totalCols, Math.round(mx / CELL_WIDTH)));
      const anchor = loopDragRef.current.startCol;

      if (col >= anchor) {
        setLoopStart(anchor);
        setLoopEnd(Math.max(col, anchor + 1));
      } else {
        setLoopStart(col);
        setLoopEnd(anchor + 1);
      }
    };

    const handleMouseUp = () => {
      loopDragRef.current = null;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [setLoopStart, setLoopEnd]);

  // Marquee selection on grid background
  const handleGridMouseDown = useCallback((e) => {
    if (playing || eraser) return;
    if (e.target.closest('.timeline-note')) return;
    if (e.button !== 0) return;

    const rect = bodyRef.current.getBoundingClientRect();
    const scrollLeft = bodyRef.current.scrollLeft;
    const x = e.clientX - rect.left + scrollLeft;
    const y = e.clientY - rect.top;

    marqueeRef.current = { startX: x, startY: y, didMove: false };
    if (!e.shiftKey) {
      setSelectedNotes(new Set());
    }

    const handleMouseMove = (moveE) => {
      if (!marqueeRef.current) return;
      const mx = moveE.clientX - rect.left + bodyRef.current.scrollLeft;
      const my = moveE.clientY - rect.top;
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
      const gridHeight = rect.height;
      const selected = new Set();
      notes.forEach((note, i) => {
        const noteLeft = note.beat * CELL_WIDTH;
        const noteRight = noteLeft + (note.duration || 1) * CELL_WIDTH;
        const row = note.stringIndex * TOTAL_FRETS_PER_STRING + note.fret;
        const noteTopFrac = (totalRows - 1 - row) / totalRows;
        const noteBottomFrac = (totalRows - row) / totalRows;
        const noteTop = noteTopFrac * gridHeight;
        const noteBottom = noteBottomFrac * gridHeight;

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
  }, [playing, eraser, notes, setSelectedNotes, totalRows]);

  // Auto-scroll to playhead during playback
  useEffect(() => {
    if (playing && bodyRef.current && currentBeat !== null) {
      const playheadX = currentBeat * CELL_WIDTH;
      const container = bodyRef.current;
      const scrollLeft = container.scrollLeft;
      const visibleWidth = container.clientWidth;

      if (playheadX > scrollLeft + visibleWidth - 100 || playheadX < scrollLeft) {
        container.scrollLeft = playheadX - 100;
      }
    }
  }, [currentBeat, playing]);

  const loopLeftPx = loopStart * CELL_WIDTH;
  const loopWidthPx = (loopEnd - loopStart) * CELL_WIDTH;

  // Build piano roll rows (bottom-up: row 0 = bottom = string 0 fret 0)
  const pianoRows = [];
  for (let s = 0; s < NUM_STRINGS; s++) {
    for (let f = 0; f < TOTAL_FRETS_PER_STRING; f++) {
      const name = getNoteName(s, f);
      const noteLetter = name.replace(/[0-9]/g, '');
      const isBlack = BLACK_NOTES.has(noteLetter);
      pianoRows.push({ stringIndex: s, fret: f, name, isBlack });
    }
  }
  // Reverse so index 0 is bottom (low notes)
  pianoRows.reverse();

  return (
    <div className={`timeline-container ${eraser ? 'eraser-mode' : ''}`}>
      {/* Header row: piano spacer + bar numbers */}
      <div style={{ display: 'flex' }}>
        <div className="piano-spacer" />
        <div className="timeline-header" ref={headerRef} onMouseDown={handleHeaderMouseDown} style={{ flex: 1 }}>
          <div
            className="loop-region-header"
            style={{ left: loopLeftPx, width: loopWidthPx }}
          />
          {Array.from({ length: NUM_BARS }, (_, i) => (
            <div
              key={i}
              className="bar-number"
              style={{ left: i * BAR_WIDTH }}
            >
              {i + 1}
            </div>
          ))}
        </div>
      </div>

      {/* Body row: piano roll + grid */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Piano roll */}
        <div className="piano-roll" onMouseLeave={() => setHoveredNote(null)}>
          {pianoRows.map((row, i) => {
            const isHovered = hoveredNote &&
              hoveredNote.stringIndex === row.stringIndex &&
              hoveredNote.fret === row.fret;
            return (
              <div
                key={i}
                className={`piano-key ${row.isBlack ? 'black' : 'white'} ${isHovered ? 'hovered' : ''}`}
                style={{
                  height: `${100 / totalRows}%`,
                  borderBottom: row.fret === 0 ? `1px solid ${stringColors[row.stringIndex]}` : undefined,
                }}
                onMouseEnter={() => setHoveredNote({ stringIndex: row.stringIndex, fret: row.fret })}
              >
                <span className="piano-key-label">{row.name}</span>
              </div>
            );
          })}
        </div>

        {/* Grid body */}
        <div
          className="timeline-body"
          ref={bodyRef}
          onClick={handleClick}
          onMouseDown={handleGridMouseDown}
          style={{ flex: 1 }}
        >
        <div className="timeline-grid" style={{ width: gridWidth }}>
          {/* Loop region highlight in grid */}
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

          {/* Row lines for each string group */}
          {Array.from({ length: NUM_STRINGS }, (_, i) => (
            <div
              key={`string-sep-${i}`}
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: `${(i / NUM_STRINGS) * 100}%`,
                height: '1px',
                background: '#333',
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
              top: `${rowTopPercent(hoveredNote.stringIndex, hoveredNote.fret, totalRows)}%`,
              height: `${rowHeightPercent(totalRows)}%`,
              background: 'rgba(100, 160, 255, 0.15)',
              pointerEvents: 'none',
              zIndex: 1,
            }} />
          )}

          {/* Vertical bar lines */}
          {Array.from({ length: totalCols }, (_, i) => (
            <div
              key={`col-${i}`}
              className={`grid-col ${i % SUBDIVISIONS === 0 ? 'bar-line' : ''}`}
              style={{ left: i * CELL_WIDTH }}
            />
          ))}

          {/* Selected beat highlight */}
          {selectedBeat !== null && (
            <div
              className="timeline-selected-col"
              style={{ left: selectedBeat * CELL_WIDTH, width: CELL_WIDTH }}
            />
          )}

          {/* Note blur glows */}
          {notes.map((note, i) => {
            const isDragging = dragPreview && dragPreview.affectedIndices.includes(i);
            if (isDragging) return null;
            const topPercent = rowTopPercent(note.stringIndex, note.fret, totalRows);
            const heightPercent = rowHeightPercent(totalRows);
            const duration = note.duration || 1;
            const noteWidth = duration * CELL_WIDTH - 2;
            const color = getNoteColor(note.stringIndex, note.fret);
            return (
              <div key={`blur-${i}`} style={{
                position: 'absolute',
                left: note.beat * CELL_WIDTH + 1,
                top: `${topPercent}%`,
                width: noteWidth,
                height: `${heightPercent}%`,
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
            const topPercent = rowTopPercent(note.stringIndex, note.fret, totalRows);
            const heightPercent = rowHeightPercent(totalRows);
            const duration = note.duration || 1;
            const noteWidth = duration * CELL_WIDTH - 2;
            const isPlaying = playing && currentBeat !== null &&
              currentBeat >= note.beat && currentBeat < note.beat + duration;
            const color = getNoteColor(note.stringIndex, note.fret);

            return (
              <div
                key={i}
                className={`timeline-note ${eraser ? 'erasable' : ''} ${selectedNotes.has(i) ? 'selected' : ''} ${isPlaying ? 'playing' : ''}`}
                style={{
                  left: note.beat * CELL_WIDTH + 1,
                  top: `${topPercent}%`,
                  width: noteWidth,
                  height: `${heightPercent}%`,
                  minHeight: 4,
                  backgroundColor: color,
                  boxShadow: isPlaying ? `0 0 12px 4px ${color}, inset 0 0 6px rgba(255,255,255,0.3)` : undefined,
                }}
                title={`${getNoteName(note.stringIndex, note.fret)} (${duration})`}
                onClick={(e) => handleNoteClick(e, i)}
                onMouseDown={(e) => handleNoteDragStart(e, i)}
              >
                {getNoteName(note.stringIndex, note.fret)}
                {!eraser && (
                  <div
                    className="note-resize-handle"
                    onMouseDown={(e) => handleResizeStart(e, i)}
                  />
                )}
              </div>
            );
          })}

          {/* Drag preview notes */}
          {dragPreview && dragPreview.affectedIndices.map(idx => {
            const note = notes[idx];
            if (!note) return null;
            const oldRow = note.stringIndex * TOTAL_FRETS_PER_STRING + note.fret;
            const newRow = Math.max(0, Math.min(totalRows - 1, oldRow + dragPreview.deltaRow));
            const newStringIndex = Math.floor(newRow / TOTAL_FRETS_PER_STRING);
            const newFret = newRow % TOTAL_FRETS_PER_STRING;
            const newBeat = Math.max(0, Math.min(totalCols - (note.duration || 1), note.beat + dragPreview.deltaBeat));
            const topPercent = rowTopPercent(newStringIndex, newFret, totalRows);
            const heightPercent = rowHeightPercent(totalRows);
            const duration = note.duration || 1;
            const noteWidth = duration * CELL_WIDTH - 2;
            return (
              <div
                key={`preview-${idx}`}
                className="timeline-note"
                style={{
                  left: newBeat * CELL_WIDTH + 1,
                  backgroundColor: getNoteColor(newStringIndex, newFret),
                  top: `${topPercent}%`,
                  width: noteWidth,
                  height: `${heightPercent}%`,
                  minHeight: 4,
                  opacity: 0.7,
                  zIndex: 20,
                  pointerEvents: 'none',
                }}
              >
                {getNoteName(newStringIndex, newFret)}
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
            <div className="playhead" style={{ left: currentBeat * CELL_WIDTH }} />
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
