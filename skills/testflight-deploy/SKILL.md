---
name: testflight-deploy
description: Build and upload an iOS app to TestFlight via fastlane, driven by a machine-local config. Use when the user says "deploy to TestFlight", "发布到 TestFlight", "push build X", gives a branch to test on device, or asks to build+upload the iOS app. This is the portable version bundled with cloud-copilot — fill in the identifiers via setup and it reproduces the exact same signing chain.
---

# TestFlight Deploy (portable SOP)

Ship the current working tree of your iOS app to TestFlight. All machine- and
account-specific values live in a **gitignored** config file so nothing secret is
committed:

```
~/.config/cloud-copilot/deploy.env
```

Create it from `setup/deploy.env.example` (the `setup/setup.sh` script does this).

## Ground-truth parameters (from deploy.env — do NOT re-derive)

| Variable | Meaning |
|---|---|
| `APP_REPO` | Local path to the iOS app repo (contains `fastlane/Fastfile` with a `beta` lane) |
| `APPLE_TEAM_ID` | The signing team the API key belongs to & where the app record lives |
| `APP_BUNDLE_ID` | The **ship** bundle id that has an App Store Connect record |
| `ASC_APP_ID` | App Store Connect App ID (numeric) |
| `ASC_KEY_ID` | App Store Connect API key id |
| `ASC_ISSUER_ID` | App Store Connect API issuer id |
| `ASC_KEY_P8_SOURCE` | Where you keep the downloaded `.p8` (copied to `~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8`) |

> The API key `.p8` is a **secret** — it lives only under
> `~/.appstoreconnect/private_keys/` (mode 600) and is never committed.

## Happy path (one command)

The app repo has `fastlane/Fastfile` with a `beta` lane (cert → sigh → gym → pilot,
via the API key, **manual signing**). From the app repo root:

```bash
source ~/.config/cloud-copilot/deploy.env
cd "$APP_REPO"
LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 fastlane beta            # build number = commit count
# or pin one:
LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8 fastlane beta build:57 version:1.0
```

It builds the **current working tree**, signs for App Store, uploads to TestFlight,
and returns. Apple then takes ~5–30 min to process before it appears in TestFlight.

## Deploy steps (driving it / a branch)

1. **Clean state**: `git status`. Stash unrelated changes. To deploy a branch:
   `git fetch` + `git checkout <branch>` (don't `git pull` over WIP you want to test).
2. **Run** `fastlane beta` (see above), from `$APP_REPO`.
3. **Report**: build number, version, `APP_BUNDLE_ID`, `ASC_APP_ID`, and the
   "~5–30 min to process" note. Restore any stash you made.

## Signing model — why manual

Automatic signing / `xcodebuild -exportArchive` fail on the CLI here with
`No Account for Team ...`. The lane uses **manual signing**: `cert` + `sigh`
create/reuse the Distribution cert + App Store profile via the API key, and `gym`
archives+exports with `CODE_SIGN_STYLE=Manual`, `CODE_SIGN_IDENTITY=Apple Distribution`,
`PROVISIONING_PROFILE_SPECIFIER=<sigh profile>`, `DEVELOPMENT_TEAM=$APPLE_TEAM_ID`.

## Troubleshooting (real errors, with fixes)

| Symptom | Cause → Fix |
|---|---|
| `Permission denied and could not request permission from user` (before any fastlane output, only for commands that write outside the repo, e.g. `/tmp`, `~/Library`, keychain) | You are running through an agent sandbox (e.g. Copilot CLI) that confines file access to the working dir and can't prompt in `-p` mode. Grant full access: run Copilot with **`--allow-all`** (= `--allow-all-tools --allow-all-paths --allow-all-urls`). cloud-copilot's deploy already does this. |
| `Permission denied` during `codesign` / signing step (keychain) | The login keychain won't let `codesign` use the key non-interactively. One-time fix: `security unlock-keychain ~/Library/Keychains/login.keychain-db` then `security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "<login-pw>" ~/Library/Keychains/login.keychain-db`. Re-run if it recurs after an OS/keychain change. |
| `No Account for Team "..."` / `No profiles for ... were found` | Automatic signing / wrong team. Use the fastlane `beta` lane (manual signing) with `APPLE_TEAM_ID`. |
| `Could not find an app on App Store Connect with app_identifier ...` | No app record for that bundle id. Ship under `APP_BUNDLE_ID` (which has record `ASC_APP_ID`), or create the record in the ASC web UI. |
| `An App ID with Identifier '...' is not available` (409) | Bundle id registered under another (often personal free) team. Free teams can't ship; use the real team `APPLE_TEAM_ID`. |
| `Missing ... 'CFBundleIconName'` / `Missing required icon` | Put a 1024×1024 **no-alpha** PNG in the AppIcon set with a single-size `Contents.json`. |
| `WARNING: fastlane requires your locale to be set to UTF-8` | Prefix with `LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8`. |
| Distribution `.p12` / `.cer` / `.mobileprovision` appear in the repo | fastlane `cert`/`sigh` byproducts — git-ignored; move them out. The `.p12` is a private key, never commit it. |

## Build numbers

Must strictly increase per (bundle id, version). `git rev-list --count HEAD` gives a
monotonic value. A failed build does not consume the number (Apple registers it only
after successful processing); if ASC says a number is taken, bump with `build:<n+1>`.
