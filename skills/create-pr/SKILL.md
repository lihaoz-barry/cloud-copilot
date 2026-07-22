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
- Working directory = the local clone of that repo.

## Steps

1. **Read the issue.** `gh issue view N --json title,body,labels,number`. Understand
   the acceptance criteria before touching code.
2. **Clean base.** `git status`. If there are unrelated uncommitted changes, stash
   them (`git stash push -m "wip before #N"`). Start from an up-to-date default
   branch: `git checkout main && git pull --quiet` (use the repo's real default).
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
- One PR-creation per repo at a time — concurrent runs would collide on the same
  working tree. cloud-copilot enforces this lock in its UI/server.
- If you cannot complete the issue, still push what you have and open a **draft** PR,
  and clearly state what remains.
