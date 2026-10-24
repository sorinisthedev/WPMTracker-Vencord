# WPMTracker for Vencord

A [Vencord](https://github.com/Vendicated/Vencord) plugin that shows how fast people typed their Discord messages. A badge such as `183 WPM · 2.0s` appears after each message.

> **Credits:** This is a Vencord port of **[WPMTracker](https://github.com/OkAlexJ/WPMTracker)** by **[OkAlexJ](https://github.com/OkAlexJ)** (astricxzs), originally written for BetterDiscord. The idea, the timing method, and most of the logic are theirs. This repo only adapts it to Vencord's plugin API. Please star the original.

## Features

- **Badge after every message** showing WPM, seconds, or both. Click a badge to cycle between them.
- **Colored by speed:** gray under 40, green 40+, blurple 70+, pink 100+.
- **Live counter** above the chat box while you type.
- **Per-user stats table** in the plugin settings: average, best, and last WPM, average time, and message count.
- **Pasted text filter:** pasted text and implausible speeds (above 250 WPM by default) are ignored.

## How it works

Discord never sends other people's keystrokes. It only sends a "started typing" event, re-sent about every 10 seconds while they keep typing. So for other users:

```
time ≈ first typing event of the burst → message arrives
WPM  ≈ (characters / 5) / time
```

For your own messages the plugin sees real keystrokes, so it measures both active typing time (pauses over 2s are capped) and total time until sent.

Because of this, numbers for other people are **estimates**, and they only show for messages typed while you had that channel open.

## Install

Vencord userplugins need a [source build of Vencord](https://docs.vencord.dev/installing/).

1. Clone and set up Vencord:
   ```bash
   git clone https://github.com/Vendicated/Vencord
   cd Vencord
   pnpm install --frozen-lockfile
   ```
2. Copy the `wpmTracker` folder from this repo into `Vencord/src/userplugins/`.
3. Build and inject:
   ```bash
   pnpm build
   pnpm inject
   ```
4. Restart Discord, then go to **User Settings → Vencord → Plugins** and enable **WPMTracker**.

## Settings

| Setting | Default |
| --- | --- |
| Show badges | on |
| Badge shows | WPM + seconds |
| Seconds measure | Time spent typing |
| Color badges by speed | on |
| Live WPM while typing | on |
| Track your own speed | on |
| Ignore bots | on |
| Word counting | Standard (5 chars = 1 word) |
| Ignore messages faster than | 1.5 s |
| Discard results above | 250 WPM |

## License

The original WPMTracker repository does not state a license, so all rights to the original code stay with its author. Vencord plugin boilerplate follows Vencord's GPL-3.0-or-later.
