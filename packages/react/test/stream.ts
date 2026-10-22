/** An async stream the test feeds by hand. */
export function stream<T>() {
  const queue: T[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  async function* gen(): AsyncGenerator<T> {
    for (;;) {
      if (queue.length) yield queue.shift()!;
      else if (closed) return;
      else await new Promise<void>((r) => (wake = r));
    }
  }
  return {
    gen: gen(),
    push(e: T) {
      queue.push(e);
      wake?.();
    },
    end() {
      closed = true;
      wake?.();
    },
  };
}
