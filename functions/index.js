const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const express = require("express");
const crypto = require("crypto");
const { parseUpi } = require("./upi");
const { RANK, maxVerdict, runRules } = require("./rules");
const { assessWithGemini } = require("./gemini");

admin.initializeApp();
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });
const { FieldValue } = admin.firestore;

const HOLD_MINUTES = 30;
const app = express();
app.use(express.json({ limit: "8mb" }));

const hashId = (id) => crypto.createHash("sha256").update(String(id).trim().toLowerCase()).digest("hex").slice(0, 32);
const maskId = (id) => {
  const [local = "", domain] = String(id || "").split("@");
  const m = local.length <= 3 ? `${local.slice(0, 1)}**` : `${local.slice(0, 2)}${"*".repeat(Math.min(local.length - 3, 6))}${local.slice(-1)}`;
  return domain ? `${m}@${domain}` : m;
};

function buildIntent(body) {
  if (body.upi_uri && String(body.upi_uri).trim()) return parseUpi(body.upi_uri);
  const i = body.intent || {};
  return {
    rail: String(i.rail || "UPI"),
    type: i.type === "collect" ? "collect" : "pay",
    payee_id: String(i.payee_id || "").trim(),
    payee_name: String(i.payee_name || "").trim(),
    amount: Number(i.amount) || 0,
    currency: String(i.currency || "INR"),
    note: String(i.note || ""),
  };
}

app.get("/api/health", (req, res) => res.json({ ok: true, gemini_configured: Boolean(process.env.GEMINI_API_KEY) }));

app.post("/api/assess", async (req, res) => {
  try {
    const body = req.body || {};
    let intent;
    try {
      intent = buildIntent(body);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    if (!intent.payee_id) return res.status(400).json({ error: "Payee ID is required" });

    const market = String(body.market || "IN");
    const c = body.context || {};
    const context = { on_call: !!c.on_call, new_payee: !!c.new_payee, typical_amount: Number(c.typical_amount) || 0 };
    const answers = (Array.isArray(body.answers) ? body.answers : [])
      .filter((a) => a && String(a.a || "").trim())
      .slice(0, 5)
      .map((a) => ({ q: String(a.q || "").slice(0, 300), a: String(a.a).slice(0, 1500) }));
    const image = body.image && body.image.data ? { mimeType: String(body.image.mimeType || "image/png"), data: String(body.image.data) } : null;

    const payeeRef = db.collection("payees").doc(hashId(intent.payee_id));
    const payeeSnap = await payeeRef.get();
    const priorReports = payeeSnap.exists ? payeeSnap.data().reports || 0 : 0;

    const { signals, floor, lowRisk } = runRules(intent, context, priorReports);

    let ai = null;
    let degraded = false;
    const aiSkipped = lowRisk && !answers.length && !image;
    if (!aiSkipped) {
      try {
        ai = await assessWithGemini({ market, intent, context, signals, answers, image });
      } catch (e) {
        console.error("gemini_error", e.message);
        degraded = true;
      }
    }

    const aiVerdict = ai ? ai.verdict : "PROCEED";
    const verdict = maxVerdict(floor, aiVerdict);
    const floorApplied = Boolean(ai) && RANK[floor] > RANK[aiVerdict];
    const flagged = verdict !== "PROCEED";
    const payeeReports = priorReports + (flagged ? 1 : 0);
    const maskedIntent = { ...intent, payee_id: maskId(intent.payee_id) };

    const caseRef = db.collection("cases").doc();
    const batch = db.batch();
    batch.set(caseRef, {
      created_at: FieldValue.serverTimestamp(),
      market,
      rail: intent.rail,
      intent: maskedIntent,
      payee_key: payeeRef.id,
      context,
      signals,
      answers,
      had_document: Boolean(image),
      ai,
      ai_skipped: aiSkipped,
      degraded,
      final: { verdict, floor, floor_applied: floorApplied },
      payee_reports: payeeReports,
      status: flagged ? "open" : "cleared",
    });
    if (flagged) {
      batch.set(
        payeeRef,
        {
          reports: FieldValue.increment(1),
          masked_id: maskId(intent.payee_id),
          payee_name: intent.payee_name,
          rail: intent.rail,
          market,
          last_pattern: (ai && ai.pattern) || (signals[0] && signals[0].code) || "UNKNOWN",
          updated_at: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
    await batch.commit();

    res.json({
      case_id: caseRef.id,
      verdict,
      floor,
      floor_applied: floorApplied,
      ai_verdict: ai ? ai.verdict : null,
      ai,
      ai_skipped: aiSkipped,
      degraded,
      signals,
      intent: maskedIntent,
      payee_reports: payeeReports,
      hold_minutes: verdict === "HOLD" ? HOLD_MINUTES : null,
    });
  } catch (e) {
    console.error("assess_error", e);
    res.status(500).json({ error: "Assessment failed" });
  }
});

app.post("/api/cases/:id/action", async (req, res) => {
  const map = { trusted_confirm: "trusted_contact_notified", release: "released", confirm_fraud: "confirmed_fraud", cancel: "cancelled_by_customer" };
  const status = map[req.body && req.body.action];
  if (!status) return res.status(400).json({ error: "Unknown action" });
  try {
    await db.collection("cases").doc(req.params.id).update({ status, updated_at: FieldValue.serverTimestamp() });
    res.json({ ok: true, status });
  } catch (e) {
    res.status(404).json({ error: "Case not found" });
  }
});

exports.api = onRequest({ region: "asia-south1", timeoutSeconds: 60, memory: "512MiB", maxInstances: 10 }, app);
