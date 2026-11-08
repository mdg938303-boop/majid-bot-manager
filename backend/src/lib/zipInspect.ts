import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { safeRelPath, PathError } from "./paths.js";

export class ZipValidationError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export interface ZipLimits {
  maxZipBytes: number; maxEntries: number; maxTotalBytes: number; maxFileBytes: number; maxRatio: number;
}
export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxZipBytes: 25 * 1024 * 1024, maxEntries: 5000, maxTotalBytes: 100 * 1024 * 1024, maxFileBytes: 20 * 1024 * 1024, maxRatio: 200,
};

export interface ExtractedProject { files: Map<string, Buffer>; warnings: string[]; strippedPrefix: string }

const SKIP_DIRS = ["node_modules", ".git", "__pycache__", ".venv", "venv", "vendor", "__MACOSX", ".idea", ".vscode"];

interface Entry { name: string; method: number; crc: number; csize: number; usize: number; offset: number; isDir: boolean }

function readEntries(buf: Buffer, lim: ZipLimits): Entry[] {
  if (buf.length < 22) throw new ZipValidationError("not_zip", "File is too small to be a ZIP archive.");
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipValidationError("not_zip", "Not a valid ZIP archive.");
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) throw new ZipValidationError("zip64", "ZIP64 archives are not supported.");
  if (total > lim.maxEntries) throw new ZipValidationError("too_many_entries", `Archive has too many entries (max ${lim.maxEntries}).`);
  if (cdOff + cdSize > eocd) throw new ZipValidationError("corrupt", "Corrupt ZIP directory.");
  const out: Entry[] = [];
  let p = cdOff;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipValidationError("corrupt", "Corrupt ZIP directory entry.");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const madeBy = buf.readUInt16LE(p + 4) >> 8;
    const extAttr = buf.readUInt32LE(p + 38);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    p += 46 + nlen + elen + clen;
    if (flags & 1) throw new ZipValidationError("encrypted", `Encrypted entries are not allowed: ${name}`);
    if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) throw new ZipValidationError("zip64", "ZIP64 entries are not supported.");
    if (madeBy === 3) { // Unix: check for symlink / special files
      const mode = (extAttr >>> 16) & 0xf000;
      if (mode === 0xa000) throw new ZipValidationError("symlink", `Symlinks are not allowed: ${name}`);
      if (mode !== 0 && mode !== 0x8000 && mode !== 0x4000) throw new ZipValidationError("special_file", `Special files are not allowed: ${name}`);
    }
    out.push({ name, method, crc, csize, usize, offset, isDir: name.endsWith("/") });
  }
  return out;
}

export function inspectAndExtractZip(buf: Buffer, lim: ZipLimits = DEFAULT_ZIP_LIMITS): ExtractedProject {
  if (buf.length > lim.maxZipBytes) throw new ZipValidationError("too_large", `Archive exceeds ${Math.round(lim.maxZipBytes / 1048576)} MB.`);
  const entries = readEntries(buf, lim);
  const warnings: string[] = [];
  const seen = new Set<string>();
  const cleaned: { path: string; e: Entry }[] = [];
  let declaredTotal = 0;

  for (const e of entries) {
    let rel: string;
    try {
      if (e.name.includes("\\")) throw new ZipValidationError("bad_path", `Backslash in entry name: ${e.name}`);
      rel = safeRelPath(e.name, { allowRoot: true });
    } catch (err) {
      if (err instanceof PathError) throw new ZipValidationError("bad_path", `Unsafe path in archive (${err.message}): ${e.name.slice(0, 80)}`);
      throw err;
    }
    if (!rel) continue;
    const segs = rel.split("/");
    if (segs.some((s) => SKIP_DIRS.includes(s)) || segs[segs.length - 1] === ".DS_Store") {
      if (!warnings.some((w) => w.includes(segs[0]))) warnings.push(`Skipped ${segs[0]} (dependencies/metadata are installed in the sandbox).`);
      continue;
    }
    if (e.isDir) continue;
    const key = rel.toLowerCase();
    if (seen.has(key)) throw new ZipValidationError("duplicate", `Duplicate entry: ${rel}`);
    seen.add(key);
    if (e.method !== 0 && e.method !== 8) throw new ZipValidationError("method", `Unsupported compression method for ${rel}.`);
    if (e.usize > lim.maxFileBytes) throw new ZipValidationError("file_too_large", `File too large: ${rel}`);
    if (e.usize > 1048576 && e.csize > 0 && e.usize / e.csize > lim.maxRatio) throw new ZipValidationError("zip_bomb", `Suspicious compression ratio: ${rel}`);
    declaredTotal += e.usize;
    if (declaredTotal > lim.maxTotalBytes) throw new ZipValidationError("zip_bomb", `Archive expands beyond ${Math.round(lim.maxTotalBytes / 1048576)} MB.`);
    cleaned.push({ path: rel, e });
  }
  if (cleaned.length === 0) throw new ZipValidationError("empty", "Archive contains no usable files.");

  // Strip a single wrapping folder (common when zipping a directory).
  let prefix = "";
  const firstSegs = new Set(cleaned.map((c) => c.path.split("/")[0]));
  if (firstSegs.size === 1 && cleaned.every((c) => c.path.includes("/"))) {
    prefix = [...firstSegs][0] + "/";
  }

  const files = new Map<string, Buffer>();
  let actualTotal = 0;
  for (const { path, e } of cleaned) {
    if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) throw new ZipValidationError("corrupt", `Corrupt local header: ${path}`);
    const nlen = buf.readUInt16LE(e.offset + 26), elen = buf.readUInt16LE(e.offset + 28);
    const start = e.offset + 30 + nlen + elen;
    const end = start + e.csize;
    if (end > buf.length) throw new ZipValidationError("corrupt", `Truncated data: ${path}`);
    const raw = buf.subarray(start, end);
    let data: Buffer;
    try {
      data = e.method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: e.usize + 1 });
    } catch {
      throw new ZipValidationError("zip_bomb", `Entry expands beyond its declared size or is corrupt: ${path}`);
    }
    if (data.length !== e.usize) throw new ZipValidationError("corrupt", `Size mismatch: ${path}`);
    if (crc32(data) !== e.crc) throw new ZipValidationError("corrupt", `CRC mismatch: ${path}`);
    actualTotal += data.length;
    if (actualTotal > lim.maxTotalBytes) throw new ZipValidationError("zip_bomb", "Archive expands beyond the allowed size.");
    const finalPath = prefix ? path.slice(prefix.length) : path;
    if (files.has(finalPath)) throw new ZipValidationError("duplicate", `Duplicate entry after normalisation: ${finalPath}`);
    files.set(finalPath, data);
  }
  return { files, warnings, strippedPrefix: prefix };
}

/** Minimal ZIP writer (stored) — used by tests to build fixtures. */
export function buildZip(entries: { name: string; data?: Buffer | string; mode?: number; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const en of entries) {
    const name = Buffer.from(en.name); const data = Buffer.from(en.data ?? "");
    const method = en.deflate ? 8 : 0; const comp = en.deflate ? deflateRawSync(data) : data;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc32(data), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc32(data), 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((en.mode ?? (en.name.endsWith("/") ? 0o40755 : 0o100644)) << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals); const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
