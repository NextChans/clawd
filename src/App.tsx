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

const FIRST_RUN_KEY = 'first_run_done';

/**
 * The cat window. Two modes, owned by the Rust side and broadcast via
 * `mode-change`:
 *  - **roam** (default): window is click-through and wanders the screen on its
 *    own. These pointer handlers never fire.
 *  - **grab** (⌘⇧C / tray): window is interactive and frozen — hover shows the
 *    tooltip, drag moves it, a plain click opens the details window.
 */
export default function App() {
  const usage = useUsage();
  const { config } = useConfig();
  const state = classify(usage, config);
  const [hover, setHover] = useState(false);
  const [mode, setMode] = useState<Mode>('roam');
  // Short-lived badge shown right after a mode switch.
  const [badge, setBadge] = useState<string | null>(null);
  // First-launch hint (bigger, self-dismissing).
  const [hint, setHint] = useState(false);

  const grab = mode === 'grab';

  // Keep in sync with Rust's mode. `mode-change` only fires on a real switch
  // (hotkey / tray / command), so every one gets a badge.
  useEffect(() => {
    invoke<string>('get_mode')
      .then((m) => setMode(m === 'grab' ? 'grab' : 'roam'))
      .catch(() => {});

    const unlisten = listen<string>('mode-change', (e) => {
      const next: Mode = e.payload === 'grab' ? 'grab' : 'roam';
      setMode(next);
      setBadge(next === 'grab' ? '🖐️ 잡기 모드 ON' : '🐾 놀기 모드');
    });
    return () => {
      unlisten.then((off) => off());
    };
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
      // Hand the gesture to the OS window manager.
      invoke('start_drag').catch(() => {});
    }
  };
  const onClick = () => {
    if (dragged.current) return; // it was a drag, not a click
    invoke('open_details').catch(() => {});
  };

  const dailyRatio = config.dailyBudget > 0 ? usage.today_cost / config.dailyBudget : 0;

  return (
    <div
      className={grab ? 'stage grab' : 'stage'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {/* First-run hint — a wider, friendlier tooltip that self-dismisses. */}
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

      <AnimatePresence mode="wait">
        <motion.div
          key={state}
          className="cat-wrap"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
        >
          <Cat state={state} />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
