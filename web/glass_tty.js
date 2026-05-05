// Minimal glass-TTY for 86-DOS over a serial console: 80×24 character cells
// rendered to a canvas, with the control codes the SCP-era terminals (and
// MS-DOS BUFOUT) actually use: BS, HT, LF, FF, CR, BEL. No escape sequences
// — 86-DOS itself emits none, and an ADM-3A/VT-52 dumb-terminal feel is the
// closest analog to what an SCP user saw.

export function createGlassTTY(canvas, opts = {}) {
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;
  const cellW = opts.cellW ?? 9;
  const cellH = opts.cellH ?? 16;
  const fg = opts.fg ?? '#d4d4aa';   // P39-ish green-amber phosphor
  const bg = opts.bg ?? '#000';
  const fontPx = opts.fontPx ?? 14;

  canvas.width = cols * cellW;
  canvas.height = rows * cellH;
  const ctx = canvas.getContext('2d');
  ctx.font = `${fontPx}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
  ctx.textBaseline = 'top';

  const buf = new Uint8Array(cols * rows).fill(0x20);
  const dirty = new Uint8Array(cols * rows).fill(1);
  let row = 0, col = 0;
  let cursorOn = true;
  let lastBlink = performance.now();
  let lastDrawnCursor = { row: 0, col: 0, on: false };

  function paintCell(c, r) {
    const idx = r * cols + c;
    ctx.fillStyle = bg;
    ctx.fillRect(c * cellW, r * cellH, cellW, cellH);
    ctx.fillStyle = fg;
    ctx.fillText(String.fromCharCode(buf[idx]), c * cellW, r * cellH);
  }

  function scroll() {
    buf.copyWithin(0, cols, cols * rows);
    buf.fill(0x20, cols * (rows - 1));
    dirty.fill(1);
  }

  function newline() {
    row++;
    if (row >= rows) { scroll(); row = rows - 1; }
  }

  function advance() {
    col++;
    if (col >= cols) { col = 0; newline(); }
  }

  function markDirty(c, r) { dirty[r * cols + c] = 1; }

  function putByte(b) {
    // Cursor cell will need redraw regardless of where it ends up.
    markDirty(col, row);
    switch (b) {
      case 0x07: /* BEL — flash inverse for one frame */
        ctx.fillStyle = fg; ctx.fillRect(0, 0, canvas.width, canvas.height);
        dirty.fill(1);
        return;
      case 0x08: /* BS */
        if (col > 0) col--;
        else if (row > 0) { row--; col = cols - 1; }
        return;
      case 0x09: /* HT — to next 8-col boundary */
        do { advance(); } while (col % 8 !== 0);
        return;
      case 0x0A: /* LF */
        newline();
        return;
      case 0x0C: /* FF — clear */
        buf.fill(0x20); dirty.fill(1); row = 0; col = 0;
        return;
      case 0x0D: /* CR */
        col = 0;
        return;
    }
    if (b < 0x20 || b > 0x7E) return; // ignore other controls
    const idx = row * cols + col;
    buf[idx] = b;
    dirty[idx] = 1;
    advance();
    markDirty(col, row);
  }

  function render(now) {
    // Blink cursor at ~2 Hz.
    if (now - lastBlink > 500) { cursorOn = !cursorOn; lastBlink = now; markDirty(lastDrawnCursor.col, lastDrawnCursor.row); markDirty(col, row); }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!dirty[r * cols + c]) continue;
        dirty[r * cols + c] = 0;
        paintCell(c, r);
      }
    }
    if (cursorOn) {
      ctx.fillStyle = fg;
      ctx.fillRect(col * cellW, row * cellH + cellH - 2, cellW, 2);
    }
    lastDrawnCursor = { row, col, on: cursorOn };
  }

  return { putByte, render };
}
