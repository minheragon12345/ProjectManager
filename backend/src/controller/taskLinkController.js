const express = require('express');
const Note = require('../models/noteModel');
const auth = require('../middleware/authMiddleware');
const { writeAudit } = require('../utils/audit');
const { canReadTask, canWriteTask, canCommentTask } = require('../utils/access');
const { isValidObjectId, validateDependencies } = require('../utils/taskRules');
const { mapNoteForList, attachSubtaskStats, computeBlockedMap } = require('../utils/taskResponse');

// Comments, subtasks and dependency links of a task. Mounted next to noteController on /api/notes.
const router = express.Router();

router.use(auth);

router.get('/:id/comments', async (req, res) => {
  const { id } = req.params;

  if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid note id' });

  const note = await Note.findOne({ _id: id, isDeleted: false })
    .populate('comments.user', 'username email')
    .populate('project', 'name isPersonal owner members isDeleted status');

  if (!note) return res.status(404).json({ message: 'Note not found' });
  if (!canReadTask(note, req.userId)) return res.status(403).json({ message: 'Forbidden' });

  const comments = Array.isArray(note.comments) ? [...note.comments] : [];
  comments.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  return res.json({ total: comments.length, comments });
});

router.post('/:id/comments', async (req, res) => {
  const { id } = req.params;
  const { text } = req.body;

  if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid note id' });
  if (!text || !String(text).trim()) return res.status(400).json({ message: 'Comment text is required' });

  const note = await Note.findOne({ _id: id, isDeleted: false })
    .populate('project', 'name isPersonal owner members isDeleted status');

  if (!note) return res.status(404).json({ message: 'Note not found' });
  if (!canCommentTask(note, req.userId)) {
    return res.status(403).json({ message: 'You do not have permission to comment on this task.' });
  }

  note.comments = Array.isArray(note.comments) ? note.comments : [];
  note.comments.push({ user: req.userId, text: String(text).trim(), createdAt: new Date(), updatedAt: new Date() });

  await note.save();

  await writeAudit(req, {
    action: 'NOTE_COMMENT_ADD',
    targetType: 'NOTE',
    targetId: String(note._id),
    metadata: {
      by: String(req.userId),
      textSnippet: String(text).trim().slice(0, 120),
    },
  });

  return res.status(201).json({ message: 'Comment added' });
});

router.get('/:id/subtasks', async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid note id' });

  const parent = await Note.findOne({ _id: id, isDeleted: false })
    .populate('project', 'name isPersonal owner members isDeleted status');
  if (!parent) return res.status(404).json({ message: 'Note not found' });
  if (!canReadTask(parent, req.userId)) return res.status(403).json({ message: 'Forbidden' });

  const subs = await Note.find({ parentTask: id, isDeleted: false })
    .select('-comments')
    .populate('user', 'username email')
    .populate('project', 'name isPersonal owner members isDeleted status')
    .populate('assignees', 'username email')
    .sort({ updatedAt: -1 })
    .lean();

  const stats = await attachSubtaskStats(subs);
  const blockedMap = await computeBlockedMap(subs);

  const mapped = subs.map((n) =>
    mapNoteForList(n, req.userId, {
      subtaskStats: stats.get(String(n._id)) || { total: 0, done: 0 },
      isBlocked: blockedMap.get(String(n._id)) || false,
    }),
  );

  return res.json({ total: mapped.length, subtasks: mapped });
});

router.get('/:id/dependencies/blocked-by', async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid note id' });

  const note = await Note.findOne({ _id: id, isDeleted: false })
    .populate('project', 'name isPersonal owner members isDeleted status');
  if (!note) return res.status(404).json({ message: 'Note not found' });
  if (!canReadTask(note, req.userId)) return res.status(403).json({ message: 'Forbidden' });

  const deps = await Note.find({ _id: { $in: note.dependencies || [] }, isDeleted: false })
    .select('title content status progress deadline project')
    .lean();

  return res.json({
    total: deps.length,
    dependencies: deps.map((d) => ({
      id: String(d._id),
      title: d.title || '',
      content: d.content || '',
      status: d.status,
      progress: d.progress,
      deadline: d.deadline,
    })),
  });
});

router.get('/:id/dependencies/blocks', async (req, res) => {
  const { id } = req.params;
  if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid note id' });

  const note = await Note.findOne({ _id: id, isDeleted: false })
    .populate('project', 'name isPersonal owner members isDeleted status');
  if (!note) return res.status(404).json({ message: 'Note not found' });
  if (!canReadTask(note, req.userId)) return res.status(403).json({ message: 'Forbidden' });

  const blocks = await Note.find({ dependencies: id, isDeleted: false })
    .select('title content status progress deadline')
    .lean();

  return res.json({
    total: blocks.length,
    blocks: blocks.map((b) => ({
      id: String(b._id),
      title: b.title || '',
      content: b.content || '',
      status: b.status,
      progress: b.progress,
      deadline: b.deadline,
    })),
  });
});

router.put('/:id/dependencies', async (req, res) => {
  const { id } = req.params;
  const { dependencies } = req.body;
  if (!isValidObjectId(id)) return res.status(400).json({ message: 'Invalid note id' });
  if (!Array.isArray(dependencies)) {
    return res.status(400).json({ message: 'dependencies must be an array' });
  }

  const note = await Note.findOne({ _id: id, isDeleted: false })
    .populate('project', 'name isPersonal owner members isDeleted status');
  if (!note) return res.status(404).json({ message: 'Note not found' });
  if (!canWriteTask(note, req.userId)) {
    return res.status(403).json({ message: 'You do not have permission to edit this task.' });
  }

  const projectId = note.project ? String(note.project._id || note.project) : null;
  const result = await validateDependencies(note._id, projectId, dependencies);
  if (result.error) return res.status(400).json({ message: result.error });

  const previous = (note.dependencies || []).map((d) => String(d));
  note.dependencies = result.value;
  await note.save();

  await writeAudit(req, {
    action: 'NOTE_DEPENDENCIES_SET',
    targetType: 'NOTE',
    targetId: String(note._id),
    metadata: { previous, next: result.value },
  });

  return res.json({ message: 'Dependencies updated', dependencies: result.value });
});

router.post('/:id/dependencies/:depId', async (req, res) => {
  const { id, depId } = req.params;
  if (!isValidObjectId(id) || !isValidObjectId(depId)) {
    return res.status(400).json({ message: 'Invalid id' });
  }
  const note = await Note.findOne({ _id: id, isDeleted: false })
    .populate('project', 'name isPersonal owner members isDeleted status');
  if (!note) return res.status(404).json({ message: 'Note not found' });
  if (!canWriteTask(note, req.userId)) {
    return res.status(403).json({ message: 'You do not have permission to edit this task.' });
  }

  const existing = (note.dependencies || []).map((d) => String(d));
  if (existing.includes(String(depId))) {
    return res.status(200).json({ message: 'Already a dependency', dependencies: existing });
  }

  const projectId = note.project ? String(note.project._id || note.project) : null;
  const next = [...existing, String(depId)];
  const result = await validateDependencies(note._id, projectId, next);
  if (result.error) return res.status(400).json({ message: result.error });

  note.dependencies = result.value;
  await note.save();

  await writeAudit(req, {
    action: 'NOTE_DEPENDENCY_ADD',
    targetType: 'NOTE',
    targetId: String(note._id),
    metadata: { added: String(depId) },
  });

  return res.json({ message: 'Dependency added', dependencies: result.value });
});

router.delete('/:id/dependencies/:depId', async (req, res) => {
  const { id, depId } = req.params;
  if (!isValidObjectId(id) || !isValidObjectId(depId)) {
    return res.status(400).json({ message: 'Invalid id' });
  }
  const note = await Note.findOne({ _id: id, isDeleted: false })
    .populate('project', 'name isPersonal owner members isDeleted status');
  if (!note) return res.status(404).json({ message: 'Note not found' });
  if (!canWriteTask(note, req.userId)) {
    return res.status(403).json({ message: 'You do not have permission to edit this task.' });
  }

  const before = (note.dependencies || []).map((d) => String(d));
  const after = before.filter((d) => d !== String(depId));
  if (before.length === after.length) {
    return res.status(404).json({ message: 'Dependency not found' });
  }
  note.dependencies = after;
  await note.save();

  await writeAudit(req, {
    action: 'NOTE_DEPENDENCY_REMOVE',
    targetType: 'NOTE',
    targetId: String(note._id),
    metadata: { removed: String(depId) },
  });

  return res.json({ message: 'Dependency removed', dependencies: after });
});

module.exports = router;
