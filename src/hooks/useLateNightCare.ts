import { useEffect, useRef, useState } from 'react';
import { Usage } from '../types';

/** Local-time window (inclusive start, exclusive end) that counts as "deep
 * night" — when working now reads as burning the midnight oil. */
const NIGHT_START = 0; // 00:00
const NIGHT_END = 5; // 05:00
/** How long the caring nudge lingers. */
const CARE_MS = 6000;
/** localStorage key so a restart in the same night doesn't re-nudge. */
const LS_KEY = 'clawd:lastNightCare';

const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

/**
 * A once-a-night caring nudge: if you're **actively** using Claude in the small
 * hours, the cat gently tells you to wrap up. Distinct from the idle night-sleep
 * mood in `useCatState` — that's for when you've stepped away; this is for when
 * you're still hammering away at 3am.
 *
 * Fires at most once per calendar date (persisted in localStorage so a restart
 * the same night stays quiet), and only while a turn landed recently
 * (`session_active`), so it never nags an idle machine.
 */
export function useLateNightCare(usage: Usage): boolean {
  const [nudge, setNudge] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!usage.session_active) return;
    const hour = new Date().getHours();
    if (hour < NIGHT_START || hour >= NIGHT_END) return;

    const today = todayKey();
    let last: string | null = null;
    try {
      last = localStorage.getItem(LS_KEY);
    } catch {
      last = null;
    }
    if (last === today) return; // already nudged tonight

    try {
      localStorage.setItem(LS_KEY, today);
    } catch {
      /* private mode / disabled storage — fall back to per-session only */
    }
    if (timer.current) clearTimeout(timer.current);
    setNudge(true);
    timer.current = window.setTimeout(() => setNudge(false), CARE_MS);
  }, [usage.session_active]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return nudge;
}
