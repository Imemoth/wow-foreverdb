"use client";

import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MediaSlot } from "@/lib/download/media-slots";

/**
 * Renders a grid of media slots (P2-E Phase 3): a slot with `asset` set shows the real
 * screenshot and can be opened in an accessible enlarged view; a slot with no `asset`
 * renders an intentional, visually polished placeholder - never a broken-image icon and
 * never a fabricated mock screenshot. Swapping a placeholder for a real screenshot later
 * is a media-slots.ts edit only; this component does not change.
 *
 * The enlarged view is a dependency-free modal: a portal, Escape to close, backdrop click to
 * close (clicking inside the dialog itself does not, via stopPropagation), focus moves to the
 * dialog on open and returns to the trigger button on close, a real Tab/Shift+Tab focus trap
 * keeps keyboard focus inside the dialog while it's open, and every other top-level element gets
 * the `inert` attribute for the duration (not just visually covered - actually unfocusable and
 * hidden from the accessibility tree). Scroll lock uses a stylesheet-backed class
 * (`.body-scroll-locked` in globals.css) toggled via classList, not a per-element inline `style`
 * mutation, so there's no ambiguity about the page's style-src CSP. prefers-reduced-motion is
 * handled globally by globals.css (every transition/animation duration collapses to ~0), so no
 * extra JS branching is needed here. See `tests/e2e/download-lightbox.spec.ts` (driven against the
 * gated `/test-fixtures/lightbox` harness, since every public slot ships without a real asset).
 */
export function MediaSlotGallery({ slots }: { slots: MediaSlot[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const triggerRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const close = () => setOpenIndex(null);

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
        <MediaSlotLightbox
          slot={slots[openIndex]}
          onClose={close}
          triggerRefs={triggerRefs}
          triggerIndex={openIndex}
        />
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

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function MediaSlotLightbox({
  slot, onClose, triggerRefs, triggerIndex,
}: {
  slot: MediaSlot;
  onClose: () => void;
  triggerRefs: RefObject<(HTMLButtonElement | null)[]>;
  triggerIndex: number;
}) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const triggerEl = triggerRefs.current[triggerIndex];
    dialogRef.current?.focus();
    document.documentElement.classList.add("body-scroll-locked");

    // Make every other top-level element inert (unfocusable, untabbable, hidden from the
    // accessibility tree) while the modal is open, so background content is never keyboard- or
    // screen-reader-reachable behind it - not just visually covered. `overlayRef.current` is this
    // portal's own container, which must stay interactive, so it's excluded.
    const siblings = Array.from(document.body.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el !== overlayRef.current,
    );
    for (const el of siblings) el.setAttribute("inert", "");

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      // Trap Tab/Shift+Tab inside the dialog: wrap from the last focusable element back to the
      // first (and vice versa) instead of letting focus escape into the (now-inert) page behind it.
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.documentElement.classList.remove("body-scroll-locked");
      // Remove `inert` before returning focus: a focus() call on an element that is still
      // inert (or a descendant of one) is a silent no-op per spec, so restoring focus has to
      // happen strictly after the background is un-inerted, not in the same tick as the
      // setOpenIndex(null) call that triggers this unmount.
      for (const el of siblings) el.removeAttribute("inert");
      document.removeEventListener("keydown", onKeyDown);
      triggerEl?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only on mount/unmount
  }, []);

  return createPortal(
    <div
      ref={overlayRef}
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
