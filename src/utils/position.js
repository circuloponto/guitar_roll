import { NUM_STRINGS, NUM_FRETS } from './constants';
import { getMidiNote } from './pitchMap';

const WINDOW = 4;
const overlaps = (a, b) =>
  a.beat < b.beat + (b.duration || 1) && b.beat < a.beat + (a.duration || 1);

// Re-finger the selected notes so chords sit inside the window [pos, pos+4].
// Notes that start together are voiced as a unit: every note gets its own
// string (also avoiding strings held by overlapping notes). Within that
// constraint we minimise distance outside the window (outliers land as close
// as possible), then prefer fewer changes to the existing fingering.
function refingerExact(notes, selected, pos) {
  const result = notes.slice();
  const groups = new Map();
  [...selected].sort((a, b) => a - b).forEach((i) => {
    if (!notes[i]) return;
    const k = notes[i].beat;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  });

  const winDist = (f) => (f < pos ? pos - f : f > pos + WINDOW ? f - pos - WINDOW : 0);

  for (const idxs of [...groups.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1])) {
    // Strings held by notes sounding during this group that we don't move now.
    const taken = (n) => {
      const used = new Set();
      result.forEach((o, j) => {
        if (idxs.includes(j) || !o) return;
        // Selected notes that start at other times (melody notes whose durations run into each
        // other) never block each other - only notes we are NOT moving hold their strings.
        if (selected.has(j)) return;
        if (overlaps(n, o)) used.add(o.stringIndex);
      });
      return used;
    };
    // Highest pitch first so constrained notes pick before flexible ones.
    const order = idxs.slice().sort((a, b) =>
      getMidiNote(notes[b].stringIndex, notes[b].fret) - getMidiNote(notes[a].stringIndex, notes[a].fret));

    const opts = order.map((i) => {
      const n = notes[i];
      const midi = getMidiNote(n.stringIndex, n.fret);
      const blocked = taken(n);
      const list = [];
      for (let s = 0; s < NUM_STRINGS; s++) {
        const f = midi - getMidiNote(s, 0);
        if (f < 0 || f > NUM_FRETS || blocked.has(s)) continue;
        list.push({ s, f, cost: winDist(f) * 100 + (s === n.stringIndex ? 0 : 1) });
      }
      return list;
    });

    let best = null;
    const cur = [];
    const search = (k, used, cost) => {
      if (best && cost >= best.cost) return;
      if (k === order.length) { best = { cost, pick: cur.slice() }; return; }
      for (const o of opts[k]) {
        if (used.has(o.s)) continue;
        used.add(o.s); cur[k] = o;
        search(k + 1, used, cost + o.cost);
        used.delete(o.s);
      }
    };
    if (order.length <= 8) search(0, new Set(), 0);
    if (!best) continue; // cannot voice the group on distinct strings: leave as is

    order.forEach((i, k) => {
      const p = best.pick[k];
      result[i] = { ...notes[i], stringIndex: p.s, fret: p.f };
    });
  }
  return result;
}

// ---- Chord voicing with inversions ------------------------------------------
// For chords (2-6 notes starting together) we may move notes by octaves and
// invert the chord so that every note can sit inside the window. Each chord
// note is tried as the bass in turn; the remaining notes are voiced above it on
// distinct strings. Cost (lower wins): outside-window distance dominates, then
// octave displacement, then deviating from the original bass note, then span.
const MAX_CHORD = 6;
const OUT_W = 100, OCT_W = 20, INV_W = 15, SPAN_W = 1, STR_W = 0.5;

function voiceChord(notes, idxs, pos, blockedFor) {
  const orig = idxs.map(i => ({ i, midi: getMidiNote(notes[i].stringIndex, notes[i].fret), s: notes[i].stringIndex }));
  const lowest = Math.min(...orig.map(o => o.midi));
  const winDist = (f) => (f < pos ? pos - f : f > pos + WINDOW ? f - pos - WINDOW : 0);

  // Candidate placements per note: same pitch class, any octave, any free string.
  const cands = orig.map((o) => {
    const blocked = blockedFor(notes[o.i]);
    const list = [];
    for (let s = 0; s < NUM_STRINGS; s++) {
      if (blocked.has(s)) continue;
      const base = getMidiNote(s, 0);
      for (let f = 0; f <= NUM_FRETS; f++) {
        const midi = base + f;
        if (((midi - o.midi) % 12 + 12) % 12 !== 0) continue;
        const d = winDist(f);
        if (d > 4) continue; // far outliers are never worth considering
        list.push({ s, f, midi, cost: d * OUT_W + (Math.abs(midi - o.midi) / 12) * OCT_W + (s === o.s ? 0 : STR_W) });
      }
    }
    return list;
  });

  let best = null;
  orig.forEach((bassNote, b) => {
    const invCost = bassNote.midi === lowest ? 0 : INV_W;
    const pick = [];
    const search = (k, used, cost, lo, hi) => {
      if (best && cost + invCost >= best.cost) return;
      if (k === orig.length) {
        const total = cost + invCost + (hi - lo) * SPAN_W;
        if (!best || total < best.cost) best = { cost: total, pick: pick.slice() };
        return;
      }
      const bassMidi = k > b ? pick[b].midi : -Infinity; // bass is placed before the others
      for (const c of (k === b ? cands[k] : cands[k])) {
        if (used.has(c.s)) continue;
        if (k !== b && b < k && c.midi < bassMidi) continue;
        used.add(c.s); pick[k] = c;
        search(k + 1, used, cost + c.cost, Math.min(lo, c.midi), Math.max(hi, c.midi));
        used.delete(c.s);
      }
    };
    // Place the bass first so the others can be constrained against it.
    const order = [b, ...orig.map((_, k) => k).filter(k => k !== b)];
    const reorder = (k, used, cost, lo, hi) => {
      if (best && cost + invCost >= best.cost) return;
      if (k === order.length) {
        const total = cost + invCost + (hi - lo) * SPAN_W;
        if (!best || total < best.cost) best = { cost: total, pick: orig.map((_, j) => pick[j]) };
        return;
      }
      const j = order[k];
      for (const c of cands[j]) {
        if (used.has(c.s)) continue;
        if (k > 0 && c.midi < pick[b].midi) continue;
        used.add(c.s); pick[j] = c;
        reorder(k + 1, used, cost + c.cost, Math.min(lo, c.midi), Math.max(hi, c.midi));
        used.delete(c.s);
      }
    };
    void search;
    reorder(0, new Set(), 0, Infinity, -Infinity);
  });
  return best ? orig.map((o, k) => ({ i: o.i, ...best.pick[k] })) : null;
}

export function refingerNotes(notes, selected, pos) {
  // Start from the pitch-preserving result (handles melodies, big groups and
  // chords that cannot be inverted), then upgrade chord groups with inversions.
  const result = refingerExact(notes, selected, pos);
  const groups = new Map();
  [...selected].sort((a, b) => a - b).forEach((i) => {
    if (!notes[i]) return;
    if (!groups.has(notes[i].beat)) groups.set(notes[i].beat, []);
    groups.get(notes[i].beat).push(i);
  });
  for (const [, idxs] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (idxs.length < 2 || idxs.length > MAX_CHORD) continue;
    const blockedFor = (n) => {
      const used = new Set();
      result.forEach((o, j) => { if (!idxs.includes(j) && !selected.has(j) && overlaps(n, o)) used.add(o.stringIndex); });
      return used;
    };
    const voiced = voiceChord(notes, idxs, pos, blockedFor);
    if (!voiced) continue;
    voiced.forEach(v => { result[v.i] = { ...notes[v.i], stringIndex: v.s, fret: v.f }; });
  }
  return result;
}

// How many of the selected notes sit inside the window [pos, pos+4] after re-fingering.
export function countInPosition(notes, selected, pos) {
  const out = refingerNotes(notes, selected, pos);
  let n = 0;
  selected.forEach((i) => { if (out[i] && out[i].fret >= pos && out[i].fret <= pos + WINDOW) n++; });
  return n;
}

// The position (0-20) that fits the most selected notes; ties go to the lowest.
export function bestPosition(notes, selected) {
  let best = 0, bestCount = -1;
  for (let p = 0; p <= 20; p++) {
    const c = countInPosition(notes, selected, p);
    if (c > bestCount) { best = p; bestCount = c; }
  }
  return { position: best, count: bestCount };
}

// Fingering for a pitch near the window (any string); null when the guitar cannot play it.
function placeNear(midi, pos) {
  let best = null;
  for (let st = 0; st < NUM_STRINGS; st++) {
    const f = midi - getMidiNote(st, 0);
    if (f < 0 || f > NUM_FRETS) continue;
    const d = f < pos ? pos - f : f > pos + WINDOW ? f - pos - WINDOW : 0;
    if (!best || d < best.d) best = { st, f, d };
  }
  return best;
}

// "Octave fit": move the whole selection up or down by whole octaves (one shift for all notes,
// so the melody keeps its shape) to the shift that puts the most notes inside the window
// [pos, pos+4]; ties go to the smallest shift. Returns { notes, shift } (shift in octaves).
export function refingerNotesOctave(notes, selected, pos) {
  let best = null;
  for (const k of [0, -1, 1, -2, 2, -3, 3]) {
    const moved = notes.slice();
    let ok = true;
    for (const i of selected) {
      const n = notes[i];
      if (!n) continue;
      const p = placeNear(getMidiNote(n.stringIndex, n.fret) + 12 * k, pos);
      if (!p) { ok = false; break; }
      moved[i] = { ...n, stringIndex: p.st, fret: p.f };
    }
    if (!ok) continue;
    const out = refingerNotes(moved, selected, pos);
    let count = 0;
    selected.forEach((i) => { if (out[i] && out[i].fret >= pos && out[i].fret <= pos + WINDOW) count++; });
    if (!best || count > best.count) best = { notes: out, shift: k, count };
  }
  return best || { notes: refingerNotes(notes, selected, pos), shift: 0, count: 0 };
}
