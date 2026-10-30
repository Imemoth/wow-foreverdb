"use client";

import { useState } from "react";

export type NodeState = "maxed" | "partial" | "available" | "waiting" | "locked";

// How the icon itself is treated per state: bright when a point can be spent or has been, muted when no points are left, dark and
// desaturated while the requirements are not met. The state is never carried by colour alone (border, badge, lock glyph, text).
const ICON_CLASS: Record<NodeState, string> = {
  maxed: "",
  partial: "",
  available: "",
  waiting: "saturate-[.6] brightness-[.8]",
  locked: "grayscale brightness-[.5]",
};

function Lock() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false" data-testid="lock-glyph" className="absolute left-px top-px h-3 w-3 rounded-full bg-ink-950/80 p-[2px] text-mist">
      <path fill="currentColor" d="M3.2 5V3.9a2.8 2.8 0 0 1 5.6 0V5H10v5.6H2V5h1.2Zm1.2 0h3.2V3.9a1.6 1.6 0 0 0-3.2 0V5Z" />
    </svg>
  );
}

/**
 * Face of a talent node, filling its (square) frame: the talent's icon when an icon URL is known and loads, otherwise the plain
 * name plate. A missing URL, a failed request (blocked, 404, wrong host) or a broken image all end in the name plate, so
 * the calculator is fully usable with no icons at all. Icons are decorative: the name is always real text on the button.
 */
export function NodeFace({ name, src, state = "available" }: { name: string; src?: string; state?: NodeState }) {
  const [failed, setFailed] = useState(false);
  const showIcon = Boolean(src) && !failed;
  return (
    <>
      {showIcon ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- external, allow-listed asset host; next/image would need inline styles the page CSP forbids */}
          <img
            // Catches an error that happened before hydration attached onError.
            ref={(el) => {
              if (el && el.complete && el.naturalWidth === 0) setFailed(true);
            }}
            src={src}
            alt=""
            aria-hidden="true"
            draggable={false}
            loading="lazy"
            decoding="async"
            data-testid="talent-icon"
            onError={() => setFailed(true)}
            className={`absolute inset-0 h-full w-full rounded-[4px] object-cover transition-[filter] ${ICON_CLASS[state]}`}
          />
          <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[4px] shadow-[inset_0_0_0_1px_rgb(0_0_0/0.5)]" />
        </>
      ) : (
        <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center overflow-hidden px-0.5 text-center text-[9px] font-semibold leading-[1.1]">
          <span className="line-clamp-3 break-words">{name}</span>
        </span>
      )}
      {state === "locked" && <Lock />}
    </>
  );
}

/** Small icon for the tooltip/detail header; renders nothing if there is no URL or it fails. */
export function CardIcon({ src }: { src?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- see NodeFace
    <img
      ref={(el) => {
        if (el && el.complete && el.naturalWidth === 0) setFailed(true);
      }}
      src={src}
      alt=""
      aria-hidden="true"
      draggable={false}
      data-testid="card-icon"
      onError={() => setFailed(true)}
      className="h-10 w-10 shrink-0 rounded-[5px] border border-gold-500/50 object-cover shadow-[0_0_0_1px_rgb(0_0_0/0.6)]"
    />
  );
}
