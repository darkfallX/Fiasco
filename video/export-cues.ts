// Writes the voiceover lines and sound cues from the trailer timeline to video/cues.json,
// so the voice generator and the audio renderer read the same data as the picture.
import fs from "node:fs";
import { buildFilm, DURATION, FPS, VO } from "../src/film/timeline";

const film = buildFilm();
fs.writeFileSync(
  "video/cues.json",
  JSON.stringify({ duration: DURATION, fps: FPS, vo: VO, sfx: film.sfx }, null, 2)
);
console.log(`cues: ${VO.length} voice lines, ${film.sfx.length} sounds`);
