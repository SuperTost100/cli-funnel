/** The most text an unfinished frame or line may hold. A server that never sends a delimiter must not fill memory. */
export const MAX_FRAME_CHARS = 16 * 1024 * 1024;

/**
 * Cuts text that arrives in chunks into frames that end at `delimiter`. Each chunk is searched once, together with the
 * few characters before it that a split delimiter could start in, and the unfinished text is kept as a list of pieces,
 * so a frame that arrives in many small chunks costs linear time. Throws when unfinished text passes MAX_FRAME_CHARS.
 * `overlap` is the longest delimiter minus one. `what` names the frame in the error.
 */
export function frameSplitter(delimiter: RegExp, overlap: number, what: string) {
  const re = new RegExp(delimiter.source, "g");
  let pending: string[] = [];
  let length = 0;
  let tail = "";

  const check = () => {
    if (length > MAX_FRAME_CHARS) throw new Error(`${what} is longer than 16 MiB and has no end`);
  };

  return {
    /** The complete frames this chunk finished, without their delimiters. */
    push(chunk: string): string[] {
      const probe = tail + chunk;
      re.lastIndex = 0;
      if (!re.test(probe)) {
        pending.push(chunk);
        length += chunk.length;
        tail = overlap ? probe.slice(-overlap) : "";
        check();
        return [];
      }
      const text = pending.join("") + chunk;
      const frames: string[] = [];
      let start = 0;
      re.lastIndex = Math.max(0, length - overlap);
      for (let m = re.exec(text); m; m = re.exec(text)) {
        frames.push(text.slice(start, m.index));
        start = re.lastIndex;
      }
      const rest = text.slice(start);
      pending = [rest];
      length = rest.length;
      tail = overlap ? rest.slice(-overlap) : "";
      check();
      return frames;
    },
    /** The text after the last delimiter. */
    rest: () => pending.join(""),
  };
}
