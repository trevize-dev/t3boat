// Wrappers around the local T3 Code CLI (`t3`), used to link and unlink peers.
// Works with the standalone `t3` install and the desktop app's `t3` shim.
// `t3 environment link` writes the local database directly, so the running
// desktop server picks a new link up without a restart.

import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type LinkAccess = "read-only" | "approval-required" | "auto-accept-edits" | "auto" | "full-access";

export interface LinkedEnvironment {
  environmentId: string;
  label?: string;
  url?: string;
  [key: string]: unknown;
}

/** `t3` on PATH (standalone install or the desktop app's shim), else the desktop shim in ~/.t3/bin. */
function findCli(): string {
  try {
    const onPath = execFileSync("sh", ["-c", "command -v t3"], { encoding: "utf8" }).trim();
    if (onPath) return onPath;
  } catch {
    // not on PATH
  }
  const shim = join(homedir(), ".t3", "bin", "t3");
  return existsSync(shim) ? shim : "t3";
}

export class LocalT3 {
  readonly cli: string;
  readonly home: string;

  /** Explicit --base-dir only when the user chose one; otherwise the CLI's own default (~/.t3). */
  private readonly baseDirArgs: string[];

  constructor() {
    this.cli = process.env.T3BOAT_T3_CLI ?? findCli();
    const explicit = process.env.T3BOAT_T3_HOME ?? process.env.T3CODE_HOME;
    this.home = explicit ?? join(homedir(), ".t3");
    this.baseDirArgs = explicit ? ["--base-dir", explicit] : [];
  }

  private async t3(args: string[], timeoutMs = 90_000): Promise<string> {
    try {
      const { stdout } = await run(this.cli, [...args, ...this.baseDirArgs], {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout;
    } catch (e: any) {
      const detail = (e.stderr || e.stdout || e.message || "").toString().trim();
      throw new Error(`\`t3 ${args.slice(0, 2).join(" ")}\` failed: ${detail}`);
    }
  }

  async version(): Promise<string> {
    const { stdout } = await run(this.cli, ["--version"], { timeout: 30_000 });
    const m = stdout.match(/v?(\d+\.\d+\.\d+)/);
    if (!m) throw new Error(`cannot parse t3 version from "${stdout.trim()}"`);
    return m[1];
  }

  /** Peer links are gated by the `linkedEnvironmentsEnabled` setting on both sides. */
  linkedEnvironmentsEnabled(): boolean {
    try {
      const settings = JSON.parse(readFileSync(join(this.home, "userdata", "settings.json"), "utf8"));
      return settings.linkedEnvironmentsEnabled === true;
    } catch {
      return false;
    }
  }

  async link(url: string, pairingCode: string, access: LinkAccess): Promise<LinkedEnvironment> {
    const out = await this.t3(["environment", "link", url, "--pairing-code", pairingCode, "--access", access]);
    // "Linked <label> (<environmentId>) with <access> access, until <iso>."
    const m = out.match(/Linked (.*) \(([^)\s]+)\) with/);
    const listed = await this.list().catch(() => []);
    const byId = m ? listed.find((l) => l.environmentId === m[2]) : undefined;
    const byUrl = listed.find((l) => JSON.stringify(l).includes(new URL(url).host));
    const found = byId ?? byUrl;
    if (found) return found;
    if (m) return { environmentId: m[2], label: m[1], url };
    throw new Error(`linked, but could not read the environment id from: ${out.trim()}`);
  }

  async list(): Promise<LinkedEnvironment[]> {
    const out = await this.t3(["environment", "list", "--json"]);
    const parsed = JSON.parse(out || "[]");
    const rows: any[] = Array.isArray(parsed) ? parsed : (parsed.links ?? parsed.environments ?? []);
    return rows.map((r) => ({ ...r, environmentId: r.environmentId ?? r.id }));
  }

  async unlink(environmentId: string): Promise<void> {
    try {
      await this.t3(["environment", "unlink", environmentId]);
    } catch (e: any) {
      if (/not.?found|unknown|no such/i.test(e.message)) return;
      throw e;
    }
  }
}
