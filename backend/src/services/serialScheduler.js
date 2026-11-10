// Serial-method resource-constrained scheduler. Pure functions, no I/O.
// Greedy: each step pick executable tasks sorted by (ES, LS, duration) and
// start as many as fit under maxHeadcount, then advance time to the next
// finishing event. Returns constrained schedule.

const { roundTime } = require('./scheduler');

function sortByPriority(executable) {
  // Priority rule: smallest ES, then smallest LS, then smallest duration.
  return executable.slice().sort((a, b) => {
    if (a.ES !== b.ES) return a.ES - b.ES;
    if (a.LS !== b.LS) return a.LS - b.LS;
    return a.duration - b.duration;
  });
}

function serialSchedule(tasks, maxHeadcount) {
  const cap = Number(maxHeadcount);
  if (!Number.isFinite(cap) || cap < 1) {
    throw new Error('maxHeadcount must be a positive number');
  }

  // Zero-length tasks (milestones, parent finish points, cancelled tasks) need nobody,
  // so they never wait for a free person.
  const getPeople = (t) => (Number(t.duration) > 0 ? Number(t.peopleRequired) || 1 : 0);

  // Sanity: any single task that exceeds the cap can never run.
  for (const t of tasks) {
    const r = getPeople(t);
    if (r > cap) {
      throw new Error(`Task ${t.id} needs ${r} people but headcount cap is ${cap}`);
    }
  }

  const byId = new Map(tasks.map((t) => [String(t.id), {
    id: String(t.id),
    duration: Number(t.duration) || 0,
    dependencies: (t.dependencies || []).map(String),
    peopleRequired: getPeople(t),
    ES_orig: Number(t.ES) || 0,
    LS_orig: Number(t.LS) || 0,
  }]));

  const pending = new Set(byId.keys());
  const completed = new Set();
  const running = []; // { id, endTime, peopleRequired }
  let remaining = cap;
  let now = 0;
  const result = new Map(); // id → { ES, EF }

  // Safety bound on iterations — prevents accidental infinite loop.
  const HARD_LIMIT = tasks.length * tasks.length + 1000;
  let iter = 0;

  while (pending.size > 0 || running.length > 0) {
    if (++iter > HARD_LIMIT) {
      throw new Error('Serial scheduler exceeded iteration limit (possible bug)');
    }

    // 1. Find executable tasks: pending + all deps completed.
    const executable = [];
    for (const id of pending) {
      const t = byId.get(id);
      const allDepsDone = t.dependencies.every((d) => completed.has(d) || !byId.has(d));
      if (allDepsDone) {
        executable.push({
          id,
          ES: t.ES_orig,
          LS: t.LS_orig,
          duration: t.duration,
          peopleRequired: t.peopleRequired,
        });
      }
    }

    // 2. Sort by priority rule.
    const ordered = sortByPriority(executable);

    // 3. Start as many as fit under the cap.
    let startedThisRound = 0;
    for (const cand of ordered) {
      if (cand.peopleRequired <= remaining) {
        // Start it: ES = now, EF = now + duration.
        const endTime = roundTime(now + cand.duration);
        result.set(cand.id, { ES: now, EF: endTime });
        running.push({
          id: cand.id,
          endTime,
          peopleRequired: cand.peopleRequired,
        });
        remaining -= cand.peopleRequired;
        pending.delete(cand.id);
        startedThisRound += 1;
      }
    }

    // 4. Advance time. If nothing running, we must have started something or the pending
    //    set has unmet dependencies (cycle / orphan). The latter is a malformed input.
    if (running.length === 0) {
      if (pending.size > 0) {
        // Pending tasks remain but none are executable and nothing's running.
        throw new Error('Serial scheduler stalled: pending tasks have unmet dependencies');
      }
      break;
    }

    // Next event is the smallest end-time among running.
    let nextTime = Infinity;
    for (const r of running) {
      if (r.endTime < nextTime) nextTime = r.endTime;
    }
    if (!Number.isFinite(nextTime)) break;

    // Tasks that started at `now` with duration 0 would loop forever. Guard:
    // ensure time strictly advances. If not, finish all zero-duration runners
    // and continue.
    if (nextTime <= now && startedThisRound === 0) {
      // No tasks started AND no time progress — break to avoid infinite loop.
      // (Should never happen because zero-duration tasks finish immediately.)
      throw new Error('Serial scheduler stalled: no time progress');
    }

    now = Math.max(now, nextTime);

    // 5. Sweep completions at `now`.
    const stillRunning = [];
    for (const r of running) {
      if (r.endTime <= now) {
        completed.add(r.id);
        remaining += r.peopleRequired;
      } else {
        stillRunning.push(r);
      }
    }
    running.length = 0;
    Array.prototype.push.apply(running, stillRunning);
  }

  // Compute project duration as max EF.
  let projectDuration = 0;
  for (const { EF } of result.values()) {
    if (EF > projectDuration) projectDuration = EF;
  }

  return {
    projectDuration,
    tasks: tasks.map((t) => {
      const r = result.get(String(t.id));
      return {
        id: String(t.id),
        ES: r?.ES ?? 0,
        EF: r?.EF ?? 0,
        peopleRequired: Number(t.peopleRequired) || 1,
      };
    }),
  };
}

module.exports = { serialSchedule, sortByPriority };
