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
      edges { node { id fullName email discordUserId orders { createdAt totalCents status } subscriptions { ${SUB_FIELDS} } } }
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
  if (memberIndex.ready) await refreshOpenTicketSummaries().catch((e) => console.error("Ticket summaries failed:", e));
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
      await hubspot("POST", "/crm/v3/objects/contacts/batch/upsert", {
        inputs: batch.map((c) => ({ idProperty: "email", id: c.email, properties: { email: c.email, ...c.facts, memberful_last_updated: today } })),
      });
      for (const c of batch) billingState.lastSent.set(c.email, c.key);
      written += batch.length;
    } catch (e) {
      failed += batch.length;
      console.error("Billing sync batch failed:", String(e.message || e).slice(0, 300));
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  billingState.primed = true;
  console.log(`Billing sync: ${written} contacts updated, ${failed} failed, ${billingState.offDate.size} cancellations tracked`);

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
      setTimeout(() => summarizeTicket(String(e.objectId)).catch((err) => console.error("Ticket summary failed:", err)), 5000);
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

app.listen(process.env.PORT || 3000);
