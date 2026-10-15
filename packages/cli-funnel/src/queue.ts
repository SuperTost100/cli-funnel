import { Channel } from "./util/channel.js";
import { FunnelError, type FunnelEvent, type ProviderId } from "./types.js";

/** Limits on runs at the same time. Runs over the limit wait in a first-in, first-out queue. */
export interface RunLimits {
  /**
   * Runs at the same time. A number caps all runs together. `perProvider` caps each provider: one number for every
   * provider, or a number per provider id. Default: no limit.
   */
  maxConcurrentRuns?: number | { total?: number; perProvider?: number | Partial<Record<ProviderId, number>> };
  /** Runs that may wait for a slot. A run over this fails with code "busy". Default: no limit. */
  maxQueuedRuns?: number;
  /** How long a run may wait for a slot before it fails with code "busy". Default: no limit. */
  queueTimeoutMs?: number;
}

/** What the HTTP handler sends in `retry-after` when it refuses a run because the queue is full. */
export const BUSY_RETRY_AFTER_SEC = 5;

interface Waiter {
  provider: ProviderId;
  ahead?: number;
  onPosition?: (ahead: number) => void;
  start: () => void;
}

export class RunQueue {
  private running = 0;
  private perProvider = new Map<ProviderId, number>();
  private waiting: Waiter[] = [];

  constructor(private readonly limits: RunLimits) {}

  /** A queue for `limits`, or undefined when they set no concurrency limit. */
  static from(limits: RunLimits): RunQueue | undefined {
    return limits.maxConcurrentRuns === undefined ? undefined : new RunQueue(limits);
  }

  private cap(provider: ProviderId): { total: number; provider: number } {
    const max = this.limits.maxConcurrentRuns;
    if (typeof max === "number") return { total: max, provider: Infinity };
    const per = max?.perProvider;
    return { total: max?.total ?? Infinity, provider: (typeof per === "number" ? per : per?.[provider]) ?? Infinity };
  }

  private fits(provider: ProviderId): boolean {
    const cap = this.cap(provider);
    return this.running < cap.total && (this.perProvider.get(provider) ?? 0) < cap.provider;
  }

  /** True when a run for `provider` would be refused right now because the queue is full. */
  full(provider: ProviderId): boolean {
    return !this.fits(provider) && this.waiting.length >= (this.limits.maxQueuedRuns ?? Infinity);
  }

  /**
   * Resolves with a release function once the run may start. Call it when the run ends. `onPosition` hears how many
   * runs wait ahead of this one whenever that changes. Rejects with code "busy" when the queue is full or the wait
   * passes `queueTimeoutMs`, and with code "aborted" when `signal` aborts first.
   */
  acquire(provider: ProviderId, opts: { signal?: AbortSignal; onPosition?: (ahead: number) => void } = {}): Promise<() => void> {
    const { signal } = opts;
    if (signal?.aborted) return Promise.reject(new FunnelError("The run was cancelled while it waited.", "aborted"));
    // Waiting runs never fit, or they would have started, so a run that fits now skips no one it could have waited for.
    if (this.fits(provider)) return Promise.resolve(this.take(provider));
    if (this.full(provider)) return Promise.reject(new FunnelError("Too many runs are waiting. Try again later.", "busy"));
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const leave = (err: FunnelError) => {
        cleanup();
        this.waiting = this.waiting.filter((w) => w !== waiter);
        this.report();
        reject(err);
      };
      const onAbort = () => leave(new FunnelError("The run was cancelled while it waited.", "aborted"));
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const waiter: Waiter = {
        provider,
        onPosition: opts.onPosition,
        start: () => {
          cleanup();
          resolve(this.take(provider));
        },
      };
      if (this.limits.queueTimeoutMs !== undefined) {
        timer = setTimeout(() => leave(new FunnelError("No run slot came free in time. Try again later.", "busy")), this.limits.queueTimeoutMs);
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiter);
      this.report();
    });
  }

  private take(provider: ProviderId): () => void {
    this.running++;
    this.perProvider.set(provider, (this.perProvider.get(provider) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running--;
      this.perProvider.set(provider, this.perProvider.get(provider)! - 1);
      this.pump();
    };
  }

  /** Starts every waiting run that fits, oldest first. */
  private pump(): void {
    for (const w of [...this.waiting]) {
      if (!this.fits(w.provider)) continue;
      this.waiting = this.waiting.filter((x) => x !== w);
      w.start();
    }
    this.report();
  }

  private report(): void {
    this.waiting.forEach((w, ahead) => {
      if (w.ahead === ahead) return;
      w.ahead = ahead;
      w.onPosition?.(ahead);
    });
  }
}

/**
 * Waits for a slot in `queue` and yields a `queue.position` event whenever the number of runs ahead changes. Returns
 * the release function, or undefined when `signal` aborted while the run waited. Throws code "busy" when refused.
 */
export async function* waitForSlot(queue: RunQueue, provider: ProviderId, signal?: AbortSignal): AsyncGenerator<FunnelEvent, (() => void) | undefined> {
  // Aborts the wait when the consumer stops reading, so the run leaves the queue.
  const stop = new AbortController();
  const positions = new Channel<number>();
  const slot = queue.acquire(provider, { signal: signal ? AbortSignal.any([signal, stop.signal]) : stop.signal, onPosition: (ahead) => positions.push(ahead) });
  slot.then(
    () => positions.end(),
    () => positions.end(),
  );
  let handedOver = false;
  try {
    for await (const ahead of positions) yield { type: "queue.position", ahead };
    const release = await slot.catch((err: unknown) => {
      if (signal?.aborted) return undefined;
      throw err;
    });
    handedOver = true;
    return release;
  } finally {
    if (!handedOver) {
      stop.abort();
      slot.then(
        (release) => release(),
        () => undefined,
      );
    }
  }
}
