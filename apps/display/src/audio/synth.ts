/**
 * Synth — the three voices every sound in this project is made of.
 *
 * **Everything is synthesised, nothing is loaded.** There are no audio files in
 * this repo and no asset pipeline to serve them, and adding both to make a 40 ms
 * blip would be the expensive way to get a worse result: a sample has to be
 * fetched, decoded and cache-busted before the first sound, and until it is the
 * game is silent exactly when the player first touches it. An oscillator has no
 * such window. It is also the same decision the renderer already made — the games
 * are Three.js primitives and gradients rather than models and textures — so the
 * project stays self-contained and the whole audio layer is a few kilobytes of
 * arithmetic.
 *
 * The trade is real and worth naming: this cannot produce a recorded voice or a
 * licensed music bed. If either is ever wanted, the seam to change is
 * `cues.ts` — a spec becomes a buffer reference — and nothing above it moves.
 *
 * Three voice shapes cover every cue in `cues.ts`:
 *
 * | shape   | what it is                         | what it is for                    |
 * |---------|------------------------------------|-----------------------------------|
 * | `blip`  | one oscillator, pitch + gain sweep | UI, shots, flaps — anything tonal |
 * | `noise` | filtered white-noise burst         | slices, crashes, explosions       |
 * | `chord` | several blips at fixed intervals   | pickups, wave clears, records     |
 *
 * Two rules run through all of them. **Never ramp exponentially to zero** — the
 * WebAudio spec makes that a no-op and the value freezes at its last setting,
 * which is a note that never stops. And **every node is stopped and disconnected**
 * on `ended`; a game firing several cues a second for ten minutes otherwise
 * accumulates thousands of live nodes in the graph.
 */

/** The smallest gain we ever ramp to. Zero is illegal for an exponential ramp. */
const SILENT = 0.0001;

export type Waveform = 'sine' | 'square' | 'sawtooth' | 'triangle';

export interface BlipSpec {
  kind: 'blip';
  /** Starting frequency, Hz. */
  freq: number;
  /** Frequency at the end of the sweep. Omit for a flat tone. */
  toFreq?: number;
  /** Total length, seconds. */
  duration: number;
  wave?: Waveform;
  /**
   * Rise time, seconds.
   *
   * Not zero by default. A gain step from silence is a discontinuity in the
   * waveform, and a discontinuity is a click — audible on every single trigger,
   * and the usual reason a synthesised UI sound feels cheap.
   */
  attack?: number;
  /** Peak gain before the mix scales it, 0..1. */
  gain?: number;
}

export interface NoiseSpec {
  kind: 'noise';
  duration: number;
  /** Band centre / cutoff at the start, Hz. */
  freq: number;
  /** Where the filter sweeps to. Omit to hold. */
  toFreq?: number;
  filter?: 'lowpass' | 'bandpass' | 'highpass';
  /** Filter resonance. Higher is more whistle, less hiss. */
  q?: number;
  attack?: number;
  gain?: number;
}

export interface ChordSpec {
  kind: 'chord';
  /** Root frequency, Hz. */
  freq: number;
  /**
   * Intervals as frequency ratios against the root — `1, 1.5, 2` is a fifth and
   * an octave. Ratios rather than semitones because the cue table is read by
   * whoever is tuning the *feel*, and "twice as high" needs no theory.
   */
  ratios: readonly number[];
  duration: number;
  wave?: Waveform;
  /** Delay between successive notes, seconds. Zero is a chord, more is an arpeggio. */
  stagger?: number;
  attack?: number;
  gain?: number;
}

export type VoiceSpec = BlipSpec | NoiseSpec | ChordSpec;

/**
 * One second of white noise, made once and shared.
 *
 * Regenerating this per burst is a few thousand `Math.random()` calls on the
 * audio path — during a bomb, several times in one frame. Playback starts at a
 * random offset instead, so repeated bursts do not sound like a loop.
 */
const NOISE_CACHE = new WeakMap<BaseAudioContext, AudioBuffer>();

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  // Module scope, deliberately, and not a default parameter — a default is
  // re-evaluated on every call, which would build a fresh empty cache each time
  // and generate 48,000 random samples per burst. That is precisely the cost this
  // exists to avoid, and it would only ever show up as audio-thread jitter during
  // the busiest moment of a round.
  let buffer = NOISE_CACHE.get(ctx);
  if (!buffer) {
    buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    NOISE_CACHE.set(ctx, buffer);
  }
  return buffer;
}

/**
 * Render one voice into `destination`.
 *
 * `gain` is the mix decision already made by `AudioDirector`; the spec's own
 * `gain` is the sound designer's balance within the cue. They multiply.
 */
export function playVoice(
  ctx: AudioContext,
  destination: AudioNode,
  spec: VoiceSpec,
  gain: number,
  when = ctx.currentTime,
): void {
  // Scheduling in the past is not an error but it is not audible either — the
  // envelope's first segment has already elapsed. A resumed context can report a
  // `currentTime` slightly ahead of the caller's, so clamp rather than trust it.
  const t0 = Math.max(when, ctx.currentTime);
  switch (spec.kind) {
    case 'blip':
      blip(ctx, destination, spec, gain, t0);
      return;
    case 'noise':
      noise(ctx, destination, spec, gain, t0);
      return;
    case 'chord':
      chord(ctx, destination, spec, gain, t0);
      return;
  }
}

function blip(
  ctx: AudioContext,
  destination: AudioNode,
  spec: BlipSpec,
  mix: number,
  t0: number,
): void {
  const osc = ctx.createOscillator();
  osc.type = spec.wave ?? 'sine';

  const from = Math.max(1, spec.freq);
  const to = Math.max(1, spec.toFreq ?? spec.freq);
  osc.frequency.setValueAtTime(from, t0);
  // Exponential, so a sweep sounds like an even glide. A linear ramp through the
  // same endpoints spends most of its time at the top, because pitch is heard
  // logarithmically — it reads as a jump followed by a slow settle.
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, t0 + spec.duration);

  const env = envelope(ctx, spec.duration, spec.attack ?? 0.006, (spec.gain ?? 1) * mix, t0);
  osc.connect(env).connect(destination);

  osc.start(t0);
  osc.stop(t0 + spec.duration + 0.02);
  cleanup(osc, env);
}

function noise(
  ctx: AudioContext,
  destination: AudioNode,
  spec: NoiseSpec,
  mix: number,
  t0: number,
): void {
  const buffer = noiseBuffer(ctx);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;

  const filter = ctx.createBiquadFilter();
  filter.type = spec.filter ?? 'bandpass';
  filter.Q.value = spec.q ?? 1;
  const from = Math.max(20, spec.freq);
  const to = Math.max(20, spec.toFreq ?? spec.freq);
  filter.frequency.setValueAtTime(from, t0);
  if (to !== from) filter.frequency.exponentialRampToValueAtTime(to, t0 + spec.duration);

  const env = envelope(ctx, spec.duration, spec.attack ?? 0.004, (spec.gain ?? 1) * mix, t0);
  src.connect(filter).connect(env).connect(destination);

  // A random start offset: the buffer is shared, and two bursts from the same
  // sample position are correlated enough to hear as a repeat rather than as two
  // separate impacts. Clamped at zero because a cue longer than the buffer would
  // otherwise ask for a negative offset, which throws — and would take the game
  // loop down with it rather than merely sounding wrong.
  const room = Math.max(0, buffer.duration - spec.duration - 0.01);
  src.start(t0, Math.random() * room);
  src.stop(t0 + spec.duration + 0.02);
  cleanup(src, filter, env);
}

function chord(
  ctx: AudioContext,
  destination: AudioNode,
  spec: ChordSpec,
  mix: number,
  t0: number,
): void {
  const stagger = spec.stagger ?? 0;
  // Divided by the note count: three notes at full gain is three times the
  // amplitude of one, and an arrival fanfare is exactly where that clips.
  const each = (spec.gain ?? 1) / Math.max(1, spec.ratios.length);

  spec.ratios.forEach((ratio, i) => {
    blip(
      ctx,
      destination,
      {
        kind: 'blip',
        freq: spec.freq * ratio,
        duration: spec.duration,
        wave: spec.wave ?? 'triangle',
        attack: spec.attack ?? 0.008,
        gain: each,
      },
      mix,
      t0 + i * stagger,
    );
  });
}

/** An attack/decay gain node, scheduled and returned ready to connect. */
function envelope(
  ctx: AudioContext,
  duration: number,
  attack: number,
  peak: number,
  t0: number,
): GainNode {
  const node = ctx.createGain();
  // The attack cannot outlast the sound: a 4 ms rise inside a 3 ms cue would
  // otherwise schedule the decay before the peak and invert the envelope.
  const rise = Math.min(attack, duration * 0.5);
  const level = Math.max(SILENT, peak);

  node.gain.setValueAtTime(SILENT, t0);
  node.gain.linearRampToValueAtTime(level, t0 + rise);
  node.gain.exponentialRampToValueAtTime(SILENT, t0 + duration);
  return node;
}

/** Disconnect the whole chain once the source has finished. */
function cleanup(source: AudioScheduledSourceNode, ...nodes: AudioNode[]): void {
  source.addEventListener(
    'ended',
    () => {
      source.disconnect();
      for (const node of nodes) node.disconnect();
    },
    { once: true },
  );
}
