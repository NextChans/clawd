import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Cat } from './components/Cat/Cat';
import { useUsage } from './hooks/useUsage';
import { useConfig } from './hooks/useConfig';
import { classifyWithReason, STATE_LABEL } from './hooks/useCatState';
import { CAT_COLORS, Config } from './types';
import { formatIdle, formatRate, formatTokens } from './utils/format';
import './details.css';

/** The Option+click / tray "settings" popup: usage summary + tunable knobs. */
export default function Details() {
  const usage = useUsage();
  const { config, save } = useConfig();
  const { state, reason } = classifyWithReason(usage, config);

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
        <Stat label="오늘" tokens={usage.today_tokens} />
        <Stat label="이번 주" tokens={usage.week_tokens} />
        <Stat label="이번 달" tokens={usage.month_tokens} />
      </section>

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
          <div className="d-thresholds-title">상태 임계값 (tokens/min · exhausted은 일일 누적)</div>
          <Slider label="curious ▸" value={config.thresholds.low} max={50_000} onChange={(v) => patchThreshold('low', v)} />
          <Slider label="active ▸" value={config.thresholds.mid} max={150_000} onChange={(v) => patchThreshold('mid', v)} />
          <Slider label="alert ▸" value={config.thresholds.high} max={400_000} onChange={(v) => patchThreshold('high', v)} />
          <Slider label="angry ▸" value={config.thresholds.veryHigh} max={800_000} onChange={(v) => patchThreshold('veryHigh', v)} />
          <Slider
            label="exhausted ▸"
            value={config.exhaustedTokenThreshold}
            min={10_000_000}
            max={200_000_000}
            step={5_000_000}
            onChange={(v) => patch({ exhaustedTokenThreshold: v })}
          />
        </div>

        <p className="d-foot">
          *Claude 팀플랜 flat rate이라 실제 청구액과 무관. 활동성 지표로만 사용
        </p>
      </section>
    </div>
  );
}

function Stat({ label, tokens }: { label: string; tokens: number }) {
  return (
    <div className="d-card">
      <div className="d-card-label">{label}</div>
      <div className="d-card-tok">{formatTokens(tokens)}</div>
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
