// Minimal boat.dev REST client (https://docs.boat.dev/api/v1.md).
// Plain fetch instead of @boatdev/sdk: we use a handful of endpoints and want
// precise control over retries and error codes.

export interface BoatSandbox {
  id: string;
  state: string;
  name?: string;
  labels?: Record<string, string>;
  [key: string]: unknown;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class BoatError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;
  constructor(
    status: number,
    code: string | undefined,
    message: string,
    retryable: boolean,
    retryAfterSeconds?: number,
  ) {
    super(`boat ${status}${code ? ` ${code}` : ""}: ${message}`);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const READY_STATES = new Set(["ready", "idle", "running"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class BoatClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl = "https://boat.dev/api/v1") {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async request<T = any>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    timeoutMs = 120_000,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json: any = undefined;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { message: text };
    }
    if (!res.ok || json?.ok === false) {
      const err = json?.error ?? json ?? {};
      const code: string | undefined = err.code ?? json?.code;
      const retryAfter =
        Number(res.headers.get("retry-after")) ||
        Number(err.details?.retryAfterSeconds ?? json?.retryAfterSeconds) ||
        undefined;
      const retryable =
        err.details?.retryable === true ||
        code === "sandbox_starting" ||
        code === "idempotency_in_progress" ||
        res.status === 429 ||
        res.status === 503;
      throw new BoatError(
        res.status,
        code,
        String(err.message ?? json?.message ?? res.statusText),
        retryable,
        retryAfter,
      );
    }
    return json as T;
  }

  /** Retries calls boat marks as retryable (starting, restoring, 429, 503). */
  private async withRetry<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof BoatError) || !e.retryable || i >= attempts - 1) throw e;
        await sleep(Math.min(30_000, (e.retryAfterSeconds ?? 2 ** i) * 1000));
      }
    }
  }

  async createSandbox(input: {
    name?: string;
    ttlSeconds?: number | null;
    type?: string;
    labels?: Record<string, string>;
    env?: Record<string, string>;
    environment?: string;
    idempotencyKey: string;
  }): Promise<BoatSandbox> {
    const { idempotencyKey, ...body } = input;
    const res = await this.withRetry(() =>
      this.request("POST", "/sandboxes", body, { "Idempotency-Key": idempotencyKey }),
    );
    const sandbox = res.sandbox ?? res;
    if (!sandbox?.id) throw new Error(`boat create returned no sandbox id: ${JSON.stringify(res)}`);
    return sandbox;
  }

  async getSandbox(id: string): Promise<BoatSandbox> {
    const res = await this.request("GET", `/sandboxes/${encodeURIComponent(id)}`);
    return res.sandbox ?? res;
  }

  async waitUntilReady(id: string, timeoutMs = 5 * 60_000): Promise<BoatSandbox> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const sandbox = await this.getSandbox(id);
      if (READY_STATES.has(sandbox.state)) return sandbox;
      if (sandbox.state === "error") throw new Error(`sandbox ${id} failed to start`);
      if (Date.now() > deadline) throw new Error(`sandbox ${id} not ready after ${timeoutMs / 1000}s (state ${sandbox.state})`);
      await sleep(2_000);
    }
  }

  /** Runs a command and waits for it (max 600 s). Throws on transport errors, not on a non-zero exit. */
  async exec(id: string, command: string, timeoutSeconds = 60): Promise<CommandResult> {
    const res = await this.withRetry(() =>
      this.request(
        "POST",
        `/sandboxes/${encodeURIComponent(id)}/commands`,
        { command, timeoutSeconds },
        {},
        (timeoutSeconds + 90) * 1000,
      ),
    );
    return {
      exitCode: Number(res.exitCode ?? res.result?.exitCode ?? 0),
      stdout: String(res.stdout ?? res.result?.stdout ?? ""),
      stderr: String(res.stderr ?? res.result?.stderr ?? ""),
    };
  }

  /** Starts a background command; it has no time limit. */
  async execDetached(id: string, command: string): Promise<string | undefined> {
    const res = await this.withRetry(() =>
      this.request("POST", `/sandboxes/${encodeURIComponent(id)}/commands`, { command, detached: true }),
    );
    return res.processId ?? res.process?.id ?? res.id;
  }

  async writeFile(id: string, path: string, content: string): Promise<void> {
    await this.withRetry(() =>
      this.request("PUT", `/sandboxes/${encodeURIComponent(id)}/files`, { path, content }),
    );
  }

  /** Exposes a port on a public HTTPS URL. */
  async host(id: string, port: number, title?: string): Promise<string> {
    const res = await this.withRetry(() =>
      this.request("POST", `/sandboxes/${encodeURIComponent(id)}/host`, { port, public: true, title }),
    );
    const url = res.url ?? res.host?.url ?? res.hostedPort?.url;
    if (!url) throw new Error(`boat host returned no url: ${JSON.stringify(res)}`);
    return url;
  }

  async listSandboxes(label: string): Promise<BoatSandbox[]> {
    const out: BoatSandbox[] = [];
    let cursor = "";
    for (;;) {
      const q = new URLSearchParams({ limit: "200", label });
      if (cursor) q.set("cursor", cursor);
      const res = await this.request("GET", `/sandboxes?${q}`);
      out.push(...(res.sandboxes ?? []));
      if (!res.pageInfo?.hasMore) return out;
      cursor = res.pageInfo.nextCursor;
    }
  }

  /** Permanently deletes the sandbox and its snapshots. */
  async deleteSandbox(id: string): Promise<void> {
    try {
      await this.request("DELETE", `/sandboxes/${encodeURIComponent(id)}`, undefined, {
        "X-Ascii-Confirm-Delete": id,
      });
    } catch (e) {
      if (e instanceof BoatError && e.status === 404) return;
      throw e;
    }
  }
}
