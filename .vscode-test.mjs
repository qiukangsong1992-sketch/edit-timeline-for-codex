import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@vscode/test-cli';

/**
 * VS Code opens a unix socket inside its user-data directory, and macOS caps
 * socket paths at 103 characters. A checkout under a long path (a synced
 * OneDrive or Dropbox folder, say) blows that limit, so the test instance keeps
 * its profile in a short temporary directory rather than under the repo.
 */
const profileDir = join(tmpdir(), 'aict');

export default defineConfig({
  label: 'integration',
  files: 'out/integration/suite/**/*.test.js',
  useInstallation: process.env.VSCODE_TEST_EXECUTABLE
    ? { fromPath: process.env.VSCODE_TEST_EXECUTABLE }
    : undefined,
  // The extension needs a workspace folder before it will track anything.
  workspaceFolder: './integration/workspace.code-workspace',
  mocha: {
    ui: 'tdd',
    timeout: 60_000,
  },
  launchArgs: [
    '--disable-extensions',
    '--disable-workspace-trust',
    `--user-data-dir=${join(profileDir, 'user-data')}`,
    `--extensions-dir=${join(profileDir, 'extensions')}`,
  ],
});
