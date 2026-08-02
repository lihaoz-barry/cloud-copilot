---
name: create-pr
description: Implement a GitHub issue end-to-end on a fresh branch and open a pull request that closes it. Use when driving Copilot to autonomously turn an issue into a merged-ready PR (this is the skill behind cloud-copilot's "Create PR" button).
---

# Create PR — implement an issue and open a pull request

This is the SOP the cloud-copilot **Create PR** action follows. Given a repo and
an issue number, take it from "open issue" to "PR that closes it", autonomously.

## Inputs
- `OWNER/REPO` — the GitHub repository (has a `github.com` origin remote).
- `#N` — the issue number to implement.
- Working directory = a checkout of that repo. When `CC_WORKTREE` is set it is a
  **dedicated linked worktree** created just for this run, already sitting on the
  up-to-date base branch and thrown away afterwards.
- `CC_TEST_PORT` / `PORT` — a port reserved for **this run only**. If you need to
  boot a server to verify the change, bind that port and nothing else: other runs
  are happening at the same time on other ports.

## Steps

1. **Read the issue.** `gh issue view N --json title,body,labels,number`. Understand
   the acceptance criteria before touching code.
2. **Clean base.** `git status`. In a `CC_WORKTREE` run the tree is already clean
   and already on the freshly fetched base commit — do **not** check out or pull
   another branch, and do **not** stash. Otherwise start from an up-to-date default
   branch: `git checkout main && git pull --quiet` (use the repo's real default),
   stashing unrelated changes first (`git stash push -m "wip before #N"`).
3. **Branch.** Create a descriptive branch: `git checkout -b fix-N-short-slug`.
4. **Implement end-to-end.** Make the actual code changes required to satisfy the
   issue. Build/lint/test where a toolchain exists. Do not stop at a partial change.
5. **Commit.** Stage and commit with a message referencing the issue
   (`... (closes #N)`).
6. **Push.** `git push -u origin <branch>`.
7. **Open the PR.** `gh pr create --base <default> --head <branch> --title ... --body ...`
   with a body that includes `Closes #N` so merging auto-closes the issue.
8. **Print the PR URL on its own line** as the final output — the caller detects
   success by matching the `https://github.com/OWNER/REPO/pull/<n>` URL in the
   transcript (fallback: `gh pr list` referencing the issue).

## Notes
- Non-interactive runs need broad permissions; cloud-copilot invokes Copilot with
  `--allow-all` so file edits, `git`, and `gh` run without prompts.
- **Several PR creations can run at once**, including on the same repo: each gets
  its own worktree (`CC_WORKTREE`), its own port (`CC_TEST_PORT`) and its own data
  directory (`CC_DATA_DIR`). Stay inside the working directory you were given and
  never touch another worktree or the repo's main checkout.
- If you cannot complete the issue, still push what you have and open a **draft** PR,
  and clearly state what remains.
