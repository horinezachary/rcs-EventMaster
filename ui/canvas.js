// Draws one screen destination to scale as SVG: the background, each layer's source where its window
// sits on the canvas (bottom layer first, so upper layers cover lower ones), and the output map as
// dashed lines. The same file is in ui/ and web/ (test/canvas.test.ts keeps them identical).
//
// A classic script, not a module: module pages run in a sandboxed frame (origin null), where an
// imported module needs CORS headers the host does not send. It sets window.E2Canvas.

(function () {

const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}, text) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, String(v));
  if (text != null) e.textContent = text;
  return e;
}

/** A steady colour per source, so the same source looks the same on every screen. */
function sourceHue(id) {
  return (id * 137.508) % 360;
}

function shortLayer(name) {
  const m = /^Layer\s*(\d+)/i.exec(name ?? '');
  return m ? `L${m[1]}` : (name ?? '');
}

/**
 * dest: a snapshot destination ({width, height, outputs, program, preview}); which: 'program' | 'preview'.
 * Returns an <svg> that scales to its box and keeps the canvas's aspect ratio.
 */
function drawCanvas(dest, which) {
  const W = Math.max(1, dest.width || 1920);
  const H = Math.max(1, dest.height || 1080);
  const unit = Math.min(W, H);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet', class: 'canvas', role: 'img' });
  const list = dest[which] ?? [];
  const bg = list.filter((l) => l.layer === null);
  const layers = list.filter((l) => l.layer !== null);
  svg.setAttribute('aria-label', `${dest.name} ${which}: ${list.map((l) => l.name).join(', ') || 'nothing'}`);

  svg.append(svgEl('rect', { x: 0, y: 0, width: W, height: H, fill: '#08090B' }));
  for (const b of bg) {
    const hue = sourceHue(b.source);
    svg.append(svgEl('rect', { x: 0, y: 0, width: W, height: H, fill: `hsl(${hue} 30% 16%)` }));
    svg.append(svgEl('text', { x: unit * 0.04, y: H - unit * 0.05, 'font-size': unit * 0.075, fill: `hsl(${hue} 40% 70%)`, 'font-weight': 600, 'font-family': 'Inter, system-ui, sans-serif' }, `BG ${b.name}`));
  }

  const unplaced = [];
  const placed = layers.filter((l) => l.window && l.window.w > 0 && l.window.h > 0);
  const covers = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  for (const l of layers) {
    const w = l.window;
    if (!w || w.w <= 0 || w.h <= 0) {
      unplaced.push(l);
      continue;
    }
    const hue = sourceHue(l.source);
    const g = svgEl('g');
    g.append(svgEl('rect', { x: w.x, y: w.y, width: w.w, height: w.h, fill: `hsl(${hue} 45% 26% / 0.92)`, stroke: `hsl(${hue} 70% 62%)`, 'stroke-width': unit * 0.006 }));
    const size = Math.max(unit * 0.05, Math.min(w.h * 0.2, w.w * 0.11, unit * 0.13));
    const cx = w.x + w.w / 2;
    const cy = w.y + w.h / 2;
    // A layer whose middle is covered by a layer above it names its source in its top left corner.
    const above = placed.slice(placed.indexOf(l) + 1);
    const hidden = above.some((u) => covers(u.window, cx, cy));
    const label = l.name + (l.frozen ? ' ❄' : '');
    if (hidden) {
      const small = Math.max(unit * 0.05, Math.min(size * 0.6, unit * 0.08));
      g.append(svgEl('text', { x: w.x + small * 1.6, y: w.y + small * 1.1, 'font-size': small, fill: '#F2F4F7', 'font-weight': 700, 'font-family': 'Inter, system-ui, sans-serif' }, label));
    } else {
      g.append(svgEl('text', { x: cx, y: cy + size * 0.35, 'font-size': size, 'text-anchor': 'middle', fill: '#F2F4F7', 'font-weight': 700, 'font-family': 'Inter, system-ui, sans-serif' }, label));
    }
    g.append(svgEl('text', { x: w.x + size * 0.35, y: w.y + size * 0.85, 'font-size': size * 0.55, fill: `hsl(${hue} 60% 78%)`, 'font-family': 'JetBrains Mono, ui-monospace, monospace' }, shortLayer(l.layer)));
    g.append(svgEl('title', {}, `${l.layer}: ${l.name} at ${w.x},${w.y} ${w.w}×${w.h}`));
    svg.append(g);
  }

  // The output map on top: where the canvas is cut into the processor's outputs.
  const outs = dest.outputs ?? [];
  if (outs.length > 1 || (outs[0] && (outs[0].w !== W || outs[0].h !== H))) {
    for (const o of outs) {
      svg.append(svgEl('rect', { x: o.x, y: o.y, width: o.w, height: o.h, fill: 'none', stroke: 'rgba(255,255,255,0.45)', 'stroke-width': unit * 0.004, 'stroke-dasharray': `${unit * 0.025} ${unit * 0.015}` }));
      svg.append(svgEl('text', { x: o.x + o.w - unit * 0.025, y: o.y + unit * 0.065, 'font-size': unit * 0.045, 'text-anchor': 'end', fill: 'rgba(255,255,255,0.6)', 'font-family': 'JetBrains Mono, ui-monospace, monospace' }, o.name));
    }
  }
  // The canvas edge, coloured by the page (preview green, program red).
  svg.append(svgEl('rect', { x: 0, y: 0, width: W, height: H, fill: 'none', class: 'edge', 'stroke-width': unit * 0.025 }));
  if (!list.length) svg.append(svgEl('text', { x: W / 2, y: H / 2, 'font-size': unit * 0.08, 'text-anchor': 'middle', fill: 'rgba(255,255,255,0.35)', 'font-family': 'Inter, system-ui, sans-serif' }, 'nothing on ' + which));
  if (unplaced.length) {
    svg.append(svgEl('text', { x: unit * 0.04, y: unit * 0.09, 'font-size': unit * 0.055, fill: 'rgba(255,255,255,0.7)', 'font-family': 'Inter, system-ui, sans-serif' }, `no position: ${unplaced.map((l) => l.name).join(', ')}`));
  }
  return svg;
}

  window.E2Canvas = { drawCanvas, sourceHue };
})();
