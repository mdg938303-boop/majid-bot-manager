/** Minimal ustar writer. Used to push validated project files into a sandbox and for downloads. */
import { gzipSync } from "node:zlib";

function field(buf: Buffer, off: number, len: number, val: string) { buf.write(val, off, len, "utf8"); }
const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";

export function buildTar(files: Map<string, Buffer>, opts: { executable?: (p: string) => boolean } = {}): Buffer {
  const chunks: Buffer[] = [];
  for (const [path, data] of [...files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    let name = path, prefix = "";
    if (Buffer.byteLength(name) > 100) {
      const i = name.lastIndexOf("/", name.length - 1);
      if (i < 1 || Buffer.byteLength(name.slice(i + 1)) > 100 || Buffer.byteLength(name.slice(0, i)) > 155) continue; // skipped; validated earlier by path limits
      prefix = name.slice(0, i); name = name.slice(i + 1);
    }
    const h = Buffer.alloc(512);
    field(h, 0, 100, name);
    field(h, 100, 8, oct(opts.executable?.(path) ? 0o755 : 0o644, 8));
    field(h, 108, 8, oct(1000, 8)); field(h, 116, 8, oct(1000, 8));
    field(h, 124, 12, oct(data.length, 12)); field(h, 136, 12, oct(0, 12));
    h.write("        ", 148, 8); h[156] = 0x30;
    field(h, 257, 6, "ustar\0"); field(h, 263, 2, "00"); field(h, 345, 155, prefix);
    let sum = 0; for (const b of h) sum += b;
    field(h, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
    chunks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}
export const buildTarGz = (files: Map<string, Buffer>) => gzipSync(buildTar(files));
