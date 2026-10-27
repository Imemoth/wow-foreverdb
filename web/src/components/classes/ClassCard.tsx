import Link from "next/link";
import type { ClassInfo } from "@/lib/classes/classes";
import { classPath } from "@/lib/classes/classes";
import { joinNames } from "@/lib/classes/facts";
import { getTalentData } from "@/lib/talents/registry";
import { classStyle } from "./class-style";
import { ClassEmblem } from "./ClassEmblem";

export function ClassCard({ info }: { info: ClassInfo }) {
  const data = getTalentData(info.id);
  const s = classStyle(info.id);
  return (
    <li className={`panel group relative flex h-full flex-col overflow-hidden border-t-2 p-5 ${s.border}`} data-testid={`class-card-${info.id}`}>
      <div className="flex items-center gap-4">
        <ClassEmblem classId={info.id} name={info.name} size="md" />
        <h2 className="font-[family-name:var(--font-display)] text-2xl font-semibold">
          <Link href={classPath(info.id)} className="text-parchment no-underline hover:text-gold-300">{info.name}</Link>
        </h2>
      </div>
      {data ? (
        <>
          <p className="mt-3 flex-1 text-sm text-mist">{joinNames(data.trees.map((t) => t.name))}</p>
          <p className="mt-3 text-xs text-mist">{data.pointBudget.total} talent points · build {data.build.version}</p>
          <Link href={`${classPath(info.id)}#talents`} className="btn-ghost mt-4 self-start text-sm">Talent calculator</Link>
        </>
      ) : (
        <p className="mt-3 flex-1 text-sm text-mist">Talent data for this class is not available yet.</p>
      )}
    </li>
  );
}
