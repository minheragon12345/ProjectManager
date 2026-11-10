// Unit tests for crashing.js. Run: node src/services/crashing.test.js

const assert = require('node:assert');
const { computeCrashingTable } = require('./crashing');

// Worked example with two critical paths.
// | Task | Dur | Min | Cost | Pred |
// | A    | 4   | 2   | 5    | —    |
// | B    | 6   | 4   | 3    | A    |
// | C    | 5   | 4   | 6    | A    |
// | D    | 4   | 2   | 2    | B    |
// | E    | 3   | 2   | 4    | C    |
// | F    | 2   | 2   | —    | D,E  |
//
// Paths: A→B→D→F = 16, A→C→E→F = 14.
// Lost-revenue lookup: 16 → 20, 15 → 15, 14 → 10, 13 → 6, 12 → 3.

const tasks = [
  { id: 'A', duration: 4, minDuration: 2, marginalCost: 5, dependencies: [] },
  { id: 'B', duration: 6, minDuration: 4, marginalCost: 3, dependencies: ['A'] },
  { id: 'C', duration: 5, minDuration: 4, marginalCost: 6, dependencies: ['A'] },
  { id: 'D', duration: 4, minDuration: 2, marginalCost: 2, dependencies: ['B'] },
  { id: 'E', duration: 3, minDuration: 2, marginalCost: 4, dependencies: ['C'] },
  // F has no marginalCost / minDuration — not crashable.
  { id: 'F', duration: 2, minDuration: 2, marginalCost: null, dependencies: ['D', 'E'] },
];

const lostRevTable = { 16: 20, 15: 15, 14: 10, 13: 6, 12: 3, 11: 0 };
const lostRevenueFn = (d) => (lostRevTable[d] != null ? lostRevTable[d] : 0);

const { rows, optimalIndex, steps } = computeCrashingTable(tasks, lostRevenueFn);

// Synthesis table — ground truth:
//   Dur 16 → crash 0  + lost 20 = 20
//   Dur 15 → crash 2  + lost 15 = 17     (crash D 4→3)
//   Dur 14 → crash 4  + lost 10 = 14 ←   (crash D 3→2)
//   Dur 13 → crash 9  + lost 6  = 15     (crash A 4→3)
//   Dur 12 → crash 14 + lost 3  = 17     (crash A 3→2)
const expected = [
  { duration: 16, cumulativeCrashCost: 0,  lostRevenue: 20, totalCost: 20 },
  { duration: 15, cumulativeCrashCost: 2,  lostRevenue: 15, totalCost: 17 },
  { duration: 14, cumulativeCrashCost: 4,  lostRevenue: 10, totalCost: 14 },
  { duration: 13, cumulativeCrashCost: 9,  lostRevenue: 6,  totalCost: 15 },
  { duration: 12, cumulativeCrashCost: 14, lostRevenue: 3,  totalCost: 17 },
];

for (let i = 0; i < expected.length; i += 1) {
  const got = rows[i];
  const want = expected[i];
  assert(got, `row ${i} missing`);
  assert.strictEqual(got.duration, want.duration, `row ${i} duration: expected ${want.duration}, got ${got.duration}`);
  assert.strictEqual(got.cumulativeCrashCost, want.cumulativeCrashCost, `row ${i} cum: expected ${want.cumulativeCrashCost}, got ${got.cumulativeCrashCost}`);
  assert.strictEqual(got.lostRevenue, want.lostRevenue, `row ${i} lost: expected ${want.lostRevenue}, got ${got.lostRevenue}`);
  assert.strictEqual(got.totalCost, want.totalCost, `row ${i} total: expected ${want.totalCost}, got ${got.totalCost}`);
}

// Optimal row = duration 14, total 14.
assert.strictEqual(rows[optimalIndex].duration, 14, `optimal duration: expected 14, got ${rows[optimalIndex].duration}`);
assert.strictEqual(rows[optimalIndex].totalCost, 14, `optimal totalCost: expected 14, got ${rows[optimalIndex].totalCost}`);

// Verify steps narrative.
assert.deepStrictEqual(steps[0], { from: 16, to: 15, taskIds: ['D'], cost: 2 }, `step 0 mismatch: ${JSON.stringify(steps[0])}`);
assert.deepStrictEqual(steps[1], { from: 15, to: 14, taskIds: ['D'], cost: 2 }, `step 1 mismatch: ${JSON.stringify(steps[1])}`);
assert.deepStrictEqual(steps[2], { from: 14, to: 13, taskIds: ['A'], cost: 5 }, `step 2 mismatch: ${JSON.stringify(steps[2])}`);
assert.deepStrictEqual(steps[3], { from: 13, to: 12, taskIds: ['A'], cost: 5 }, `step 3 mismatch: ${JSON.stringify(steps[3])}`);

// ----- Edge: no crashable tasks -----
{
  const r = computeCrashingTable(
    [
      { id: 'X', duration: 3, dependencies: [], minDuration: null, marginalCost: null },
      { id: 'Y', duration: 2, dependencies: ['X'], minDuration: null, marginalCost: null },
    ],
    () => 100,
  );
  assert.strictEqual(r.rows.length, 1, `no-crash table should have one row, got ${r.rows.length}`);
  assert.strictEqual(r.rows[0].duration, 5);
  assert.strictEqual(r.optimalIndex, 0);
  assert.strictEqual(r.steps.length, 0);
}

// ----- Edge: single critical path, linear lost revenue -----
{
  const r = computeCrashingTable(
    [
      { id: 'A', duration: 5, minDuration: 3, marginalCost: 1, dependencies: [] },
      { id: 'B', duration: 4, minDuration: 2, marginalCost: 10, dependencies: ['A'] },
    ],
    (d) => 2 * d,
  );
  // Initial: dur 9, lost 18, total 18.
  // Step: crash A (cheaper) → dur 8, cum 1, lost 16, total 17.
  // Step: crash A → dur 7, cum 2, lost 14, total 16. A at min.
  // Step: crash B → dur 6, cum 12, lost 12, total 24. Continue B once more → dur 5, cum 22, lost 10, total 32.
  // Optimal: dur 7, total 16.
  assert.strictEqual(r.rows[0].duration, 9);
  assert.strictEqual(r.rows[r.optimalIndex].duration, 7, `linear-rev optimal: ${r.rows[r.optimalIndex].duration}`);
}

// ----- Edge: less than one unit left before the minimum -----
{
  const r = computeCrashingTable(
    [{ id: 'X', duration: 3.5, minDuration: 3, marginalCost: 10, dependencies: [] }],
    (d) => d * 100,
  );
  // Crash only the 0.5 that is left, at half the per-unit cost, then stop at the minimum.
  assert.deepStrictEqual(r.rows.map((row) => row.duration), [3.5, 3]);
  assert.deepStrictEqual(r.steps, [{ from: 3.5, to: 3, taskIds: ['X'], cost: 5 }]);
  assert.strictEqual(r.rows[1].cumulativeCrashCost, 5);
}

// ----- Edge: step records the real new duration, not "minus one" -----
{
  // Crashing A by 1 only gains 0.5, because B (parallel, 0.5 shorter) becomes critical.
  const r = computeCrashingTable(
    [
      { id: 'A', duration: 4, minDuration: 3, marginalCost: 1, dependencies: [] },
      { id: 'B', duration: 3.5, minDuration: null, marginalCost: null, dependencies: [] },
    ],
    () => 0,
  );
  assert.deepStrictEqual(r.steps[0], { from: 4, to: 3.5, taskIds: ['A'], cost: 1 }, `step: ${JSON.stringify(r.steps[0])}`);
}

console.log('All crashing tests pass.');
