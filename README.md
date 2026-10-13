# WorkflowRemix

Browse and curate your AI-generated media (images, video, audio), then **remix** it: rerun
the workflow inside any file with a new prompt, seed or model. A private desktop app for
Windows, macOS and Linux, built to pair with [ComfyUI](https://github.com/Comfy-Org/ComfyUI).

- **Website, documentation and examples:** <https://workflowremix.com>
- **Downloads:** the [Releases](https://github.com/masteroleary/workflow-remix/releases) of
  this repository, which are also where an installed copy looks for updates.

This repository holds the installers and the website. The app's source is not published.

> WorkflowRemix is an independent product. It is **not affiliated with, endorsed by, or
> sponsored by Comfy Org, Inc.** "ComfyUI" is the branding of Comfy Org. The app contains
> no ComfyUI code; it talks to your own ComfyUI install over its local API.
>
> **Licence:** proprietary. Copyright (c) 2026 Matthew (masteroleary), all rights reserved.
> See [the licence](https://workflowremix.com/licence).
>
> **Acceptable use:** for lawful use by adults (18+) only. See the
> [Acceptable Use Policy](https://workflowremix.com/acceptable-use), which is part of the
> licence terms.

## The website (`site/`)

Plain pages wrapped in one layout by a small Node server. No build step and no
dependencies; it sends no script to a browser and loads nothing from anywhere else.

```bash
cd site
npm start        # http://localhost:8791  (HOST=127.0.0.1 keeps it to this machine)
npm test         # Node 22 or newer
```

| Path | What it is |
|---|---|
| `site/pages/` | One HTML fragment per page. The comment at the top holds its title, description and place in a section; the file's path is its address. |
| `site/layout.html` | The header, footer and `<head>` every page is wrapped in. |
| `site/assets/` | The stylesheet and the icons. |
| `site/legal/` | Copies of the app's `ACCEPTABLE_USE.md` and `LICENSE`, word for word. The policy and licence pages are rendered from them, so replacing a file is the whole of an update. |
| `site/server.js` | Serves all of it, and reads this repository's release feeds (`latest*.yml`) every ten minutes so the Downloads page links the newest installers by itself. |

`SITE_ORIGIN` names the address the site is published at (default
`https://workflowremix.com`); any other host name it is reached by is served with
`X-Robots-Tag: noindex`.
