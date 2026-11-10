// Unit tests for access.js and regex.js. Run: node src/utils/access.test.js

const assert = require('node:assert');
const {
  getProjectRole,
  getTaskAccess,
  canWriteTask,
  canCommentTask,
  isTaskOwner,
} = require('./access');
const { escapeRegex } = require('./regex');

const project = {
  owner: { _id: 'owner' },
  isDeleted: false,
  members: [
    { user: { _id: 'mod' }, role: 'moderator' },
    { user: 'editor', role: 'editor' },
    { user: 'reviewer', role: 'reviewer' },
    { user: 'viewer', role: 'viewer' },
    { user: 'assignedViewer', role: 'viewer' },
  ],
};

const task = { user: 'editor', project, assignees: ['assignedViewer', 'removed'] };

assert.strictEqual(getProjectRole(project, 'owner'), 'owner');
assert.strictEqual(getProjectRole(project, 'mod'), 'moderator');
assert.strictEqual(getProjectRole(project, 'stranger'), null);
assert.strictEqual(getProjectRole({ ...project, isDeleted: true }, 'owner'), null);

assert.strictEqual(getTaskAccess(task, 'editor'), 'owner');
assert.strictEqual(getTaskAccess(task, 'owner'), 'write');
assert.strictEqual(getTaskAccess(task, 'mod'), 'write');
assert.strictEqual(getTaskAccess(task, 'reviewer'), 'comment');
assert.strictEqual(getTaskAccess(task, 'viewer'), 'read');
assert.strictEqual(getTaskAccess(task, 'assignedViewer'), 'write');

// Assigned but no longer a member: no access at all.
assert.strictEqual(getTaskAccess(task, 'removed'), null);

// Creator removed from the project loses ownership.
const orphaned = { user: 'gone', project, assignees: [] };
assert.strictEqual(getTaskAccess(orphaned, 'gone'), null);
assert.strictEqual(isTaskOwner(orphaned, 'gone'), false);

// Unpopulated project reference never grants access.
assert.strictEqual(getTaskAccess({ user: 'editor', project: 'someProjectId' }, 'editor'), null);

// Task without a project: creator and assignees only.
const loose = { user: 'me', project: null, assignees: ['friend'] };
assert.strictEqual(getTaskAccess(loose, 'me'), 'owner');
assert.strictEqual(getTaskAccess(loose, 'friend'), 'write');
assert.strictEqual(getTaskAccess(loose, 'other'), null);

assert.strictEqual(canWriteTask(task, 'mod'), true);
assert.strictEqual(canWriteTask(task, 'reviewer'), false);
assert.strictEqual(canCommentTask(task, 'reviewer'), true);
assert.strictEqual(canCommentTask(task, 'viewer'), false);

assert.strictEqual(escapeRegex('(a+)+$'), '\\(a\\+\\)\\+\\$');
assert.ok(new RegExp(escapeRegex('a.b*c')).test('xa.b*cx'));
assert.ok(!new RegExp(escapeRegex('a.b')).test('axb'));

console.log('All access tests pass.');
