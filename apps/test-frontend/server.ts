import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const HOST = process.env.TEST_FRONTEND_HOST ?? "127.0.0.1";
const PORT = Number(process.env.TEST_FRONTEND_PORT ?? "4174");
const WEB_ROOT = path.resolve(__dirname, "frontend");
const API_BASE = process.env.LOWKIE_API_BASE?.trim() ?? "";

function respond(
  res: http.ServerResponse,
  status: number,
  body: string,
  contentType: string,
): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function serveFile(res: http.ServerResponse, filePath: string): void {
  if (!fs.existsSync(filePath)) {
    respond(
      res,
      404,
      JSON.stringify({ error: "Not found" }),
      "application/json; charset=utf-8",
    );
    return;
  }

  const ext = path.extname(filePath);
  const contentType =
    ext === ".html"
      ? "text/html; charset=utf-8"
      : ext === ".css"
        ? "text/css; charset=utf-8"
        : ext === ".js"
          ? "application/javascript; charset=utf-8"
          : "text/plain; charset=utf-8";

  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  if (!req.url || !req.method || req.method !== "GET") {
    respond(
      res,
      405,
      JSON.stringify({ error: "Method not allowed" }),
      "application/json; charset=utf-8",
    );
    return;
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname === "/config.js") {
    respond(
      res,
      200,
      `window.LOWKIE_API_BASE = ${JSON.stringify(API_BASE)};\n`,
      "application/javascript; charset=utf-8",
    );
    return;
  }

  const relativePath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.resolve(WEB_ROOT, `.${relativePath}`);
  const normalizedPath = path.relative(WEB_ROOT, filePath);
  if (normalizedPath.startsWith("..") || path.isAbsolute(normalizedPath)) {
    respond(
      res,
      403,
      JSON.stringify({ error: "Forbidden" }),
      "application/json; charset=utf-8",
    );
    return;
  }

  serveFile(res, filePath);
});

server.listen(PORT, HOST, () => {
  console.log("\nLowkie Test Frontend");
  console.log(`  URL:      http://${HOST}:${PORT}`);
  console.log(`  API Base: ${API_BASE || "window.location.origin"}`);
});