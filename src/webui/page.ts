/**
 * Memory Center 页面（R7-2/3）：宿主 webServer 注册的静态单页（GET only）。
 * - 路径：/dsh-memory/memory            → HTML 外壳
 * - 路径：/dsh-memory/memory/app.js     → SPA 脚本（纯前端展示层）
 * 数据一律通过 R7-1 的 /dsh-memory/api/* 访问，页面不做任何业务逻辑。
 * 屏幕清单来自 models.ts 的 MEMORY_CENTER_SCREENS（单一来源）。
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WebRoute, WebServerLike } from "../cordis/apply.js";
import { MEMORY_CENTER_SCREENS } from "./models.js";

export const MEMORY_PAGE_BASE = "/dsh-memory/memory";

function locateAsset(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "app.js"),
    path.join(here, "..", "..", "src", "webui", "app.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`webui asset not found; tried ${candidates.join(", ")}`);
}

const APP_JS = readFileSync(locateAsset(), "utf8");

const CSS = `
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  background: #0e1420; color: #e8eef7; }
#mc-root { display: flex; min-height: 100vh; }
aside { width: 230px; flex: 0 0 230px; background: #101828; border-right: 1px solid #22304e; padding: 16px 10px; }
aside h1 { font-size: 14px; margin: 2px 8px 6px; color: #fff; letter-spacing: .3px; }
aside h1 span { color: #5b8cff; }
.ng { font-size: 10px; letter-spacing: 1.2px; text-transform: uppercase; color: #7c8db0; margin: 16px 8px 4px; }
.nav { display: block; width: 100%; text-align: left; padding: 7px 9px; margin-bottom: 2px; border: 0;
  border-radius: 7px; background: transparent; color: #cdd7e8; cursor: pointer; font-size: 13px; }
.nav:hover { background: #182338; }
.nav.on { background: #1e2c4d; color: #fff; box-shadow: inset 2px 0 0 #5b8cff; }
main { flex: 1; padding: 18px 24px; min-width: 0; }
main h2 { margin: 0; font-size: 18px; color: #fff; }
.sub { margin: 2px 0 14px; color: #7c8db0; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-bottom: 14px; }
.card { background: #131c30; border: 1px solid #22304e; border-radius: 10px; padding: 10px 12px; }
.card b { display: block; font-size: 21px; color: #fff; }
.card span { font-size: 12px; color: #9fb1d1; }
.panel { background: #131c30; border: 1px solid #22304e; border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; }
.panel h3 { margin: 0 0 8px; font-size: 13px; color: #cdd9f0; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; color: #7c8db0; font-size: 11px; text-transform: uppercase; letter-spacing: .5px;
  padding: 4px 8px; border-bottom: 1px solid #22304e; }
td { padding: 6px 8px; border-bottom: 1px solid #1a2438; vertical-align: top; color: #dbe4f3; }
td.wide { max-width: 640px; }
.bd { display: inline-block; border: 1px solid #2f4066; color: #aab9d6; border-radius: 20px;
  font-size: 11px; padding: 1px 8px; }
button { background: #23304f; color: #e8eef7; border: 1px solid #35507f; border-radius: 7px;
  padding: 4px 10px; margin: 0 6px 4px 0; font-size: 12px; cursor: pointer; }
button.primary { background: #3d66dd; border-color: #3d66dd; }
button.danger { background: #3c1f28; border-color: #6b3240; color: #ffd9df; }
button:hover { filter: brightness(1.15); }
.msg, .err { border-radius: 8px; padding: 8px 12px; margin-bottom: 12px; }
.msg { background: #123423; border: 1px solid #1f5c3c; color: #b5e6cd; }
.err { background: #3c1a20; border: 1px solid #6b3240; color: #ffc6cd; }
.bars { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px 18px; }
.bar .cap { display: flex; justify-content: space-between; color: #9fb1d1; font-size: 12px; }
.track { height: 6px; background: #0c1424; border-radius: 4px; overflow: hidden; margin-top: 3px; }
.track i { display: block; height: 6px; background: #5b8cff; }
.muted { color: #7c8db0; }
pre { background: #0b101d; border: 1px solid #22304e; border-radius: 8px; padding: 10px;
  overflow: auto; white-space: pre-wrap; }
`;

function buildPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Amnesia · Memory Center</title>
<style>${CSS}</style>
<script>window.__mc = { screens: ${JSON.stringify(MEMORY_CENTER_SCREENS)} };</script>
</head>
<body>
<div id="mc-root"></div>
<script src="${MEMORY_PAGE_BASE}/app.js"></script>
</body>
</html>`;
}

const PAGE_HTML = buildPageHtml();

function handlerFor(body: string, contentType: string): NonNullable<WebRoute["handler"]> {
  return (req, res) => {
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      res.end("method not allowed");
      return;
    }
    res.writeHead(200, { "content-type": contentType });
    res.end(body);
  };
}

/** 注册 Memory Center 页面与 SPA 脚本。无 webServer 时静默跳过。 */
export function registerMemoryCenterPage(webServer: WebServerLike | undefined): void {
  if (typeof webServer?.register !== "function") return;
  webServer.register({
    name: "dsh-memory-memory-page",
    kind: "exact",
    path: MEMORY_PAGE_BASE,
    handler: handlerFor(PAGE_HTML, "text/html; charset=utf-8"),
  });
  webServer.register({
    name: "dsh-memory-memory-page-asset",
    kind: "exact",
    path: `${MEMORY_PAGE_BASE}/app.js`,
    handler: handlerFor(APP_JS, "text/javascript; charset=utf-8"),
  });
}
