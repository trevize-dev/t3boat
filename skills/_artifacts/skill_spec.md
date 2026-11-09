# t3boat skill spec

t3boat ships one skill for the agent that uses it: an orchestrator thread in T3 Code that
delegates work to boat.dev sandboxes. Maintainer-facing setup (API keys, MCP config) lives
in the README, not in skills.

## Coverage and batch history

- **0.1.0, batch 1.** Registered `orchestrate-boat-sandboxes` in `.` (domain
  `orchestration`). Developer tasks: boot a sandbox and delegate a task to it; run several
  tasks in parallel on one sandbox; clean up a sandbox when the work is done.

## Decisions

- **One skill.** The tool surface is five MCP tools with one lifecycle; splitting it would
  repeat the same constraints across files.
- **The skill and the MCP `instructions` field say the same things.** The MCP field
  reaches every client without installing anything; the skill is the longer form for
  agents that load Intent skills. Change both together (`src/index.ts`).
- **Untrusted remote output is CRITICAL.** Sandbox agents run arbitrary code with the
  boat account's credentials, and their results flow into the local orchestrator.

## Source evidence

- Lifecycle, idle and TTL defaults, `projectId` capture: `src/sandboxes.ts`.
- Tool names, parameters and descriptions: `src/index.ts`.
- Busy statuses (`running`, `waiting`, …) and the server log path: `src/bootstrap.ts`.
- `isolation: "worktree"` rejection, project matching by repository and `target.projectId`:
  T3 Code `apps/server/src/peer/RemoteDelegation.ts` and `docs/user/remote-access.md`
  (pingdotgg/t3code, 0.1.7).

## Remaining work

- Executable task checks: needs a boat account and a T3 Code with linked environments in CI.
- Revisit when sleep/resume or lifetime extension is added (see README known limits).
