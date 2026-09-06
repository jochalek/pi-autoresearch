import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import autoresearchExtension from "../extensions/research-loop.ts";

async function loadInProject(configured) {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-autoresearch-"));
  if (configured) {
    await mkdir(path.join(cwd, ".pi"));
    await writeFile(path.join(cwd, ".pi", "research.yaml"), "# test config\n");
  }

  const tools = [];
  const hooks = [];
  const api = {
    registerTool(tool) {
      tools.push(tool.name);
    },
    on(event) {
      hooks.push(event);
    },
  };
  const previousCwd = process.cwd();
  process.chdir(cwd);
  try {
    autoresearchExtension(api);
    return { tools, hooks };
  } finally {
    process.chdir(previousCwd);
    await rm(cwd, { recursive: true, force: true });
  }
}

test("does not register autoresearch tools or hooks without the project config", async () => {
  const registered = await loadInProject(false);
  assert.deepEqual(registered, { tools: [], hooks: [] });
});

test("registers the existing tools and hooks when opted in", async () => {
  const registered = await loadInProject(true);
  assert.deepEqual(registered.tools, [
    "research_status",
    "research_start",
    "research_evaluate",
    "research_record",
    "research_abort",
    "research_supervise",
  ]);
  assert.deepEqual(registered.hooks, ["tool_call", "tool_result"]);
});
