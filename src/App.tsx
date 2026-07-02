import { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { Cat } from './components/Cat/Cat';
import { useUsage } from './hooks/useUsage';
import { useConfig } from './hooks/useConfig';
import { classify, STATE_LABEL } from './hooks/useCatState';
import { formatCost, formatRate, formatTokens } from './utils/format';
import './App.css';

/**
 * The cat window. The window itself is click-through (Rust side) until Option
 * is held, at which point these handlers can fire: hover shows the tooltip,
 * drag moves the window, a plain click opens the details window.
 */
export default function App() {
  const usage = useUsage();
  const { config } = useConfig();
  const state = classify(usage, config);
  const [hover, setHover] = useState(false);

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
      className="stage"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <AnimatePresence>
        {hover && (
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
