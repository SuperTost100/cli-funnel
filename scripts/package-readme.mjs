// Copies the root README into a package before npm packs it. npm cannot resolve links and images relative to the
// repository, so they become GitHub URLs pinned to the release tag.
// Usage: node package-readme.mjs <from> <to> [ref]. The ref defaults to v<npm_package_version>, which npm sets.
import { readFileSync, writeFileSync } from "node:fs";

const REPO = "SuperTost100/cli-funnel";

/** True for a link that points into the repository: not a URL, not an anchor, not an absolute path. */
const relative = (url) => !/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(url);

export function absoluteLinks(markdown, ref) {
  const blob = (path) => `https://github.com/${REPO}/blob/${ref}/${path}`;
  const raw = (path) => `https://raw.githubusercontent.com/${REPO}/${ref}/${path}`;
  return (
    markdown
      // HTML images and picture sources. srcset may list several "url descriptor" entries.
      .replace(/\b(src)="([^"]+)"/g, (m, attr, url) => (relative(url) ? `${attr}="${raw(url)}"` : m))
      .replace(/\b(srcset)="([^"]+)"/g, (_m, attr, list) =>
        `${attr}="${list
          .split(",")
          .map((entry) => entry.trim().replace(/^\S+/, (url) => (relative(url) ? raw(url) : url)))
          .join(", ")}"`,
      )
      .replace(/\b(href)="([^"]+)"/g, (m, attr, url) => (relative(url) ? `${attr}="${blob(url)}"` : m))
      // Markdown images first, so the link rule below sees only links.
      .replace(/(!\[[^\]]*\])\(([^)\s]+)\)/g, (m, alt, url) => (relative(url) ? `${alt}(${raw(url)})` : m))
      .replace(/(\[[^\]]*\])\(([^)\s]+)\)/g, (m, text, url) => (relative(url) ? `${text}(${blob(url)})` : m))
  );
}

const [from, to, refArg] = process.argv.slice(2);
if (from && to) {
  const ref = refArg ?? (process.env.npm_package_version && `v${process.env.npm_package_version}`);
  if (!ref) {
    console.error("package-readme: pass a ref, or run it from an npm script so npm_package_version is set.");
    process.exit(1);
  }
  writeFileSync(to, absoluteLinks(readFileSync(from, "utf8"), ref));
}
