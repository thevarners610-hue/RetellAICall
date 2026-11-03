// Retell -> Memberful bridge
//  - /lookup-member: read-only lookup for Riya (Retell custom function)
//  - /hubspot/duplicate-cleanup: team-only cleanup of duplicate Memberful
//    accounts, plus "Find by name" to locate a member's other accounts
//    accounts, triggered from a HubSpot ticket property (Riya can't reach it)
//  - /send-link-text: Riya texts the caller a fixed link via a Zapier -> SlickText Zap
//  - One-time backlog cleanup: reply in each stuck AI-handoff ticket's email
//    thread, then close it (POST /admin/backlog-reply)
//  - Daily dispute alert (9 AM Puerto Rico): posts Stripe disputes that need a
//    response soon as a phone/computer push notification and/or email
//  - Auto-merge duplicate tickets: a new ticket from someone who already has an
//    open ticket is merged into it and keeps that owner (plus an hourly sweep)
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
const SUB_FIELDS = "active autorenew pastDue createdAt activatedAt expiresAt trialStartAt trialEndAt plan { name priceCents intervalUnit intervalCount }";

const LOOKUP = `
  query ($email: String!) {
    memberByEmail(email: $email) {
      id
      fullName
      discordUserId
      subscriptions { ${SUB_FIELDS} }
    }
  }`;

// ---- Subscription details, shared by Riya's lookup, name search and cleanup notes ----
function usd(cents) {
  if (cents == null) return null;
  return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 });
}
function planPrice(plan) {
  if (!plan || plan.priceCents == null) return null;
  if (plan.priceCents === 0) return "free";
  const unit = (plan.intervalUnit || "").toLowerCase();
  const n = plan.intervalCount || 1;
  if (!unit) return usd(plan.priceCents);
  return n === 1 ? `${usd(plan.priceCents)}/${unit}` : `${usd(plan.priceCents)} every ${n} ${unit}s`;
}
function longDate(t) {
  return t
    ? new Date(t * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Puerto_Rico" })
    : null;
}
// Plain-English status for one subscription
function subDetails(s) {
  const now = Date.now() / 1000;
  const onTrial = s.active && s.trialEndAt && s.trialEndAt > now;
  let status;
  if (!s.active) status = s.expiresAt ? `ended ${longDate(s.expiresAt)}` : "ended";
  else if (s.pastDue) status = `ACTIVE but PAST DUE (payment failed)${s.expiresAt ? `, access through ${longDate(s.expiresAt)}` : ""}`;
  else if (onTrial) status = s.autorenew ? `FREE TRIAL, converts to paid on ${longDate(s.trialEndAt)}` : `FREE TRIAL, canceled, access ends ${longDate(s.trialEndAt)}`;
  else if (!s.autorenew) status = `ACTIVE, canceled (won't renew), access ends ${longDate(s.expiresAt)}`;
  else status = s.expiresAt ? `ACTIVE, renews ${longDate(s.expiresAt)}` : "ACTIVE, no end date";
  return {
    plan: s.plan?.name || "unknown plan",
    price: planPrice(s.plan),
    active: !!s.active,
    status,
    auto_renew: !!s.autorenew,
    past_due: !!s.pastDue,
    on_trial: !!onTrial,
    trial_ends_on: onTrial ? longDate(s.trialEndAt) : null,
    started_on: longDate(s.createdAt),
    renews_or_ends_on: longDate(onTrial ? s.trialEndAt : s.expiresAt),
  };
}
function subLine(s) {
  const d = subDetails(s);
  return `${d.plan}${d.price ? ` (${d.price})` : ""}: ${d.status}; started ${d.started_on || "?"}`;
}
function sortSubs(subs) {
  return [...(subs || [])].sort((a, b) => (b.active - a.active) || ((b.createdAt || 0) - (a.createdAt || 0)));
}

// ---- Discord: is the member's linked Discord account in the server, and with which roles ----
// Uses a bot that's already in the HDN server (read-only). Env: DISCORD_BOT_TOKEN, DISCORD_GUILD_ID,
// optional DISCORD_PAID_ROLE_IDS (comma-separated role IDs that paid members should have).
let discordRoles = { at: 0, byId: new Map() };
async function discordApi(path) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    headers: { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
  });
  if (r.status === 429) {
    const wait = Number((await r.json().catch(() => ({}))).retry_after || 1);
    await new Promise((res) => setTimeout(res, Math.min(wait, 5) * 1000));
    return discordApi(path);
  }
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function roleNames(ids) {
  if (Date.now() - discordRoles.at > 60 * 60 * 1000) {
    const { status, body } = await discordApi(`/guilds/${process.env.DISCORD_GUILD_ID}/roles`);
    if (status === 200 && Array.isArray(body)) discordRoles = { at: Date.now(), byId: new Map(body.map((r) => [r.id, r.name])) };
  }
  return ids.map((id) => discordRoles.byId.get(id) || id);
}
// Which Discord role(s) each Memberful plan should give (matched by role NAME, so role IDs don't matter)
function expectedRolesForPlan(planName) {
  const n = (planName || "").toLowerCase();
  const yearly = /year|\(y\)/.test(n);
  const trial = /trial/.test(n);
  if (/mentee|mentorship/.test(n)) return /all access/.test(n) ? ["Mentee + All Access (Y)"] : ["Mentee + Live (Y)"];
  if (/all access/.test(n)) return yearly ? ["All Access (Y)", "All Access"] : ["All Access"];
  if (/real estate/.test(n)) return ["Real Estate + Options"];
  if (/university/.test(n)) return ["Honey Drip University"];
  if (/sports/.test(n)) return /option/.test(n) ? ["Sports + Options"] : ["Sports Bettors", "Sports (T)"];
  if (/live trading/.test(n)) return yearly ? ["Live Trading (Y)"] : trial ? ["Live Trading (T)"] : ["Live Trading"];
  if (/free trial/.test(n)) return ["Free Trial"];
  if (/option/.test(n)) return yearly ? ["Options (Y)"] : trial ? ["Options (T)"] : ["PREMIUM_MEMBERS"];
  return [];
}

async function discordStatus(discordUserId, activePlanNames = []) {
  if (!process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_GUILD_ID) return { checked: false };
  if (!discordUserId) return { checked: true, linked: false, summary: "No Discord account linked in Memberful" };
  try {
    const { status, body } = await discordApi(`/guilds/${process.env.DISCORD_GUILD_ID}/members/${discordUserId}`);
    if (status === 404) {
      return { checked: true, linked: true, in_server: false, summary: "Discord linked, but NOT in the server" };
    }
    if (status !== 200) return { checked: false, error: `Discord ${status}` };
    const roles = await roleNames(body.roles || []);
    const paidIds = (process.env.DISCORD_PAID_ROLE_IDS || "").split(",").map((x) => x.trim()).filter(Boolean);
    const hasPaid = paidIds.length ? (body.roles || []).some((r) => paidIds.includes(r)) : null;
    const name = body.user?.global_name || body.user?.username || "";
    const lower = roles.map((r) => String(r).toLowerCase());
    // For each active plan, does the member have the role that plan should give?
    const planChecks = activePlanNames.map((plan) => {
      const expected = expectedRolesForPlan(plan);
      const ok = !expected.length || expected.some((e) => lower.includes(e.toLowerCase()));
      return { plan, expected_role: expected.join(" or ") || null, has_role: ok };
    });
    const missing = planChecks.filter((c) => !c.has_role);
    let summary = `In the server as ${name || "unknown"}${body.user?.username ? ` (@${body.user.username})` : ""}; roles: ${roles.length ? roles.join(", ") : "none"}`;
    if (missing.length) summary += ` (MISSING role for their plan: ${missing.map((m) => `${m.plan} should have "${m.expected_role}"`).join("; ")})`;
    else if (activePlanNames.length && planChecks.length) summary += " (roles match their plan)";
    else if (hasPaid === false) summary += " (MISSING paid role)";
    return {
      checked: true, linked: true, in_server: true,
      username: body.user?.username || null, display_name: name || null,
      roles, has_paid_role: hasPaid, plan_role_checks: planChecks, roles_match_plan: !missing.length,
      joined_server_on: body.joined_at ? longDate(Math.floor(new Date(body.joined_at).getTime() / 1000)) : null,
      summary,
    };
  } catch (e) {
    return { checked: false, error: String(e.message || e) };
  }
}

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

    const subs = sortSubs(m.subscriptions);
    const active = subs.filter((s) => s.active);

    // Only what the agent needs to say out loud. Plan prices are public; no card details.
    res.json({
      result: {
        found: true,
        name: m.fullName,
        has_active_plan: active.length > 0,
        active_subscription_count: active.length, // >1 can explain double billing
        active_plans: active.map(subDetails),
        any_past_due: active.some((s) => s.pastDue),
        // Last few ended plans, so Riya can explain an expired trial or lapsed plan
        past_plans: subs.filter((s) => !s.active).slice(0, 3).map(subDetails),
        // Discord: linked? in the server? which roles?
        discord: await discordStatus(m.discordUserId, active.map((x) => x.plan?.name)),
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

const MEMBERFUL_SIGN_IN = "https://aristotlesignals.memberful.com/auth/sign_in";
const DISCORD_RECONNECT = "https://aristotlesignals.memberful.com/account/discord/authorize";
const SUPPORT_FORM = "https://share.hsforms.com/2MgOAUJOaRI6W1PRppczVkwuaf69";
const STOP = "Reply STOP to opt out.";

// Message text for each link type (the Zap sends whatever "message" the bridge provides)
const LINK_TEXTS = {
  account_sign_in: `Honey Drip Network: Here's your account link to update your card, upgrade, or cancel: ${MEMBERFUL_SIGN_IN} ${STOP}`,
  discord_reconnect: `Honey Drip Network: Tap to reconnect Discord to your plan (make sure you're logged into the right Discord first): ${DISCORD_RECONNECT} ${STOP}`,
  support_ticket: `Honey Drip Network: Submit a support ticket here: ${SUPPORT_FORM} ${STOP}`,
  apparel_store: `Honey Drip Apparel: Shop Drop 001 here: https://www.honeydripnetwork.com/category/all-products ${STOP}`,
  affiliate_signup: `Honey Drip Network: Join the affiliate program (50% recurring commission): https://whop.com/checkout/14YkAEgaxs8lrBICDD-XgcQ-eRh2-Jvy9-Zdxdfy0T1m8v/ ${STOP}`,
  all_links: `Honey Drip Network links. Account: ${MEMBERFUL_SIGN_IN} Discord: ${DISCORD_RECONNECT} Support: ${SUPPORT_FORM} ${STOP}`,
};
const LINK_TYPES = Object.keys(LINK_TEXTS);

// Plans Riya can sell by phone (Memberful plan IDs, confirmed via the Memberful API)
const CHECKOUT_PLANS = {
  // Riya recommends these
  options_monthly:      { id: "48773",  name: "Options Trading (Monthly)",        price: "$125/month" },
  live_trading_monthly: { id: "81750",  name: "Options + Live Trading (Monthly)", price: "$200/month" },
  free_trial:           { id: "147065", name: "Options Trading 7-Day Free Trial", price: "free for 7 days, then $125/month (first-time members only)" },
  // Only when the caller asks for one of these specifically
  options_yearly:       { id: "56175",  name: "Options Trading (Yearly)",         price: "$1,100/year" },
  live_trading_yearly:  { id: "84062",  name: "Options + Live Trading (Yearly)",  price: "$2,000/year" },
  all_access_monthly:   { id: "81709",  name: "All Access (Monthly)",             price: "$250/month" },
  all_access_yearly:    { id: "89735",  name: "All Access (Yearly)",              price: "$2,600/year" },
  real_estate_options:  { id: "122687", name: "Real Estate + Options (Monthly)",  price: "$165/month" },
  honey_drip_university:{ id: "91193",  name: "Honey Drip University (Monthly)",  price: "$25/month" },
};
function checkoutUrl(planId) {
  return `https://aristotlesignals.memberful.com/checkout?plan=${planId}&utm_source=phone&utm_medium=riya`;
}

const textedCalls = new Map(); // `${call_id}:${kind}` -> time sent

function toTenDigit(e164) {
  const digits = (e164 || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  return "";
}

// Shared: text the caller (only the number that's calling), max one text of each kind per call
async function textCaller(req, res, kind, linkType, message, okResult) {
  const call = req.body?.call || {};
  const phone = call.direction === "outbound" ? call.to_number : call.from_number;
  const tenDigit = toTenDigit(phone);
  if (!tenDigit) {
    return res.json({ result: "Can't text this caller (no US phone number on the call). Offer to email the link instead, or point them to honeydripnetwork.com." });
  }
  const callId = call.call_id || "";
  const key = `${callId}:${kind}`;
  if (callId && textedCalls.has(key)) {
    return res.json({ result: `A ${kind === "checkout" ? "checkout link" : "link"} was already texted on this call. Don't send another; ask them to check their messages.` });
  }
  try {
    const r = await fetch(process.env.ZAPIER_SMS_HOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: process.env.ZAPIER_SMS_TOKEN, link_type: linkType, message, phone_e164: phone, phone_10: tenDigit, call_id: callId }),
    });
    if (!r.ok) throw new Error(`Zapier hook ${r.status}`);
    if (callId) textedCalls.set(key, Date.now());
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    for (const [id, t] of textedCalls) if (t < dayAgo) textedCalls.delete(id);
    res.json({ result: okResult });
  } catch (e) {
    console.error(`text (${kind}) failed:`, e);
    res.json({ result: "The text didn't go through. Offer to email the link instead, or point them to honeydripnetwork.com." });
  }
}

// Retell custom function: send_link_text (args: { link_type })
app.post("/send-link-text", verifyRetell, async (req, res) => {
  const linkType = String(req.body?.args?.link_type || "").toLowerCase();
  if (!LINK_TYPES.includes(linkType)) {
    return res.json({ result: "Unknown link type. Offer to email the link instead." });
  }
  return textCaller(req, res, "link", linkType, LINK_TEXTS[linkType],
    "Text sent to the caller's phone. Tell them it should arrive in a moment.");
});

// Retell custom function: send_checkout_link (args: { plan })
// Riya never takes card details by phone; the caller pays on Memberful's secure checkout page.
app.post("/send-checkout-link", verifyRetell, async (req, res) => {
  const planKey = String(req.body?.args?.plan || "").toLowerCase();
  const plan = CHECKOUT_PLANS[planKey];
  if (!plan) return res.json({ result: "Unknown plan. Confirm which plan they want and try again." });
  const message =
    `Honey Drip Network: Here's your secure checkout link for ${plan.name} (${plan.price}): ${checkoutUrl(plan.id)} ` +
    `Renews automatically, cancel anytime. ${STOP}`;
  return textCaller(req, res, "checkout", `checkout_${planKey}`, message,
    `Checkout link for ${plan.name} (${plan.price}) texted. Tell them it should arrive in a moment and they can complete checkout while you stay on the line. After they finish, ask for the email they used and call lookup_member to confirm the plan is active.`);
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
          `${email}: SKIPPED, has an active subscription (${active.map(subLine).join("; ")}). Handle this one by hand.`
        );
        continue;
      }
      if (mode !== "delete") {
        const hist = sortSubs(m.subscriptions).slice(0, 3).map(subLine).join("; ") || "no subscriptions";
        const dc = await discordStatus(m.discordUserId);
        lines.push(`${email}: would DELETE member #${m.id} (${m.fullName || "no name"}), no active subscriptions. History: ${hist}.${dc.summary ? ` Discord: ${dc.summary}.` : ""}`);
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


// ---------------------------------------------------------------------------
// Memberful name search (for finding duplicate accounts)
// Memberful's API can only look members up by email, so the bridge keeps an
// in-memory list of every member (id, name, email, subscriptions) and searches
// it by name. New members are picked up every hour; a full rebuild runs nightly
// so renamed or deleted accounts drop out. Read-only on Memberful.
// ---------------------------------------------------------------------------

const memberIndex = { byId: new Map(), cursor: null, ready: false, building: false, builtAt: 0 };

const MEMBERS_PAGE = `
  query ($after: String) {
    members(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges { node { id fullName email phoneNumber discordUserId orders { createdAt totalCents status } subscriptions { ${SUB_FIELDS} } } }
    }
  }`;

async function refreshMemberIndex({ full = false } = {}) {
  if (memberIndex.building) return;
  memberIndex.building = true;
  const started = Date.now();
  try {
    const byId = full ? new Map() : memberIndex.byId;
    let after = full ? null : memberIndex.cursor;
    let pages = 0;
    for (;;) {
      const { data, errors } = await memberful(MEMBERS_PAGE, { after });
      if (errors) throw new Error(`Memberful: ${errors[0]?.message}`);
      const conn = data?.members;
      for (const e of conn?.edges || []) byId.set(e.node.id, e.node);
      pages++;
      if (conn?.pageInfo?.endCursor) after = conn.pageInfo.endCursor;
      if (!conn?.pageInfo?.hasNextPage) break;
      await new Promise((r) => setTimeout(r, 150)); // be gentle with Memberful
    }
    memberIndex.byId = byId;
    memberIndex.cursor = after;
    memberIndex.ready = true;
    memberIndex.builtAt = Date.now();
    console.log(`Member index ${full ? "rebuilt" : "updated"}: ${byId.size} members, ${pages} pages, ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (e) {
    console.error("Member index refresh failed:", e);
  } finally {
    memberIndex.building = false;
  }
}

// Build at startup, pick up new members hourly, full rebuild every 24 hours
// Full refresh at startup and every hour (so billing changes like auto-renew are caught),
// then push billing facts to HubSpot contacts
async function refreshAndSyncBilling() {
  await refreshMemberIndex({ full: true });
  if (memberIndex.ready) await syncBillingToHubSpot().catch((e) => console.error("Billing sync failed:", e));
  if (MERGE.enabled) await sweepDuplicateTickets().catch((e) => console.error("Duplicate ticket sweep failed:", e));
  if (memberIndex.ready) await refreshOpenTicketSummaries().catch((e) => console.error("Ticket summaries failed:", e));
  if (memberIndex.ready) await syncActiveMembersToSlickText().catch((e) => console.error("SlickText sync failed:", e));
}
setTimeout(refreshAndSyncBilling, 30 * 1000);
setInterval(refreshAndSyncBilling, 60 * 60 * 1000);


// ---------------------------------------------------------------------------
// Billing facts -> HubSpot contacts (hourly, after the member index refresh)
// So HubSpot's AI agent (and your team) can see plan, auto-renew, last payment,
// access end date, and when auto-renew was turned off, right on the contact.
// Only members who are active or ended within the last 120 days are synced,
// and only contacts whose billing facts changed are written.
// ---------------------------------------------------------------------------

const billingState = { lastSent: new Map(), lastSentMembership: new Map(), prevAutoRenew: new Map(), offDate: new Map(), primed: false };

function primarySub(m) {
  const subs = sortSubs(m.subscriptions);
  return subs[0] || null;
}

function billingFacts(m) {
  const sub = primarySub(m);
  if (!sub) return null;
  const now = Date.now() / 1000;
  const onTrial = sub.active && sub.trialEndAt && sub.trialEndAt > now;
  let status = "ended";
  if (sub.active && sub.pastDue) status = "past_due";
  else if (onTrial) status = "trial";
  else if (sub.active && !sub.autorenew) status = "canceled_with_access";
  else if (sub.active) status = "active";

  const paid = (m.orders || []).filter((o) => o.status === "completed" && (o.totalCents || 0) > 0)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const lastPaid = paid[0];
  const firstSub = (m.subscriptions || []).reduce((min, x) => (x.createdAt && (!min || x.createdAt < min) ? x.createdAt : min), 0);
  const price = planPrice(sub.plan);

  return {
    hdn_plan: `${sub.plan?.name || "Unknown plan"}${price ? ` (${price})` : ""}`,
    hdn_membership_status: status,
    hdn_auto_renew: sub.active && sub.autorenew ? "true" : "false",
    hdn_last_payment_date: lastPaid ? String(prDateMs(lastPaid.createdAt)) : "",
    hdn_last_payment_amount: lastPaid ? String(lastPaid.totalCents / 100) : "",
    hdn_access_ends: (onTrial ? sub.trialEndAt : sub.expiresAt) ? String(prDateMs(onTrial ? sub.trialEndAt : sub.expiresAt)) : "",
    hdn_member_since: firstSub ? String(prDateMs(firstSub)) : "",
    hdn_discord_user_id: m.discordUserId ? String(m.discordUserId) : "",
    // Keep the older Memberful properties current too, since existing lists and
    // marketing-status workflows still use them (the old Zaps that wrote them are off)
    memberful_member_status: { active: "Active", trial: "Trial Active", past_due: "Past Due", canceled_with_access: "Cancelled", ended: "Cancelled" }[status],
    memberful_plan_name: sub.plan?.name || "",
    memberful_subscription_expires: sub.expiresAt ? String(prDateMs(sub.expiresAt)) : "",
  };
}


function membershipProps(m, f) {
  const day = (ms) => (ms ? new Date(Number(ms)).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : "");
  const off = billingState.offDate.get(m.id);
  return {
    member_email: (m.email || "").toLowerCase(),
    member_name: m.fullName || "",
    billing_summary: billingSummaryText(m),
    plan: f.hdn_plan,
    membership_status: STATUS_TEXT[f.hdn_membership_status],
    auto_renew: f.hdn_auto_renew === "true" ? "ON" : "OFF",
    last_payment: f.hdn_last_payment_amount ? `$${Number(f.hdn_last_payment_amount).toFixed(2)} on ${day(f.hdn_last_payment_date)}` : "none on record",
    access_ends: day(f.hdn_access_ends),
    auto_renew_turned_off_on: off ? day(off) : f.hdn_auto_renew === "true" ? "n/a (still on)" : "not recorded (before Oct 2026)",
    discord_connected: m.discordUserId ? "Yes" : "No",
    memberful_id: String(m.id),
  };
}


// Upsert contacts in a batch; if HubSpot rejects some emails as invalid (e.g. "gmail.con"),
// drop just those and retry, so one bad email doesn't sink the other 99.
const badEmails = new Set();
async function upsertContactsBatch(inputs) {
  let list = inputs.filter((x) => !badEmails.has(x.id));
  for (let attempt = 0; attempt < 4 && list.length; attempt++) {
    try {
      await hubspot("POST", "/crm/v3/objects/contacts/batch/upsert", { inputs: list });
      return { written: list.length, skipped: inputs.length - list.length };
    } catch (e) {
      const msg = String(e.message || e);
      const found = [...msg.matchAll(/Email address ([^\s\\"]+) is invalid/g)].map((x) => x[1].toLowerCase());
      if (!found.length) throw e;
      found.forEach((f) => badEmails.add(f));
      list = list.filter((x) => !badEmails.has(x.id));
    }
  }
  // Still failing: send one at a time so the good ones get through
  let written = 0;
  for (const one of list) {
    try { await hubspot("POST", "/crm/v3/objects/contacts/batch/upsert", { inputs: [one] }); written++; }
    catch { badEmails.add(one.id); }
  }
  return { written, skipped: inputs.length - written };
}

async function syncBillingToHubSpot() {
  const now = Date.now() / 1000;
  const cutoff = now - 120 * 86400;
  const today = String(prDateMs(Math.floor(now)));
  const changed = [];
  const all = [];

  for (const m of memberIndex.byId.values()) {
    const email = (m.email || "").trim().toLowerCase();
    if (!email || email.startsWith("test@")) continue;
    const sub = primarySub(m);
    if (!sub) continue;
    if (!sub.active && !(sub.expiresAt && sub.expiresAt > cutoff)) continue;

    // Detect auto-renew switching from on to off (the cancellation moment)
    const ar = !!(sub.active && sub.autorenew);
    const prev = billingState.prevAutoRenew.get(m.id);
    if (billingState.primed && prev === true && ar === false && !billingState.offDate.has(m.id)) {
      billingState.offDate.set(m.id, today);
    }
    if (ar === true) billingState.offDate.delete(m.id); // renewed / turned back on
    billingState.prevAutoRenew.set(m.id, ar);

    const facts = billingFacts(m);
    if (!facts) continue;
    if (billingState.offDate.has(m.id)) facts.hdn_auto_renew_off_date = billingState.offDate.get(m.id);

    const key = JSON.stringify(facts);
    all.push({ email, facts, key, m });
    if (billingState.lastSent.get(email) === key) continue;
    changed.push({ email, facts, key, m });
  }

  let written = 0, failed = 0;
  for (let i = 0; i < changed.length; i += 100) {
    const batch = changed.slice(i, i + 100);
    try {
      const r = await upsertContactsBatch(
        batch.map((c) => ({ idProperty: "email", id: c.email, properties: { email: c.email, ...c.facts, memberful_last_updated: today } }))
      );
      for (const c of batch) if (!badEmails.has(c.email)) billingState.lastSent.set(c.email, c.key);
      written += r.written;
      failed += r.skipped;
    } catch (e) {
      failed += batch.length;
      console.error("Billing sync batch failed:", String(e.message || e).slice(0, 300));
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  billingState.primed = true;
  console.log(`Billing sync: ${written} contacts updated, ${failed} skipped (${badEmails.size} invalid emails like "gmail.con"), ${billingState.offDate.size} cancellations tracked`);

  // Same facts into the "HDN Membership" custom object, which HubSpot's AI agent can search
  const objectType = process.env.HDN_MEMBERSHIP_OBJECT; // e.g. 2-12345678 (from the custom object's settings)
  if (objectType) {
    let ok = 0, bad = 0;
    const toSend = all.filter((c) => billingState.lastSentMembership.get(c.email) !== c.key);
    for (let i = 0; i < toSend.length; i += 100) {
      const batch = toSend.slice(i, i + 100);
      try {
        await hubspot("POST", `/crm/v3/objects/${objectType}/batch/upsert`, {
          inputs: batch.map((c) => ({ idProperty: "member_email", id: c.email, properties: membershipProps(c.m, c.facts) })),
        });
        for (const c of batch) billingState.lastSentMembership.set(c.email, c.key);
        ok += batch.length;
      } catch (e) {
        bad += batch.length;
        console.error("Membership object sync failed:", String(e.message || e).slice(0, 300));
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    console.log(`Membership records: ${ok} updated, ${bad} failed`);
  }
}

function normName(s) {
  return (s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

// Every word of the search must match a word of the member's name (or the start
// of one, for 3+ letters), in any order. Also matches emails like "johnsmith88@".
function searchMembersByName(query) {
  const q = normName(query).split(" ").filter(Boolean);
  if (!q.length) return [];
  const joined = q.join("");
  const out = [];
  for (const m of memberIndex.byId.values()) {
    const words = normName(m.fullName).split(" ").filter(Boolean);
    const nameHit = q.every((t) => words.some((w) => w === t || (t.length >= 3 && w.startsWith(t))));
    const local = (m.email || "").toLowerCase().split("@")[0].replace(/[^a-z0-9]/g, "");
    const emailHit = q.length >= 2 && joined.length >= 6 && local.includes(joined);
    if (nameHit || emailHit) out.push(m);
  }
  return out;
}

function fmtDate(unixSeconds) {
  return unixSeconds ? new Date(unixSeconds * 1000).toISOString().slice(0, 10) : "?";
}

function describeMember(m) {
  const subs = m.subscriptions || [];
  const active = subs.filter((s) => s.active);
  const first = subs.reduce((min, s) => (s.createdAt && (!min || s.createdAt < min) ? s.createdAt : min), 0);
  const lastEnd = subs.reduce((max, s) => (s.expiresAt && s.expiresAt > max ? s.expiresAt : max), 0);
  const status = active.length
    ? `ACTIVE: ${active.map((s) => s.plan?.name).join(", ")}`
    : subs.length
    ? `inactive (last access ended ${fmtDate(lastEnd)})`
    : "no subscriptions";
  return { status, joined: first ? fmtDate(first) : "?", active: active.length > 0 };
}

async function runNameSearch(ticketId) {
  const ticket = await hubspot(
    "GET",
    `/crm/v3/objects/tickets/${ticketId}?properties=memberful_name_search&associations=contacts`
  );
  const contactId = ticket.associations?.contacts?.results?.[0]?.id || null;
  let activeEmail = "";
  let contactName = "";
  if (contactId) {
    const c = await hubspot("GET", `/crm/v3/objects/contacts/${contactId}?properties=email,firstname,lastname`);
    activeEmail = (c.properties?.email || "").trim().toLowerCase();
    contactName = `${c.properties?.firstname || ""} ${c.properties?.lastname || ""}`.trim();
  }
  const query = (ticket.properties?.memberful_name_search || "").trim() || contactName;

  let body;
  if (!query) {
    body = "No name to search. Fill in <b>Memberful name search</b> (or the contact's first and last name) and try again.";
  } else if (!memberIndex.ready) {
    refreshMemberIndex({ full: true });
    body = "The member list is still loading (this takes a few minutes after the bridge restarts). Try again in about 5 minutes.";
  } else {
    if (Date.now() - memberIndex.builtAt > 10 * 60 * 1000) await refreshMemberIndex(); // grab brand-new signups
    const hits = searchMembersByName(query);
    if (!hits.length) {
      body = `No Memberful accounts found for "${query}". Try just the last name, or a different spelling.`;
    } else {
      const shown = hits.slice(0, 25);
      const discordLines = await Promise.all(shown.map((m) => discordStatus(m.discordUserId, (m.subscriptions || []).filter((x) => x.active).map((x) => x.plan?.name))));
      const rows = shown.map((m, i) => {
        const d = describeMember(m);
        const email = (m.email || "").toLowerCase();
        const tag = email === activeEmail ? " <b>(this ticket's contact, protected)</b>" : "";
        const subs = sortSubs(m.subscriptions);
        const subText = subs.length ? subs.map((x) => `&nbsp;&nbsp;• ${subLine(x)}`).join("<br>") : "&nbsp;&nbsp;• no subscriptions";
        const dc = discordLines[i]?.summary ? `<br>&nbsp;&nbsp;• Discord: ${discordLines[i].summary}` : "";
        return `<b>${m.fullName || "no name"}</b> | ${email || "no email"} | joined ${d.joined}${tag}<br>${subText}${dc}`;
      });
      const candidates = shown
        .filter((m) => !describeMember(m).active && (m.email || "").toLowerCase() !== activeEmail)
        .map((m) => m.email.toLowerCase());
      body =
        `Found ${hits.length} account(s) matching "${query}"${hits.length > 25 ? " (showing the first 25)" : ""}:<br><br>` +
        rows.join("<br><br>") +
        "<br><br><b>Inactive matches you could clean up:</b><br>" +
        (candidates.length ? candidates.join(", ") : "none") +
        "<br><br>Same name doesn't always mean same person. Confirm each one is really this member " +
        "(same phone, same Discord, or they told you), paste only those emails into <b>Old Memberful emails</b>, " +
        "then set Duplicate cleanup to <b>Preview</b>.";
    }
  }

  await addNote(ticketId, contactId, `<b>Memberful name search</b><br>${body}`);
  await hubspot("PATCH", `/crm/v3/objects/tickets/${ticketId}`, { properties: { duplicate_cleanup: "" } });
}


// ---------------------------------------------------------------------------
// Billing summary on tickets (for HubSpot's AI agent)
// HubSpot's agent actions can't read contact properties, but they can search
// tickets. So when a ticket is created (and hourly while it's open), the bridge
// writes the member's email and a plain-English billing summary onto the ticket.
// ---------------------------------------------------------------------------

const MEMBER_BY_EMAIL = `
  query ($email: String!) {
    memberByEmail(email: $email) {
      id fullName email discordUserId
      orders { createdAt totalCents status }
      subscriptions { ${SUB_FIELDS} }
    }
  }`;

async function findMemberForBilling(email) {
  const e = (email || "").trim().toLowerCase();
  if (!e) return null;
  if (memberIndex.ready) {
    for (const m of memberIndex.byId.values()) if ((m.email || "").toLowerCase() === e) return m;
  }
  const { data } = await memberful(MEMBER_BY_EMAIL, { email: e });
  return data?.memberByEmail || null;
}

const STATUS_TEXT = {
  active: "Active",
  trial: "Free trial",
  past_due: "Active but PAST DUE (last payment failed)",
  canceled_with_access: "Canceled (auto-renew off), still has access",
  ended: "Ended",
};

function billingSummaryText(m) {
  const f = billingFacts(m);
  if (!f) return `Member: ${m.fullName || ""} (${m.email}). No subscriptions on file.`;
  const day = (ms) => (ms ? new Date(Number(ms)).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : null);
  const off = billingState.offDate.get(m.id);
  const ends = day(f.hdn_access_ends);
  const lines = [
    `Member: ${m.fullName || "(no name)"} (${m.email})${f.hdn_member_since ? `, member since ${day(f.hdn_member_since)}` : ""}`,
    `Plan: ${f.hdn_plan}`,
    `Status: ${STATUS_TEXT[f.hdn_membership_status]}${ends ? (f.hdn_membership_status === "ended" ? `, access ended ${ends}` : f.hdn_auto_renew === "true" ? `, next renewal ${ends}` : `, access until ${ends}`) : ""}`,
    `Auto-renew: ${f.hdn_auto_renew === "true" ? "ON (will be charged on the renewal date)" : "OFF (will not be charged again)"}`,
    `Last payment: ${f.hdn_last_payment_amount ? `$${Number(f.hdn_last_payment_amount).toFixed(2)} on ${day(f.hdn_last_payment_date)}` : "none on record"}`,
    `Auto-renew turned off on: ${off ? day(off) : f.hdn_auto_renew === "true" ? "n/a (still on)" : "not recorded (canceled before Oct 2026 tracking began)"}`,
    `Discord: ${m.discordUserId ? "connected in Memberful" : "NOT connected in Memberful"}`,
    `Rule: Memberful never charges a renewal on a canceled subscription, so any payment that went through was made while auto-renew was ON.`,
    `Updated: ${day(prDateMs(Math.floor(Date.now() / 1000)))}`,
  ];
  return lines.join("\n");
}

async function summarizeTicket(ticketId) {
  const t = await hubspot("GET", `/crm/v3/objects/tickets/${ticketId}?properties=hs_pipeline_stage&associations=contacts`);
  const contactId = t.associations?.contacts?.results?.[0]?.id;
  if (!contactId) return { ticketId, skipped: "no contact" };
  const c = await hubspot("GET", `/crm/v3/objects/contacts/${contactId}?properties=email`);
  const email = (c.properties?.email || "").trim().toLowerCase();
  if (!email) return { ticketId, skipped: "contact has no email" };
  const m = await findMemberForBilling(email);
  const summary = m
    ? billingSummaryText(m)
    : `No Memberful account found for ${email}. They may have joined with a different email, or pay through Whop. Ask for the email they used to sign up.`;
  await hubspot("PATCH", `/crm/v3/objects/tickets/${ticketId}`, {
    properties: { hdn_member_email: email, hdn_billing_summary: summary },
  });
  // Also make sure this member has an up-to-date HDN Membership record right away,
  // so the AI agent can find them even before the next hourly sync
  if (m && process.env.HDN_MEMBERSHIP_OBJECT) {
    const facts = billingFacts(m);
    if (facts) {
      await hubspot("POST", `/crm/v3/objects/${process.env.HDN_MEMBERSHIP_OBJECT}/batch/upsert`, {
        inputs: [{ idProperty: "member_email", id: email, properties: membershipProps({ ...m, email }, facts) }],
      }).catch((e) => console.error("Membership record upsert failed:", String(e.message || e).slice(0, 200)));
    }
  }
  return { ticketId, email, found: !!m };
}

// Hourly (after the billing sync): refresh open tickets touched in the last 14 days
async function refreshOpenTicketSummaries() {
  const since = Date.now() - 14 * 86400 * 1000;
  let after, done = 0;
  for (let page = 0; page < 5; page++) {
    const r = await hubspot("POST", "/crm/v3/objects/tickets/search", {
      filterGroups: [{ filters: [
        { propertyName: "hs_pipeline_stage", operator: "NEQ", value: "4" },
        { propertyName: "hs_lastmodifieddate", operator: "GTE", value: String(since) },
      ] }],
      properties: ["hs_pipeline_stage"],
      limit: 100,
      ...(after ? { after } : {}),
    });
    for (const t of r.results || []) {
      try { await summarizeTicket(t.id); done++; } catch (e) { console.error("Ticket summary failed", t.id, String(e.message || e).slice(0, 200)); }
      await new Promise((res) => setTimeout(res, 250));
    }
    after = r.paging?.next?.after;
    if (!after) break;
  }
  console.log(`Ticket billing summaries refreshed: ${done}`);
}

// Manual: POST /admin/ticket-billing {"ticketId":"123"} or {"mode":"open"} (header x-admin-token)
app.post("/admin/ticket-billing", async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: "unauthorized" });
  let body = {};
  try { body = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf-8") : JSON.stringify(req.body || {})); } catch {}
  try {
    if (body.ticketId) return res.json(await summarizeTicket(String(body.ticketId)));
    if (body.mode === "open") { refreshOpenTicketSummaries(); return res.json({ started: true }); }
    res.status(400).json({ error: 'send {"ticketId":"..."} or {"mode":"open"}' });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});


// One-time: create the "HDN Membership" custom object (needs scope crm.schemas.custom.write)
//   POST /admin/create-membership-object   header x-admin-token
app.post("/admin/create-membership-object", async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: "unauthorized" });
  const text = (name, label, extra = {}) => ({ name, label, type: "string", fieldType: "text", ...extra });
  try {
    const schema = await hubspot("POST", "/crm/v3/schemas", {
      name: "hdn_membership",
      labels: { singular: "HDN Membership", plural: "HDN Memberships" },
      primaryDisplayProperty: "member_email",
      secondaryDisplayProperties: ["membership_status"],
      searchableProperties: ["member_email", "member_name"],
      requiredProperties: ["member_email"],
      associatedObjects: ["CONTACT", "TICKET"],
      properties: [
        text("member_email", "Member email", { hasUniqueValue: true }),
        text("member_name", "Member name"),
        { name: "billing_summary", label: "Billing summary", type: "string", fieldType: "textarea" },
        text("plan", "Plan"),
        text("membership_status", "Membership status"),
        text("auto_renew", "Auto-renew"),
        text("last_payment", "Last payment"),
        text("access_ends", "Access ends / renews on"),
        text("auto_renew_turned_off_on", "Auto-renew turned off on"),
        text("discord_connected", "Discord connected"),
        text("memberful_id", "Memberful member ID"),
      ],
    });
    res.json({ objectTypeId: schema.objectTypeId, fullyQualifiedName: schema.fullyQualifiedName, next: "Set HDN_MEMBERSHIP_OBJECT to objectTypeId in Railway" });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});


// Manual: POST /admin/membership {"email":"x@y.com"} -> create/refresh that member's HDN Membership record
app.post("/admin/membership", async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: "unauthorized" });
  let body = {};
  try { body = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf-8") : JSON.stringify(req.body || {})); } catch {}
  const email = String(body.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ error: "email required" });
  if (!process.env.HDN_MEMBERSHIP_OBJECT) return res.status(400).json({ error: "HDN_MEMBERSHIP_OBJECT is not set in Railway" });
  try {
    const m = await findMemberForBilling(email);
    if (!m) return res.json({ email, found: false });
    const facts = billingFacts(m);
    if (!facts) return res.json({ email, found: true, written: false, reason: "no subscriptions" });
    await hubspot("POST", `/crm/v3/objects/${process.env.HDN_MEMBERSHIP_OBJECT}/batch/upsert`, {
      inputs: [{ idProperty: "member_email", id: email, properties: membershipProps({ ...m, email }, facts) }],
    });
    res.json({ email, found: true, written: true, summary: billingSummaryText({ ...m, email }) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

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
    // New ticket: add the member's billing summary (short wait so the contact is associated)
    if (e.subscriptionType === "ticket.creation") {
      // Merge into an existing open ticket first (same person = one ticket), then add the billing summary
      setTimeout(() => handleNewTicket(String(e.objectId)).catch((err) => console.error("New ticket handling failed:", err)), 8000);
      continue;
    }
    const mode = (e.propertyValue || "").toLowerCase();
    if (e.propertyName !== "duplicate_cleanup") continue;
    if (mode === "find by name") {
      runNameSearch(String(e.objectId)).catch((err) => console.error("Name search failed:", err));
      continue;
    }
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
      const r = await upsertContactsBatch(inputs);
      upserted += r.written;
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

  // Batch-drafting reminder: disputes due within 5 days that still have no draft
  const needDraft = open.filter(
    (d) => d.evidence_details.due_by - now <= 5 * 86400 && !d.evidence_details?.has_evidence
  );
  if (push && needDraft.length) {
    const r = await fetch(`https://ntfy.sh/${encodeURIComponent(push)}`, {
      method: "POST",
      headers: {
        Title: `Open Claude: ${needDraft.length} dispute${needDraft.length > 1 ? "s" : ""} need drafts`,
        Priority: "high",
        Tags: "memo",
        Click: "https://claude.ai/new",
      },
      body:
        `Say "draft the next batch of disputes" in a new chat.\n` +
        needDraft.slice(0, 8).map((d) => `${d.evidence?.customer_name || "Unknown"}, due ${prLabel(d.evidence_details.due_by)}`).join("\n"),
    });
    results.draft_reminder = r.status;
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

// ---------------------------------------------------------------------------
// One-time backlog cleanup for tickets stuck with "HD Support AI"
// For each open ticket the Customer Agent escalated (owner = HD Support AI,
// created before a cutoff): reply in the original email thread from a human
// teammate, then close the ticket. If a human already replied last, it just
// closes the ticket without emailing. Tickets with no email thread are skipped
// and left open.
//
//   POST /admin/backlog-reply   header x-admin-token
//   {"mode":"dry"}                          -> count + preview of the first 5
//   {"mode":"one","ticketId":"123"}         -> email + close just that ticket
//   {"mode":"all"}                          -> run all (in the background)
//   GET  /admin/backlog-reply/status        -> progress
// Needs the private app scopes conversations.read + conversations.write + tickets.
// ---------------------------------------------------------------------------

const BACKLOG = {
  aiOwnerId: process.env.BACKLOG_AI_OWNER_ID || "86933385",       // HD Support AI
  senderOwnerId: process.env.BACKLOG_SENDER_OWNER_ID || "86840305", // Asia Varner (shows as sender)
  cutoff: process.env.BACKLOG_CUTOFF || "2026-09-20T00:00:00Z",
  closedStage: process.env.BACKLOG_CLOSED_STAGE || "4",
};
const backlogRun = { running: false, total: 0, done: 0, emailed: 0, closedOnly: 0, skipped: 0, failed: 0, errors: [], startedAt: null, finishedAt: null };

function backlogText(firstName) {
  const hi = firstName ? `Hi ${firstName},` : "Hi there,";
  const text =
    `${hi}\n\nWe're so sorry we didn't get back to you on this. If you still need help, just reply to this email ` +
    `and a member of our team will jump in. If it's already sorted, no action needed.\n\n— Honey Drip Network Support`;
  const rich = text.split("\n\n").map((p) => `<p>${p.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>`).join("");
  return { text, rich };
}

async function findBacklogTickets(limitAll = true) {
  const out = [];
  let after;
  do {
    const body = {
      filterGroups: [{ filters: [
        { propertyName: "createdate", operator: "LT", value: BACKLOG.cutoff },
        { propertyName: "hs_customer_agent_ticket_status", operator: "EQ", value: "ESCALATED" },
        { propertyName: "hubspot_owner_id", operator: "EQ", value: BACKLOG.aiOwnerId },
        { propertyName: "hs_pipeline_stage", operator: "NEQ", value: BACKLOG.closedStage },
      ] }],
      sorts: [{ propertyName: "createdate", direction: "ASCENDING" }],
      properties: ["subject", "hs_conversations_originating_thread_id"],
      limit: 100,
      ...(after ? { after } : {}),
    };
    const r = await hubspot("POST", "/crm/v3/objects/tickets/search", body);
    out.push(...(r.results || []));
    after = r.paging?.next?.after;
    if (!limitAll) break;
    await new Promise((res) => setTimeout(res, 300));
  } while (after);
  return out;
}

let senderUserIdCache = null;
async function senderActorId() {
  if (!senderUserIdCache) {
    const o = await hubspot("GET", `/crm/v3/owners/${BACKLOG.senderOwnerId}`);
    if (!o.userId) throw new Error("Sender owner has no HubSpot user id");
    senderUserIdCache = `A-${o.userId}`;
  }
  return senderUserIdCache;
}

// Work out what to send for one ticket, without sending anything
async function planTicket(ticket) {
  const threadId = ticket.properties?.hs_conversations_originating_thread_id;
  if (!threadId) return { action: "skip", reason: "no email thread" };
  const thread = await hubspot("GET", `/conversations/v3/conversations/threads/${threadId}`);
  const msgs = (await hubspot("GET", `/conversations/v3/conversations/threads/${threadId}/messages?limit=100`)).results || [];
  const real = msgs.filter((m) => m.type === "MESSAGE").sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  if (!real.length) return { action: "skip", reason: "no messages in thread" };
  const last = real[real.length - 1];
  const lastIncoming = [...real].reverse().find((m) => m.direction === "INCOMING");
  if (!lastIncoming) return { action: "skip", reason: "no message from the member" };

  // A human teammate already answered last -> just close it
  const humanAnsweredLast = last.direction === "OUTGOING" && (last.senders || []).some((x) => String(x.actorId || "").startsWith("A-"));
  if (humanAnsweredLast) return { action: "close", reason: "a teammate already replied", threadId };

  const from = (lastIncoming.senders || []).find((x) => x.deliveryIdentifier?.value);
  if (!from) return { action: "skip", reason: "no sender email on the thread" };

  // Only email people who have (or had) a Memberful account; vendors and spam just get closed
  const toEmail = String(from.deliveryIdentifier.value).trim().toLowerCase();
  if (process.env.BACKLOG_REQUIRE_MEMBER !== "false") {
    const { data } = await memberful(`query ($email: String!) { memberByEmail(email: $email) { id } }`, { email: toEmail });
    if (!data?.memberByEmail) return { action: "close", reason: "sender isn't a Memberful member (likely vendor or spam)", threadId, to: toEmail };
  }

  let firstName = "";
  if (thread.associatedContactId) {
    try {
      const c = await hubspot("GET", `/crm/v3/objects/contacts/${thread.associatedContactId}?properties=firstname`);
      firstName = (c.properties?.firstname || "").trim().split(/\s+/)[0] || "";
    } catch {}
  }
  // Drop names that aren't really names ("Home", "Info", "user123")
  if (/\d/.test(firstName) || /^(home|info|admin|support|hello|contact|user|test|me|my|the|mr|mrs|ms)$/i.test(firstName) || firstName.length < 2) firstName = "";
  else firstName = firstName.charAt(0).toUpperCase() + firstName.slice(1);
  const subj = lastIncoming.subject || ticket.properties?.subject || "Your support request";
  return {
    action: "email",
    threadId,
    to: from.deliveryIdentifier.value,
    firstName,
    payload: {
      type: "MESSAGE",
      channelId: lastIncoming.channelId,
      channelAccountId: lastIncoming.channelAccountId,
      subject: /^re:/i.test(subj) ? subj : `Re: ${subj}`,
      recipients: [{ actorId: from.actorId, deliveryIdentifier: from.deliveryIdentifier, recipientField: "TO" }],
    },
  };
}

async function processTicket(ticket) {
  const plan = await planTicket(ticket);
  if (plan.action === "skip") return plan;
  if (plan.action === "email") {
    const { text, rich } = backlogText(plan.firstName);
    await hubspot("POST", `/conversations/v3/conversations/threads/${plan.threadId}/messages`, {
      ...plan.payload, text, richText: rich, senderActorId: await senderActorId(),
    });
  }
  await hubspot("PATCH", `/crm/v3/objects/tickets/${ticket.id}`, { properties: { hs_pipeline_stage: BACKLOG.closedStage } });
  return plan;
}

async function runBacklogAll() {
  Object.assign(backlogRun, { running: true, total: 0, done: 0, emailed: 0, closedOnly: 0, skipped: 0, failed: 0, errors: [], startedAt: new Date().toISOString(), finishedAt: null });
  try {
    const tickets = await findBacklogTickets(true);
    backlogRun.total = tickets.length;
    for (const t of tickets) {
      try {
        const r = await processTicket(t);
        if (r.action === "email") backlogRun.emailed++;
        else if (r.action === "close") { backlogRun.closedOnly++; if (r.reason?.startsWith("sender isn't")) backlogRun.notMembers = (backlogRun.notMembers || 0) + 1; }
        else backlogRun.skipped++;
      } catch (e) {
        backlogRun.failed++;
        if (backlogRun.errors.length < 20) backlogRun.errors.push(`${t.id}: ${String(e.message || e).slice(0, 200)}`);
      }
      backlogRun.done++;
      await new Promise((res) => setTimeout(res, 1200)); // stay well under HubSpot rate limits
    }
  } catch (e) {
    backlogRun.errors.push(`search: ${String(e.message || e).slice(0, 200)}`);
  } finally {
    backlogRun.running = false;
    backlogRun.finishedAt = new Date().toISOString();
    console.log("Backlog reply finished:", JSON.stringify(backlogRun));
  }
}

function adminOk(req) {
  return process.env.ADMIN_TOKEN && req.headers["x-admin-token"] === process.env.ADMIN_TOKEN;
}

app.post("/admin/backlog-reply", async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: "unauthorized" });
  let body = {};
  try { body = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf-8") : JSON.stringify(req.body || {})); } catch {}
  req.body = body;
  const mode = body.mode;
  try {
    if (mode === "dry") {
      const tickets = await findBacklogTickets(true);
      const preview = [];
      for (const t of tickets.slice(0, 5)) {
        const p = await planTicket(t).catch((e) => ({ action: "error", reason: String(e.message || e).slice(0, 200) }));
        preview.push({ ticketId: t.id, action: p.action, reason: p.reason, to: p.to, firstName: p.firstName, subject: p.payload?.subject });
      }
      return res.json({ total: tickets.length, preview, message: backlogText("{first name}").text });
    }
    if (mode === "one") {
      if (!req.body?.ticketId) return res.status(400).json({ error: "ticketId required" });
      const t = await hubspot("GET", `/crm/v3/objects/tickets/${req.body.ticketId}?properties=subject,hs_conversations_originating_thread_id`);
      const r = await processTicket(t);
      return res.json({ ticketId: t.id, action: r.action, reason: r.reason, to: r.to });
    }
    if (mode === "all") {
      if (backlogRun.running) return res.status(409).json({ error: "already running", ...backlogRun });
      runBacklogAll();
      return res.json({ started: true, check: "GET /admin/backlog-reply/status" });
    }
    res.status(400).json({ error: 'mode must be "dry", "one" or "all"' });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/admin/backlog-reply/status", (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: "unauthorized" });
  res.json(backlogRun);
});

// ---------------------------------------------------------------------------
// Auto-merge duplicate tickets (one person = one open ticket = one agent)
//
// When a new ticket is created for a contact who already has an open ticket,
// the new ticket is merged into the existing one and the existing owner is
// kept. An hourly sweep catches anything the webhook missed.
//
// Which ticket is kept:
//   1. one a teammate owns AND has already replied on
//   2. otherwise one a teammate owns
//   3. otherwise the oldest (e.g. both are with HD Support AI)
//   ties go to the oldest ticket.
//
// Env (optional):
//   AUTO_MERGE_TICKETS=off     turns all of this off
//   NON_HUMAN_OWNER_IDS        owners that aren't a person
//                              (default: HD Support AI, Honey Drip Support)
//
// Manual:  POST /admin/merge-duplicates  header x-admin-token
//   {"mode":"dry"}  -> list who has duplicates and what would be kept
//   {"mode":"run"}  -> merge them now
// ---------------------------------------------------------------------------

const MERGE = {
  enabled: process.env.AUTO_MERGE_TICKETS !== "off",
  closedStage: "4",
  waitingOnUsStage: "3",
  nonHumanOwners: (process.env.NON_HUMAN_OWNER_IDS || "86933385,86799246")
    .split(",").map((x) => x.trim()).filter(Boolean),
};

const TICKET_PROPS = [
  "subject", "hubspot_owner_id", "hs_pipeline", "hs_pipeline_stage",
  "createdate", "hs_first_agent_message_sent_by",
];

// One merge at a time per contact, so two tickets created seconds apart
// (Adrian sent the form 3 times) can't try to merge into each other
const mergeLocks = new Map();
function withContactLock(contactId, fn) {
  const prev = mergeLocks.get(contactId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  mergeLocks.set(contactId, next);
  next.finally(() => { if (mergeLocks.get(contactId) === next) mergeLocks.delete(contactId); }).catch(() => {});
  return next;
}

const isHumanOwner = (ownerId) => !!ownerId && !MERGE.nonHumanOwners.includes(String(ownerId));

async function openTicketsForContact(contactId) {
  const a = await hubspot("GET", `/crm/v4/objects/contacts/${contactId}/associations/tickets?limit=100`);
  const ids = [...new Set((a.results || []).map((r) => String(r.toObjectId)))];
  if (!ids.length) return [];
  const r = await hubspot("POST", "/crm/v3/objects/tickets/batch/read", {
    properties: TICKET_PROPS,
    inputs: ids.map((id) => ({ id })),
  });
  return (r.results || []).filter((t) => t.properties?.hs_pipeline_stage !== MERGE.closedStage);
}

function pickPrimary(tickets) {
  const rank = (t) => {
    const p = t.properties || {};
    const human = isHumanOwner(p.hubspot_owner_id);
    const humanReplied = human && isHumanOwner(p.hs_first_agent_message_sent_by);
    return humanReplied ? 0 : human ? 1 : 2;
  };
  return [...tickets].sort(
    (a, b) => rank(a) - rank(b) || new Date(a.properties.createdate) - new Date(b.properties.createdate)
  )[0];
}

function ticketLabel(t) {
  const p = t.properties || {};
  const when = p.createdate ? new Date(p.createdate).toLocaleString("en-US", { timeZone: "America/Puerto_Rico", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "?";
  return `#${t.id} "${p.subject || "no subject"}" (created ${when})`;
}

// Merge `dupes` into `primary`, then put the kept owner back (HubSpot's merge
// can switch the owner to the duplicate's owner) and leave a note on the ticket.
async function mergeInto(primary, dupes, { contactId, memberWroteAgain }) {
  const owner = primary.properties?.hubspot_owner_id || "";
  let keepId = String(primary.id);
  const merged = [];
  const failed = [];

  for (const d of dupes) {
    if (String(d.id) === keepId) continue;
    if (d.properties?.hs_pipeline !== primary.properties?.hs_pipeline) {
      failed.push(`${ticketLabel(d)}: different pipeline, left as is`);
      continue;
    }
    try {
      const r = await hubspot("POST", "/crm/v3/objects/tickets/merge", {
        primaryObjectId: keepId,
        objectIdToMerge: String(d.id),
      });
      keepId = String(r.id || keepId); // HubSpot gives the merged ticket a new id
      merged.push(d);
    } catch (e) {
      failed.push(`${ticketLabel(d)}: merge failed (${String(e.message || e).slice(0, 150)})`);
    }
    await new Promise((res) => setTimeout(res, 300));
  }
  if (!merged.length) {
    if (failed.length) console.error("Auto-merge failed:", failed.join(" | "));
    return null;
  }

  const props = {};
  if (owner) props.hubspot_owner_id = owner;
  // The member just wrote in again, so a teammate's ticket should show as "Waiting on us"
  if (memberWroteAgain && isHumanOwner(owner)) props.hs_pipeline_stage = MERGE.waitingOnUsStage;
  if (Object.keys(props).length) {
    await hubspot("PATCH", `/crm/v3/objects/tickets/${keepId}`, { properties: props });
  }

  await addNote(
    keepId,
    contactId,
    `<b>Duplicate tickets merged</b><br>This member had more than one open ticket, so they were merged into this one and it stays with its current owner.<br><br>` +
      `Kept: ${ticketLabel(primary)}<br>Merged in:<br>${merged.map((d) => `&nbsp;&nbsp;• ${ticketLabel(d)}`).join("<br>")}` +
      (failed.length ? `<br><br>Not merged:<br>${failed.map((f) => `&nbsp;&nbsp;• ${f}`).join("<br>")}` : "")
  ).catch((e) => console.error("Merge note failed:", String(e.message || e).slice(0, 200)));

  console.log(`Auto-merge: contact ${contactId}, kept ${primary.id} -> ${keepId}, merged ${merged.map((d) => d.id).join(", ")}`);
  return keepId;
}

// Called for every new ticket. Returns the id to use afterwards (new id if merged).
async function mergeNewTicket(ticketId) {
  const t = await hubspot(
    "GET",
    `/crm/v3/objects/tickets/${ticketId}?properties=${TICKET_PROPS.join(",")}&associations=contacts`
  );
  const contactId = t.associations?.contacts?.results?.[0]?.id;
  if (!contactId) return null;

  return withContactLock(String(contactId), async () => {
    const open = await openTicketsForContact(contactId);
    const fresh = open.find((x) => String(x.id) === String(ticketId));
    if (!fresh) return null; // already merged or closed
    const existing = open.filter((x) => String(x.id) !== String(ticketId));
    if (!existing.length) return null; // first open ticket for this person
    const primary = pickPrimary(existing); // never the brand-new ticket
    const dupes = [...existing.filter((x) => x.id !== primary.id), fresh];
    return mergeInto(primary, dupes, { contactId, memberWroteAgain: true });
  });
}

// New-ticket webhook: merge first, then write the billing summary on whatever ticket survives
async function handleNewTicket(ticketId) {
  let id = ticketId;
  if (MERGE.enabled) {
    try {
      id = (await mergeNewTicket(ticketId)) || ticketId;
    } catch (e) {
      console.error("Auto-merge on new ticket failed:", String(e.message || e).slice(0, 300));
    }
  }
  await summarizeTicket(String(id));
}

// Hourly sweep (and manual dry run): every contact with 2+ open tickets
async function sweepDuplicateTickets({ dry = false } = {}) {
  const tickets = [];
  let after;
  for (let page = 0; page < 20; page++) {
    const r = await hubspot("POST", "/crm/v3/objects/tickets/search", {
      filterGroups: [{ filters: [{ propertyName: "hs_pipeline_stage", operator: "NEQ", value: MERGE.closedStage }] }],
      properties: TICKET_PROPS,
      limit: 100,
      ...(after ? { after } : {}),
    });
    tickets.push(...(r.results || []));
    after = r.paging?.next?.after;
    if (!after) break;
    await new Promise((res) => setTimeout(res, 300));
  }

  const byContact = new Map();
  const byId = new Map(tickets.map((t) => [String(t.id), t]));
  for (let i = 0; i < tickets.length; i += 100) {
    const r = await hubspot("POST", "/crm/v4/associations/tickets/contacts/batch/read", {
      inputs: tickets.slice(i, i + 100).map((t) => ({ id: String(t.id) })),
    });
    for (const row of r.results || []) {
      const c = row.to?.[0]?.toObjectId;
      if (!c) continue;
      const key = String(c);
      if (!byContact.has(key)) byContact.set(key, []);
      byContact.get(key).push(byId.get(String(row.from?.id)));
    }
  }

  const groups = [...byContact].filter(([, ts]) => ts.filter(Boolean).length > 1);
  const report = [];
  for (const [contactId, ts] of groups) {
    const primary = pickPrimary(ts.filter(Boolean));
    if (dry) {
      report.push({ contactId, keep: ticketLabel(primary), merge: ts.filter((t) => t && t.id !== primary.id).map(ticketLabel) });
      continue;
    }
    const keptId = await withContactLock(contactId, async () => {
      const open = await openTicketsForContact(contactId); // re-read in case the webhook already merged
      if (open.length < 2) return null;
      const p = pickPrimary(open);
      return mergeInto(p, open.filter((x) => x.id !== p.id), { contactId, memberWroteAgain: false });
    }).catch((e) => { console.error("Sweep merge failed for contact", contactId, String(e.message || e).slice(0, 200)); return null; });
    report.push({ contactId, keptId });
  }
  console.log(`Duplicate ticket sweep${dry ? " (dry run)" : ""}: ${tickets.length} open tickets, ${groups.length} people with duplicates`);
  return { openTickets: tickets.length, peopleWithDuplicates: groups.length, report };
}

app.post("/admin/merge-duplicates", async (req, res) => {
  if (!adminOk(req)) return res.status(401).json({ error: "unauthorized" });
  let body = {};
  try { body = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf-8") : JSON.stringify(req.body || {})); } catch {}
  if (body.mode !== "dry" && body.mode !== "run") return res.status(400).json({ error: 'mode must be "dry" or "run"' });
  try {
    res.json(await sweepDuplicateTickets({ dry: body.mode === "dry" }));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------------------------------------------------------------------------
// Memberful -> SlickText "active members" list (hourly, after the member index refresh)
// Members with an active subscription (incl. trials and cancelled-but-still-has-access)
// and a US phone number are added to the list; members whose access ended in the last
// 120 days are removed from it. Contacts who texted STOP are never re-subscribed or added.
//
// Env: SLICKTEXT_API_KEY (required), SLICKTEXT_SYNC_MODE = "dry" (default: log only) or "live",
//      optional SLICKTEXT_BRAND_ID (29910), SLICKTEXT_ACTIVE_LIST_ID (119268), SLICKTEXT_API_BASE.
// Run on demand: POST /admin/slicktext-sync  (header x-admin-token, body {"mode":"dry"|"live"})
// ---------------------------------------------------------------------------

const ST = {
  base: (process.env.SLICKTEXT_API_BASE || "https://dev.slicktext.com/v1").replace(/\/$/, ""),
  brand: process.env.SLICKTEXT_BRAND_ID || "29910",
  list: Number(process.env.SLICKTEXT_ACTIVE_LIST_ID || 119268),
};
const stState = {
  running: false,
  contactByPhone: new Map(), // +1XXXXXXXXXX -> { id, optIn }
  onList: new Set(),         // phones this process has confirmed on the list
  offList: new Set(),        // phones this process has confirmed removed
  last: null,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toE164US(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length === 10 && !/^[01]/.test(d)) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1") && !/^[01]/.test(d.slice(1))) return `+${d}`;
  return null;
}

async function slick(method, path, body, retry = true) {
  const r = await fetch(`${ST.base}/brands/${ST.brand}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.SLICKTEXT_API_KEY}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (r.status === 429 && retry) {
    await sleep(Number(r.headers.get("retry-after") || 2) * 1000);
    return slick(method, path, body, false);
  }
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) {
    const e = new Error(`SlickText ${method} ${path} -> ${r.status}: ${text.slice(0, 300)}`);
    e.status = r.status;
    throw e;
  }
  return json;
}

const asList = (j) => (Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : j ? [j] : []);

async function findContact(phone) {
  if (stState.contactByPhone.has(phone)) return stState.contactByPhone.get(phone);
  const rows = asList(await slick("GET", `/contacts?mobile_number=${encodeURIComponent(phone)}`));
  const hit = rows.find((c) => c?.mobile_number === phone);
  const out = hit ? { id: hit.contact_id, optIn: hit.opt_in_status } : null;
  if (out) stState.contactByPhone.set(phone, out);
  return out;
}

async function createContact(phone, m) {
  const [first, ...rest] = String(m.fullName || "").trim().split(/\s+/);
  const created = await slick("POST", "/contacts", {
    mobile_number: phone,
    first_name: first || undefined,
    last_name: rest.join(" ") || undefined,
    email: (m.email || "").trim().toLowerCase() || undefined,
    opt_in_status: "subscribed",
  });
  const c = asList(created)[0];
  const out = { id: c?.contact_id, optIn: c?.opt_in_status || "subscribed" };
  if (out.id) stState.contactByPhone.set(phone, out);
  return out;
}

async function listChange(method, contactIds) {
  for (let i = 0; i < contactIds.length; i += 100) {
    await slick(method, "/lists/contacts", { contacts: contactIds.slice(i, i + 100), lists: [ST.list] });
    await sleep(300);
  }
}

async function syncActiveMembersToSlickText({ mode } = {}) {
  mode = (mode || process.env.SLICKTEXT_SYNC_MODE || "dry").toLowerCase() === "live" ? "live" : "dry";
  if (!process.env.SLICKTEXT_API_KEY) return { skipped: "SLICKTEXT_API_KEY not set" };
  if (stState.running) return { skipped: "already running" };
  stState.running = true;
  const started = Date.now();
  const r = { mode, active: 0, activeWithPhone: 0, ended: 0, toAdd: 0, toRemove: 0, created: 0, added: 0, removed: 0,
              skippedOptedOut: 0, newContacts: 0, lookupErrors: 0, errors: [] };
  try {
    const now = Date.now() / 1000;
    const cutoff = now - 120 * 86400;
    const want = new Map();  // phone -> member (should be on list)
    const drop = new Map();  // phone -> member (access ended recently)
    for (const m of memberIndex.byId.values()) {
      const email = (m.email || "").toLowerCase();
      if (email.startsWith("test@")) continue;
      const subs = m.subscriptions || [];
      const active = subs.some((s) => s.active);
      const phone = toE164US(m.phoneNumber);
      if (active) {
        r.active++;
        if (phone) want.set(phone, m);
      } else if (phone && subs.some((s) => s.expiresAt && s.expiresAt > cutoff)) {
        drop.set(phone, m);
      }
    }
    for (const p of want.keys()) drop.delete(p); // same phone still active on another account
    r.activeWithPhone = want.size;
    r.ended = drop.size;

    const addPhones = [...want.keys()].filter((p) => !stState.onList.has(p));
    const removePhones = [...drop.keys()].filter((p) => !stState.offList.has(p));
    r.toAdd = addPhones.length;
    r.toRemove = removePhones.length;

    // Dry run: check the API works on a small sample, change nothing
    const sample = mode === "dry" ? addPhones.slice(0, 15) : addPhones;
    const addIds = [], addedPhones = [];
    const flushAdds = async () => {
      if (!addIds.length) return;
      const ids = addIds.splice(0), phones = addedPhones.splice(0);
      await listChange("POST", ids);
      phones.forEach((p) => { stState.onList.add(p); stState.offList.delete(p); });
      r.added += ids.length;
      if (r.added % 1000 < 200) console.log(`SlickText sync progress: added ${r.added} of ${r.toAdd}`);
    };
    for (const phone of sample) {
      try {
        let c = await findContact(phone);
        if (c && c.optIn !== "subscribed") { r.skippedOptedOut++; continue; }
        if (!c) {
          r.newContacts++;
          if (mode === "dry") continue;
          c = await createContact(phone, want.get(phone));
          r.created++;
        }
        if (c?.id) { addIds.push(c.id); addedPhones.push(phone); }
        // Live: add in batches so progress survives a restart
        if (mode === "live" && addIds.length >= 200) await flushAdds();
      } catch (e) {
        r.lookupErrors++;
        if (r.errors.length < 5) r.errors.push(String(e.message || e));
        if (e.status === 401 || e.status === 403 || e.status === 404) break; // wrong key / endpoint: stop
      }
      await sleep(150);
    }

    if (mode === "live") {
      await flushAdds();
      const removeIds = [];
      for (const phone of removePhones) {
        try {
          const c = await findContact(phone);
          if (c?.id) removeIds.push([phone, c.id]);
          else stState.offList.add(phone); // not in SlickText at all
        } catch (e) {
          r.lookupErrors++;
          if (r.errors.length < 5) r.errors.push(String(e.message || e));
        }
        await sleep(150);
      }
      if (removeIds.length) {
        await listChange("DELETE", removeIds.map((x) => x[1]));
        removeIds.forEach(([p]) => { stState.offList.add(p); stState.onList.delete(p); });
        r.removed = removeIds.length;
      }
    }
  } catch (e) {
    r.errors.push(String(e.message || e));
  } finally {
    stState.running = false;
    r.seconds = Math.round((Date.now() - started) / 1000);
    stState.last = { at: new Date().toISOString(), ...r };
    console.log("SlickText sync:", JSON.stringify(r));
  }
  return r;
}

app.post("/admin/slicktext-sync", async (req, res) => {
  if (!process.env.ADMIN_TOKEN || req.headers["x-admin-token"] !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  let body = {};
  try { body = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf-8") : JSON.stringify(req.body || {})); } catch {}
  res.json(await syncActiveMembersToSlickText({ mode: body.mode }));
});
app.get("/admin/slicktext-sync/status", (req, res) => {
  if (!process.env.ADMIN_TOKEN || req.headers["x-admin-token"] !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  res.json(stState.last || { note: "not run yet" });
});

// ---------------------------------------------------------------------------
// Asia's to-do list (used by Riya's reminder calls and texts)
// Stored as HubSpot tasks owned by Asia with body tag [riya-todo], so it survives
// restarts and also shows up in HubSpot. Completed = hs_task_status COMPLETED.
// ---------------------------------------------------------------------------
const TODO_OWNER = process.env.REMINDER_TODO_OWNER_ID || "86840305";
const TODO_TAG = "[riya-todo]";

async function listTodos() {
  const out = []; let after;
  for (let i = 0; i < 5; i++) {
    const d = await hubspot("POST", "/crm/v3/objects/tasks/search", {
      filterGroups: [{ filters: [
        { propertyName: "hubspot_owner_id", operator: "EQ", value: TODO_OWNER },
        { propertyName: "hs_task_status", operator: "NEQ", value: "COMPLETED" },
      ] }],
      properties: ["hs_task_subject", "hs_task_body", "hs_task_status", "hs_createdate"],
      sorts: [{ propertyName: "hs_createdate", direction: "ASCENDING" }],
      limit: 100, ...(after ? { after } : {}),
    });
    out.push(...(d.results || []));
    after = d.paging?.next?.after;
    if (!after) break;
  }
  return out
    .filter((t) => (t.properties.hs_task_body || "").includes(TODO_TAG))
    .map((t) => ({ id: t.id, item: t.properties.hs_task_subject }));
}

async function addTodo(item) {
  item = String(item || "").trim().slice(0, 200);
  item = item.charAt(0).toUpperCase() + item.slice(1);
  if (!item) throw new Error("empty item");
  const existing = await listTodos();
  const dup = existing.find((t) => t.item.toLowerCase() === item.toLowerCase());
  if (dup) return { ...dup, duplicate: true };
  const t = await hubspot("POST", "/crm/v3/objects/tasks", { properties: {
    hs_task_subject: item,
    hs_task_body: `${TODO_TAG} Added via Riya`,
    hs_task_status: "NOT_STARTED",
    hs_task_type: "TODO",
    hs_timestamp: new Date().toISOString(),
    hubspot_owner_id: TODO_OWNER,
  } });
  return { id: t.id, item };
}

const TODO_STOP = new Set("the a an to my i on in for of and with about up off it is be that this get".split(" "));
const words = (x) => String(x).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w && !TODO_STOP.has(w));
function matchTodo(todos, said) {
  const sw = new Set(words(said));
  if (!sw.size) return { best: null, scored: [] };
  const scored = todos.map((t) => {
    const tw = words(t.item);
    const hits = tw.filter((w) => sw.has(w) || [...sw].some((s) => s.length > 3 && (w.startsWith(s) || s.startsWith(w)))).length;
    return { ...t, score: tw.length ? hits / Math.min(tw.length, sw.size) : 0, hits };
  }).filter((x) => x.hits > 0).sort((a, b) => b.score - a.score || b.hits - a.hits);
  const best = scored[0] && scored[0].score >= 0.5 && (!scored[1] || scored[0].score > scored[1].score) ? scored[0] : null;
  return { best, scored };
}

async function completeTodo(said) {
  const todos = await listTodos();
  const { best, scored } = matchTodo(todos, said);
  if (!best) return { done: false, candidates: scored.slice(0, 3).map((x) => x.item), all: todos.map((t) => t.item) };
  await hubspot("PATCH", `/crm/v3/objects/tasks/${best.id}`, { properties: { hs_task_status: "COMPLETED" } });
  return { done: true, item: best.item, remaining: todos.length - 1 };
}

function todoAuthOk(req) {
  return process.env.REMINDER_CALL_TOKEN && req.headers["x-reminder-token"] === process.env.REMINDER_CALL_TOKEN;
}
function bodyJson(req) {
  try { return JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf-8") : JSON.stringify(req.body || {})); } catch { return {}; }
}
// For texts / admin: GET list, POST add {item} or {items:[..]}, POST done {item}
app.get("/reminder-list", async (req, res) => {
  if (!todoAuthOk(req)) return res.status(401).json({ error: "unauthorized" });
  try { const t = await listTodos(); res.json({ count: t.length, items: t.map((x) => x.item) }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post("/reminder-list/add", async (req, res) => {
  if (!todoAuthOk(req)) return res.status(401).json({ error: "unauthorized" });
  const b = bodyJson(req); const items = b.items || (b.item ? [b.item] : []);
  try { const added = []; for (const i of items) added.push(await addTodo(i)); res.json({ added }); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post("/reminder-list/done", async (req, res) => {
  if (!todoAuthOk(req)) return res.status(401).json({ error: "unauthorized" });
  try { res.json(await completeTodo(bodyJson(req).item)); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// Asia texting Riya to update her list (called by the Zapier "Asia → Riya to-do texts" Zap,
// which only fires for Asia's own number). Body {message}. Returns {reply} to text back.
//   "done 2" / "done 2, 5" / "done channing" / "called channing" / "finished the fiverr thing"
//   "add call the bank" / "new ..." / "remind me to ..."
//   "list" / "?"  -> current list
async function handleTodoText(msg) {
  const raw = String(msg || "").trim();
  const t = raw.toLowerCase();
  const fmt = (items) => items.length ? items.map((x, i) => `${i + 1}. ${x.item}`).join("\n") : "(nothing left 🎉)";
  if (!t || /^(list|todo|to-do|to do|\?|what'?s (on )?my list)\b/.test(t)) {
    const todos = await listTodos();
    return `📝 Your list:\n${fmt(todos)}\n\nReply "done 2" or "add ..." to update.`;
  }
  const addM = raw.match(/^\s*(?:add|new|remind me to|put)\s*[:\-]?\s*(.+)$/i);
  if (addM) {
    const items = addM[1].split(/\n|;/).map((s) => s.trim()).filter(Boolean);
    const out = [];
    for (const it of items) out.push(await addTodo(it.replace(/\s+(to|on) (my|the) list$/i, "")));
    const todos = await listTodos();
    return `➕ Added: ${out.map((o) => `"${o.item}"${o.duplicate ? " (already there)" : ""}`).join(", ")}\n\n📝 Your list:\n${fmt(todos)}`;
  }
  // done ...  (numbers or words)
  const doneM = raw.match(/^\s*(?:done|did|finished|completed|complete|crossed off|cross off|check off|checked off|x)\b\s*[:\-]?\s*(.*)$/i);
  const target = doneM ? doneM[1] : raw;
  const todos = await listTodos();
  const nums = target.match(/^\s*#?\d+(\s*(,|and|&|\s)\s*#?\d+)*\s*$/) ? target.match(/\d+/g).map(Number) : null;
  if (nums) {
    const picks = [...new Set(nums)].map((n) => todos[n - 1]).filter(Boolean);
    if (!picks.length) return `Hmm, I don't see that number. 📝 Your list:\n${fmt(todos)}`;
    for (const p of picks) await hubspot("PATCH", `/crm/v3/objects/tasks/${p.id}`, { properties: { hs_task_status: "COMPLETED" } });
    const left = await listTodos();
    return `✅ Crossed off: ${picks.map((p) => `"${p.item}"`).join(", ")}\n\n📝 Still on your list:\n${fmt(left)}`;
  }
  const { best, scored } = matchTodo(todos, target);
  if (best && (doneM || /\b(did|done|called|sent|finished|registered|transferred|talked|emailed|checked|handled|took care)\b/i.test(raw))) {
    await hubspot("PATCH", `/crm/v3/objects/tasks/${best.id}`, { properties: { hs_task_status: "COMPLETED" } });
    const left = await listTodos();
    return `✅ Crossed off: "${best.item}"\n\n📝 Still on your list:\n${fmt(left)}`;
  }
  if (doneM && scored.length) {
    return `Which one? Reply "done" + the number:\n${fmt(todos)}`;
  }
  return `I didn't catch that 🙈 Reply "done 2" (or "done channing") to cross off, "add ..." to add, or "list" to see it.\n\n📝 Your list:\n${fmt(todos)}`;
}
app.post("/reminder-list/text", async (req, res) => {
  if (!todoAuthOk(req)) return res.status(401).json({ error: "unauthorized" });
  try { res.json({ reply: (await handleTodoText(bodyJson(req).message || req.query.message)).slice(0, 900) }); }
  catch (e) { console.error(e); res.json({ reply: "Sorry, I couldn't update your list right now. Try again in a bit." }); }
});

// Retell custom functions for the reminder agent (only honored on Asia's reminder calls)
const isReminderCall = (req) => req.body?.call?.metadata?.purpose === "asia-reminder";
app.post("/riya-todo/done", verifyRetell, async (req, res) => {
  if (!isReminderCall(req)) return res.json({ result: "Not available on this call." });
  try {
    const r = await completeTodo(req.body?.args?.item);
    if (r.done) return res.json({ result: `Crossed off: "${r.item}". ${r.remaining} item(s) left.` });
    return res.json({ result: r.candidates.length
      ? `Not sure which one she means. Ask her to pick: ${r.candidates.join(" / ")}`
      : `No matching item. Her current list: ${r.all.join(" / ")}` });
  } catch (e) { console.error(e); res.json({ result: "Couldn't update the list right now; tell her it'll be fixed and to text the change instead." }); }
});
app.post("/riya-todo/add", verifyRetell, async (req, res) => {
  if (!isReminderCall(req)) return res.json({ result: "Not available on this call." });
  try {
    const r = await addTodo(req.body?.args?.item);
    res.json({ result: r.duplicate ? `"${r.item}" is already on the list.` : `Added: "${r.item}".` });
  } catch (e) { console.error(e); res.json({ result: "Couldn't add it right now." }); }
});

// ---------------------------------------------------------------------------
// Reminder calls for Asia (Riya calls her and reads her to-do list)
//   POST /reminder-call   header x-reminder-token: REMINDER_CALL_TOKEN
//        body {"extra": "<time-sensitive items>", "kind": "daily"|"urgent"}; the to-do list comes from HubSpot
//   GET  /reminder-call/info   (same header) -> phone numbers + agents, for setup
// Always calls REMINDER_CALL_TO (Asia's cell) and nobody else.
// Env: REMINDER_CALL_TOKEN, REMINDER_CALL_TO (+1706...), optional
//      RETELL_REMINDER_FROM (+1...), RETELL_REMINDER_AGENT_ID, RETELL_REMINDER_VOICE_ID
// ---------------------------------------------------------------------------
const RETELL_BASE = "https://api.retellai.com";
async function retellApi(method, path, body) {
  const r = await fetch(RETELL_BASE + path, {
    method,
    headers: { Authorization: `Bearer ${process.env.RETELL_API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`Retell ${method} ${path} ${r.status}: ${typeof data === "string" ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)}`);
  return data;
}
const REMINDER_AGENT_NAME = "Riya Reminders v2 (Asia only)";
let reminderAgentId = process.env.RETELL_REMINDER_AGENT_ID || null;

async function listAll(method, path) {
  const out = []; let key;
  for (let i = 0; i < 10; i++) {
    const body = method === "POST" ? { limit: 100, ...(key ? { pagination_key: key } : {}) } : undefined;
    const q = method === "GET" ? `?limit=100${key ? `&pagination_key=${encodeURIComponent(key)}` : ""}` : "";
    const d = await retellApi(method, path + q, body);
    const items = Array.isArray(d) ? d : d?.items || [];
    out.push(...items);
    if (Array.isArray(d) || !d?.has_more || !d?.pagination_key) break;
    key = d.pagination_key;
  }
  return out;
}
const listPhoneNumbers = () => listAll("GET", "/v2/list-phone-numbers");
const listAgents = () => listAll("POST", "/v2/list-agents");

async function pickFromNumber() {
  if (process.env.RETELL_REMINDER_FROM) return process.env.RETELL_REMINDER_FROM;
  const nums = await listPhoneNumbers();
  const n = (nums || []).find((x) => x.outbound_agent_id || x.inbound_agent_id) || (nums || [])[0];
  if (!n) throw new Error("No Retell phone number on this account");
  return n.phone_number;
}

async function ensureReminderAgent() {
  if (reminderAgentId) return reminderAgentId;
  const agents = await listAgents();
  const existing = (agents || []).find((a) => a.agent_name === REMINDER_AGENT_NAME);
  if (existing) return (reminderAgentId = existing.agent_id);
  // Reuse the voice of the existing Riya support agent so it sounds the same
  let voiceId = process.env.RETELL_REMINDER_VOICE_ID;
  if (!voiceId) {
    const riya = (agents || []).find((a) => /riya/i.test(a.agent_name || "")) || (agents || [])[0];
    voiceId = riya?.voice_id;
  }
  if (!voiceId) throw new Error("Could not find a voice to use; set RETELL_REMINDER_VOICE_ID");
  const base = (process.env.PUBLIC_BASE_URL || `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`).replace(/\/$/, "");
  const llm = await retellApi("POST", "/create-retell-llm", {
    general_prompt:
      "You are Riya, Asia Varner's personal assistant at Honey Drip Network. You are calling Asia (the owner) with her reminders. " +
      "Be warm, upbeat and brief. Speak naturally: no emojis, no symbols, say addresses normally.\n\n" +
      "TODAY'S TIME-SENSITIVE ITEMS (say these first, if any):\n{{extra}}\n\n" +
      "HER TO-DO LIST:\n{{todos}}\n\n" +
      "HOW THE CALL GOES:\n" +
      "1. Mention any time-sensitive items first.\n" +
      "2. Read her to-do list, briefly.\n" +
      "3. Ask: \"Have you crossed any of these off yet?\" For EACH item she says is done, call mark_done with her words for it, " +
      "then confirm it's crossed off. If mark_done says it isn't sure which item, ask her to pick and call it again.\n" +
      "4. Ask: \"Anything you want me to add?\" For EACH new thing, call add_item with a short, clear to-do (e.g. 'Call the CPA about residency'). Confirm it was added.\n" +
      "5. When she's done, say a quick upbeat goodbye and call end_call.\n" +
      "Only change the list when she clearly asks. Keep the call under 4 minutes. " +
      "If you reach voicemail: leave a short message with the most important one or two items, say the full list is in her texts, and end the call. " +
      "Never discuss anything else and never share member data.",
    begin_message: "Hey Asia, it's Riya with your reminders. You got a quick minute?",
    general_tools: [
      { type: "end_call", name: "end_call", description: "End the call after saying goodbye." },
      { type: "custom", name: "mark_done", url: `${base}/riya-todo/done`, speak_during_execution: false, speak_after_execution: true,
        description: "Cross an item off Asia's to-do list when she says it's done.",
        parameters: { type: "object", properties: { item: { type: "string", description: "The to-do she finished, in her words" } }, required: ["item"] } },
      { type: "custom", name: "add_item", url: `${base}/riya-todo/add`, speak_during_execution: false, speak_after_execution: true,
        description: "Add a new item to Asia's to-do list when she asks.",
        parameters: { type: "object", properties: { item: { type: "string", description: "Short, clear to-do to add" } }, required: ["item"] } },
    ],
  });
  const agent = await retellApi("POST", "/create-agent", {
    agent_name: REMINDER_AGENT_NAME,
    response_engine: { type: "retell-llm", llm_id: llm.llm_id },
    voice_id: voiceId,
    end_call_after_silence_ms: 20000,
    enable_voicemail_detection: true,
    voicemail_message: "Hey Asia, it's Riya with your reminders. Sorry I missed you! Your full list is in your texts, and you can reply done or add to update it. Talk soon!",
    max_call_duration_ms: 420000,
  });
  return (reminderAgentId = agent.agent_id);
}

function reminderAuthOk(req) {
  return process.env.REMINDER_CALL_TOKEN && req.headers["x-reminder-token"] === process.env.REMINDER_CALL_TOKEN;
}

app.get("/reminder-call/info", async (req, res) => {
  if (!reminderAuthOk(req)) return res.status(401).json({ error: "unauthorized" });
  try {
    const [nums, agents] = await Promise.all([listPhoneNumbers(), listAgents()]);
    res.json({
      to: process.env.REMINDER_CALL_TO || null,
      reminderAgentId,
      phoneNumbers: (nums || []).map((n) => ({ phone_number: n.phone_number, nickname: n.nickname, inbound_agent_id: n.inbound_agent_id, outbound_agent_id: n.outbound_agent_id })),
      agents: [...new Map((agents || []).map((a) => [a.agent_id, { agent_id: a.agent_id, agent_name: a.agent_name, voice_id: a.voice_id }])).values()],
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Place one reminder call. If it isn't answered (no answer / busy / voicemail),
// call back ONCE about 30 minutes later (retries never retry).
const MISSED = new Set(["dial_no_answer", "dial_busy", "dial_failed", "voicemail_reached", "machine_detected", "error_no_audio_received"]);
async function placeReminderCall({ extra, kind, isRetry = false }) {
  const to = process.env.REMINDER_CALL_TO;
  if (!to) throw new Error("REMINDER_CALL_TO not set");
  const todos = await listTodos();
  const todoText = todos.length ? todos.map((t, i) => `${i + 1}. ${t.item}`).join("\n") : "Her list is empty right now.";
  const agentId = await ensureReminderAgent();
  const from = await pickFromNumber();
  const call = await retellApi("POST", "/v2/create-phone-call", {
    from_number: from,
    to_number: to,
    override_agent_id: agentId,
    retell_llm_dynamic_variables: { extra, todos: todoText },
    metadata: { purpose: "asia-reminder", kind, retry: isRetry },
  });
  console.log(`Reminder call placed: ${call.call_id} (${kind}${isRetry ? ", retry" : ""})`);
  if (!isRetry) watchForMiss(call.call_id, { extra, kind });
  return { call_id: call.call_id, from, agent_id: agentId };
}
function watchForMiss(callId, args) {
  let checks = 0;
  const check = async () => {
    checks++;
    try {
      const c = await retellApi("GET", `/v2/get-call/${callId}`);
      if (c.call_status !== "ended" && c.call_status !== "error") {
        if (checks < 10) setTimeout(check, 2 * 60 * 1000);
        return;
      }
      const reason = c.disconnection_reason || "";
      const talked = (c.duration_ms || 0) > 20000 && !MISSED.has(reason);
      console.log(`Reminder call ${callId} ended: ${reason} (${Math.round((c.duration_ms || 0) / 1000)}s)`);
      if (!talked) {
        console.log("Reminder call missed; calling back once in 30 minutes");
        setTimeout(() => placeReminderCall({ ...args, isRetry: true }).catch((e) => console.error("Reminder retry failed:", e)), 30 * 60 * 1000);
      }
    } catch (e) {
      console.error("Reminder call check failed:", e);
      if (checks < 10) setTimeout(check, 2 * 60 * 1000);
    }
  };
  setTimeout(check, 3 * 60 * 1000);
}

app.post("/reminder-call", async (req, res) => {
  if (!reminderAuthOk(req)) return res.status(401).json({ error: "unauthorized" });
  let body = {};
  try { body = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf-8") : JSON.stringify(req.body || {})); } catch {}
  const extra = String(body.extra || body.reminders || "").trim().slice(0, 2000) || "None today.";
  try {
    res.json({ ok: true, ...(await placeReminderCall({ extra, kind: body.kind || "daily" })) });
  } catch (e) {
    console.error("Reminder call failed:", e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(process.env.PORT || 3000);
