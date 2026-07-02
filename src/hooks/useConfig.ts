import { useCallback, useEffect, useRef, useState } from 'react';
import { load, type Store } from '@tauri-apps/plugin-store';
import { emit, listen } from '@tauri-apps/api/event';
import { CAT_SCALE_MAX, CAT_SCALE_MIN, Config, DEFAULT_CONFIG } from '../types';

const STORE_FILE = 'config.json';
const KEY = 'config';
const CHANGED_EVENT = 'clawd://config-changed';

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (!storePromise) storePromise = load(STORE_FILE, { autoSave: true, defaults: {} });
  return storePromise;
}

// Rebuild only the fields we know about. Legacy keys from older versions
// (e.g. `dailyBudget`, `notifyEnabled`, `exhaustedTokenThreshold`) are silently
// dropped, and any missing key falls back to its current default.
function merge(partial: Partial<Config> | undefined | null): Config {
  const p = partial ?? {};
  return {
    catColor: p.catColor ?? DEFAULT_CONFIG.catColor,
    autostart: p.autostart ?? DEFAULT_CONFIG.autostart,
    catScale: clampScale(p.catScale),
    thresholds: { ...DEFAULT_CONFIG.thresholds, ...(p.thresholds ?? {}) },
    networkEnabled: p.networkEnabled ?? DEFAULT_CONFIG.networkEnabled,
    nickname: typeof p.nickname === 'string' ? p.nickname : DEFAULT_CONFIG.nickname,
  };
}

/** Clamp a possibly-missing / hand-edited scale into the supported range. */
function clampScale(v: number | undefined | null): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_CONFIG.catScale;
  return Math.min(CAT_SCALE_MAX, Math.max(CAT_SCALE_MIN, v));
}

/**
 * Shared, live config. Loads from the Tauri store and stays in sync across the
 * cat and details windows via a broadcast event.
 */
export function useConfig() {
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
  // Once a live save/broadcast has set the config, the slow initial store read
  // must not clobber it back to the on-disk value (startup race between the
  // async `getStore()` load and an early save / `config-changed` event).
  const liveUpdate = useRef(false);

  useEffect(() => {
    let alive = true;

    getStore()
      .then((s) => s.get<Config>(KEY))
      .then((saved) => {
        if (!alive || liveUpdate.current) return;
        setConfig(merge(saved));
      })
      .catch(() => {});

    const un = listen<Config>(CHANGED_EVENT, (e) => {
      if (!alive) return;
      liveUpdate.current = true;
      setConfig(merge(e.payload));
    });
    return () => {
      alive = false;
      un.then((f) => f());
    };
  }, []);

  const save = useCallback(async (next: Config) => {
    liveUpdate.current = true;
    setConfig(next);
    const store = await getStore();
    await store.set(KEY, next);
    await store.save();
    await emit(CHANGED_EVENT, next); // notify the other window
  }, []);

  return { config, save };
}
