const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
  packagerConfig: {
    asar: true,
    name: 'Folio',
    appBundleId: 'local.folio.app',
    // App icon: Forge adds the right extension (.icns on Mac)
    icon: 'icon/Folio',
    // Files in this folder that should NOT be copied into Folio.app
    ignore: [
      /^\/Writing app redesign/,
      /^\/icon($|\/)/,
      /^\/out($|\/)/,
      /^\/forge\.config\.js$/,
      /^\/tests($|\/)/,
      /^\/\.gitignore$/,
    ],
  },
  rebuildConfig: {},
  hooks: {
    // Sign every Mac build with the same local certificate. A throwaway
    // signature makes macOS treat each rebuild as a new app and block it from
    // the synced Dropbox folder; a fixed one keeps it the same app every time.
    postPackage: async (_config, { platform, outputPaths }) => {
      if (platform !== 'darwin') return;
      // The key lives in its own keychain (~/.folio-signing) whose password is
      // stored beside it, so signing never asks for the Mac login password.
      const { execFileSync } = require('child_process');
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const identity = 'Folio Local Signing';
      const dir = path.join(os.homedir(), '.folio-signing');
      const keychain = path.join(dir, 'folio-signing.keychain-db');
      const passwordFile = path.join(dir, 'keychain-password');
      if (!fs.existsSync(keychain) || !fs.existsSync(passwordFile)) {
        console.warn(`\nNo ${keychain}, so this build keeps a throwaway signature.\n`);
        return;
      }
      const run = (cmd, args, opts) => execFileSync(cmd, args, opts);
      run('security', ['unlock-keychain', '-p', fs.readFileSync(passwordFile, 'utf8').trim(), keychain]);
      // codesign only finds identities in keychains on the search list, so add
      // ours for the signing and then put the list back exactly as it was.
      const original = run('security', ['list-keychains', '-d', 'user']).toString()
        .split('\n').map(line => line.trim().replace(/^"|"$/g, '')).filter(Boolean);
      run('security', ['list-keychains', '-d', 'user', '-s', ...original, keychain]);
      try {
        for (const out of outputPaths) {
          const app = path.join(out, 'Folio.app');
          run('codesign', ['--force', '--deep', '--sign', identity, app], { stdio: 'inherit' });
          run('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
        }
      } finally {
        run('security', ['list-keychains', '-d', 'user', '-s', ...original]);
      }
    },
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {},
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
