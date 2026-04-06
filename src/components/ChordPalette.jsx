import { useState } from 'react';
import { getNoteName, getNoteFrequency } from '../utils/audio';
import { getMidiNote, closestComboForPitch } from '../utils/pitchMap';
import { NUM_STRINGS, NUM_FRETS } from '../utils/constants';
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
  // Migrate old format chords (notes array) to new format (intervals) on load
  const [chords, setChords] = useState(() => {
    const raw = loadChordLibrary();
    return raw.filter(c => c.intervals || c.notes).map(c => {
      if (c.intervals) return c;
      // Migrate: old format had absolute notes, convert to intervals
      const midis = c.notes.map(n => getMidiNote(n.stringIndex, n.fret));
      const rootMidi = Math.min(...midis);
      return {
        ...c,
        intervals: c.notes.map((n, i) => ({
          semitones: midis[i] - rootMidi,
          duration: n.duration || 1,
          velocity: n.velocity ?? 0.8,
          beatOffset: n.beatOffset || 0,
        })),
      };
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
  // Compute root MIDI from hoveredNote or selector
  const getRootMidi = () => {
    if (chordRoot) return getMidiNote(chordRoot.stringIndex, chordRoot.fret);
    return 48 + rootNote; // C3 + offset
  };

  // Compute preview voicing for a chord (used for preview + stamp)
  const computeVoicing = (chord) => {
    if (!chord.intervals || chord.intervals.length === 0) return null;
    const rootMidi = getRootMidi();
    const midiNotes = chord.intervals.map(iv => rootMidi + iv.semitones);
    const voicing = voiceChord(midiNotes);
    if (!voicing) return null;
    return voicing.map((combo, i) => ({
      stringIndex: combo.stringIndex,
      fret: combo.fret,
      duration: noteDuration,
      velocity: chord.intervals[i].velocity,
      beatOffset: chord.intervals[i].beatOffset,
    }));
  };

  const handleStamp = (chord) => {
    const stampNotes = computeVoicing(chord);
    if (!stampNotes) return;
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
              onMouseEnter={() => onPreviewChange && onPreviewChange(computeVoicing(chord))}
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
              <span className="chord-note-count">{(chord.intervals || []).length}n</span>
            </button>
            <button className="chord-delete-btn" onClick={() => handleDelete(chord.id)} title="Delete">x</button>
          </div>
        ))}
      </div>
    </div>
  );
}
