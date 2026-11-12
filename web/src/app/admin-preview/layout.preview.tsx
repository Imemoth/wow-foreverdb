import { notFound } from "next/navigation";
import { PreviewFrame } from "@/admin-preview/ui/PreviewApp";
import { evaluatePreviewGate } from "@/lib/admin-preview-gate";

/**
 * ADM-UI-PREVIEW-01. This file is only recognised as a route in a dedicated preview build (next.config.ts pageExtensions). Even then the runtime
 * gate must pass: absent or inconsistent configuration => 404, before any preview UI is rendered.
 */
export default function AdminPreviewLayout({ children }: { children: React.ReactNode }) {
  if (!evaluatePreviewGate().allowed) notFound();
  return <PreviewFrame>{children}</PreviewFrame>;
}
