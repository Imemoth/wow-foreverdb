// Dev helper: node scripts/content-art/preview.mjs <a|b> <out.png>
import { renderSvgToPng } from "./render.mjs";
const [which, out] = process.argv.slice(2);
const mod = which === "a" ? await import("./scene-beginners-guide.mjs") : await import("./scene-race-class.mjs");
const svg = which === "a" ? mod.buildBeginnersGuideSvg() : mod.buildRaceClassSvg();
await renderSvgToPng(svg, out);
console.log("rendered", out, svg.length, "bytes of svg");
