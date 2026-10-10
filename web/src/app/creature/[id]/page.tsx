import { SourcePage, sourceMetadata } from "@/components/SourcePage";

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  return sourceMetadata("creature", (await params).id);
}

export default async function Page({ params }: { params: Params }) {
  return <SourcePage type="creature" rawId={(await params).id} />;
}
