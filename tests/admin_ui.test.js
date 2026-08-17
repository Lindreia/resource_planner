const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const projectRoot = path.join(__dirname, '..');
const adminRoutesSource = fs.readFileSync(path.join(projectRoot, 'admin_routes.js'), 'utf8');
const managerRoutesSource = fs.readFileSync(path.join(projectRoot, 'manager_routes.js'), 'utf8');

test('admin messaging page template exists', () => {
  const filePath = path.join(projectRoot, 'web', 'templates', 'admin-messages.ejs');
  assert.ok(fs.existsSync(filePath), 'admin messaging template is missing');
});

test('control panel route exists', () => {
  assert.match(adminRoutesSource, /router\.get\([\s\S]*?['"]\/control-panel['"]/m,
    'control panel route should exist');
});

test('control panel template exists', () => {
  const filePath = path.join(projectRoot, 'web', 'templates', 'control-panel.ejs');
  assert.ok(fs.existsSync(filePath), 'control panel template is missing');
});

test('allocation view includes all user types in editable team list', () => {
  assert.match(managerRoutesSource, /ALL_USER_ROLES|role IN \$\{ALL_USER_ROLES\}/,
    'manager allocation queries should use the all-role user list in the editable team list');
});
