// Retell -> Memberful bridge (read-only)
// Deploy on Railway. Env vars: RETELL_API_KEY, MEMBERFUL_API_KEY
// npm i express retell-sdk

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

app.listen(process.env.PORT || 3000);
