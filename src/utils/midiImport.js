import { closestComboForPitch } from './pitchMap';

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
 * @param {number} subdivisionsPerBeat - how many grid subdivisions per quarter note (e.g., 4 for 16th notes)
 * @param {number} bpm - beats per minute (used for tempo map)
 * @returns {{ tracks: Array<{ name: string, notes: Array }>, detectedBpm: number }}
 */
export function midiToGuitarNotes(midi, subdivisionsPerBeat = 4) {
  const { ticksPerQuarter, midiTracks } = midi;

  // Collect tempo events from all tracks
  const tempoEvents = [];
  midiTracks.forEach(events => {
    events.forEach(e => {
      if (e.type === 'tempo') tempoEvents.push(e);
    });
  });
  tempoEvents.sort((a, b) => a.tick - b.tick);

  // Default tempo: 120 BPM = 500000 microseconds per quarter
  const defaultTempo = 500000;
  const detectedBpm = tempoEvents.length > 0
    ? Math.round(60000000 / tempoEvents[0].tempo)
    : 120;

  // Convert ticks to beats (1 beat = 1 subdivision in the grid)
  // 1 quarter note = ticksPerQuarter ticks = subdivisionsPerBeat grid beats
  function tickToBeats(tick) {
    return (tick / ticksPerQuarter) * subdivisionsPerBeat;
  }

  const result = [];

  midiTracks.forEach((events, trackIdx) => {
    // Match noteOn/noteOff pairs
    const activeNotes = new Map(); // note -> [{ tick, velocity }]
    const notes = [];

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
          const duration = Math.max(endBeat - startBeat, 1 / subdivisionsPerBeat);

          // Map MIDI note to guitar string/fret
          const combo = closestComboForPitch(e.note, 0);
          if (combo) {
            notes.push({
              stringIndex: combo.stringIndex,
              fret: combo.fret,
              beat: Math.round(startBeat * 10000) / 10000,
              duration: Math.round(duration * 10000) / 10000,
              velocity: Math.min(1, start.velocity / 127),
            });
          }
        }
      }
    });

    if (notes.length > 0) {
      result.push({
        name: `MIDI Track ${trackIdx + 1}`,
        notes,
      });
    }
  });

  // For format 0 (single track), try splitting by channel
  if (midi.format === 0 && result.length === 1 && result[0].notes.length > 0) {
    // Check if multiple channels are used
    const channelNotes = new Map();
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
          if (!channelNotes.has(start.channel)) channelNotes.set(start.channel, []);
          const startBeat = tickToBeats(start.tick);
          const endBeat = tickToBeats(e.tick);
          const duration = Math.max(endBeat - startBeat, 1 / subdivisionsPerBeat);
          const combo = closestComboForPitch(e.note, 0);
          if (combo) {
            channelNotes.get(start.channel).push({
              stringIndex: combo.stringIndex,
              fret: combo.fret,
              beat: Math.round(startBeat * 10000) / 10000,
              duration: Math.round(duration * 10000) / 10000,
              velocity: Math.min(1, start.velocity / 127),
            });
          }
        }
      }
    });

    if (channelNotes.size > 1) {
      const channelResult = [];
      channelNotes.forEach((notes, ch) => {
        if (notes.length > 0) {
          channelResult.push({ name: `Channel ${ch + 1}`, notes });
        }
      });
      if (channelResult.length > 1) return { tracks: channelResult, detectedBpm };
    }
  }

  return { tracks: result, detectedBpm };
}
