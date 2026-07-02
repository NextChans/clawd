import { useCallback, useEffect, useState } from 'react';
import { load, type Store } from '@tauri-apps/plugin-store';
import { emit, listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { Config, DEFAULT_CONFIG } from '../types';

const STORE_FILE = 'config.json';
const KEY = 'config';
const CHANGED_EVENT = 'clawd://config-changed';

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (!storePromise) storePromise = load(STORE_FILE, { autoSave: true, defaults: {} });
  return storePromise;
}

function merge(partial: Partial<Config> | undefined | null): Config {
  return {
    ...DEFAULT_CONFIG,
    ...(partial ?? {}),
    thresholds: { ...DEFAULT_CONFIG.thresholds, ...(partial?.thresholds ?? {}) },
  };
}

// Push the two knobs the Rust side needs (budget + notifications) so the
// background poller notifies against the latest values.
async function syncToBackend(cfg: Config) {
  try {
    await invoke('set_config', {
      dailyBudget: cfg.dailyBudget,
      notifyEnabled: cfg.notifyEnabled,
    });
  } catch {
    /* backend may not be ready yet; next save will retry */
  }
}

/**
 * Shared, live config. Loads from the Tauri store and stays in sync across the
 * cat and details windows via a broadcast event.
 */
export function useConfig() {
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);

  useEffect(() => {
    let alive = true;
    getStore()
      .then((s) => s.get<Config>(KEY))
      .then((saved) => {
        if (!alive) return;
        const cfg = merge(saved);
        setConfig(cfg);
        syncToBackend(cfg);
      })
      .catch(() => {});

    const un = listen<Config>(CHANGED_EVENT, (e) => {
      if (alive) setConfig(merge(e.payload));
    });
    return () => {
      alive = false;
      un.then((f) => f());
    };
  }, []);

  const save = useCallback(async (next: Config) => {
    setConfig(next);
    const store = await getStore();
    await store.set(KEY, next);
    await store.save();
    await syncToBackend(next);
    await emit(CHANGED_EVENT, next); // notify the other window
  }, []);

  return { config, save };
}
