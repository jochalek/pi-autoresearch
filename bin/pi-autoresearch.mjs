#!/usr/bin/env node
import { main } from "../cli/run-loop.mjs";

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
