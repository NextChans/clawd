import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Usage, EMPTY_USAGE } from '../types';

/**
 * Current usage snapshot. Pulls once on mount for an instant paint, then rides
 * the `usage` events the Rust poller emits every 30s.
 */
export function useUsage(): Usage {
  const [usage, setUsage] = useState<Usage>(EMPTY_USAGE);

  useEffect(() => {
    let alive = true;

    invoke<Usage>('get_usage')
      .then((u) => alive && setUsage(u))
      .catch(() => {});

    const un = listen<Usage>('usage', (e) => {
      if (alive) setUsage(e.payload);
    });

    return () => {
      alive = false;
      un.then((f) => f());
    };
  }, []);

  return usage;
}
