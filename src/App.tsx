import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Cat } from './components/Cat/Cat';
import { FurnitureBaseline } from './components/Furniture/Furniture';
import { useUsage } from './hooks/useUsage';
import { useConfig } from './hooks/useConfig';
import { classifyWithReason, STATE_LABEL } from './hooks/useCatState';
import { CatState } from './types';
import { formatCost, formatRate, formatTokens } from './utils/format';
import './App.css';

type Mode = 'roam' | 'grab';
type Gait = 'idle' | 'walk' | 'run' | 'jitter';
type Direction = 'left' | 'right';
type SubEventKind = 'yawn' | 'stretch';

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
/** Rust's `cat-sub-event` payload: a brief in-place flourish while resting. */
interface SubEvent {
  kind: SubEventKind;
  duration_ms: number;
}
/** Rust's `cat-butterfly` payload: spawn a butterfly the cat chases. */
interface ButterflyEvent {
  x: number;
  y: number;
  target_x: number;
  target_y: number;
  duration_ms: number;
}
/** Live butterfly being animated on screen (frontend-only). */
interface Butterfly extends ButterflyEvent {
  /** Bump on each spawn so the animation effect re-fires. */
  id: number;
}

/** How long the "just ate" reaction (temp sit + bowl linger) lasts. */
const FEED_REACT_MS = 5000;

const FIRST_RUN_KEY = 'first_run_done';
/** Tooltip max width (px); must match `.tooltip { max-width }` in App.css. */
const TOOLTIP_MAX = 240;
/** How the tooltip is anchored over the cat once auto-flip has run. */
type TtAlign = 'center' | 'left' | 'right';

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
  const { state, reason } = classifyWithReason(usage, config);
  const [hover, setHover] = useState(false);
  // Tooltip placement, recomputed each time it's shown so it never clips out of
  // the (small, edge-clamped) grab window.
  const [ttAlign, setTtAlign] = useState<TtAlign>('center');
  const [ttBelow, setTtBelow] = useState(false);
  const [mode, setMode] = useState<Mode>('roam');
  const [gait, setGait] = useState<Gait>('idle');
  const [direction, setDirection] = useState<Direction>('right');
  const [placed, setPlaced] = useState(false);
  // Short-lived badge shown right after a mode switch.
  const [badge, setBadge] = useState<string | null>(null);
  // First-launch hint (bigger, self-dismissing).
  const [hint, setHint] = useState(false);

  // --- "Alive" flourishes + interactions ---
  // Yawn / stretch class currently applied (cleared after its duration).
  const [subEvent, setSubEvent] = useState<SubEventKind | null>(null);
  // Butterfly the cat is chasing, and a transient pounce on the catch.
  const [butterfly, setButterfly] = useState<Butterfly | null>(null);
  const [pounce, setPounce] = useState(false);
  // Grab-mode petting: mouse held down on the cat → purr.
  const [holding, setHolding] = useState(false);
  // Greeting wiggle + bubble shown for the first few seconds each launch.
  const [greeting, setGreeting] = useState(true);
  // Feed reaction: sparkle at the bowl + a temporary content pose.
  const [fed, setFed] = useState(false);

  const grab = mode === 'grab';

  const containerRef = useRef<HTMLDivElement>(null);
  const gaitTimer = useRef<number | null>(null);
  const flyRef = useRef<HTMLDivElement>(null);

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

  // Greeting: wiggle + a "hi!" bubble for the first 4s of every launch (we
  // deliberately don't persist this — the cat is always glad to see you).
  useEffect(() => {
    const t = setTimeout(() => setGreeting(false), 4000);
    return () => clearTimeout(t);
  }, []);

  // Yawn / stretch flourishes scheduled by Rust. Apply the class for its
  // duration, then clear. A fresh event supersedes any in-flight one.
  useEffect(() => {
    let clear: number | null = null;
    const un = listen<SubEvent>('cat-sub-event', (e) => {
      if (clear !== null) clearTimeout(clear);
      setSubEvent(e.payload.kind);
      clear = window.setTimeout(() => setSubEvent(null), e.payload.duration_ms);
    });
    return () => {
      if (clear !== null) clearTimeout(clear);
      un.then((off) => off());
    };
  }, []);

  // Butterfly chase: Rust sends where the butterfly appears + where it flutters
  // (the cat is sent chasing via a parallel `cat-wander`). We just record it;
  // the animation lives in the effect below.
  useEffect(() => {
    let seq = 0;
    const un = listen<ButterflyEvent>('cat-butterfly', (e) => {
      seq += 1;
      setButterfly({ ...e.payload, id: seq });
    });
    return () => {
      un.then((off) => off());
    };
  }, []);

  // Feed reaction: sparkle the bowl + hold a content pose for a few seconds.
  useEffect(() => {
    let clear: number | null = null;
    const un = listen('feed-cat', () => {
      if (clear !== null) clearTimeout(clear);
      setFed(true);
      clear = window.setTimeout(() => setFed(false), FEED_REACT_MS);
    });
    return () => {
      if (clear !== null) clearTimeout(clear);
      un.then((off) => off());
    };
  }, []);

  // Drive the butterfly across the screen: snap to its start, flutter to the
  // target over `duration_ms`, then fade it out and pop a pounce on the cat.
  useEffect(() => {
    if (!butterfly) return;
    const el = flyRef.current;
    if (!el) return;
    el.style.transition = 'none';
    el.style.opacity = '1';
    el.style.transform = `translate3d(${butterfly.x}px, ${butterfly.y}px, 0)`;
    void el.offsetWidth; // commit the start before animating
    el.style.transition = `transform ${butterfly.duration_ms}ms ease-in-out, opacity 0.35s ease`;
    el.style.transform = `translate3d(${butterfly.target_x}px, ${butterfly.target_y}px, 0)`;

    const caught = window.setTimeout(() => {
      el.style.opacity = '0';
      setPounce(true);
      window.setTimeout(() => setPounce(false), 450);
    }, butterfly.duration_ms);
    const gone = window.setTimeout(() => setButterfly(null), butterfly.duration_ms + 400);
    return () => {
      clearTimeout(caught);
      clearTimeout(gone);
    };
  }, [butterfly]);

  // Petting: releasing the mouse anywhere ends the purr (a drag hands the
  // pointer to the OS, so the container's own pointerup may never fire).
  useEffect(() => {
    const end = () => setHolding(false);
    window.addEventListener('pointerup', end);
    window.addEventListener('blur', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('blur', end);
    };
  }, []);

  // Grab mode owns interaction: leaving it clears any hover/hold artifacts.
  useEffect(() => {
    if (!grab) {
      setHolding(false);
      setHover(false);
    }
  }, [grab]);

  // Distinguish a click (open details) from a drag (move window).
  const down = useRef<{ x: number; y: number } | null>(null);
  const dragged = useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    down.current = { x: e.clientX, y: e.clientY };
    dragged.current = false;
    // Holding still on the cat = petting → purr (until it turns into a drag).
    if (grab) setHolding(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!down.current || dragged.current) return;
    const dx = Math.abs(e.clientX - down.current.x);
    const dy = Math.abs(e.clientY - down.current.y);
    if (dx + dy > 4) {
      dragged.current = true;
      setHolding(false); // it's a drag, not a pet
      // Hand the gesture to the OS window manager (moves the grab window).
      invoke('start_drag').catch(() => {});
    }
  };
  const onClick = () => {
    if (dragged.current) return; // it was a drag, not a click
    invoke('open_details').catch(() => {});
  };

  // Decide where the tooltip sits so it stays inside the window. The grab
  // window is small (≈300px) and gets clamped against the screen edge, so a
  // cat parked near an edge would push a centered tooltip off the window — we
  // flip it to hug whichever edge the cat is close to, and drop it below the
  // cat when there isn't room above.
  const onMouseEnter = () => {
    const el = containerRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      const catCenter = r.left + r.width / 2;
      const half = TOOLTIP_MAX / 2;
      const pad = 12;
      let align: TtAlign = 'center';
      if (catCenter + half > window.innerWidth - pad) align = 'right';
      else if (catCenter - half < pad) align = 'left';
      setTtAlign(align);
      setTtBelow(r.top < 96); // not enough headroom above → sit below the cat
    }
    setHover(true);
  };

  const dailyRatio = config.dailyBudget > 0 ? usage.today_cost / config.dailyBudget : 0;

  // Pose overrides: greet with a forward sit; a just-fed exhausted cat perks up
  // to a content sit for the reaction window. Otherwise show the real mood.
  const effectiveState: CatState =
    greeting || (fed && state === 'exhausted') ? 'playing' : state;

  // FX layer classes — a flourish/interaction stack on the `.cat-fx` wrapper.
  const fx = ['cat-fx'];
  if (greeting) fx.push('wiggle');
  if (pounce) fx.push('pounce');
  if (grab && hover) fx.push('pet');
  if (grab && holding) fx.push('purr');
  // Yawn/stretch only while resting in Roam (grab / motion would look wrong).
  if (subEvent && !grab && gait === 'idle') fx.push(subEvent);

  // Shadow reacts to the gait (blurs + shrinks while airborne).
  const containerClass = [
    placed ? 'cat-container placed' : 'cat-container',
    gait === 'run' ? 'running' : gait === 'walk' ? 'walking' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={grab ? 'stage grab' : 'stage'}>
      {/* Decorative furniture row (Roam only — the grab window would clip it).
          Rendered before the cat so the cat always sits in front of its props. */}
      {!grab && <FurnitureBaseline color={config.catColor} />}

      {/* Butterfly the cat chases (Roam only). Driven imperatively via flyRef. */}
      {!grab && butterfly && (
        <div ref={flyRef} className="butterfly" aria-hidden>
          <svg viewBox="0 0 32 32" width="30" height="30">
            <g className="bfly-wings">
              <path
                d="M16 16 C 9 4, 1 6, 4 15 C 1 24, 10 26, 16 16 Z"
                fill="rgba(255,255,255,0.95)"
                stroke="rgba(120,110,140,0.6)"
                strokeWidth="1"
              />
              <path
                d="M16 16 C 23 4, 31 6, 28 15 C 31 24, 22 26, 16 16 Z"
                fill="rgba(255,255,255,0.95)"
                stroke="rgba(120,110,140,0.6)"
                strokeWidth="1"
              />
            </g>
            <line x1="16" y1="10" x2="16" y2="22" stroke="rgba(90,80,110,0.8)" strokeWidth="1.6" />
          </svg>
        </div>
      )}

      {/* Feed sparkle at the bowl (Roam only). */}
      {!grab && fed && (
        <div className="feed-sparkle" aria-hidden>
          <span>✨</span>
          <span>🍚</span>
          <span>✨</span>
        </div>
      )}

      <div
        ref={containerRef}
        className={containerClass}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onClick={onClick}
        onMouseEnter={onMouseEnter}
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

        {/* Greeting bubble — every launch, unless the first-run hint is up. */}
        <AnimatePresence>
          {greeting && !hint && (
            <motion.div
              className="greet"
              initial={{ opacity: 0, y: 6, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.9 }}
              transition={{ duration: 0.2 }}
            >
              안녕! 😺
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
              className={`tooltip tt-${ttAlign}${ttBelow ? ' tt-below' : ''}`}
              // Fade only — animating transform here would clobber the CSS
              // `translateX(-50%)` that centers the tooltip.
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <div className="tt-title">{STATE_LABEL[state]}</div>
              <div className="tt-row">
                오늘 {formatTokens(usage.today_tokens)} · {formatCost(usage.today_cost)}
              </div>
              <div className="tt-row dim">
                rate {formatRate(usage.rate_per_min)} · 예산 {Math.round(dailyRatio * 100)}%
              </div>
              <div className="tt-row dim">이유: {reason}</div>
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

        {/* The cat itself — flips to face its travel direction. The `.cat-fx`
            wrapper carries the flourish/interaction transforms (yawn, stretch,
            purr, pounce, greeting wiggle, pet squish) so they never collide
            with the flip or the resting breathing. */}
        <div className={direction === 'left' ? 'cat-flip flip' : 'cat-flip'}>
          <div className={fx.join(' ')}>
            <Cat state={effectiveState} gait={gait} color={config.catColor} />
          </div>
        </div>
      </div>
    </div>
  );
}
