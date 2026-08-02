---
name: salvage-local-changes
description: Rescue uncommitted work from a dirty git working tree by summarizing it, opening a GitHub issue, and putting it on a branch cut from the latest default branch as a pull request — leaving the tree clean. Use when a working-tree action (Deploy, Create PR, Chat) is blocked by local changes that must not be thrown away (this is the skill behind cloud-copilot's automatic deploy preflight).
---

# Salvage local changes — turn a dirty working tree into an issue + PR

This is the SOP the cloud-copilot **Deploy** action runs as a preflight when the
repo's shared working tree has uncommitted changes. A single clone serves every
action, so `git checkout <pr-branch>` aborts with *"Your local changes would be
overwritten by checkout"* and the deploy dies. Rather than failing — or worse,
discarding the work with a hard reset — capture that work properly first.

**The prime directive: never lose the local changes, and never leave the tree
dirty.** Both halves matter. The caller checks out another branch the moment you
finish, so anything still uncommitted is destroyed.

## Inputs
- `OWNER/REPO` — the GitHub repository (has a `github.com` origin remote).
- Working directory = the local clone, with uncommitted changes present.

## Steps

1. **Survey the damage.** `git status --porcelain` and `git diff` (plus
   `git diff --staged`, and read any untracked files). Understand what the change
   actually *does* — you are about to describe it to a human who has forgotten.
2. **Summarize.** Write a short title and a body covering: which files changed,
   what behavior the change introduces or fixes, and whether it looks finished or
   mid-flight. Say so plainly when the work is clearly incomplete — a truthful
   "WIP, parser half-rewritten" beats an invented rationale.
3. **Open an issue.** `gh issue create --title ... --body ...`, with a body noting
   it was recovered automatically from an uncommitted working tree. Capture the
   issue number `N`.
4. **Park the changes.** `git stash push -u -m "salvage before #N"` (`-u` so
   untracked files come along — they are the easiest to lose).
5. **Fresh base.** `git fetch origin` then `git checkout <default>` and
   `git pull --quiet` (use the repo's real default branch, not a guess —
   `gh repo view --json defaultBranchRef`).
6. **Branch.** `git checkout -b salvage-N-short-slug`.
7. **Restore.** `git stash pop`.
   - **On conflict:** resolve it. Take the local (stashed) side for the salvaged
     work, keep upstream's side where main has moved on, and combine them where
     both changed the same region. Never resolve by discarding the stashed hunk
     wholesale. Then `git add` the resolved files.
   - If you truly cannot reconcile a file, commit the conflict-free files, and
     record the unresolved file's full stashed contents in the PR body so the
     work still exists somewhere durable. Do not drop it silently.
   - Confirm the stash entry is gone (`git stash list`); if `pop` left it behind
     because of the conflict, `git stash drop` only after the content is committed.
8. **Sanity-check.** Build/lint/test if a toolchain exists. This is recovered WIP,
   so it may not pass — that is fine and worth stating, but you must know which.
9. **Commit.** Stage everything, including previously-untracked files, and commit
   with a message referencing the issue (`... (closes #N)`).
10. **Push.** `git push -u origin <branch>`.
11. **Open the PR.** `gh pr create --base <default> --head <branch> --title ... --body ...`
    with `Closes #N` in the body, plus the summary from step 2 and any caveats from
    steps 7–8. **Do not merge it** — a human reviews recovered work.
12. **Leave the tree clean.** `git status --porcelain` must print **nothing**. The
    caller checks out a different branch immediately after you exit; a dirty tree
    means the preflight failed even if the PR exists.
13. **Print the issue URL and the PR URL, each on its own line**, as the final
    output — the caller matches those URLs in the transcript to confirm success.

## How the caller verifies you

A clean working tree is *not* enough: the caller also checks that

- `HEAD` is contained in some `origin/*` ref — i.e. the salvaged commit was
  actually pushed, not just committed locally, and
- a pull request that is **open**, is **not** the one being deployed, is not
  headed by the default branch, and whose head commit **contains** the commit you
  left at `HEAD` really exists on GitHub. Each PR URL you print is looked up (last
  one first); failing that, open PRs on the branch you left checked out are.

So printing a URL is not enough on its own — the PR has to be real and has to
carry the work. If the check fails the deploy is aborted and nothing is checked
out, so a half-finished salvage (commit made, `gh`/push failed) can never bury
the work. Push and open the PR — do not stop at a local commit.

## Notes
- Non-interactive runs need broad permissions; cloud-copilot invokes Copilot with
  `--allow-all` so file edits, `git`, and `gh` run without prompts.
- Do not touch the branch the caller is about to deploy, and do not merge, rebase,
  or force-push anything. Your entire job is: dirty tree in, clean tree + issue +
  PR out.
- `git checkout -- .`, `git reset --hard`, and `git clean` destroy the very work
  you were asked to rescue. Never run them.
- If the tree turns out to be clean already, do nothing, say so, and exit 0 — the
  caller then proceeds straight to its checkout.
