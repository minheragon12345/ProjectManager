// API tests against an in-memory MongoDB. Run: npm run test:api
// The first run downloads the MongoDB server binary (about 630 MB) into ~/.cache/mongodb-binaries.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server-core');

process.env.JWT_SECRET = 'test-secret';
const app = require('./app');
const User = require('./models/userModel');
const Note = require('./models/noteModel');
const TimeEntry = require('./models/timeEntryModel');
const Project = require('./models/projectModel');

let server;
const users = {};

before(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  for (const name of ['owner', 'editor', 'viewer', 'outsider', 'admin']) {
    const user = await User.create({ username: name, email: `${name}@test.dev`, password: 'secret123', role: name === 'admin' ? 'admin' : 'user' });
    users[name] = { id: String(user._id), token: jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET) };
  }
});

after(async () => {
  await mongoose.disconnect();
  await server.stop();
});

function as(name) {
  const token = users[name].token;
  const call = (method) => (url) => request(app)[method](`/api${url}`).set('Authorization', `Bearer ${token}`);
  return { get: call('get'), post: call('post'), put: call('put'), patch: call('patch'), delete: call('delete') };
}

async function createProject(name, extra = {}) {
  const res = await as('owner').post('/projects').send({ name, ...extra });
  assert.strictEqual(res.status, 201, res.body.message);
  const id = String(res.body.project._id || res.body.project.id);
  await as('owner').post(`/projects/${id}/members`).send({ email: 'editor@test.dev', role: 'editor' }).expect(200);
  await as('owner').post(`/projects/${id}/members`).send({ email: 'viewer@test.dev', role: 'viewer' }).expect(200);
  return id;
}

async function createTask(who, project, extra = {}) {
  const res = await as(who).post('/notes').send({ title: extra.title || 'Task', content: 'Do it', project, ...extra });
  assert.strictEqual(res.status, 201, res.body.message);
  return String(res.body.note._id);
}

test('register, login and ban check order', async () => {
  const registered = await request(app).post('/api/auth/register').send({ username: 'newbie', email: 'newbie@test.dev', password: 'secret123' }).expect(201);
  assert.strictEqual(await Project.countDocuments({ owner: registered.body.user._id, isPersonal: true }), 1);
  const short = await request(app).post('/api/auth/register').send({ username: 'shorty', email: 'shorty@test.dev', password: '123' });
  assert.strictEqual(short.status, 400);
  const login = await request(app).post('/api/auth/login').send({ email: 'newbie@test.dev', password: 'secret123' }).expect(200);
  assert.ok(login.body.token);
  await request(app).get('/api/auth/me').set('Authorization', `Bearer ${login.body.token}`).expect(200);
  assert.strictEqual(await Project.countDocuments({ owner: registered.body.user._id, isPersonal: true }), 1);

  // Older accounts without a Personal project get one when they log in.
  const legacy = await User.create({ username: 'legacy', email: 'legacy@test.dev', password: 'secret123' });
  await request(app).post('/api/auth/login').send({ email: 'legacy@test.dev', password: 'secret123' }).expect(200);
  assert.strictEqual(await Project.countDocuments({ owner: legacy._id, isPersonal: true }), 1);
  await request(app).post('/api/auth/login').send({ email: 'newbie@test.dev' }).expect(400);

  await User.updateOne({ email: 'newbie@test.dev' }, { isBanned: true, banReason: 'spam' });
  const wrong = await request(app).post('/api/auth/login').send({ email: 'newbie@test.dev', password: 'nope' });
  assert.strictEqual(wrong.status, 400);
  assert.ok(!JSON.stringify(wrong.body).includes('spam'));
  const right = await request(app).post('/api/auth/login').send({ email: 'newbie@test.dev', password: 'secret123' });
  assert.strictEqual(right.status, 403);
});

test('bad input gets a 4xx, not a server error', async () => {
  const bad = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"email":');
  assert.strictEqual(bad.status, 400);
  await as('owner').get('/nope').expect(404);
  await as('owner').get('/notes?search=(a%2B)%2B%24').expect(200);
  await as('owner').get('/projects?search=[').expect(200);
  const taken = await request(app).post('/api/auth/register').send({ username: 'owner', email: 'other@test.dev', password: 'secret123' });
  assert.strictEqual(taken.status, 409);
});

test('unexpected errors return 500 and are logged', async () => {
  const find = Note.find;
  const log = console.error;
  const logged = [];
  Note.find = () => { throw new Error('boom'); };
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const res = await as('owner').get('/notes');
    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.body.message, 'Server error');
  } finally {
    Note.find = find;
    console.error = log;
  }
  assert.ok(logged.some((line) => line.includes('GET /api/notes') && line.includes('boom')));
});

test('project roles decide who can create and edit tasks', async () => {
  const project = await createProject('Roles');
  await as('viewer').post('/notes').send({ title: 'x', content: 'x', project }).expect(403);
  await as('outsider').post('/notes').send({ title: 'x', content: 'x', project }).expect(403);
  const task = await createTask('editor', project);
  await as('viewer').put(`/notes/${task}`).send({ title: 'changed' }).expect(403);
  await as('owner').put(`/notes/${task}`).send({ title: 'changed' }).expect(200);
  await as('outsider').get(`/notes/${task}`).expect(403);
});

test('comments, subtasks and dependency links', async () => {
  const project = await createProject('Links');
  const parent = await createTask('owner', project, { title: 'Parent' });
  await createTask('editor', project, { title: 'Child', parentTask: parent });
  const blocker = await createTask('owner', project, { title: 'Blocker' });

  await as('viewer').post(`/notes/${parent}/comments`).send({ text: 'no' }).expect(403);
  await as('editor').post(`/notes/${parent}/comments`).send({ text: 'looks good' }).expect(201);
  const comments = await as('viewer').get(`/notes/${parent}/comments`).expect(200);
  assert.strictEqual(comments.body.total, 1);

  const subtasks = await as('viewer').get(`/notes/${parent}/subtasks`).expect(200);
  assert.strictEqual(subtasks.body.total, 1);

  await as('editor').post(`/notes/${parent}/dependencies/${blocker}`).expect(200);
  const blockedBy = await as('viewer').get(`/notes/${parent}/dependencies/blocked-by`).expect(200);
  assert.strictEqual(blockedBy.body.total, 1);
  const blocks = await as('viewer').get(`/notes/${blocker}/dependencies/blocks`).expect(200);
  assert.strictEqual(blocks.body.total, 1);
  const listed = await as('viewer').get(`/notes?projectId=${project}`).expect(200);
  assert.strictEqual(listed.body.notes.find((note) => String(note._id) === parent).isBlocked, true);

  await as('owner').post(`/notes/${blocker}/dependencies/${parent}`).expect(400);
  await as('editor').delete(`/notes/${parent}/dependencies/${blocker}`).expect(200);
  assert.deepStrictEqual((await Note.findById(parent)).dependencies, []);
});

test('only the creator or a project owner moves a task, and its time entries follow', async () => {
  const from = await createProject('Move from');
  const to = await createProject('Move to');
  const task = await createTask('owner', from, { assignees: [users.editor.id] });
  await as('editor').post('/time-entries').send({ task, hours: 2, date: '2026-11-01' }).expect(201);

  await as('editor').put(`/notes/${task}`).send({ project: to }).expect(403);
  const moved = await as('owner').put(`/notes/${task}`).send({ project: to });
  assert.strictEqual(moved.status, 200, moved.body.message);
  const entry = await TimeEntry.findOne({ task });
  assert.strictEqual(String(entry.project), to);

  const parent = await createTask('owner', to, { title: 'Parent' });
  await createTask('owner', to, { title: 'Child', parentTask: parent });
  await as('owner').put(`/notes/${parent}`).send({ project: from }).expect(400);
});

test('trash and restore keep subtasks trashed on their own', async () => {
  const project = await createProject('Trash');
  const parent = await createTask('owner', project, { title: 'Parent' });
  const kept = await createTask('owner', project, { title: 'Kept', parentTask: parent });
  const alone = await createTask('owner', project, { title: 'Alone', parentTask: parent });

  await as('owner').delete(`/notes/${alone}`).expect(200);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const trashed = await as('owner').delete(`/notes/${parent}`).expect(200);
  assert.strictEqual(trashed.body.cascadedSubtasks, 1);

  await as('owner').patch(`/notes/${kept}/restore`).expect(400);
  const restored = await as('owner').patch(`/notes/${parent}/restore`).expect(200);
  assert.strictEqual(restored.body.cascadedSubtasks, 1);
  assert.strictEqual((await Note.findById(kept)).isDeleted, false);
  assert.strictEqual((await Note.findById(alone)).isDeleted, true);
});

test('permanent delete removes subtasks, dependency links and time entries', async () => {
  const project = await createProject('Delete');
  const parent = await createTask('owner', project, { title: 'Parent' });
  const child = await createTask('owner', project, { title: 'Child', parentTask: parent });
  const waiting = await createTask('owner', project, { title: 'Waiting' });
  await as('owner').put(`/notes/${waiting}/dependencies`).send({ dependencies: [child] }).expect(200);
  await as('owner').post('/time-entries').send({ task: child, hours: 1, date: '2026-11-01' }).expect(201);

  await as('owner').delete(`/notes/${parent}`).expect(200);
  await as('owner').delete(`/notes/${parent}/hard`).expect(200);
  assert.strictEqual(await Note.countDocuments({ _id: { $in: [parent, child] } }), 0);
  assert.deepStrictEqual((await Note.findById(waiting)).dependencies, []);
  assert.strictEqual(await TimeEntry.countDocuments({ task: child }), 0);
});

test('admin permanent delete cascades too', async () => {
  const project = await createProject('Admin delete');
  const parent = await createTask('owner', project, { title: 'Parent' });
  const child = await createTask('owner', project, { title: 'Child', parentTask: parent });
  await as('owner').post('/time-entries').send({ task: child, hours: 1, date: '2026-11-01' }).expect(201);
  await as('editor').delete(`/admin/notes/${parent}`).expect(403);
  await as('admin').delete(`/admin/notes/${parent}`).expect(200);
  assert.strictEqual(await Note.countDocuments({ _id: { $in: [parent, child] } }), 0);
  assert.strictEqual(await TimeEntry.countDocuments({ task: child }), 0);
});

test('deleting a project trashes its tasks and time entries', async () => {
  const project = await createProject('Doomed');
  const task = await createTask('owner', project);
  await as('owner').post('/time-entries').send({ task, hours: 3, date: '2026-11-01' }).expect(201);
  await as('editor').delete(`/projects/${project}`).expect(403);
  await as('owner').delete(`/projects/${project}`).expect(200);
  assert.strictEqual((await Note.findById(task)).isDeleted, true);
  assert.strictEqual((await TimeEntry.findOne({ task })).isDeleted, true);
  const mine = await as('owner').get('/time-entries');
  assert.ok(!mine.body.entries?.some((entry) => entry.task?.id === task));
});

test('archived projects are read-only', async () => {
  const project = await createProject('Archive');
  const task = await createTask('editor', project);
  const entry = await as('editor').post('/time-entries').send({ task, hours: 1, date: '2026-11-01' }).expect(201);
  await as('owner').patch(`/projects/${project}/archive`).expect(200);

  await as('editor').post('/notes').send({ title: 'x', content: 'x', project }).expect(403);
  await as('editor').put(`/notes/${task}`).send({ title: 'changed' }).expect(403);
  await as('owner').post(`/notes/${task}/comments`).send({ text: 'hi' }).expect(403);
  await as('editor').post('/time-entries').send({ task, hours: 1 }).expect(403);
  await as('editor').put(`/time-entries/${entry.body.entry.id}`).send({ hours: 5 }).expect(403);
  const read = await as('viewer').get(`/notes/${task}`).expect(200);
  assert.strictEqual(read.body.note.access, 'read');

  await as('owner').patch(`/projects/${project}/archive`).expect(200);
  await as('editor').put(`/notes/${task}`).send({ title: 'changed' }).expect(200);
});

test('removed members lose their tasks and time entries', async () => {
  const project = await createProject('Leaving');
  const task = await createTask('owner', project, { assignees: [users.editor.id] });
  const entry = await as('editor').post('/time-entries').send({ task, hours: 1, date: '2026-11-01' }).expect(201);
  await as('owner').delete(`/projects/${project}/members/${users.editor.id}`).expect(200);

  assert.deepStrictEqual((await Note.findById(task)).assignees, []);
  await as('editor').get(`/notes/${task}`).expect(403);
  await as('editor').delete(`/time-entries/${entry.body.entry.id}`).expect(403);
  await as('owner').put(`/notes/${task}`).send({ title: 'still saves' }).expect(200);
});

test('admin edits follow the same parent and subtask rules', async () => {
  const project = await createProject('Admin edit');
  const parent = await createTask('owner', project, { title: 'Parent' });
  const child = await createTask('owner', project, { title: 'Child', parentTask: parent });
  await as('admin').patch(`/admin/notes/${parent}`).send({ progress: 50 }).expect(400);
  await as('admin').patch(`/admin/notes/${parent}`).send({ status: 'done' }).expect(400);
  await as('admin').patch(`/admin/notes/${child}`).send({ status: 'done' }).expect(200);
  const updated = await Note.findById(parent);
  assert.strictEqual(updated.progress, 100);
  assert.strictEqual(updated.status, 'done');

  await as('owner').patch(`/notes/${parent}/status`).send({ status: 'done' }).expect(400);
  const cancelled = await as('owner').patch(`/notes/${parent}/status`).send({ status: 'cancelled' }).expect(200);
  assert.strictEqual(cancelled.body.note.project.members, undefined);
  assert.strictEqual(cancelled.body.note.access, 'owner');
  await as('owner').patch(`/notes/${parent}/status`).send({ status: 'not_done' }).expect(200);
  const log = await as('owner').get(`/projects/${project}/audit-log`).expect(200);
  assert.ok(log.body.items.some((item) => item.actorRole === 'admin' && item.targetId === child));
  await as('owner').patch(`/notes/${child}/status`).send({ status: 'chưa xong' }).expect(400);
});

test('schedule spans parents over their subtasks and skips cancelled tasks', async () => {
  const project = await createProject('Plan', { maxHeadcount: 2 });
  const design = await createTask('owner', project, { title: 'Design', duration: 3 });
  const parent = await createTask('owner', project, { title: 'Parent', duration: 10 });
  await as('owner').put(`/notes/${parent}/dependencies`).send({ dependencies: [design] }).expect(200);
  const build = await createTask('owner', project, { title: 'Build', duration: 4, parentTask: parent });
  const check = await createTask('owner', project, { title: 'Check', duration: 2, parentTask: parent });
  await as('owner').put(`/notes/${check}/dependencies`).send({ dependencies: [build] }).expect(200);
  const dropped = await createTask('owner', project, { title: 'Dropped', duration: 6 });
  await as('owner').patch(`/notes/${dropped}/status`).send({ status: 'cancelled' }).expect(200);

  const res = await as('viewer').get(`/projects/${project}/schedule`).expect(200);
  assert.strictEqual(res.body.projectDuration, 9);
  const byId = new Map(res.body.tasks.map((task) => [task.id, task]));
  assert.strictEqual(byId.get(parent).ES, 3);
  assert.strictEqual(byId.get(parent).EF, 9);
  assert.strictEqual(byId.get(dropped).duration, 0);
  await as('viewer').get(`/projects/${project}/schedule?constrained=true`).expect(200);
  await as('viewer').get(`/projects/${project}/resource-curve?constrained=true`).expect(200);
});
