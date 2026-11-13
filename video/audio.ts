// Renders the trailer's music and sound effects to video/out/music.wav and sfx.wav.
// Everything is synthesised here, so there is nothing to license. The score is written
// against the same timeline as the picture: 120 bpm, so a bar is exactly two seconds and
// every cut in src/film/timeline.ts lands on a beat.
//
//   npx tsx video/audio.ts
import fs from "node:fs";
import { buildFilm, DURATION } from "../src/film/timeline";

const SR = 48000;
const N = Math.round(SR * DURATION);
const STEP = 0.125; // one sixteenth note

type Bus = { l: Float32Array; r: Float32Array; send: Float32Array };
const bus = (): Bus => ({ l: new Float32Array(N), r: new Float32Array(N), send: new Float32Array(N) });

let seed = 1234567;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
const noise = () => rnd() * 2 - 1;
const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);
const lpCoef = (fc: number) => 1 - Math.exp((-2 * Math.PI * Math.min(fc, SR * 0.45)) / SR);

/** Writes one voice. `fn(i, tt)` returns a mono sample for sample index i at time tt. */
function voice(
  b: Bus,
  t: number,
  dur: number,
  gain: number,
  pan: number,
  send: number,
  fn: (tt: number, i: number) => number
) {
  const start = Math.round(t * SR);
  const len = Math.round(dur * SR);
  const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4);
  const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (idx < 0 || idx >= N) continue;
    const s = fn(i / SR, i);
    b.l[idx] += s * gl;
    b.r[idx] += s * gr;
    if (send) b.send[idx] += s * gain * send;
  }
}

const saw = (phase: number) => 2 * (phase - Math.floor(phase + 0.5));
const env = (tt: number, attack: number, decay: number) =>
  tt < attack ? tt / attack : Math.exp(-(tt - attack) / decay);

function kick(b: Bus, t: number, g = 1) {
  let phase = 0;
  voice(b, t, 0.42, 0.95 * g, 0, 0, (tt) => {
    const f = 46 + 110 * Math.exp(-tt / 0.035);
    phase += f / SR;
    return Math.sin(2 * Math.PI * phase) * Math.exp(-tt / 0.16) + (tt < 0.004 ? noise() * 0.5 : 0);
  });
}

function clap(b: Bus, t: number, g = 1) {
  let lp = 0;
  voice(b, t, 0.26, 0.42 * g, 0.05, 0.5, (tt) => {
    const x = noise();
    lp += lpCoef(900) * (x - lp);
    const burst = (tt < 0.012 ? 1 : 0) + (tt > 0.016 && tt < 0.028 ? 0.8 : 0) + (tt > 0.032 ? Math.exp(-(tt - 0.032) / 0.07) : 0);
    return (x - lp) * burst * 0.8 + Math.sin(2 * Math.PI * 190 * tt) * Math.exp(-tt / 0.05) * 0.25;
  });
}

function hat(b: Bus, t: number, g: number, open = false) {
  let lp = 0;
  voice(b, t, open ? 0.3 : 0.07, g, 0.3, 0.1, (tt) => {
    const x = noise();
    lp += lpCoef(6500) * (x - lp);
    return (x - lp) * Math.exp(-tt / (open ? 0.09 : 0.018));
  });
}

function bass(b: Bus, t: number, midi: number, dur: number, g: number, bright = 1) {
  const f = hz(midi);
  let p = 0;
  let lp = 0;
  voice(b, t, dur + 0.08, g, 0, 0, (tt) => {
    p += f / SR;
    const raw = saw(p) * 0.7 + Math.sign(Math.sin(2 * Math.PI * p * 0.5)) * 0.35;
    const cut = (180 + 900 * bright * Math.exp(-tt / 0.09));
    lp += lpCoef(cut) * (raw - lp);
    const a = tt < 0.004 ? tt / 0.004 : tt > dur ? Math.max(0, 1 - (tt - dur) / 0.08) : 1;
    return lp * a;
  });
}

function pluck(b: Bus, t: number, midi: number, g: number, pan: number, cutoff = 2600) {
  const f = hz(midi);
  let p1 = 0;
  let p2 = 0;
  let lp = 0;
  voice(b, t, 0.34, g, pan, 0.45, (tt) => {
    p1 += f / SR;
    p2 += (f * 1.006) / SR;
    const raw = (saw(p1) + saw(p2)) * 0.5;
    lp += lpCoef(350 + cutoff * Math.exp(-tt / 0.06)) * (raw - lp);
    return lp * env(tt, 0.002, 0.11);
  });
}

function pad(b: Bus, t: number, notes: number[], dur: number, g: number, cutoff: number) {
  notes.forEach((midi, k) => {
    for (const det of [-0.006, 0, 0.007]) {
      const f = hz(midi) * (1 + det);
      let p = rnd();
      let lp = 0;
      voice(b, t, dur + 1.2, g / 3, (k - 1) * 0.5 + det * 60, 0.35, (tt) => {
        p += f / SR;
        lp += lpCoef(cutoff) * (saw(p) - lp);
        const a = tt < 0.5 ? tt / 0.5 : tt > dur ? Math.max(0, 1 - (tt - dur) / 1.2) : 1;
        return lp * a;
      });
    }
  });
}

function bell(b: Bus, t: number, midi: number, g: number, pan = 0, decay = 0.7) {
  const f = hz(midi);
  voice(b, t, decay * 4, g, pan, 0.6, (tt) => {
    const e = env(tt, 0.002, decay);
    return (Math.sin(2 * Math.PI * f * tt) + 0.35 * Math.sin(2 * Math.PI * f * 2.76 * tt) * Math.exp(-tt / 0.12)) * e;
  });
}

function drone(b: Bus, t: number, midi: number, dur: number, g: number) {
  const f = hz(midi);
  voice(b, t, dur, g, 0, 0.1, (tt) => {
    const a = Math.min(1, tt / 2.5) * Math.min(1, (dur - tt) / 1.5);
    return (Math.sin(2 * Math.PI * f * tt) + 0.4 * Math.sin(2 * Math.PI * f * 2 * tt + Math.sin(tt * 0.7))) * a;
  });
}

function riser(b: Bus, t: number, len: number, g: number) {
  let lp = 0;
  let p = 0;
  voice(b, t, len, g, 0, 0.3, (tt) => {
    const u = tt / len;
    const x = noise();
    lp += lpCoef(300 + 9000 * u * u) * (x - lp);
    p += (180 + 900 * u * u) / SR;
    return (lp * 0.8 + Math.sin(2 * Math.PI * p) * 0.25) * u * u;
  });
}

function impact(b: Bus, t: number, g: number, big = false) {
  let phase = 0;
  let lp = 0;
  voice(b, t, big ? 2.6 : 1.5, g, 0, 0.5, (tt) => {
    phase += (34 + 60 * Math.exp(-tt / 0.08)) / SR;
    const x = noise();
    lp += lpCoef(big ? 1400 : 2200) * (x - lp);
    return (
      Math.sin(2 * Math.PI * phase) * Math.exp(-tt / (big ? 0.9 : 0.45)) +
      lp * Math.exp(-tt / 0.12) * 0.9
    );
  });
}

function whoosh(b: Bus, t: number, g: number) {
  let lp = 0;
  let lp2 = 0;
  const len = 0.42;
  const start = Math.round(t * SR);
  for (let i = 0; i < len * SR; i++) {
    const tt = i / SR;
    const u = tt / len;
    const x = noise();
    lp += lpCoef(500 + 5200 * Math.sin(Math.PI * u)) * (x - lp);
    lp2 += lpCoef(260) * (lp - lp2);
    const s = (lp - lp2) * Math.pow(Math.sin(Math.PI * u), 2) * g;
    const pan = -0.8 + 1.6 * u;
    const idx = start + i;
    if (idx < 0 || idx >= N) continue;
    b.l[idx] += s * Math.cos(((pan + 1) * Math.PI) / 4);
    b.r[idx] += s * Math.sin(((pan + 1) * Math.PI) / 4);
    b.send[idx] += s * 0.2;
  }
}

function blip(b: Bus, t: number, f0: number, f1: number, dur: number, g: number, pan = 0) {
  let p = 0;
  voice(b, t, dur, g, pan, 0.15, (tt) => {
    p += (f0 + (f1 - f0) * (tt / dur)) / SR;
    return Math.sin(2 * Math.PI * p) * Math.exp(-tt / (dur * 0.4));
  });
}

function reverb(b: Bus, wet: number) {
  const combs = [1695, 1760, 1623, 1548, 1867, 1999];
  const out = new Float32Array(N);
  for (const d of combs) {
    const buf = new Float32Array(d);
    let idx = 0;
    let damp = 0;
    for (let i = 0; i < N; i++) {
      const y = buf[idx];
      damp += 0.35 * (y - damp);
      buf[idx] = b.send[i] + damp * 0.84;
      idx = (idx + 1) % d;
      out[i] += y;
    }
  }
  for (const d of [245, 605]) {
    const buf = new Float32Array(d);
    let idx = 0;
    for (let i = 0; i < N; i++) {
      const y = buf[idx];
      const x = out[i];
      buf[idx] = x + y * 0.5;
      out[i] = y - x * 0.5;
      idx = (idx + 1) % d;
    }
  }
  for (let i = 0; i < N; i++) {
    const w = (out[i] / combs.length) * wet;
    b.l[i] += w;
    b.r[i] += i >= 37 ? (out[i - 37] / combs.length) * wet : w;
  }
}

function writeWav(path: string, b: Bus, peak: number) {
  let max = 0;
  for (let i = 0; i < N; i++) max = Math.max(max, Math.abs(b.l[i]), Math.abs(b.r[i]));
  const k = max > 0 ? peak / max : 1;
  const data = Buffer.alloc(44 + N * 4);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + N * 4, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(2, 22);
  data.writeUInt32LE(SR, 24);
  data.writeUInt32LE(SR * 4, 28);
  data.writeUInt16LE(4, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(N * 4, 40);
  const fadeFrom = (DURATION - 3.5) * SR;
  for (let i = 0; i < N; i++) {
    const fade = i > fadeFrom ? Math.max(0, 1 - (i - fadeFrom) / (3.4 * SR)) : 1;
    const l = Math.tanh(b.l[i] * k * 1.15) * fade;
    const r = Math.tanh(b.r[i] * k * 1.15) * fade;
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, l)) * 32767), 44 + i * 4);
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, r)) * 32767), 46 + i * 4);
  }
  fs.writeFileSync(path, data);
  console.log("wrote", path);
}

// ------------------------------------------------------------------ score
// D minor, one chord per bar: Dm, Bb, F, C.
const CHORDS = [
  { root: 38, tones: [62, 65, 69] },
  { root: 34, tones: [58, 62, 65] },
  { root: 41, tones: [57, 60, 65] },
  { root: 36, tones: [55, 60, 64] },
];
const ARP = [0, 1, 2, 1, 0, 2, 1, 2, 0, 1, 2, 1, 2, 1, 0, 2];
const BASS = [0, 0, 12, 0, 0, 12, 7, 12];
const LEAD: [number, number][] = [
  [0, 74], [3, 77], [6, 81], [10, 79], [12, 77], [16, 76], [20, 74], [24, 69],
];

const music = bus();
const bars = Math.floor(DURATION / 2);

drone(music, 0, 26, 16, 0.2);
drone(music, 0, 38, 14, 0.07);
drone(music, 62, 26, 6.2, 0.22);

for (let bar = 0; bar < bars; bar++) {
  const t0 = bar * 2;
  const chord = CHORDS[bar % 4];
  const intro = bar < 6;
  const build1 = bar >= 6 && bar < 8;
  const drive = bar >= 8 && bar < 14;
  const lift = bar === 14;
  const titleHold = bar === 15;
  const titleGroove = bar >= 16 && bar < 18;
  const main = bar >= 18 && bar < 31;
  const breakdown = bar >= 31 && bar < 34;
  const build2 = bar >= 34 && bar < 37;
  const finale = bar >= 37 && bar < 40;
  const lastBar = bar === 40;
  const outro = bar > 40;

  // pads
  if (intro) pad(music, t0, chord.tones, 2, 0.05 + bar * 0.012, 500 + bar * 90);
  else if (!outro && !lastBar) pad(music, t0, chord.tones, 2, breakdown ? 0.16 : 0.11, breakdown ? 700 : 1300);
  if (lastBar) {
    pad(music, t0 + 1, CHORDS[0].tones, 7, 0.2, 1500);
    bass(music, t0 + 1, 26, 1.6, 0.34, 0.4);
    [74, 77, 81, 86].forEach((n, i) => bell(music, t0 + 1 + i * 0.5, n, 0.16, (i - 1.5) * 0.3, 1.4));
  }
  if (titleHold) [62, 65, 69, 74].forEach((n, i) => bell(music, t0 + 0.5 + i * 0.375, n + 12, 0.14, (i - 1.5) * 0.3, 1.2));

  for (let s = 0; s < 16; s++) {
    const t = t0 + s * STEP;
    const eighth = s % 2 === 0;
    const beat = s % 4 === 0;

    if (intro && bar >= 1 && eighth) hat(music, t, 0.035 + bar * 0.006);
    if (intro && s === 6) bell(music, t, [74, 69, 77, 72, 74, 81][bar], 0.1, bar % 2 ? 0.4 : -0.4, 1.1);

    if (build1) {
      if (eighth) bass(music, t, 38, 0.2, 0.3, 0.3 + (bar - 6) * 0.4 + s / 32);
      if (eighth) hat(music, t, 0.07);
      if (bar === 7 && beat) kick(music, t, 0.8);
    }

    const groove = drive || main || finale || build2 || titleGroove;
    if (groove) {
      const light = titleGroove;
      if (beat) kick(music, t, light ? 0.8 : 1);
      if (!light && (s === 4 || s === 12)) clap(music, t, finale ? 1.1 : 1);
      hat(music, t, (s % 4 === 2 ? 0.11 : eighth ? 0.07 : 0.04) * (light ? 0.7 : 1), finale && s === 14);
      if (eighth) bass(music, t, chord.root + BASS[s / 2], 0.19, 0.4, finale ? 1.3 : 1);
      if (!light) {
        const tone = chord.tones[ARP[s]] + (s % 8 >= 4 ? 12 : 0);
        pluck(music, t, tone, drive ? 0.085 : 0.1, s % 2 ? 0.55 : -0.55, finale ? 3600 : 2400);
      }
    }
    if ((main && Math.floor((bar - 18) / 2) % 2 === 1) || finale) {
      const phrase = ((bar - (finale ? 37 : 18)) % 2) * 16 + s;
      for (const [at, note] of LEAD) if (at === phrase) bell(music, t, note, finale ? 0.17 : 0.1, 0.1, 0.5);
    }

    if (lift) {
      if (s >= 8 || s % 2 === 0) clap(music, t, 0.35 + s * 0.04);
      if (s >= 12) clap(music, t + STEP / 2, 0.5 + s * 0.04);
    }
    if (bar === 36 && s >= 8) {
      clap(music, t, 0.4 + (s - 8) * 0.07);
      if (s >= 12) clap(music, t + STEP / 2, 0.6);
    }

    if (breakdown) {
      if (s === 0) kick(music, t, 1);
      if (s === 8) clap(music, t, 0.7);
      if (eighth) pluck(music, t, chord.tones[ARP[s]] + 12, 0.07, s % 4 ? 0.6 : -0.6, 1200);
      if (s === 0) bass(music, t, chord.root - 12, 1.7, 0.45, 0.3);
    }

    if (lastBar && s < 8 && beat) kick(music, t, 1);
  }
}
reverb(music, 0.55);
fs.mkdirSync("video/out", { recursive: true });
writeWav("video/out/music.wav", music, 0.9);

// ------------------------------------------------------------------ effects
const fx = bus();
for (const cue of buildFilm().sfx) {
  const g = cue.gain ?? 1;
  switch (cue.kind) {
    case "whoosh":
      whoosh(fx, cue.t, 0.5 * g);
      break;
    case "impact":
      impact(fx, cue.t, 0.9 * g);
      break;
    case "hit":
      impact(fx, cue.t, 1.0 * g, true);
      bell(fx, cue.t, 50, 0.25, 0, 1.6);
      break;
    case "tick":
      blip(fx, cue.t, 1700, 1300, 0.03, 0.09 * g, 0.2);
      break;
    case "click":
      blip(fx, cue.t, 1150, 760, 0.045, 0.3 * g);
      break;
    case "flip":
      blip(fx, cue.t, 900, 1300, 0.04, 0.2 * g, -0.4);
      blip(fx, cue.t + 0.06, 1100, 1500, 0.04, 0.18 * g, 0.4);
      break;
    case "cash":
      bell(fx, cue.t, 88, 0.22 * g, -0.2, 0.25);
      bell(fx, cue.t + 0.07, 95, 0.22 * g, 0.2, 0.4);
      break;
    case "pop":
      blip(fx, cue.t, 500, 1800, 0.07, 0.22 * g);
      bell(fx, cue.t + 0.02, 93, 0.12 * g, 0.3, 0.3);
      break;
    case "fail": {
      let p = 0;
      let lp = 0;
      voice(fx, cue.t, 0.8, 0.28 * g, 0, 0.3, (tt) => {
        p += (320 * Math.exp(-tt / 0.3) + 50) / SR;
        lp += lpCoef(1200) * (saw(p) - lp);
        return lp * Math.exp(-tt / 0.4);
      });
      break;
    }
    case "riser":
      riser(fx, cue.t, cue.len ?? 2, 0.5 * g);
      break;
    case "count": {
      const len = cue.len ?? 1.4;
      for (let i = 0; i < 22; i++) {
        const u = i / 22;
        blip(fx, cue.t + u * len, 900 + u * 900, 1000 + u * 900, 0.03, 0.14, (i % 2 ? 0.3 : -0.3));
      }
      bell(fx, cue.t + len, 86, 0.25, 0, 0.6);
      bell(fx, cue.t + len + 0.08, 93, 0.25, 0, 0.8);
      break;
    }
  }
}
reverb(fx, 0.35);
writeWav("video/out/sfx.wav", fx, 0.8);
