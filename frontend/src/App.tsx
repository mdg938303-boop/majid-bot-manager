import { useCallback, useEffect, useState } from "react";
import { get, post, setCsrf } from "./api";
import { UIProvider, useUI, Spinner } from "./ui";
import { getLang, setLang, t, type Lang } from "./i18n";
import { AddBot, AdminPanel, BotDetail, BotPicker, BotsList, Account, ConsolePage, Dashboard, DeploymentsPage, FilesPage } from "./pages";

export interface User { id: string; email: string; role: "admin" | "subadmin" | "user"; permissions: string[]; displayName: string; botQuota: number }

function LangButton({ onLang }: { onLang: (l: Lang) => void }) {
  const l = getLang();
  return <button className="btn flex-1" onClick={() => onLang(l === "bn" ? "en" : "bn")}>{l === "bn" ? "English" : "বাংলা"}</button>;
}

function Auth({ onAuth, onLang }: { onAuth: (u: User) => void; onLang: (l: Lang) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [busy, setBusy] = useState(false);
  const { toast } = useUI();
  async function submit() {
    setBusy(true);
    try { const r = await post(`/api/auth/${mode}`, { email, password }); setCsrf(r.csrf); onAuth(r.user); }
    catch (e: any) { toast(e.message, "err"); } finally { setBusy(false); }
  }
  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-4">
      <div className="flex justify-end"><LangButton onLang={onLang} /></div>
      <div className="text-center"><div className="text-3xl font-bold text-brand-600">{t("Majid Bot Manager")}</div><p className="text-sm text-slate-500">{t("Host and manage your Telegram bots")}</p></div>
      <div className="card space-y-3">
        <input className="input" type="email" autoComplete="username" placeholder={t("Email")} value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="input" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder={t("Password")} value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        <button className="btn btn-primary w-full" disabled={busy || !email || !password} onClick={submit}>{busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}</button>
        <button className="w-full text-sm text-brand-600" onClick={() => setMode(mode === "login" ? "register" : "login")}>{mode === "login" ? "Need an account? Register" : "Have an account? Sign in"}</button>
        {mode === "register" && <p className="text-xs text-slate-500">{t("Password: at least 10 characters with letters and numbers.")}</p>}
      </div>
    </div>
  );
}

const NAV = [
  ["dashboard", "Dashboard"], ["bots", "My Bots"], ["new", "Add New Bot"], ["deployments", "Deployments"],
  ["files", "File Manager"], ["console", "Console"], ["account", "Account Settings"],
] as const;

function Shell({ user, onLogout, onLang }: { user: User; onLogout: () => void; onLang: (l: Lang) => void }) {
  const [route, setRoute] = useState(location.hash.slice(2) || "dashboard");
  const [open, setOpen] = useState(false);
  const [dark, setDark] = useState(localStorage.getItem("theme") !== "light");
  useEffect(() => { const f = () => { setRoute(location.hash.slice(2) || "dashboard"); setOpen(false); }; addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  useEffect(() => { document.documentElement.classList.toggle("dark", dark); localStorage.setItem("theme", dark ? "dark" : "light"); }, [dark]);
  const isStaff = user.role === "admin" || user.role === "subadmin";
  const [seg, id, sub] = route.split("/");
  let page;
  if (seg === "bots" && id) page = <BotDetail id={id} user={user} />;
  else if (seg === "bots") page = <BotsList user={user} />;
  else if (seg === "new") page = <AddBot />;
  else if (seg === "deployments") page = <DeploymentsPage user={user} />;
  else if (seg === "files") page = id ? <FilesPage botId={id} /> : <BotPicker title={t("File Manager")} base="files" />;
  else if (seg === "console") page = id ? <ConsolePage botId={id} /> : <BotPicker title={t("Console")} base="console" />;
  else if (seg === "account") page = <Account user={user} />;
  else if (seg === "admin" && isStaff) page = <AdminPanel user={user} />;
  else page = <Dashboard user={user} />;
  void sub;
  const items = [...NAV, ...(isStaff ? [["admin", "Admin Panel"] as const] : [])];
  return (
    <div className="min-h-screen lg:flex">
      <header className="sticky top-0 z-30 flex items-center justify-between bg-brand-600 px-4 py-3 text-white lg:hidden">
        <button aria-label={t("Menu")} className="text-2xl" onClick={() => setOpen(!open)}>☰</button>
        <span className="font-semibold">{t("Majid Bot Manager")}</span><span className="w-6" />
      </header>
      <nav className={`${open ? "block" : "hidden"} fixed inset-x-0 top-12 z-20 max-h-[80vh] overflow-auto border-b bg-white p-3 shadow-lg dark:border-slate-800 dark:bg-slate-900 lg:static lg:block lg:min-h-screen lg:w-64 lg:max-h-none lg:border-r lg:shadow-none`}>
        <div className="mb-4 hidden px-3 text-xl font-bold text-brand-600 lg:block">{t("Majid Bot Manager")}</div>
        {items.map(([k, label]) => (
          <a key={k} href={`#/${k}`} className={`block rounded-xl px-3 py-3 text-sm font-medium ${seg === k || (!seg && k === "dashboard") ? "bg-brand-600 text-white" : "hover:bg-slate-100 dark:hover:bg-slate-800"}`}>{t(label)}</a>
        ))}
        <div className="mt-4 flex gap-2 border-t pt-3 dark:border-slate-800">
          <LangButton onLang={onLang} />
          <button className="btn flex-1" onClick={() => setDark(!dark)}>{dark ? t("☀ Light") : t("🌙 Dark")}</button>
          <button className="btn flex-1" onClick={onLogout}>{t("Sign out")}</button>
        </div>
        <div className="mt-2 truncate px-1 text-xs text-slate-500">{user.email} · {user.role}</div>
      </nav>
      <main className="mx-auto w-full max-w-5xl flex-1 p-3 pb-24 sm:p-6 lg:pb-6">{page}</main>
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] dark:border-slate-800 dark:bg-slate-900 lg:hidden" aria-label={t("Quick navigation")}>
        {[["dashboard", "🏠", "Home"], ["bots", "🤖", "My bots"], ["new", "➕", "Add bot"], ["console", "📟", "Console"]].map(([k, icon, label]) => (
          <a key={k} href={`#/${k}`} className={`flex flex-col items-center py-2 text-[11px] ${seg === k || (!seg && k === "dashboard") ? "font-semibold text-brand-600" : "text-slate-500"}`}><span className="text-lg leading-none">{icon}</span>{t(label)}</a>
        ))}
      </nav>
    </div>
  );
}

function Root() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => { get("/api/auth/me").then((r) => { if (r.csrf) setCsrf(r.csrf); setUser(r.user); }).catch(() => setUser(null)); }, []);
  const logout = useCallback(async () => { await post("/api/auth/logout").catch(() => undefined); setUser(null); location.hash = ""; }, []);
  const [lang, setL] = useState<Lang>(getLang());
  const onLang = useCallback((l: Lang) => { setLang(l); setL(l); }, []);
  if (user === undefined) return <Spinner />;
  return <div key={lang}>{user ? <Shell user={user} onLogout={logout} onLang={onLang} /> : <Auth onAuth={setUser} onLang={onLang} />}</div>;
}
export const App = () => <UIProvider><Root /></UIProvider>;
