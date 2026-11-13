// Renders the trailer picture frame by frame from http://localhost:3000/film.
//
//   node video/capture.mjs                 full render to video/out/picture.mp4
//   node video/capture.mjs --stills=3,15   single frames to video/stills/ (for review)
//   node video/capture.mjs --url=play.example.com   adds the play link to the end card
//
// Each frame is stepped, then photographed, so the result is smooth 30 fps at 1080p
// however slow the machine is. Needs the dev server (npm run dev) running.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";
import ffmpegPath from "ffmpeg-static";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  })
);

const browserPath = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => fs.existsSync(p));
if (!browserPath) throw new Error("No Chrome or Edge found");

const outDir = path.join("video", "out");
const stillDir = path.join("video", "stills");
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(stillDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: browserPath,
  headless: true,
  args: [
    "--window-size=1920,1080",
    "--hide-scrollbars",
    "--use-angle=d3d11",
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--enable-webgl",
    "--force-device-scale-factor=1",
  ],
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("page error:", e.message));
page.on("console", (msg) => {
  if (msg.type() === "error") console.error("console error:", msg.text().slice(0, 200));
});
page.on("framenavigated", (f) => {
  if (f === page.mainFrame()) console.error("navigated:", f.url());
});

const base = args.base || "http://localhost:3000";
const query = args.url ? `?url=${encodeURIComponent(args.url)}` : "";
await page.goto(`${base}/film${query}`, { waitUntil: "networkidle2", timeout: 120000 });
await page.waitForFunction(() => window.__film && window.__film.ready, { timeout: 120000 });
const { fps, duration } = await page.evaluate(() => ({ fps: window.__film.fps, duration: window.__film.duration }));
const total = Math.round(fps * duration);
const dt = 1 / fps;

const stills = args.stills
  ? new Set(args.stills.split(",").map((s) => Math.round(Number(s) * fps)))
  : null;

let ffmpeg = null;
if (!stills) {
  ffmpeg = spawn(
    ffmpegPath,
    [
      "-y", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
      "-c:v", "libx264", "-preset", "slow", "-crf", "15", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart", path.join(outDir, "picture.mp4"),
    ],
    { stdio: ["pipe", "ignore", "inherit"] }
  );
}

const started = Date.now();
const lastStill = stills ? Math.max(...stills) : total;
for (let f = 1; f <= Math.min(total, lastStill); f++) {
  await page.evaluate((d) => window.__film.step(d), dt);
  if (stills) {
    if (stills.has(f)) {
      const name = `t${(f / fps).toFixed(1).padStart(5, "0")}.jpg`;
      await page.screenshot({ path: path.join(stillDir, name), type: "jpeg", quality: 82 });
      console.log("still", name);
    }
    continue;
  }
  const shot = await page.screenshot({ type: "jpeg", quality: 95, optimizeForSpeed: true });
  if (!ffmpeg.stdin.write(shot)) await new Promise((r) => ffmpeg.stdin.once("drain", r));
  if (f % 150 === 0) {
    const sec = (Date.now() - started) / 1000;
    console.log(`frame ${f}/${total}  ${(f / sec).toFixed(1)} fps  eta ${Math.round(((total - f) / f) * sec)}s`);
  }
}

if (ffmpeg) {
  ffmpeg.stdin.end();
  await new Promise((r) => ffmpeg.on("close", r));
  console.log("wrote", path.join(outDir, "picture.mp4"));
}
await browser.close();
