# pi-autoresearch

A small, generic **autoresearch outer loop for Pi**. It keeps Pi as the worker and
adds the pieces that make unattended iterative optimization more disciplined:

- fixed validation + objective evaluator
- compact `experiments.tsv` attempt/result memory
- short `research.md` learned-state memory
- Git lineage for accepted improvements
- stagnation-triggered strategy supervision
- a doom-loop watchdog for pathological long debugging iterations
- optional `/knowledge`-style domain references
- editable/protected path enforcement

The design intentionally borrows the simple experiment loop popularized by
Karpathy's autoresearch and the evaluator/lineage/knowledge/supervision ideas in
NVIDIA AVO, while remaining a normal Pi package rather than a Pi fork.

## Install

Pi packages can be installed straight from Git:

```bash
pi install git:github.com/jochalek/pi-autoresearch
```

For development, this repo pins Node 22 with mise:

```bash
mise install
npm install
npm run check
pi -e ./extensions/research-loop.ts
```

Pi currently uses `@earendil-works/pi-coding-agent`; the older
`@mariozechner/pi-coding-agent` package is deprecated.

## Configure a target project

Copy the example contract:

```bash
mkdir -p .pi
cp /path/to/pi-autoresearch/examples/research.yaml .pi/research.yaml
mkdir -p knowledge
```

A minimal contract:

```yaml
goal: "Minimize benchmark latency"

editable:
  - "src/**"

protected:
  - "tests/**"
  - "benchmarks/**"

validate:
  command: "npm test"

evaluate:
  command: "./scripts/benchmark.sh"
  score_regex: "score\\s*=\\s*([0-9.]+)"
  direction: minimize

knowledge:
  paths: ["./knowledge"]
  optional: true

supervisor:
  stagnation_attempts: 5
  watchdog:
    soft_tool_calls: 45
    hard_tool_calls: 80
    max_failed_tools: 12
    max_repeated_bash: 5
```

The evaluator should emit a numeric final line, or output text matched by
`score_regex` with the score in capture group 1.

## Tools

The extension registers six tools:

- `research_status` — objective, best result, recent attempts, watchdog/supervisor state, knowledge paths
- `research_start` — begin one bounded experiment from a clean implementation worktree
- `research_evaluate` — run fixed validation then fixed evaluator
- `research_record` — keep/discard/crash/abort an experiment; only objective improvements may be kept
- `research_abort` — stop a doom-loop and roll back editable changes
- `research_supervise` — strategy reset after stagnation or an aborted iteration

The bundled `autoresearch` skill teaches the worker how to use them.

## Memory model

`experiments.tsv` is deliberately compact:

```text
attempt status   score   delta   commit   description
1       keep     18.42           a12bc3   baseline
2       discard  18.76   -0.34   a12bc3   parallel parser added lock overhead
3       aborted                  a12bc3   allocator rewrite spiraled into lifetime debugging
4       keep     17.91    0.51   f39d12   cache parsed schema between requests
```

`research.md` holds a bounded list of recent learned observations. It is meant to
stay short enough to reread cheaply. Git stores exact accepted implementations.
Optional `knowledge/` material is consulted only when useful; it is never loaded
wholesale by the extension.

By default `experiments.tsv`, `research.md`, and `.pi/research-state.json` should
be ignored by the target project's Git history. That keeps the accepted code
lineage clean while preserving local research memory. Track them deliberately if
you prefer them versioned.

## Watchdog

Stagnation and doom loops are separate failure modes.

A completed sequence of non-improving experiments triggers the strategy
supervisor. A single iteration can instead trip the watchdog based on tool-call
budget, failed tools, or repeated identical bash commands. Once hard-stopped,
ordinary tools are blocked and the worker must abort the experiment and perform a
strategy reset.

A soft tool-call threshold warns in the Pi UI before the hard stop.

## Safety / Git behavior

Autoresearch requires a Git repository with at least one commit and a clean
implementation worktree at the start of each experiment. Runtime research-memory
files are ignored when checking cleanliness.

`keep` commits only files matching `editable`. `discard`/`crash`/`aborted` restore
tracked editable files and remove untracked editable files created during the
iteration. Protected or out-of-scope modifications cause evaluation/recording to
fail instead of silently accepting them.

This is v0.1: intentionally small, inspectable, and single-worker. A later version
can add a truly separate supervisor model/session without changing the project
contract.
