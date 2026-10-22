#!/usr/bin/env node
// Generates the AzerDex Auth e-mail templates (Resend) from ONE layout that mirrors the published `azerdex-welcome-v1` template
// (same header with the CID emblem, palette, panels and footer). Output (committed, reviewed in git, uploaded to Resend by the owner/ops
// step in docs/azerdex-auth-email/README.md):
//   docs/azerdex-auth-email/templates/<alias>.html   Resend HTML ({{{VARIABLE}}} placeholders, no external image, emblem = cid:azerdex-logo)
//   docs/azerdex-auth-email/templates/<alias>.txt    plain-text alternative
//   docs/azerdex-auth-email/templates/manifest.json  alias, name, subject, declared variables (the Edge Function is tested against this)
//   node scripts/build-azerdex-auth-templates.mjs          write
//   node scripts/build-azerdex-auth-templates.mjs --check  exit 1 when the committed files are stale
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const outDir = path.join(root, "docs/azerdex-auth-email/templates");

const SUPPORT = "support@azerdex.com";
const SECURITY = "AzerDex will never ask for your password, a verification code or installation credentials by e-mail.";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Copy decks. Variables are the ONLY dynamic parts; every other word is fixed here. */
export const TEMPLATES = [
  {
    alias: "azerdex-confirm-signup-v1",
    name: "AzerDex — Confirm Sign-up (V1)",
    subject: "Confirm Your Email — Welcome to AzerDex",
    vars: ["CONFIRM_URL"],
    eyebrow: "ONE LAST STEP",
    title: "Confirm your email.",
    lead: "Thanks for registering with AzerDex. Verify your email address to activate your account.",
    body: "This link is time-limited and can be used once. Nothing changes on your account until you open it.",
    cta: { label: "Verify My Email", url: "CONFIRM_URL" },
    notice: ["DIDN'T REGISTER?", "If you did not create an AzerDex account you can ignore this message: no account is activated unless this link is used."],
  },
  {
    alias: "azerdex-reset-password-v1",
    name: "AzerDex — Reset Password (V1)",
    subject: "Reset Your Password — AzerDex",
    vars: ["RESET_URL"],
    eyebrow: "ACCOUNT SECURITY",
    title: "Reset your password.",
    lead: "We received a request to reset the password of your AzerDex account. Use the button below to choose a new one.",
    body: "This link is time-limited and can be used once.",
    cta: { label: "Reset Password", url: "RESET_URL" },
    notice: ["DIDN'T ASK FOR THIS?", "If you did not request a password reset, ignore this message: your password stays unchanged. If requests keep arriving, contact support."],
  },
  {
    alias: "azerdex-email-change-v1",
    name: "AzerDex — Confirm Email Change (V1)",
    subject: "Confirm Your Email Change — AzerDex",
    vars: ["CONFIRM_URL", "NEW_EMAIL"],
    eyebrow: "ACCOUNT SECURITY",
    title: "Confirm your email change.",
    lead: "A request was made to change the email address of your AzerDex account to {{{NEW_EMAIL}}}.",
    body: "Confirm it with the button below. This link is time-limited and can be used once.",
    cta: { label: "Confirm Email Change", url: "CONFIRM_URL" },
    notice: ["DIDN'T ASK FOR THIS?", "If you did not request this change, ignore this message and consider changing your password."],
  },
  {
    alias: "azerdex-auth-link-v1",
    name: "AzerDex — Account Link (V1)",
    subject: "Your AzerDex Account Link",
    vars: ["TITLE", "MESSAGE", "BUTTON_LABEL", "CONFIRM_URL"],
    eyebrow: "ACCOUNT",
    title: "{{{TITLE}}}",
    lead: "{{{MESSAGE}}}",
    body: "This link is time-limited and can be used once.",
    cta: { label: "{{{BUTTON_LABEL}}}", url: "CONFIRM_URL" },
    notice: ["DIDN'T EXPECT THIS?", "If you did not expect this message you can ignore it."],
  },
  {
    alias: "azerdex-auth-code-v1",
    name: "AzerDex — Verification Code (V1)",
    subject: "Your AzerDex Verification Code",
    vars: ["CODE"],
    eyebrow: "ACCOUNT SECURITY",
    title: "Your verification code.",
    lead: "Enter this code to confirm a sensitive change on your AzerDex account.",
    body: "The code is time-limited and can be used once.",
    code: "CODE",
    notice: ["DIDN'T ASK FOR THIS?", "If you did not request a code, ignore this message and consider changing your password."],
  },
  {
    alias: "azerdex-auth-notice-v1",
    name: "AzerDex — Account Notice (V1)",
    subject: "Account Notice — AzerDex",
    vars: ["TITLE", "MESSAGE"],
    eyebrow: "ACCOUNT NOTICE",
    title: "{{{TITLE}}}",
    lead: "{{{MESSAGE}}}",
    body: "No action is needed if you made this change yourself.",
    notice: ["WASN'T YOU?", "If you did not make this change, reset your password right away and contact support."],
  },
];

const P = (mb, size, lh, color, extra = "") => `margin-top:0;margin-right:0;margin-bottom:${mb}px;margin-left:0;font-family:Arial,Helvetica,sans-serif;font-size:${size}px;line-height:${lh}px;color:${color};${extra}`;

export function renderHtml(t) {
  const cta = t.cta
    ? `
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" bgcolor="#6C41C7" style="background-color:#6C41C7;border-radius:8px;">
                  <tr>
                    <td align="center" bgcolor="#6C41C7" style="background-color:#6C41C7;padding-top:14px;padding-right:28px;padding-bottom:14px;padding-left:28px;border-radius:8px;">
                      <a href="{{{${t.cta.url}}}}" target="_blank" style="font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:700;line-height:22px;color:#FFFFFF;text-decoration:none;display:inline-block;">${t.cta.label}</a>
                    </td>
                  </tr>
                </table>
                <p style="${P(0, 12, 19, "#B0A7C7", "margin-top:16px;")}">Button not working? Copy this link into your browser:<br><a href="{{{${t.cta.url}}}}" style="color:#C1ADF1;word-break:break-all;">{{{${t.cta.url}}}}</a></p>`
    : "";
  const code = t.code
    ? `
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" bgcolor="#191A47" style="background-color:#191A47;border-radius:8px;border-width:1px;border-style:solid;border-color:#383366;">
                  <tr><td align="center" style="padding-top:16px;padding-right:32px;padding-bottom:16px;padding-left:32px;font-family:'Courier New',Courier,monospace;font-size:32px;font-weight:700;letter-spacing:8px;line-height:38px;color:#F0D6A8;">{{{${t.code}}}}</td></tr>
                </table>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="X-UA-Compatible" content="IE=edge" />
    <title>${esc(t.subject)}</title>
  </head>
  <body bgcolor="#07091C" style="margin:0;padding:0;background-color:#07091C;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#07091C" style="width:100%;background-color:#07091C;">
      <tr>
        <td align="center" bgcolor="#07091C" style="background-color:#07091C;padding-top:32px;padding-right:14px;padding-bottom:32px;padding-left:14px;">
          <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0D0F33" style="width:100%;max-width:600px;background-color:#0D0F33;border-width:1px;border-style:solid;border-color:#383366;border-radius:12px;">
            <tr>
              <td bgcolor="#0D0F33" style="background-color:#0D0F33;padding-top:25px;padding-right:32px;padding-bottom:24px;padding-left:32px;border-bottom-width:2px;border-bottom-style:solid;border-bottom-color:#6C41C7;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td width="70" valign="middle" style="width:70px;"><img src="cid:azerdex-logo" alt="AzerDex rune compass emblem" width="56" height="56" border="0" style="display:block;width:56px;height:56px;border:0;outline:none;text-decoration:none;"></td>
                    <td valign="middle">
                      <p style="margin-top:0;margin-right:0;margin-bottom:3px;margin-left:0;font-family:Georgia,'Times New Roman',serif;font-size:27px;font-weight:700;line-height:32px;letter-spacing:0.4px;color:#F0D6A8;">AzerDex</p>
                      <p style="${P(0, 10, 15, "#C1ADF1", "font-weight:700;letter-spacing:2px;")}">KNOW YOUR WORLD.</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td bgcolor="#0D0F33" style="background-color:#0D0F33;padding-top:38px;padding-right:33px;padding-bottom:29px;padding-left:33px;">
                <p style="${P(12, 11, 17, "#9E77ED", "font-weight:700;letter-spacing:2px;")}">${esc(t.eyebrow)}</p>
                <h1 style="margin-top:0;margin-right:0;margin-bottom:17px;margin-left:0;font-family:Georgia,'Times New Roman',serif;font-size:35px;font-weight:700;line-height:43px;color:#F4EFFA;">${t.title}</h1>
                <p style="${P(13, 16, 26, "#F4EFFA")}">${t.lead}</p>
                <p style="${P(27, 14, 23, "#B0A7C7")}">${t.body}</p>${code}${cta}
              </td>
            </tr>
            <tr>
              <td bgcolor="#191A47" style="background-color:#191A47;padding-top:22px;padding-right:33px;padding-bottom:22px;padding-left:33px;border-top-width:1px;border-top-style:solid;border-top-color:#383366;">
                <p style="${P(0, 13, 21, "#F4EFFA")}"><strong style="color:#D9B978;">${esc(t.notice[0])}</strong>&nbsp; ${esc(t.notice[1])} ${esc(SECURITY)}</p>
              </td>
            </tr>
            <tr>
              <td align="center" bgcolor="#07091C" style="background-color:#07091C;padding-top:22px;padding-right:33px;padding-bottom:23px;padding-left:33px;border-top-width:1px;border-top-style:solid;border-top-color:#383366;">
                <p style="margin-top:0;margin-right:0;margin-bottom:10px;margin-left:0;font-family:Georgia,'Times New Roman',serif;font-size:15px;font-weight:700;line-height:21px;color:#D9B978;">AzerDex &nbsp;&middot;&nbsp; Know Your World.</p>
                <p style="${P(9, 12, 19, "#B0A7C7")}">Questions? Reply to this email or contact <a href="mailto:${SUPPORT}" style="font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:19px;color:#C1ADF1;text-decoration:underline;">${SUPPORT}</a>.</p>
                <p style="${P(8, 11, 17, "#B0A7C7")}">This is a transactional message about your account, not a newsletter. An independent fan project. Not affiliated with or endorsed by Blizzard Entertainment.</p>
                <p style="${P(0, 11, 18, "#B0A7C7")}">&copy; 2026 AzerDex</p>
              </td>
            </tr>
          </table>
          <!--[if mso]></td></tr></table><![endif]-->
        </td>
      </tr>
    </table>
  </body>
</html>
`;
}

export function renderText(t) {
  const lines = [t.title, "", t.lead, "", t.body, ""];
  if (t.cta) lines.push(`${t.cta.label}: {{{${t.cta.url}}}}`, "");
  if (t.code) lines.push(`Code: {{{${t.code}}}}`, "");
  lines.push(`${t.notice[0]} ${t.notice[1]}`, SECURITY, "", `Questions? Reply to this message or write to ${SUPPORT}.`, "Transactional message about your account, not a newsletter. AzerDex is an independent fan project and is not affiliated with Blizzard Entertainment.");
  return lines.join("\n") + "\n";
}

export function manifest() {
  return TEMPLATES.map((t) => ({ alias: t.alias, name: t.name, subject: t.subject, from: "AzerDex <noreply@azerdex.com>", reply_to: [SUPPORT], variables: t.vars }));
}

export function render() {
  const files = {};
  for (const t of TEMPLATES) {
    files[`${t.alias}.html`] = renderHtml(t);
    files[`${t.alias}.txt`] = renderText(t);
  }
  files["manifest.json"] = JSON.stringify(manifest(), null, 2) + "\n";
  return files;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = render();
  if (process.argv.includes("--check")) {
    const stale = Object.entries(files).filter(([n, c]) => !fs.existsSync(path.join(outDir, n)) || fs.readFileSync(path.join(outDir, n), "utf8") !== c).map(([n]) => n);
    console.log(stale.length ? `STALE: ${stale.join(", ")} (run node scripts/build-azerdex-auth-templates.mjs)` : "auth templates are up to date");
    process.exit(stale.length ? 1 : 0);
  }
  fs.mkdirSync(outDir, { recursive: true });
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(outDir, n), c);
  console.log(`wrote ${Object.keys(files).length} files to ${path.relative(process.cwd(), outDir)}`);
}
