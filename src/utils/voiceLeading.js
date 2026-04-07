import { NUM_STRINGS, NUM_FRETS } from './constants';
import { getMidiNote } from './pitchMap';

const OPEN_STRING_MIDI = [40, 45, 50, 55, 59, 64];
const MAX_FRET_SPAN = 4;
const MAX_FRETTED_FINGERS = 4;

// Generate all valid guitar voicings for a set of MIDI notes
export function generateVoicings(midiNotes) {
  // For each MIDI note, find all (string, fret) options
  const options = midiNotes.map(midi => {
    const combos = [];
    for (let s = 0; s < NUM_STRINGS; s++) {
      const fret = midi - OPEN_STRING_MIDI[s];
      if (fret >= 0 && fret <= NUM_FRETS) combos.push({ stringIndex: s, fret });
    }
    return combos;
  });

  const results = [];

  function search(noteIdx, usedStrings, placed) {
    if (noteIdx === midiNotes.length) {
      // Validate constraints
      const frets = placed.map(p => p.fret);
      const frettedFrets = frets.filter(f => f > 0);

      // Max fretted fingers (barres count as 1)
      const uniqueFrettedPositions = new Set(frettedFrets);
      // Count fingers: each unique fret position needs at least 1 finger
      // But we need to be smarter: group by fret, each fret = 1 finger (barre)
      const fretGroups = {};
      placed.forEach(p => {
        if (p.fret > 0) {
          if (!fretGroups[p.fret]) fretGroups[p.fret] = 0;
          fretGroups[p.fret]++;
        }
      });
      const fingersNeeded = Object.keys(fretGroups).length;
      if (fingersNeeded > MAX_FRETTED_FINGERS) return;

      // Max fret span
      if (frettedFrets.length > 0) {
        const minFret = Math.min(...frettedFrets);
        const maxFret = Math.max(...frettedFrets);
        if (maxFret - minFret > MAX_FRET_SPAN) return;
      }

      results.push([...placed]);
      return;
    }

    for (const combo of options[noteIdx]) {
      if (usedStrings.has(combo.stringIndex)) continue;

      // Early pruning: check span with already placed
      const frettedSoFar = [...placed.map(p => p.fret), combo.fret].filter(f => f > 0);
      if (frettedSoFar.length > 0 && Math.max(...frettedSoFar) - Math.min(...frettedSoFar) > MAX_FRET_SPAN) continue;

      usedStrings.add(combo.stringIndex);
      placed.push({ ...combo, midi: midiNotes[noteIdx] });
      search(noteIdx + 1, usedStrings, placed);
      placed.pop();
      usedStrings.delete(combo.stringIndex);
    }
  }

  search(0, new Set(), []);
  return results;
}

// Score a voicing against a previous voicing (lower = better)
export function scoreVoicing(prevVoicing, newVoicing) {
  let score = 0;

  // Build lookup: midi -> { stringIndex, fret } from previous voicing
  const prevByMidi = new Map();
  const prevByString = new Map();
  prevVoicing.forEach(v => {
    prevByMidi.set(v.midi, v);
    prevByString.set(v.stringIndex, v);
  });

  newVoicing.forEach(nv => {
    // Check if same pitch existed in prev
    const prevSamePitch = prevByMidi.get(nv.midi);
    if (prevSamePitch && prevSamePitch.stringIndex === nv.stringIndex && prevSamePitch.fret === nv.fret) {
      // Common tone, same position — perfect, 0 cost
      return;
    }

    // Check if same string was used in prev
    const prevSameString = prevByString.get(nv.stringIndex);
    if (prevSameString) {
      // Same string, different fret — cost = fret distance
      score += Math.abs(nv.fret - prevSameString.fret);
    } else {
      // Different string — penalty
      score += 3;
      // Plus minimum fret distance to any prev note
      let minDist = Infinity;
      prevVoicing.forEach(pv => {
        minDist = Math.min(minDist, Math.abs(nv.fret - pv.fret));
      });
      if (minDist < Infinity) score += minDist;
    }
  });

  return score;
}

// Find the best N voicings for a chord, given the previous voicing
export function findBestVoicings(prevVoicing, targetMidiNotes, count = 5) {
  const voicings = generateVoicings(targetMidiNotes);
  if (voicings.length === 0) return [];

  // Score each against the previous voicing
  const scored = voicings.map(v => ({
    voicing: v,
    score: scoreVoicing(prevVoicing, v),
  }));

  // Sort by score (lowest first) and return top N
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, count);
}

// Group selected notes by beat into chords
export function groupNotesIntoChords(notes) {
  const beatMap = new Map();
  notes.forEach(note => {
    const beatKey = Math.round(note.beat * 10000) / 10000;
    if (!beatMap.has(beatKey)) beatMap.set(beatKey, []);
    beatMap.get(beatKey).push(note);
  });

  // Sort by beat
  const chords = [...beatMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([beat, notes]) => ({
      beat,
      notes,
      midiNotes: notes.map(n => getMidiNote(n.stringIndex, n.fret)),
      voicing: notes.map(n => ({
        stringIndex: n.stringIndex,
        fret: n.fret,
        midi: getMidiNote(n.stringIndex, n.fret),
      })),
    }));

  return chords;
}
