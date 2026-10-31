# DSH 插件市场分发可行性

> 目标：用可复现的证据回答「看板娘能否直接从 DSH（DeepSeek Harness）插件市场安装」，并列出启用市场分发前必须解决的事项。
> 验证对象：**DSH 桌面端 0.2.1-rc.3**（`dsh --version` 实测输出 `0.2.1-rc.3`），Windows x64。
> 证据标注：`【实测】`= 本机真实运行并保留输出；`【静态】`= 阅读 DSH 安装包内代码得出，未运行。

## 结论（TL;DR）

| 问题 | 结论 |
|---|---|
| DSH 0.2.1-rc.3 本身支持「第三方插件市场」吗？ | **支持**。可选组合包 `@deepseek-ai/dsh-experimental-plugin-market-bundle` 提供「发现」页；索引格式 1 有随装校验器；安装走 `pluginManager.installBundle`，源可以是 npm 版本或 git 仓库的精确 commit。【实测+静态】 |
| 本仓库现在能通过市场直接装好吗？ | **不能**。即使自建索引，「安装成功」之后看板娘也起不来：git 包不含 `lib/`（入口不存在）、包内没有可执行文件且宿主插件的可执行文件定位依赖仓库根（`src/tauri/Cargo.toml` 不会进包）、`prepare` 构建被 pnpm 拦截。【实测】 |
| 现在可用的安装方式 | 本地 `link:` 安装（`npm run plugin:install` 或 GUI「插件 → 安装第三方插件 → 填仓库绝对路径」），见 README。 |
| 上架前必须补齐 | ① `lib/` 进入安装包 ② 应用可执行文件的分发与定位 ③ 索引托管 ④ 模型获取方式（模型不入库）。见[未来启用清单](#未来启用清单)。 |

一句话：**协议与工具链层面已具备，仓库打包形态层面尚不具备。**

---

## 1. DSH 插件市场机制（代码依据）

以下路径均指桌面端安装目录内的 `resources/app.asar/dsh/node_modules/...`；`@deepseek-ai/<包名>/lib/*.js` 为随装实现。

### 1.1 市场是可选组合包（bundle）

- `@deepseek-ai/dsh-experimental-plugin-market-bundle` 的 `cordis.patch.yml` 插入两行：`plugin-market`（Host 服务，包 `@deepseek-ai/dsh-plugin-market`）与 `ui-plugin-market`（Web 客户端，包 `@deepseek-ai/dsh-client-ui-plugin-market`）。
- 它是**随装但默认关闭**的可选组合包：`@deepseek-ai/dsh-app-boot/lib/index.js` 的 `OPTIONAL_BUNDLES` 列表包含该包名（同列表还有 session-search、agent-team-profile 等）。启用方式 = 把包名加进 profile 的 `dsh.profile.bundles`（Web 里是「插件 → 实验性插件 → 自定义插件市场」）。
- 当前 DSH **没有官方市场**；发现页只列出用户自己添加的索引源，索引源默认 `[]`（`dsh-plugin-market/README.zh.md`「已知限制」与 `plugin-market` 行配置 `indexes`）。
- 索引源由用户添加：发现页「管理来源」调用 `pluginMarket.setIndexes(urls)`，写入该 profile 的 `plugin-market` 行配置；等价地，也可以在 profile 的 `cordis.patch.yml` 里覆盖 `plugin-market` 的 `config.indexes`（本文测试即用后者）。

索引 URL 规则（`dsh-plugin-market/lib/types/index-url.js:normalizeIndexUrl`）：绝对 `http:`/`https:`，不带凭据、不带 fragment；Host 端 `fetch` **拒绝重定向**（需直接配置最终 URL）。

### 1.2 索引格式 1（随装校验器）

校验器：`@deepseek-ai/dsh-plugin-market-index/lib/index.js`（导出 `parseMarketIndex` / `marketInstallTarget` / `MarketIndexError`），无运行时依赖（仅 `semver`）。

必需与约束（`parseMarketIndex(value, indexUrl)`，遇第一条违规抛错，`path` 给出 JSON 路径）：

| 字段 | 规则 |
|---|---|
| `format` | 必须为数字 `1` |
| `title` | 字符串，或语言对象；**对象形式必须含 `en`**（`localizedText`） |
| `plugins` | 非空数组，`name` 必须是合法 npm 包名且不重复 |
| `plugins[].versions` | 非空数组；`version` 必须是**精确 SemVer**（不允许 `^0.1.0`）；同插件内版本不重复；结果按 SemVer 降序 |
| `versions[].publishTimestamp` | 整数秒（Unix 秒，`[0, 10^11)`） |
| `versions[].source` | `{type:"npm", registry?}` 或 `{type:"git", url, commit, path?}` |
| git source | `url` 必须是**规范化 https**、≥2 段路径、不能是 tarball；`commit` 必须是**40 位小写十六进制**；`path` 为包所在子目录（monorepo） |
| npm source | 可选 `registry`（http/https） |
| `engines.dsh` | 可选；必须是 SemVer range（不允许 `workspace:`） |
| `icon` | 相对索引 URL 解析（须 https 或与索引同源），或 SVG/PNG/JPEG/WebP 的 `data:` URL（解码后 ≤32 KiB） |
| 其它 | 未定义成员被丢弃；`metadata.categories/labels/sortKeys` 需先声明再引用 |

> 校验器只做格式校验，不验证包真实内容；索引没有签名，**索引里的 name/version 是市场声明，实际加载什么由安装后的 manifest 决定**（`dsh-plugin-market/README.zh.md`）。

### 1.3 安装参数与安装链路

- `marketInstallTarget(name, version)`（`dsh-plugin-market-index/lib/index.js:311`）生成 pnpm 安装 spec：
  - npm → `name@version`（带 `registry` 时一并返回）；
  - git → `git+<url>[.git]#<commit>`，monorepo 追加 `&path:/<dir>`。
- 发现页「安装」= 先 `inspect(spec)` 再 `pluginManager.installBundle(spec, {registry?, saveExact?})`（`dsh-client-ui-plugin-market/lib/client.js` 的 `install({...version.install, title, version})` → `dsh-client-ui-plugin-manager/lib/client.js:installFrom` → `startInstall` → `ctx.remote.pluginManager.installBundle`）。
- `installBundle`（`dsh-plugin-manager/lib/index.js`）关键行为【静态】：
  - pnpm 之前先做 `git ls-remote` 连通性检查，**仅对 `github.com`/`*.github.com`**，超时 5 s；只拦截网络失败/超时；
  - 用 `pnpm add <spec>`（npm 源带 `--registry` 与注册表回退）；
  - 失败/取消/装到的包没有 `dsh.bundle` → **恢复 `package.json` 与 `pnpm-lock.yaml`**；
  - 安装成功后校验 `engines.dsh` 等兼容性，再把包名追加进 `dsh.profile.bundles`（默认启用，`enabled !== false`）；
  - pnpm 11 拦下构建脚本时返回 `pendingBuilds`，Web 可「允许这些脚本并重试」（`approvedBuilds` → 写 `pnpm-workspace.yaml` 的 `allowBuilds.<包名>: true`）。
- CLI 等价性：`dsh plugin --profile <p> add <spec>` 与上述服务走同一份 `@deepseek-ai/dsh-plugin-manager/operations`：同样在 profile 目录执行 `pnpm add`，成功后用同一套 `reconcile` 把新包追加进 `dsh.profile.bundles`（`dsh/lib/plugin-BiveYA7h.js:runPlugin` → `runPluginCommand` → `runProfilePnpm` → `reconcile`）。差异：CLI 没有 GitHub 预检、没有审批/HMR 语义、不返回 `pendingBuilds`。因此**用 CLI 的 `file:` / `git+...` 安装可等价验证「市场安装后落到 profile 的状态」**；本文即以此实测，并在 §2.3 标注等价性依据。

### 1.4 版本兼容性

`engines.dsh` 由 `evaluatePluginCompatibility`（`dsh-app-boot/lib/index.js`）判断，内部用 `semver.satisfies(runtime, range, { includePrerelease: true })`——**预发布版本参与匹配**。本仓库 `engines.dsh = ^0.2.0-rc.1` 对运行时 `0.2.1-rc.3` 判定为满足【实测：`semver.satisfies('0.2.1-rc.3','^0.2.0-rc.1',{includePrerelease:true}) === true`；不传该选项时为 false，注意区别】。所以市场条目可用同一 range；若要更严格可写 `^0.2.1-rc.0`。

### 1.5 复核时发现的措辞差异（避免后续引用出错）

| 常见说法 | 更准确的事实 | 依据 |
|---|---|---|
| 「CLI 拒绝操作 desktop profile」 | 只有**通用** `dsh` 拒绝；桌面端安装包自带的 `dsh.cmd` 传了 `manageDesktopProfile: true`，因此允许（本仓库 `scripts/install-dsh-plugin.mjs` 正依赖这一点）。测试仍应避开 desktop profile。 | `@deepseek-ai/dsh/lib/bin.js`（`rejectElectronProfile` 只在 `!manageDesktopProfile` 时调用）【静态】 |
| 「`engines.dsh ^0.2.0-rc.1` 对 0.2.1-rc.3 不满足，会挡安装」 | 不成立：DSH 判定带 `{ includePrerelease: true }`，实测判定为满足；裸 `semver.satisfies` 才为 false。 | §1.4【实测】 |
| 「git 安装由 `prepare` 构建 `lib/`」 | 默认走不通：pnpm 报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`；必须写入 `包名@git+url#commit` 形式的精确 `allowBuilds` key 才会执行 prepare。DSH 的 `approvedBuilds` 只写包名，覆盖不了。 | §2.6【实测】 |
| 「CLI 的 `plugin add` 只跑 pnpm」 | 不止：成功的安装会自动把新包追加进 `dsh.profile.bundles`（`reconcile`），与市场安装落盘状态一致。 | §2.3【实测】+ `operations.js:reconcile`【静态】 |
| 「git 安装 spec 是 `git+<https>#<commit>`」 | 还会补 `.git` 后缀（若 url 未以 `.git` 结尾）；monorepo 用 `&path:/<dir>` 追加，不是 `?path=`。 | `marketInstallTarget`【实测】 |
| 「索引图标必须 https」 | 相对图标允许与索引**同源**（本地 http 索引 + 相对 `assets/icon.png` 实测通过）；其余情况才要求 https 或 `data:`。 | §2.1【实测】 |

---

## 2. 实测记录

测试全程隔离：`DSH_HOME` 指向临时目录，不触碰真实 `~/.dsh` 与 desktop profile；看板娘 MCP 端点覆盖到未占用的 `127.0.0.1:7499`，用户正在运行的 `7432` 实例未被访问或终止。

### 2.1 索引条目校验与安装参数【实测】

用随装校验器 `parseMarketIndex` 校验「本仓库的合法条目」，并打印 `marketInstallTarget` 的结果：

```
PARSE_OK KanbanNiang Test Market plugins=1
plugin.name = kanbanniang | versions = 0.1.0
icon resolved = http://127.0.0.1:7498/assets/icon.png
engines.dsh = {"dsh":"^0.2.0-rc.1"}
INSTALL_TARGET {"spec":"git+https://github.com/example-owner/kanbanniang.git#0123456789abcdef0123456789abcdef01234567"}
INSTALL_TARGET_PATH {"spec":"git+https://github.com/example-owner/monorepo.git#0123456789abcdef0123456789abcdef01234567&path:/packages/kanbanniang"}
INSTALL_TARGET_NPM {"spec":"kanbanniang@0.1.0","registry":"https://registry.npmmirror.com/"}
NEGATIVE bad-commit => $.plugins[0].versions[0].source.commit: must be a lowercase 40-hex-digit commit SHA
NEGATIVE title-missing-en => $.title: must contain en
NEGATIVE version-not-semver => $.plugins[0].versions[0].version: must be an exact SemVer version
NEGATIVE git-http-rejected => $.plugins[0].versions[0].source.url: must use https:
```

条目模板（占位 owner/commit，实测用的就是它）：

```json
{
  "format": 1,
  "title": { "en": "KanbanNiang Test Market", "zh": "看板娘测试市场" },
  "plugins": [
    {
      "name": "kanbanniang",
      "title": { "en": "KanbanNiang", "zh": "看板娘" },
      "icon": "assets/icon.png",
      "metadata": { "keywords": ["live2d", "tauri", "mcp"] },
      "versions": [
        {
          "version": "0.1.0",
          "publishTimestamp": 1761868800,
          "source": {
            "type": "git",
            "url": "https://github.com/example-owner/kanbanniang",
            "commit": "0123456789abcdef0123456789abcdef01234567"
          },
          "engines": { "dsh": "^0.2.0-rc.1" }
        }
      ]
    }
  ]
}
```

### 2.2 启用市场组合包 + 配置索引源 → `--dump-config`【实测】

在测试 profile（由 `web` 模板初始化）的 `package.json` 中加入市场组合包，并在 profile 的 `cordis.patch.yml` 覆盖索引源：

```yaml
- id: plugin-market
  name: '@deepseek-ai/dsh-plugin-market'
  config:
    indexes:
      - http://127.0.0.1:7498/market-index.json
```

`DSH_HOME=<临时目录> dsh --profile market-test --dump-config` 输出（节选，实测 dump 第 1232–1241 行）：

```
# == @deepseek-ai/dsh-experimental-plugin-market-bundle, patched by ...\profiles\market-test\cordis.patch.yml
- id: plugin-market
  name: '@deepseek-ai/dsh-plugin-market'
  disabled: !!js '!ctx.get(''profileContext'')'
  config:
    indexes:
      - http://127.0.0.1:7498/market-index.json
# == @deepseek-ai/dsh-experimental-plugin-market-bundle
- id: ui-plugin-market
  name: '@deepseek-ai/dsh-client-ui-plugin-market'
```

结论：把组合包名加入 `dsh.profile.bundles` 即可让 `plugin-market` / `ui-plugin-market` 行出现在组合结果里，索引源也在该行 `config.indexes` 生效。真实 profile 启动时 `profileContext` 存在，`disabled` 的 `!!js` 为假；该次启动日志也没有出现「entries did not activate」类告警（对比 §2.5 的反例），说明两行正常激活。

### 2.3 安装「市场形态」的包 → profile 状态【实测】

把仓库按 git 包内容暂存（`git ls-files` + 已编译的 `lib/`；不含 `target/`、不含模型），执行：

```
dsh plugin --profile market-test add "file:<仓库根>/.tmp/stage/kanbanniang"
```

结果：

```
dependencies:
+ kanbanniang kanbanniang@file:../../../stage/kanbanniang(0736f5bd...)
Done in 6s using pnpm v11.28.5
```

profile 的 `package.json` 被更新（`dsh plugin` 自动完成选择，与市场安装一致）：

```json
"dependencies": { "kanbanniang": "file:<仓库根>/.tmp/stage/kanbanniang" },
"dsh": { "profile": { "bundles": [ "...", "@deepseek-ai/dsh-experimental-plugin-market-bundle", "kanbanniang" ] } }
```

再 dump 一次，出现两行宿主插件：

```
# == kanbanniang
- id: kanbanniang
  name: kanbanniang
  config: { autoLaunch: true }
- id: kanbanniang-mcp
  name: '@deepseek-ai/dsh-mcp-client'
  inject: [mascotStartup]
  config:
    serverName: kanbanniang
    transport: streamable-http
    url: !!js ctx.mascotStartup.mcpUrl ?? 'http://127.0.0.1:7432/mcp'
```

安装落盘形态【实测】：`node_modules/kanbanniang/` 只有 `lib/`、`assets/`、`cordis.patch.yml`、`README.md`、`package.json`——pnpm 按 `files` 字段打包本地/git 依赖，`src/`、`scripts/` 等**不会**进入安装目录。**安装目录里没有 `target/release/kanbanniang.exe`。**

### 2.4 启动测试 profile → plugin.log【实测】

`dsh --profile market-test`（Web profile，`DSH_HOME` 在仓库外的临时目录，`mcpUrl` 覆盖为 7499）启动成功（`dsh web: http://127.0.0.1:3080/?token=...`），同时 `<DSH_HOME>/kanbanniang/plugin.log` 记录：

```
2026-10-31T14:01:28.313Z INFO [kanbanniang] 激活: mcpUrl=http://127.0.0.1:7499/mcp 来源=config autoLaunch=true
2026-10-31T14:01:28.760Z ERROR [kanbanniang] 未找到看板娘可执行文件。请先在仓库根执行 "make build" 生成 target/release/kanbanniang.exe，或在 cordis.patch.yml 中配置 launchCommand。
```

即：**市场形态下宿主插件能加载、`mascotStartup` 服务能发布（日志第一行先于报错），但拉不起应用**；DSH 自身不崩，工具因 MCP 端点无服务而不可用（MCP 客户端行 `failOnStartupError: false` 只重连）。

另用单元级方式（直接 `import` 安装目录里的 `lib/host.js`，桩 ctx）复现同一结论，同时确认 `ctx.provide('mascotStartup', …)` 在任何失败路径前发生：

```
PROVIDE mascotStartup = {"mcpUrl":"http://127.0.0.1:7499/mcp"}
INFO    [kanbanniang] 激活: ...
ERROR   [kanbanniang] 未找到看板娘可执行文件。...
```

### 2.5 如果 `lib/` 没进包（当前 git 的真实形态）【实测】

当前 `.gitignore` 忽略 `lib/`，所以真实 git 包**不含** `lib/`。用只含 `git ls-files` 内容的暂存目录安装后启动：

```
dsh: warning: 2 entries did not activate
kanbanniang (kanbanniang): failed to import: Error [ERR_MODULE_NOT_FOUND]: Cannot find module '...\node_modules\kanbanniang\lib\host.js' ...
kanbanniang-mcp (@deepseek-ai/dsh-mcp-client): pending (waiting for service: mascotStartup)
```

DSH 仍能启动（该行 import 失败按「未激活告警」处理），但看板娘功能完全缺失，且 `mascotStartup` 永不被 provide。

### 2.6 git 源安装的真实行为【实测，用本地 git 仓库模拟】

市场 git source 必须是 https，但 pnpm 的安装语义与协议无关于主机，因此用 `git+file://` 本地仓库验证机制（安装 spec 形式、commit 锁定、`files` 打包、prepare 拦截）：

1. **无 prepare、仓库自带 `lib/`** → 安装成功，写出 `"kanbanniang": "git+file:///.../gitpkg#3654637f..."`，包名自动进入 `dsh.profile.bundles`，安装目录同样只有 `files` 列出的内容。
2. **不含 `lib/`、靠 `prepare` 构建** → 失败并回滚：

   ```
   [ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package fetched from "...": The git-hosted package "kanbanniang@0.1.0" needs to execute build scripts but is not in the "allowBuilds" allowlist.
   ...allowBuilds:
     kanbanniang@git+file:///<仓库根>/.tmp/gitpkg-prepare#5a146fa...: true
   dsh: plugin command failed; ...
   dsh: git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed — add the exact key pnpm printed above under allowBuilds in ...\pnpm-workspace.yaml, then re-run
   ```

   失败后 profile `package.json` 回到安装前（`dependencies: {}`、bundles 不含 kanbanniang），即 DSH 的「失败即恢复」逻辑生效。
3. **`allowBuilds` 只写包名（`kanbanniang: true`）→ 仍然失败**；必须写 pnpm 打印的**精确 key**（`包名@git+url#commit`）。手工写入精确 key 后重试才成功并真正执行 `prepare`、生成 `lib/`。

> 这意味着「git 包 + prepare 构建」在当前市场流程里对用户很不友好：`installBundle` 的 `approvedBuilds` 只会写 `allowBuilds.<包名>: true`（`dsh-plugin-manager/lib/index.js:approveBuilds`），而 pnpm 对 git prepare 要求精确 key。**未在 GUI 实测该路径**，仅由代码与 pnpm 行为推断。

### 2.7 可执行文件定位规则【实测】

`lib/runtime.js` 的 `findRepoRoot()` 需要「same dir has `package.json` **且** `src/tauri/Cargo.toml`」，然后只认 `<repoRoot>/target/release/kanbanniang.exe`（或 debug）。直接探测安装目录：

```
moduleRoot() = ...\node_modules\kanbanniang\lib
findRepoRoot(安装后的包目录) = undefined
detectLaunch(undefined, 默认配置) = undefined
```

再构造「包内自带 `src/tauri/Cargo.toml` + `target/release/kanbanniang.exe`」的目录：

```
findRepoRoot(fake) = C:\...\fake-repo
detectLaunch(fakeRoot) = { command: 'C:\...\fake-repo\target\release\kanbanniang.exe', args: [], cwd: 'C:\\...\\fake-repo' }
```

即：**要自包含启动，安装包必须同时带 `src/tauri/Cargo.toml`（用于根判定）与 `target/release/kanbanniang.exe`，并让 `files` 包含它们；或改宿主插件支持包内相对路径 / 用 `launchCommand` 配置。** 当前 `files` 只有 `lib`、`assets`、`cordis.patch.yml`、`README.md`，两者都不在包内。

> 一个容易误判的交互（**静态推断，未在仓库内的 home 上启动验证**）：`findRepoRoot()` 会从包目录向上最多走 8 层。如果 `DSH_HOME` 恰好放在本仓库内（例如 `C:\Code\pet\.tmp\dsh-home`，从 `...\profiles\<p>\node_modules\kanbanniang\lib` 上溯到 `C:\Code\pet` 只需 8 步），它会命中仓库根，进而找到并拉起你本机的 `target/release/kanbanniang.exe`，看起来像「市场安装能启动」。本次启动测试特意把 `DSH_HOME` 放在仓库外的临时目录，避免这个假阳性；复现时也要注意（见 §6.2 步骤 7 的提示）。

---

## 3. 阻塞项清单（每条含证据）

| # | 阻塞项 | 证据 | 影响 |
|---|---|---|---|
| 1 | **`lib/` 不在 git**（`.gitignore` 含 `lib/`），git 包没有 `main` 入口 | §2.5 实测 `ERR_MODULE_NOT_FOUND: ...lib\host.js` | 市场安装后插件行无法 import，功能全无 |
| 2 | **包内没有应用可执行文件**，且定位逻辑要求仓库根（`src/tauri/Cargo.toml`）+ `target/release/kanbanniang.exe` | §2.7 实测 `findRepoRoot = undefined`；§2.4 plugin.log | 无法冷启动看板娘；MCP 工具不可用 |
| 3 | **`files` 字段只列 `lib/assets/cordis.patch.yml/README.md`**，pnpm 按 `files` 打包本地/git 依赖，`src/` 因此不进安装目录 | §2.3 安装目录实测（只有 5 个条目） | 即使 exe 打进包，`findRepoRoot` 也判不出包目录是「仓库根」（它要求 `src/tauri/Cargo.toml`） |
| 4 | **`prepare` 构建被 pnpm 拦截**，且 `allowBuilds` 要求精确 `包名@git+url#commit` | §2.6 实测 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`；`allowBuilds: kanbanniang` 仍失败 | 「不提交 lib、靠安装期构建」的方案对普通用户不可行；每个版本/commit 都要手工加 key |
| 5 | **模型不入库**（`/models/*/` 被忽略，`models/README.md` 保留） | `.gitignore` + `models/README.md` | 市场包不含 Live2D 模型；用户仍需自备 Cubism 模型并拖拽导入 |
| 6 | **没有可发布的 npm 包**：`private: true`，且这是 Tauri 应用源码（含 Rust/Vite 前端），并非纯 Host 插件 | `package.json` | 市场的 npm source（`name@version`）不可用，只剩 git source；Tauri 应用无法在安装期构建 |
| 7 | **市场索引无签名、无官方市场** | `dsh-plugin-market/README.zh.md` | 索引需自建自托管；用户需手动加来源；内容可信度靠用户判断 |
| 8 | 仅 Windows 验证 | `runtime.js` 的 `EXE_CANDIDATES` 分平台；本次只在 Windows x64 实测 | macOS/Linux 的 exe 分发与定位未验证 |

不受阻、但需要知道的点：

- `engines.dsh = ^0.2.0-rc.1` **不阻塞** 0.2.1-rc.3（DSH 用 `includePrerelease` 判定，§1.4）。
- `private: true` **不阻塞** pnpm 安装（本次 file:/git: 安装都成功）；它只影响 `npm publish`。
- 市场安装默认启用组合包（`installBundle` 的 `enabled !== false`），无需用户再手动勾选。

---

## 4. 未来启用清单

按依赖顺序列出；每项给出可选方案与取舍。**这些都未实现**，仅作为上架路线。

### 4.1 索引托管

- 索引是一份静态 JSON（格式 1），必须可通过 **http(s)、无凭据、无 fragment、无重定向** 直接取到。
- 可选：GitHub Pages（`https://<owner>.github.io/<repo>/market-index.json`）、仓库 raw 地址（`https://raw.githubusercontent.com/...`，需实测该 URL 是否直达——Host 拒绝重定向）、任意静态对象存储/自建站点。
- 图标：同源相对路径最省事（如 `assets/icon.png`），或 https 绝对 URL，或 ≤32 KiB 的 `data:` URL。注意 `referrerPolicy: no-referrer` 不影响加载。
- 发现页不直连索引（Host 侧 fetch），因此**不需要 CORS**；但图标由浏览器 `<img>` 直接加载，需公网可达。

### 4.2 版本条目字段（每发一版更新一次）

```json
{
  "version": "<精确 SemVer，例如 0.1.0>",
  "publishTimestamp": 1761868800,
  "source": {
    "type": "git",
    "url": "https://github.com/<owner>/<repo>",
    "commit": "<40 位小写 hex>"
  },
  "engines": { "dsh": "^0.2.1-rc.0" }
}
```

- `commit` 与发布 tag 一一对应，市场安装是**精确 commit 锁定**（不会跟随分支）。
- monorepo 时加 `"path": "packages/dsh-plugin"`。
- `title`/`description` 对象形式必须含 `en`；`homepage`/`repository` 用 https。

### 4.3 `lib/` 产物进包（三选一）

| 方案 | 做法 | 优点 | 代价 |
|---|---|---|---|
| A. 提交构建产物 | `.gitignore` 去掉 `lib/`（或加 `!lib/`），提交 `npm run plugin:build` 输出 | 最简单、市场安装即可用；pnpm 按 `files` 打包 | 仓库出现生成物；每次改 `src/plugin` 要同步提交并防漂移（可用 CI 校验 `lib/` 与源码一致） |
| B. `prepare` 构建 | 包加 `"prepare": "npm run plugin:build"`，git 包不含 `lib/` | 仓库干净 | **当前市场流程对普通用户不可用**：pnpm 拦截 prepare，需手工写精确 `allowBuilds` key（§2.6）；`approvedBuilds` 只写包名，覆盖不了 |
| C. 单发一个纯插件 npm 包 | 把 Host 插件单独发布（含 `lib`），应用本体另行分发 | 符合市场 npm source；体积小 | 需要拆包与发布流程；本次范围外 |

> 推荐 A（配合 CI 防漂移）；若坚持 B，需要 DSH 侧支持「git prepare 审批 + 精确 key」或改用 `postinstall` 之外的分发方式——不是本仓库能单方面解决的。

### 4.4 应用本体（exe）分发（四选一）

| 方案 | 做法 | 说明 |
|---|---|---|
| A. 包内自带 exe | git 树提交 `target/release/kanbanniang.exe`（`target/` 在 `.gitignore` 里，需 `git add -f`），`files` 增加 `target/release/kanbanniang.exe` 与 `src/tauri/Cargo.toml` | 与现有 `findRepoRoot` 逻辑兼容（§2.7 已验证规则）；代价是仓库/安装包 +24 MB 二进制、且需按平台分别提供 |
| B. 首次运行下载安装包 | 宿主插件新增「从 GitHub Releases 下载并校验哈希」逻辑 | 代码改动；需要网络、签名/校验与更新策略；repo 保持干净 |
| C. 用户单独安装应用 | 插件只探活/连接，`autoLaunch: false` 或找不到 exe 时提示去下载 | 改动最小；但失去「DSH 启动自动拉起」的核心体验 |
| D. 发布安装器 + 插件仅装配 | 用现有 `tauri build` 产物做 NSIS/MSI，插件沿用本机安装路径 | 需要改 `detectLaunch` 的候选路径（读安装位置/注册表/配置），不兼容当前「仓库根」逻辑 |

> 任选其一都要同步改 `lib/runtime.js` 的候选路径或 `cordis.patch.yml` 的 `launchCommand`/`repoRoot` 兜底；建议给 `detectLaunch` 增加「包内 `bin/`」候选并允许配置，减少平台差异。

### 4.5 模型获取

- 模型有版权且体积大，继续不入库（`models/README.md` 已说明）。
- 市场安装后：应用首次运行应能引导用户拖拽导入 `.zip`/模型文件夹（现有能力），或在 README/插件描述里明确「需自备 Cubism 3–5.3 模型」。
- 若要内置示例模型，必须确认 Cubism 许可允许再分发（当前仓库未做此声明）。

### 4.6 上架前验收清单

1. `dsh plugin --profile <test> add "git+<https url>#<commit>"` 在隔离 `DSH_HOME` 下安装成功，profile 的 `dependencies` 与 `dsh.profile.bundles` 同时更新。
2. `dsh --profile <test> --dump-config` 中能看到 **市场两行**（`plugin-market`、`ui-plugin-market`，含 `indexes`）和 **看板娘两行**（`kanbanniang`、`kanbanniang-mcp`）。
3. `<DSH_HOME>/kanbanniang/plugin.log` 不再出现「未找到看板娘可执行文件」，出现「MCP 服务就绪」与「前端链路就绪」。
4. 自建索引能被 `parseMarketIndex` 通过（含 en 标题、精确 SemVer、40 位 commit、https git URL）。
5. 在真实 GUI「发现」页添加该索引 URL，搜索到条目并能点安装（本文未在 GUI 点击验证，见 §5）。
6. 新版本发布后：更新索引 `commit`/`version`/`publishTimestamp`，且 `engines.dsh` 与当前 DSH 版本兼容。

---

## 5. 未验证项与限制

| 项 | 状态 | 原因 |
|---|---|---|
| 在 GUI「发现」页实际点击安装 | **未验证** | 需要桌面 GUI 交互；本文用 CLI（同一份安装 operation）验证落盘状态，并在 `--dump-config` 验证行与索引 |
| 真实 `git+https://github.com/...` 安装 | **未验证** | 仓库尚无公开远端；用 `git+file://` 本地仓库验证 pnpm 的 git 语义。市场校验器只接受 https（已验证），DSH 对 GitHub 另有 5 s `ls-remote` 预检（静态阅读） |
| `installBundle` 服务路径的 `pendingBuilds`/`approvedBuilds` | **未验证** | 该路径只在 Host 服务（GUI/工具）触发；本文只验证了 CLI 与 pnpm 行为，并据代码说明其局限 |
| macOS / Linux 平台 | **未验证** | 仅 Windows x64 环境；`EXE_CANDIDATES` 有非 Windows 分支但未实测 |
| 市场安装后的 MCP 工具实际可用性 | **未验证** | 冷启动失败是前置阻塞；未构建「自带 exe」的完整包来端到端跑工具 |
| 索引体量/大市场性能 | **未验证** | 与本次分发无关，未测 |
| 应用下载/更新/签名方案 | **未开始** | 属 4.4 待定方案 |

另：本次测试启动了一个隔离的 Web profile（`127.0.0.1:3080`），执行过 `dsh web`，默认行为会打开一次浏览器；测试进程已结束。用户正在运行的看板娘实例（7432）与 desktop profile 全程未操作。

---

## 6. 可复现命令（Windows）

> 下面命令在仓库根执行。CLI 路径与版本以本机安装为准（DSH 桌面端 0.2.1-rc.3）。测试用 `DSH_HOME` 完全隔离，**不要**对 `desktop` profile 做实验。

### 6.1 调用桌面端 CLI

官方入口是 `resources/runtime/cli/bin/dsh.cmd`（脚本内部以 `ELECTRON_RUN_AS_NODE=1` 运行 `app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`）。MSYS bash 下直接执行 `.cmd` 容易踩路径/引号问题，本次实测用「以 Node 模式运行同一 cli.js」的封装：

```bash
DSH_APP="${LOCALAPPDATA:-/c/Users/<你>/AppData/Local}/Programs/DeepSeek Harness"
DSH_CLI() {
  ELECTRON_RUN_AS_NODE=1 "$DSH_APP/DeepSeek Harness.exe" \
    --expose-internals "$DSH_APP/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js" "$@"
}
DSH_CLI --version        # 输出 0.2.1-rc.3
```

PowerShell 下可直接用 `.cmd`（与仓库 `scripts/install-dsh-plugin.mjs` 一致）：

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
$env:DSH_HOME = "<仓库根>\.tmp\dsh-home"
& $dsh --profile market-test --dump-config
```

> 只有桌面端安装包提供的 CLI 才允许操作 `desktop` profile（`runDesktopCli` 传 `manageDesktopProfile: true`）；PATH 上的通用 `dsh` 会拒绝。测试一律用非 desktop profile。

### 6.2 隔离 profile → 市场行 → 安装 → 启动

```bash
# 1) 隔离 home + 由 web 模板初始化测试 profile
export DSH_HOME="<仓库根>/.tmp/dsh-home"
DSH_CLI --profile market-test --from-default-profile web --dump-config > .tmp/dump-web-initial.yml

# 2) 启用市场组合包：编辑 .tmp/dsh-home/profiles/market-test/package.json
#    dsh.profile.bundles 追加 "@deepseek-ai/dsh-experimental-plugin-market-bundle"
# 3) 在 profile 的 cordis.patch.yml 写入 plugin-market 的 config.indexes（见 §2.2）
# 4) 本地起静态索引服务器（127.0.0.1:7498 指向 .tmp/market-test/），然后：
DSH_CLI --profile market-test --dump-config | grep -A 8 "id: plugin-market"

# 5) 用 file: 验证「市场安装后」的 profile 状态
DSH_CLI plugin --profile market-test add "file:<仓库根>/.tmp/stage/kanbanniang"
DSH_CLI --profile market-test --dump-config | grep -A 6 "id: kanbanniang"

# 6) 用本地 git 仓库验证 git spec（等价于市场的 git+https，仅主机不同）
DSH_CLI plugin --profile market-git add "git+file:///<仓库根>/.tmp/gitpkg#<40位commit>"

# 7) 启动隔离 profile，观察插件日志（--no-open 避免开浏览器；端点先覆盖到 7499 避免碰 7432）
#    注意：做「冷启动失败」复现时，DSH_HOME 要放在仓库之外（如 %TEMP%\dsh-verify-home），
#    否则 findRepoRoot() 会沿目录向上找到本仓库，从而真的拉起你本机的 target/release 产物。
DSH_CLI --profile market-test --no-open
cat "$DSH_HOME/kanbanniang/plugin.log"
```

校验索引条目（需要先从 DSH 安装包抽出校验器，见下面的抽取脚本）：

```js
// verify-index.mjs —— 与 node_modules/ 同级；node_modules 内需有抽出的
// @deepseek-ai/dsh-plugin-market-index 与 semver（它只依赖后者）
import { readFileSync } from 'node:fs';
import { parseMarketIndex, marketInstallTarget, MarketIndexError }
  from '@deepseek-ai/dsh-plugin-market-index';
const indexUrl = 'http://127.0.0.1:7498/market-index.json';
const doc = JSON.parse(readFileSync('./market-index.json', 'utf8'));
const parsed = parseMarketIndex(doc, indexUrl);
console.log(JSON.stringify(marketInstallTarget(parsed.plugins[0].name, parsed.plugins[0].versions[0])));
```

从 `app.asar` 抽包的小脚本（本机验证时使用；asar 数据区起点 = `8 + headerSize`，注意 `headerSize` 取自文件头 offset 4 的 uint32，不能写成 `16 + headerSize`，否则每个文件会整体偏移 8 字节）：

```js
// asar-extract.mjs <输出目录> <路径关键字...>
import fs from 'node:fs';
import path from 'node:path';
const asar = '<DSH 安装目录>/resources/app.asar';
const fd = fs.openSync(asar, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4);
const headerBuf = Buffer.alloc(headerSize);
fs.readSync(fd, headerBuf, 0, headerSize, 16);
const header = JSON.parse(headerBuf.toString('utf8').slice(0, headerBuf.toString('utf8').lastIndexOf('}') + 1));
const files = new Map();
const walk = (node, base) => { for (const [name, val] of Object.entries(node.files ?? {})) { const p = base ? `${base}/${name}` : name; val.files ? walk(val, p) : files.set(p, val); } };
walk(header, '');
const dataStart = 8 + headerSize;
const [outDir, ...keys] = process.argv.slice(2);
for (const [p, entry] of files) {
  if (!keys.some(k => p.includes(k))) continue;
  const buf = Buffer.alloc(entry.size);
  fs.readSync(fd, buf, 0, entry.size, dataStart + Number(entry.offset));
  const dest = path.join(outDir, p);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
}
```

---

## 7. 关键代码位置（0.2.1-rc.3，供复核）

| 内容 | 路径（`resources/app.asar/dsh/node_modules/` 下） |
|---|---|
| 索引格式校验 / 安装参数 | `@deepseek-ai/dsh-plugin-market-index/lib/index.js`（`parseMarketIndex` L280、`marketInstallTarget` L311） |
| 市场 Host 服务、索引 URL 规则 | `@deepseek-ai/dsh-plugin-market/lib/index.js`、`lib/types/index-url.js` |
| 发现页（Web） | `@deepseek-ai/dsh-client-ui-plugin-market/lib/client.js`（`install({...version.install,…})`） |
| 市场组合包（patch 两行） | `@deepseek-ai/dsh-experimental-plugin-market-bundle/`（`cordis.patch.yml`、`README.zh.md`） |
| 可选组合包清单 | `@deepseek-ai/dsh-app-boot/lib/index.js`（`OPTIONAL_BUNDLES`、`PROFILE_TEMPLATES`、`initProfile`） |
| 安装/回滚/审批 | `@deepseek-ai/dsh-plugin-manager/lib/index.js`（`installBundle`、`approveBuilds`、`checkGithubConnection`） |
| CLI 安装（等价路径） | `@deepseek-ai/dsh/lib/plugin-BiveYA7h.js`、`@deepseek-ai/dsh-desktop-host/lib/cli.js` |
| 兼容性判定（含 includePrerelease） | `@deepseek-ai/dsh-app-boot/lib/index.js`（`evaluatePluginCompatibility` / `satisfies`） |
| 本仓库插件侧入口与定位逻辑 | `lib/host.js`、`lib/runtime.js`、`lib/config.js`、`lib/appSettings.js`、`cordis.patch.yml` |
