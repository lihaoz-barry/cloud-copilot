# Vendored browser libraries

This app has **no build step** and is served over LAN — often with no internet
access at all. Everything the chat UI needs is therefore committed here and
loaded from the same origin; nothing is ever fetched from a third-party CDN at
runtime.

| File | Library | Version | License |
| --- | --- | --- | --- |
| `marked.min.js` | [marked](https://github.com/markedjs/marked) | 15.0.7 | MIT |
| `purify.min.js` | [DOMPurify](https://github.com/cure53/DOMPurify) | 3.2.4 | Apache-2.0 / MPL-2.0 |
| `highlight.min.js` | [highlight.js](https://github.com/highlightjs/highlight.js) (common languages bundle) | 11.11.1 | BSD-3-Clause |
| `highlight-github-dark.min.css` | highlight.js "GitHub Dark" theme | 11.11.1 | BSD-3-Clause |

They are consumed by `public/chat-render.js` (`CCChat`), the single markdown /
streaming renderer shared by the PR chat panel, the pre-issue chat panel, the
Admin Terminal and the pipeline log panels.

## Refreshing a library

```bash
cd public/vendor
curl -sSLO https://cdn.jsdelivr.net/npm/marked@<ver>/marked.min.js
curl -sSL  -o purify.min.js https://cdn.jsdelivr.net/npm/dompurify@<ver>/dist/purify.min.js
curl -sSL  -o highlight.min.js https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@<ver>/highlight.min.js
curl -sSL  -o highlight-github-dark.min.css \
  https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@<ver>/styles/github-dark.min.css
```

Then bump the version in the table above.
