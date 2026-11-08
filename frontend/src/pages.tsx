import { useCallback, useEffect, useRef, useState } from "react";
import { api, get, post } from "./api";
import { Empty, ErrorBox, Spinner, Status, useUI } from "./ui";
import type { User } from "./App";

function useLoad<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null); const [err, setErr] = useState(""); const [loading, setLoading] = useState(!!path);
  const reload = useCallback(() => { if (!path) return; setLoading(true); get<T>(path).then((d) => { setData(d); setErr(""); }).catch((e) => setErr(e.message)).finally(() => setLoading(false)); }, [path]);
  useEffect(reload, [reload, ...deps]);
  return { data, err, loading, reload, setData };
}
const fmt = (d?: string | null) => (d ? new Date(d).toLocaleString() : "—");
const H = ({ children }: { children: React.ReactNode }) => <h1 className="mb-3 text-xl font-bold">{children}</h1>;

// ---------------- Dashboard ----------------
export function Dashboard({ user }: { user: User }) {
  const bots = useLoad<{ bots: any[] }>("/api/bots"); const rt = useLoad<{ ok: boolean; reason?: string }>("/api/runtime");
  if (bots.loading) return <Spinner />; if (bots.err) return <ErrorBox text={bots.err} />;
  const list = bots.data!.bots; const n = (s: string) => list.filter((b) => b.status === s).length;
  return (
    <div className="space-y-4">
      <H>Welcome{user.displayName ? `, ${user.displayName}` : ""}</H>
      {rt.data && !rt.data.ok && <div className="card border-amber-400 text-sm"><b>Execution runtime is not available.</b> Bots cannot be deployed until it is fixed.<div className="mt-1 text-slate-500">{rt.data.reason}</div></div>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[["Bots", list.length], ["Running", n("running")], ["Failed", n("failed")], ["Quota", `${list.length}/${user.role === "admin" ? "∞" : user.botQuota}`]].map(([k, v]) => (
          <div key={String(k)} className="card"><div className="text-xs text-slate-500">{k}</div><div className="text-2xl font-bold">{v}</div></div>
        ))}
      </div>
      <a className="btn btn-primary" href="#/new">+ Add new bot</a>
    </div>
  );
}

// ---------------- Bots list ----------------
export function BotsList({ user }: { user: User }) {
  const staff = user.role === "admin" || user.permissions.includes("bots.view_all");
  const [all, setAll] = useState(false); const [q, setQ] = useState(""); const [f, setF] = useState("");
  const { data, err, loading } = useLoad<{ bots: any[] }>(`/api/bots${all ? "?all=1" : ""}`);
  if (loading) return <Spinner />; if (err) return <ErrorBox text={err} />;
  const bots = data!.bots.filter((b) => (!f || b.status === f) && (b.name + (b.telegramUsername ?? "")).toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-3">
      <H>My Bots</H>
      <div className="flex flex-wrap gap-2">
        <input className="input flex-1" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input w-auto" value={f} onChange={(e) => setF(e.target.value)}><option value="">All</option>{["running", "stopped", "failed", "queued", "deploying", "created", "released"].map((s) => <option key={s}>{s}</option>)}</select>
        {staff && <label className="flex items-center gap-1 text-sm"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> All users</label>}
      </div>
      {!bots.length ? <Empty text="No bots yet. Add one to get started." /> : bots.map((b) => (
        <a key={b.id} href={`#/bots/${b.id}`} className="card block">
          <div className="flex items-center justify-between"><b>{b.name}</b><Status s={b.status} /></div>
          <div className="text-xs text-slate-500">@{b.telegramUsername} · {b.language ?? "no project"} · deployed {fmt(b.lastDeployedAt)}{b.ownerEmail && all ? ` · ${b.ownerEmail}` : ""}</div>
        </a>
      ))}
    </div>
  );
}

export function BotPicker({ title, base }: { title: string; base: string }) {
  const { data, err, loading } = useLoad<{ bots: any[] }>("/api/bots");
  if (loading) return <Spinner />; if (err) return <ErrorBox text={err} />;
  return <div className="space-y-2"><H>{title}</H><p className="text-sm text-slate-500">Choose a bot:</p>{!data!.bots.length ? <Empty text="No bots yet." /> : data!.bots.map((b) => <a key={b.id} href={`#/${base}/${b.id}`} className="card flex justify-between"><b>{b.name}</b><Status s={b.status} /></a>)}</div>;
}

// ---------------- Add bot ----------------
export function AddBot() {
  const { toast } = useUI(); const [name, setName] = useState(""); const [token, setToken] = useState(""); const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true);
    try { const r = await post("/api/bots", { name, token }); toast(`Verified @${r.bot.telegramUsername}`); location.hash = `#/bots/${r.bot.id}`; }
    catch (e: any) { toast(e.message, "err"); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-3"><H>Add New Bot</H>
      <div className="card space-y-3">
        <input className="input" placeholder="Bot name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        <input className="input" type="password" autoComplete="off" placeholder="Telegram bot token (from @BotFather)" value={token} onChange={(e) => setToken(e.target.value)} />
        <p className="text-xs text-slate-500">The token is verified with Telegram, then stored encrypted. You will upload your project ZIP on the next screen.</p>
        <button className="btn btn-primary w-full" disabled={busy || !name || !token} onClick={create}>{busy ? "Verifying…" : "Verify & create"}</button>
      </div>
    </div>
  );
}

// ---------------- Bot detail ----------------
export function BotDetail({ id, user }: { id: string; user: User }) {
  const { toast, confirm } = useUI(); const [tab, setTab] = useState("overview");
  const { data, err, loading, reload } = useLoad<any>(`/api/bots/${id}`);
  const [proc, setProc] = useState<any>(null); const [busy, setBusy] = useState("");
  const [phase, setPhase] = useState<string | null>(null);
  const check = useCallback(() => get(`/api/bots/${id}/process`).then(setProc).catch(() => setProc(null)), [id]);
  useEffect(() => { check(); }, [check, data]);
  useEffect(() => { const t = setInterval(() => { if (["queued", "deploying"].includes(data?.bot?.status)) reload(); }, 3000); return () => clearInterval(t); }, [data, reload]);
  if (loading && !data) return <Spinner />; if (err) return <ErrorBox text={err} />;
  const bot = data.bot;
  async function act(name: string, path: string, method = "POST", ask?: string) {
    if (ask && !(await confirm(ask))) return;
    setBusy(name);
    try { const r = await api(method, `/api/bots/${id}${path}`, {}); toast(r.queued ? "Deployment queued." : `${name} done.`); if (method === "DELETE") location.hash = "#/bots"; else { reload(); check(); } }
    catch (e: any) { toast(e.message, "err"); } finally { setBusy(""); }
  }
  async function upload(file: File, deploy: boolean) {
    setBusy("upload"); setPhase("Validating archive…");
    try { const r = await api("POST", `/api/bots/${id}/upload?deploy=${deploy ? 1 : 0}&name=${encodeURIComponent(file.name)}`, undefined, file); toast(`Detected ${r.manifest.language} (${r.fileCount} files). ${r.warnings.join(" ")}`); reload(); }
    catch (e: any) { toast(e.message, "err"); } finally { setBusy(""); setPhase(null); }
  }
  const b = (label: string, name: string, path: string, cls = "", method = "POST", ask?: string) => <button key={name} className={`btn ${cls}`} disabled={!!busy} onClick={() => act(name, path, method, ask)}>{busy === name ? "…" : label}</button>;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between"><H>{bot.name}</H><Status s={bot.status} /></div>
      <div className="flex gap-1 overflow-x-auto">{["overview", "console", "files", "env", "settings"].map((t) => <button key={t} className={`btn ${tab === t ? "btn-primary" : ""}`} onClick={() => setTab(t)}>{t}</button>)}</div>
      {tab === "overview" && (<>
        <div className="card space-y-1 text-sm">
          <div>Telegram: <b>@{bot.telegramUsername}</b></div><div>Language: {bot.language ?? "—"} · Entry: {bot.entryPoint ?? "—"} · Plan: {bot.plan}</div>
          <div>Last deployment: {fmt(bot.lastDeployedAt)}</div><div>Files: {data.project?.file_count ?? 0} {data.project?.archive_name ? `(${data.project.archive_name})` : ""}</div>
          <div>Live check: {proc ? <>sandbox <b>{proc.sandbox ?? "none"}</b>, process <b>{proc.process ?? "n/a"}</b></> : "…"} <button className="text-brand-600" onClick={check}>refresh</button></div>
          {data.latestDeployment && <div>Latest deployment: <Status s={data.latestDeployment.status} /> {data.latestDeployment.stage} {data.latestDeployment.error && <span className="text-red-500">— {data.latestDeployment.error}</span>}</div>}
          {bot.warnings?.map((w: string) => <div key={w} className="text-amber-600">⚠ {w}</div>)}
        </div>
        <div className="card space-y-2">
          <div className="text-sm font-medium">Project ZIP</div>
          <input type="file" accept=".zip" disabled={!!busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f, true); e.target.value = ""; }} />
          <p className="text-xs text-slate-500">{phase ?? "Uploading validates the archive, detects the language, saves the files and starts a deployment."}</p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {b("▶ Start", "Start", "/start", "btn-primary")}{b("■ Stop", "Stop", "/stop")}{b("↻ Restart", "Restart", "/restart")}
          {b("Deploy", "Deploy", "/deploy")}{b("Rebuild", "Rebuild", "/rebuild")}{b("Redeploy", "Redeploy", "/redeploy")}
          {b("Free sandbox", "Release", "/release", "", "POST", "Terminate the sandbox to stop billing? You can redeploy later.")}
          {b("Delete", "Delete", "", "btn-danger", "DELETE", "Delete this bot, its files and logs permanently?")}
        </div>
        <a className="btn w-full" href={`/api/bots/${id}/files/download-project`}>Download project (.tar.gz)</a>
      </>)}
      {tab === "console" && <Console botId={id} />}
      {tab === "files" && <Files botId={id} />}
      {tab === "env" && <Env botId={id} />}
      {tab === "settings" && <BotSettings bot={bot} reload={reload} user={user} />}
    </div>
  );
}

function BotSettings({ bot, reload }: { bot: any; reload: () => void; user: User }) {
  const { toast } = useUI(); const [name, setName] = useState(bot.name); const [entry, setEntry] = useState(""); const [dom, setDom] = useState((bot.egressDomains ?? []).join("\n"));
  async function save() { try { await api("PATCH", `/api/bots/${bot.id}`, { name, egressDomains: dom.split(/\s+/).filter(Boolean), ...(entry ? { entryPoint: entry } : {}) }); toast("Saved. Redeploy to apply network changes."); reload(); } catch (e: any) { toast(e.message, "err"); } }
  return (
    <div className="card space-y-3">
      <label className="text-sm">Name<input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="text-sm">Entry point override (optional)<input className="input mt-1" placeholder={bot.entryPoint ?? "main.py"} value={entry} onChange={(e) => setEntry(e.target.value)} /></label>
      <label className="text-sm">Extra allowed outbound domains (one per line)<textarea className="input mt-1 h-24 font-mono" placeholder="api.openai.com" value={dom} onChange={(e) => setDom(e.target.value)} /></label>
      <p className="text-xs text-slate-500">Sandboxes can only reach Telegram, package registries and domains listed here (HTTPS only).</p>
      <button className="btn btn-primary" onClick={save}>Save</button>
    </div>
  );
}

// ---------------- Env ----------------
function Env({ botId }: { botId: string }) {
  const { toast, confirm } = useUI(); const { data, err, loading, reload } = useLoad<any>(`/api/bots/${botId}/env`);
  const [k, setK] = useState(""); const [v, setV] = useState("");
  if (loading && !data) return <Spinner />; if (err) return <ErrorBox text={err} />;
  async function save() { try { await api("PUT", `/api/bots/${botId}/env`, { key: k, value: v }); setK(""); setV(""); toast("Saved. Restart the bot to apply."); reload(); } catch (e: any) { toast(e.message, "err"); } }
  return (
    <div className="space-y-3">
      <div className="card space-y-2"><input className="input font-mono" placeholder="NAME" value={k} onChange={(e) => setK(e.target.value)} /><input className="input font-mono" type="password" autoComplete="off" placeholder="value" value={v} onChange={(e) => setV(e.target.value)} /><button className="btn btn-primary" disabled={!k} onClick={save}>Add / update</button><p className="text-xs text-slate-500">Values are encrypted and never shown again. BOT_TOKEN is provided automatically.</p></div>
      {!data.variables.length ? <Empty text="No variables." /> : data.variables.map((x: any) => (
        <div key={x.key} className="card flex items-center justify-between"><div><div className="font-mono text-sm">{x.key}</div><div className="text-xs text-slate-500">{x.preview}</div></div>
          <button className="btn" onClick={async () => { if (await confirm(`Delete ${x.key}?`)) { await api("DELETE", `/api/bots/${botId}/env/${x.key}`); reload(); } }}>Delete</button></div>))}
    </div>
  );
}

// ---------------- Console ----------------
export const ConsolePage = ({ botId }: { botId: string }) => <div className="space-y-2"><H>Console</H><Console botId={botId} /></div>;
function Console({ botId }: { botId: string }) {
  const { toast, confirm } = useUI();
  const [rows, setRows] = useState<any[]>([]); const [streams, setStreams] = useState<Record<string, boolean>>({ system: true, build: true, stdout: true, stderr: true });
  const [q, setQ] = useState(""); const [auto, setAuto] = useState(true); const [note, setNote] = useState(""); const last = useRef(0); const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let es: EventSource | null = null; let dead = false;
    get(`/api/bots/${botId}/logs?limit=300`).then((r) => { if (dead) return; setRows(r.logs); setNote(r.note); last.current = r.logs.at(-1)?.id ?? 0;
      es = new EventSource(`/api/bots/${botId}/logs/stream?after=${last.current}`);
      es.onmessage = (m) => { const row = JSON.parse(m.data); last.current = row.id; setRows((p) => [...p.slice(-1500), row]); };
    }).catch((e) => toast(e.message, "err"));
    return () => { dead = true; es?.close(); };
  }, [botId, toast]);
  useEffect(() => { if (auto && box.current) box.current.scrollTop = box.current.scrollHeight; }, [rows, auto]);
  const shown = rows.filter((r) => streams[r.stream] && (!q || r.text.toLowerCase().includes(q.toLowerCase())));
  const color: Record<string, string> = { stderr: "text-red-400", system: "text-sky-300", build: "text-amber-200", stdout: "text-slate-100" };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {Object.keys(streams).map((s) => <label key={s} className="flex items-center gap-1"><input type="checkbox" checked={streams[s]} onChange={() => setStreams({ ...streams, [s]: !streams[s] })} />{s}</label>)}
        <label className="flex items-center gap-1"><input type="checkbox" checked={auto} onChange={() => setAuto(!auto)} />auto-scroll</label>
        <button className="btn !py-1" onClick={() => setRows([])}>Clear display</button>
        <button className="btn !py-1" onClick={async () => { if (await confirm("Permanently delete stored logs for this bot?")) { await api("DELETE", `/api/bots/${botId}/logs`); setRows([]); } }}>Clear stored logs</button>
      </div>
      <input className="input" placeholder="Filter text…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div ref={box} className="h-96 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-slate-950 p-3 font-mono text-xs">
        {!shown.length && <span className="text-slate-500">No log output yet.</span>}
        {shown.map((r) => <span key={r.id} className={color[r.stream]}><span className="text-slate-600">{new Date(r.ts).toLocaleTimeString()} [{r.stream}] </span>{r.text.endsWith("\n") ? r.text : r.text + "\n"}</span>)}
      </div>
      <p className="text-xs text-slate-500">{note}</p>
    </div>
  );
}

// ---------------- Files ----------------
export const FilesPage = ({ botId }: { botId: string }) => <div className="space-y-2"><H>File Manager</H><Files botId={botId} /></div>;
function Files({ botId }: { botId: string }) {
  const { toast, confirm } = useUI(); const [path, setPath] = useState(""); const { data, err, loading, reload } = useLoad<any>(`/api/bots/${botId}/files/list?path=${encodeURIComponent(path)}`);
  const [open, setOpen] = useState<{ path: string; content: string } | null>(null); const [dirty, setDirty] = useState(false);
  const base = `/api/bots/${botId}/files`; const join = (n: string) => (path ? `${path}/${n}` : n);
  const run = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); if (ok) toast(ok); reload(); } catch (e: any) { toast(e.message, "err"); } };
  async function view(name: string) { try { const r = await get(`${base}/read?path=${encodeURIComponent(join(name))}`); if (r.binary) { window.open(`${base}/download?path=${encodeURIComponent(join(name))}`); return; } setOpen({ path: r.path, content: r.content }); setDirty(false); } catch (e: any) { toast(e.message, "err"); } }
  if (open) return (
    <div className="space-y-2"><div className="flex items-center justify-between"><b className="break-all text-sm">{open.path}</b><button className="btn" onClick={async () => { if (!dirty || await confirm("Discard unsaved changes?")) setOpen(null); }}>Close</button></div>
      <textarea className="input h-96 font-mono text-xs" spellCheck={false} value={open.content} onChange={(e) => { setOpen({ ...open, content: e.target.value }); setDirty(true); }} />
      <button className="btn btn-primary w-full" disabled={!dirty} onClick={() => run(async () => { await api("PUT", `${base}/write`, { path: open.path, content: open.content }); setDirty(false); }, "Saved. Redeploy/restart to run it.")}>Save</button></div>);
  if (loading && !data) return <Spinner />; if (err) return <ErrorBox text={err} />;
  const crumbs = path ? path.split("/") : [];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1 text-sm"><button className="text-brand-600" onClick={() => setPath("")}>root</button>{crumbs.map((c, i) => <span key={i}>/<button className="text-brand-600" onClick={() => setPath(crumbs.slice(0, i + 1).join("/"))}>{c}</button></span>)}</div>
      <div className="flex flex-wrap gap-2">
        <button className="btn" onClick={() => { const n = prompt("New file name"); if (n) run(() => api("PUT", `${base}/write`, { path: join(n), content: "", mustNotExist: true }), "Created"); }}>+ File</button>
        <button className="btn" onClick={() => { const n = prompt("New folder name"); if (n) run(() => api("POST", `${base}/folder`, { path: join(n) }), "Created"); }}>+ Folder</button>
        <label className="btn cursor-pointer">Upload<input type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) run(() => api("POST", `${base}/upload?path=${encodeURIComponent(join(f.name))}`, undefined, f), "Uploaded"); e.target.value = ""; }} /></label>
      </div>
      {!data.entries.length ? <Empty text="Empty folder." /> : data.entries.map((e: any) => (
        <div key={e.name} className="card flex items-center justify-between !p-3">
          <button className="flex-1 truncate text-left" onClick={() => (e.type === "dir" ? setPath(join(e.name)) : view(e.name))}>{e.type === "dir" ? "📁" : "📄"} {e.name} {e.type === "file" && <span className="text-xs text-slate-500">{e.size} B</span>}</button>
          <div className="flex gap-1 text-xs">
            {e.type === "file" && <a className="btn !px-2 !py-1" href={`${base}/download?path=${encodeURIComponent(join(e.name))}`}>⬇</a>}
            <button className="btn !px-2 !py-1" onClick={() => { const n = prompt("Rename to (path in project)", join(e.name)); if (n) run(() => api("POST", `${base}/rename`, { from: join(e.name), to: n }), "Renamed"); }}>✎</button>
            <button className="btn !px-2 !py-1" onClick={async () => { if (await confirm(`Delete ${e.name}?`)) run(() => api("DELETE", `${base}?path=${encodeURIComponent(join(e.name))}`), "Deleted"); }}>🗑</button>
          </div></div>))}
    </div>
  );
}

// ---------------- Deployments ----------------
export function DeploymentsPage({ user }: { user: User }) {
  const staff = user.role === "admin" || user.permissions.includes("deployments.view_all"); const [all, setAll] = useState(false);
  const { data, err, loading } = useLoad<any>(`/api/deployments${all ? "?all=1" : ""}`);
  if (loading) return <Spinner />; if (err) return <ErrorBox text={err} />;
  return (
    <div className="space-y-2"><H>Deployments</H>{staff && <label className="text-sm"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> All users</label>}
      {!data.deployments.length ? <Empty text="No deployments yet." /> : data.deployments.map((d: any) => (
        <a key={d.id} href={`#/bots/${d.bot_id}`} className="card block"><div className="flex justify-between"><b>{d.bot_name}</b><Status s={d.status} /></div>
          <div className="text-xs text-slate-500">{d.kind} · {d.stage ?? "—"} · {fmt(d.queued_at)}</div>{d.error && <div className="mt-1 text-xs text-red-500">{d.error}</div>}</a>))}
    </div>
  );
}

// ---------------- Account ----------------
export function Account({ user }: { user: User }) {
  const { toast } = useUI(); const [cur, setCur] = useState(""); const [nw, setNw] = useState("");
  return (
    <div className="space-y-3"><H>Account Settings</H><div className="card text-sm">{user.email} · {user.role}</div>
      <div className="card space-y-2"><div className="font-medium">Change password</div>
        <input className="input" type="password" autoComplete="current-password" placeholder="Current password" value={cur} onChange={(e) => setCur(e.target.value)} />
        <input className="input" type="password" autoComplete="new-password" placeholder="New password (10+ chars, letters & numbers)" value={nw} onChange={(e) => setNw(e.target.value)} />
        <button className="btn btn-primary" onClick={async () => { try { await post("/api/auth/change-password", { currentPassword: cur, newPassword: nw }); toast("Password changed."); setCur(""); setNw(""); } catch (e: any) { toast(e.message, "err"); } }}>Update</button></div></div>
  );
}

// ---------------- Admin ----------------
const PERMS = ["users.view", "users.manage", "users.suspend", "bots.view_all", "bots.manage_all", "deployments.view_all", "settings.manage", "audit.view", "killswitch.use", "subadmins.manage"];
export function AdminPanel({ user }: { user: User }) {
  const has = (p: string) => user.role === "admin" || user.permissions.includes(p);
  const [tab, setTab] = useState(has("users.view") ? "users" : has("settings.manage") ? "system" : "audit");
  return (
    <div className="space-y-3"><H>Admin Panel</H>
      <div className="flex gap-1 overflow-x-auto">{[["users", "users.view"], ["system", "settings.manage"], ["audit", "audit.view"]].filter(([, p]) => has(p)).map(([t]) => <button key={t} className={`btn ${tab === t ? "btn-primary" : ""}`} onClick={() => setTab(t)}>{t}</button>)}</div>
      {tab === "users" && <Users has={has} />}{tab === "system" && <System has={has} />}{tab === "audit" && <Audit />}
    </div>
  );
}
function Users({ has }: { has: (p: string) => boolean }) {
  const { toast } = useUI(); const { data, err, loading, reload } = useLoad<any>("/api/admin/users");
  const [f, setF] = useState({ email: "", password: "", role: "user", permissions: [] as string[] });
  if (loading && !data) return <Spinner />; if (err) return <ErrorBox text={err} />;
  const patch = async (id: string, body: object) => { try { await api("PATCH", `/api/admin/users/${id}`, body); reload(); } catch (e: any) { toast(e.message, "err"); } };
  return (
    <div className="space-y-3">
      {has("users.manage") && <div className="card space-y-2"><div className="font-medium">Create user</div>
        <input className="input" placeholder="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /><input className="input" type="password" autoComplete="new-password" placeholder="Password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        <select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option>user</option>{has("subadmins.manage") && <><option>subadmin</option><option>admin</option></>}</select>
        {f.role === "subadmin" && <div className="grid grid-cols-2 gap-1 text-xs">{PERMS.map((p) => <label key={p}><input type="checkbox" checked={f.permissions.includes(p)} onChange={() => setF({ ...f, permissions: f.permissions.includes(p) ? f.permissions.filter((x) => x !== p) : [...f.permissions, p] })} /> {p}</label>)}</div>}
        <button className="btn btn-primary" onClick={async () => { try { await post("/api/admin/users", f); toast("User created."); setF({ email: "", password: "", role: "user", permissions: [] }); reload(); } catch (e: any) { toast(e.message, "err"); } }}>Create</button></div>}
      {data.users.map((u: any) => (
        <div key={u.id} className="card space-y-1 text-sm"><div className="flex justify-between"><b className="truncate">{u.email}</b><span className="badge bg-slate-200 dark:bg-slate-800">{u.role}</span></div>
          <div className="text-xs text-slate-500">{u.status} · {u.bots}/{u.bot_quota} bots · last login {fmt(u.last_login_at)}</div>
          {u.role === "subadmin" && <div className="text-xs">perms: {u.permissions.join(", ") || "none"}</div>}
          <div className="flex flex-wrap gap-2">
            {has("users.suspend") && <button className="btn !py-1" onClick={() => patch(u.id, { status: u.status === "active" ? "suspended" : "active" })}>{u.status === "active" ? "Suspend" : "Activate"}</button>}
            {has("users.manage") && <button className="btn !py-1" onClick={() => { const n = prompt("Bot quota (0–50)", String(u.bot_quota)); if (n !== null) patch(u.id, { botQuota: Number(n) }); }}>Quota</button>}
            {has("subadmins.manage") && u.role === "subadmin" && <button className="btn !py-1" onClick={() => { const n = prompt(`Permissions, comma-separated:\n${PERMS.join(", ")}`, u.permissions.join(", ")); if (n !== null) patch(u.id, { permissions: n.split(",").map((s) => s.trim()).filter(Boolean) }); }}>Permissions</button>}
          </div></div>))}
    </div>
  );
}
function System({ has }: { has: (p: string) => boolean }) {
  const { toast, confirm } = useUI(); const ov = useLoad<any>("/api/admin/overview"); const st = useLoad<any>("/api/admin/settings");
  if ((ov.loading && !ov.data) || (st.loading && !st.data)) return <Spinner />; if (ov.err) return <ErrorBox text={ov.err} />;
  const o = ov.data, s = st.data?.settings ?? {};
  const set = async (key: string, value: unknown) => { try { await api("PUT", "/api/admin/settings", { key, value }); st.reload(); toast("Saved."); } catch (e: any) { toast(e.message, "err"); } };
  return (
    <div className="space-y-3">
      <div className="card text-sm space-y-1"><div>Runtime: <b>{o.runtime.ok ? "available" : "unavailable"}</b> {o.runtime.reason && <span className="text-red-500">{o.runtime.reason}</span>}</div>
        <div>Users {o.counts.users} · Bots {o.counts.bots} · Running {o.counts.running} · Live sandboxes {o.counts.sandboxes}</div></div>
      <div className={`card text-sm ${o.costEstimate.overWarning ? "border-red-400" : ""}`}><div className="font-medium">Cost estimate (this month): ${o.costEstimate.monthToDateUsd}</div><p className="text-xs text-slate-500">{o.costEstimate.disclaimer}</p></div>
      {has("killswitch.use") && <div className="card space-y-2"><div className="font-medium">Kill switch {o.killSwitch ? "🔴 ACTIVE" : "🟢 off"}</div>
        {o.killSwitch ? <button className="btn" onClick={async () => { await post("/api/admin/killswitch/reset"); ov.reload(); }}>Re-enable deployments</button>
          : <button className="btn btn-danger" onClick={async () => { if (await confirm("Terminate ALL sandboxes and block new deployments?")) { const r = await post("/api/admin/killswitch"); toast(`${r.terminated} sandbox(es) terminated.`); ov.reload(); } }}>Stop everything now</button>}</div>}
      <div className="card space-y-2 text-sm"><div className="font-medium">Limits</div>
        {([["max_concurrent_sandboxes", "Max concurrent sandboxes"], ["default_bot_quota", "Default bot quota"], ["max_run_hours", "Auto-stop any sandbox after running (hours, 0=off)"], ["auto_release_minutes", "Auto-release stopped sandboxes after (min, 0=off)"], ["budget_warning_usd", "Cost warning at ($)"]] as const).map(([k, l]) => (
          <div key={k} className="flex items-center justify-between gap-2"><span>{l}</span><input className="input !w-24" type="number" defaultValue={s[k]} onBlur={(e) => Number(e.target.value) !== s[k] && set(k, Number(e.target.value))} /></div>))}
        <label className="flex justify-between"><span>Open registration</span><input type="checkbox" checked={!!s.registration_open} onChange={(e) => set("registration_open", e.target.checked)} /></label>
        <div><span>Allowed plans:</span> {["1c-2g", "2c-4g", "4c-8g", "8c-16g"].map((p) => <label key={p} className="ml-2"><input type="checkbox" checked={(s.allowed_plans ?? []).includes(p)} onChange={(e) => set("allowed_plans", e.target.checked ? [...(s.allowed_plans ?? []), p] : (s.allowed_plans ?? []).filter((x: string) => x !== p))} /> {p}</label>)}</div></div>
    </div>
  );
}
function Audit() {
  const { data, err, loading } = useLoad<any>("/api/admin/audit?limit=200");
  if (loading) return <Spinner />; if (err) return <ErrorBox text={err} />;
  return <div className="space-y-1">{data.audit.map((a: any) => <div key={a.id} className="card !p-2 text-xs"><b>{a.action}</b> · {a.actor_email ?? "system"} · {fmt(a.ts)}<div className="break-all text-slate-500">{a.target_type} {a.target_id} {JSON.stringify(a.detail)}</div></div>)}</div>;
}
