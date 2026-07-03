import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

/** Mirrors `SessionUsage` in src-tauri/src/session.rs. */
export interface SessionUsage {
  configured: boolean;
  ok: boolean;
  session_pct: number | null;
  weekly_pct: number | null;
  session_reset: string | null;
  weekly_reset: string | null;
  status: number | null;
  debug: string;
}

/** Each check sends a (tiny) Messages request, so poll sparingly. */
const POLL_MS = 120_000;

/**
 * Experimental session-usage integration (opt-in). Reads the 5-hour session +
 * weekly utilization off the Anthropic Messages API's rate-limit headers using
 * a Claude Code OAuth token kept in the macOS Keychain. Best-effort: if the
 * headers/response don't match, `usage.ok` is false and `usage.debug` carries
 * the raw status/headers so it can be diagnosed.
 */
export function useSessionUsage() {
  const [hasToken, setHasToken] = useState(false);
  const [usage, setUsage] = useState<SessionUsage | null>(null);
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    setBusy(true);
    try {
      const u = await invoke<SessionUsage>('session_usage');
      setUsage(u);
      setHasToken(u.configured);
    } catch {
      /* ignore — leave the last snapshot */
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    invoke<boolean>('session_has_token')
      .then((h) => {
        if (!alive) return;
        setHasToken(h);
        if (h) check();
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [check]);

  useEffect(() => {
    if (!hasToken) return;
    const id = setInterval(check, POLL_MS);
    return () => clearInterval(id);
  }, [hasToken, check]);

  const saveToken = useCallback(
    async (token: string) => {
      await invoke('session_set_token', { token });
      setHasToken(true);
      await check();
    },
    [check],
  );

  const clearToken = useCallback(async () => {
    await invoke('session_clear_token').catch(() => {});
    setHasToken(false);
    setUsage(null);
  }, []);

  return { hasToken, usage, busy, check, saveToken, clearToken };
}
