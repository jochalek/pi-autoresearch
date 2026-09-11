import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { minimatch } from "minimatch";
import { parse as parseYaml } from "yaml";
import {
  appendFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

interface ResearchConfig {
  goal: string;
  editable: string[];
  protected?: string[];
  validate?: { command: string };
  evaluate: {
    command: string;
    score_regex?: string;
    direction: "minimize" | "maximize";
  };
  knowledge?: { paths?: string[]; optional?: boolean };
  supervisor?: {
    stagnation_attempts?: number;
    watchdog?: {
      soft_tool_calls?: number;
      hard_tool_calls?: number;
      max_failed_tools?: number;
      max_repeated_bash?: number;
    };
  };
}

interface IterationState {
  id: number;
  hypothesis: string;
  expectedPath: string;
  baseCommit: string;
  startedAt: string;
  toolCalls: number;
  failedTools: number;
  repeatedBash: Record<string, number>;
  softWarned: boolean;
  hardStopped: boolean;
  lastScore?: number;
  validationPassed?: boolean;
  evaluationOutput?: string;
}

interface ResearchState {
  version: 1;
  attemptCount: number;
  keepCount: number;
  nonImprovingCount: number;
  bestScore?: number;
  bestCommit?: string;
  supervisorRequired: boolean;
  supervisorReason?: string;
  iteration?: IterationState;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const CONFIG_PATH = ".pi/research.yaml";
const STATE_PATH = ".pi/research-state.json";
const EXPERIMENTS_PATH = "experiments.tsv";
const RESEARCH_PATH = "research.md";
const META_PATHS = new Set([STATE_PATH, EXPERIMENTS_PATH, RESEARCH_PATH]);

function nowIso(): string {
  return new Date().toISOString();
}

function cleanCell(value: string | number | undefined): string {
  return String(value ?? "").replace(/[\t\r\n]+/g, " ").trim();
}

function fmtScore(value: number | undefined): string {
  return value === undefined ? "" : Number.isInteger(value) ? String(value) : value.toPrecision(8).replace(/0+$/, "").replace(/\.$/, "");
}

function outputText(result: RunResult): string {
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
}

async function runShell(cwd: string, command: string, signal?: AbortSignal): Promise<RunResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-lc", command], {
      cwd,
      signal,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function loadConfig(cwd: string): Promise<ResearchConfig> {
  const full = path.join(cwd, CONFIG_PATH);
  if (!existsSync(full)) {
    throw new Error(`Missing ${CONFIG_PATH}. Copy the package example and customize it for this project.`);
  }
  const raw = await readFile(full, "utf8");
  const cfg = parseYaml(raw) as Partial<ResearchConfig>;
  if (!cfg.goal || !Array.isArray(cfg.editable) || cfg.editable.length === 0 || !cfg.evaluate?.command || !cfg.evaluate?.direction) {
    throw new Error(`${CONFIG_PATH} must define goal, editable[], evaluate.command, and evaluate.direction.`);
  }
  if (!['minimize', 'maximize'].includes(cfg.evaluate.direction)) {
    throw new Error(`evaluate.direction must be minimize or maximize.`);
  }
  return cfg as ResearchConfig;
}

async function loadState(cwd: string): Promise<ResearchState> {
  const full = path.join(cwd, STATE_PATH);
  if (!existsSync(full)) {
    return {
      version: 1,
      attemptCount: 0,
      keepCount: 0,
      nonImprovingCount: 0,
      supervisorRequired: false,
    };
  }
  return JSON.parse(await readFile(full, "utf8")) as ResearchState;
}

async function saveState(cwd: string, state: ResearchState): Promise<void> {
  await mkdir(path.dirname(path.join(cwd, STATE_PATH)), { recursive: true });
  await writeFile(path.join(cwd, STATE_PATH), `${JSON.stringify(state, null, 2)}\n`);
}

async function ensureMemoryFiles(cwd: string): Promise<void> {
  const experiments = path.join(cwd, EXPERIMENTS_PATH);
  if (!existsSync(experiments)) {
    await writeFile(experiments, "attempt\tstatus\tscore\tdelta\tcommit\tdescription\n");
  }
  const research = path.join(cwd, RESEARCH_PATH);
  if (!existsSync(research)) {
    await writeFile(
      research,
      "# Research state\n\n## Current understanding\n\nNo durable findings yet.\n\n## Recent lessons\n\n",
    );
  }
}

async function gitHead(cwd: string): Promise<string> {
  const r = await runShell(cwd, "git rev-parse HEAD");
  if (r.code !== 0) throw new Error("Autoresearch requires a Git repository with at least one commit.");
  return r.stdout.trim();
}

interface ChangedPath { status: string; file: string }

async function changedPaths(cwd: string): Promise<ChangedPath[]> {
  const r = await runShell(cwd, "git status --porcelain=v1 --untracked-files=all");
  if (r.code !== 0) throw new Error(outputText(r));
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2), file: line.slice(3).replace(/^\"|\"$/g, "") }));
}

function matchesAny(file: string, patterns: string[]): boolean {
  const normalized = file.replace(/\\/g, "/");
  return patterns.some((pattern) => minimatch(normalized, pattern, { dot: true, matchBase: false }));
}

function isMeta(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  return META_PATHS.has(normalized) || normalized.startsWith(`${STATE_PATH}.`);
}

async function assertIterationChangesAllowed(cwd: string, cfg: ResearchConfig): Promise<ChangedPath[]> {
  const changes = await changedPaths(cwd);
  const relevant = changes.filter((x) => !isMeta(x.file));
  const protectedHit = relevant.filter((x) => matchesAny(x.file, cfg.protected ?? []));
  if (protectedHit.length) {
    throw new Error(`Protected paths were modified: ${protectedHit.map((x) => x.file).join(", ")}`);
  }
  const outside = relevant.filter((x) => !matchesAny(x.file, cfg.editable));
  if (outside.length) {
    throw new Error(`Changes outside editable paths: ${outside.map((x) => x.file).join(", ")}`);
  }
  return relevant;
}

async function assertCleanStart(cwd: string): Promise<void> {
  const changes = (await changedPaths(cwd)).filter((x) => !isMeta(x.file));
  if (changes.length) {
    throw new Error(`Research requires a clean implementation worktree. Existing changes: ${changes.map((x) => x.file).join(", ")}`);
  }
}

async function rollbackEditable(cwd: string, cfg: ResearchConfig): Promise<void> {
  const changes = (await changedPaths(cwd)).filter((x) => !isMeta(x.file) && matchesAny(x.file, cfg.editable));
  if (!changes.length) return;
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const change of changes) {
    if (change.status === "??") untracked.push(change.file);
    else tracked.push(change.file);
  }
  if (tracked.length) {
    await runShell(cwd, `git restore --staged --worktree -- ${tracked.map(shellQuote).join(" ")}`);
  }
  for (const file of untracked) {
    const full = path.resolve(cwd, file);
    if (!full.startsWith(path.resolve(cwd) + path.sep)) continue;
    await rm(full, { recursive: true, force: true });
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function commitEditable(cwd: string, cfg: ResearchConfig, description: string): Promise<string> {
  const changes = await assertIterationChangesAllowed(cwd, cfg);
  if (changes.length === 0) return await gitHead(cwd);
  const files = changes.map((x) => x.file);
  let r = await runShell(cwd, `git add -- ${files.map(shellQuote).join(" ")}`);
  if (r.code !== 0) throw new Error(`git add failed: ${outputText(r)}`);
  r = await runShell(cwd, `git commit -m ${shellQuote(`research: ${description.slice(0, 64)}`)}`);
  if (r.code !== 0) throw new Error(`git commit failed: ${outputText(r)}`);
  return await gitHead(cwd);
}

function scoreImproved(score: number, best: number | undefined, direction: "minimize" | "maximize"): boolean {
  if (best === undefined) return true;
  return direction === "minimize" ? score < best : score > best;
}

function scoreDelta(score: number | undefined, best: number | undefined, direction: "minimize" | "maximize"): number | undefined {
  if (score === undefined || best === undefined) return undefined;
  return direction === "minimize" ? best - score : score - best;
}

function parseScore(output: string, cfg: ResearchConfig): number {
  if (cfg.evaluate.score_regex) {
    const re = new RegExp(cfg.evaluate.score_regex, "m");
    const m = output.match(re);
    if (!m?.[1]) throw new Error(`Evaluator output did not match score_regex: ${cfg.evaluate.score_regex}`);
    const value = Number(m[1]);
    if (!Number.isFinite(value)) throw new Error(`Parsed score is not finite: ${m[1]}`);
    return value;
  }
  const lines = output.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    const value = Number(line);
    if (Number.isFinite(value)) return value;
  }
  throw new Error("Could not parse evaluator score. Print a numeric final line or configure evaluate.score_regex.");
}

async function appendExperiment(
  cwd: string,
  row: { attempt: number; status: string; score?: number; delta?: number; commit?: string; description: string },
): Promise<void> {
  await ensureMemoryFiles(cwd);
  await appendFile(
    path.join(cwd, EXPERIMENTS_PATH),
    [row.attempt, row.status, fmtScore(row.score), fmtScore(row.delta), row.commit ?? "", cleanCell(row.description)].join("\t") + "\n",
  );
}

async function addRecentLesson(cwd: string, attempt: number, status: string, description: string): Promise<void> {
  await ensureMemoryFiles(cwd);
  const full = path.join(cwd, RESEARCH_PATH);
  const raw = await readFile(full, "utf8");
  const marker = "## Recent lessons";
  const [head] = raw.split(marker);
  const existing = raw.includes(marker)
    ? raw.split(marker)[1].split("\n").filter((x) => x.trim().startsWith("- ")).slice(-11)
    : [];
  existing.push(`- #${attempt} (${status}): ${cleanCell(description)}`);
  await writeFile(full, `${head.trimEnd()}\n\n${marker}\n\n${existing.join("\n")}\n`);
}

async function recentExperiments(cwd: string, limit = 8): Promise<string> {
  const full = path.join(cwd, EXPERIMENTS_PATH);
  if (!existsSync(full)) return "(none yet)";
  const lines = (await readFile(full, "utf8")).trim().split("\n");
  return lines.slice(Math.max(1, lines.length - limit)).join("\n") || "(none yet)";
}

async function knowledgeSummary(cwd: string, cfg: ResearchConfig): Promise<string> {
  const paths = cfg.knowledge?.paths ?? [];
  if (!paths.length) return "(not configured)";
  const out: string[] = [];
  for (const p of paths) {
    const full = path.resolve(cwd, p);
    try {
      const s = await stat(full);
      out.push(`${p} (${s.isDirectory() ? "directory" : "file"})`);
    } catch {
      out.push(`${p} (missing)`);
    }
  }
  return out.join(", ");
}

function watchdogThresholds(cfg: ResearchConfig) {
  const w = cfg.supervisor?.watchdog ?? {};
  return {
    soft: w.soft_tool_calls ?? 45,
    hard: w.hard_tool_calls ?? 80,
    failed: w.max_failed_tools ?? 12,
    repeated: w.max_repeated_bash ?? 5,
  };
}

function tripReason(iter: IterationState, cfg: ResearchConfig): string | undefined {
  const w = watchdogThresholds(cfg);
  if (iter.toolCalls >= w.hard) return `hard tool-call budget reached (${iter.toolCalls}/${w.hard})`;
  if (iter.failedTools >= w.failed) return `failed-tool budget reached (${iter.failedTools}/${w.failed})`;
  const maxRepeat = Math.max(0, ...Object.values(iter.repeatedBash));
  if (maxRepeat >= w.repeated) return `same bash command repeated ${maxRepeat} times`;
  return undefined;
}

export default function autoresearchExtension(pi: ExtensionAPI) {
  // The contract is the explicit project-level opt-in. Check it while the
  // extension is loaded so disabled projects get neither tools nor hooks.
  if (!existsSync(path.join(process.cwd(), CONFIG_PATH))) return;

  pi.registerTool({
    name: "research_status",
    label: "Research Status",
    description: "Show the current autoresearch objective, best result, compact history, watchdog state, and optional knowledge paths.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      try {
        const cfg = await loadConfig(ctx.cwd);
        const state = await loadState(ctx.cwd);
        await ensureMemoryFiles(ctx.cwd);
        const iter = state.iteration;
        const text = [
          `Goal: ${cfg.goal}`,
          `Direction: ${cfg.evaluate.direction}`,
          `Best: ${state.bestScore === undefined ? "(none)" : `${fmtScore(state.bestScore)} @ ${state.bestCommit?.slice(0, 8) ?? "unknown"}`}`,
          `Attempts: ${state.attemptCount} | keeps: ${state.keepCount} | non-improving: ${state.nonImprovingCount}`,
          `Supervisor: ${state.supervisorRequired ? `REQUIRED — ${state.supervisorReason ?? "strategy review"}` : "not required"}`,
          `Iteration: ${iter ? `#${iter.id} ${iter.hypothesis} | tool calls ${iter.toolCalls} | failed ${iter.failedTools}${iter.hardStopped ? " | WATCHDOG STOPPED" : ""}` : "none active"}`,
          `Knowledge: ${await knowledgeSummary(ctx.cwd, cfg)}`,
          "",
          "Recent experiments:",
          await recentExperiments(ctx.cwd),
        ].join("\n");
        return { content: [{ type: "text", text }], details: { state } };
      } catch (error) {
        return { content: [{ type: "text", text: String(error) }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "research_start",
    label: "Start Research Iteration",
    description: "Start one bounded experiment with a hypothesis and expected path. Requires a clean implementation worktree.",
    parameters: Type.Object({
      hypothesis: Type.String({ minLength: 3 }),
      expected_path: Type.String({ minLength: 3, description: "Short expected sequence, e.g. implement -> validate -> benchmark" }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const cfg = await loadConfig(ctx.cwd);
        const state = await loadState(ctx.cwd);
        if (state.iteration) throw new Error(`Iteration #${state.iteration.id} is already active.`);
        if (state.supervisorRequired) throw new Error(`Strategy supervision is required before another iteration: ${state.supervisorReason ?? "stagnation"}. Call research_supervise.`);
        await assertCleanStart(ctx.cwd);
        const baseCommit = await gitHead(ctx.cwd);
        const id = state.attemptCount + 1;
        state.iteration = {
          id,
          hypothesis: params.hypothesis,
          expectedPath: params.expected_path,
          baseCommit,
          startedAt: nowIso(),
          toolCalls: 0,
          failedTools: 0,
          repeatedBash: {},
          softWarned: false,
          hardStopped: false,
        };
        await saveState(ctx.cwd, state);
        return {
          content: [{ type: "text", text: `Started experiment #${id}. Hypothesis: ${params.hypothesis}\nExpected path: ${params.expected_path}` }],
          details: { iteration: state.iteration, config: cfg },
        };
      } catch (error) {
        return { content: [{ type: "text", text: String(error) }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "research_evaluate",
    label: "Evaluate Research Candidate",
    description: "Validate and objectively score the current candidate using the fixed commands in .pi/research.yaml.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      try {
        const cfg = await loadConfig(ctx.cwd);
        const state = await loadState(ctx.cwd);
        const iter = state.iteration;
        if (!iter) throw new Error("No active research iteration. Call research_start first.");
        if (iter.hardStopped) throw new Error("The watchdog stopped this iteration. Abort it instead of continuing evaluation.");
        await assertIterationChangesAllowed(ctx.cwd, cfg);
        let validationOutput = "(no validation command configured)";
        if (cfg.validate?.command) {
          const validation = await runShell(ctx.cwd, cfg.validate.command, signal);
          validationOutput = outputText(validation);
          iter.validationPassed = validation.code === 0;
          if (validation.code !== 0) {
            iter.failedTools += 1;
            await saveState(ctx.cwd, state);
            return {
              content: [{ type: "text", text: `VALIDATION FAILED\n${validationOutput}` }],
              details: { validation },
              isError: true,
            };
          }
        } else {
          iter.validationPassed = true;
        }
        const evaluation = await runShell(ctx.cwd, cfg.evaluate.command, signal);
        if (evaluation.code !== 0) {
          iter.failedTools += 1;
          iter.evaluationOutput = outputText(evaluation);
          await saveState(ctx.cwd, state);
          return {
            content: [{ type: "text", text: `EVALUATOR FAILED\n${iter.evaluationOutput}` }],
            details: { evaluation },
            isError: true,
          };
        }
        const combined = outputText(evaluation);
        const score = parseScore(combined, cfg);
        iter.lastScore = score;
        iter.evaluationOutput = combined;
        await saveState(ctx.cwd, state);
        const delta = scoreDelta(score, state.bestScore, cfg.evaluate.direction);
        const improved = scoreImproved(score, state.bestScore, cfg.evaluate.direction);
        const text = [
          "VALIDATION PASSED",
          cfg.validate?.command ? validationOutput : "",
          "",
          `Score: ${fmtScore(score)}`,
          `Best: ${state.bestScore === undefined ? "(none)" : fmtScore(state.bestScore)}`,
          `Delta toward improvement: ${delta === undefined ? "n/a" : fmtScore(delta)}`,
          `Improved: ${improved ? "yes" : "no"}`,
        ].filter(Boolean).join("\n");
        return { content: [{ type: "text", text }], details: { score, delta, improved, evaluation } };
      } catch (error) {
        return { content: [{ type: "text", text: String(error) }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "research_record",
    label: "Record Research Result",
    description: "Record a completed iteration as keep, discard, crash, or aborted. Keeps commit objective improvements; other outcomes roll back editable changes.",
    parameters: Type.Object({
      status: Type.Union([Type.Literal("keep"), Type.Literal("discard"), Type.Literal("crash"), Type.Literal("aborted")]),
      description: Type.String({ minLength: 3, description: "One compact sentence describing the result/lesson." }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const cfg = await loadConfig(ctx.cwd);
        const state = await loadState(ctx.cwd);
        const iter = state.iteration;
        if (!iter) throw new Error("No active iteration to record.");
        const oldBest = state.bestScore;
        let commit = iter.baseCommit;
        let effectiveStatus = params.status;
        let delta = scoreDelta(iter.lastScore, oldBest, cfg.evaluate.direction);

        if (params.status === "keep") {
          if (!iter.validationPassed || iter.lastScore === undefined) {
            throw new Error("A keep requires a successful research_evaluate result.");
          }
          if (!scoreImproved(iter.lastScore, oldBest, cfg.evaluate.direction)) {
            throw new Error(`Score ${fmtScore(iter.lastScore)} does not improve best ${fmtScore(oldBest)}. Record discard instead.`);
          }
          commit = await commitEditable(ctx.cwd, cfg, params.description);
          state.bestScore = iter.lastScore;
          state.bestCommit = commit;
          state.keepCount += 1;
          state.nonImprovingCount = 0;
        } else {
          await assertIterationChangesAllowed(ctx.cwd, cfg);
          await rollbackEditable(ctx.cwd, cfg);
          state.nonImprovingCount += 1;
        }

        state.attemptCount = Math.max(state.attemptCount, iter.id);
        await appendExperiment(ctx.cwd, {
          attempt: iter.id,
          status: effectiveStatus,
          score: iter.lastScore,
          delta,
          commit,
          description: params.description,
        });
        await addRecentLesson(ctx.cwd, iter.id, effectiveStatus, params.description);
        state.iteration = undefined;

        const stagnation = cfg.supervisor?.stagnation_attempts ?? 5;
        if (state.nonImprovingCount >= stagnation) {
          state.supervisorRequired = true;
          state.supervisorReason = `${state.nonImprovingCount} consecutive completed experiments without improvement`;
        }
        if (effectiveStatus === "aborted") {
          state.supervisorRequired = true;
          state.supervisorReason = "iteration aborted after becoming unproductive";
        }
        await saveState(ctx.cwd, state);
        return {
          content: [{ type: "text", text: `Recorded #${iter.id} as ${effectiveStatus}${iter.lastScore === undefined ? "" : ` at ${fmtScore(iter.lastScore)}`}.${effectiveStatus === "keep" ? ` Accepted commit ${commit.slice(0, 8)}.` : " Editable changes rolled back."}${state.supervisorRequired ? `\nSUPERVISOR REQUIRED: ${state.supervisorReason}` : ""}` }],
          details: { state },
        };
      } catch (error) {
        return { content: [{ type: "text", text: String(error) }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "research_abort",
    label: "Abort Research Iteration",
    description: "Abort a pathological or over-budget iteration, record the lesson, and roll back editable changes to the accepted checkpoint.",
    parameters: Type.Object({
      description: Type.String({ minLength: 3, description: "What made the iteration unproductive and what was learned." }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const cfg = await loadConfig(ctx.cwd);
        const state = await loadState(ctx.cwd);
        const iter = state.iteration;
        if (!iter) throw new Error("No active iteration to abort.");
        await assertIterationChangesAllowed(ctx.cwd, cfg);
        await rollbackEditable(ctx.cwd, cfg);
        state.attemptCount = Math.max(state.attemptCount, iter.id);
        state.nonImprovingCount += 1;
        await appendExperiment(ctx.cwd, {
          attempt: iter.id,
          status: "aborted",
          score: iter.lastScore,
          delta: scoreDelta(iter.lastScore, state.bestScore, cfg.evaluate.direction),
          commit: iter.baseCommit,
          description: params.description,
        });
        await addRecentLesson(ctx.cwd, iter.id, "aborted", params.description);
        state.iteration = undefined;
        state.supervisorRequired = true;
        state.supervisorReason = "doom-loop watchdog / manual abort";
        await saveState(ctx.cwd, state);
        return { content: [{ type: "text", text: `Aborted experiment #${iter.id}, rolled back editable changes, and recorded the lesson. Call research_supervise before another experiment.` }], details: { state } };
      } catch (error) {
        return { content: [{ type: "text", text: String(error) }], details: {}, isError: true };
      }
    },
  });

  pi.registerTool({
    name: "research_supervise",
    label: "Research Supervisor",
    description: "Perform a strategy reset after stagnation or a doom-loop. Returns compact trajectory context and clears the supervisor gate for a new direction.",
    parameters: Type.Object({
      new_direction: Type.String({ minLength: 3, description: "The substantially different direction chosen after review." }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const cfg = await loadConfig(ctx.cwd);
        const state = await loadState(ctx.cwd);
        if (state.iteration) throw new Error("Abort or record the active iteration before strategy supervision.");
        const reason = state.supervisorReason ?? "manual strategy review";
        const history = await recentExperiments(ctx.cwd, 12);
        const research = existsSync(path.join(ctx.cwd, RESEARCH_PATH)) ? (await readFile(path.join(ctx.cwd, RESEARCH_PATH), "utf8")).slice(0, 6000) : "(none)";
        state.supervisorRequired = false;
        state.supervisorReason = undefined;
        state.nonImprovingCount = 0;
        await saveState(ctx.cwd, state);
        const text = [
          `STRATEGY RESET (${reason})`,
          `Chosen new direction: ${params.new_direction}`,
          "",
          "Before editing, use this trajectory to avoid minor variants of failed ideas. Inspect an earlier accepted commit or relevant /knowledge material when useful.",
          "",
          "Recent experiments:",
          history,
          "",
          "Current research.md:",
          research,
          "",
          `Knowledge: ${await knowledgeSummary(ctx.cwd, cfg)}`,
        ].join("\n");
        return { content: [{ type: "text", text }], details: { state, reason } };
      } catch (error) {
        return { content: [{ type: "text", text: String(error) }], details: {}, isError: true };
      }
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName.startsWith("research_")) return undefined;
    let cfg: ResearchConfig;
    let state: ResearchState;
    try {
      cfg = await loadConfig(ctx.cwd);
      state = await loadState(ctx.cwd);
    } catch {
      return undefined;
    }
    const iter = state.iteration;
    if (!iter) return undefined;

    iter.toolCalls += 1;
    if (event.toolName === "bash") {
      const command = String((event.input as { command?: unknown })?.command ?? "").trim();
      if (command) iter.repeatedBash[command] = (iter.repeatedBash[command] ?? 0) + 1;
    }

    const thresholds = watchdogThresholds(cfg);
    const reason = tripReason(iter, cfg);
    if (reason) {
      iter.hardStopped = true;
      state.supervisorRequired = true;
      state.supervisorReason = `doom-loop watchdog: ${reason}`;
      await saveState(ctx.cwd, state);
      return {
        block: true,
        reason: `AUTORESEARCH WATCHDOG STOP: ${reason}. Do not continue debugging this candidate. Call research_abort with the lesson learned, then research_supervise before a new experiment.`,
      };
    }

    if (!iter.softWarned && iter.toolCalls >= thresholds.soft) {
      iter.softWarned = true;
      await saveState(ctx.cwd, state);
      ctx.ui.notify(
        `Autoresearch warning: experiment #${iter.id} has used ${iter.toolCalls}/${thresholds.hard} tool calls without completion. Reach evaluation soon or abort.`,
        "warning",
      );
    } else {
      await saveState(ctx.cwd, state);
    }
    return undefined;
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName.startsWith("research_")) return undefined;
    let state: ResearchState;
    let cfg: ResearchConfig;
    try {
      state = await loadState(ctx.cwd);
      cfg = await loadConfig(ctx.cwd);
    } catch {
      return undefined;
    }
    const iter = state.iteration;
    if (!iter) return undefined;
    if ((event as { isError?: boolean }).isError) iter.failedTools += 1;
    const reason = tripReason(iter, cfg);
    if (reason) {
      iter.hardStopped = true;
      state.supervisorRequired = true;
      state.supervisorReason = `doom-loop watchdog: ${reason}`;
    }
    await saveState(ctx.cwd, state);
    return undefined;
  });
}
