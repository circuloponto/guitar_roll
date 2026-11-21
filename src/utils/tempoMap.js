// Project tempo map. The recording is the master: sync points on an audio track say where its
// beats really are, and the grid (notes, metronome, playhead) follows that timing. The audio
// itself always plays 1:1 (apart from the BPM control, which speeds everything up/down together).
//
// One map per project for now (taken from the first audio track that has sync points).
// Everything goes through this object, so a per-tab map can replace it later.
import { getClips, getSyncPoints, makeWarp, linearMap, secPerBeat } from './audioClips';
import { beatToTime } from './barLayout';

export function makeTempoMap(tracks, bpm, denom) {
  const liveSpb = beatToTime(1, null, bpm, denom);
  const ref = tracks.find(t => t.type === 'audio' && getSyncPoints(t).length > 0 && getClips(t).length > 0);
  const trackMap = (t) => linearMap(secPerBeat(t, bpm, denom));
  if (!ref) {
    return {
      active: false, refId: null, mult: 1, liveSpb,
      baseSec: (b) => b * liveSpb, baseBeat: (s) => s / liveSpb, knotBeats: [],
      liveSec: (b) => b * liveSpb, liveBeat: (s) => s / liveSpb, colDur: () => liveSpb,
      forTrack: trackMap,
    };
  }
  const spb0 = secPerBeat(ref, bpm, denom);
  const warp = makeWarp(ref, spb0);
  // Timeline beat where the file's own beat 0 (its first second) sits. Fixed when the first sync
  // point is made, so moving / cropping clips later never changes the map.
  const c0 = getClips(ref).reduce((m, c) => (c.start < m.start ? c : m));
  const anchor = Number.isFinite(ref.syncAnchor) ? ref.syncAnchor : c0.start - c0.srcStart / spb0;
  const secOf = (T) => anchor * spb0 + T;
  const beatOf = (T) => anchor + warp.toBeat(T);
  const times = warp.pts.map(p => p.time);
  if (times[0] > 1e-9) times.unshift(0); // the file start is an anchor too
  const knots = times.map(T => ({ beat: beatOf(T), sec: secOf(T) }));
  const first = knots[0], last = knots[knots.length - 1];
  const interp = (x, key, other) => {
    if (x <= first[key]) return first[other] + (x - first[key]) * (key === 'beat' ? spb0 : 1 / spb0);
    if (x >= last[key]) return last[other] + (x - last[key]) * (key === 'beat' ? spb0 : 1 / spb0);
    for (let i = 1; i < knots.length; i++) {
      if (x <= knots[i][key]) {
        const a = knots[i - 1], b = knots[i];
        const span = b[key] - a[key];
        return span > 0 ? a[other] + ((x - a[key]) / span) * (b[other] - a[other]) : a[other];
      }
    }
    return last[other];
  };
  const baseSec = (b) => interp(b, 'beat', 'sec');
  const baseBeat = (s) => interp(s, 'sec', 'beat');
  const mult = bpm / (ref.originalBpm || bpm);
  const tm = {
    active: true, refId: ref.id, mult, liveSpb, spb0,
    baseSec, baseBeat, knotBeats: knots.map(k => k.beat),
    liveSec: (b) => baseSec(b) / mult,
    liveBeat: (s) => baseBeat(s * mult),
    colDur: (b) => (baseSec(b + 1) - baseSec(b)) / mult,
    forTrack: () => tm,
    // sync points are stored in the reference file's own beat grid; these convert to the timeline
    fileBeatToBeat: (B) => anchor + B,
    beatToFileBeat: (b) => b - anchor,
    anchor,
    fileBeatOfTime: (T) => warp.toBeat(T),
    timeOfFileBeat: (B) => warp.toTime(B),
  };
  return tm;
}
