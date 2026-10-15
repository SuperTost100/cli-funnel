/** A push-based async queue. Producers call `push`/`end`, consumers `for await`. */
export class Channel<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiting: { resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void }[] = [];
  private closed = false;
  private failure: unknown;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiting.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.queue.push(value);
  }

  end(): void {
    this.closed = true;
    for (const w of this.waiting.splice(0)) w.resolve({ value: undefined as never, done: true });
  }

  /** Ends the stream with an error. A reader already waiting gets the error too, not a clean end. */
  fail(error: unknown): void {
    if (this.closed) return;
    this.failure = error;
    this.closed = true;
    for (const w of this.waiting.splice(0)) w.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        if (this.queue.length) return { value: this.queue.shift() as T, done: false };
        if (this.closed) {
          if (this.failure) throw this.failure;
          return { value: undefined as never, done: true };
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => this.waiting.push({ resolve, reject }));
      },
    };
  }
}
