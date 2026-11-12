import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { jarFrom } from "@/lib/account/session";
import { adminRuntime } from "@/lib/admin/runtime";
import { resolveAdminSession } from "@/lib/admin/session";
import { AdminLogout } from "./AdminLogout";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin" };
export default async function AdminPage() {
  const rt=adminRuntime();
  if(rt.state==="disabled") notFound();
  if(rt.state!=="ready") return <main><h1>Admin temporarily unavailable</h1></main>;
  const store=await cookies();
  const state=await resolveAdminSession(rt.ac,jarFrom(()=>store.getAll()));
  if(!state.ok) return <main><h1>Admin access unavailable</h1><p>Complete a fresh TOTP verification from your account.</p><a href="/account">My account</a></main>;
  return <main><h1>Admin authentication verified</h1><p>Privileged actions are inactive.</p><AdminLogout /></main>;
}
