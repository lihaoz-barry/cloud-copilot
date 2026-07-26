#!/usr/bin/env bash
#
# cloud-copilot setup — bring a fresh Mac to the same working state:
#   Copilot CLI + gh auth + bundled skills + App Store Connect .p8 + fastlane.
#
# Idempotent: safe to re-run. Prints a ✓/✗ summary at the end.
#
# Usage:
#   ./setup/setup.sh [options]
#
# Options:
#   --skills-scope <global|project>  Where to install bundled skills.
#                                    global (default): symlink into ~/.agents/skills
#                                    project: leave in repo, just report the path
#   --override-global-skills         Replace an existing global skill of the same name
#   --fix-keychain                   Run the one-time codesign keychain grant
#                                    (prompts for your login password, interactively)
#   --no-install                     Verify only; do not install anything
#   -h, --help                       Show this help
#
# The companion "cloud-copilot-setup" skill walks the same steps interactively.

set -euo pipefail

# --------------------------------------------------------------------------
# Paths & args
# --------------------------------------------------------------------------
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILLS_SRC="$REPO_DIR/skills"
GLOBAL_SKILLS="$HOME/.agents/skills"
CONFIG_DIR="$HOME/.config/cloud-copilot"
DEPLOY_ENV="$CONFIG_DIR/deploy.env"
DEPLOY_ENV_EXAMPLE="$REPO_DIR/setup/deploy.env.example"

SKILLS_SCOPE="global"
OVERRIDE_SKILLS=""
FIX_KEYCHAIN=""
NO_INSTALL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skills-scope) SKILLS_SCOPE="${2:-}"; shift 2 ;;
    --override-global-skills) OVERRIDE_SKILLS="1"; shift ;;
    --fix-keychain) FIX_KEYCHAIN="1"; shift ;;
    --no-install) NO_INSTALL="1"; shift ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [[ "$SKILLS_SCOPE" != "global" && "$SKILLS_SCOPE" != "project" ]]; then
  echo "--skills-scope must be 'global' or 'project'" >&2; exit 2
fi

# --------------------------------------------------------------------------
# Pretty output + result tracking
# --------------------------------------------------------------------------
BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RST=$'\033[0m'
declare -a RESULTS=()
ok()   { echo "  ${GRN}✓${RST} $1"; RESULTS+=("ok|$1"); }
warn() { echo "  ${YLW}!${RST} $1"; RESULTS+=("warn|$1"); }
fail() { echo "  ${RED}✗${RST} $1"; RESULTS+=("fail|$1"); }
section() { echo; echo "${BOLD}$1${RST}"; }
have() { command -v "$1" >/dev/null 2>&1; }

IS_MAC=""; [[ "$(uname -s)" == "Darwin" ]] && IS_MAC="1"

# --------------------------------------------------------------------------
section "0. Prerequisites"
# --------------------------------------------------------------------------
if [[ -n "$IS_MAC" ]]; then ok "macOS detected"; else warn "not macOS — Deploy/fastlane steps will be skipped"; fi

if have brew; then ok "Homebrew $(brew --version | head -1 | awk '{print $2}')"; else
  warn "Homebrew missing — install from https://brew.sh (needed for gh/fastlane)"
fi

if have node; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if (( NODE_MAJOR >= 18 )); then ok "Node $(node -v)"; else fail "Node $(node -v) — need >= 18"; fi
else
  fail "Node.js missing — install Node >= 18"
fi
have git && ok "git $(git --version | awk '{print $3}')" || fail "git missing"

# --------------------------------------------------------------------------
section "1. GitHub CLI + auth"
# --------------------------------------------------------------------------
if have gh; then
  ok "gh $(gh --version | head -1 | awk '{print $3}')"
  if gh auth status >/dev/null 2>&1; then ok "gh authenticated"; else
    fail "gh not authenticated — run: gh auth login"
  fi
else
  if [[ -z "$NO_INSTALL" ]] && have brew; then
    echo "  installing gh…"; brew install gh >/dev/null && ok "gh installed (now run: gh auth login)"
  else
    fail "gh missing — brew install gh"
  fi
fi

# --------------------------------------------------------------------------
section "2. Copilot CLI"
# --------------------------------------------------------------------------
if have copilot; then
  ok "copilot $(copilot --version 2>/dev/null | head -1)"
elif [[ -z "$NO_INSTALL" ]] && have npm; then
  echo "  installing @github/copilot…"
  if npm install -g @github/copilot >/dev/null 2>&1 && have copilot; then
    ok "copilot installed"
  else
    warn "could not install copilot globally — cloud-copilot can still auto-resolve the VS Code bundled binary, or set COPILOT_BIN"
  fi
else
  warn "copilot missing — npm install -g @github/copilot (or set COPILOT_BIN)"
fi

# --------------------------------------------------------------------------
section "3. Skills (Create PR + Deploy + UI test)"
# --------------------------------------------------------------------------
if [[ "$SKILLS_SCOPE" == "global" ]]; then
  mkdir -p "$GLOBAL_SKILLS"
  for d in "$SKILLS_SRC"/*/; do
    [[ -d "$d" ]] || continue
    name="$(basename "$d")"
    dest="$GLOBAL_SKILLS/$name"
    if [[ -e "$dest" && -z "$OVERRIDE_SKILLS" ]]; then
      # Only warn if it's not already our symlink.
      if [[ -L "$dest" && "$(readlink "$dest")" == "${d%/}" ]]; then
        ok "skill '$name' already linked"
      else
        warn "skill '$name' exists at $dest (keep). Use --override-global-skills to replace"
      fi
    else
      ln -sfn "${d%/}" "$dest" && ok "skill '$name' → $dest"
    fi
  done
else
  ok "skills kept project-local at $SKILLS_SRC"
  echo "  ${DIM}point Copilot at them per-project, e.g. ln -s $SKILLS_SRC/testflight-deploy ~/.agents/skills/${RST}"
fi

# --------------------------------------------------------------------------
section "4. UI testing (Playwright, web repos only)"
# --------------------------------------------------------------------------
# The ui-test skill drives a headless browser to catch layout / contrast /
# tap-target regressions on web UI changes. Two pieces are needed: the npm deps
# + a Chromium build (for skills/ui-test/scripts/audit.mjs), and the playwright
# MCP server (so Copilot can navigate and click interactively).
if have node; then
  if [[ -z "$NO_INSTALL" ]]; then
    if [[ ! -d "$REPO_DIR/node_modules/playwright" || ! -d "$REPO_DIR/node_modules/axe-core" ]]; then
      if (cd "$REPO_DIR" && npm install --silent >/dev/null 2>&1); then
        ok "ui-test npm deps installed (playwright, axe-core)"
      else
        warn "npm install failed — run it manually in $REPO_DIR for the ui-test skill"
      fi
    else
      ok "ui-test npm deps present (playwright, axe-core)"
    fi
  fi

  # Chromium download is ~95MB but cached, so re-runs are a no-op.
  if [[ -n "$NO_INSTALL" ]]; then
    if ls "$HOME/Library/Caches/ms-playwright"/chromium* >/dev/null 2>&1; then
      ok "headless Chromium present"
    else
      warn "headless Chromium missing — npx playwright install chromium"
    fi
  elif (cd "$REPO_DIR" && npx --yes playwright install chromium >/dev/null 2>&1); then
    ok "headless Chromium ready"
  else
    warn "could not install headless Chromium — run: npx playwright install chromium"
  fi
else
  warn "node missing — skipping UI test setup"
fi

if have copilot; then
  # Capture first: `... | grep -q` would SIGPIPE copilot and, under `pipefail`,
  # report a false negative even when the server is registered.
  MCP_LIST="$(copilot mcp list 2>/dev/null || true)"
  if grep -q '^  playwright ' <<<"$MCP_LIST"; then
    ok "playwright MCP server registered"
  elif [[ -n "$NO_INSTALL" ]]; then
    warn "playwright MCP server not registered"
  elif copilot mcp add playwright -- npx -y @playwright/mcp@latest --headless --isolated >/dev/null 2>&1; then
    ok "playwright MCP server registered"
  else
    warn "could not register the playwright MCP server — run: copilot mcp add playwright -- npx -y @playwright/mcp@latest --headless --isolated"
  fi
  # The MCP server drives its own browser build, separate from the npm one above.
  if [[ -z "$NO_INSTALL" ]] && ! ls "$HOME/Library/Caches/ms-playwright"/chrome* >/dev/null 2>&1; then
    npx --yes @playwright/mcp@latest install-browser chrome-for-testing >/dev/null 2>&1 \
      && ok "playwright MCP browser ready" \
      || warn "playwright MCP browser missing — npx @playwright/mcp install-browser chrome-for-testing"
  fi
fi

# --------------------------------------------------------------------------
section "5. Deploy config (App Store Connect)"
# --------------------------------------------------------------------------
mkdir -p "$CONFIG_DIR"
if [[ ! -f "$DEPLOY_ENV" ]]; then
  cp "$DEPLOY_ENV_EXAMPLE" "$DEPLOY_ENV"
  warn "created $DEPLOY_ENV from template — EDIT it with your real values"
else
  ok "deploy.env present at $DEPLOY_ENV"
fi

# shellcheck disable=SC1090
if [[ -f "$DEPLOY_ENV" ]] && source "$DEPLOY_ENV" 2>/dev/null; then
  : "${ASC_KEY_ID:=}"; : "${ASC_KEY_P8_SOURCE:=}"; : "${APP_REPO:=}"
  if [[ -n "${ASC_KEY_ID}" && "${ASC_KEY_ID}" != "XXXXXXXXXX" ]]; then
    P8_DEST="$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8"
    if [[ -f "$P8_DEST" ]]; then
      ok "API key installed: $P8_DEST"
    elif [[ -n "$ASC_KEY_P8_SOURCE" && -f "${ASC_KEY_P8_SOURCE/#\~/$HOME}" ]]; then
      mkdir -p "$(dirname "$P8_DEST")"
      cp "${ASC_KEY_P8_SOURCE/#\~/$HOME}" "$P8_DEST" && chmod 600 "$P8_DEST" && ok "API key copied → $P8_DEST"
    else
      fail "API key .p8 not found (looked for $P8_DEST and ASC_KEY_P8_SOURCE)"
    fi
  else
    warn "deploy.env still has placeholder values — fill it in"
  fi
  if [[ -n "${APP_REPO}" && -f "${APP_REPO/#\~/$HOME}/fastlane/Fastfile" ]]; then
    ok "app repo fastlane found: ${APP_REPO}/fastlane/Fastfile"
  else
    warn "APP_REPO/fastlane/Fastfile not found — set APP_REPO to your iOS app with a 'beta' lane"
  fi
else
  warn "could not source $DEPLOY_ENV"
fi

# --------------------------------------------------------------------------
section "6. fastlane"
# --------------------------------------------------------------------------
if [[ -n "$IS_MAC" ]]; then
  if have fastlane; then
    ok "fastlane $(fastlane --version 2>/dev/null | awk '/fastlane [0-9]/{print $2; exit}')"
  elif [[ -z "$NO_INSTALL" ]] && have brew; then
    echo "  installing fastlane…"; brew install fastlane >/dev/null && ok "fastlane installed"
  else
    warn "fastlane missing — brew install fastlane"
  fi

  if [[ -n "$FIX_KEYCHAIN" ]]; then
    echo "  ${DIM}applying codesign keychain grant (you'll be prompted for your login password)…${RST}"
    KC="$HOME/Library/Keychains/login.keychain-db"
    security unlock-keychain "$KC" || true
    if security set-key-partition-list -S apple-tool:,apple:,codesign: -s "$KC" >/dev/null 2>&1; then
      ok "keychain partition list set for codesign"
    else
      warn "keychain grant not applied — re-run: security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k <pw> $KC"
    fi
  else
    echo "  ${DIM}tip: re-run with --fix-keychain to grant codesign non-interactive keychain access${RST}"
  fi
else
  warn "skipping fastlane/keychain (not macOS)"
fi

# --------------------------------------------------------------------------
section "7. cloud-copilot dependencies"
# --------------------------------------------------------------------------
if [[ -z "$NO_INSTALL" ]] && have npm; then
  ( cd "$REPO_DIR" && npm install --no-audit --no-fund >/dev/null 2>&1 ) && ok "npm install complete" || warn "npm install had issues — run it manually in $REPO_DIR"
else
  warn "run 'npm install' in $REPO_DIR"
fi

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------
section "Summary"
fails=0; warns=0
for r in "${RESULTS[@]}"; do
  status="${r%%|*}"; msg="${r#*|}"
  case "$status" in
    ok)   printf "  ${GRN}✓${RST} %s\n" "$msg" ;;
    warn) printf "  ${YLW}!${RST} %s\n" "$msg"; warns=$((warns+1)) ;;
    fail) printf "  ${RED}✗${RST} %s\n" "$msg"; fails=$((fails+1)) ;;
  esac
done
echo
if (( fails == 0 )); then
  echo "${GRN}${BOLD}Ready.${RST} Start with: ${BOLD}cd $REPO_DIR && npm start${RST}  (then open http://<mac-ip>:8787)"
else
  echo "${RED}${BOLD}$fails blocking item(s)${RST} and $warns warning(s) — resolve the ✗ items above (see the cloud-copilot-setup skill)."
fi
exit $(( fails > 0 ? 1 : 0 ))
