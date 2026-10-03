/**
 * A short rising tone for lining up recordings: played (with a white flash)
 * while presenting, it's picked up by the camera's mic; the exported video
 * starts with the exact same sound, so video editors can sync the two by
 * audio waveform.
 */

const CHIRP_DURATION = 0.3;
const CHIRP_FROM_HZ = 600;
const CHIRP_TO_HZ = 2400;
const CHIRP_FADE = 0.01;
const CHIRP_GAIN = 0.8;

export const SYNC_FLASH_DURATION = 120;

/** The chirp's samples (mono), at `sampleRate`. */
export const createChirpSamples = (
  sampleRate: number,
): Float32Array<ArrayBuffer> => {
  const length = Math.round(CHIRP_DURATION * sampleRate);
  const samples = new Float32Array(length);
  // linear sweep: phase = 2π (f0 t + (f1 - f0) t² / 2T)
  const sweep = (CHIRP_TO_HZ - CHIRP_FROM_HZ) / CHIRP_DURATION;
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const phase = 2 * Math.PI * (CHIRP_FROM_HZ * t + (sweep * t * t) / 2);
    const fade = Math.min(1, t / CHIRP_FADE, (CHIRP_DURATION - t) / CHIRP_FADE);
    samples[i] = Math.sin(phase) * Math.max(0, fade) * CHIRP_GAIN;
  }
  return samples;
};

let audioContext: AudioContext | null = null;

/**
 * Plays the chirp. Call from a user gesture (iOS only allows audio then).
 *
 * @returns when the chirp actually starts playing (`performance.now()` time),
 *   accounting for the output latency
 */
export const playSyncChirp = (): number => {
  const now = performance.now();
  try {
    audioContext ??= new AudioContext();
    const context = audioContext;
    void context.resume();
    const samples = createChirpSamples(context.sampleRate);
    const buffer = context.createBuffer(1, samples.length, context.sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start();
    const latency = (context.outputLatency || context.baseLatency || 0) * 1000;
    return now + latency;
  } catch (error) {
    // no audio (e.g. blocked): the flash still works
    console.error(error);
    return now;
  }
};
