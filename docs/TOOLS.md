# Editor tools

A reference for every tool, button and panel in the Paperloom PDF editor
(`/editor/`). Labels are written exactly as the UI shows them (button text,
tooltip or screen-reader name) so a tester can find each control.

The test checklist for these tools is in [E2E.md](E2E.md).

## Screen layout

| Area | What it holds |
|---|---|
| Header | Close, undo/redo, page navigation, zoom, theme, focus mode, pages panel, Find & Replace, Export, Download |
| Left tool rail | The eight editing tools |
| Options panel (left) | Settings for the active tool or the selected object |
| Page canvas (centre) | The rendered page; clicks act according to the active tool |
| Pages panel (right) | Thumbnails and page operations |
| Status bar (bottom) | Page size, active tool, selection, line and page counts |

On phones (narrower than 768px) the tool rail becomes a bottom strip, the Options
and Security panels open as bottom sheets, and the pages panel opens from the
"{N}p" button. See [Mobile](#mobile).

## Tool rail

Hover a tool (or focus it with the keyboard) to see its name and shortcut.
Choosing a tool reopens the Options panel unless Focus mode is on.

| Tool | Key | Click or drag on the page | Options panel |
|---|---|---|---|
| **Select** | V | Click text to edit it, an image or drawing to select it, a signature to select it, or a form field to fill it | Selection details, Form Fields |
| **Edit Text** | T or L | Click a text line to edit it in place; drag the **Drag** tab to move it; Enter commits, Shift+Enter adds a line below, Esc cancels | Text Properties, Form Fields |
| **Highlight** | H | Click a text line to highlight it, or drag to draw a freehand highlight | Highlight colour, Thickness |
| **Draw** | D | Drag to draw: Freehand, Line, Arrow, Rectangle or Ellipse | Shape, Draw colour, Brush Size |
| **Erase** | E | Drag over drawings and markup to remove them | Eraser Size |
| **Watermark** | W | Shows a live preview of the watermark | Watermark options |
| **Sign** | S | Places the active library signature; click a PDF signature field to fill it | Signature |
| **Security** | X | Used for drawing a redaction region | Document Security panel |

The **A** key switches straight to adding a text box.

Rail footer buttons:

- **Hide options panel / Show options panel** shows or hides the Options panel.
- **Shrink toolbar / Expand toolbar** narrows or widens the rail.

## Header

| Control | Shortcut | What it does |
|---|---|---|
| Close file & return home | — | Closes the document; if there are unsaved edits, asks **Keep editing**, **Discard changes** or **Download and close** |
| Unsaved badge | — | Shown while the document has edits that are not downloaded |
| Undo / Redo | Ctrl/Cmd+Z; Ctrl/Cmd+Shift+Z or Ctrl+Y | Steps through edit history |
| Previous page / Next page | Arrow keys (with nothing selected) | Page navigation; the counter shows "n / N" |
| Zoom out / Zoom in | Ctrl/Cmd+− / Ctrl/Cmd+=, Ctrl+wheel, pinch | 50%–400% |
| Switch to dark mode / Switch to white mode | — | Theme |
| Focus mode | — | Hides the Options and Pages panels (desktop only) |
| Pages panel | — | Shows or hides the right panel (desktop only) |
| Toggle Find & Replace | Ctrl/Cmd+F | Opens search |
| Clear | — | Removes all drawn paths; shown only while there are some |
| **Export** | — | Opens the Export Document panel |
| Print | Ctrl/Cmd+P | Desktop and tablet only. Prints the edited PDF through the browser's PDF viewer (vector quality); does not count as a download, so the Unsaved badge stays |
| **Download** | — | Saves the edited PDF without recompressing it |
| Download options (chevron) | Esc closes | Save Mode, Resolution and Compression for the download |

## Options panel

### Selecting objects (Select tool)

With nothing selected the panel shows **Select Tool** and how many images and
drawings were detected on the page.

- **Image Properties** (an embedded image): X, Y, W, H in points, Lock aspect ratio,
  Replace Image, Duplicate, Deselect, Delete. Deleting an image that covers most of the page
  asks for confirmation first.
- **Drawing / Signature** (a vector shape such as a card, box or drawn mark):
  read-only Type, Position and Size; **Duplicate**, **Deselect** and **Delete**.
  - Drag the dashed frame to move the drawing, drag one of the eight handles to
    resize it (Shift keeps it free-form), or use the arrow keys. The drawing keeps
    its colour, line style and layer; a thick line gets thicker when enlarged.
  - If the PDF paints the same shape several times on top of itself (common in
    PDFs printed from a browser), Delete removes all the copies in one undoable
    step, so the shape actually disappears.
  - Full-width background bands and page backgrounds are not selectable, so
    clicking empty page space selects nothing.
- **Duplicate** (or Ctrl/Cmd+D) places a copy 12pt to the right and below
  (mirrored near the page edge) and selects it, so pressing it again makes a
  row of copies. A drawing copy keeps the original's colour and layer; an
  image copy is placed on top of the page. Undo removes the copy.
- A text box or floating image you added has a **Duplicate** button (copy icon)
  next to its delete button.
- To copy a line of existing PDF text, use **Duplicate Line Below** or Shift+Enter
  while editing the line.

### Text Properties (Edit Text)

Text that the PDF stores as shaped text (`/ActualText`, which browsers use for
Chinese and other complex scripts when printing) cannot be edited or moved in
place; the editor shows a message and you can add a text box instead.

- **Font**, **Size** (− / + and presets 8–72), **Style** (Bold, Italic, Underline),
  **Color** (hex value and swatches), **Alignment**, **Opacity**.
- **Links**: **Scan for links** highlights existing links; **Add link to selection**
  asks for a URL (Save / Cancel). Hovering a link shows **Edit** and **Open Link**;
  Ctrl/Cmd+click opens it.
- **Add Content**: **Add Text Box** (click the page to place "New Text"),
  **Duplicate Line Below**, **Add Image**. When a table is detected:
  **Add Row Below**, **Add Column Right**.

### Draw, Highlight and Erase

- **Draw**: Shape (Freehand, Line, Arrow, Rectangle, Ellipse), Draw colour, Brush Size 1–20.
- **Highlight**: Highlight colour, Thickness 5–40.
- **Erase**: Eraser Size 5–50.

### Form Fields

Shown with Select and Edit Text when the page has fillable fields (amber boxes
on the page). Edit a text **Value**, toggle checkboxes and radio buttons, pick a
**Choice value**, or use **Flatten All** to turn the fields into plain page content.
Push-button actions are not supported.

### Watermark

- Tabs **Text**, **Image** (ADD IMAGE / Remove Image, PNG or JPEG) and **Shape**
  (Rectangle, Circle, Pill with text and colours).
- Live Preview, position grid (Top left … Bottom right, or Mosaic), Transparency,
  Rotation, Blend Mode, Size 10–300%, page range, and Layer (over or below the content).
- **Add watermark** applies it ("Watermark applied.").
- **Scan for Watermarks** finds existing ones; tick them and use **Remove Selected**
  (asks for confirmation) or **Cancel**.
- **Header, footer & page numbers** (bottom of the panel): six text fields
  (header and footer, left / centre / right) with the tokens `{page}`, `{total}`,
  `{date}` (YYYY-MM-DD) and `{bates}` (Bates prefix plus a six-digit number);
  font size, margin, page range and start number. **Add header & footer** writes
  Helvetica text on every page in the range, upright even on rotated pages; undo
  removes it. Only English letters, digits and punctuation are supported.

### Signature (Sign)

- **Create signature**: tabs **Draw**, **Upload** (PNG, JPG, SVG) and **Type**; a name;
  appearance template; keep for this session or save on this device; **Save to library**.
- Library entries: rename, Favorite, Duplicate, Delete, or drag onto the page.
- **PDF fields on page** and **Place library signature into field**.
- Selected signature: opacity, **Rotate** (+15°), **Lock** / **Unlock**, **Delete signature**.
  On the page it has Rotate 15°, Delete, Deselect and a rotation handle.
- Digital signing: **Import / manage certificates** (PEM, CRT, CER, DER, P12, PFX,
  KEY, or pasted PEM), **Digitally sign document**, optional **Request RFC 3161
  timestamp (TSA)**, **Validate all signatures** (Shift+V), **Enable LTV (embed DSS)**,
  and the **Signatures & revisions** list.

### Document Security (Security)

The panel shows a score out of 100 and four tabs:

| Tab | Controls |
|---|---|
| Inspect | Encryption, Revision, Metadata, Attachments, JavaScript, Integrity, Redact marks, Recommendations, **Rescan** |
| Protect | User and Owner passwords, Algorithm (AES-256, AES-128, RC4-128), Allow print / copy / modify, **Encrypt PDF**, **Remove encryption** |
| Clean | **Select redaction region**, **Apply selected region**, **Redact entire current page**, **Apply existing redaction marks**, **Sanitize document**, **Remove JavaScript**, **Remove attachments**, **Strip metadata**, **Optimize (keep security)** |
| Policy | Policy preset, passwords, **Apply policy** |

Redaction removes the content from the saved file; page and mark redaction ask
for confirmation first.

## Pages panel

| Control | What it does |
|---|---|
| Page capabilities information (ⓘ) | Explains what each page action does |
| Hide pages panel / Expand sidebar | Hide the panel or switch to a grid of thumbnails |
| **Merge PDF** | Appends the pages of another PDF |
| **Download current page** | Downloads the current page as its own PDF |
| **Download each page** | Downloads one PDF per page (asks first; needs 2+ pages) |
| **Remove current page** | Deletes the current page (asks first; undoable) |
| Between thumbnails | **Insert blank page**, **Rotate page N 90° clockwise**, **Insert PDF** |
| On a thumbnail | Drag to reorder, **Rotate page N**, **Move page N earlier/later** (↑ ↓), **Delete page** (red trash, asks first), click to open the page |

## Find & Replace and OCR

- **Search text**: Enter for the next match, Shift+Enter for the previous one; **Match case**.
- **Replace with**, then **Replace** or **Replace All**.
- **Recognize text (OCR)** appears above the search panel and adds
  searchable text recognised in the browser.

## Export and Download

- **Export Document**: PNG Image, JPEG Image, SVG Image or Plain Text; All Pages,
  the current page or a range; resolution (Screen, Standard, Print, High) and JPEG
  quality; **Export as …** downloads the result (several pages download as a zip).
- **Download** saves the PDF itself. **Download options** chooses Save Mode
  (Optimized or Quick), Resolution (Original, or 72 to 600 DPI) and Compression
  (Original, Extreme, High, Medium, Low).

## Keyboard shortcuts

Shortcuts are ignored while typing in a field, editing text, or while a dialog is open.

| Keys | Action |
|---|---|
| V T A H L D E S W X | Select, Edit Text, Add Text Box, Highlight, Edit Text, Draw, Erase, Sign, Watermark, Security |
| Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z or Ctrl+Y | Undo, Redo |
| Ctrl/Cmd+F | Find & Replace |
| Ctrl/Cmd+P | Print the edited PDF |
| Ctrl/Cmd+= / Ctrl/Cmd+− | Zoom in / out |
| Arrow keys | Move the selected image, drawing, text box or signature by 1pt (Shift: 10pt); otherwise change page |
| Ctrl/Cmd+D | Duplicate the selected image, drawing, text box or floating image |
| Delete / Backspace | Delete the selected signature, image or text box |
| Escape | Leave the text box; close menus |
| Hold Space | Temporary hand tool for panning |
| Shift+V (Sign tool) | Validate all signatures |

## Mobile

- Tools sit in a scrollable strip at the bottom; **Hide options / Show options**
  toggles the Options sheet.
- Options, Security, Export and Download options open as bottom sheets.
- Page thumbnails open from the "{N}p" button.
- Text editing shows **Done editing text** and **Cancel text edit** buttons.
- A selected signature gets large touch handles for moving, resizing and rotating.
