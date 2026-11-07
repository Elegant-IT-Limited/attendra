#!/usr/bin/env bash
# Makes the caller's lines in lines.json as short 16 kHz mono WAVs (<script>-<n>.wav), with Piper and its
# LJSpeech voice: the model is MIT and the voice's recordings are public domain, so the files can live here.
# Only needed when lines.json changes; the WAVs are committed.
#
#   python3 -m venv .venv && .venv/bin/pip install piper-tts
#   curl -LO https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx
#   curl -LO https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx.json
#   PIPER=.venv/bin/piper PIPER_VOICE=en_US-ljspeech-medium.onnx ./make.sh
#
# Resampling uses ffmpeg, or afconvert on macOS.
set -euo pipefail
cd "$(dirname "$0")"
piper="${PIPER:-piper}"
voice="${PIPER_VOICE:?PIPER_VOICE: the path to en_US-ljspeech-medium.onnx}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
node -e 'const l = require("./lines.json"); for (const [k, v] of Object.entries(l)) v.forEach((t, i) => console.log(`${k}-${i + 1}\t${t}`));' |
while IFS=$'\t' read -r name text; do
  printf '%s' "$text" | "$piper" -m "$voice" -f "$tmp/$name.wav" >/dev/null 2>&1
  if command -v ffmpeg >/dev/null; then ffmpeg -loglevel error -y -i "$tmp/$name.wav" -ac 1 -ar 16000 -sample_fmt s16 "$name.wav"
  else afconvert -f WAVE -d LEI16@16000 -c 1 "$tmp/$name.wav" "$name.wav"; fi
  echo "$name.wav"
done
