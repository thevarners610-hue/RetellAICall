// Retell -> Memberful bridge
//  - /lookup-member: read-only lookup for Riya (Retell custom function)
//  - /hubspot/duplicate-cleanup: team-only cleanup of duplicate Memberful
//    accounts, triggered from a HubSpot ticket property (Riya can't reach it)
// Deploy on Railway. Env vars:
//   RETELL_API_KEY, MEMBERFUL_API_KEY,
//   HUBSPOT_TOKEN, HUBSPOT_CLIENT_SECRET
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
// Duplicate account cleanup (team-only, triggered from HubSpot)
//
// A teammate fills in "Old Memberful emails" on a ticket, then sets
// "Duplicate cleanup" to Preview or Delete. HubSpot sends a webhook here.
// Guardrails: never deletes an account with an active subscription, never
// deletes the ticket contact's own email, max 5 emails per run.
// ---------------------------------------------------------------------------

const HUBSPOT = "https://api.hubapi.com";
const MAX_EMAILS = 5;

// CONFIRM the mutation name and argument in Memberful's API Explorer
// (Documentation Explorer -> Mutation -> search "member") before using Delete.
const DELETE_MEMBER =
  process.env.MEMBERFUL_DELETE_MUTATION ||
  `mutation ($id: ID!) { memberDelete(id: $id) { __typename } }`;

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

app.listen(process.env.PORT || 3000);
