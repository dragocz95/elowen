'use client';
import type { AgentPresenceState } from './useAgentPresence';

const PARTICLES = Array.from({ length: 10 }, (_, index) => index);

/** The original flat Elowen mascot, kept pixel-for-pixel recognizable. Depth and liveliness live in
 *  the surrounding CSS/SVG-like layers — no generated 3D character and no duplicate brand asset. */
export function ElowenPresence({ state, compact = false, label }: {
  state: AgentPresenceState;
  compact?: boolean;
  label: string;
}) {
  return (
    <div className={`elowen-presence elowen-presence--${state}${compact ? ' elowen-presence--compact' : ''}`} role="img" aria-label={label}>
      <span className="elowen-presence__aura" aria-hidden />
      <span className="elowen-presence__orbit elowen-presence__orbit--one" aria-hidden />
      <span className="elowen-presence__orbit elowen-presence__orbit--two" aria-hidden />
      <span className="elowen-presence__ground" aria-hidden />
      {PARTICLES.map((index) => <span key={index} className={`elowen-presence__particle elowen-presence__particle--${index + 1}`} aria-hidden />)}
      {/* eslint-disable-next-line @next/next/no-img-element -- local brand asset, intentionally unmodified */}
      <img src="/icon.png" alt="" className="elowen-presence__mascot" draggable={false} />
      <style>{`
        .elowen-presence { --presence-hot: #ff5236; --presence-warm: #ff8a4c; position: relative; display: grid; place-items: center; width: min(100%, 25rem); aspect-ratio: 1; isolation: isolate; }
        .elowen-presence--compact { width: 8rem; }
        .elowen-presence__mascot { position: relative; z-index: 5; width: 49%; height: auto; user-select: none; filter: drop-shadow(0 1rem 2rem rgb(255 45 28 / .16)); animation: elowen-breathe 4.8s ease-in-out infinite; }
        .elowen-presence__aura { position: absolute; inset: 19%; z-index: -2; border-radius: 999px; background: radial-gradient(circle, rgb(255 82 54 / .2), rgb(255 82 54 / .06) 42%, transparent 72%); filter: blur(18px); animation: elowen-aura 4.8s ease-in-out infinite; }
        .elowen-presence__orbit { position: absolute; z-index: -1; width: 76%; height: 36%; border: 1px solid rgb(255 82 54 / .28); border-radius: 50%; transform: rotate(-12deg); animation: elowen-orbit 13s linear infinite; }
        .elowen-presence__orbit::after { content: ''; position: absolute; left: 12%; top: 12%; width: .42rem; height: .42rem; border-radius: 999px; background: var(--presence-hot); box-shadow: 0 0 1rem rgb(255 82 54 / .8); }
        .elowen-presence__orbit--two { width: 62%; height: 27%; opacity: .55; transform: rotate(17deg); animation-direction: reverse; animation-duration: 18s; }
        .elowen-presence__ground { position: absolute; bottom: 20%; width: 46%; height: 8%; border-radius: 50%; background: radial-gradient(ellipse, rgb(255 82 54 / .32), transparent 68%); filter: blur(8px); }
        .elowen-presence__particle { position: absolute; z-index: 1; left: 50%; top: 50%; width: .22rem; height: .22rem; border-radius: 999px; background: var(--presence-warm); opacity: .55; animation: elowen-particle 5s ease-in-out infinite; }
        ${PARTICLES.map((index) => `.elowen-presence__particle--${index + 1} { --px: ${20 + (index * 37) % 70}%; --py: ${17 + (index * 53) % 68}%; animation-delay: -${(index * .47).toFixed(2)}s; animation-duration: ${(4.1 + (index % 4) * .7).toFixed(1)}s; }`).join('\n')}
        .elowen-presence--thinking .elowen-presence__orbit { animation-duration: 6.5s; }
        .elowen-presence--working .elowen-presence__particle { animation-duration: 1.8s; opacity: .9; }
        .elowen-presence--working .elowen-presence__mascot { animation-duration: 2.2s; }
        .elowen-presence--needs_input .elowen-presence__aura { background: radial-gradient(circle, rgb(245 158 11 / .28), rgb(255 82 54 / .08) 48%, transparent 72%); animation-duration: 1.5s; }
        .elowen-presence--needs_input .elowen-presence__orbit { border-color: rgb(245 158 11 / .45); }
        .elowen-presence--success .elowen-presence__aura { background: radial-gradient(circle, rgb(34 197 94 / .18), rgb(255 82 54 / .08) 46%, transparent 72%); }
        .elowen-presence--offline .elowen-presence__mascot { filter: grayscale(.85) opacity(.58); animation: none; }
        .elowen-presence--offline .elowen-presence__orbit, .elowen-presence--offline .elowen-presence__particle { animation-play-state: paused; opacity: .12; }
        @keyframes elowen-breathe { 0%, 100% { transform: translateY(0) scale(1); } 50% { transform: translateY(-2.5%) scale(1.018); } }
        @keyframes elowen-aura { 0%, 100% { opacity: .62; transform: scale(.94); } 50% { opacity: 1; transform: scale(1.06); } }
        @keyframes elowen-orbit { from { rotate: 0deg; } to { rotate: 360deg; } }
        @keyframes elowen-particle { 0%, 100% { left: 50%; top: 58%; opacity: 0; transform: scale(.45); } 42% { opacity: .8; } 75% { left: var(--px); top: var(--py); opacity: .25; transform: scale(1); } }
        html[data-effects='reduced'] .elowen-presence * { animation: none !important; }
        @media (prefers-reduced-motion: reduce) { html[data-effects-mode='auto'] .elowen-presence * { animation: none !important; } }
      `}</style>
    </div>
  );
}
