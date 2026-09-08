---
name: voice-notes
description: Handle a voice note or audio attachment the hermit cannot read, and set up transcription when the operator wants it. Activates when a channel message carries an audio attachment (Telegram voice message, Discord voice-message.ogg), or on "can you understand voice notes", "transcribe my voice message", "set up voice notes".
---
# Voice Notes

The channel plugin downloads an audio attachment on its own; the model cannot read audio. Transcription is an operator choice, not a shipped default: it needs a speech-to-text tool where the hermit runs, and possibly a provider key. The recipe lives in `docs/voice-notes.md` beside this plugin; this skill routes, it does not repeat it.

## An audio attachment arrives

With no standing role covering it, reply in channel voice: you received a voice note, you cannot listen to it yet, and you can set that up if they want. Do not guess at the content or ask them to retype it unless they decline setup.

## The operator asks to set it up

Walk them through `docs/voice-notes.md` from chat:

1. Settle one thing over the reply tool, then continue when the answer arrives: should the audio stay on this machine, or is uploading it to a transcription provider acceptable? Self-hosted is the default. Then read only the matching section of the doc, self-hosted or hosted, plus step 2.
2. Install: in Docker, delegate to `/claude-code-hermit:docker-customize` with the tool the doc names. On tmux the hermit runs on the host, so name the host install for the operator rather than running it yourself. A hosted provider needs its key in `.env`; never put a key in the role text or `config.json`.
3. Role: once the tool is in place, save the standing role from the doc through the ordinary "remember" path, substituting the command they ended up with. Offer "for this channel" if they only want it in one chat.
4. Verify: ask them to send a voice note and confirm the reply addresses what they said.

On a prompting permission mode, mention the allow rule from the doc after the first run raises an approval.
