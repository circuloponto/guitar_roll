// Audio clips (DAW-style regions) for audio tracks.
//
// A clip plays a slice of the track's decoded file:
//   { id, start, srcStart, srcEnd }
//   start    - timeline position in beats
//   srcStart - first second of the file that is played (file/original-bpm time)
//   srcEnd   - last second of the file that is played
// Its length on the timeline is (srcEnd - srcStart) / secondsPerBeat(originalBpm),
// matching how waveforms are drawn, so tempo changes stretch playback but the
// clip stays attached to the beat grid it was imported on.
import { beatToTime } from './barLayout';

export const MIN_CLIP_SEC = 0.02;
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));

export const secPerBeat = (track, bpm, denom) =>
  beatToTime(1, null, track.originalBpm || bpm, denom);

// Tracks saved before clips existed have a single implicit clip.
export function getClips(track) {
  if (Array.isArray(track.clips)) return track.clips;
  if (track.type === 'audio' && track.audioFileName && track.audioDuration > 0) {
    return [{ id: `legacy-${track.id}`, start: track.audioOffset || 0, srcStart: 0, srcEnd: track.audioDuration }];
  }
  return [];
}

// ---- Sync points (time warp) ----
// track.syncPoints = [{ id, time, beat }] pins the sound at `time` (seconds in the file) to
// `beat` (position in the file's own beat grid; unwarped it would be time / secPerBeat).
// Between pins the audio is stretched linearly so the recording lines up with the grid even
// when the performance drifts. Beyond the first/last pin the normal 1:1 slope continues.
export const getSyncPoints = (track) => (Array.isArray(track.syncPoints) ? track.syncPoints : []);

// A "warp" converts between file time and file-beat. `spb` is seconds per beat at originalBpm.
export function makeWarp(track, spb) {
  const pts = [...getSyncPoints(track)].sort((a, b) => a.time - b.time);
  // The file start is an implicit anchor (time 0 = beat 0) so a first pin stretches the audio
  // before it instead of just sliding the whole file.
  const ep = pts.length && pts[0].time > 1e-9 ? [{ time: 0, beat: 0 }, ...pts] : pts;
  return {
    spb,
    pts,
    toBeat(t) {
      const pts = ep;
      if (!pts.length) return t / spb;
      if (t <= pts[0].time) return pts[0].beat + (t - pts[0].time) / spb;
      const last = pts[pts.length - 1];
      if (t >= last.time) return last.beat + (t - last.time) / spb;
      for (let i = 1; i < pts.length; i++) {
        if (t <= pts[i].time) {
          const a = pts[i - 1], b = pts[i];
          const span = b.time - a.time;
          return span > 0 ? a.beat + ((t - a.time) / span) * (b.beat - a.beat) : a.beat;
        }
      }
      return t / spb;
    },
    toTime(b) {
      const pts = ep;
      if (!pts.length) return b * spb;
      if (b <= pts[0].beat) return pts[0].time + (b - pts[0].beat) * spb;
      const last = pts[pts.length - 1];
      if (b >= last.beat) return last.time + (b - last.beat) * spb;
      for (let i = 1; i < pts.length; i++) {
        if (b <= pts[i].beat) {
          const a = pts[i - 1], c = pts[i];
          const span = c.beat - a.beat;
          return span > 0 ? a.time + ((b - a.beat) / span) * (c.time - a.time) : a.time;
        }
      }
      return b * spb;
    },
  };
}

// A "map" converts timeline beats <-> seconds of the audio's own time (baseSec / baseBeat) and
// lists the beats where its slope changes (knotBeats). Without sync points it is linear.
export const linearMap = (spb) => ({ spb, knotBeats: [], baseSec: (b) => b * spb, baseBeat: (s) => s / spb });
const asMap = (m) => (typeof m === 'number' ? linearMap(m) : m);

// Clips play the audio natively: the file time under a timeline beat follows the map.
export const clipLenBeats = (clip, m) => {
  const k = asMap(m);
  return k.baseBeat(k.baseSec(clip.start) + (clip.srcEnd - clip.srcStart)) - clip.start;
};
export const clipEndBeat = (clip, m) => clip.start + clipLenBeats(clip, m);

// File time under timeline beat `beat` for this clip.
export const clipBeatToTime = (clip, beat, m) => {
  const k = asMap(m);
  return clip.srcStart + k.baseSec(beat) - k.baseSec(clip.start);
};
// Timeline beat at which file time `t` of this clip sounds.
export const clipTimeToBeat = (clip, t, m) => {
  const k = asMap(m);
  return k.baseBeat(k.baseSec(clip.start) + t - clip.srcStart);
};

// Pieces of a clip between map knots: [{ t0, t1, b0, b1 }] in file time / clip-relative beats.
export function clipSpans(clip, m) {
  const k = asMap(m);
  const end = clipEndBeat(clip, k);
  const cuts = [clip.start, ...k.knotBeats.filter(b => b > clip.start + 1e-9 && b < end - 1e-9), end];
  const out = [];
  for (let i = 1; i < cuts.length; i++) {
    out.push({
      t0: clipBeatToTime(clip, cuts[i - 1], k), t1: clipBeatToTime(clip, cuts[i], k),
      b0: cuts[i - 1] - clip.start, b1: cuts[i] - clip.start,
    });
  }
  return out;
}

export function newClip(start, srcStart, srcEnd) {
  return { id: newId(), start, srcStart, srcEnd };
}

// Split every clip in `ids` that strictly contains `beat`. Returns { clips, created }.
export function splitClips(clips, ids, beat, spb) {
  const out = [];
  const created = [];
  for (const c of clips) {
    const end = clipEndBeat(c, spb);
    if (ids.has(c.id) && beat > c.start + 1e-6 && beat < end - 1e-6) {
      const cut = clipBeatToTime(c, beat, spb);
      if (cut - c.srcStart < MIN_CLIP_SEC || c.srcEnd - cut < MIN_CLIP_SEC) { out.push(c); continue; }
      out.push({ ...c, srcEnd: cut });
      const right = newClip(beat, cut, c.srcEnd);
      out.push(right);
      created.push(right.id);
    } else {
      out.push(c);
    }
  }
  return { clips: out, created };
}

// Paste copies of `source` clips so that the earliest one starts at `atBeat`.
export function pasteClips(clips, source, atBeat) {
  if (!source.length) return { clips, created: [] };
  const base = Math.min(...source.map(c => c.start));
  const copies = source.map(c => ({ ...c, id: newId(), start: Math.max(0, atBeat + (c.start - base)) }));
  return { clips: [...clips, ...copies], created: copies.map(c => c.id) };
}
