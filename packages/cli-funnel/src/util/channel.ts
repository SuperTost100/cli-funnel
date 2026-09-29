/** A push-based async queue. Producers call `push`/`end`, consumers `for await`. */
export class Channel<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiting: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;
  private failure: unknown;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value, done: false });
    else this.queue.push(value);
  }

  end(): void {
    this.closed = true;
    for (const w of this.waiting.splice(0)) w({ value: undefined as never, done: true });
  }

  fail(error: unknown): void {
    this.failure = error;
    this.end();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        if (this.queue.length) return { value: this.queue.shift() as T, done: false };
        if (this.closed) {
          if (this.failure) throw this.failure;
          return { value: undefined as never, done: true };
        }
        return new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
      },
    };
  }
}
