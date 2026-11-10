// Unit tests for serialScheduler.js. Run: node src/services/serialScheduler.test.js

const assert = require('node:assert');
const { computeSchedule } = require('./scheduler');
const { serialSchedule } = require('./serialScheduler');

// Worked example with known ground-truth constrained schedule.
// | Task | Dur | Pred  | People |
// | A    | 2   | —     | 4      |
// | B    | 3   | —     | 3      |
// | C    | 2   | A     | 5      |
// | D    | 4   | A,B   | 2      |
// | E    | 3   | C     | 4      |
// | F    | 2   | D     | 3      |
// | G    | 2   | E,F   | 2      |
//
// Unlimited: end = 11.
// Constrained to 6: end = 15 (delay = 4).

const taskData = [
  { id: 'A', duration: 2, dependencies: [],          peopleRequired: 4 },
  { id: 'B', duration: 3, dependencies: [],          peopleRequired: 3 },
  { id: 'C', duration: 2, dependencies: ['A'],       peopleRequired: 5 },
  { id: 'D', duration: 4, dependencies: ['A', 'B'],  peopleRequired: 2 },
  { id: 'E', duration: 3, dependencies: ['C'],       peopleRequired: 4 },
  { id: 'F', duration: 2, dependencies: ['D'],       peopleRequired: 3 },
  { id: 'G', duration: 2, dependencies: ['E', 'F'],  peopleRequired: 2 },
];

// Unconstrained pass first — supplies ES/LS for tie-break.
const sched = computeSchedule(taskData);
assert.strictEqual(sched.projectDuration, 11, `unconstrained projectDuration: expected 11, got ${sched.projectDuration}`);

const enriched = taskData.map((t) => {
  const s = sched.slacks.get(t.id);
  return { ...t, ES: s.ES, LS: s.LS };
});

// ----- Constrained to 6 -----
{
  const { projectDuration, tasks } = serialSchedule(enriched, 6);
  assert.strictEqual(projectDuration, 15, `constrained projectDuration: expected 15, got ${projectDuration}`);

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const expected = {
    B: { ES: 0,  EF: 3  },
    A: { ES: 3,  EF: 5  },
    C: { ES: 5,  EF: 7  },
    D: { ES: 7,  EF: 11 },
    E: { ES: 7,  EF: 10 },
    F: { ES: 11, EF: 13 },
    G: { ES: 13, EF: 15 },
  };
  for (const id of Object.keys(expected)) {
    const got = byId.get(id);
    assert.strictEqual(got.ES, expected[id].ES, `${id}.ES: expected ${expected[id].ES}, got ${got.ES}`);
    assert.strictEqual(got.EF, expected[id].EF, `${id}.EF: expected ${expected[id].EF}, got ${got.EF}`);
  }
}

// ----- Cap of 8 (matches unconstrained peak): no delay -----
{
  const { projectDuration } = serialSchedule(enriched, 8);
  assert.strictEqual(projectDuration, 11, `cap=8 should match unconstrained: got ${projectDuration}`);
}

// ----- Cap below max peopleRequired: should throw -----
{
  let threw = false;
  try {
    serialSchedule(enriched, 4); // C needs 5
  } catch (err) {
    threw = /needs 5 people/.test(err.message);
  }
  assert.strictEqual(threw, true, 'expected throw when task exceeds cap');
}

// ----- Invalid cap: should throw -----
{
  let threw = false;
  try {
    serialSchedule(enriched, 0);
  } catch (err) {
    threw = /maxHeadcount must be a positive/.test(err.message);
  }
  assert.strictEqual(threw, true, 'expected throw for cap=0');
}

// Zero-length tasks need nobody, whatever peopleRequired says.
{
  const result = serialSchedule([
    { id: 'work', duration: 2, dependencies: [], peopleRequired: 2 },
    { id: 'milestone', duration: 0, dependencies: ['work'], peopleRequired: 5 },
  ], 2);
  assert.strictEqual(result.projectDuration, 2);
}

console.log('All serial-scheduler tests pass.');
