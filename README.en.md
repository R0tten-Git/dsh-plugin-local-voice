# dsh-plugin-voice-input

Real-time speech-to-text inside DeepSeek Harness: a floating transcription panel that writes
each sentence as you speak, plus a local **Qwen3-ASR** recognizer registered into the shipped
speech service.

- **Panel**: bottom-right pill → floating window, live lines, play/pause, minimize, save to md.
- **Engine**: Qwen3-ASR-1.7B-8bit via MLX, loaded once, kept warm, reclaimed after idle.
- **Offline**: audio never leaves the machine; no cloud calls by default.

![Live transcription panel](docs/screenshot.png)

<sub>Speak, pause for 0.95 s, get a line. Pause or minimize while it keeps recording; copy the transcript or save it as markdown.</sub>

## Requirements

| Item | Requirement |
|---|---|
| DSH | Desktop `0.2.0-rc.2` or later, with the shipped **Voice Input** bundle enabled |
| OS / engine | macOS on Apple Silicon (arm64) for the Qwen3 engine |
| Python | 3.10+ with `mlx-audio==0.5.5`, `sounddevice`, `numpy`, `huggingface_hub` |
| Model | `mlx-community/Qwen3-ASR-1.7B-8bit` (2.47 GB) |

On other platforms the panel still loads, but the Qwen3 recognizer is **not** registered — the
shipped SenseVoice recognizer stays in charge.

## Install

1. Plugin page → **Add plugin** → point at this package directory (or the `.tgz`) → install → enable.
2. Prepare the engine (macOS):

```bash
# python environment
uv venv ~/.local/venvs/mlx-audio --python 3.12
~/.local/venvs/mlx-audio/bin/pip install "mlx-audio==0.5.5" sounddevice numpy huggingface_hub

# model — ModelScope by default (fast in mainland China, no extra SDK needed)
python3 scripts/prepare_model.py
# or: --source hf-mirror / --source hf
```

3. Restart DSH. A pill labelled `🎙 实时转写` appears at the bottom right.

## Usage

| Control | Action |
|---|---|
| click the pill | start recording, open the panel |
| ▶ / ⏸ | start / pause (pause keeps the transcript) |
| — | minimize (keeps recording, leaves a tiny `● 01:23`) |
| × | end this session and clear (asks once when there is content) |
| 复制 / 存 md | copy the transcript / save it as markdown |

Sentences are emitted after 0.95 s of silence; a fragment-ending heuristic merges sentences
that were cut mid-way. Filler audio (a bare "嗯") is dropped.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `LIVE_STT_MODEL` | `~/models/Qwen3-ASR-1.7B-8bit` | model directory |
| `LIVE_STT_PYTHON` | `~/.local/venvs/mlx-audio/bin/python` | interpreter that owns mlx-audio |
| `LIVE_STT_MODEL_SOURCE` | `modelscope` | mirror used in the missing-model hint |
| `LIVE_STT_LLM_VERIFY` | `off` | per-sentence LLM proofread (needs DSH's model channel) |

## How it fits together

```
client.js  ──►  ctx.remote.speech.transcribe
                      │
              shipped speech-to-text service
                      │
              index.js provider (qwen3-asr-local)
                      │  ndjson over stdio
              qwen3_worker.py  (model loaded once)
```

The panel talks to the shipped speech remote, so it stays backend-agnostic: whichever
recognizer is selected serves it.

## Limitations

- Depends on the shipped **experimental** voice-input bundle; a DSH upgrade may change those APIs.
- Qwen3 engine is Apple-Silicon only. Windows/Linux fall back to SenseVoice.
- The model is not bundled; it is downloaded by the user.

## License

MIT
