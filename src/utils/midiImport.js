import { pitchRowCombos, midiToPitchRow } from './pitchMap';
import { findBestVoicings } from './voiceLeading';

// Assign string+fret to a sequence of note groups (chords) using voice leading.
// Each group is an array of { midi, ... } records sharing a start tick.
// Mutates each note in-place, adding .stringIndex and .fret.
// Notes that can't be placed (out of range) have stringIndex = null.
function assignFretboardPositions(groups) {
  let prevVoicing = [];
  for (const group of groups) {
    const midis = group.map(n => n.midi);
    const best = findBestVoicings(prevVoicing, midis, 1);

    if (best.length > 0) {
      const voicing = best[0].voicing;
      // Match each voicing entry back to a note by midi pitch.
      const used = new Set();
      for (const v of voicing) {
        const idx = group.findIndex((n, i) => !used.has(i) && n.midi === v.midi);
        if (idx >= 0) {
          group[idx].stringIndex = v.stringIndex;
          group[idx].fret = v.fret;
          used.add(idx);
        }
      }
      prevVoicing = voicing.slice();
      continue;
    }

    // Fallback — group is unvoiceable as a single chord (too many notes,
    // impossible fret span, or notes out of range). Place each note individually
    // onto a free string nearest to the previous voicing's fret center.
    const centerFret = prevVoicing.length > 0
      ? prevVoicing.reduce((s, v) => s + v.fret, 0) / prevVoicing.length
      : 5;
    const usedStrings = new Set();
    const placed = [];
    for (const n of group) {
      const row = midiToPitchRow(n.midi);
      if (row < 0) continue;
      const combos = pitchRowCombos(row).filter(c => !usedStrings.has(c.stringIndex));
      if (combos.length === 0) continue;
      combos.sort((a, b) => Math.abs(a.fret - centerFret) - Math.abs(b.fret - centerFret));
      const pick = combos[0];
      n.stringIndex = pick.stringIndex;
      n.fret = pick.fret;
      usedStrings.add(pick.stringIndex);
      placed.push({ ...pick, midi: n.midi });
    }
    if (placed.length > 0) prevVoicing = placed;
  }
}

/**
 * Parse a MIDI file ArrayBuffer into tracks of note events.
 * Supports Format 0 (single track) and Format 1 (multi-track).
 */
export function parseMidi(arrayBuffer) {
  const data = new Uint8Array(arrayBuffer);
  let pos = 0;

  function readUint16() {
    const val = (data[pos] << 8) | data[pos + 1];
    pos += 2;
    return val;
  }

  function readUint32() {
    const val = (data[pos] << 24) | (data[pos + 1] << 16) | (data[pos + 2] << 8) | data[pos + 3];
    pos += 4;
    return val >>> 0;
  }

  function readVarLen() {
    let val = 0;
    for (let i = 0; i < 4; i++) {
      const byte = data[pos++];
      val = (val << 7) | (byte & 0x7f);
      if (!(byte & 0x80)) break;
    }
    return val;
  }

  // Read header chunk
  const headerTag = String.fromCharCode(data[0], data[1], data[2], data[3]);
  if (headerTag !== 'MThd') throw new Error('Not a valid MIDI file');
  pos = 4;
  readUint32(); // header length (always 6)
  const format = readUint16();
  const numTracks = readUint16();
  const timeDivision = readUint16();

  // We only support ticks-per-quarter-note (not SMPTE)
  if (timeDivision & 0x8000) throw new Error('SMPTE time division not supported');
  const ticksPerQuarter = timeDivision;

  // Parse all tracks
  const midiTracks = [];
  for (let t = 0; t < numTracks; t++) {
    const trackTag = String.fromCharCode(data[pos], data[pos + 1], data[pos + 2], data[pos + 3]);
    pos += 4;
    if (trackTag !== 'MTrk') throw new Error('Invalid track chunk');
    const trackLength = readUint32();
    const trackEnd = pos + trackLength;

    const events = [];
    let absoluteTick = 0;
    let runningStatus = 0;

    while (pos < trackEnd) {
      const delta = readVarLen();
      absoluteTick += delta;

      let statusByte = data[pos];
      if (statusByte & 0x80) {
        runningStatus = statusByte;
        pos++;
      } else {
        statusByte = runningStatus;
      }

      const type = statusByte & 0xf0;
      const channel = statusByte & 0x0f;

      if (type === 0x90) {
        // Note On
        const note = data[pos++];
        const velocity = data[pos++];
        events.push({ type: 'noteOn', tick: absoluteTick, note, velocity, channel });
      } else if (type === 0x80) {
        // Note Off
        const note = data[pos++];
        pos++; // velocity (ignored)
        events.push({ type: 'noteOff', tick: absoluteTick, note, channel });
      } else if (type === 0xa0 || type === 0xb0 || type === 0xe0) {
        pos += 2; // 2-byte messages
      } else if (type === 0xc0 || type === 0xd0) {
        pos += 1; // 1-byte messages
      } else if (statusByte === 0xff) {
        // Meta event
        const metaType = data[pos++];
        const metaLen = readVarLen();
        if (metaType === 0x51) {
          // Tempo — microseconds per quarter note
          const tempo = (data[pos] << 16) | (data[pos + 1] << 8) | data[pos + 2];
          events.push({ type: 'tempo', tick: absoluteTick, tempo });
        }
        pos += metaLen;
      } else if (statusByte === 0xf0 || statusByte === 0xf7) {
        // SysEx
        const sysLen = readVarLen();
        pos += sysLen;
      } else {
        // Unknown, skip
        pos++;
      }
    }
    pos = trackEnd;
    midiTracks.push(events);
  }

  return { format, numTracks, ticksPerQuarter, midiTracks };
}

/**
 * Convert parsed MIDI data into guitar roll note arrays.
 * Returns an array of track arrays, each containing { stringIndex, fret, beat, duration, velocity }.
 *
 * @param {object} midi - parsed MIDI data from parseMidi()
 * @param {number} timeSigDenominator - time signature denominator (4 = quarter, 8 = eighth)
 * @returns {{ tracks: Array<{ name: string, notes: Array }>, detectedBpm: number }}
 */
export function midiToGuitarNotes(midi, timeSigDenominator = 4) {
  const { ticksPerQuarter, midiTracks } = midi;

  // Collect tempo events from all tracks
  const tempoEvents = [];
  midiTracks.forEach(events => {
    events.forEach(e => {
      if (e.type === 'tempo') tempoEvents.push(e);
    });
  });
  tempoEvents.sort((a, b) => a.tick - b.tick);

  const detectedBpm = tempoEvents.length > 0
    ? Math.round(60000000 / tempoEvents[0].tempo)
    : 120;

  // Convert ticks to grid columns.
  // In the grid, each column's duration = (60/bpm) * (4/denominator).
  // With denominator=4 (4/4 time), each column = 1 quarter note → multiply by 1.
  // With denominator=8 (6/8 time), each column = 1 eighth note → multiply by 2.
  // General: columnsPerQuarterNote = denominator / 4.
  const columnsPerQuarter = timeSigDenominator / 4;
  function tickToBeats(tick) {
    return (tick / ticksPerQuarter) * columnsPerQuarter;
  }

  const result = [];

  midiTracks.forEach((events, trackIdx) => {
    // First pass: collect completed notes as pitch-only records (no string/fret yet).
    const activeNotes = new Map(); // note -> [{ tick, velocity }]
    const raw = []; // { midi, startTick, startBeat, duration, velocity }

    events.forEach(e => {
      if (e.type === 'noteOn' && e.velocity > 0) {
        if (!activeNotes.has(e.note)) activeNotes.set(e.note, []);
        activeNotes.get(e.note).push({ tick: e.tick, velocity: e.velocity });
      } else if (e.type === 'noteOff' || (e.type === 'noteOn' && e.velocity === 0)) {
        const pending = activeNotes.get(e.note);
        if (pending && pending.length > 0) {
          const start = pending.shift();
          const startBeat = tickToBeats(start.tick);
          const endBeat = tickToBeats(e.tick);
          const duration = Math.max(endBeat - startBeat, 0.01);
          raw.push({
            midi: e.note,
            startTick: start.tick,
            startBeat,
            duration,
            velocity: start.velocity,
          });
        }
      }
    });

    if (raw.length === 0) return;

    // Group simultaneous notes (same startTick) into chord groups, sorted in time.
    raw.sort((a, b) => a.startTick - b.startTick);
    const groups = [];
    let cursor = 0;
    while (cursor < raw.length) {
      const tick = raw[cursor].startTick;
      const group = [];
      while (cursor < raw.length && raw[cursor].startTick === tick) {
        group.push(raw[cursor++]);
      }
      groups.push(group);
    }

    // Second pass: assign string/fret per chord group using voice leading.
    assignFretboardPositions(groups);

    const notes = [];
    for (const group of groups) {
      for (const n of group) {
        if (n.stringIndex == null) continue;
        notes.push({
          stringIndex: n.stringIndex,
          fret: n.fret,
          beat: Math.round(n.startBeat * 10000) / 10000,
          duration: Math.round(n.duration * 10000) / 10000,
          velocity: Math.min(1, n.velocity / 127),
        });
      }
    }

    if (notes.length > 0) {
      result.push({
        name: `MIDI Track ${trackIdx + 1}`,
        notes,
      });
    }
  });

  // For format 0 (single track), try splitting by channel
  if (midi.format === 0 && result.length === 1 && result[0].notes.length > 0) {
    // First pass: collect pitch-only notes per channel.
    const channelRaw = new Map(); // channel -> raw[]
    const events = midiTracks[0];
    const activeByChannel = new Map();

    events.forEach(e => {
      if (e.type === 'noteOn' && e.velocity > 0) {
        const key = `${e.channel}-${e.note}`;
        if (!activeByChannel.has(key)) activeByChannel.set(key, []);
        activeByChannel.get(key).push({ tick: e.tick, velocity: e.velocity, channel: e.channel });
      } else if (e.type === 'noteOff' || (e.type === 'noteOn' && e.velocity === 0)) {
        const key = `${e.channel}-${e.note}`;
        const pending = activeByChannel.get(key);
        if (pending && pending.length > 0) {
          const start = pending.shift();
          if (!channelRaw.has(start.channel)) channelRaw.set(start.channel, []);
          const startBeat = tickToBeats(start.tick);
          const endBeat = tickToBeats(e.tick);
          const duration = Math.max(endBeat - startBeat, 0.01);
          channelRaw.get(start.channel).push({
            midi: e.note,
            startTick: start.tick,
            startBeat,
            duration,
            velocity: start.velocity,
          });
        }
      }
    });

    if (channelRaw.size > 1) {
      const channelResult = [];
      channelRaw.forEach((raw, ch) => {
        if (raw.length === 0) return;
        // Group by startTick and assign voice-leading positions per channel.
        raw.sort((a, b) => a.startTick - b.startTick);
        const groups = [];
        let cursor = 0;
        while (cursor < raw.length) {
          const tick = raw[cursor].startTick;
          const group = [];
          while (cursor < raw.length && raw[cursor].startTick === tick) {
            group.push(raw[cursor++]);
          }
          groups.push(group);
        }
        assignFretboardPositions(groups);
        const notes = [];
        for (const group of groups) {
          for (const n of group) {
            if (n.stringIndex == null) continue;
            notes.push({
              stringIndex: n.stringIndex,
              fret: n.fret,
              beat: Math.round(n.startBeat * 10000) / 10000,
              duration: Math.round(n.duration * 10000) / 10000,
              velocity: Math.min(1, n.velocity / 127),
            });
          }
        }
        if (notes.length > 0) channelResult.push({ name: `Channel ${ch + 1}`, notes });
      });
      if (channelResult.length > 1) return { tracks: channelResult, detectedBpm };
    }
  }

  return { tracks: result, detectedBpm };
}
