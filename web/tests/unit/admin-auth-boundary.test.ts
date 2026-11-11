import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { b64urlEncode } from "@/lib/account/crypto";
import { csrfBinding, mintCsrf } from "@/lib/account/csrf";
import { jarFrom, readSession, writeSession, type StoredSession } from "@/lib/account/session";
import { adminCookie, adminCsrfCookie, clearAdminSession, readAdminSession, resolveAdminSession, writeAdminSession } from "@/lib/admin/session";
import { HOSTED_ADMIN_AUTH_APPROVED, adminEnabled } from "@/lib/admin/runtime";
import type { AccountContext } from "@/lib/account/runtime";

const SECRET="unit-test-secret-0123456789abcdefghijklmnopqrstuvwxyz";
const UID="123e4567-e89b-42d3-a456-426614174000";
const SID="223e4567-e89b-42d3-a456-426614174000";
const ORIGIN="http://localhost:3000";
const now=()=>Math.floor(Date.now()/1000);
const jwt=(aal:string,exp=now()+1800)=>{
  const enc=(v:unknown)=>b64urlEncode(new TextEncoder().encode(JSON.stringify(v)));
  return `${enc({alg:"HS256"})}.${enc({sub:UID,session_id:SID,aal,exp,iat:now()})}.${"x".repeat(43)}`;
};
const stored=(aal="aal2"):StoredSession=>({v:1,k:"user",uid:UID,sid:SID,at:jwt(aal),rt:"refresh-token-is-never-in-admin-cookie",ex:now()+1800,sc:now(),rf:now()});
const ac={cfg:{mode:"local",authOrigin:"http://127.0.0.1:54321",projectRef:null,publishableKey:"sb_publishable_unit",csrfSecret:SECRET},
  env:{hosted:false,FOREVERDB_DEPLOYMENT:"local",RATE_LIMIT_BACKEND:"memory"},https:false,siteOrigin:ORIGIN,
  callbackUrl:`${ORIGIN}/account/auth/confirm`,cookies:{session:"fdb_acct",csrf:"fdb_csrf"},turnstileSecret:null} as AccountContext;
vi.mock("@/lib/account/runtime",()=>({ accountRuntime:()=>({state:"ready",ctx:ac}) }));
const jar=(value:string)=>jarFrom(()=>[{name:adminCookie,value}]);
function cookieValue(header:string){return header.split(";")[0]!.split("=")[1]!;}
afterEach(()=>vi.unstubAllGlobals());

describe("isolated Admin cookie and live entry boundary",()=>{
  it("is compiled off on hosted environments and never admits production mode",()=>{
    expect(HOSTED_ADMIN_AUTH_APPROVED).toBe(false);
    expect(adminEnabled(ac)).toBe(true);
    expect(adminEnabled({...ac,cfg:{...ac.cfg,mode:"production"}})).toBe(false);
    expect(adminEnabled({...ac,env:{...ac.env,hosted:true}})).toBe(false);
  });
  it("seals only an AAL2 access token in a Secure, HttpOnly, Path=/admin cookie with no refresh token",async()=>{
    const headers:string[]=[];
    const sink={append:(_name:string,value:string)=>headers.push(value)};
    expect(await writeAdminSession(ac,sink,stored("aal1"))).toBe(false);
    expect(headers).toEqual([]);
    expect(await writeAdminSession(ac,sink,stored())).toBe(true);
    expect(headers).toHaveLength(1);
    expect(headers[0]).toMatch(/^__Secure-fdb_admin=.*; Path=\/admin; Max-Age=[0-9]+; HttpOnly; Secure; SameSite=Lax$/);
    expect(headers[0]).not.toContain("refresh-token-is-never-in-admin-cookie");
    expect((await readAdminSession(ac,jar(cookieValue(headers[0]!))))?.uid).toBe(UID);
    expect(await readAdminSession(ac,jar(cookieValue(headers[0]!).slice(0,-1)+"A"))).toBeNull();
    const cleared:string[]=[];clearAdminSession({append:(_n,v)=>cleared.push(v)});
    expect(cleared.filter(v=>v.includes("Path=/admin"))).toHaveLength(2);
    expect(cleared.every(v=>v.includes("Max-Age=0"))).toBe(true);
  });
  it("requires Auth /user and a fresh private status decision for every Admin read",async()=>{
    const headers:string[]=[];
    await writeAdminSession(ac,{append:(_n,v)=>headers.push(v)},stored());
    const token=cookieValue(headers[0]!);
    let ready=false;
    const calls:string[]=[];
    vi.stubGlobal("fetch",vi.fn(async(input:string|URL|Request)=>{
      const url=String(input);calls.push(url);
      if(url.endsWith("/auth/v1/user")) return Response.json({id:UID,email:"a@example.test",email_confirmed_at:"2026-01-01T00:00:00Z",is_anonymous:false});
      if(url.endsWith("/rest/v1/rpc/fdb_admin_entry_ready")) return Response.json(ready);
      throw Error("unexpected request");
    }));
    expect((await resolveAdminSession(ac,jar(token))).ok).toBe(false);
    ready=true;
    expect((await resolveAdminSession(ac,jar(token))).ok).toBe(true);
    expect(calls.filter(v=>v.includes("/auth/v1/user"))).toHaveLength(2);
    expect(calls.filter(v=>v.includes("fdb_admin_entry_ready"))).toHaveLength(2);
  });
  it("revokes the server-side Admin session on local logout; a copied old cookie fails its next read",async()=>{
    const headers:string[]=[];
    await writeAdminSession(ac,{append:(_n,v)=>headers.push(v)},stored());
    const oldCookie=cookieValue(headers[0]!);
    const csrf=await mintCsrf(SECRET,`admin:${SID}`);
    let revoked=false;
    const calls:string[]=[];
    vi.stubGlobal("fetch",vi.fn(async(input:string|URL|Request)=>{
      const url=String(input);calls.push(url);
      if(url.endsWith("/auth/v1/user")) return Response.json({id:UID,email:"a@example.test",email_confirmed_at:"2026-01-01T00:00:00Z",is_anonymous:false});
      if(url.endsWith("/rest/v1/rpc/fdb_admin_entry_ready")) return Response.json(!revoked);
      if(url.endsWith("/rest/v1/rpc/fdb_admin_session_revoke")){revoked=true;return Response.json(true);}
      throw Error("unexpected request");
    }));
    const {POST}=await import("@/app/admin/api/logout/route");
    const req=new NextRequest(`${ORIGIN}/admin/api/logout`,{method:"POST",headers:{origin:ORIGIN,"sec-fetch-site":"same-origin",
      "content-type":"application/json","x-fdb-csrf":csrf,cookie:`${adminCookie}=${oldCookie}; ${adminCsrfCookie}=${csrf}`},body:"{}"});
    const res=await POST(req);
    expect(res.status).toBe(200);
    expect(revoked).toBe(true);
    expect(res.headers.getSetCookie().some(v=>v.startsWith(`${adminCookie}=`)&&v.includes("Max-Age=0"))).toBe(true);
    expect((await resolveAdminSession(ac,jar(oldCookie))).ok).toBe(false);
    expect(calls.some(v=>v.includes("/auth/v1/logout"))).toBe(false);
  });
});

describe("Account to Admin route guards (mock transport only)",()=>{
  async function request(path:string,withCsrf=true,s=stored(),body:unknown={}){
    const out:string[]=[];
    await writeSession(SECRET,{append:(_n,v)=>out.push(v)},jarFrom(()=>[]),false,s);
    const token=await mintCsrf(SECRET,csrfBinding(s));
    const cookies=`${out.map(cookieValue).map((v,i)=>`fdb_acct${i?`.${i}`:""}=${v}`).join("; ")}; fdb_csrf=${token}`;
    return new NextRequest(`${ORIGIN}${path}`,{method:"POST",headers:{origin:ORIGIN,"sec-fetch-site":"same-origin","content-type":"application/json",
      ...(withCsrf?{"x-fdb-csrf":token}:{}),cookie:cookies},body:JSON.stringify(body)});
  }
  it("rejects missing CSRF before Auth or SQL and returns a token only after a private entry decision",async()=>{
    let rpc=false;
    vi.stubGlobal("fetch",vi.fn(async(input:string|URL|Request)=>{
      const url=String(input);
      if(url.endsWith("/auth/v1/user")) return Response.json({id:UID,email:"a@example.test",email_confirmed_at:"2026-01-01T00:00:00Z",is_anonymous:false});
      if(url.endsWith("/rest/v1/rpc/fdb_admin_handoff_start")){rpc=true;return Response.json(false);}
      throw Error("unexpected request");
    }));
    const {POST}=await import("@/app/account/api/admin/handoff/start/route");
    expect((await POST(await request("/account/api/admin/handoff/start",false))).status).toBe(403);
    expect(rpc).toBe(false);
    const denied=await POST(await request("/account/api/admin/handoff/start"));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ok:false,error:"admin_denied"});
    expect(rpc).toBe(true);
  });
  it("persists an Account refresh that precedes a refused TOTP attempt",async()=>{
    const old={...stored(),ex:now()+1,rf:now()-100};
    const factorId="323e4567-e89b-42d3-a456-426614174000";
    const challengeId="423e4567-e89b-42d3-a456-426614174000";
    vi.stubGlobal("fetch",vi.fn(async(input:string|URL|Request)=>{
      const url=String(input);
      if(url.includes("grant_type=refresh_token")) return Response.json({access_token:jwt("aal1",now()+3600),refresh_token:"new-refresh-token-rotated",expires_in:3600,
        token_type:"bearer",user:{id:UID,email:"a@example.test",email_confirmed_at:"2026-01-01T00:00:00Z",is_anonymous:false}});
      if(url.endsWith("/auth/v1/user")) return Response.json({id:UID,email:"a@example.test",email_confirmed_at:"2026-01-01T00:00:00Z",is_anonymous:false,
        factors:[{id:factorId,factor_type:"totp",status:"verified"}]});
      if(url.includes(`/factors/${factorId}/verify`)) return Response.json({error_code:"mfa_verification_failed"},{status:422});
      throw Error("unexpected request");
    }));
    const {POST}=await import("@/app/account/api/admin/mfa/verify/route");
    const res=await POST(await request("/account/api/admin/mfa/verify",true,old,{factorId,challengeId,code:"000000"}));
    expect(res.status).toBe(403);
    const set=res.headers.getSetCookie().find(v=>v.startsWith("fdb_acct="));
    expect(set).toBeTruthy();
    const newJar=jarFrom(()=>[{name:"fdb_acct",value:cookieValue(set!)}]);
    expect((await readSession(SECRET,newJar,false)).session?.rt).toBe("new-refresh-token-rotated");
  });
});
