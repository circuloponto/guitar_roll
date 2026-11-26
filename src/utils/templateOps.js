// Templates (from the 8-fold way app): short patterns stored by scale DEGREE, so one shape replays on any
// scale + root. Note fields: { beat, degree, octave, semis, length } with beat/length in 16th-note cells.
// FretRoll's timeline counts columns of 1/den notes, so cells <-> columns scales by den / 16.
import { scales } from './eightScales';

export const SCALE_LIST = scales;
export const ROOT_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const newTemplateId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
export const isFolder = (n) => n && n.type === 'folder';
export const cellsPerColumn = (den) => 16 / (den || 4);

// Scale walker: a "step" is an index along the scale's notes, going up through the octaves.
export function makeScaleCtx(scaleId, root) {
  const scale = scales.find((s) => s.id === scaleId) || scales[0];
  const N = scale.notes.length;
  const baseRoot = 60 + root;
  const midiToStep = (midi) => {
    const rel = midi - baseRoot;
    const oct = Math.floor(rel / 12);
    const idx = scale.notes.indexOf(rel - 12 * oct);
    return idx < 0 ? null : oct * N + idx;
  };
  const stepToMidi = (step) => {
    const oct = Math.floor(step / N);
    return baseRoot + 12 * oct + scale.notes[step - oct * N];
  };
  const nearestScaleMidi = (midi) => {
    for (let d = 0; d < 12; d++) {
      if (midiToStep(midi - d) != null) return midi - d;
      if (midiToStep(midi + d) != null) return midi + d;
    }
    return midi;
  };
  return { scale, N, baseRoot, midiToStep, stepToMidi, nearestScaleMidi };
}

// Where a template's notes land when its first note is put at (anchorBeat in columns, anchorMidi): the
// shape is kept in scale steps. Returns [{ beat, midi, length }] in columns.
export function placeTemplate(tpl, scaleId, root, anchorBeat, anchorMidi, den) {
  const ctx = makeScaleCtx(scaleId, root);
  const per = cellsPerColumn(den);
  if (!tpl || !tpl.notes || !tpl.notes.length) return [];
  const first = tpl.notes.reduce((a, n) => (n.beat < a.beat ? n : a), tpl.notes[0]);
  if (first.degree < 0 || first.degree >= ctx.N) return [];
  const stepOf = (n) => ctx.midiToStep(ctx.baseRoot + ctx.scale.notes[n.degree] + n.octave * 12);
  const firstStep = stepOf(first);
  const anchorStep = ctx.midiToStep(ctx.nearestScaleMidi(anchorMidi));
  if (firstStep == null || anchorStep == null) return [];
  const shift = anchorStep - firstStep;
  const out = [];
  for (const n of tpl.notes) {
    if (n.degree < 0 || n.degree >= ctx.N) continue;
    const s = stepOf(n);
    if (s == null) continue;
    out.push({
      beat: anchorBeat + (n.beat - first.beat) / per,
      midi: ctx.stepToMidi(s + shift) + (n.semis || 0),
      length: (n.length ?? 1) / per,
    });
  }
  return out;
}

// Turn timeline notes (already as { beat, midi, duration }) into template notes for a scale + root.
export function captureNotes(items, scaleId, root, den) {
  if (!items.length) return [];
  const ctx = makeScaleCtx(scaleId, root);
  const per = cellsPerColumn(den);
  const minBeat = Math.min(...items.map((n) => n.beat));
  const r4 = (v) => Math.round(v * 10000) / 10000;
  return items
    .map((n) => {
      const rel = n.midi - ctx.baseRoot;
      const octave = Math.floor(rel / 12);
      const pc = rel - 12 * octave;
      let degree = 0;
      ctx.scale.notes.forEach((v, i) => { if (v <= pc) degree = i; });
      return {
        beat: r4((n.beat - minBeat) * per),
        degree,
        octave,
        semis: pc - ctx.scale.notes[degree],
        length: r4((n.duration || 1) * per),
      };
    })
    .sort((a, b) => a.beat - b.beat || a.degree - b.degree);
}

// Accepts one template, an array, or the "export const templates = [...]" code form. Fresh ids.
export function parseTemplates(text) {
  let s = (text || '').trim();
  if (!s) return null;
  const i = s.search(/[[{]/);
  if (i > 0) s = s.slice(i);
  s = s.replace(/;\s*$/, '');
  let data;
  try { data = JSON.parse(s); } catch { return null; }
  const arr = Array.isArray(data) ? data : [data];
  const valid = arr.filter((t) => t && (t.type === 'folder' || Array.isArray(t.notes)));
  if (!valid.length) return null;
  const idMap = new Map();
  valid.forEach((t) => idMap.set(t.id, newTemplateId()));
  return valid.map((t) => {
    const parentId = t.parentId != null && idMap.has(t.parentId) ? idMap.get(t.parentId) : null;
    if (t.type === 'folder') return { id: idMap.get(t.id), type: 'folder', name: typeof t.name === 'string' ? t.name : 'Folder', parentId, collapsed: !!t.collapsed };
    return { id: idMap.get(t.id), type: 'template', name: typeof t.name === 'string' ? t.name : 'Imported', parentId, capturedFrom: t.capturedFrom || null, notes: t.notes };
  });
}

const isDesc = (prev, ancestorId, nodeId) => {
  let cur = prev.find((n) => n.id === nodeId);
  const seen = new Set();
  while (cur && cur.parentId != null && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.parentId === ancestorId) return true;
    cur = prev.find((n) => n.id === cur.parentId);
  }
  return false;
};

// Move nodes (a folder carries its subtree) before / after a target, or inside a folder.
export function moveNodes(prev, ids, targetId, pos) {
  const idSet = new Set(ids);
  if (targetId != null && idSet.has(targetId)) return prev;
  if (targetId != null && [...idSet].some((id) => isDesc(prev, id, targetId))) return prev;
  const moving = prev.filter((n) => idSet.has(n.id));
  const rest = prev.filter((n) => !idSet.has(n.id));
  let parentId, insertAt;
  if (pos === 'root' || targetId == null) { parentId = null; insertAt = rest.length; }
  else {
    const ti = rest.findIndex((n) => n.id === targetId);
    if (ti < 0) return prev;
    parentId = pos === 'inside' ? targetId : rest[ti].parentId ?? null;
    insertAt = pos === 'before' ? ti : ti + 1;
  }
  rest.splice(insertAt, 0, ...moving.map((n) => (idSet.has(n.parentId) ? n : { ...n, parentId })));
  return rest;
}

// A node plus every descendant, parents first.
export function withDescendants(all, ids) {
  const wanted = new Set();
  const add = (id) => {
    if (wanted.has(id)) return;
    wanted.add(id);
    all.forEach((c) => { if (c.parentId === id) add(c.id); });
  };
  ids.forEach(add);
  return all.filter((t) => wanted.has(t.id));
}
