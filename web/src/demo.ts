import { defaultSettings, type AnalysisInput, type Frame } from "./types.ts";

function frame(name: string, width: number, height: number, color: number[]): Frame {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([...color, 255], i);
  return { name, width, height, data };
}

function circle(image: Frame, x: number, y: number, radius: number, color: number[]): void {
  for (let py = Math.max(0, y - radius); py <= Math.min(image.height - 1, y + radius); py++) {
    for (let px = Math.max(0, x - radius); px <= Math.min(image.width - 1, x + radius); px++) {
      if ((px - x) ** 2 + (py - y) ** 2 <= radius ** 2) {
        image.data.set([...color, 255], (py * image.width + px) * 4);
      }
    }
  }
}

export function pieceContains(x: number, y: number, index: number): boolean {
  const column = index % 5;
  const row = Math.floor(index / 5);
  const left = column * 128;
  const top = row * 120;
  let inside = x >= left && x < left + 128 && y >= top && y < top + 120;
  if (column < 4 && (x - left - 128) ** 2 + (y - top - 60) ** 2 <= 17 ** 2) inside = true;
  if (row < 3 && (x - left - 64) ** 2 + (y - top - 120) ** 2 <= 15 ** 2) inside = true;
  if (column > 0 && (x - left) ** 2 + (y - top - 60) ** 2 <= 17 ** 2) inside = false;
  if (row > 0 && (x - left - 64) ** 2 + (y - top) ** 2 <= 15 ** 2) inside = false;
  return inside;
}

export function makeDemo(): AnalysisInput {
  let seed = 2026;
  const random = (max: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor(seed / 4294967296 * max);
  };
  const reference = frame("演示参考图", 640, 480, [205, 215, 225]);
  for (let i = 0; i < 1000; i++) {
    circle(reference, random(640), random(480), 2 + random(11), [
      65 + random(180), 65 + random(180), 65 + random(180),
    ]);
  }
  const background = [32, 38, 42];
  const assembled = frame("演示已拼区域", 700, 540, background);
  for (let y = 0; y < 480; y++) {
    for (let x = 0; x < 640; x++) {
      if ([0, 1, 5, 6, 10].some((index) => pieceContains(x, y, index))) {
        const offset = (y * 640 + x) * 4;
        assembled.data.set(reference.data.subarray(offset, offset + 4), ((y + 30) * 700 + x + 30) * 4);
      }
    }
  }
  const loose = frame("一张照片中的四块散片", 640, 440, background);
  [[2, 30], [7, 90], [11, 180], [14, 270]].forEach(([pieceIndex, angle], index) => {
    const cx = (pieceIndex % 5) * 128 + 64;
    const cy = Math.floor(pieceIndex / 5) * 120 + 60;
    const radians = angle / 180 * Math.PI;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const targetX = 140 + (index % 2) * 310;
    const targetY = 110 + Math.floor(index / 2) * 220;
    for (let dy = -102; dy <= 102; dy++) {
      for (let dx = -102; dx <= 102; dx++) {
        const x = Math.round(cx + cosine * dx - sine * dy);
        const y = Math.round(cy + sine * dx + cosine * dy);
        if (x >= 0 && x < 640 && y >= 0 && y < 480 && pieceContains(x, y, pieceIndex)) {
          const offset = (y * 640 + x) * 4;
          loose.data.set(reference.data.subarray(offset, offset + 4), ((targetY + dy) * 640 + targetX + dx) * 4);
        }
      }
    }
  });
  return { reference, assembled, loose: [loose], settings: { ...defaultSettings } };
}
