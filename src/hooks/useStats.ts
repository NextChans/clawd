import { useCallback, useEffect, useRef, useState } from 'react';
import { load, type Store } from '@tauri-apps/plugin-store';
import { emit, listen } from '@tauri-apps/api/event';
import { applyEvent, DEFAULT_STATS, mergeStats, Stats, StatEvent } from '../achievements';

const STORE_FILE = 'stats.json';
const KEY = 'stats';
const CHANGED_EVENT = 'clawd://stats-changed';

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (!storePromise) storePromise = load(STORE_FILE, { autoSave: true, defaults: {} });
  return storePromise;
}

/**
 * Shared, live play stats — the same store+broadcast shape as {@link useConfig}
 * so the cat and details windows stay in sync. The cat window `record()`s events
 * (feed, golden, …); the details window reads the counters to draw the 도감 grid
 * and bond meter. A `clawd://stats-changed` broadcast keeps both current.
 */
export function useStats() {
  const [stats, setStats] = useState<Stats>(DEFAULT_STATS);
  const liveUpdate = useRef(false);
  // Latest stats, so `record` folds onto the current value without a stale
  // closure or a dependency that re-creates the callback every change.
  const latest = useRef<Stats>(DEFAULT_STATS);
  latest.current = stats;

  useEffect(() => {
    let alive = true;

    getStore()
      .then((s) => s.get<Stats>(KEY))
      .then((saved) => {
        if (!alive || liveUpdate.current) return;
        setStats(mergeStats(saved));
      })
      .catch(() => {});

    const un = listen<Stats>(CHANGED_EVENT, (e) => {
      if (!alive) return;
      liveUpdate.current = true;
      setStats(mergeStats(e.payload));
    });
    return () => {
      alive = false;
      un.then((f) => f());
    };
  }, []);

  const record = useCallback(async (ev: StatEvent) => {
    const next = applyEvent(latest.current, ev);
    if (next === latest.current) return; // no-op (e.g. tower3 already set)
    liveUpdate.current = true;
    latest.current = next;
    setStats(next);
    try {
      const store = await getStore();
      await store.set(KEY, next);
      await store.save();
      await emit(CHANGED_EVENT, next);
    } catch {
      /* best-effort persistence */
    }
  }, []);

  return { stats, record };
}
