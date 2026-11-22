// Session bundle: a .zip holding session.json plus the audio files, so a session can be
// moved between browsers and reopened with the audio and its sync points already in place.
import { makeZip, readZip } from './zip';
import { getAudioFile, putAudioFile } from './audioStore';

const MIME_EXT = {
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/aac': 'aac', 'audio/webm': 'webm',
};

function extOf(fileName, mime) {
  const m = /\.([a-z0-9]{2,5})$/i.exec(fileName || '');
  return (m && m[1].toLowerCase()) || MIME_EXT[mime] || 'bin';
}

// Every audio track in the session, including those parked in other song tabs.
function audioTrackIds(state) {
  const ids = new Set();
  const add = (tracks) => (tracks || []).forEach(t => { if (t.type === 'audio' && t.audioFileName) ids.add(t.id); });
  add(state.tracks);
  (state.songs || []).forEach(s => add(s.snapshot?.tracks));
  return [...ids];
}

export const sessionHasAudio = (state) => audioTrackIds(state).length > 0;

// Save blob with a "save as" dialog where the browser has one, otherwise a named download.
async function saveBlob(blob, suggestedName) {
  if ('showSaveFilePicker' in window) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'Guitar Roll session with audio', accept: { 'application/zip': ['.zip'] } }],
      });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return true;
    } catch (err) {
      if (err.name === 'AbortError') return false;
    }
  }
  const entered = window.prompt('Save as (file name):', suggestedName);
  if (entered === null) return false;
  let name = entered.trim() || suggestedName;
  if (!/\.zip$/i.test(name)) name += '.zip';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return true;
}

// Returns { saved, audioCount, missing } — `missing` lists audio tracks whose file wasn't in the browser.
export async function exportSessionZip(state, suggestedName = 'guitar-roll-session.zip') {
  const enc = new TextEncoder();
  const entries = [];
  const audio = {};
  const missing = [];
  for (const id of audioTrackIds(state)) {
    let f = null;
    try { f = await getAudioFile(id); } catch { /* ignore */ }
    if (!f) { missing.push(id); continue; }
    const path = `audio/${id}.${extOf(f.fileName, f.mimeType)}`;
    audio[id] = { path, fileName: f.fileName, mimeType: f.mimeType };
    entries.push({ path, data: new Uint8Array(f.arrayBuffer) });
  }
  entries.unshift({ path: 'session.json', data: enc.encode(JSON.stringify({ ...state, audioFiles: audio }, null, 2)) });
  const saved = await saveBlob(makeZip(entries), suggestedName);
  return { saved, audioCount: Object.keys(audio).length, missing };
}

// Open a .json or .zip session file. For a zip, the audio goes back into the browser's audio
// store under the same track ids, so applying the session finds it already there.
export function importSessionFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.zip,application/json,application/zip';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) { reject('No file'); return; }
      try {
        const isZip = /\.zip$/i.test(file.name) || file.type === 'application/zip';
        if (!isZip) { resolve({ data: JSON.parse(await file.text()), audioCount: 0 }); return; }
        const entries = await readZip(await file.arrayBuffer());
        const sessionEntry = entries.find(x => x.path === 'session.json') || entries.find(x => /(^|\/)session\.json$/.test(x.path));
        if (!sessionEntry) throw new Error('No session.json in this zip');
        const data = JSON.parse(new TextDecoder().decode(sessionEntry.data));
        const files = data.audioFiles || {};
        let audioCount = 0;
        for (const [trackId, meta] of Object.entries(files)) {
          const entry = entries.find(x => x.path === meta.path);
          if (!entry) continue;
          const ab = entry.data.buffer.slice(entry.data.byteOffset, entry.data.byteOffset + entry.data.byteLength);
          await putAudioFile(trackId, ab, meta.fileName, meta.mimeType);
          audioCount++;
        }
        delete data.audioFiles;
        resolve({ data, audioCount });
      } catch (err) { reject(err); }
    };
    input.click();
  });
}
