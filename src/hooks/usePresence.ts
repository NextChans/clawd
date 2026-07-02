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
 * Read-only view of the peers currently online. Pulls a snapshot on mount (so a
 * window that opens after discovery paints immediately) then rides the `peers`
 * events Rust emits on every join / leave / stale-drop. Safe to use from any
 * window — it never starts or stops the transport.
 */
export function usePeers(): Peer[] {
  const [peers, setPeers] = useState<Peer[]>([]);
  useEffect(() => {
    let alive = true;
    invoke<Peer[]>('presence_peers')
      .then((p) => alive && setPeers(p))
      .catch(() => {});
    const un = listen<Peer[]>('peers', (e) => {
      if (alive) setPeers(e.payload);
    });
    return () => {
      alive = false;
      un.then((off) => off());
    };
  }, []);
  return peers;
}

/**
 * Publish side of social mode (LAN). When {@link Config.networkEnabled} is on,
 * broadcasts a *coarse* presence payload (nickname, coat color, mood, activity
 * bucket) to clawd peers on the same network via the Rust `presence_*`
 * commands. Owns start/stop, so it belongs to exactly one window (the cat
 * overlay). Shares no token counts, cost, or project names — see
 * `src-tauri/src/presence.rs`.
 */
export function usePresencePublish(config: Config, state: CatState): void {
  const enabled = config.networkEnabled;

  const id = getPeerId();
  const nickname = config.nickname.trim() || `cat-${id.slice(0, 4)}`;
  const color = config.catColor;
  const activity = ACTIVITY_FOR_STATE[state];
  const payload = { id, nickname, color, state, activity };

  // Start on enable, stop on disable / unmount.
  useEffect(() => {
    if (!enabled) return;
    invoke('presence_start', { payload }).catch(() => {});
    return () => {
      invoke('presence_stop').catch(() => {});
    };
    // Only (re)start when the toggle flips — payload updates ride the effect
    // below so changing identity mid-session doesn't tear the socket down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Push live payload updates (mood / color / nickname changed) while enabled.
  useEffect(() => {
    if (!enabled) return;
    invoke('presence_publish', { payload }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, nickname, color, state, activity]);
}
