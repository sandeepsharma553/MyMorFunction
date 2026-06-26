"use strict";
// Golden test (functions side) — mirrors MyMorAdmin/src/pages/restaurantgroup/contractFill.test.js
// using the SAME fixture, so the server's document assembly can't diverge from the client preview.
// Run: `npm test` (node test/contractFill.test.js). No jest dependency.
const assert = require("assert");
const contractFill = require("../lib/contractFill");
const fx = require("./contractFill.fixture.json");

assert.deepStrictEqual(
  contractFill.assemble(fx.template, fx.contract),
  fx.expectedBlocks,
  "assemble() output must match the golden fixture (order + minor + extras + empty token)"
);
assert.strictEqual(
  contractFill.line("a {{x}} b {{y}}", { x: "1" }),
  "a 1 b ‹y›",
  "line() must fill non-empty tokens and flag empties as ‹token›"
);
console.log("contractFill (functions) golden test: PASS");
