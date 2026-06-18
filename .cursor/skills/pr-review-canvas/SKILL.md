---
name: pr-review-canvas
description: >-
  Organize a code change diff for reviewer comprehension (core logic → wiring →
  mechanical). For Telegram Bot admin edits, output a single self-contained HTML
  file instead of a .canvas.tsx. Use when summarizing a diff for review or after
  tg-bot code modifications.
---

# PR / Code Change Review

Present a diff reorganized for reviewer comprehension — not in file-tree order.

This copy is **bundled with cursor-tg-bot** (`.cursor/skills/pr-review-canvas/`). Do not depend on `~/.cursor/skills/`.

## Gather the diff

**Telegram Bot / local branch workflow (default here):**

- After commits on the current feature branch, run shell:
  - `git diff main...HEAD` (or `master...HEAD` if main does not exist)
  - If needed: `git merge-base main HEAD` then `git diff <base>...HEAD`
- Collect every file path, additions, deletions, and hunks.

**GitHub PR workflow (optional):**

- If the user gave a PR URL or number, use `gh pr diff <pr>` instead.

Do not stop and ask for a PR link when you are finishing a tg-bot admin code edit — the branch diff is the source of truth.

## Group changes for comprehension

Do **not** present files in alphabetical or tree order. Reorganize into sections ordered by reviewer value:

1. **Core logic** — New behavior, algorithm changes, state transitions, API surface changes. Show full diffs with surrounding context.
2. **Wiring & integration** — Route registration, dependency injection, config plumbing. Condensed — enough to confirm correctness.
3. **Boilerplate & mechanical** — Import reordering, renames, generated code, formatting. Summarize as file names and stats; skip inline diffs unless relevant.

Lead with core logic.

## Distill complex logic into pseudocode

When a core change is dense (state machines, retry flows, multi-step transforms), add a short pseudocode summary beside the diff. Skip for straightforward hunks.

## Trace tricky logic on a concrete example

For behavior that is hard to predict from the hunk alone, walk a small realistic input through old vs new paths and note where they diverge.

## Call attention to tricky things

For surprising, risky, or easy-to-miss hunks, add a short tag (e.g. "Subtle", "Breaking", "Race condition", "Perf") and one sentence of explanation. Use sparingly.

## Tone and content

Reviewer-facing commentary, not a changelog:

- **Why** something changed, not only what.
- Cross-file interactions when relevant.
- One or two sentences per note.

## Output: single HTML file (Telegram Bot)

When invoked from **cursor-tg-bot** admin code edits (system prompt says so):

1. **Do not** create `.canvas.tsx` or read the IDE canvas skill.
2. Write one **self-contained HTML** file:
   - Path: `.cursor-tg-bot/code-review.html` (relative to project root; `mkdir -p .cursor-tg-bot` if needed)
   - Inline CSS only; no external assets, no `fetch`
   - Page title, branch name, grouped sections (Core / Wiring / Boilerplate)
   - Diffs in `<pre>` with `+`/`-` lines preserved; optional light styling for additions/deletions
   - Terse reviewer notes per section
3. End the chat reply with a single line (machine marker for the bot):
   `REVIEW_HTML:.cursor-tg-bot/code-review.html`
4. If no files were changed or no commit was made, skip HTML and the marker line.

## IDE Canvas (optional)

If the user explicitly asks for a **Cursor Canvas** in the IDE (not Telegram), read `~/.cursor/skills-cursor/canvas/SKILL.md` and build a `.canvas.tsx` under the workspace `canvases/` directory per that skill. That path is separate from the HTML deliverable above.
