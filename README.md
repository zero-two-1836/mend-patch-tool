[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/zero-two-1836/mend-patch-tool/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/zero-two-1836/mend-patch-tool/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

mend is a command-line tool that applies an edit an AI model wrote to a tree of
text files. Models write edits in four formats — a unified diff (often with
wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and
text-editor tool calls as JSON — and mend reads all four to one written
specification, `SPEC.md`, which is the whole contract.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `main.ts`: the CLI. Node 22 and its standard library alone; it finds the
  lines each edit names at the first of three matching tiers (exact, trailing
  whitespace ignored, indentation ignored), and writes every change or none.
- `runner.ts`: the trial runner. When `MAKEFUN_ENV_URL` is set, `main.ts`
  hands over to it; it reads the trial's checks from the env, runs the CLI on
  each one in a fresh directory, and posts the results.
- `check.ts`: runs the CLI on the public practice checks:
  `node check.ts <practice.json>`.
- `SPEC.md`: the specification mend implements.
