/** Safe relative path handling for the per-bot virtual workspace. */
export class PathError extends Error {}

export const MAX_PATH_LEN = 512;

/** Returns normalized POSIX relative path ("" = root). Throws PathError on anything suspicious. */
export function safeRelPath(input: unknown, opts: { allowRoot?: boolean } = {}): string {
  if (typeof input !== "string") throw new PathError("Path must be a string");
  if (input.length > MAX_PATH_LEN) throw new PathError("Path too long");
  if (/[\u0000-\u001f\u007f]/.test(input)) throw new PathError("Invalid characters in path");
  if (input.includes("\\")) throw new PathError("Backslashes are not allowed");
  if (input.startsWith("/") || /^[A-Za-z]:/.test(input)) throw new PathError("Absolute paths are not allowed");
  const parts: string[] = [];
  for (const seg of input.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") throw new PathError("Path traversal is not allowed");
    if (seg.length > 255) throw new PathError("Name too long");
    parts.push(seg);
  }
  const out = parts.join("/");
  if (!out && !opts.allowRoot) throw new PathError("Path is required");
  return out;
}

export const dirname = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
