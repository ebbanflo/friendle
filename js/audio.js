// All sound is synthesized with WebAudio - no audio files. The on/off toggle
// lives on the MAIN MENU only and persists in localStorage.

let ctx = null;
let master = null;
let enabled = localStorage.getItem('friendle-sound') !== 'off';

function ac() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function soundEnabled() { return enabled; }
export function setSound(on) {
  enabled = on;
  localStorage.setItem('friendle-sound', on ? 'on' : 'off');
}

function tone({ freq = 440, type = 'sine', dur = 0.12, gain = 0.5, at = 0, slide = 0 }) {
  if (!enabled) return;
  try {
    const c = ac();
    const t0 = c.currentTime + at;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g).connect(master);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  } catch { /* audio unavailable */ }
}

function noise({ dur = 0.15, gain = 0.3, at = 0, freq = 1200 }) {
  if (!enabled) return;
  try {
    const c = ac();
    const t0 = c.currentTime + at;
    const buf = c.createBuffer(1, c.sampleRate * dur, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t0);
  } catch { /* audio unavailable */ }
}

export const sfx = {
  key: () => tone({ freq: 520 + Math.random() * 80, type: 'triangle', dur: 0.05, gain: 0.25 }),
  back: () => tone({ freq: 300, type: 'triangle', dur: 0.05, gain: 0.2 }),
  flip: (i = 0) => tone({ freq: 400 + i * 70, type: 'sine', dur: 0.09, gain: 0.22, at: i * 0.06 }),
  invalid: () => { tone({ freq: 160, type: 'sawtooth', dur: 0.18, gain: 0.3 }); tone({ freq: 120, type: 'sawtooth', dur: 0.2, gain: 0.3, at: 0.09 }); },
  solve: () => [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, type: 'triangle', dur: 0.16, gain: 0.4, at: i * 0.09 })),
  lose: () => [330, 262, 196].forEach((f, i) => tone({ freq: f, type: 'sine', dur: 0.25, gain: 0.35, at: i * 0.16 })),
  win: () => [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => tone({ freq: f, type: 'square', dur: 0.18, gain: 0.22, at: i * 0.1 })),
  pot: () => { [880, 988, 1175, 1319].forEach((f, i) => tone({ freq: f, type: 'triangle', dur: 0.1, gain: 0.35, at: i * 0.06 })); noise({ dur: 0.3, gain: 0.15, freq: 3000, at: 0.25 }); },
  freeze: () => tone({ freq: 1400, type: 'sine', dur: 0.6, gain: 0.3, slide: -1100 }),
  buy: () => { tone({ freq: 700, type: 'triangle', dur: 0.07, gain: 0.3 }); tone({ freq: 1050, type: 'triangle', dur: 0.09, gain: 0.3, at: 0.07 }); },
  peek: () => tone({ freq: 900, type: 'sine', dur: 0.2, gain: 0.25, slide: 500 }),
  smudge: () => noise({ dur: 0.2, gain: 0.25, freq: 500 }),
  tick: () => tone({ freq: 1000, type: 'sine', dur: 0.04, gain: 0.18 }),
  duel: () => { [220, 220, 330].forEach((f, i) => tone({ freq: f, type: 'sawtooth', dur: 0.15, gain: 0.3, at: i * 0.14 })); noise({ dur: 0.25, gain: 0.2, freq: 2000, at: 0.4 }); },
  join: () => tone({ freq: 660, type: 'triangle', dur: 0.12, gain: 0.3, slide: 200 }),
  pop: () => { tone({ freq: 880, type: 'sine', dur: 0.06, gain: 0.3, slide: 300 }); tone({ freq: 1320, type: 'triangle', dur: 0.08, gain: 0.2, at: 0.05 }); },
  reveal: () => tone({ freq: 440, type: 'sine', dur: 0.3, gain: 0.25, slide: 220 }),
  heart: () => [988, 1318, 1568].forEach((f, i) => tone({ freq: f, type: 'sine', dur: 0.12, gain: 0.28, at: i * 0.07 })),
};
