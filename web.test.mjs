import assert from "node:assert/strict";
import { before, test } from "node:test";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { unzipSync } from "fflate";
import cvModule from "@techstark/opencv-js";
import { makeDemo } from "./web/src/demo.ts";
import { defaultSettings } from "./web/src/types.ts";
import { convexHull, median, project, signedArea, similarityTransform, validPolygon } from "./web/src/geometry.ts";
import { analyze, assessEdges, copyMat, FeatureMatcher, foreground, templateCandidates, validateInput } from "./web/src/matcher.ts";
import { createStaticServer } from "./serve.mjs";

let cv;
before(async () => {
  ({ cv } = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("OpenCV initialization timed out.")), 30_000);
    const ready = (runtime) => { clearTimeout(timer); resolve({ cv: runtime }); };
    if (cvModule instanceof Promise) cvModule.then(ready, reject);
    else if (cvModule.Mat) ready(cvModule);
    else cvModule.onRuntimeInitialized = () => ready(cvModule);
  }));
});

function frameFromMat(name, mat) {
  return { name, width: mat.cols, height: mat.rows, data: new Uint8ClampedArray(mat.data) };
}

function matFromFrame(frame) {
  const mat = new cv.Mat(frame.height, frame.width, cv.CV_8UC4);
  mat.data.set(frame.data);
  return mat;
}

function makeWeakInput() {
  const width = 320, height = 240;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data.set([
        140 + 42 * Math.sin(x / 39 + y / 71) + 12 * Math.cos(x * y / 2800),
        135 + 38 * Math.sin(x / 61 - y / 43) + 15 * Math.cos(x / 23 + y / 37),
        145 + 35 * Math.cos(x / 47 + y / 29) + 15 * Math.sin(x * y / 3700),
        255,
      ], (y * width + x) * 4);
    }
  }
  const photo = new Uint8ClampedArray(160 * 160 * 4);
  for (let i = 0; i < photo.length; i += 4) photo.set([25, 30, 35, 255], i);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const offset = ((y + 70) * width + x + 120) * 4;
      photo.set(data.subarray(offset, offset + 4), ((y + 45) * 160 + x + 45) * 4);
    }
  }
  return {
    reference: { name: "weak-reference.png", width, height, data },
    assembled: null,
    loose: [{ name: "weak-piece.png", width: 160, height: 160, data: photo }],
    settings: { ...defaultSettings, approximateColumns: 5 },
  };
}

test("homography geometry rejects invalid, reflected, and out-of-frame polygons", () => {
  assert.equal(median([3, 1, 2, 4]), 2.5);
  assert.throws(() => median([]));
  assert.deepEqual(project([2, 3], [1, 0, 10, 0, 1, 20, 0, 0, 1]), [12, 23]);
  assert.ok(project([2, 3], [1, 0, 0, 0, 1, 0, 0, 0, 0]).every(Number.isNaN));
  assert.equal(validPolygon([[20, 20], [100, 20], [100, 100], [20, 100]], 200, 200), true);
  assert.equal(validPolygon([[20, 20], [20, 100], [100, 100], [100, 20]], 200, 200), false);
  assert.equal(validPolygon([[-80, 20], [100, 20], [100, 100], [-80, 100]], 200, 200), false);
  assert.equal(validPolygon([[20, 20], [NaN, 20], [100, 100], [20, 100]], 200, 200), false);
  assert.equal(signedArea(convexHull([[0, 0], [10, 0], [5, 5], [10, 10], [0, 10]])), 100);
  const fit = similarityTransform([[0, 0], [10, 0], [0, 10]], [[20, 30], [20, 50], [0, 30]]);
  assert.ok(fit);
  assert.deepEqual(project([5, 5], fit), [10, 40]);
  assert.equal(similarityTransform([[0, 0], [0, 0]], [[1, 1], [1, 1]]), null);
});

test("deep pixel copies are independent even for non-contiguous regions of interest", () => {
  const source = new cv.Mat(80, 100, cv.CV_8UC1, new cv.Scalar(255));
  const roi = source.roi(new cv.Rect(20, 10, 40, 50));
  const copy = copyMat(cv, roi);
  try {
    cv.circle(copy, new cv.Point(20, 20), 8, new cv.Scalar(0), -1);
    assert.equal(cv.countNonZero(source), 80 * 100);
    assert.equal(copy.data.length, 40 * 50);
    assert.ok(cv.countNonZero(copy) < 40 * 50);
  } finally { copy.delete(); roi.delete(); source.delete(); }
});

test("one photo automatically yields four separately numbered rotated pieces", () => {
  const result = analyze(cv, makeDemo());
  assert.equal(result.previews.length, 1);
  assert.equal(result.pieces.length, 4);
  assert.equal(new Set(result.pieces.map((piece) => piece.id)).size, 4);
  assert.ok(result.occupied, result.warnings.join("\n"));
  const expected = [[320, 60], [320, 180], [192, 300], [576, 300]];
  const locations = new Set();
  for (const piece of result.pieces) {
    assert.ok(piece.candidate, piece.id);
    const candidate = piece.candidate;
    assert.equal(candidate.reliable, true, `${piece.id}: ${candidate.inliers} inliers`);
    const distances = expected.map(([x, y]) => Math.hypot(x - candidate.center[0], y - candidate.center[1]));
    assert.ok(Math.min(...distances) < 22, JSON.stringify(candidate.center));
    locations.add(distances.indexOf(Math.min(...distances)));
    assert.ok(candidate.overlap < 0.08);
    assert.ok(candidate.transform.every(Number.isFinite));
    assert.ok(candidate.outline.flat().every(Number.isFinite));
  }
  assert.equal(locations.size, 4);
  assert.ok(result.pieces.filter((piece) => piece.candidate.edgeScore !== null).length >= 3);
});

test("perspective-warped piece maps its contour to the reference within five pixels", () => {
  const input = makeDemo();
  const reference = matFromFrame(input.reference);
  const roi = reference.roi(new cv.Rect(180, 130, 200, 200));
  const crop = copyMat(cv, roi);
  const source = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, 199, 0, 199, 199, 0, 199]);
  const target = cv.matFromArray(4, 1, cv.CV_32FC2, [30, 20, 240, 40, 230, 240, 40, 230]);
  const transform = cv.getPerspectiveTransform(source, target);
  const photo = new cv.Mat();
  try {
    cv.warpPerspective(crop, photo, transform, new cv.Size(280, 270));
    const result = analyze(cv, { ...input, assembled: null, loose: [frameFromMat("perspective.png", photo)] });
    assert.equal(result.pieces.length, 1);
    const candidate = result.pieces[0].candidate;
    assert.ok(candidate);
    const errors = candidate.outline.map(([x, y]) => {
      assert.ok(x >= 175 && x <= 384 && y >= 125 && y <= 334);
      return Math.min(Math.abs(x - 180), Math.abs(x - 379), Math.abs(y - 130), Math.abs(y - 329));
    });
    assert.ok(Math.max(...errors) < 5, `Contour error: ${Math.max(...errors)}`);
  } finally {
    for (const mat of [photo, transform, target, source, crop, roi, reference]) mat.delete();
  }
});

test("AKAZE independently locates a known crop with spatially distributed inliers", () => {
  const reference = matFromFrame(makeDemo().reference);
  const roi = reference.roi(new cv.Rect(180, 130, 200, 200));
  const crop = copyMat(cv, roi);
  const mask = new cv.Mat(200, 200, cv.CV_8UC1, new cv.Scalar(255));
  const matcher = new FeatureMatcher(cv, reference.cols, reference.rows, reference, "akaze");
  try {
    const candidate = matcher.locate(crop, mask, [[0, 0], [199, 0], [199, 199], [0, 199]]);
    assert.ok(candidate);
    assert.equal(candidate.method, "akaze");
    assert.equal(candidate.reliable, true);
    assert.ok(candidate.inliers >= 10);
    assert.ok(Math.hypot(candidate.center[0] - 279.5, candidate.center[1] - 229.5) < 3);
  } finally { matcher.close(); mask.delete(); crop.delete(); roi.delete(); reference.delete(); }
});

test("default advanced search recovers a weak-texture piece missed by both feature extractors", () => {
  const input = makeWeakInput();
  const featureOnly = analyze(cv, { ...input, settings: { ...input.settings, templateFallback: false } });
  assert.equal(featureOnly.pieces.length, 1);
  assert.equal(featureOnly.pieces[0].candidate, null);
  const progress = [];
  const result = analyze(cv, input, (text) => progress.push(text));
  const piece = result.pieces[0];
  assert.ok(piece.candidate);
  assert.equal(piece.candidate.method, "template");
  assert.equal(piece.candidate.reliable, false);
  assert.equal(piece.candidate.inliers, 0);
  assert.ok(Math.hypot(piece.candidate.center[0] - 151.5, piece.candidate.center[1] - 101.5) < 5, JSON.stringify(piece.candidate.center));
  assert.ok(piece.candidate.score > 0.95);
  assert.equal(piece.alternatives.length, 2);
  assert.ok(progress.some((text) => text.includes("多角度多尺寸搜索")));
  assert.ok(result.warnings.some((text) => text.includes("仅有弱纹理候选")));
  for (const candidate of [piece.candidate, ...piece.alternatives]) {
    assert.equal(candidate.reliable, false);
    assert.ok(candidate.transform.every(Number.isFinite));
    assert.ok(candidate.score <= 1 && candidate.score >= 0.5);
  }
  assert.ok(Math.hypot(
    piece.alternatives[0].center[0] - piece.candidate.center[0],
    piece.alternatives[0].center[1] - piece.candidate.center[1],
  ) > 12);
});

test("weak-texture search handles non-right-angle rotation and scale within five pixels", () => {
  const input = makeWeakInput();
  const reference = matFromFrame(input.reference);
  const roi = reference.roi(new cv.Rect(120, 70, 64, 64));
  const crop = copyMat(cv, roi);
  const full = new cv.Mat(64, 64, cv.CV_8UC1, new cv.Scalar(255));
  const rotation = cv.getRotationMatrix2D(new cv.Point(31.5, 31.5), 27, 1.2);
  rotation.data64F[2] += 32.5;
  rotation.data64F[5] += 32.5;
  const photo = new cv.Mat(), mask = new cv.Mat();
  const contours = new cv.MatVector(), hierarchy = new cv.Mat();
  try {
    cv.warpAffine(crop, photo, rotation, new cv.Size(128, 128), cv.INTER_LINEAR);
    cv.warpAffine(full, mask, rotation, new cv.Size(128, 128), cv.INTER_NEAREST);
    cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const contour = contours.get(0);
    const outline = [];
    try { for (let i = 0; i < contour.data32S.length; i += 2) outline.push([contour.data32S[i], contour.data32S[i + 1]]); }
    finally { contour.delete(); }
    const candidates = templateCandidates(cv, photo, mask, outline, reference, 5);
    assert.ok(candidates.length);
    const mapped = project([64, 64], candidates[0].transform);
    assert.ok(Math.hypot(mapped[0] - 151.5, mapped[1] - 101.5) < 5, JSON.stringify(mapped));
    assert.equal(candidates[0].reliable, false);
  } finally {
    for (const mat of [hierarchy, contours, mask, photo, rotation, full, crop, roi, reference]) mat.delete();
  }
});

test("flat templates do not manufacture candidates or start a meaningless rotation search", () => {
  const reference = new cv.Mat(240, 320, cv.CV_8UC4, new cv.Scalar(150, 140, 160, 255));
  const pattern = new cv.Mat(64, 64, cv.CV_8UC4, new cv.Scalar(150, 140, 160, 255));
  const mask = new cv.Mat(64, 64, cv.CV_8UC1, new cv.Scalar(255));
  let reports = 0;
  try {
    assert.deepEqual(templateCandidates(cv, pattern, mask, [], reference, 5, () => reports++), []);
    assert.equal(reports, 0);
  } finally { mask.delete(); pattern.delete(); reference.delete(); }
});

test("masked correlation ignores noisy background pixels and does not mutate source data", () => {
  const reference = matFromFrame(makeWeakInput().reference);
  const roi = reference.roi(new cv.Rect(120, 70, 64, 64));
  const pattern = copyMat(cv, roi);
  const mask = cv.Mat.zeros(64, 64, cv.CV_8UC1);
  cv.circle(mask, new cv.Point(32, 32), 29, new cv.Scalar(255), -1);
  for (let i = 0; i < mask.data.length; i++) {
    if (!mask.data[i]) pattern.data.set([(i * 13) % 255, (i * 31) % 255, (i * 71) % 255, 255], i * 4);
  }
  const before = new Uint8Array(reference.data);
  const originalMask = new Uint8Array(mask.data);
  try {
    const candidates = templateCandidates(cv, pattern, mask, [], reference, 5);
    assert.ok(candidates.length);
    assert.ok(Math.hypot(candidates[0].center[0] - 152, candidates[0].center[1] - 102) < 5);
    assert.deepEqual(reference.data, before);
    assert.deepEqual(mask.data, originalMask);
  } finally { mask.delete(); pattern.delete(); roi.delete(); reference.delete(); }
});

test("a textured template cannot get a perfect candidate from a constant reference", () => {
  const reference = new cv.Mat(240, 320, cv.CV_8UC4, new cv.Scalar(150, 140, 160, 255));
  const source = matFromFrame(makeWeakInput().reference);
  const roi = source.roi(new cv.Rect(120, 70, 64, 64));
  const pattern = copyMat(cv, roi);
  const mask = new cv.Mat(64, 64, cv.CV_8UC1, new cv.Scalar(255));
  try { assert.deepEqual(templateCandidates(cv, pattern, mask, [], reference, 5), []); }
  finally { mask.delete(); pattern.delete(); roi.delete(); source.delete(); reference.delete(); }
});

test("already-assembled missing-piece holes are preserved while single-piece artwork is filled", () => {
  const photo = new cv.Mat(200, 200, cv.CV_8UC4, new cv.Scalar(245, 245, 245, 255));
  let assembled, single;
  try {
    cv.rectangle(photo, new cv.Point(20, 20), new cv.Point(180, 180), new cv.Scalar(160, 100, 60, 255), -1);
    cv.rectangle(photo, new cv.Point(70, 70), new cv.Point(120, 120), new cv.Scalar(245, 245, 245, 255), -1);
    assembled = foreground(cv, photo, defaultSettings, false);
    single = foreground(cv, photo, defaultSettings, true);
    assert.equal(assembled.ucharAt(90, 90), 0);
    assert.equal(single.ucharAt(90, 90), 255);
    assert.equal(assembled.ucharAt(40, 40), 255);
  } finally { photo.delete(); assembled?.delete(); single?.delete(); }
});

test("transparent PNG masks take precedence over background color", () => {
  const photo = new cv.Mat(100, 160, cv.CV_8UC4, new cv.Scalar(70, 70, 70, 0));
  let mask;
  try {
    cv.rectangle(photo, new cv.Point(30, 20), new cv.Point(89, 69), new cv.Scalar(70, 70, 70, 255), -1);
    mask = foreground(cv, photo, defaultSettings, true);
    assert.equal(cv.countNonZero(mask), 50 * 60);
  } finally { photo.delete(); mask?.delete(); }
});

test("a larger connected region is flagged as possibly containing touching pieces", () => {
  const photo = new cv.Mat(240, 550, cv.CV_8UC4, new cv.Scalar(245, 245, 245, 255));
  try {
    for (const [x, width, height] of [[20, 60, 60], [120, 60, 60], [250, 160, 90]]) {
      cv.rectangle(photo, new cv.Point(x, 40), new cv.Point(x + width, 40 + height), new cv.Scalar(160, 100, 60, 255), -1);
    }
    const result = analyze(cv, { ...makeDemo(), assembled: null, loose: [frameFromMat("batch.png", photo)] });
    assert.equal(result.pieces.length, 3);
    assert.equal(result.pieces.filter((piece) => piece.suspectedJoined).length, 1);
    assert.ok(result.warnings.some((warning) => warning.includes("多片相连")));
    assert.ok(result.pieces.every((piece) => piece.candidate === null));
  } finally { photo.delete(); }
});

test("failed assembled alignment is explicit and does not stop loose-piece matching", () => {
  const input = makeDemo();
  const photo = new cv.Mat(240, 300, cv.CV_8UC4, new cv.Scalar(245, 245, 245, 255));
  try {
    cv.rectangle(photo, new cv.Point(30, 30), new cv.Point(220, 190), new cv.Scalar(160, 100, 60, 255), -1);
    const result = analyze(cv, { ...input, assembled: frameFromMat("assembled.png", photo) });
    assert.equal(result.occupied, null);
    assert.ok(result.warnings.some((warning) => warning.includes("轮廓检查已停用")));
    assert.ok(result.pieces.every((piece) => piece.candidate && piece.candidate.overlap === null));
  } finally { photo.delete(); }
});

test("piece cap applies across multiple batch photos with an explicit warning", () => {
  const input = makeDemo();
  input.settings.maxPieces = 3;
  input.loose = [...input.loose, ...input.loose];
  const result = analyze(cv, input);
  assert.equal(result.pieces.length, 3);
  assert.equal(result.previews.length, 2);
  assert.ok(result.warnings.some((warning) => warning.includes("超出部分未处理")));
});

test("blank photos do not receive invented placements", () => {
  const photo = new cv.Mat(200, 300, cv.CV_8UC4, new cv.Scalar(245, 245, 245, 255));
  try {
    const result = analyze(cv, { ...makeDemo(), assembled: null, loose: [frameFromMat("blank.png", photo)] });
    assert.equal(result.pieces.length, 0);
    assert.ok(result.warnings.some((warning) => warning.includes("没有分离出")));
  } finally { photo.delete(); }
});

test("input validation rejects missing photos, corrupt pixels, NaN and excessive limits", () => {
  const input = makeDemo();
  assert.throws(() => validateInput({ ...input, loose: [] }), /散片照片/);
  assert.throws(() => validateInput({ ...input, loose: Array(6).fill(input.loose[0]) }), /散片照片/);
  assert.throws(() => validateInput({ ...input, settings: { ...input.settings, tolerance: NaN } }), /参数/);
  assert.throws(() => validateInput({ ...input, settings: { ...input.settings, maxPieces: 51 } }), /参数/);
  assert.throws(() => validateInput({ ...input, settings: { ...input.settings, templateFallback: "yes" } }), /参数/);
  assert.throws(() => validateInput({ ...input, settings: { ...input.settings, approximateColumns: 0 } }), /参数/);
  assert.throws(() => validateInput({ ...input, settings: { ...input.settings, approximateColumns: 5.5 } }), /参数/);
  assert.throws(() => validateInput({ ...input, reference: { ...input.reference, width: 1300 } }), /像素/);
});

test("complementary tab/socket shape beats a straight edge that overlaps the tab", () => {
  const occupied = cv.Mat.zeros(150, 200, cv.CV_8UC1);
  const socket = new cv.Mat(60, 60, cv.CV_8UC1, new cv.Scalar(255));
  const square = copyMat(cv, socket);
  const candidate = () => ({
    transform: [1, 0, 81, 0, 1, 35, 0, 0, 1],
    polygon: [], outline: [], center: [110, 65], score: 0.85, inliers: 12, reliable: true,
    overlap: null, contact: null, edgeScore: null,
  });
  try {
    cv.rectangle(occupied, new cv.Point(20, 35), new cv.Point(80, 94), new cv.Scalar(255), -1);
    cv.circle(occupied, new cv.Point(80, 65), 12, new cv.Scalar(255), -1);
    cv.circle(socket, new cv.Point(-1, 30), 12, new cv.Scalar(0), -1);
    const fitting = candidate(), wrong = candidate();
    assessEdges(cv, fitting, socket, occupied);
    assessEdges(cv, wrong, square, occupied);
    assert.equal(fitting.overlap, 0);
    assert.ok(wrong.overlap > 0.01);
    assert.ok(fitting.edgeScore > wrong.edgeScore);
  } finally { occupied.delete(); socket.delete(); square.delete(); }
});

test("OpenCV can be reused for consecutive analyses without stale results", () => {
  const first = analyze(cv, makeDemo());
  const second = analyze(cv, makeDemo());
  assert.equal(first.pieces.length, 4);
  assert.equal(second.pieces.length, 4);
  assert.ok(second.pieces.every((piece) => piece.candidate?.reliable));
});

test("distribution archive contains only self-contained static runtime assets", async () => {
  const archive = unzipSync(await readFile(join("web", "puzzle-iphone.zip")));
  const names = Object.keys(archive);
  for (const name of ["index.html", "app.js", "worker.js", "opencv.js", "sw.js", "manifest.webmanifest", "apple-touch-icon.png", "LICENSE-opencv-js.txt"]) {
    assert.ok(names.includes(name), name);
  }
  assert.equal(names.length, 13);
  const html = new TextDecoder().decode(archive["index.html"]);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /id="loose-files"[^>]+multiple/);
  assert.doesNotMatch(html, /(?:src|href)="https?:/);
  const manifest = JSON.parse(new TextDecoder().decode(archive["manifest.webmanifest"]));
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.display, "standalone");
  for (const [name, size] of [["apple-touch-icon.png", 180], ["icon-192.png", 192], ["icon-512.png", 512]]) {
    assert.equal(new DataView(archive[name].buffer, archive[name].byteOffset).getUint32(16), size);
  }
});

test("directory entry normalizes its trailing slash before resolving relative assets", async () => {
  const html = await readFile(join("web", "dist", "index.html"), "utf8");
  const bootstrap = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(bootstrap);
  assert.ok(html.indexOf("<script>") < html.indexOf("<link"));
  for (const [input, expected] of [
    ["https://example.test/jigsaw-helper", "https://example.test/jigsaw-helper/"],
    ["https://example.test/tools/jigsaw-helper?demo=1#pieces", "https://example.test/tools/jigsaw-helper/?demo=1#pieces"],
    ["https://example.test/jigsaw-helper/", null],
    ["https://example.test/jigsaw-helper/index.html", null],
    ["https://example.test/", null],
    ["https://example.test/index.html", null],
  ]) {
    const url = new URL(input);
    let redirected = null;
    runInNewContext(bootstrap[1], {
      URL,
      location: { href: url.href, pathname: url.pathname, replace: (target) => { redirected = target; } },
    });
    assert.equal(redirected, expected);
  }
});

test("service worker works in a subdirectory, caches only assets, and preserves unrelated caches", async () => {
  const events = new Map(), stores = new Map();
  const scope = "https://example.test/jigsaw-helper/";
  stores.set(`jigsaw-static:${scope}:old`, new Map());
  stores.set("jigsaw-static:https://example.test/:root-version", new Map());
  stores.set("jigsaw-static:https://example.test/other/:old", new Map());
  stores.set("unrelated-user-cache", new Map());
  const cacheApi = {
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    open: async (name) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        addAll: async (urls) => { for (const url of urls) store.set(url, { cached: url }); },
        match: async (url) => store.get(url),
      };
    },
  };
  runInNewContext(await readFile(join("web", "dist", "sw.js"), "utf8"), {
    self: { registration: { scope }, clients: { claim: async () => {} }, addEventListener: (name, handler) => events.set(name, handler) },
    caches: cacheApi, URL, Set, Promise,
    fetch: async () => { throw new Error("Network is offline"); },
  });
  let pending;
  events.get("install")({ waitUntil: (promise) => { pending = promise; } });
  await pending;
  events.get("activate")({ waitUntil: (promise) => { pending = promise; } });
  await pending;
  assert.equal(stores.has(`jigsaw-static:${scope}:old`), false);
  assert.equal(stores.has("jigsaw-static:https://example.test/:root-version"), true);
  assert.equal(stores.has("jigsaw-static:https://example.test/other/:old"), true);
  assert.equal(stores.has("unrelated-user-cache"), true);
  const request = async (url, method = "GET") => {
    let response;
    events.get("fetch")({ request: { url, method }, respondWith: (promise) => { response = promise; } });
    return response ? await response : null;
  };
  assert.deepEqual(await request(scope), { cached: scope + "index.html" });
  assert.deepEqual(await request(scope + "opencv.js"), { cached: scope + "opencv.js" });
  assert.equal(await request(scope + "private-photo.jpg"), null);
  assert.equal(await request("https://example.test/app.js"), null);
  assert.equal(await request("https://example.test/jigsaw-helper-other/app.js"), null);
  assert.equal(await request("https://other.example/app.js"), null);
  assert.equal(await request(scope + "app.js", "POST"), null);
});

test("root retirement worker removes only root app caches and unregisters without touching nested apps", async () => {
  const scope = "https://example.test/";
  const events = new Map();
  const stores = new Set([
    `jigsaw-static:${scope}:old`,
    `jigsaw-static:${scope}:older`,
    `jigsaw-static:${scope}jigsaw-helper/:current`,
    "unrelated-user-cache",
  ]);
  let skipped = false, claimed = false, unregistered = false;
  const navigated = [];
  const clients = [scope + "?from=home", scope + "index.html", scope + "jigsaw-helper/", scope + "other/"].map((url) => ({
    url, navigate: async (target) => { navigated.push(target); },
  }));
  runInNewContext(await readFile(join("web", "retire-root-sw.js"), "utf8"), {
    URL, Promise,
    self: {
      registration: { scope, unregister: async () => { unregistered = true; return true; } },
      skipWaiting: async () => { skipped = true; },
      clients: { claim: async () => { claimed = true; }, matchAll: async () => clients },
      addEventListener: (name, handler) => events.set(name, handler),
    },
    caches: { keys: async () => [...stores], delete: async (name) => stores.delete(name) },
  });
  let pending;
  events.get("install")({ waitUntil: (promise) => { pending = promise; } });
  await pending;
  events.get("activate")({ waitUntil: (promise) => { pending = promise; } });
  await pending;
  assert.equal(skipped, true);
  assert.equal(claimed, true);
  assert.equal(unregistered, true);
  assert.deepEqual([...stores], [`jigsaw-static:${scope}jigsaw-helper/:current`, "unrelated-user-cache"]);
  assert.deepEqual(navigated, [scope + "?from=home", scope + "index.html"]);
  assert.equal(events.has("fetch"), false);
});

test("preview serves static files without accepting uploads or path traversal", async () => {
  const server = createStaticServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const index = await fetch(origin);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /拼图定位助手/);
    const opencv = await fetch(origin + "/opencv.js", { method: "HEAD" });
    assert.equal(opencv.status, 200);
    assert.ok(Number(opencv.headers.get("content-length")) > 8_000_000);
    assert.match(opencv.headers.get("content-type"), /javascript/);
    assert.equal((await fetch(origin + "/", { method: "POST", body: "photo" })).status, 405);
    assert.equal((await fetch(origin + "/%2e%2e%5cpackage.json")).status, 403);
    assert.equal((await fetch(origin + "/missing.png")).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
