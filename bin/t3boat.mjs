#!/usr/bin/env node
// Runs the TypeScript sources directly (Node >= 23.6 strips types natively).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Load <repo>/.env (e.g. BOAT_API_KEY); variables already set in the environment win.
const envFile = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const args = process.argv.slice(2);
if (args.length > 0) await import("../src/cli.ts");
else await import("../src/index.ts");
