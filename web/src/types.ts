import type { Feature2D } from "@techstark/opencv-js";

export type Cv = typeof import("@techstark/opencv-js") & {
  AKAZE: new () => Feature2D;
};
export type Point = [number, number];

export const MAX_SIDE = 1200;
export const MAX_PHOTOS = 5;

export interface Frame {
  name: string;
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

export interface Settings {
  background: "auto" | "light" | "dark";
  tolerance: number;
  minAreaFraction: number;
  maxPieces: number;
  templateFallback: boolean;
  approximateColumns: number;
}

export interface AnalysisInput {
  reference: Frame;
  assembled: Frame | null;
  loose: Frame[];
  settings: Settings;
}

export interface Candidate {
  method: "orb" | "akaze" | "template";
  model: "homography" | "similarity" | "template";
  transform: number[];
  polygon: Point[];
  outline: Point[];
  center: Point;
  score: number;
  inliers: number;
  reliable: boolean;
  overlap: number | null;
  contact: number | null;
  edgeScore: number | null;
}

export interface PieceResult {
  id: string;
  source: string;
  thumbnail: Frame;
  suspectedJoined: boolean;
  candidate: Candidate | null;
  alternatives: Candidate[];
}

export interface AnalysisResult {
  reference: Frame;
  previews: Frame[];
  occupied: Uint8Array<ArrayBuffer> | null;
  pieces: PieceResult[];
  warnings: string[];
  elapsedMs: number;
}

export type WorkerRequest = { type: "analyze"; id: number; input: AnalysisInput };
export type WorkerReply =
  | { type: "ready" }
  | { type: "progress"; id: number; text: string; value: number }
  | { type: "result"; id: number; result: AnalysisResult }
  | { type: "error"; id: number | null; message: string; fatal: boolean };

export const defaultSettings: Settings = {
  background: "auto",
  tolerance: 32,
  minAreaFraction: 0.002,
  maxPieces: 30,
  templateFallback: true,
  approximateColumns: 10,
};

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return `OpenCV 错误 ${String(error)}。请缩小照片或重新加载识别引擎。`;
}

export function inputTransfers(input: AnalysisInput): ArrayBuffer[] {
  return [input.reference, ...(input.assembled ? [input.assembled] : []), ...input.loose]
    .map((frame) => frame.data.buffer);
}

export function resultTransfers(result: AnalysisResult): ArrayBuffer[] {
  const buffers = [
    result.reference,
    ...result.previews,
    ...result.pieces.map((piece) => piece.thumbnail),
  ].map((frame) => frame.data.buffer);
  if (result.occupied) buffers.push(result.occupied.buffer);
  return buffers;
}
