// Unit tests for scheduleTasks.js. Run: node src/services/scheduleTasks.test.js

const assert = require('node:assert');
const { buildScheduleTasks, getSummaryStart } = require('./scheduleTasks');
const { computeSchedule, computeResourceCurve } = require('./scheduler');
const { serialSchedule } = require('./serialScheduler');
const { computeCrashingTable } = require('./crashing');

// design (3) -> parent P [build (4), test (2), test after build] -> release (1)
// P has a stored duration of 10 that must not count on top of its subtasks.
const rows = [
  { _id: 'design', duration: 3, dependencies: [], peopleRequired: 2 },
  { _id: 'P', duration: 10, dependencies: ['design'], peopleRequired: 5 },
  { _id: 'build', duration: 4, dependencies: [], parentTask: 'P', peopleRequired: 2, minDuration: 2, marginalCost: 10 },
  { _id: 'test', duration: 2, dependencies: ['build', 'P'], parentTask: 'P', peopleRequired: 1 },
  { _id: 'release', duration: 1, dependencies: ['P', 'ghost'], peopleRequired: 1 },
  { _id: 'dropped', duration: 6, dependencies: ['design'], status: 'cancelled', peopleRequired: 3 },
];

const tasks = buildScheduleTasks(rows);
const byId = new Map(tasks.map((task) => [task.id, task]));

const parent = byId.get('P');
assert.strictEqual(parent.isSummary, true);
assert.strictEqual(parent.duration, 0);
assert.strictEqual(parent.peopleRequired, 0);
assert.deepStrictEqual(parent.dependencies.sort(), ['build', 'design', 'test']);

// Subtasks inherit the parent's dependency; a link to their own parent is dropped.
assert.deepStrictEqual(byId.get('build').dependencies, ['design']);
assert.deepStrictEqual(byId.get('test').dependencies.sort(), ['build', 'design']);

// Links to tasks outside the list are dropped.
assert.deepStrictEqual(byId.get('release').dependencies, ['P']);

const dropped = byId.get('dropped');
assert.strictEqual(dropped.duration, 0);
assert.strictEqual(dropped.peopleRequired, 0);
assert.strictEqual(dropped.isCancelled, true);

const schedule = computeSchedule(tasks);
// design 3 + build 4 + test 2 + release 1. The parent's own 10 is not added.
assert.strictEqual(schedule.projectDuration, 10);
assert.strictEqual(schedule.slacks.get('P').ES, 9);
assert.strictEqual(schedule.slacks.get('release').ES, 9);

const startById = new Map(tasks.map((task) => [task.id, schedule.slacks.get(task.id).ES]));
assert.strictEqual(getSummaryStart(parent, startById), 3);

// A parent linked to its own subtasks must not make the subtasks wait on each other.
const linked = buildScheduleTasks([
  { _id: 'P', duration: 0, dependencies: ['a', 'b'] },
  { _id: 'a', duration: 2, parentTask: 'P' },
  { _id: 'b', duration: 3, parentTask: 'P' },
]);
assert.strictEqual(computeSchedule(linked).projectDuration, 3);

// The cancelled task and the parent need nobody, so a cap of 2 still fits.
const enriched = tasks.map((task) => ({ ...task, ES: schedule.slacks.get(task.id).ES, LS: schedule.slacks.get(task.id).LS }));
const serial = serialSchedule(enriched, 2);
assert.strictEqual(serial.projectDuration, 10);

const curve = computeResourceCurve(
  tasks.map((task) => ({ id: task.id, ES: schedule.slacks.get(task.id).ES, duration: task.duration, peopleRequired: task.peopleRequired })),
  schedule.projectDuration,
);
assert.strictEqual(curve.peak, 2);

// Only real work is offered for crashing.
const crash = computeCrashingTable(tasks, (duration) => duration * 100);
assert.ok(crash.steps.every((step) => step.taskIds.every((id) => id === 'build')));
assert.strictEqual(crash.steps.length, 2);

console.log('All schedule-input tests pass.');
