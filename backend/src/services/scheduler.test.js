// Unit tests for scheduler.js. Run: node src/services/scheduler.test.js
// Exits 0 on success, non-zero on failure.

const assert = require('node:assert');
const { computeSchedule, computeResourceCurve } = require('./scheduler');

// Running example: 8 tasks A..H with known ground-truth schedule.
const tasks = [
  { id: 'A', duration: 3, dependencies: [] },
  { id: 'B', duration: 4, dependencies: ['A'] },
  { id: 'C', duration: 2, dependencies: ['A'] },
  { id: 'D', duration: 5, dependencies: ['B'] },
  { id: 'E', duration: 3, dependencies: ['B', 'C'] },
  { id: 'F', duration: 4, dependencies: ['C'] },
  { id: 'G', duration: 2, dependencies: ['D', 'E'] },
  { id: 'H', duration: 3, dependencies: ['F', 'G'] },
];

const { projectDuration, criticalPath, slacks } = computeSchedule(tasks);

// Project duration = 17
assert.strictEqual(projectDuration, 17, `projectDuration: expected 17, got ${projectDuration}`);

// Critical path = A → B → D → G → H
assert.deepStrictEqual(criticalPath, ['A', 'B', 'D', 'G', 'H'], `criticalPath mismatch: ${JSON.stringify(criticalPath)}`);

// Earliest / Latest starts (forward + backward pass)
const expectedES = { A: 0, B: 3, C: 3, D: 7, E: 7, F: 5, G: 12, H: 14 };
const expectedLS = { A: 0, B: 3, C: 7, D: 7, E: 9, F: 10, G: 12, H: 14 };
for (const id of Object.keys(expectedES)) {
  const s = slacks.get(id);
  assert.strictEqual(s.ES, expectedES[id], `${id}.ES: expected ${expectedES[id]}, got ${s.ES}`);
  assert.strictEqual(s.LS, expectedLS[id], `${id}.LS: expected ${expectedLS[id]}, got ${s.LS}`);
}

// Total slack
const expectedTotal = { A: 0, B: 0, C: 4, D: 0, E: 2, F: 5, G: 0, H: 0 };
for (const id of Object.keys(expectedTotal)) {
  assert.strictEqual(
    slacks.get(id).totalSlack,
    expectedTotal[id],
    `${id}.totalSlack: expected ${expectedTotal[id]}, got ${slacks.get(id).totalSlack}`,
  );
}

// Critical flag matches totalSlack === 0
for (const id of Object.keys(expectedTotal)) {
  assert.strictEqual(
    slacks.get(id).isCritical,
    expectedTotal[id] === 0,
    `${id}.isCritical mismatch`,
  );
}

// Free slack — terminal task H gets totalSlack==0 → freeSlack 0
const expectedFree = { A: 0, B: 0, C: 0, D: 0, E: 2, F: 5, G: 0, H: 0 };
for (const id of Object.keys(expectedFree)) {
  assert.strictEqual(
    slacks.get(id).freeSlack,
    expectedFree[id],
    `${id}.freeSlack: expected ${expectedFree[id]}, got ${slacks.get(id).freeSlack}`,
  );
}

// ----- Edge: empty -----
{
  const r = computeSchedule([]);
  assert.strictEqual(r.projectDuration, 0);
  assert.deepStrictEqual(r.criticalPath, []);
  assert.strictEqual(r.slacks.size, 0);
}

// ----- Edge: single task -----
{
  const r = computeSchedule([{ id: 'X', duration: 5, dependencies: [] }]);
  assert.strictEqual(r.projectDuration, 5);
  assert.deepStrictEqual(r.criticalPath, ['X']);
  assert.strictEqual(r.slacks.get('X').totalSlack, 0);
}

// ----- Edge: cycle detection -----
{
  let threw = false;
  try {
    computeSchedule([
      { id: 'A', duration: 1, dependencies: ['B'] },
      { id: 'B', duration: 1, dependencies: ['A'] },
    ]);
  } catch (err) {
    threw = err.message === 'Cycle detected in dependency graph';
  }
  assert.strictEqual(threw, true, 'cycle should throw Error("Cycle detected in dependency graph")');
}

// ----- Edge: dangling dependency reference (e.g. deleted task) -----
{
  const r = computeSchedule([
    { id: 'A', duration: 2, dependencies: [] },
    { id: 'B', duration: 3, dependencies: ['A', 'GHOST'] }, // GHOST does not exist
  ]);
  assert.strictEqual(r.projectDuration, 5);
  assert.strictEqual(r.slacks.get('B').ES, 2);
}

// Resource curve: unlimited-resources example. Peak 8 at [2,3).
{
  const tasks = [
    { id: 'A', ES: 0, duration: 2, peopleRequired: 4 },
    { id: 'B', ES: 0, duration: 3, peopleRequired: 3 },
    { id: 'C', ES: 2, duration: 2, peopleRequired: 5 },
    { id: 'D', ES: 3, duration: 4, peopleRequired: 2 },
    { id: 'E', ES: 4, duration: 3, peopleRequired: 4 },
    { id: 'F', ES: 7, duration: 2, peopleRequired: 3 },
    { id: 'G', ES: 9, duration: 2, peopleRequired: 2 },
  ];
  const { peak, points } = computeResourceCurve(tasks, 11);
  assert.strictEqual(peak, 8, `peak expected 8, got ${peak}`);
  const at = (t) => points.find((p) => p.t === t)?.demand;
  assert.strictEqual(at(0), 7, `t=0: ${at(0)}`);
  assert.strictEqual(at(2), 8, `t=2: ${at(2)}`);
  assert.strictEqual(at(3), 7, `t=3: ${at(3)}`);
  assert.strictEqual(at(4), 6, `t=4: ${at(4)}`);
  assert.strictEqual(at(7), 3, `t=7: ${at(7)}`);
  assert.strictEqual(at(9), 2, `t=9: ${at(9)}`);
  assert.strictEqual(at(11), 0, `t=11: ${at(11)}`);
}

// ----- Resource curve: empty -----
{
  const r = computeResourceCurve([], 0);
  assert.strictEqual(r.peak, 0);
  assert.deepStrictEqual(r.points, [{ t: 0, demand: 0 }]);
}

// ----- Decimal durations: 0.1 + 0.2 must still tie with 0.3 -----
{
  const r = computeSchedule([
    { id: 'A', duration: 0.1, dependencies: [] },
    { id: 'B', duration: 0.2, dependencies: ['A'] },
    { id: 'C', duration: 0.3, dependencies: [] },
  ]);
  assert.strictEqual(r.projectDuration, 0.3, `decimal duration: ${r.projectDuration}`);
  for (const id of ['A', 'B', 'C']) {
    assert.strictEqual(r.slacks.get(id).totalSlack, 0, `${id} slack: ${r.slacks.get(id).totalSlack}`);
    assert.strictEqual(r.slacks.get(id).isCritical, true, `${id} should be critical`);
  }
}

// ----- Critical path only follows edges where one task drives the next -----
// c→s is a dependency between two critical tasks, but c ends at 1 and s starts at 5,
// so the real critical chains are c→s2 and x→s.
{
  const r = computeSchedule([
    { id: 'c', duration: 1, dependencies: [] },
    { id: 'x', duration: 5, dependencies: [] },
    { id: 's', duration: 6, dependencies: ['c', 'x'] },
    { id: 's2', duration: 10, dependencies: ['c'] },
  ]);
  assert.deepStrictEqual([...r.criticalSet].sort(), ['c', 's', 's2', 'x']);
  assert.deepStrictEqual(r.criticalPath, ['c', 's2'], `criticalPath: ${JSON.stringify(r.criticalPath)}`);
}

// Resource curve sees tasks that start and end between whole steps.
{
  const curve = computeResourceCurve([
    { id: 'short', ES: 0.2, duration: 0.5, peopleRequired: 3 },
    { id: 'long', ES: 0, duration: 2, peopleRequired: 1 },
  ], 2);
  assert.strictEqual(curve.peak, 4);
  assert.deepStrictEqual(curve.points.map((p) => p.t), [0, 0.2, 0.7, 1, 2]);
  assert.deepStrictEqual(curve.points.map((p) => p.demand), [1, 4, 1, 1, 0]);
}

console.log('All scheduler tests pass.');
