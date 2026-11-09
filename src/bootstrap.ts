// Shell scripts that turn a fresh boat sandbox into a T3 Code environment.
// Installs upstream T3 Code with its official installer (https://t3.codes/install.sh)
// under $HOME (boat runs as `user`; sudo is not assumed).

export const T3_PORT = 3773;
export const T3_HOME = "$HOME/.t3";
export const SCRIPT_DIR = "/home/user/.t3boat";

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const installScript = `#!/usr/bin/env bash
# t3boat: install the T3 Code server and provider CLIs. Idempotent.
# $1 = exact T3 Code version (match the local client), or empty for the latest stable.
set -euo pipefail
T3_VERSION="\${1:-}"
export PATH="$HOME/.local/bin:$HOME/.t3boat/node/bin:$PATH"
log() { echo "[t3boat] $*"; }

ver_ge() { [ "$(printf '%s\\n%s\\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }

# 1. T3 Code, via the official installer (checks the release's SHA256SUMS).
have="$(t3 --version 2>/dev/null | sed -n 's/^t3 v//p' || true)"
if [ -z "$have" ] || { [ -n "$T3_VERSION" ] && [ "$have" != "$T3_VERSION" ]; }; then
  log "installing t3 \${T3_VERSION:-stable}"
  curl -fsSL https://t3.codes/install.sh | T3CODE_VERSION="$T3_VERSION" T3CODE_INSTALL_BIN_DIR="$HOME/.local/bin" sh
fi
t3 --version

# 2. Node (only for the provider CLIs) when missing or too old.
if ! command -v node >/dev/null || ! ver_ge "$(node -v | tr -d v)" "22.16.0"; then
  log "installing node 24"
  nv="v24.11.1"
  mkdir -p "$HOME/.t3boat/node"
  case "$(uname -m)" in aarch64|arm64) na=arm64 ;; *) na=x64 ;; esac
  curl -fsSL "https://nodejs.org/dist/$nv/node-$nv-linux-$na.tar.xz" | tar -xJ -C "$HOME/.t3boat/node" --strip-components=1
fi

npm_install() { npm install -g --prefix "$HOME/.local" --no-fund --no-audit "$@" >/dev/null; }

# 3. Provider CLIs T3 Code drives (boat images usually ship both; install only if missing).
command -v claude >/dev/null || { log "installing claude"; npm_install @anthropic-ai/claude-code; }
command -v codex >/dev/null || { log "installing codex"; npm_install @openai/codex || log "codex install failed (continuing)"; }

# 4. Server settings: peer links must be enabled on this side too.
mkdir -p "${T3_HOME}/userdata"
settings="${T3_HOME}/userdata/settings.json"
if [ -s "$settings" ] && command -v jq >/dev/null; then
  jq '.linkedEnvironmentsEnabled = true' "$settings" > "$settings.tmp" && mv "$settings.tmp" "$settings"
else
  echo '{"linkedEnvironmentsEnabled":true}' > "$settings"
fi

# 5. Supervisor: restarts t3 serve if it exits; credentials come from the boat env.
cat > "$HOME/.t3boat/serve.sh" <<'SERVE'
#!/usr/bin/env bash
# One supervisor per VM: a second start exits at once.
exec 9>"$HOME/.t3boat/serve.lock"
flock -n 9 || exit 0
export PATH="$HOME/.local/bin:$HOME/.t3boat/node/bin:$PATH"
[ -f "$HOME/.t3boat/env" ] && set -a && . "$HOME/.t3boat/env" && set +a
while true; do
  t3 serve --host 0.0.0.0 --port ${T3_PORT} --base-dir "$HOME/.t3" --no-browser >> "$HOME/.t3boat/serve.log" 2>&1
  echo "[t3boat] t3 serve exited with $?, restarting" >> "$HOME/.t3boat/serve.log"
  sleep 2
done
SERVE
chmod +x "$HOME/.t3boat/serve.sh"
log "install done"
`;

/** Run as a boat *detached* command: boat keeps it alive (sync commands reap their children). */
export const startServerCommand = `bash "$HOME/.t3boat/serve.sh"`;

export const healthCommand = `curl -fsS -m 5 http://127.0.0.1:${T3_PORT}/.well-known/t3/environment`;

/** Clones the repo (with the same origin URL as locally, so T3 matches the project by repository identity) and registers it. */
export function projectSetupCommand(repo: string, ref: string | undefined, dir: string): string {
  const checkout = ref ? ` && git -C ${sh(dir)} checkout ${sh(ref)}` : "";
  return [
    `export PATH="$HOME/.local/bin:$PATH"`,
    `if [ ! -d ${sh(dir)}/.git ]; then git clone ${sh(repo)} ${sh(dir)}${checkout}; fi`,
    // Prints "Added project <id> (<title>) at <path>."; an already-added path is not an error.
    `{ t3 project add ${sh(dir)} --base-dir "$HOME/.t3" 2>&1 || true; }`,
  ].join(" && ");
}

export function pairingCommand(label: string): string {
  return `export PATH="$HOME/.local/bin:$PATH" && t3 auth pairing create --base-dir "$HOME/.t3" --json --ttl 10m --label ${sh(label)}`;
}

/** Thread statuses on the VM; busy ones keep the sandbox alive. */
export const threadListCommand = [
  `export PATH="$HOME/.local/bin:$PATH";`,
  // \`t3 thread list\` is per project: try every checkout under $HOME (depth 1-2), merge, dedupe.
  `{ for d in $(find "$HOME" -mindepth 2 -maxdepth 3 -name .git -not -path "*/.*/*" -printf "%h\\n" 2>/dev/null | sort -u); do`,
  `t3 thread list --json --project "$d" --base-dir "$HOME/.t3" 2>/dev/null; done; echo "[]"; }`,
  `| jq -s "add | unique_by(.threadId)"`,
].join(" ");

export const BUSY_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export function envFile(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${sh(v)}`)
    .join("\n") + "\n";
}

export function shellQuote(s: string): string {
  return sh(s);
}
