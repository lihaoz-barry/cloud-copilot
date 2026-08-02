# ☁️ cloud-copilot

A phone-friendly **issues console** for driving the local GitHub Copilot CLI over
your LAN/VPN. From your phone you can:

- browse the git repos under an **authorized root** (`REPOS_ROOT`), with a
  per-device **repo filter** (checkbox show/hide, persisted in `localStorage`)
- expand a repo to see its **GitHub issues**, served through a **three-tier cache**
  (browser → server → `gh`) so an expand is instant and a page reload costs zero
  requests — see [Caching](#caching-browser--server--gh) below; every expand also
  **auto-discovers PRs** referencing those issues (one `gh pr list` call, matched
  in-process) so the pipeline is populated without a manual step — a per-issue
  **↻** button remains for an explicit, always-live re-check
- a **flat two-line layout**: one line per issue (number, title, and the pin /
  GitHub / refresh / delete cluster), then **one workflow line per PR** —
  `#43 [ PR created ▸ Deploy ▸ Merge ]`. The first workflow line always has an
  empty PR number and starts a *new* PR, since one issue can have several
- each stage is a colored segment (blue = planned, yellow = running, green =
  done, red = failed); a **⋯** toggle reveals that line's logs, abort and timing,
  and opens itself automatically while a stage runs
- **repo open/closed state is remembered per device**, so a reload lands on the
  same view instead of collapsing everything
- **Deploy is per-repo configurable**: iOS repos ship to TestFlight via the
  `testflight-deploy` skill; other repos (cloud-copilot itself included) just run
  a shell command you define (e.g. restart the local service) — see
  [`.cloud-copilot.json`](#per-repo-deploy-config-cloud-copilotjson) below
- **Merge** (`gh pr merge --merge --delete-branch`) unlocks once Deploy succeeds;
  you can still force it early behind a confirm if you're confident. If the
  command fails, cloud-copilot automatically starts a repo-scoped Copilot session
  to investigate, resolve branch conflicts, push, retry, and verify the merge.
  Once the merge lands, cloud-copilot **closes the issue and every other still-open
  PR for that issue** (with a "superseded by #N" comment + branch deletion)
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
**deploy**, **merge** and **update** (sync with the base branch) lifecycle
(status, start/finish, `durationMs`, transcript) plus its last collected `sync`
status:

| Stage      | idle              | running           | success         | failed / aborted                |
| ---------- | ----------------- | ----------------- | --------------- | -------------------------------- |
| Create PR  | `Create PR` 🔵    | `Creating PR…` 🟡  | issue turns 🟢  | `PR failed` 🔴 / `PR aborted`    |
| Deploy     | `Deploy` 🔵       | `Deploying…` 🟡    | `Deployed` 🟢   | `Deploy failed` 🔴 / `Aborted`   |
| Merge      | `🔒 Merge` 🔵 (dim until Deploy succeeds) | `Merging…` 🟡 | `Merged` 🟢 | `Merge failed` 🔴 / `Aborted` |
| Update from base | `⇣N` / `⚠` / `✓` / `○` badge | `⟳` 🔵 | badge returns to `✓` | badge stays `⇣N`/`⚠`, log kept |

Each PR renders as **one workflow line** across all three stages — a **Create PR |
Deploy | Merge** pipeline, matching the state machine above: blue = planned,
yellow = running, green = done, red = failed. The PR number sits at the head of
the line:

```
#42  Deploy dies on a dirty working tree: salvage local changes…   📌 ↗ ↻ 🗑
#43↗ [  PR created   ▸     Deploy     ▸  🔒 Merge     ]                 ⋯
     ⎇ claude/app-bug-fixes  62cf6ca  50m  Deploy: salvage a dirty…
```

The PR number and its `↗` GitHub link are packed together on the **left**, so
every workflow bar starts at the same x whichever icons a line has.

- **An issue with no PRs** leads with a `—` line whose first segment is the live
  **Create PR** button.
- **Once a PR exists that line disappears**, saving a row per issue. To open a
  *second* PR, click the green **PR created** segment on any existing line — it
  asks to confirm before starting a new Copilot run.
- The `—` line **comes back** while a Create PR run is working, failed, or
  aborted, so progress and failures stay visible and their log stays reachable.

- **Success shows on the issue**, not the button: on a created PR the issue gets a
  green border + green `#number`, and the Create PR segment resets to "Create PR".
- **An issue has one Create PR record but can have many PRs**, most of them
  discovered on GitHub rather than created here. Only the PR that run actually
  produced (`work.prNumber`) shows its duration and log — otherwise an unrelated
  run gets attributed to a PR that predates it.
- **Per-line logs are hidden behind `⋯`**, along with that line's abort button and
  run timing. The toggle only appears when there is something to show, and opens
  itself while a stage is running so Abort is always one tap away.
- **Each PR line carries its branch and tip commit** — `⎇ branch`, the short SHA,
  how long ago it landed, and the commit subject — so you can tell at a glance
  what code a given Deploy actually shipped. The SHA links straight to that
  commit on GitHub. (On phones the branch is dropped in favour of the commit
  subject, which says more in less space.)
- **The repo header does the same for the local checkout**, plus the issue that
  branch belongs to: `feat-x · #45 主页扁平化… · d9132eb 2m …`. The issue is
  resolved client-side by matching the branch against each PR's `headRefName`,
  so it costs no extra API call. An **unpushed** commit has no page on GitHub —
  linking to it would just 404 — so it renders as a plain chip with an
  `unpushed` badge instead of a dead link.
- **Abort**: while running, Create PR / Deploy / Merge each show a red `⨯` button.
  Confirming signals the whole process group (copilot + fastlane/xcodebuild/gh), so
  subprocesses die too; the run ends in an `aborted` state you can re-run.
- **Re-deploy**: clicking Deploy on a finished/failed/aborted PR asks to confirm
  before starting a new run.
- **Worktrees are cleaned up after every run, not fought over at Deploy time** —
  an agent session often implements an issue inside a `git worktree` it creates
  itself (e.g. under `.claude/worktrees/`) and leaves behind, sometimes locked,
  still holding the PR's branch. Git then refuses to check that branch out
  anywhere else (`already used by worktree`), which is exactly what Deploy needs
  to do. So **Create PR** and a successful **Merge** now sweep those directories
  as soon as they finish — while they still hold the repo lock — and Deploy/PR
  chat keep the same release step as a fallback. The rule is always "never delete
  work": a worktree is unlocked, removed and pruned only when it is clean **and**
  every commit it holds already exists on `origin/<branch>` (after a merge,
  `origin/<base>` counts too, since GitHub usually deleted the branch). Anything
  with uncommitted changes, unpushed commits, a detached HEAD, or no remote to
  compare against is left untouched — and if Deploy still finds its branch held
  by such a worktree, it runs inside that directory instead of failing. What was
  removed or kept, and why, is appended to the run's transcript as
  `[worktree] released … / kept … — reason`.
- **Closed PRs drop out of the local pipeline** — a PR closed *without* being
  merged has no branch left on GitHub, so Deploy/Merge/chat on it could only ever
  die on `git fetch` with an opaque `Command failed`. Each sync records every
  tracked PR's GitHub state (including ones cloud-copilot created itself, which
  the per-issue body match may not return), and `CLOSED` rows stop being listed —
  `↻ PRs` is the manual sweep. **`MERGED` is never hidden**: that is the
  pipeline's successful end state. A closed PR that was never deployed, merged or
  chatted is forgotten entirely; one that *does* carry local history keeps its
  record (just hidden) so the builds overview never loses past attempts. If you
  click Deploy on a PR that closed since the page loaded, you get a plain-language
  `Blocked: PR #N is closed…` instead of a checkout failure.
- **Merge is gated on Deploy succeeding** — the Merge cell stays a dimmed, locked
  `🔒 Merge` until then. You can still click it early; it asks you to confirm a
  **force-merge** that skips the gate.
- **Failed merges recover automatically** — Copilot investigates the original
  failure, resolves and pushes conflicts against the PR's actual base branch,
  retries the merge, and verifies GitHub reports `MERGED`. The Merge cell says
  `Merged · conflict resolved` when that recovery resolved a reported conflict.
- **A successful merge cleans up after itself** — GitHub only auto-closes an issue
  when the PR body has `Closes #N` *and* targets the default branch, and it never
  touches sibling PRs. So after the PR reaches `MERGED`, cloud-copilot closes the
  issue (comment: `Closed by #N (merged via cloud-copilot).`) and closes every other
  still-open PR of that issue with `Superseded by #N…` + `--delete-branch`. Already
  merged/closed PRs are skipped, the whole step is best-effort (it can never fail an
  already successful merge), and `MERGE_AUTO_CLEANUP=0` turns it off.
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

### Caching (browser → server → `gh`)

Issue and PR data is read through three tiers, so the dashboard is instant and
`gh` is called as rarely as possible:

| Tier | Where | TTL | Cost | Survives |
|---|---|---|---|---|
| **L1** | browser `localStorage` | 15 min | 0 ms | page reloads |
| **L2** | `data/gh-cache.json` + memory | 15 min | ~5 ms | server restarts |
| **L3** | the `gh` CLI (real GitHub) | — | ~800 ms+ | — |

Three things fill L2 per repo: `gh issue list`, `gh pr list`, and one GraphQL
query for each PR's tip commit. (`gh pr list --json commits` can't be used for
that last one — it returns every commit of every PR and blows past GitHub's
GraphQL node limit at 100 PRs.) The commit query is decorative: if it fails, the
rows simply render without their branch/commit annotations.

- **Expanding a repo** renders from L1 immediately — if that copy is under 15
  minutes old, **no GitHub read happens at any tier**. A reload of a page with an
  already-expanded repo therefore issues zero `gh` calls.
- **L1 only caches the GitHub half.** The action statuses that ride along in the
  same payload (`work`/`deploy`/`merge`, plus `activeWorkIssues`) are live
  server state, and a job started from another machine is invisible to a cached
  render. So every cache-backed render is immediately followed by a
  `/api/repos/:name/statuses` call, which reads `state.json` and the job table
  and never touches `gh`; the list is repainted only if something actually
  moved. The 60-second sweep does the same for repos still inside the TTL, so a
  page left open notices a remote job within a minute.
- **Labels ride along with that patch**, even though they are GitHub data. They
  are the one part of the GitHub half that a person flips expecting an immediate
  answer — the `committed` checkbox — and 15 minutes of L1 on top of 15 minutes
  of L2 meant a label set on github.com could take half an hour to appear, which
  reads as a checkbox that does not work. `/statuses` therefore also returns the
  label names from the L2 cache (a memory read, not a `gh` call), and toggling
  the checkbox writes the server's answer straight into L1. An issue missing
  from that map means "nothing cached", not "no labels" — the client keeps what
  it has rather than blanking it.
- **Past the TTL**, the browser silently asks the server and updates the list in
  place. That request usually costs nothing beyond L2; only if the server's own
  copy has aged out does it reach for `gh`.
- **The server refreshes every repo hourly** in the background (`force`, so it
  really does hit GitHub), which bounds staleness even if nobody opens the page.
  A repo with a job running is skipped and picked up on the next pass.
- **`↻ Refresh` punches through all three tiers**: a live `gh` read that rewrites
  the server's cache *and* this browser's copy.
- The background top-up is **skipped while anything in that repo is running**,
  since re-rendering the list would tear down the DOM a live log is streaming into.

The freshness pill next to the issue count shows both halves and a countdown:

```
9 open   ☁ 3m · 💾 just now · ↻ 12m
         │      │              └ next automatic sync
         │      └ when this browser last copied it
         └ when the server last read GitHub
```

Green inside the TTL, amber under an hour, grey beyond that; hovering gives
absolute timestamps. Tune with `GH_CACHE_TTL_MS`, `GH_SYNC_INTERVAL_MS`, and
`GH_SYNC_FIRST_DELAY_MS`.

The per-PR base-branch comparison is deliberately *not* part of this: it runs
on its own 3-minute rhythm against local git and never touches the GitHub API
(see [Base-branch sync badge](#base-branch-sync-badge--update-a-pr-with-copilot)).

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

### Phone pushes (ntfy) — one message per task

The alerts above need a page that is (or recently was) open. To reach a phone
with the app fully closed, the **server** publishes one [ntfy](https://ntfy.sh)
message per job the moment it reaches a terminal state (`lib/notifier.js`,
called from `lib/jobs.js`).

Each push names the task, not just the session:

```
✅ Create PR · cloud-copilot#27          ❌ Deploy · ios-diet-expert PR #112 失败
   Task-aware ntfy notifications            fastlane: build failed
   本 repo 第 2 个 Create PR                 exit code 1
   https://github.com/…/pull/48
```

- **Title** = action · repo#issue / repo PR #n, plus the conversation title for
  chat turns (`💬 Admin chat · 「刷新页面后聊天新开了一个 tab」`) and a status
  suffix for anything that didn't succeed.
- **Body** = what the task was about (issue/PR title, or the chat title) + a
  one-line gist of the agent's final answer + the key result (PR link, TestFlight
  build number, or the first line of the error).
- **Tags** render as the leading emoji: ✅ success, ❌ failure, ⚠️ aborted;
  failures are also sent with a higher ntfy priority.
- **Tapping** opens the matching place in the app — the PR page, the pre-issue
  chat, or `#/admin/chat/<id>` for an admin conversation (needs `APP_BASE_URL`).

Configuration is machine-local and never committed — copy
[`setup/notify.env.example`](setup/notify.env.example) to
`~/.config/cloud-copilot/notify.env`:

```bash
NTFY_TOPIC=some-long-unguessable-topic   # your topic IS the credential
NTFY_SERVER=https://ntfy.sh              # or your self-hosted instance
APP_BASE_URL=http://192.168.1.20:8787    # how your phone reaches this app
```

Every key can also be given as an environment variable (which wins), the file is
re-read when it changes (no restart), and **with no topic set nothing is pushed
and nothing errors**. A push has a 10s timeout, is de-duplicated per job key for
60s, and can never fail a job — errors are logged and dropped. The 🔔 Alerts
drawer shows the current status and has a **Test phone push** button
(`GET/POST /api/settings/ntfy[/test]`).

Jobs are spawned with `CLOUD_COPILOT_JOB=1`, which the Copilot CLI `sessionEnd`
hook (`~/Repos/hooks/copilot-notify.sh`) checks before sending its own generic
`[repo] session complete` message — so cloud-copilot's runs notify exactly once,
with the specific message, and other Copilot CLI sessions still get the generic
one:

```bash
[[ -n "$CLOUD_COPILOT_JOB" ]] && exit 0
```

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
  its own [`.cloud-copilot.json`](.cloud-copilot.json) and `cc:restart` in
  [`package.json`](package.json), which runs
  [`scripts/restart.sh`](scripts/restart.sh) — the same restart done by hand
  during development.

  That script identifies the old process by **the port it holds**, not by a
  `pkill -f 'node server.js'` pattern: a command-line match also hits the shell
  running it and any unrelated project's server. It then waits for the port to
  actually be released before starting the replacement, and exits non-zero with
  the log if the new process does not answer. The version it replaced did none
  of that, and the failure mode was nasty — the new process lost the port race,
  died of `EADDRINUSE`, and the OLD one kept serving. Since `public/` is read
  from disk per request while `server.js` and `lib/` are frozen at boot, the
  browser then ran the *new* dashboard against the *old* API and every endpoint
  the new UI knew about answered 404. `GET /api/version` now reports exactly
  that condition (see below) so it can never again look like a dozen unrelated
  bugs.
- No config and no Xcode project detected → Deploy is disabled with a message
  pointing here. cloud-copilot never guesses a shell command for an unconfigured
  repo.

### Base-branch sync badge (⇣N / ⚠) — update a PR with Copilot

Every open PR's workflow line starts with a small round badge, left of the PR
number, saying how that branch relates to its base branch (usually `main`) —
in the same visual family as the pipeline chevrons:

| Badge | Meaning |
| ----- | ------- |
| `✓` green | In sync: 0 behind, merges cleanly. |
| `⇣` amber, with the count on the ring | The branch is **N commits behind** its base. |
| `⚠` red | Merging the base in would **conflict** (the behind count still rides on the ring). |
| `○` grey | Not compared yet — a fork PR whose head this clone doesn't have, or a repo the sweep hasn't reached. Never rendered as clean. |
| `⟳` blue | An update session is running right now. |
| `!` red | The last update run failed or was aborted; click to see the log or retry. |

Hovering shows base → head, exact ahead/behind, how long ago the comparison
ran and whether it came from git or GitHub. The same legend lives in
**⚙ Settings → Sync badge**.

#### How the comparison is made

Every **3 minutes** the server recompares every tracked open PR of every repo,
using the clone already on disk — not the GitHub API:

```
git fetch --no-tags --prune origin          # once per repo per sweep
git rev-list --left-right --count origin/<base>...origin/<head>   # behind / ahead
git merge-tree --write-tree origin/<base> origin/<head>           # would it conflict?
```

Both plumbing commands are read-only with respect to the working tree and the
index (`merge-tree` writes only loose objects), so a sweep is safe while a
Copilot job holds the checkout. The interval is `PR_SYNC_INTERVAL_MS`
(default 180000). Results are written to each PR's `sync` field in
`data/state.json`; the browser polls `GET /api/repos/:name/prsync` on the same
3-minute rhythm and repaints the badges **in place**, so a running log panel is
never torn down. A sweep also runs immediately after a PR is created and after
a merge (which moves the base branch and puts every other PR behind).

Asking GitHub instead was rejected on purpose: `mergeable` is computed lazily,
so it answers `UNKNOWN` exactly when a PR is new — the moment the badge matters
most. GitHub's answer is still collected on the hourly sync, but only for what
git here cannot see (fork PRs), and an `UNKNOWN` from GitHub is discarded rather
than allowed to blank out a definite local result.

**Clicking the badge starts a Copilot session that updates the PR**, in the
direction `base → PR head` only:

- It runs in the PR branch's own working tree (an existing linked worktree is
  reused if one holds the branch) and takes the same repo working-tree lock as
  Create PR / Deploy / Merge / Chat, so it can never race them.
- The session fetches, merges `origin/<base>` into the PR branch, resolves
  conflicts, runs the relevant existing checks, commits and pushes — never a
  force-push, never `gh pr merge`, never a new PR.
- Success is decided by git, not by the transcript: the pushed head must
  contain the pushed base (`0` commits behind). Otherwise the run is `failed`,
  the log stays available behind `⋯ → ▤`, and the badge keeps telling the truth.
- Afterwards the branch is recompared locally (git answers now; GitHub would
  take minutes to recompute `mergeable`) and the badge updates itself. A
  successful update archives the PR's previous Deploy and re-locks Merge (the
  old build no longer reflects the branch), exactly like an applied chat turn.
- Progress, abort (`⨯`) and the full log live on the row's `⋯` tools line, and
  the job survives a page reload or a dropped phone connection like every other
  action.

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

## Running many PRs at once (worktree + port pool)

Create PR, Update, Review and Chat no longer take over the repo's checkout, so
**several of them run at the same time — even on the same repo**.

- **One throwaway worktree per run.** `lib/worktreePool.js` leases
  `<repo>/.worktrees/<action>-<issue>-<hex>` (excluded via `.git/info/exclude`, so
  nothing lands in your diff). Create PR gets a detached checkout of
  `origin/<base>`; branch actions check out the PR branch, or reuse an existing
  linked worktree that already holds it.
- **One port per worktree.** `lib/portPool.js` hands out a free port from
  **8000–8888**, probing it with a real bind before leasing, and exports it into
  the run as `PORT` and `CC_TEST_PORT`. Two runs can therefore boot dev servers
  side by side without a fight. The server's own port is never leased.
- **Isolated state.** Each lease also sets `CC_DATA_DIR=<worktree>/.cc-data`, so a
  nested tool run inside a worktree can never scribble on the real
  `data/state.json`.
- **Limits.** 3 concurrent leases per repo, 6 in total (`CC_MAX_WORKTREES*`).
  Beyond that a run waits in a FIFO queue instead of failing.
- **Never lose work.** Release reuses the existing disposability check: a worktree
  is only removed when it is clean and provably has no unpushed commits.
  Anything else is left on disk for you. Crash leftovers are swept at startup.
- **Deploy, Merge and Restart main still share the repo's real working tree** and
  remain mutually exclusive — those genuinely need the checkout.

### ⚡ Running tasks panel

The **⚡ button in the top-left** opens a live list of everything the server is
running: repo + issue, what it is doing, how long it has been going, which
worktree and port it holds, whether it was started by you or automatically, a
link to the issue, and a **Stop** button per row. The button carries a badge with
the number of running jobs and polls every 3 seconds while open. The scheduler's
switch and a **Run a sweep now** button live at the bottom of the same panel.

## Committed issues and the scheduler

Tick the **committed** checkbox on an issue and cloud-copilot takes ownership of
it. The checkbox writes the **`committed` GitHub label** — the label *is* the
state, so it is visible and editable from GitHub itself and survives any local
reset.

Every 10 minutes (`SCHEDULER_INTERVAL_MS`) the scheduler sweeps every enabled
repo and, for each committed issue, does the highest-priority thing that is due:

1. **Create PR** if the issue has no open PR (re-checked live against GitHub
   first, so a PR opened by hand is adopted instead of duplicated).
2. **Update from base** if the PR is behind its base branch — this is what keeps
   every committed PR continuously rebased on the newest `main`. A PR with no
   comparison on record yet (typically the one this sweep just created) gets one
   computed on the spot rather than being allowed to fall through to step 3:
   reviewing a diff that is about to be rewritten by the base merge it actually
   needs wastes a whole agent run. Fork PRs, which local git genuinely cannot
   answer for, still fall through.
3. **Review & improve** once per head commit, when nothing else is pending. A new
   push makes the PR eligible again; the reviewed SHA is read from git, not from
   the hourly PR cache, so a review can never loop on its own push.

Repos run in parallel, tasks within a repo run one at a time, and **you always
win**: a repo with any manually started job is skipped for that sweep. Failures
back off exponentially and, after 3 attempts, the record is flagged
`needsAttention` and left alone. Every automatic run is a normal job — it shows
up in the ⚡ panel, streams into the same log, and sends the same ntfy push
(prefixed `自动 ·`).

Ticking the checkbox **brings the next sweep forward** instead of waiting out
the interval — committing something and watching nothing happen for ten minutes
is indistinguishable from a broken button. The checkbox shows a short `queued`
hint when that happens. Clicking repeatedly cannot start a burst of sweeps: it
only reschedules the one timer.

The global switch is off by default and is **persisted**; on restart the
scheduler restores it and re-checks GitHub before creating anything, so a server
bounce never produces a duplicate PR. Under it sits one checkbox per GitHub
repo, for keeping the scheduler off a single repo while it runs everywhere else.
Those are opt-*outs*: a repo with no entry follows the global switch, so
enabling a newly cloned repo is never something you can forget to do.


## API

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET  | `/api/repos` | List git repos under `REPOS_ROOT` (with remotes). |
| GET  | `/api/health` | Liveness probe: `{ ok, pid, startedAt }`. Polled by the client while the server restarts itself. |
| GET  | `/api/settings/model` | Current model + the selectable list. `POST` the same path to change it. |
| GET  | `/api/settings/ntfy` | Phone-push status: `{ enabled, server, topic (masked), appBaseUrl, configFile }`. |
| POST | `/api/settings/ntfy/test` | Send a test push to the configured ntfy topic. `400` when unconfigured, `502` when ntfy rejects it. |
| GET  | `/api/settings/self` | The cloud-copilot repo serving this app: `{ repo, branch, defaultBranch, dirty, busy }`, or `{ repo: null }`. |
| POST | `/api/settings/self/restart-main` | **Restart main** — stash if dirty, check out the default branch, `pull --ff-only`, then restart detached. Takes the repo working-tree lock; `409` when it's held. |
| GET  | `/api/repos/:name/issues[?refresh=1]` | List open issues merged with local status; includes `activeWorkIssues` (repo lock) and cache telemetry (`serverAt`, `ttlMs`, `nextSyncAt`) for the freshness pill. Served from the L2 cache (15 min TTL, persisted to `data/gh-cache.json`); `?refresh=1` forces a live `gh` read and rewrites it. Also auto-discovers and persists PRs referencing these issues (one whole-repo `gh pr list`, same cache). |
| GET  | `/api/repos/:name/statuses?n=1,2,3` | Just the live half of the list above: `{ statuses, labels, activeWorkIssues }` for the given issue numbers. Reads `state.json`, the in-memory job table and the in-memory L2 entry — never `gh` — so the client can call it on every cache-backed render and once a minute thereafter. `labels` is what keeps the `committed` checkbox from lagging half an hour behind GitHub. |
| GET  | `/api/repos/:name/issues/:n/record` | Full stored record (work + per-PR deploy/merge, transcripts, `live` flags). |
| GET  | `/api/repos/:name/issues/:n/prs` | Force-refresh the PR list for one issue from GitHub — always live, bypasses the whole-repo PR cache. |
| POST | `/api/repos/:name/issues/:n/work` | **Create PR** — SSE stream. Body: `{ "mode": "allow-all" }`. |
| POST | `/api/repos/:name/issues/:n/work/cancel` | Abort the running PR creation. |
| POST | `/api/repos/:name/issues/:n/deploy/:pr` | **Deploy a specific PR** — SSE stream. Dispatched per the repo's `.cloud-copilot.json`. |
| POST | `/api/repos/:name/issues/:n/deploy/:pr/cancel` | Abort the running deploy for that PR. |
| POST | `/api/repos/:name/issues/:n/merge/:pr` | **Merge a specific PR** — SSE stream. Body: `{ "force": false }`. Blocked unless Deploy succeeded, unless `force: true`. A failed `gh pr merge` automatically starts Copilot to investigate, resolve conflicts, retry, and verify the merge. On success the issue and the issue's other open PRs are closed automatically (`MERGE_AUTO_CLEANUP=0` disables it). |
| POST | `/api/repos/:name/issues/:n/merge/:pr/cancel` | Abort the running merge for that PR. |
| GET | `/api/repos/:name/prsync` | Base-branch sync state of every tracked PR of a repo (`{ [prNumber]: sync }`), plus the sweep interval and the next sweep time. Reads `data/state.json` only — the badge poller's endpoint. |
| POST | `/api/repos/:name/issues/:n/prs/:pr/update` | **Update a PR from its base branch** — SSE stream. Starts a Copilot session in the PR's working tree that merges `base` → PR head, resolves any conflicts, and pushes. Never merges the PR into the base. Takes the repo working-tree lock; success is verified with `git rev-list --count origin/<head>..origin/<base>` (must be 0), then the branch is recompared with local git and returned as `sync`. |
| POST | `/api/repos/:name/issues/:n/prs/:pr/update/cancel` | Abort the running branch update for that PR. |
| POST | `/api/repos/:name/issues/:n/prs/:pr/chat` | **Chat with a PR** — SSE stream. Body: `{ "message": "...", "mode": "plan"\|"apply", "model": "..." }`. `plan` is read-only (default approval flags); `apply` implements + pushes to the existing branch and resets Deploy/Merge on success. The optional `model` overrides the global setting for that turn only (unknown values fall back to it). |
| POST | `/api/repos/:name/issues/:n/prs/:pr/chat/cancel` | Abort the running chat turn for that PR. |
| POST | `/api/repos/:name/issues/:n/prs/:pr/review` | **Review & improve a PR** — SSE stream. Starts a Copilot session in the PR's own worktree that reviews the diff, applies the fixes it deems worth making, and pushes. Records the reviewed head SHA so the same commit is never reviewed twice. |
| POST | `/api/repos/:name/issues/:n/prs/:pr/review/cancel` | Abort the running review for that PR. |
| POST | `/api/repos/:name/issues/:n/committed` | Toggle the **committed** label on the issue. Body: `{ "committed": true }`. Writes the label on GitHub — that label *is* the state. Answers `{ committed, label, scheduled, labels }`: `labels` is the issue's full label set as the server now knows it (the client writes that into its own cache rather than guessing a patch), and `scheduled` says whether the next sweep was brought forward. |
| GET  | `/api/version` | What code this process is actually running: `{ boot, disk, stale, reasons, committedLabel }`. `stale` compares a **content hash** of `server.js` + `lib/` against the one taken at boot — not the commit sha, which would fire on every commit of already-running code. Polled every 60s; when it says `stale`, the dashboard shows a banner, because at that point the page is talking to an API older than itself. |
| GET  | `/api/jobs` | Everything currently running: `{ jobs, worktrees, limits, scheduler }`. Backs the ⚡ task panel; polled every 3s while it is open. |
| POST | `/api/jobs/cancel` | Stop one running job. Body: `{ "key": "<repo>#<n>:<action>" }`. |
| GET  | `/api/settings/scheduler` | Scheduler state: `{ enabled, repos, running, intervalMs, nextRunAt, lastRunAt, lastSummary }`. |
| POST | `/api/settings/scheduler` | Turn the scheduler on/off (`{ enabled }`), per repo (`{ repo, enabled }`), or run a sweep now (`{ runNow: true }`). Persisted to `data/state.json` and restored on restart. |
| POST | `/api/run` | Simple one-shot demo (prompt + optional `sessionId` resume). |

### SSE events

`meta` (command) → `chunk` (`{stream,text}` streamed output) → `session`
(`{sessionId}`) → `result` (`{action,status,prUrl?,prNumber?}`, where `status` is
`success`/`failed`/`aborted`, or `blocked` when the working-tree lock rejects
an overlapping Deploy/Merge/Restart, or Merge is attempted before Deploy has succeeded) → `done` (`{exitCode}`).

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
| `MERGE_AUTO_CLEANUP` | `1`    | `0` disables closing the issue + superseded PRs after a merge |
| `CC_MAX_WORKTREES_PER_REPO` | `3` | Concurrent worktree leases allowed per repo |
| `CC_MAX_WORKTREES` | `6`     | Concurrent worktree leases allowed across all repos |
| `CC_PORT_RANGE_START` | `8000` | First port handed to a worktree (`PORT`/`CC_TEST_PORT` inside it) |
| `CC_PORT_RANGE_END` | `8888`  | Last port of that range |
| `CC_COMMITTED_LABEL` | `committed` | GitHub label that marks an issue as committed |
| `SCHEDULER_INTERVAL_MS` | `600000` | Scheduler sweep interval (10 min) |
| `CC_DATA_DIR` | `./data`      | State/cache/upload directory — set per worktree so parallel runs never share state |

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
├── scripts/restart.sh  # the restart itself: port-identified, waits, fails loudly
├── server.js           # Express app: repos/issues/work/deploy/merge routes + state machine
├── lib/
│   ├── gh.js           # enumerate repos, list issues/PRs/single-PR via `gh` (cached)
│   ├── ghCache.js      # L2 cache for gh results, persisted to data/gh-cache.json
│   ├── store.js        # per-issue status persisted to data/state.json
│   ├── jobs.js         # durable job manager: child outlives the browser connection
│   ├── notifier.js     # task-aware ntfy pushes when a job reaches a terminal state
│   ├── runner.js       # spawn copilot, stream SSE, capture transcript + session id
│   ├── mergeRunner.js  # gh pr merge + Copilot recovery, verifies the PR is MERGED
│   ├── mergeCleanup.js # after a merge: close the issue + superseded sibling PRs
│   ├── worktrees.js    # linked-worktree housekeeping: release/sweep without ever losing work
│   ├── worktreePool.js # leases one throwaway worktree per run (concurrency limits + cleanup)
│   ├── portPool.js     # leases a free port (8000-8888) to each worktree
│   ├── scheduler.js    # 10-min sweep that drives committed issues by itself
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
├── setup/
│   ├── setup.sh              # onboard a fresh Mac (CLI, gh, skills, .p8, fastlane)
│   ├── deploy.env.example    # -> ~/.config/cloud-copilot/deploy.env
│   └── notify.env.example    # -> ~/.config/cloud-copilot/notify.env (ntfy pushes)
├── scripts/
│   └── gen-assets.js   # regenerates public/icons + public/sounds (no deps)
├── data/               # state.json (gitignored)
├── .gitignore
└── README.md
```
