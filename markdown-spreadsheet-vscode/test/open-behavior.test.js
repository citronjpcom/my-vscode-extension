const assert = require('node:assert/strict');
const extension = require('../extension');

assert.equal(extension.shouldCreateSeparateEditorPanel(true), true);
assert.equal(extension.shouldCreateSeparateEditorPanel(false), false);

console.log('open behavior tests passed');
