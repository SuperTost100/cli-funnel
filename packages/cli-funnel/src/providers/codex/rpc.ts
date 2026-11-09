import type { Streamed } from "../../util/process.js";

type Message = { id?: string | number; method?: string; params?: any; result?: any; error?: { code: number; message: string } };

export interface RpcHandlers {
  /** Called with every line the app-server prints, before it is handled, except answers to a `hideAnswer` request. */
  line?(raw: unknown): void;
  notification(method: string, params: any): void;
  request(id: string | number, method: string, params: any): void;
  /** Called once when the stream ends. */
  closed(): void;
}

/** Minimal JSON-RPC client for `codex app-server` over stdio, one JSON object per line. */
export class RpcClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  /** Ids of requests whose answer never reaches the `line` handler. */
  private hidden = new Set<number>();

  constructor(private proc: Streamed, handlers: RpcHandlers) {
    void (async () => {
      try {
        for await (const raw of proc.lines) {
          const m = raw as Message;
          if (!(m.method === undefined && typeof m.id === "number" && this.hidden.delete(m.id))) handlers.line?.(raw);
          if (m.method && m.id !== undefined) handlers.request(m.id, m.method, m.params);
          else if (m.method) handlers.notification(m.method, m.params);
          else if (typeof m.id === "number") {
            const p = this.pending.get(m.id);
            this.pending.delete(m.id);
            if (m.error) p?.reject(new Error(m.error.message));
            else p?.resolve(m.result);
          }
        }
      } catch {
        /* the process error is reported through closed() */
      }
      for (const p of this.pending.values()) p.reject(new Error("Codex app-server closed."));
      this.pending.clear();
      this.hidden.clear();
      handlers.closed();
    })();
  }

  /**
   * Sends a request and resolves with its result. `hideAnswer` keeps the answer out of the `line` handler, and so out
   * of verbose `raw` events, for answers that hold the user's private settings.
   */
  request<T = any>(method: string, params: unknown, options: { hideAnswer?: boolean } = {}): Promise<T> {
    const id = this.nextId++;
    if (options.hideAnswer) this.hidden.add(id);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.write(JSON.stringify({ method, id, params }));
    });
  }

  notify(method: string): void {
    this.proc.write(JSON.stringify({ method }));
  }

  respond(id: string | number, reply: { result: unknown } | { error: { code: number; message: string } }): void {
    this.proc.write(JSON.stringify({ id, ...reply }));
  }
}
