"use strict";
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const sources = [
  "src/wiser-schedule-core.js",
  "src/wiser-native-schedule-card.js"
];
const banner = "/* Wiser Style Heating schedule editor - generated from src/. MIT; see LICENSE and docs/ATTRIBUTION.md */\n";
const bundle = banner + sources.map((name) => fs.readFileSync(path.join(root, name), "utf8")).join("\n\n");
const output = path.join(root, "dist/wiser-native-schedule-card.js");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, bundle);
console.log("Built", path.relative(root, output), "-", Buffer.byteLength(bundle), "bytes");
