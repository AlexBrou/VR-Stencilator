/*
 * trace-core.js — image → tracing outline processing.
 *
 * Pure functions on plain arrays, so it runs both in the browser (window.TraceCore)
 * and in Node (require) for testing.
 *
 * Pipeline:
 *   process(imageData, opts)  -> analysis at "work" resolution:
 *       { w, h, dist, palette?, labels?, numbers? }
 *       dist = distance (in work px) from every pixel to the nearest line pixel.
 *   renderLines(result, outW, outH, thickness) -> Uint8ClampedArray alpha mask at output size.
 *       Lines are drawn from the distance field, so they come out smooth and anti-aliased
 *       at any output size.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TraceCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- color ----------
  const SRGB_LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    SRGB_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  const fLab = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

  function rgbaToLab(data, n) {
    const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const j = i * 4;
      const al = data[j + 3] / 255;
      // composite transparent pixels over white
      const r = SRGB_LIN[data[j]] * al + (1 - al);
      const g = SRGB_LIN[data[j + 1]] * al + (1 - al);
      const b = SRGB_LIN[data[j + 2]] * al + (1 - al);
      const x = fLab((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
      const y = fLab(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
      const z = fLab((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
      L[i] = 116 * y - 16;
      A[i] = 500 * (x - y);
      B[i] = 200 * (y - z);
    }
    return [L, A, B];
  }

  function labToRgb(L, a, b) {
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    const inv = (t) => (t * t * t > 0.008856 ? t * t * t : (t - 16 / 116) / 7.787);
    const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
    const lin = [
      3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
      -0.969266 * X + 1.8760108 * Y + 0.041556 * Z,
      0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
    ];
    return lin.map((c) => {
      c = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
      return Math.max(0, Math.min(255, Math.round(c * 255)));
    });
  }

  // ---------- filters ----------
  function gaussianBlur(src, w, h, sigma) {
    if (sigma < 0.3) return src.slice();
    const r = Math.ceil(sigma * 3);
    const k = new Float32Array(2 * r + 1);
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let j = -r; j <= r; j++) {
          let xx = x + j;
          xx = xx < 0 ? 0 : xx >= w ? w - 1 : xx;
          s += k[j + r] * src[row + xx];
        }
        tmp[row + x] = s;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let j = -r; j <= r; j++) {
          let yy = y + j;
          yy = yy < 0 ? 0 : yy >= h ? h - 1 : yy;
          s += k[j + r] * tmp[yy * w + x];
        }
        out[y * w + x] = s;
      }
    }
    return out;
  }

  // Exact Euclidean distance transform (Felzenszwalb & Huttenlocher).
  function distanceTransform(mask, w, h) {
    const INF = 1e20, n = Math.max(w, h);
    const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
    const v = new Int32Array(n);
    const grid = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) grid[i] = mask[i] ? 0 : INF;
    const dt1 = (len) => {
      let k = 0;
      v[0] = 0; z[0] = -INF; z[1] = INF;
      for (let q = 1; q < len; q++) {
        let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= z[k]) {
          k--;
          s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        }
        k++; v[k] = q; z[k] = s; z[k + 1] = INF;
      }
      k = 0;
      for (let q = 0; q < len; q++) {
        while (z[k + 1] < q) k++;
        d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
      }
    };
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
      dt1(h);
      for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
      dt1(w);
      for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x]);
    }
    return out;
  }

  // Remove 8-connected groups of line pixels smaller than minSize.
  function removeSmallBits(mask, w, h, minSize) {
    if (minSize <= 1) return mask;
    const seen = new Uint8Array(w * h), stack = new Int32Array(w * h), comp = [];
    for (let s = 0; s < w * h; s++) {
      if (!mask[s] || seen[s]) continue;
      let sp = 0;
      comp.length = 0;
      stack[sp++] = s; seen[s] = 1;
      while (sp) {
        const i = stack[--sp];
        comp.push(i);
        const x = i % w, y = (i / w) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const j = yy * w + xx;
            if (mask[j] && !seen[j]) { seen[j] = 1; stack[sp++] = j; }
          }
        }
      }
      if (comp.length < minSize) for (const i of comp) mask[i] = 0;
    }
    return mask;
  }

  // Zhang–Suen thinning: reduce blobs/bands to 1px center lines (in place).
  function thin(img, w, h) {
    const del = new Int32Array(w * h);
    let changed = true;
    while (changed) {
      changed = false;
      for (let step = 0; step < 2; step++) {
        let nd = 0;
        for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            if (!img[i]) continue;
            const p2 = img[i - w], p3 = img[i - w + 1], p4 = img[i + 1], p5 = img[i + w + 1];
            const p6 = img[i + w], p7 = img[i + w - 1], p8 = img[i - 1], p9 = img[i - w - 1];
            const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
            if (B < 2 || B > 6) continue;
            const A = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) +
                      (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
            if (A !== 1) continue;
            if (step === 0 ? (p2 && p4 && p6) || (p4 && p6 && p8) : (p2 && p4 && p8) || (p2 && p6 && p8)) continue;
            del[nd++] = i;
          }
        }
        for (let j = 0; j < nd; j++) img[del[j]] = 0;
        if (nd) changed = true;
      }
    }
    return img;
  }

  // ---------- outline mode: color-aware Canny ----------
  function detectEdges(L, A, B, w, h, detail) {
    const n = w * h;
    const mag = new Float32Array(n), dir = new Uint8Array(n);
    const ch = [L, A, B];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        let best = 0, bgx = 0, bgy = 0;
        for (let c = 0; c < 3; c++) {
          const p = ch[c];
          const gx = p[i - w + 1] + 2 * p[i + 1] + p[i + w + 1] - p[i - w - 1] - 2 * p[i - 1] - p[i + w - 1];
          const gy = p[i + w - 1] + 2 * p[i + w] + p[i + w + 1] - p[i - w - 1] - 2 * p[i - w] - p[i - w + 1];
          const m = gx * gx + gy * gy;
          if (m > best) { best = m; bgx = gx; bgy = gy; }
        }
        mag[i] = Math.sqrt(best);
        const ax = Math.abs(bgx), ay = Math.abs(bgy);
        dir[i] = ay <= ax * 0.4142 ? 0 : ay > ax * 2.4142 ? 2 : bgx * bgy > 0 ? 1 : 3;
      }
    }
    // non-maximum suppression
    const nms = new Float32Array(n);
    let maxMag = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x, m = mag[i];
        if (m === 0) continue;
        let a, b;
        switch (dir[i]) {
          case 0: a = mag[i - 1]; b = mag[i + 1]; break;
          case 2: a = mag[i - w]; b = mag[i + w]; break;
          case 1: a = mag[i - w - 1]; b = mag[i + w + 1]; break;
          default: a = mag[i - w + 1]; b = mag[i + w - 1];
        }
        if (m >= a && m > b) { nms[i] = m; if (m > maxMag) maxMag = m; }
      }
    }
    // thresholds from the distribution of edge strengths, steered by "detail"
    const BINS = 2048, hist = new Uint32Array(BINS);
    let count = 0;
    for (let i = 0; i < n; i++) if (nms[i] > 0) { hist[Math.min(BINS - 1, ((nms[i] / maxMag) * BINS) | 0)]++; count++; }
    const q = 0.96 - (detail / 100) * 0.66; // detail 0 → only strongest 4%, 100 → 70%
    let acc = 0, bin = 0;
    for (; bin < BINS; bin++) { acc += hist[bin]; if (acc >= q * count) break; }
    // absolute floor so flat areas / jpeg noise never become lines
    const high = Math.max((bin / BINS) * maxMag, 24 - detail * 0.16);
    const low = high * 0.45;
    // hysteresis
    const out = new Uint8Array(n), stack = new Int32Array(n);
    let sp = 0;
    for (let i = 0; i < n; i++) if (nms[i] >= high) { out[i] = 1; stack[sp++] = i; }
    while (sp) {
      const i = stack[--sp];
      for (const o of [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1]) {
        const j = i + o;
        if (!out[j] && nms[j] >= low) { out[j] = 1; stack[sp++] = j; }
      }
    }
    return out;
  }

  // ---------- paint-by-numbers mode ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function kmeans(L, A, B, n, k) {
    const rnd = mulberry32(12345);
    const m = Math.min(n, 40000);
    const P = new Float32Array(m * 3);
    for (let s = 0; s < m; s++) {
      const i = m === n ? s : (rnd() * n) | 0;
      P[s * 3] = L[i]; P[s * 3 + 1] = A[i]; P[s * 3 + 2] = B[i];
    }
    const d2 = (s, C, c) => {
      const a = P[s * 3] - C[c * 3], b = P[s * 3 + 1] - C[c * 3 + 1], e = P[s * 3 + 2] - C[c * 3 + 2];
      return a * a + b * b + e * e;
    };
    // k-means++ init
    const C = new Float32Array(k * 3), D = new Float32Array(m).fill(Infinity);
    let pick = (rnd() * m) | 0;
    for (let c = 0; c < k; c++) {
      C[c * 3] = P[pick * 3]; C[c * 3 + 1] = P[pick * 3 + 1]; C[c * 3 + 2] = P[pick * 3 + 2];
      let total = 0;
      for (let s = 0; s < m; s++) { const d = d2(s, C, c); if (d < D[s]) D[s] = d; total += D[s]; }
      let r = rnd() * total;
      for (pick = 0; pick < m - 1; pick++) { r -= D[pick]; if (r <= 0) break; }
    }
    const asg = new Uint8Array(m);
    for (let it = 0; it < 25; it++) {
      const sum = new Float64Array(k * 3), cnt = new Uint32Array(k);
      let moved = 0;
      for (let s = 0; s < m; s++) {
        let best = 0, bd = Infinity;
        for (let c = 0; c < k; c++) { const d = d2(s, C, c); if (d < bd) { bd = d; best = c; } }
        if (asg[s] !== best) moved++;
        asg[s] = best; cnt[best]++;
        sum[best * 3] += P[s * 3]; sum[best * 3 + 1] += P[s * 3 + 1]; sum[best * 3 + 2] += P[s * 3 + 2];
      }
      for (let c = 0; c < k; c++) {
        if (cnt[c]) for (let j = 0; j < 3; j++) C[c * 3 + j] = sum[c * 3 + j] / cnt[c];
        else { const s = (rnd() * m) | 0; for (let j = 0; j < 3; j++) C[c * 3 + j] = P[s * 3 + j]; }
      }
      if (it > 0 && moved < m * 0.001) break;
    }
    return C;
  }

  // 4-connected components of equal label. Returns {comp, order, start, size, count}.
  function components(labels, w, h) {
    const n = w * h, comp = new Int32Array(n).fill(-1), order = new Int32Array(n);
    const start = [], size = [];
    let head = 0, count = 0;
    for (let s = 0; s < n; s++) {
      if (comp[s] >= 0) continue;
      const lab = labels[s];
      let tail = head;
      start.push(head);
      comp[s] = count; order[tail++] = s;
      while (head < tail) {
        const i = order[head++];
        const x = i % w;
        if (x > 0 && comp[i - 1] < 0 && labels[i - 1] === lab) { comp[i - 1] = count; order[tail++] = i - 1; }
        if (x < w - 1 && comp[i + 1] < 0 && labels[i + 1] === lab) { comp[i + 1] = count; order[tail++] = i + 1; }
        if (i >= w && comp[i - w] < 0 && labels[i - w] === lab) { comp[i - w] = count; order[tail++] = i - w; }
        if (i < n - w && comp[i + w] < 0 && labels[i + w] === lab) { comp[i + w] = count; order[tail++] = i + w; }
      }
      size.push(tail - start[count]);
      count++;
    }
    return { comp, order, start, size, count };
  }

  function majorityFilter(labels, w, h, k) {
    const out = labels.slice(), cnt = new Uint16Array(k);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        let best = labels[i];
        cnt.fill(0);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) cnt[labels[i + dy * w + dx]]++;
        for (let c = 0; c < k; c++) if (cnt[c] > cnt[best]) best = c;
        out[i] = best;
      }
    }
    return out;
  }

  // Morphological opening on the label map: parts of any region thinner than ~2r px
  // (e.g. dark outlines around shapes) are handed to the neighboring regions.
  function removeThinParts(labels, w, h, r) {
    const n = w * h, border = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const x = i % w, l = labels[i];
      border[i] = (x > 0 && labels[i - 1] !== l) || (x < w - 1 && labels[i + 1] !== l) ||
                  (i >= w && labels[i - w] !== l) || (i < n - w && labels[i + w] !== l) ? 1 : 0;
    }
    const inner = distanceTransform(border, w, h);
    const core = new Uint8Array(n);
    let any = false;
    for (let i = 0; i < n; i++) if (inner[i] >= r) { core[i] = 1; any = true; }
    if (!any) return labels;
    const reach = distanceTransform(core, w, h);
    const unknown = new Uint8Array(n), queue = new Int32Array(n);
    for (let i = 0; i < n; i++) if (reach[i] > r + 0.5) unknown[i] = 1;
    // grow the remaining regions into the removed pixels
    let tail = 0;
    for (let i = 0; i < n; i++) {
      if (unknown[i]) continue;
      const x = i % w;
      if ((x > 0 && unknown[i - 1]) || (x < w - 1 && unknown[i + 1]) || (i >= w && unknown[i - w]) || (i < n - w && unknown[i + w])) queue[tail++] = i;
    }
    for (let head = 0; head < tail; head++) {
      const i = queue[head], x = i % w, l = labels[i];
      if (x > 0 && unknown[i - 1]) { unknown[i - 1] = 0; labels[i - 1] = l; queue[tail++] = i - 1; }
      if (x < w - 1 && unknown[i + 1]) { unknown[i + 1] = 0; labels[i + 1] = l; queue[tail++] = i + 1; }
      if (i >= w && unknown[i - w]) { unknown[i - w] = 0; labels[i - w] = l; queue[tail++] = i - w; }
      if (i < n - w && unknown[i + w]) { unknown[i + w] = 0; labels[i + w] = l; queue[tail++] = i + w; }
    }
    return labels;
  }

  // Merge regions that are too small (area < minSize) or too thin to paint
  // (no point farther than minWidth px from the region's edge) into their main neighbor.
  function mergeSmallRegions(labels, w, h, k, minSize, minWidth) {
    const n = w * h, votes = new Uint32Array(k), border = new Uint8Array(n);
    for (let pass = 0; pass < 6; pass++) {
      const { comp, order, start, size, count } = components(labels, w, h);
      // how far inside each region can you get from its edge?
      for (let i = 0; i < n; i++) {
        const x = i % w, l = labels[i];
        border[i] = (x > 0 && labels[i - 1] !== l) || (x < w - 1 && labels[i + 1] !== l) ||
                    (i >= w && labels[i - w] !== l) || (i < n - w && labels[i + w] !== l) ? 1 : 0;
      }
      const dist = distanceTransform(border, w, h);
      let changed = false;
      for (let c = 0; c < count; c++) {
        if (size[c] >= minSize) {
          let maxD = 0;
          for (let p = start[c]; p < start[c] + size[c]; p++) if (dist[order[p]] > maxD) maxD = dist[order[p]];
          if (maxD >= minWidth) continue;
        }
        votes.fill(0);
        for (let p = start[c]; p < start[c] + size[c]; p++) {
          const i = order[p], x = i % w;
          if (x > 0 && comp[i - 1] !== c) votes[labels[i - 1]]++;
          if (x < w - 1 && comp[i + 1] !== c) votes[labels[i + 1]]++;
          if (i >= w && comp[i - w] !== c) votes[labels[i - w]]++;
          if (i < n - w && comp[i + w] !== c) votes[labels[i + w]]++;
        }
        let best = -1, bv = 0;
        for (let l = 0; l < k; l++) if (votes[l] > bv) { bv = votes[l]; best = l; }
        if (best < 0) continue;
        for (let p = start[c]; p < start[c] + size[c]; p++) labels[order[p]] = best;
        changed = true;
      }
      if (!changed) break;
    }
    return labels;
  }

  // ---------- main entry ----------
  /**
   * @param img  {width, height, data: RGBA bytes}
   * @param opts {mode: 'outline'|'ink'|'regions', detail 0-100, smoothing (sigma px), minSize px,
   *              colors 2-32}
   */
  function process(img, opts) {
    const w = img.width, h = img.height, n = w * h;
    let [L, A, B] = rgbaToLab(img.data, n);
    const sigma = opts.smoothing ?? 1.5;
    L = gaussianBlur(L, w, h, sigma);
    A = gaussianBlur(A, w, h, sigma);
    B = gaussianBlur(B, w, h, sigma);

    if (opts.mode === 'ink') {
      // dark strokes: pixels clearly darker than their surroundings, thinned to center lines
      const bg = gaussianBlur(L, w, h, Math.max(4, Math.min(w, h) / 120));
      const thr = 32 - (opts.detail ?? 50) * 0.28; // detail 0 → only very dark ink, 100 → faint pencil
      let ink = new Uint8Array(n);
      for (let i = 0; i < n; i++) ink[i] = bg[i] - L[i] > thr ? 1 : 0;
      removeSmallBits(ink, w, h, opts.minSize ?? 20);
      thin(ink, w, h);
      removeSmallBits(ink, w, h, opts.minSize ?? 20);
      return { mode: 'ink', w, h, dist: distanceTransform(ink, w, h) };
    }

    if (opts.mode !== 'regions') {
      const edges = detectEdges(L, A, B, w, h, opts.detail ?? 50);
      removeSmallBits(edges, w, h, opts.minSize ?? 20);
      return { mode: 'outline', w, h, dist: distanceTransform(edges, w, h) };
    }

    // regions
    const k = Math.max(2, Math.min(32, opts.colors ?? 8));
    const C = kmeans(L, A, B, n, k);
    let labels = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) {
        const a = L[i] - C[c * 3], b = A[i] - C[c * 3 + 1], e = B[i] - C[c * 3 + 2];
        const d = a * a + b * b + e * e;
        if (d < bd) { bd = d; best = c; }
      }
      labels[i] = best;
    }
    labels = majorityFilter(labels, w, h, k);
    labels = majorityFilter(labels, w, h, k);
    const minSize = opts.minSize ?? 20;
    const minWidth = Math.max(1, Math.min(5, minSize / 10));
    removeThinParts(labels, w, h, minWidth);
    mergeSmallRegions(labels, w, h, k, Math.max(4, minSize * 4), minWidth);

    // renumber used colors, light → dark
    const used = new Uint32Array(k);
    for (let i = 0; i < n; i++) used[labels[i]]++;
    const keep = [];
    for (let c = 0; c < k; c++) if (used[c]) keep.push(c);
    keep.sort((a, b) => C[b * 3] - C[a * 3]);
    const remap = new Uint8Array(k);
    keep.forEach((c, idx) => (remap[c] = idx));
    for (let i = 0; i < n; i++) labels[i] = remap[labels[i]];
    const palette = keep.map((c) => labToRgb(C[c * 3], C[c * 3 + 1], C[c * 3 + 2]));

    // boundaries between regions
    const edges = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if ((x < w - 1 && labels[i] !== labels[i + 1]) || (y < h - 1 && labels[i] !== labels[i + w])) edges[i] = 1;
      }
    }
    const dist = distanceTransform(edges, w, h);

    // number placement: the point in each region farthest from its edges (image border counts)
    for (let x = 0; x < w; x++) { edges[x] = 1; edges[(h - 1) * w + x] = 1; }
    for (let y = 0; y < h; y++) { edges[y * w] = 1; edges[y * w + w - 1] = 1; }
    const room = distanceTransform(edges, w, h);
    const { order, start, size, count } = components(labels, w, h);
    const numbers = [];
    for (let c = 0; c < count; c++) {
      let bi = -1, bd = 0;
      for (let p = start[c]; p < start[c] + size[c]; p++) {
        const i = order[p];
        if (room[i] > bd) { bd = room[i]; bi = i; }
      }
      if (bi >= 0 && bd >= 3) numbers.push({ x: (bi % w) + 0.5, y: ((bi / w) | 0) + 0.5, r: bd, color: labels[bi] });
    }
    return { mode: 'regions', w, h, dist, labels, palette, numbers };
  }

  /** Alpha mask (0-255) of lines `thickness` px wide at the output size. */
  function renderLines(res, outW, outH, thickness) {
    const { w, h, dist } = res;
    const sx = w / outW, sy = h / outH, scale = outW / w;
    const half = thickness / 2;
    const out = new Uint8ClampedArray(outW * outH);
    for (let Y = 0; Y < outH; Y++) {
      let v = (Y + 0.5) * sy - 0.5;
      v = v < 0 ? 0 : v > h - 1 ? h - 1 : v;
      const y0 = v | 0, y1 = Math.min(h - 1, y0 + 1), fy = v - y0;
      for (let X = 0; X < outW; X++) {
        let u = (X + 0.5) * sx - 0.5;
        u = u < 0 ? 0 : u > w - 1 ? w - 1 : u;
        const x0 = u | 0, x1 = Math.min(w - 1, x0 + 1), fx = u - x0;
        const top = dist[y0 * w + x0] * (1 - fx) + dist[y0 * w + x1] * fx;
        const bot = dist[y1 * w + x0] * (1 - fx) + dist[y1 * w + x1] * fx;
        const d = (top * (1 - fy) + bot * fy) * scale;
        const a = half + 0.5 - d;
        out[Y * outW + X] = a >= 1 ? 255 : a <= 0 ? 0 : a * 255;
      }
    }
    return out;
  }

  /** RGBA of the flat color regions at work resolution (regions mode). */
  function flatColors(res) {
    const { w, h, labels, palette } = res;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const c = palette[labels[i]];
      out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = 255;
    }
    return out;
  }

  /** Long side used for analysis: small images are upscaled, huge ones downscaled. */
  function workSize(width, height) {
    const long = Math.max(width, height);
    const target = Math.min(1600, Math.max(1000, long));
    const s = target / long;
    return [Math.max(1, Math.round(width * s)), Math.max(1, Math.round(height * s))];
  }

  return { process, renderLines, flatColors, workSize };
});
