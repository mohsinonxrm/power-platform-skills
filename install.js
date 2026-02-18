#!/usr/bin/env node
/**
 * Power Platform Skills — Installation Script
 *
 * Clones the marketplace repository and writes directly to the plugin
 * directories used by Claude Code and GitHub Copilot CLI. No CLI commands
 * are executed — only git, file copies, and JSON config updates.
 *
 * Usage:
 *   node install.js                                              (from local clone)
 *   curl -fsSL https://raw.githubusercontent.com/microsoft/power-platform-skills/main/install.js | node
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");

// ── Config ────────────────────────────────────────────────────
const REPO = "microsoft/power-platform-skills";
const REPO_URL = `https://github.com/${REPO}.git`;
const MARKETPLACE_NAME = "power-platform-skills";
const GITHUB_RAW = `https://raw.githubusercontent.com/${REPO}/main`;
const HOME = os.homedir();

// ── Colors (disabled when output is piped) ────────────────────
const tty = process.stdout.isTTY;
const bold = (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const green = (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s);
const yellow = (s) => (tty ? `\x1b[33m${s}\x1b[0m` : s);
const red = (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s);

const ok = (msg) => console.log(`  ${green("✓")} ${msg}`);
const warn = (msg) => console.log(`  ${yellow("!")} ${msg}`);
const fail = (msg) => console.log(`  ${red("✗")} ${msg}`);
const header = (msg) => console.log(`\n${bold(msg)}`);
const info = (msg) => console.log(`  ${msg}`);

// ── Helpers ───────────────────────────────────────────────────
function hasCommand(cmd) {
  try {
    const which = process.platform === "win32" ? "where" : "which";
    execSync(`${which} ${cmd}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function run(cmd, opts = {}) {
  try {
    const output = execSync(cmd, {
      stdio: "pipe",
      timeout: 120_000,
      cwd: opts.cwd,
      shell: true,
    });
    return { ok: true, output: output.toString().trim() };
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().trim() : err.message;
    return { ok: false, output: stderr };
  }
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const request = (target) => {
      https
        .get(target, { headers: { "User-Agent": "power-platform-skills-installer" } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return request(res.headers.location);
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode} from ${target}`));
          }
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve(data));
        })
        .on("error", reject);
    };
    request(url);
  });
}

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      const target = fs.readlinkSync(srcPath);
      try {
        fs.symlinkSync(target, destPath);
      } catch {
        fs.copyFileSync(fs.realpathSync(srcPath), destPath);
      }
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ── Git operations ────────────────────────────────────────────
function gitCloneOrUpdate(url, dir) {
  const gitDir = path.join(dir, ".git");

  if (fs.existsSync(gitDir)) {
    info("Updating existing repository...");
    const fetch = run(`git -C "${dir}" fetch origin main`);
    if (fetch.ok) {
      run(`git -C "${dir}" checkout main`);
      const pull = run(`git -C "${dir}" pull origin main`);
      if (pull.ok) {
        ok("Repository updated");
        return true;
      }
    }
    warn("Update failed — re-cloning...");
    const backup = `${dir}-backup-${Date.now()}`;
    fs.renameSync(dir, backup);
    info(`Backup saved to ${path.basename(backup)}`);
  }

  info("Cloning marketplace repository...");
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const clone = run(`git clone "${url}" "${dir}"`);
  if (clone.ok) {
    ok("Repository cloned");
    return true;
  }

  fail(`Failed to clone: ${clone.output}`);
  return false;
}

function gitCommitSha(dir) {
  const result = run(`git -C "${dir}" rev-parse HEAD`);
  return result.ok ? result.output : "";
}

// ── Marketplace loader ────────────────────────────────────────
async function loadMarketplace() {
  const scriptDir = process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : process.cwd();
  const localFile = path.join(scriptDir, ".claude-plugin", "marketplace.json");

  if (fs.existsSync(localFile)) {
    return JSON.parse(fs.readFileSync(localFile, "utf8"));
  }

  info("Fetching marketplace manifest from GitHub...");
  const raw = await httpsGet(`${GITHUB_RAW}/.claude-plugin/marketplace.json`);
  return JSON.parse(raw);
}

// ── Claude Code installation ──────────────────────────────────
//
// On-disk layout:
//   ~/.claude/plugins/marketplaces/<marketplace>/          — git clone of marketplace repo
//   ~/.claude/plugins/cache/<marketplace>/<plugin>/<ver>/  — plugin files (versioned)
//   ~/.claude/plugins/known_marketplaces.json              — marketplace registry
//   ~/.claude/plugins/installed_plugins.json               — plugin registry
//
function installClaude(plugins) {
  header("Claude Code");

  const pluginsRoot = path.join(HOME, ".claude", "plugins");

  // 1. Clone marketplace repo
  const marketplacePath = path.join(pluginsRoot, "marketplaces", MARKETPLACE_NAME);
  info("Setting up marketplace repository...");
  if (!gitCloneOrUpdate(REPO_URL, marketplacePath)) {
    fail("Could not set up marketplace — skipping Claude Code");
    return;
  }

  const sha = gitCommitSha(marketplacePath);

  // 2. Copy each plugin into the versioned cache
  for (const plugin of plugins) {
    const src = path.join(marketplacePath, "plugins", plugin);
    if (!fs.existsSync(src)) {
      warn(`Plugin directory not found in marketplace: plugins/${plugin}`);
      continue;
    }

    const pluginMeta = readJSON(path.join(src, ".claude-plugin", "plugin.json"));
    const version = pluginMeta?.version || sha.substring(0, 12);
    const dest = path.join(pluginsRoot, "cache", MARKETPLACE_NAME, plugin, version);

    info(`Installing ${plugin} (v${version})...`);
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    copyDirSync(src, dest);
    ok(`${plugin} installed`);
  }

  // 3. Register marketplace in known_marketplaces.json
  const knownPath = path.join(pluginsRoot, "known_marketplaces.json");
  const known = readJSON(knownPath) || {};
  known[MARKETPLACE_NAME] = {
    source: { source: "github", repo: REPO },
    installLocation: marketplacePath,
    lastUpdated: new Date().toISOString(),
    autoUpdate: true,
  };
  writeJSON(knownPath, known);
  ok("Marketplace registered (auto-update enabled)");

  // 4. Register plugins in installed_plugins.json
  const installedPath = path.join(pluginsRoot, "installed_plugins.json");
  const installed = readJSON(installedPath) || { version: 2, plugins: {} };
  if (!installed.plugins) installed.plugins = {};

  for (const plugin of plugins) {
    const src = path.join(marketplacePath, "plugins", plugin);
    if (!fs.existsSync(src)) continue;

    const pluginMeta = readJSON(path.join(src, ".claude-plugin", "plugin.json"));
    const version = pluginMeta?.version || sha.substring(0, 12);
    const cachePath = path.join(pluginsRoot, "cache", MARKETPLACE_NAME, plugin, version);
    const key = `${plugin}@${MARKETPLACE_NAME}`;

    const existing = installed.plugins[key]?.[0];
    installed.plugins[key] = [
      {
        scope: "user",
        installPath: cachePath,
        version: version,
        installedAt: existing?.installedAt || new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        gitCommitSha: sha,
      },
    ];
  }

  writeJSON(installedPath, installed);
  ok("Plugin registry updated");
}

// ── GitHub Copilot installation ───────────────────────────────
//
// On-disk layout:
//   ~/.copilot/marketplace-cache/<owner>-<marketplace>/        — git clone of marketplace repo
//   ~/.copilot/installed-plugins/<marketplace>/<plugin>/       — plugin files (flat)
//   ~/.copilot/config.json  → { marketplaces: {}, installed_plugins: [] }
//
function installCopilot(plugins) {
  header("GitHub Copilot");

  const copilotDir = path.join(HOME, ".copilot");

  // 1. Clone marketplace repo
  const cacheDir = path.join(copilotDir, "marketplace-cache", `microsoft-${MARKETPLACE_NAME}`);
  info("Setting up marketplace cache...");
  if (!gitCloneOrUpdate(REPO_URL, cacheDir)) {
    fail("Could not set up marketplace cache — skipping Copilot");
    return;
  }

  // 2. Copy each plugin to installed-plugins
  for (const plugin of plugins) {
    const src = path.join(cacheDir, "plugins", plugin);
    const dest = path.join(copilotDir, "installed-plugins", MARKETPLACE_NAME, plugin);

    if (!fs.existsSync(src)) {
      warn(`Plugin directory not found in marketplace: plugins/${plugin}`);
      continue;
    }

    info(`Installing ${plugin}...`);
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    copyDirSync(src, dest);
    ok(`${plugin} installed`);
  }

  // 3. Update config.json — register marketplace + plugins
  const configPath = path.join(copilotDir, "config.json");
  const config = readJSON(configPath) || {};

  if (!config.marketplaces) config.marketplaces = {};
  config.marketplaces[MARKETPLACE_NAME] = {
    source: { source: "github", repo: REPO },
  };

  if (!config.installed_plugins) config.installed_plugins = [];

  for (const plugin of plugins) {
    const pluginPath = path.join(copilotDir, "installed-plugins", MARKETPLACE_NAME, plugin);
    if (!fs.existsSync(pluginPath)) continue;

    const idx = config.installed_plugins.findIndex(
      (p) => p.name === plugin && p.marketplace === MARKETPLACE_NAME
    );

    const entry = {
      name: plugin,
      marketplace: MARKETPLACE_NAME,
      installed_at: new Date().toISOString(),
      enabled: true,
      cache_path: pluginPath,
    };

    if (idx >= 0) {
      entry.installed_at = config.installed_plugins[idx].installed_at;
      config.installed_plugins[idx] = entry;
    } else {
      config.installed_plugins.push(entry);
    }
  }

  writeJSON(configPath, config);
  ok("Config updated — marketplace and plugins registered");
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log("");
  console.log(bold("Power Platform Skills — Installer"));
  console.log("──────────────────────────────────");

  // ── Prerequisites ──────────────────────────────────────────
  header("Checking prerequisites");
  ok(`Node.js ${process.version}`);

  if (!hasCommand("git")) {
    fail("Git is required. Install from https://git-scm.com");
    process.exit(1);
  }
  ok("Git available");

  // Detect tools — check CLI in PATH or config directory on disk
  const tools = [];

  if (hasCommand("claude") || fs.existsSync(path.join(HOME, ".claude", "plugins"))) {
    tools.push("claude");
    ok("Claude Code detected");
  }
  if (hasCommand("copilot") || fs.existsSync(path.join(HOME, ".copilot", "config.json"))) {
    tools.push("copilot");
    ok("GitHub Copilot CLI detected");
  }

  if (tools.length === 0) {
    fail("Neither Claude Code nor GitHub Copilot CLI found.");
    console.log("");
    console.log("  Install at least one:");
    console.log("    Claude Code     https://docs.anthropic.com/en/docs/claude-code");
    console.log("    GitHub Copilot  https://docs.github.com/en/copilot");
    process.exit(1);
  }

  // ── Marketplace ────────────────────────────────────────────
  header("Reading marketplace");

  const manifest = await loadMarketplace();
  const plugins = manifest.plugins.map((p) => p.name);

  console.log(`  Marketplace : ${manifest.name}`);
  console.log("  Plugins     :");
  for (const p of plugins) console.log(`    - ${p}`);

  if (plugins.length === 0) {
    warn("No plugins found in the marketplace.");
    process.exit(0);
  }

  // ── Install ────────────────────────────────────────────────
  if (tools.includes("claude")) installClaude(plugins);
  if (tools.includes("copilot")) installCopilot(plugins);

  // ── Summary ────────────────────────────────────────────────
  header("Done!");
  console.log("");
  console.log("  Auto-update is enabled. Plugins will stay current automatically.");
  console.log("  Run this script again anytime to update to the latest version.");
  console.log("");
  console.log("  Get started:");
  for (const tool of tools) {
    console.log(`    ${tool} session  ->  /power-pages:create-site`);
  }
  console.log("");
}

main().catch((err) => {
  fail(`Installation failed: ${err.message}`);
  process.exit(1);
});
