import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR } from "./config.ts";

const THEME_FILE = "material_black_simple.json";

/**
 * Resolve the theme JSON we should rewrite.
 *
 * Prefers the copy shipped alongside this extension (`<pkg>/themes/`), so an
 * installed package edits its own file. Falls back to a user-local copy for
 * people who vendored the theme by hand.
 */
function resolveThemePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../../themes", THEME_FILE), // published package layout
    join(homedir(), CONFIG_DIR, "agent/themes", THEME_FILE), // hand-installed
    join(homedir(), CONFIG_DIR, "cc/themes", THEME_FILE),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[1];
}

export const THEME_PATH: string = resolveThemePath();

/** Full-strength source colours. Blends are always computed from these, never
 *  from the current (already blended) values, so repeated changes don't compound. */
const BASE = { green: "#2e7d32", blue: "#1565c0" } as const;

type Hex = `#${string}`;

function parseHex(hex: string): [number, number, number] {
  const m = hex.trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) throw new Error(`invalid hex colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: [number, number, number]): Hex {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

/** Alpha-composite `fg` over `bg` at the given opacity (0..1). */
export function blend(fg: string, bg: string, opacity: number): Hex {
  const f = parseHex(fg);
  const b = parseHex(bg);
  return toHex([0, 1, 2].map((i) => f[i] * opacity + b[i] * (1 - opacity)) as [number, number, number]);
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export interface OpacityResult {
  percent: number;
  green: Hex;
  blue: Hex;
  /** Contrast of white text on each new background. */
  textContrast: { green: number; blue: number };
  /** Contrast of each background against the page background. */
  pageContrast: { green: number; blue: number };
}

/**
 * Rewrite the `green`/`blue` vars to `percent` opacity over the theme's page
 * background. Only those two vars change; every foreground stays full strength.
 */
export function setBgOpacity(percent: number, themePath: string = THEME_PATH): OpacityResult {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error(`opacity must be 0-100, got: ${percent}`);
  }

  const raw = readFileSync(themePath, "utf8");
  const theme = JSON.parse(raw);
  const pageBg: string = theme.vars?.bg ?? "#0a0a0a";
  const o = percent / 100;

  const green = blend(BASE.green, pageBg, o);
  const blue = blend(BASE.blue, pageBg, o);

  // Preserve the file's existing indentation style.
  const indent = /\n(\s+)"/.exec(raw)?.[1]?.length ?? 2;
  theme.vars.green = green;
  theme.vars.blue = blue;
  writeFileSync(themePath, `${JSON.stringify(theme, null, indent)}\n`);

  return {
    percent,
    green,
    blue,
    textContrast: { green: contrast("#ffffff", green), blue: contrast("#ffffff", blue) },
    pageContrast: { green: contrast(green, pageBg), blue: contrast(blue, pageBg) },
  };
}

/** Recover the current opacity by matching the stored blue against the base. */
export function currentOpacity(themePath: string = THEME_PATH): number | undefined {
  const theme = JSON.parse(readFileSync(themePath, "utf8"));
  const pageBg: string = theme.vars?.bg ?? "#0a0a0a";
  const current: string | undefined = theme.vars?.blue;
  if (!current) return undefined;
  for (let p = 0; p <= 100; p++) {
    if (blend(BASE.blue, pageBg, p / 100).toLowerCase() === current.toLowerCase()) return p;
  }
  return undefined;
}
