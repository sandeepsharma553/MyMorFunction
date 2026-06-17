/* Phase 3c — auto-assign PARITY (server half). Dependency-free: `node scripts/rgAutoAssign.test.js`.
 *
 * Asserts functions/rgAutoAssign.shouldAutoAssign against the SAME canonical truth
 * table as the client (MyMorAdmin/src/pages/restaurantgroup/assignmentParity.test.js).
 * Both green ⇒ the two halves are equivalent ⇒ server auto-assign and client suggest
 * pick the same staff for the same item.
 *
 * ⚠ KEEP CASES identical to the client parity test. */
const assert = require("assert");
const { shouldAutoAssign } = require("../rgAutoAssign");

const foh = { area: "FOH", role: "FOH", venueIds: ["v1"] };
const boh = { area: "BOH", role: "BOH", venueIds: ["v1"] };
const mgr = { area: "Mgmt", role: "Manager", venueIds: ["v1"] };
const sup = { area: "FOH", role: "FOH Supervisor", venueIds: ["v1"] };
const fohV2 = { area: "FOH", role: "FOH", venueIds: ["v2"] };
const fohNoArea = { role: "FOH", venueIds: ["v1"] };

const clFOHrole = { area: "FOH", autoAssign: { roles: ["FOH"] } };
const clFOHroleLower = { area: "FOH", autoAssign: { roles: ["foh"] } };
const clAllRoleFOH = { area: "All", autoAssign: { roles: ["FOH"] } };
const clFOHnoRole = { area: "FOH" };
const clBOHnoRole = { area: "BOH" };
const mBOHrole = { cat: "BOH", autoAssign: { roles: ["BOH"] } };

const CASES = [
  ["role+area match", clFOHrole, foh, "v1", true],
  ["area+role mismatch", clFOHrole, boh, "v1", false],
  ["module cat match", mBOHrole, boh, "v1", true],
  ["role-targeted skips manager not in roles", mBOHrole, mgr, "v1", false],
  ["All area, role match", clAllRoleFOH, foh, "v1", true],
  ["All area, role mismatch", clAllRoleFOH, boh, "v1", false],
  ["no-roles item NOT auto-assigned to line staff", clFOHnoRole, foh, "v1", false],
  ["no-roles item goes to managers", clFOHnoRole, mgr, "v1", true],
  ["wrong venue excluded", clFOHrole, fohV2, "v1", false],
  ["unknown staff.area never blocks", clFOHrole, fohNoArea, "v1", true],
  ["role match is case-insensitive", clFOHroleLower, foh, "v1", true],
  ["supervisor (sees all) gets no-roles cross-area item", clBOHnoRole, sup, "v1", true],
];

let pass = 0;
for (const [label, item, staff, venueId, expected] of CASES) {
  assert.strictEqual(shouldAutoAssign(item, staff, venueId), expected, `FAILED: ${label}`);
  pass++;
}

// same-people proof: server filter resolves to exactly the expected staff
assert.deepStrictEqual(
  [foh, boh, mgr, sup, fohV2, fohNoArea].filter((s) => shouldAutoAssign(clFOHrole, s, "v1")),
  [foh, fohNoArea],
  "FAILED: role-targeted FOH checklist should resolve to FOH line + unknown-area FOH"
);
assert.deepStrictEqual(
  [foh, boh, mgr, sup, fohNoArea].filter((s) => shouldAutoAssign(clFOHnoRole, s, "v1")),
  [mgr, sup],
  "FAILED: no-roles checklist should resolve to managers/supervisors"
);
pass += 2;

console.log(`✅ rgAutoAssign parity: ${pass}/${pass} cases pass (matches client truth table).`);
process.exit(0);
