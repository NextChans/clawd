/** Persisted play stats — counters the cat accumulates over its life. Stored in
 * its own Tauri store (`stats.json`) and shared across the cat + details windows
 * the same way config is. Kept content-free: play counters only, never usage
 * numbers. */
export interface Stats {
  /** Times fed (successful feeds, not cooldown no-ops). */
  feedCount: number;
  /** Late-night care nudges seen. */
  nightCount: number;
  /** Golden-cat shimmers witnessed. */
  goldenCount: number;
  /** Parties set off (rapid-click easter egg). */
  partyCount: number;
  /** Pomodoro focus sessions completed. */
  focusCount: number;
  /** Times the cat was petted (drives the bond meter). */
  petCount: number;
  /** Whether the cat-tower ever reached its top tier (3). */
  towerTier3: boolean;
}

export const DEFAULT_STATS: Stats = {
  feedCount: 0,
  nightCount: 0,
  goldenCount: 0,
  partyCount: 0,
  focusCount: 0,
  petCount: 0,
  towerTier3: false,
};

/** Events the frontend records; each maps to a stat mutation in `applyEvent`. */
export type StatEvent =
  | 'feed'
  | 'night'
  | 'golden'
  | 'party'
  | 'focus'
  | 'pet'
  | 'tower3';

/** Fold an event into a stats snapshot, returning a new object. */
export function applyEvent(s: Stats, ev: StatEvent): Stats {
  switch (ev) {
    case 'feed':
      return { ...s, feedCount: s.feedCount + 1 };
    case 'night':
      return { ...s, nightCount: s.nightCount + 1 };
    case 'golden':
      return { ...s, goldenCount: s.goldenCount + 1 };
    case 'party':
      return { ...s, partyCount: s.partyCount + 1 };
    case 'focus':
      return { ...s, focusCount: s.focusCount + 1 };
    case 'pet':
      return { ...s, petCount: s.petCount + 1 };
    case 'tower3':
      return s.towerTier3 ? s : { ...s, towerTier3: true };
    default:
      return s;
  }
}

/** Merge a possibly-partial / hand-edited store value onto the defaults. */
export function mergeStats(p: Partial<Stats> | undefined | null): Stats {
  const s = p ?? {};
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    feedCount: num(s.feedCount, 0),
    nightCount: num(s.nightCount, 0),
    goldenCount: num(s.goldenCount, 0),
    partyCount: num(s.partyCount, 0),
    focusCount: num(s.focusCount, 0),
    petCount: num(s.petCount, 0),
    towerTier3: s.towerTier3 === true,
  };
}

// ---------------------------------------------------------------------------
// Achievements — derived purely from Stats.
// ---------------------------------------------------------------------------

export interface Achievement {
  id: string;
  emoji: string;
  title: string;
  desc: string;
  /** Unlocked test + progress (current / target) for the locked-state hint. */
  done: (s: Stats) => boolean;
  progress: (s: Stats) => { cur: number; target: number };
}

const count = (cur: number, target: number) => ({ cur: Math.min(cur, target), target });

export const ACHIEVEMENTS: Achievement[] = [
  {
    id: 'first_golden',
    emoji: '✨',
    title: '행운의 목격자',
    desc: '골든 캣을 처음 목격',
    done: (s) => s.goldenCount >= 1,
    progress: (s) => count(s.goldenCount, 1),
  },
  {
    id: 'feed_10',
    emoji: '🍚',
    title: '든든한 집사',
    desc: '먹이 10번 주기',
    done: (s) => s.feedCount >= 10,
    progress: (s) => count(s.feedCount, 10),
  },
  {
    id: 'pet_50',
    emoji: '💕',
    title: '쓰담쓰담 마스터',
    desc: '쓰다듬기 50번',
    done: (s) => s.petCount >= 50,
    progress: (s) => count(s.petCount, 50),
  },
  {
    id: 'night_3',
    emoji: '🌙',
    title: '올빼미 동료',
    desc: '밤샘 걱정 3번 듣기',
    done: (s) => s.nightCount >= 3,
    progress: (s) => count(s.nightCount, 3),
  },
  {
    id: 'party_1',
    emoji: '🎉',
    title: '파티 애니멀',
    desc: '숨겨진 파티 발견',
    done: (s) => s.partyCount >= 1,
    progress: (s) => count(s.partyCount, 1),
  },
  {
    id: 'tower_3',
    emoji: '🏆',
    title: '타워 마스터',
    desc: '캣타워 최고 단계 도달',
    done: (s) => s.towerTier3,
    progress: (s) => count(s.towerTier3 ? 1 : 0, 1),
  },
  {
    id: 'focus_5',
    emoji: '🍅',
    title: '집중의 대가',
    desc: '뽀모도로 5회 완주',
    done: (s) => s.focusCount >= 5,
    progress: (s) => count(s.focusCount, 5),
  },
];

/** The set of unlocked achievement ids for a stats snapshot. */
export function unlockedIds(s: Stats): Set<string> {
  return new Set(ACHIEVEMENTS.filter((a) => a.done(s)).map((a) => a.id));
}

// ---------------------------------------------------------------------------
// Bond — a friendship level that grows with care (feeds, pets, focus).
// ---------------------------------------------------------------------------

/** XP each caring action is worth toward the bond. */
export function bondXp(s: Stats): number {
  return s.feedCount * 3 + s.petCount * 1 + s.focusCount * 5;
}

/** Cumulative XP needed to *reach* each level index (0-based). Level maxes at
 * the last entry. */
const BOND_THRESHOLDS = [0, 20, 60, 140, 300];
export const BOND_MAX_LEVEL = BOND_THRESHOLDS.length; // 5

export const BOND_LABELS = ['낯가림', '친구', '단짝', '베프', '가족', '소울메이트'];

/** Bond level (1..BOND_MAX_LEVEL) + progress toward the next level. */
export function bondLevel(s: Stats): {
  level: number;
  label: string;
  xp: number;
  intoLevel: number;
  span: number;
  atMax: boolean;
} {
  const xp = bondXp(s);
  let level = 1;
  for (let i = 0; i < BOND_THRESHOLDS.length; i++) {
    if (xp >= BOND_THRESHOLDS[i]) level = i + 1;
  }
  const atMax = level >= BOND_MAX_LEVEL;
  const base = BOND_THRESHOLDS[level - 1];
  const next = atMax ? base : BOND_THRESHOLDS[level];
  return {
    level,
    label: BOND_LABELS[level - 1] ?? BOND_LABELS[0],
    xp,
    intoLevel: xp - base,
    span: atMax ? 1 : next - base,
    atMax,
  };
}
