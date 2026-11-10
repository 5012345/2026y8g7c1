/** Tiny WebAudio sound effects (no audio files → fast loading). */
let ctx: AudioContext | null = null;
const ac = (): AudioContext | null => {
  try {
    ctx ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
};

function tone(freq: number, dur: number, type: OscillatorType = 'sine', gain = 0.12, delay = 0): void {
  if (sfx.muted) return;
  const c = ac();
  if (!c) return;
  const t = c.currentTime + delay;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

export const sfx = {
  muted: false,
  place: () => { tone(880, 0.09, 'triangle'); tone(1320, 0.12, 'triangle', 0.08, 0.05); },
  magnet: () => tone(1500, 0.05, 'sine', 0.05),
  wrong: () => tone(160, 0.18, 'sawtooth', 0.05),
  hint: () => tone(600, 0.15, 'sine', 0.08),
  tick: () => tone(660, 0.1, 'square', 0.05),
  go: () => tone(990, 0.25, 'square', 0.06),
  clear: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, 'triangle', 0.1, i * 0.08)),
  finish: () => [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.3, 'triangle', 0.1, i * 0.11)),
};

// unlock audio on first touch (iOS/Android autoplay policy)
window.addEventListener('pointerdown', () => ac(), { once: true });
