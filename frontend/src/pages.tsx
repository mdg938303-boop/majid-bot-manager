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
function Steps({ done }: { done: boolean[] }) {
  const items = ["Add your bot (token from @BotFather)", "Upload your project ZIP", "Deploy and check the Console", "Message your bot on Telegram"];
  return (
    <div className="card space-y-2">
      <div className="font-medium">Get started in 4 steps</div>
      {items.map((t, i) => (
        <div key={t} className="flex items-center gap-3 text-sm">
          <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${done[i] ? "bg-emerald-500 text-white" : "bg-slate-200 dark:bg-slate-700"}`}>{done[i] ? "✓" : i + 1}</span>
          <span className={done[i] ? "text-slate-500 line-through" : ""}>{t}</span>
        </div>
      ))}
    </div>
  );
}

export function Dashboard({ user }: { user: User }) {
  const bots = useLoad<{ bots: any[] }>("/api/bots"); const rt = useLoad<{ ok: boolean; reason?: string }>("/api/runtime");
  if (bots.loading) return <Spinner />; if (bots.err) return <ErrorBox text={bots.err} />;
  const list = bots.data!.bots; const n = (s: string) => list.filter((b) => b.status === s).length;
  const first = list[0];
  const live = n("running") + n("deploying") + n("queued");
  return (
    <div className="space-y-4">
      <H>Welcome{user.displayName ? `, ${user.displayName}` : ""} 👋</H>
      {rt.data && !rt.data.ok && <div className="card border-amber-400 text-sm"><b>Bots can't be deployed right now.</b> The execution runtime isn't available.<div className="mt-1 text-slate-500">{rt.data.reason}</div></div>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[["My bots", list.length, ""], ["Running", n("running"), "text-emerald-600"], ["Need attention", n("failed"), n("failed") ? "text-red-600" : ""], ["Bot limit", `${list.length}/${user.role === "admin" ? "∞" : user.botQuota}`, ""]].map(([k, v, c]) => (
          <div key={String(k)} className="card"><div className="text-xs text-slate-500">{k}</div><div className={`text-2xl font-bold ${c}`}>{v}</div></div>
        ))}
      </div>
      {live > 0 && <div className="card border-amber-300 text-sm">💡 {live} bot{live > 1 ? "s are" : " is"} using a sandbox that costs credit while it runs. Use <b>Free sandbox</b> on the bot page when you're done testing.</div>}
      {!list.length || !first?.fileCount ? <Steps done={[list.length > 0, !!first?.fileCount, !!first?.lastDeployedAt, first?.status === "running"]} /> : null}
      {list.length > 0 && <div className="space-y-2"><div className="text-sm font-medium text-slate-500">Your bots</div>
        {list.slice(0, 5).map((b) => (
          <a key={b.id} href={`#/bots/${b.id}`} className="card flex items-center justify-between">
            <div><b>{b.name}</b><div className="text-xs text-slate-500">@{b.telegramUsername} · {b.language ?? "no project yet"}</div></div><Status s={b.status} />
          </a>))}</div>}
      <a className="btn btn-primary w-full sm:w-auto" href="#/new">+ Add new bot</a>
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
const HELP: Record<string, string> = {
  created: "Bot added. Next step: upload your project ZIP below.",
  queued: "Waiting in line to deploy. This usually takes a few seconds.",
  deploying: "Deploying now. Open the Console tab to watch the progress.",
  running: "Your bot is running. Send it a message on Telegram to test it.",
  stopped: "Stopped. Press Start to run it again. The sandbox is released automatically after a while to save credit.",
  failed: "Something went wrong. Open the Console tab to see the exact error, fix it, then press Redeploy.",
  released: "Sandbox released to save credit. Press Start to run it again (takes about a minute).",
};

export function BotDetail({ id, user }: { id: string; user: User }) {
  const { toast, confirm } = useUI(); const [tab, setTab] = useState("overview");
  const { data, err, loading, reload } = useLoad<any>(`/api/bots/${id}`);
  const [proc, setProc] = useState<any>(null); const [busy, setBusy] = useState("");
  const [phase, setPhase] = useState<string | null>(null);
  const check = useCallback(() => get(`/api/bots/${id}/process`).then(setProc).catch(() => setProc(null)), [id]);
  useEffect(() => { check(); }, [check, data]);
  useEffect(() => { const t = setInterval(() => { if (["queued", "deploying"].includes(data?.bot?.status)) reload(); }, 3000); return () => clearInterval(t); }, [data, reload]);
  if (loading && !data) return <Spinner />; if (err) return <ErrorBox text={err} />;
  const bot = data.bot; const hasProject = (data.project?.file_count ?? 0) > 0; const st = bot.status as string;
  const busyNow = ["queued", "deploying"].includes(st);
  async function act(name: string, path: string, method = "POST", ask?: string) {
    if (ask && !(await confirm(ask))) return;
    setBusy(name);
    try { const r = await api(method, `/api/bots/${id}${path}`, {}); toast(r.queued ? "Deployment started. Open the Console tab to watch." : `${name} done.`); if (method === "DELETE") location.hash = "#/bots"; else { reload(); check(); } }
    catch (e: any) { toast(e.message, "err"); } finally { setBusy(""); }
  }
  async function upload(file: File) {
    setBusy("upload"); setPhase("Checking your ZIP…");
    try { const r = await api("POST", `/api/bots/${id}/upload?deploy=1&name=${encodeURIComponent(file.name)}`, undefined, file); toast(`Detected ${r.manifest.language} (${r.fileCount} files). Deploying…`); setTab("console"); reload(); }
    catch (e: any) { toast(e.message, "err"); } finally { setBusy(""); setPhase(null); }
  }
  const btn = (label: string, name: string, path: string, cls = "", method = "POST", ask?: string) => (
    <button key={name} className={`btn ${cls}`} disabled={!!busy || busyNow} onClick={() => act(name, path, method, ask)}>{busy === name ? "Please wait…" : label}</button>
  );
  const steps = [["Bot added", true], ["ZIP uploaded", hasProject], ["Deployed", !!bot.lastDeployedAt], ["Running", st === "running"]] as const;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2"><div className="min-w-0"><H>{bot.name}</H><a className="text-xs text-brand-600" href={`https://t.me/${bot.telegramUsername}`} target="_blank" rel="noreferrer">@{bot.telegramUsername} ↗</a></div><Status s={st} /></div>
      <div className="flex gap-1 overflow-x-auto pb-1">{[["overview", "Overview"], ["console", "Console"], ["files", "Files"], ["env", "Variables"], ["settings", "Settings"]].map(([t, l]) => <button key={t} className={`btn whitespace-nowrap ${tab === t ? "btn-primary" : ""}`} onClick={() => setTab(t)}>{l}</button>)}</div>
      {tab === "overview" && (<>
        <div className={`card text-sm ${st === "failed" ? "border-red-300" : st === "running" ? "border-emerald-300" : ""}`}>
          <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">{steps.map(([l, ok]) => <span key={l} className={ok ? "text-emerald-600" : "text-slate-400"}>{ok ? "✓" : "○"} {l}</span>)}</div>
          <p>{HELP[st] ?? ""}</p>
          {data.latestDeployment?.error && st === "failed" && <p className="mt-2 break-words rounded-lg bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">{data.latestDeployment.error}</p>}
          {bot.warnings?.map((w: string) => <p key={w} className="mt-1 text-xs text-amber-600">⚠ {w}</p>)}
          {st === "running" && <p className="mt-2 text-xs text-amber-600">💡 The sandbox costs credit while running. Press “Free sandbox” when you finish testing.</p>}
        </div>
        {!hasProject && (
          <div className="card space-y-2 border-dashed">
            <div className="font-medium">Step 2: upload your project</div>
            <p className="text-xs text-slate-500">A .zip with your bot code (Python, Node.js or PHP). Dependencies are installed automatically.</p>
            <label className="btn btn-primary w-full cursor-pointer">{busy === "upload" ? phase : "Choose ZIP file"}<input type="file" accept=".zip" hidden disabled={!!busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} /></label>
          </div>)}
        {hasProject && (<>
          <div className="grid grid-cols-2 gap-2">
            {st === "running" ? btn("■ Stop bot", "Stop", "/stop") : btn("▶ Start bot", "Start", "/start", "btn-primary")}
            {btn("↻ Restart", "Restart", "/restart")}
          </div>
          <details className="card !p-3"><summary className="cursor-pointer text-sm font-medium">More actions</summary>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {btn("Redeploy", "Redeploy", "/redeploy")}{btn("Rebuild", "Rebuild", "/rebuild")}
              {btn("Free sandbox", "Release", "/release", "", "POST", "Terminate the sandbox to stop billing? You can start the bot again later.")}
              <label className="btn cursor-pointer">Upload new ZIP<input type="file" accept=".zip" hidden disabled={!!busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} /></label>
              <a className="btn col-span-2" href={`/api/bots/${id}/files/download-project`}>Download project (.tar.gz)</a>
              {btn("Delete bot", "Delete", "", "btn-danger col-span-2", "DELETE", "Delete this bot, its files and logs permanently?")}
            </div></details>
        </>)}
        <div className="card space-y-1 text-xs text-slate-500">
          <div>Language: <b className="text-slate-700 dark:text-slate-300">{bot.language ?? "—"}</b> · Entry: {bot.entryPoint ?? "—"} · Files: {data.project?.file_count ?? 0}</div>
          <div>Last deployed: {fmt(bot.lastDeployedAt)}</div>
          <div>Live check: {proc ? <>sandbox <b>{proc.sandbox ?? "none"}</b>, process <b>{proc.process ?? "n/a"}</b></> : "…"} <button className="text-brand-600" onClick={check}>refresh</button></div>
        </div>
      </>)}
      {tab === "console" && <Console botId={id} />}
      {tab === "files" && <Files botId={id} />}
      {tab === "env" && <Env botId={id} />}
      {tab === "settings" && <BotSettings bot={bot} reload={reload} user={user} />}
    </div>
  );
}

function TokenCard({ bot, reload }: { bot: any; reload: () => void }) {
  const { toast, confirm } = useUI(); const [token, setToken] = useState(""); const [busy, setBusy] = useState(false);
  async function change(allowDifferent = false): Promise<void> {
    setBusy(true);
    try {
      const r = await api("PUT", `/api/bots/${bot.id}/token`, { token, allowDifferent });
      toast(r.applied === "restarted" ? `Token changed. Bot restarted as @${r.telegramUsername}.` : r.applied === "saved_restart_failed" ? "Token saved, but the restart failed. Press Restart." : `Token saved for @${r.telegramUsername}. It applies when you press Start.`, r.applied === "saved_restart_failed" ? "err" : "ok");
      setToken(""); reload();
    } catch (e: any) {
      if (String(e.message).startsWith("This token belongs to a different") && !allowDifferent) { setBusy(false); if (await confirm(e.message)) return change(true); return; }
      toast(e.message, "err");
    } finally { setBusy(false); }
  }
  return (
    <div className="card space-y-2">
      <div className="font-medium">Change bot token</div>
      <p className="text-xs text-slate-500">Paste the new token from @BotFather (after /revoke). It is verified with Telegram, stored encrypted{bot.status === "running" ? ", and the running bot restarts automatically with it" : ""}.</p>
      <input className="input" type="password" autoComplete="off" placeholder="New bot token" value={token} onChange={(e) => setToken(e.target.value)} />
      <button className="btn btn-primary" disabled={busy || !token} onClick={() => change()}>{busy ? "Verifying…" : "Verify and change token"}</button>
    </div>
  );
}

function BotSettings({ bot, reload }: { bot: any; reload: () => void; user: User }) {
  const { toast } = useUI(); const [name, setName] = useState(bot.name); const [entry, setEntry] = useState(""); const [dom, setDom] = useState((bot.egressDomains ?? []).join("\n"));
  async function save() { try { await api("PATCH", `/api/bots/${bot.id}`, { name, egressDomains: dom.split(/\s+/).filter(Boolean), ...(entry ? { entryPoint: entry } : {}) }); toast("Saved. Redeploy to apply network changes."); reload(); } catch (e: any) { toast(e.message, "err"); } }
  return (
    <div className="space-y-3">
      <TokenCard bot={bot} reload={reload} />
      <div className="card space-y-3">
        <div className="font-medium">Bot settings</div>
        <label className="text-sm">Name<input className="input mt-1" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="text-sm">Entry point (optional)<input className="input mt-1" placeholder={bot.entryPoint ?? "main.py"} value={entry} onChange={(e) => setEntry(e.target.value)} /></label>
        <label className="text-sm">Extra websites the bot may call (one per line)<textarea className="input mt-1 h-24 font-mono" placeholder="api.openai.com" value={dom} onChange={(e) => setDom(e.target.value)} /></label>
        <p className="text-xs text-slate-500">By default a bot can only reach Telegram and package registries. Add any other API your bot uses here, then Redeploy.</p>
        <button className="btn btn-primary" onClick={save}>Save</button>
      </div>
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
  const [tab, setTab] = useState(has("settings.manage") ? "overview" : has("users.view") ? "users" : has("bots.view_all") ? "bots" : "audit");
  return (
    <div className="space-y-3"><H>Admin Panel</H>
      <div className="flex gap-1 overflow-x-auto">{[["overview", "Overview", "settings.manage"], ["users", "Users", "users.view"], ["bots", "All bots", "bots.view_all"], ["limits", "Limits", "settings.manage"], ["audit", "Activity log", "audit.view"]].filter(([, , p]) => has(p)).map(([t, l]) => <button key={t} className={`btn whitespace-nowrap ${tab === t ? "btn-primary" : ""}`} onClick={() => setTab(t)}>{l}</button>)}</div>
      {tab === "overview" && <System has={has} part="overview" />}{tab === "limits" && <System has={has} part="limits" />}
      {tab === "users" && <Users has={has} />}{tab === "bots" && <AllBots has={has} />}{tab === "audit" && <Audit />}
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
function System({ has, part }: { has: (p: string) => boolean; part: "overview" | "limits" }) {
  const { toast, confirm } = useUI(); const ov = useLoad<any>("/api/admin/overview"); const st = useLoad<any>("/api/admin/settings");
  if ((ov.loading && !ov.data) || (st.loading && !st.data)) return <Spinner />; if (ov.err) return <ErrorBox text={ov.err} />;
  const o = ov.data, s = st.data?.settings ?? {};
  const set = async (key: string, value: unknown) => { try { await api("PUT", "/api/admin/settings", { key, value }); st.reload(); toast("Saved."); } catch (e: any) { toast(e.message, "err"); } };
  if (part === "overview") return (
    <div className="space-y-3">
      <div className={`card text-sm ${o.runtime.ok ? "border-emerald-300" : "border-red-300"}`}>
        <b>{o.runtime.ok ? "✓ Bot runtime is ready" : "✕ Bot runtime is not available"}</b>
        {!o.runtime.ok && <p className="mt-1 text-xs text-red-600">{o.runtime.reason}</p>}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[["Users", o.counts.users], ["Bots", o.counts.bots], ["Running", o.counts.running], ["Live sandboxes", o.counts.sandboxes]].map(([k, v]) => <div key={String(k)} className="card"><div className="text-xs text-slate-500">{k}</div><div className="text-2xl font-bold">{v}</div></div>)}
      </div>
      <div className={`card text-sm ${o.costEstimate.overWarning ? "border-red-400" : ""}`}>
        <div className="text-xs text-slate-500">Estimated sandbox cost this month</div><div className="text-2xl font-bold">${o.costEstimate.monthToDateUsd}</div>
        <p className="mt-1 text-xs text-slate-500">{o.costEstimate.disclaimer}</p>
      </div>
      {has("killswitch.use") && <div className={`card space-y-2 ${o.killSwitch ? "border-red-400" : ""}`}>
        <div className="font-medium">Emergency stop {o.killSwitch ? "· 🔴 ACTIVE" : "· 🟢 off"}</div>
        <p className="text-xs text-slate-500">{o.killSwitch ? "All sandboxes were stopped and new deployments are blocked." : "Instantly stops every running bot and blocks new deployments. Use it if costs get out of control."}</p>
        {o.killSwitch ? <button className="btn btn-primary" onClick={async () => { await post("/api/admin/killswitch/reset"); ov.reload(); toast("Deployments enabled again."); }}>Re-enable deployments</button>
          : <button className="btn btn-danger" onClick={async () => { if (await confirm("Stop ALL bots and terminate every sandbox now?")) { const r = await post("/api/admin/killswitch"); toast(`${r.terminated} sandbox(es) stopped.`); ov.reload(); } }}>Stop everything now</button>}
      </div>}
    </div>
  );
  const rows = [["max_concurrent_sandboxes", "Max bots running at once", "Each running bot costs credit."], ["default_bot_quota", "Bots per new user", ""], ["max_run_hours", "Auto-stop a sandbox after (hours)", "0 = never. Saves credit."], ["auto_release_minutes", "Free a stopped bot's sandbox after (minutes)", "0 = never."], ["budget_warning_usd", "Warn me at ($)", ""]] as const;
  return (
    <div className="card space-y-4 text-sm"><div className="font-medium">Limits and cost controls</div>
      {rows.map(([k, l, hint]) => (
        <div key={k} className="flex items-center justify-between gap-3"><div><div>{l}</div>{hint && <div className="text-xs text-slate-500">{hint}</div>}</div>
          <input className="input !w-24" type="number" defaultValue={s[k]} onBlur={(e) => Number(e.target.value) !== s[k] && set(k, Number(e.target.value))} /></div>))}
      <label className="flex items-center justify-between"><span>Allow new people to register</span><input type="checkbox" checked={!!s.registration_open} onChange={(e) => set("registration_open", e.target.checked)} /></label>
      <div><div className="mb-1">Allowed sandbox sizes</div>{["1c-2g", "2c-4g", "4c-8g", "8c-16g"].map((p) => <label key={p} className="mr-3"><input type="checkbox" checked={(s.allowed_plans ?? []).includes(p)} onChange={(e) => set("allowed_plans", e.target.checked ? [...(s.allowed_plans ?? []), p] : (s.allowed_plans ?? []).filter((x: string) => x !== p))} /> {p}</label>)}<p className="text-xs text-slate-500">Bigger sizes cost more. Keep only 1c-2g to stay cheap.</p></div>
    </div>
  );
}
function AllBots({ has }: { has: (p: string) => boolean }) {
  const { toast, confirm } = useUI(); const { data, err, loading, reload } = useLoad<any>("/api/bots?all=1"); const [q, setQ] = useState("");
  if (loading && !data) return <Spinner />; if (err) return <ErrorBox text={err} />;
  const bots = data.bots.filter((b: any) => (b.name + b.telegramUsername + (b.ownerEmail ?? "")).toLowerCase().includes(q.toLowerCase()));
  const act = async (id: string, path: string, ask: string) => { if (!(await confirm(ask))) return; try { await post(`/api/bots/${id}${path}`); toast("Done."); reload(); } catch (e: any) { toast(e.message, "err"); } };
  return (
    <div className="space-y-2"><input className="input" placeholder="Search bot, @username or owner…" value={q} onChange={(e) => setQ(e.target.value)} />
      {!bots.length ? <Empty text="No bots found." /> : bots.map((b: any) => (
        <div key={b.id} className="card space-y-2"><div className="flex items-center justify-between"><a href={`#/bots/${b.id}`} className="font-medium text-brand-600">{b.name}</a><Status s={b.status} /></div>
          <div className="text-xs text-slate-500">@{b.telegramUsername} · owner {b.ownerEmail} · {b.language ?? "no project"}</div>
          {has("bots.manage_all") && b.sandboxId && <div className="flex gap-2"><button className="btn !py-1 text-xs" onClick={() => act(b.id, "/stop", `Stop ${b.name}?`)}>Stop</button><button className="btn !py-1 text-xs" onClick={() => act(b.id, "/release", `Free the sandbox of ${b.name}?`)}>Free sandbox</button></div>}
        </div>))}
    </div>
  );
}
function Audit() {
  const { data, err, loading } = useLoad<any>("/api/admin/audit?limit=200");
  if (loading) return <Spinner />; if (err) return <ErrorBox text={err} />;
  return <div className="space-y-1">{data.audit.map((a: any) => <div key={a.id} className="card !p-2 text-xs"><b>{a.action}</b> · {a.actor_email ?? "system"} · {fmt(a.ts)}<div className="break-all text-slate-500">{a.target_type} {a.target_id} {JSON.stringify(a.detail)}</div></div>)}</div>;
}
