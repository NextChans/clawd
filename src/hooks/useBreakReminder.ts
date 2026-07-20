import { useEffect, useRef, useState } from 'react';
import { Usage } from '../types';

/** A working streak continues as long as gaps between activity stay under this
 * many minutes; a longer gap counts as a real break and resets the streak. */
const BREAK_GAP_MIN = 10;
/** Nudge once the current streak has run this long (ms). */
const STREAK_MS = 90 * 60 * 1000;
/** How long the nudge lingers. */
const NUDGE_MS = 6000;

/**
 * A gentle "take a break" nudge after a long continuous working stretch. A
 * streak is tracked in wall-clock time and rides out the short gaps between
 * turns (idle < {@link BREAK_GAP_MIN} keeps it alive); a real break resets it.
 * Fires once per streak. Distinct from the late-night nudge (that's about the
 * hour; this is about how long you've been at it).
 */
export function useBreakReminder(usage: Usage): boolean {
  const [nudge, setNudge] = useState(false);
  // Latest idle-minutes, refreshed every poll (usage is a new object each tick).
  const idleRef = useRef(usage.idle_minutes);
  idleRef.current = usage.idle_minutes;

  const streakStart = useRef<number | null>(null);
  const nudgedThisStreak = useRef(false);
  const clear = useRef<number | undefined>(undefined);

  useEffect(() => {
    const check = window.setInterval(() => {
      const idle = idleRef.current;
      if (idle < BREAK_GAP_MIN) {
        if (streakStart.current === null) {
          streakStart.current = Date.now();
          nudgedThisStreak.current = false;
        } else if (!nudgedThisStreak.current && Date.now() - streakStart.current >= STREAK_MS) {
          nudgedThisStreak.current = true;
          setNudge(true);
          if (clear.current) clearTimeout(clear.current);
          clear.current = window.setTimeout(() => setNudge(false), NUDGE_MS);
        }
      } else {
        // A real break — reset so the next long stretch can nudge again.
        streakStart.current = null;
        nudgedThisStreak.current = false;
      }
    }, 60_000);
    return () => {
      clearInterval(check);
      if (clear.current) clearTimeout(clear.current);
    };
  }, []);

  return nudge;
}
