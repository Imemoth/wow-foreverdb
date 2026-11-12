import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { companionWithInstallation, link, startClaim, webUser } from "./world";
import { admin, auth, fingerprint, ownerOf, registeredSession, rpc, sleep } from "./stack";

function totp(secret:string):string {
  const alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits=0,acc=0;const bytes:number[]=[];
  for(const ch of secret.toUpperCase().replace(/=+$/, "")) {
    const n=alphabet.indexOf(ch);if(n<0) throw Error("invalid TOTP secret shape");
    acc=(acc<<5)|n;bits+=5;
    if(bits>=8){bits-=8;bytes.push((acc>>bits)&255);}
  }
  const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
  const h=createHmac("sha1",Buffer.from(bytes)).update(counter).digest();
  return String((h.readUInt32BE(h[h.length-1]!&15)&0x7fffffff)%1000000).padStart(6,"0");
}

test("pinned GoTrue TOTP step-up invalidates a registered Companion AAL1 session, while ownership and Guildbook isolation survive",async({playwright})=>{
  const db=await admin();
  try {
    const website=await webUser(playwright,"mfa-compat");
    const linked=await companionWithInstallation({guilds:2,members:4,tag:"MFA"});
    const anonymous=await companionWithInstallation({guilds:1,members:2,tag:"ANON"});
    expect((await link(website.c,await startClaim(linked),website.password)).status()).toBe(200);
    expect(await ownerOf(db,linked.installationId)).toBe(website.uid);
    const before=await fingerprint(db);
    let companion=await registeredSession(website.email,website.password);
    expect(companion.uid).toBe(website.uid);
    let webToken=website.accessToken;
    const enroll=await auth("/factors",{body:{factor_type:"totp",friendly_name:"AzerDex Admin",issuer:"AzerDex"},token:webToken});
    expect(enroll.status).toBe(200);
    const factorId=enroll.body.id as string;
    const secret=enroll.body.totp.secret as string;
    expect(factorId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(secret.length).toBeGreaterThan(10);
    expect((await auth("/user",{method:"GET",token:companion.token})).status).toBe(200);
    const afterEnroll=await auth("/token?grant_type=refresh_token",{body:{refresh_token:companion.refresh}});
    expect(afterEnroll.status).toBe(200);
    companion={...companion,token:afterEnroll.body.access_token,refresh:afterEnroll.body.refresh_token};
    expect((await rpc(companion.token,"fdb_installation_link_status",{p_installation_id:linked.installationId})).body).toEqual({state:"owned"});

    for(const ordinal of [1,2]) {
      if(ordinal===2) await sleep(30000-Date.now()%30000+1000); // a fresh TOTP time-step for repeated verification
      const challenge=await auth(`/factors/${factorId}/challenge`,{body:{},token:webToken});
      expect(challenge.status).toBe(200);
      const verified=await auth(`/factors/${factorId}/verify`,{body:{challenge_id:challenge.body.id,code:totp(secret)},token:webToken});
      expect(verified.status).toBe(200);
      webToken=verified.body.access_token;
      const oldUser=await auth("/user",{method:"GET",token:companion.token});
      const oldRefresh=await auth("/token?grant_type=refresh_token",{body:{refresh_token:companion.refresh}});
      expect(oldUser.status,`Companion AAL1 session after verification ${ordinal}`).toBe(403);
      expect(oldRefresh.status,`Companion refresh after verification ${ordinal}`).toBe(400);

      companion=await registeredSession(website.email,website.password);
      expect(companion.uid).toBe(website.uid);
      expect((await rpc(companion.token,"fdb_installation_link_status",{p_installation_id:linked.installationId})).body).toEqual({state:"owned"});
      expect(await ownerOf(db,linked.installationId)).toBe(website.uid);
      expect((await rpc(anonymous.id.token,"fdb_installation_link_status",{p_installation_id:anonymous.installationId})).body).toEqual({state:"owned"});
      for(const id of [linked.installationId,anonymous.installationId]) {
        expect((await db.query("select count(*)::int n from public.installation_guilds where installation_id=$1",[id])).rows[0].n).toBe(0);
        expect((await db.query("select count(*)::int n from public.installation_guild_members where installation_id=$1",[id])).rows[0].n).toBe(0);
      }
      expect(await fingerprint(db)).toEqual(before);
    }
  } finally {await db.end();}
});
