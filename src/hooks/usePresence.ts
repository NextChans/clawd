import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ACTIVITY_FOR_STATE, CatState, Config, Peer } from '../types';

const PEER_ID_KEY = 'clawd_peer_id';
const IROH_SECRET_KEY = 'clawd_iroh_secret';

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

/** Stable per-install iroh secret key as 64-char lowercase hex (32 bytes),
 * generated once and persisted. Parsed by `iroh::SecretKey` on the Rust side. */
function getIrohSecret(): string {
  let s = localStorage.getItem(IROH_SECRET_KEY);
  if (!s || !/^[0-9a-f]{64}$/.test(s)) {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    s = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(IROH_SECRET_KEY, s);
  }
  return s;
}

/** Build the coarse payload we share — never token counts or project names. */
function buildPayload(config: Config, state: CatState) {
  const id = getPeerId();
  return {
    id,
    nickname: config.nickname.trim() || `cat-${id.slice(0, 4)}`,
    color: config.catColor,
    state,
    activity: ACTIVITY_FOR_STATE[state],
  };
}

/**
 * Read-only view of the peers currently online (LAN + remote, merged). Pulls a
 * snapshot on mount then rides the `peers` events Rust emits on every join /
 * leave / stale-drop. Safe from any window — never starts or stops anything.
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
 * Publish side of social mode. Broadcasts our coarse payload on state/identity
 * changes to whatever transports are live (Rust no-ops per-transport when off),
 * and owns the LAN toggle (start/stop on `config.networkEnabled`). Belongs to
 * exactly one window (the cat overlay).
 */
export function usePresencePublish(config: Config, state: CatState): void {
  const enabled = config.networkEnabled;
  const { id, nickname, color, activity } = buildPayload(config, state);
  const payload = { id, nickname, color, state, activity };

  // LAN: start on enable, stop on disable / unmount.
  useEffect(() => {
    if (!enabled) return;
    invoke('presence_start', { payload }).catch(() => {});
    return () => {
      invoke('presence_stop').catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Push live payload updates to every active transport (LAN and/or remote).
  // Unconditional: the Rust side no-ops for any transport that's off.
  useEffect(() => {
    invoke('presence_publish', { payload }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nickname, color, state, activity]);
}

export type RoomStatus = 'off' | 'hosting' | 'joined';

/**
 * Remote room controls (WAN, iroh). `open` hosts a fresh room and surfaces a
 * base32 code to share (via the `remote-room-code` event); `join` connects to a
 * code; `leave` disconnects. Peers found this way flow into the shared `peers`
 * roster like LAN ones. Used from the details window.
 */
export function useRemoteRoom(config: Config, state: CatState) {
  const [status, setStatus] = useState<RoomStatus>('off');
  const [code, setCode] = useState<string>('');
  // Connection diagnostics: whether we've joined the room and to how many peers.
  const [joined, setJoined] = useState(false);
  const [neighbors, setNeighbors] = useState(0);
  const [debug, setDebug] = useState('');

  useEffect(() => {
    const unCode = listen<string>('remote-room-code', (e) => setCode(e.payload));
    const unStatus = listen<[boolean, number]>('remote-status', (e) => {
      setJoined(e.payload[0]);
      setNeighbors(e.payload[1]);
    });
    const unDebug = listen<string>('remote-debug', (e) => setDebug(e.payload));
    return () => {
      unCode.then((off) => off());
      unStatus.then((off) => off());
      unDebug.then((off) => off());
    };
  }, []);

  // Optional self-hosted relay: both peers must set the same URL. Empty → n0's
  // public relays. Passed as `null` when unset so Rust falls back to Default.
  const relayUrl = config.remoteRelayUrl?.trim() || null;

  const open = useCallback(async () => {
    setCode('');
    await invoke('presence_remote_open', {
      payload: buildPayload(config, state),
      secretHex: getIrohSecret(),
      relayUrl,
    });
    setStatus('hosting');
  }, [config, state, relayUrl]);

  const join = useCallback(
    async (roomCode: string) => {
      const trimmed = roomCode.trim().toLowerCase();
      if (!trimmed) return;
      await invoke('presence_remote_join', {
        payload: buildPayload(config, state),
        secretHex: getIrohSecret(),
        code: trimmed,
        relayUrl,
      });
      setCode(trimmed);
      setStatus('joined');
    },
    [config, state, relayUrl],
  );

  const leave = useCallback(async () => {
    await invoke('presence_remote_leave').catch(() => {});
    setStatus('off');
    setCode('');
    setJoined(false);
    setNeighbors(0);
    setDebug('');
  }, []);

  return { status, code, joined, neighbors, debug, open, join, leave };
}
