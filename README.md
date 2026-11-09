# t3boat

[`t3code-boat` on npm](https://www.npmjs.com/package/t3code-boat)

MCP server that lets a [T3 Code](https://github.com/pingdotgg/t3code) orchestrator thread boot a
[boat.dev](https://boat.dev) sandbox, use it as a linked T3 Code **environment** for subagents, and delete it
automatically when the work is done. Built on T3 Code's peer links (the *Linked environments* beta).

```
orchestrator thread ──boat_sandbox_create──▶ t3boat ──boat API──▶ VM: t3.codes/install.sh (same version) + claude/codex
                                                    │                 t3 serve :3773 → public HTTPS (boat host)
                                                    │                 git clone <repo> + t3 project add
                                                    └─local t3 CLI──▶ t3 environment link <url> --pairing-code …
orchestrator ──delegate_task(target.environmentId)──▶ thread runs on the VM, wakes the parent when done
t3boat reaper (every 60 s) ──t3 thread list on VM──▶ idle ≥ idleMinutes → t3 environment unlink + boat DELETE
```

The link is one-way: your machine holds a token for the sandbox, the sandbox gets nothing for your machine.

## Quick start

Requires Node ≥ 22.16 and T3 Code 0.1.7 or later.

1. **Turn on Linked environments** in T3 Code: *Settings → Labs → Linked environments*. t3boat turns it on in
   each sandbox itself.
2. **Get a boat API key**: `boat api-key create t3boat --preset ci`, or create one in the boat dashboard.
   Sandbox creation needs a paid boat plan or the free trial.
3. **Add the MCP server** to the provider your orchestrator threads use:

   ```bash
   # Claude Code
   claude mcp add t3boat --scope user -e BOAT_API_KEY=boat_… -- npx -y t3code-boat
   # Codex
   codex mcp add t3boat --env BOAT_API_KEY=boat_… -- npx -y t3code-boat
   ```

   Or in an MCP JSON config (`.mcp.json`, `~/.claude.json`, …):

   ```json
   {
     "mcpServers": {
       "t3boat": {
         "command": "npx",
         "args": ["-y", "t3code-boat"],
         "env": { "BOAT_API_KEY": "boat_…" }
       }
     }
   }
   ```

4. **Check the setup**: `BOAT_API_KEY=boat_… npx t3code-boat doctor` reports your `t3` CLI and version, whether linked
   environments are on, and whether the boat key works.
5. **Ask an orchestrator thread** to run something on a sandbox, e.g. *"Boot a boat sandbox and delegate the test
   fixes to it."* The server's instructions tell the agent the flow.

### Credentials on the sandbox

By default a sandbox gets what your boat environment holds: the Claude/ChatGPT logins from boat's
*Agents & Proxying* page, and your GitHub connection for cloning private repos. Agents on the sandbox can use those.
To pass something extra, list local env vars in `T3BOAT_FORWARD_ENV`, for example
`T3BOAT_FORWARD_ENV=CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token` makes a subscription token).

## Tools

| Tool | What it does |
| - | - |
| `boat_sandbox_create` | Boots and links a sandbox. Returns `environmentId` and `projectId` for `delegate_task`'s `target`. 1–4 min. |
| `boat_sandbox_list` | Managed sandboxes, their remote threads and statuses. |
| `boat_sandbox_destroy` | Unlink + permanently delete now. |
| `boat_sandbox_configure` | Change `keepAlive` / `idleMinutes`. |
| `boat_sandbox_exec` | Run a shell command on the VM (debugging). |

## Agent skill

The package ships an [Agent Skill](skills/orchestrate-boat-sandboxes/SKILL.md) for the orchestrator, published with
[TanStack Intent](https://tanstack.com/intent/latest). The MCP server already sends a short form of it to every
client. To also load the full skill in a project, install the package there and let Intent wire it up:

```bash
npm i -D t3code-boat
npx @tanstack/intent@latest install
```

## Cleanup policy

- **Idle reaper**: once a thread has run on the VM and no thread is busy (`preparing/queued/starting/running/waiting`)
  for `idleMinutes` (default 10), the environment is unlinked and the sandbox deleted. A sandbox where no thread
  ever started is reaped after `3 × idleMinutes`. A thread waiting on a question or approval counts as busy.
- **Hard TTL**: boat auto-stops after `ttlMinutes` (default 120) even if t3boat is gone; the next reaper run deletes it.
- **Crash-safe**: state lives in `~/.t3boat/state.json`; a restarted server keeps reaping. Sandboxes carry the boat
  label `t3boat=1`; `boat_sandbox_list` reports labelled sandboxes it doesn't track.
- Order is unlink → delete, so T3's remote-delegation follower stops instead of retrying a dead peer.

## Configuration

| Env var | Default |
| - | - |
| `BOAT_API_KEY` | required |
| `BOAT_API_BASE` | `https://boat.dev/api/v1` |
| `T3BOAT_T3_VERSION` | local `t3 --version`, so both ends match (installed with `t3.codes/install.sh`) |
| `T3BOAT_T3_CLI` / `T3BOAT_T3_HOME` | `t3` on PATH, else `~/.t3/bin/t3` (desktop app shim) / the CLI's default `~/.t3` (`T3CODE_HOME`) |
| `T3BOAT_FORWARD_ENV` | comma-separated local env vars to inject into each sandbox |
| `T3BOAT_REAP_INTERVAL_SECONDS` | `60` |
| `T3BOAT_STATE_DIR` | `~/.t3boat` |
| `T3BOAT_SKIP_LINK` | `1` = provision + pair the VM but don't link it locally (testing) |
| `T3BOAT_KEEP_FAILED` | `1` = keep a sandbox whose setup failed, for debugging (the reaper still deletes it) |

## CLI

`npx t3code-boat` with no arguments starts the MCP server on stdio (installed globally, the command is also available as `t3boat`). With arguments it is a CLI over the same operations:

```
npx t3code-boat create [--repo <url|none>] [--ref main] [--idle 10] [--ttl 120] [--access full-access]
npx t3code-boat list | destroy <id> | exec <id> <cmd> | reap | doctor
```

The idle reaper runs inside the MCP server. Sandboxes made with the CLI while no server runs are only stopped by
boat's TTL; run `npx t3code-boat reap` (or start the server) to delete them and drop their links.

## Known limits

This is a proof of concept.

- `ttlMinutes` is a hard limit, also for a task waiting on input. It is not extended while work is in progress.
- Idle sandboxes are deleted, not stopped: there is no resume or reuse, so a follow-up sent after cleanup is lost.
  A task that ends its turn with a question counts as idle.
- The idle check lists each project's threads, not their child threads.
- `delegate_task` to a remote environment does not support `isolation: "worktree"`; pass `target.model` if the VM
  lacks the provider instance you use locally.
- The T3 server is reachable on a public boat URL. It still needs OAuth (pairing code, 10 min, one-time) for access.
- `t3 environment link` writes your live `~/.t3` database (that's how T3 links without the UI).

## Development

```bash
git clone https://github.com/trevize-dev/t3boat && cd t3boat && npm install
echo 'BOAT_API_KEY=boat_…' > .env   # loaded automatically from a checkout
node bin/t3boat.mjs doctor           # a checkout runs src/ directly (Node ≥ 23.6)
npm run typecheck && npm run build
npm exec -- intent maintainer check  # validates the agent skill
```

Release: `npm publish` (runs typecheck and build first).
