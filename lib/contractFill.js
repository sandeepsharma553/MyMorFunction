/* eslint-disable */
// contractFill.js — BYTE-IDENTICAL in two locations (verified by scripts/verify-fill-parity.js):
//   MyMorAdmin/src/pages/restaurantgroup/contractFill.js   (client preview)
//   functions/lib/contractFill.js                          (server PDF)
// SINGLE SOURCE OF TRUTH for token fill + document assembly, so the live preview and the
// generated PDF can never diverge. Do NOT edit one copy without the other.
// SPEC (pinned):
//   token:  /{{(\w+)}}/g  -> non-empty value, else the placeholder "<U+2039>token<U+203A>" (the ‹ › guillemets)
//   assemble order: each section -> heading (if any) then body lines; then the guardian body
//   IFF contract.isMinor; then an "Additional Terms" heading + extraClauses lines IFF
//   extraClauses is non-empty.
function fillToken(values, t) {
  var v = values ? values[t] : undefined;
  return (v !== undefined && v !== null && String(v).trim() !== "") ? String(v) : "‹" + t + "›";
}
function line(str, values) {
  return String(str).replace(/{{(\w+)}}/g, function (_m, t) { return fillToken(values, t); });
}
function assemble(template, contract) {
  var v = (contract && contract.values) || {};
  var blocks = [];
  var sections = (template && template.sections) || [];
  for (var i = 0; i < sections.length; i++) {
    var s = sections[i] || {};
    if (s.heading) blocks.push({ t: "h", text: s.heading });
    var body = s.body || [];
    for (var j = 0; j < body.length; j++) blocks.push({ t: "p", text: line(body[j], v) });
  }
  var g = template && template.conditional && template.conditional.guardian;
  if (contract && contract.isMinor && g && g.body) {
    for (var k = 0; k < g.body.length; k++) blocks.push({ t: "p", text: line(g.body[k], v) });
  }
  var extra = ((contract && contract.extraClauses) || "").trim();
  if (extra) {
    blocks.push({ t: "h", text: "Additional Terms" });
    var lines = extra.split("\n").filter(Boolean);
    for (var m = 0; m < lines.length; m++) blocks.push({ t: "p", text: lines[m] });
  }
  return blocks;
}
module.exports = { line: line, fillToken: fillToken, assemble: assemble };
