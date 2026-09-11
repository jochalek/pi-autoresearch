import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { minimatch } from "minimatch";

export const CONFIG_PATH = ".pi/research.yaml";
export const STATE_PATH = ".pi/research-state.json";
export const EXPERIMENTS_PATH = "experiments.tsv";
export const RESEARCH_PATH = "research.md";

const META_PATHS = new Set([STATE_PATH, EXPERIMENTS_PATH, RESEARCH_PATH]);
const DEFAULT_PI_COMMAND = "pi";

/**
 * This is deliberately a prompt, rather than a session or a continuation.
 * A worker gets one turn and the files in the checkout are its only memory.
 */
export const WORKER_PROMPT = `You are the worker for exactly one autoresearch experiment.

Use the project's .pi/research.yaml contract and the research_* tools. Inspect
research_status and the recent durable memory, then choose one hypothesis. If
supervision is required, perform research_supervise first. Call research_start,
make the smallest useful change, evaluate it, and finish by calling
research_record exactly once with keep, discard, crash, or aborted.

This invocation must complete exactly one experiment. Do not start a second
experiment, do not leave .pi/research-state.json with an active iteration, and do not
wait for another worker. Never edit protected paths or the evaluator. Do not
use /compact, continue a session, or rely on conversation history: durable
files, Git, and the research tools are the only memory. If the experiment
becomes pathological, use research_abort and research_supervise as required,
then stop after that one outcome.`;

function defaultState() {
  return {
    version: 1,
    attemptCount: 0,
    keepCount: 0,
    nonImprovingCount: 0,
    supervisorRequired: false,
  };
}

function cleanCell(value) {
  return String(value ?? "").replace(/[\t\r\n]+/g, " ").trim();
}

function fmtScore(value) {
  if (value === undefined || value === null) return "";
  return Number.isInteger(value)
    ? String(value)
    : Number(value).toPrecision(8).replace(/0+$/, "").replace(/\.$/, "");
}

function fullPath(cwd, relative) {
  return path.join(cwd, relative);
}

async function readState(cwd) {
  const filename = fullPath(cwd, STATE_PATH);
  if (!existsSync(filename)) return defaultState();
  return JSON.parse(await readFile(filename, "utf8"));
}

async function writeState(cwd, state) {
  const filename = fullPath(cwd, STATE_PATH);
  await mkdir(path.dirname(filename), { recursive: true });
  // A rename prevents a killed outer loop from leaving a half-written JSON
  // file. The extension itself can still write the normal state file.
  const temporary = `${filename}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temporary, filename);
}

async function loadConfig(cwd) {
  const filename = fullPath(cwd, CONFIG_PATH);
  if (!existsSync(filename)) {
    throw new Error(`Missing ${CONFIG_PATH}. Run this command from an opted-in research project.`);
  }
  const config = parseYaml(await readFile(filename, "utf8"));
  if (!config?.goal || !Array.isArray(config.editable) || config.editable.length === 0 ||
      !config.evaluate?.command || !config.evaluate?.direction) {
    throw new Error(`${CONFIG_PATH} must define goal, editable[], evaluate.command, and evaluate.direction.`);
  }
  return config;
}

async function git(cwd, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function gitOutput(result) {
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
}

function parseStatus(output) {
  return output.split("\n").filter(Boolean).map((line) => ({
    status: line.slice(0, 2),
    file: line.slice(3).replace(/^"|"$/g, ""),
  }));
}

async function changedPaths(cwd) {
  const result = await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (result.code !== 0) throw new Error(`git status failed: ${gitOutput(result)}`);
  return parseStatus(result.stdout);
}

function normalized(file) {
  return file.replaceAll("\\", "/");
}

function isMeta(file) {
  const candidate = normalized(file);
  return META_PATHS.has(candidate) || candidate.startsWith(`${STATE_PATH}.`);
}

function matchesAny(file, patterns) {
  const candidate = normalized(file);
  return patterns.some((pattern) => minimatch(candidate, pattern, { dot: true, matchBase: false }));
}

function assertSafeStaleChanges(changes, config) {
  const relevant = changes.filter((change) => !isMeta(change.file));
  const protectedHit = relevant.filter((change) => matchesAny(change.file, config.protected ?? []));
  if (protectedHit.length) {
    throw new Error(`Cannot recover stale experiment: protected paths were modified: ${protectedHit.map((x) => x.file).join(", ")}`);
  }
  const outside = relevant.filter((change) => !matchesAny(change.file, config.editable));
  if (outside.length) {
    throw new Error(`Cannot recover stale experiment: changes outside editable paths: ${outside.map((x) => x.file).join(", ")}`);
  }
  return relevant;
}

function safeProjectPath(cwd, file) {
  const root = path.resolve(cwd);
  const target = path.resolve(cwd, file);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Refusing to remove stale experiment path outside the project: ${file}`);
  }
  return target;
}

async function rollbackStale(cwd, changes) {
  const tracked = changes.filter((change) => change.status !== "??").map((change) => change.file);
  const untracked = changes.filter((change) => change.status === "??").map((change) => change.file);
  if (tracked.length) {
    const result = await git(cwd, ["restore", "--staged", "--worktree", "--", ...tracked]);
    if (result.code !== 0) throw new Error(`Could not roll back stale experiment: ${gitOutput(result)}`);
  }
  for (const file of untracked) await rm(safeProjectPath(cwd, file), { recursive: true, force: true });
}

async function ensureMemoryFiles(cwd) {
  const experiments = fullPath(cwd, EXPERIMENTS_PATH);
  if (!existsSync(experiments)) {
    await writeFile(experiments, "attempt\tstatus\tscore\tdelta\tcommit\tdescription\n");
  }
  const research = fullPath(cwd, RESEARCH_PATH);
  if (!existsSync(research)) {
    await writeFile(research, "# Research state\n\n## Current understanding\n\nNo durable findings yet.\n\n## Recent lessons\n\n");
  }
}

async function experimentRecord(cwd, attempt) {
  const filename = fullPath(cwd, EXPERIMENTS_PATH);
  if (!existsSync(filename)) return undefined;
  const line = (await readFile(filename, "utf8")).split(/\r?\n/)
    .find((candidate) => candidate.split("\t", 1)[0] === String(attempt));
  if (!line) return undefined;
  const columns = line.split("\t");
  return {
    status: columns[1],
    score: columns[2] === "" ? undefined : Number(columns[2]),
    commit: columns[4] || undefined,
    description: columns.slice(5).join("\t"),
  };
}

async function appendExperiment(cwd, row) {
  await ensureMemoryFiles(cwd);
  await appendFile(fullPath(cwd, EXPERIMENTS_PATH), [
    row.attempt,
    row.status,
    fmtScore(row.score),
    "",
    row.commit ?? "",
    cleanCell(row.description),
  ].join("\t") + "\n");
}

async function addRecentLesson(cwd, attempt, description) {
  await ensureMemoryFiles(cwd);
  const filename = fullPath(cwd, RESEARCH_PATH);
  const raw = await readFile(filename, "utf8");
  const marker = "## Recent lessons";
  const head = raw.split(marker)[0];
  const existing = raw.includes(marker)
    ? raw.split(marker)[1].split("\n").filter((line) => line.trim().startsWith("- ")).slice(-11)
    : [];
  if (!existing.some((line) => line.includes(`#${attempt} (aborted)`))) {
    existing.push(`- #${attempt} (aborted): ${cleanCell(description)}`);
  }
  await writeFile(filename, `${head.trimEnd()}\n\n${marker}\n\n${existing.join("\n")}\n`);
}

/**
 * Recover an iteration whose worker disappeared. This is intentionally done
 * by the outer loop, not by asking a replacement worker to guess whether it
 * is safe to edit the candidate. No evaluator or objective is changed here.
 */
export async function recoverStaleExperiment(cwd, state, config) {
  const iteration = state.iteration;
  if (!iteration) return false;

  const changes = await changedPaths(cwd);
  const relevant = assertSafeStaleChanges(changes, config);
  const record = await experimentRecord(cwd, iteration.id);
  await rollbackStale(cwd, relevant);

  if (!record) {
    await appendExperiment(cwd, {
      attempt: iteration.id,
      status: "aborted",
      score: iteration.lastScore,
      commit: iteration.baseCommit,
      description: "worker interrupted or stale; editable changes rolled back by the outer loop",
    });
    await addRecentLesson(cwd, iteration.id, "worker interrupted or became stale; the candidate was rolled back");
    state.nonImprovingCount = (state.nonImprovingCount ?? 0) + 1;
    state.supervisorRequired = true;
    state.supervisorReason = "previous worker was interrupted or became stale";
  } else if (record.status === "keep") {
    // research_record writes the experiment row before its final state write.
    // Recover that narrow crash window without turning an already committed
    // improvement into an aborted experiment.
    if (record.score !== undefined && Number.isFinite(record.score)) state.bestScore = record.score;
    if (record.commit) state.bestCommit = record.commit;
    state.keepCount = (state.keepCount ?? 0) + 1;
    state.nonImprovingCount = 0;
  } else {
    state.nonImprovingCount = (state.nonImprovingCount ?? 0) + 1;
    if (record.status === "aborted") {
      state.supervisorRequired = true;
      state.supervisorReason = "previous worker was interrupted or became stale";
    } else if (state.nonImprovingCount >= (config.supervisor?.stagnation_attempts ?? 5)) {
      state.supervisorRequired = true;
      state.supervisorReason = `${state.nonImprovingCount} consecutive completed experiments without improvement`;
    }
  }

  state.attemptCount = Math.max(state.attemptCount ?? 0, iteration.id);
  state.iteration = undefined;
  await writeState(cwd, state);
  return true;
}

function parseArgs(argv) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") return { help: true };
  if (argv[0] !== "run") {
    throw new Error("Usage: pi-autoresearch run [--cwd <directory>] [--pi-command <command>]");
  }
  let cwd = process.cwd();
  let piCommand = process.env.PI_AUTORESEARCH_PI_COMMAND || process.env.PI_AUTORESEARCH_PI || DEFAULT_PI_COMMAND;
  let model = process.env.PI_AUTORESEARCH_MODEL;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--cwd") {
      const value = argv[++i];
      if (!value) throw new Error("--cwd requires a directory");
      cwd = path.resolve(value);
    } else if (arg === "--pi-command") {
      piCommand = argv[++i] ?? "";
    } else if (arg === "--model") {
      model = argv[++i] ?? "";
    } else if (arg === "--help" || arg === "-h") {
      return { help: true };
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!piCommand) throw new Error("--pi-command cannot be empty");
  if (model === "") throw new Error("--model cannot be empty");
  return { cwd, piCommand, model };
}

function printHelp() {
  console.log(`Usage: pi-autoresearch run [options]

Run fresh, one-experiment pi workers forever. Stop with Ctrl-C or SIGTERM.

Options:
  --cwd <directory>       Research project (default: current directory)
  --pi-command <command>  pi executable (default: pi; also PI_AUTORESEARCH_PI_COMMAND)
  --model <pattern>       model passed to pi (also PI_AUTORESEARCH_MODEL)
  -h, --help              Show this help

Each worker is launched as: <command> --no-session [--model <pattern>] --print <one-experiment prompt>`);
}

function runWorker({ cwd, piCommand, model, onChild }) {
  return new Promise((resolve) => {
    const piArgs = ["--no-session"];
    if (model) piArgs.push("--model", model);
    piArgs.push("--print", WORKER_PROMPT);
    const child = spawn(piCommand, piArgs, {
      cwd,
      env: process.env,
      stdio: "inherit",
    });
    onChild(child);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      onChild(null);
      resolve(result);
    };
    child.on("error", (error) => finish({ code: 127, signal: null, error }));
    child.on("close", (code, signal) => finish({ code: code ?? 1, signal, error: null }));
  });
}

function stateProgressed(before, after) {
  const beforeAttempts = Number(before.attemptCount ?? 0);
  const afterAttempts = Number(after.attemptCount ?? 0);
  return afterAttempts === beforeAttempts + 1 && !after.iteration;
}

/** Run the indefinitely repeating outer loop. */
export async function runLoop(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const piCommand = options.piCommand ?? DEFAULT_PI_COMMAND;
  const model = options.model;
  await loadConfig(cwd);

  let stopping = false;
  let activeChild = null;
  let forwardedSignal = null;
  const onSignal = (signal) => {
    if (stopping && activeChild) {
      // A second Ctrl-C should still be able to stop a worker which ignores
      // the first signal, while the first one gets a chance to clean up.
      activeChild.kill("SIGKILL");
      return;
    }
    stopping = true;
    forwardedSignal = signal;
    if (activeChild) activeChild.kill(signal);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    while (!stopping) {
      const config = await loadConfig(cwd);
      let before = await readState(cwd);
      if (before.iteration) {
        await recoverStaleExperiment(cwd, before, config);
        if (stopping) break;
        before = await readState(cwd);
      }
      if (stopping) break;

      console.error(`Starting autoresearch experiment #${Number(before.attemptCount ?? 0) + 1}`);
      const result = await runWorker({
        cwd,
        piCommand,
        model,
        onChild: (child) => { activeChild = child; },
      });
      if (stopping) break;

      const after = await readState(cwd);
      if (after.iteration) {
        // A worker which disappeared after research_start owns a candidate.
        // Reconcile it before starting another worker; otherwise the next
        // worker could mistake the old candidate for its own experiment.
        console.error(`Worker exited before recording experiment #${after.iteration.id}; marking it aborted.`);
        await recoverStaleExperiment(cwd, after, config);
        continue;
      }
      if (!stateProgressed(before, after)) {
        throw new Error(
          `Worker exited without exactly one durable experiment: expected attemptCount ${Number(before.attemptCount ?? 0) + 1} and no active iteration, got ${Number(after.attemptCount ?? 0)}` +
          (result.error ? ` (${result.error.message})` : ""),
        );
      }
      if (result.code !== 0) {
        console.error(`Worker exited with code ${result.code}; its completed durable result will be retained.`);
      }
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }

  return forwardedSignal === "SIGTERM" ? 143 : forwardedSignal === "SIGINT" ? 130 : 0;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  return await runLoop(args);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
