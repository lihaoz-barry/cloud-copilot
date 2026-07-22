# ☁️ cloud-copilot

A phone-friendly **issues console** for driving the local GitHub Copilot CLI over
your LAN/VPN. From your phone you can:

- browse the git repos under an **authorized root** (`REPOS_ROOT`)
- expand a repo to see its **GitHub issues** (fetched via `gh`, cached, refreshable)
- **Create PR** — Copilot implements the issue end-to-end and opens a PR
- **Deploy** — ship the app to TestFlight via the `testflight-deploy` skill
- watch every run **stream live**, and see each action go **yellow → green/red**
  with a link to the PR or the full transcript on failure

This is a proof-of-concept for remotely driving a local coding-agent CLI from a web UI.

---

## How it works

`gh` (already logged in on your Mac) provides all GitHub reads — **no MCP or token
wiring needed**. The four tabs you see in the Copilot CLI TUI (Session / Issues /
Pull requests / Gists) are Copilot's own built-in GitHub views; this app reproduces
the Issues + PR flow through `gh` + `copilot -p`.

Per-issue state is a small machine persisted to `data/state.json`:

| Action     | idle        | running        | success            | failed              |
| ---------- | ----------- | -------------- | ------------------ | ------------------- |
| Create PR  | `Create PR` | `Creating PR…` 🟡 | `PR created` 🟢    | `PR failed` 🔴      |
| Deploy     | `Deploy`    | `Deploying…` 🟡  | `Deployed` 🟢      | `Deploy failed` 🔴  |

- 🟢 clicking a **success** button opens a panel with the **PR link** (and the
  always-present *View issue on GitHub* link).
- 🔴 clicking a **failed** button opens the **full Copilot conversation** so you can
  see what went wrong.
- Success/failure is decided by the CLI **exit code** plus detection: a PR URL in the
  transcript (fallback: `gh pr list` referencing the issue) for Create PR; a fastlane/
  TestFlight success marker for Deploy.

---

## API

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET  | `/api/repos` | List git repos under `REPOS_ROOT` (with remotes). |
| GET  | `/api/repos/:name/issues[?refresh=1]` | List open issues (cached 5 min) merged with local status. |
| GET  | `/api/repos/:name/issues/:n/record` | Full stored record (status, PR link, transcript). |
| POST | `/api/repos/:name/issues/:n/work` | **Create PR** — SSE stream. Body: `{ "mode": "allow-all" }`. |
| POST | `/api/repos/:name/issues/:n/deploy` | **Deploy** — SSE stream. |
| POST | `/api/run` | Simple one-shot demo (prompt + optional `sessionId` resume). |

### SSE events

`meta` (command) → `chunk` (`{stream,text}` streamed output) → `session`
(`{sessionId}`) → `result` (`{action,status,prUrl,prNumber}`) → `done` (`{exitCode}`).

---

## Deploy uses your existing `testflight-deploy` skill

The **Deploy** button runs `copilot -p` with a prompt that invokes your personal
`testflight-deploy` skill (`~/.agents/skills/testflight-deploy/`), which already
encodes the correct signing team, bundle id, and App Store Connect API key for
`ios-diet-expert`. (The generic `ios-deploy` skill is intentionally **not** used —
`testflight-deploy` supersedes it.)

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
   `~/.agents/skills/` and fastlane configured for `ios-diet-expert`.

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
| `HOST`       | `127.0.0.1`    | Bind address (`0.0.0.0` for LAN access)  |

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
| **Allow All**          | `copilot -p "<prompt>" --allow-all-tools`      | ⚠️ Every tool auto-approved, including arbitrary shell. Powerful and dangerous — only in trusted setups. |

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
├── package.json        # express dependency, `npm start`
├── server.js           # Express app: repos/issues/work/deploy routes + state machine
├── lib/
│   ├── gh.js           # enumerate repos, list issues/PRs via `gh` (cached)
│   ├── store.js        # per-issue status persisted to data/state.json
│   ├── jobs.js         # durable job manager: child outlives the browser connection
│   └── runner.js       # spawn copilot, stream SSE, capture transcript + session id
├── public/
│   └── index.html      # repos → issues → Create PR / Deploy console
├── data/               # state.json (gitignored)
├── .gitignore
└── README.md
```
