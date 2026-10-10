import { SourcePage, sourceMetadata } from "@/components/SourcePage";

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  return sourceMetadata("fishing", (await params).id);
}

export default async function Page({ params }: { params: Params }) {
  return <SourcePage type="fishing" rawId={(await params).id} />;
}
