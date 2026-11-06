import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), "web", "dist");
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
};

export function createStaticServer(root = defaultRoot) {
  const directory = resolve(root);
  return createServer((request, response) => {
    async function respond() {
      if (!["GET", "HEAD"].includes(request.method)) {
        response.writeHead(405, { Allow: "GET, HEAD" });
        response.end("This is a static site; photo uploads are processed in the browser.");
        return;
      }
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      } catch (error) {
        if (!(error instanceof URIError) && !(error instanceof TypeError)) throw error;
        response.writeHead(400).end("Invalid URL.");
        return;
      }
      if (pathname.includes("\0")) { response.writeHead(400).end("Invalid path."); return; }
      const relative = pathname.replace(/^[/\\]+/, "") + (pathname.endsWith("/") ? "index.html" : "");
      const target = resolve(directory, relative);
      if (!target.startsWith(directory + sep)) { response.writeHead(403).end("Forbidden."); return; }
      try {
        const info = await stat(target);
        if (!info.isFile()) { response.writeHead(404).end("Not found."); return; }
        response.writeHead(200, {
          "Content-Type": contentTypes[extname(target)] ?? "application/octet-stream",
          "Content-Length": info.size,
          "Cache-Control": "no-cache",
          "X-Content-Type-Options": "nosniff",
        });
        if (request.method === "HEAD") { response.end(); return; }
        response.end(await readFile(target));
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && ["ENOENT", "ENOTDIR"].includes(error.code)) {
          response.writeHead(404).end("Not found. Run npm run build first.");
        } else throw error;
      }
    }
    respond().catch((error) => {
      console.error("Static server request failed:", error);
      if (!response.headersSent) response.writeHead(500);
      response.end("Static server error. See the server log.");
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be between 0 and 65535.");
  const lan = process.argv.includes("--lan");
  const server = createStaticServer();
  server.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, lan ? "0.0.0.0" : "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unexpected server address.");
    console.log(`Static preview: http://127.0.0.1:${address.port}`);
    if (lan) console.log("LAN preview enabled. On iPhone use this computer's LAN IP on the same Wi-Fi. Offline caching requires HTTPS.");
  });
}
