import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const THEME_NAME = "material_black_simple";

/**
 * Runtime config for the patched renderer.
 *
 * The patch reads this file directly (it runs inside pi's own module, so it
 * cannot import from the extension). Keeping it in ~/.pi means it is shared by
 * every profile that uses the same binary.
 */
export const CONFIG_PATH = join(homedir(), ".pi", "material-black-simple.json");

export interface Config {
  /** Apply the highlighting even when another theme is active. */
  overlay: boolean;
  /** Colour overrides; empty string / undefined = fall back to the theme. */
  inputBg?: string;
  inputFontColor?: string;
  finalOutputBg?: string;
  finalFontColor?: string;
  intermediateBg?: string;
  intermediateFontColor?: string;
}

export const COLOR_KEYS = [
  "input-bg",
  "input-font-color",
  "final-output-bg",
  "final-font-color",
  "intermediate-bg",
  "intermediate-font-color",
] as const;

export type ColorKey = (typeof COLOR_KEYS)[number];

const KEY_MAP: Record<ColorKey, keyof Config> = {
  "input-bg": "inputBg",
  "input-font-color": "inputFontColor",
  "final-output-bg": "finalOutputBg",
  "final-font-color": "finalFontColor",
  "intermediate-bg": "intermediateBg",
  "intermediate-font-color": "intermediateFontColor",
};

const DEFAULTS: Config = { overlay: false };

export function normalizeHex(input: string): string {
  const m = input.trim().match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) throw new Error(`expected a hex colour like #1565c0, got "${input}"`);
  return `#${m[1].toLowerCase()}`;
}

export function readConfig(): Config {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeConfig(cfg: Config): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`);
}

export function setColor(key: ColorKey, value: string | undefined): Config {
  const cfg = readConfig();
  const field = KEY_MAP[key];
  if (value === undefined || value === "" || value === "reset") {
    delete cfg[field];
  } else {
    (cfg[field] as string) = normalizeHex(value);
  }
  writeConfig(cfg);
  return cfg;
}

export function getColor(key: ColorKey): string | undefined {
  return readConfig()[KEY_MAP[key]] as string | undefined;
}

export function setOverlay(on: boolean): Config {
  const cfg = readConfig();
  cfg.overlay = on;
  writeConfig(cfg);
  return cfg;
}

/** True when the config file exists (used to decide first-run theme activation). */
export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}
