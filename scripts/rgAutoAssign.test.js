/* Phase 3c — auto-assign PARITY (server half). Dependency-free: `node scripts/rgAutoAssign.test.js`.
 *
 * Asserts functions/rgAutoAssign.shouldAutoAssign against the SAME canonical truth
 * table as the client (MyMorAdmin/src/pages/restaurantgroup/assignmentParity.test.js).
 * Both green ⇒ the two halves are equivalent ⇒ server auto-assign and client suggest
 * pick the same staff for the same item.
 *
 * ⚠ KEEP CASES identical to the client parity test. */
const assert = require("assert");
const { shouldAutoAssign, areaFromRole } = require("../rgAutoAssign");

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

// multi-area (areas[]) fixtures — the migration's target shape — kept identical in both repos
const multiFB = { areas: ["FOH", "BOH"], role: "FOH", venueIds: ["v1"] };
const cookMgmt = { areas: ["Mgmt"], role: "Cook", venueIds: ["v1"] };
const cookBOH = { areas: ["BOH"], role: "Cook", venueIds: ["v1"] };
const clFOHcook = { area: "FOH", autoAssign: { roles: ["Cook"] } };
const mBOHfoh = { cat: "BOH", autoAssign: { roles: ["FOH"] } };
const clKitchenFOH = { area: "Kitchen", autoAssign: { roles: ["FOH"] } };

// station HARD-gate (auto-assign) fixtures — kept identical in both repos
const clFOHbar = { area: "FOH", stationId: "bar", autoAssign: { roles: ["FOH"] } };       // station-specific
const clFOHnoStn = { area: "FOH", autoAssign: { roles: ["FOH"] } };                       // no station
const clBarMgr = { area: "FOH", stationId: "bar", autoAssign: { roles: ["Manager"] } };   // station + manager role
const clBarWrongRole = { area: "FOH", stationId: "bar", autoAssign: { roles: ["BOH"] } }; // station + a role the FOH-bar person lacks
const clMultiStn = { area: "FOH", autoAssign: { roles: [], stations: ["bar", "counter"] } }; // multi-station auto-assign target
const fohBar = { areas: ["FOH"], role: "FOH", venueIds: ["v1"], stationIds: ["bar"] };    // tagged the station
const fohNoStn = { areas: ["FOH"], role: "FOH", venueIds: ["v1"], stationIds: [] };       // NOT tagged
const mgrBar = { areas: ["Mgmt"], role: "Manager", venueIds: ["v1"], stationIds: ["bar"] };
const mgrNoStn = { areas: ["Mgmt"], role: "Manager", venueIds: ["v1"], stationIds: [] };

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
  // multi-area (areas[]) + dropped area-based see-all
  ["multi-area person gets a FOH item", clFOHrole, multiFB, "v1", true],
  ["multi-area person ALSO gets a BOH item", mBOHfoh, multiFB, "v1", true],
  ["multi-area person does NOT get an out-of-area (Kitchen) item", clKitchenFOH, multiFB, "v1", false],
  ["area 'Mgmt' no longer grants see-all (role-based only)", clFOHcook, cookMgmt, "v1", false],
  ["non-mgr area gate blocks even when the role matches", clFOHcook, cookBOH, "v1", false],
  // station HARD gate (auto-assign): station-specific item → only station-tagged staff
  ["station item → station-tagged staff auto-assigned", clFOHbar, fohBar, "v1", true],
  ["station item → staff missing the station EXCLUDED", clFOHbar, fohNoStn, "v1", false],
  ["no-station item → station ignored (area/role only)", clFOHnoStn, fohNoStn, "v1", true],
  ["station item → role-matched MANAGER without the station excluded (no bypass)", clBarMgr, mgrNoStn, "v1", false],
  ["station item → manager WITH the station auto-assigned", clBarMgr, mgrBar, "v1", true],
  // station-DRIVEN (#3): a station-tagged item assigns to station-tagged staff even when the role list doesn't match
  ["station item → station-tagged staff assigned despite role mismatch (station drives)", clBarWrongRole, fohBar, "v1", true],
  // multi-station auto-assign (autoAssign.stations): staff tagged ANY target station is assigned
  ["multi-station item → staff at one of the target stations assigned", clMultiStn, fohBar, "v1", true],
  ["multi-station item → staff at none of the target stations excluded", clMultiStn, fohNoStn, "v1", false],
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

// ── Rostered-role fix: area derived from the shift's role (shift has no area field) ──
// ⚠ KEEP AREA_CASES + the rostered proof identical to the client parity test.
const AREA_CASES = [
  ["FOH", "FOH"],
  ["FOH — Bar", "FOH"],
  ["BOH", "BOH"],
  ["BOH — Kitchen", "BOH"],
  ["Chef", "BOH"],
  ["Central Kitchen", "BOH"],
  ["Store Manager", "Mgmt"],
  ["FOH Supervisor", "Mgmt"],
  ["Junior", ""],
  ["", ""],
];
for (const [role, area] of AREA_CASES) {
  assert.strictEqual(areaFromRole(role), area, `FAILED: areaFromRole(${JSON.stringify(role)})`);
  pass++;
}

// rostered identity built from the shift doc (mirrors rgOnShiftCreated)
const rosteredFromShift = (shift, venueId) => ({
  role: shift.role,
  area: areaFromRole(shift.role),
  venueIds: [venueId],
  stationIds: shift.stationId ? [shift.stationId] : [],
});
// a BOH-home person rostered as FOH gets the FOH item, not the BOH item (home never read)
const rosteredFOH = rosteredFromShift({ staffId: "x", role: "FOH", venueId: "v1", stationId: "" }, "v1");
assert.strictEqual(rosteredFOH.area, "FOH", "FAILED: rostered FOH should derive area FOH");
assert.strictEqual(shouldAutoAssign(clFOHrole, rosteredFOH, "v1"), true, "FAILED: rostered FOH → FOH checklist");
assert.strictEqual(shouldAutoAssign(mBOHrole, rosteredFOH, "v1"), false, "FAILED: rostered FOH should NOT get BOH module");
const rosteredBOH = rosteredFromShift({ staffId: "x", role: "BOH", venueId: "v1", stationId: "" }, "v1");
assert.strictEqual(shouldAutoAssign(mBOHrole, rosteredBOH, "v1"), true, "FAILED: rostered BOH → BOH module");
assert.strictEqual(shouldAutoAssign(clFOHrole, rosteredBOH, "v1"), false, "FAILED: rostered BOH should NOT get FOH checklist");
pass += 5;

console.log(`✅ rgAutoAssign parity: ${pass}/${pass} cases pass (matches client truth table).`);
process.exit(0);
