# Progress

## Goal

Build a generic autonomous research loop around Pi without forking Pi itself.

The architecture is:

* Pi = research/coding worker
* skill = research protocol
* extension = deterministic experiment machinery
* `.pi/research.yaml` = project-specific research contract
* `experiments.tsv` = compact experiment history
* `research.md` = accumulated research understanding
* Git = accepted implementation lineage
* `knowledge/` = optional domain knowledge

The basic loop is:

`inspect → hypothesize → modify → validate → evaluate → keep/discard → repeat`

The extension currently provides experiment lifecycle tools, objective evaluation, editable/protected path enforcement, Git checkpointing, compact research memory, stagnation supervision, and a doom-loop watchdog.

## Current direction

Autoresearch should be explicitly enabled by the target project rather than affecting every Pi session where the package is available.

`.pi/research.yaml` will serve as that opt-in signal.

A project without the file should behave like ordinary Pi: no autoresearch tools or watchdog hooks.

A research project should require only:

```text
.pi/research.yaml
knowledge/          # optional
```

Runtime state such as `experiments.tsv`, `research.md`, and `.pi/research-state.json` should be created automatically.

## Completed

The extension now checks for `.pi/research.yaml` when it loads. Without that file,
no `research_*` tools or autoresearch event hooks are registered. With it, the
existing config schema and research behavior are unchanged. The README now uses
this explicit opt-in flow and documents optional knowledge and generated state.

The preferred installation for an individual project is:

```bash
cd my-project
pi install -l git:github.com/jochalek/pi-autoresearch
```

## Next work

Keep the architecture generic while improving supervision, memory synthesis,
watchdog behavior, and autonomous experiment quality. A separate supervisor
Pi/model session can be considered later rather than complicating the initial
single-worker design.
