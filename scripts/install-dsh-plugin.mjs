#!/usr/bin/env node
/**
 * 把本仓库注册成 DSH（DeepSeek Harness）插件。
 *
 * 优先走官方安装通道：桌面端自带的 `resources/runtime/cli/bin/dsh.cmd`。
 * 只有它允许操作 desktop profile（PATH 上的 npm `dsh` 会拒绝），且它会完成
 * 「写 dependencies → 追加 bundles → pnpm install（link: 符号链接）→ 版本闸门」全套动作。
 * 找不到桌面端 CLI 时退化为手动改 profile 清单（与插件管理器落盘结构一致），
 * 并提示用户改用 GUI「插件」页安装。
 *
 * 用法：
 *   node scripts/install-dsh-plugin.mjs                 # 安装到 desktop profile
 *   node scripts/install-dsh-plugin.mjs --dry-run       # 只打印计划
 *   node scripts/install-dsh-plugin.mjs --remove        # 卸载
 *   node scripts/install-dsh-plugin.mjs --profile web   # 其他 profile（调试用）
 *
 * @module scripts/install-dsh-plugin
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 插件包名，同时是 profile 依赖名与 bundle 名。 */
const PACKAGE_NAME = 'kanbanniang';

/** 仓库根（本脚本位于 `<repo>/scripts/`）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 解析命令行参数。 */
function parseArgs(argv) {
  const options = { profile: 'desktop', remove: false, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--profile') {
      const value = argv[index + 1];
      if (value === undefined) fail('--profile 需要一个 profile 名称');
      options.profile = value;
      index += 1;
    } else if (arg === '--remove') {
      options.remove = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      fail(`未知参数: ${arg}`);
    }
  }
  return options;
}

/** 打印帮助。 */
function printHelp() {
  process.stdout.write(`用法: node scripts/install-dsh-plugin.mjs [选项]

选项:
  --profile <name>  目标 DSH profile（默认 desktop）
  --remove          从 profile 卸载本插件
  --dry-run         只打印将执行的命令/改动
  -h, --help        显示帮助

安装完成后需完全退出并重启 DSH 桌面端；DSH 启动时会拉起看板娘，
并以 mcp__kanbanniang__* 的形式把工具暴露给模型。
`);
}

/** 输出统一错误并退出。 */
function fail(message) {
  process.stderr.write(`✗ ${message}\n`);
  process.exit(1);
}

/** 解析 DSH 主目录。 */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (fromEnv !== undefined && fromEnv.trim() !== '') return resolve(fromEnv);
  return join(homedir(), '.dsh');
}

/**
 * 定位桌面端自带的 dsh CLI。
 *
 * 存在的三个候选位置按优先级排列：显式环境变量 → Windows 默认安装路径 → 自定义安装路径推断。
 */
function resolveDesktopCli() {
  const explicit = process.env.DSH_DESKTOP_CLI;
  if (explicit !== undefined && explicit.trim() !== '') return explicit;

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData !== undefined && localAppData.trim() !== '') {
    const standard = join(
      localAppData,
      'Programs',
      'DeepSeek Harness',
      'resources',
      'runtime',
      'cli',
      'bin',
      'dsh.cmd',
    );
    if (existsSync(standard)) return standard;
  }
  return undefined;
}

/**
 * 调用桌面端 dsh CLI。
 *
 * Windows 上 `dsh.cmd` 是批处理文件，Node 直接 spawn 会报 `EINVAL`，
 * 必须经 `cmd.exe /c` 转发；其余平台直接执行。
 */
function runDesktopCli(cli, args) {
  if (process.platform !== 'win32') {
    return spawnSync(cli, args, { cwd: REPO_ROOT, stdio: 'inherit' });
  }
  const line = [quoteWindowsArg(cli), ...args.map(quoteWindowsArg)].join(' ');
  // 批处理文件必须交给 shell；单字符串 + shell:true 由 Node 拼 `cmd /d /s /c "..."`。
  return spawnSync(line, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    windowsHide: true,
    shell: true,
  });
}

/** 为 cmd.exe 命令行加引号（路径含空格或引号时）。 */
function quoteWindowsArg(value) {
  return /[\s"]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** 确保插件宿主半侧已编译（缺失或落后于源码时重新编译）。 */
function ensurePluginBuilt() {
  const entry = join(REPO_ROOT, 'lib', 'host.js');
  const pluginDir = join(REPO_ROOT, 'src', 'plugin');
  const sources = existsSync(pluginDir)
    ? readdirSync(pluginDir)
        .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
        .map((name) => join(pluginDir, name))
    : [];
  const newestSource = Math.max(
    0,
    ...sources.filter((path) => existsSync(path)).map((path) => statSync(path).mtimeMs),
  );
  const builtAt = existsSync(entry) ? statSync(entry).mtimeMs : 0;
  if (builtAt > 0 && builtAt >= newestSource) return;

  process.stdout.write('› 编译插件宿主半侧（tsc -p tsconfig.plugin.json）...\n');
  const tsc = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) fail('缺少 typescript，请先在仓库根执行 npm install');
  const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.plugin.json'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) fail('TypeScript 编译失败，安装中止');
}

/** 读取 profile 清单；不存在时返回 undefined（由调用方给出提示）。 */
function readProfileManifest(profileDir) {
  const manifestPath = join(profileDir, 'package.json');
  if (!existsSync(manifestPath)) return undefined;
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`profile 清单不是合法 JSON: ${manifestPath}\n${String(error)}`);
  }
}

/** 生成 `link:` 依赖说明符（pnpm 对本地目录建符号链接，源码改动无需重装）。 */
function linkSpecifier() {
  return `link:${REPO_ROOT.replaceAll('\\', '/')}`;
}

/**
 * 无桌面端 CLI 时的兜底：手动维护 profile 清单。
 *
 * 与插件管理器落盘结构一致：dependencies 增加 link 依赖、dsh.profile.bundles 末尾追加包名。
 */
function manualInstall(profileDir, manifest, options) {
  const dependencies = { ...(manifest.dependencies ?? {}) };
  const bundles = [...(manifest.dsh?.profile?.bundles ?? [])];
  if (options.remove) {
    delete dependencies[PACKAGE_NAME];
    for (let index = bundles.length - 1; index >= 0; index -= 1) {
      if (bundles[index] === PACKAGE_NAME) bundles.splice(index, 1);
    }
  } else {
    dependencies[PACKAGE_NAME] = linkSpecifier();
    if (!bundles.includes(PACKAGE_NAME)) bundles.push(PACKAGE_NAME);
  }

  const updated = {
    ...manifest,
    dependencies,
    dsh: { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles } },
  };
  const manifestPath = join(profileDir, 'package.json');
  const backupPath = `${manifestPath}.bak-${PACKAGE_NAME}-${Date.now()}`;
  copyFileSync(manifestPath, backupPath);
  writeFileSync(manifestPath, `${JSON.stringify(updated, undefined, 2)}\n`);
  process.stdout.write(`› 已更新 ${manifestPath}（备份: ${backupPath}）\n`);
  process.stdout.write('› 请用桌面端自带的 pnpm 安装 profile 依赖：\n');
  process.stdout.write(
    `  node "${join(resolveDshHome(), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe')}" ` +
      `"${join(resolveDshHome(), 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs')}" install\n`,
  );
}

/** 主流程。 */
function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const profileDir = join(resolveDshHome(), 'profiles', options.profile);
  const manifest = readProfileManifest(profileDir);
  if (manifest === undefined) {
    fail(
      `未找到 profile 清单: ${join(profileDir, 'package.json')}\n` +
        '请先启动一次 DSH 桌面端完成 profile 初始化，再执行本脚本。',
    );
  }

  const cli = resolveDesktopCli();
  const specifier = linkSpecifier();
  const command = options.remove ? 'remove' : 'add';

  if (cli === undefined) {
    process.stdout.write('⚠ 未找到桌面端 CLI；改用清单兜底方案。\n');
    if (options.dryRun) {
      process.stdout.write(
        `› 计划${options.remove ? '卸载' : '安装'} ${PACKAGE_NAME} → ${profileDir}\n`,
      );
      return;
    }
    manualInstall(profileDir, manifest, options);
    return;
  }

  const args = ['plugin', '--profile', options.profile, command];
  if (!options.remove) args.push(specifier);
  if (options.remove) args.push(PACKAGE_NAME);

  if (options.dryRun) {
    process.stdout.write(`› ${cli} ${args.join(' ')}\n`);
    return;
  }

  ensurePluginBuilt();
  process.stdout.write(`› 调用桌面端插件管理器: ${args.join(' ')}\n`);
  const result = runDesktopCli(cli, args);
  if (result.error !== undefined) fail(`桌面端 CLI 执行失败: ${result.error.message}`);
  if (result.status !== 0) fail(`插件安装命令退出码 ${String(result.status)}，安装未完成`);

  // 安装后复查落盘结果：依赖 + bundles 必须同时命中（插件管理器的 reconcile 会补齐 bundles）。
  const updated = readProfileManifest(profileDir);
  const installedDependency = updated?.dependencies?.[PACKAGE_NAME];
  const inBundles = (updated?.dsh?.profile?.bundles ?? []).includes(PACKAGE_NAME);
  if (!options.remove && (installedDependency === undefined || !inBundles)) {
    fail(
      `已执行安装，但 profile 清单未同时出现依赖与 bundle 项（dependency=${String(
        installedDependency,
      )}, bundle=${String(inBundles)}）。请检查插件管理器日志后重试。`,
    );
  }

  process.stdout.write(
    options.remove
      ? '✓ 卸载完成：重启 DSH 后不再加载看板娘插件（应用本体与仓库文件不受影响）\n'
      : [
          '✓ 安装完成。接下来：',
          '  1) 完全退出并重启 DSH 桌面端；',
          '  2) DSH 启动时会拉起看板娘（需已执行 make build 生成 exe）；',
          '  3) 新建会话即可看到 mcp__kanbanniang__* 工具。',
          '',
        ].join('\n'),
  );
}

main();
