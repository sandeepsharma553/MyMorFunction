/* ════════════════════════════════════════════════════════════════════
 * CANONICAL auto-assign decision — Area → Station → Role.
 *
 * ⚠ MUST stay byte-identical (same logic) to the client copy at
 *   MyMorAdmin/src/pages/restaurantgroup/assignmentUtils.js  (shouldAutoAssign).
 * Both repos verify this function against the SAME truth table (parity test), so
 * server auto-assign (rgOnShiftCreated / rgRecurringChecklists) and client suggest
 * never disagree about who an item is for.
 *
 * Station is a ranking nudge only (client matchScore) — never a hard yes/no gate —
 * so it does NOT appear here. Area is the client matcher; roles refine; managers
 * ("sees all") are eligible for everything. An unset staff.area never blocks
 * (additive/guarded: we only exclude on a KNOWN area mismatch).
 *
 *   item    : checklist ({area}) or training module ({cat}); may carry autoAssign.roles
 *   staff   : { area, role, venueIds[]|venueId }
 *   venueId : the venue the item lives in
 * ════════════════════════════════════════════════════════════════════ */
function shouldAutoAssign(item, staff, venueId) {
  if (!item || !staff) return false;
  // venue membership (multi-venue via venueIds, legacy single venueId)
  const inVenue = Array.isArray(staff.venueIds) ? staff.venueIds.includes(venueId) : staff.venueId === venueId;
  if (!inVenue) return false;
  // managers / supervisors / admins see everything (mirrors client staffSeesAll)
  const seesAll = staff.area === "Mgmt" || /manager|supervisor|in charge|owner|admin/i.test(staff.role || "");
  // Area (mirrors client moduleForStaff/checklistForStaff): universal "All", exact
  // area match, or seesAll. An unset staff.area never blocks.
  const itemArea = item.cat || item.area || "All";
  const areaOk = seesAll || !staff.area || itemArea === "All" || itemArea === staff.area;
  if (!areaOk) return false;
  // Role targeting: when the item names roles, staff.role must be one (case-insensitive);
  // when it names none, only seesAll staff are auto-targeted (recurring default = managers).
  const roles = (item.autoAssign && item.autoAssign.roles) || [];
  if (roles.length) {
    if (!(staff.role && roles.some((r) => r && r.toLowerCase() === staff.role.toLowerCase()))) return false;
  } else if (!seesAll) {
    return false;
  }
  return true;
}

module.exports = { shouldAutoAssign };
