import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ACTIVITY_FOR_STATE, CatState, Config, Peer } from '../types';

const PEER_ID_KEY = 'clawd_peer_id';

/** Stable per-install id: generated once and persisted in localStorage so the
 * same machine keys to the same peer across restarts. */
function getPeerId(): string {
  let id = localStorage.getItem(PEER_ID_KEY);
  if (!id) {
    id =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(PEER_ID_KEY, id);
  }
  return id;
}

/**
 * Social mode, LAN edition. When {@link Config.networkEnabled} is on, publishes
 * a *coarse* presence payload (nickname, coat color, mood, activity bucket) to
 * clawd peers on the same network via the Rust `presence_*` commands, and
 * returns the peers currently online (from the `peers` event). Off → empty.
 *
 * Deliberately shares no token counts, cost, or project names — see
 * `src-tauri/src/presence.rs`.
 */
export function usePresence(config: Config, state: CatState): Peer[] {
  const [peers, setPeers] = useState<Peer[]>([]);
  const enabled = config.networkEnabled;

  const id = getPeerId();
  const nickname = config.nickname.trim() || `cat-${id.slice(0, 4)}`;
  const color = config.catColor;
  const activity = ACTIVITY_FOR_STATE[state];
  const payload = { id, nickname, color, state, activity };

  // Subscribe to peer snapshots once. Rust emits `peers` on every join / leave
  // / stale-drop; when disabled it emits an empty list on stop, and we also
  // clear locally below so a stale roster never lingers.
  useEffect(() => {
    const un = listen<Peer[]>('peers', (e) => setPeers(e.payload));
    return () => {
      un.then((off) => off());
    };
  }, []);

  // Start on enable, stop on disable / unmount.
  useEffect(() => {
    if (!enabled) {
      setPeers([]);
      return;
    }
    invoke('presence_start', { payload }).catch(() => {});
    return () => {
      invoke('presence_stop').catch(() => {});
    };
    // Only (re)start when the toggle flips — payload updates ride the effect
    // below so flipping identity mid-session doesn't tear the socket down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Push live payload updates (mood / color / nickname changed) while enabled.
  useEffect(() => {
    if (!enabled) return;
    invoke('presence_publish', { payload }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, nickname, color, state, activity]);

  return enabled ? peers : [];
}
