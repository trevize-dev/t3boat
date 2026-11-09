# t3boat

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

## Tools

| Tool | What it does |
| - | - |
| `boat_sandbox_create` | Boots and links a sandbox. Returns `environmentId` for `delegate_task`'s `target.environmentId`. 1–4 min. |
| `boat_sandbox_list` | Managed sandboxes, their remote threads and statuses. |
| `boat_sandbox_destroy` | Unlink + permanently delete now. |
| `boat_sandbox_configure` | Change `keepAlive` / `idleMinutes`. |
| `boat_sandbox_exec` | Run a shell command on the VM (debugging). |

## Cleanup policy

- **Idle reaper**: once a thread has run on the VM and no thread is busy (`preparing/queued/starting/running/waiting`)
  for `idleMinutes` (default 10), the environment is unlinked and the sandbox deleted. A sandbox where no thread
  ever started is reaped after `3 × idleMinutes`.
- **Hard TTL**: boat auto-stops after `ttlMinutes` (default 120) even if t3boat is gone; the next reaper run deletes it.
- **Crash-safe**: state lives in `~/.t3boat/state.json`; a restarted server keeps reaping. Sandboxes carry the boat
  label `t3boat=1`; `boat_sandbox_list` reports labelled sandboxes it doesn't track.
- Order is unlink → delete, so T3's remote-delegation follower stops instead of retrying a dead peer.

## Setup

1. **boat API key**: `boat api-key create t3boat --preset ci` → `BOAT_API_KEY`.
2. **Provider credentials on the VM**: connect Claude/ChatGPT on boat's *Agents & Proxying* page (every sandbox
   gets them), or forward local env vars with `T3BOAT_FORWARD_ENV=CLAUDE_CODE_OAUTH_TOKEN,OPENAI_API_KEY`
   (`claude setup-token` makes a subscription token).
3. **Private repos**: connect GitHub in your boat environment so `git clone` works on the VM.
4. **Enable the Linked environments beta locally** in T3 Code settings (`"linkedEnvironmentsEnabled": true` in
   `~/.t3/userdata/settings.json`). t3boat turns it on in the VM itself.
5. Check: `BOAT_API_KEY=… node bin/t3boat.mjs doctor`.
6. Register the MCP server with your provider, e.g. Claude Code `~/.claude.json` / project `.mcp.json`:

```json
{
  "mcpServers": {
    "t3boat": {
      "command": "node",
      "args": ["/path/to/t3boat/bin/t3boat.mjs"],
      "env": { "BOAT_API_KEY": "boat_…", "T3BOAT_FORWARD_ENV": "CLAUDE_CODE_OAUTH_TOKEN" }
    }
  }
}
```

Requires Node ≥ 23.6 (runs the TypeScript directly).

```bash
git clone https://github.com/trevize-dev/t3boat && cd t3boat && npm install
echo 'BOAT_API_KEY=boat_…' > .env   # loaded automatically
```

## Configuration

| Env var | Default |
| - | - |
| `BOAT_API_KEY` | required |
| `BOAT_API_BASE` | `https://boat.dev/api/v1` |
| `T3BOAT_T3_VERSION` | local `t3 --version`, so both ends match (installed with `t3.codes/install.sh`) |
| `T3BOAT_SKIP_LINK` | `1` = provision + pair the VM but don't link it locally (testing) |
| `T3BOAT_KEEP_FAILED` | `1` = keep a sandbox whose setup failed, for debugging (the reaper still deletes it) |
| `T3BOAT_T3_CLI` / `T3BOAT_T3_HOME` | `t3` on PATH, else `~/.t3/bin/t3` (desktop app shim) / the CLI's default `~/.t3` (`T3CODE_HOME`) |
| `T3BOAT_FORWARD_ENV` | comma-separated local env vars to inject into each sandbox |
| `T3BOAT_REAP_INTERVAL_SECONDS` | `60` |
| `T3BOAT_STATE_DIR` | `~/.t3boat` |

## CLI

```
node bin/t3boat.mjs create [--repo <url|none>] [--ref main] [--idle 10] [--ttl 120] [--access full-access]
node bin/t3boat.mjs list | destroy <id> | exec <id> <cmd> | reap | doctor
```

The idle reaper runs inside the MCP server. Sandboxes made with the CLI while no server runs are only stopped by
boat's TTL; run `t3boat reap` (or start the server) to delete them and drop their links.

## Known limits

- Needs a T3 Code release with peer links (0.1.7+); the VM runs the same version as your local `t3`.
- `delegate_task` to a remote environment does not support `isolation: "worktree"`; pass `target.model` if the VM
  lacks the provider instance you use locally.
- The T3 server is reachable on a public boat URL. It still needs OAuth (pairing code, 10 min, one-time) for access.
- `t3 environment link` writes your live `~/.t3` database (that's how T3 links without the UI).
