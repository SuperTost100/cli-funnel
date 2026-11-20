import type { Streamed } from "../../../util/process.js";

/** An error answer of the agent. `code` is the JSON-RPC code, `data` whatever the agent attached. */
export class AcpError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AcpError";
  }
}

type Message = { id?: string | number; method?: string; params?: any; result?: any; error?: { code?: number; message?: string; data?: unknown } };

export interface AcpHandlers {
  /** Called with every line the agent prints, before it is handled. */
  line?(raw: unknown): void;
  notification(method: string, params: any): void;
  /** A request from the agent. Answer it with `respond` or `fail`. */
  request(id: string | number, method: string, params: any): void;
  /** Called once when the stream ends. */
  closed(): void;
}

/** JSON-RPC 2.0 over the stdio of `agy acp`, one JSON object per line. */
export class AcpClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor(
    private proc: Streamed,
    handlers: AcpHandlers,
  ) {
    void (async () => {
      try {
        for await (const raw of proc.lines) {
          handlers.line?.(raw);
          const m = raw as Message;
          if (!m || typeof m !== "object") continue;
          if (m.method && m.id !== undefined) handlers.request(m.id, m.method, m.params);
          else if (m.method) handlers.notification(m.method, m.params);
          else if (typeof m.id === "number") {
            const p = this.pending.get(m.id);
            this.pending.delete(m.id);
            if (m.error) p?.reject(new AcpError(String(m.error.message ?? "agy acp failed."), Number(m.error.code ?? -32603), m.error.data));
            else p?.resolve(m.result);
          }
        }
      } catch {
        /* the process error is reported through closed() */
      }
      for (const p of this.pending.values()) p.reject(new AcpError("agy acp closed.", -32000));
      this.pending.clear();
      handlers.closed();
    })();
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  respond(id: string | number, result: unknown): void {
    this.send({ id, result });
  }

  fail(id: string | number, code: number, message: string): void {
    this.send({ id, error: { code, message } });
  }

  private send(message: Record<string, unknown>): void {
    this.proc.write(JSON.stringify({ jsonrpc: "2.0", ...message }));
  }
}
