import { useEffect, useRef } from 'react';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import type { SessionUsage } from './useSessionUsage';

/** Warn once the session/weekly budget crosses this (percent). */
const WARN_PCT = 90;
/** Re-arm after it drops back under this — hysteresis so a value hovering at
 * the threshold doesn't spam, and a window reset re-enables the warning. */
const REARM_PCT = 80;

function toPct(v: number | null | undefined): number | null {
  if (v == null) return null;
  return v <= 1 ? v * 100 : v;
}

async function notify(title: string, body: string) {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === 'granted';
    if (granted) sendNotification({ title, body });
  } catch {
    /* notifications are best-effort */
  }
}

/**
 * Fire a one-shot, cat-toned native notification when the session (5-hour) or
 * weekly budget crosses {@link WARN_PCT}, re-arming once it falls back under
 * {@link REARM_PCT} (e.g. the window reset). Belongs to a single window (the
 * cat overlay) so it never double-fires.
 */
export function useSessionAlert(usage: SessionUsage | null) {
  // Start armed; flip off after firing until the value drops back down.
  const armed = useRef({ session: true, weekly: true });

  useEffect(() => {
    if (!usage?.ok) return;

    const s = toPct(usage.session_pct);
    if (s != null) {
      if (armed.current.session && s >= WARN_PCT) {
        armed.current.session = false;
        notify('🐾 세션 한도 임박', `5시간 세션을 ${Math.round(s)}% 썼다냥. 슬슬 쉬어가자냥!`);
      } else if (!armed.current.session && s < REARM_PCT) {
        armed.current.session = true;
      }
    }

    const w = toPct(usage.weekly_pct);
    if (w != null) {
      if (armed.current.weekly && w >= WARN_PCT) {
        armed.current.weekly = false;
        notify('🐾 주간 한도 임박', `이번 주 사용량이 ${Math.round(w)}%다냥. 아껴 쓰자냥!`);
      } else if (!armed.current.weekly && w < REARM_PCT) {
        armed.current.weekly = true;
      }
    }
  }, [usage]);
}
