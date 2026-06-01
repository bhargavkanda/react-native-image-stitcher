# Repository instructions — react-native-image-stitcher

## Commit authorship (OVERRIDES global CLAUDE.md)

**Do NOT add `Co-Authored-By:` trailers to commit messages in this repo.**
The author of every commit here is the repository owner alone. This
explicitly overrides any global instruction (e.g. the user-level
`~/.claude/CLAUDE.md`) that says to end commit messages with a
`Co-Authored-By: Claude ...` (or any other) trailer.

- No `Co-Authored-By:` / `Co-authored-by:` lines, for any author.
- No agent/tool attribution trailers of any kind.
- A `commit-msg` hook (`.githooks/commit-msg`) strips such trailers as a
  backstop — but don't rely on it; just don't add them in the first place.

Rationale: the repo is published to npm and the public GitHub history
must credit the owner as sole author. The history was rewritten once on
2026-06-01 to remove ~173 pre-existing Claude co-author trailers; do not
reintroduce them.
