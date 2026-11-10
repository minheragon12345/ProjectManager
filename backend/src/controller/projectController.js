const express = require('express');
const mongoose = require('mongoose');
const Project = require('../models/projectModel');
const Note = require('../models/noteModel');
const User = require('../models/userModel');
const TimeEntry = require('../models/timeEntryModel');
const AuditLog = require('../models/auditLogModel');
const auth = require('../middleware/authMiddleware');
const { writeAudit } = require('../utils/audit');
const { escapeRegex } = require('../utils/regex');
const { getProjectRole } = require('../utils/access');
const { computeSchedule, computeResourceCurve } = require('../services/scheduler');
const { serialSchedule } = require('../services/serialScheduler');
const { computeCrashingTable } = require('../services/crashing');

const router = express.Router();
const MEMBER_ROLES = Project.MEMBER_ROLES || ['owner', 'moderator', 'editor', 'reviewer', 'viewer'];
const ASSIGNABLE_MEMBER_ROLES = Project.ASSIGNABLE_MEMBER_ROLES || ['moderator', 'editor', 'reviewer', 'viewer'];
const PROJECT_STATUSES = Project.PROJECT_STATUSES || ['active', 'archived'];
const BUDGET_TYPES = Project.BUDGET_TYPES || ['fixed', 'hourly'];
const TIME_UNITS = Project.TIME_UNITS || ['hour', 'day', 'week', 'month'];

router.use(auth);

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

function ownerIdOf(project) {
  return String(project?.owner?._id || project?.owner || '');
}

function getMemberRole(project, userId) {
  return getProjectRole(project, userId);
}

function canRead(project, userId) {
  return !!getMemberRole(project, userId);
}

function canWrite(project, userId) {
  const role = getMemberRole(project, userId);
  return role === 'owner' || role === 'moderator' || role === 'editor';
}

function canManageProject(project, userId) {
  const role = getMemberRole(project, userId);
  return role === 'owner' || role === 'moderator';
}

function canViewLog(project, userId) {
  const role = getMemberRole(project, userId);
  return role === 'owner' || role === 'moderator';
}

function canManageMembers(project, userId) {
  const role = getMemberRole(project, userId);
  return role === 'owner' || role === 'moderator';
}

function isSubordinateRole(role) {
  return role === 'editor' || role === 'reviewer' || role === 'viewer';
}

function canManageMemberAt(project, requesterId, currentRole, newRole) {
  const role = getMemberRole(project, requesterId);
  if (role === 'owner') return true;
  if (role === 'moderator') {
    if (currentRole !== undefined && currentRole !== null && !isSubordinateRole(currentRole)) return false;
    if (newRole !== undefined && newRole !== null && !isSubordinateRole(newRole)) return false;
    return true;
  }
  return false;
}

function parseDate(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { error: 'date must be valid' };
  return d;
}

function parseBudget(budget) {
  if (budget === undefined) return undefined;
  if (budget === null) return { amount: 0, currency: 'USD', type: 'hourly' };
  if (typeof budget !== 'object') return { error: 'budget must be an object' };

  const out = {};
  if (budget.amount !== undefined) {
    const n = Number(budget.amount);
    if (!Number.isFinite(n) || n < 0) return { error: 'budget.amount must be >= 0' };
    out.amount = n;
  }
  if (budget.currency !== undefined) {
    out.currency = String(budget.currency).trim().toUpperCase().slice(0, 8) || 'USD';
  }
  if (budget.type !== undefined) {
    const t = String(budget.type).trim().toLowerCase();
    if (!BUDGET_TYPES.includes(t)) return { error: `budget.type must be one of ${BUDGET_TYPES.join(', ')}` };
    out.type = t;
  }
  return out;
}

function parseTimeUnit(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return 'day';
  const v = String(value).trim().toLowerCase();
  if (!TIME_UNITS.includes(v)) {
    return { error: `timeUnit must be one of ${TIME_UNITS.join(', ')}` };
  }
  return v;
}

function parseNullablePositiveNumber(value, label, { minValue = 1, allowZero = false } = {}) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return { error: `${label} must be a number` };
  const floor = allowZero ? 0 : minValue;
  if (n < floor) return { error: `${label} must be >= ${floor}` };
  return n;
}

// Accepts { "12": 3, "13": 6, ... } | null | "" → returns a plain object,
// null (unset), or an { error } shape.
function parseLostRevenueByDuration(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'lostRevenueByDuration must be an object keyed by duration' };
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const kn = Number(k);
    if (!Number.isFinite(kn) || kn < 0) {
      return { error: `lostRevenueByDuration: invalid duration key "${k}"` };
    }
    const vn = Number(v);
    if (!Number.isFinite(vn) || vn < 0) {
      return { error: `lostRevenueByDuration: value for ${k} must be >= 0` };
    }
    out[String(kn)] = vn;
  }
  if (Object.keys(out).length === 0) return null;
  return out;
}

// Convert Mongoose Map | plain object | null → plain object (or null when empty).
function mapToPlain(value) {
  if (value == null) return null;
  if (typeof value.toJSON === 'function') {
    const obj = value.toJSON();
    return obj && Object.keys(obj).length ? obj : null;
  }
  if (value instanceof Map) {
    if (value.size === 0) return null;
    const out = {};
    for (const [k, v] of value.entries()) out[String(k)] = v;
    return out;
  }
  if (typeof value === 'object') {
    return Object.keys(value).length ? value : null;
  }
  return null;
}

function toUserDto(u) {
  if (!u) return null;
  if (typeof u === 'string') return { id: u };
  return { id: String(u._id || ''), username: u.username, email: u.email };
}

function mapProjectForList(p, reqUserId) {
  const uid = String(reqUserId);
  const ownerId = String(p?.owner?._id || p?.owner || '');
  const role = ownerId === uid
    ? 'owner'
    : (p?.members || []).find((m) => String(m?.user?._id || m?.user) === uid)?.role || null;

  return {
    id: String(p._id),
    name: p.name,
    description: p.description,
    status: p.status,
    startDate: p.startDate,
    endDate: p.endDate,
    budget: p.budget,
    timeUnit: p.timeUnit || 'day',
    maxHeadcount: p.maxHeadcount ?? null,
    lostRevenuePerUnit: p.lostRevenuePerUnit ?? null,
    lostRevenueByDuration: mapToPlain(p.lostRevenueByDuration),
    isPersonal: p.isPersonal,
    owner: toUserDto(p.owner),
    memberCount: (p.members?.length || 0) + 1,
    role,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

router.post('/', async (req, res) => {
  const { name, description, startDate, endDate, budget, timeUnit, maxHeadcount, lostRevenuePerUnit, lostRevenueByDuration } = req.body;

  try {
    if (!name || !String(name).trim()) {
      return res.status(400).json({ message: 'name is required' });
    }

    const parsedStart = parseDate(startDate);
    if (parsedStart && parsedStart.error) {
      return res.status(400).json({ message: `startDate: ${parsedStart.error}` });
    }
    const parsedEnd = parseDate(endDate);
    if (parsedEnd && parsedEnd.error) {
      return res.status(400).json({ message: `endDate: ${parsedEnd.error}` });
    }

    const parsedBudget = parseBudget(budget);
    if (parsedBudget && parsedBudget.error) {
      return res.status(400).json({ message: parsedBudget.error });
    }

    const parsedTimeUnit = parseTimeUnit(timeUnit);
    if (parsedTimeUnit && typeof parsedTimeUnit === 'object' && parsedTimeUnit.error) {
      return res.status(400).json({ message: parsedTimeUnit.error });
    }
    const parsedHeadcount = parseNullablePositiveNumber(maxHeadcount, 'maxHeadcount');
    if (parsedHeadcount && typeof parsedHeadcount === 'object' && parsedHeadcount.error) {
      return res.status(400).json({ message: parsedHeadcount.error });
    }
    const parsedRevenue = parseNullablePositiveNumber(lostRevenuePerUnit, 'lostRevenuePerUnit', { minValue: 0, allowZero: true });
    if (parsedRevenue && typeof parsedRevenue === 'object' && parsedRevenue.error) {
      return res.status(400).json({ message: parsedRevenue.error });
    }
    const parsedRevTable = parseLostRevenueByDuration(lostRevenueByDuration);
    if (parsedRevTable && typeof parsedRevTable === 'object' && parsedRevTable.error) {
      return res.status(400).json({ message: parsedRevTable.error });
    }

    const project = await Project.create({
      name: String(name).trim(),
      description: description ? String(description).trim() : '',
      owner: req.userId,
      members: [],
      status: 'active',
      startDate: parsedStart === undefined ? null : parsedStart,
      endDate: parsedEnd === undefined ? null : parsedEnd,
      budget: parsedBudget || { amount: 0, currency: 'USD', type: 'hourly' },
      timeUnit: parsedTimeUnit === undefined ? 'day' : parsedTimeUnit,
      maxHeadcount: parsedHeadcount === undefined ? null : parsedHeadcount,
      lostRevenuePerUnit: parsedRevenue === undefined ? null : parsedRevenue,
      lostRevenueByDuration: parsedRevTable === undefined ? null : parsedRevTable,
      isPersonal: false,
      isDeleted: false,
    });

    await writeAudit(req, {
      action: 'PROJECT_CREATE',
      targetType: 'PROJECT',
      targetId: String(project._id),
      metadata: { name: project.name },
    });

    return res.status(201).json({ message: 'Project created', project });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/', async (req, res) => {
  const { status, search, scope } = req.query;

  try {
    const uid = String(req.userId);
    const membershipOr =
      scope === 'mine'
        ? [{ owner: uid }]
        : scope === 'shared'
          ? [{ 'members.user': uid }]
          : [{ owner: uid }, { 'members.user': uid }];

    const and = [{ isDeleted: false }, { $or: membershipOr }];

    if (status) {
      const s = String(status).trim().toLowerCase();
      if (!PROJECT_STATUSES.includes(s)) {
        return res.status(400).json({ message: `Invalid status. Allowed: ${PROJECT_STATUSES.join(', ')}` });
      }
      and.push({ status: s });
    }

    if (search && String(search).trim()) {
      const keyword = escapeRegex(String(search).trim());
      and.push({
        $or: [
          { name: { $regex: keyword, $options: 'i' } },
          { description: { $regex: keyword, $options: 'i' } },
        ],
      });
    }

    const projects = await Project.find({ $and: and })
      .populate('owner', 'username email')
      .sort({ updatedAt: -1 })
      .lean();

    const mapped = projects.map((p) => mapProjectForList(p, uid));

    return res.json({ total: mapped.length, projects: mapped });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid project id' });

    const project = await Project.findOne({ _id: id, isDeleted: false })
      .populate('owner', 'username email')
      .populate('members.user', 'username email')
      .lean();

    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (!canRead(project, req.userId)) return res.status(403).json({ message: 'Forbidden' });

    const role = getMemberRole(project, req.userId);
    const members = (project.members || []).map((m) => ({
      user: toUserDto(m.user),
      role: m.role,
      addedAt: m.addedAt,
    }));

    return res.json({
      project: {
        id: String(project._id),
        name: project.name,
        description: project.description,
        status: project.status,
        startDate: project.startDate,
        endDate: project.endDate,
        budget: project.budget,
        timeUnit: project.timeUnit || 'day',
        maxHeadcount: project.maxHeadcount ?? null,
        lostRevenuePerUnit: project.lostRevenuePerUnit ?? null,
        lostRevenueByDuration: mapToPlain(project.lostRevenueByDuration),
        isPersonal: project.isPersonal,
        owner: toUserDto(project.owner),
        members,
        role,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      },
    });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { name, description, status, startDate, endDate, budget, timeUnit, maxHeadcount, lostRevenuePerUnit, lostRevenueByDuration } = req.body;

  try {
    if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid project id' });

    const project = await Project.findOne({ _id: id, isDeleted: false });
    if (!project) return res.status(404).json({ message: 'Project not found' });

    if (!canManageProject(project, req.userId)) {
      return res.status(403).json({ message: 'Only the project owner or moderators can edit this project.' });
    }

    if (name !== undefined) {
      if (!String(name).trim()) return res.status(400).json({ message: 'name cannot be empty' });
      project.name = String(name).trim();
    }
    if (description !== undefined) {
      project.description = description ? String(description).trim() : '';
    }
    if (status !== undefined) {
      const s = String(status).trim().toLowerCase();
      if (!PROJECT_STATUSES.includes(s)) {
        return res.status(400).json({ message: `Invalid status. Allowed: ${PROJECT_STATUSES.join(', ')}` });
      }
      project.status = s;
    }
    if (startDate !== undefined) {
      const parsed = parseDate(startDate);
      if (parsed && parsed.error) return res.status(400).json({ message: `startDate: ${parsed.error}` });
      project.startDate = parsed;
    }
    if (endDate !== undefined) {
      const parsed = parseDate(endDate);
      if (parsed && parsed.error) return res.status(400).json({ message: `endDate: ${parsed.error}` });
      project.endDate = parsed;
    }
    if (budget !== undefined) {
      const parsed = parseBudget(budget);
      if (parsed && parsed.error) return res.status(400).json({ message: parsed.error });
      project.budget = { ...(project.budget?.toObject?.() || project.budget || {}), ...(parsed || {}) };
    }
    if (timeUnit !== undefined) {
      const parsed = parseTimeUnit(timeUnit);
      if (parsed && typeof parsed === 'object' && parsed.error) {
        return res.status(400).json({ message: parsed.error });
      }
      project.timeUnit = parsed;
    }
    if (maxHeadcount !== undefined) {
      const parsed = parseNullablePositiveNumber(maxHeadcount, 'maxHeadcount');
      if (parsed && typeof parsed === 'object' && parsed.error) {
        return res.status(400).json({ message: parsed.error });
      }
      project.maxHeadcount = parsed;
    }
    if (lostRevenuePerUnit !== undefined) {
      const parsed = parseNullablePositiveNumber(lostRevenuePerUnit, 'lostRevenuePerUnit', { minValue: 0, allowZero: true });
      if (parsed && typeof parsed === 'object' && parsed.error) {
        return res.status(400).json({ message: parsed.error });
      }
      project.lostRevenuePerUnit = parsed;
    }
    if (lostRevenueByDuration !== undefined) {
      const parsed = parseLostRevenueByDuration(lostRevenueByDuration);
      if (parsed && typeof parsed === 'object' && parsed.error) {
        return res.status(400).json({ message: parsed.error });
      }
      // Setting null clears the Map; setting an object replaces it.
      project.lostRevenueByDuration = parsed;
    }

    await project.save();

    await writeAudit(req, {
      action: 'PROJECT_EDIT',
      targetType: 'PROJECT',
      targetId: String(project._id),
      metadata: { editorRole: getMemberRole(project, req.userId) },
    });

    return res.json({ message: 'Project updated', project });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.patch('/:id/archive', async (req, res) => {
  const { id } = req.params;

  try {
    if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid project id' });

    const project = await Project.findOne({ _id: id, isDeleted: false });
    if (!project) return res.status(404).json({ message: 'Project not found' });

    if (ownerIdOf(project) !== String(req.userId)) {
      return res.status(403).json({ message: 'Only the project owner can archive it.' });
    }

    project.status = project.status === 'archived' ? 'active' : 'archived';
    await project.save();

    await writeAudit(req, {
      action: project.status === 'archived' ? 'PROJECT_ARCHIVE' : 'PROJECT_UNARCHIVE',
      targetType: 'PROJECT',
      targetId: String(project._id),
      metadata: {},
    });

    return res.json({ message: 'Project status toggled', project });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid project id' });

    const project = await Project.findOne({ _id: id, isDeleted: false });
    if (!project) return res.status(404).json({ message: 'Project not found' });

    if (ownerIdOf(project) !== String(req.userId)) {
      return res.status(403).json({ message: 'Only the project owner can delete it.' });
    }

    if (project.isPersonal) {
      return res.status(400).json({ message: 'Personal projects cannot be deleted.' });
    }

    project.isDeleted = true;
    project.deletedAt = new Date();
    await project.save();

    await writeAudit(req, {
      action: 'PROJECT_DELETE',
      targetType: 'PROJECT',
      targetId: String(project._id),
      metadata: {},
    });

    return res.json({ message: 'Project deleted' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:id/members', async (req, res) => {
  const { id } = req.params;

  try {
    if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid project id' });

    const project = await Project.findOne({ _id: id, isDeleted: false })
      .populate('owner', 'username email')
      .populate('members.user', 'username email');

    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (!canRead(project, req.userId)) return res.status(403).json({ message: 'Forbidden' });

    const members = (project.members || []).map((m) => ({
      user: m.user ? { id: String(m.user._id), username: m.user.username, email: m.user.email } : { id: String(m.user) },
      role: m.role,
      addedAt: m.addedAt,
    }));

    return res.json({
      owner: toUserDto(project.owner),
      total: members.length,
      members,
    });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.post('/:id/members', async (req, res) => {
  const { id } = req.params;
  const { email, role } = req.body;

  try {
    if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid project id' });
    if (!email || !String(email).trim()) return res.status(400).json({ message: 'email is required' });

    const r = String(role || 'viewer').trim().toLowerCase();
    if (!ASSIGNABLE_MEMBER_ROLES.includes(r)) {
      return res.status(400).json({ message: `Invalid role. Allowed: ${ASSIGNABLE_MEMBER_ROLES.join(', ')}` });
    }

    const project = await Project.findOne({ _id: id, isDeleted: false });
    if (!project) return res.status(404).json({ message: 'Project not found' });

    if (!canManageMembers(project, req.userId)) {
      return res.status(403).json({ message: 'You do not have permission to add members.' });
    }
    if (!canManageMemberAt(project, req.userId, undefined, r)) {
      return res.status(403).json({ message: 'Moderators can only assign editor, reviewer or viewer roles.' });
    }

    const targetEmail = String(email).trim().toLowerCase();
    const target = await User.findOne({ email: targetEmail }).select('_id username email');
    if (!target) return res.status(404).json({ message: 'No user found with this email.' });

    if (String(target._id) === ownerIdOf(project)) {
      return res.status(400).json({ message: 'The project owner already has full permissions.' });
    }

    project.members = Array.isArray(project.members) ? project.members : [];
    const existing = project.members.find((m) => String(m.user) === String(target._id));
    let action = 'PROJECT_MEMBER_ADD';

    if (existing) {
      if (!canManageMemberAt(project, req.userId, existing.role, r)) {
        return res.status(403).json({ message: 'Moderators cannot change moderator/owner roles.' });
      }
      existing.role = r;
      action = 'PROJECT_MEMBER_UPDATE';
    } else {
      project.members.push({
        user: target._id,
        role: r,
        addedAt: new Date(),
        addedBy: req.userId,
      });
    }

    await project.save();

    await writeAudit(req, {
      action,
      targetType: 'PROJECT',
      targetId: String(project._id),
      metadata: { memberUserId: String(target._id), role: r, email: targetEmail },
    });

    return res.json({ message: 'Member updated' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.patch('/:id/members/:memberUserId', async (req, res) => {
  const { id, memberUserId } = req.params;
  const { role } = req.body;

  try {
    if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid project id' });
    if (!isValidObjectId(memberUserId)) return res.status(400).json({ message: 'Invalid user id' });

    const r = String(role || 'viewer').trim().toLowerCase();
    if (!ASSIGNABLE_MEMBER_ROLES.includes(r)) {
      return res.status(400).json({ message: `Invalid role. Allowed: ${ASSIGNABLE_MEMBER_ROLES.join(', ')}` });
    }

    const project = await Project.findOne({ _id: id, isDeleted: false });
    if (!project) return res.status(404).json({ message: 'Project not found' });

    if (!canManageMembers(project, req.userId)) {
      return res.status(403).json({ message: 'You do not have permission to change member roles.' });
    }

    const entry = (project.members || []).find((m) => String(m.user) === String(memberUserId));
    if (!entry) return res.status(404).json({ message: 'Member not found' });

    if (!canManageMemberAt(project, req.userId, entry.role, r)) {
      return res.status(403).json({ message: 'Moderators cannot promote/demote moderator-or-above ranks.' });
    }

    entry.role = r;
    await project.save();

    await writeAudit(req, {
      action: 'PROJECT_MEMBER_UPDATE',
      targetType: 'PROJECT',
      targetId: String(project._id),
      metadata: { memberUserId: String(memberUserId), role: r },
    });

    return res.json({ message: 'Member role updated' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/:id/members/:memberUserId', async (req, res) => {
  const { id, memberUserId } = req.params;

  try {
    if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid project id' });
    if (!isValidObjectId(memberUserId)) return res.status(400).json({ message: 'Invalid user id' });

    const project = await Project.findOne({ _id: id, isDeleted: false });
    if (!project) return res.status(404).json({ message: 'Project not found' });

    const isSelf = String(memberUserId) === String(req.userId);
    if (!isSelf) {
      if (!canManageMembers(project, req.userId)) {
        return res.status(403).json({ message: 'You do not have permission to remove members.' });
      }
      const target = (project.members || []).find((m) => String(m.user) === String(memberUserId));
      if (!canManageMemberAt(project, req.userId, target?.role, undefined)) {
        return res.status(403).json({ message: 'Moderators cannot remove moderator-or-above members.' });
      }
    }

    const before = project.members?.length || 0;
    project.members = (project.members || []).filter((m) => String(m.user) !== String(memberUserId));
    if ((project.members?.length || 0) === before) {
      return res.status(404).json({ message: 'Member not found' });
    }

    await project.save();

    const unassigned = await Note.updateMany(
      { project: project._id, assignees: memberUserId },
      { $pull: { assignees: memberUserId } },
    );

    await writeAudit(req, {
      action: 'PROJECT_MEMBER_REMOVE',
      targetType: 'PROJECT',
      targetId: String(project._id),
      metadata: { memberUserId: String(memberUserId), unassignedTasks: unassigned.modifiedCount || 0 },
    });

    return res.json({ message: 'Member removed' });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// GET /:id/budget-summary, planned vs actual cost + hour totals.
router.get('/:id/budget-summary', async (req, res) => {
  const { id } = req.params;

  try {
    if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid project id' });

    const project = await Project.findOne({ _id: id, isDeleted: false })
      .populate('owner', 'username email billingRate billingCurrency')
      .populate('members.user', 'username email billingRate billingCurrency')
      .lean();

    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (!canRead(project, req.userId)) return res.status(403).json({ message: 'Forbidden' });

    // Map userId -> billingRate (snapshot of "today's" rate per the plan).
    const rateMap = new Map();
    const currencyMap = new Map();
    if (project.owner) {
      rateMap.set(String(project.owner._id), Number(project.owner.billingRate) || 0);
      currencyMap.set(String(project.owner._id), project.owner.billingCurrency || 'USD');
    }
    for (const m of project.members || []) {
      if (m.user?._id) {
        rateMap.set(String(m.user._id), Number(m.user.billingRate) || 0);
        currencyMap.set(String(m.user._id), m.user.billingCurrency || 'USD');
      }
    }

    // Sum hours per contributing user from non-deleted time entries on this project.
    const rows = await TimeEntry.aggregate([
      { $match: { project: new mongoose.Types.ObjectId(String(id)), isDeleted: false } },
      {
        $group: {
          _id: '$user',
          hours: { $sum: '$hours' },
          billableHours: { $sum: { $cond: ['$billable', '$hours', 0] } },
          entries: { $sum: 1 },
        },
      },
    ]);

    // For users not yet in the rate map (e.g., contributors removed from project), look them up.
    const missingIds = rows
      .map((r) => String(r._id))
      .filter((uid) => !rateMap.has(uid));
    if (missingIds.length > 0) {
      const extraUsers = await User.find({ _id: { $in: missingIds } })
        .select('_id username email billingRate billingCurrency')
        .lean();
      for (const u of extraUsers) {
        rateMap.set(String(u._id), Number(u.billingRate) || 0);
        currencyMap.set(String(u._id), u.billingCurrency || 'USD');
      }
    }

    // Resolve usernames for display.
    const userIds = rows.map((r) => String(r._id));
    const users = userIds.length > 0
      ? await User.find({ _id: { $in: userIds } }).select('_id username email billingRate billingCurrency').lean()
      : [];
    const userMap = new Map(users.map((u) => [String(u._id), u]));

    let totalHours = 0;
    let billableHours = 0;
    let totalCost = 0;
    let billableCost = 0;
    const projectCurrency = project.budget?.currency || 'USD';

    const byUser = rows.map((r) => {
      const uid = String(r._id);
      const rate = rateMap.get(uid) || 0;
      const u = userMap.get(uid);
      const cost = (r.hours || 0) * rate;
      const billable = (r.billableHours || 0) * rate;
      totalHours += r.hours || 0;
      billableHours += r.billableHours || 0;
      totalCost += cost;
      billableCost += billable;
      return {
        user: u
          ? { id: uid, username: u.username, email: u.email }
          : { id: uid },
        hours: Math.round((r.hours || 0) * 100) / 100,
        billableHours: Math.round((r.billableHours || 0) * 100) / 100,
        billingRate: rate,
        billingCurrency: currencyMap.get(uid) || 'USD',
        cost: Math.round(cost * 100) / 100,
        billableCost: Math.round(billable * 100) / 100,
        entries: r.entries,
      };
    });

    byUser.sort((a, b) => b.cost - a.cost);

    const planned = {
      amount: Number(project.budget?.amount) || 0,
      currency: projectCurrency,
      type: project.budget?.type || 'hourly',
    };

    const actual = {
      hours: Math.round(totalHours * 100) / 100,
      billableHours: Math.round(billableHours * 100) / 100,
      cost: Math.round(totalCost * 100) / 100,
      billableCost: Math.round(billableCost * 100) / 100,
    };

    const remaining = planned.amount > 0
      ? Math.round((planned.amount - actual.cost) * 100) / 100
      : null;
    const usedPercent = planned.amount > 0
      ? Math.round((actual.cost / planned.amount) * 1000) / 10
      : null;

    return res.json({
      planned,
      actual,
      remaining,
      usedPercent,
      byUser,
      currencyWarning: byUser.some((u) => u.billingCurrency !== projectCurrency),
    });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

router.get('/:id/audit-log', async (req, res) => {
  const { id } = req.params;
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  try {
    if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid project id' });

    const project = await Project.findOne({ _id: id, isDeleted: false }).lean();
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (!canViewLog(project, req.userId)) {
      return res.status(403).json({ message: 'Only the project owner or moderators can view the log.' });
    }

    const noteIds = await Note.find({ project: id }).distinct('_id');
    const noteIdStrings = noteIds.map(String);

    const logs = await AuditLog.find({
      $or: [
        { targetType: 'PROJECT', targetId: String(id) },
        { targetType: 'NOTE', targetId: { $in: noteIdStrings } },
      ],
    })
      .populate('actor', 'username email')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const items = logs.map((l) => ({
      id: String(l._id),
      action: l.action,
      targetType: l.targetType,
      targetId: l.targetId ? String(l.targetId) : null,
      actor: l.actor
        ? { id: String(l.actor._id || l.actor), username: l.actor.username, email: l.actor.email }
        : null,
      actorRole: l.actorRole,
      metadata: l.metadata || {},
      createdAt: l.createdAt,
    }));

    return res.json({ total: items.length, items });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// CPM schedule: forward/backward pass over the project's dependency graph.
// Returns earliest/latest dates, slacks, and the critical path.
// Query: ?constrained=true → re-runs the serial-method scheduler
//   under project.maxHeadcount and overrides ES/EF in the response.
router.get('/:id/schedule', async (req, res) => {
  const { id } = req.params;
  const constrained = String(req.query.constrained || '').toLowerCase() === 'true';

  try {
    if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid project id' });

    const project = await Project.findOne({ _id: id, isDeleted: false })
      .select('owner members isDeleted timeUnit maxHeadcount');
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (!canRead(project, req.userId)) return res.status(403).json({ message: 'Forbidden' });

    const tasksRaw = await Note.find({ project: id, isDeleted: false })
      .select('_id title duration dependencies status actualStart actualEnd peopleRequired')
      .lean();

    const tasksForScheduler = tasksRaw.map((t) => ({
      id: String(t._id),
      duration: Number(t.duration) || 0,
      dependencies: (t.dependencies || []).map((d) => String(d)),
    }));

    let schedule;
    try {
      schedule = computeSchedule(tasksForScheduler);
    } catch (err) {
      if (/cycle/i.test(err.message)) {
        return res.status(400).json({ message: 'Cycle detected in dependency graph' });
      }
      throw err;
    }

    // Constrained pass (optional). Reuses unconstrained ES/LS for tie-break.
    let serialResult = null;
    if (constrained) {
      if (project.maxHeadcount == null) {
        return res.status(400).json({ message: 'project.maxHeadcount is not set; cannot run constrained schedule' });
      }
      try {
        const enriched = tasksForScheduler.map((t) => {
          const s = schedule.slacks.get(String(t.id));
          const raw = tasksRaw.find((r) => String(r._id) === String(t.id));
          return {
            ...t,
            peopleRequired: Number(raw?.peopleRequired) || 1,
            ES: s?.ES ?? 0,
            LS: s?.LS ?? 0,
          };
        });
        serialResult = serialSchedule(enriched, Number(project.maxHeadcount));
      } catch (err) {
        return res.status(400).json({ message: err.message || 'Serial scheduler failed' });
      }
    }

    const serialById = serialResult
      ? new Map(serialResult.tasks.map((t) => [String(t.id), t]))
      : null;

    const tasks = tasksRaw.map((t) => {
      const sid = String(t._id);
      const s = schedule.slacks.get(sid);
      const serial = serialById?.get(sid);
      const ES = serial ? serial.ES : (s?.ES ?? 0);
      const EF = serial ? serial.EF : (s?.EF ?? 0);
      return {
        id: sid,
        title: t.title || '',
        duration: Number(t.duration) || 0,
        peopleRequired: Number(t.peopleRequired) || 1,
        dependencies: (t.dependencies || []).map((d) => String(d)),
        status: t.status,
        actualStart: t.actualStart || null,
        actualEnd: t.actualEnd || null,
        ES,
        EF,
        LS: s?.LS ?? 0,
        LF: s?.LF ?? 0,
        totalSlack: s?.totalSlack ?? 0,
        freeSlack: s?.freeSlack ?? 0,
        isCritical: !!s?.isCritical,
      };
    });

    const constrainedDuration = serialResult?.projectDuration ?? schedule.projectDuration;

    return res.json({
      mode: serialResult ? 'constrained' : 'unlimited',
      projectDuration: constrainedDuration,
      unconstrainedDuration: schedule.projectDuration,
      delay: serialResult ? constrainedDuration - schedule.projectDuration : 0,
      maxHeadcount: project.maxHeadcount ?? null,
      timeUnit: project.timeUnit || 'day',
      criticalPath: schedule.criticalPath,
      tasks,
    });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// Resource loading curve: sums peopleRequired of active tasks at each time
// step. Uses the same CPM schedule produced above. Returns the curve plus a
// reference line (maxHeadcount if set, else members + owner).
router.get('/:id/resource-curve', async (req, res) => {
  const { id } = req.params;

  try {
    if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid project id' });

    const project = await Project.findOne({ _id: id, isDeleted: false })
      .select('owner members isDeleted timeUnit maxHeadcount');
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (!canRead(project, req.userId)) return res.status(403).json({ message: 'Forbidden' });

    const tasksRaw = await Note.find({ project: id, isDeleted: false })
      .select('_id duration dependencies peopleRequired')
      .lean();

    const tasksForScheduler = tasksRaw.map((t) => ({
      id: String(t._id),
      duration: Number(t.duration) || 0,
      dependencies: (t.dependencies || []).map((d) => String(d)),
    }));

    let schedule;
    try {
      schedule = computeSchedule(tasksForScheduler);
    } catch (err) {
      if (/cycle/i.test(err.message)) {
        return res.status(400).json({ message: 'Cycle detected in dependency graph' });
      }
      throw err;
    }

    const scheduleTasks = tasksRaw.map((t) => {
      const s = schedule.slacks.get(String(t._id));
      return {
        id: String(t._id),
        ES: s?.ES ?? 0,
        duration: Number(t.duration) || 0,
        peopleRequired: Number(t.peopleRequired) || 1,
      };
    });

    const { peak, points } = computeResourceCurve(scheduleTasks, schedule.projectDuration);

    // Reference line: explicit cap, else members + 1 owner.
    const reference = project.maxHeadcount != null
      ? Number(project.maxHeadcount)
      : (Array.isArray(project.members) ? project.members.length : 0) + 1;

    return res.json({
      peak,
      points,
      reference,
      timeUnit: project.timeUnit || 'day',
      projectDuration: schedule.projectDuration,
    });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

// Crashing analysis. Iteratively reduces critical-path tasks by 1 unit,
// lowest marginalCost first, recomputes the schedule each step. Reports the
// synthesis table with the totalCost-minimizing row flagged.
//
// Lost-revenue curve: prefers project.lostRevenueByDuration (Map<duration,
// revenue>) for non-linear lookup. Falls back to project.lostRevenuePerUnit
// * d (linear) otherwise. At least one of the two must be set.
router.get('/:id/crash-analysis', async (req, res) => {
  const { id } = req.params;

  try {
    if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid project id' });

    const project = await Project.findOne({ _id: id, isDeleted: false })
      .select('owner members isDeleted timeUnit lostRevenuePerUnit lostRevenueByDuration');
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (!canRead(project, req.userId)) return res.status(403).json({ message: 'Forbidden' });

    const lookup = mapToPlain(project.lostRevenueByDuration);
    const perUnit = project.lostRevenuePerUnit == null
      ? null
      : Number(project.lostRevenuePerUnit);
    if (perUnit != null && (!Number.isFinite(perUnit) || perUnit < 0)) {
      return res.status(400).json({ message: 'project.lostRevenuePerUnit must be >= 0' });
    }
    if (lookup == null && perUnit == null) {
      return res.status(400).json({
        message: 'Set project.lostRevenueByDuration (table) or project.lostRevenuePerUnit (linear) before running crashing analysis',
      });
    }

    // Build lostRev fn: lookup wins; linear used either as fallback or when
    // duration isn't in the lookup.
    const lostRevenueFn = (d) => {
      if (lookup) {
        const v = lookup[String(d)];
        if (v != null) return Number(v) || 0;
      }
      if (perUnit != null) return perUnit * d;
      return 0;
    };

    const tasksRaw = await Note.find({ project: id, isDeleted: false })
      .select('_id title duration dependencies minDuration marginalCost')
      .lean();

    const tasksForCrash = tasksRaw.map((t) => ({
      id: String(t._id),
      duration: Number(t.duration) || 0,
      minDuration: t.minDuration == null ? null : Number(t.minDuration),
      marginalCost: t.marginalCost == null ? null : Number(t.marginalCost),
      dependencies: (t.dependencies || []).map((d) => String(d)),
    }));

    let result;
    try {
      result = computeCrashingTable(tasksForCrash, lostRevenueFn);
    } catch (err) {
      if (/cycle/i.test(err.message)) {
        return res.status(400).json({ message: 'Cycle detected in dependency graph' });
      }
      throw err;
    }

    // Decorate steps with task titles for the frontend table.
    const titleById = new Map(tasksRaw.map((t) => [String(t._id), t.title || '']));
    const steps = result.steps.map((s) => ({
      from: s.from,
      to: s.to,
      cost: s.cost,
      tasks: s.taskIds.map((tid) => ({ id: tid, title: titleById.get(tid) || '' })),
    }));

    return res.json({
      timeUnit: project.timeUnit || 'day',
      lostRevenuePerUnit: perUnit,
      lostRevenueByDuration: lookup,
      lostRevenueMode: lookup ? 'table' : 'linear',
      rows: result.rows,
      optimalIndex: result.optimalIndex,
      steps,
    });
  } catch (err) {
    return res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
