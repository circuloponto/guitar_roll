import { useRef, useState, useEffect, useCallback } from 'react';
import {
  NUM_STRINGS, NUM_FRETS, NUM_BARS, SUBDIVISIONS,
  CELL_WIDTH, BAR_WIDTH, STRING_COLORS
} from '../utils/constants';
import { getNoteName } from '../utils/audio';

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
  notes, setNotes, currentBeat, selectedBeat, setSelectedBeat,
  playing, eraser, onDeleteNote,
  loopStart, loopEnd, setLoopStart, setLoopEnd, loop,
  selectedNotes, setSelectedNotes,
}) {
  const bodyRef = useRef(null);
  const headerRef = useRef(null);
  const totalRows = NUM_STRINGS * TOTAL_FRETS_PER_STRING;
  const gridWidth = totalCols * CELL_WIDTH;
  const draggingRef = useRef(null);   // resize drag
  const noteDragRef = useRef(null);   // note move drag
  const [dragPreview, setDragPreview] = useState(null); // { noteIndex, beat, stringIndex, fret }
  const loopDragRef = useRef(null);

  const handleClick = useCallback((e) => {
    if (playing) return;
    if (eraser && e.target.closest('.timeline-note')) return;
    if (draggingRef.current || noteDragRef.current) return;
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

    const handleMouseMove = (moveE) => {
      if (!draggingRef.current) return;
      const dx = moveE.clientX - draggingRef.current.startX;
      const dBeats = Math.round(dx / CELL_WIDTH);
      const { affectedIndices, startDurations } = draggingRef.current;

      setNotes(prev => prev.map((n, i) => {
        if (!affectedIndices.includes(i)) return n;
        const baseDuration = startDurations.get(i);
        const newDuration = Math.max(1, baseDuration + dBeats);
        const maxDuration = totalCols - n.beat;
        return { ...n, duration: Math.min(newDuration, maxDuration) };
      }));
    };

    const handleMouseUp = () => {
      setTimeout(() => { draggingRef.current = null; }, 0);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [notes, setNotes, selectedNotes]);

  const handleNoteDragStart = useCallback((e, noteIndex) => {
    if (eraser || e.shiftKey) return;
    e.stopPropagation();
    e.preventDefault();
    const note = notes[noteIndex];
    const rect = bodyRef.current.getBoundingClientRect();
    const gridTop = rect.top;
    const gridHeight = rect.height;

    noteDragRef.current = {
      noteIndex,
      startX: e.clientX,
      startY: e.clientY,
      startBeat: note.beat,
      startStringIndex: note.stringIndex,
      startFret: note.fret,
      gridTop,
      gridHeight,
      didMove: false,
    };
    setDragPreview({ noteIndex, beat: note.beat, stringIndex: note.stringIndex, fret: note.fret });

    const handleMouseMove = (moveE) => {
      if (!noteDragRef.current) return;
      const d = noteDragRef.current;

      const dx = moveE.clientX - d.startX;
      const dy = moveE.clientY - d.startY;
      if (!d.didMove && Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      d.didMove = true;

      const dBeats = Math.round(dx / CELL_WIDTH);
      const newBeat = Math.max(0, Math.min(totalCols - (notes[d.noteIndex].duration || 1), d.startBeat + dBeats));

      const scrollTop = bodyRef.current.scrollTop;
      const mouseY = moveE.clientY - d.gridTop + scrollTop;
      const rowHeight = d.gridHeight * (1 / totalRows);
      const rowFromTop = Math.floor(mouseY / rowHeight);
      const row = totalRows - 1 - rowFromTop; // invert: bottom = low strings
      const clampedRow = Math.max(0, Math.min(totalRows - 1, row));
      const newStringIndex = Math.floor(clampedRow / TOTAL_FRETS_PER_STRING);
      const newFret = clampedRow % TOTAL_FRETS_PER_STRING;

      setDragPreview({ noteIndex: d.noteIndex, beat: newBeat, stringIndex: newStringIndex, fret: newFret });
    };

    const handleMouseUp = () => {
      const d = noteDragRef.current;
      if (d && d.didMove) {
        setDragPreview(prev => {
          if (prev) {
            setNotes(old => {
              // Remove any note at the destination position
              const filtered = old.filter((n, i) =>
                i === d.noteIndex || !(n.stringIndex === prev.stringIndex && n.fret === prev.fret && n.beat === prev.beat)
              );
              return filtered.map(n =>
                n === old[d.noteIndex]
                  ? { ...n, beat: prev.beat, stringIndex: prev.stringIndex, fret: prev.fret }
                  : n
              );
            });
          }
          return null;
        });
      } else {
        setDragPreview(null);
      }
      noteDragRef.current = null;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [notes, setNotes, eraser]);

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

  return (
    <div className={`timeline-container ${eraser ? 'eraser-mode' : ''}`}>
      {/* Header with bar numbers + loop region */}
      <div className="timeline-header" ref={headerRef} onMouseDown={handleHeaderMouseDown}>
        {/* Loop region highlight in header */}
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

      {/* Grid body */}
      <div
        className="timeline-body"
        ref={bodyRef}
        onClick={handleClick}
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

          {/* String labels on the left edge */}
          {Array.from({ length: NUM_STRINGS }, (_, i) => (
            <div
              key={`label-${i}`}
              style={{
                position: 'absolute',
                left: 2,
                bottom: `${((i + 0.5) / NUM_STRINGS) * 100}%`,
                transform: 'translateY(50%)',
                fontSize: '10px',
                color: STRING_COLORS[i],
                fontWeight: 'bold',
                zIndex: 5,
                pointerEvents: 'none',
              }}
            >
              {['E', 'A', 'D', 'G', 'B', 'e'][i]}
            </div>
          ))}

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

          {/* Notes */}
          {notes.map((note, i) => {
            const isDragging = dragPreview && dragPreview.noteIndex === i;
            if (isDragging) return null;
            const topPercent = rowTopPercent(note.stringIndex, note.fret, totalRows);
            const heightPercent = rowHeightPercent(totalRows);
            const duration = note.duration || 1;
            const noteWidth = duration * CELL_WIDTH - 2;
            const isPlaying = playing && currentBeat !== null &&
              currentBeat >= note.beat && currentBeat < note.beat + duration;

            return (
              <div
                key={i}
                className={`timeline-note string-${note.stringIndex} ${eraser ? 'erasable' : ''} ${selectedNotes.has(i) ? 'selected' : ''} ${isPlaying ? 'playing' : ''}`}
                style={{
                  left: note.beat * CELL_WIDTH + 1,
                  top: `${topPercent}%`,
                  width: noteWidth,
                  height: `${heightPercent}%`,
                  minHeight: 4,
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

          {/* Drag preview note */}
          {dragPreview && (() => {
            const note = notes[dragPreview.noteIndex];
            if (!note) return null;
            const topPercent = rowTopPercent(dragPreview.stringIndex, dragPreview.fret, totalRows);
            const heightPercent = rowHeightPercent(totalRows);
            const duration = note.duration || 1;
            const noteWidth = duration * CELL_WIDTH - 2;
            return (
              <div
                className={`timeline-note string-${dragPreview.stringIndex}`}
                style={{
                  left: dragPreview.beat * CELL_WIDTH + 1,
                  top: `${topPercent}%`,
                  width: noteWidth,
                  height: `${heightPercent}%`,
                  minHeight: 4,
                  opacity: 0.7,
                  zIndex: 20,
                  pointerEvents: 'none',
                }}
              >
                {getNoteName(dragPreview.stringIndex, dragPreview.fret)}
              </div>
            );
          })()}

          {/* Playhead */}
          {currentBeat !== null && playing && (
            <div className="playhead" style={{ left: currentBeat * CELL_WIDTH }} />
          )}
        </div>
      </div>
    </div>
  );
}
