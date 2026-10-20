"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MediaSlot } from "@/lib/download/media-slots";

/**
 * Renders a grid of media slots (P2-E Phase 3): a slot with `asset` set shows the real
 * screenshot and can be opened in an accessible enlarged view; a slot with no `asset`
 * renders an intentional, visually polished placeholder - never a broken-image icon and
 * never a fabricated mock screenshot. Swapping a placeholder for a real screenshot later
 * is a media-slots.ts edit only; this component does not change.
 *
 * The enlarged view is a simple, dependency-free modal (same pattern as MobileNav.tsx):
 * a portal, Escape to close, backdrop click to close, focus moves to the dialog on open
 * and returns to the trigger button on close. prefers-reduced-motion is handled globally
 * by globals.css (every transition/animation duration collapses to ~0), so no extra JS
 * branching is needed here.
 */
export function MediaSlotGallery({ slots }: { slots: MediaSlot[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const triggerRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const close = () => {
    const i = openIndex;
    setOpenIndex(null);
    if (i != null) triggerRefs.current[i]?.focus();
  };

  return (
    <>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {slots.map((slot, i) => (
          <li key={slot.id}>
            <MediaSlotCard
              slot={slot}
              buttonRef={(el) => { triggerRefs.current[i] = el; }}
              onOpen={slot.asset ? () => setOpenIndex(i) : undefined}
            />
          </li>
        ))}
      </ul>
      {openIndex != null && slots[openIndex]?.asset && (
        <MediaSlotLightbox slot={slots[openIndex]} onClose={close} />
      )}
    </>
  );
}

function MediaSlotCard({
  slot, onOpen, buttonRef,
}: {
  slot: MediaSlot;
  onOpen?: () => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
}) {
  const titleId = useId();
  const body = slot.asset ? (
    // eslint-disable-next-line @next/next/no-img-element -- static repository asset, images.unoptimized site-wide
    <img src={slot.asset} alt="" className="h-full w-full object-cover transition group-hover:scale-[1.02]" />
  ) : (
    <PlaceholderArt />
  );

  return (
    <figure className="panel overflow-hidden p-0">
      {onOpen ? (
        <button
          ref={buttonRef}
          type="button"
          onClick={onOpen}
          aria-labelledby={titleId}
          className="group block aspect-video w-full overflow-hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-400"
        >
          {body}
        </button>
      ) : (
        <div className="aspect-video w-full overflow-hidden" aria-hidden="true">
          {body}
        </div>
      )}
      <figcaption className="space-y-1 p-4">
        <p id={titleId} className="font-[family-name:var(--font-display)] text-sm font-semibold text-parchment">{slot.title}</p>
        <p className="text-xs text-mist">{slot.description}</p>
        {!slot.asset && <p className="text-xs italic text-mist/70">Screenshot coming soon</p>}
      </figcaption>
    </figure>
  );
}

/** Deliberately a styled placeholder, not a fake mock UI screenshot: a soft gradient
 *  panel with the AzerDex compass glyph, clearly reading as "not yet available" rather
 *  than as a real (but blurry/broken) image. */
function PlaceholderArt() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-ink-800 via-ink-900 to-ink-950">
      <svg viewBox="0 0 40 40" className="h-10 w-10 opacity-40" aria-hidden="true">
        <circle cx="20" cy="20" r="17.5" fill="none" stroke="#9b8cc9" strokeWidth="2" />
        <path d="M20 10 27 20 20 30 13 20z" fill="none" stroke="#9b8cc9" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function MediaSlotLightbox({ slot, onClose }: { slot: MediaSlot; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    dialogRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only on mount/unmount
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/90 p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="relative max-h-[90vh] max-w-4xl overflow-hidden rounded-xl border border-ink-600 bg-ink-900 shadow-2xl focus:outline-none"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close enlarged image"
          className="absolute right-3 top-3 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-ink-950/80 text-parchment hover:bg-ink-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-400"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
        {/* eslint-disable-next-line @next/next/no-img-element -- static repository asset */}
        <img src={slot.asset} alt={slot.description} className="max-h-[80vh] w-full object-contain" />
        <p id={titleId} className="p-4 text-sm font-semibold text-parchment">{slot.title}</p>
      </div>
    </div>,
    document.body,
  );
}
