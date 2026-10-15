/** 10 MB: room for a few base64 images, small enough that one request cannot fill the server's memory. */
export const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

/** A request the server refuses before it runs anything: 400 for a body that is not a JSON object, 413 for one that is too large. */
export class BodyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413,
  ) {
    super(message);
    this.name = "BodyError";
  }
}

/**
 * Reads a JSON object from the request body. Checks `content-length` first, then counts the bytes as they arrive, because
 * the header can be missing or wrong.
 */
export async function readJson(req: Request, maxBytes = DEFAULT_MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const tooLarge = () => new BodyError(`Request body is too large. The limit is ${maxBytes} bytes.`, 413);
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();

  const chunks: Uint8Array[] = [];
  let size = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BodyError("Request body is not valid JSON.", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BodyError("Request body must be a JSON object.", 400);
  return parsed as Record<string, unknown>;
}
