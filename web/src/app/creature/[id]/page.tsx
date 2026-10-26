import { SourcePage, sourceMetadata } from "@/components/SourcePage";

type Params = Promise<{ id: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  return sourceMetadata("creature", (await params).id);
}

export default async function Page({ params, searchParams }: { params: Params; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <SourcePage type="creature" rawId={(await params).id} searchParams={searchParams} />;
}
