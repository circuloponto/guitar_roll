// Inserting and removing whole bars, and copying a stretch of the song. Everything that lives on the
// beat grid moves together: notes, audio clips (cut where needed), markers, the loop region and the
// per-bar subdivision list. Sync points stay as they are: they belong to the recording, not the grid.
//
// A "doc" is { tracks, subs, markers, loopStart, loopEnd }. `mapOf(track)` gives the beat/time map
// used to cut audio clips (tempoMap.forTrack).
import { getClips, clipBeatToTime, clipEndBeat, newClip, MIN_CLIP_SEC } from './audioClips';
import { barStartBeats } from './barLayout';

const EPS = 1e-6;

export const totalBeatsOf = (subs) => subs.reduce((a, b) => a + b, 0);

// the bar that contains `beat` (clamped)
export function barIndexAt(subs, beat) {
  const starts = barStartBeats(subs);
  let i = 0;
  for (let k = 0; k < starts.length; k++) if (starts[k] <= beat + EPS) i = k;
  return i;
}
// first bar boundary at or after `beat`: an index in [0, subs.length]
export function barBoundaryAtOrAfter(subs, beat) {
  const starts = barStartBeats(subs);
  for (let k = 0; k < starts.length; k++) if (starts[k] >= beat - EPS) return k;
  return subs.length;
}
export const beatOfBar = (subs, bar) => (bar >= subs.length ? totalBeatsOf(subs) : barStartBeats(subs)[bar]);

// the end of the last note or audio clip, in beats
export function contentEnd(tracks, mapOf) {
  let e = 0;
  tracks.forEach((t) => {
    if (t.type === 'audio') {
      const m = mapOf(t);
      getClips(t).forEach((c) => { e = Math.max(e, clipEndBeat(c, m)); });
    } else t.notes.forEach((n) => { e = Math.max(e, n.beat + n.duration); });
  });
  return e;
}

// ---- copying a stretch [s, e) ----
export function copyRange(tracks, s, e, mapOf) {
  const notes = {}, clips = {};
  tracks.forEach((t) => {
    if (t.type === 'audio') {
      const m = mapOf(t);
      const pieces = [];
      getClips(t).forEach((c) => {
        const cs = Math.max(c.start, s), ce = Math.min(clipEndBeat(c, m), e);
        if (ce - cs < EPS) return;
        const a = clipBeatToTime(c, cs, m), b = clipBeatToTime(c, ce, m);
        if (b - a < MIN_CLIP_SEC) return;
        pieces.push({ rel: cs - s, srcStart: a, srcEnd: b });
      });
      if (pieces.length) clips[t.id] = pieces;
    } else {
      const list = t.notes.filter(n => n.beat >= s - EPS && n.beat < e - EPS).map(n => ({ ...n, beat: n.beat - s }));
      if (list.length) notes[t.id] = list;
    }
  });
  return { len: e - s, notes, clips };
}

// ---- making room / closing a gap, in beats ----
function shiftClipsInsert(track, at, L, mapOf) {
  const m = mapOf(track);
  const out = [];
  getClips(track).forEach((c) => {
    const end = clipEndBeat(c, m);
    if (end <= at + EPS) out.push(c);
    else if (c.start >= at - EPS) out.push({ ...c, start: c.start + L });
    else {
      const cut = clipBeatToTime(c, at, m);
      if (cut - c.srcStart < MIN_CLIP_SEC || c.srcEnd - cut < MIN_CLIP_SEC) { out.push(c.start + (end - c.start) / 2 < at ? c : { ...c, start: c.start + L }); return; }
      out.push({ ...c, srcEnd: cut });
      out.push(newClip(at + L, cut, c.srcEnd));
    }
  });
  return out;
}

function shiftClipsRemove(track, s, e, mapOf) {
  const L = e - s;
  const m = mapOf(track);
  const out = [];
  getClips(track).forEach((c) => {
    const end = clipEndBeat(c, m);
    if (end <= s + EPS) { out.push(c); return; }
    if (c.start >= e - EPS) { out.push({ ...c, start: c.start - L }); return; }
    const leftKeeps = c.start < s - EPS;
    const rightKeeps = end > e + EPS;
    if (leftKeeps) {
      const cut = clipBeatToTime(c, s, m);
      if (cut - c.srcStart >= MIN_CLIP_SEC) out.push({ ...c, srcEnd: cut });
    }
    if (rightKeeps) {
      const from = clipBeatToTime(c, e, m);
      if (c.srcEnd - from >= MIN_CLIP_SEC) out.push(leftKeeps ? newClip(s, from, c.srcEnd) : { ...c, start: s, srcStart: from });
    }
  });
  return out;
}

const mapPosInsert = (p, at, L) => (p >= at - EPS ? p + L : p);
const mapPosRemove = (p, s, e) => (p >= e - EPS ? p - (e - s) : (p > s ? s : p));

// Insert bars (their subdivisions `newSubs`) before bar index `atBar`. Returns a new doc.
export function insertBars(doc, atBar, newSubs, mapOf) {
  const at = beatOfBar(doc.subs, atBar);
  const L = totalBeatsOf(newSubs);
  const subs = [...doc.subs.slice(0, atBar), ...newSubs, ...doc.subs.slice(atBar)];
  const tracks = doc.tracks.map((t) => (t.type === 'audio'
    ? { ...t, clips: shiftClipsInsert(t, at, L, mapOf) }
    : { ...t, notes: t.notes.map(n => (n.beat >= at - EPS ? { ...n, beat: n.beat + L } : n)) }));
  return {
    ...doc, subs, tracks,
    markers: doc.markers.map(m => ({ ...m, beat: mapPosInsert(m.beat, at, L) })),
    loopStart: mapPosInsert(doc.loopStart, at, L),
    loopEnd: doc.loopEnd >= at - EPS ? doc.loopEnd + L : doc.loopEnd,
    at, len: L,
  };
}

// Remove bars [startBar, endBar). Notes that start inside are deleted; everything after moves left.
export function removeBars(doc, startBar, endBar, mapOf) {
  const s = beatOfBar(doc.subs, startBar), e = beatOfBar(doc.subs, endBar);
  const subs = [...doc.subs.slice(0, startBar), ...doc.subs.slice(endBar)];
  const tracks = doc.tracks.map((t) => (t.type === 'audio'
    ? { ...t, clips: shiftClipsRemove(t, s, e, mapOf) }
    : { ...t, notes: t.notes.filter(n => n.beat < s - EPS || n.beat >= e - EPS).map(n => (n.beat >= e - EPS ? { ...n, beat: n.beat - (e - s) } : n)) }));
  const loopStart = mapPosRemove(doc.loopStart, s, e);
  const loopEnd = Math.max(loopStart + 1, mapPosRemove(doc.loopEnd, s, e));
  return {
    ...doc, subs, tracks,
    markers: doc.markers.filter(m => m.beat < s - EPS || m.beat >= e - EPS).map(m => ({ ...m, beat: mapPosRemove(m.beat, s, e) })),
    loopStart, loopEnd, at: s, len: e - s,
  };
}

// Put a copied stretch down at beat `at` (the room must already be there).
export function pasteRange(doc, payload, at) {
  const tracks = doc.tracks.map((t) => {
    if (t.type === 'audio') {
      const pieces = payload.clips[t.id];
      if (!pieces) return t;
      return { ...t, clips: [...getClips(t), ...pieces.map(p => newClip(at + p.rel, p.srcStart, p.srcEnd))] };
    }
    const list = payload.notes[t.id];
    return list ? { ...t, notes: [...t.notes, ...list.map(n => ({ ...n, beat: at + n.beat }))] } : t;
  });
  return { ...doc, tracks };
}
