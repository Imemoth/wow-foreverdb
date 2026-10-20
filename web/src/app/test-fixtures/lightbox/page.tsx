import { notFound } from "next/navigation";
import { MediaSlotGallery } from "@/components/download/MediaSlotGallery";
import type { MediaSlot } from "@/lib/download/media-slots";

/**
 * Internal Playwright-only harness for MediaSlotGallery's lightbox (P2-E remediation,
 * "Screenshot gallery accessibility and Lightbox hardening"). All eight public /download
 * media slots stay placeholders - none has a real asset, so the open-image interaction is
 * never exercised by a normal page visit. This route exists ONLY to give an automated
 * test a real openable lightbox to drive keyboard/focus assertions against, using an
 * obviously synthetic test-pattern image (see public/test-fixtures/lightbox-test-image.webp
 * - a striped warning pattern reading "TEST FIXTURE / NOT A REAL SCREENSHOT") that could
 * never be mistaken for Addon or Companion UI.
 *
 * Fail-closed by default: this page 404s unless E2E_FIXTURES_ENABLED=1 is set, which is
 * only ever set in playwright.config.ts's webServer env - never in the real app, beta, or
 * production configuration. Always noindex regardless, as a second layer.
 */
export const metadata = { robots: { index: false, follow: false } };

const TEST_SLOT: MediaSlot = {
  id: "test-fixture-lightbox",
  group: "addon",
  title: "Test fixture image",
  description: "Internal Playwright test fixture - not a real Addon or Companion screenshot.",
  intendedFilename: "lightbox-test-image.webp",
  asset: "/test-fixtures/lightbox-test-image.webp",
};

export default function LightboxTestFixturePage() {
  if (process.env.E2E_FIXTURES_ENABLED !== "1") notFound();
  return (
    <div className="mx-auto max-w-4xl py-10">
      <h1 className="panel-title text-xl">Lightbox test fixture</h1>
      <p className="mt-2 text-sm text-mist">Internal harness - not a public page.</p>
      <div className="mt-6">
        <MediaSlotGallery slots={[TEST_SLOT]} />
      </div>
    </div>
  );
}
