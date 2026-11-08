export interface TelegramBotInfo { id: number; username: string; first_name: string }
export const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,50}$/;

/** Verifies a bot token with Telegram's official getMe endpoint. */
export async function verifyBotToken(token: string, fetchImpl: typeof fetch = fetch): Promise<TelegramBotInfo> {
  if (!TOKEN_RE.test(token)) throw new Error("Token format is invalid.");
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok || !body.result?.username) throw new Error("Telegram rejected this token.");
  return body.result as TelegramBotInfo;
}
