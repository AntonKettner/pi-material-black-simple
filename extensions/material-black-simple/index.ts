import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyPatch, findTargets, revertPatch } from "./patch.ts";
import { currentOpacity, setBgOpacity } from "./opacity.ts";
import {
  COLOR_KEYS,
  type ColorKey,
  THEME_NAME,
  configExists,
  getColor,
  readConfig,
  setColor,
  setOverlay,
  writeConfig,
} from "./config.ts";

/**
 * Keeps the "final assistant answer gets a background" tweak applied.
 *
 * pi has no install/upgrade hook, so this re-checks on startup. A `brew upgrade`
 * lands in a fresh versioned directory, which arrives unpatched; the next launch
 * detects and repairs it. Already-patched installs are a cheap string check.
 *
 * The patch itself renders intermediate assistant text (messages containing a
 * toolCall) in "muted", and final answers in "text" on the "selectedBg" colour.
 */
export default function assistantBg(pi: ExtensionAPI) {
  pi.on("session_start", async (event, ctx) => {
    // Only on a cold start: reloads and session switches can't change the install.
    if (event.reason !== "startup") return;

    // First run: create the config and switch to the theme this package ships.
    const firstRun = !configExists();
    if (firstRun) {
      writeConfig(readConfig());
      const res = ctx.ui.setTheme(THEME_NAME);
      ctx.ui.notify(
        res.success
          ? `material-black-simple: theme activated`
          : `material-black-simple: could not activate theme (${res.error ?? "unknown"})`,
        res.success ? "info" : "warning",
      );
    }

    const results = applyPatch();
    const patched = results.filter((r) => r.status === "patched");
    const failed = results.filter((r) => r.status === "failed");

    if (patched.length > 0) {
      ctx.ui.notify(
        `material-black-simple: patched ${patched.length} install(s) after upgrade - restart pi to apply`,
        "warning",
      );
    }
    for (const f of failed) {
      if (f.status === "failed") ctx.ui.notify(`material-black-simple: ${f.reason}`, "error");
    }
  });

  pi.registerCommand("material-black-simple", {
    description: "restart | status | revert | bg-opacity | overlay | <colour> <hex> - manage material_black_simple",
    handler: async (args, ctx) => {
      const arg = args.trim();

      const overlayArg = /^overlay(?:\s+(.*))?$/.exec(arg);
      if (overlayArg) {
        const v = overlayArg[1]?.trim();
        if (!v) {
          ctx.ui.notify(`overlay: ${readConfig().overlay ? "activated" : "deactivated"}`, "info");
          return;
        }
        if (v !== "activate" && v !== "deactivate") {
          ctx.ui.notify("usage: /material-black-simple overlay activate | deactivate", "error");
          return;
        }
        const on = v === "activate";
        setOverlay(on);
        ctx.ui.notify(
          on
            ? "overlay activated - highlighting now applies to every theme"
            : `overlay deactivated - highlighting only applies to ${THEME_NAME}`,
          "info",
        );
        return;
      }

      const colorArg = /^([a-z-]+)(?:\s+(.*))?$/.exec(arg);
      if (colorArg && (COLOR_KEYS as readonly string[]).includes(colorArg[1])) {
        const key = colorArg[1] as ColorKey;
        const value = colorArg[2]?.trim();
        if (!value) {
          const cur = getColor(key);
          ctx.ui.notify(`${key}: ${cur ?? "(theme default)"}`, "info");
          return;
        }
        try {
          setColor(key, value);
          const cur = getColor(key);
          ctx.ui.notify(`${key} = ${cur ?? "(theme default)"} - reselect via /theme to see it`, "info");
        } catch (e) {
          ctx.ui.notify(`${key}: ${(e as Error).message}`, "error");
        }
        return;
      }

      const opacityArg = /^bg-opacity(?:\s+(.*))?$/.exec(arg);
      if (opacityArg) {
        const value = opacityArg[1]?.trim();
        if (!value) {
          const cur = currentOpacity();
          ctx.ui.notify(
            cur === undefined
              ? "bg-opacity: current value not recognised (theme edited by hand?)"
              : `bg-opacity: currently ${cur}%`,
            "info",
          );
          return;
        }
        const percent = Number(value);
        if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
          ctx.ui.notify(`bg-opacity: expected a number 0-100, got "${value}"`, "error");
          return;
        }
        try {
          const r = setBgOpacity(percent);
          ctx.ui.notify(
            `bg-opacity ${r.percent}% - user ${r.green}, answer ${r.blue} ` +
              `(white text ${r.textContrast.blue.toFixed(1)}:1, vs page ${r.pageContrast.blue.toFixed(2)}:1)`,
            "info",
          );
          if (r.pageContrast.blue < 1.2) {
            ctx.ui.notify("bg-opacity: backgrounds are nearly invisible against the page", "warning");
          }
          ctx.ui.notify("reselect the theme via /theme to see the change", "info");
        } catch (e) {
          ctx.ui.notify(`bg-opacity failed: ${(e as Error).message}`, "error");
        }
        return;
      }

      if (arg === "revert") {
        for (const r of revertPatch()) {
          ctx.ui.notify(
            r.status === "failed" ? `revert failed: ${r.reason}` : `reverted: ${r.file}`,
            r.status === "failed" ? "error" : "info",
          );
        }
        return;
      }

      const targets = findTargets();
      if (targets.length === 0) {
        ctx.ui.notify("material-black-simple: no pi-coding-agent install found", "error");
        return;
      }

      if (arg === "status") {
        for (const t of targets) {
          const state = readFileSync(t, "utf8").includes("isIntermediate") ? "patched" : "NOT patched";
          ctx.ui.notify(`${state}: ${t}`, state === "patched" ? "info" : "warning");
        }
        const cfg = readConfig();
        ctx.ui.notify(`overlay: ${cfg.overlay ? "activated" : "deactivated"}`, "info");
        for (const k of COLOR_KEYS) ctx.ui.notify(`${k}: ${getColor(k) ?? "(theme default)"}`, "info");
        return;
      }

      if (arg !== "restart") {
        ctx.ui.notify(
          "usage: /material-black-simple restart | status | revert | bg-opacity <0-100> | " +
            `overlay activate|deactivate | ${COLOR_KEYS.join("|")} <hex|reset>`,
          "info",
        );
        return;
      }

      for (const r of applyPatch()) {
        const msg =
          r.status === "patched"
            ? `patched: ${r.file}`
            : r.status === "already"
              ? `already patched: ${r.file}`
              : `failed: ${r.reason}`;
        ctx.ui.notify(msg, r.status === "failed" ? "error" : "info");
      }
    },
  });
}
