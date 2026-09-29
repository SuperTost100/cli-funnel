import type { Streamed } from "../../util/process.js";

type Message = { id?: string | number; method?: string; params?: any; result?: any; error?: { code: number; message: string } };

export interface RpcHandlers {
  notification(method: string, params: any): void;
  request(id: string | number, method: string, params: any): void;
  /** Called once when the stream ends. */
  closed(): void;
}

/** Minimal JSON-RPC client for `codex app-server` over stdio, one JSON object per line. */
export class RpcClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor(private proc: Streamed, handlers: RpcHandlers) {
    void (async () => {
      try {
        for await (const raw of proc.lines) {
          const m = raw as Message;
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
      handlers.closed();
    })();
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
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
