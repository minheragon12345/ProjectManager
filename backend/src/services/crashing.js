// Project crashing analysis. Iteratively shortens the critical path one unit
// at a time, each step picking the cheapest crashable task (or the cheapest
// combination when multiple paths are simultaneously critical).
// Returns rows + optimalIndex + steps. Throws on dependency cycle.

const { buildGraph, computeSchedule, isCriticalEdge, roundTime } = require('./scheduler');

function isCrashable(t) {
  return (
    t.marginalCost != null
    && Number.isFinite(Number(t.marginalCost))
    && t.minDuration != null
    && Number.isFinite(Number(t.minDuration))
    && t.current > Number(t.minDuration)
  );
}

// Enumerate every source→sink path made of critical tasks.
function findAllCriticalPaths(graph, slacks) {
  const isCritical = (id) => slacks.get(id)?.isCritical === true;

  const criticalNodes = [...graph.nodes].filter(isCritical);
  if (criticalNodes.length === 0) return [];

  const sources = criticalNodes.filter((id) => {
    const preds = graph.predecessors.get(id) || [];
    return preds.every((p) => !isCriticalEdge(slacks, p, id));
  });

  const paths = [];
  const stack = [];

  function dfs(node) {
    stack.push(node);
    const succs = (graph.successors.get(node) || []).filter((s) => isCriticalEdge(slacks, node, s));
    if (succs.length === 0) {
      paths.push(stack.slice());
    } else {
      for (const s of succs) dfs(s);
    }
    stack.pop();
  }

  for (const src of sources) dfs(src);
  return paths;
}

// Given critical paths and current task states, find the min-cost subset of
// tasks (a vertex cut) such that every critical path contains at least one
// member, and every member is crashable.
function findMinCostMove(criticalPaths, taskById) {
  if (criticalPaths.length === 0) return null;

  // Collect candidate crashable tasks that appear on at least one critical path.
  const candidates = new Set();
  for (const path of criticalPaths) {
    for (const id of path) {
      const t = taskById.get(id);
      if (t && isCrashable(t)) candidates.add(id);
    }
  }
  if (candidates.size === 0) return null;

  const candArr = [...candidates];

  // Path-cover test.
  const covers = (subset, path) => {
    const setOfPath = new Set(path);
    for (const id of subset) {
      if (setOfPath.has(id)) return true;
    }
    return false;
  };
  const coversAll = (subset) => criticalPaths.every((p) => covers(subset, p));
  const subsetCost = (subset) => subset.reduce((s, id) => s + Number(taskById.get(id).marginalCost), 0);

  // 1-task cuts (shared task on every path).
  let best = null;
  for (const id of candArr) {
    if (coversAll([id])) {
      const cost = Number(taskById.get(id).marginalCost);
      if (best == null || cost < best.cost) best = { taskIds: [id], cost };
    }
  }
  if (best) return best;

  // 2-task cuts.
  for (let i = 0; i < candArr.length; i += 1) {
    for (let j = i + 1; j < candArr.length; j += 1) {
      const subset = [candArr[i], candArr[j]];
      if (!coversAll(subset)) continue;
      const cost = subsetCost(subset);
      if (best == null || cost < best.cost) best = { taskIds: subset, cost };
    }
  }
  if (best) return best;

  // 3-task cuts (rare — projects with 3 simultaneously-critical disjoint paths).
  for (let i = 0; i < candArr.length; i += 1) {
    for (let j = i + 1; j < candArr.length; j += 1) {
      for (let k = j + 1; k < candArr.length; k += 1) {
        const subset = [candArr[i], candArr[j], candArr[k]];
        if (!coversAll(subset)) continue;
        const cost = subsetCost(subset);
        if (best == null || cost < best.cost) best = { taskIds: subset, cost };
      }
    }
  }

  return best;
}

function computeCrashingTable(tasks, lostRevenueFn, { maxIter = 200 } = {}) {
  const lostRev = typeof lostRevenueFn === 'function'
    ? lostRevenueFn
    : () => 0;

  // Working copy: mutate `current` only; preserve baseline `duration` for reference.
  const state = tasks.map((t) => ({
    id: String(t.id),
    baselineDuration: Number(t.duration) || 0,
    current: Number(t.duration) || 0,
    minDuration: t.minDuration == null ? null : Number(t.minDuration),
    marginalCost: t.marginalCost == null ? null : Number(t.marginalCost),
    dependencies: (t.dependencies || []).map(String),
  }));
  const byId = new Map(state.map((s) => [s.id, s]));

  const rows = [];
  const steps = [];
  let cumulative = 0;

  for (let iter = 0; iter <= maxIter; iter += 1) {
    const schedTasks = state.map((s) => ({
      id: s.id,
      duration: s.current,
      dependencies: s.dependencies,
    }));
    const sched = computeSchedule(schedTasks);
    const dur = sched.projectDuration;
    // The previous move may shorten the project by less than it shortened the tasks.
    if (steps.length) steps[steps.length - 1].to = dur;

    const lostValue = Number(lostRev(dur));
    const lostFinal = Number.isFinite(lostValue) ? lostValue : 0;
    const totalCost = cumulative + lostFinal;
    rows.push({
      duration: dur,
      cumulativeCrashCost: cumulative,
      lostRevenue: lostFinal,
      totalCost,
    });

    if (iter === maxIter) break;

    // Build graph again to find all critical paths.
    const graph = buildGraph(schedTasks);
    const criticalPaths = findAllCriticalPaths(graph, sched.slacks);
    const move = findMinCostMove(criticalPaths, byId);
    if (!move) break;

    // Each task in the cut loses 1 unit, or less when one of them is closer than
    // 1 unit to its minimum duration.
    const amount = Math.min(1, ...move.taskIds.map((id) => byId.get(id).current - byId.get(id).minDuration));
    for (const id of move.taskIds) {
      const s = byId.get(id);
      s.current = roundTime(s.current - amount);
    }
    const cost = roundTime(move.cost * amount);
    cumulative = roundTime(cumulative + cost);
    steps.push({ from: dur, to: null, taskIds: move.taskIds.slice(), cost });
  }

  // Optimal = row with minimum totalCost (first match wins on ties).
  let optimalIndex = 0;
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].totalCost < rows[optimalIndex].totalCost) optimalIndex = i;
  }

  return { rows, optimalIndex, steps };
}

module.exports = {
  computeCrashingTable,
  findAllCriticalPaths,
  findMinCostMove,
};
