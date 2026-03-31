import { useRef, useEffect, useCallback } from 'react';
import {
  NUM_STRINGS, NUM_FRETS, NUM_BARS, SUBDIVISIONS,
  CELL_WIDTH, BAR_WIDTH, STRING_COLORS
} from '../utils/constants';
import { getNoteName } from '../utils/audio';

const totalCols = NUM_BARS * SUBDIVISIONS;

export default function Timeline({
  notes, setNotes, currentBeat, selectedBeat, setSelectedBeat,
  playing, eraser, onDeleteNote,
  loopStart, loopEnd, setLoopStart, setLoopEnd, loop,
}) {
  const bodyRef = useRef(null);
  const headerRef = useRef(null);
  const totalRows = NUM_STRINGS * (NUM_FRETS + 1);
  const gridWidth = totalCols * CELL_WIDTH;
  const draggingRef = useRef(null);
  const loopDragRef = useRef(null);

  const handleClick = useCallback((e) => {
    if (playing) return;
    if (eraser && e.target.closest('.timeline-note')) return;
    if (draggingRef.current) return;
    const rect = bodyRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + bodyRef.current.scrollLeft;
    const col = Math.floor(x / CELL_WIDTH);
    if (col >= 0 && col < totalCols) {
      setSelectedBeat(col);
    }
  }, [setSelectedBeat, playing, eraser]);

  const handleNoteClick = useCallback((e, noteIndex) => {
    if (!eraser) return;
    e.stopPropagation();
    onDeleteNote(noteIndex);
  }, [eraser, onDeleteNote]);

  const handleResizeStart = useCallback((e, noteIndex) => {
    e.stopPropagation();
    e.preventDefault();
    const note = notes[noteIndex];
    draggingRef.current = {
      noteIndex,
      startX: e.clientX,
      startDuration: note.duration || 1,
    };

    const handleMouseMove = (moveE) => {
      if (!draggingRef.current) return;
      const dx = moveE.clientX - draggingRef.current.startX;
      const dBeats = Math.round(dx / CELL_WIDTH);
      const newDuration = Math.max(1, draggingRef.current.startDuration + dBeats);
      const maxDuration = totalCols - note.beat;
      const clampedDuration = Math.min(newDuration, maxDuration);

      setNotes(prev => prev.map((n, i) =>
        i === draggingRef.current.noteIndex
          ? { ...n, duration: clampedDuration }
          : n
      ));
    };

    const handleMouseUp = () => {
      setTimeout(() => { draggingRef.current = null; }, 0);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [notes, setNotes]);

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
                top: `${(i / NUM_STRINGS) * 100}%`,
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
                top: `${((i + 0.5) / NUM_STRINGS) * 100}%`,
                transform: 'translateY(-50%)',
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
            const row = note.stringIndex * (NUM_FRETS + 1) + note.fret;
            const topPercent = (row / totalRows) * 100;
            const heightPercent = (1 / totalRows) * 100;
            const duration = note.duration || 1;
            const noteWidth = duration * CELL_WIDTH - 2;

            return (
              <div
                key={i}
                className={`timeline-note string-${note.stringIndex} ${eraser ? 'erasable' : ''}`}
                style={{
                  left: note.beat * CELL_WIDTH + 1,
                  top: `${topPercent}%`,
                  width: noteWidth,
                  height: `${heightPercent}%`,
                  minHeight: 4,
                }}
                title={`${getNoteName(note.stringIndex, note.fret)} (${duration})`}
                onClick={(e) => handleNoteClick(e, i)}
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

          {/* Playhead */}
          {currentBeat !== null && playing && (
            <div className="playhead" style={{ left: currentBeat * CELL_WIDTH }} />
          )}
        </div>
      </div>
    </div>
  );
}
