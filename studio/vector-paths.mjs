// Editable Vector Paths, SVG Parser/Serializer, 2D Affine Transforms,
// Hit-Testing (nonzero & evenodd), Planar Boolean Operations (union, subtract,
// intersect, exclude), and Axure RP 9 CustomShape (Shape: 300) Conversion.

const EPS = 1e-5;
const AREA_EPS = 1e-2;

function roundCoord(n) {
  return Math.round(Number(n) * 1000) / 1000;
}

function vectorError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

// ---------------------------------------------------------------------------
// 1. 2D Affine Transform Matrices [a, b, c, d, e, f]
//    x' = a*x + c*y + e
//    y' = b*x + d*y + f
// ---------------------------------------------------------------------------

export function identityMatrix() {
  return [1, 0, 0, 1, 0, 0];
}

export function multiplyMatrices(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export function isIdentityMatrix(m) {
  if (!Array.isArray(m) || m.length !== 6) return true;
  return (
    Math.abs(m[0] - 1) < EPS &&
    Math.abs(m[1]) < EPS &&
    Math.abs(m[2]) < EPS &&
    Math.abs(m[3] - 1) < EPS &&
    Math.abs(m[4]) < EPS &&
    Math.abs(m[5]) < EPS
  );
}

export function applyMatrixToPoint(m, pt) {
  if (!pt || typeof pt.x !== 'number' || typeof pt.y !== 'number') return pt;
  const [a, b, c, d, e, f] = m;
  return {
    x: roundCoord(a * pt.x + c * pt.y + e),
    y: roundCoord(b * pt.x + d * pt.y + f),
  };
}

export function parseVectorTransform(transformSpec, origin = { x: 0, y: 0 }) {
  if (!transformSpec) return identityMatrix();
  if (Array.isArray(transformSpec) && transformSpec.length === 6) {
    return transformSpec.map(Number);
  }
  if (typeof transformSpec === 'object') {
    let m = identityMatrix();
    const ox = Number(transformSpec.originX ?? origin.x ?? 0);
    const oy = Number(transformSpec.originY ?? origin.y ?? 0);
    if (transformSpec.translateX || transformSpec.translateY) {
      m = multiplyMatrices(m, [1, 0, 0, 1, Number(transformSpec.translateX || 0), Number(transformSpec.translateY || 0)]);
    }
    if (transformSpec.rotate) {
      const rad = (Number(transformSpec.rotate) * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      m = multiplyMatrices(m, [1, 0, 0, 1, ox, oy]);
      m = multiplyMatrices(m, [cos, sin, -sin, cos, 0, 0]);
      m = multiplyMatrices(m, [1, 0, 0, 1, -ox, -oy]);
    }
    if (transformSpec.scaleX !== undefined || transformSpec.scaleY !== undefined) {
      const sx = Number(transformSpec.scaleX ?? 1);
      const sy = Number(transformSpec.scaleY ?? sx);
      m = multiplyMatrices(m, [1, 0, 0, 1, ox, oy]);
      m = multiplyMatrices(m, [sx, 0, 0, sy, 0, 0]);
      m = multiplyMatrices(m, [1, 0, 0, 1, -ox, -oy]);
    }
    if (transformSpec.skewX) {
      const tan = Math.tan((Number(transformSpec.skewX) * Math.PI) / 180);
      m = multiplyMatrices(m, [1, 0, tan, 1, 0, 0]);
    }
    if (transformSpec.skewY) {
      const tan = Math.tan((Number(transformSpec.skewY) * Math.PI) / 180);
      m = multiplyMatrices(m, [1, tan, 0, 1, 0, 0]);
    }
    return m;
  }
  if (typeof transformSpec !== 'string') return identityMatrix();

  let m = identityMatrix();
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi;
  let match;
  while ((match = re.exec(transformSpec)) !== null) {
    const fn = match[1].toLowerCase();
    const args = match[2]
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(s => parseFloat(s));
    if (args.some(n => !Number.isFinite(n))) continue;
    if (fn === 'matrix' && args.length >= 6) {
      m = multiplyMatrices(m, args.slice(0, 6));
    } else if (fn === 'translate') {
      const tx = args[0] || 0;
      const ty = args[1] || 0;
      m = multiplyMatrices(m, [1, 0, 0, 1, tx, ty]);
    } else if (fn === 'scale') {
      const sx = args[0] ?? 1;
      const sy = args[1] ?? sx;
      m = multiplyMatrices(m, [sx, 0, 0, sy, 0, 0]);
    } else if (fn === 'rotate') {
      const deg = args[0] || 0;
      const cx = args[1] ?? origin.x ?? 0;
      const cy = args[2] ?? origin.y ?? 0;
      const rad = (deg * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      m = multiplyMatrices(m, [1, 0, 0, 1, cx, cy]);
      m = multiplyMatrices(m, [cos, sin, -sin, cos, 0, 0]);
      m = multiplyMatrices(m, [1, 0, 0, 1, -cx, -cy]);
    } else if (fn === 'skewx') {
      const tan = Math.tan(((args[0] || 0) * Math.PI) / 180);
      m = multiplyMatrices(m, [1, 0, tan, 1, 0, 0]);
    } else if (fn === 'skewy') {
      const tan = Math.tan(((args[0] || 0) * Math.PI) / 180);
      m = multiplyMatrices(m, [1, tan, 0, 1, 0, 0]);
    }
  }
  return m;
}

export function bakeVectorTransform(subpaths, transformSpec, origin = { x: 0, y: 0 }) {
  const m = Array.isArray(transformSpec) ? transformSpec : parseVectorTransform(transformSpec, origin);
  if (isIdentityMatrix(m)) return structuredClone(subpaths);
  return (subpaths || []).map(sp => ({
    ...sp,
    points: (sp.points || []).map(pt => {
      const next = {
        ...pt,
        ...applyMatrixToPoint(m, pt),
      };
      if (pt.in) next.in = applyMatrixToPoint(m, pt.in);
      if (pt.out) next.out = applyMatrixToPoint(m, pt.out);
      if (pt.q) next.q = applyMatrixToPoint(m, pt.q);
      return next;
    }),
  }));
}

// ---------------------------------------------------------------------------
// 2. SVG Path `d` Parser & Serializer + Basic SVG Shape Elements
// ---------------------------------------------------------------------------

// Convert one SVG elliptical arc segment (endpoint parameterization, W3C F.6.5)
// into cubic bezier segments of at most 90°, appended to the current subpath
// with the same in/out handle model as C commands.
function appendArcSegments(current, x1, y1, rx, ry, phi, largeArc, sweep, x2, y2) {
  if (x1 === x2 && y1 === y2) return; // SVG F.6.2: identical endpoints omit the arc
  if (!rx || !ry) { // SVG F.6.2: zero radius degrades to a straight line
    current.points.push({ x: roundCoord(x2), y: roundCoord(y2) });
    return;
  }
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    rx *= scale;
    ry *= scale;
  }
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const denom = rx2 * y1p * y1p + ry2 * x1p * x1p;
  const coSign = largeArc !== sweep ? 1 : -1;
  const co = denom ? coSign * Math.sqrt(Math.max(0, (rx2 * ry2 - denom) / denom)) : 0;
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const ccx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const ccy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;
  // Positive-direction angle from u to v in [0, 2π), per W3C F.6.5: acos gives
  // the magnitude and the cross-product sign extends it past π.
  const angleTo = (ux, uy, vx, vy) => {
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy) || 1;
    const value = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / len)));
    return ux * vy - uy * vx < 0 ? 2 * Math.PI - value : value;
  };
  const theta1 = angleTo(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angleTo((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep) delta -= 2 * Math.PI;
  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  const step = delta / segments;
  const dir = step < 0 ? -1 : 1;
  const kappa = (4 / 3) * Math.tan(Math.abs(step) / 4);
  let theta = theta1;
  // Point/handle positions are derived in the rotated (primed) frame and mapped
  // back through phi before writing coordinates.
  const toWorld = (px, py) => ({ x: ccx + cosPhi * px - sinPhi * py, y: ccy + sinPhi * px + cosPhi * py });
  for (let i = 0; i < segments; i++) {
    const t1 = theta;
    const t2 = theta + step;
    theta = t2;
    const e1 = toWorld(rx * Math.cos(t1), ry * Math.sin(t1));
    const e2 = toWorld(rx * Math.cos(t2), ry * Math.sin(t2));
    const tan1 = { x: -rx * Math.sin(t1), y: ry * Math.cos(t1) };
    const tan2 = { x: -rx * Math.sin(t2), y: ry * Math.cos(t2) };
    const prevPt = current.points[current.points.length - 1];
    prevPt.out = {
      x: roundCoord(e1.x + dir * kappa * (cosPhi * tan1.x - sinPhi * tan1.y)),
      y: roundCoord(e1.y + dir * kappa * (sinPhi * tan1.x + cosPhi * tan1.y)),
    };
    current.points.push({
      x: roundCoord(e2.x),
      y: roundCoord(e2.y),
      in: {
        x: roundCoord(e2.x - dir * kappa * (cosPhi * tan2.x - sinPhi * tan2.y)),
        y: roundCoord(e2.y - dir * kappa * (sinPhi * tan2.x + cosPhi * tan2.y)),
      },
    });
  }
}


export function parseSvgPathD(dString) {
  if (typeof dString !== 'string' || !dString.trim()) return [];
  const tokens = dString.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || [];
  const subpaths = [];
  let current = null;
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let prevCmd = '';
  let lastControl = null;

  let i = 0;
  const hasNum = () => i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i]);
  const nextNum = () => Number(tokens[i++]);
  // SVG arc flags may be written without separators ("a5 5 0 117 0" == flags 1,1);
  // split multi-digit all-boolean tokens one character at a time.
  const nextFlag = () => {
    const token = String(tokens[i]);
    if (/^[01][01]+$/.test(token)) {
      tokens[i] = token.slice(1);
      return Number(token[0]);
    }
    return nextNum();
  };

  const ensureSubpath = (x, y) => {
    if (!current || current.points.length === 0) {
      current = { closed: false, points: [{ x: roundCoord(x), y: roundCoord(y) }] };
      subpaths.push(current);
    }
  };

  while (i < tokens.length) {
    let cmd = tokens[i];
    if (/^[a-zA-Z]$/.test(cmd)) {
      i++;
    } else if (prevCmd) {
      cmd = prevCmd === 'M' ? 'L' : prevCmd === 'm' ? 'l' : prevCmd;
    } else {
      throw vectorError('E_VECTOR_PATH_SYNTAX', `SVG path 语法错误：起始命令前出现数值 "${cmd}"`);
    }

    const isRel = cmd === cmd.toLowerCase();
    const upper = cmd.toUpperCase();

    if (upper === 'M') {
      let first = true;
      while (hasNum()) {
        const nx = nextNum() + (isRel ? cx : 0);
        const ny = nextNum() + (isRel ? cy : 0);
        cx = nx;
        cy = ny;
        if (first) {
          startX = cx;
          startY = cy;
          current = { closed: false, points: [{ x: roundCoord(cx), y: roundCoord(cy) }] };
          subpaths.push(current);
          first = false;
        } else {
          current.points.push({ x: roundCoord(cx), y: roundCoord(cy) });
        }
      }
      lastControl = null;
    } else if (upper === 'L') {
      while (hasNum()) {
        const nx = nextNum() + (isRel ? cx : 0);
        const ny = nextNum() + (isRel ? cy : 0);
        ensureSubpath(cx, cy);
        cx = nx;
        cy = ny;
        current.points.push({ x: roundCoord(cx), y: roundCoord(cy) });
      }
      lastControl = null;
    } else if (upper === 'H') {
      while (hasNum()) {
        const nx = nextNum() + (isRel ? cx : 0);
        ensureSubpath(cx, cy);
        cx = nx;
        current.points.push({ x: roundCoord(cx), y: roundCoord(cy) });
      }
      lastControl = null;
    } else if (upper === 'V') {
      while (hasNum()) {
        const ny = nextNum() + (isRel ? cy : 0);
        ensureSubpath(cx, cy);
        cy = ny;
        current.points.push({ x: roundCoord(cx), y: roundCoord(cy) });
      }
      lastControl = null;
    } else if (upper === 'Q') {
      while (hasNum()) {
        const qx = nextNum() + (isRel ? cx : 0);
        const qy = nextNum() + (isRel ? cy : 0);
        const nx = nextNum() + (isRel ? cx : 0);
        const ny = nextNum() + (isRel ? cy : 0);
        ensureSubpath(cx, cy);
        const prevPt = current.points[current.points.length - 1];
        // Degree elevation of quadratic Bezier (P0, Q, P1) to cubic (P0, C1, C2, P1)
        const c1x = prevPt.x + (2 / 3) * (qx - prevPt.x);
        const c1y = prevPt.y + (2 / 3) * (qy - prevPt.y);
        const c2x = nx + (2 / 3) * (qx - nx);
        const c2y = ny + (2 / 3) * (qy - ny);
        prevPt.out = { x: roundCoord(c1x), y: roundCoord(c1y) };
        current.points.push({
          x: roundCoord(nx),
          y: roundCoord(ny),
          in: { x: roundCoord(c2x), y: roundCoord(c2y) },
          q: { x: roundCoord(qx), y: roundCoord(qy) },
        });
        cx = nx;
        cy = ny;
        lastControl = { x: qx, y: qy, kind: 'Q' };
      }
    } else if (upper === 'T') {
      while (hasNum()) {
        const nx = nextNum() + (isRel ? cx : 0);
        const ny = nextNum() + (isRel ? cy : 0);
        ensureSubpath(cx, cy);
        const prevPt = current.points[current.points.length - 1];
        const qx = lastControl?.kind === 'Q' ? 2 * cx - lastControl.x : cx;
        const qy = lastControl?.kind === 'Q' ? 2 * cy - lastControl.y : cy;
        const c1x = prevPt.x + (2 / 3) * (qx - prevPt.x);
        const c1y = prevPt.y + (2 / 3) * (qy - prevPt.y);
        const c2x = nx + (2 / 3) * (qx - nx);
        const c2y = ny + (2 / 3) * (qy - ny);
        prevPt.out = { x: roundCoord(c1x), y: roundCoord(c1y) };
        current.points.push({
          x: roundCoord(nx),
          y: roundCoord(ny),
          in: { x: roundCoord(c2x), y: roundCoord(c2y) },
          q: { x: roundCoord(qx), y: roundCoord(qy) },
        });
        cx = nx;
        cy = ny;
        lastControl = { x: qx, y: qy, kind: 'Q' };
      }
    } else if (upper === 'C') {
      while (hasNum()) {
        const c1x = nextNum() + (isRel ? cx : 0);
        const c1y = nextNum() + (isRel ? cy : 0);
        const c2x = nextNum() + (isRel ? cx : 0);
        const c2y = nextNum() + (isRel ? cy : 0);
        const nx = nextNum() + (isRel ? cx : 0);
        const ny = nextNum() + (isRel ? cy : 0);
        ensureSubpath(cx, cy);
        const prevPt = current.points[current.points.length - 1];
        prevPt.out = { x: roundCoord(c1x), y: roundCoord(c1y) };
        current.points.push({
          x: roundCoord(nx),
          y: roundCoord(ny),
          in: { x: roundCoord(c2x), y: roundCoord(c2y) },
        });
        cx = nx;
        cy = ny;
        lastControl = { x: c2x, y: c2y, kind: 'C' };
      }
    } else if (upper === 'S') {
      while (hasNum()) {
        const c2x = nextNum() + (isRel ? cx : 0);
        const c2y = nextNum() + (isRel ? cy : 0);
        const nx = nextNum() + (isRel ? cx : 0);
        const ny = nextNum() + (isRel ? cy : 0);
        ensureSubpath(cx, cy);
        const prevPt = current.points[current.points.length - 1];
        const c1x = lastControl?.kind === 'C' ? 2 * cx - lastControl.x : cx;
        const c1y = lastControl?.kind === 'C' ? 2 * cy - lastControl.y : cy;
        prevPt.out = { x: roundCoord(c1x), y: roundCoord(c1y) };
        current.points.push({
          x: roundCoord(nx),
          y: roundCoord(ny),
          in: { x: roundCoord(c2x), y: roundCoord(c2y) },
        });
        cx = nx;
        cy = ny;
        lastControl = { x: c2x, y: c2y, kind: 'C' };
      }
    } else if (upper === 'A') {
      while (hasNum()) {
        const rx = Math.abs(nextNum());
        const ry = Math.abs(nextNum());
        const xRot = (nextNum() * Math.PI) / 180;
        const largeArc = nextFlag() !== 0;
        const sweep = nextFlag() !== 0;
        const nx = nextNum() + (isRel ? cx : 0);
        const ny = nextNum() + (isRel ? cy : 0);
        ensureSubpath(cx, cy);
        appendArcSegments(current, cx, cy, rx, ry, xRot, largeArc, sweep, nx, ny);
        cx = nx;
        cy = ny;
        lastControl = null;
      }
    } else if (upper === 'Z') {
      if (current && current.points.length > 0) {
        current.closed = true;
        // If last point duplicates first point without closing handles, merge its `in` handle into first point
        if (current.points.length > 1) {
          const firstPt = current.points[0];
          const lastPt = current.points[current.points.length - 1];
          if (Math.hypot(firstPt.x - lastPt.x, firstPt.y - lastPt.y) < EPS) {
            if (lastPt.in) firstPt.in = lastPt.in;
            if (lastPt.q) firstPt.q = lastPt.q;
            current.points.pop();
          }
        }
      }
      cx = startX;
      cy = startY;
      lastControl = null;
    } else {
      throw vectorError('E_VECTOR_UNSUPPORTED_CMD', `不支持的 SVG 路径命令 "${cmd}"；支持 M/L/H/V/A/Q/T/C/S/Z`, { command: cmd });
    }
    prevCmd = cmd;
  }

  return markSubpathHoles(subpaths.filter(sp => sp.points.length > 0));
}

export function subpathsToSvgD(subpaths) {
  if (!Array.isArray(subpaths) || subpaths.length === 0) return '';
  const parts = [];
  for (const sp of subpaths) {
    const pts = sp?.points || [];
    if (pts.length === 0) continue;
    parts.push(`M ${roundCoord(pts[0].x)} ${roundCoord(pts[0].y)}`);
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const cur = pts[i];
      if (cur.q && (!prev.out || !cur.in)) {
        parts.push(`Q ${roundCoord(cur.q.x)} ${roundCoord(cur.q.y)} ${roundCoord(cur.x)} ${roundCoord(cur.y)}`);
      } else if (prev.out || cur.in) {
        const c1 = prev.out || { x: prev.x, y: prev.y };
        const c2 = cur.in || { x: cur.x, y: cur.y };
        parts.push(`C ${roundCoord(c1.x)} ${roundCoord(c1.y)} ${roundCoord(c2.x)} ${roundCoord(c2.y)} ${roundCoord(cur.x)} ${roundCoord(cur.y)}`);
      } else {
        parts.push(`L ${roundCoord(cur.x)} ${roundCoord(cur.y)}`);
      }
    }
    if (sp.closed && pts.length > 1) {
      const last = pts[pts.length - 1];
      const first = pts[0];
      if (last.out || first.in) {
        const c1 = last.out || { x: last.x, y: last.y };
        const c2 = first.in || { x: first.x, y: first.y };
        parts.push(`C ${roundCoord(c1.x)} ${roundCoord(c1.y)} ${roundCoord(c2.x)} ${roundCoord(c2.y)} ${roundCoord(first.x)} ${roundCoord(first.y)}`);
      }
      parts.push('Z');
    }
  }
  return parts.join(' ');
}

function parseSvgAttributes(tagText) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(tagText)) !== null) {
    attrs[m[1]] = m[2] ?? m[3] ?? '';
  }
  return attrs;
}

export function parseSvgMarkup(svgText) {
  if (typeof svgText !== 'string') {
    throw vectorError('E_VECTOR_SVG_INVALID', 'SVG 内容必须是字符串');
  }
  const trimmed = svgText.trim();
  if (!trimmed.startsWith('<')) {
    const subpaths = parseSvgPathD(trimmed);
    return {
      subpaths,
      d: subpathsToSvgD(subpaths),
      svgD: subpathsToSvgD(subpaths),
      fillRule: null,
      viewBox: null,
      transform: null,
      unsupportedElements: [],
    };
  }

  const unsupportedElements = [];
  const tagRe = /<\s*([a-zA-Z0-9:_-]+)([^>]*?)\/?>/g;
  const subpaths = [];
  let fillRule = 'nonzero';
  let viewBox = null;
  let rootTransform = null;
  let strokeLinecap = null;
  let strokeLinejoin = null;
  let strokeDasharray = null;
  let extractedFill = null;
  let extractedStroke = null;
  let extractedStrokeWidth = null;

  const ALLOWED_TAGS = new Set(['svg', 'g', 'path', 'polygon', 'polyline', 'rect', 'circle', 'ellipse', 'line', 'defs', 'title', 'desc']);
  let m;
  while ((m = tagRe.exec(trimmed)) !== null) {
    const rawTag = m[0];
    if (rawTag.startsWith('</') || rawTag.startsWith('<?') || rawTag.startsWith('<!')) continue;
    const tag = m[1].toLowerCase();
    const attrs = parseSvgAttributes(m[2] || '');

    if (!ALLOWED_TAGS.has(tag)) {
      unsupportedElements.push(tag);
      continue;
    }

    if (attrs['fill-rule'] || attrs.fillRule) {
      const fr = (attrs['fill-rule'] || attrs.fillRule).toLowerCase();
      if (fr === 'evenodd' || fr === 'nonzero') fillRule = fr;
    }
    if (attrs['stroke-linecap'] || attrs.strokeLinecap) strokeLinecap = attrs['stroke-linecap'] || attrs.strokeLinecap;
    if (attrs['stroke-linejoin'] || attrs.strokeLinejoin) strokeLinejoin = attrs['stroke-linejoin'] || attrs.strokeLinejoin;
    if (attrs['stroke-dasharray'] || attrs.strokeDasharray) strokeDasharray = attrs['stroke-dasharray'] || attrs.strokeDasharray;
    if (attrs.fill && attrs.fill !== 'none' && !extractedFill) extractedFill = attrs.fill;
    if (attrs.stroke && attrs.stroke !== 'none' && !extractedStroke) extractedStroke = attrs.stroke;
    if ((attrs['stroke-width'] || attrs.strokeWidth) && extractedStrokeWidth === null) {
      extractedStrokeWidth = parseFloat(attrs['stroke-width'] || attrs.strokeWidth);
    }

    if (tag === 'svg') {
      if (attrs.viewBox) {
        const vb = attrs.viewBox.trim().split(/[\s,]+/).map(Number);
        if (vb.length === 4 && vb.every(Number.isFinite)) {
          viewBox = { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
        }
      }
      if (attrs.transform) rootTransform = attrs.transform;
      continue;
    }
    if (tag === 'g') {
      if (attrs.transform) {
        rootTransform = rootTransform ? `${rootTransform} ${attrs.transform}` : attrs.transform;
      }
      continue;
    }

    let elemSubpaths = [];
    if (tag === 'path' && attrs.d) {
      elemSubpaths = parseSvgPathD(attrs.d);
    } else if ((tag === 'polygon' || tag === 'polyline') && attrs.points) {
      const nums = attrs.points.trim().split(/[\s,]+/).filter(Boolean).map(Number);
      const pts = [];
      for (let idx = 0; idx + 1 < nums.length; idx += 2) {
        pts.push({ x: roundCoord(nums[idx]), y: roundCoord(nums[idx + 1]) });
      }
      if (pts.length >= 2) {
        elemSubpaths = [{ closed: tag === 'polygon', points: pts }];
      }
    } else if (tag === 'rect') {
      const x = parseFloat(attrs.x || 0);
      const y = parseFloat(attrs.y || 0);
      const w = parseFloat(attrs.width || 0);
      const h = parseFloat(attrs.height || 0);
      if (w > 0 && h > 0) {
        elemSubpaths = [{
          closed: true,
          points: [
            { x: roundCoord(x), y: roundCoord(y) },
            { x: roundCoord(x + w), y: roundCoord(y) },
            { x: roundCoord(x + w), y: roundCoord(y + h) },
            { x: roundCoord(x), y: roundCoord(y + h) },
          ],
        }];
      }
    } else if (tag === 'circle' || tag === 'ellipse') {
      const cx = parseFloat(attrs.cx || 0);
      const cy = parseFloat(attrs.cy || 0);
      const rx = tag === 'circle' ? parseFloat(attrs.r || 0) : parseFloat(attrs.rx || 0);
      const ry = tag === 'circle' ? rx : parseFloat(attrs.ry || 0);
      if (rx > 0 && ry > 0) {
        const k = 0.5522847498;
        const ox = rx * k;
        const oy = ry * k;
        elemSubpaths = [{
          closed: true,
          points: [
            { x: roundCoord(cx), y: roundCoord(cy - ry), in: { x: roundCoord(cx - ox), y: roundCoord(cy - ry) }, out: { x: roundCoord(cx + ox), y: roundCoord(cy - ry) } },
            { x: roundCoord(cx + rx), y: roundCoord(cy), in: { x: roundCoord(cx + rx), y: roundCoord(cy - oy) }, out: { x: roundCoord(cx + rx), y: roundCoord(cy + oy) } },
            { x: roundCoord(cx), y: roundCoord(cy + ry), in: { x: roundCoord(cx + ox), y: roundCoord(cy + ry) }, out: { x: roundCoord(cx - ox), y: roundCoord(cy + ry) } },
            { x: roundCoord(cx - rx), y: roundCoord(cy), in: { x: roundCoord(cx - rx), y: roundCoord(cy + oy) }, out: { x: roundCoord(cx - rx), y: roundCoord(cy - oy) } },
          ],
        }];
      }
    } else if (tag === 'line') {
      const x1 = parseFloat(attrs.x1 || 0);
      const y1 = parseFloat(attrs.y1 || 0);
      const x2 = parseFloat(attrs.x2 || 0);
      const y2 = parseFloat(attrs.y2 || 0);
      elemSubpaths = [{
        closed: false,
        points: [
          { x: roundCoord(x1), y: roundCoord(y1) },
          { x: roundCoord(x2), y: roundCoord(y2) },
        ],
      }];
    }

    if (attrs.transform && elemSubpaths.length) {
      elemSubpaths = bakeVectorTransform(elemSubpaths, attrs.transform);
    }
    subpaths.push(...elemSubpaths);
  }

  const finalSubpaths = markSubpathHoles(rootTransform ? bakeVectorTransform(subpaths, rootTransform) : subpaths);
  const svgD = subpathsToSvgD(finalSubpaths);
  return {
    subpaths: finalSubpaths,
    d: svgD,
    svgD,
    fillRule,
    viewBox,
    transform: rootTransform,
    strokeLinecap,
    strokeLinejoin,
    strokeDasharray,
    extractedFill,
    extractedStroke,
    extractedStrokeWidth,
    unsupportedElements,
  };
}

// ---------------------------------------------------------------------------
// 3. Subpath Flattening, Winding / Hole Detection, Smoothing, and Hit-Testing
// ---------------------------------------------------------------------------

function sampleCubicBezier(p0, c1, c2, p1, steps = 16) {
  const pts = [];
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const mt = 1 - t;
    const x =
      mt * mt * mt * p0.x +
      3 * mt * mt * t * c1.x +
      3 * mt * t * t * c2.x +
      t * t * t * p1.x;
    const y =
      mt * mt * mt * p0.y +
      3 * mt * mt * t * c1.y +
      3 * mt * t * t * c2.y +
      t * t * t * p1.y;
    pts.push({ x: roundCoord(x), y: roundCoord(y) });
  }
  return pts;
}

export function flattenSubpath(subpath, curveSteps = 16) {
  const pts = subpath?.points || [];
  if (pts.length === 0) return [];
  const ring = [{ x: roundCoord(pts[0].x), y: roundCoord(pts[0].y) }];
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];
    if (prev.out || cur.in || cur.q) {
      const c1 = prev.out || (cur.q ? {
        x: prev.x + (2 / 3) * (cur.q.x - prev.x),
        y: prev.y + (2 / 3) * (cur.q.y - prev.y),
      } : { x: prev.x, y: prev.y });
      const c2 = cur.in || (cur.q ? {
        x: cur.x + (2 / 3) * (cur.q.x - cur.x),
        y: cur.y + (2 / 3) * (cur.q.y - cur.y),
      } : { x: cur.x, y: cur.y });
      ring.push(...sampleCubicBezier(prev, c1, c2, cur, curveSteps));
    } else {
      ring.push({ x: roundCoord(cur.x), y: roundCoord(cur.y) });
    }
  }
  if (subpath.closed && pts.length > 1) {
    const last = pts[pts.length - 1];
    const first = pts[0];
    if (last.out || first.in) {
      const c1 = last.out || { x: last.x, y: last.y };
      const c2 = first.in || { x: first.x, y: first.y };
      const segPts = sampleCubicBezier(last, c1, c2, first, curveSteps);
      // Drop the very last point if it coincides with ring[0]
      if (segPts.length > 0 && Math.hypot(segPts[segPts.length - 1].x - ring[0].x, segPts[segPts.length - 1].y - ring[0].y) < EPS) {
        segPts.pop();
      }
      ring.push(...segPts);
    } else if (Math.hypot(ring[ring.length - 1].x - ring[0].x, ring[ring.length - 1].y - ring[0].y) < EPS) {
      ring.pop();
    }
  }
  return ring;
}

// 与 flattenSubpath 相同的展平结果，但每个采样点附带曲线来源 c={p0,c1,c2,p1,t}（T-H-2 布尔保曲线用）。
// 直线点/角点的 c 为 null。布尔装配后按 c 把折线段还原为原生 in/out 手柄。
function flattenSubpathWithProvenance(subpath, curveSteps = 16) {
  const pts = subpath?.points || [];
  if (pts.length === 0) return [];
  const tag = pt => ({ x: roundCoord(pt.x), y: roundCoord(pt.y) });
  const ring = [{ ...tag(pts[0]), c: null }];
  const emitCubic = (p0, c1, c2, p1) => {
    for (let s = 1; s <= curveSteps; s++) {
      const t = s / curveSteps;
      const mt = 1 - t;
      ring.push({
        x: roundCoord(mt * mt * mt * p0.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * p1.x),
        y: roundCoord(mt * mt * mt * p0.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * p1.y),
        c: { p0, c1, c2, p1, t },
      });
    }
  };
  const handles = (prev, cur) => {
    const c1 = prev.out || (cur.q ? { x: prev.x + (2 / 3) * (cur.q.x - prev.x), y: prev.y + (2 / 3) * (cur.q.y - prev.y) } : { x: prev.x, y: prev.y });
    const c2 = cur.in || (cur.q ? { x: cur.x + (2 / 3) * (cur.q.x - cur.x), y: cur.y + (2 / 3) * (cur.q.y - cur.y) } : { x: cur.x, y: cur.y });
    return [c1, c2];
  };
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];
    if (prev.out || cur.in || cur.q) emitCubic(prev, ...handles(prev, cur), cur);
    else ring.push({ ...tag(cur), c: null });
  }
  if (subpath.closed && pts.length > 1) {
    const last = pts[pts.length - 1];
    const first = pts[0];
    if (last.out || first.in) {
      const c1 = last.out || { x: last.x, y: last.y };
      const c2 = first.in || { x: first.x, y: first.y };
      const segPts = [];
      for (let s = 1; s <= curveSteps; s++) {
        const t = s / curveSteps;
        const mt = 1 - t;
        segPts.push({
          x: roundCoord(mt * mt * mt * last.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * first.x),
          y: roundCoord(mt * mt * mt * last.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * first.y),
          c: { p0: last, c1, c2, p1: first, t },
        });
      }
      if (segPts.length > 0 && Math.hypot(segPts[segPts.length - 1].x - ring[0].x, segPts[segPts.length - 1].y - ring[0].y) < EPS) segPts.pop();
      ring.push(...segPts);
    } else if (Math.hypot(ring[ring.length - 1].x - ring[0].x, ring[ring.length - 1].y - ring[0].y) < EPS) {
      ring.pop();
    }
  }
  return ring;
}

// de Casteljau：从三次贝塞尔中截取参数区间 [tA,tB] 的子曲线控制点（含端点）
function subCubicRange(c, tA, tB) {
  const { p0, c1, c2, p1 } = c;
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  let q0 = p0, q1 = c1, q2 = c2, q3 = p1;
  if (tA > 1e-9) {
    const q01 = lerp(q0, q1, tA), q12 = lerp(q1, q2, tA), q23 = lerp(q2, q3, tA);
    const q012 = lerp(q01, q12, tA), q123 = lerp(q12, q23, tA);
    const r0 = lerp(q012, q123, tA);
    q0 = r0; q1 = q123; q2 = q23; q3 = q3;
  }
  if (tB < 1 - 1e-9) {
    const s = (tB - tA) / (1 - tA);
    const s01 = lerp(q0, q1, s), s12 = lerp(q1, q2, s), s23 = lerp(q2, q3, s);
    const s012 = lerp(s01, s12, s), s123 = lerp(s12, s23, s);
    const s0123 = lerp(s012, s123, s);
    // 左段取各层第一个：[q0, s01, s012, s0123]；右段才是 [s0123, s123, s23, q3]
    q3 = s0123; q1 = s01; q2 = s012;
  }
  return { p0: q0, c1: q1, c2: q2, p1: q3 };
}

// 布尔产物曲线还原（T-H-2）：同一源三次贝塞尔上的连续点对安装原生 in/out 手柄
// （子区间 de Casteljau 控制点），随后剥离 c 标记，svgD 恢复 C 段、形状与源曲线一致。
function restoreCurveHandles(subpaths) {
  const sameCubic = (a, b) => a && b && a.c1 === b.c1 && a.c2 === b.c2 && a.p0 === b.p0 && a.p1 === b.p1;
  for (const sp of subpaths) {
    const pts = sp.points || [];
    const pairIsCurve = (i, j) => sameCubic(pts[i]?.c, pts[j]?.c) && pts[j].c.t > pts[i].c.t;
    const n = pts.length;
    const wrap = sp.closed && n > 1 && pairIsCurve(n - 1, 0);
    for (let i = 0; i + 1 < n; i++) {
      if (!pairIsCurve(i, i + 1)) continue;
      const seg = subCubicRange(pts[i].c, pts[i].c.t, pts[i + 1].c.t);
      pts[i].out = { x: seg.c1.x, y: seg.c1.y };
      pts[i + 1].in = { x: seg.c2.x, y: seg.c2.y };
      // 处于连续曲线段内部的采样点吸附到曲线精确位置（交点顶点保持装配坐标不动）
      const inPrev = i > 0 && pairIsCurve(i - 1, i);
      if (inPrev) { pts[i].x = seg.p0.x; pts[i].y = seg.p0.y; }
    }
    if (wrap) {
      const seg = subCubicRange(pts[n - 1].c, pts[n - 1].c.t, pts[0].c.t);
      pts[n - 1].out = { x: seg.c1.x, y: seg.c1.y };
      pts[0].in = { x: seg.c2.x, y: seg.c2.y };
    }
    for (const p of pts) delete p.c;
  }
  return subpaths;
}

export function signedRingArea(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

export function ringWindingNumber(ring, px, py) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  let wn = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (a.y <= py) {
      if (b.y > py) {
        const isLeft = (b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y);
        if (isLeft > 0) wn++;
      }
    } else if (b.y <= py) {
      const isLeft = (b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y);
      if (isLeft < 0) wn--;
    }
  }
  return wn;
}

export function ringRayCrossings(ring, px, py) {
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  let crossings = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if ((a.y > py) !== (b.y > py)) {
      const xIntersect = a.x + ((py - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (px < xIntersect) crossings++;
    }
  }
  return crossings;
}

function pointToSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < EPS * EPS) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function markSubpathHoles(subpaths) {
  if (!Array.isArray(subpaths) || subpaths.length <= 1) return subpaths || [];
  const flattened = subpaths.map(sp => (sp.closed ? flattenSubpath(sp) : []));
  return subpaths.map((sp, idx) => {
    if (!sp.closed || flattened[idx].length < 3) return { ...sp, hole: false };
    const sample = flattened[idx][0];
    let containingCount = 0;
    for (let j = 0; j < subpaths.length; j++) {
      if (j === idx || !subpaths[j].closed || flattened[j].length < 3) continue;
      if (ringWindingNumber(flattened[j], sample.x, sample.y) !== 0) {
        containingCount++;
      }
    }
    const isHole = sp.hole !== undefined ? Boolean(sp.hole) : containingCount % 2 === 1;
    return { ...sp, hole: isHole };
  });
}

export function applySmoothHandles(subpaths, tension = 0.3) {
  return (subpaths || []).map(sp => {
    const pts = sp.points || [];
    if (pts.length < 3) return sp;
    const n = pts.length;
    const smoothed = pts.map((pt, i) => {
      if (pt.in || pt.out || pt.q) return pt;
      const prev = sp.closed ? pts[(i - 1 + n) % n] : pts[Math.max(0, i - 1)];
      const next = sp.closed ? pts[(i + 1) % n] : pts[Math.min(n - 1, i + 1)];
      const dx = (next.x - prev.x) * tension;
      const dy = (next.y - prev.y) * tension;
      const out = { ...pt };
      if (sp.closed || i > 0) {
        out.in = { x: roundCoord(pt.x - dx), y: roundCoord(pt.y - dy) };
      }
      if (sp.closed || i < n - 1) {
        out.out = { x: roundCoord(pt.x + dx), y: roundCoord(pt.y + dy) };
      }
      return out;
    });
    return { ...sp, points: smoothed };
  });
}

export function computeVectorBounds(subpaths) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const sp of subpaths || []) {
    const flat = flattenSubpath(sp, 16);
    for (const pt of flat) {
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    }
  }
  if (!Number.isFinite(minX)) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }
  return {
    minX: roundCoord(minX),
    minY: roundCoord(minY),
    maxX: roundCoord(maxX),
    maxY: roundCoord(maxY),
    width: roundCoord(Math.max(0, maxX - minX)),
    height: roundCoord(Math.max(0, maxY - minY)),
  };
}

export function hitTestVectorPath(vectorSpec, x, y, { strokeWidth = 2, hitTolerance = 4 } = {}) {
  const spec = normalizeVectorNodeSpec(vectorSpec);
  const subpaths = spec.subpaths || [];
  const fillRule = spec.fillRule || 'nonzero';

  // 1. Check control point handles first
  for (let sIdx = 0; sIdx < subpaths.length; sIdx++) {
    const pts = subpaths[sIdx].points || [];
    for (let pIdx = 0; pIdx < pts.length; pIdx++) {
      const pt = pts[pIdx];
      if (Math.hypot(x - pt.x, y - pt.y) <= hitTolerance) {
        return {
          hit: true,
          hitArea: 'control-point',
          handleKind: 'anchor',
          subpathIndex: sIdx,
          pointIndex: pIdx,
          fillRule,
        };
      }
      for (const hKey of ['in', 'out', 'q']) {
        if (pt[hKey] && Math.hypot(x - pt[hKey].x, y - pt[hKey].y) <= hitTolerance) {
          return {
            hit: true,
            hitArea: 'control-point',
            handleKind: hKey,
            subpathIndex: sIdx,
            pointIndex: pIdx,
            fillRule,
          };
        }
      }
    }
  }

  // 2. Check stroke hit
  const halfStroke = Math.max(Number(strokeWidth || 0) / 2, hitTolerance);
  let minStrokeDist = Infinity;
  let totalWinding = 0;
  let totalCrossings = 0;

  for (const sp of subpaths) {
    const ring = flattenSubpath(sp, 20);
    if (ring.length === 0) continue;
    const segCount = sp.closed ? ring.length : ring.length - 1;
    for (let i = 0; i < segCount; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const dist = pointToSegmentDistance(x, y, a.x, a.y, b.x, b.y);
      if (dist < minStrokeDist) minStrokeDist = dist;
    }
    if (sp.closed && ring.length >= 3) {
      totalWinding += ringWindingNumber(ring, x, y);
      totalCrossings += ringRayCrossings(ring, x, y);
    }
  }

  const insideFill = fillRule === 'evenodd' ? Math.abs(totalCrossings % 2) === 1 : totalWinding !== 0;
  const onStroke = minStrokeDist <= halfStroke;

  return {
    hit: insideFill || onStroke,
    hitArea: insideFill ? 'fill' : onStroke ? 'stroke' : null,
    insideFill,
    onStroke,
    windingNumber: totalWinding,
    parity: Math.abs(totalCrossings % 2),
    minStrokeDistance: roundCoord(minStrokeDist),
    fillRule,
  };
}

// ---------------------------------------------------------------------------
// 4. Node Vector Specification Normalization
// ---------------------------------------------------------------------------

function normalizePointObject(rawPt) {
  if (Array.isArray(rawPt) && rawPt.length >= 2) {
    return { x: roundCoord(rawPt[0]), y: roundCoord(rawPt[1]) };
  }
  if (!rawPt || typeof rawPt !== 'object') {
    throw vectorError('E_VECTOR_INVALID_POINT', '路径控制点必须是 {x, y} 对象或 [x, y] 数组');
  }
  const x = Number(rawPt.x);
  const y = Number(rawPt.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw vectorError('E_VECTOR_INVALID_POINT', '路径控制点坐标 x, y 必须是有效数值');
  }
  const pt = { x: roundCoord(x), y: roundCoord(y) };
  if (rawPt.q && typeof rawPt.q === 'object') {
    const qx = Number(rawPt.q.x);
    const qy = Number(rawPt.q.y);
    if (Number.isFinite(qx) && Number.isFinite(qy)) {
      pt.q = { x: roundCoord(qx), y: roundCoord(qy) };
    }
  }
  if (rawPt.in && typeof rawPt.in === 'object') {
    const ix = Number(rawPt.in.x);
    const iy = Number(rawPt.in.y);
    if (Number.isFinite(ix) && Number.isFinite(iy)) {
      pt.in = { x: roundCoord(ix), y: roundCoord(iy) };
    }
  }
  if (rawPt.out && typeof rawPt.out === 'object') {
    const ox = Number(rawPt.out.x);
    const oy = Number(rawPt.out.y);
    if (Number.isFinite(ox) && Number.isFinite(oy)) {
      pt.out = { x: roundCoord(ox), y: roundCoord(oy) };
    }
  }
  return pt;
}

function elevateQuadraticHandlesInSubpath(sp) {
  const pts = (sp.points || []).map(normalizePointObject);
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];
    if (cur.q && (!prev.out || !cur.in)) {
      prev.out = {
        x: roundCoord(prev.x + (2 / 3) * (cur.q.x - prev.x)),
        y: roundCoord(prev.y + (2 / 3) * (cur.q.y - prev.y)),
      };
      cur.in = {
        x: roundCoord(cur.x + (2 / 3) * (cur.q.x - cur.x)),
        y: roundCoord(cur.y + (2 / 3) * (cur.q.y - cur.y)),
      };
    }
  }
  return {
    closed: Boolean(sp.closed),
    ...(sp.hole !== undefined ? { hole: Boolean(sp.hole) } : {}),
    points: pts,
  };
}

export function normalizeVectorNodeSpec(node = {}) {
  if (typeof node === 'string') {
    const trimmed = node.trim();
    node = trimmed.startsWith('<') ? parseSvgMarkup(trimmed) : { points: { d: trimmed } };
  } else if (Array.isArray(node)) {
    node = node[0] && typeof node[0] === 'object' && Array.isArray(node[0].points)
      ? { points: { subpaths: node } }
      : { points: node };
  }
  let subpaths = [];
  let fillRule = node.fillRule === 'evenodd' || node.fillRule === 'nonzero' ? node.fillRule : 'nonzero';
  let viewBox = node.viewBox && typeof node.viewBox === 'object'
    ? {
        x: Number(node.viewBox.x || 0),
        y: Number(node.viewBox.y || 0),
        w: Number(node.viewBox.w || node.w || 100),
        h: Number(node.viewBox.h || node.h || 100),
      }
    : null;
  let transform = node.transform || null;
  let strokeLinecap = node.strokeLinecap || 'round';
  let strokeLinejoin = node.strokeLinejoin || 'round';
  let strokeDasharray = node.strokeDasharray || null;
  let unsupportedElements = Array.isArray(node.unsupportedElements) ? node.unsupportedElements : [];

  const rawPoints = node.points;
  const rawContent = typeof node.content === 'string'
    ? node.content.trim()
    : typeof node.d === 'string'
      ? node.d.trim()
      : typeof node.svgD === 'string'
        ? node.svgD.trim()
        : '';

  if (Array.isArray(node.subpaths) && node.subpaths.length > 0 && !rawPoints) {
    subpaths = node.subpaths.map(elevateQuadraticHandlesInSubpath);
  } else if (rawPoints && typeof rawPoints === 'object' && !Array.isArray(rawPoints)) {
    if (rawPoints.fillRule === 'evenodd' || rawPoints.fillRule === 'nonzero') {
      fillRule = rawPoints.fillRule;
    } else if (rawPoints.fillRule !== undefined) {
      throw vectorError('E_VECTOR_FILL_RULE', `不支持的填充规则 "${rawPoints.fillRule}"；仅支持 nonzero 或 evenodd`, { field: 'points.fillRule' });
    }
    if (rawPoints.viewBox && typeof rawPoints.viewBox === 'object') {
      viewBox = {
        x: Number(rawPoints.viewBox.x || 0),
        y: Number(rawPoints.viewBox.y || 0),
        w: Number(rawPoints.viewBox.w || node.w || 100),
        h: Number(rawPoints.viewBox.h || node.h || 100),
      };
    }
    if (rawPoints.transform) transform = rawPoints.transform;
    if (rawPoints.strokeLinecap) strokeLinecap = rawPoints.strokeLinecap;
    if (rawPoints.strokeLinejoin) strokeLinejoin = rawPoints.strokeLinejoin;
    if (rawPoints.strokeDasharray) strokeDasharray = rawPoints.strokeDasharray;

    if (Array.isArray(rawPoints.subpaths)) {
      subpaths = rawPoints.subpaths.map(elevateQuadraticHandlesInSubpath);
    } else if (Array.isArray(rawPoints.points)) {
      subpaths = [elevateQuadraticHandlesInSubpath({ closed: Boolean(rawPoints.closed), points: rawPoints.points })];
    } else if (typeof rawPoints.d === 'string') {
      subpaths = parseSvgPathD(rawPoints.d);
    }
  } else if (Array.isArray(rawPoints) && rawPoints.length > 0) {
    if (typeof rawPoints[0] === 'number') {
      // Sparkline numeric series: [10, 25, 18, 40]
      const w = typeof node.w === 'number' ? node.w : 120;
      const h = typeof node.h === 'number' ? node.h : 40;
      const minV = Math.min(...rawPoints);
      const maxV = Math.max(...rawPoints);
      const span = Math.max(1, maxV - minV);
      const pts = rawPoints.map((val, idx) => ({
        x: roundCoord((idx / Math.max(1, rawPoints.length - 1)) * w),
        y: roundCoord(h - ((Number(val) - minV) / span) * (h - 8) - 4),
      }));
      subpaths = [{ closed: false, points: pts }];
    } else if (rawPoints[0] && typeof rawPoints[0] === 'object' && Array.isArray(rawPoints[0].points)) {
      subpaths = rawPoints.map(elevateQuadraticHandlesInSubpath);
    } else {
      subpaths = [elevateQuadraticHandlesInSubpath({ closed: Boolean(node.closed), points: rawPoints })];
    }
  } else if (typeof rawPoints === 'string' && rawPoints.trim()) {
    const tp = rawPoints.trim();
    if (tp.startsWith('<') || /^[Mm]/.test(tp)) {
      subpaths = parseSvgMarkup(tp).subpaths;
    } else {
      const nums = tp.split(/[\s,]+/).filter(Boolean).map(Number);
      const pts = [];
      for (let idx = 0; idx + 1 < nums.length; idx += 2) {
        if (Number.isFinite(nums[idx]) && Number.isFinite(nums[idx + 1])) {
          pts.push({ x: roundCoord(nums[idx]), y: roundCoord(nums[idx + 1]) });
        }
      }
      if (pts.length >= 2) {
        subpaths = [{ closed: Boolean(node.closed), points: pts }];
      }
    }
  }

  if (subpaths.length === 0 && rawContent) {
    const parsedSvg = parseSvgMarkup(rawContent);
    subpaths = parsedSvg.subpaths;
    if (parsedSvg.fillRule && !node.fillRule && !rawPoints?.fillRule) fillRule = parsedSvg.fillRule;
    if (parsedSvg.viewBox && !viewBox) viewBox = parsedSvg.viewBox;
    if (parsedSvg.transform && !transform) transform = parsedSvg.transform;
    if (parsedSvg.strokeLinecap && !node.strokeLinecap && !rawPoints?.strokeLinecap) strokeLinecap = parsedSvg.strokeLinecap;
    if (parsedSvg.strokeLinejoin && !node.strokeLinejoin && !rawPoints?.strokeLinejoin) strokeLinejoin = parsedSvg.strokeLinejoin;
    if (parsedSvg.strokeDasharray && !strokeDasharray) strokeDasharray = parsedSvg.strokeDasharray;
    unsupportedElements = parsedSvg.unsupportedElements || [];
  }

  if (node.smooth && subpaths.length > 0) {
    subpaths = applySmoothHandles(subpaths);
  }

  if (transform && (typeof transform === 'object' ? transform.bake !== false : true) && rawPoints?.bakeTransform !== false) {
    // When transform is specified in points.transform with bake !== false, bake into subpaths
    if (rawPoints?.bakeTransform === true) {
      subpaths = bakeVectorTransform(subpaths, transform, {
        x: (typeof node.w === 'number' ? node.w : 100) / 2,
        y: (typeof node.h === 'number' ? node.h : 100) / 2,
      });
      transform = null;
    }
  }

  subpaths = markSubpathHoles(subpaths);
  const bounds = computeVectorBounds(subpaths);
  const w = typeof node.w === 'number' && node.w > 0 ? node.w : Math.max(24, Math.ceil(bounds.maxX || 100));
  const h = typeof node.h === 'number' && node.h > 0 ? node.h : Math.max(24, Math.ceil(bounds.maxY || 100));
  const resolvedViewBox = viewBox || {
    x: Math.min(0, bounds.minX),
    y: Math.min(0, bounds.minY),
    w: Math.max(w, bounds.maxX - Math.min(0, bounds.minX)),
    h: Math.max(h, bounds.maxY - Math.min(0, bounds.minY)),
  };

  const svgD = subpathsToSvgD(subpaths);
  const compat = classifyVectorNativeCompatibility({
    node,
    subpaths,
    fillRule,
    transform,
    strokeDasharray,
    strokeLinecap,
    strokeLinejoin,
    unsupportedElements,
  });

  return {
    subpaths,
    svgD,
    fillRule,
    viewBox: resolvedViewBox,
    bounds,
    transform,
    strokeLinecap,
    strokeLinejoin,
    strokeDasharray,
    unsupportedElements,
    nativeCompatibility: compat,
  };
}

// ---------------------------------------------------------------------------
// 5. Planar Arrangement Boolean Operations (union, subtract, intersect, exclude)
// ---------------------------------------------------------------------------

function segmentsIntersect(a1, a2, b1, b2) {
  const dax = a2.x - a1.x;
  const day = a2.y - a1.y;
  const dbx = b2.x - b1.x;
  const dby = b2.y - b1.y;
  const denom = dax * dby - day * dbx;
  if (Math.abs(denom) < 1e-9) {
    // Parallel / collinear: check if endpoints of B lie on A or vice versa
    const hits = [];
    const lenASq = dax * dax + day * day;
    const lenBSq = dbx * dbx + dby * dby;
    if (lenASq > EPS * EPS && lenBSq > EPS * EPS) {
      for (const [pt, tb] of [[b1, 0], [b2, 1]]) {
        const cross = (pt.x - a1.x) * day - (pt.y - a1.y) * dax;
        if (Math.abs(cross) / Math.sqrt(lenASq) < 1e-4) {
          const ta = ((pt.x - a1.x) * dax + (pt.y - a1.y) * day) / lenASq;
          if (ta >= -1e-5 && ta <= 1 + 1e-5) {
            hits.push({
              ta: Math.max(0, Math.min(1, ta)),
              tb,
              x: pt.x,
              y: pt.y,
              proper: false,
            });
          }
        }
      }
      for (const [pt, ta] of [[a1, 0], [a2, 1]]) {
        const cross = (pt.x - b1.x) * dby - (pt.y - b1.y) * dbx;
        if (Math.abs(cross) / Math.sqrt(lenBSq) < 1e-4) {
          const tb = ((pt.x - b1.x) * dbx + (pt.y - b1.y) * dby) / lenBSq;
          if (tb >= -1e-5 && tb <= 1 + 1e-5) {
            hits.push({
              ta,
              tb: Math.max(0, Math.min(1, tb)),
              x: pt.x,
              y: pt.y,
              proper: false,
            });
          }
        }
      }
    }
    return hits;
  }

  const dx = b1.x - a1.x;
  const dy = b1.y - a1.y;
  const ta = (dx * dby - dy * dbx) / denom;
  const tb = (dx * day - dy * dax) / denom;
  if (ta < -1e-6 || ta > 1 + 1e-6 || tb < -1e-6 || tb > 1 + 1e-6) {
    return [];
  }
  const clampedTa = Math.max(0, Math.min(1, ta));
  const clampedTb = Math.max(0, Math.min(1, tb));
  const proper = clampedTa > 1e-4 && clampedTa < 1 - 1e-4 && clampedTb > 1e-4 && clampedTb < 1 - 1e-4;
  return [{
    ta: clampedTa,
    tb: clampedTb,
    x: a1.x + clampedTa * dax,
    y: a1.y + clampedTa * day,
    proper,
  }];
}

function dedupeConsecutiveRingPoints(ring) {
  const out = [];
  for (const pt of ring || []) {
    if (out.length === 0 || Math.hypot(pt.x - out[out.length - 1].x, pt.y - out[out.length - 1].y) > 1e-3) {
      out.push({ ...pt, x: roundCoord(pt.x), y: roundCoord(pt.y) });
    }
  }
  if (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= 1e-3) {
    out.pop();
  }
  return out;
}

export function detectRingSelfIntersections(ring) {
  const pts = dedupeConsecutiveRingPoints(ring);
  const n = pts.length;
  const intersections = [];
  for (let i = 0; i < n; i++) {
    const a1 = pts[i];
    const a2 = pts[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent at vertex 0
      const b1 = pts[j];
      const b2 = pts[(j + 1) % n];
      const hits = segmentsIntersect(a1, a2, b1, b2);
      for (const h of hits) {
        // Ignore shared endpoints
        const atEndA = h.ta <= 1e-4 || h.ta >= 1 - 1e-4;
        const atEndB = h.tb <= 1e-4 || h.tb >= 1 - 1e-4;
        if (atEndA && atEndB) continue;
        intersections.push({
          edgeA: i,
          edgeB: j,
          x: roundCoord(h.x),
          y: roundCoord(h.y),
        });
      }
    }
  }
  return intersections;
}

function extractClosedRings(pathInput, label, { allowSelfIntersection = false } = {}) {
  const spec = normalizeVectorNodeSpec(pathInput);
  if (!spec.subpaths.length) {
    throw vectorError('E_VECTOR_DEGENERATE', `${label} 路径为空，无法执行布尔运算`);
  }
  const rings = [];
  for (let idx = 0; idx < spec.subpaths.length; idx++) {
    const sp = spec.subpaths[idx];
    if (!sp.closed) {
      throw vectorError('E_VECTOR_NOT_CLOSED', `${label} 的子路径 #${idx} 未闭合 (closed=false)，布尔运算要求闭合轮廓`, { subpathIndex: idx });
    }
    const flat = dedupeConsecutiveRingPoints(flattenSubpathWithProvenance(sp, 16));
    if (flat.length < 3) {
      throw vectorError('E_VECTOR_DEGENERATE', `${label} 的子路径 #${idx} 顶点数不足 (<3)，无法执行布尔运算`, { subpathIndex: idx });
    }
    const selfHits = detectRingSelfIntersections(flat);
    if (selfHits.length > 0 && !allowSelfIntersection) {
      throw vectorError('E_VECTOR_SELF_INTERSECTION', `${label} 的子路径 #${idx} 存在自交 (${selfHits.length} 处)，请先拆分或传入 allowSelfIntersection: true`, {
        subpathIndex: idx,
        intersections: selfHits,
      });
    }
    if (Math.abs(signedRingArea(flat)) < AREA_EPS) {
      throw vectorError('E_VECTOR_DEGENERATE', `${label} 的子路径 #${idx} 面积退化，无法执行布尔运算`, { subpathIndex: idx });
    }
    rings.push(flat);
  }
  return { rings, fillRule: spec.fillRule || 'nonzero' };
}

function pointInRingSet(rings, fillRule, px, py) {
  if (fillRule === 'evenodd') {
    let crossings = 0;
    for (const r of rings) crossings += ringRayCrossings(r, px, py);
    return Math.abs(crossings % 2) === 1;
  }
  let wn = 0;
  for (const r of rings) wn += ringWindingNumber(r, px, py);
  return wn !== 0;
}

function interiorSamplePointOfFace(faceRing) {
  // Find a strictly interior point of a simple polygon `faceRing`
  // by computing ear centroid or casting a vertical/horizontal line through the bbox center
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of faceRing) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const testYs = [
    (minY + maxY) / 2,
    minY + (maxY - minY) * 0.37,
    minY + (maxY - minY) * 0.63,
  ];
  for (const y of testYs) {
    const xs = [];
    for (let i = 0; i < faceRing.length; i++) {
      const a = faceRing[i];
      const b = faceRing[(i + 1) % faceRing.length];
      if ((a.y > y) !== (b.y > y)) {
        xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
    }
    xs.sort((u, v) => u - v);
    if (xs.length >= 2) {
      const midX = (xs[0] + xs[1]) / 2;
      if (Math.abs(xs[1] - xs[0]) > 1e-4 && ringWindingNumber(faceRing, midX, y) !== 0) {
        return { x: midX, y };
      }
    }
  }
  // Fallback to average of first 3 non-collinear vertices
  return {
    x: (faceRing[0].x + faceRing[1].x + faceRing[2].x) / 3,
    y: (faceRing[0].y + faceRing[1].y + faceRing[2].y) / 3,
  };
}

function simplifyCollinearRing(ring) {
  const pts = dedupeConsecutiveRingPoints(ring);
  if (pts.length <= 3) return pts;
  const simplified = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const cur = pts[i];
    const next = pts[(i + 1) % n];
    const ux = cur.x - prev.x;
    const uy = cur.y - prev.y;
    const vx = next.x - cur.x;
    const vy = next.y - cur.y;
    const lenU = Math.hypot(ux, uy);
    const lenV = Math.hypot(vx, vy);
    if (lenU > 1e-4 && lenV > 1e-4) {
      const cross = Math.abs(ux * vy - uy * vx) / (lenU * lenV);
      const dot = (ux * vx + uy * vy) / (lenU * lenV);
      // 曲线采样点保留（T-H-2）：共线合并交给曲线手柄还原，避免打断源贝塞尔的连续性
      if (cross < 1e-4 && dot > 0 && !cur.c) {
        continue; // collinear in same direction
      }
    }
    simplified.push(cur);
  }
  return simplified.length >= 3 ? simplified : pts;
}

export function resolveBooleanGroupPath(operation, operands, { x = 0, y = 0, allowSelfIntersection = false } = {}) {
  const paths = operands.map(node => {
    const vb = node.viewBox;
    const sx = node.w / vb.w, sy = node.h / vb.h;
    const dx = node.x - x, dy = node.y - y;
    let matrix = [sx, 0, 0, sy, dx - vb.x * sx, dy - vb.y * sy];
    if (node.rotation) {
      const rotation = parseVectorTransform(`rotate(${node.rotation})`, { x: dx + node.w / 2, y: dy + node.h / 2 });
      matrix = multiplyMatrices(rotation, matrix);
    }
    return { points: { subpaths: bakeVectorTransform(node.subpaths, matrix), fillRule: node.fillRule } };
  });
  const result = booleanVectorPaths(operation, paths[0], paths[1], { allowSelfIntersection });
  const left = Math.floor(result.bounds.minX), top = Math.floor(result.bounds.minY);
  const rect = {
    x: left, y: top,
    w: Math.max(1, Math.ceil(result.bounds.maxX) - left),
    h: Math.max(1, Math.ceil(result.bounds.maxY) - top),
  };
  const points = {
    subpaths: bakeVectorTransform(result.subpaths, [1, 0, 0, 1, -left, -top]),
    fillRule: result.fillRule,
    strokeLinecap: operands[0].strokeLinecap,
    strokeLinejoin: operands[0].strokeLinejoin,
    strokeDasharray: operands[0].strokeDasharray,
  };
  const viewBox = { x: 0, y: 0, w: rect.w, h: rect.h };
  return { rect, points, viewBox, svgD: subpathsToSvgD(points.subpaths) };
}

export function booleanVectorPaths(operation, pathA, pathB, options = {}) {
  const op = String(operation || '').toLowerCase();
  const VALID_OPS = new Set(['union', 'subtract', 'intersect', 'exclude', 'xor']);
  if (!VALID_OPS.has(op)) {
    throw vectorError('E_VECTOR_BOOLEAN_OP', `不支持的布尔运算 "${operation}"；支持 union / subtract / intersect / exclude`, { operation });
  }
  const normalizedOp = op === 'xor' ? 'exclude' : op;
  const setA = extractClosedRings(pathA, 'pathA', options);
  const setB = extractClosedRings(pathB, 'pathB', options);

  // 1. Collect all segments from A and B
  const rawSegments = [];
  for (const ring of setA.rings) {
    for (let i = 0; i < ring.length; i++) {
      rawSegments.push({ a: ring[i], b: ring[(i + 1) % ring.length], splitTs: [0, 1] });
    }
  }
  for (const ring of setB.rings) {
    for (let i = 0; i < ring.length; i++) {
      rawSegments.push({ a: ring[i], b: ring[(i + 1) % ring.length], splitTs: [0, 1] });
    }
  }

  // 2. Pairwise intersect all segments and collect split parameters
  for (let i = 0; i < rawSegments.length; i++) {
    const s1 = rawSegments[i];
    for (let j = i + 1; j < rawSegments.length; j++) {
      const s2 = rawSegments[j];
      const hits = segmentsIntersect(s1.a, s1.b, s2.a, s2.b);
      for (const h of hits) {
        s1.splitTs.push(h.ta);
        s2.splitTs.push(h.tb);
      }
    }
  }

  // 3. Snap vertices and build planar graph half-edges
  const vertices = [];
  const findOrAddVertex = (x, y) => {
    for (let i = 0; i < vertices.length; i++) {
      if (Math.hypot(vertices[i].x - x, vertices[i].y - y) < 1e-3) {
        return i;
      }
    }
    const id = vertices.length;
    vertices.push({ id, x: roundCoord(x), y: roundCoord(y), outgoing: [] });
    return id;
  };

  const undirectedEdgeSet = new Set();
  const halfEdges = [];

  for (const seg of rawSegments) {
    seg.splitTs.sort((u, v) => u - v);
    const uniqueTs = [];
    for (const t of seg.splitTs) {
      if (uniqueTs.length === 0 || Math.abs(t - uniqueTs[uniqueTs.length - 1]) > 1e-5) {
        uniqueTs.push(t);
      }
    }
    for (let k = 0; k + 1 < uniqueTs.length; k++) {
      const t0 = uniqueTs[k];
      const t1 = uniqueTs[k + 1];
      const x0 = seg.a.x + t0 * (seg.b.x - seg.a.x);
      const y0 = seg.a.y + t0 * (seg.b.y - seg.a.y);
      const x1 = seg.a.x + t1 * (seg.b.x - seg.a.x);
      const y1 = seg.a.y + t1 * (seg.b.y - seg.a.y);
      const u = findOrAddVertex(x0, y0);
      const v = findOrAddVertex(x1, y1);
      if (u === v) continue;
      const key = u < v ? `${u}:${v}` : `${v}:${u}`;
      if (undirectedEdgeSet.has(key)) continue;
      undirectedEdgeSet.add(key);

      // 曲线来源跟随边传递（T-H-2）：边端点在同一源贝塞尔上的参数按弦长比例插值
      const curveAt = tt => {
        if (!seg.a.c || !seg.b.c) return null;
        const ab = Math.hypot(seg.b.x - seg.a.x, seg.b.y - seg.a.y);
        if (ab < EPS) return seg.a.c;
        const frac = Math.hypot((seg.a.x + tt * (seg.b.x - seg.a.x)) - seg.a.x, (seg.a.y + tt * (seg.b.y - seg.a.y)) - seg.a.y) / ab;
        return { ...seg.a.c, t: seg.a.c.t + (seg.b.c.t - seg.a.c.t) * frac };
      };
      const fromC = curveAt(t0), toC = curveAt(t1);

      const heUV = halfEdges.length;
      const heVU = heUV + 1;
      const angleUV = Math.atan2(vertices[v].y - vertices[u].y, vertices[v].x - vertices[u].x);
      const angleVU = Math.atan2(vertices[u].y - vertices[v].y, vertices[u].x - vertices[v].x);
      halfEdges.push({ id: heUV, from: u, to: v, twin: heVU, angle: angleUV, visited: false, fromC, toC });
      halfEdges.push({ id: heVU, from: v, to: u, twin: heUV, angle: angleVU, visited: false, fromC: toC, toC: fromC });
      vertices[u].outgoing.push(heUV);
      vertices[v].outgoing.push(heVU);
    }
  }

  // 4. Classify each undirected elementary segment by sampling both sides of its midpoint
  const evalKeep = (inA, inB) => {
    if (normalizedOp === 'union') return inA || inB;
    if (normalizedOp === 'subtract') return inA && !inB;
    if (normalizedOp === 'intersect') return inA && inB;
    if (normalizedOp === 'exclude') return inA !== inB;
    return false;
  };

  const boundaryEdges = [];
  for (let eIdx = 0; eIdx < halfEdges.length; eIdx += 2) {
    const heUV = halfEdges[eIdx];
    const heVU = halfEdges[eIdx + 1];
    const u = vertices[heUV.from];
    const v = vertices[heUV.to];
    const dx = v.x - u.x;
    const dy = v.y - u.y;
    const len = Math.hypot(dx, dy);
    if (len < EPS) continue;
    const mx = (u.x + v.x) / 2;
    const my = (u.y + v.y) / 2;
    // Left normal in screen coordinates (points into interior of positive-signed-area ring)
    const nx = -dy / len;
    const ny = dx / len;
    const delta = Math.min(1e-2, len * 0.1);
    const leftPt = { x: mx + nx * delta, y: my + ny * delta };
    const rightPt = { x: mx - nx * delta, y: my - ny * delta };

    const keepLeft = evalKeep(
      pointInRingSet(setA.rings, setA.fillRule, leftPt.x, leftPt.y),
      pointInRingSet(setB.rings, setB.fillRule, leftPt.x, leftPt.y)
    );
    const keepRight = evalKeep(
      pointInRingSet(setA.rings, setA.fillRule, rightPt.x, rightPt.y),
      pointInRingSet(setB.rings, setB.fillRule, rightPt.x, rightPt.y)
    );

    if (keepLeft && !keepRight) {
      boundaryEdges.push(heUV);
    } else if (!keepLeft && keepRight) {
      boundaryEdges.push(heVU);
    }
  }

  // 7. Stitch boundary half-edges into closed rings
  // At vertices where multiple boundary cycles touch, pair incoming edge with the closest turn
  const outgoingBoundaryByVertex = new Map();
  for (const edge of boundaryEdges) {
    if (!outgoingBoundaryByVertex.has(edge.from)) outgoingBoundaryByVertex.set(edge.from, []);
    outgoingBoundaryByVertex.get(edge.from).push(edge);
  }
  for (const list of outgoingBoundaryByVertex.values()) {
    list.sort((a, b) => a.angle - b.angle);
  }

  const usedBoundaryEdges = new Set();
  const resultSubpaths = [];

  for (const startEdge of boundaryEdges) {
    if (usedBoundaryEdges.has(startEdge.id)) continue;
    const ringPts = [];
    let cur = startEdge;
    let guard = 0;
    while (cur && !usedBoundaryEdges.has(cur.id) && guard++ <= boundaryEdges.length + 2) {
      usedBoundaryEdges.add(cur.id);
      ringPts.push({ x: vertices[cur.from].x, y: vertices[cur.from].y, c: cur.fromC || null });
      const candidates = (outgoingBoundaryByVertex.get(cur.to) || []).filter(e => !usedBoundaryEdges.has(e.id));
      if (candidates.length === 0) break;
      if (candidates.length === 1) {
        cur = candidates[0];
      } else {
        // Pick the outgoing boundary edge that turns right-most relative to twin
        const twinAngle = halfEdges[cur.twin].angle;
        candidates.sort((a, b) => {
          const da = (twinAngle - a.angle + 4 * Math.PI) % (2 * Math.PI);
          const db = (twinAngle - b.angle + 4 * Math.PI) % (2 * Math.PI);
          return da - db;
        });
        cur = candidates[0];
      }
      if (cur.id === startEdge.id) break;
    }

    const simplified = simplifyCollinearRing(ringPts);
    if (simplified.length >= 3 && Math.abs(signedRingArea(simplified)) > AREA_EPS) {
      const area = signedRingArea(simplified);
      resultSubpaths.push({
        closed: true,
        hole: area < 0,
        points: simplified,
      });
    }
  }

  const finalSubpaths = markSubpathHoles(restoreCurveHandles(resultSubpaths));
  const svgD = subpathsToSvgD(finalSubpaths);
  const bounds = computeVectorBounds(finalSubpaths);
  const outerRingCount = finalSubpaths.filter(sp => !sp.hole).length;
  const holeRingCount = finalSubpaths.filter(sp => sp.hole).length;
  const totalArea = roundCoord(
    finalSubpaths.reduce((acc, sp) => acc + signedRingArea(flattenSubpath(sp)), 0)
  );

  const topology = {
    subpathCount: finalSubpaths.length,
    outerRingCount,
    holeRingCount,
    vertexCount: finalSubpaths.reduce((n, sp) => n + sp.points.length, 0),
    netArea: Math.abs(totalArea),
  };

  return {
    ok: true,
    operation: normalizedOp,
    subpaths: finalSubpaths,
    svgD,
    fillRule: 'nonzero',
    bounds,
    topology,
    diagnostics: topology,
  };
}

// ---------------------------------------------------------------------------
// 6. Axure RP 9 Custom VectorShape (Shape: 300, ControlPoints) Conversion &
//    Per-Node Native Compatibility Classification
// ---------------------------------------------------------------------------

export function classifyVectorNativeCompatibility({
  node = {},
  subpaths = [],
  fillRule = 'nonzero',
  transform = null,
  strokeDasharray = null,
  strokeLinecap = 'round',
  strokeLinejoin = 'round',
  unsupportedElements = [],
} = {}) {
  const fallbackReasons = [];
  if (unsupportedElements?.length) {
    fallbackReasons.push({
      feature: `svg-elements:${unsupportedElements.join(',')}`,
      reason: `SVG 包含未直接映射的标签 (${unsupportedElements.join(', ')})，仅转换已识别的矢量路径`,
    });
  }
  if (strokeDasharray) {
    fallbackReasons.push({
      feature: 'vector:strokeDasharray',
      reason: 'Axure RP 9 原生自定义形状 (Shape: 300) 使用标准描边样式表，不直接保留自定义 SVG stroke-dasharray 数组序列',
    });
  }
  if (fillRule === 'evenodd' && subpaths.length > 0) {
    // Check if any single subpath is self-overlapping or if hole rings have same winding as outer ring
    let hasSameWindingHole = false;
    const areas = subpaths.map(sp => signedRingArea(flattenSubpath(sp)));
    const outerSigns = subpaths.map((sp, i) => (!sp.hole ? Math.sign(areas[i]) : 0)).filter(Boolean);
    const primarySign = outerSigns[0] || 1;
    for (let i = 0; i < subpaths.length; i++) {
      const flat = flattenSubpath(subpaths[i]);
      if (detectRingSelfIntersections(flat).length > 0) {
        hasSameWindingHole = true;
      }
      if (subpaths[i].hole && Math.sign(areas[i]) === primarySign) {
        hasSameWindingHole = true;
      }
    }
    if (hasSameWindingHole) {
      fallbackReasons.push({
        feature: 'vector:fillRule:evenodd',
        reason: 'Axure RP 9 原生 VectorShape 按环绕方向填充；自交或同向嵌套的 evenodd 奇偶规则在宿主中有降级差异，画布权威源完整保留 evenodd',
      });
    }
  }
  if (node.threeDTransform || node.customFilter || node.backdropBlur) {
    fallbackReasons.push({
      feature: 'vector:browser-filter',
      reason: '浏览器 3D 变换或滤镜无法在 RP 9 VectorShape 中无损表示；基础可编辑矢量控制点仍导出为原生 Shape: 300',
    });
  }

  return {
    nativeEditable: subpaths.length > 0,
    nativeShapeCode: 300,
    nativeVectorMode: 'rp9-custom-shape-300',
    hasFallback: fallbackReasons.length > 0,
    fallbackReasons,
  };
}

export function buildRp9ControlPointsForSubpaths(subpaths, width, height, { fillRule = 'nonzero' } = {}) {
  const bounds = computeVectorBounds(subpaths);
  const w = Math.max(1, Number(width) || bounds.width || 100);
  const h = Math.max(1, Number(height) || bounds.height || 100);
  const offsetX = bounds.minX < 0 ? -bounds.minX : 0;
  const offsetY = bounds.minY < 0 ? -bounds.minY : 0;
  const normX = x => Math.max(0, Math.min(1, (Number(x) + offsetX) / w));
  const normY = y => Math.max(0, Math.min(1, (Number(y) + offsetY) / h));

  // If fillRule is evenodd or hole is marked, ensure hole subpaths have opposite winding to outer subpaths
  // so RP 9's native path renderer hollows out interior holes accurately!
  const orientedSubpaths = structuredClone(subpaths || []);
  let outerSign = 0;
  for (const sp of orientedSubpaths) {
    if (!sp.closed) continue;
    const area = signedRingArea(flattenSubpath(sp));
    if (!sp.hole && Math.abs(area) > EPS && outerSign === 0) {
      outerSign = Math.sign(area);
    }
  }
  if (outerSign !== 0) {
    for (const sp of orientedSubpaths) {
      if (!sp.closed || !sp.hole) continue;
      const area = signedRingArea(flattenSubpath(sp));
      if (Math.sign(area) === outerSign) {
        // Reverse point order and swap in/out handles
        sp.points.reverse();
        for (const pt of sp.points) {
          const tmp = pt.in;
          if (pt.out) pt.in = pt.out;
          else delete pt.in;
          if (tmp) pt.out = tmp;
          else delete pt.out;
        }
      }
    }
  }

  return orientedSubpaths
    .filter(sp => Array.isArray(sp.points) && sp.points.length >= 2)
    .map(sp => {
      const n = sp.points.length;
      return sp.points.map((pt, idx) => {
        const isLast = idx === n - 1;
        const higherSegmentExists = sp.closed ? true : !isLast;
        const lower = pt.in
          ? { X: normX(pt.in.x), Y: normY(pt.in.y) }
          : { X: Number.NaN, Y: Number.NaN };
        const higher = pt.out
          ? { X: normX(pt.out.x), Y: normY(pt.out.y) }
          : { X: Number.NaN, Y: Number.NaN };
        return {
          Path: { X: normX(pt.x), Y: normY(pt.y) },
          LowerHandle: lower,
          HigherHandle: higher,
          HigherSegmentExists: higherSegmentExists,
        };
      });
    });
}

export function rp9ControlPointsToSubpaths(controlPoints, width, height) {
  const w = Math.max(1, Number(width) || 100);
  const h = Math.max(1, Number(height) || 100);
  return (controlPoints || [])
    .filter(sp => Array.isArray(sp) && sp.length >= 2)
    .map(sp => {
      const closed = Boolean(sp[sp.length - 1]?.HigherSegmentExists);
      const points = sp.map(cp => {
        const pt = {
          x: roundCoord(Number(cp.Path?.X ?? 0) * w),
          y: roundCoord(Number(cp.Path?.Y ?? 0) * h),
        };
        if (Number.isFinite(cp.LowerHandle?.X) && Number.isFinite(cp.LowerHandle?.Y)) {
          pt.in = {
            x: roundCoord(Number(cp.LowerHandle.X) * w),
            y: roundCoord(Number(cp.LowerHandle.Y) * h),
          };
        }
        if (Number.isFinite(cp.HigherHandle?.X) && Number.isFinite(cp.HigherHandle?.Y)) {
          pt.out = {
            x: roundCoord(Number(cp.HigherHandle.X) * w),
            y: roundCoord(Number(cp.HigherHandle.Y) * h),
          };
        }
        return pt;
      });
      return { closed, points };
    });
}
