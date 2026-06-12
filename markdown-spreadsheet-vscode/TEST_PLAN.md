# Markdown Spreadsheet Test Plan

VS Code extension upgrades should pass both the automated checks and the manual VS Code checks below.

## Automated Checks

Run from the extension project root:

```sh
npm test
```

Expected result:

- `node --check extension.js` passes.
- `test/roundtrip.test.js` passes.
- Markdown text, tables, Mermaid blocks, and images round-trip without unexpected conversion.

## VS Code Manual Regression

Use `sample/sample.md` in an Extension Development Host.

### 1. Explorer Context Menu

1. Right-click `sample/sample.md` in Explorer while the source file is not open.
2. Select `Markdown Spreadsheet: Open Table Editor`.

Expected result:

- The command appears in the context menu for `.md` files.
- The Markdown source editor is not opened just to launch the editor.
- The `Markdown Spreadsheet` editor opens in the active editor group.
- If `Welcome` was the active tab, it is replaced by `Markdown Spreadsheet`.

### 2. Source Tab Already Open

1. Open `sample/sample.md` normally in VS Code.
2. Right-click `sample/sample.md` in Explorer.
3. Select `Markdown Spreadsheet: Open Table Editor`.

Expected result:

- The `sample.md` source tab remains open.
- A new `Markdown Spreadsheet` tab is added in the same editor group for side-by-side comparison by tab switching.
- The source tab is not overwritten by the editor.
- If another `Markdown Spreadsheet` tab was already open, opening from the active source tab still creates a separate editor tab.

### 3. Editor Tab Already Open

1. Open `Markdown Spreadsheet`.
2. Keep the `Markdown Spreadsheet` tab active.
3. Right-click `sample/sample.md` again.
4. Select `Markdown Spreadsheet: Open Table Editor`.

Expected result:

- A second `Markdown Spreadsheet` tab is not created.
- The existing editor tab is reused and refreshed.
- This differs from opening while the Markdown source tab is active, which intentionally creates a new editor tab.

### 4. Save With Source Tab Open

1. Keep both `sample.md` and `Markdown Spreadsheet` open.
2. Change a text block or table cell in `Markdown Spreadsheet`.
3. Click `Save Document`.
4. Switch back to `sample.md`.

Expected result:

- The source tab reflects the edit.
- The Markdown file is saved to disk by the editor save action.
- The source tab should not require an extra manual save to persist the change.
- A success notification says `Markdown document saved.`

### 5. Refresh, Manual Save, And Unsaved Confirmation

Manual save:

1. Edit a table cell.
2. Confirm the status shows `unsaved changes`.
3. Click `Save Document`.

Expected result:

- The Markdown file is saved only after clicking `Save Document`.
- The status changes back to `saved`.
- A success notification says `Markdown document saved.`
- There is no auto save selector in the toolbar.

Keyboard shortcuts:

1. Press `Cmd/Ctrl+S`.
2. Press `Cmd/Ctrl+Shift+=`.
3. Press `Cmd/Ctrl+-`.
4. Press `Cmd/Ctrl+F`.
5. Press `Cmd/Ctrl+H`.

Expected result:

- `Cmd/Ctrl+S` performs the same save action as `Save Document`.
- `Cmd/Ctrl+Shift+=` performs the same add action as `Add` only when a table row or column is selected.
- `Cmd/Ctrl+-` performs the same delete action as `Delete` only when a table row or column is selected.
- When a text block or a single table cell is selected, those add and delete shortcuts do not fire.
- `Cmd/Ctrl+F` opens the find bar.
- `Cmd/Ctrl+H` opens the replace bar.

Refresh from source:

1. Edit `sample.md` in the source editor.
2. Do not save the source editor.
3. Switch to `Markdown Spreadsheet`.
4. Click `Refresh`.
5. Inspect the refreshed editor content.
6. Click `Save Document`.

Expected result:

- `Markdown Spreadsheet` reloads from the current source editor text, including unsaved source-editor changes.
- The status changes to `saved` after the refresh.
- `Save Document` persists the refreshed content to disk.

Source conflict and diff preview:

1. Open the same Markdown file in source and `Markdown Spreadsheet`.
2. Edit the source tab.
3. Edit the spreadsheet view without refreshing.
4. Click `Preview Diff`.
5. Click `Save Document`.

Expected result:

- The status shows `source changed` after the source tab edit.
- The status shows `source conflict` after both source and editor have diverged.
- `Preview Diff` opens a VS Code diff view between the current source and the editor output.
- Saving warns before overwriting source-side changes.

Reload confirmation:

1. Edit a table cell without saving.
2. Run `Markdown Spreadsheet: Open Table Editor` again for the same file.

Expected result:

- A modal warning says the editor has unsaved changes.
- Cancelling keeps the current editor content.
- Choosing `Discard and Reload` reloads from the Markdown file and discards unsaved editor changes.

Close confirmation:

1. Edit a table cell without saving.
2. Close the `Markdown Spreadsheet` tab.
3. Choose `Reopen Editor`.
4. Close the `Markdown Spreadsheet` tab again.
5. Choose `Discard`.

Expected result:

- A modal warning says the editor was closed with unsaved changes.
- Choosing `Reopen Editor` opens the editor again with the unsaved cell value restored.
- The restored editor still shows `unsaved changes`.
- Choosing `Discard` closes the editor without saving the unsaved value.
- Saving first removes the close warning.

### 6. Markdown Text Editing

1. Edit a non-table text block.
2. Keep paragraph breaks and Markdown syntax such as headings or backticks.
3. Save.

Expected result:

- Text appears naturally in the editor, more like a label than a large boxed textarea.
- Text remains editable.
- Saved Markdown keeps normal prose as prose, not as a table.

Front matter and Markdown-only constructs:

1. Open a Markdown file that starts with front matter.
2. Include a task list, footnote, and callout in the document.
3. Save without changing those structures.

Expected result:

- Front matter remains at the top of the file with its fence unchanged.
- Task lists, footnotes, and callouts round-trip without syntax changes.

### 7. Table Selection Rendering

1. Inspect the first row of each rendered table.

Expected result:

- No generated column-number row is shown above the Markdown header row.
- The Markdown header row, such as `Item / Owner / Status / Notes`, is the first visible row and shows row number `0`.
- Data rows below the Markdown header row are numbered from `1`.
- Fixed headers use an opaque background, so cell values do not show through while scrolling.
- The fixed header keeps a clear bottom border while the table body scrolls.
- Clicking a Markdown header cell selects that column.
- Double-clicking or pressing `F2` on a Markdown header cell edits the header text.

Selection rendering:

1. Select a column by clicking a Markdown header cell, such as `Item`.
2. Confirm the whole column is highlighted.
3. Click a single cell in that column.

Expected result:

- The column highlight is cleared.
- Only the clicked cell is rendered as selected.

Repeat the same pattern for row selection:

1. Select a row number.
2. Confirm the whole row is highlighted.
3. Click a single cell in that row.

Expected result:

- The row highlight is cleared.
- Only the clicked cell is rendered as selected.

### 8. Add Row And Column

Row add:

1. Select a row number.
2. Click `Add`.

Expected result:

- A new row is inserted immediately after the selected row.

Column add:

1. Select a column by clicking a Markdown header cell.
2. Click `Add`.

Expected result:

- A new column is inserted immediately after the selected column.
- The Markdown header row remains the first visible row.

Multiple row add:

1. Select a row number.
2. Hold `Shift` and select another row number.
3. Click `Add`.

Expected result:

- The full selected row range is highlighted.
- The same number of rows is inserted immediately after the selected row range.

Multiple column add:

1. Select a column by clicking a Markdown header cell.
2. Hold `Shift` and select another Markdown header cell.
3. Click `Add`.

Expected result:

- The full selected column range is highlighted.
- The same number of columns is inserted immediately after the selected column range.

### 9. Copy Then Add

Row copy:

1. Select a row number.
2. Copy with `Cmd+C`.
3. Click `Add`.

Expected result:

- A copied row is inserted after the selected row.

Column copy:

1. Select a column by clicking a Markdown header cell.
2. Copy with `Cmd+C`.
3. Click `Add`.

Expected result:

- A copied column is inserted after the selected column.

Horizontal overflow:

1. Add columns until the table exceeds the visible editor width.
2. Check the table viewport behavior.

Expected result:

- The table keeps a fixed column width.
- Horizontal scrolling becomes available inside the table viewport.
- There is no per-cell or per-column manual width resize control.

Text block add:

1. Click inside a `Write Markdown text` block.
2. Click `Add`.

Expected result:

- A new table block is inserted immediately after that text block.
- If the clipboard does not contain table-like data, the inserted table starts with default headers.

Copied table add:

1. Select an entire table and copy with `Cmd+C`.
2. Click inside a `Write Markdown text` block.
3. Click `Add`.

Expected result:

- A new table block is inserted immediately after that text block.
- The copied table contents are inserted into the new table as-is.

### 10. Delete Row And Column

Row delete:

1. Select a data row number.
2. Click `Delete`.
3. Press `Cmd+Z`.

Expected result:

- The selected data row is removed.
- The Markdown header row numbered `0` is not removed by row delete.
- `Cmd+Z` restores the deleted row.

Column delete:

1. Select a column by clicking a Markdown header cell.
2. Click `Delete`.
3. Press `Cmd+Z`.

Expected result:

- The selected column is removed.
- At least one column remains in the table.
- `Cmd+Z` restores the deleted column.

Multiple row delete:

1. Select a data row number.
2. Hold `Shift` and select another data row number.
3. Click `Delete`.

Expected result:

- The selected row range is removed together.
- The Markdown header row numbered `0` is not removed by row delete.

Multiple column delete:

1. Select a column by clicking a Markdown header cell.
2. Hold `Shift` and select another Markdown header cell.
3. Click `Delete`.

Expected result:

- The selected column range is removed together.
- At least one column remains in the table.

### 11. Undo And Redo

1. Edit a cell or add a row.
2. Press `Cmd+Z`.
3. Press `Cmd+Y`.

Expected result:

- `Cmd+Z` reverts the latest editor change.
- `Cmd+Y` reapplies the reverted change.

### 12. Find And Replace

Find:

1. Press `Cmd/Ctrl+F`.
2. Search for a value that appears in prose, a table cell, and Mermaid or image fields.
3. Use `Next` and `Previous`.

Expected result:

- The find bar opens without triggering the browser find UI.
- Matches can be navigated across Markdown text, table cells, Mermaid source, and image fields.
- The active match is focused and its text selection is visible.

Replace:

1. Press `Cmd/Ctrl+H`.
2. Enter a search term and a replacement term.
3. Click `Replace`.
4. Click `Replace All`.

Expected result:

- The replace row opens.
- `Replace` updates the active match only.
- `Replace All` updates every current match across the editor.
- Both actions can be undone with `Cmd+Z`.

### 13. Cell Keyboard Editing

Cell movement:

1. Click a table cell.
2. Press `ArrowRight`, `ArrowLeft`, `ArrowDown`, and `ArrowUp`.
3. Press `Tab`, `Shift+Tab`, `Enter`, and `Shift+Enter`.

Expected result:

- Arrow keys move the selected cell in the matching direction.
- `Tab` moves right.
- `Shift+Tab` moves left.
- `Enter` moves down.
- `Shift+Enter` moves up.
- Movement stays inside the current table.

Direct input:

1. Click a table cell.
2. Type new text without double-clicking or manually selecting the old text.

Expected result:

- The typed text replaces the selected cell value.
- The cell remains selected while editing.

Double-click editing:

1. Double-click a table cell.
2. Type text or use the arrow keys inside the cell text.
3. Press `Escape`.

Expected result:

- The cell enters text-editing mode without selecting the whole value.
- Arrow keys move the text cursor instead of moving to another cell.
- `Escape` returns the cell to whole-cell selection.

F2 editing:

1. Click a table cell.
2. Press `F2`.
3. Type text or use the arrow keys inside the cell text.
4. Press `Escape`.

Expected result:

- The selected cell enters the same text-editing mode as double-click.
- The typed text is inserted at the text cursor instead of replacing the whole value.
- Arrow keys move the text cursor instead of moving to another cell.
- `Escape` returns the cell to whole-cell selection.

Clear cell:

1. Click a table cell.
2. Press `Delete` or `Backspace`.

Expected result:

- The selected cell value is cleared.
- The action can be undone with `Cmd+Z`.

### 14. Multiple Cell Selection

Shift selection:

1. Click a table cell.
2. Hold `Shift` and click another cell in the same table.

Expected result:

- The rectangular range between the first and second cells is highlighted.
- The status text shows the selected cell range.

Drag selection:

1. Click and drag from one table cell to another table cell.

Expected result:

- The dragged rectangular range is highlighted.
- Clicking a single cell afterward returns to single-cell selection.

Keyboard range selection:

1. Click a table cell.
2. Press `Shift+ArrowRight`.
3. Press `Shift+ArrowDown`.

Expected result:

- The selected range expands in the direction of the arrow key.
- The active cell moves to the edge of the selected range.

Range actions:

1. Select multiple cells.
2. Press `Cmd+C`.
3. Paste into a plain text editor.
4. Select multiple cells again.
5. Press `Delete` or `Backspace`.
6. Press `Cmd+Z`.

Expected result:

- Copied cells are pasted as tab-separated rows.
- `Delete` or `Backspace` clears all selected cells.
- `Cmd+Z` restores the cleared cells.

Range paste:

1. Copy a 2x2 range from a spreadsheet app or from a plain text value like `A<Tab>B<Newline>C<Tab>D`.
2. Select a 2x2 cell range in the Markdown Spreadsheet editor.
3. Press `Cmd+V`.
4. Press `Cmd+Z`.

Expected result:

- The clipboard values are pasted into the selected range from its top-left cell.
- The pasted cells remain selected as a rectangular range.
- `Cmd+Z` restores the previous cell values.

Paste expansion:

1. Copy a cell range that is wider or taller than the remaining visible table area.
2. Select a destination cell near the right or bottom edge of a table.
3. Press `Cmd+V`.

Expected result:

- New rows or columns are added as needed.
- Existing Markdown text blocks below the table remain unchanged.

Excel paste:

1. Copy a multi-cell range from Excel.
2. Select a destination cell in the Markdown Spreadsheet editor.
3. Press `Cmd+V`.

Expected result:

- The Excel cells are pasted as matching rows and columns.
- Quoted values from Excel, including embedded tabs or line breaks, remain in the correct cells.
- New rows or columns are added as needed.

Navigation expansion:

1. Select the rightmost cell in a table row.
2. Press `Tab` or `ArrowRight`.
3. Select the bottom cell in a table column.
4. Press `Enter` or `ArrowDown`.
5. Press `Cmd+Z`.

Expected result:

- Moving past the right edge adds a new column and moves selection into it.
- Moving past the bottom edge adds a new row and moves selection into it.
- `Cmd+Z` reverts the automatic expansion.

### 15. Mermaid And Images

1. Open `sample/sample.md` in `Markdown Spreadsheet`.
2. Inspect the Mermaid block.
3. Inspect the image block.
4. Edit the Mermaid source or image fields.
5. Save.

Expected result:

- Mermaid preview renders.
- Image preview renders for the referenced image.
- Mermaid and image Markdown are preserved after save.

### 16. Sticky Toolbar

1. Scroll down in the editor.

Expected result:

- `Save Document` and `Add` remain fixed at the top of the editor view.
- It is not necessary to scroll back to the document top to save or add.

### 17. Table Height Resize

1. Open `sample/sample.md` in `Markdown Spreadsheet`.
2. Confirm the table initially fits close to its visible rows without a large blank area below them.
3. Move the cursor near the bottom edge of a table viewport.
4. Confirm the cursor changes to a vertical resize cursor.
5. Drag the bottom edge downward.
6. Drag the same bottom edge upward.
7. Focus the table viewport and press `ArrowDown`, then `ArrowUp`.

Expected result:

- The table viewport grows and shrinks without changing Markdown content.
- The resize cursor appears across a generous bottom-edge hit area.
- A small table cannot be expanded beyond its visible row count.
- There is no extra visible spacer below the table.
- Table scrolling still works inside the resized viewport.
- The header row remains fixed while the table body scrolls.

## Release Sign-Off

Before tagging or packaging a version:

- `npm test` has passed.
- All manual checks above have passed in an Extension Development Host.
- No unrelated workspace files were changed.
- `sample/sample.md` is in the expected saved state after manual testing.
