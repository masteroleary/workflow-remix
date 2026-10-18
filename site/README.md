# The website

The pages at <https://workflowremix.com>: plain pages wrapped in one layout by a small Node
server. No build step and no dependencies; it sends no script to a browser and loads nothing
from anywhere else.

```bash
cd site
npm start        # http://localhost:8791  (HOST=127.0.0.1 keeps it to this machine)
npm test         # Node 22 or newer
```

| Path | What it is |
|---|---|
| `pages/` | One HTML fragment per page. The comment at the top holds its title, description and place in a section; the file's path is its address. |
| `layout.html` | The header, footer and `<head>` every page is wrapped in. |
| `assets/` | The stylesheet and the icons. |
| `legal/` | Copies of the app's `ACCEPTABLE_USE.md` and `LICENSE`, word for word. The policy and licence pages are rendered from them, so replacing a file is the whole of an update. |
| `server.js` | Serves all of it, and reads this repository's release feeds (`latest*.yml`) every ten minutes so the Downloads page links the newest installers by itself. |

`SITE_ORIGIN` names the address the site is published at (default
`https://workflowremix.com`); any other host name it is reached by is served with
`X-Robots-Tag: noindex`.
