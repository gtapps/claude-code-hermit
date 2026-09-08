# Voice Notes

Send a voice note to your hermit over Discord or Telegram and it downloads the file on its own, the same way it handles photos and documents. It cannot listen to it: the model reads text, images, and PDFs, not audio. Out of the box the hermit tells you so and offers to set transcription up. This page is the setup.

Only a channel delivers an audio file. Through the Claude app, [dictation and voice mode](https://support.claude.com/en/articles/11101966-use-voice-mode) transcribe as you speak, so nothing here is needed.

Two steps: put a speech-to-text tool where the hermit runs, then tell the hermit to use it.

## 1. Install a speech-to-text tool

Where the tool goes depends on how the hermit runs:

- **Docker:** it has to be in the image or the bind mount. Ask the hermit "install whisper.cpp and ffmpeg in the container" and the [`docker-customize`](../skills/docker-customize/SKILL.md) skill routes it.
- **tmux:** the hermit runs on the host, so install the tool on the host and make sure it is on the PATH of the shell that runs `hermit-start`.

Then pick a tool. Self-hosted keeps the audio on the box, which is the point of a hermit.

### Self-hosted: whisper.cpp (default)

One binary and a model file, no Python, a few hundred megabytes of RAM while a note is transcribed and nothing resident afterwards. Voice notes arrive as OGG/Opus and whisper.cpp wants 16 kHz mono WAV, so install `ffmpeg` alongside it. Download a model once, next to the binary; `base` is a good first pick, `small` is more accurate on non-English speech and several times slower.

The command the hermit will run:

```bash
ffmpeg -loglevel error -y -i "$IN" -ar 16000 -ac 1 /tmp/note-$$.wav && whisper-cli -m /path/to/ggml-base.bin -f /tmp/note-$$.wav -nt
```

The `$$` keeps the scratch WAV per-invocation, so a second note (or a second hermit on the same host) never lands on a file the first one owns.

### Self-hosted: the `openai-whisper` package (GPU hosts)

Same models and the same transcripts, on Python and PyTorch. On a CPU box it is heavier on every axis: PyTorch is a multi-gigabyte install, and the README's table puts `base` at about 1 GB and `small` at about 2 GB of memory to load. On a host with a GPU it is the fastest self-hosted option, and its `turbo` model runs at roughly eight times the speed of `large`. Needs `ffmpeg` too.

```bash
pip install -U openai-whisper
whisper "$IN" --model turbo --output_format txt --output_dir /tmp && cat "/tmp/$(basename "${IN%.*}").txt"
```

`whisper` names its output after the input file, not after a fixed name, which is what the `basename` does. The container image ships no Python, and on Ubuntu 24.04 and newer the system Python is externally managed, so the `pip` line needs `python3` plus a virtualenv (or `pipx`) first. `docker-customize` § 2 is where that boot-time work goes.

`faster-whisper` is a third self-hosted runtime, generally the quickest on CPU, but it is a Python library rather than a command and needs a short wrapper script.

### Hosted: a transcription API

Audio is uploaded to the provider. No install beyond `curl` and `jq`, which the image has, and the same command on Docker and tmux. Put the key in `.env` (never in `config.json` or the role text). OpenAI lists `whisper-1` and `gpt-4o-transcribe` at $0.006 per minute and `gpt-4o-mini-transcribe` at $0.003 per minute as of September 2026; check your provider's pricing and endpoint. Shape of the call:

```bash
curl -sS https://api.openai.com/v1/audio/transcriptions -H "Authorization: Bearer $OPENAI_API_KEY" -F "file=@$IN" -F model=whisper-1 | jq -r .text
```

## 2. Tell the hermit to use it

Save a standing role from chat, in your own words. Example:

> remember: when a voice note arrives, download it, run `ffmpeg -loglevel error -y -i "<file>" -ar 16000 -ac 1 /tmp/note-$$.wav && whisper-cli -m /path/to/ggml-base.bin -f /tmp/note-$$.wav -nt` on the downloaded file, and treat the transcript as my message

Pinning the role to one chat, listing roles, and forgetting one are covered in [Talk to Your Hermit](how-to-use.md#talk-to-your-hermit).

The downloaded file lands in the `inbox/` of the channel plugin's state dir: `.claude.local/channels/<channel>/inbox/` on a bare-host boot, and `~/.claude/channels/<channel>/inbox/` as the container sees it (compose bind-mounts the first onto the second). Either way the hermit gets the exact path from the download and substitutes it into the command.

Then send a voice note and check the reply addresses what you said.

## Permissions

Under the default `auto` permission mode a local binary reading an inbox file ran without a prompt in testing on Claude Code 2.1.263; expect the same, not a guarantee. On a prompting mode the first run raises one relayed approval; to stop that, add an allow rule in `.claude/settings.local.json` for every binary in the chain (`Bash(ffmpeg:*)` and `Bash(whisper-cli:*)` for the whisper.cpp recipe).

## Not covered

The hermit can transcribe a note, not send one. Reply audio would need text-to-speech, which nothing here provides.
