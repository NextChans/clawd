import { useCallback, useEffect, useRef, useState } from 'react';
import { load, type Store } from '@tauri-apps/plugin-store';
import { emit, listen } from '@tauri-apps/api/event';
import { Config, DEFAULT_CONFIG } from '../types';

const STORE_FILE = 'config.json';
const KEY = 'config';
const CHANGED_EVENT = 'clawd://config-changed';

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (!storePromise) storePromise = load(STORE_FILE, { autoSave: true, defaults: {} });
  return storePromise;
}

// Rebuild only the fields we know about. Legacy keys from older versions
// (e.g. `dailyBudget`, `notifyEnabled`) are silently dropped, and any missing
// key — including a brand-new `exhaustedTokenThreshold` on an upgraded install
// — falls back to its current default.
function merge(partial: Partial<Config> | undefined | null): Config {
  const p = partial ?? {};
  return {
    exhaustedTokenThreshold: p.exhaustedTokenThreshold ?? DEFAULT_CONFIG.exhaustedTokenThreshold,
    catColor: p.catColor ?? DEFAULT_CONFIG.catColor,
    autostart: p.autostart ?? DEFAULT_CONFIG.autostart,
    thresholds: { ...DEFAULT_CONFIG.thresholds, ...(p.thresholds ?? {}) },
  };
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
