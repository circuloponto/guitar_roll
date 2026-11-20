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

export const clipLenBeats = (clip, spb) => (clip.srcEnd - clip.srcStart) / spb;
export const clipEndBeat = (clip, spb) => clip.start + clipLenBeats(clip, spb);

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
      const cut = c.srcStart + (beat - c.start) * spb;
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
