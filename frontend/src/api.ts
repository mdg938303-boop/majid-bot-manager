let csrf = "";
export const setCsrf = (t: string) => { csrf = t; };

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

export async function api<T = any>(method: string, path: string, body?: unknown, raw?: Blob | ArrayBuffer): Promise<T> {
  const headers: Record<string, string> = { "X-CSRF-Token": csrf };
  let payload: BodyInit | undefined;
  if (raw) { payload = raw as BodyInit; headers["Content-Type"] = "application/octet-stream"; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers["Content-Type"] = "application/json"; }
  const res = await fetch(path, { method, headers, body: payload, credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  if (data.csrf) csrf = data.csrf;
  return data as T;
}
export const get = <T = any>(p: string) => api<T>("GET", p);
export const post = <T = any>(p: string, b?: unknown) => api<T>("POST", p, b ?? {});
