// Retell -> Memberful bridge (read-only)
// Deploy on Railway. Env vars: RETELL_API_KEY, MEMBERFUL_API_KEY
// npm i express retell-sdk

import express from "express";
import Retell from "retell-sdk";

const app = express();
app.use(express.json());

const MEMBERFUL_URL = "https://aristotlesignals.memberful.com/api/graphql";

// Verify the request actually came from Retell
function verifyRetell(req, res, next) {
  const ok = Retell.verify(
    JSON.stringify(req.body),
    process.env.RETELL_API_KEY,
    req.headers["x-retell-signature"]
  );
  if (!ok) return res.status(401).json({ error: "unauthorized" });
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

    // Only return what the agent needs to say out loud. No billing details.
    res.json({
      result: {
        found: true,
        name: m.fullName,
        active_plans: active.map((s) => s.plan?.name),
        active_subscription_count: active.length, // >1 can explain double billing
        renews_or_expires: active[0]?.expiresAt || null,
      },
    });
  } catch (e) {
    console.error(e);
    res.json({ result: "Lookup is unavailable right now. Take their details and escalate." });
  }
});

app.listen(process.env.PORT || 3000);
