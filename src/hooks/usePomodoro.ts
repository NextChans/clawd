import { useCallback, useEffect, useRef, useState } from 'react';
import { emit } from '@tauri-apps/api/event';

export type PomodoroPhase = 'idle' | 'focus' | 'break';

const FOCUS_SEC = 25 * 60;
const BREAK_SEC = 5 * 60;

/** Broadcast so the cat window can reflect focus mode (badge + calm) and
 * celebrate a completed session. Fired from whichever window owns the timer
 * (the details window). */
export const FOCUS_EVENT = 'clawd://focus'; // payload: { active: boolean }
export const FOCUS_DONE_EVENT = 'clawd://focus-done';

/**
 * A little pomodoro the cat keeps with you. Owned by the details window (which
 * has the controls + live readout); it broadcasts focus start/stop so the cat
 * shows a 🍅 badge and stays calm while you focus, and a "done" event when a
 * focus block completes so the cat celebrates. A completed focus auto-rolls into
 * a short break, then back to idle.
 */
export function usePomodoro() {
  const [phase, setPhase] = useState<PomodoroPhase>('idle');
  const [remaining, setRemaining] = useState(0);
  const tick = useRef<number | undefined>(undefined);
  // Latest phase for the interval callback without re-arming it each second.
  const phaseRef = useRef<PomodoroPhase>('idle');
  phaseRef.current = phase;

  const stopTimer = () => {
    if (tick.current) {
      clearInterval(tick.current);
      tick.current = undefined;
    }
  };

  const stop = useCallback(() => {
    stopTimer();
    setPhase('idle');
    setRemaining(0);
    void emit(FOCUS_EVENT, { active: false });
  }, []);

  const enter = useCallback((next: PomodoroPhase) => {
    stopTimer();
    if (next === 'idle') {
      setPhase('idle');
      setRemaining(0);
      void emit(FOCUS_EVENT, { active: false });
      return;
    }
    setPhase(next);
    setRemaining(next === 'focus' ? FOCUS_SEC : BREAK_SEC);
    void emit(FOCUS_EVENT, { active: next === 'focus' });
    tick.current = window.setInterval(() => {
      setRemaining((r) => {
        if (r > 1) return r - 1;
        // Hit zero: advance the phase. Focus → celebrate + break; break → idle.
        if (phaseRef.current === 'focus') {
          void emit(FOCUS_DONE_EVENT, {});
          queueMicrotask(() => enter('break'));
        } else {
          queueMicrotask(() => enter('idle'));
        }
        return 0;
      });
    }, 1000);
  }, []);

  const start = useCallback(() => enter('focus'), [enter]);

  useEffect(() => () => stopTimer(), []);

  return { phase, remaining, running: phase !== 'idle', start, stop };
}
