// CPM (Critical Path Method) scheduler. Pure functions, no I/O.
// computeSchedule(tasks) -> { projectDuration, criticalPath, criticalSet, slacks }
// Throws on dependency cycles.

function buildGraph(tasks) {
  const nodes = new Set();
  const durations = new Map();
  const predecessors = new Map();
  const successors = new Map();

  for (const t of tasks || []) {
    const id = String(t.id);
    nodes.add(id);
    durations.set(id, Number(t.duration) || 0);
    if (!predecessors.has(id)) predecessors.set(id, []);
    if (!successors.has(id)) successors.set(id, []);
  }

  for (const t of tasks || []) {
    const tid = String(t.id);
    for (const dep of t.dependencies || []) {
      const did = String(dep);
      if (!nodes.has(did)) continue; // skip dangling refs (deleted task, cross-project, etc.)
      if (did === tid) continue; // skip self-loop defensively
      predecessors.get(tid).push(did);
      successors.get(did).push(tid);
    }
  }

  return { nodes, durations, predecessors, successors };
}

function topologicalSort(graph) {
  const { nodes, predecessors, successors } = graph;
  const indeg = new Map();
  for (const id of nodes) indeg.set(id, predecessors.get(id).length);

  const queue = [];
  for (const id of nodes) {
    if (indeg.get(id) === 0) queue.push(id);
  }

  const out = [];
  while (queue.length) {
    const n = queue.shift();
    out.push(n);
    for (const s of successors.get(n) || []) {
      indeg.set(s, indeg.get(s) - 1);
      if (indeg.get(s) === 0) queue.push(s);
    }
  }

  if (out.length !== nodes.size) {
    throw new Error('Cycle detected in dependency graph');
  }
  return out;
}

// Durations carry decimals, so every sum is rounded: otherwise 0.1 + 0.2 never equals 0.3
// and slack comes out as 1e-17 instead of 0.
function roundTime(value) {
  return Math.round(value * 1e6) / 1e6;
}

function forwardPass(graph) {
  const order = topologicalSort(graph);
  const ES = new Map();
  const EF = new Map();
  for (const id of order) {
    const preds = graph.predecessors.get(id);
    const es = preds.length === 0 ? 0 : Math.max(...preds.map((p) => EF.get(p)));
    ES.set(id, es);
    EF.set(id, roundTime(es + graph.durations.get(id)));
  }
  return { ES, EF, order };
}

function backwardPass(graph, projectDuration, forwardOrder) {
  const order = (forwardOrder || topologicalSort(graph)).slice().reverse();
  const LS = new Map();
  const LF = new Map();
  for (const id of order) {
    const succs = graph.successors.get(id);
    const lf = succs.length === 0 ? projectDuration : Math.min(...succs.map((s) => LS.get(s)));
    LF.set(id, lf);
    LS.set(id, roundTime(lf - graph.durations.get(id)));
  }
  return { LS, LF };
}

function computeSlacks(graph, forward, backward) {
  const { ES, EF } = forward;
  const { LS, LF } = backward;
  const result = new Map();
  for (const id of graph.nodes) {
    const totalSlack = roundTime(LS.get(id) - ES.get(id));
    const succs = graph.successors.get(id);
    let freeSlack;
    if (succs.length === 0) {
      // For terminal tasks, free slack equals total slack: anything pushed
      // beyond ES still has to fit before the project ends.
      freeSlack = totalSlack;
    } else {
      freeSlack = roundTime(Math.min(...succs.map((s) => ES.get(s) - EF.get(id))));
    }
    result.set(id, {
      ES: ES.get(id),
      EF: EF.get(id),
      LS: LS.get(id),
      LF: LF.get(id),
      totalSlack,
      freeSlack: Math.max(0, freeSlack),
      isCritical: totalSlack === 0,
    });
  }
  return result;
}

// Two critical tasks can be linked without the first one driving the second
// (EF < ES), so a real critical path only follows edges where EF === ES.
function isCriticalEdge(slacks, fromId, toId) {
  const from = slacks.get(fromId);
  const to = slacks.get(toId);
  return !!from?.isCritical && !!to?.isCritical && from.EF === to.ES;
}

function findCriticalPath(graph, slacks) {
  // Walk from a critical task with no critical predecessor.
  // Tie-break: among critical successors, pick the one with greatest EF
  // (the one driving the chain). For well-formed graphs this gives the canonical path.
  const isCritical = (id) => slacks.get(id)?.isCritical;

  const roots = [];
  for (const id of graph.nodes) {
    if (!isCritical(id)) continue;
    const preds = graph.predecessors.get(id) || [];
    if (preds.every((p) => !isCriticalEdge(slacks, p, id))) roots.push(id);
  }
  if (roots.length === 0) return [];

  // Pick the root whose forward chain is longest (deterministic).
  let best = [];
  for (const root of roots) {
    const path = [root];
    let current = root;
    const seen = new Set([current]);
    while (true) {
      const succs = (graph.successors.get(current) || []).filter((s) => isCriticalEdge(slacks, current, s));
      if (succs.length === 0) break;
      // Among critical successors, prefer one whose EF is largest (deepest chain).
      let next = succs[0];
      for (const s of succs) {
        if (slacks.get(s).EF > slacks.get(next).EF) next = s;
      }
      if (seen.has(next)) break; // cycle safeguard (shouldn't happen with critical slack)
      path.push(next);
      seen.add(next);
      current = next;
    }
    if (path.length > best.length) best = path;
  }
  return best;
}

function computeSchedule(tasks) {
  const graph = buildGraph(tasks);
  if (graph.nodes.size === 0) {
    return { projectDuration: 0, criticalPath: [], criticalSet: new Set(), slacks: new Map() };
  }
  const forward = forwardPass(graph);
  const projectDuration = forward.EF.size === 0
    ? 0
    : Math.max(...forward.EF.values());
  const backward = backwardPass(graph, projectDuration, forward.order);
  const slacks = computeSlacks(graph, forward, backward);
  const criticalPath = findCriticalPath(graph, slacks);
  const criticalSet = new Set();
  for (const [id, s] of slacks.entries()) {
    if (s.isCritical) criticalSet.add(id);
  }
  return { projectDuration, criticalPath, criticalSet, slacks };
}

/*
  Resource loading curve — sums peopleRequired of all tasks active at each
  whole time step in [0, projectDuration] and at every task start and end.
  Pure function over scheduleTasks (the array returned by the schedule
  endpoint or computed locally). Each point holds until the next one.

  Input:
    scheduleTasks: [{ id, ES, duration, peopleRequired }]
    projectDuration: Number
  Output:
    { peak, points: [{ t, demand }] }
*/
function computeResourceCurve(scheduleTasks, projectDuration) {
  const points = [];
  const D = Math.max(0, Math.ceil(Number(projectDuration) || 0));
  if (!Array.isArray(scheduleTasks) || scheduleTasks.length === 0 || D === 0) {
    return { peak: 0, points: [{ t: 0, demand: 0 }] };
  }

  // Demand only changes when a task starts or ends, so sample those moments as well as
  // every whole step. Whole steps alone miss tasks such as one running from 0.2 to 0.7.
  const active = scheduleTasks
    .map((task) => {
      const start = Number(task.ES) || 0;
      return { start, end: roundTime(start + (Number(task.duration) || 0)), people: Number(task.peopleRequired) || 0 };
    })
    .filter((task) => task.end > task.start);
  const times = new Set();
  for (let t = 0; t <= D; t += 1) times.add(t);
  for (const task of active) {
    times.add(task.start);
    times.add(task.end);
  }

  let peak = 0;
  for (const t of [...times].sort((a, b) => a - b)) {
    let demand = 0;
    // Task active during half-open interval [start, end).
    for (const task of active) {
      if (t >= task.start && t < task.end) demand += task.people;
    }
    if (demand > peak) peak = demand;
    points.push({ t, demand });
  }

  return { peak, points };
}

module.exports = {
  roundTime,
  isCriticalEdge,
  buildGraph,
  topologicalSort,
  forwardPass,
  backwardPass,
  computeSlacks,
  findCriticalPath,
  computeSchedule,
  computeResourceCurve,
};
