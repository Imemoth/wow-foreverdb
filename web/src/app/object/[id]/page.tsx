import { SourcePage, sourceMetadata } from "@/components/SourcePage";

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  return sourceMetadata("gameobject", (await params).id);
}

export default async function Page({ params }: { params: Params }) {
  return <SourcePage type="gameobject" rawId={(await params).id} />;
}
