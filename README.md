# WorkflowRemix

**Every file you made is a workflow you can run again.**

WorkflowRemix is a private desktop app for the images, video and audio you make with
[ComfyUI](https://github.com/Comfy-Org/ComfyUI). Browse your library, open any file to see
the workflow inside it, and run it again with a new prompt, seed or model, without
rebuilding a graph. Your library never leaves your computer.

**[Download the latest version](https://github.com/masteroleary/workflow-remix/releases/latest)** ·
[Website and docs](https://workflowremix.com) ·
[Getting started](https://workflowremix.com/docs/getting-started)

## What it does

- **Browse.** A fast grid over your library and ComfyUI's own output folder, with nothing
  to import. Search by file name or by the prompt written inside the file, so "ocean" finds
  the picture even when it is called `Final_0042.png`.
- **Remix.** Open a file and its workflow becomes a form: prompt, seed, steps, models,
  LoRAs, size. Change one thing and run it again, or send the picture through a different
  workflow.
- **Check a workflow before you run it.** Press Enable and the app checks that every
  custom node, model and LoRA the workflow needs is installed, and lists anything missing
  with the folder it goes in.
- **Prompts with keywords.** Write `[character]` in a prompt and pick the answers from your
  library: three answers queue three jobs. Switch the collection and the same prompt comes
  out as a different world.
- **Compare models.** Pick several checkpoints and each one renders on the same seeds, so
  what differs is the model and not the noise.
- **H3 Studio.** Make short MiniMax H3 videos from characters and stories: give each
  character a face, a full body and named looks, write stories in timed scenes with
  dialogue, and render them as one video. Two example projects are included to start from.
- **Video.** Send any picture through an image-to-video workflow, join clips end to end,
  or start the next clip from the last frame of this one.
- **From your phone, privately.** Reach the app over your own Tailscale network. It is
  never on the public internet.

## Private by design

- Your library stays on your computer. Nothing phones home.
- The app runs in its own window and loads nothing from the internet.
- You choose where your data lives, and the app warns if your system search indexes it.
- Blur that comes back on whenever the app goes out of sight, an optional password, and a
  safe mode for shared screens.

## What you need

- **Windows 10 or 11.** macOS and Linux versions are on the way.
- **ComfyUI**, installed and running on the same computer, with your own models and custom
  nodes. WorkflowRemix generates nothing itself; it sends each run to your ComfyUI.

Install it like any other app: no Python and no command line. On first launch you choose
where your data lives and tell it where ComfyUI is. After that it **updates itself**: a new
version downloads in the background and installs when you restart. What changed in each
version is on the [Releases](https://github.com/masteroleary/workflow-remix/releases) page.

---

> WorkflowRemix is an independent product. It is **not affiliated with, endorsed by, or
> sponsored by Comfy Org, Inc.** "ComfyUI" is the branding of Comfy Org. The app contains
> no ComfyUI code; it talks to your own ComfyUI install over its local API.
>
> **Licence:** proprietary. Copyright (c) 2026 Matthew (masteroleary), all rights reserved.
> See [the licence](https://workflowremix.com/licence). The app's source is not published;
> this repository holds its installers and its website (`site/`).
>
> **Acceptable use:** for lawful use by adults (18+) only. See the
> [Acceptable Use Policy](https://workflowremix.com/acceptable-use), which is part of the
> licence terms.
