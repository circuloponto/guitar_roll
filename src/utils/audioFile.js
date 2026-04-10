import { getAudioContext } from './audio';

/**
 * Load and decode an audio file (wav, mp3, aiff)
 * @param {File} file
 * @returns {Promise<{ buffer: AudioBuffer, peaks: number[] }>}
 */
export async function loadAudioFile(file) {
  const ctx = getAudioContext();
  const arrayBuffer = await file.arrayBuffer();
  const buffer = await ctx.decodeAudioData(arrayBuffer);
  const peaks = computeWaveformPeaks(buffer, 2000);
  return { buffer, peaks };
}

/**
 * Downsample an AudioBuffer to an array of peak amplitudes
 * @param {AudioBuffer} buffer
 * @param {number} numBuckets
 * @returns {number[]}
 */
export function computeWaveformPeaks(buffer, numBuckets) {
  const data = buffer.getChannelData(0);
  const samplesPerBucket = Math.floor(data.length / numBuckets);
  const peaks = new Array(numBuckets);
  for (let i = 0; i < numBuckets; i++) {
    let max = 0;
    const start = i * samplesPerBucket;
    const end = Math.min(start + samplesPerBucket, data.length);
    for (let j = start; j < end; j++) {
      const abs = Math.abs(data[j]);
      if (abs > max) max = abs;
    }
    peaks[i] = max;
  }
  return peaks;
}
