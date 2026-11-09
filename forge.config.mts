import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

/**
 * Local mirror for the electron artifacts: when the release hosts are
 * unreachable (networks filter github release downloads the way they filter
 * youtube), point YTM_ELECTRON_ARTIFACT_DIR at a folder with
 * electron-<version>-<platform>-<arch>.zip and SHASUMS256.txt and packaging
 * reads them from disk instead of the network.
 */
const localElectronDownloader = {
  download: async (url: string, targetPath: string): Promise<void> => {
    const dir = process.env.YTM_ELECTRON_ARTIFACT_DIR;
    const source = dir ? path.resolve(dir, path.basename(url).split("?")[0]) : "";
    if (!dir || !source || !fsSync.existsSync(source)) {
      throw new Error(
        `No local electron artifact for ${url}. Set YTM_ELECTRON_ARTIFACT_DIR to a folder containing the artifact files, or unset it to download normally.`,
      );
    }
    console.log(`Serving ${path.basename(url)} from ${dir}`);
    fsSync.copyFileSync(source, targetPath);
  },
};

const config: ForgeConfig = {
  packagerConfig: {
    download: process.env.YTM_ELECTRON_ARTIFACT_DIR
      ? {
          downloader: localElectronDownloader as never,
        }
      : {},
    executableName: "youtube-music-desktop-app",
    icon: "src/assets/icons/ytmd",
    extraResource: [
      "src/assets/icons/tray.ico",
      "src/assets/icons/trayTemplate.png",
      "src/assets/icons/trayTemplate@2x.png",
      "src/assets/icons/ytmd.png",
      "src/assets/icons/ytmd_white.png",
      "src/assets/icons/ytmd_black.png",

      "src/assets/icons/controls/pause-button.png",
      "src/assets/icons/controls/play-button.png",
      "src/assets/icons/controls/play-next-button.png",
      "src/assets/icons/controls/play-previous-button.png",
    ],
    protocols: [
      {
        name: "YTMDesktop",
        schemes: ["ytmd"]
      }
    ],
    appCategoryType: "public.app-category.music",
    asar: true
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      iconUrl: `https://raw.githubusercontent.com/ytmdesktop/ytmdesktop/137c4e5c175c8c125cbcca9a5312611f80cd3bd9/src/assets/icons/ytmd.ico`
    }),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({
      options: {
        categories: ["AudioVideo", "Audio"],
        mimeType: ["x-scheme-handler/ytmd"],
        icon: "src/assets/icons/ytmd.png"
      }
    }),
    new MakerDeb({
      options: {
        categories: ["AudioVideo", "Audio"],
        mimeType: ["x-scheme-handler/ytmd"],
        section: "sound",
        icon: "src/assets/icons/ytmd.png"
      }
    }),
  ],
  publishers: [
    {
      name: "@electron-forge/publisher-github",
      config: {
        repository: {
          owner: process.env.YTMD_UPDATE_FEED_OWNER,
          name: process.env.YTMD_UPDATE_FEED_REPOSITORY
        }
      }
    }
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "src/main/index.ts",
          config: "config/vite/main.ts",
          target: "main",
        },
        {
          entry: "src/renderer/windows/main/preload.ts",
          config: "config/vite/preload/main_window.ts",
          target: "preload"
        },
        {
          entry: "src/renderer/windows/settings/preload.ts",
          config: "config/vite/preload/settings_window.ts",
          target: "preload"
        },
        {
          entry: "src/renderer/windows/authorize-companion/preload.ts",
          config: "config/vite/preload/authorize_companion_window.ts",
          target: "preload"
        },
        {
          entry: "src/renderer/windows/titlebar/preload.ts",
          config: "config/vite/preload/titlebar_window.ts",
          target: "preload"
        },
        {
          entry: "src/renderer/windows/updater/preload.ts",
          config: "config/vite/preload/updater_window.ts",
          target: "preload"
        },
        {
          entry: "src/renderer/windows/miniplayer/preload.ts",
          config: "config/vite/preload/miniplayer_window.ts",
          target: "preload"
        },
        {
          entry: "src/renderer/windows/changelog/preload.ts",
          config: "config/vite/preload/changelog_window.ts",
          target: "preload"
        },
        {
          entry: "src/renderer/ytmview/preload.ts",
          config: "config/vite/preload/ytmview.ts",
          target: "preload"
        }
      ],
      renderer: [
        {
          name: "all_windows",
          config: "config/vite/renderer.ts",
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      strictlyRequireAllFuses: true,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
      [FuseV1Options.WasmTrapHandlers]: true,
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false
    }),
  ],
  hooks: {
    async packageAfterCopy(_config, buildPath, _electronVersion, platform, arch) {
      const srcRoot = path.join(__dirname, "node_modules");
      const destRoot = path.join(buildPath, "node_modules");
      
      const xosmsPlatformSuffix = (() => {
        switch (platform) {
          case "linux":
            return "-gnu"
          case "win32":
            return "-msvc"
          default:
            return ""
        }
      })()
      const pkgs = ["xosms", `@xosms/xosms-${platform}-${arch}${xosmsPlatformSuffix}`];

      await Promise.all(
        pkgs.map(async pkg => {
          const src = path.join(srcRoot, pkg);
          const dest = path.join(destRoot, pkg);

          if ((await fs.stat(src)).isDirectory()) {
            await fs.cp(src, dest, { dereference: true, recursive: true });
          }
        })
      )
    }
  }
};

export default config;
