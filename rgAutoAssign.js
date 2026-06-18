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
/* Derive an Area from a role string — used to give a SHIFT a rostered area (shift
 * docs carry a role + station but no area field). Mirrors the client's Phase-2
 * staffAreaBucket / ShiftPlanner roleArea regex (no "CK" — Central Kitchen is a venue,
 * and a "Central Kitchen" role contains "kitchen" → BOH). Unknown → "" so the
 * shouldAutoAssign "unknown area never blocks" escape applies. */
function areaFromRole(role) {
  const r = role || "";
  if (/manager|owner|admin|supervisor|in charge/i.test(r)) return "Mgmt";
  if (/foh|floor|\bbar\b|barista|counter|service/i.test(r)) return "FOH";
  if (/boh|kitchen|chef|grill|fry|wash|prep|cook|dish/i.test(r)) return "BOH";
  return "";
}

function shouldAutoAssign(item, staff, venueId) {
  if (!item || !staff) return false;
  // venue membership (multi-venue via venueIds, legacy single venueId)
  const inVenue = Array.isArray(staff.venueIds) ? staff.venueIds.includes(venueId) : staff.venueId === venueId;
  if (!inVenue) return false;
  // managerial ROLES see everything (mirrors client staffSeesAll). Area-based see-all
  // (area === "Mgmt") is DROPPED — visibility is exactly the areas in the list.
  const seesAll = /manager|supervisor|in charge|owner|admin/i.test(staff.role || "");
  // staff areas as a LIST (backward-compat: fall back to the legacy single area)
  const sAreas = (Array.isArray(staff.areas) && staff.areas.length) ? staff.areas : (staff.area ? [staff.area] : []);
  // Area (mirrors client moduleForStaff/checklistForStaff): universal "All", the item
  // area is among the staff's areas, or seesAll. Unknown areas (empty) never block.
  const itemArea = item.cat || item.area || "All";
  const areaOk = seesAll || itemArea === "All" || !sAreas.length || sAreas.includes(itemArea);
  if (!areaOk) return false;
  // Station HARD gate (AUTO-ASSIGN ONLY — manual assign stays suggest-never-block): a
  // station-specific item only auto-assigns to staff tagged that station. No station on
  // the item → station does not restrict. No manager/seesAll bypass here (strict machine).
  if (item.stationId && !(Array.isArray(staff.stationIds) ? staff.stationIds : []).includes(item.stationId)) return false;
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

module.exports = { shouldAutoAssign, areaFromRole };
