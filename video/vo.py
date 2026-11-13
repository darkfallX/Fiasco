"""Scratch voiceover for the trailer.

Reads the lines from video/cues.json and writes one file per line to video/vo/NN.mp3.
Lines that already have a file are skipped, so it is safe to run again after a failure.
To use a different voice (for example ElevenLabs), replace those files with your own
recordings under the same names; the assembler only looks at the file names.

    python video/vo.py [voice] [rate]
"""
import asyncio
import json
import pathlib
import sys

import edge_tts

VOICE = sys.argv[1] if len(sys.argv) > 1 else "en-US-AndrewMultilingualNeural"
RATE = sys.argv[2] if len(sys.argv) > 2 else "-3%"


async def main() -> None:
    cues = json.loads(pathlib.Path("video/cues.json").read_text(encoding="utf-8"))
    out = pathlib.Path("video/vo")
    out.mkdir(parents=True, exist_ok=True)
    missing = []
    for line in cues["vo"]:
        target = out / f"{line['id']}.mp3"
        if target.exists() and target.stat().st_size > 2000:
            continue
        done = False
        for attempt in range(5):
            try:
                # The service sometimes stalls without answering, so every try has a deadline.
                await asyncio.wait_for(
                    edge_tts.Communicate(line["text"], VOICE, rate=RATE).save(str(target)), 25
                )
                done = target.stat().st_size > 2000
                if done:
                    break
            except Exception as err:
                print("retry", target.name, type(err).__name__, flush=True)
                await asyncio.sleep(1.5)
        if done:
            print("voiced", target.name, "-", line["text"], flush=True)
        else:
            missing.append(target.name)
            target.unlink(missing_ok=True)
    if missing:
        print("MISSING", ", ".join(missing), flush=True)
        sys.exit(1)


asyncio.run(main())
