// Pure layout maths for the call grid (no DOM) so it can be reasoned about and tested.

const ASPECTS = [16 / 9, 4 / 3, 1, 3 / 4];

function bestFor(a, n, W, H, gap) {
  let best = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cw = (W - gap * (cols - 1)) / cols;
    const ch = (H - gap * (rows - 1)) / rows;
    const w = Math.min(cw, ch * a);
    const area = w * (w / a);
    if (!best || area > best.area) best = { w, h: w / a, cols, rows, a, area };
  }
  return best;
}

/** Best uniform tile size for n tiles in a W×H box. Prefers 16:9 unless another shape is clearly bigger. */
export function gridSizes(n, W, H, gap = 8, minW = 120) {
  if (n <= 0 || W <= 0 || H <= 0) return { w: 0, h: 0, cols: 0, rows: 0, overflow: false };
  const cands = ASPECTS.map(a => bestFor(a, n, W, H, gap));
  let best = cands[0];
  for (const c of cands.slice(1)) if (c.area > cands[0].area * 1.12 && c.area > best.area) best = c;

  let { w, h, cols, rows } = best;
  let overflow = false;
  if (w < minW) {                               // too many people for the screen: fixed size + scroll
    w = Math.min(minW, W);
    h = Math.round(w / best.a);
    cols = Math.max(1, Math.floor((W + gap) / (w + gap)));
    rows = Math.ceil(n / cols);
    overflow = rows * h + (rows - 1) * gap > H;
  }
  return { w: Math.floor(w), h: Math.floor(h), cols, rows, overflow };
}

/**
 * Spotlight: one big tile plus a strip of the others. Landscape boxes put the strip on the right
 * (column flow), portrait boxes put it underneath (row flow).
 */
export function spotlightSizes(n, W, H, gap = 8) {
  const others = Math.max(0, n - 1);
  if (!others) return { dir: "row", main: { w: Math.floor(W), h: Math.floor(H) }, strip: { w: 0, h: 0 } };
  const landscape = W >= H * 1.05;
  if (landscape) {
    // the strip is a column on the right: every small tile must fit in the height, however small the window is
    const room = Math.floor((H - gap * (others - 1)) / others);
    const sw = Math.round(Math.min(Math.max(W * 0.2, 60), 260));
    const sh = Math.max(16, Math.min(Math.round(sw * 9 / 16), room));
    return {
      dir: "column",
      main: { w: Math.max(16, Math.floor(W - Math.min(sw, Math.round(sh * 16 / 9)) - gap)), h: Math.floor(H) },
      strip: { w: Math.min(sw, Math.round(sh * 16 / 9)), h: sh }
    };
  }
  // portrait: the strip is a row underneath. It may take at most a third of the height, and all tiles must fit the width.
  const sh = Math.max(16, Math.min(Math.round(Math.min(Math.max(H * 0.17, 60), 150)), Math.floor((H - gap) / 3)));
  const sw = Math.max(16, Math.min(Math.round(sh * 16 / 9), Math.floor((W - gap * (others - 1)) / others)));
  return {
    dir: "row",
    main: { w: Math.floor(W), h: Math.max(16, Math.floor(H - sh - gap)) },
    strip: { w: sw, h: Math.min(sh, Math.round(sw * 9 / 16)) }
  };
}
