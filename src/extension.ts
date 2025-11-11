import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as https from 'https';
import { createWriteStream } from 'fs';

const execAsync = promisify(exec);
let EXTENSION_ROOT = "";
/**
 * Documentation URL for troubleshooting and additional information
 */
const DOCS_URL = 'https://docs.your-organization.com/commitguard';

/**
 * Interface for setup result tracking
 */
interface SetupResult {
  workspace: string;
  success: boolean;
  message: string;
  skipped?: boolean;
}

/**
 * Interface for prerequisite installation result
 */
interface PrerequisiteResult {
  installed: boolean;
  method: 'existing' | 'pip' | 'pip3' | 'python' | 'manual';
  message: string;
  /** Optional absolute path to a pre-commit binary (e.g., from a temp venv). */
  preCommitBinPath?: string;
}

/**
 * Python detection
 */
interface PythonInfo {
  available: boolean;
  command: string; // e.g., "python3" or "python"
  version?: string;
}

/**
 * Result of temporary virtual environment setup
 */
interface VenvSetupResult {
  success: boolean;
  venvPath: string;
  pythonBin: string;
  pipBin: string;
  preCommitBin?: string; // absolute path to pre-commit within venv
}

/**
 * Activates the CommitGuard extension
 * Sets up pre-commit hooks across all workspace folders on startup
 */
// export async function activate(context: vscode.ExtensionContext): Promise<void> {
//   console.log('CommitGuard extension is now active');
//   EXTENSION_ROOT = context.extensionPath;
//   // Register the manual setup command
//   const setupCommand = vscode.commands.registerCommand(
//     'commitGuard.setupPreCommit',
//     async () => {
//       await setupPreCommitForAllWorkspaces(true);
//     }
//   );
//   context.subscriptions.push(setupCommand);

//   // Check if auto-setup is enabled
//   const config = vscode.workspace.getConfiguration('commitGuard');
//   const autoSetup = config.get<boolean>('autoSetupOnStartup', true);

//   if (autoSetup) {
//     console.log('CommitGuard: Running auto-setup on startup');
//     await setupPreCommitForAllWorkspaces(false);
//   } else {
//     console.log('CommitGuard: Auto-setup is disabled in settings');
//   }
// }

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('CommitGuard extension is now active');
  EXTENSION_ROOT = context.extensionPath;

  // Register the manual setup command
  const setupCommand = vscode.commands.registerCommand(
    'commitGuard.setupPreCommit',
    async () => {
      await setupPreCommitForAllWorkspaces(true);
    }
  );
  context.subscriptions.push(setupCommand);

  // Check if auto-setup is enabled
  const config = vscode.workspace.getConfiguration('commitGuard');
  const autoSetup = config.get<boolean>('autoSetupOnStartup', true);

  if (autoSetup) {
    console.log('CommitGuard: Running auto-setup on startup');
    await setupPreCommitForAllWorkspaces(false);
  } else {
    console.log('CommitGuard: Auto-setup is disabled in settings');
  }

// ✅ Detect git init by watching file creation inside .git
  const gitWatcher = vscode.workspace.createFileSystemWatcher("**/.git/**");

  let gitInitTriggered = false;
  let gitInitTimeout: NodeJS.Timeout | undefined;

  gitWatcher.onDidCreate(async (uri) => {
    if (gitInitTriggered) return; // prevent multiple runs

    // Debounce: wait until git is done creating files
    clearTimeout(gitInitTimeout as NodeJS.Timeout);

    gitInitTimeout = setTimeout(async () => {
      gitInitTriggered = true;
      console.log("CommitGuard: Git init detected — triggering setup once.");
      await setupPreCommitForAllWorkspaces(true); // pass manualTrigger = true to show summary only once


    }, 600); // 🟢 debounce (sweet spot)
  });

  context.subscriptions.push(gitWatcher);
}


/**
 * Deactivates the extension
 */
export function deactivate(): void {
  console.log('CommitGuard extension has been deactivated');
}

/**
 * Orchestrates pre-commit setup across all workspace folders
 */
async function setupPreCommitForAllWorkspaces(manualTrigger: boolean): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  console.log(`CommitGuard: Found ${workspaceFolders?.length ?? 0} workspace folder(s)`);

  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showWarningMessage(
      'CommitGuard: No workspace folders found. Open a folder to setup pre-commit hooks.'
    );
    return;
  }
    // ✅ NEW: skip entire setup if no .git repo exists in any workspace
  const hasGitRepo = await Promise.all(
    workspaceFolders.map(folder =>
      checkPathExists(path.join(folder.uri.fsPath, ".git"))
    )
  ).then(results => results.some(r => r));

  if (!hasGitRepo) {
    console.log("CommitGuard: No git repos detected — skipping setup.");
    return; // prevents prereq checks and UI popups
  }


  // Step 1: Ensure pre-commit is available (best-effort)
  console.log('CommitGuard: Checking for pre-commit installation...');
  const prereqResult = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'CommitGuard',
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: 'Checking for pre-commit...' });
      return await ensurePreCommitInstalled(progress);
    }
  );

  if (!prereqResult.installed) {
    const contactITAction = 'Contact IT';
    const tryManualAction = 'Try Manual Install';
    const viewDocsAction = 'View Documentation';

    const message = `CommitGuard: ${prereqResult.message}`;
    const actions = [tryManualAction, contactITAction, viewDocsAction];
    const result = await vscode.window.showErrorMessage(message, ...actions);

    if (result === tryManualAction) {
      const terminal = vscode.window.createTerminal('CommitGuard Setup');
      terminal.show();
      terminal.sendText('python -m pip install --user pre-commit');
      vscode.window.showInformationMessage(
        'CommitGuard: Manual installation command sent to terminal. After installation completes, restart VS Code and try again.'
      );
    } else if (result === contactITAction) {
      vscode.window.showInformationMessage(
        'CommitGuard: Please request your IT department to install Python 3.7+ and pre-commit on developer machines. ' +
          'Command for IT: python -m pip install pre-commit'
      );
    } else if (result === viewDocsAction) {
      vscode.env.openExternal(vscode.Uri.parse(DOCS_URL));
    }
    return;
  }

  if (prereqResult.method !== 'existing') {
    vscode.window.showInformationMessage(`CommitGuard: ${prereqResult.message}`);
  }
  console.log('CommitGuard: pre-commit is available');

  // Step 2: Setup pre-commit for each workspace folder
  const results: SetupResult[] = [];
  // for (const folder of workspaceFolders) {
  //   const result = await setupPreCommitForWorkspace(folder, prereqResult.preCommitBinPath);
  //   results.push(result);
  // }
  for (const folder of workspaceFolders) {
  const workspacePath = folder.uri.fsPath;
  const gitDir = path.join(workspacePath, ".git");

  // ✅ Skip this workspace entirely if not a git repo
  if (!(await checkPathExists(gitDir))) {
    console.log(`CommitGuard: Skipping workspace "${folder.name}" — no .git repo found.`);
    continue;
  }

  const result = await setupPreCommitForWorkspace(folder, prereqResult.preCommitBinPath);
  results.push(result);
}
  // Step 3: Show summary to user
  displaySetupSummary(results, manualTrigger);
}

/**
 * Ensures pre-commit is installed, attempting automatic installation if needed.
 * 1) If `pre-commit` is on PATH -> 'existing'
 * 2) Else try temp venv -> 'python'
 * 3) Else try `python -m pip install --user pre-commit` -> 'pip'
 */
async function ensurePreCommitInstalled(
  progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<PrerequisiteResult> {
  // Check PATH for pre-commit
  try {
    const { stdout } = await execAsync(`pre-commit --version`);
    if (stdout?.trim()) {
      return {
        installed: true,
        method: 'existing',
        message: `Using existing ${stdout.trim()}`,
      };
    }
  } catch {
    // not present -> continue
  }

  // Check Python (needed for venv/pip fallback)
  console.log('CommitGuard: Checking for Python...');
  progress.report({ message: 'Checking prerequisites...' });
  const pythonInfo = await getPythonInfo();
  if (!pythonInfo.available) {
    console.error('CommitGuard: Python not found on system');
    return {
      installed: false,
      method: 'manual',
      message:
        'Python is not installed. Please contact your IT department to install Python 3.7+ or request pre-commit to be pre-installed on developer machines.',
    };
  }

  // Try a temporary virtual environment (best-effort, isolated)
  const tmpDir = path.join(os.tmpdir(), 'commitguard-setup');
  try {
    await fs.mkdir(tmpDir, { recursive: true });
    progress.report({ message: 'Setting up a temporary virtual environment...' });
    const venvSetup = await setupVirtualEnvironment(pythonInfo.command, tmpDir);
    if (venvSetup.success && venvSetup.preCommitBin) {
      progress.report({ message: 'Pre-commit installed in temporary environment' });
      return {
        installed: true,
        method: 'python',
        message: 'Successfully installed pre-commit in a temporary virtual environment',
        preCommitBinPath: venvSetup.preCommitBin,
      };
    }
  } catch (error) {
    console.error('CommitGuard: Virtual environment setup failed:', error);
    // continue to pip --user fallback
  }

  // Fallback to user-space installation (no admin required)
  progress.report({ message: 'Trying alternative installation methods...' });
  try {
    console.log(`CommitGuard: Attempting user-space installation with ${pythonInfo.command}`);
    progress.report({ message: 'Installing pre-commit (this may take 30–60 seconds)...' });
    await execAsync(`"${pythonInfo.command}" -m pip install --user pre-commit`, { timeout: 120_000 });
    return {
      installed: true,
      method: 'pip',
      message: 'Installed pre-commit using pip --user',
    };
  } catch (pipError) {
    console.warn('CommitGuard: pip install failed, retrying ensurepip and pip install');
    try {
      await execAsync(`"${pythonInfo.command}" -m ensurepip --upgrade`, { timeout: 60_000 });
      await execAsync(`"${pythonInfo.command}" -m pip install --user pre-commit`, { timeout: 120_000 });
      return {
        installed: true,
        method: 'pip',
        message: 'Installed pre-commit after bootstrapping pip',
      };
    } catch (err: any) {
      return {
        installed: false,
        method: 'manual',
        message: `Automatic installation failed: ${err?.stderr ?? err?.message ?? String(err)}`,
      };
    }
  }
}

/**
 * Per-workspace orchestration and safety checks.
 * Ensures a default .pre-commit-config.yaml exists (opinionated first-run).
 */
async function setupPreCommitForWorkspace(
  workspaceFolder: vscode.WorkspaceFolder,
  preCommitPathFromVenv?: string
): Promise<SetupResult> {
  const workspacePath = workspaceFolder.uri.fsPath;

  try {
    // Ensure this is a Git repo
    const gitDir = path.join(workspacePath, '.git');
    if (!(await checkPathExists(gitDir))) {
      return {
        workspace: workspaceFolder.name,
        success: false,
        skipped: true,
        message: 'Not a Git repository (.git folder not found)',
      };
    }

    await ensureVenvIgnored(workspacePath);

    // Ensure a pre-commit config exists (auto-create minimal + gitleaks)
    const cfg = await ensurePreCommitConfig(workspacePath);
    if (cfg.created) {
      console.log(`CommitGuard: Created default pre-commit config at ${cfg.path}`);
    } else {
      console.log(`CommitGuard: Using existing pre-commit config at ${cfg.path}`);
    }

    // Install hooks (phased) and warm up environments
    await installPreCommitHooks(workspaceFolder, preCommitPathFromVenv);

    return {
      workspace: workspaceFolder.name,
      success: true,
      message: cfg.created ? 'Hooks installed; default config created' : 'Hooks installed',
    };
  } catch (err: any) {
    const detail = err?.message ?? String(err);
    return {
      workspace: workspaceFolder.name,
      success: false,
      message: detail,
    };
  }
}

/**
 * Install pre-commit hooks with a two-phase strategy:
 * 1) Install the hook script ("install -t pre-commit") and verify its presence.
 * 2) Best-effort "install-hooks"; warn on failure but don't abort.
 */
async function installPreCommitHooks(
  workspaceFolder: vscode.WorkspaceFolder,
  preCommitPathFromVenv?: string
): Promise<void> {
  try {
    const config = vscode.workspace.getConfiguration('commitGuard');
    const showTerminal = config.get<boolean>('showTerminalOnInstall', true);
    const workspacePath = workspaceFolder.uri.fsPath;
    const env = { ...process.env, PRE_COMMIT_HOME: path.join(workspacePath, '.pre-commit-cache') };

    // Prefer provided pre-commit path (from temp venv), else use local .venv pre-commit if present, else PATH
    let preCommitBin = preCommitPathFromVenv;
    if (!preCommitBin) {
      const localCandidate = path.join(
        workspacePath,
        '.venv',
        process.platform === 'win32' ? 'Scripts' : 'bin',
        process.platform === 'win32' ? 'pre-commit.exe' : 'pre-commit'
      );
      preCommitBin = (await checkPathExists(localCandidate)) ? localCandidate : 'pre-commit';
    }

    console.log('CommitGuard: PHASED INSTALL MODE (no --install-hooks up front)');

    // PHASE 1 — install only the hook script (fast, reliable)
    await execAsync(`"${preCommitBin}" install -t pre-commit`, {
      cwd: workspacePath,
      timeout: 120_000,
      env,
    });

    // Verify hook file exists
    const hookPath = path.join(workspacePath, '.git', 'hooks', 'pre-commit');
    if (!(await checkPathExists(hookPath))) {
      throw new Error('Hook script was not created at .git/hooks/pre-commit');
    }
    console.log(`CommitGuard: Verified hook file exists at ${hookPath}`);

    // PHASE 2 — best-effort warm-up of hook environments (reads the config we ensured)
    try {
      await execAsync(`"${preCommitBin}" install-hooks`, {
        cwd: workspacePath,
        timeout: 180_000,
        env,
      });
    } catch (e: any) {
      const detail = e?.stderr ?? e?.stdout ?? e?.message ?? String(e);
      console.warn('CommitGuard: install-hooks failed, continuing. Details:', detail);
      vscode.window.showWarningMessage(
        'CommitGuard: Hook installed. Installing hook environments failed; the first commit may build environments and could fail if prerequisites are missing.'
      );
    }

    if (showTerminal) {
      const terminal = vscode.window.createTerminal({
        name: `CommitGuard: ${workspaceFolder.name}`,
        cwd: workspacePath,
      });
      terminal.sendText(`echo "✅ CommitGuard: Pre-commit hooks successfully installed!"`);
      terminal.sendText(`echo "Hooks are ready to run on your next commit."`);
      terminal.show(true);
    }

    console.log(`CommitGuard: Successfully installed and verified hooks for ${workspaceFolder.name}`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('CommitGuard: Hook installation error:', error);
    throw new Error(`Failed to install pre-commit hooks: ${errorMessage}`);
  }
}

/**
 * Ensure `.pre-commit-config.yaml` exists in repo root.
 * Creates a default config that includes:
 *  - basic hygiene hooks (pre-commit-hooks)
 *  - Gitleaks (secrets scanning)
 */

// async function ensurePreCommitConfig(
//   workspacePath: string
// ): Promise<{ created: boolean; path: string }> {
//   const config = vscode.workspace.getConfiguration('commitGuard');
//   const autoCreate = config.get<boolean>('autoCreateConfigIfMissing', true);
//   const includeGitleaks = config.get<boolean>('includeGitleaks', true);
//   const gitleaksVersion = config.get<string>('gitleaksVersionPin', 'v8.28.0'); // pin for determinism

//   const yamlPath = path.join(workspacePath, '.pre-commit-config.yaml');
//   const ymlPath = path.join(workspacePath, '.pre-commit-config.yml');

//   // ✅ Instead of returning if exists — we now ALWAYS overwrite
//   const exists = (await checkPathExists(yamlPath)) || (await checkPathExists(ymlPath));

//   if (!exists && !autoCreate) {
//     const choice = await vscode.window.showInformationMessage(
//       'CommitGuard: No .pre-commit-config.yaml found. Create a default config?',
//       'Create default',
//       'Not now'
//     );
//     if (choice !== 'Create default') {
//       return { created: false, path: yamlPath };
//     }
//   }

//   // Try read the bundled template from the extension root
//   let finalYaml: string | undefined;
//   try {
//     const templatePath = path.join(EXTENSION_ROOT, '.pre-commit-config.yaml');
//     finalYaml = await fs.readFile(templatePath, 'utf8');
//   } catch {
//     // Fallback to previous inline default to avoid hard failure if the file isn't packaged
//     const fallback = `repos:
//   - repo: https://github.com/pre-commit/pre-commit-hooks
//     rev: v4.6.0
//     hooks:
//       - id: trailing-whitespace
//       - id: end-of-file-fixer
//       - id: check-yaml
//       - id: check-merge-conflict
// `;
//     finalYaml = fallback;
//   }

//   if (includeGitleaks) {
//     finalYaml += `
//   - repo: https://github.com/gitleaks/gitleaks
//     rev: ${gitleaksVersion}
//     hooks:
//       - id: gitleaks
// `;
//   }

//   await fs.writeFile(yamlPath, finalYaml, { encoding: 'utf8' });

//   // ✅ Only refresh when config was freshly created
//   const created = !exists;
//   if (created) {
//     try {
//       await execAsync("pre-commit migrate-config", { cwd: workspacePath });
//       await execAsync("pre-commit install --overwrite", { cwd: workspacePath });
//       console.log("CommitGuard: Pre-commit hook installed / updated.");
//     } catch (error) {
//       console.error("CommitGuard: Failed to refresh pre-commit hook.", error);
//     }
//   }

// return { created, path: yamlPath };


//   return { created: !exists, path: yamlPath };
// }

async function ensurePreCommitConfig(
  workspacePath: string
): Promise<{ created: boolean; path: string }> {
  const config = vscode.workspace.getConfiguration('commitGuard');
  const autoCreate = config.get<boolean>('autoCreateConfigIfMissing', true);
  const includeGitleaks = config.get<boolean>('includeGitleaks', true);
  const gitleaksVersion = config.get<string>('gitleaksVersionPin', 'v8.28.0');

  const yamlPath = path.join(workspacePath, '.pre-commit-config.yaml');
  const ymlPath = path.join(workspacePath, '.pre-commit-config.yml');

  // ✅ detect whether config already existed
  const existed =
    (await checkPathExists(yamlPath)) || (await checkPathExists(ymlPath));

  if (!existed && !autoCreate) {
    const choice = await vscode.window.showInformationMessage(
      'CommitGuard: No .pre-commit-config.yaml found. Create a default config?',
      'Create default',
      'Not now'
    );
    if (choice !== 'Create default') {
      return { created: false, path: yamlPath };
    }
  }

  // Load template from extension bundle
  let finalYaml: string;
  try {
    const templatePath = path.join(EXTENSION_ROOT, '.pre-commit-config.yaml');
    finalYaml = await fs.readFile(templatePath, 'utf8');
  } catch {
    finalYaml = `repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v4.6.0
    hooks:
      - id: trailing-whitespace
      - id: end-of-file-fixer
      - id: check-yaml
      - id: check-merge-conflict
`;
  }

  if (includeGitleaks) {
    finalYaml += `
  - repo: https://github.com/gitleaks/gitleaks
    rev: ${gitleaksVersion}
    hooks:
      - id: gitleaks
`;
  }

  // ✅ Only overwrite file if new or changed
  await fs.writeFile(yamlPath, finalYaml, { encoding: 'utf8' });

  const created = !existed;

  if (created) {
    try {
      await execAsync(`python -m pre_commit migrate-config`, { cwd: workspacePath });
      await execAsync(`python -m pre_commit install --overwrite`, {
        cwd: workspacePath,
      });
      console.log('CommitGuard: Installed/updated pre-commit hook.');
    } catch (error) {
      console.error('CommitGuard: Failed to refresh pre-commit hook.', error);
    }
  }

  return { created, path: yamlPath };
}

/**
 * Ensure `.venv` is added to .gitignore (idempotent).
 */
async function ensureVenvIgnored(workspacePath: string): Promise<void> {
  try {
    const gitignorePath = path.join(workspacePath, '.gitignore');
    let content = '';
    try {
      content = await fs.readFile(gitignorePath, 'utf8');
    } catch {
      // file not present; we'll create it
    }
    const hasVenv = content.split(/\r?\n/).some((line) => line.trim() === '.venv');
    if (!hasVenv) {
      const next = (content.trim() ? content.trim() + '\n' : '') + '.venv\n';
      await fs.writeFile(gitignorePath, next, 'utf8');
      console.log(`CommitGuard: Added .venv to .gitignore at ${gitignorePath}`);
    } else {
      console.log('CommitGuard: .venv already present in .gitignore');
    }
  } catch (err) {
    console.warn('CommitGuard: Failed to update .gitignore:', err);
  }
}

/**
 * (Optional) Download and place a Gitleaks binary into a venv's bin/Scripts.
 * Not used by default; the pre-commit hook pulls gitleaks from its own repo.
 * Keep for air‑gapped or custom scenarios.
 */
async function ensureGitleaksAvailable(venvPath: string): Promise<string> {
  const isWindows = process.platform === 'win32';
  const binDir = isWindows ? path.join(venvPath, 'Scripts') : path.join(venvPath, 'bin');
  const target = path.join(binDir, isWindows ? 'gitleaks.exe' : 'gitleaks');

  if (await checkPathExists(target)) {
    return target;
  }

  const version = 'v8.28.0';
  const base = `https://github.com/gitleaks/gitleaks/releases/download/${version}`;
  const arch = process.arch;
  let asset = '';

  if (isWindows) {
    asset = 'gitleaks_8.28.0_windows_x64.zip';
  } else if (process.platform === 'darwin') {
    asset =
      arch === 'arm64'
        ? 'gitleaks_8.28.0_darwin_arm64.tar.gz'
        : 'gitleaks_8.28.0_darwin_x64.tar.gz';
  } else {
    asset =
      arch === 'arm64'
        ? 'gitleaks_8.28.0_linux_arm64.tar.gz'
        : 'gitleaks_8.28.0_linux_x64.tar.gz';
  }

  const url = `${base}/${asset}`;
  const tmpDir = path.join(os.tmpdir(), 'commitguard-gitleaks');
  await fs.mkdir(tmpDir, { recursive: true });
  const archivePath = path.join(tmpDir, asset);
  await downloadFile(url, archivePath);

  if (isWindows) {
    await execAsync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${tmpDir}' -Force"`,
      { timeout: 120_000 }
    );
    const exePath = path.join(tmpDir, 'gitleaks.exe');
    const nestedExe = (await checkPathExists(exePath))
      ? exePath
      : path.join(tmpDir, 'gitleaks', 'gitleaks.exe');

    await fs.mkdir(binDir, { recursive: true });
    await fs.copyFile(nestedExe, target);
  } else {
    await execAsync(`tar -xzf "${archivePath}" -C "${tmpDir}"`, { timeout: 120_000 });
    const binCandidate = path.join(tmpDir, 'gitleaks');
    const nested = (await checkPathExists(binCandidate))
      ? binCandidate
      : path.join(tmpDir, 'gitleaks', 'gitleaks');

    await fs.mkdir(binDir, { recursive: true });
    await fs.copyFile(nested, target);
    await fs.chmod(target, 0o755);
  }

  console.log(`CommitGuard: Installed Gitleaks binary at ${target}`);
  return target;
}

async function downloadFile(url: string, dest: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const file = createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // redirect
          file.close();
          downloadFile(res.headers.location, dest).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          reject(new Error(`HTTP ${res.statusCode} when downloading ${url}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      })
      .on('error', (err) => {
        try {
          file.close();
        } catch {}
        reject(err);
      });
  });
}

/**
 * Displays a summary of setup results to the user
 */
function displaySetupSummary(results: SetupResult[], manualTrigger: boolean): void {
  const successful = results.filter((r) => r.success && !r.skipped);
  const failed = results.filter((r) => !r.success && !r.skipped);
  const skipped = results.filter((r) => r.skipped);

  if (skipped.length === results.length && !manualTrigger) {
    return;
  }

  const messages: string[] = [];
  if (successful.length > 0) {
    messages.push(
      `✅ Configured ${successful.length} workspace(s): ${successful.map((r) => r.workspace).join(', ')}`
    );
  }
  if (skipped.length > 0) {
    messages.push(
      `⏭️ Skipped ${skipped.length} workspace(s): ${skipped
        .map((r) => `${r.workspace} (${r.message})`)
        .join(', ')}`
    );
  }
  if (failed.length > 0) {
    messages.push(
      `❌ Failed ${failed.length} workspace(s): ${failed
        .map((r) => `${r.workspace} - ${r.message}`)
        .join(', ')}`
    );
  }

  if (failed.length > 0) {
    const viewDocsAction = 'View Documentation';
    vscode.window
      .showErrorMessage(`CommitGuard Setup Issues:\n${messages.join('\n')}`, viewDocsAction)
      .then((action) => {
        if (action === viewDocsAction) {
          vscode.env.openExternal(vscode.Uri.parse(DOCS_URL));
        }
      });
  } else if (successful.length > 0) {
    vscode.window.showInformationMessage(`CommitGuard: ${messages.join(' ')}`);
  } else if (manualTrigger) {
    vscode.window.showInformationMessage(`CommitGuard: ${messages.join(' ')}`);
  }
}

/* ------------------------ Internal helpers ------------------------ */

/**
 * Detect Python and version. Prefer python3, fallback to python.
 */
async function getPythonInfo(): Promise<PythonInfo> {
  const candidates = ['python3', 'python'];

  for (const cmd of candidates) {
    try {
      const { stdout, stderr } = await execAsync(`"${cmd}" --version`);
      const text = (stdout || stderr || '').trim();
      if (text) {
        return { available: true, command: cmd, version: text };
      }
    } catch {
      // try next
    }
  }
  return { available: false, command: '' };
}

/**
 * Creates a temporary venv and installs pre-commit into it.
 */
async function setupVirtualEnvironment(pythonCmd: string, baseDir: string): Promise<VenvSetupResult> {
  const venvPath = path.join(baseDir, 'commitguard-venv');
  const isWin = process.platform === 'win32';
  try {
    // Create venv
    await execAsync(`"${pythonCmd}" -m venv "${venvPath}"`, { timeout: 120_000 });

    const pythonBin = isWin
      ? path.join(venvPath, 'Scripts', 'python.exe')
      : path.join(venvPath, 'bin', 'python');
    const pipBin = isWin
      ? path.join(venvPath, 'Scripts', 'pip.exe')
      : path.join(venvPath, 'bin', 'pip');

    // Upgrade pip and install pre-commit inside the venv
    await execAsync(`"${pythonBin}" -m pip install --upgrade pip`, { timeout: 90_000 });
    await execAsync(`"${pipBin}" install pre-commit`, { timeout: 180_000 });

    const preCommitBin = isWin
      ? path.join(venvPath, 'Scripts', 'pre-commit.exe')
      : path.join(venvPath, 'bin', 'pre-commit');

    if (!(await checkPathExists(preCommitBin))) {
      return { success: false, venvPath, pythonBin, pipBin };
    }
    return { success: true, venvPath, pythonBin, pipBin, preCommitBin };
  } catch (err) {
    console.warn('CommitGuard: setupVirtualEnvironment failed:', err);
    return {
      success: false,
      venvPath,
      pythonBin: isWin ? path.join(venvPath, 'Scripts', 'python.exe') : path.join(venvPath, 'bin', 'python'),
      pipBin: isWin ? path.join(venvPath, 'Scripts', 'pip.exe') : path.join(venvPath, 'bin', 'pip'),
    };
  }
}

/**
 * Cross-platform path existence check.
 */
async function checkPathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
``