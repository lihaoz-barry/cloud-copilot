---
name: cloud-copilot-setup
description: Bring up cloud-copilot on a fresh Mac end-to-end — install the Copilot CLI, gh auth, bundled skills, the App Store Connect .p8 key, and fastlane — so the Create PR and Deploy buttons work identically to the reference machine. Use when a user says "set up cloud-copilot on this machine", "配置 cloud-copilot", "onboard a new laptop", or asks an agent to reproduce the whole chain.
---

# cloud-copilot — machine setup (guided)

Goal: a new Mac reaches the **exact same** behavior — browse issues, **Create PR**,
and **Deploy to TestFlight** — as the reference machine.

There are two paths; both end in the same state:
- **Automated:** run `setup/setup.sh` (see "One-shot script" below).
- **Guided:** walk the steps here interactively (use this when the script fails or
  the user wants to understand/confirm each step).

Follow steps in order. After each, verify before moving on.

## 0. Prerequisites
- macOS (deploy is macOS-only), Homebrew, Node.js ≥ 18, git.
- `brew --version`, `node -v`, `git --version` should all succeed.

## 1. GitHub CLI + auth
- Install: `brew install gh` (if missing).
- Auth: `gh auth status` — if not logged in, `gh auth login` (HTTPS, git protocol).
- All GitHub reads (issues, PRs) go through `gh`; no token wiring needed.

## 2. Copilot CLI
- Install: `npm install -g @github/copilot` → binary `copilot`.
- Verify: `copilot --version`.
- cloud-copilot auto-resolves the binary (PATH → nvm → Homebrew → VS Code bundle).
  Override with `COPILOT_BIN=/path/to/copilot` if needed.
- **Sandbox note:** autonomous runs use `--allow-all` (tools + paths + urls) so
  Create PR can edit files/run git+gh and Deploy can write to `/tmp`, `~/Library`,
  and the keychain non-interactively. Without it you'll see
  `Permission denied and could not request permission from user`.

## 3. Skills (Create PR + Deploy)
The repo bundles skills under `skills/`. Decide **scope** with the user:
- **Global** (default) — symlink each `skills/<name>` into `~/.agents/skills/<name>`
  so Copilot discovers them from any repo. This is what makes Deploy work from the
  target app repo. Use `--override-global-skills` to replace an existing one.
- **Project** — leave them in `skills/` and reference/symlink per-project. Prefer
  global unless the user explicitly wants to keep a machine's global skills untouched.

Verify: `ls -l ~/.agents/skills/` shows `testflight-deploy`, `create-pr`.

## 4. Deploy config (App Store Connect)
- Copy `setup/deploy.env.example` → `~/.config/cloud-copilot/deploy.env` and fill in:
  `APP_REPO`, `APPLE_TEAM_ID`, `APP_BUNDLE_ID`, `ASC_APP_ID`, `ASC_KEY_ID`,
  `ASC_ISSUER_ID`, `ASC_KEY_P8_SOURCE`. **Never commit this file.**
- Install the API key: copy the `.p8` to
  `~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8` (mode 600).
- Verify: the `.p8` exists and `deploy.env` sources cleanly
  (`bash -c 'source ~/.config/cloud-copilot/deploy.env && echo "$ASC_APP_ID"'`).

## 5. fastlane
- Install: `brew install fastlane`. Verify `fastlane --version`.
- The **target app repo** (`$APP_REPO`) must contain `fastlane/Fastfile` with a
  `beta` lane (manual signing via the API key). See the `testflight-deploy` skill.
- One-time keychain grant so `codesign` won't block headless deploys:
  ```bash
  security unlock-keychain ~/Library/Keychains/login.keychain-db
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s \
    -k "<login-pw>" ~/Library/Keychains/login.keychain-db
  ```
  (The user types their own login password; never route it through an agent.)

## 6. cloud-copilot itself
- In the repo: `npm install`.
- Set `REPOS_ROOT` to the folder holding your git repos (default `~/repos`).
- Start: `npm start` (binds `0.0.0.0:8787` for LAN). Open `http://<mac-ip>:8787`.

## 7. Verify the whole chain
- `GET /api/repos` lists your repos.
- Expand a repo → issues load (via `gh`).
- **Create PR** on a throwaway issue → streams, opens a PR, issue turns green.
- **Deploy** a PR → `cert → sigh → gym → pilot` → `Successfully uploaded`.

## One-shot script
```bash
cd cloud-copilot
./setup/setup.sh                     # global skills, interactive checks
./setup/setup.sh --skills-scope project
./setup/setup.sh --override-global-skills --fix-keychain
```
The script is idempotent — safe to re-run. It installs/verifies each layer and
prints a ✓/✗ summary at the end; finish any ✗ items using the matching step above.
