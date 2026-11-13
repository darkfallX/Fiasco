// Mixes picture, voiceover, music and effects into video/out/fiasco-trailer.mp4.
//
//   node video/assemble.mjs
//
// Voice lines are placed at the times in video/cues.json. The music ducks under the voice
// automatically. To change the voice, replace the files in video/vo/ and run this again;
// to change the music, replace video/out/music.wav (or pass --music=path).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  })
);
const cues = JSON.parse(fs.readFileSync("video/cues.json", "utf8"));
const out = path.join("video", "out");
const picture = path.join(out, "picture.mp4");
const music = args.music || path.join(out, "music.wav");
const sfx = path.join(out, "sfx.wav");

const durationOf = (file) => {
  const res = spawnSync(ffmpeg, ["-i", file], { encoding: "utf8" });
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(res.stderr || "");
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
};

const lines = cues.vo.map((line) => {
  const file = path.join("video", "vo", `${line.id}.mp3`);
  if (!fs.existsSync(file)) throw new Error(`Missing voice line ${file}`);
  return { ...line, file, dur: durationOf(file) };
});

let clash = false;
lines.forEach((line, i) => {
  const end = line.t + line.dur;
  const next = lines[i + 1];
  const flag = next && end > next.t - 0.1 ? "  << runs into the next line" : "";
  if (flag) clash = true;
  console.log(`${line.id}  ${line.t.toFixed(1).padStart(5)}s  ${line.dur.toFixed(2)}s${flag}`);
});
if (clash) console.log("Some lines overlap. Move their start times in src/film/timeline.ts or shorten the text.");

const inputs = ["-i", picture, "-i", music, "-i", sfx];
for (const line of lines) inputs.push("-i", line.file);

const voiceChains = lines
  .map((line, i) => {
    const ms = Math.round(line.t * 1000);
    return `[${i + 3}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${ms}|${ms}[v${i}]`;
  })
  .join(";");
const voiceMix = `${lines.map((_, i) => `[v${i}]`).join("")}amix=inputs=${lines.length}:normalize=0:duration=longest,highpass=f=75,acompressor=threshold=-20dB:ratio=3:attack=8:release=140:makeup=4,volume=1.5,apad=whole_dur=${cues.duration},asplit=2[voice][key]`;
const graph = [
  voiceChains,
  voiceMix,
  `[1:a]volume=0.8[m]`,
  `[m][key]sidechaincompress=threshold=0.035:ratio=5:attack=25:release=480:makeup=1[bed]`,
  `[2:a]volume=0.85[fx]`,
  `[bed][fx][voice]amix=inputs=3:normalize=0:duration=first,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]`,
].join(";");

const target = path.join(out, "fiasco-trailer.mp4");
const res = spawnSync(
  ffmpeg,
  [
    "-y", ...inputs,
    "-filter_complex", graph,
    "-map", "0:v", "-map", "[a]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "256k",
    "-t", String(cues.duration), "-movflags", "+faststart",
    target,
  ],
  { encoding: "utf8" }
);
if (res.status !== 0) {
  console.error((res.stderr || "").split("\n").slice(-12).join("\n"));
  process.exit(1);
}
console.log("wrote", target, `${(fs.statSync(target).size / 1e6).toFixed(1)} MB`);
