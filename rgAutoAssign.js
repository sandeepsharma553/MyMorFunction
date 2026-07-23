/* ════════════════════════════════════════════════════════════════════
 * CANONICAL auto-assign decision — Area → Station → Role.
 *
 * ⚠ MUST stay byte-identical (same logic) to the client copy at
 *   MyMorAdmin/src/pages/restaurantgroup/assignmentUtils.js  (shouldAutoAssign).
 * Both repos verify this function against the SAME truth table (parity test), so
 * server auto-assign (rgOnShiftCreated / rgRecurringChecklists) and client suggest
 * never disagree about who an item is for.
 *
 * Station targets ARE a hard gate here: when an item names stations, only staff tagged
 * one of them match, and the check returns before roles are considered (the "ranking
 * nudge" is matchScore/isSuggested — the suggest-ordering layer — not this predicate).
 * Area is the client matcher; roles refine; managers
 * ("sees all") bypass only the AREA gate — eligibility still needs a station or role
 * target on the item (untargeted items match nobody). An unset staff.area never blocks
 * (additive/guarded: we only exclude on a KNOWN area mismatch).
 *
 *   item    : checklist ({area}) or training module ({cat}); may carry autoAssign.roles
 *   staff   : { area, role, venueIds[]|venueId }
 *   venueId : the venue the item lives in
 * ════════════════════════════════════════════════════════════════════ */
/* Derive an Area from a role string — used to give a SHIFT a rostered area (shift
 * docs carry a role + station but no area field). No "CK" — Central Kitchen is a venue,
 * and a "Central Kitchen" role contains "kitchen" → BOH. MANAGERIAL roles return "":
 * the legacy "Mgmt" token is gone, and shouldAutoAssign's seesAll regex is the SAME
 * word list, so the area check is short-circuited for them either way (proven
 * equivalent). Unknown → "" so the "unknown area never blocks" escape applies.
 * Kept byte-identical to the client copies (Admin/Ops assignmentUtils.js). */
function areaFromRole(role) {
  const r = role || "";
  if (/manager|owner|admin|supervisor|in charge/i.test(r)) return ""; // managerial — seesAll covers them; no baked-in token
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
  // Area (mirrors client moduleForStaff/checklistForStaff): universal needs an EXPLICIT
  // "All" — a missing cat/area is an oversight, NOT an implicit "everyone" (same ruling
  // as checklistForStaff). Unknown STAFF areas (empty sAreas) still never block.
  const itemArea = item.cat || item.area || "";
  const areaOk = seesAll || itemArea === "All" || !sAreas.length || sAreas.includes(itemArea);
  if (!areaOk) return false;
  // Station-DRIVEN (AUTO-ASSIGN ONLY — manual assign stays suggest-never-block): targets =
  // autoAssign.stations (multi-select) else the legacy single stationId. A station-targeted
  // item auto-assigns to staff tagged ANY of those stations (area already gated), REGARDLESS
  // of role. Items with NO station targets fall through to role targeting. Byte-identical across Admin/Ops/Functions.
  const stationTargets = (item.autoAssign && item.autoAssign.stations && item.autoAssign.stations.length) ? item.autoAssign.stations : (item.stationId ? [item.stationId] : []);
  if (stationTargets.length) return (Array.isArray(staff.stationIds) ? staff.stationIds : []).some((id) => stationTargets.includes(id));
  // Role targeting: when the item names roles, staff.role must be one (case-insensitive).
  // When it names NONE (and no station targets matched above), the item auto-assigns to
  // NOBODY — seesAll included. It previously fell through to managers, which contradicted
  // both editors' helper text ("otherwise assign it manually") and silently delivered
  // untargeted checklists to managers nobody had assigned them to. Manual assign, slot
  // links and station/role targeting are unaffected.
  const roles = (item.autoAssign && item.autoAssign.roles) || [];
  if (!roles.length) return false;
  if (!(staff.role && roles.some((r) => r && r.toLowerCase() === staff.role.toLowerCase()))) return false;
  return true;
}

module.exports = {shouldAutoAssign, areaFromRole};
