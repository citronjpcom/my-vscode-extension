# Markdown Spreadsheet Prototype

VS Code extension prototype for editing Markdown documents that mix prose and tables.

## Goal

Validate whether `.md` files can be edited like Excel inside VS Code.

This prototype keeps prose as Markdown text and opens pipe tables as spreadsheet-like grids:

```md
| Item | Owner | Status |
| --- | --- | --- |
| Budget | Aki | Draft |
```

The command opens the active Markdown document as a single editing surface. Plain text looks like normal document text and remains directly editable, while each table is embedded as a grid. Pressing `Refresh` reloads the editor from the current VS Code document text, and pressing `Save Document` writes the full document back to the source file.

Keyboard shortcuts in the editor:

- `Cmd/Ctrl+S`: save
- `Cmd/Ctrl+Shift+=`: add, only when a table row or column is selected
- `Cmd/Ctrl+-`: delete, only when a table row or column is selected
- `Cmd/Ctrl+F`: find
- `Cmd/Ctrl+H`: replace

## Try It

1. Open this folder in VS Code.
2. Press `F5` to start the Extension Development Host.
3. Open `sample/sample.md`.
4. Run `Markdown Spreadsheet: Open Table Editor` from the Command Palette, or right-click a Markdown editor/file tab/file in Explorer and choose the same command.
5. Edit cells in the side panel and press `Save Document`.

## Build A Local Install Package

1. Install dependencies:

   ```sh
   npm install
   ```

2. Run checks:

   ```sh
   npm test
   ```

3. Build the VS Code install package:

   ```sh
   npm run package:vsix
   ```

4. Install the generated `.vsix` locally:

   ```sh
   code --install-extension markdown-spreadsheet-vscode-0.0.1.vsix
   ```

## Publish On GitHub

For GitHub distribution, publish the project folder as a repository and attach the generated `.vsix` file to a GitHub Release.

Recommended flow:

1. Create a GitHub repository.
2. Update the `repository` field in `package.json` to the real GitHub URL.
3. Commit the source files, excluding `node_modules/` and `*.vsix`.
4. Run `npm test`.
5. Run `npm run package:vsix`.
6. Create a GitHub Release such as `v0.0.1`.
7. Upload `markdown-spreadsheet-vscode-0.0.1.vsix` to that release.

Users can then download the `.vsix` from GitHub and install it with:

```sh
code --install-extension markdown-spreadsheet-vscode-0.0.1.vsix
```

## Current Scope

- Keeps prose and table sections together in one editor.
- Reads multiple Markdown tables in the active `.md` editor.
- Supports cell editing.
- Supports selecting table row and column headers.
- Supports adding rows or columns with one `Add` button based on the selected row or column header.
- Supports copying a selected row or column and inserting that copied shape with `Add`.
- Preserves front matter as dedicated document metadata.
- Keeps footnotes, task lists, and callouts round-tripping as normal Markdown content.
- Supports refreshing the editor from source Markdown before saving.
- Shows source-changed and source-conflict state when the underlying Markdown changes.
- Opens a diff preview between source Markdown and editor output before save when needed.
- Supports find and replace across Markdown text, table cells, Mermaid source, and image fields.
- Writes the edited full document back to Markdown.
- Uses `Alt` + arrow keys to move between cells.

## Next Validation Ideas

- Row and column deletion.
- Copy and paste ranges.
- CSV import and export.
- Front matter or fenced-block backed table data.
- Custom editor mode for `.md` files.
