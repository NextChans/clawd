import { Cat } from '../Cat/Cat';
import { ACTIVITY_BADGE, Peer } from '../../types';
import './peers.css';

/**
 * Visiting cats from clawd peers on the LAN, gathered along the bottom-left of
 * the overlay. Each shows the peer's coat + mood pose, a nickname, and a coarse
 * activity badge (🔥 busy / 💤 idle …). Purely decorative and click-through —
 * only rendered in Roam (the grab window is too small), like the furniture row.
 *
 * MVP: peers stand and idle rather than wander. The wander scheduler
 * (`roam.rs`) is single-cat today; giving visitors their own gentle roaming is
 * a natural follow-up.
 */
export function PeerCats({ peers }: { peers: Peer[] }) {
  if (peers.length === 0) return null;
  return (
    <div className="peer-strip" aria-label="네트워크 친구 고양이">
      {peers.map((p, i) => {
        const badge = ACTIVITY_BADGE[p.activity] ?? ACTIVITY_BADGE.light;
        return (
          <div
            className="peer-cat"
            key={p.id}
            // Stagger the idle bob so the visitors don't bounce in lockstep.
            style={{ animationDelay: `${(i % 6) * 0.35}s` }}
          >
            <div className="peer-label" title={`${p.nickname} · ${badge.label}`}>
              <span className="peer-badge">{badge.icon}</span>
              <span className="peer-name">{p.nickname}</span>
            </div>
            <div className="peer-sprite">
              <Cat state={p.state} gait="idle" color={p.color} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
