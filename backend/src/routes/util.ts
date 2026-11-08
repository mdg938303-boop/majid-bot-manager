import type { NextFunction, Request, RequestHandler, Response } from "express";
import { HttpError } from "../services/engine.js";
import { PathError } from "../lib/paths.js";
import { ZipValidationError } from "../lib/zipInspect.js";
import { DetectionError } from "../lib/detect.js";

export const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => (req, res, next) => { fn(req, res).catch(next); };

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err instanceof PathError) return res.status(400).json({ error: err.message });
  if (err instanceof ZipValidationError) return res.status(422).json({ error: err.message, code: err.code });
  if (err instanceof DetectionError) return res.status(422).json({ error: err.message, code: err.code });
  if (err?.type === "entity.too.large") return res.status(413).json({ error: "Upload is too large." });
  console.error(err);
  res.status(500).json({ error: "Internal server error." });
}

export function str(v: unknown, name: string, o: { min?: number; max?: number; re?: RegExp; optional?: boolean } = {}): string {
  if (v === undefined || v === null || v === "") { if (o.optional) return ""; throw new HttpError(400, `${name} is required.`); }
  if (typeof v !== "string") throw new HttpError(400, `${name} must be text.`);
  const s = v.trim();
  if (s.length < (o.min ?? 1) || s.length > (o.max ?? 500)) throw new HttpError(400, `${name} has an invalid length.`);
  if (o.re && !o.re.test(s)) throw new HttpError(400, `${name} is invalid.`);
  return s;
}
export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
export const uuid = (v: unknown) => { if (typeof v !== "string" || !/^[0-9a-f-]{36}$/i.test(v)) throw new HttpError(400, "Invalid id."); return v; };
