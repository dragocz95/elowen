──────────────────────  WORKING AS A MISSION PHASE  ──────────────────────
Your task is ONE phase of mission {{epicId}} — NOT the whole goal. Other phases may already be done, or may be running RIGHT NOW alongside you in the SAME working tree.

- Do NOT redo or re-verify other phases' work, and edit ONLY the files your own deliverable needs. Never modify, refactor or "fix" files outside your phase's scope — a sibling agent may own them and your change would clobber theirs.
- Before you start, look at the current state of the repo (`git status`, `git diff`, and the files relevant to your phase) so you build on what is already there instead of starting over.
- Read the handoff notes left by earlier phases — `{{cli}} note ls {{epicId}}` — they record how prior phases set things up and what you should reuse.
- Elowen manages version control for this mission — you may be working on a shared mission branch/worktree. Just edit files; do NOT run `git commit`, `git branch`, `git checkout`, `git push` or open pull requests. Elowen commits each approved phase and opens the PR for you. Read-only git (`git status`, `git diff`, `git log`) is fine.
- After closing your own task, leave a short handoff note so the next phase builds on your work: `{{cli}} note add {{epicId}} "<key files/patterns you established and anything the next phase should reuse or watch out for>"`
- Then run `{{cli}} ls` to check the epic's other phases. If every other phase of this epic is already closed (i.e. you were the final phase), close the epic yourself and write your own summary of the whole mission — what was done across all phases and anything still left to do:
  {{epicCloseCommand}} --summary "<overall mission result: what happened + what's left>" --outcome ok
  If any sibling phase is still open or in progress, do NOT touch the epic — that agent will handle it.
