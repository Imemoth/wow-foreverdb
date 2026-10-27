"use client";

import { useState } from "react";

/**
 * Face of a talent node: the talent's icon with its name on a strip when an icon URL is known and loads, otherwise the plain
 * name plate. A missing URL, a failed request (blocked, 404, wrong host) or a broken image all end in the name plate, so
 * the calculator is fully usable with no icons at all. Icons are decorative: the name is always real text on the button.
 */
export function NodeFace({ name, src }: { name: string; src?: string }) {
  const [failed, setFailed] = useState(false);
  const showIcon = Boolean(src) && !failed;
  return (
    <>
      {showIcon && (
        // eslint-disable-next-line @next/next/no-img-element -- external, allow-listed asset host; next/image would need inline styles the page CSP forbids
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
          className="absolute inset-0 h-full w-full rounded-md object-cover"
        />
      )}
      <span
        aria-hidden="true"
        className={showIcon ? "absolute inset-x-0 bottom-0 line-clamp-2 rounded-b-md bg-ink-950/85 py-px pl-0.5 pr-7 text-left text-[9px] leading-tight text-parchment" : "line-clamp-3 break-words"}
      >
        {name}
      </span>
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
      className="h-10 w-10 shrink-0 rounded-md border border-gold-500/40 object-cover"
    />
  );
}
