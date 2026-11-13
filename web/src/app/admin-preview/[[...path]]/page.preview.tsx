import { notFound } from "next/navigation";
import { PreviewView } from "@/admin-preview/ui/PreviewApp";
import { evaluatePreviewGate } from "@/lib/admin-preview-gate";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin preview (synthetic)", robots: { index: false, follow: false } };

export default function AdminPreviewPage() {
  if (!evaluatePreviewGate().allowed) notFound();
  return <PreviewView />;
}
