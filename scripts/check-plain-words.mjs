#!/usr/bin/env node
// Fails when words people read in Star OS hedge or talk about how we checked:
// "may be", "might", "read live", "from this side", "can't confirm", "last
// checked" and the like. Each status says the fact and, when there is one, the
// action. If data is stale, fix the data, not the wording (Hamza, 18 Nov 2026).
//
// It scans source and data a person sees (strings, JSX text, JSON) with code
// comments and console lines removed. Words written for AI models (MCP tool
// descriptions, system prompts) are skipped. A line that must keep such a word
// (a quote, a legal or security notice) carries the marker `plain-words-ok` on
// it or the line above.
//
// Usage: node scripts/check-plain-words.mjs [dir ...]   (default: src app web workers public)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const DIRS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["src", "app", "web", "workers", "public"];
const EXT = /\.(tsx?|jsx?|mjs|json|md|html)$/;
const SKIP_DIR =
  /^(node_modules|dist|build|\.output|\.wrangler|coverage|migrations|drizzle|generated|__generated__|fixtures|mcp|prompts)$/;
const SKIP_FILE =
  /(\.test\.|\.spec\.|\.d\.ts$|routeTree\.gen|worker-configuration|package(-lock)?\.json$|tsconfig.*\.json$|\.min\.|[Pp]rompts?\.|mcp[-.]|check-plain-words)/;
const CONSOLE = /\bconsole\.(?:log|info|warn|error|debug)\(/;

// "may" counts only as a guess ("may be", "may have"), not as permission
// ("only listed domains may send"). Lowercase only, so the month "May" passes.
/** @type {Array<[RegExp, string]>} */
const RULES = [
  [/\b(?:not |was not |wasn't )?read live\b/i, "read live"],
  [/\bfrom (?:this|our) side\b/i, "from this side"],
  // Present tense is the hedge ("we can't confirm it ran"). "We couldn't verify
  // your email" reports a check that failed, which is a fact.
  [/\b(?:can'?t|cannot|unable to) (?:confirm|verify)\b/i, "can't confirm"],
  [/\blast checked\b/i, "last checked"],
  [/\bmight\b/, "might"],
  [
    /\bmay (?:be|have|not|take|still|need|also|well|contain|differ|vary|fail|charge|cost|show|appear|look|lag|miss|seem|falter|offer|stop|break|change)\b/,
    "may (a guess)",
  ],
  [/\b(?:perhaps|possibly|probably|presumably)\b/i, "perhaps / possibly"],
  [/\b(?:appears|seems) to\b/i, "appears to"],
  [/\bwe (?:think|believe)\b/i, "we think"],
];

/**
 * @param {string} dir
 * @returns {Generator<string>}
 */
function* files(dir) {
  /** @type {string[]} */
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIR.test(name)) yield* files(p);
    } else if (EXT.test(name) && !SKIP_FILE.test(name) && st.size < 2_000_000) {
      yield p;
    }
  }
}

/**
 * Blank out comments, keeping line numbers. Strings stay.
 * @param {string} text
 * @param {boolean} isCode
 * @returns {string}
 */
function stripComments(text, isCode) {
  if (!isCode) return text;
  let out = "";
  let i = 0;
  /** @type {string | null} */
  let quote = null;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i += 2;
        continue;
      }
      if (c === quote || (c === "\n" && quote !== "`")) quote = null;
      i++;
      continue;
    }
    if (c === "/" && n === "/" && text[i - 1] !== ":") {
      // A line comment, unless it is a URL inside JSX text.
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = text.indexOf("*/", i + 2);
      const chunk = text.slice(i, end === -1 ? text.length : end + 2);
      out += chunk.replace(/[^\n]/g, " ");
      i += chunk.length;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    out += c;
    i++;
  }
  return out;
}

/** @type {string[]} */
const hits = [];
for (const d of DIRS) {
  const dir = join(ROOT, d);
  if (!existsSync(dir)) continue;
  for (const f of files(dir)) {
    const raw = readFileSync(f, "utf8");
    const isCode = /\.(tsx?|jsx?|mjs)$/.test(f);
    const lines = stripComments(raw, isCode).split("\n");
    const rawLines = raw.split("\n");
    lines.forEach((line, i) => {
      if (
        /plain-words-ok/.test(rawLines[i] ?? "") ||
        /plain-words-ok/.test(rawLines[i - 1] ?? "")
      )
        return;
      if (CONSOLE.test(line)) return;
      for (const [re, name] of RULES) {
        if (re.test(line)) {
          hits.push(
            `${relative(ROOT, f).replace(/\\/g, "/")}:${i + 1}  [${name}]  ${line.trim().slice(0, 140)}`,
          );
          break;
        }
      }
    });
  }
}

if (hits.length) {
  console.error(
    `Plain words: ${hits.length} hedge or meta phrase(s). Say the fact and the action instead.\n`,
  );
  console.error(hits.join("\n"));
  process.exit(1);
}
console.log("Plain words: no hedge or meta phrases.");
