/**
 * Appends `path` to a base URL. A query string on the base, such as an Azure `api-version` or a gateway key, stays at
 * the end and is merged with the path's own query. Plain string work, so it never throws and keeps the encoding.
 */
export function joinUrl(base: string, path: string): string {
  const q = base.indexOf("?");
  const root = (q < 0 ? base : base.slice(0, q)).replace(/\/+$/, "");
  const query = q < 0 ? "" : base.slice(q + 1);
  if (!query) return root + path;
  const p = path.indexOf("?");
  return p < 0 ? `${root}${path}?${query}` : `${root}${path.slice(0, p)}?${query}&${path.slice(p + 1)}`;
}
