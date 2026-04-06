import { useState } from 'react';
import { getNoteName } from '../utils/audio';
import { getMidiNote } from '../utils/pitchMap';
import { NUM_FRETS } from '../utils/constants';
import { loadChordLibrary, saveChordLibrary } from '../utils/storage';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const OPEN_STRING_MIDI = [40, 45, 50, 55, 59, 64]; // E2 A2 D3 G3 B3 E4

// Extract chord shape — stores string, fret, and interval from root
function captureChordShape(noteList) {
  const midis = noteList.map(n => getMidiNote(n.stringIndex, n.fret));
  const rootMidi = Math.min(...midis);
  return {
    rootMidi,
    rootName: NOTE_NAMES[rootMidi % 12],
    voices: noteList.map((n, i) => ({
      stringIndex: n.stringIndex,
      fret: n.fret,
      semitones: midis[i] - rootMidi,
      duration: n.duration || 1,
      velocity: n.velocity ?? 0.8,
      beatOffset: n.beatOffset || 0,
    })),
  };
}

// Transpose a chord shape by shifting all frets by a semitone delta
// Returns null if any fret goes out of range
function transposeShape(voices, semitoneDelta) {
  const transposed = voices.map(v => {
    const newFret = v.fret + semitoneDelta;
    if (newFret < 0 || newFret > NUM_FRETS) return null;
    return { ...v, fret: newFret };
  });
  if (transposed.some(v => v === null)) return null;
  return transposed;
}

export default function ChordPalette({ notes, selectedNotes, selectedBeat, onStampChord, onPreviewChange, chordRoot, noteDuration = 1 }) {
  // Migrate old format chords on load
  const [chords, setChords] = useState(() => {
    const raw = loadChordLibrary();
    return raw.filter(c => c.voices || c.intervals || c.notes).map(c => {
      if (c.voices) return c; // current format
      // Migrate from old formats
      const srcNotes = c.intervals || c.notes || [];
      const noteList = srcNotes.map(n => {
        if (n.stringIndex !== undefined) return n;
        return { stringIndex: 0, fret: n.semitones || 0, duration: n.duration || 1, velocity: n.velocity ?? 0.8, beatOffset: n.beatOffset || 0 };
      });
      const { rootMidi, voices } = captureChordShape(noteList);
      return { ...c, voices, rootMidi };
    });
  });
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [rootNote, setRootNote] = useState(0); // MIDI offset 0-11 (C=0, C#=1, ...)

  const persist = (updated) => {
    setChords(updated);
    saveChordLibrary(updated);
  };

  // Save chord from selected notes — captures exact voicing shape
  const handleSaveFromSelection = () => {
    if (!selectedNotes || selectedNotes.size === 0) return;
    const selected = notes.filter((_, i) => selectedNotes.has(i));
    if (selected.length === 0) return;
    const minBeat = Math.min(...selected.map(n => n.beat));
    const withOffsets = selected.map(n => ({ ...n, beatOffset: n.beat - minBeat }));
    const { rootMidi, rootName, voices } = captureChordShape(withOffsets);
    const name = rootName + ' chord';
    persist([...chords, { id: crypto.randomUUID(), name, voices, rootMidi }]);
  };

  // Save chord from notes at current beat
  const handleSaveFromBeat = () => {
    const beatNotes = notes.filter(n => selectedBeat >= n.beat && selectedBeat < n.beat + (n.duration || 1));
    if (beatNotes.length === 0) return;
    const minBeat = Math.min(...beatNotes.map(n => n.beat));
    const withOffsets = beatNotes.map(n => ({ ...n, beatOffset: n.beat - minBeat }));
    const { rootMidi, rootName, voices } = captureChordShape(withOffsets);
    const name = rootName + ' chord';
    persist([...chords, { id: crypto.randomUUID(), name, voices, rootMidi }]);
  };

  const handleDelete = (id) => {
    persist(chords.filter(c => c.id !== id));
  };

  // Stamp chord: transpose intervals to selected root and find voicing
  // Compute root MIDI from clicked piano key or selector
  const getRootMidi = () => {
    if (chordRoot) return getMidiNote(chordRoot.stringIndex, chordRoot.fret);
    return 48 + rootNote; // C3 + offset
  };

  // Transpose chord shape to target root, preserving voicing
  const computeTransposed = (chord) => {
    const voices = chord.voices;
    if (!voices || voices.length === 0) return null;
    if (typeof voices[0].fret !== 'number') return null;
    const targetMidi = getRootMidi();
    const originalRoot = chord.rootMidi;
    if (typeof originalRoot !== 'number') {
      // No root stored — stamp as-is with current noteDuration
      return voices.map(v => ({
        stringIndex: v.stringIndex,
        fret: v.fret,
        duration: noteDuration,
        velocity: v.velocity ?? 0.8,
        beatOffset: v.beatOffset || 0,
      }));
    }
    const delta = targetMidi - originalRoot;
    const transposed = transposeShape(voices, delta);
    if (!transposed) return null;
    return transposed.map(v => ({
      stringIndex: v.stringIndex,
      fret: v.fret,
      duration: noteDuration,
      velocity: v.velocity ?? 0.8,
      beatOffset: v.beatOffset || 0,
    }));
  };

  const handleStamp = (chord) => {
    const stampNotes = computeTransposed(chord);
    if (!stampNotes || stampNotes.length === 0) return;
    onStampChord(stampNotes);
  };

  const startRename = (chord) => {
    setEditingId(chord.id);
    setEditName(chord.name);
  };

  const commitRename = () => {
    if (editingId && editName.trim()) {
      persist(chords.map(c => c.id === editingId ? { ...c, name: editName.trim() } : c));
    }
    setEditingId(null);
  };

  return (
    <div className="chord-palette">
      <div className="chord-palette-header">
        <span className="chord-palette-title">Chords</span>
        <button className="chord-save-btn" onClick={handleSaveFromSelection} title="Save selected notes as chord quality">
          + Sel
        </button>
        <button className="chord-save-btn" onClick={handleSaveFromBeat} title="Save notes at beat as chord quality">
          + Beat
        </button>
      </div>
      {/* Root note selector */}
      <div className="chord-root-selector">
        {NOTE_NAMES.map((name, i) => (
          <button
            key={name}
            className={`chord-root-btn ${i === rootNote ? 'active' : ''}`}
            onClick={() => setRootNote(i)}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="chord-palette-list">
        {chords.length === 0 && (
          <div className="chord-empty">Select notes and click "+ Sel" or "+ Beat" to capture a chord quality.</div>
        )}
        {chords.map(chord => (
          <div key={chord.id} className="chord-item">
            <button
              className="chord-stamp-btn"
              onClick={() => handleStamp(chord)}
              onMouseEnter={() => onPreviewChange && onPreviewChange(computeTransposed(chord))}
              onMouseLeave={() => onPreviewChange && onPreviewChange(null)}
              title={`Stamp as ${NOTE_NAMES[rootNote]} (or hovered note)`}
            >
              {editingId === chord.id ? (
                <input
                  className="chord-name-input"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') setEditingId(null);
                    e.stopPropagation();
                  }}
                  onClick={(e) => e.stopPropagation()}
                  autoFocus
                />
              ) : (
                <span onDoubleClick={(e) => { e.stopPropagation(); startRename(chord); }}>
                  {chord.name}
                </span>
              )}
              <span className="chord-note-count">{(chord.voices || chord.intervals || []).length}n</span>
            </button>
            <button className="chord-delete-btn" onClick={() => handleDelete(chord.id)} title="Delete">x</button>
          </div>
        ))}
      </div>
    </div>
  );
}
