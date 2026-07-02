import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Cat, hasCatSprite } from './components/Cat/Cat';
import { FurnitureBaseline, FurnitureKind } from './components/Furniture/Furniture';
import { Butterfly } from './components/Playthings/Butterfly';
import { Ball } from './components/Playthings/Ball';
import { Yarn } from './components/Playthings/Yarn';
import { Bird } from './components/Playthings/Bird';
import { PeerCats } from './components/Peers/PeerCats';
import { useUsage } from './hooks/useUsage';
import { useConfig } from './hooks/useConfig';
import { usePeers, usePresencePublish } from './hooks/usePresence';
import { classifyWithReason, STATE_LABEL } from './hooks/useCatState';
import { ACTIVITY_FOR_STATE, CatState } from './types';
import { formatRate, formatTokens } from './utils/format';
import './App.css';

type Mode = 'roam' | 'grab';
type Gait = 'idle' | 'walk' | 'run' | 'jitter';
type Direction = 'left' | 'right';
/** Resting flourishes scheduled by Rust. `yawn`/`stretch` have expressive
 * sprites (cream); the three smaller twitches are CSS-only (see App.css). */
type SubEventKind = 'yawn' | 'stretch' | 'ear_wiggle' | 'look_back' | 'blink_hard';
/** The four toys the cat reacts to (mirrors `roam.rs`'s `PLAYTHINGS`). */
type PlaythingKind = 'butterfly' | 'ball' | 'yarn' | 'bird';

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
/** Rust's `cat-plaything` payload: spawn a toy the cat reacts to. */
interface PlaythingEvent {
  kind: PlaythingKind;
  x: number;
  y: number;
  target_x: number;
  target_y: number;
  duration_ms: number;
}
/** Live plaything being animated on screen (frontend-only). */
interface Plaything extends PlaythingEvent {
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
  // Social mode: publish our coarse status + render cats from clawd peers on
  // the LAN (empty unless opted in).
  usePresencePublish(config, state);
  const peers = usePeers();
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
  // Plaything the cat is reacting to, and a transient pounce on the catch.
  const [plaything, setPlaything] = useState<Plaything | null>(null);
  const [pounce, setPounce] = useState(false);
  // Brief "spooked" beat when a plaything first appears (drives the startled pose).
  const [startled, setStartled] = useState(false);
  // Grab-mode petting: mouse held down on the cat → purr.
  const [holding, setHolding] = useState(false);
  // Greeting wiggle + bubble shown for the first few seconds each launch.
  const [greeting, setGreeting] = useState(true);
  // Feed reaction: sparkle at the bowl + a temporary content pose. `feedPhase`
  // sequences the expressive pose: tuck in and `eating`, then a short `purr`
  // afterglow before returning to normal.
  const [fed, setFed] = useState(false);
  const [feedPhase, setFeedPhase] = useState<'eating' | 'purr' | null>(null);

  const grab = mode === 'grab';

  const containerRef = useRef<HTMLDivElement>(null);
  const gaitTimer = useRef<number | null>(null);
  const flyRef = useRef<HTMLDivElement>(null);
  // The cat's current position within the window, mirrored for peer cats so a
  // visitor can drift over to play. Updated wherever we move the cat.
  const catXRef = useRef(0);
  const catYRef = useRef(0);

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
    catXRef.current = x;
    catYRef.current = y;
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
    catXRef.current = ev.x;
    catYRef.current = ev.y;
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

  // Plaything: Rust sends where the toy appears + where it travels (the cat is
  // sent reacting via a parallel `cat-wander`). We just record it; the animation
  // lives in the effect below.
  useEffect(() => {
    let seq = 0;
    const un = listen<PlaythingEvent>('cat-plaything', (e) => {
      seq += 1;
      setPlaything({ ...e.payload, id: seq });
    });
    return () => {
      un.then((off) => off());
    };
  }, []);

  // Feed reaction: sparkle the bowl + sequence eating → purr for a few seconds.
  useEffect(() => {
    const timers: number[] = [];
    const un = listen('feed-cat', () => {
      timers.forEach(clearTimeout);
      timers.length = 0;
      setFed(true);
      setFeedPhase('eating');
      // Perk up into a content purr for the tail end of the reaction window.
      timers.push(window.setTimeout(() => setFeedPhase('purr'), FEED_REACT_MS - 1500));
      timers.push(
        window.setTimeout(() => {
          setFed(false);
          setFeedPhase(null);
        }, FEED_REACT_MS),
      );
    });
    return () => {
      timers.forEach(clearTimeout);
      un.then((off) => off());
    };
  }, []);

  // Drive the plaything across the screen: snap to its start, glide to the
  // target over `duration_ms`, then fade it out. The per-kind flourish (roll /
  // sway / dip / flutter) rides on the inner element via CSS. On "catch" the cat
  // pounces — except for the bird, which flies off out of reach.
  useEffect(() => {
    if (!plaything) return;
    // A quick spooked beat as the toy pops in, before the cat reacts.
    setStartled(true);
    const unspook = window.setTimeout(() => setStartled(false), 550);
    const el = flyRef.current;
    if (!el) {
      return () => clearTimeout(unspook);
    }
    el.style.transition = 'none';
    el.style.opacity = '1';
    el.style.transform = `translate3d(${plaything.x}px, ${plaything.y}px, 0)`;
    void el.offsetWidth; // commit the start before animating
    // Bird glides at a steady pace (linear) under its CSS dip; the others ease.
    const ease = plaything.kind === 'bird' ? 'linear' : 'ease-in-out';
    el.style.transition = `transform ${plaything.duration_ms}ms ${ease}, opacity 0.35s ease`;
    el.style.transform = `translate3d(${plaything.target_x}px, ${plaything.target_y}px, 0)`;

    const catchable = plaything.kind !== 'bird';
    const caught = window.setTimeout(() => {
      el.style.opacity = '0';
      if (catchable) {
        setPounce(true);
        window.setTimeout(() => setPounce(false), 450);
      }
    }, plaything.duration_ms);
    const gone = window.setTimeout(() => setPlaything(null), plaything.duration_ms + 400);
    return () => {
      clearTimeout(unspook);
      clearTimeout(caught);
      clearTimeout(gone);
    };
  }, [plaything]);

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

  // Pose overrides: greet with a forward sit; a just-fed exhausted cat perks up
  // to a content sit for the reaction window. Otherwise show the real mood.
  const effectiveState: CatState =
    greeting || (fed && state === 'exhausted') ? 'playing' : state;

  // Expressive pose override — the new art (cream only). Priority, highest
  // first: petting/holding in grab → purr; then Roam flourishes. Each maps to a
  // dedicated sprite; `usePose` gates on the sprite actually existing so other
  // colors fall back to the legacy CSS flourish below instead of breaking.
  let overridePose: string | undefined;
  if (grab) {
    if (hover || holding) overridePose = 'happy_purr';
  } else if (pounce) {
    overridePose = 'playing_pounce';
  } else if (startled) {
    overridePose = 'startled';
  } else if (feedPhase) {
    overridePose = feedPhase === 'purr' ? 'happy_purr' : 'eating';
  } else if (subEvent && gait === 'idle') {
    overridePose = subEvent; // 'yawn' | 'stretch'
  }
  const usePose = !!overridePose && hasCatSprite(config.catColor, overridePose);

  // On-demand furniture: a prop appears only while its mood is active (keyed on
  // the *raw* mood so it lines up with `roam.rs`'s wander target), plus the bowl
  // during a feed reaction. Idle moods (playing/curious/active) show nothing.
  const visibleFurniture = new Set<FurnitureKind>();
  if (state === 'sleeping') visibleFurniture.add('cushion');
  if (state === 'alert' || state === 'angry') visibleFurniture.add('tower');
  if (state === 'exhausted' || fed) visibleFurniture.add('bowl');

  // FX layer classes — a flourish/interaction stack on the `.cat-fx` wrapper.
  // When an expressive pose is in play (`usePose`) the pose *is* the flourish,
  // so we skip the CSS squish transforms it replaces (pounce/pet/purr/yawn/
  // stretch) to avoid double-animating. If the pose sprite is missing (non-cream
  // colors) the CSS classes below still fire as the fallback. The greeting
  // wiggle is independent (it never sets an override) so it always applies.
  const fx = ['cat-fx'];
  if (greeting) fx.push('wiggle');
  if (!usePose) {
    if (pounce) fx.push('pounce');
    if (grab && hover) fx.push('pet');
    if (grab && holding) fx.push('purr');
    // Yawn/stretch only while resting in Roam (grab / motion would look wrong).
    if (subEvent && !grab && gait === 'idle') fx.push(subEvent);
  }

  // Shadow reacts to the gait (blurs + shrinks while airborne).
  const containerClass = [
    placed ? 'cat-container placed' : 'cat-container',
    gait === 'run' ? 'running' : gait === 'walk' ? 'walking' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={grab ? 'stage grab' : 'stage'}
      style={{ '--cat-scale': config.catScale } as CSSProperties}
    >
      {/* Decorative furniture row (Roam only — the grab window would clip it).
          Rendered before the cat so the cat always sits in front of its props. */}
      {!grab && (
        <FurnitureBaseline
          color={config.catColor}
          visibleKinds={visibleFurniture}
          towerTier={usage.tower_tier}
        />
      )}

      {/* Visiting peer cats (social mode, Roam only). Gated on the toggle so
          nothing shows for the default local setup. `getSelf`/`selfPlayful`
          let a visitor drift over to play when you're both relaxed. */}
      {!grab && config.networkEnabled && (
        <PeerCats
          peers={peers}
          getSelf={() => ({ x: catXRef.current, y: catYRef.current })}
          selfPlayful={ACTIVITY_FOR_STATE[state] === 'light'}
        />
      )}

      {/* Plaything the cat reacts to (Roam only). The outer element is glided
          imperatively via flyRef; the inner element carries the per-kind CSS
          flourish (roll / sway / dip / flutter). */}
      {!grab && plaything && (
        <div ref={flyRef} className="plaything" aria-hidden>
          <div
            className={`plaything-inner pt-${plaything.kind}${
              plaything.kind === 'ball' && plaything.target_x < plaything.x ? ' rev' : ''
            }`}
            // The bird's dip runs once across the whole flight.
            style={
              plaything.kind === 'bird'
                ? { animationDuration: `${plaything.duration_ms}ms` }
                : undefined
            }
          >
            {plaything.kind === 'butterfly' && <Butterfly />}
            {plaything.kind === 'ball' && <Ball />}
            {plaything.kind === 'yarn' && <Yarn />}
            {plaything.kind === 'bird' && <Bird />}
          </div>
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
              <div className="tt-row">오늘 {formatTokens(usage.today_tokens)} tokens</div>
              <div className="tt-row dim">
                rate {formatRate(usage.rate_per_min)} · 오늘 {formatTokens(usage.today_tokens)}
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
            <Cat
              state={effectiveState}
              gait={gait}
              color={config.catColor}
              pose={usePose ? overridePose : undefined}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
