import type { Mat, KeyPointVector, Feature2D } from "@techstark/opencv-js";
import {
  MAX_PHOTOS, MAX_SIDE,
  type AnalysisInput, type AnalysisResult, type Candidate, type Cv,
  type Frame, type PieceResult, type Point, type Settings,
} from "./types.ts";
import { convexHull, median, priority, project, signedArea, similarityTransform, validPolygon } from "./geometry.ts";

interface Disposable { delete(): void }

class Scope {
  private handles: Disposable[] = [];

  add<T extends Disposable>(handle: T): T {
    this.handles.push(handle);
    return handle;
  }

  take<T extends Disposable>(handle: T): T {
    const index = this.handles.indexOf(handle);
    if (index < 0) throw new Error("OpenCV resource ownership mismatch.");
    this.handles.splice(index, 1);
    return handle;
  }

  close(): void {
    for (const handle of this.handles.reverse()) handle.delete();
    this.handles = [];
  }
}

function toMat(cv: Cv, image: Frame): Mat {
  const mat = new cv.Mat(image.height, image.width, cv.CV_8UC4);
  mat.data.set(image.data);
  return mat;
}

function toFrame(name: string, mat: Mat): Frame {
  return { name, width: mat.cols, height: mat.rows, data: new Uint8ClampedArray(mat.data) };
}

export function copyMat(cv: Cv, source: Mat): Mat {
  // This OpenCV.js build's clone() duplicates the Embind handle, not the pixels.
  const copy = new cv.Mat();
  source.copyTo(copy);
  return copy;
}

export function validateInput(input: AnalysisInput): void {
  const { settings } = input;
  if (!input.loose.length || input.loose.length > MAX_PHOTOS) {
    throw new Error(`请提供 1～${MAX_PHOTOS} 张散片照片，每张可以包含多块。`);
  }
  if (!Number.isInteger(settings.maxPieces) || settings.maxPieces < 1 || settings.maxPieces > 50
    || !Number.isFinite(settings.tolerance) || settings.tolerance < 5 || settings.tolerance > 100
    || !Number.isFinite(settings.minAreaFraction) || settings.minAreaFraction <= 0 || settings.minAreaFraction >= 0.5
    || typeof settings.templateFallback !== "boolean"
    || !Number.isInteger(settings.approximateColumns) || settings.approximateColumns < 2 || settings.approximateColumns > 100
    || !["auto", "light", "dark"].includes(settings.background)) {
    throw new Error("识别参数超出允许范围。");
  }
  for (const image of [input.reference, ...(input.assembled ? [input.assembled] : []), ...input.loose]) {
    if (!Number.isInteger(image.width) || !Number.isInteger(image.height)
      || image.width < 16 || image.height < 16 || Math.max(image.width, image.height) > MAX_SIDE
      || image.data.length !== image.width * image.height * 4) {
      throw new Error("图片尺寸或像素数据无效，请重新选择照片。");
    }
  }
}

export function foreground(cv: Cv, rgba: Mat, settings: Settings, fillHoles: boolean): Mat {
  const scope = new Scope();
  try {
    const mask = scope.add(cv.Mat.zeros(rgba.rows, rgba.cols, cv.CV_8UC1));
    const pixels = rgba.data;
    let transparent = false;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] < 250) { transparent = true; break; }
    }
    if (transparent) {
      for (let i = 0; i < mask.data.length; i++) mask.data[i] = pixels[i * 4 + 3] > 32 ? 255 : 0;
    } else {
      const rgb = scope.add(new cv.Mat());
      const lab = scope.add(new cv.Mat());
      cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
      cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
      const border: number[][] = [[], [], []];
      const sample = (x: number, y: number): void => {
        const offset = (y * lab.cols + x) * 3;
        for (let c = 0; c < 3; c++) border[c].push(lab.data[offset + c]);
      };
      for (let x = 0; x < lab.cols; x++) { sample(x, 0); sample(x, lab.rows - 1); }
      for (let y = 0; y < lab.rows; y++) { sample(0, y); sample(lab.cols - 1, y); }
      const background = settings.background === "auto"
        ? border.map(median)
        : [settings.background === "light" ? 255 : 0, 128, 128];
      const limit = settings.tolerance ** 2;
      for (let i = 0; i < mask.data.length; i++) {
        let distance = 0;
        for (let c = 0; c < 3; c++) distance += (lab.data[i * 3 + c] - background[c]) ** 2;
        mask.data[i] = distance > limit ? 255 : 0;
      }
      const kernel = scope.add(cv.Mat.ones(3, 3, cv.CV_8U));
      cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kernel);
    }
    if (!fillHoles) return scope.take(mask);
    const contours = scope.add(new cv.MatVector());
    const hierarchy = scope.add(new cv.Mat());
    const filled = scope.add(cv.Mat.zeros(mask.rows, mask.cols, cv.CV_8UC1));
    cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    cv.drawContours(filled, contours, -1, new cv.Scalar(255), cv.FILLED);
    return scope.take(filled);
  } finally { scope.close(); }
}

export class FeatureMatcher {
  private scope = new Scope();
  private detector: Feature2D;
  private keypoints: KeyPointVector;
  private descriptors: Mat;
  private cv: Cv;
  private width: number;
  private height: number;
  private method: "orb" | "akaze";

  constructor(cv: Cv, width: number, height: number, reference: Mat, method: "orb" | "akaze" = "orb") {
    this.cv = cv;
    this.width = width;
    this.height = height;
    this.method = method;
    try {
      this.detector = this.scope.add(method === "akaze"
        ? new cv.AKAZE()
        : new cv.ORB(6500, 1.2, 8, 12, 0, 2, cv.ORB_HARRIS_SCORE, 25, 10));
      this.keypoints = this.scope.add(new cv.KeyPointVector());
      this.descriptors = this.scope.add(new cv.Mat());
      const gray = this.scope.add(new cv.Mat());
      const empty = this.scope.add(new cv.Mat());
      cv.cvtColor(reference, gray, cv.COLOR_RGBA2GRAY);
      this.detector.detectAndCompute(gray, empty, this.keypoints, this.descriptors);
    } catch (error) {
      this.scope.close();
      throw error;
    }
  }

  get hasFeatures(): boolean { return this.descriptors.rows >= 2; }

  close(): void { this.scope.close(); }

  locate(image: Mat, mask: Mat, outline: Point[]): Candidate | null {
    if (!this.hasFeatures) return null;
    const cv = this.cv;
    const scope = new Scope();
    try {
      const gray = scope.add(new cv.Mat());
      const featureMask = scope.add(new cv.Mat());
      const kernel = scope.add(cv.Mat.ones(5, 5, cv.CV_8U));
      const points = scope.add(new cv.KeyPointVector());
      const descriptors = scope.add(new cv.Mat());
      cv.cvtColor(image, gray, cv.COLOR_RGBA2GRAY);
      cv.erode(mask, featureMask, kernel);
      this.detector.detectAndCompute(gray, featureMask, points, descriptors);
      if (descriptors.rows < 6) return null;
      const matches = scope.add(new cv.DMatchVectorVector());
      const matcher = scope.add(new cv.BFMatcher(cv.NORM_HAMMING, false));
      matcher.knnMatch(descriptors, this.descriptors, matches, 2);
      const good: { query: number; train: number; distance: number }[] = [];
      for (let i = 0; i < matches.size(); i++) {
        const pair = matches.get(i);
        try {
          if (pair.size() >= 2) {
            const first = pair.get(0);
            if (first.distance < pair.get(1).distance * 0.76) {
              good.push({ query: first.queryIdx, train: first.trainIdx, distance: first.distance });
            }
          }
        } finally { pair.delete(); }
      }
      const unique = new Map<number, (typeof good)[number]>();
      for (const match of good.sort((a, b) => a.distance - b.distance)) {
        if (!unique.has(match.train)) unique.set(match.train, match);
      }
      const source: Point[] = [];
      const target: Point[] = [];
      for (const match of unique.values()) {
        const a = points.get(match.query).pt;
        const b = this.keypoints.get(match.train).pt;
        source.push([a.x, a.y]);
        target.push([b.x, b.y]);
      }
      if (source.length < 6) return null;
      const from = scope.add(cv.matFromArray(source.length, 1, cv.CV_32FC2, source.flat()));
      const to = scope.add(cv.matFromArray(target.length, 1, cv.CV_32FC2, target.flat()));
      const accepted = scope.add(new cv.Mat());
      const threshold = Math.max(2.5, Math.max(this.width, this.height) * 0.002);
      const homography = scope.add(cv.findHomography(from, to, cv.RANSAC, threshold, accepted, 2500, 0.995));
      if (homography.empty()) return null;
      const initial = source.map((_, index) => index).filter((index) => accepted.data[index] > 0);
      if (initial.length < 6) return null;
      const models: { transform: number[]; kind: Candidate["model"] }[] = [
        { transform: Array.from(homography.data64F), kind: "homography" },
      ];
      let similarity = similarityTransform(initial.map((i) => source[i]), initial.map((i) => target[i]));
      if (similarity) {
        const fit = similarity;
        const refined = source.map((point, index) => {
          const mapped = project(point, fit);
          return Math.hypot(mapped[0] - target[index][0], mapped[1] - target[index][1]) <= threshold ? index : -1;
        }).filter((index) => index >= 0);
        if (refined.length >= 6) {
          similarity = similarityTransform(refined.map((i) => source[i]), refined.map((i) => target[i]));
          if (similarity) models.push({ transform: similarity, kind: "similarity" });
        }
      }
      const rect = cv.boundingRect(mask);
      const corners: Point[] = [
        [rect.x, rect.y], [rect.x + rect.width - 1, rect.y],
        [rect.x + rect.width - 1, rect.y + rect.height - 1], [rect.x, rect.y + rect.height - 1],
      ];
      let best: Candidate | null = null;
      let bestError = Infinity;
      for (const { transform, kind } of models) {
        const errors = source.map((point, index) => {
          const mapped = project(point, transform);
          return Math.hypot(mapped[0] - target[index][0], mapped[1] - target[index][1]);
        });
        const indexes = errors.map((error, index) => error <= threshold ? index : -1).filter((index) => index >= 0);
        const ratio = indexes.length / source.length;
        if (indexes.length < 6 || ratio < 0.55) continue;
        const polygon = corners.map((point) => project(point, transform));
        const projectedOutline = outline.map((point) => project(point, transform));
        if (!validPolygon(polygon, this.width, this.height, projectedOutline.length ? projectedOutline : polygon)) continue;
        const coverage = Math.abs(signedArea(convexHull(indexes.map((i) => source[i])))) / (rect.width * rect.height);
        if (coverage < 0.04) continue;
        const error = median(indexes.map((i) => errors[i]));
        if (best && !(indexes.length > best.inliers * 1.1
          || (kind === "similarity" && indexes.length >= best.inliers * 0.9 && error <= Math.max(1.5, bestError * 1.5)))) continue;
        bestError = error;
        best = {
          method: this.method,
          model: kind, transform, polygon, outline: projectedOutline,
          center: [polygon.reduce((sum, p) => sum + p[0], 0) / 4, polygon.reduce((sum, p) => sum + p[1], 0) / 4],
          score: Math.min(1, 0.45 * Math.min(1, indexes.length / 20) + 0.3 * ratio + 0.25 * Math.exp(-error / threshold)),
          inliers: indexes.length,
          reliable: indexes.length >= 10 && coverage >= 0.08 && error <= threshold,
          overlap: null, contact: null, edgeScore: null,
        };
      }
      return best;
    } finally { scope.close(); }
  }
}

export function templateCandidates(
  cv: Cv, image: Mat, mask: Mat, outline: Point[], reference: Mat,
  approximateColumns: number, report: (fraction: number) => void = () => {},
): Candidate[] {
  const scope = new Scope();
  try {
    const rgb = scope.add(new cv.Mat());
    const searchMask = scope.add(new cv.Mat());
    const kernel = scope.add(cv.Mat.ones(3, 3, cv.CV_8U));
    const mean = scope.add(new cv.Mat());
    const deviation = scope.add(new cv.Mat());
    const empty = scope.add(new cv.Mat());
    cv.cvtColor(image, rgb, cv.COLOR_RGBA2RGB);
    cv.erode(mask, searchMask, kernel);
    cv.meanStdDev(rgb, mean, deviation, searchMask);
    if (cv.countNonZero(searchMask) < 50 || Array.from(deviation.data64F).reduce((sum, value) => sum + value * value, 0) < 20) {
      return [];
    }
    const referenceRgb = scope.add(new cv.Mat());
    const small = scope.add(new cv.Mat());
    cv.cvtColor(reference, referenceRgb, cv.COLOR_RGBA2RGB);
    const factor = Math.min(1, 640 / Math.max(reference.cols, reference.rows));
    cv.resize(referenceRgb, small, new cv.Size(Math.round(reference.cols * factor), Math.round(reference.rows * factor)), 0, 0, cv.INTER_AREA);
    const factorX = small.cols / reference.cols, factorY = small.rows / reference.rows;
    const baseScale = (small.cols / approximateColumns) / Math.max(image.cols, image.rows);
    const rect = cv.boundingRect(mask);
    const corners: Point[] = [
      [rect.x, rect.y], [rect.x + rect.width - 1, rect.y],
      [rect.x + rect.width - 1, rect.y + rect.height - 1], [rect.x, rect.y + rect.height - 1],
    ];
    const footprint = outline.length ? outline : corners;
    const pool: { candidate: Candidate; angle: number; scale: number }[] = [];
    const search = (angle: number, scale: number): void => {
      const step = new Scope();
      try {
        const rotation = step.add(cv.getRotationMatrix2D(new cv.Point((image.cols - 1) / 2, (image.rows - 1) / 2), angle, scale));
        const cosine = Math.abs(rotation.data64F[0]), sine = Math.abs(rotation.data64F[1]);
        const width = Math.ceil(image.cols * cosine + image.rows * sine);
        const height = Math.ceil(image.rows * cosine + image.cols * sine);
        if (Math.min(width, height) < 8 || width >= small.cols || height >= small.rows) return;
        rotation.data64F[2] += (width - image.cols) / 2;
        rotation.data64F[5] += (height - image.rows) / 2;
        const template = step.add(new cv.Mat());
        const active = step.add(new cv.Mat());
        const correlation = step.add(new cv.Mat());
        cv.warpAffine(rgb, template, rotation, new cv.Size(width, height), cv.INTER_LINEAR);
        cv.warpAffine(searchMask, active, rotation, new cv.Size(width, height), cv.INTER_NEAREST);
        if (cv.countNonZero(active) < 50) return;
        cv.matchTemplate(small, template, correlation, cv.TM_CCOEFF_NORMED, active);
        // Flat reference windows have undefined normalized correlation, not evidence.
        const scores = correlation.data32F;
        for (let i = 0; i < scores.length; i++) {
          scores[i] = Number.isFinite(scores[i]) && Math.abs(scores[i]) <= 1.001
            ? Math.max(-1, Math.min(1, scores[i])) : -1;
        }
        for (let peak = 0; peak < 2; peak++) {
          const best = cv.minMaxLoc(correlation, empty);
          if (best.maxVal < 0.5) break;
          const affine = Array.from(rotation.data64F);
          affine[2] += best.maxLoc.x;
          affine[5] += best.maxLoc.y;
          const transform = [
            affine[0] / factorX, affine[1] / factorX, affine[2] / factorX,
            affine[3] / factorY, affine[4] / factorY, affine[5] / factorY, 0, 0, 1,
          ];
          const polygon = corners.map((point) => project(point, transform));
          const projectedOutline = footprint.map((point) => project(point, transform));
          if (validPolygon(polygon, reference.cols, reference.rows, projectedOutline)) {
            pool.push({
              angle, scale,
              candidate: {
                method: "template", model: "template", transform, polygon, outline: projectedOutline,
                center: [polygon.reduce((sum, point) => sum + point[0], 0) / 4, polygon.reduce((sum, point) => sum + point[1], 0) / 4],
                score: best.maxVal, reliable: false, inliers: 0,
                overlap: null, contact: null, edgeScore: null,
              },
            });
          }
          const radius = Math.max(8, Math.floor(Math.min(width, height) / 2));
          for (let y = Math.max(0, best.maxLoc.y - radius); y <= Math.min(correlation.rows - 1, best.maxLoc.y + radius); y++) {
            for (let x = Math.max(0, best.maxLoc.x - radius); x <= Math.min(correlation.cols - 1, best.maxLoc.x + radius); x++) {
              scores[y * correlation.cols + x] = -1;
            }
          }
        }
      } finally { step.close(); }
    };
    const select = (): typeof pool => {
      const chosen: typeof pool = [];
      for (const entry of [...pool].sort((a, b) => b.candidate.score - a.candidate.score)) {
        if (chosen.every((other) => Math.hypot(
          entry.candidate.center[0] - other.candidate.center[0],
          entry.candidate.center[1] - other.candidate.center[1],
        ) > Math.max(12, Math.sqrt(Math.abs(signedArea(entry.candidate.polygon))) * 0.5))) chosen.push(entry);
        if (chosen.length === 3) break;
      }
      return chosen;
    };
    for (let angle = 0; angle < 360; angle += 15) {
      report(angle / 360 * 0.8);
      for (const multiplier of [0.65, 0.8, 0.9, 1, 1.15, 1.35, 1.6]) search(angle, baseScale * multiplier);
    }
    const seeds = select();
    for (const [index, seed] of seeds.entries()) {
      report(0.8 + index / Math.max(1, seeds.length) * 0.2);
      for (const offset of [-5, 0, 5]) {
        for (const multiplier of [0.95, 1, 1.05]) search(seed.angle + offset, seed.scale * multiplier);
      }
    }
    report(1);
    return select().map((entry) => entry.candidate);
  } finally { scope.close(); }
}

export function assessEdges(cv: Cv, candidate: Candidate, pieceMask: Mat, occupied: Mat): void {
  const scope = new Scope();
  try {
    const mask = scope.add(new cv.Mat());
    const transform = scope.add(cv.matFromArray(3, 3, cv.CV_64F, candidate.transform));
    cv.warpPerspective(pieceMask, mask, transform, new cv.Size(occupied.cols, occupied.rows), cv.INTER_NEAREST);
    const area = cv.countNonZero(mask);
    if (!area) return;
    const radius = Math.max(2, Math.round(Math.sqrt(area) * 0.035));
    const kernel = scope.add(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(radius * 2 + 1, radius * 2 + 1)));
    const tiny = scope.add(cv.Mat.ones(3, 3, cv.CV_8U));
    const core = scope.add(new cv.Mat());
    const eroded = scope.add(new cv.Mat());
    const boundary = scope.add(new cv.Mat());
    const otherBoundary = scope.add(new cv.Mat());
    const inverted = scope.add(new cv.Mat());
    const distance = scope.add(new cv.Mat());
    cv.erode(occupied, core, kernel, new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, new cv.Scalar(0));
    cv.erode(mask, eroded, tiny);
    cv.subtract(mask, eroded, boundary);
    cv.erode(occupied, eroded, tiny);
    cv.subtract(occupied, eroded, otherBoundary);
    cv.bitwise_not(otherBoundary, inverted);
    cv.distanceTransform(inverted, distance, cv.DIST_L2, 3);
    let overlap = 0, perimeter = 0, contact = 0, fit = 0;
    for (let i = 0; i < mask.data.length; i++) {
      if (mask.data[i] && core.data[i]) overlap++;
      if (boundary.data[i]) {
        perimeter++;
        if (distance.data32F[i] <= radius * 3) {
          contact++;
          fit += Math.exp(-distance.data32F[i] / radius);
        }
      }
    }
    candidate.overlap = overlap / area;
    candidate.contact = contact / Math.max(1, perimeter);
    if (candidate.contact >= 0.04) {
      candidate.edgeScore = fit / contact * Math.max(0, 1 - candidate.overlap * 5);
    }
  } finally { scope.close(); }
}

export function analyze(
  cv: Cv, input: AnalysisInput, progress: (text: string, value: number) => void = () => {},
): AnalysisResult {
  validateInput(input);
  const started = performance.now();
  const scope = new Scope();
  const matchers: FeatureMatcher[] = [];
  try {
    const reference = scope.add(toMat(cv, input.reference));
    const primary = new FeatureMatcher(cv, reference.cols, reference.rows, reference);
    matchers.push(primary);
    let supplemental: FeatureMatcher | null = null;
    const locate = (image: Mat, mask: Mat, outline: Point[]): Candidate | null => {
      const first = primary.locate(image, mask, outline);
      if (first?.reliable) return first;
      if (!supplemental) {
        supplemental = new FeatureMatcher(cv, reference.cols, reference.rows, reference, "akaze");
        matchers.push(supplemental);
      }
      const second = supplemental.locate(image, mask, outline);
      if (!first || (second && (second.reliable || second.score > first.score))) return second;
      return first;
    };
    const warnings: string[] = [];
    if (!primary.hasFeatures) warnings.push("参考图的 ORB 特征不足，将尝试补充定位；纯色和重复图案可能没有唯一答案。");
    let occupied: Mat | null = null;
    if (input.assembled) {
      progress("正在对齐已拼区域……", 0.12);
      const photo = scope.add(toMat(cv, input.assembled));
      const mask = scope.add(foreground(cv, photo, input.settings, false));
      const fraction = cv.countNonZero(mask) / (mask.rows * mask.cols);
      const alignment = fraction > 0.005 && fraction < 0.95 ? locate(photo, mask, []) : null;
      if (!alignment?.reliable) {
        warnings.push("已拼区域无法可靠分离或对齐，轮廓检查已停用；散片仍可按图案定位。");
      } else {
        occupied = scope.add(new cv.Mat());
        const transform = scope.add(cv.matFromArray(3, 3, cv.CV_64F, alignment.transform));
        cv.warpPerspective(mask, occupied, transform, new cv.Size(reference.cols, reference.rows), cv.INTER_NEAREST);
      }
    }
    const pieces: PieceResult[] = [];
    const previews: Frame[] = [];
    for (const [photoIndex, image] of input.loose.entries()) {
      const photoScope = new Scope();
      try {
        const photo = photoScope.add(toMat(cv, image));
        const preview = photoScope.add(copyMat(cv, photo));
        const mask = photoScope.add(foreground(cv, photo, input.settings, true));
        const contours = photoScope.add(new cv.MatVector());
        const hierarchy = photoScope.add(new cv.Mat());
        cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        const regions: { index: number; area: number; rect: { x: number; y: number; width: number; height: number } }[] = [];
        for (let index = 0; index < contours.size(); index++) {
          const contour = contours.get(index);
          try {
            const area = cv.contourArea(contour);
            if (area >= image.width * image.height * input.settings.minAreaFraction) {
              regions.push({ index, area, rect: cv.boundingRect(contour) });
            }
          } finally { contour.delete(); }
        }
        regions.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
        const typicalArea = regions.length ? median(regions.map((region) => region.area)) : 0;
        if (!regions.length) warnings.push(`${image.name}：没有分离出碎片。请使用反差明显的纯色背景，并降低最小面积或调整容差。`);
        if (regions.length === 1) warnings.push(`${image.name}：只检测到 1 个连通区域；如果实际有多块，请将接触或堆叠的散片摆开后重拍。`);
        const remaining = input.settings.maxPieces - pieces.length;
        if (regions.length > remaining) warnings.push(`最多处理 ${input.settings.maxPieces} 块，超出部分未处理。请分批或提高数量上限。`);
        for (const [regionIndex, region] of regions.slice(0, Math.max(0, remaining)).entries()) {
          const { x, y, width, height } = region.rect;
          if (x <= 1 || y <= 1 || x + width >= image.width - 1 || y + height >= image.height - 1) {
            warnings.push(`${image.name}：已跳过接触照片边缘的区域。请在碎片四周留出背景。`);
            continue;
          }
          const pieceScope = new Scope();
          try {
            const id = `${photoIndex + 1}-${String(regionIndex + 1).padStart(2, "0")}`;
            progress(`照片 ${photoIndex + 1}/${input.loose.length} · 正在定位碎片 ${id}`, 0.2 + 0.75 * ((photoIndex + regionIndex / Math.max(1, regions.length)) / input.loose.length));
            const roi = pieceScope.add(photo.roi(new cv.Rect(x, y, width, height)));
            const patch = pieceScope.add(copyMat(cv, roi));
            const pieceMask = pieceScope.add(cv.Mat.zeros(height, width, cv.CV_8UC1));
            cv.drawContours(pieceMask, contours, region.index, new cv.Scalar(255), cv.FILLED, cv.LINE_8, hierarchy, 0, new cv.Point(-x, -y));
            const contour = pieceScope.add(contours.get(region.index));
            const outline: Point[] = [];
            for (let i = 0; i < contour.data32S.length; i += 2) {
              outline.push([contour.data32S[i] - x, contour.data32S[i + 1] - y]);
            }
            const suspectedJoined = regions.length >= 3 && region.area > typicalArea * 1.8;
            if (suspectedJoined) warnings.push(`碎片 ${id} 区域明显偏大，可能是多片相连，请先查看编号图。`);
            const feature = locate(patch, pieceMask, outline);
            const candidates = feature ? [feature] : [];
            if (!feature?.reliable && !suspectedJoined && input.settings.templateFallback) {
              candidates.push(...templateCandidates(cv, patch, pieceMask, outline, reference, input.settings.approximateColumns, (fraction) => {
                progress(`碎片 ${id} · 多角度多尺寸搜索 ${Math.round(fraction * 100)}%`, 0.2 + 0.75 * (photoIndex + (regionIndex + fraction) / Math.max(1, regions.length)) / input.loose.length);
              }));
            }
            for (const candidate of candidates) {
              if (suspectedJoined) candidate.reliable = false;
              if (occupied) assessEdges(cv, candidate, pieceMask, occupied);
            }
            candidates.sort((a, b) => Number(b.reliable) - Number(a.reliable) || priority(b) - priority(a));
            const candidate = candidates[0] ?? null;
            const alternatives = candidates.slice(1, 3);
            if (candidate?.method === "template") warnings.push(`碎片 ${id}：仅有弱纹理候选，需要逐个核对，不能视为可靠匹配。`);
            for (let i = 0; i < pieceMask.data.length; i++) {
              if (!pieceMask.data[i]) patch.data.set([245, 245, 245, 255], i * 4);
            }
            pieces.push({ id, source: image.name, thumbnail: toFrame(id, patch), suspectedJoined, candidate, alternatives });
            cv.drawContours(preview, contours, region.index, new cv.Scalar(255, 164, 32, 255), 2);
            cv.putText(preview, id, new cv.Point(x, Math.max(20, y - 5)), cv.FONT_HERSHEY_SIMPLEX, 0.65, new cv.Scalar(255, 255, 255, 255), 2);
          } finally { pieceScope.close(); }
        }
        previews.push(toFrame(image.name, preview));
      } finally { photoScope.close(); }
    }
    return {
      reference: input.reference, previews, pieces, warnings,
      occupied: occupied ? new Uint8Array(occupied.data) : null,
      elapsedMs: performance.now() - started,
    };
  } finally {
    for (const matcher of matchers) matcher.close();
    scope.close();
  }
}
