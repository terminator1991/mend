# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/terminator1991/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/terminator1991/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

A small command line tool that applies a model-written edit to a tree of text
files. It reads one patch — a unified diff, SEARCH/REPLACE blocks, a V4A
patch, or JSON editor calls — and applies its edits in order, all or nothing.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=jdm01ad5&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>

## Usage

- `PATCH` is the patch file, relative to the working directory (the tree's
  root). When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`. The default, `auto`, detects it.
- `--check` does everything but write: same output and exit code, no file
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

## Exit codes

- `0` — the tree is written; stdout lists each changed path (`A`, `D`, `M`,
  or `R old -> new`), then `ok: <n> files`.
- `1` — one or more edits failed; stdout lists each failure
  (`error: <code> <path>`) and then `failed: <k> of <n> edits`. Nothing is
  written.
- `2` — a usage error, an unreadable patch file, an undetected format, or a
  patch that cannot be parsed; stdout holds a single `error: ...` line.

Matching is forgiving by default: old lines are found exactly, then ignoring
trailing whitespace, then ignoring leading and trailing whitespace.

See `SPEC.md` in the competition kit for the full specification.
