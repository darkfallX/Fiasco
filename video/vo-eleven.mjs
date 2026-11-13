// Voices the trailer with ElevenLabs.
//
//   node video/vo-eleven.mjs --list          show the voices on your account
//   node video/vo-eleven.mjs                 voice all 15 lines
//   node video/vo-eleven.mjs --only=03,07    redo just those lines
//   node video/vo-eleven.mjs --voice=<id>    use a specific voice
//
// Needs ELEVENLABS_API_KEY in .env.local (never commit it; .env.local is git-ignored).
// Optional: ELEVENLABS_VOICE_ID and ELEVENLABS_MODEL. Lines are read from video/cues.json
// and written to video/vo/NN.mp3; the previous voice files are kept in video/vo-scratch/.
// Afterwards run `npm run film:mix`.
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  })
);

const fileEnv = fs.existsSync(".env.local")
  ? Object.fromEntries(
      fs
        .readFileSync(".env.local", "utf8")
        .split(/\r?\n/)
        .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
        .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
    )
  : {};
const env = (name) => process.env[name] || fileEnv[name] || "";

const key = env("ELEVENLABS_API_KEY");
if (!key) {
  console.error("No ELEVENLABS_API_KEY found. Add it to .env.local and run this again.");
  process.exit(1);
}

const API = "https://api.elevenlabs.io/v1";
const headers = { "xi-api-key": key, "Content-Type": "application/json" };

if (args.list) {
  const res = await fetch(`${API}/voices`, { headers });
  if (!res.ok) {
    console.error(`ElevenLabs answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    process.exit(1);
  }
  const { voices } = await res.json();
  for (const v of voices) {
    const tags = Object.values(v.labels || {}).join(", ");
    console.log(`${v.voice_id}  ${v.name}${tags ? `  (${tags})` : ""}`);
  }
  process.exit(0);
}

// Default: George, a warm British narrator from the ElevenLabs premade library.
const voiceId = args.voice || env("ELEVENLABS_VOICE_ID") || "JBFqnCBsd6RMkjVDRZzb";
const model = env("ELEVENLABS_MODEL") || "eleven_multilingual_v2";

const cues = JSON.parse(fs.readFileSync("video/cues.json", "utf8"));
const only = args.only ? new Set(args.only.split(",")) : null;
const outDir = path.join("video", "vo");
const keepDir = path.join("video", "vo-scratch");
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(keepDir, { recursive: true });

let chars = 0;
for (let i = 0; i < cues.vo.length; i++) {
  const line = cues.vo[i];
  if (only && !only.has(line.id)) continue;
  const target = path.join(outDir, `${line.id}.mp3`);
  const keep = path.join(keepDir, `${line.id}.mp3`);
  if (fs.existsSync(target) && !fs.existsSync(keep)) fs.copyFileSync(target, keep);

  const body = {
    text: line.text,
    model_id: model,
    // Neighbouring lines give the model context, so the read flows like one narration.
    previous_text: cues.vo[i - 1]?.text,
    next_text: cues.vo[i + 1]?.text,
    voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true },
  };

  let saved = false;
  for (let attempt = 0; attempt < 3 && !saved; attempt++) {
    const res = await fetch(`${API}/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    }).catch((err) => ({ ok: false, status: 0, text: async () => String(err.message) }));
    if (res.ok) {
      fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()));
      saved = true;
    } else {
      const detail = (await res.text()).slice(0, 220);
      console.error(`line ${line.id}: ElevenLabs answered ${res.status}: ${detail}`);
      if ([401, 402, 403, 404, 422].includes(res.status)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!saved) {
    console.error(`Stopped at line ${line.id}. Earlier lines are saved; fix the problem and rerun with --only=...`);
    process.exit(1);
  }
  chars += line.text.length;
  console.log(`voiced ${line.id}  ${line.text}`);
}
console.log(`Done. ${chars} characters used. Now run: npm run film:mix`);
