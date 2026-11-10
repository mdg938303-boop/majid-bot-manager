import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { t } from "./i18n";

type Toast = { id: number; text: string; kind: "ok" | "err" };
const ToastCtx = createContext<{ toast: (text: string, k?: "ok" | "err") => void; confirm: (msg: string) => Promise<boolean> }>({ toast: () => {}, confirm: async () => false });
export const useUI = () => useContext(ToastCtx);

export function UIProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dlg, setDlg] = useState<{ msg: string; res: (v: boolean) => void } | null>(null);
  const toast = useCallback((text: string, kind: "ok" | "err" = "ok") => {
    const id = Date.now() + Math.random(); setToasts((xs) => [...xs, { id, text, kind }]);
    setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== id)), 5000);
  }, []);
  const confirm = useCallback((msg: string) => new Promise<boolean>((res) => setDlg({ msg, res })), []);
  return (
    <ToastCtx.Provider value={{ toast, confirm }}>
      {children}
      <div className="fixed inset-x-3 top-3 z-50 space-y-2 sm:left-auto sm:w-96">
        {toasts.map((x) => (
          <div key={x.id} role="status" className={`rounded-xl px-4 py-3 text-sm text-white shadow-lg ${x.kind === "ok" ? "bg-emerald-600" : "bg-red-600"}`}>{t(x.text)}</div>
        ))}
      </div>
      {dlg && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center">
          <div className="card w-full max-w-sm">
            <p className="mb-4 text-sm">{t(dlg.msg)}</p>
            <div className="flex justify-end gap-2">
              <button className="btn" onClick={() => { dlg.res(false); setDlg(null); }}>{t("Cancel")}</button>
              <button className="btn btn-danger" onClick={() => { dlg.res(true); setDlg(null); }}>{t("Confirm")}</button>
            </div>
          </div>
        </div>
      )}
    </ToastCtx.Provider>
  );
}

export const STATUS_STYLE: Record<string, string> = {
  running: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  deploying: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  queued: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  stopped: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  released: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  created: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  succeeded: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  cancelled: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};
export const Status = ({ s }: { s: string }) => <span className={`badge ${STATUS_STYLE[s] ?? STATUS_STYLE.created}`}>{t(s)}</span>;
export const Spinner = () => <div className="p-6 text-center text-sm text-slate-500" aria-busy="true">{t("Loading…")}</div>;
export const Empty = ({ text }: { text: string }) => <div className="card text-center text-sm text-slate-500">{t(text)}</div>;
export const ErrorBox = ({ text }: { text: string }) => <div className="card border-red-300 text-sm text-red-600 dark:border-red-800 dark:text-red-400">{t(text)}</div>;
