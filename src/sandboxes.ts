// Lifecycle of boat sandboxes that act as linked T3 Code environments:
// create → install → serve → host → pair → link, and unlink → delete.
// State is persisted so a restarted MCP server still reaps what it started.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BoatClient } from "./boat.ts";
import {
  BUSY_STATUSES,
  SCRIPT_DIR,
  T3_PORT,
  envFile,
  healthCommand,
  installScript,
  pairingCommand,
  projectSetupCommand,
  shellQuote,
  startServerCommand,
  threadListCommand,
} from "./bootstrap.ts";
import { type LinkAccess, LocalT3 } from "./t3local.ts";

export type Phase = "creating" | "installing" | "starting" | "linking" | "ready" | "destroying" | "failed";

export interface ManagedSandbox {
  sandboxId: string;
  name: string;
  phase: Phase;
  createdAt: string;
  url?: string;
  environmentId?: string;
  repo?: string;
  workspacePath?: string;
  access: LinkAccess;
  idleMinutes: number;
  ttlMinutes: number;
  keepAlive: boolean;
  lastBusyAt?: string;
  sawThread: boolean;
  error?: string;
  threads?: { threadId: string; title?: string; status: string }[];
}

export interface CreateOptions {
  repo?: string;
  ref?: string;
  name?: string;
  ttlMinutes?: number;
  idleMinutes?: number;
  access?: LinkAccess;
  size?: "small" | "medium" | "large";
  boatEnvironment?: string;
  env?: Record<string, string>;
  keepAlive?: boolean;
}

type Progress = (message: string) => void;

const LABEL = "t3boat";
/** Test switch: provision the VM and create a pairing code, but don't link it locally. */
const skipLink = process.env.T3BOAT_SKIP_LINK === "1";
const stateDir = process.env.T3BOAT_STATE_DIR ?? join(homedir(), ".t3boat");
const stateFile = join(stateDir, "state.json");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const minutesSince = (iso: string) => (Date.now() - Date.parse(iso)) / 60_000;

/** Repo URL → directory name, e.g. git@github.com:a/b.git → b */
const repoDirName = (repo: string) =>
  repo.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop() || "workspace";

export class SandboxManager {
  readonly boat: BoatClient;
  readonly t3 = new LocalT3();
  private sandboxes = new Map<string, ManagedSandbox>();
  private reaping = false;

  constructor(boat: BoatClient) {
    this.boat = boat;
    try {
      const saved: ManagedSandbox[] = JSON.parse(readFileSync(stateFile, "utf8"));
      for (const s of saved) this.sandboxes.set(s.sandboxId, s);
    } catch {
      // first run
    }
  }

  private save() {
    mkdirSync(stateDir, { recursive: true });
    const tmp = `${stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.sandboxes.values()], null, 2));
    renameSync(tmp, stateFile);
  }

  update(s: ManagedSandbox, patch: Partial<ManagedSandbox>) {
    Object.assign(s, patch);
    this.save();
  }

  list(): ManagedSandbox[] {
    return [...this.sandboxes.values()];
  }

  find(idOrEnv: string): ManagedSandbox | undefined {
    return (
      this.sandboxes.get(idOrEnv) ??
      this.list().find((s) => s.environmentId === idOrEnv || s.name === idOrEnv)
    );
  }

  async preflight(): Promise<void> {
    if (!skipLink && !this.t3.linkedEnvironmentsEnabled()) {
      throw new Error(
        `Linked environments are off in ${this.t3.home}/userdata/settings.json. ` +
          `Turn on the Linked environments beta in T3 Code settings ("linkedEnvironmentsEnabled": true) and retry.`,
      );
    }
  }

  async create(opts: CreateOptions, progress: Progress = () => {}): Promise<ManagedSandbox> {
    await this.preflight();
    // Match the local client's version so both ends speak the same protocol.
    const t3Version = process.env.T3BOAT_T3_VERSION ?? (await this.t3.version());
    const ttlMinutes = opts.ttlMinutes ?? 120;
    const name = opts.name ?? `t3boat-${randomUUID().slice(0, 8)}`;

    progress(`creating boat sandbox ${name}`);
    const forwarded = Object.fromEntries(
      (process.env.T3BOAT_FORWARD_ENV ?? "")
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k && process.env[k])
        .map((k) => [k, process.env[k]!]),
    );
    const env = { ...forwarded, ...opts.env };
    const created = await this.boat.createSandbox({
      name,
      ttlSeconds: ttlMinutes * 60,
      labels: { [LABEL]: "1", t3boatName: name },
      idempotencyKey: randomUUID(),
      ...(Object.keys(env).length ? { env } : {}),
      ...(opts.size ? { type: opts.size } : {}),
      ...(opts.boatEnvironment ? { environment: opts.boatEnvironment } : {}),
    });

    const s: ManagedSandbox = {
      sandboxId: created.id,
      name,
      phase: "creating",
      createdAt: new Date().toISOString(),
      repo: opts.repo,
      access: opts.access ?? "full-access",
      idleMinutes: opts.idleMinutes ?? 10,
      ttlMinutes,
      keepAlive: opts.keepAlive ?? false,
      sawThread: false,
    };
    this.sandboxes.set(s.sandboxId, s);
    this.save();

    try {
      await this.provision(s, { ...opts, env }, t3Version, progress);
      return s;
    } catch (e: any) {
      this.update(s, { phase: "failed", error: e.message });
      if (process.env.T3BOAT_KEEP_FAILED === "1") {
        progress(`setup failed, keeping sandbox ${s.sandboxId} for debugging (reaper deletes it later)`);
      } else {
        progress(`setup failed, deleting sandbox: ${e.message}`);
        await this.destroy(s.sandboxId).catch(() => {});
      }
      throw e;
    }
  }

  private async provision(
    s: ManagedSandbox,
    opts: CreateOptions,
    t3Version: string,
    progress: Progress,
  ): Promise<void> {
    const id = s.sandboxId;
    await this.boat.waitUntilReady(id);

    this.update(s, { phase: "installing" });
    progress(`installing t3 ${t3Version} and provider CLIs`);
    await this.boat.writeFile(id, `${SCRIPT_DIR}/install.sh`, installScript);
    if (opts.env && Object.keys(opts.env).length) {
      await this.boat.writeFile(id, `${SCRIPT_DIR}/env`, envFile(opts.env));
    }
    const install = await this.boat.exec(
      id,
      `bash ${SCRIPT_DIR}/install.sh ${shellQuote(t3Version)} 2>&1 | tail -40`,
      600,
    );
    if (install.exitCode !== 0 || !/install done/.test(install.stdout)) {
      throw new Error(`install failed:\n${install.stdout}${install.stderr}`);
    }

    this.update(s, { phase: "starting" });
    progress("starting t3 serve");
    await this.boat.execDetached(id, startServerCommand);
    await this.waitForHealth(id);

    if (opts.repo) {
      const dir = `/home/user/${repoDirName(opts.repo)}`;
      progress(`cloning ${opts.repo}`);
      const r = await this.boat.exec(id, projectSetupCommand(opts.repo, opts.ref, dir), 600);
      if (r.exitCode !== 0) throw new Error(`clone failed:\n${r.stdout}${r.stderr}`);
      this.update(s, { workspacePath: dir });
    }

    progress("exposing port");
    const url = new URL(await this.boat.host(id, T3_PORT, "T3 Code")).origin;
    this.update(s, { url, phase: "linking" });

    progress("pairing with local T3 Code");
    const pairing = await this.boat.exec(id, pairingCommand(`t3boat ${s.name}`), 60);
    const out = pairing.stdout;
    const code = (() => {
      try {
        return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)).credential as string | undefined;
      } catch {
        return undefined;
      }
    })();
    if (!code) throw new Error(`could not create pairing code:\n${pairing.stdout}${pairing.stderr}`);
    if (skipLink) {
      this.update(s, { phase: "ready" });
      progress("T3BOAT_SKIP_LINK=1: pairing code created, not linking");
      return;
    }
    const linked = await this.linkWithRetry(url, code, s.access);
    this.update(s, { environmentId: linked.environmentId, phase: "ready" });
    progress(`ready as environment ${linked.environmentId}`);
  }

  private async waitForHealth(id: string, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await this.boat.exec(id, healthCommand, 15).catch(() => undefined);
      if (r?.exitCode === 0) return;
      if (Date.now() > deadline) {
        const log = await this.boat.exec(id, "tail -40 ~/.t3boat/serve.log", 15).catch(() => undefined);
        throw new Error(`t3 serve did not come up:\n${log?.stdout ?? ""}`);
      }
      await sleep(2_000);
    }
  }

  /** The hosted URL can take a few seconds to route after `POST /host`. */
  private async linkWithRetry(url: string, code: string, access: LinkAccess) {
    let last: unknown;
    for (let i = 0; i < 5; i++) {
      try {
        return await this.t3.link(url, code, access);
      } catch (e: any) {
        last = e;
        // A refused/consumed pairing code will not succeed on retry.
        if (/pairing|scope|denied|disabled|refus/i.test(e.message)) throw e;
        await sleep(3_000 * (i + 1));
      }
    }
    throw last;
  }

  /** Unlinks locally first (so delegation followers stop), then deletes the sandbox. */
  async destroy(idOrEnv: string): Promise<ManagedSandbox> {
    const s = this.find(idOrEnv);
    if (!s) throw new Error(`no managed sandbox ${idOrEnv}`);
    this.update(s, { phase: "destroying" });
    if (s.environmentId) await this.t3.unlink(s.environmentId);
    await this.boat.deleteSandbox(s.sandboxId);
    this.sandboxes.delete(s.sandboxId);
    this.save();
    return s;
  }

  async exec(idOrEnv: string, command: string, timeoutSeconds = 60) {
    const s = this.find(idOrEnv);
    if (!s) throw new Error(`no managed sandbox ${idOrEnv}`);
    return this.boat.exec(s.sandboxId, command, timeoutSeconds);
  }

  /** Reads thread statuses on the VM and records activity. */
  async refresh(s: ManagedSandbox): Promise<void> {
    const r = await this.boat.exec(s.sandboxId, threadListCommand, 30);
    if (r.exitCode !== 0) throw new Error(r.stderr || r.stdout);
    const rows: any[] = JSON.parse(r.stdout || "[]");
    const threads = rows.map((t) => ({ threadId: t.threadId, title: t.title, status: String(t.status) }));
    const busy = threads.some((t) => BUSY_STATUSES.has(t.status));
    this.update(s, {
      threads,
      sawThread: s.sawThread || threads.length > 0,
      ...(busy ? { lastBusyAt: new Date().toISOString() } : {}),
    });
  }

  /**
   * Auto-cleanup. A ready sandbox is destroyed when:
   *  - it ran at least one thread, none is busy now, and the last activity was idleMinutes ago; or
   *  - no thread ever started within idleMinutes * 3 of becoming ready (forgotten sandbox).
   * Sandboxes that failed or were abandoned mid-setup are deleted too. boat's own TTL is the backstop.
   */
  async reap(log: (msg: string) => void = () => {}): Promise<void> {
    if (this.reaping) return;
    this.reaping = true;
    try {
      for (const s of this.list()) {
        try {
          if (s.phase === "failed" || s.phase === "destroying") {
            await this.destroy(s.sandboxId);
            log(`reaped ${s.name} (${s.phase})`);
            continue;
          }
          if (s.phase !== "ready") {
            if (minutesSince(s.createdAt) > 30) {
              await this.destroy(s.sandboxId);
              log(`reaped ${s.name} (stuck in ${s.phase})`);
            }
            continue;
          }
          const boatState = await this.boat.getSandbox(s.sandboxId).then((b) => b.state).catch((e) => (e.status === 404 ? "gone" : "unknown"));
          if (boatState === "gone" || boatState === "archived" || boatState === "archiving") {
            await this.destroy(s.sandboxId);
            log(`reaped ${s.name} (boat state ${boatState}, probably TTL)`);
            continue;
          }
          if (s.keepAlive) continue;
          await this.refresh(s);
          const busy = s.threads?.some((t) => BUSY_STATUSES.has(t.status));
          if (busy) continue;
          const idleFor = minutesSince(s.lastBusyAt ?? s.createdAt);
          const limit = s.sawThread ? s.idleMinutes : s.idleMinutes * 3;
          if (idleFor >= limit) {
            await this.destroy(s.sandboxId);
            log(`reaped ${s.name}: idle ${idleFor.toFixed(1)} min`);
          }
        } catch (e: any) {
          log(`reap check failed for ${s.name}: ${e.message}`);
        }
      }
    } finally {
      this.reaping = false;
    }
  }

  /** Sandboxes carrying our label that this state file does not know (e.g. lost state). */
  async orphans(): Promise<string[]> {
    const live = await this.boat.listSandboxes(`${LABEL}=1`);
    return live.filter((b) => !this.sandboxes.has(b.id) && b.state !== "archived").map((b) => b.id);
  }
}
