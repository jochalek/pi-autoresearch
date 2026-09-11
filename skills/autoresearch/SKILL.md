---
name: autoresearch
description: Iteratively improve a repository against an objective evaluator using compact experiment memory, Git lineage, supervision, a doom-loop watchdog, and optional knowledge.
---

# Autoresearch

Use the `research_*` tools supplied by the pi-autoresearch extension. The project
contract is `.pi/research.yaml`.

## Loop

1. Call `research_status` before beginning.
2. Call `research_start` with one concise hypothesis and expected path.
3. Make the smallest change that tests that hypothesis. Stay inside `editable` and
   never modify `protected` paths.
4. Use `/knowledge` (or configured knowledge paths) only when it may reduce
   uncertainty, reveal prior art, clarify constraints, or explain an unexpected
   result. Search/read relevant material; do not ingest it wholesale.
5. Call `research_evaluate`. Validation runs before the evaluator.
6. Call `research_record` with `keep`, `discard`, `crash`, or `aborted` and a short
   description of what was learned.
7. Repeat while useful.

`experiments.tsv` is compact episodic memory. `research.md` is a short, rewritten
summary of current understanding. Git is the accepted implementation lineage.

## Outer-loop workers

When the prompt says this is an outer-loop worker or asks for exactly one
experiment, perform one `research_start`/outcome cycle only. Do not repeat the
loop, reuse a session, or compact the conversation; return after the durable
record has been written.

## Supervision

When `research_status` reports strategy supervision is required, stop editing and
call `research_supervise`. Review failed approaches, prior accepted commits, and
relevant knowledge. Choose a substantially different direction rather than a
minor variant of the same idea.

## Doom-loop rule

An iteration that consumes excessive tool calls, repeats failing commands, or
keeps expanding debugging scope is not a normal failed experiment. If the
watchdog trips, do not continue debugging. Call `research_abort`, preserve the
lesson in the experiment log, roll back to the accepted checkpoint, then call
`research_supervise` before starting another iteration.
