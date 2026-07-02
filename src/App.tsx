import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Cat } from './components/Cat/Cat';
import { useUsage } from './hooks/useUsage';
import { useConfig } from './hooks/useConfig';
import { classify, STATE_LABEL } from './hooks/useCatState';
import { formatCost, formatRate, formatTokens } from './utils/format';
import './App.css';

type Mode = 'roam' | 'grab';
type Gait = 'idle' | 'walk' | 'run' | 'jitter';
type Direction = 'left' | 'right';

/** Rust's `cat-wander` payload: tween the cat here over `duration_ms`. */
interface WanderEvent {
  x: number;
  y: number;
  duration_ms: number;
  direction: Direction;
  gait: Exclude<Gait, 'idle'>;
}
/** Rust's `cat-place` payload: snap the cat here with no transition. */
interface PlaceEvent {
  x: number;
  y: number;
}

const FIRST_RUN_KEY = 'first_run_done';

/**
 * The cat window is a full-screen, transparent, click-through overlay. The cat
 * itself is a `.cat-container` moved *inside* it with GPU-accelerated CSS
 * transforms — Rust only schedules where/when to go (`cat-wander`) and the
 * browser tweens there smoothly. Two modes, owned by Rust and broadcast via
 * `mode-change`:
 *  - **roam** (default): overlay is click-through and the cat auto-wanders. The
 *    pointer handlers never fire.
 *  - **grab** (⌘⇧C / tray): Rust shrinks the window around the frozen cat and
 *    makes it interactive — hover shows the tooltip, drag moves it, a plain
 *    click opens details.
 */
export default function App() {
  const usage = useUsage();
  const { config } = useConfig();
  const state = classify(usage, config);
  const [hover, setHover] = useState(false);
  const [mode, setMode] = useState<Mode>('roam');
  const [gait, setGait] = useState<Gait>('idle');
  const [direction, setDirection] = useState<Direction>('right');
  const [placed, setPlaced] = useState(false);
  // Short-lived badge shown right after a mode switch.
  const [badge, setBadge] = useState<string | null>(null);
  // First-launch hint (bigger, self-dismissing).
  const [hint, setHint] = useState(false);

  const grab = mode === 'grab';

  const containerRef = useRef<HTMLDivElement>(null);
  const gaitTimer = useRef<number | null>(null);

  // --- Movement primitives (imperative so React re-renders never clobber an
  // in-flight CSS transition; `transform` is never part of the JSX style). ---
  const clearGaitTimer = () => {
    if (gaitTimer.current !== null) {
      clearTimeout(gaitTimer.current);
      gaitTimer.current = null;
    }
  };

  const placeAt = (x: number, y: number) => {
    const el = containerRef.current;
    if (!el) return;
    el.style.transition = 'none';
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    setPlaced(true);
    clearGaitTimer();
    setGait('idle');
  };

  const wanderTo = (ev: WanderEvent) => {
    const el = containerRef.current;
    if (!el) return;
    // Force the pending "none" transition to commit before swapping to the
    // timed one, so we always animate from the current spot.
    void el.offsetWidth;
    el.style.transition = `transform ${ev.duration_ms}ms ease-in-out`;
    el.style.transform = `translate3d(${ev.x}px, ${ev.y}px, 0)`;
    setDirection(ev.direction);
    setGait(ev.gait);
    setPlaced(true);
    clearGaitTimer();
    // Drop back to the idle pose when the hop finishes.
    gaitTimer.current = window.setTimeout(() => setGait('idle'), ev.duration_ms);
  };

  // Freeze the cat exactly where it is on screen, then let Rust shrink the
  // window around it. `getBoundingClientRect` gives the live, mid-transition
  // position (the container's base sits at the window origin).
  const freezeForGrab = () => {
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.transition = 'none';
    el.style.transform = `translate3d(${r.left}px, ${r.top}px, 0)`;
    clearGaitTimer();
    setGait('idle');
    invoke('enter_grab', { x: r.left, y: r.top }).catch(() => {});
  };

  // Initial paint: place the cat where Rust says it is.
  useEffect(() => {
    invoke<[number, number]>('get_cat_pos')
      .then(([x, y]) => placeAt(x, y))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Movement events from Rust.
  useEffect(() => {
    const unWander = listen<WanderEvent>('cat-wander', (e) => wanderTo(e.payload));
    const unPlace = listen<PlaceEvent>('cat-place', (e) => placeAt(e.payload.x, e.payload.y));
    return () => {
      unWander.then((off) => off());
      unPlace.then((off) => off());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep in sync with Rust's mode. `mode-change` only fires on a real switch
  // (hotkey / tray / command), so every one gets a badge. On entering grab we
  // freeze the cat and hand its position to Rust to shrink the window.
  useEffect(() => {
    invoke<string>('get_mode')
      .then((m) => setMode(m === 'grab' ? 'grab' : 'roam'))
      .catch(() => {});

    const unlisten = listen<string>('mode-change', (e) => {
      const next: Mode = e.payload === 'grab' ? 'grab' : 'roam';
      if (next === 'grab') freezeForGrab();
      setMode(next);
      setBadge(next === 'grab' ? '🖐️ 잡기 모드 ON' : '🐾 놀기 모드');
    });
    return () => {
      unlisten.then((off) => off());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clear the mode badge after a beat.
  useEffect(() => {
    if (!badge) return;
    const t = setTimeout(() => setBadge(null), 2500);
    return () => clearTimeout(t);
  }, [badge]);

  // Report the cat's mood to Rust so Roam mode can tune the wander liveliness.
  useEffect(() => {
    invoke('set_cat_state', { catState: state }).catch(() => {});
  }, [state]);

  // First-run hint: show once, for 5s, then remember we've shown it.
  useEffect(() => {
    if (localStorage.getItem(FIRST_RUN_KEY)) return;
    setHint(true);
    const t = setTimeout(() => {
      setHint(false);
      localStorage.setItem(FIRST_RUN_KEY, '1');
    }, 5000);
    return () => clearTimeout(t);
  }, []);

  // Distinguish a click (open details) from a drag (move window).
  const down = useRef<{ x: number; y: number } | null>(null);
  const dragged = useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    down.current = { x: e.clientX, y: e.clientY };
    dragged.current = false;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!down.current || dragged.current) return;
    const dx = Math.abs(e.clientX - down.current.x);
    const dy = Math.abs(e.clientY - down.current.y);
    if (dx + dy > 4) {
      dragged.current = true;
      // Hand the gesture to the OS window manager (moves the grab window).
      invoke('start_drag').catch(() => {});
    }
  };
  const onClick = () => {
    if (dragged.current) return; // it was a drag, not a click
    invoke('open_details').catch(() => {});
  };

  const dailyRatio = config.dailyBudget > 0 ? usage.today_cost / config.dailyBudget : 0;

  return (
    <div className={grab ? 'stage grab' : 'stage'}>
      <div
        ref={containerRef}
        className={placed ? 'cat-container placed' : 'cat-container'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onClick={onClick}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        {/* First-run hint — a wider, friendlier tooltip that rides above the cat. */}
        <AnimatePresence>
          {hint && (
            <motion.div
              className="hint"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.25 }}
            >
              🐾 <b>놀기 모드</b>로 시작해요. 잡으려면 트레이 아이콘 또는 <b>⌘⇧C</b>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Mode-switch badge. */}
        <AnimatePresence>
          {badge && (
            <motion.div
              className="badge"
              initial={{ opacity: 0, y: -6, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.9 }}
              transition={{ duration: 0.2 }}
            >
              {badge}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Stats tooltip — hover in Grab mode. */}
        <AnimatePresence>
          {hover && grab && (
            <motion.div
              className="tooltip"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.15 }}
            >
              <div className="tt-title">{STATE_LABEL[state]}</div>
              <div className="tt-row">
                오늘 {formatTokens(usage.today_tokens)} · {formatCost(usage.today_cost)}
              </div>
              <div className="tt-row dim">
                rate {formatRate(usage.rate_per_min)} · 예산 {Math.round(dailyRatio * 100)}%
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {grab && (
            <motion.div
              className="grab-ring"
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85 }}
              transition={{ duration: 0.2 }}
            />
          )}
        </AnimatePresence>

        {/* The cat itself — flips to face its travel direction. */}
        <div className={direction === 'left' ? 'cat-flip flip' : 'cat-flip'}>
          <Cat state={state} gait={gait} />
        </div>
      </div>
    </div>
  );
}
