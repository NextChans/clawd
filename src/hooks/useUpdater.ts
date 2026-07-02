import { useCallback, useEffect, useRef, useState } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getVersion } from '@tauri-apps/api/app';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';

/** Releases page — the fallback when self-update isn't wired up (no signing key
 * yet) or the update check errors for any reason. */
const RELEASES_URL = 'https://github.com/NextChans/clawd/releases';
/** How long after mount before the automatic (silent) check fires. */
const AUTO_CHECK_DELAY_MS = 5000;
/** Tray "새 버전 확인" → this event (see `tray.rs`). */
const CHECK_EVENT = 'clawd://check-update';

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'uptodate'
  | 'error';

/**
 * Self-update controller, mounted once in the (always-loaded) details window —
 * the cat overlay is click-through, so it can't host the confirm button.
 *
 * Lifecycle: a silent `check()` runs `AUTO_CHECK_DELAY_MS` after launch; finding
 * an update fires a native notification and flags the banner so it's waiting
 * when the user opens details. The tray menu emits {@link CHECK_EVENT} for an
 * explicit (non-silent) check that surfaces its result inline. Any failure —
 * most commonly an unsigned release before the key is set up — degrades to
 * opening the Releases page in the browser and is only logged.
 */
export function useUpdater() {
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [version, setVersion] = useState('');
  const [current, setCurrent] = useState('');
  const [progress, setProgress] = useState(0);
  // The pending update carries the download/install handle — kept in a ref so a
  // re-render never drops it mid-flight.
  const pending = useRef<Update | null>(null);
  // Guard against overlapping checks (auto + manual racing).
  const busy = useRef(false);

  useEffect(() => {
    getVersion().then(setCurrent).catch(() => {});
  }, []);

  const runCheck = useCallback(async (opts: { silent: boolean }) => {
    if (busy.current) return;
    busy.current = true;
    setStatus('checking');
    try {
      const update = await check();
      if (update) {
        pending.current = update;
        setVersion(update.version);
        setStatus('available');
        if (opts.silent) {
          await notify(`새 버전 v${update.version} 사용 가능`, '트레이 › 상세에서 업데이트하세요.');
        }
      } else {
        pending.current = null;
        setStatus('uptodate');
      }
    } catch (e) {
      // Almost always "no signature"/"unsupported" on an unsigned release.
      console.warn('[updater] check failed, falling back to Releases page:', e);
      setStatus('error');
      if (!opts.silent) {
        await openUrl(RELEASES_URL).catch(() => {});
      }
    } finally {
      busy.current = false;
    }
  }, []);

  const install = useCallback(async () => {
    const update = pending.current;
    if (!update) return;
    setStatus('downloading');
    setProgress(0);
    try {
      let total = 0;
      let got = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            total = event.data.contentLength ?? 0;
            break;
          case 'Progress':
            got += event.data.chunkLength;
            if (total > 0) setProgress(Math.min(100, Math.round((got / total) * 100)));
            break;
          case 'Finished':
            setProgress(100);
            break;
        }
      });
      await relaunch();
    } catch (e) {
      console.error('[updater] install failed:', e);
      setStatus('error');
      await openUrl(RELEASES_URL).catch(() => {});
    }
  }, []);

  // Auto (silent) check shortly after launch, and the manual tray-driven check.
  useEffect(() => {
    const t = window.setTimeout(() => void runCheck({ silent: true }), AUTO_CHECK_DELAY_MS);
    const un = listen(CHECK_EVENT, () => {
      // Bring the window forward so the check result is visible, then run it.
      invoke('open_details').catch(() => {});
      void runCheck({ silent: false });
    });
    return () => {
      clearTimeout(t);
      un.then((off) => off());
    };
  }, [runCheck]);

  return { status, version, current, progress, check: runCheck, install };
}

async function notify(title: string, body: string) {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === 'granted';
    if (granted) sendNotification({ title, body });
  } catch {
    /* notifications are best-effort */
  }
}
