/**
 * End-to-end API tests. They need a RUNNING server + Postgres, so they are skipped unless:
 *   API_BASE_URL=http://localhost:3000  TEST_ADMIN_EMAIL=...  TEST_ADMIN_PASSWORD=...  npm run test:api
 * They never touch real Telegram bots or sandboxes: deployments are not triggered.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildZip } from "../src/lib/zipInspect.js";

const BASE = process.env.API_BASE_URL;
const skip = BASE ? false : "API_BASE_URL not set (needs a running server + database)";

class Client {
  cookie = ""; csrf = "";
  async req(method: string, path: string, body?: unknown, raw?: Buffer) {
    const headers: Record<string, string> = { cookie: this.cookie, "x-csrf-token": this.csrf };
    let payload: any;
    if (raw) { payload = raw; headers["content-type"] = "application/zip"; } else if (body !== undefined) { payload = JSON.stringify(body); headers["content-type"] = "application/json"; }
    const res = await fetch(BASE + path, { method, headers, body: payload });
    const set = res.headers.get("set-cookie"); if (set) this.cookie = set.split(";")[0];
    const json: any = await res.json().catch(() => ({}));
    if (json.csrf) this.csrf = json.csrf;
    return { status: res.status, json };
  }
}
const uniq = () => `t${Date.now()}${Math.floor(Math.random() * 1e5)}@example.com`;
const PW = "Str0ngPassw0rd!";

async function register() { const c = new Client(); const email = uniq(); const r = await c.req("POST", "/api/auth/register", { email, password: PW }); assert.equal(r.status, 201, JSON.stringify(r.json)); return { c, email, id: r.json.user.id as string }; }

test("registration, login, logout, bad credentials", { skip }, async () => {
  const { c, email } = await register();
  assert.equal((await c.req("GET", "/api/auth/me")).json.user.email, email);
  await c.req("POST", "/api/auth/logout");
  assert.equal((await new Client().req("GET", "/api/bots")).status, 401);
  const c2 = new Client();
  assert.equal((await c2.req("POST", "/api/auth/login", { email, password: "wrong-password-1" })).status, 401);
  assert.equal((await c2.req("POST", "/api/auth/login", { email, password: PW })).status, 200);
  assert.equal((await new Client().req("POST", "/api/auth/register", { email, password: PW })).status, 409);
  assert.equal((await new Client().req("POST", "/api/auth/register", { email: uniq(), password: "short" })).status, 400);
});

test("CSRF: state-changing request without token is rejected", { skip }, async () => {
  const { c } = await register(); c.csrf = "";
  assert.equal((await c.req("POST", "/api/auth/change-password", { currentPassword: PW, newPassword: "An0therStrongPw" })).status, 403);
});

test("regular user cannot reach admin APIs (backend RBAC)", { skip }, async () => {
  const { c } = await register();
  for (const p of ["/api/admin/users", "/api/admin/audit", "/api/admin/settings", "/api/admin/overview"]) assert.equal((await c.req("GET", p)).status, 403, p);
  assert.equal((await c.req("POST", "/api/admin/killswitch")).status, 403);
});

test("bot creation rejects an invalid Telegram token (getMe verification path)", { skip }, async () => {
  const { c } = await register();
  assert.equal((await c.req("POST", "/api/bots", { name: "x", token: "not-a-token" })).status, 422);
});

const adminEmail = process.env.TEST_ADMIN_EMAIL, adminPw = process.env.TEST_ADMIN_PASSWORD;
const skipAdmin = !BASE ? skip : !adminEmail || !adminPw ? "TEST_ADMIN_EMAIL/TEST_ADMIN_PASSWORD not set" : false;

test("admin creates sub-admin with limited permissions; sub-admin is bound by them", { skip: skipAdmin }, async () => {
  const admin = new Client();
  assert.equal((await admin.req("POST", "/api/auth/login", { email: adminEmail, password: adminPw })).status, 200);
  const subEmail = uniq();
  const created = await admin.req("POST", "/api/admin/users", { email: subEmail, password: PW, role: "subadmin", permissions: ["users.view"] });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const sub = new Client(); await sub.req("POST", "/api/auth/login", { email: subEmail, password: PW });
  assert.equal((await sub.req("GET", "/api/admin/users")).status, 200, "granted permission works");
  assert.equal((await sub.req("GET", "/api/admin/audit")).status, 403, "ungranted permission denied");
  assert.equal((await sub.req("POST", "/api/admin/killswitch")).status, 403);
  const victim = await register();
  assert.equal((await sub.req("PATCH", `/api/admin/users/${victim.id}`, { status: "suspended" })).status, 403, "cannot suspend without users.suspend");
  assert.equal((await sub.req("PATCH", `/api/admin/users/${created.json.id}`, { role: "admin" })).status, 403, "cannot self-escalate");
  assert.equal((await admin.req("PATCH", `/api/admin/users/${victim.id}`, { status: "suspended" })).status, 200);
  assert.equal((await victim.c.req("GET", "/api/bots")).status, 401, "suspended user's sessions are revoked");
  assert.equal((await admin.req("GET", "/api/admin/audit")).status, 200);
});

test("ZIP upload validation + file-manager traversal + user isolation need a verified bot", { skip: "Requires a real Telegram token to create a bot via POST /api/bots; run manually with TEST_BOT_TOKEN" }, async () => {});

const tok = process.env.TEST_BOT_TOKEN;
test("with a real token: zip validation, file manager security, isolation", { skip: !BASE ? skip : tok ? false : "TEST_BOT_TOKEN not set" }, async () => {
  const a = await register(), b = await register();
  const bot = await a.c.req("POST", "/api/bots", { name: "t", token: tok });
  assert.equal(bot.status, 201, JSON.stringify(bot.json));
  const id = bot.json.bot.id;
  // user isolation: another user sees 404 for every route
  for (const [m, p] of [["GET", ""], ["GET", "/files/list"], ["GET", "/logs"], ["POST", "/stop"], ["DELETE", ""]] as const) assert.equal((await b.c.req(m, `/api/bots/${id}${p}`)).status, 404, `${m} ${p}`);
  assert.ok(!(await b.c.req("GET", "/api/bots")).json.bots.some((x: any) => x.id === id));
  // zip validation
  assert.equal((await a.c.req("POST", `/api/bots/${id}/upload`, undefined, buildZip([{ name: "../evil.py", data: "x" }]))).status, 422);
  assert.equal((await a.c.req("POST", `/api/bots/${id}/upload`, undefined, buildZip([{ name: "l", data: "/etc/passwd", mode: 0o120777 }]))).status, 422);
  const ok = await a.c.req("POST", `/api/bots/${id}/upload`, undefined, buildZip([{ name: "main.py", data: "print(1)" }, { name: "requirements.txt", data: "aiogram==3.4.1\n" }]));
  assert.equal(ok.status, 200, JSON.stringify(ok.json)); assert.equal(ok.json.manifest.language, "python");
  // file manager
  for (const bad of ["../x", "/etc/passwd", "a/../../b"]) assert.equal((await a.c.req("PUT", `/api/bots/${id}/files/write`, { path: bad, content: "x" })).status, 400, bad);
  assert.equal((await a.c.req("PUT", `/api/bots/${id}/files/write`, { path: "src/new.py", content: "print(2)" })).status, 200);
  assert.equal((await a.c.req("GET", `/api/bots/${id}/files/read?path=src/new.py`)).json.content, "print(2)");
  assert.equal((await a.c.req("DELETE", `/api/bots/${id}/files?path=src`)).status, 200);
  await a.c.req("DELETE", `/api/bots/${id}`);
});
