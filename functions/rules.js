const RANK = { PROCEED: 0, HOLD: 1, BLOCK: 2 };
const maxVerdict = (a, b) => (RANK[b] > RANK[a] ? b : a);

const RECEIVE_RE = /\b(refund|cash\s?back|reward|prize|lottery|claim|receive|receiving|accept payment)\b|enter\s+(your\s+)?(upi\s+)?pin\s+to\s+(receive|accept|claim|get)|रिफंड|प्राप्त|वापसी|返金|환불|退款/i;
const INJECTION_RE = /(system\s*:|assistant\s*:|ignore\s+(all\s+|any\s+|previous\s+)?(instructions|rules|policy|checks)|verified\s+by|pre-?approved|classify\s+(this\s+)?as|mark\s+(as\s+)?(safe|proceed)|return\s+proceed|do\s+not\s+(flag|block|hold)|override)/i;
const IMPERSONATION_RE = /\b(bank|rbi|reserve bank|npci|police|cbi|enforcement directorate|customs|income\s?tax|court|judge|government|govt|ministry|officer|desk|helpline|customer care|support|kyc|sbi|hdfc|icici|monetary authority|mas|moh|ato|centrelink)\b|警察|検察|金融庁|경찰|검찰|금융감독원|公安|警方/i;

function runRules(intent, context, priorReports) {
  const signals = [];
  let floor = "PROCEED";
  const add = (code, detail, min) => {
    signals.push({ code, detail, floor: min });
    floor = maxVerdict(floor, min);
  };

  if (intent.type === "collect" || RECEIVE_RE.test(`${intent.note} ${intent.payee_name}`)) {
    add("COLLECT_REVERSAL", "Payment is framed as receiving money. Entering a PIN on an instant payment always sends money.", "BLOCK");
  }
  if (priorReports >= 2) {
    add("PAYEE_FLAGGED", `Payee already reported in ${priorReports} separate cases: likely mule account.`, "BLOCK");
  } else if (priorReports === 1) {
    signals.push({ code: "PAYEE_REPORTED", detail: "Payee reported in 1 earlier case.", floor: "PROCEED" });
  }
  if (INJECTION_RE.test(intent.note)) {
    add("NOTE_INJECTION", "Payment note contains instruction-like text aimed at automated checks.", "HOLD");
  }
  if (IMPERSONATION_RE.test(intent.payee_name)) {
    add("IMPERSONATION_NAME", `Payee name "${intent.payee_name}" claims an institution on a person-to-person payment.`, "HOLD");
  }
  const big = context.typical_amount > 0 ? intent.amount >= 5 * context.typical_amount : intent.amount >= 50000;
  if (context.on_call && context.new_payee && big) {
    add("COERCION_CONTEXT", "Customer is on a live call, paying a new payee, far above their usual amount.", "HOLD");
  } else if (context.on_call && context.new_payee) {
    signals.push({ code: "CALL_NEW_PAYEE", detail: "Customer is on a live call while paying a new payee.", floor: "PROCEED" });
  }

  const lowRisk = signals.length === 0 && !context.new_payee && !big;
  return { signals, floor, lowRisk };
}

module.exports = { RANK, maxVerdict, runRules };
