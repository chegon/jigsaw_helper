import { build } from "esbuild";
import { zipSync, zlibSync } from "fflate";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPrivacy } from "./check-private-data.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const privacy = checkPrivacy({ root });
console.log(`Private-data preflight passed (${privacy.privateConfigPresent ? "local identifiers and generic patterns" : "generic patterns only"}).`);
const dist = join(root, "web", "dist");
const source = join(root, "web", "public");
await mkdir(dist, { recursive: true });

await Promise.all([
  build({ entryPoints: [join(root, "web", "src", "app.ts")], outfile: join(dist, "app.js"), bundle: true, minify: true, format: "iife", target: "safari16" }),
  build({ entryPoints: [join(root, "web", "src", "worker.ts")], outfile: join(dist, "worker.js"), bundle: true, minify: true, format: "iife", target: "safari16" }),
]);

const assets = ["index.html", "app.css", "manifest.webmanifest", "icon.svg", "THIRD-PARTY-NOTICES.txt", "app.js", "worker.js", "opencv.js", "LICENSE-opencv-js.txt"];
for (const name of ["index.html", "app.css", "manifest.webmanifest", "icon.svg", "THIRD-PARTY-NOTICES.txt"]) {
  await copyFile(join(source, name), join(dist, name));
}
await copyFile(join(root, "node_modules", "@techstark", "opencv-js", "dist", "opencv.js"), join(dist, "opencv.js"));
await copyFile(join(root, "node_modules", "@techstark", "opencv-js", "LICENSE"), join(dist, "LICENSE-opencv-js.txt"));

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, bytes) {
  const body = Buffer.concat([Buffer.from(type), bytes]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

function iconPng(size) {
  const stride = size * 4 + 1;
  const raw = new Uint8Array(stride * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x / size * 192, py = y / size * 192;
      let tile = px >= 48 && px <= 144 && py >= 54 && py <= 148;
      if ((px - 96) ** 2 + (py - 48) ** 2 <= 23 ** 2) tile = true;
      if ((px - 144) ** 2 + (py - 100) ** 2 <= 23 ** 2) tile = true;
      if ((px - 48) ** 2 + (py - 100) ** 2 <= 20 ** 2) tile = false;
      if ((px - 96) ** 2 + (py - 148) ** 2 <= 20 ** 2) tile = false;
      raw.set(tile ? [243, 241, 223, 255] : [18, 109, 101, 255], y * stride + 1 + x * 4);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", Buffer.from(zlibSync(raw))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const [name, size] of [["apple-touch-icon.png", 180], ["icon-192.png", 192], ["icon-512.png", 512]]) {
  await writeFile(join(dist, name), iconPng(size));
  assets.push(name);
}
const files = Object.fromEntries(await Promise.all(assets.map(async (name) => [name, await readFile(join(dist, name))])));
const version = createHash("sha256").update(Buffer.concat(Object.values(files))).digest("hex").slice(0, 16);
const serviceWorker = (await readFile(join(source, "sw.js"), "utf8"))
  .replace("__ASSET_VERSION__", version)
  .replace("__ASSETS__", JSON.stringify(assets));
await writeFile(join(dist, "sw.js"), serviceWorker);
files["sw.js"] = Buffer.from(serviceWorker);
const archive = zipSync(files, { level: 6 });
await writeFile(join(root, "web", "puzzle-iphone.zip"), archive);
console.log(`Built ${Object.keys(files).length} static files; OpenCV.js ${(files["opencv.js"].length / 1024 / 1024).toFixed(1)} MiB.`);
console.log(`Static folder: ${dist}`);
console.log(`iPhone package: ${join(root, "web", "puzzle-iphone.zip")} (${(archive.length / 1024 / 1024).toFixed(1)} MiB)`);
