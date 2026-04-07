import { useState, useMemo } from 'react';
import { getNoteName } from '../utils/audio';
import { groupNotesIntoChords, findBestVoicings } from '../utils/voiceLeading';

export default function VoiceLeadingModal({ notes, selectedNotes, onPreview, onApply, onClose }) {
  // Get the selected notes with their original indices
  const selectedWithIndices = useMemo(() =>
    notes.map((n, i) => ({ ...n, _origIdx: i })).filter((_, i) => selectedNotes.has(i)),
    [notes, selectedNotes]
  );

  const chords = useMemo(() => groupNotesIntoChords(selectedWithIndices), [selectedWithIndices]);

  // For each chord after the first, compute voice leading options
  const [choices, setChoices] = useState(() => {
    // Initialize: each chord keeps its original voicing
    return chords.map((c, i) => ({
      ...c,
      options: i === 0 ? [] : [],  // will be computed below
      selectedOption: -1, // -1 = keep original
    }));
  });

  // Compute options for all chords based on the chain of choices
  const computedChords = useMemo(() => {
    const result = chords.map((c, i) => ({
      ...c,
      options: [],
      selectedOption: choices[i]?.selectedOption ?? -1,
    }));

    for (let i = 1; i < result.length; i++) {
      // Previous voicing: either the chosen alternative or the original
      const prevIdx = i - 1;
      const prevChoice = result[prevIdx];
      const prevVoicing = prevChoice.selectedOption >= 0 && prevChoice.options[prevChoice.selectedOption]
        ? prevChoice.options[prevChoice.selectedOption].voicing
        : prevChoice.voicing;

      const options = findBestVoicings(prevVoicing, result[i].midiNotes, 5);
      result[i].options = options;
    }

    return result;
  }, [chords, choices]);

  const handleSelect = (chordIdx, optionIdx) => {
    setChoices(prev => {
      const next = [...prev];
      if (!next[chordIdx]) next[chordIdx] = {};
      next[chordIdx] = { ...next[chordIdx], selectedOption: next[chordIdx].selectedOption === optionIdx ? -1 : optionIdx };
      return next;
    });
  };

  const handleAutoAll = () => {
    setChoices(prev => {
      const next = [...prev];
      for (let i = 1; i < computedChords.length; i++) {
        if (computedChords[i].options.length > 0) {
          if (!next[i]) next[i] = {};
          next[i] = { ...next[i], selectedOption: 0 }; // pick best
        }
      }
      return next;
    });
  };

  const handleApply = () => {
    const replacements = [];

    for (let ci = 0; ci < computedChords.length; ci++) {
      const chord = computedChords[ci];
      const choice = choices[ci]?.selectedOption ?? -1;
      const voicing = choice >= 0 && chord.options[choice]
        ? chord.options[choice].voicing
        : null;

      if (voicing) {
        chord.notes.forEach((origNote, ni) => {
          const origMidi = chord.midiNotes[ni];
          const newVoice = voicing.find(v => v.midi === origMidi);
          if (newVoice && origNote._origIdx != null) {
            replacements.push({
              index: origNote._origIdx,
              stringIndex: newVoice.stringIndex,
              fret: newVoice.fret,
            });
          }
        });
      }
    }

    onApply(replacements);
  };

  if (chords.length < 2) {
    return (
      <div className="settings-overlay" onClick={onClose}>
        <div className="settings-popup" onClick={e => e.stopPropagation()}>
          <h2 className="settings-title">Voice Leading</h2>
          <p style={{ color: '#888', fontSize: 13 }}>Select notes spanning at least 2 different beats to analyze voice leading.</p>
          <button className="settings-btn settings-close" onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-popup vl-modal" onClick={e => e.stopPropagation()}>
        <h2 className="settings-title">Voice Leading</h2>

        <div className="vl-chords">
          {computedChords.map((chord, ci) => {
            const isFirst = ci === 0;
            const selected = choices[ci]?.selectedOption ?? -1;

            return (
              <div key={ci} className="vl-chord-col">
                <div className="vl-chord-header">Beat {chord.beat + 1}</div>

                {/* Original voicing */}
                <div className={`vl-voicing ${selected === -1 ? 'active' : ''}`}
                  onClick={() => !isFirst && handleSelect(ci, -1)}
                  onMouseEnter={() => onPreview && onPreview(chord.voicing)}
                  onMouseLeave={() => onPreview && onPreview(null)}
                >
                  <div className="vl-voicing-label">Original</div>
                  {chord.notes.map((n, ni) => (
                    <div key={ni} className="vl-note">
                      <span className="vl-string">S{n.stringIndex + 1}</span>
                      <span className="vl-fret">f{n.fret}</span>
                      <span className="vl-name">{getNoteName(n.stringIndex, n.fret)}</span>
                    </div>
                  ))}
                </div>

                {/* Alternative voicings */}
                {!isFirst && chord.options.map((opt, oi) => (
                  <div key={oi}
                    className={`vl-voicing ${selected === oi ? 'active' : ''}`}
                    onClick={() => handleSelect(ci, oi)}
                    onMouseEnter={() => onPreview && onPreview(opt.voicing)}
                    onMouseLeave={() => onPreview && onPreview(null)}
                  >
                    <div className="vl-voicing-label">
                      Option {oi + 1}
                      <span className="vl-score">cost: {opt.score}</span>
                    </div>
                    {opt.voicing.map((v, vi) => (
                      <div key={vi} className="vl-note">
                        <span className="vl-string">S{v.stringIndex + 1}</span>
                        <span className="vl-fret">f{v.fret}</span>
                        <span className="vl-name">{getNoteName(v.stringIndex, v.fret)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            );
          })}
        </div>

        <div className="vl-actions">
          <button className="settings-btn" onClick={handleAutoAll}>Auto (Best)</button>
          <button className="settings-btn" onClick={handleApply}>Apply</button>
          <button className="settings-btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
