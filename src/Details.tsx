import { useEffect, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';
import { Cat } from './components/Cat/Cat';
import { ModelDonut } from './components/Charts/ModelDonut';
import { HourlySparkline } from './components/Charts/HourlySparkline';
import { WeeklyHeatmap } from './components/Charts/WeeklyHeatmap';
import { useUsage } from './hooks/useUsage';
import { useConfig } from './hooks/useConfig';
import { usePeers, useRemoteRoom } from './hooks/usePresence';
import { useSessionUsage } from './hooks/useSessionUsage';
import { useUpdater } from './hooks/useUpdater';
import { classifyWithReason, STATE_LABEL } from './hooks/useCatState';
import { ACTIVITY_BADGE, CAT_COLORS, CAT_SCALE_MAX, CAT_SCALE_MIN, Config } from './types';
import { formatIdle, formatRate, formatTokens } from './utils/format';
import './details.css';

/** Format a rate-limit utilization value as a percent. Anthropic's units aren't
 * documented, so accept either a 0–1 fraction or an already-0–100 number. */
function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—';
  const pct = v <= 1 ? v * 100 : v;
  return `${Math.round(pct)}%`;
}

/** The Option+click / tray "settings" popup: usage summary + tunable knobs. */
export default function Details() {
  const usage = useUsage();
  const { config, save } = useConfig();
  const session = useSessionUsage();
  const sessionPct = session.usage?.ok ? session.usage.session_pct : null;
  const { state, reason } = classifyWithReason(usage, config, sessionPct);
  const updater = useUpdater();
  const peers = usePeers();
  const room = useRemoteRoom(config, state);
  const [joinCode, setJoinCode] = useState('');
  const [tokenInput, setTokenInput] = useState('');

  const patch = (p: Partial<Config>) => save({ ...config, ...p });
  const patchThreshold = (k: keyof Config['thresholds'], v: number) =>
    save({ ...config, thresholds: { ...config.thresholds, [k]: v } });

  // Feed button + 60s cooldown (the Rust side rate-limits too, so a `false`
  // return just means it's still cooling down).
  const [feedLeft, setFeedLeft] = useState(0);
  const feed = async () => {
    if (feedLeft > 0) return;
    const ok = await invoke<boolean>('feed_cat').catch(() => false);
    if (ok) setFeedLeft(60);
  };
  useEffect(() => {
    if (feedLeft <= 0) return;
    const id = setInterval(() => setFeedLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [feedLeft > 0]);

  // Login-item autostart. The plugin (the registered LaunchAgent) is the source
  // of truth, so the switch reflects `isEnabled()` rather than the config flag —
  // which merely mirrors it and is only rewritten on an explicit toggle (we must
  // not `patch()` during mount, since that would clobber the still-loading store
  // config back to defaults). `autostartBusy` guards against double-toggling
  // while an enable/disable round-trip is in flight.
  const [autostartOn, setAutostartOn] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(true);
  useEffect(() => {
    let alive = true;
    isEnabled()
      .then((on) => {
        if (!alive) return;
        setAutostartOn(on);
        setAutostartBusy(false);
      })
      .catch(() => {
        if (alive) setAutostartBusy(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const toggleAutostart = async () => {
    if (autostartBusy) return;
    const next = !autostartOn;
    setAutostartBusy(true);
    try {
      if (next) await enable();
      else await disable();
      const real = await isEnabled();
      setAutostartOn(real);
      patch({ autostart: real });
    } catch {
      // Registration can fail (e.g. macOS blocks the login item); re-sync to
      // whatever the OS actually did rather than trusting our optimistic guess.
      const real = await isEnabled().catch(() => autostartOn);
      setAutostartOn(real);
    } finally {
      setAutostartBusy(false);
    }
  };

  return (
    <div className="details">
      <header className="d-head">
        <div className="d-cat">
          <Cat state={state} color={config.catColor} />
        </div>
        <div>
          <div className="d-state">{STATE_LABEL[state]}</div>
          <div className="d-sub">
            {usage.session_active ? '● 세션 활성' : `마지막 활동 ${formatIdle(usage.idle_minutes)}`}
          </div>
          <div className="d-reason" title="현재 상태가 결정된 이유">
            이유: {reason}
          </div>
        </div>
        <button className="d-close" onClick={() => invoke('hide_details')} aria-label="close">
          ✕
        </button>
      </header>

      {usage.error && <div className="d-error">⚠ {usage.error}</div>}

      <section className="d-cards">
        <Stat
          label="오늘"
          tokens={usage.today_tokens}
          sub={<YesterdayDelta today={usage.today_tokens} yesterday={usage.yesterday_tokens} />}
        />
        <Stat label="이번 주" tokens={usage.week_tokens} />
        <Stat label="이번 달" tokens={usage.month_tokens} />
      </section>

      <ModelDonut models={usage.models_today} />

      <HourlySparkline data={usage.today_hourly} />

      <WeeklyHeatmap data={usage.weekly_hourly} />

      <div className="d-activity">
        rate {formatRate(usage.rate_per_min)} · 오늘 {formatTokens(usage.today_tokens)}
      </div>

      {usage.models_today.length > 0 && (
        <section className="d-models">
          {usage.models_today.map((m) => (
            <div className="d-model-row" key={m.model}>
              <span className="d-model-name">{shortModel(m.model)}</span>
              <span className="d-model-tok">{formatTokens(m.tokens)}</span>
            </div>
          ))}
        </section>
      )}

      <section className="d-settings">
        <div className="d-field-col">
          <span>고양이 색</span>
          <div className="d-swatches" role="radiogroup" aria-label="고양이 색">
            {CAT_COLORS.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={config.catColor === c.id}
                aria-label={c.label}
                title={c.label}
                className={config.catColor === c.id ? 'd-swatch active' : 'd-swatch'}
                onClick={() => patch({ catColor: c.id })}
              >
                <span className="d-swatch-dot" style={{ background: c.swatch }} />
                <span className="d-swatch-label">{c.label}</span>
              </button>
            ))}
          </div>
        </div>

        <label className="d-slider d-scale">
          <span className="d-slider-label">캐릭터 크기</span>
          <input
            type="range"
            min={CAT_SCALE_MIN}
            max={CAT_SCALE_MAX}
            step={0.05}
            value={config.catScale}
            onChange={(e) => patch({ catScale: Number(e.target.value) })}
          />
          <span className="d-slider-val">{Math.round(config.catScale * 100)}%</span>
        </label>

        <label className="d-toggle" title="macOS 로그인 시 clawd를 자동 실행합니다">
          <span className="d-toggle-label">로그인 시 자동 시작</span>
          <button
            type="button"
            role="switch"
            aria-checked={autostartOn}
            aria-label="로그인 시 자동 시작"
            className={autostartOn ? 'd-switch on' : 'd-switch'}
            disabled={autostartBusy}
            onClick={toggleAutostart}
          >
            <span className="d-switch-knob" />
          </button>
        </label>

        <label
          className="d-toggle"
          title="같은 네트워크(Wi-Fi)의 다른 clawd 고양이를 화면에 초대하고, 서로의 대략적 활동 현황을 봅니다"
        >
          <span className="d-toggle-label">🐈 네트워크에서 친구 초대</span>
          <button
            type="button"
            role="switch"
            aria-checked={config.networkEnabled}
            aria-label="네트워크에서 친구 초대"
            className={config.networkEnabled ? 'd-switch on' : 'd-switch'}
            onClick={() => patch({ networkEnabled: !config.networkEnabled })}
          >
            <span className="d-switch-knob" />
          </button>
        </label>

        {config.networkEnabled && (
          <label className="d-field-col d-nick">
            <span>닉네임 (친구 화면에 표시)</span>
            <input
              type="text"
              className="d-nick-input"
              maxLength={16}
              placeholder="예: 채니"
              value={config.nickname}
              onChange={(e) => patch({ nickname: e.target.value })}
            />
            <span className="d-nick-note">
              공유: 닉네임 · 색 · 기분 · 대략적 활동량뿐. 토큰 수·비용·프로젝트명은 공유하지 않아요.
            </span>
          </label>
        )}

        {config.networkEnabled && (
          <div className="d-peers">
            <div className="d-peers-head">
              네트워크 친구{peers.length > 0 ? ` (${peers.length})` : ''}
            </div>
            {peers.length === 0 ? (
              <div className="d-peers-empty">같은 네트워크에서 clawd를 켠 친구를 찾는 중…</div>
            ) : (
              <ul className="d-peers-list">
                {peers.map((p) => {
                  const b = ACTIVITY_BADGE[p.activity] ?? ACTIVITY_BADGE.light;
                  return (
                    <li className="d-peer" key={p.id}>
                      <span className="d-peer-badge">{b.icon}</span>
                      <span className="d-peer-name">{p.nickname}</span>
                      <span className="d-peer-act">{b.label}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}

        <div className="d-remote">
          <div className="d-peers-head">🌐 원격 방 (다른 네트워크의 친구)</div>
          {room.status === 'off' ? (
            <>
              <button type="button" className="d-room-btn" onClick={() => void room.open()}>
                방 만들기
              </button>
              <div className="d-room-row">
                <input
                  type="text"
                  className="d-nick-input"
                  placeholder="초대 코드 붙여넣기"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value)}
                />
                <button type="button" className="d-room-btn" onClick={() => void room.join(joinCode)}>
                  참가
                </button>
              </div>
              <span className="d-nick-note">
                방을 만들면 초대 코드가 생겨요. 친구가 그 코드로 참가하면 서로의 고양이가 보입니다.
                서버 없이 P2P로 연결돼요 (안 되면 공용 릴레이 경유).
              </span>
            </>
          ) : (
            <>
              <div className="d-room-status">
                {room.status === 'hosting' ? '방 열림 · 이 코드를 친구에게 공유' : '방에 참가됨'}
              </div>
              <div className="d-room-conn">
                {!room.joined
                  ? '⏳ 연결 중…'
                  : room.neighbors > 0
                    ? `🟢 연결됨 · 친구 ${room.neighbors}명`
                    : '🟡 방에 있음 · 친구 기다리는 중 (안 잡히면 방화벽/네트워크일 수 있어요)'}
              </div>
              {room.debug && <div className="d-room-conn">🔧 {room.debug}</div>}
              {room.code ? (
                <div className="d-room-row">
                  <input
                    className="d-nick-input"
                    readOnly
                    value={room.code}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <button
                    type="button"
                    className="d-room-btn"
                    onClick={() => void navigator.clipboard?.writeText(room.code)}
                  >
                    복사
                  </button>
                </div>
              ) : (
                <div className="d-nick-note">코드 생성 중…</div>
              )}
              <button type="button" className="d-room-btn leave" onClick={() => void room.leave()}>
                나가기
              </button>
            </>
          )}
        </div>

        <button
          type="button"
          className="d-feed"
          onClick={feed}
          disabled={feedLeft > 0}
          title="고양이에게 먹이를 줍니다 (60초 쿨다운)"
        >
          {feedLeft > 0 ? `🍚 냠냠… (${feedLeft}s)` : '🍚 먹이 주기'}
        </button>

        <div className="d-thresholds">
          <div className="d-thresholds-title">상태 임계값 (tokens/min)</div>
          <Slider label="curious ▸" value={config.thresholds.low} max={50_000} onChange={(v) => patchThreshold('low', v)} />
          <Slider label="active ▸" value={config.thresholds.mid} max={150_000} onChange={(v) => patchThreshold('mid', v)} />
          <Slider label="alert ▸" value={config.thresholds.high} max={400_000} onChange={(v) => patchThreshold('high', v)} />
          <Slider label="angry ▸" value={config.thresholds.veryHigh} max={800_000} onChange={(v) => patchThreshold('veryHigh', v)} />
          <p className="d-thresholds-note">
            *Exhausted는 최근 30분간 rate가 alert 임계 이상으로 지속되면 자동 진입
          </p>
        </div>

        <div className="d-session">
          <div className="d-session-title">
            세션 사용량 <span className="d-exp">실험</span>
          </div>
          {session.hasToken ? (
            <>
              {session.usage?.ok ? (
                <div className="d-session-vals">
                  <div>
                    <span className="d-session-k">5시간 세션</span>
                    <span className="d-session-v">{fmtPct(session.usage.session_pct)}</span>
                  </div>
                  <div>
                    <span className="d-session-k">주간</span>
                    <span className="d-session-v">{fmtPct(session.usage.weekly_pct)}</span>
                  </div>
                </div>
              ) : (
                <p className="d-session-warn">
                  아직 사용률을 못 읽었어요. 아래 진단을 보내주면 맞출게요:
                  <br />
                  <code>{session.usage?.debug ?? '…'}</code>
                </p>
              )}
              <div className="d-session-actions">
                <button className="d-btn" onClick={session.check} disabled={session.busy}>
                  {session.busy ? '확인 중…' : '지금 확인'}
                </button>
                <button className="d-btn ghost" onClick={session.clearToken}>
                  연동 해제
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="d-session-help">
                Claude Code OAuth 토큰(<code>claude setup-token</code> →{' '}
                <code>sk-ant-oat01…</code>)을 넣으면 5시간 세션·주간 사용률을 표시해요. 토큰은
                macOS 키체인에 저장됩니다.
              </p>
              <div className="d-session-actions">
                <input
                  className="d-session-input"
                  type="password"
                  placeholder="sk-ant-oat01-…"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                />
                <button
                  className="d-btn"
                  disabled={!tokenInput.trim()}
                  onClick={() => {
                    session.saveToken(tokenInput.trim()).catch(() => {});
                    setTokenInput('');
                  }}
                >
                  저장
                </button>
              </div>
            </>
          )}
          <p className="d-session-note">
            *비공식 방식이라 언제든 바뀔 수 있고, 확인할 때마다 작은 요청을 한 번 보냅니다.
          </p>
        </div>

        <UpdateRow updater={updater} />

        <p className="d-foot">
          {session.usage?.ok
            ? '*세션/주간 값은 Claude의 사용률 한도 기준. 아래 토큰·비용은 로컬 로그 기반 추정치'
            : '*토큰·비용은 로컬 로그 기반 추정치 (Claude 구독은 정액이라 실제 청구액과 무관)'}
        </p>
      </section>
    </div>
  );
}

/** Self-update control: current version + a check/update button whose label and
 * action track the {@link useUpdater} status. */
function UpdateRow({ updater }: { updater: ReturnType<typeof useUpdater> }) {
  const { status, version, current, progress, check, install } = updater;

  const busy = status === 'checking' || status === 'downloading';
  let label = '새 버전 확인';
  if (status === 'checking') label = '확인 중…';
  else if (status === 'downloading') label = `업데이트 중… ${progress}%`;
  else if (status === 'available') label = `⬇ v${version}(으)로 업데이트`;

  const onClick = () => {
    if (busy) return;
    if (status === 'available') void install();
    else void check({ silent: false });
  };

  return (
    <div className="d-update">
      <div className="d-update-info">
        <span className="d-update-cur">현재 버전 v{current || '…'}</span>
        {status === 'uptodate' && <span className="d-update-msg ok">최신 버전이에요</span>}
        {status === 'available' && (
          <span className="d-update-msg hot">새 버전 v{version} 사용 가능</span>
        )}
        {status === 'error' && (
          <span className="d-update-msg warn">확인 실패 · 릴리스 페이지를 열었어요</span>
        )}
      </div>
      <button
        type="button"
        className={status === 'available' ? 'd-update-btn hot' : 'd-update-btn'}
        onClick={onClick}
        disabled={busy}
      >
        {label}
      </button>
    </div>
  );
}

function Stat({
  label,
  tokens,
  sub,
}: {
  label: string;
  tokens: number;
  sub?: ReactNode;
}) {
  return (
    <div className="d-card">
      <div className="d-card-label">{label}</div>
      <div className="d-card-tok">{formatTokens(tokens)}</div>
      {sub}
    </div>
  );
}

/**
 * "vs. yesterday" delta shown under the 오늘 card. Increase is red, decrease is
 * green (this is an *activity* meter, not a bill — more work today reads "hot").
 * A first-token day (no yesterday baseline) shows a neutral "신규" chip.
 */
function YesterdayDelta({ today, yesterday }: { today: number; yesterday: number }) {
  if (yesterday <= 0) {
    if (today <= 0) return null;
    return <div className="d-delta neutral">어제 대비 신규</div>;
  }
  const pct = Math.round(((today - yesterday) / yesterday) * 100);
  if (pct === 0) return <div className="d-delta neutral">어제와 비슷</div>;
  const up = pct > 0;
  return (
    <div className={`d-delta ${up ? 'up' : 'down'}`}>
      어제 대비 {up ? '▲' : '▼'} {Math.abs(pct)}%
    </div>
  );
}

function Slider({
  label,
  value,
  min = 0,
  max,
  step = 1000,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="d-slider">
      <span className="d-slider-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="d-slider-val">{formatTokens(value)}</span>
    </label>
  );
}

function shortModel(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'Opus';
  if (m.includes('haiku')) return 'Haiku';
  if (m.includes('sonnet')) return 'Sonnet';
  return model.replace('claude-', '');
}
