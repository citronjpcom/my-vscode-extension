const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const extension = require('../extension');

const samplePath = path.join(__dirname, '..', 'sample', 'sample.md');
const sample = fs.readFileSync(samplePath, 'utf8');
const table = extension.findFirstMarkdownTable(sample);
const blocks = extension.parseMarkdownDocument(sample);

assert.ok(table, 'sample Markdown should include a table');
assert.equal(table.startLine, 6);
assert.deepEqual(table.rows[0], ['Item', 'Owner', 'Status', 'Notes']);
assert.deepEqual(table.alignments, [null, null, null, null]);
assert.deepEqual(
  blocks.map((block) => block.type),
  ['text', 'table', 'text', 'mermaid', 'text', 'image', 'text', 'table', 'text']
);
assert.match(blocks[3].code, /flowchart LR/);
assert.equal(blocks[5].target, './diagrams/system.drawio.svg');
assert.equal(extension.renderMarkdownDocument(blocks), sample);

const markdown = extension.renderMarkdownTable([
  ['A', 'B'],
  ['1', '2'],
  ['3', '4']
]);

assert.equal(markdown, ['| A | B |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |'].join('\n'));

const alignedMarkdown = extension.renderMarkdownTable(
  [['A', 'B', 'C'], ['1', '`x|y`', '3']],
  ['left', 'center', 'right']
);
assert.equal(
  alignedMarkdown,
  ['| A | B | C |', '| :--- | :---: | ---: |', '| 1 | `x|y` | 3 |'].join('\n')
);

const multilineMarkdown = extension.renderMarkdownTable(
  [['A', 'Notes'], ['1', 'first line\nsecond line']]
);
assert.equal(
  multilineMarkdown,
  ['| A | Notes |', '| --- | --- |', '| 1 | first line<br>second line |'].join('\n')
);

const mixed = [
  '# Mixed',
  '',
  'Intro text.',
  '',
  '| A | B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  'Between tables.',
  '',
  '| C | D |',
  '| --- | --- |',
  '| 3 | 4 |',
  '',
  'Outro text.'
].join('\n');
const mixedBlocks = extension.parseMarkdownDocument(mixed);

assert.deepEqual(mixedBlocks.map((block) => block.type), ['text', 'table', 'text', 'table', 'text']);
assert.equal(extension.renderMarkdownDocument(mixedBlocks), mixed);

const fenceAndEscapes = [
  '```js',
  'const sample = "| not a table |";',
  '```',
  '',
  '| Name | Notes | Amount |',
  '| :--- | :---: | ---: |',
  '| A | `x|y` | 10 |',
  '| B | left \\| right | 20 |'
].join('\n');
const fencedBlocks = extension.parseMarkdownDocument(fenceAndEscapes);

assert.deepEqual(
  fencedBlocks.map((block) => block.type),
  ['text', 'table']
);
assert.deepEqual(fencedBlocks[1].alignments, ['left', 'center', 'right']);
assert.deepEqual(fencedBlocks[1].rows[1], ['A', '`x|y`', '10']);
assert.deepEqual(fencedBlocks[1].rows[2], ['B', 'left | right', '20']);
assert.equal(extension.renderMarkdownDocument(fencedBlocks), fenceAndEscapes);

const multilineTable = [
  '| A | Notes |',
  '| --- | --- |',
  '| 1 | first line<br>second line |'
].join('\n');
const multilineBlocks = extension.parseMarkdownDocument(multilineTable);
assert.deepEqual(multilineBlocks[0].rows[1], ['1', 'first line\nsecond line']);
assert.equal(extension.renderMarkdownDocument(multilineBlocks), multilineTable);

const quotedBreakTable = [
  '| A | Notes |',
  '| --- | --- |',
  '| 1 | "Error: あかさたな<br>はまやらわ" |'
].join('\n');
const quotedBreakBlocks = extension.parseMarkdownDocument(quotedBreakTable);
assert.deepEqual(quotedBreakBlocks[0].rows[1], ['1', '"Error: あかさたな<br>はまやらわ"']);
assert.equal(extension.renderMarkdownDocument(quotedBreakBlocks), quotedBreakTable);

const frontMatterDoc = [
  '---',
  'title: Sample',
  'tags:',
  '  - docs',
  '---',
  '',
  '# Heading',
  '',
  '- [ ] todo',
  '- [x] done',
  '',
  'Here is a note.[^note]',
  '',
  '[^note]: Footnote text',
  '',
  '> [!NOTE]',
  '> Callout body'
].join('\n');
const frontMatterBlocks = extension.parseMarkdownDocument(frontMatterDoc);

assert.equal(frontMatterBlocks[0].type, 'frontmatter');
assert.equal(frontMatterBlocks[0].fence, '---');
assert.equal(frontMatterBlocks[0].text, ['title: Sample', 'tags:', '  - docs'].join('\n'));
assert.equal(extension.renderMarkdownDocument(frontMatterBlocks), frontMatterDoc);

assert.deepEqual(
  extension.createDefaultInsertedTableRows(),
  [['Column 1', 'Column 2'], ['', '']]
);
assert.deepEqual(
  extension.createTableRowsFromCopiedSelection({
    type: 'table',
    values: [['A', 'B'], ['1', '2']]
  }),
  [['A', 'B'], ['1', '2']]
);
assert.deepEqual(
  extension.createTableRowsFromCopiedSelection({
    type: 'column',
    values: ['Header', 'Value']
  }),
  [['Header'], ['Value']]
);

console.log('roundtrip tests passed');
