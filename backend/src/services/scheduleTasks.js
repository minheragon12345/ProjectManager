// Turns task rows from the database into scheduler input. Pure function, no I/O.
//
// A parent task is a summary of its subtasks, so it becomes a zero-length finish point
// that waits for all of them, and each subtask also waits for whatever the parent waits for.
// Cancelled tasks keep their place in the dependency chain but take no time or people.

function buildScheduleTasks(rows) {
  const ids = new Set((rows || []).map((row) => String(row._id)));
  const byId = new Map((rows || []).map((row) => [String(row._id), row]));
  const childrenOf = new Map();
  for (const row of rows || []) {
    const parentId = row.parentTask ? String(row.parentTask) : null;
    if (!parentId || !ids.has(parentId)) continue;
    if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
    childrenOf.get(parentId).push(String(row._id));
  }

  return (rows || []).map((row) => {
    const id = String(row._id);
    const parentId = row.parentTask && ids.has(String(row.parentTask)) ? String(row.parentTask) : null;
    const children = childrenOf.get(id) || [];
    const isSummary = children.length > 0;
    const isIdle = isSummary || row.status === 'cancelled';
    const siblings = parentId ? childrenOf.get(parentId) : [];
    // Links from a parent to its own subtasks are already covered by the finish point.
    const inherited = parentId ? (byId.get(parentId).dependencies || []).filter((dep) => !siblings.includes(String(dep))) : [];
    const dependencies = new Set();
    for (const dep of [...(row.dependencies || []), ...inherited, ...children]) {
      const depId = String(dep);
      // A subtask waiting on its own parent would loop through the parent's finish point.
      if (depId === id || depId === parentId || !ids.has(depId)) continue;
      dependencies.add(depId);
    }
    return {
      id,
      duration: isIdle ? 0 : Number(row.duration) || 0,
      peopleRequired: isIdle ? 0 : Number(row.peopleRequired) || 1,
      minDuration: isIdle || row.minDuration == null ? null : Number(row.minDuration),
      marginalCost: isIdle || row.marginalCost == null ? null : Number(row.marginalCost),
      dependencies: [...dependencies],
      children,
      isSummary,
      isCancelled: row.status === 'cancelled',
    };
  });
}

// A summary bar starts with its earliest subtask and ends at its finish point.
function getSummaryStart(task, startById) {
  let start = startById.get(task.id) ?? 0;
  for (const childId of task.children) {
    const childStart = startById.get(childId);
    if (childStart != null && childStart < start) start = childStart;
  }
  return start;
}

module.exports = { buildScheduleTasks, getSummaryStart };
