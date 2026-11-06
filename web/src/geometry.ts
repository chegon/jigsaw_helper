import type { Candidate, Point } from "./types.ts";

export function median(values: number[]): number {
  if (!values.length) throw new Error("Cannot calculate a median without values.");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function project(point: Point, matrix: number[]): Point {
  const [x, y] = point;
  const divisor = matrix[6] * x + matrix[7] * y + matrix[8];
  if (Math.abs(divisor) < 1e-10) return [NaN, NaN];
  return [
    (matrix[0] * x + matrix[1] * y + matrix[2]) / divisor,
    (matrix[3] * x + matrix[4] * y + matrix[5]) / divisor,
  ];
}

export function similarityTransform(source: Point[], target: Point[]): number[] | null {
  if (source.length < 2 || source.length !== target.length) return null;
  const mean = (points: Point[]): Point => [
    points.reduce((sum, point) => sum + point[0], 0) / points.length,
    points.reduce((sum, point) => sum + point[1], 0) / points.length,
  ];
  const a = mean(source), b = mean(target);
  let real = 0, imaginary = 0, energy = 0;
  for (let i = 0; i < source.length; i++) {
    const x = source[i][0] - a[0], y = source[i][1] - a[1];
    const u = target[i][0] - b[0], v = target[i][1] - b[1];
    real += x * u + y * v;
    imaginary += x * v - y * u;
    energy += x * x + y * y;
  }
  if (energy < 1e-8) return null;
  const c = real / energy, s = imaginary / energy;
  return [c, -s, b[0] - c * a[0] + s * a[1], s, c, b[1] - s * a[0] - c * a[1], 0, 0, 1];
}

export function signedArea(points: Point[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const next = points[(i + 1) % points.length];
    area += points[i][0] * next[1] - next[0] * points[i][1];
  }
  return area / 2;
}

function cross(a: Point, b: Point, c: Point): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

export function convexHull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length <= 2) return sorted;
  const lower: Point[] = [];
  const upper: Point[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0) lower.pop();
    lower.push(point);
  }
  for (const point of [...sorted].reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0) upper.pop();
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

function clipAxis(points: Point[], axis: 0 | 1, limit: number, keepGreater: boolean): Point[] {
  const result: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const aInside = keepGreater ? a[axis] >= limit : a[axis] <= limit;
    const bInside = keepGreater ? b[axis] >= limit : b[axis] <= limit;
    if (aInside) result.push(a);
    if (aInside !== bInside) {
      const ratio = (limit - a[axis]) / (b[axis] - a[axis]);
      result.push([a[0] + ratio * (b[0] - a[0]), a[1] + ratio * (b[1] - a[1])]);
    }
  }
  return result;
}

export function validPolygon(points: Point[], width: number, height: number, footprint: Point[] = points): boolean {
  if (points.length !== 4 || points.some((point) => point.some((value) => !Number.isFinite(value)))) {
    return false;
  }
  const area = signedArea(points);
  if (area < width * height * 0.0001 || area > width * height * 1.15) return false;
  const lengths = points.map((point, index) => {
    const b = points[(index + 1) % 4];
    const c = points[(index + 2) % 4];
    return cross(point, b, c) > 0 ? Math.hypot(point[0] - b[0], point[1] - b[1]) : 0;
  });
  if (Math.min(...lengths) < 5 || Math.max(...lengths) / Math.min(...lengths) > 12) return false;
  if (footprint.some((point) => point.some((value) => !Number.isFinite(value)))) return false;
  const hull = convexHull(footprint);
  const footprintArea = Math.abs(signedArea(hull));
  if (footprintArea < 1) return false;
  let clipped = clipAxis(hull, 0, 0, true);
  clipped = clipAxis(clipped, 0, width - 1, false);
  clipped = clipAxis(clipped, 1, 0, true);
  clipped = clipAxis(clipped, 1, height - 1, false);
  return Math.abs(signedArea(clipped)) / footprintArea >= 0.88;
}

export function priority(candidate: Candidate | null): number {
  if (!candidate) return -1;
  if (candidate.overlap === null) return candidate.score;
  return candidate.score * 0.7
    + Math.min(1, (candidate.contact ?? 0) * 4) * 0.2
    + (candidate.edgeScore ?? 0) * 0.1
    - candidate.overlap * 0.7;
}
