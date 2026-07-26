---
name: ui-test
description: Validate and improve a web UI with headless Playwright — navigate, screenshot, and detect layout, sizing, contrast and readability problems (text misalignment, buttons too small, hard-to-read text, horizontal overflow, overlapping controls, console errors). Use when a change touches web UI, when an issue is labelled `ui-validation`, or when the user says "UI test", "check the UI", "跑一下 UI 测试", "验证界面". Skip entirely for non-web projects (e.g. iOS).
---

# UI test — headless browser validation of web UI changes

Turns "does the UI still look right?" into **measured findings**, not opinions.
Runs headless Chromium via Playwright, so it works unattended inside `copilot -p`.

## When this applies

Run it when **both** are true:

1. The repo is a **web** project — it declares a `ui` block in `.cloud-copilot.json`
   (see below), or it obviously serves HTML (`public/*.html`, Next/Vite/CRA config).
2. The change under test touches the UI — modified files match
   `*.html`, `*.css`, `*.jsx`, `*.tsx`, `*.vue`, `*.svelte`, or the issue carries
   the `ui-validation` label.

**Skip silently** for anything else. iOS/native repos (`*.xcodeproj`) have no UI
test stage — say so in one line and move on. Never block a PR on a UI check that
does not apply.

## Configuration — `.cloud-copilot.json`

```json
{
  "ui": {
    "enabled": true,
    "startCommand": "npm start",
    "port": 8899,
    "baseUrl": "http://127.0.0.1:8899",
    "readyPath": "/",
    "routes": ["/", "/settings"],
    "viewports": [[390, 844], [1440, 900]],
    "storageState": ".auth/state.json",
    "minTapTarget": 44
  }
}
```

Every key is optional except `enabled`. Defaults: routes `["/"]`, viewports
`390x844` (phone) and `1440x900` (desktop), tap target `44`px.

## Steps

1. **Decide.** Read `.cloud-copilot.json`. No `ui.enabled` and no obvious web
   entry point → skip and report "not a web project — UI test skipped".

2. **Start the app on a scratch port.** Never reuse the port the app already runs
   on, and never restart the production instance:

   ```bash
   PORT=8899 nohup <ui.startCommand> > /tmp/ui-test.log 2>&1 &
   ```

   > ⚠️ **cloud-copilot testing itself:** `npm run cc:restart` kills
   > `node server.js` — running it would terminate the very job doing the test.
   > Always launch a second instance with an explicit `PORT` instead, and kill
   > only that PID when done (`kill <pid>`, never `pkill`).

3. **Audit.** From the repo root:

   ```bash
   node ~/.agents/skills/ui-test/scripts/audit.mjs \
     --config .cloud-copilot.json \
     --out /tmp/ui-audit
   ```

   Or pass things explicitly:

   ```bash
   node ~/.agents/skills/ui-test/scripts/audit.mjs \
     --base-url http://127.0.0.1:8899 --route / --route /settings \
     --viewport 390x844 --viewport 1440x900 --out /tmp/ui-audit
   ```

   Exit code `1` means at least one **error**-severity finding. A markdown table
   goes to stdout; `report.json` and full-page PNGs land in `--out`.

   The script needs `playwright` + `axe-core` (dev deps of the cloud-copilot repo)
   and a browser: `npx playwright install chromium` once per machine.

4. **Read the findings.** Severity meanings:

   | check | severity | what it means |
   | --- | --- | --- |
   | `navigation`, `http-status` | error | the page didn't even load |
   | `console-error`, `failed-request` | error | runtime JS error or 4xx/5xx request |
   | `horizontal-overflow` | error | page scrolls sideways — layout is broken at that width |
   | `text-outside-viewport` | error | text spills past a viewport edge |
   | `overlapping-controls` | error | two interactive elements cover each other |
   | `a11y:color-contrast` | error | text fails WCAG contrast — the objective form of "hard to read" |
   | `tap-target-too-small` | warn | interactive element under 44×44 on a touch-sized viewport |
   | `text-too-small` | warn | body text under 12px |
   | `content-clipped` | warn | a box hides part of its own content |
   | `a11y:*` (other) | warn | serious/critical axe violations (missing labels, structure) |
   | `text-truncated` | info | ellipsised text — usually intentional |

5. **Interact when the issue demands it.** For flows (open a drawer, submit a
   form), drive the page with the **playwright MCP server** — `browser_navigate`,
   `browser_click`, `browser_type`, `browser_snapshot`, `browser_take_screenshot`.
   Prefer `browser_snapshot` (accessibility tree, plain text) over screenshots
   for assertions; it's far cheaper and more precise than reading pixels.
   Re-run `audit.mjs` against any route you can reach by URL.

6. **Fix what you found.** Errors are non-negotiable; fix them before finishing.
   For warnings, fix the ones your change introduced and mention the pre-existing
   ones rather than silently expanding scope. Typical remedies:
   - `horizontal-overflow` / `text-outside-viewport` → `max-width: 100%`,
     `min-width: 0` on flex children, `overflow-wrap: anywhere`
   - `tap-target-too-small` → grow padding or set `min-height/min-width: 44px`
   - `a11y:color-contrast` → darken/lighten the foreground until ratio ≥ 4.5:1
   - `a11y:select-name` / missing labels → add `aria-label` or a real `<label for>`

7. **Re-run until clean**, then kill the scratch server.

8. **Review the screenshots.** Only after steps 4–7 pass, look at the PNGs in
   the output dir and judge what a script cannot: visual hierarchy, alignment,
   spacing rhythm, whether the change actually looks like what the issue asked
   for. Report at most a handful of concrete, actionable observations.

9. **Report.** Paste the findings table into the PR body (or the chat reply)
   under a `## UI validation` heading, state the before/after error counts, and
   list what you changed. Attach or reference the screenshot paths.

## Notes

- Screenshots are written outside the repo by default (`/tmp/ui-audit`). If you
  keep them, put them under an ignored path — never commit binaries to the PR.
- The auditor freezes animations, transitions and carets so runs are comparable.
- Findings are per route **and** per viewport; the same problem legitimately
  appears twice when it exists at both widths.
- Authenticated pages: point `ui.storageState` at a Playwright `storageState`
  JSON. Without it, the audit only sees the logged-out UI.
- Keep the run bounded — a handful of routes, two viewports. This is a gate, not
  a full test suite.
