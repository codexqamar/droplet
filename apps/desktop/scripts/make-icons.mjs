// Renders the DROPLET app icon SVG to the PNGs consumed by `tauri icon` and the web favicon.
import { Resvg } from "@resvg/resvg-js";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(join(root, "assets/icon.svg"), "utf8");
const png = new Resvg(svg, { fitTo: { mode: "width", value: 1024 } }).render().asPng();
writeFileSync(join(root, "assets/icon-1024.png"), png);

const webPublic = join(root, "../web/public");
mkdirSync(webPublic, { recursive: true });
copyFileSync(join(root, "assets/icon.svg"), join(webPublic, "favicon.svg"));
writeFileSync(join(webPublic, "apple-touch-icon.png"), new Resvg(svg, { fitTo: { mode: "width", value: 180 } }).render().asPng());
console.log("icons rendered");
