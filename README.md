# ☁️ cloud-copilot

A phone-friendly **issues console** for driving the local GitHub Copilot CLI over
your LAN/VPN. From your phone you can:

- browse the git repos under an **authorized root** (`REPOS_ROOT`), with a
  per-device **repo filter** (checkbox show/hide, persisted in `localStorage`)
- expand a repo to see its **GitHub issues** (fetched via `gh`, cached, refreshable);
  every expand also **auto-discovers PRs** referencing those issues (one `gh pr
  list` call, matched in-process) so the pipeline is populated without a manual
  step — a per-issue **↻ PRs** button remains for an explicit, always-live re-check
- run every PR through a **3-stage pipeline — Create PR → Deploy → Merge** — shown
  as one row per PR with a colored pill per stage (blue = planned, yellow =
  running, green = done, red = failed), each with its own collapsible log
- **Deploy is per-repo configurable**: iOS repos ship to TestFlight via the
  `testflight-deploy` skill; other repos (cloud-copilot itself included) just run
  a shell command you define (e.g. restart the local service) — see
  [`.cloud-copilot.json`](#per-repo-deploy-config-cloud-copilotjson) below
- **Merge** (`gh pr merge --merge --delete-branch`) unlocks once Deploy succeeds;
  you can still force it early behind a confirm if you're confident
- **click a PR** to open its own **detail page** (`#/pr/<repo>/<issue>/<pr>`,
  bookmarkable/shareable) — same pipeline, plus a **Deploy History** list (every
  build number/version/status the PR has ever shipped, not just the latest) and
  a **chat panel** to keep iterating on the PR's code — see
  [Chat with a PR](#chat-with-a-pr-plan--apply) below
- **pin any issue** (📌, next to its GitHub link) to a "Pinned" section at the very
  top of the page — persisted per-device in `localStorage`, no server state; a
  pinned card is a fully live clone of the issue (same Create PR / Deploy /
  Merge pipeline), just easier to find across repos
- a **floating "⏩ Depth" control** (bottom-right, stays put while you scroll) lets
  you pick how far a run auto-advances — Create PR only, through Deploy, or all
  the way through Merge — so one click on Create PR can walk the whole pipeline
- **Abort** a running Create PR, Deploy, or Merge (kills the whole process group);
  aborted runs get their own state and can be re-run after a confirm
- watch every run **stream live** in **collapsible per-action logs** (hidden by
  default), with success/failure shown **on the issue** and lifecycle timing cached
- **one PR creation per repo at a time** — other issues in that repo are greyed out
  while one is in progress, to avoid working-tree collisions
- a **⚙ Settings** panel (mode / model / repo filter) that fits a phone, plus a
  **Restart main** button that checks out `main`, pulls, and restarts cloud-copilot

This is a proof-of-concept for remotely driving a local coding-agent CLI from a web UI.

---

## How it works

`gh` (already logged in on your Mac) provides all GitHub reads — **no MCP or token
wiring needed**. The four tabs you see in the Copilot CLI TUI (Session / Issues /
Pull requests / Gists) are Copilot's own built-in GitHub views; this app reproduces
the Issues + PR flow through `gh` + `copilot -p`.

Per-issue state is a small machine persisted to `data/state.json`. Each issue keeps
one **work** (Create PR) record plus a map of **PRs**, and every PR carries its own
**deploy** and **merge** lifecycle (status, start/finish, `durationMs`, transcript):

| Stage      | idle              | running           | success         | failed / aborted                |
| ---------- | ----------------- | ----------------- | --------------- | -------------------------------- |
| Create PR  | `Create PR` 🔵    | `Creating PR…` 🟡  | issue turns 🟢  | `PR failed` 🔴 / `PR aborted`    |
| Deploy     | `Deploy` 🔵       | `Deploying…` 🟡    | `Deployed` 🟢   | `Deploy failed` 🔴 / `Aborted`   |
| Merge      | `🔒 Merge` 🔵 (dim until Deploy succeeds) | `Merging…` 🟡 | `Merged` 🟢 | `Merge failed` 🔴 / `Aborted` |

Each PR renders as one row across all three stages — a **Create PR | Deploy |
Merge** pipeline, matching the state machine above: blue = planned, yellow =
running, green = done, red = failed.

- **Success shows on the issue**, not the button: on a created PR the issue gets a
  green border + green `#number`, and the **Create PR** button stays "Create PR".
- **Per-action logs** are hidden by default. A small `▤` toggle by **Create PR**
  reveals the creation log; each PR row has `▤` toggles for its Deploy and Merge logs.
- **Abort**: while running, Create PR / Deploy / Merge each show a red `⨯` button.
  Confirming signals the whole process group (copilot + fastlane/xcodebuild/gh), so
  subprocesses die too; the run ends in an `aborted` state you can re-run.
- **Re-deploy**: clicking Deploy on a finished/failed/aborted PR asks to confirm
  before starting a new run.
- **Merge is gated on Deploy succeeding** — the Merge cell stays a dimmed, locked
  `🔒 Merge` until then. You can still click it early; it asks you to confirm a
  **force-merge** that skips the gate.
- Success/failure is decided by the CLI/command **exit code** plus detection: a PR
  URL in the transcript (fallback: `gh pr list` referencing the issue) for Create
  PR; a fastlane/TestFlight success marker for an `ios-testflight` Deploy (plain
  exit code for a `shell` Deploy); `gh pr merge`'s own exit code for Merge.
- **Build number / version for `ios-testflight` deploys are never guessed from
  text.** Before invoking Copilot, the server checks out the PR's branch and
  computes `buildNumber = git rev-list --count HEAD` (the same value `fastlane
  beta` itself defaults to) and reads `version` straight from the Xcode
  project's own `MARKETING_VERSION`. Both are then **pinned explicitly** —
  `fastlane beta build:<n> version:<v>` — so what cloud-copilot records and
  displays is guaranteed to match what was actually built, not inferred
  after the fact from the agent's free-form report.

### Auto-run depth

A floating **⏩ Depth** button (top-right, fixed — stays visible while you scroll)
opens a drawer with three options for how far a run should auto-advance once you
click **Create PR**:

| Depth | Behavior |
| ----- | -------- |
| **Create PR only** (default) | Stop once the PR is created — today's original behavior. |
| **…through Deploy** | After Create PR succeeds, automatically run Deploy. |
| **…through Merge** | Keep going through Deploy, then Merge — no further clicks. |

A stage only advances on **success**; a failure or abort at any point simply stops
the chain. The choice is saved per-device in `localStorage`.

### Task completion alerts (sound + system notification)

Long runs are meant to be started and forgotten about, so the console tells you
the moment **any** action (Create PR / Deploy / Merge / a PR, pre-issue or admin
chat turn) reaches a terminal state:

1. a short chime — a rising one for success, a falling one for failure/abort,
2. an OS notification, but only when the tab is **not** visible + focused, so it
   never fires while you're already watching the log,
3. `navigator.vibrate()` where the platform supports it,
4. an in-page toast, which always shows and is the graceful-degradation path.

The floating **🔔 Alerts** button (bottom-left) opens a drawer with independent
**Sound & vibration** and **System notifications** toggles plus a **Test
notification** button. Both settings are per-device (`localStorage`) and default
to on.

All of this hangs off a single hook in `pumpSSE()`: every long action streams
through `lib/jobs.js`, which always emits a `meta` event carrying the job's
status before replaying, so one code path covers every button. That `meta` also
gives the "did this job finish before I was looking?" answer — a job whose
completion is only ever *replayed* to this page, and which the page never saw
running, stays silent.

#### iOS / mobile Safari

| Platform | Works? |
| -------- | ------ |
| Desktop Chrome / Firefox / Safari | Yes, no install needed — just grant permission. |
| Android Chrome | Yes, including vibration. |
| iOS Safari, **installed to the Home Screen** | Yes (iOS 16.4+). |
| iOS Safari, plain tab | `window.Notification` doesn't exist; the drawer detects this and shows an **Add to Home Screen** hint instead of failing silently. Sound + toast still work. |

Two iOS quirks are handled explicitly:

- **Audio needs a gesture.** The chimes are primed (played muted, then paused)
  on the first tap/keypress anywhere in the app, so a later completion can play
  them without a fresh gesture.
- **Notifications need a PWA + a service worker.** `public/manifest.webmanifest`
  and `public/sw.js` are what make "Add to Home Screen" produce a standalone app
  that iOS will deliver notifications to; iOS also only allows
  `registration.showNotification()`, never `new Notification()`.

Permission is only ever requested from a real tap (the toggle or the Test
button), never on page load.

**Not covered (follow-up):** Web Push (VAPID) so alerts arrive with the app
fully closed. Phase 1 fires notifications from the page itself, which covers the
"app backgrounded / screen briefly locked" case, not "app killed".

### Settings panel (⚙, top-right of Home)

Mode, model and the per-device repo filter all live behind a single `⚙ Settings`
button, so the header fits a phone (no horizontal overflow at 390px). The panel
is `min(280px, calc(100vw - 24px))` wide, clamped inside the viewport, scrolls
internally for long repo lists, and ellipsises long model names. It closes on
`Esc` (returning focus to the trigger) or an outside click, and `aria-expanded`
reflects its state. A dot on the trigger warns that the repo filter is currently
hiding something.

- **Mode** — Allow All / Granular / Default (applies to every Copilot run).
- **Model** — the model every Copilot invocation uses (`GET`/`POST
  /api/settings/model`, persisted in `data/state.json`).
- **This instance** — only shown when cloud-copilot is itself served from a repo
  under `REPOS_ROOT`. Displays that repo's current branch plus a **Restart main**
  button.
- **Show repositories** — the repo checkboxes (All / None), stored per device in
  `localStorage`.

#### Restart main

One click to answer "does `main` still work?": the server stashes any
uncommitted changes (`cloud-copilot restart-main <timestamp>` — never silently
discarded), checks out the default branch, `git pull --ff-only`s, and restarts
itself.

The restart is deliberately *not* `pkill`-based. `POST
/api/settings/self/restart-main` flushes its JSON result **first**, then spawns a
detached (`detached: true`, own session) shell that waits for this process's PID
to disappear before running `npm start`, and only then does the server exit — so
the handover is deterministic and unrelated `node` processes are never killed.
The browser doesn't sit on the dead request either: it polls `GET /api/health`
until a *different* `startedAt` answers (120s timeout), then reloads.

It takes the same per-repo working-tree lock as Create PR / Deploy / Chat (it
switches branches), so a conflict is reported with the usual blocked message.

### Per-repo deploy config (`.cloud-copilot.json`)

Deploy is dispatched per-repo. Drop a `.cloud-copilot.json` at a repo's root:

```json
{ "deploy": { "type": "ios-testflight" } }
```
```json
{ "deploy": { "type": "shell", "command": "npm run cc:restart" } }
```

- **`ios-testflight`** — runs Copilot with the `testflight-deploy` skill, exactly
  like the original hardcoded flow. If no config file is present, a repo with an
  `.xcodeproj`/`.xcworkspace` at its root is auto-detected as `ios-testflight`.
- **`shell`** — checks out the PR's branch, then runs `command` directly (no
  agent involved — it's deterministic). cloud-copilot dogfoods this on itself: see
  its own [`.cloud-copilot.json`](.cloud-copilot.json) and the `cc:restart` script
  in [`package.json`](package.json), which kills the running `node server.js` and
  starts a fresh one — the same restart done by hand during development.
- No config and no Xcode project detected → Deploy is disabled with a message
  pointing here. cloud-copilot never guesses a shell command for an unconfigured
  repo.

### Chat with a PR (plan → apply)

Click any PR to open its detail page (`#/pr/<repo>/<issue>/<pr>`). Below the same
pipeline you get:

- **Deploy History** — every past deploy attempt for that PR (build number,
  version, status, timestamp), archived automatically whenever a new Deploy
  starts. The pipeline above only ever shows the *current* attempt; this list is
  where the full history lives.
- **Chat with this PR** — describe a change in plain text. It's a **two-turn**
  flow:
  1. **Send (plan)** resumes the PR's own conversation (or, on the very first
     turn, the original Create-PR session, so it has full context) and asks
     Copilot to read the code and propose a plan **without touching any
     files** — enforced by running with the same restrictive `default`
     approval mode as read-only actions, not just prompted.
  2. Once a plan comes back, the button becomes **Execute this plan** — this
     resumes the *same* session and actually implements it: commits and pushes
     **to the existing PR branch** (no new PR, no force-push), so PR history on
     GitHub is just new commits, same as pushing manually.
  - A successful "Execute this plan" **resets Deploy and re-locks Merge** for
    that PR (the old build no longer reflects the new code) — the just-applied
    turn's page reload shows this immediately, and the previous Deploy attempt
    is preserved in Deploy History rather than lost.
  - **Image attachments**: drag an image onto the message box, paste a
    screenshot, or tap the 📎 button (opens the native photo picker on mobile)
    to attach up to 4 images to a turn. Attached images are passed to Copilot
    via `--attachment` and stay visible as thumbnails in the conversation
    history after reload. The same attachment support is available in the
    Admin Terminal composer.

### Non-blocking chat: type ahead, queue, pick a model

Every composer (PR chat, PreIssue chat, Admin Terminal) shares the same
behaviour:

- **The input never locks while a reply streams.** Anything sent mid-stream is
  **queued** (the send button reads *Queue*) and shown as a grey "QUEUED"
  bubble at the bottom of the conversation. Queued turns are dispatched
  automatically in FIFO order, each getting its own reply bubble.
  Only one Copilot process may run per chat (the job key is per PR / PreIssue /
  admin turn and the conversation is chained with `--resume`), so this is
  strictly *serial type-ahead*, not parallel conversations.
- **Per-message controls**: ✕ drops a queued message, ⚡ sends it *now* — it
  jumps to the front of the queue and the running turn is aborted.
- Aborting a turn does **not** clear the queue: the next queued message goes out
  as soon as the aborted turn ends.
- Queued messages (with their attachments, where size permits) are mirrored to
  `localStorage`, so a refresh or a dropped phone connection doesn't throw away
  what was already typed — they resume sending after the live turn has been
  re-attached.
- **Per-chat model picker** next to each composer, populated from
  `/api/settings/model`. It starts at the global default, but changing it only
  affects *that chat's* following turns — the homepage setting is never
  silently overwritten. The model is captured **when a message is queued**, so
  switching the dropdown afterwards never rewrites what's already waiting, and
  each reply bubble carries a small badge naming the model that answered.
  If the model list can't be loaded the picker shows `(unavailable)` and is
  disabled — sending still works and the server falls back to the global model.
- **Enter sends**, Shift+Enter inserts a newline, ⌘/Ctrl+Enter still sends.
  Enter never fires mid-IME-composition (so picking Chinese/Japanese candidates
  is safe), and on touch devices Enter always inserts a newline — sending there
  goes through the button, so a soft keyboard can't fire off a message.

---

## API

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET  | `/api/repos` | List git repos under `REPOS_ROOT` (with remotes). |
| GET  | `/api/health` | Liveness probe: `{ ok, pid, startedAt }`. Polled by the client while the server restarts itself. |
| GET  | `/api/settings/model` | Current model + the selectable list. `POST` the same path to change it. |
| GET  | `/api/settings/self` | The cloud-copilot repo serving this app: `{ repo, branch, defaultBranch, dirty, busy }`, or `{ repo: null }`. |
| POST | `/api/settings/self/restart-main` | **Restart main** — stash if dirty, check out the default branch, `pull --ff-only`, then restart detached. Takes the repo working-tree lock; `409` when it's held. |
| GET  | `/api/repos/:name/issues[?refresh=1]` | List open issues (cached 5 min) merged with local status; includes `activeWorkIssues` (repo lock). Also auto-discovers and persists PRs referencing these issues (one whole-repo `gh pr list`, cached 5 min, `?refresh=1` bypasses it too). |
| GET  | `/api/repos/:name/issues/:n/record` | Full stored record (work + per-PR deploy/merge, transcripts, `live` flags). |
| GET  | `/api/repos/:name/issues/:n/prs` | Force-refresh the PR list for one issue from GitHub — always live, bypasses the whole-repo PR cache. |
| POST | `/api/repos/:name/issues/:n/work` | **Create PR** — SSE stream. Body: `{ "mode": "allow-all" }`. |
| POST | `/api/repos/:name/issues/:n/work/cancel` | Abort the running PR creation. |
| POST | `/api/repos/:name/issues/:n/deploy/:pr` | **Deploy a specific PR** — SSE stream. Dispatched per the repo's `.cloud-copilot.json`. |
| POST | `/api/repos/:name/issues/:n/deploy/:pr/cancel` | Abort the running deploy for that PR. |
| POST | `/api/repos/:name/issues/:n/merge/:pr` | **Merge a specific PR** — SSE stream. Body: `{ "force": false }`. Blocked unless Deploy succeeded, unless `force: true`. |
| POST | `/api/repos/:name/issues/:n/merge/:pr/cancel` | Abort the running merge for that PR. |
| POST | `/api/repos/:name/issues/:n/prs/:pr/chat` | **Chat with a PR** — SSE stream. Body: `{ "message": "...", "mode": "plan"\|"apply", "model": "..." }`. `plan` is read-only (default approval flags); `apply` implements + pushes to the existing branch and resets Deploy/Merge on success. The optional `model` overrides the global setting for that turn only (unknown values fall back to it). |
| POST | `/api/repos/:name/issues/:n/prs/:pr/chat/cancel` | Abort the running chat turn for that PR. |
| POST | `/api/run` | Simple one-shot demo (prompt + optional `sessionId` resume). |

### SSE events

`meta` (command) → `chunk` (`{stream,text}` streamed output) → `session`
(`{sessionId}`) → `result` (`{action,status,prUrl?,prNumber?}`, where `status` is
`success`/`failed`/`aborted`, or `blocked` when the repo lock rejects a second
Create PR, or Merge is attempted before Deploy has succeeded) → `done` (`{exitCode}`).

---

## Deploy uses your existing `testflight-deploy` skill

The **Deploy** button runs `copilot -p` with a prompt that invokes your personal
`testflight-deploy` skill (`~/.agents/skills/testflight-deploy/`), which already
encodes the correct signing team, bundle id, and App Store Connect API key for
`ios-diet-expert`. (The generic `ios-deploy` skill is intentionally **not** used —
`testflight-deploy` supersedes it.)

---

## Replicate on another machine

Everything needed to reproduce the **Create PR** + **Deploy** chain on a fresh Mac
is bundled in this repo — as both an automated script and a guided skill.

```bash
git clone <this-repo> && cd cloud-copilot
./setup/setup.sh                     # Copilot CLI + gh + skills + .p8 + fastlane
```

The script is idempotent and prints a ✓/✗ summary. Flags:

| Flag | Effect |
| ---- | ------ |
| `--skills-scope global` (default) | Symlink `skills/*` into `~/.agents/skills/` so Copilot finds them everywhere |
| `--skills-scope project` | Keep skills in-repo; link per-project yourself |
| `--override-global-skills` | Replace an existing global skill of the same name |
| `--fix-keychain` | One-time `codesign` keychain grant (prompts for your login password) |
| `--no-install` | Verify only, install nothing |

**Bundled skills** (`skills/`):
- `create-pr` — implement an issue end-to-end and open a PR (the Create PR flow).
- `testflight-deploy` — build + upload to TestFlight via fastlane (the Deploy flow).
- `cloud-copilot-setup` — a step-by-step guide an agent can read to do the setup
  interactively, if you'd rather not run the script.

**Secrets stay local.** Real App Store Connect identifiers go in
`~/.config/cloud-copilot/deploy.env` (created from
[`setup/deploy.env.example`](setup/deploy.env.example)); the `.p8` key lives under
`~/.appstoreconnect/private_keys/`. Both are gitignored — nothing sensitive is
committed. Fill `deploy.env`, then re-run the script to install the key.

> Skills scope: use **global** to make Deploy work from any app repo (recommended),
> or **project** to leave a machine's existing global skills untouched and reference
> the in-repo copies explicitly.

---

## Architecture

```
┌────────────┐   POST /api/run (SSE)   ┌──────────────────┐   spawn    ┌────────────────┐
│  Frontend  │ ──────────────────────► │  Backend (Node)  │ ─────────► │ copilot -p ...  │
│  1 button  │ ◄────────────────────── │  SSE per chunk   │ ◄───────── │  stdout stream  │
│  + output  │   text/event-stream     │                  │   stdout   └────────────────┘
└────────────┘                         └──────────────────┘
```

- **Frontend** (`public/index.html`): plain HTML + JS, no framework. A prompt box, a mode
  dropdown, a session indicator, and a live output area. Parses the SSE stream from a
  `fetch` POST and remembers the session id so follow-up prompts continue the conversation.
- **Backend** (`server.js`): Express. `POST /api/run` spawns the Copilot CLI with
  `child_process.spawn` (argument-array form, so the prompt never touches a shell → no
  injection) and forwards stdout/stderr to the browser as SSE events. It **auto-detects**
  the `copilot` binary and **captures the `--resume=<id>` session id** from stderr so the
  client can continue the same conversation.
- **Transport**: SSE — simple, one-directional (server → browser), perfect for streaming.

### Streaming markdown (`public/chat-render.js`)

Every surface that streams Copilot output — the PR chat panel, the pre-issue chat panel,
the Admin Terminal and the pipeline log panels — goes through one renderer, `CCChat`:

- **Markdown while it streams, not after.** Chunks accumulate into a buffer that is
  re-parsed on a ~60ms cadence; only the markdown *blocks* whose source text actually
  changed are rebuilt, so a 5k-token answer costs one small parse per frame instead of one
  DOM text node (and one forced reflow) per SSE chunk. An unterminated ``` fence is closed
  before parsing so code reads as code from its first line.
- **Sanitized, always.** Model output is untrusted: everything passes through DOMPurify —
  no scripts, inline styles, event handlers, frames or `javascript:` URLs survive. Links
  are forced to `target="_blank" rel="noopener noreferrer nofollow"`; GFM task-list
  checkboxes are the one `<input>` allowed through, stripped down to an inert checkbox.
- **Syntax highlighting + copy buttons** on every code fence, a copy button on every
  assistant message, and dumps longer than 40 lines folded behind a "Show all N lines".
- **Sticky-bottom autoscroll.** The view only pins to the bottom while you are already
  within 40px of it; scroll up during a live turn and it stays put, with a
  "↓ Jump to latest" pill to come back.
- Pipeline logs stay verbatim (they're raw interleaved stdout/stderr, not markdown) but
  share the sticky scrolling and node coalescing.

The libraries behind it (marked, DOMPurify, highlight.js) are **vendored** into
`public/vendor/` — see the README there. The app is used over LAN and must work with no
internet, so nothing is loaded from a CDN.

### Durable jobs (survives phone disconnects)

Issue actions (**Create PR**, **Deploy**) can run for many minutes. A phone locking its
screen, switching apps, or a network blip would otherwise drop the SSE connection. To make
these robust, long-running actions run as **jobs** (`lib/jobs.js`) that are decoupled from
the HTTP connection that started them:

- The `copilot` child process is owned by the **job**, not the response. Closing/dropping a
  browser connection only **unsubscribes** — it never kills the child (this was the root
  cause of the "Create PR failed but the PR actually got created" bug).
- Each job keeps its full transcript in memory and persists the final result to
  `data/state.json`. Finished jobs stay **subscribable for 15 minutes** so a reconnecting
  phone can replay everything and see the real outcome.
- A **15s heartbeat** keeps idle mobile/proxy connections alive.
- **Reconnect logic**: if the stream drops, the frontend does **not** show failure. It polls
  `GET …/record`; if `record.live[action]` is still `true` it transparently re-attaches to
  the live job's stream, otherwise it paints the authoritative persisted status. Reopening
  the page while an action is running auto-re-attaches too.
- **Success detection**: a PR URL printed by *this* run's transcript is treated as success
  even if the process was later killed (exit code `null`), with a `gh pr list` fallback that
  still requires a clean exit to avoid matching a stale PR.

### SSE event types

| Event     | Payload                                              | When |
| --------- | ---------------------------------------------------- | ---- |
| `meta`    | `{ bin, args, mode, resumed, replay?, status? }`     | Once at start (or on replay) — the exact command being run. |
| `session` | `{ sessionId }`                                      | As soon as the session id is parsed from Copilot's stderr. |
| `chunk`   | `{ stream: "stdout"\|"stderr", text }`               | Repeatedly — streamed output as it arrives. |
| `result`  | `{ action, status, prUrl?, prNumber?, exitCode }`    | Once when an issue action finishes — the persisted outcome. |
| `error`   | `{ message }`                                        | If the CLI can't be spawned. |
| `done`    | `{ exitCode, sessionId }`                            | Once at the end. |

---

## Prerequisites

1. **Node.js 18+**
2. **GitHub Copilot CLI installed and logged in.** Confirm it runs in your terminal:
   ```bash
   copilot --version
   ```
   The server **auto-detects** the binary (PATH, then nvm versions, then Homebrew/
   `/usr/local`/`~/.local`), so an nvm-installed `copilot` that isn't on your login
   `PATH` is still found automatically. To force a specific one, set `COPILOT_BIN`.
3. **GitHub CLI (`gh`) installed and logged in** — used for all issue/PR reads:
   ```bash
   gh auth status
   ```
4. *(for Deploy only)* the **`testflight-deploy` skill** installed under
   `~/.agents/skills/` and fastlane configured for your iOS app. On a fresh machine,
   run [`setup/setup.sh`](setup/setup.sh) (see **Replicate on another machine**) to
   install the bundled skills, the App Store Connect `.p8`, and fastlane in one go.

---

## Run

```bash
cd cloud-copilot
npm install
npm start
# open http://127.0.0.1:8787
```

The server prints the auto-resolved binary path on startup. If you need to override it:

```bash
COPILOT_BIN=/absolute/path/to/copilot npm start
```

Other optional env vars:

| Var          | Default        | Meaning                                  |
| ------------ | -------------- | ---------------------------------------- |
| `COPILOT_BIN`| _(auto-detect)_| Path/name of the Copilot CLI executable  |
| `REPOS_ROOT` | `~/repos`      | Authorized root — repos shown in the UI  |
| `GH_BIN`     | `gh`           | Path/name of the GitHub CLI              |
| `PORT`       | `8787`         | Port to listen on                        |
| `HOST`       | `0.0.0.0`      | Bind address (`127.0.0.1` for local-only)|

---

## Multi-turn conversations

Each Copilot run prints `Resume  copilot --resume=<uuid>` on stderr. The backend parses
this id and sends it to the browser as a `session` event (and again in `done`). The
frontend stores it and includes it as `sessionId` on the next request, which makes the
backend run `copilot --resume=<id> -p "<next prompt>"` — continuing the same conversation
with full memory of earlier turns. Click **New session** in the UI to forget it and start
fresh.

Verified end-to-end: turn 1 "remember BANANA42" → turn 2 (resumed) "what was the word?"
→ Copilot answers "BANANA42".

---

## Running modes

The dropdown maps to different Copilot CLI approval flags. **All three run the same
`copilot -p "<your prompt>"` session** — they differ only in how much the agent is allowed
to do without asking:

| UI option              | CLI arguments                                  | Meaning |
| ---------------------- | ---------------------------------------------- | ------- |
| **Default Approval**   | `copilot -p "<prompt>"`                        | Safest. Read-only tools auto-run; destructive actions are denied. |
| **Granular**           | `copilot -p "<prompt>" --allow-tool 'shell(git)'` | Middle ground: only `git` shell commands are auto-approved. |
| **Allow All**          | `copilot -p "<prompt>" --allow-all`            | ⚠️ Every tool + **all file paths + all URLs** auto-approved. Required for autonomous Create PR and Deploy (fastlane writes to `/tmp`, `~/Library`, the keychain). Powerful and dangerous — only in trusted setups. |

(When resuming, `--resume=<id>` is prepended to the arguments above.)

### Note on "autopilot"

This demo uses Copilot CLI's **programmatic one-shot mode** (`-p`): each button press is a
brand-new session that runs the prompt and exits. That is **not** the interactive
**autopilot** mode (where the agent works autonomously across many steps in a live
session). The "running mode" selector here controls *tool approval policy*, not autopilot.

---

## Security

- The server binds to **`127.0.0.1` only** by design. This endpoint can run commands on
  your machine (especially in *Allow All* mode) — do **not** expose it directly to the
  internet.
- To reach it remotely (e.g. from your phone), put it behind a tunnel with authentication,
  such as **Cloudflare Tunnel + Zero Trust Access** or **Tailscale**, rather than opening a
  router port.
- The prompt is passed to the CLI as a separate `spawn` argument (never concatenated into a
  shell string), preventing shell injection. The `sessionId` is validated against a strict
  hex/uuid pattern before use.

---

## Files

```
cloud-copilot/
├── package.json        # express dependency, `npm start`, `cc:restart` (self deploy)
├── .cloud-copilot.json # this repo's own deploy config (shell -> cc:restart)
├── server.js           # Express app: repos/issues/work/deploy/merge routes + state machine
├── lib/
│   ├── gh.js           # enumerate repos, list issues/PRs/single-PR via `gh` (cached)
│   ├── store.js        # per-issue status persisted to data/state.json
│   ├── jobs.js         # durable job manager: child outlives the browser connection
│   ├── runner.js       # spawn copilot, stream SSE, capture transcript + session id
│   └── repoConfig.js   # loads a repo's .cloud-copilot.json (or auto-detects iOS)
├── public/
│   ├── index.html      # repos → issues → Create PR / Deploy / Merge pipeline console
│   ├── chat-render.js  # CCChat: streamed markdown renderer shared by every chat surface
│   ├── vendor/         # marked + DOMPurify + highlight.js, committed (never a CDN)
│   ├── notify.js       # CCNotify: completion chime + system notification + toast
│   ├── sw.js           # service worker (required for notifications on iOS)
│   ├── manifest.webmanifest  # PWA manifest — makes "Add to Home Screen" a real app
│   ├── icons/          # PWA / apple-touch icons (generated)
│   └── sounds/         # success + failure chimes (generated)
├── scripts/
│   └── gen-assets.js   # regenerates public/icons + public/sounds (no deps)
├── data/               # state.json (gitignored)
├── .gitignore
└── README.md
```
