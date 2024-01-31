import fs from "node:fs/promises";
import * as path from "node:path";
import URL from "node:url";
import { test, expect } from "@playwright/test";
import { normalizePath } from "vite";
import getPort from "get-port";

import {
  createProject,
  viteDev,
  viteBuild,
  VITE_CONFIG,
} from "./helpers/vite.js";

const js = String.raw;

test.describe(async () => {
  let port: number;
  let cwd: string;
  let stop: () => void;

  function pathStartsWithCwd(pathname: string) {
    return normalizePath(pathname).startsWith(normalizePath(cwd));
  }

  function relativeToCwd(pathname: string) {
    return normalizePath(path.relative(cwd, pathname));
  }

  test.beforeAll(async () => {
    port = await getPort();
    cwd = await createProject({
      "vite.config.ts": await VITE_CONFIG({
        port,
        pluginOptions: js`
          {
            presets: [
              // Ensure accumulated remixConfig starts as an empty object
              {
                remixConfig: async ({ remixConfig }) => {
                  if (Object.keys(remixConfig).length !== 0) {
                    throw new Error("Accumulated Remix config did not start as an empty object");
                  }
                  return {};
                },
              },

              // Ensure Remix config is accumulated across presets
              {
                remixConfig: async ({ remixConfig }) => ({
                  ignoredRouteFiles: ["MOCK_PATTERN"],
                }),
              },
              {
                remixConfig: async ({ remixConfig }) => {
                  if (!remixConfig.ignoredRouteFiles.includes("MOCK_PATTERN")) {
                    throw new Error("Remix config does not have accumulated values");
                  }
                  return {};
                },
              },

              // Ensure preset config takes lower precedence than user config
              {
                remixConfig: async ({ remixConfig }) => ({
                  appDirectory: "INCORRECT_APP_DIR", // This is overridden by the user config further down this file
                }),
              },
              {
                remixConfigResolved: async ({ remixConfig }) => {
                  if (remixConfig.appDirectory === "INCORRECT_APP_DIR") {
                    throw new Error("Remix preset config wasn't overridden with user config");
                  }
                }
              },

              // Ensure config presets are merged in the correct order
              {
                remixConfig: async ({ remixConfig }) => ({
                  buildDirectory: "INCORRECT_BUILD_DIR",
                }),
              },
              {
                remixConfig: async ({ remixConfig }) => ({
                  buildDirectory: "build",
                }),
              },

              // Ensure presets can't define more presets
              {
                remixConfig: async ({ remixConfig }) => ({
                  presets: [{}],
                }),
              },
              {
                remixConfig: async ({ remixConfig }) => {
                  if (remixConfig.presets) {
                    throw new Error("Remix preset config should ignore 'presets' key");
                  }
                  return {};
                },
              },

              // Ensure remixConfigResolved is called with a frozen Remix config
              {
                remixConfigResolved: async ({ remixConfig }) => {
                  let isDeepFrozen = (obj: any) =>
                    Object.isFrozen(obj) &&
                    Object.keys(obj).every(
                      prop => typeof obj[prop] !== 'object' || isDeepFrozen(obj[prop])
                    );

                  let fs = await import("node:fs/promises");
                  await fs.writeFile("PRESET_REMIX_CONFIG_RESOLVED_META.json", JSON.stringify({
                    remixConfigFrozen: isDeepFrozen(remixConfig),
                  }), "utf-8");
                }
              },

              // Ensure presets can set serverBundles option (this is critical for Vercel support)
              {
                remixConfig: async ({ remixConfig }) => ({
                  serverBundles() {
                    return "preset-server-bundle-id";
                  },
                }),
              },

              // Ensure presets can set buildEnd option (this is critical for Vercel support)
              {
                remixConfig: async ({ remixConfig }) => ({
                  async buildEnd(buildEndArgs) {
                    let fs = await import("node:fs/promises");
                    let serializeJs = (await import("serialize-javascript")).default;

                    await fs.writeFile(
                      "BUILD_END_ARGS.js",
                      "export default " + serializeJs(buildEndArgs, { space: 2, unsafe: true }),
                      "utf-8"
                    );
                  },
                }),
              },
            ],

            // Ensure user config takes precedence over preset config
            appDirectory: "app",
          },
        `,
      }),
    });
    stop = await viteDev({ cwd, port });
  });
  test.afterAll(() => stop());

  test("Vite / presets", async () => {
    let { status, stderr } = viteBuild({ cwd });
    expect(stderr.toString()).toBeFalsy();
    expect(status).toBe(0);

    let buildEndArgs: any = (
      await import(URL.pathToFileURL(path.join(cwd, "BUILD_END_ARGS.js")).href)
    ).default;
    let { remixConfig } = buildEndArgs;

    // Before rewriting to relative paths, assert that paths are absolute within cwd
    expect(pathStartsWithCwd(remixConfig.buildDirectory)).toBe(true);

    // Rewrite path args to be relative and normalized for snapshot test
    remixConfig.buildDirectory = relativeToCwd(remixConfig.buildDirectory);

    // Ensure preset configs are merged in correct order, resulting in the correct build directory
    expect(remixConfig.buildDirectory).toBe("build");

    // Ensure preset config takes lower precedence than user config
    expect(remixConfig.serverModuleFormat).toBe("esm");

    // Ensure `remixConfigResolved` is called with a frozen Remix config
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(cwd, "PRESET_REMIX_CONFIG_RESOLVED_META.json"),
          "utf-8"
        )
      )
    ).toEqual({
      remixConfigFrozen: true,
    });

    expect(Object.keys(buildEndArgs)).toEqual(["buildManifest", "remixConfig"]);

    // Smoke test the resolved config
    expect(Object.keys(buildEndArgs.remixConfig)).toEqual([
      "appDirectory",
      "buildDirectory",
      "buildEnd",
      "future",
      "manifest",
      "publicPath",
      "routes",
      "serverBuildFile",
      "serverBundles",
      "serverModuleFormat",
      "unstable_ssr",
    ]);

    // Ensure we get a valid build manifest
    expect(buildEndArgs.buildManifest).toEqual({
      routeIdToServerBundleId: {
        "routes/_index": "preset-server-bundle-id",
      },
      routes: {
        root: {
          file: "app/root.tsx",
          id: "root",
          path: "",
        },
        "routes/_index": {
          file: "app/routes/_index.tsx",
          id: "routes/_index",
          index: true,
          parentId: "root",
        },
      },
      serverBundles: {
        "preset-server-bundle-id": {
          file: "build/server/preset-server-bundle-id/index.js",
          id: "preset-server-bundle-id",
        },
      },
    });
  });
});
