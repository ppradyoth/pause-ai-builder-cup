function parseUpi(uri) {
  const s = String(uri || "").trim();
  if (!/^upi:\/\//i.test(s)) throw new Error("Not a UPI link (expected upi://pay?...)");
  const qi = s.indexOf("?");
  const verb = s.slice(6, qi === -1 ? undefined : qi).toLowerCase();
  const p = new URLSearchParams(qi === -1 ? "" : s.slice(qi + 1));
  return {
    rail: "UPI",
    type: verb.includes("collect") ? "collect" : "pay",
    payee_id: (p.get("pa") || "").trim(),
    payee_name: (p.get("pn") || "").trim(),
    amount: Number(p.get("am")) || 0,
    currency: p.get("cu") || "INR",
    note: p.get("tn") || "",
  };
}

module.exports = { parseUpi };
