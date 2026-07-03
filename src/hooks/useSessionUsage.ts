import { useCallback, useEffect, useRef, useState } from 'react';
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
/** Only session-% rises above this (points) within the activity window count as
 * "actively using" — filters out float/rounding noise between polls. */
const RISE_EPS = 0.05;
/** How far back we look for a rise; a bit above two poll intervals so a single
 * poll's usage still registers. */
const RISE_WINDOW_MS = 12 * 60 * 1000;

/** Normalize a raw utilization value (0–1 fraction or already-0–100) to 0–100. */
function toPct(v: number): number {
  return v <= 1 ? v * 100 : v;
}

export function useSessionUsage() {
  const [hasToken, setHasToken] = useState(false);
  const [usage, setUsage] = useState<SessionUsage | null>(null);
  const [busy, setBusy] = useState(false);
  // Whether the session % has climbed recently — our "using Claude *now*"
  // signal (incl. web usage the local logs can't see). Derived from a short
  // history of samples, since the absolute % alone can't tell activity from a
  // high-but-idle window.
  const [rising, setRising] = useState(false);
  const histRef = useRef<{ t: number; pct: number }[]>([]);

  const check = useCallback(async () => {
    setBusy(true);
    try {
      const u = await invoke<SessionUsage>('session_usage');
      setUsage(u);
      setHasToken(u.configured);
      if (u.ok && u.session_pct != null) {
        const pct = toPct(u.session_pct);
        const now = Date.now();
        const h = histRef.current;
        h.push({ t: now, pct });
        while (h.length > 1 && now - h[0].t > RISE_WINDOW_MS) h.shift();
        setRising(h.length >= 2 && pct - h[0].pct > RISE_EPS);
      }
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
    setRising(false);
    histRef.current = [];
  }, []);

  return { hasToken, usage, rising, busy, check, saveToken, clearToken };
}
