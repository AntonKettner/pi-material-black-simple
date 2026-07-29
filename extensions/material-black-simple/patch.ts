import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { THEME_NAME } from "./config.ts";

const REL = "dist/modes/interactive/components/assistant-message.js";
const REL_MODE = "dist/modes/interactive/interactive-mode.js";
const REL_USER = "dist/modes/interactive/components/user-message.js";

const CTOR_ANCHOR = "        if (message) {\n            this.updateContent(message);\n        }";
const INVALIDATE_ANCHOR = "    invalidate() {\n        super.invalidate();";
const FLAG_ANCHOR = "        const hasVisibleContent = message.content.some(";
const MD_ANCHOR =
  "                this.contentContainer.addChild(new Markdown(content.text.trim(), this.outputPad, 0, this.markdownTheme));";

/**
 * Only a *finalized* message with no tool call is a final answer.
 *
 * `stopReason` turned out to be unreliable as a "is it done" signal: providers
 * can populate it on a message that is still streaming, which made intermediate
 * text briefly flash with the final-answer background.
 *
 * So finality is now explicit instead of inferred:
 *  - a component constructed WITH a message is a history/replay render -> final
 *  - the live streaming component is constructed empty and is marked final only
 *    when interactive-mode calls markFinal() at message_end
 */
const CTOR_INJECT = `        this.isFinalized = !!message;
${CTOR_ANCHOR}`;

const MARK_FINAL_INJECT = `    markFinal() {
        this.isFinalized = true;
        if (this.lastMessage) {
            this.updateContent(this.lastMessage);
        }
    }
`;

const FLAG_INJECT =
  '        const isIntermediate = !this.isFinalized || message.stopReason === "aborted" || message.stopReason === "error" || message.content.some((c) => c.type === "toolCall");\n';

// interactive-mode.js: finalize the live component at message_end, right before
// it is dropped. Anchored on the updateContent call that applies the final message.
const MODE_ANCHOR = `                    this.streamingComponent.updateContent(this.streamingMessage);
                    if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {`;
const MODE_INJECT = `                    this.streamingComponent.updateContent(this.streamingMessage);
                    this.streamingComponent.markFinal?.();
                    if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {`;

// Runtime helpers injected into the component module. The patched code runs
// inside pi's own bundle and cannot import from this extension, so the config
// is read from disk (cached for 1s to avoid per-render file reads).
const HELPER_ANCHOR = "export class AssistantMessageComponent extends Container {";
const HELPERS = `import { createRequire as __mbsCreateRequire } from "node:module";
const __mbsRequire = __mbsCreateRequire(import.meta.url);
const __mbsConfigPath = __mbsRequire("node:path").join(__mbsRequire("node:os").homedir(), ".pi", "material-black-simple.json");
let __mbsCache = { at: 0, value: { overlay: false } };
function __mbsConfig() {
    const now = Date.now();
    if (now - __mbsCache.at < 1000) return __mbsCache.value;
    let value = { overlay: false };
    try {
        value = { overlay: false, ...JSON.parse(__mbsRequire("node:fs").readFileSync(__mbsConfigPath, "utf8")) };
    }
    catch { }
    __mbsCache = { at: now, value };
    return value;
}
/** Styling applies to material_black_simple, or to any theme when overlay is on. */
function __mbsActive() {
    const cfg = __mbsConfig();
    return cfg.overlay || theme.name === "${THEME_NAME}";
}
function __mbsHex(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function __mbsFg(override, fallbackKey) {
    if (override)
        return (text) => \`\\x1b[38;2;\${__mbsHex(override).join(";")}m\${text}\\x1b[39m\`;
    return (text) => theme.fg(fallbackKey, text);
}
function __mbsBg(override, fallbackKey) {
    if (override)
        return (text) => \`\\x1b[48;2;\${__mbsHex(override).join(";")}m\${text}\\x1b[49m\`;
    return fallbackKey ? (text) => theme.bg(fallbackKey, text) : undefined;
}
`;

const HELPER_INJECT = `${HELPERS}${HELPER_ANCHOR}`;

// user-message.js: same helpers, plus overrides for the user bubble.
const USER_ANCHOR = "export class UserMessageComponent extends Container {";
const USER_HELPER_INJECT = `${HELPERS}${USER_ANCHOR}`;
const USER_BOX_ANCHOR = `        const contentBox = new Box(this.outputPad, 1, (content) => theme.bg("userMessageBg", content));
        contentBox.addChild(new Markdown(this.text, 0, 0, this.markdownTheme, {
            color: (content) => theme.fg("userMessageText", content),
        }, { preserveOrderedListMarkers: true, preserveBackslashEscapes: true }));`;
const USER_BOX_INJECT = `        const __mbsCfg = __mbsConfig();
        const __mbsOn = __mbsActive();
        const contentBox = new Box(this.outputPad, 1, __mbsOn && __mbsCfg.inputBg
            ? __mbsBg(__mbsCfg.inputBg, "userMessageBg")
            : (content) => theme.bg("userMessageBg", content));
        contentBox.addChild(new Markdown(this.text, 0, 0, this.markdownTheme, {
            color: __mbsOn && __mbsCfg.inputFontColor
                ? __mbsFg(__mbsCfg.inputFontColor, "userMessageText")
                : (content) => theme.fg("userMessageText", content),
        }, { preserveOrderedListMarkers: true, preserveBackslashEscapes: true }));`;

const MD_REPLACEMENT = `                const __mbsCfg = __mbsConfig();
                this.contentContainer.addChild(new Markdown(content.text.trim(), this.outputPad, 0, this.markdownTheme, !__mbsActive()
                    ? undefined
                    : isIntermediate
                        ? {
                            color: __mbsFg(__mbsCfg.intermediateFontColor, "muted"),
                            bgColor: __mbsBg(__mbsCfg.intermediateBg, undefined),
                        }
                        : {
                            color: __mbsFg(__mbsCfg.finalFontColor, "text"),
                            bgColor: __mbsBg(__mbsCfg.finalOutputBg, "selectedBg"),
                        }));`;

export type PatchOutcome =
  | { status: "patched"; file: string }
  | { status: "already"; file: string }
  | { status: "failed"; file: string; reason: string };

/**
 * Locate every pi-coding-agent install: the one `pi` actually runs (often a
 * Homebrew cellar path that changes on every upgrade) plus local copies.
 */
export function findTargets(): string[] {
  const roots = new Set<string>();

  try {
    const bin = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
    // <prefix>/bin/pi -> <prefix>/libexec/lib/node_modules/@earendil-works/pi-coding-agent
    const pkg = join(dirname(dirname(bin)), "libexec/lib/node_modules/@earendil-works/pi-coding-agent");
    if (existsSync(join(pkg, REL))) roots.add(pkg);
  } catch {
    // `which pi` missing (e.g. run via npx) - local copies below still apply.
  }

  for (const dir of ["agent", "cc"]) {
    const pkg = join(homedir(), ".pi", dir, "node_modules/@earendil-works/pi-coding-agent");
    if (existsSync(join(pkg, REL))) roots.add(pkg);
  }

  return [...roots].map((r) => join(r, REL));
}

export function patchFile(file: string): PatchOutcome {
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch (e) {
    return { status: "failed", file, reason: `unreadable: ${(e as Error).message}` };
  }

  if (src.includes("isIntermediate")) return { status: "already", file };

  for (const [name, anchor] of [
    ["class header", HELPER_ANCHOR],
    ["constructor", CTOR_ANCHOR],
    ["hasVisibleContent", FLAG_ANCHOR],
    ["Markdown call", MD_ANCHOR],
    ["invalidate", INVALIDATE_ANCHOR],
  ] as const) {
    const n = src.split(anchor).length - 1;
    if (n !== 1) {
      return { status: "failed", file, reason: `expected 1 "${name}" anchor, found ${n} (upstream changed)` };
    }
  }

  const next = src
    .replace(HELPER_ANCHOR, HELPER_INJECT)
    .replace(CTOR_ANCHOR, CTOR_INJECT)
    .replace(INVALIDATE_ANCHOR, MARK_FINAL_INJECT + INVALIDATE_ANCHOR)
    .replace(FLAG_ANCHOR, FLAG_INJECT + FLAG_ANCHOR)
    .replace(MD_ANCHOR, MD_REPLACEMENT);

  try {
    if (!existsSync(`${file}.orig`)) copyFileSync(file, `${file}.orig`);
    writeFileSync(file, next);
  } catch (e) {
    return { status: "failed", file, reason: `not writable: ${(e as Error).message}` };
  }

  return { status: "patched", file };
}

/** Patch user-message.js so input bg/font overrides apply. */
function patchUser(file: string): PatchOutcome {
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch (e) {
    return { status: "failed", file, reason: `unreadable: ${(e as Error).message}` };
  }

  if (src.includes("__mbsConfig")) return { status: "already", file };

  for (const [name, anchor] of [
    ["class header", USER_ANCHOR],
    ["content box", USER_BOX_ANCHOR],
  ] as const) {
    const n = src.split(anchor).length - 1;
    if (n !== 1) {
      return { status: "failed", file, reason: `expected 1 "${name}" anchor, found ${n} (upstream changed)` };
    }
  }

  const next = src.replace(USER_ANCHOR, USER_HELPER_INJECT).replace(USER_BOX_ANCHOR, USER_BOX_INJECT);

  try {
    if (!existsSync(`${file}.orig`)) copyFileSync(file, `${file}.orig`);
    writeFileSync(file, next);
  } catch (e) {
    return { status: "failed", file, reason: `not writable: ${(e as Error).message}` };
  }

  return { status: "patched", file };
}

/** Patch interactive-mode.js so the live component is finalized at message_end. */
function patchMode(file: string): PatchOutcome {
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch (e) {
    return { status: "failed", file, reason: `unreadable: ${(e as Error).message}` };
  }

  if (src.includes("markFinal")) return { status: "already", file };

  const n = src.split(MODE_ANCHOR).length - 1;
  if (n !== 1) {
    return { status: "failed", file, reason: `expected 1 "message_end" anchor, found ${n} (upstream changed)` };
  }

  try {
    if (!existsSync(`${file}.orig`)) copyFileSync(file, `${file}.orig`);
    writeFileSync(file, src.replace(MODE_ANCHOR, MODE_INJECT));
  } catch (e) {
    return { status: "failed", file, reason: `not writable: ${(e as Error).message}` };
  }

  return { status: "patched", file };
}

export function applyPatch(): PatchOutcome[] {
  return findTargets().flatMap((file) => [
    patchFile(file),
    patchMode(file.replace(REL, REL_MODE)),
    patchUser(file.replace(REL, REL_USER)),
  ]);
}

export function revertPatch(): PatchOutcome[] {
  return findTargets()
    .flatMap((f) => [f, f.replace(REL, REL_MODE), f.replace(REL, REL_USER)])
    .map((file) => {
    const orig = `${file}.orig`;
    if (!existsSync(orig)) return { status: "failed", file, reason: "no .orig backup found" };
    try {
      copyFileSync(orig, file);
      return { status: "patched", file };
    } catch (e) {
      return { status: "failed", file, reason: (e as Error).message };
    }
  });
}
