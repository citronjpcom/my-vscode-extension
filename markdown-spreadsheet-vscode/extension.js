let vscodeApi;
let activePanel;
const editorSessions = new Map();

function activate(context) {
  vscodeApi = require('vscode');
  const disposable = vscodeApi.commands.registerCommand(
    'markdownSpreadsheet.openTableEditor',
    (resource) => openTableEditor(context, resource)
  );

  context.subscriptions.push(disposable);
  context.subscriptions.push(
    vscodeApi.workspace.onDidChangeTextDocument((event) => {
      for (const [panel, session] of editorSessions.entries()) {
        if (!session.document || session.document.uri.toString() !== event.document.uri.toString()) {
          continue;
        }

        syncSessionSourceState(panel, session);
      }
    })
  );
}

function deactivate() {}

async function openTableEditor(context, resource) {
  const vscode = getVscode();
  const previouslyOpenTabs = getOpenTabIds(vscode);
  const previouslyOpenUris = getOpenTabUris(vscode);
  const document = await getMarkdownDocument(vscode, resource);

  if (!document) {
    vscode.window.showWarningMessage('Open a Markdown file before launching the table editor.');
    return;
  }

  const sourceIsActive = isActiveMarkdownSource(vscode, document);
  const activeSession = getPanelSession(activePanel);

  if (!sourceIsActive && activePanel && activeSession?.dirty) {
    const choice = await vscode.window.showWarningMessage(
      'The Markdown Spreadsheet editor has unsaved changes. Reloading it will discard those changes.',
      { modal: true },
      'Discard and Reload'
    );

    if (choice !== 'Discard and Reload') {
      return;
    }
  }

  const blocks = parseMarkdownDocument(document.getText());
  const tabToReplace = getReplaceableActiveTab(vscode);
  const hadSourceTabOpen = previouslyOpenUris.has(document.uri.toString());

  if (hadSourceTabOpen) {
    await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.Active,
      preview: false,
      preserveFocus: true
    });
  }

  const panel = shouldCreateSeparateEditorPanel(sourceIsActive)
    ? createEditorPanel(vscode, context)
    : getOrCreateEditorPanel(vscode, context);
  const session = getPanelSession(panel);

  session.document = document;
  session.dirty = false;
  session.pendingBlocks = null;
  session.sourceText = document.getText();
  session.sourceChanged = false;
  session.conflict = false;

  panel.webview.html = getWebviewHtml(
    panel.webview,
    prepareBlocksForWebview(panel.webview, blocks, document.uri),
    false
  );
  postSourceState(panel, session);

  panel.reveal(vscode.ViewColumn.Active);
  await closeTab(vscode, tabToReplace);
  await closeNewMarkdownSourceTabs(vscode, document.uri, previouslyOpenTabs);
}

function getReplaceableActiveTab(vscode) {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab;

  if (!tab) {
    return undefined;
  }

  if (tab.label === 'Welcome') {
    return tab;
  }

  return undefined;
}

function getOpenTabIds(vscode) {
  return new Set(
    vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .map(tabId)
  );
}

function getOpenTabUris(vscode) {
  return new Set(
    vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .flatMap(tabUris)
  );
}

async function closeTab(vscode, tab) {
  if (tab) {
    await vscode.window.tabGroups.close(tab, true);
  }
}

function getOrCreateEditorPanel(vscode, context) {
  if (activePanel) {
    return activePanel;
  }

  return createEditorPanel(vscode, context);
}

function createEditorPanel(vscode, context) {
  const panel = vscode.window.createWebviewPanel(
    'markdownSpreadsheet',
    'Markdown Spreadsheet',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true
    }
  );

  activePanel = panel;
  editorSessions.set(panel, {
    document: null,
    dirty: false,
    pendingBlocks: null,
    sourceText: '',
    sourceChanged: false,
    conflict: false
  });

  panel.webview.onDidReceiveMessage(
    async (message) => {
      const session = getPanelSession(panel);

      if (!session) {
        return;
      }

      if (message.type === 'dirty') {
        session.dirty = Boolean(message.dirty);
        session.pendingBlocks = session.dirty
          ? message.blocks || session.pendingBlocks
          : null;
        syncSessionSourceState(panel, session);
        return;
      }

      if (message.type === 'previewDiff') {
        if (!session.document) {
          vscode.window.showWarningMessage('No Markdown document is attached to this editor.');
          return;
        }

        await openDiffPreview(vscode, session.document, message.blocks, 'Markdown Spreadsheet Preview');
        return;
      }

      if (message.type === 'refresh') {
        if (!session.document) {
          vscode.window.showWarningMessage('No Markdown document is attached to this editor.');
          return;
        }

        if (session.dirty) {
          const choice = await vscode.window.showWarningMessage(
            'The Markdown Spreadsheet editor has unsaved changes. Refreshing will discard those changes.',
            { modal: true },
            'Discard and Refresh'
          );

          if (choice !== 'Discard and Refresh') {
            panel.webview.postMessage({ type: 'refreshResult', ok: false, cancelled: true });
            return;
          }
        }

        const blocks = parseMarkdownDocument(session.document.getText());
        session.dirty = false;
        session.pendingBlocks = null;
        session.sourceText = session.document.getText();
        session.sourceChanged = false;
        session.conflict = false;
        panel.webview.postMessage({
          type: 'refreshResult',
          ok: true,
          blocks: prepareBlocksForWebview(panel.webview, blocks, session.document.uri)
        });
        postSourceState(panel, session);
        return;
      }

      if (message.type !== 'save') {
        return;
      }

      if (!session.document) {
        vscode.window.showWarningMessage('No Markdown document is attached to this editor.');
        return;
      }

      try {
        if (hasSourceConflict(session)) {
          const choice = await vscode.window.showWarningMessage(
            'The source Markdown changed after this editor was opened. Saving now may overwrite source-side changes.',
            { modal: true },
            'Preview Diff',
            'Overwrite Source'
          );

          if (choice === 'Preview Diff') {
            await openDiffPreview(vscode, session.document, message.blocks, 'Markdown Spreadsheet Conflict');
            panel.webview.postMessage({ type: 'saveResult', ok: false, cancelled: true });
            return;
          }

          if (choice !== 'Overwrite Source') {
            panel.webview.postMessage({ type: 'saveResult', ok: false, cancelled: true });
            return;
          }
        }

        session.pendingBlocks = message.blocks;
        await replaceMarkdownDocument(session.document, message.blocks);
        session.dirty = false;
        session.pendingBlocks = null;
        session.sourceText = session.document.getText();
        session.sourceChanged = false;
        session.conflict = false;
        panel.webview.postMessage({ type: 'saveResult', ok: true });
        postSourceState(panel, session);
        vscode.window.showInformationMessage('Markdown document saved.');
      } catch (error) {
        panel.webview.postMessage({
          type: 'saveResult',
          ok: false,
          message: error.message || 'Failed to save the Markdown document.'
        });
        vscode.window.showErrorMessage(error.message || 'Failed to save the Markdown document.');
      }
    },
    undefined,
    context.subscriptions
  );

  panel.onDidChangeViewState(
    (event) => {
      if (event.webviewPanel.active) {
        activePanel = panel;
      }
    },
    undefined,
    context.subscriptions
  );

  panel.onDidDispose(
    async () => {
      const closedState = getPanelSession(panel);
      const closedDocument = closedState?.document;
      editorSessions.delete(panel);

      if (activePanel === panel) {
        activePanel = undefined;
      }

      if (!closedState?.dirty || !closedDocument || !closedState.pendingBlocks) {
        return;
      }

      const choice = await vscode.window.showWarningMessage(
        'The Markdown Spreadsheet editor was closed with unsaved changes.',
        { modal: true },
        'Reopen Editor',
        'Discard'
      );

      if (choice !== 'Reopen Editor') {
        return;
      }

      const restoredPanel = createEditorPanel(vscode, context);
      const restoredSession = getPanelSession(restoredPanel);
      restoredSession.document = closedDocument;
      restoredSession.dirty = true;
      restoredSession.pendingBlocks = closedState.pendingBlocks;
      restoredSession.sourceText = closedState.sourceText;
      restoredSession.sourceChanged = closedState.sourceChanged;
      restoredSession.conflict = closedState.conflict;
      restoredPanel.webview.html = getWebviewHtml(
        restoredPanel.webview,
        prepareBlocksForWebview(restoredPanel.webview, closedState.pendingBlocks, closedDocument.uri),
        true
      );
      postSourceState(restoredPanel, restoredSession);
      restoredPanel.reveal(vscode.ViewColumn.Active);
    },
    undefined,
    context.subscriptions
  );

  return panel;
}

function getPanelSession(panel) {
  return panel ? editorSessions.get(panel) : null;
}

function hasSourceConflict(session) {
  return Boolean(session?.dirty && session?.document && session.document.getText() !== session.sourceText);
}

function syncSessionSourceState(panel, session) {
  if (!panel || !session?.document) {
    return;
  }

  const currentText = session.document.getText();
  session.sourceChanged = currentText !== session.sourceText;
  session.conflict = session.sourceChanged && Boolean(session.dirty);
  postSourceState(panel, session);
}

function postSourceState(panel, session) {
  panel.webview.postMessage({
    type: 'sourceState',
    sourceChanged: Boolean(session?.sourceChanged),
    conflict: Boolean(session?.conflict)
  });
}

async function openDiffPreview(vscode, document, blocks, title) {
  const sourceDoc = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: document.getText()
  });
  const previewDoc = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: renderMarkdownDocument(blocks)
  });

  await vscode.commands.executeCommand(
    'vscode.diff',
    sourceDoc.uri,
    previewDoc.uri,
    title + ': ' + document.fileName.split('/').pop()
  );
}

async function closeNewMarkdownSourceTabs(vscode, documentUri, previouslyOpenTabs) {
  const sourceTabs = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .filter((tab) => tabUris(tab).includes(documentUri.toString()))
    .filter((tab) => !previouslyOpenTabs.has(tabId(tab)));

  if (sourceTabs.length > 0) {
    await vscode.window.tabGroups.close(sourceTabs, true);
  }
}

function tabId(tab) {
  return [tab.label, ...tabUris(tab)].join('|');
}

function tabUris(tab) {
  const input = tab.input;
  return [input?.uri, input?.modified, input?.original]
    .filter(Boolean)
    .map((uri) => uri.toString());
}

async function getMarkdownDocument(vscode, resource) {
  if (resource?.scheme) {
    const document = await vscode.workspace.openTextDocument(resource);

    if (document.languageId !== 'markdown') {
      return null;
    }

    return document;
  }

  if (vscode.window.activeTextEditor?.document.languageId === 'markdown') {
    return vscode.window.activeTextEditor.document;
  }

  return vscode.window.visibleTextEditors.find(
    (visibleEditor) => visibleEditor.document.languageId === 'markdown'
  )?.document ?? null;
}

function isActiveMarkdownSource(vscode, document) {
  return vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString();
}

function shouldCreateSeparateEditorPanel(sourceIsActive) {
  return Boolean(sourceIsActive);
}

function findFirstMarkdownTable(text) {
  return parseMarkdownDocument(text).find((block) => block.type === 'table') || null;
}

function parseMarkdownDocument(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  const textLines = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (index === 0) {
      const frontMatter = parseFrontMatter(lines, index);
      if (frontMatter) {
        blocks.push(frontMatter.block);
        index = frontMatter.endIndex;
        continue;
      }
    }

    const fence = getFenceStart(lines[index]);
    if (fence?.info === 'mermaid') {
      flushTextBlock(blocks, textLines);

      const codeLines = [];
      let cursor = index + 1;

      while (cursor < lines.length && !isFenceClose(lines[cursor], fence.marker)) {
        codeLines.push(lines[cursor]);
        cursor += 1;
      }

      blocks.push({
        type: 'mermaid',
        fence: fence.marker,
        code: codeLines.join('\n')
      });

      index = cursor < lines.length ? cursor : lines.length - 1;
      continue;
    }

    if (fence) {
      const fenceLines = [lines[index]];
      let cursor = index + 1;

      while (cursor < lines.length && !isFenceClose(lines[cursor], fence.marker)) {
        fenceLines.push(lines[cursor]);
        cursor += 1;
      }

      if (cursor < lines.length) {
        fenceLines.push(lines[cursor]);
      }

      textLines.push(...fenceLines);
      index = cursor < lines.length ? cursor : lines.length - 1;
      continue;
    }

    const image = parseImageLine(lines[index]);
    if (image) {
      flushTextBlock(blocks, textLines);
      blocks.push(image);
      continue;
    }

    if (!isTableRow(lines[index]) || !isSeparatorRow(lines[index + 1] ?? '')) {
      textLines.push(lines[index]);
      continue;
    }

    flushTextBlock(blocks, textLines);

    const tableLines = [lines[index], lines[index + 1]];
    let cursor = index + 2;

    while (cursor < lines.length && isTableRow(lines[cursor])) {
      tableLines.push(lines[cursor]);
      cursor += 1;
    }

    blocks.push({
      type: 'table',
      startLine: index,
      endLine: cursor - 1,
      ...parseTable(tableLines)
    });

    index = cursor - 1;
  }

  flushTextBlock(blocks, textLines);

  return blocks;
}

function parseFrontMatter(lines, index) {
  const fence = lines[index];
  if (fence !== '---' && fence !== '+++') {
    return null;
  }

  let cursor = index + 1;
  while (cursor < lines.length && lines[cursor] !== fence) {
    cursor += 1;
  }

  if (cursor >= lines.length) {
    return null;
  }

  return {
    endIndex: cursor,
    block: {
      type: 'frontmatter',
      fence,
      text: lines.slice(index + 1, cursor).join('\n')
    }
  };
}

function flushTextBlock(blocks, textLines) {
  if (textLines.length === 0) {
    return;
  }

  blocks.push({
    type: 'text',
    text: textLines.splice(0, textLines.length).join('\n')
  });
}

function isTableRow(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.includes('|');
}

function isSeparatorRow(line) {
  if (!isTableRow(line)) {
    return false;
  }

  return splitTableRow(line).every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function parseTable(lines) {
  const header = splitTableRow(lines[0]);
  const alignments = splitTableRow(lines[1]).map(parseAlignmentCell);
  const body = lines.slice(2).map(splitTableRow);
  return {
    rows: [header, ...body],
    alignments
  };
}

function getFenceStart(line) {
  const match = line.match(/^(`{3,}|~{3,})(.*)$/);
  if (!match) {
    return null;
  }

  return {
    marker: match[1],
    info: match[2].trim().toLowerCase()
  };
}

function isFenceClose(line, marker) {
  if (!marker) {
    return /^(`{3,}|~{3,})\s*$/.test(line);
  }

  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escapedMarker + '\\s*$').test(line);
}

function parseImageLine(line) {
  const match = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);

  if (!match) {
    return null;
  }

  return {
    type: 'image',
    alt: match[1],
    target: match[2]
  };
}

function splitTableRow(line) {
  const trimmed = line.trim();
  const content = trimmed.slice(1, -1);
  const cells = [];
  let cell = '';
  let backtickFence = 0;

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];

    if (character === '\\' && content[index + 1] === '|') {
      cell += '|';
      index += 1;
      continue;
    }

    if (character === '`') {
      let runLength = 1;
      while (content[index + runLength] === '`') {
        runLength += 1;
      }

      if (backtickFence === 0) {
        backtickFence = runLength;
      } else if (backtickFence === runLength) {
        backtickFence = 0;
      }

      cell += '`'.repeat(runLength);
      index += runLength - 1;
      continue;
    }

    if (character === '|' && backtickFence === 0) {
      cells.push(cell.trim());
      cell = '';
      continue;
    }

    cell += character;
  }

  cells.push(cell.trim());
  return cells.map(decodeCellLineBreaks);
}

function decodeCellLineBreaks(value) {
  const text = String(value ?? '');
  let decoded = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (character === '"' && text[index - 1] !== '\\') {
      quoted = !quoted;
      decoded += character;
      continue;
    }

    const breakMatch = text.slice(index).match(/^<br\s*\/?>/i);
    if (breakMatch && !quoted) {
      decoded += '\n';
      index += breakMatch[0].length - 1;
      continue;
    }

    decoded += character;
  }

  return decoded;
}

function parseAlignmentCell(cell) {
  const trimmed = cell.trim();
  const startsWithColon = trimmed.startsWith(':');
  const endsWithColon = trimmed.endsWith(':');

  if (startsWithColon && endsWithColon) {
    return 'center';
  }

  if (startsWithColon) {
    return 'left';
  }

  if (endsWithColon) {
    return 'right';
  }

  return null;
}

async function replaceMarkdownTable(editor, originalTable, rows) {
  const vscode = getVscode();
  const normalizedRows = normalizeRows(rows);
  const markdown = renderMarkdownTable(normalizedRows, originalTable.alignments);
  const start = new vscode.Position(originalTable.startLine, 0);
  const end = new vscode.Position(
    originalTable.endLine,
    editor.document.lineAt(originalTable.endLine).text.length
  );

  await editor.edit((editBuilder) => {
    editBuilder.replace(new vscode.Range(start, end), markdown);
  });
}

async function replaceMarkdownDocument(document, blocks) {
  const vscode = getVscode();
  const markdown = renderMarkdownDocument(blocks);
  const lastLine = document.lineCount - 1;
  const fullRange = new vscode.Range(
    new vscode.Position(0, 0),
    new vscode.Position(lastLine, document.lineAt(lastLine).text.length)
  );
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, fullRange, markdown);

  const edited = await vscode.workspace.applyEdit(edit);

  if (!edited) {
    throw new Error('Failed to update the Markdown document.');
  }

  const saved = await document.save();

  if (!saved) {
    throw new Error('Failed to save the Markdown document.');
  }
}

function normalizeRows(rows) {
  const width = Math.max(1, ...rows.map((row) => row.length));
  const normalized = rows.map((row) => {
    const nextRow = [...row];

    while (nextRow.length < width) {
      nextRow.push('');
    }

    return nextRow;
  });

  if (normalized.length === 0) {
    normalized.push(Array(width).fill(''));
  }

  return normalized;
}

function renderMarkdownTable(rows, alignments = []) {
  const normalizedRows = normalizeRows(rows);
  const columnCount = normalizedRows[0].length;
  const separator = Array.from({ length: columnCount }, (_, index) => renderAlignmentCell(alignments[index]));
  const renderedRows = [normalizedRows[0], separator, ...normalizedRows.slice(1)];

  return renderedRows
    .map((row) => `| ${row.map(escapeCell).join(' | ')} |`)
    .join('\n');
}

function renderMarkdownDocument(blocks) {
  return blocks
    .map((block) => {
      if (block.type === 'frontmatter') {
        return renderFrontMatterBlock(block);
      }

      if (block.type === 'table') {
        return renderMarkdownTable(block.rows, block.alignments);
      }

      if (block.type === 'mermaid') {
        return renderMermaidBlock(block);
      }

      if (block.type === 'image') {
        return renderImageBlock(block);
      }

      return String(block.text ?? '');
    })
    .join('\n');
}

function renderFrontMatterBlock(block) {
  const fence = block.fence || '---';
  return [fence, String(block.text ?? ''), fence].join('\n');
}

function renderMermaidBlock(block) {
  const fence = block.fence || '```';
  return [fence + 'mermaid', String(block.code ?? ''), fence].join('\n');
}

function renderImageBlock(block) {
  return `![${String(block.alt ?? '')}](${String(block.target ?? '')})`;
}

function escapeCell(value) {
  const text = String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let escaped = '';
  let backtickFence = 0;
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (character === '`') {
      let runLength = 1;
      while (text[index + runLength] === '`') {
        runLength += 1;
      }

      if (backtickFence === 0) {
        backtickFence = runLength;
      } else if (backtickFence === runLength) {
        backtickFence = 0;
      }

      escaped += '`'.repeat(runLength);
      index += runLength - 1;
      continue;
    }

    if (character === '|' && backtickFence === 0 && text[index - 1] !== '\\') {
      escaped += '\\|';
      continue;
    }

    if (character === '"' && text[index - 1] !== '\\') {
      quoted = !quoted;
      escaped += character;
      continue;
    }

    escaped += character === '\n' && !quoted ? '<br>' : character;
  }

  return escaped;
}

function renderAlignmentCell(alignment) {
  if (alignment === 'left') {
    return ':---';
  }

  if (alignment === 'right') {
    return '---:';
  }

  if (alignment === 'center') {
    return ':---:';
  }

  return '---';
}

function cloneGrid(rows) {
  return rows.map((row) => [...row]);
}

function createTableRowsFromCopiedSelection(copiedSelection) {
  if (!copiedSelection) {
    return null;
  }

  if (copiedSelection.type === 'table' || copiedSelection.type === 'cells') {
    return copiedSelection.values.length ? cloneGrid(copiedSelection.values) : null;
  }

  if (copiedSelection.type === 'row') {
    return copiedSelection.values.length ? [[...copiedSelection.values]] : null;
  }

  if (copiedSelection.type === 'column') {
    return copiedSelection.values.length ? copiedSelection.values.map((value) => [value]) : null;
  }

  return null;
}

function createDefaultInsertedTableRows() {
  return [
    ['Column 1', 'Column 2'],
    ['', '']
  ];
}

function prepareBlocksForWebview(webview, blocks, documentUri) {
  return blocks.map((block) => {
    if (block.type !== 'image') {
      return block;
    }

    return {
      ...block,
      src: getImageWebviewSource(webview, documentUri, block.target)
    };
  });
}

function getImageWebviewSource(webview, documentUri, target) {
  const cleanedTarget = String(target ?? '').trim().replace(/^<|>$/g, '');

  if (!cleanedTarget || /^(https?:|data:|vscode-resource:|vscode-webview-resource:)/i.test(cleanedTarget)) {
    return cleanedTarget;
  }

  try {
    const vscode = getVscode();
    return String(webview.asWebviewUri(vscode.Uri.joinPath(documentUri, '..', cleanedTarget)));
  } catch {
    return cleanedTarget;
  }
}

function getWebviewHtml(webview, blocks, initialDirty = false) {
  const nonce = getNonce();
  const initialState = JSON.stringify(blocks)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  const initialDirtyJson = JSON.stringify(Boolean(initialDirty));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Markdown Spreadsheet</title>
  <style>
    :root {
      color-scheme: light dark;
      --border: color-mix(in srgb, var(--vscode-editor-foreground) 20%, transparent);
      --focus: var(--vscode-focusBorder);
      --header: var(--vscode-sideBar-background);
    }

    body {
      margin: 0;
      padding: 16px;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }

    .toolbar {
      position: sticky;
      top: 0;
      z-index: 10;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      margin: -16px -16px 12px;
      padding: 12px 16px;
      background: var(--vscode-editor-background);
      border-bottom: 1px solid var(--border);
    }

    .searchbar {
      position: sticky;
      top: 54px;
      z-index: 9;
      display: grid;
      gap: 8px;
      margin: 0 -16px 12px;
      padding: 10px 16px;
      background: var(--vscode-editor-background);
      border-bottom: 1px solid var(--border);
    }

    .searchbar.hidden,
    .replace-row.hidden {
      display: none;
    }

    .search-row,
    .replace-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }

    .search-input {
      min-width: 200px;
      flex: 1 1 240px;
      min-height: 32px;
      box-sizing: border-box;
      padding: 6px 8px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--border);
      border-radius: 3px;
      font: inherit;
    }

    .search-match-status {
      min-width: 72px;
      color: var(--vscode-descriptionForeground);
      text-align: right;
    }

    button {
      min-height: 30px;
      padding: 4px 10px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      font: inherit;
      cursor: pointer;
    }

    button:hover {
      background: var(--vscode-button-hoverBackground);
    }

    label {
      display: inline-flex;
      gap: 6px;
      align-items: center;
      color: var(--vscode-descriptionForeground);
    }

    select {
      min-height: 30px;
      color: var(--vscode-dropdown-foreground);
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border, var(--border));
      border-radius: 3px;
      font: inherit;
    }

    .document {
      display: grid;
      gap: 12px;
      box-sizing: border-box;
      padding: 18px 20px;
      background: var(--vscode-input-background);
      border: 1px solid var(--border);
      border-radius: 4px;
    }

    .text-block,
    .table-block,
    .mermaid-block,
    .image-block {
      display: grid;
      gap: 6px;
    }

    .block-toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }

    .block-title {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
    }

    .text-editor {
      min-height: 1.5em;
      padding: 2px 0;
      color: var(--vscode-input-foreground);
      background: transparent;
      border: 1px solid transparent;
      font: inherit;
      line-height: 1.5;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .text-editor:focus {
      outline: 1px solid var(--focus);
      outline-offset: 3px;
    }

    .text-editor:empty::before {
      color: var(--vscode-input-placeholderForeground);
      content: attr(data-placeholder);
    }

    .sheet {
      position: relative;
      overflow-x: auto;
      overflow-y: auto;
      border: 1px solid var(--border);
      min-height: 72px;
      max-height: 78vh;
      background: var(--vscode-editor-background);
      scrollbar-width: auto;
    }

    .sheet.resize-edge {
      cursor: ns-resize;
    }

    .sheet::-webkit-scrollbar:horizontal {
      height: 0;
      transition: height 120ms ease;
    }

    .sheet.show-horizontal-scrollbar::-webkit-scrollbar:horizontal {
      height: 10px;
    }

    .sheet::-webkit-scrollbar-thumb:horizontal {
      background: color-mix(in srgb, var(--vscode-scrollbarSlider-background, var(--vscode-editor-foreground)) 88%, transparent);
      border-radius: 999px;
    }

    .sheet::-webkit-scrollbar-track:horizontal {
      background: transparent;
    }

    .sheet:focus {
      outline: 1px solid var(--focus);
      outline-offset: -1px;
    }

    table {
      width: max(100%, var(--table-width, 560px));
      border-collapse: collapse;
      table-layout: fixed;
    }

    th,
    td {
      border: 1px solid var(--border);
      padding: 0;
      min-width: 120px;
      min-height: 34px;
      height: auto;
    }

    .row-header {
      min-width: 44px;
      width: 44px;
      background: var(--header);
      text-align: center;
    }

    th {
      background: var(--vscode-input-background);
      text-align: left;
    }

    tr:first-child th {
      position: sticky;
      top: 0;
      z-index: 2;
      background: var(--header);
    }

    tr:first-child th::after {
      position: absolute;
      right: 0;
      bottom: -1px;
      left: 0;
      height: 1px;
      background: var(--border);
      content: '';
      pointer-events: none;
    }

    tr:first-child input {
      font-weight: 600;
      background: transparent;
    }

    .index-button {
      width: 100%;
      height: 100%;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      border: 0;
      border-radius: 0;
      font: inherit;
      cursor: pointer;
    }

    .index-button:hover,
    .index-button.selected {
      color: var(--vscode-editor-foreground);
      background: color-mix(in srgb, var(--vscode-focusBorder) 28%, transparent);
    }

    tr.selected-row td,
    tr.selected-row th.row-header {
      background: color-mix(in srgb, var(--vscode-focusBorder) 12%, var(--vscode-input-background));
    }

    td.selected-column,
    th.selected-column {
      background: color-mix(in srgb, var(--vscode-focusBorder) 12%, var(--vscode-input-background));
    }

    tr:first-child th.selected-column {
      background: color-mix(in srgb, var(--vscode-focusBorder) 18%, var(--header));
    }

    tr.selected-row input,
    td.selected-column input,
    th.selected-column input {
      background: color-mix(in srgb, var(--vscode-focusBorder) 18%, var(--vscode-input-background));
    }

    td.selected-cell,
    th.selected-cell {
      background: color-mix(in srgb, var(--vscode-focusBorder) 16%, var(--vscode-input-background));
      box-shadow: inset 0 0 0 2px var(--focus);
    }

    td.selected-range,
    th.selected-range {
      background: color-mix(in srgb, var(--vscode-focusBorder) 14%, var(--vscode-input-background));
    }

    td.selected-cell input,
    th.selected-cell input,
    td.selected-range input,
    th.selected-range input {
      background: color-mix(in srgb, var(--vscode-focusBorder) 22%, var(--vscode-input-background));
    }

    input,
    .cell-input {
      width: 100%;
      height: 100%;
      box-sizing: border-box;
      padding: 6px 8px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 0;
      font: inherit;
    }

    input:focus,
    .cell-input:focus {
      outline: 1px solid var(--focus);
      outline-offset: -1px;
    }

    .cell-input {
      display: block;
      min-height: 33px;
      resize: none;
      overflow: hidden;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .media-editor {
      display: grid;
      gap: 8px;
      padding: 10px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--border);
      border-radius: 4px;
    }

    .media-fields {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
      gap: 8px;
    }

    .media-input,
    .frontmatter-editor,
    .mermaid-source {
      box-sizing: border-box;
      width: 100%;
      min-height: 32px;
      padding: 6px 8px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--border);
      border-radius: 3px;
      font: inherit;
    }

    .frontmatter-editor {
      min-height: 120px;
      resize: vertical;
      font-family: var(--vscode-editor-font-family, monospace);
      white-space: pre;
    }

    .mermaid-source {
      min-height: 120px;
      resize: vertical;
      font-family: var(--vscode-editor-font-family, monospace);
      white-space: pre;
    }

    .image-preview {
      display: grid;
      place-items: center;
      min-height: 120px;
      background: var(--vscode-input-background);
      border: 1px dashed var(--border);
      border-radius: 3px;
      overflow: auto;
    }

    .image-preview img {
      max-width: 100%;
      max-height: 360px;
      display: block;
    }

    .mermaid-preview {
      min-height: 150px;
      padding: 10px;
      background: var(--vscode-input-background);
      border: 1px solid var(--border);
      border-radius: 3px;
      overflow: auto;
    }

    .mermaid-preview svg {
      max-width: 100%;
      min-width: 520px;
      height: auto;
    }

    .preview-empty {
      color: var(--vscode-descriptionForeground);
    }

    .status {
      margin-left: auto;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
    }

    .document .block-title {
      display: none;
    }

    .table-block,
    .mermaid-block,
    .image-block {
      margin: 2px 0;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="save">Save Document</button>
    <button id="preview-diff">Preview Diff</button>
    <button id="refresh">Refresh</button>
    <button id="add">Add</button>
    <button id="delete">Delete</button>
    <span class="status" id="status"></span>
  </div>
  <div class="searchbar hidden" id="searchbar">
    <div class="search-row">
      <input id="find-input" class="search-input" type="text" placeholder="Find" aria-label="Find text">
      <button id="find-previous" type="button">Previous</button>
      <button id="find-next" type="button">Next</button>
      <span class="search-match-status" id="search-status"></span>
      <button id="close-search" type="button">Close</button>
    </div>
    <div class="replace-row hidden" id="replace-row">
      <input id="replace-input" class="search-input" type="text" placeholder="Replace" aria-label="Replace text">
      <button id="replace-one" type="button">Replace</button>
      <button id="replace-all" type="button">Replace All</button>
    </div>
  </div>
  <div class="document" id="document"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let blocks = ${initialState};
    const documentRoot = document.getElementById('document');
    const status = document.getElementById('status');
    const saveButton = document.getElementById('save');
    const refreshButton = document.getElementById('refresh');
    const searchBar = document.getElementById('searchbar');
    const findInput = document.getElementById('find-input');
    const replaceRow = document.getElementById('replace-row');
    const replaceInput = document.getElementById('replace-input');
    const searchStatus = document.getElementById('search-status');
    let selection = getInitialSelection();
    let copiedSelection = null;
    let undoStack = [];
    let redoStack = [];
    let dragSelection = null;
    let suppressFocusSelection = false;
    let dirty = ${initialDirtyJson};
    let saving = false;
    let refreshing = false;
    let sourceChanged = false;
    let sourceConflict = false;
    let changeSerial = 0;
    let savingSerial = 0;
    const tableHeights = new Map();
    const sheetScrollTimers = new WeakMap();
    const searchState = {
      visible: false,
      replaceVisible: false,
      query: '',
      replace: '',
      matches: [],
      activeIndex: -1
    };

    function render() {
      documentRoot.replaceChildren(...blocks.map((block, blockIndex) => {
        if (block.type === 'table') {
          return renderTableBlock(block, blockIndex);
        }

        if (block.type === 'frontmatter') {
          return renderFrontMatterBlock(block, blockIndex);
        }

        if (block.type === 'mermaid') {
          return renderMermaidBlock(block, blockIndex);
        }

        if (block.type === 'image') {
          return renderImageBlock(block, blockIndex);
        }

        return renderTextBlock(block, blockIndex);
      }));

      updateStatus();
      syncSearchAfterRender();
    }

    function renderFrontMatterBlock(block, blockIndex) {
      const wrapper = document.createElement('section');
      wrapper.className = 'text-block';

      const title = document.createElement('div');
      title.className = 'block-title';
      title.textContent = 'Front Matter';

      const editor = document.createElement('textarea');
      editor.className = 'frontmatter-editor';
      editor.spellcheck = false;
      editor.dataset.blockIndex = String(blockIndex);
      editor.ariaLabel = 'Front matter block';
      editor.value = block.text || '';
      editor.addEventListener('focus', () => {
        setSelection(createLineSelection(blockIndex, null, null), false);
      });
      editor.addEventListener('beforeinput', pushUndoState);
      editor.addEventListener('input', () => {
        blocks[blockIndex].text = editor.value;
        markDirty();
      });

      wrapper.append(title, editor);
      return wrapper;
    }

    function renderTextBlock(block, blockIndex) {
      const wrapper = document.createElement('section');
      wrapper.className = 'text-block';

      const title = document.createElement('div');
      title.className = 'block-title';
      title.textContent = 'Text';

      const editor = document.createElement('div');
      editor.className = 'text-editor';
      editor.contentEditable = 'plaintext-only';
      editor.dataset.blockIndex = String(blockIndex);
      editor.dataset.placeholder = 'Write Markdown text';
      editor.ariaLabel = 'Markdown text block ' + (blockIndex + 1);
      editor.textContent = block.text || '';
      editor.addEventListener('focus', () => {
        setSelection(createLineSelection(blockIndex, null, null), false);
      });
      editor.addEventListener('mousedown', () => {
        setSelection(createLineSelection(blockIndex, null, null), false);
      });
      editor.addEventListener('beforeinput', pushUndoState);
      editor.addEventListener('input', () => {
        blocks[blockIndex].text = editor.textContent;
        markDirty();
      });

      wrapper.append(title, editor);
      return wrapper;
    }

    function renderTableBlock(block, blockIndex) {
      const wrapper = document.createElement('section');
      wrapper.className = 'table-block';

      const title = document.createElement('div');
      title.className = 'block-title';
      title.textContent = 'Table';

      const sheet = document.createElement('div');
      sheet.className = 'sheet';
      sheet.dataset.blockIndex = String(blockIndex);
      sheet.tabIndex = 0;
      sheet.ariaLabel = 'Table ' + getTableNumber(blockIndex) + ' viewport. Use the bottom edge to resize.';
      sheet.dataset.maxHeight = String(getTableMaxHeight(block.rows.length));
      sheet.style.height = getTableHeight(blockIndex, block.rows.length);
      sheet.style.maxHeight = sheet.dataset.maxHeight + 'px';
      sheet.addEventListener('mousemove', (event) => {
        sheet.classList.toggle('resize-edge', isNearSheetResizeEdge(event, sheet));
      });
      sheet.addEventListener('scroll', () => {
        flashHorizontalScrollbar(sheet);
      });
      sheet.addEventListener('mouseleave', () => {
        sheet.classList.remove('resize-edge');
      });
      sheet.addEventListener('mousedown', (event) => {
        if (isNearSheetResizeEdge(event, sheet)) {
          startTableResize(event, blockIndex, sheet);
        }
      });
      sheet.addEventListener('keydown', (event) => {
        resizeTableWithKeyboard(event, blockIndex, sheet);
      });
      sheet.appendChild(renderTable(block, blockIndex));
      requestAnimationFrame(() => {
        syncSheetScrollState(sheet);
      });

      wrapper.append(title, sheet);
      return wrapper;
    }

    function renderMermaidBlock(block, blockIndex) {
      const wrapper = document.createElement('section');
      wrapper.className = 'mermaid-block';

      const title = document.createElement('div');
      title.className = 'block-title';
      title.textContent = 'Mermaid';

      const editor = document.createElement('div');
      editor.className = 'media-editor';

      const source = document.createElement('textarea');
      source.className = 'mermaid-source';
      source.spellcheck = false;
      source.dataset.blockIndex = String(blockIndex);
      source.ariaLabel = 'Mermaid diagram source ' + (blockIndex + 1);
      source.value = block.code || '';

      const preview = document.createElement('div');
      preview.className = 'mermaid-preview';
      renderMermaidPreview(preview, source.value);

      source.addEventListener('beforeinput', pushUndoState);
      source.addEventListener('input', () => {
        blocks[blockIndex].code = source.value;
        renderMermaidPreview(preview, source.value);
        markDirty();
      });

      editor.append(preview, source);
      wrapper.append(title, editor);
      return wrapper;
    }

    function renderImageBlock(block, blockIndex) {
      const wrapper = document.createElement('section');
      wrapper.className = 'image-block';

      const title = document.createElement('div');
      title.className = 'block-title';
      title.textContent = 'Image';

      const editor = document.createElement('div');
      editor.className = 'media-editor';

      const preview = document.createElement('div');
      preview.className = 'image-preview';

      if (block.src) {
        const image = document.createElement('img');
        image.src = block.src;
        image.alt = block.alt || '';
        preview.appendChild(image);
      } else {
        const empty = document.createElement('div');
        empty.className = 'preview-empty';
        empty.textContent = 'Image path is empty';
        preview.appendChild(empty);
      }

      const fields = document.createElement('div');
      fields.className = 'media-fields';

      const alt = document.createElement('input');
      alt.className = 'media-input';
      alt.dataset.blockIndex = String(blockIndex);
      alt.dataset.field = 'alt';
      alt.value = block.alt || '';
      alt.placeholder = 'Alt text';
      alt.ariaLabel = 'Image alt text ' + (blockIndex + 1);
      alt.addEventListener('beforeinput', pushUndoState);
      alt.addEventListener('input', () => {
        blocks[blockIndex].alt = alt.value;
        const image = preview.querySelector('img');
        if (image) {
          image.alt = alt.value;
        }
        markDirty();
      });

      const target = document.createElement('input');
      target.className = 'media-input';
      target.dataset.blockIndex = String(blockIndex);
      target.dataset.field = 'target';
      target.value = block.target || '';
      target.placeholder = './images/example.png';
      target.ariaLabel = 'Image path ' + (blockIndex + 1);
      target.addEventListener('beforeinput', pushUndoState);
      target.addEventListener('input', () => {
        blocks[blockIndex].target = target.value;
        markDirty();
      });

      fields.append(alt, target);
      editor.append(preview, fields);
      wrapper.append(title, editor);
      return wrapper;
    }

    function renderTable(block, blockIndex) {
      const tableNumber = getTableNumber(blockIndex);
      const columnCount = getColumnCount(block.rows);
      block.rows = block.rows.map((row) => {
        const nextRow = [...row];
        while (nextRow.length < columnCount) {
          nextRow.push('');
        }
        return nextRow;
      });

      const table = document.createElement('table');
      table.dataset.blockIndex = String(blockIndex);
      table.style.setProperty('--table-width', (44 + (columnCount * 160)) + 'px');

      const colgroup = document.createElement('colgroup');
      const rowHeaderCol = document.createElement('col');
      rowHeaderCol.style.width = '44px';
      colgroup.appendChild(rowHeaderCol);

      for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
        const dataCol = document.createElement('col');
        dataCol.style.width = '160px';
        colgroup.appendChild(dataCol);
      }

      table.appendChild(colgroup);

      block.rows.forEach((row, rowIndex) => {
        const tr = document.createElement('tr');
        tr.dataset.blockIndex = String(blockIndex);
        tr.dataset.rowIndex = String(rowIndex);
        if (isRowSelection(blockIndex, rowIndex)) {
          tr.classList.add('selected-row');
        }

        const rowHeader = document.createElement('th');
        rowHeader.className = 'row-header';
        rowHeader.dataset.blockIndex = String(blockIndex);
        rowHeader.dataset.rowIndex = String(rowIndex);
        const rowButton = document.createElement('button');
        rowButton.className = 'index-button';
        rowButton.dataset.blockIndex = String(blockIndex);
        rowButton.dataset.rowIndex = String(rowIndex);
        if (isRowSelection(blockIndex, rowIndex)) {
          rowButton.classList.add('selected');
        }
        rowButton.textContent = String(rowIndex);
        rowButton.ariaLabel = 'Select table ' + tableNumber + ', row ' + rowIndex;
        rowButton.addEventListener('click', (event) => {
          if (event.shiftKey && selection.blockIndex === blockIndex) {
            const anchor = getSelectedRowRange()?.anchorIndex ?? rowIndex;
            setSelection(createLineRangeSelection(blockIndex, 'row', anchor, rowIndex));
            return;
          }

          setSelection(createLineSelection(blockIndex, rowIndex, null));
        });
        rowHeader.appendChild(rowButton);
        tr.appendChild(rowHeader);

        row.forEach((cell, columnIndex) => {
          const cellElement = document.createElement(rowIndex === 0 ? 'th' : 'td');
          cellElement.dataset.blockIndex = String(blockIndex);
          cellElement.dataset.rowIndex = String(rowIndex);
          cellElement.dataset.columnIndex = String(columnIndex);
          if (isColumnSelection(blockIndex, columnIndex)) {
            cellElement.classList.add('selected-column');
          }
          if (isCellSelection(blockIndex, rowIndex, columnIndex)) {
            cellElement.classList.add('selected-cell');
          }
          if (isCellInSelectedRange(blockIndex, rowIndex, columnIndex)) {
            cellElement.classList.add('selected-range');
          }
          const input = document.createElement('textarea');
          input.className = 'cell-input';
          input.rows = 1;
          input.spellcheck = false;
          input.value = cell;
          input.ariaLabel = 'Table ' + tableNumber + ', ' + getRowLabel(rowIndex) + ', column ' + (columnIndex + 1);
          input.dataset.blockIndex = String(blockIndex);
          input.dataset.rowIndex = String(rowIndex);
          input.dataset.columnIndex = String(columnIndex);
          input.addEventListener('mousedown', (event) => {
            handleCellMouseDown(event, blockIndex, rowIndex, columnIndex);
          });
          input.addEventListener('mousemove', (event) => {
            handleCellMouseMove(event, blockIndex, rowIndex, columnIndex);
          });
          input.addEventListener('dblclick', (event) => {
            enterCellEditMode(event.currentTarget, blockIndex, rowIndex, columnIndex);
          });
          input.addEventListener('focus', () => {
            if (suppressFocusSelection) {
              return;
            }

            setSelection(createCellSelection(blockIndex, rowIndex, columnIndex), false);
            input.select();
          });
          input.addEventListener('blur', () => {
            input.dataset.editing = 'false';
          });
          input.addEventListener('beforeinput', pushUndoState);
          input.addEventListener('input', () => {
            blocks[blockIndex].rows[rowIndex][columnIndex] = input.value;
            autoResizeCellEditor(input);
            markDirty();
          });
          input.addEventListener('keydown', (event) => moveWithKeyboard(event, table, rowIndex, columnIndex));
          autoResizeCellEditor(input);
          cellElement.appendChild(input);
          tr.appendChild(cellElement);
        });

        table.appendChild(tr);
      });

      return table;
    }

    function renderMermaidPreview(container, code) {
      container.replaceChildren();
      const graph = parseSimpleMermaidFlowchart(code);

      if (!graph.nodes.length) {
        const fallback = document.createElement('pre');
        fallback.className = 'preview-empty';
        fallback.textContent = code.trim() ? code : 'Mermaid diagram';
        container.appendChild(fallback);
        return;
      }

      container.appendChild(createFlowchartSvg(graph));
    }

    function parseSimpleMermaidFlowchart(code) {
      const lines = String(code || '')
        .split('\\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('%%'));
      const directionLine = lines.find((line) => /^flowchart\\s+/i.test(line) || /^graph\\s+/i.test(line));
      const direction = directionLine?.match(/\\s+(LR|RL|TB|TD|BT)\\b/i)?.[1]?.toUpperCase() || 'LR';
      const nodes = new Map();
      const edges = [];

      lines.forEach((line) => {
        if (/^(flowchart|graph)\\s+/i.test(line)) {
          return;
        }

        const edgeMatch = line.match(/^(.+?)\\s*[-.=]+(?:>|x|o)?\\s*(.+)$/);
        if (!edgeMatch) {
          return;
        }

        const from = parseMermaidNode(edgeMatch[1]);
        const to = parseMermaidNode(edgeMatch[2]);
        nodes.set(from.id, from);
        nodes.set(to.id, to);
        edges.push({ from: from.id, to: to.id });
      });

      return { direction, nodes: [...nodes.values()], edges };
    }

    function parseMermaidNode(raw) {
      const token = String(raw || '').trim().replace(/;$/, '');
      const match = token.match(/^([A-Za-z0-9_:-]+)(?:\\[([^\\]]+)\\]|\\(([^)]+)\\)|\\{([^}]+)\\})?/);
      const id = match?.[1] || token;
      const label = match?.[2] || match?.[3] || match?.[4] || id;
      return { id, label };
    }

    function createFlowchartSvg(graph) {
      const horizontal = graph.direction === 'LR' || graph.direction === 'RL';
      const nodeWidth = 150;
      const nodeHeight = 48;
      const gap = 56;
      const width = horizontal
        ? Math.max(260, graph.nodes.length * nodeWidth + (graph.nodes.length + 1) * gap)
        : 360;
      const height = horizontal
        ? 150
        : Math.max(160, graph.nodes.length * nodeHeight + (graph.nodes.length + 1) * gap);
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
      svg.setAttribute('role', 'img');

      const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
      const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
      marker.setAttribute('id', 'arrow');
      marker.setAttribute('viewBox', '0 0 10 10');
      marker.setAttribute('refX', '9');
      marker.setAttribute('refY', '5');
      marker.setAttribute('markerWidth', '6');
      marker.setAttribute('markerHeight', '6');
      marker.setAttribute('orient', 'auto-start-reverse');
      const markerPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      markerPath.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
      markerPath.setAttribute('fill', 'currentColor');
      marker.appendChild(markerPath);
      defs.appendChild(marker);
      svg.appendChild(defs);

      const positions = new Map();
      graph.nodes.forEach((node, index) => {
        const x = horizontal ? gap + index * (nodeWidth + gap) : (width - nodeWidth) / 2;
        const y = horizontal ? (height - nodeHeight) / 2 : gap + index * (nodeHeight + gap);
        positions.set(node.id, { x, y });
      });

      graph.edges.forEach((edge) => {
        const from = positions.get(edge.from);
        const to = positions.get(edge.to);
        if (!from || !to) {
          return;
        }

        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', horizontal ? from.x + nodeWidth : from.x + nodeWidth / 2);
        line.setAttribute('y1', horizontal ? from.y + nodeHeight / 2 : from.y + nodeHeight);
        line.setAttribute('x2', horizontal ? to.x : to.x + nodeWidth / 2);
        line.setAttribute('y2', horizontal ? to.y + nodeHeight / 2 : to.y);
        line.setAttribute('stroke', 'currentColor');
        line.setAttribute('stroke-width', '1.5');
        line.setAttribute('marker-end', 'url(#arrow)');
        svg.appendChild(line);
      });

      graph.nodes.forEach((node) => {
        const position = positions.get(node.id);
        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', position.x);
        rect.setAttribute('y', position.y);
        rect.setAttribute('width', nodeWidth);
        rect.setAttribute('height', nodeHeight);
        rect.setAttribute('rx', '4');
        rect.setAttribute('fill', 'var(--vscode-editor-background)');
        rect.setAttribute('stroke', 'currentColor');
        rect.setAttribute('opacity', '0.9');

        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', position.x + nodeWidth / 2);
        text.setAttribute('y', position.y + nodeHeight / 2 + 5);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('font-size', '12');
        text.setAttribute('fill', 'currentColor');
        text.textContent = truncateLabel(node.label);

        group.append(rect, text);
        svg.appendChild(group);
      });

      return svg;
    }

    function truncateLabel(value) {
      const label = String(value || '');
      return label.length > 20 ? label.slice(0, 19) + '...' : label;
    }

    function handleCellMouseDown(event, blockIndex, rowIndex, columnIndex) {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();

      if (event.shiftKey && selection.blockIndex === blockIndex && selection.rowIndex !== null && selection.columnIndex !== null) {
        const anchor = getSelectionAnchor();
        setSelection(createRangeSelection(blockIndex, anchor.rowIndex, anchor.columnIndex, rowIndex, columnIndex), false);
        return;
      }

      if (rowIndex === 0) {
        if (event.shiftKey && selection.blockIndex === blockIndex) {
          const anchor = getSelectedColumnRange()?.anchorIndex ?? columnIndex;
          setSelection(createLineRangeSelection(blockIndex, 'column', anchor, columnIndex), false);
          return;
        }

        dragSelection = null;
        event.currentTarget.dataset.editing = 'false';
        event.currentTarget.focus();
        event.currentTarget.select();
        setSelection(createLineSelection(blockIndex, null, columnIndex), false);
        return;
      }

      dragSelection = { blockIndex, rowIndex, columnIndex };
      event.currentTarget.dataset.editing = 'false';
      event.currentTarget.focus();
      event.currentTarget.select();
      setSelection(createCellSelection(blockIndex, rowIndex, columnIndex), false);
    }

    function enterCellEditMode(input, blockIndex, rowIndex, columnIndex) {
      input.dataset.editing = 'true';
      dragSelection = null;
      setSelection(createCellSelection(blockIndex, rowIndex, columnIndex), false);
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      autoResizeCellEditor(input);
    }

    function syncCellEditorValue(input) {
      const blockIndex = Number(input.dataset.blockIndex);
      const rowIndex = Number(input.dataset.rowIndex);
      const columnIndex = Number(input.dataset.columnIndex);

      if (blocks[blockIndex]?.type !== 'table') {
        return;
      }

      blocks[blockIndex].rows[rowIndex][columnIndex] = input.value;
      autoResizeCellEditor(input);
      markDirty();
    }

    function insertCellLineBreak(input) {
      if (isSelectionInsideDoubleQuotes(input)) {
        return;
      }

      pushUndoState();
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      input.setRangeText('\n', start, end, 'end');
      syncCellEditorValue(input);
    }

    function isSelectionInsideDoubleQuotes(input) {
      const value = String(input.value || '');
      const caretStart = input.selectionStart ?? value.length;
      let quoted = false;

      for (let index = 0; index < caretStart; index += 1) {
        if (value[index] === '"' && value[index - 1] !== '\\') {
          quoted = !quoted;
        }
      }

      return quoted;
    }

    function handleCellMouseMove(event, blockIndex, rowIndex, columnIndex) {
      if (!dragSelection || event.buttons !== 1 || dragSelection.blockIndex !== blockIndex) {
        return;
      }

      if (dragSelection.rowIndex === rowIndex && dragSelection.columnIndex === columnIndex) {
        return;
      }

      event.preventDefault();
      setSelection(createRangeSelection(blockIndex, dragSelection.rowIndex, dragSelection.columnIndex, rowIndex, columnIndex), false);
    }

    function moveWithKeyboard(event, table, rowIndex, columnIndex) {
      if (event.defaultPrevented) {
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      if (event.target?.dataset?.editing === 'true') {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.target.dataset.editing = 'false';
          event.target.select();
          return;
        }

        if (event.key === 'Enter' && event.shiftKey) {
          event.preventDefault();
          insertCellLineBreak(event.target);
          return;
        }

        if (event.key === 'Enter') {
          event.preventDefault();
          event.target.dataset.editing = 'false';
          focusTableCell(table, rowIndex + 1, columnIndex);
          return;
        }

        if (event.key === 'Tab') {
          event.preventDefault();
          event.target.dataset.editing = 'false';
          focusTableCell(table, rowIndex, columnIndex + (event.shiftKey ? -1 : 1));
        }
        return;
      }

      if (event.key === 'F2') {
        event.preventDefault();
        enterCellEditMode(event.target, Number(event.target.dataset.blockIndex), rowIndex, columnIndex);
        return;
      }

      if ((event.key === 'Delete' || event.key === 'Backspace') && isWholeInputSelected(event.target)) {
        event.preventDefault();
        clearFocusedSelection(event.target);
        return;
      }

      const keyMap = {
        ArrowUp: [rowIndex - 1, columnIndex],
        ArrowDown: [rowIndex + 1, columnIndex],
        ArrowLeft: [rowIndex, columnIndex - 1],
        ArrowRight: [rowIndex, columnIndex + 1],
        Tab: [rowIndex, columnIndex + (event.shiftKey ? -1 : 1)],
        Enter: [rowIndex + (event.shiftKey ? -1 : 1), columnIndex]
      };

      if (!keyMap[event.key]) {
        return;
      }

      event.preventDefault();
      const [nextRow, nextColumn] = keyMap[event.key];
      if (event.shiftKey && event.key.startsWith('Arrow')) {
        const anchor = getSelectionAnchor();
        focusTableCell(table, nextRow, nextColumn, createRangeSelection(
          Number(table.dataset.blockIndex),
          anchor.rowIndex,
          anchor.columnIndex,
          nextRow,
          nextColumn
        ));
        return;
      }

      focusTableCell(table, nextRow, nextColumn);
    }

    function focusTableCell(table, nextRow, nextColumn, nextSelection = null) {
      if (nextRow < 0 || nextColumn < 0) {
        return;
      }

      const blockIndex = Number(table.dataset.blockIndex);
      const tableBlock = blocks[blockIndex];

      if (tableBlock?.type === 'table' && tableNeedsSize(tableBlock, nextRow + 1, nextColumn + 1)) {
        pushUndoState();
        ensureTableSize(tableBlock, nextRow + 1, nextColumn + 1);
        selection = nextSelection || createCellSelection(blockIndex, nextRow, nextColumn);
        render();
        markDirty();
        focusRenderedCell(blockIndex, nextRow, nextColumn);
        return;
      }

      const selector = '.cell-input[data-row-index="' + nextRow + '"][data-column-index="' + nextColumn + '"]';
      const target = table.querySelector(selector);

      if (target) {
        suppressFocusSelection = Boolean(nextSelection);
        target.focus();
        target.select();
        suppressFocusSelection = false;

        if (nextSelection) {
          setSelection(nextSelection, false);
        }
      }
    }

    function tableNeedsSize(tableBlock, requiredRows, requiredColumns) {
      return tableBlock.rows.length < Math.max(1, requiredRows) ||
        getColumnCount(tableBlock.rows) < Math.max(1, requiredColumns);
    }

    function ensureTableSize(tableBlock, requiredRows, requiredColumns) {
      let changed = false;
      const normalizedRequiredRows = Math.max(1, requiredRows);
      const normalizedRequiredColumns = Math.max(1, requiredColumns);

      while (tableBlock.rows.length < normalizedRequiredRows) {
        tableBlock.rows.push(Array(getColumnCount(tableBlock.rows)).fill(''));
        changed = true;
      }

      tableBlock.rows = tableBlock.rows.map((row) => {
        const nextRow = [...row];
        while (nextRow.length < normalizedRequiredColumns) {
          nextRow.push('');
          changed = true;
        }
        return nextRow;
      });

      return changed;
    }

    function isWholeInputSelected(input) {
      return isCellEditor(input) &&
        input.selectionStart === 0 &&
        input.selectionEnd === input.value.length;
    }

    function isCellEditor(target) {
      return target instanceof HTMLTextAreaElement && target.classList.contains('cell-input');
    }

    function autoResizeCellEditor(input) {
      if (!isCellEditor(input)) {
        return;
      }

      input.style.height = 'auto';
      input.style.height = Math.max(33, input.scrollHeight) + 'px';
    }

    function clearFocusedCell(input) {
      const blockIndex = Number(input.dataset.blockIndex);
      const rowIndex = Number(input.dataset.rowIndex);
      const columnIndex = Number(input.dataset.columnIndex);

      if (blocks[blockIndex]?.type !== 'table') {
        return;
      }

      pushUndoState();
      input.value = '';
      blocks[blockIndex].rows[rowIndex][columnIndex] = '';
      setSelection(createCellSelection(blockIndex, rowIndex, columnIndex), false);
      markDirty();
    }

    function clearFocusedSelection(input) {
      if (!isRangeSelection()) {
        clearFocusedCell(input);
        return;
      }

      const tableBlock = getSelectedTableBlock();
      if (!tableBlock) {
        return;
      }

      pushUndoState();
      getSelectedCells().forEach(({ rowIndex, columnIndex }) => {
        tableBlock.rows[rowIndex][columnIndex] = '';
        const cellInput = documentRoot.querySelector(
          '.cell-input[data-block-index="' + selection.blockIndex + '"][data-row-index="' + rowIndex + '"][data-column-index="' + columnIndex + '"]'
        );
        if (cellInput) {
          cellInput.value = '';
          autoResizeCellEditor(cellInput);
        }
      });
      markDirty();
    }

    function getTableHeight(blockIndex, rowCount) {
      if (tableHeights.has(blockIndex)) {
        return tableHeights.get(blockIndex) + 'px';
      }

      const naturalHeight = getTableNaturalHeight(rowCount);
      return Math.min(naturalHeight, Math.round(window.innerHeight * 0.42)) + 'px';
    }

    function getTableNaturalHeight(rowCount) {
      return Math.max(72, rowCount * 34 + 2);
    }

    function getTableMaxHeight(rowCount) {
      const naturalHeight = getTableNaturalHeight(rowCount);
      return Math.min(Math.round(window.innerHeight * 0.78), naturalHeight);
    }

    function setTableHeight(blockIndex, sheet, height) {
      const maxHeight = Number(sheet.dataset.maxHeight) || Math.round(window.innerHeight * 0.78);
      const nextHeight = Math.max(72, Math.min(maxHeight, Math.round(height)));
      tableHeights.set(blockIndex, nextHeight);
      sheet.style.height = nextHeight + 'px';
      requestAnimationFrame(() => {
        syncSheetScrollState(sheet);
      });
    }

    function syncSheetScrollState(sheet) {
      const verticalOverflow = sheet.scrollHeight > sheet.clientHeight + 1;
      const horizontalOverflow = sheet.scrollWidth > sheet.clientWidth + 1;
      sheet.style.overflowY = verticalOverflow ? 'auto' : 'hidden';
      sheet.style.overflowX = horizontalOverflow ? 'auto' : 'hidden';

      if (!horizontalOverflow) {
        sheet.classList.remove('show-horizontal-scrollbar');
      }
    }

    function flashHorizontalScrollbar(sheet) {
      if (sheet.scrollWidth <= sheet.clientWidth + 1) {
        sheet.classList.remove('show-horizontal-scrollbar');
        return;
      }

      sheet.classList.add('show-horizontal-scrollbar');
      clearTimeout(sheetScrollTimers.get(sheet));
      const timer = window.setTimeout(() => {
        sheet.classList.remove('show-horizontal-scrollbar');
        sheetScrollTimers.delete(sheet);
      }, 700);
      sheetScrollTimers.set(sheet, timer);
    }

    function startTableResize(event, blockIndex, sheet) {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      const startY = event.clientY;
      const startHeight = sheet.getBoundingClientRect().height;

      const resize = (moveEvent) => {
        setTableHeight(blockIndex, sheet, startHeight + moveEvent.clientY - startY);
      };

      const stop = () => {
        window.removeEventListener('mousemove', resize);
        window.removeEventListener('mouseup', stop);
      };

      window.addEventListener('mousemove', resize);
      window.addEventListener('mouseup', stop);
    }

    function isNearSheetResizeEdge(event, sheet) {
      const rect = sheet.getBoundingClientRect();
      const insideWidth = event.clientX >= rect.left && event.clientX <= rect.right;
      const nearBottom = rect.bottom - event.clientY <= 24 && rect.bottom - event.clientY >= 0;
      return insideWidth && nearBottom;
    }

    function resizeTableWithKeyboard(event, blockIndex, sheet) {
      const step = event.shiftKey ? 48 : 16;

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setTableHeight(blockIndex, sheet, sheet.getBoundingClientRect().height - step);
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setTableHeight(blockIndex, sheet, sheet.getBoundingClientRect().height + step);
      }
    }

    function updateStatus() {
      const tables = blocks.filter((block) => block.type === 'table').length;
      const textBlocks = blocks.filter((block) => block.type === 'text' || block.type === 'frontmatter').length;
      const selected = getSelectionLabel();
      const copied = getCopiedSelectionLabel();
      const saveState = saving ? ', saving...' : refreshing ? ', refreshing...' : dirty ? ', unsaved changes' : ', saved';
      const sourceState = sourceConflict
        ? ', source conflict'
        : sourceChanged
          ? ', source changed'
          : '';
      status.textContent = textBlocks + ' text blocks, ' + tables + ' tables' + selected + copied + saveState + sourceState;
    }

    function openSearch(showReplace = false) {
      searchState.visible = true;
      searchState.replaceVisible = showReplace;
      searchBar.classList.remove('hidden');
      replaceRow.classList.toggle('hidden', !searchState.replaceVisible);
      searchState.query = findInput.value;
      searchState.replace = replaceInput.value;
      updateSearchMatches();
      findInput.focus();
      findInput.select();
    }

    function closeSearch() {
      searchState.visible = false;
      searchBar.classList.add('hidden');
      updateSearchStatus();
    }

    function updateSearchStatus() {
      if (!searchState.visible) {
        searchStatus.textContent = '';
        return;
      }

      if (!searchState.query) {
        searchStatus.textContent = '0 / 0';
        return;
      }

      const active = searchState.activeIndex >= 0 ? searchState.activeIndex + 1 : 0;
      searchStatus.textContent = active + ' / ' + searchState.matches.length;
    }

    function getSearchableEntries() {
      const entries = [];
      blocks.forEach((block, blockIndex) => {
        if (block.type === 'frontmatter') {
          entries.push({ kind: 'frontmatter', blockIndex, value: block.text || '' });
          return;
        }

        if (block.type === 'text') {
          entries.push({ kind: 'text', blockIndex, value: block.text || '' });
          return;
        }

        if (block.type === 'table') {
          block.rows.forEach((row, rowIndex) => {
            row.forEach((cell, columnIndex) => {
              entries.push({ kind: 'cell', blockIndex, rowIndex, columnIndex, value: cell || '' });
            });
          });
          return;
        }

        if (block.type === 'mermaid') {
          entries.push({ kind: 'mermaid', blockIndex, value: block.code || '' });
          return;
        }

        if (block.type === 'image') {
          entries.push({ kind: 'image-alt', blockIndex, field: 'alt', value: block.alt || '' });
          entries.push({ kind: 'image-target', blockIndex, field: 'target', value: block.target || '' });
        }
      });
      return entries;
    }

    function getEntryKey(entry) {
      return [
        entry.kind,
        entry.blockIndex,
        entry.rowIndex ?? '',
        entry.columnIndex ?? '',
        entry.field ?? ''
      ].join(':');
    }

    function findMatchOffsets(value, query) {
      const haystack = String(value || '').toLowerCase();
      const needle = String(query || '').toLowerCase();
      if (!needle) {
        return [];
      }

      const matches = [];
      let startIndex = 0;
      while (startIndex <= haystack.length) {
        const index = haystack.indexOf(needle, startIndex);
        if (index === -1) {
          break;
        }
        matches.push({ start: index, end: index + needle.length });
        startIndex = index + needle.length;
      }
      return matches;
    }

    function updateSearchMatches(preferredKey = null) {
      searchState.query = findInput.value;
      searchState.replace = replaceInput.value;

      if (!searchState.query) {
        searchState.matches = [];
        searchState.activeIndex = -1;
        updateSearchStatus();
        return;
      }

      const matches = [];
      getSearchableEntries().forEach((entry) => {
        findMatchOffsets(entry.value, searchState.query).forEach((offset) => {
          matches.push({
            ...entry,
            start: offset.start,
            end: offset.end
          });
        });
      });
      searchState.matches = matches;

      if (preferredKey) {
        searchState.activeIndex = matches.findIndex((match) => getMatchKey(match) === preferredKey);
      }

      if (searchState.activeIndex < 0 || searchState.activeIndex >= matches.length) {
        searchState.activeIndex = matches.length ? 0 : -1;
      }

      updateSearchStatus();
    }

    function getMatchKey(match) {
      return getEntryKey(match) + ':' + match.start + ':' + match.end;
    }

    function syncSearchAfterRender() {
      if (!searchState.visible) {
        return;
      }

      const activeMatch = searchState.matches[searchState.activeIndex];
      updateSearchMatches(activeMatch ? getMatchKey(activeMatch) : null);
      if (searchState.activeIndex >= 0) {
        focusSearchMatch(searchState.matches[searchState.activeIndex]);
      }
    }

    function stepSearch(direction) {
      if (!searchState.query) {
        updateSearchMatches();
      }

      if (!searchState.matches.length) {
        updateSearchStatus();
        return;
      }

      const matchCount = searchState.matches.length;
      searchState.activeIndex = (searchState.activeIndex + direction + matchCount) % matchCount;
      updateSearchStatus();
      focusSearchMatch(searchState.matches[searchState.activeIndex]);
    }

    function focusSearchMatch(match) {
      if (!match) {
        return;
      }

      requestAnimationFrame(() => {
        if (match.kind === 'text') {
          const target = documentRoot.querySelector('.text-editor[data-block-index="' + match.blockIndex + '"]');
          if (target) {
            target.focus();
            selectContentEditableRange(target, match.start, match.end);
          }
          return;
        }

        if (match.kind === 'frontmatter') {
          const target = documentRoot.querySelector('.frontmatter-editor[data-block-index="' + match.blockIndex + '"]');
          if (target) {
            target.focus();
            target.setSelectionRange(match.start, match.end);
          }
          return;
        }

        if (match.kind === 'cell') {
          const target = documentRoot.querySelector(
            '.cell-input[data-block-index="' + match.blockIndex + '"][data-row-index="' + match.rowIndex + '"][data-column-index="' + match.columnIndex + '"]'
          );
          if (target) {
            target.dataset.editing = 'true';
            target.focus();
            target.setSelectionRange(match.start, match.end);
          }
          return;
        }

        if (match.kind === 'mermaid') {
          const target = documentRoot.querySelector('.mermaid-source[data-block-index="' + match.blockIndex + '"]');
          if (target) {
            target.focus();
            target.setSelectionRange(match.start, match.end);
          }
          return;
        }

        const target = documentRoot.querySelector(
          '.media-input[data-block-index="' + match.blockIndex + '"][data-field="' + match.field + '"]'
        );
        if (target) {
          target.focus();
          target.setSelectionRange(match.start, match.end);
        }
      });
    }

    function selectContentEditableRange(element, start, end) {
      const selectionApi = window.getSelection();
      if (!selectionApi) {
        return;
      }

      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let currentOffset = 0;
      let startNode = null;
      let endNode = null;
      let startOffset = 0;
      let endOffset = 0;

      while (walker.nextNode()) {
        const node = walker.currentNode;
        const nextOffset = currentOffset + node.textContent.length;

        if (!startNode && start <= nextOffset) {
          startNode = node;
          startOffset = Math.max(0, start - currentOffset);
        }

        if (!endNode && end <= nextOffset) {
          endNode = node;
          endOffset = Math.max(0, end - currentOffset);
          break;
        }

        currentOffset = nextOffset;
      }

      if (!startNode || !endNode) {
        return;
      }

      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      selectionApi.removeAllRanges();
      selectionApi.addRange(range);
    }

    function updateEntryValue(entry, nextValue) {
      if (entry.kind === 'text') {
        blocks[entry.blockIndex].text = nextValue;
        return;
      }

      if (entry.kind === 'frontmatter') {
        blocks[entry.blockIndex].text = nextValue;
        return;
      }

      if (entry.kind === 'cell') {
        blocks[entry.blockIndex].rows[entry.rowIndex][entry.columnIndex] = nextValue;
        return;
      }

      if (entry.kind === 'mermaid') {
        blocks[entry.blockIndex].code = nextValue;
        return;
      }

      if (entry.kind === 'image-alt') {
        blocks[entry.blockIndex].alt = nextValue;
        return;
      }

      if (entry.kind === 'image-target') {
        blocks[entry.blockIndex].target = nextValue;
      }
    }

    function replaceCurrentMatch() {
      const match = searchState.matches[searchState.activeIndex];
      if (!match) {
        return;
      }

      pushUndoState();
      const value = String(match.value || '');
      const nextValue = value.slice(0, match.start) + replaceInput.value + value.slice(match.end);
      updateEntryValue(match, nextValue);
      render();
      markDirty();
    }

    function replaceAllMatches() {
      if (!searchState.matches.length) {
        return;
      }

      pushUndoState();
      const matchesByEntry = new Map();
      searchState.matches.forEach((match) => {
        const key = getEntryKey(match);
        if (!matchesByEntry.has(key)) {
          matchesByEntry.set(key, []);
        }
        matchesByEntry.get(key).push(match);
      });

      matchesByEntry.forEach((entryMatches) => {
        const entry = entryMatches[0];
        let nextValue = String(entry.value || '');
        [...entryMatches]
          .sort((left, right) => right.start - left.start)
          .forEach((match) => {
            nextValue = nextValue.slice(0, match.start) + replaceInput.value + nextValue.slice(match.end);
          });
        updateEntryValue(entry, nextValue);
      });

      render();
      markDirty();
    }

    function markDirty() {
      changeSerial += 1;
      dirty = true;
      updateStatus();
      vscode.postMessage({ type: 'dirty', dirty: true, blocks });
    }

    function markSaved() {
      dirty = false;
      saving = false;
      updateStatus();
      vscode.postMessage({ type: 'dirty', dirty: false, blocks: null });
    }

    function saveDocument() {
      saving = true;
      savingSerial = changeSerial;
      updateStatus();
      vscode.postMessage({ type: 'save', blocks });
    }

    function refreshDocument() {
      refreshing = true;
      updateStatus();
      vscode.postMessage({ type: 'refresh' });
    }

    function getColumnCount(rows) {
      return Math.max(1, ...rows.map((row) => row.length));
    }

    function getInitialSelection() {
      const blockIndex = blocks.findIndex((block) => block.type === 'table');
      return createLineSelection(Math.max(0, blockIndex), null, null);
    }

    function createLineSelection(blockIndex, rowIndex, columnIndex) {
      return { blockIndex, rowIndex, columnIndex, range: null, lineRange: null };
    }

    function createCellSelection(blockIndex, rowIndex, columnIndex) {
      return { blockIndex, rowIndex, columnIndex, range: null, lineRange: null };
    }

    function createRangeSelection(blockIndex, anchorRow, anchorColumn, focusRow, focusColumn) {
      return {
        blockIndex,
        rowIndex: focusRow,
        columnIndex: focusColumn,
        lineRange: null,
        range: {
          anchorRow,
          anchorColumn,
          focusRow,
          focusColumn
        }
      };
    }

    function createLineRangeSelection(blockIndex, axis, anchorIndex, focusIndex) {
      const normalizedStart = Math.min(anchorIndex, focusIndex);
      const normalizedEnd = Math.max(anchorIndex, focusIndex);
      return {
        blockIndex,
        rowIndex: axis === 'row' ? focusIndex : null,
        columnIndex: axis === 'column' ? focusIndex : null,
        range: null,
        lineRange: {
          axis,
          anchorIndex,
          focusIndex,
          startIndex: normalizedStart,
          endIndex: normalizedEnd
        }
      };
    }

    function setSelection(nextSelection, shouldRender = true) {
      selection = nextSelection;

      if (shouldRender) {
        render();
        return;
      }

      updateSelectionRendering();
      updateStatus();
    }

    function updateSelectionRendering() {
      documentRoot.querySelectorAll('.selected-row').forEach((element) => {
        element.classList.remove('selected-row');
      });
      documentRoot.querySelectorAll('.selected-column').forEach((element) => {
        element.classList.remove('selected-column');
      });
      documentRoot.querySelectorAll('.selected-cell').forEach((element) => {
        element.classList.remove('selected-cell');
      });
      documentRoot.querySelectorAll('.selected-range').forEach((element) => {
        element.classList.remove('selected-range');
      });
      documentRoot.querySelectorAll('.index-button.selected').forEach((element) => {
        element.classList.remove('selected');
      });

      documentRoot.querySelectorAll('table[data-block-index]').forEach((table) => {
        const blockIndex = Number(table.dataset.blockIndex);

        table.querySelectorAll('tr[data-row-index]').forEach((row) => {
          const rowIndex = Number(row.dataset.rowIndex);
          row.classList.toggle('selected-row', isRowSelection(blockIndex, rowIndex));
        });

        table.querySelectorAll('.row-header[data-row-index] .index-button').forEach((button) => {
          const rowIndex = Number(button.dataset.rowIndex);
          button.classList.toggle('selected', isRowSelection(blockIndex, rowIndex));
        });

        table.querySelectorAll('td[data-row-index][data-column-index], th[data-row-index][data-column-index]').forEach((cell) => {
          const rowIndex = Number(cell.dataset.rowIndex);
          const columnIndex = Number(cell.dataset.columnIndex);
          cell.classList.toggle('selected-column', isColumnSelection(blockIndex, columnIndex));
          cell.classList.toggle('selected-cell', isCellSelection(blockIndex, rowIndex, columnIndex));
          cell.classList.toggle('selected-range', isCellInSelectedRange(blockIndex, rowIndex, columnIndex));
        });
      });
    }

    function isSelected(blockIndex, rowIndex, columnIndex) {
      return selection.blockIndex === blockIndex &&
        selection.rowIndex === rowIndex &&
        selection.columnIndex === columnIndex;
    }

    function isRowSelection(blockIndex, rowIndex) {
      if (selection.blockIndex !== blockIndex) {
        return false;
      }

      if (selection.lineRange?.axis === 'row') {
        return rowIndex >= selection.lineRange.startIndex && rowIndex <= selection.lineRange.endIndex;
      }

      return isSelected(blockIndex, rowIndex, null);
    }

    function isColumnSelection(blockIndex, columnIndex) {
      if (selection.blockIndex !== blockIndex) {
        return false;
      }

      if (selection.lineRange?.axis === 'column') {
        return columnIndex >= selection.lineRange.startIndex && columnIndex <= selection.lineRange.endIndex;
      }

      return isSelected(blockIndex, null, columnIndex);
    }

    function isCellSelection(blockIndex, rowIndex, columnIndex) {
      if (rowIndex === null || columnIndex === null) {
        return false;
      }

      return isSelected(blockIndex, rowIndex, columnIndex);
    }

    function isRangeSelection() {
      return Boolean(selection.range);
    }

    function getSelectedRowRange() {
      if (selection.lineRange?.axis === 'row') {
        return selection.lineRange;
      }

      if (selection.rowIndex !== null && selection.columnIndex === null) {
        return {
          axis: 'row',
          anchorIndex: selection.rowIndex,
          focusIndex: selection.rowIndex,
          startIndex: selection.rowIndex,
          endIndex: selection.rowIndex
        };
      }

      return null;
    }

    function getSelectedColumnRange() {
      if (selection.lineRange?.axis === 'column') {
        return selection.lineRange;
      }

      if (selection.rowIndex === null && selection.columnIndex !== null) {
        return {
          axis: 'column',
          anchorIndex: selection.columnIndex,
          focusIndex: selection.columnIndex,
          startIndex: selection.columnIndex,
          endIndex: selection.columnIndex
        };
      }

      return null;
    }

    function getSelectionAnchor() {
      if (selection.range) {
        return {
          rowIndex: selection.range.anchorRow,
          columnIndex: selection.range.anchorColumn
        };
      }

      return {
        rowIndex: selection.rowIndex,
        columnIndex: selection.columnIndex
      };
    }

    function getNormalizedRange() {
      if (!selection.range) {
        return null;
      }

      const startRow = Math.min(selection.range.anchorRow, selection.range.focusRow);
      const endRow = Math.max(selection.range.anchorRow, selection.range.focusRow);
      const startColumn = Math.min(selection.range.anchorColumn, selection.range.focusColumn);
      const endColumn = Math.max(selection.range.anchorColumn, selection.range.focusColumn);
      return { startRow, endRow, startColumn, endColumn };
    }

    function isCellInSelectedRange(blockIndex, rowIndex, columnIndex) {
      if (selection.blockIndex !== blockIndex) {
        return false;
      }

      const range = getNormalizedRange();
      if (!range) {
        return false;
      }

      return rowIndex >= range.startRow &&
        rowIndex <= range.endRow &&
        columnIndex >= range.startColumn &&
        columnIndex <= range.endColumn;
    }

    function getSelectedCells() {
      const range = getNormalizedRange();
      if (!range) {
        return [];
      }

      const cells = [];
      for (let rowIndex = range.startRow; rowIndex <= range.endRow; rowIndex += 1) {
        for (let columnIndex = range.startColumn; columnIndex <= range.endColumn; columnIndex += 1) {
          cells.push({ rowIndex, columnIndex });
        }
      }
      return cells;
    }

    function getSelectedTableBlock() {
      return blocks[selection.blockIndex]?.type === 'table'
        ? blocks[selection.blockIndex]
        : null;
    }

    function getSelectionLabel() {
      if (blocks[selection.blockIndex]?.type !== 'table') {
        return '';
      }

      const tableNumber = getTableNumber(selection.blockIndex);

      if (isRangeSelection()) {
        const range = getNormalizedRange();
        return ', selected table ' + tableNumber + ' cells ' +
          getRowNumber(range.startRow) + ':' + (range.startColumn + 1) + '-' +
          getRowNumber(range.endRow) + ':' + (range.endColumn + 1);
      }

      if (isCellSelection(selection.blockIndex, selection.rowIndex, selection.columnIndex)) {
        return ', selected table ' + tableNumber + ' cell ' + getRowNumber(selection.rowIndex) + ':' + (selection.columnIndex + 1);
      }

      const rowRange = getSelectedRowRange();
      if (rowRange) {
        return rowRange.startIndex === rowRange.endIndex
          ? ', selected table ' + tableNumber + ' row ' + getRowNumber(rowRange.startIndex)
          : ', selected table ' + tableNumber + ' rows ' + getRowNumber(rowRange.startIndex) + '-' + getRowNumber(rowRange.endIndex);
      }

      const columnRange = getSelectedColumnRange();
      if (columnRange) {
        return columnRange.startIndex === columnRange.endIndex
          ? ', selected table ' + tableNumber + ' column ' + (columnRange.startIndex + 1)
          : ', selected table ' + tableNumber + ' columns ' + (columnRange.startIndex + 1) + '-' + (columnRange.endIndex + 1);
      }

      return ', selected table ' + tableNumber;
    }

    function getRowNumber(rowIndex) {
      return String(rowIndex);
    }

    function getRowLabel(rowIndex) {
      return 'row ' + rowIndex;
    }

    function cloneBlocks(value) {
      return JSON.parse(JSON.stringify(value));
    }

    function cloneSelection(value) {
      return JSON.parse(JSON.stringify(value));
    }

    function getHistorySnapshot() {
      return {
        blocks: cloneBlocks(blocks),
        selection: cloneSelection(selection)
      };
    }

    function restoreHistorySnapshot(snapshot) {
      blocks = cloneBlocks(snapshot.blocks);
      selection = cloneSelection(snapshot.selection);
      render();
    }

    function pushUndoState() {
      undoStack.push(getHistorySnapshot());
      redoStack = [];

      if (undoStack.length > 100) {
        undoStack.shift();
      }
    }

    function undo() {
      if (undoStack.length === 0) {
        return;
      }

      redoStack.push(getHistorySnapshot());
      restoreHistorySnapshot(undoStack.pop());
      markDirty();
    }

    function redo() {
      if (redoStack.length === 0) {
        return;
      }

      undoStack.push(getHistorySnapshot());
      restoreHistorySnapshot(redoStack.pop());
      markDirty();
    }

    function getCopiedSelectionLabel() {
      if (!copiedSelection) {
        return '';
      }

      return ', copied ' + copiedSelection.type;
    }

    function getTableNumber(blockIndex) {
      return blocks.slice(0, blockIndex + 1).filter((block) => block.type === 'table').length;
    }

    function copySelectedShape(event) {
      const tableBlock = getSelectedTableBlock();
      if (!tableBlock) {
        return;
      }

      if (isRangeSelection()) {
        const range = getNormalizedRange();
        copiedSelection = {
          type: 'cells',
          values: tableBlock.rows
            .slice(range.startRow, range.endRow + 1)
            .map((row) => row.slice(range.startColumn, range.endColumn + 1))
        };

        event.clipboardData?.setData('text/plain', copiedSelection.values.map((row) => row.join('\\t')).join('\\n'));
        event.preventDefault();
        updateStatus();
        return;
      }

      if (selection.rowIndex !== null && selection.columnIndex === null) {
        const rowRange = getSelectedRowRange();
        copiedSelection = rowRange && rowRange.startIndex !== rowRange.endIndex
          ? {
              type: 'rows',
              values: tableBlock.rows
                .slice(rowRange.startIndex, rowRange.endIndex + 1)
                .map((row) => [...row])
            }
          : {
              type: 'row',
              values: [...tableBlock.rows[selection.rowIndex]]
            };

        event.clipboardData?.setData(
          'text/plain',
          copiedSelection.type === 'rows'
            ? copiedSelection.values.map((row) => row.join('\\t')).join('\\n')
            : copiedSelection.values.join('\\t')
        );
        event.preventDefault();
        updateStatus();
        return;
      }

      if (selection.rowIndex === null && selection.columnIndex !== null) {
        const columnRange = getSelectedColumnRange();
        copiedSelection = columnRange && columnRange.startIndex !== columnRange.endIndex
          ? {
              type: 'columns',
              values: tableBlock.rows.map((row) =>
                row.slice(columnRange.startIndex, columnRange.endIndex + 1)
              )
            }
          : {
              type: 'column',
              values: tableBlock.rows.map((row) => row[selection.columnIndex] ?? '')
            };

        event.clipboardData?.setData(
          'text/plain',
          copiedSelection.type === 'columns'
            ? copiedSelection.values.map((row) => row.join('\\t')).join('\\n')
            : copiedSelection.values.join('\\n')
        );
        event.preventDefault();
        updateStatus();
        return;
      }

      copiedSelection = {
        type: 'table',
        values: tableBlock.rows.map((row) => [...row])
      };

      event.clipboardData?.setData('text/plain', copiedSelection.values.map((row) => row.join('\\t')).join('\\n'));
      event.preventDefault();
      updateStatus();
    }

    function parseClipboardGrid(text) {
      const normalized = String(text || '').replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n').replace(/\\n+$/, '');
      if (!normalized) {
        return [];
      }

      const rows = [];
      let row = [];
      let cell = '';
      let quoted = false;

      for (let index = 0; index < normalized.length; index += 1) {
        const character = normalized[index];
        const nextCharacter = normalized[index + 1];

        if (character === '"') {
          if (quoted && nextCharacter === '"') {
            cell += '"';
            index += 1;
            continue;
          }

          quoted = !quoted;
          continue;
        }

        if (!quoted && character === '\\t') {
          row.push(cell);
          cell = '';
          continue;
        }

        if (!quoted && character === '\\n') {
          row.push(cell);
          rows.push(row);
          row = [];
          cell = '';
          continue;
        }

        cell += character;
      }

      row.push(cell);
      rows.push(row);
      return rows;
    }

    function getPasteOrigin(target) {
      if (isRangeSelection()) {
        const range = getNormalizedRange();
        return { rowIndex: range.startRow, columnIndex: range.startColumn };
      }

      if (selection.rowIndex !== null && selection.columnIndex !== null) {
        return { rowIndex: selection.rowIndex, columnIndex: selection.columnIndex };
      }

      if (selection.rowIndex !== null) {
        return { rowIndex: selection.rowIndex, columnIndex: 0 };
      }

      if (selection.columnIndex !== null) {
        return { rowIndex: 0, columnIndex: selection.columnIndex };
      }

      if (isCellEditor(target) &&
        target.dataset.blockIndex === String(selection.blockIndex)) {
        return {
          rowIndex: Number(target.dataset.rowIndex),
          columnIndex: Number(target.dataset.columnIndex)
        };
      }

      return { rowIndex: 0, columnIndex: 0 };
    }

    function focusRenderedCell(blockIndex, rowIndex, columnIndex) {
      requestAnimationFrame(() => {
        const target = documentRoot.querySelector(
          '.cell-input[data-block-index="' + blockIndex + '"][data-row-index="' + rowIndex + '"][data-column-index="' + columnIndex + '"]'
        );
        if (target) {
          target.focus();
          target.select();
        }
      });
    }

    function pasteSelectedCells(event) {
      const target = event.target;
      if (!isCellEditor(target) || target.dataset.editing === 'true') {
        return;
      }

      const tableBlock = getSelectedTableBlock();
      if (!tableBlock || target.dataset.blockIndex !== String(selection.blockIndex)) {
        return;
      }

      const values = parseClipboardGrid(event.clipboardData?.getData('text/plain') || '');
      if (!values.length) {
        return;
      }

      const origin = getPasteOrigin(target);
      const rowCount = values.length;
      const columnCount = Math.max(1, ...values.map((row) => row.length));
      const requiredRows = origin.rowIndex + rowCount;
      const requiredColumns = origin.columnIndex + columnCount;

      pushUndoState();

      ensureTableSize(tableBlock, requiredRows, requiredColumns);

      values.forEach((row, rowOffset) => {
        row.forEach((value, columnOffset) => {
          tableBlock.rows[origin.rowIndex + rowOffset][origin.columnIndex + columnOffset] = value;
        });
      });

      event.preventDefault();
      selection = createRangeSelection(
        selection.blockIndex,
        origin.rowIndex,
        origin.columnIndex,
        origin.rowIndex + rowCount - 1,
        origin.columnIndex + columnCount - 1
      );
      render();
      markDirty();
      focusRenderedCell(selection.blockIndex, origin.rowIndex, origin.columnIndex);
    }

    function addRow(tableBlock) {
      const columns = getColumnCount(tableBlock.rows);
      const rowRange = getSelectedRowRange();
      const insertIndex = rowRange ? rowRange.endIndex + 1 : tableBlock.rows.length;
      const copiedRows = copiedSelection?.type === 'rows'
        ? copiedSelection.values.map((row) => [...row])
        : copiedSelection?.type === 'row'
          ? [[...copiedSelection.values]]
          : null;
      const rowsToInsert = copiedRows || Array.from(
        { length: rowRange ? rowRange.endIndex - rowRange.startIndex + 1 : 1 },
        () => Array(columns).fill('')
      );

      const normalizedRows = rowsToInsert.map((row) => {
        const nextRow = [...row];
        while (nextRow.length < columns) {
          nextRow.push('');
        }
        return nextRow.slice(0, columns);
      });

      tableBlock.rows.splice(insertIndex, 0, ...normalizedRows);
      selection = normalizedRows.length > 1
        ? createLineRangeSelection(selection.blockIndex, 'row', insertIndex, insertIndex + normalizedRows.length - 1)
        : createLineSelection(selection.blockIndex, insertIndex, null);
      render();
      markDirty();
    }

    function addColumn(tableBlock) {
      const columnCount = getColumnCount(tableBlock.rows);
      const columnRange = getSelectedColumnRange();
      const insertIndex = columnRange ? columnRange.endIndex + 1 : columnCount;
      const copiedColumns = copiedSelection?.type === 'columns'
        ? copiedSelection.values.map((row) => [...row])
        : null;
      const copiedValues = copiedSelection?.type === 'column' ? [...copiedSelection.values] : null;
      const insertCount = copiedColumns
        ? Math.max(1, ...copiedColumns.map((row) => row.length))
        : columnRange
          ? columnRange.endIndex - columnRange.startIndex + 1
          : 1;
      tableBlock.rows = tableBlock.rows.map((row, rowIndex) => {
        const nextRow = [...row];
        while (nextRow.length < columnCount) {
          nextRow.push('');
        }
        const insertedValues = copiedColumns
          ? Array.from({ length: insertCount }, (_, offset) => copiedColumns[rowIndex]?.[offset] ?? '')
          : Array.from({ length: insertCount }, (_, offset) => {
              if (copiedValues && offset === 0) {
                return copiedValues.shift() ?? '';
              }
              return '';
            });
        nextRow.splice(insertIndex, 0, ...insertedValues);
        return nextRow;
      });
      selection = insertCount > 1
        ? createLineRangeSelection(selection.blockIndex, 'column', insertIndex, insertIndex + insertCount - 1)
        : createLineSelection(selection.blockIndex, null, insertIndex);
      render();
      markDirty();
    }

    function createDefaultInsertedTableRows() {
      return [
        ['Column 1', 'Column 2'],
        ['', '']
      ];
    }

    function createTableRowsFromCopiedSelection() {
      if (!copiedSelection) {
        return null;
      }

      if (copiedSelection.type === 'table' || copiedSelection.type === 'cells') {
        return copiedSelection.values.length
          ? copiedSelection.values.map((row) => [...row])
          : null;
      }

      if (copiedSelection.type === 'row') {
        return copiedSelection.values.length ? [[...copiedSelection.values]] : null;
      }

      if (copiedSelection.type === 'rows') {
        return copiedSelection.values.length
          ? copiedSelection.values.map((row) => [...row])
          : null;
      }

      if (copiedSelection.type === 'column') {
        return copiedSelection.values.length
          ? copiedSelection.values.map((value) => [value])
          : null;
      }

      if (copiedSelection.type === 'columns') {
        return copiedSelection.values.length
          ? copiedSelection.values.map((row) => [...row])
          : null;
      }

      return null;
    }

    async function getClipboardTableRows() {
      if (!navigator.clipboard?.readText) {
        return null;
      }

      try {
        const text = await navigator.clipboard.readText();
        const rows = parseClipboardGrid(text);
        const isTableLike = rows.length > 1 || rows.some((row) => row.length > 1);
        return isTableLike ? rows : null;
      } catch {
        return null;
      }
    }

    async function addTableAfterTextBlock(blockIndex) {
      const clipboardRows = await getClipboardTableRows();
      const rows = clipboardRows || createTableRowsFromCopiedSelection() || createDefaultInsertedTableRows();
      blocks.splice(blockIndex + 1, 0, {
        type: 'table',
        rows
      });
      selection = createLineSelection(blockIndex + 1, 0, null);
      render();
      markDirty();
    }

    function deleteRow(tableBlock) {
      const rowRange = getSelectedRowRange();
      if (!rowRange || rowRange.startIndex === 0 || tableBlock.rows.length <= 1) {
        return false;
      }

      const deleteCount = rowRange.endIndex - rowRange.startIndex + 1;
      tableBlock.rows.splice(rowRange.startIndex, deleteCount);
      const nextRowIndex = Math.min(rowRange.startIndex, tableBlock.rows.length - 1);
      selection = createLineSelection(selection.blockIndex, nextRowIndex, null);
      render();
      markDirty();
      return true;
    }

    function deleteColumn(tableBlock) {
      const columnCount = getColumnCount(tableBlock.rows);
      const columnRange = getSelectedColumnRange();
      if (!columnRange || columnCount <= 1 || columnCount - (columnRange.endIndex - columnRange.startIndex + 1) < 1) {
        return false;
      }

      const deleteIndex = columnRange.startIndex;
      const deleteCount = columnRange.endIndex - columnRange.startIndex + 1;
      tableBlock.rows = tableBlock.rows.map((row) => {
        const nextRow = [...row];
        nextRow.splice(deleteIndex, deleteCount);
        return nextRow.length ? nextRow : [''];
      });
      const nextColumnIndex = Math.min(deleteIndex, getColumnCount(tableBlock.rows) - 1);
      selection = createLineSelection(selection.blockIndex, null, nextColumnIndex);
      render();
      markDirty();
      return true;
    }

    async function performAdd() {
      if (blocks[selection.blockIndex]?.type === 'text') {
        pushUndoState();
        await addTableAfterTextBlock(selection.blockIndex);
        return;
      }

      const tableBlock = getSelectedTableBlock();
      if (!tableBlock) {
        return;
      }

      pushUndoState();

      if (selection.rowIndex !== null) {
        addRow(tableBlock);
        return;
      }

      if (selection.columnIndex !== null) {
        addColumn(tableBlock);
        return;
      }

      addRow(tableBlock);
    }

    function performDelete() {
      const tableBlock = getSelectedTableBlock();
      if (!tableBlock) {
        return;
      }

      pushUndoState();

      const deleted = selection.rowIndex !== null
        ? deleteRow(tableBlock)
        : deleteColumn(tableBlock);

      if (!deleted) {
        undoStack.pop();
      }
    }

    function canUseTableShapeShortcut() {
      if (blocks[selection.blockIndex]?.type !== 'table') {
        return false;
      }

      return Boolean(getSelectedRowRange() || getSelectedColumnRange());
    }

    documentRoot.addEventListener('copy', copySelectedShape);
    documentRoot.addEventListener('paste', pasteSelectedCells);
    window.addEventListener('message', (event) => {
      const message = event.data;

      if (message?.type === 'refreshResult') {
        refreshing = false;

        if (!message.ok) {
          updateStatus();
          return;
        }

        blocks = message.blocks;
        undoStack = [];
        redoStack = [];
        tableHeights.clear();
        selection = getInitialSelection();
        dirty = false;
        saving = false;
        render();
        vscode.postMessage({ type: 'dirty', dirty: false, blocks: null });
        return;
      }

      if (message?.type === 'sourceState') {
        sourceChanged = Boolean(message.sourceChanged);
        sourceConflict = Boolean(message.conflict);
        updateStatus();
        return;
      }

      if (message?.type !== 'saveResult') {
        return;
      }

      saving = false;

      if (message.ok) {
        if (savingSerial === changeSerial) {
          markSaved();
          return;
        }

        dirty = true;
        updateStatus();
        vscode.postMessage({ type: 'dirty', dirty: true, blocks });
        return;
      }

      dirty = true;
      updateStatus();
      vscode.postMessage({ type: 'dirty', dirty: true, blocks });
    });

    window.addEventListener('beforeunload', (event) => {
      if (!dirty) {
        return;
      }

      event.preventDefault();
      event.returnValue = 'You have unsaved Markdown Spreadsheet changes.';
    });

    window.addEventListener('mouseup', () => {
      dragSelection = null;
    });
    window.addEventListener('keydown', (event) => {
      const isShortcut = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const target = event.target;

      if (isShortcut && key === 'f') {
        event.preventDefault();
        openSearch(false);
        return;
      }

      if (isShortcut && key === 'h') {
        event.preventDefault();
        openSearch(true);
        requestAnimationFrame(() => {
          replaceInput.focus();
          replaceInput.select();
        });
        return;
      }

      if (isShortcut && key === 's') {
        event.preventDefault();
        saveDocument();
        return;
      }

      if (isShortcut && event.shiftKey && (key === '=' || key === '+') && canUseTableShapeShortcut()) {
        event.preventDefault();
        void performAdd();
        return;
      }

      if (isShortcut && !event.shiftKey && (key === '-' || key === '_') && canUseTableShapeShortcut()) {
        event.preventDefault();
        performDelete();
        return;
      }

      if (isShortcut && key === 'z') {
        event.preventDefault();
        undo();
        return;
      }

      if (isShortcut && key === 'y') {
        event.preventDefault();
        redo();
        return;
      }

      if (isShortcut && key === 'c') {
        copySelectedShape(event);
      }

      if (!event.metaKey && !event.ctrlKey && !event.altKey &&
        (event.key === 'Delete' || event.key === 'Backspace') &&
        isRangeSelection() &&
        isCellEditor(target) &&
        target.dataset.blockIndex === String(selection.blockIndex)) {
        event.preventDefault();
        clearFocusedSelection(target);
      }
    }, true);

    document.getElementById('add').addEventListener('click', () => {
      void performAdd();
    });

    document.getElementById('delete').addEventListener('click', () => {
      performDelete();
    });

    document.getElementById('preview-diff').addEventListener('click', () => {
      vscode.postMessage({ type: 'previewDiff', blocks });
    });

    saveButton.addEventListener('click', () => {
      saveDocument();
    });

    refreshButton.addEventListener('click', () => {
      refreshDocument();
    });

    document.getElementById('find-next').addEventListener('click', () => {
      stepSearch(1);
    });

    document.getElementById('find-previous').addEventListener('click', () => {
      stepSearch(-1);
    });

    document.getElementById('replace-one').addEventListener('click', () => {
      replaceCurrentMatch();
    });

    document.getElementById('replace-all').addEventListener('click', () => {
      replaceAllMatches();
    });

    document.getElementById('close-search').addEventListener('click', () => {
      closeSearch();
    });

    findInput.addEventListener('input', () => {
      updateSearchMatches();
      if (searchState.activeIndex >= 0) {
        focusSearchMatch(searchState.matches[searchState.activeIndex]);
      }
    });

    replaceInput.addEventListener('input', () => {
      searchState.replace = replaceInput.value;
    });

    findInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        stepSearch(event.shiftKey ? -1 : 1);
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        closeSearch();
      }
    });

    replaceInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        replaceCurrentMatch();
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        closeSearch();
      }
    });

    render();
  </script>
</body>
</html>`;
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  for (let index = 0; index < 32; index += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }

  return text;
}

function getVscode() {
  if (!vscodeApi) {
    vscodeApi = require('vscode');
  }

  return vscodeApi;
}

module.exports = {
  activate,
  deactivate,
  createDefaultInsertedTableRows,
  createTableRowsFromCopiedSelection,
  findFirstMarkdownTable,
  parseMarkdownDocument,
  renderMarkdownDocument,
  renderMarkdownTable,
  shouldCreateSeparateEditorPanel
};
