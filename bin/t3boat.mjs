#!/usr/bin/env node
// `t3boat` with no arguments starts the MCP server (stdio); with arguments it is the CLI.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);

// A checkout's .env (e.g. BOAT_API_KEY) is loaded for local development; variables
// already in the environment win. The published package ships no .env.
const envFile = fileURLToPath(new URL(".env", root));
if (existsSync(envFile)) process.loadEnvFile(envFile);

// A checkout runs the TypeScript sources directly (Node >= 23.6 strips types outside
// node_modules); the published package ships only the compiled dist/.
const fromSource = existsSync(fileURLToPath(new URL("src/index.ts", root)));
const dir = fromSource ? "src" : "dist";
const ext = fromSource ? "ts" : "js";
const entry = process.argv.length > 2 ? "cli" : "index";
await import(new URL(`${dir}/${entry}.${ext}`, root).href);
