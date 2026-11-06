import { makeDemo } from "./demo.ts";
import { priority } from "./geometry.ts";
import {
  MAX_PHOTOS, MAX_SIDE, errorMessage, inputTransfers,
  type AnalysisInput, type AnalysisResult, type Candidate, type Frame,
  type Settings, type WorkerReply, type WorkerRequest,
} from "./types.ts";

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing page element: ${selector}`);
  return element;
}

const referenceInput = required<HTMLInputElement>("#reference-file");
const assembledInput = required<HTMLInputElement>("#assembled-file");
const looseInput = required<HTMLInputElement>("#loose-files");
const analyzeButton = required<HTMLButtonElement>("#analyze");
const demoButton = required<HTMLButtonElement>("#demo");
const cancelButton = required<HTMLButtonElement>("#cancel");
const retryButton = required<HTMLButtonElement>("#retry-engine");
const engineStatus = required<HTMLParagraphElement>("#engine-status");
const offlineStatus = required<HTMLParagraphElement>("#offline-status");
const analysisStatus = required<HTMLParagraphElement>("#analysis-status");
const errorBox = required<HTMLParagraphElement>("#error");
const progressArea = required<HTMLDivElement>("#progress-area");
const progressBar = required<HTMLProgressElement>("#progress");
const resultsSection = required<HTMLElement>("#results");
const referenceCanvas = required<HTMLCanvasElement>("#reference-canvas");
const saveImage = required<HTMLButtonElement>("#save-image");
const saveJson = required<HTMLButtonElement>("#save-json");
const pieceList = required<HTMLDivElement>("#piece-list");
const sourcePreviews = required<HTMLDivElement>("#source-previews");
const selectionText = required<HTMLParagraphElement>("#selection");
const candidateControls = required<HTMLLabelElement>("#candidate-controls");
const candidateChoice = required<HTMLSelectElement>("#candidate-choice");
const settingsInputs = [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(".settings input, .settings select")];

let worker: Worker | null = null;
let engineReady = false;
let busy = false;
let sequence = 0;
let engineTimer = 0;
let analysis: AnalysisResult | null = null;
let selectedId: string | null = null;
let selectedCandidateIndex = 0;
let referenceBase: HTMLCanvasElement | null = null;
let pngBlob: Blob | null = null;
let jsonBlob: Blob | null = null;
let drawingVersion = 0;
let registeredOffline = false;

function showError(message: string): void {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function updateControls(): void {
  analyzeButton.disabled = busy || !engineReady || !referenceInput.files?.length || !looseInput.files?.length;
  demoButton.disabled = busy || !engineReady;
  cancelButton.hidden = !busy;
  progressArea.hidden = !busy;
  for (const element of [referenceInput, assembledInput, looseInput, ...settingsInputs]) element.disabled = busy;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-clear]")) button.disabled = busy;
}

function clearResults(): void {
  drawingVersion++;
  analysis = null;
  selectedId = null;
  selectedCandidateIndex = 0;
  candidateControls.hidden = true;
  candidateChoice.replaceChildren();
  pngBlob = null;
  jsonBlob = null;
  resultsSection.hidden = true;
  pieceList.replaceChildren();
  sourcePreviews.replaceChildren();
  referenceBase = null;
  referenceCanvas.width = 1;
  referenceCanvas.height = 1;
  saveImage.disabled = true;
  saveJson.disabled = true;
  errorBox.hidden = true;
}

function fileSummary(input: HTMLInputElement, labelId: string): void {
  const files = [...(input.files ?? [])];
  required<HTMLElement>(`#${labelId}`).textContent = files.length
    ? files.map((file) => file.name).join("、")
    : "尚未选择";
  required<HTMLButtonElement>(`[data-clear="${input.id}"]`).hidden = files.length === 0;
}

for (const [input, name] of [
  [referenceInput, "reference-name"],
  [assembledInput, "assembled-name"],
  [looseInput, "loose-name"],
] as const) {
  input.addEventListener("change", () => {
    clearResults();
    fileSummary(input, name);
    analysisStatus.textContent = "照片已更新，点击“开始寻找位置”。";
    analysisStatus.dataset.state = "idle";
    updateControls();
  });
  required<HTMLButtonElement>(`[data-clear="${input.id}"]`).addEventListener("click", () => {
    input.value = "";
    input.dispatchEvent(new Event("change"));
  });
}
for (const input of settingsInputs) input.addEventListener("change", clearResults);

function readSettings(): Settings {
  const background = required<HTMLSelectElement>("#background").value;
  if (background !== "auto" && background !== "light" && background !== "dark") {
    throw new Error("背景选项无效。");
  }
  return {
    background,
    tolerance: required<HTMLInputElement>("#tolerance").valueAsNumber,
    minAreaFraction: required<HTMLInputElement>("#min-area").valueAsNumber / 100,
    maxPieces: required<HTMLInputElement>("#max-pieces").valueAsNumber,
    templateFallback: required<HTMLInputElement>("#template-fallback").checked,
    approximateColumns: required<HTMLInputElement>("#approximate-columns").valueAsNumber,
  };
}

async function loadPhoto(file: File): Promise<Frame> {
  if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} 超过 20 MB，请先缩小照片。`);
  if (file.type === "image/svg+xml" || /\.svg$/i.test(file.name)) throw new Error("请选择相机照片（JPEG、PNG、WebP 或 HEIC），不支持 SVG。");
  const url = URL.createObjectURL(file);
  const image = new Image();
  const canvas = document.createElement("canvas");
  try {
    image.src = url;
    try { await image.decode(); } catch (error) {
      throw new Error(`${file.name} 无法读取。若为 HEIC，请在相册导出 JPEG，或将相机格式设为“兼容性最佳”。`, { cause: error });
    }
    if (image.naturalWidth * image.naturalHeight > 30_000_000) {
      throw new Error(`${file.name} 超过 3000 万像素。请先裁剪或导出较小的照片，以免手机内存不足。`);
    }
    if (Math.min(image.naturalWidth, image.naturalHeight) < 16) throw new Error(`${file.name} 尺寸太小。`);
    const scale = Math.min(1, MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    if (Math.min(canvas.width, canvas.height) < 16) throw new Error(`${file.name} 长宽比例过大，请先裁剪照片。`);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("浏览器无法创建图片画布，请重新打开 Safari。");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    return {
      name: file.name, width: canvas.width, height: canvas.height,
      data: new Uint8ClampedArray(pixels.data),
    };
  } finally {
    URL.revokeObjectURL(url);
    canvas.width = 1;
    canvas.height = 1;
  }
}

async function collectPhotos(job: number): Promise<AnalysisInput> {
  const referenceFile = referenceInput.files?.item(0);
  const assembledFile = assembledInput.files?.item(0);
  const looseFiles = [...(looseInput.files ?? [])];
  if (!referenceFile || !looseFiles.length) throw new Error("请选择完整参考图和至少一张散片合照。");
  if (looseFiles.length > MAX_PHOTOS) throw new Error(`一次最多选择 ${MAX_PHOTOS} 张散片合照，请分批分析。`);
  const settings = readSettings();
  const reference = await loadPhoto(referenceFile);
  const assembled = assembledFile ? await loadPhoto(assembledFile) : null;
  const loose: Frame[] = [];
  for (const file of looseFiles) {
    if (job !== sequence) throw new DOMException("分析已取消", "AbortError");
    analysisStatus.textContent = `正在读取散片合照 ${loose.length + 1}/${looseFiles.length}……`;
    loose.push(await loadPhoto(file));
  }
  return { reference, assembled, loose, settings };
}

function describe(candidate: Candidate | null, joined = false): string {
  if (joined) return "疑似多片相连，请检查编号图";
  if (!candidate) return "没有可验证位置，请改善照片";
  if (candidate.overlap !== null && candidate.overlap > 0.2) return "与已拼区域重叠，请核对";
  if (candidate.method === "template") return "弱纹理搜索候选，需人工核对";
  if (!candidate.reliable) return "候选位置，需人工核对";
  if (candidate.edgeScore !== null && candidate.edgeScore >= 0.45) return "图案匹配，邻接轮廓有支持";
  return "图案特征匹配";
}

function methodLabel(candidate: Candidate): string {
  return { orb: "ORB 特征", akaze: "AKAZE 特征", template: "弱纹理搜索" }[candidate.method];
}

function imageCanvas(frame: Frame, label: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = frame.width;
  canvas.height = frame.height;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", label);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法显示图片。");
  context.putImageData(new ImageData(frame.data, frame.width, frame.height), 0, 0);
  return canvas;
}

function textElement<K extends keyof HTMLElementTagNameMap>(tag: K, text: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}

function drawReference(): void {
  if (!analysis || !referenceBase) return;
  const context = referenceCanvas.getContext("2d");
  if (!context) throw new Error("浏览器无法显示定位图。");
  referenceCanvas.width = referenceBase.width;
  referenceCanvas.height = referenceBase.height;
  context.drawImage(referenceBase, 0, 0);
  for (const piece of analysis.pieces) {
    if (!piece.candidate || (selectedId && piece.id !== selectedId)) continue;
    const candidate = piece.id === selectedId
      ? [piece.candidate, ...piece.alternatives][selectedCandidateIndex] ?? piece.candidate
      : piece.candidate;
    const color = candidate.overlap !== null && candidate.overlap > 0.2
      ? "#d44028" : candidate.reliable ? "#12914c" : "#ef9b1a";
    context.beginPath();
    candidate.outline.forEach(([x, y], index) => {
      if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
    });
    context.closePath();
    context.strokeStyle = color;
    context.lineWidth = Math.max(3, referenceCanvas.width / 280);
    context.stroke();
    context.font = `bold ${Math.max(16, referenceCanvas.width / 36)}px -apple-system, sans-serif`;
    context.lineWidth = 4;
    context.strokeStyle = "white";
    context.strokeText(piece.id, candidate.center[0] - 18, candidate.center[1]);
    context.fillStyle = color;
    context.fillText(piece.id, candidate.center[0] - 18, candidate.center[1]);
  }
  for (const button of pieceList.querySelectorAll<HTMLButtonElement>("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.id === selectedId));
  }
  const selected = analysis.pieces.find((piece) => piece.id === selectedId);
  const displayed = selected ? [selected.candidate, ...selected.alternatives][selectedCandidateIndex] : null;
  selectionText.textContent = selected
    ? `${selected.id} · ${describe(displayed ?? null, selected.suspectedJoined)}${displayed ? ` · ${methodLabel(displayed)}，图案分 ${Math.round(displayed.score * 100)}/100，内点 ${displayed.inliers}` : ""}`
    : "点击下方编号，只看这块的候选位置。评分不是正确概率。";
  pngBlob = null;
  saveImage.disabled = true;
  const version = ++drawingVersion;
  referenceCanvas.toBlob((blob) => {
    if (version !== drawingVersion) return;
    if (!blob) { showError("定位图导出失败，请尝试截图保存。"); return; }
    pngBlob = blob;
    saveImage.disabled = false;
  }, "image/png");
}

function renderResults(result: AnalysisResult): void {
  analysis = result;
  selectedId = null;
  referenceBase = imageCanvas(result.reference, "参考图");
  if (result.occupied) {
    const context = referenceBase.getContext("2d");
    if (!context) throw new Error("浏览器无法显示已拼区域。");
    const pixels = context.getImageData(0, 0, referenceBase.width, referenceBase.height);
    for (let i = 0; i < result.occupied.length; i++) {
      if (!result.occupied[i]) continue;
      pixels.data[i * 4] = pixels.data[i * 4] * 0.7 + 60 * 0.3;
      pixels.data[i * 4 + 1] = pixels.data[i * 4 + 1] * 0.7 + 185 * 0.3;
      pixels.data[i * 4 + 2] = pixels.data[i * 4 + 2] * 0.7 + 90 * 0.3;
    }
    context.putImageData(pixels, 0, 0);
  }
  const warnings = required<HTMLUListElement>("#warnings");
  warnings.replaceChildren(...result.warnings.map((message) => textElement("li", message)));
  required<HTMLElement>("#piece-count").textContent = String(result.pieces.length);
  required<HTMLElement>("#match-count").textContent = String(result.pieces.filter((piece) => piece.candidate).length);
  required<HTMLElement>("#strong-count").textContent = String(result.pieces.filter((piece) => piece.candidate?.reliable).length);
  pieceList.replaceChildren();
  for (const piece of [...result.pieces].sort((a, b) => priority(b.candidate) - priority(a.candidate))) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "piece-card";
    card.dataset.id = piece.id;
    card.setAttribute("aria-pressed", "false");
    card.append(
      imageCanvas(piece.thumbnail, `散片 ${piece.id}`),
      textElement("strong", piece.id),
      textElement("span", describe(piece.candidate, piece.suspectedJoined)),
      textElement("span", piece.candidate ? `${methodLabel(piece.candidate)} · 图案分 ${Math.round(piece.candidate.score * 100)}/100${piece.alternatives.length ? ` · ${piece.alternatives.length + 1} 个候选` : ""}` : "保留编号，暂不猜位置"),
    );
    card.addEventListener("click", () => {
      selectedId = piece.id;
      selectedCandidateIndex = 0;
      candidateChoice.replaceChildren();
      if (piece.candidate) {
        for (const [index, candidate] of [piece.candidate, ...piece.alternatives].entries()) {
          const option = textElement("option", `候选 ${index + 1} · ${methodLabel(candidate)} · ${Math.round(candidate.score * 100)}/100`);
          option.value = String(index);
          candidateChoice.append(option);
        }
      }
      candidateControls.hidden = !piece.alternatives.length;
      drawReference();
      referenceCanvas.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    pieceList.append(card);
  }
  if (!result.pieces.length) pieceList.append(textElement("p", "未分离出碎片。请先检查背景、容差和最小面积。"));
  sourcePreviews.replaceChildren();
  for (const preview of result.previews) {
    const figure = document.createElement("figure");
    figure.className = "source-preview";
    figure.append(imageCanvas(preview, `${preview.name} 的散片编号`), textElement("figcaption", preview.name));
    sourcePreviews.append(figure);
  }
  const exported = {
    engine: "OpenCV.js ORB + AKAZE + RANSAC + masked template correlation",
    reference_size: { width: result.reference.width, height: result.reference.height },
    coordinate_system: "resized_reference_pixels, origin=top_left",
    scores_are_probabilities: false,
    warnings: result.warnings,
    pieces: result.pieces.map((piece) => ({
      id: piece.id, source: piece.source, suspected_joined: piece.suspectedJoined,
      candidate: piece.candidate, alternatives: piece.alternatives,
    })),
  };
  jsonBlob = new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" });
  saveJson.disabled = false;
  required<HTMLElement>("#coordinates").textContent = `导出坐标基于缩放后的参考图 ${result.reference.width} × ${result.reference.height} 像素，原点在左上角。`;
  resultsSection.hidden = false;
  drawReference();
}

async function saveFile(blob: Blob, name: string): Promise<void> {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: "拼图定位结果" });
    return;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function attachSave(button: HTMLButtonElement, getBlob: () => Blob | null, name: string): void {
  button.addEventListener("click", () => {
    const blob = getBlob();
    if (!blob) { showError("导出内容尚未准备好，请稍后重试。"); return; }
    saveFile(blob, name).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") {
        analysisStatus.textContent = "已取消分享。";
      } else showError(`保存失败：${errorMessage(error)}。可以截图保存当前定位图。`);
    });
  });
}
attachSave(saveImage, () => pngBlob, "puzzle-locations.png");
attachSave(saveJson, () => jsonBlob, "puzzle-candidates.json");
required<HTMLButtonElement>("#show-all").addEventListener("click", () => {
  selectedId = null;
  selectedCandidateIndex = 0;
  candidateControls.hidden = true;
  drawReference();
});
candidateChoice.addEventListener("change", () => {
  selectedCandidateIndex = Number(candidateChoice.value);
  drawReference();
});

async function prepareOffline(): Promise<void> {
  if (registeredOffline) return;
  registeredOffline = true;
  if (!("serviceWorker" in navigator) || !isSecureContext) {
    offlineStatus.textContent = "当前连接不能缓存离线程序。请通过 HTTPS 静态网站打开；普通局域网 HTTP 仅供在线试用。";
    return;
  }
  try {
    const registration = await navigator.serviceWorker.register("./sw.js");
    const installing = registration.installing;
    if (installing) {
      installing.addEventListener("statechange", () => {
        if (installing.state === "redundant") {
          offlineStatus.textContent = "离线缓存安装未完成，请联网重新打开页面重试；仍可在线分析。";
        }
      });
    }
    await navigator.serviceWorker.ready;
    offlineStatus.textContent = "离线程序已缓存。可在 Safari 分享菜单中“添加到主屏幕”；照片不会缓存。";
    offlineStatus.dataset.state = "ready";
  } catch (error) {
    registeredOffline = false;
    offlineStatus.textContent = `离线缓存未完成：${errorMessage(error)}。仍可在线使用，联网重新打开可重试。`;
  }
}

function failEngine(message: string): void {
  clearTimeout(engineTimer);
  worker?.terminate();
  worker = null;
  sequence++;
  busy = false;
  engineReady = false;
  engineStatus.dataset.state = "error";
  engineStatus.textContent = "识别引擎未就绪。";
  retryButton.hidden = false;
  analysisStatus.dataset.state = "error";
  showError(message);
  updateControls();
}

function startEngine(): void {
  sequence++;
  worker?.terminate();
  clearTimeout(engineTimer);
  worker = null;
  engineReady = false;
  retryButton.hidden = true;
  engineStatus.dataset.state = "loading";
  engineStatus.textContent = "正在加载本地识别引擎……首次需要下载约 11 MB。";
  updateControls();
  if (location.protocol === "file:") {
    failEngine("不能直接从“文件”App 打开 HTML。请将静态文件部署到 HTTPS 网站后，通过 Safari 访问。");
    return;
  }
  if (!("Worker" in window) || !("WebAssembly" in window)) {
    failEngine("当前浏览器不支持 Web Worker / WebAssembly，请使用较新版本的 Safari。");
    return;
  }
  try {
    worker = new Worker(new URL("./worker.js", document.baseURI));
    const currentWorker = worker;
    engineTimer = window.setTimeout(() => failEngine("加载超过两分钟。请检查网络或刷新页面，离线使用前需完成首次缓存。"), 120_000);
    worker.onerror = (event) => {
      if (worker !== currentWorker) return;
      event.preventDefault();
      failEngine(`识别线程错误：${event.message || "可能是手机内存不足，请缩小照片后重试。"}`);
    };
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      if (worker !== currentWorker) return;
      const message = event.data;
      if (message.type === "ready") {
        clearTimeout(engineTimer);
        engineReady = true;
        engineStatus.dataset.state = "ready";
        engineStatus.textContent = "识别引擎已就绪 · 图片在本机处理";
        updateControls();
        void prepareOffline();
        return;
      }
      if (message.type === "error") {
        if (message.fatal) { failEngine(message.message); return; }
        if (message.id !== sequence) return;
        busy = false;
        analysisStatus.dataset.state = "error";
        analysisStatus.textContent = "分析未完成，可调整照片或设置后重试。";
        showError(`分析失败：${message.message}`);
        retryButton.hidden = false;
        updateControls();
        return;
      }
      if (message.id !== sequence) return;
      if (message.type === "progress") {
        analysisStatus.textContent = message.text;
        progressBar.value = message.value;
      } else {
        busy = false;
        try {
          renderResults(message.result);
          analysisStatus.textContent = `完成：从 ${message.result.previews.length} 张散片合照中分离出 ${message.result.pieces.length} 个区域，识别耗时 ${(message.result.elapsedMs / 1000).toFixed(1)} 秒。请对照编号图核对实际碎片。`;
          analysisStatus.dataset.state = "done";
        } catch (error) {
          clearResults();
          analysisStatus.dataset.state = "error";
          showError(`显示结果失败：${errorMessage(error)}`);
        }
        updateControls();
      }
    };
  } catch (error) { failEngine(`无法启动识别线程：${errorMessage(error)}`); }
}

async function runAnalysis(demo: boolean): Promise<void> {
  if (!engineReady || !worker || busy) { showError("请等待识别引擎就绪后再分析。"); return; }
  clearResults();
  const job = ++sequence;
  busy = true;
  analysisStatus.dataset.state = "working";
  analysisStatus.textContent = "正在读取照片并缩小到适合手机的尺寸……";
  progressBar.value = 0.03;
  updateControls();
  try {
    const input = demo ? makeDemo() : await collectPhotos(job);
    if (demo) input.settings = readSettings();
    if (job !== sequence) return;
    const request: WorkerRequest = { type: "analyze", id: job, input };
    worker.postMessage(request, inputTransfers(input));
  } catch (error) {
    if (job !== sequence) return;
    busy = false;
    analysisStatus.dataset.state = "error";
    analysisStatus.textContent = "照片读取失败，请检查后重新选择。";
    showError(errorMessage(error));
    updateControls();
  }
}

analyzeButton.addEventListener("click", () => { void runAnalysis(false); });
demoButton.addEventListener("click", () => { void runAnalysis(true); });
cancelButton.addEventListener("click", () => {
  busy = false;
  clearResults();
  analysisStatus.textContent = "分析已取消，正在重新准备识别引擎。";
  analysisStatus.dataset.state = "idle";
  startEngine();
});
retryButton.addEventListener("click", () => {
  busy = false;
  clearResults();
  startEngine();
});
startEngine();
