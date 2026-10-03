// Retell -> Memberful bridge
//  - /lookup-member: read-only lookup for Riya (Retell custom function)
//  - /hubspot/duplicate-cleanup: team-only cleanup of duplicate Memberful
//    accounts, triggered from a HubSpot ticket property (Riya can't reach it)
//  - /send-link-text: Riya texts the caller a fixed link via a Zapier -> SlickText Zap
//  - Daily dispute alert (9 AM Puerto Rico): posts Stripe disputes that need a
//    response soon as a phone/computer push notification and/or email
//  - Trial sync (hourly): copies Memberful trial end dates to HubSpot contacts
//    so a HubSpot workflow can send a reminder before the trial converts
// Deploy on Railway. Env vars:
//   RETELL_API_KEY, MEMBERFUL_API_KEY,
//   HUBSPOT_TOKEN, HUBSPOT_CLIENT_SECRET,
//   ZAPIER_SMS_HOOK_URL, ZAPIER_SMS_TOKEN,
//   ADMIN_TOKEN (optional, lets you trigger the trial sync / dispute alert on demand),
//   STRIPE_DISPUTES_KEY (restricted key, Disputes: Read),
//   ALERT_NTFY_TOPIC (phone/computer push) and/or ALERT_EMAIL_HOOK (Zapier hook -> Gmail)
// npm i express retell-sdk

import crypto from "node:crypto";
import express from "express";
import Retell from "retell-sdk";

const app = express();
// Raw body so Retell signature verification is exact
app.use(express.raw({ type: "application/json" }));

const MEMBERFUL_URL = "https://aristotlesignals.memberful.com/api/graphql";

// Verify the request actually came from Retell
async function verifyRetell(req, res, next) {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf-8") : "";
  // verify is async in retell-sdk v6, so it must be awaited
  const ok = await Retell.verify(
    raw,
    process.env.RETELL_API_KEY, // the key with the webhook badge
    req.headers["x-retell-signature"]
  );
  if (!ok) return res.status(401).json({ error: "unauthorized" });
  try {
    req.body = JSON.parse(raw);
  } catch {
    return res.status(400).json({ error: "bad json" });
  }
  next();
}

async function memberful(query, variables) {
  const r = await fetch(MEMBERFUL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.MEMBERFUL_API_KEY}`,
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0",
    },
    body: JSON.stringify({ query, variables }),
  });
  return r.json();
}

// Confirm field names in Memberful's API Explorer before going live
const LOOKUP = `
  query ($email: String!) {
    memberByEmail(email: $email) {
      id
      fullName
      subscriptions {
        active
        expiresAt
        createdAt
        plan { name }
      }
    }
  }`;

// Retell custom function: lookup_member  (args: { email })
app.post("/lookup-member", verifyRetell, async (req, res) => {
  const email = (req.body?.args?.email || "").trim().toLowerCase();
  if (!email) return res.json({ result: "No email provided." });

  try {
    const { data, errors } = await memberful(LOOKUP, { email });
    if (errors) console.error(errors);
    const m = data?.memberByEmail;
    if (!m) {
      return res.json({
        result: "No member found with that email. Ask if they used a different email.",
      });
    }

    const subs = m.subscriptions || [];
    const active = subs.filter((s) => s.active);

    // Memberful returns Unix timestamps in seconds; turn them into spoken dates
    const day = (t) =>
      t
        ? new Date(t * 1000).toLocaleDateString("en-US", {
            month: "long",
            day: "numeric",
            year: "numeric",
            timeZone: "America/New_York",
          })
        : null;

    // Most recent subscription, so Riya can explain an ended trial or plan
    const latest = [...subs].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];

    // Only return what the agent needs to say out loud. No billing details.
    res.json({
      result: {
        found: true,
        name: m.fullName,
        has_active_plan: active.length > 0,
        active_plans: active.map((s) => ({
          plan: s.plan?.name,
          renews_or_ends_on: day(s.expiresAt),
        })),
        active_subscription_count: active.length, // >1 can explain double billing
        most_recent_plan: latest
          ? {
              plan: latest.plan?.name,
              active: latest.active,
              started_on: day(latest.createdAt),
              ends_or_ended_on: day(latest.expiresAt),
            }
          : null,
      },
    });
  } catch (e) {
    console.error(e);
    res.json({ result: "Lookup is unavailable right now. Take their details and escalate." });
  }
});


// ---------------------------------------------------------------------------
// Riya texts a link (Retell custom function: send_link_text, args: { link_type })
// Guardrails: only texts the number that is calling (from Retell's call data,
// never from anything Riya says), fixed link types only, one text per call.
// ---------------------------------------------------------------------------

const LINK_TYPES = [
  "account_sign_in",
  "discord_reconnect",
  "support_ticket",
  "apparel_store",
  "affiliate_signup",
  "all_links",
];
const textedCalls = new Map(); // call_id -> time sent

function toTenDigit(e164) {
  const digits = (e164 || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  return "";
}

app.post("/send-link-text", verifyRetell, async (req, res) => {
  const call = req.body?.call || {};
  const linkType = String(req.body?.args?.link_type || "").toLowerCase();

  if (!LINK_TYPES.includes(linkType)) {
    return res.json({ result: "Unknown link type. Offer to email the link instead." });
  }

  // Inbound calls: the caller is from_number. Web test calls have no number.
  const phone = call.direction === "outbound" ? call.to_number : call.from_number;
  const tenDigit = toTenDigit(phone);
  if (!tenDigit) {
    return res.json({
      result: "Can't text this caller (no US phone number on the call). Offer to email the link instead.",
    });
  }

  const callId = call.call_id || "";
  if (callId && textedCalls.has(callId)) {
    return res.json({
      result: "A text was already sent on this call. Only one text per call. If they need more links, offer the All links email.",
    });
  }

  try {
    const r = await fetch(process.env.ZAPIER_SMS_HOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: process.env.ZAPIER_SMS_TOKEN,
        link_type: linkType,
        phone_e164: phone,
        phone_10: tenDigit,
        call_id: callId,
      }),
    });
    if (!r.ok) throw new Error(`Zapier hook ${r.status}`);
    if (callId) textedCalls.set(callId, Date.now());

    // Forget old calls so memory doesn't grow
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    for (const [id, t] of textedCalls) if (t < dayAgo) textedCalls.delete(id);

    res.json({ result: "Text sent to the caller's phone. Tell them it should arrive in a moment." });
  } catch (e) {
    console.error("send-link-text failed:", e);
    res.json({ result: "The text didn't go through. Offer to email the link instead." });
  }
});

// ---------------------------------------------------------------------------
// Duplicate account cleanup (team-only, triggered from HubSpot)
//
// A teammate fills in "Old Memberful emails" on a ticket, then sets
// "Duplicate cleanup" to Preview or Delete. HubSpot sends a webhook here.
// Guardrails: never deletes an account with an active subscription, never
// deletes the ticket contact's own email, max 5 emails per run.
// ---------------------------------------------------------------------------

const HUBSPOT = "https://api.hubapi.com";
const MAX_EMAILS = 5;

// Confirmed in Memberful's API Explorer: memberDelete(id: ID!) -> MemberDeletePayload { id }
const DELETE_MEMBER =
  process.env.MEMBERFUL_DELETE_MUTATION ||
  `mutation ($id: ID!) { memberDelete(id: $id) { id } }`;

// Verify HubSpot's v3 webhook signature
function verifyHubSpot(req) {
  const sig = req.headers["x-hubspot-signature-v3"];
  const ts = Number(req.headers["x-hubspot-request-timestamp"]);
  if (!sig || !ts) return false;
  if (Math.abs(Date.now() - ts) > 5 * 60 * 1000) return false; // older than 5 min
  const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf-8") : "";
  const uri = `https://${req.headers.host}${req.originalUrl}`;
  const expected = crypto
    .createHmac("sha256", process.env.HUBSPOT_CLIENT_SECRET)
    .update(`POST${uri}${raw}${ts}`)
    .digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function hubspot(method, path, body) {
  const r = await fetch(`${HUBSPOT}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.HUBSPOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HubSpot ${method} ${path} -> ${r.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function addNote(ticketId, contactId, html) {
  const associations = [
    { to: { id: ticketId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 228 }] },
  ];
  if (contactId) {
    associations.push({
      to: { id: contactId },
      types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }],
    });
  }
  await hubspot("POST", "/crm/v3/objects/notes", {
    properties: { hs_timestamp: new Date().toISOString(), hs_note_body: html },
    associations,
  });
}

async function runCleanup(ticketId, mode) {
  const ticket = await hubspot(
    "GET",
    `/crm/v3/objects/tickets/${ticketId}?properties=old_memberful_emails&associations=contacts`
  );
  const contactId = ticket.associations?.contacts?.results?.[0]?.id || null;

  // The ticket contact's email is treated as the ACTIVE account and is never deleted
  let activeEmail = "";
  if (contactId) {
    const c = await hubspot("GET", `/crm/v3/objects/contacts/${contactId}?properties=email`);
    activeEmail = (c.properties?.email || "").trim().toLowerCase();
  }

  const emails = [
    ...new Set(
      (ticket.properties?.old_memberful_emails || "")
        .split(/[\s,;]+/)
        .map((e) => e.trim().toLowerCase())
        .filter((e) => e.includes("@"))
    ),
  ];

  const lines = [];
  if (!emails.length) lines.push("No emails found in Old Memberful emails.");
  if (!contactId) lines.push("Ticket has no associated contact, so the active email can't be protected. Nothing was deleted.");
  if (emails.length > MAX_EMAILS) lines.push(`Only the first ${MAX_EMAILS} emails were processed.`);

  if (contactId) {
    for (const email of emails.slice(0, MAX_EMAILS)) {
      if (email === activeEmail) {
        lines.push(`${email}: SKIPPED, this is the member's active email.`);
        continue;
      }
      const { data, errors } = await memberful(LOOKUP, { email });
      if (errors) {
        lines.push(`${email}: ERROR looking up (${errors[0]?.message}).`);
        continue;
      }
      const m = data?.memberByEmail;
      if (!m) {
        lines.push(`${email}: no Memberful account found.`);
        continue;
      }
      const active = (m.subscriptions || []).filter((s) => s.active);
      if (active.length) {
        lines.push(
          `${email}: SKIPPED, has an active subscription (${active.map((s) => s.plan?.name).join(", ")}). Handle this one by hand.`
        );
        continue;
      }
      if (mode !== "delete") {
        lines.push(`${email}: would DELETE member #${m.id} (${m.fullName || "no name"}), no active subscriptions.`);
        continue;
      }
      const del = await memberful(DELETE_MEMBER, { id: m.id });
      if (del.errors) {
        lines.push(`${email}: DELETE FAILED (${del.errors[0]?.message}).`);
      } else if (!del.data?.memberDelete?.id) {
        lines.push(`${email}: DELETE NOT CONFIRMED, Memberful didn't return the deleted id. Check this account by hand.`);
      } else {
        lines.push(`${email}: DELETED member #${m.id} (${m.fullName || "no name"}).`);
      }
    }
  }

  const title = mode === "delete" ? "Duplicate cleanup: DELETE run" : "Duplicate cleanup: preview (nothing deleted)";
  const footer =
    mode === "delete"
      ? "Next: have the member reconnect Discord, then add back the time they missed."
      : 'If this looks right, set "Duplicate cleanup" to Delete.';
  await addNote(
    ticketId,
    contactId,
    `<b>${title}</b><br>Active email (protected): ${activeEmail || "none"}<br><br>${lines.join("<br>")}<br><br>${footer}`
  );

  // Reset the trigger so the button can be used again
  await hubspot("PATCH", `/crm/v3/objects/tickets/${ticketId}`, {
    properties: { duplicate_cleanup: "" },
  });
}

// HubSpot private app webhook: ticket.propertyChange on duplicate_cleanup
app.post("/hubspot/duplicate-cleanup", (req, res) => {
  if (!verifyHubSpot(req)) return res.status(401).json({ error: "unauthorized" });

  let events = [];
  try {
    events = JSON.parse(req.body.toString("utf-8"));
  } catch {
    return res.status(400).json({ error: "bad json" });
  }

  // Answer HubSpot right away, then do the work
  res.sendStatus(200);

  for (const e of Array.isArray(events) ? events : []) {
    const mode = (e.propertyValue || "").toLowerCase();
    if (e.propertyName !== "duplicate_cleanup") continue;
    if (mode !== "preview" && mode !== "delete") continue; // ignores our own reset
    runCleanup(String(e.objectId), mode).catch((err) =>
      console.error("Duplicate cleanup failed:", err)
    );
  }
});

// ---------------------------------------------------------------------------
// Memberful -> HubSpot trial sync
// Every hour: reads the newest Memberful subscriptions (back ~8 days), and for
// every trial that hasn't ended yet, upserts the HubSpot contact (by email) with:
//   trial_end_date   (date, Puerto Rico calendar day the trial converts)
//   trial_plan       (plan name)
//   trial_auto_renew ("true" if still set to convert, "false" if canceled)
// Read-only on Memberful. Only writes those three HubSpot contact properties.
// ---------------------------------------------------------------------------

const TRIAL_SYNC_EVERY_MS = 60 * 60 * 1000;
const PR_OFFSET_SECONDS = 4 * 3600; // Puerto Rico is UTC-4 all year

// HubSpot date properties want midnight UTC of the calendar day
function prDateMs(unixSeconds) {
  const d = new Date((unixSeconds - PR_OFFSET_SECONDS) * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

const RECENT_SUBS = `
  query ($before: String) {
    subscriptions(last: 100, before: $before) {
      pageInfo { startCursor hasPreviousPage }
      edges { node { active autorenew createdAt trialEndAt plan { name } member { email } } }
    }
  }`;

async function fetchOpenTrials() {
  const now = Math.floor(Date.now() / 1000);
  const createdCutoff = now - 8 * 86400; // trials are 7 days, so look back 8
  const trials = [];
  let before = null;

  for (let page = 0; page < 10; page++) {
    const { data, errors } = await memberful(RECENT_SUBS, { before });
    if (errors) throw new Error(`Memberful: ${errors[0]?.message}`);
    const conn = data?.subscriptions;
    const nodes = (conn?.edges || []).map((e) => e.node);
    if (!nodes.length) break;

    for (const n of nodes) {
      const email = (n.member?.email || "").trim().toLowerCase();
      if (!n.trialEndAt || !email || email.startsWith("test@")) continue;
      if (n.trialEndAt < now - 86400) continue; // already ended
      trials.push({ ...n, email });
    }

    const oldest = Math.min(...nodes.map((n) => n.createdAt || now));
    if (!conn.pageInfo?.hasPreviousPage || oldest < createdCutoff) break;
    before = conn.pageInfo.startCursor;
  }

  // One row per email: keep the trial that ends last
  const byEmail = new Map();
  for (const t of trials) {
    const prev = byEmail.get(t.email);
    if (!prev || t.trialEndAt > prev.trialEndAt) byEmail.set(t.email, t);
  }
  return [...byEmail.values()];
}

let trialSyncRunning = false;
async function syncTrialsToHubSpot() {
  if (trialSyncRunning) return { skipped: true };
  trialSyncRunning = true;
  try {
    const trials = await fetchOpenTrials();
    let upserted = 0;
    for (let i = 0; i < trials.length; i += 100) {
      const inputs = trials.slice(i, i + 100).map((t) => ({
        idProperty: "email",
        id: t.email,
        properties: {
          email: t.email,
          trial_end_date: String(prDateMs(t.trialEndAt)),
          trial_plan: t.plan?.name || "",
          trial_auto_renew: t.active && t.autorenew ? "true" : "false",
        },
      }));
      await hubspot("POST", "/crm/v3/objects/contacts/batch/upsert", { inputs });
      upserted += inputs.length;
    }
    console.log(`Trial sync: ${upserted} trial contacts updated in HubSpot`);
    return { upserted };
  } catch (e) {
    console.error("Trial sync failed:", e);
    return { error: String(e.message || e) };
  } finally {
    trialSyncRunning = false;
  }
}

// Run shortly after startup, then every hour
setTimeout(syncTrialsToHubSpot, 15 * 1000);
setInterval(syncTrialsToHubSpot, TRIAL_SYNC_EVERY_MS);

// Optional: run it on demand with  POST /admin/sync-trials  (header x-admin-token)
app.post("/admin/sync-trials", async (req, res) => {
  if (!process.env.ADMIN_TOKEN || req.headers["x-admin-token"] !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  res.json(await syncTrialsToHubSpot());
});

// ---------------------------------------------------------------------------
// Daily Stripe dispute alert -> push notification and/or email
// Every day at 9 AM Puerto Rico time, lists disputes that still need a response,
// soonest deadline first, flagging anything due within 48 hours.
// Read-only on Stripe (use a restricted key with Disputes: Read only).
// ---------------------------------------------------------------------------

const ALERT_HOUR_PR = 9;
let lastAlertDay = "";

function prNow() {
  return new Date(Date.now() - PR_OFFSET_SECONDS * 1000); // UTC fields = PR wall clock
}
function prLabel(unixSeconds) {
  const d = new Date((unixSeconds - PR_OFFSET_SECONDS) * 1000);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  let h = d.getUTCHours(); const ampm = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${h}:${m} ${ampm}`;
}

async function fetchOpenDisputes() {
  const open = [];
  let startingAfter = null;
  for (let page = 0; page < 10; page++) {
    const qs = new URLSearchParams({ limit: "100" });
    if (startingAfter) qs.set("starting_after", startingAfter);
    const r = await fetch(`https://api.stripe.com/v1/disputes?${qs}`, {
      headers: { Authorization: `Bearer ${process.env.STRIPE_DISPUTES_KEY}` },
    });
    const body = await r.json();
    if (!r.ok) throw new Error(`Stripe ${r.status}: ${body?.error?.message}`);
    for (const d of body.data || []) {
      if (["needs_response", "warning_needs_response"].includes(d.status) && d.evidence_details?.due_by) {
        open.push(d);
      }
    }
    if (!body.has_more || !body.data?.length) break;
    startingAfter = body.data[body.data.length - 1].id;
  }
  return open.sort((a, b) => a.evidence_details.due_by - b.evidence_details.due_by);
}

async function sendDisputeAlert() {
  const push = process.env.ALERT_NTFY_TOPIC;
  const emailHook = process.env.ALERT_EMAIL_HOOK;
  if (!process.env.STRIPE_DISPUTES_KEY || (!push && !emailHook)) {
    return { skipped: "Set STRIPE_DISPUTES_KEY plus ALERT_NTFY_TOPIC and/or ALERT_EMAIL_HOOK" };
  }
  const now = Math.floor(Date.now() / 1000);
  const open = (await fetchOpenDisputes()).filter((d) => d.evidence_details.due_by > now);
  const urgent = open.filter((d) => d.evidence_details.due_by - now <= 48 * 3600);
  const total = open.reduce((s, d) => s + d.amount, 0) / 100;

  const line = (d) => {
    const ev = d.evidence || {};
    const drafted = d.evidence_details?.has_evidence ? "draft saved" : "NO DRAFT";
    return `- ${ev.customer_name || ev.customer_email_address || "Unknown"}: $${(d.amount / 100).toFixed(2)} (${d.reason.replace(/_/g, " ")}), due ${prLabel(d.evidence_details.due_by)} [${drafted}]\n  https://dashboard.stripe.com/disputes/${d.id}`;
  };

  const title = urgent.length
    ? `${urgent.length} Stripe dispute${urgent.length > 1 ? "s" : ""} due within 48 hours`
    : `Stripe disputes: nothing due in the next 48 hours`;

  let body = `${open.length} disputes need a response ($${total.toFixed(2)} at stake).\n`;
  if (urgent.length) body += `\nDUE IN THE NEXT 48 HOURS:\n` + urgent.map(line).join("\n") + "\n";
  const upcoming = open.filter((d) => !urgent.includes(d)).slice(0, 5);
  if (upcoming.length) body += `\nCOMING UP NEXT:\n` + upcoming.map(line).join("\n") + "\n";
  body += `\nAsk Claude to "draft the disputes due next," then review and submit in Stripe before the deadline.`;

  const results = {};

  // Push notification to phone + computer (ntfy app / ntfy.sh in a browser)
  if (push) {
    const short = urgent.length
      ? urgent.map((d) => `${d.evidence?.customer_name || "Unknown"} $${(d.amount / 100).toFixed(0)}, due ${prLabel(d.evidence_details.due_by)}${d.evidence_details?.has_evidence ? "" : " (no draft)"}`).join("\n")
      : `${open.length} open, next due ${open[0] ? prLabel(open[0].evidence_details.due_by) : "n/a"}`;
    const r = await fetch(`https://ntfy.sh/${encodeURIComponent(push)}`, {
      method: "POST",
      headers: {
        Title: title,
        Priority: urgent.length ? "high" : "default",
        Tags: urgent.length ? "rotating_light" : "credit_card",
        Click: "https://dashboard.stripe.com/disputes",
      },
      body: short,
    });
    results.push = r.status;
  }

  // Email (Zapier Catch Hook -> Gmail "Send Email")
  if (emailHook) {
    const r = await fetch(emailHook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: title, text: body, urgent_count: urgent.length, open_count: open.length }),
    });
    results.email = r.status;
  }

  console.log(`Dispute alert sent: ${open.length} open, ${urgent.length} urgent`, results);
  return { open: open.length, urgent: urgent.length, ...results };
}

// Check every 10 minutes; send once per day at 9 AM Puerto Rico time
setInterval(async () => {
  const pr = prNow();
  const day = pr.toISOString().slice(0, 10);
  if (pr.getUTCHours() === ALERT_HOUR_PR && lastAlertDay !== day) {
    lastAlertDay = day;
    try { await sendDisputeAlert(); } catch (e) { console.error("Dispute alert failed:", e); }
  }
}, 10 * 60 * 1000);

// Optional: send it right now with  POST /admin/dispute-alert  (header x-admin-token)
app.post("/admin/dispute-alert", async (req, res) => {
  if (!process.env.ADMIN_TOKEN || req.headers["x-admin-token"] !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try { res.json(await sendDisputeAlert()); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.listen(process.env.PORT || 3000);
