// t3boat CLI: the same operations as the MCP tools, for testing and cron.
//   t3boat create [--repo <url|none>] [--ref <ref>] [--idle <min>] [--ttl <min>] [--access <mode>]
//   t3boat list | destroy <id> | exec <id> <command> | reap | doctor
import { parseArgs } from "node:util";
import { BoatClient } from "./boat.ts";
import { SandboxManager } from "./sandboxes.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: "string" },
    ref: { type: "string" },
    idle: { type: "string" },
    ttl: { type: "string" },
    access: { type: "string" },
    "keep-alive": { type: "boolean" },
  },
});
const [cmd, ...rest] = positionals;
const log = (m: string) => process.stderr.write(`[t3boat] ${m}\n`);
const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));

const apiKey = process.env.BOAT_API_KEY;
if (!apiKey) {
  log("BOAT_API_KEY is not set");
  process.exit(1);
}
const m = new SandboxManager(new BoatClient(apiKey, process.env.BOAT_API_BASE));

switch (cmd) {
  case "doctor": {
    const out: Record<string, unknown> = { t3Cli: m.t3.cli, t3Home: m.t3.home };
    out.t3Version = await m.t3.version().catch((e) => `error: ${e.message}`);
    out.linkedEnvironmentsEnabled = m.t3.linkedEnvironmentsEnabled();
    out.links = await m.t3.list().catch((e) => `error: ${e.message}`);
    out.boat = await m.boat.listSandboxes("t3boat=1").then((s) => `ok, ${s.length} labelled sandbox(es)`, (e) => `error: ${e.message}`);
    print(out);
    break;
  }
  case "create":
    print(
      await m.create(
        {
          repo: values.repo === "none" ? undefined : values.repo,
          ref: values.ref,
          idleMinutes: values.idle ? Number(values.idle) : undefined,
          ttlMinutes: values.ttl ? Number(values.ttl) : undefined,
          access: values.access as any,
          keepAlive: values["keep-alive"],
        },
        log,
      ),
    );
    break;
  case "list":
    await Promise.all(m.list().filter((s) => s.phase === "ready").map((s) => m.refresh(s).catch(() => {})));
    print({ sandboxes: m.list(), untracked: await m.orphans().catch(() => []) });
    break;
  case "destroy":
    print(await m.destroy(rest[0]!));
    break;
  case "exec":
    print(await m.exec(rest[0]!, rest.slice(1).join(" "), 600));
    break;
  case "reap":
    await m.reap(log);
    break;
  default:
    log("usage: t3boat create|list|destroy <id>|exec <id> <cmd>|reap|doctor");
    process.exit(2);
}
