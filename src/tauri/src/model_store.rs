//! 导入模型仓库（基础设施层）。
//!
//! 把用户拖进窗口的 **模型文件夹 / .zip 压缩包** 解析成可加载的 Live2D 模型：
//!
//! 1. 定位 `*.model3.json`（Cubism 3+）并解析 `FileReferences`（moc / 贴图 / 动作组 / 表情）；
//! 2. 校验配置引用的文件确实随包存在且路径不越界（缺文件提前报错，避免加载到一半失败）；
//! 3. 以「临时目录 → 旧目录挪到 .trash → 改名上位 → 删旧目录」的方式落盘到
//!    `<app_data_dir>/models/<id>/`，**同名模型**重复导入时整体替换（不做版本堆积），
//!    不同名模型即使 slug 撞车也会让位成 `-2`，绝不互相覆盖；
//! 4. 经自定义 URI 协议 `mascot-model://` 把仓库里的文件提供给 WebView
//!    （Windows 上是 `http://mascot-model.localhost/<id>/<相对路径>`）。
//!
//! 为什么不复用 Vite 的 `models/`：那目录是构建期静态资源，安装包内只读；
//! 运行时导入的模型必须落在用户数据目录，故需要一条独立的只读协议通道。
//! 该模块只做「解析 / 落盘 / 只读服务」，命令编排见 `commands.rs`。

use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use tauri::http::header;
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Manager};

/// 自定义 URI 协议 scheme（与前端 `shared/domain/imported.ts` 的资产地址成对维护）。
pub const ASSET_SCHEME: &str = "mascot-model";

/// 模型仓库在应用数据目录下的子目录名。
const STORE_DIR: &str = "models";
/// 导入模型 id 前缀：避免与构建期扫描 `models/` 得到的内置档案 id 撞车。
const IMPORTED_ID_PREFIX: &str = "imported-";
/// 模型配置文件名后缀（Cubism 3+）。
const MODEL_CONFIG_SUFFIX: &str = ".model3.json";
/// Cubism 2 配置后缀：命中时给出「不支持」的明确提示，而不是笼统的「没找到配置」。
const CUBISM2_CONFIG_SUFFIX: &str = ".model.json";
/// 目录扫描深度上限（防止异常目录结构导致长时间递归）。
const MAX_SCAN_DEPTH: usize = 6;
/// 复制目录时的深度上限（防止链接成环导致无限递归）。
const MAX_COPY_DEPTH: usize = 12;
/// 压缩包解压上限：条目数与总解压字节数（防解压炸弹）。
const MAX_ZIP_ENTRIES: usize = 5000;
const MAX_ZIP_BYTES: u64 = 512 * 1024 * 1024;
/// 导入过程中临时目录前缀：崩溃残留会在下次导入时清理。
const TMP_PREFIX: &str = ".tmp-";
/// 覆盖旧模型时先把旧目录挪成 `.trash-*`，新目录上位成功后再删（避免旧模型白白丢失）。
const TRASH_PREFIX: &str = ".trash-";
/// 同一个进程内串行化导入：id 分配 / 临时目录清理都依赖「无并发导入」这一前提。
static IMPORT_LOCK: Mutex<()> = Mutex::new(());
/// 导入模型自身的元数据文件名（记录展示名 / 主配置 / 来源 / 导入时间，供重启后回读）。
const META_FILE: &str = "mascot-import.json";

/// 一个已导入模型的元数据（与前端 `shared/domain/imported.ts` 的 `ImportedModel` 成对镜像，camelCase）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedModel {
    /// 稳定 id（也是仓库目录名），形如 `imported-haru`；MCP `set_model` 用该 id。
    pub id: String,
    /// 展示名（模型配置文件名去掉后缀，保留原始大小写与中文）。
    pub name: String,
    /// 主模型配置文件名（位于模型目录根部，如 `Haru.model3.json`）。
    pub model_file: String,
    /// 配置里声明的动作组名（供设置页展示与排查；实际可用名以加载后的模型为准）。
    pub motions: Vec<String>,
    /// 配置里声明的表情名。
    pub expressions: Vec<String>,
    /// 贴图数量（0 不可能出现：无贴图会在解析阶段被拒绝）。
    pub textures: usize,
    /// 来源类型：`folder` / `zip`。
    pub source: String,
}

/// 一次拖拽导入的结果：成功导入的模型 + 各路径的失败原因（单条失败不影响其它路径）。
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    /// 本次新导入（或替换）的模型。
    pub models: Vec<ImportedModel>,
    /// 失败原因（形如「文件名: 具体原因」，可直接展示给用户）。
    pub errors: Vec<String>,
}

/// 仓库内的模型元数据（`mascot-import.json`）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ModelMeta {
    /// 展示名（缺省回退模型配置文件名）。
    name: String,
    /// 主模型配置文件名（重启后据此回读，避免多配置目录里取错模型）。
    model_file: String,
    /// 来源类型（folder / zip）。
    source: String,
    /// 导入时间（RFC 3339，仅供排查）。
    imported_at: String,
}

/// `model3.json` 里我们关心的字段（校验 + 展示用，不参与渲染）。
#[derive(Debug, Clone)]
struct ConfigInfo {
    /// moc3 文件相对路径。
    moc: String,
    /// 贴图相对路径列表。
    textures: Vec<String>,
    /// 动作组名列表（`FileReferences.Motions` 的键）。
    motions: Vec<String>,
    /// 表情名列表（`FileReferences.Expressions[].Name`）。
    expressions: Vec<String>,
    /// `FileReferences` 下声明的全部文件路径（含动作 / 表情 / 物理 / 姿势，用于校验）。
    references: Vec<String>,
}

// ---- Tauri 命令的底层实现（命令层见 commands.rs）----

/// 仓库根目录：`<app_data_dir>/models`（只解析路径，不创建目录）。
///
/// 创建目录的时机由调用方决定：导入时创建；列表与只读协议在目录不存在时按空处理，
/// 避免每个资源请求都触发一次 `create_dir_all`。
pub fn store_root(app: &AppHandle) -> Result<PathBuf> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow!("无法解析应用数据目录: {e}"))?
        .join(STORE_DIR);
    Ok(root)
}

/// 列出已导入模型（跳过隐藏临时目录，损坏条目仅告警不拖垮整次列表）。
pub fn list(app: &AppHandle) -> Result<Vec<ImportedModel>> {
    let root = store_root(app)?;
    if !root.is_dir() {
        // 还没导入过任何模型：目录不存在属正常状态
        return Ok(Vec::new());
    }
    let mut models = Vec::new();
    let entries =
        fs::read_dir(&root).with_context(|| format!("读取模型仓库失败: {}", root.display()))?;
    for entry in entries.flatten() {
        // 单个条目读不到属性（权限/损坏）只跳过，不能连累其它模型
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if !is_dir {
            continue;
        }
        let id = file_name_lossy(&entry.path());
        // `.tmp-*` / `.trash-*` 是导入过程中的临时目录，崩溃残留也不应展示
        if id.starts_with('.') {
            continue;
        }
        if !is_valid_id(&id) {
            log::warn!("[model_store] 跳过非法目录名的导入模型 {id}");
            continue;
        }
        match load_imported(&entry.path(), &id) {
            Ok(model) => models.push(model),
            Err(e) => log::warn!("[model_store] 跳过无法解析的导入模型 {id}: {e}"),
        }
    }
    models.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(models)
}

/// 导入一批拖入路径（模型文件夹或 .zip）；逐路径容错，返回成功项与失败原因。
pub fn import(app: &AppHandle, paths: &[String]) -> ImportOutcome {
    let mut outcome = ImportOutcome::default();
    // 进程内串行：id 分配、旧目录替换与临时目录清理都假设没有并发导入
    // （两次快速拖放会各起一个 spawn_blocking 任务，交错 remove/rename 会互相踩）。
    let _guard = IMPORT_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = match store_root(app).and_then(|root| {
        fs::create_dir_all(&root)
            .with_context(|| format!("创建模型仓库目录失败: {}", root.display()))?;
        Ok(root)
    }) {
        Ok(root) => root,
        Err(e) => {
            log::error!("[model_store] 模型仓库不可用: {e}");
            outcome.errors.push(format!("模型仓库不可用: {e}"));
            return outcome;
        }
    };
    // 拿到锁即可安全清理上次崩溃/强杀留下的临时目录（此刻不存在在途导入）
    remove_stale_dirs(&root);
    // 同一批次内去重（不同目录下同名模型会追加 -2、-3 后缀），跨批次则按 id 覆盖旧模型
    let mut used: HashSet<String> = HashSet::new();
    for raw in paths {
        match import_one(&root, Path::new(raw), &mut used) {
            Ok(models) => {
                for model in &models {
                    log::info!(
                        "[model_store] 已导入模型 {}（{}，{} 组动作 / {} 表情）",
                        model.id,
                        model.name,
                        model.motions.len(),
                        model.expressions.len()
                    );
                }
                outcome.models.extend(models);
            }
            Err(e) => {
                let label = Path::new(raw)
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| raw.clone());
                log::warn!("[model_store] 导入 {label} 失败: {e}");
                outcome.errors.push(format!("{label}: {e}"));
            }
        }
    }
    outcome
}

// ---- 单路径导入 ----

/// 导入单个拖入路径：文件夹直接扫描，zip 先解压到临时目录再扫描。
fn import_one(root: &Path, path: &Path, used: &mut HashSet<String>) -> Result<Vec<ImportedModel>> {
    let path = path
        .canonicalize()
        .with_context(|| format!("路径不存在或不可访问: {}", path.display()))?;
    if path.is_dir() {
        return import_from_dir(root, &path, "folder", used);
    }
    if is_zip_file(&path) {
        return import_from_zip(root, &path, used);
    }
    bail!(
        "仅支持模型文件夹或 .zip 压缩包（收到 {}）",
        file_name_lossy(&path)
    );
}

/// 解压 zip 到临时目录后按文件夹流程导入；无论成败都清理临时目录。
fn import_from_zip(
    root: &Path,
    zip_path: &Path,
    used: &mut HashSet<String>,
) -> Result<Vec<ImportedModel>> {
    let tmp = temp_dir_path(root);
    let result = (|| -> Result<Vec<ImportedModel>> {
        extract_zip(zip_path, &tmp)?;
        import_from_dir(root, &tmp, "zip", used)
    })();
    remove_dir_quiet(&tmp);
    result
}

/// 扫描目录内全部 Cubism 3+ 模型并逐个落盘（同一文件夹含多个模型时全部导入）。
fn import_from_dir(
    root: &Path,
    dir: &Path,
    source: &str,
    used: &mut HashSet<String>,
) -> Result<Vec<ImportedModel>> {
    let configs = collect_model_configs(dir);
    if configs.is_empty() {
        if contains_cubism2_config(dir) {
            bail!("仅支持 Cubism 3+ 的 .model3.json，Cubism 2 模型（.model.json）不受支持");
        }
        bail!("未找到 {MODEL_CONFIG_SUFFIX} 模型配置（仅支持 Cubism 3+ 模型）");
    }

    let mut models = Vec::new();
    let mut first_error: Option<anyhow::Error> = None;
    for config in configs {
        match install_model(root, &config, source, used) {
            Ok(model) => models.push(model),
            Err(e) => {
                log::warn!("[model_store] 跳过模型配置 {}: {e}", config.display());
                if first_error.is_none() {
                    first_error =
                        Some(e.context(format!("模型配置 {} 导入失败", file_name_lossy(&config))));
                }
            }
        }
    }
    if models.is_empty() {
        return Err(first_error.unwrap_or_else(|| anyhow!("模型导入失败")));
    }
    Ok(models)
}

/// 校验并落盘单个模型：解析配置与文件校验 → 复制到临时目录 → 旧目录让位 → 新目录上位。
fn install_model(
    root: &Path,
    config_path: &Path,
    source: &str,
    used: &mut HashSet<String>,
) -> Result<ImportedModel> {
    let model_root = config_path
        .parent()
        .ok_or_else(|| anyhow!("模型配置路径异常: {}", config_path.display()))?;
    let text = fs::read_to_string(config_path)
        .with_context(|| format!("读取模型配置失败: {}", config_path.display()))?;
    let info = parse_config(&text)?;
    verify_referenced_files(model_root, &info)?;

    let model_file = file_name_lossy(config_path);
    let stem = model_stem(&model_file).unwrap_or_else(|| model_file.clone());
    // 覆盖语义只对「同名模型」成立：slug 会把中文等折叠成 `model`，不同名绝不能互相删
    let id = allocate_id(root, &stem, used);

    let tmp = temp_dir_path(root);
    let staged = (|| -> Result<()> {
        copy_tree(model_root, &tmp)?;
        write_meta(
            &tmp,
            &ModelMeta {
                name: stem.clone(),
                model_file: model_file.clone(),
                source: source.to_string(),
                imported_at: now_rfc3339(),
            },
        )?;
        Ok(())
    })();
    if let Err(e) = staged {
        remove_dir_quiet(&tmp);
        return Err(e);
    }

    let target = root.join(&id);
    // 先把旧目录挪成 `.trash-*` 而不是直接删：新目录 rename 失败时还能把旧模型挪回来
    let trash = if target.exists() {
        let trash = root.join(format!("{TRASH_PREFIX}{}", uuid::Uuid::new_v4()));
        if let Err(e) = fs::rename(&target, &trash) {
            remove_dir_quiet(&tmp);
            return Err(anyhow!("替换旧模型失败: {e}"));
        }
        log::info!("[model_store] 覆盖已导入模型 {id}");
        Some(trash)
    } else {
        None
    };
    if let Err(e) = fs::rename(&tmp, &target) {
        // 新目录没上位：回滚旧模型，保证用户手里至少还有原来那份
        if let Some(trash) = trash.as_ref() {
            if let Err(restore) = fs::rename(trash, &target) {
                log::error!("[model_store] 回滚旧模型失败: {restore}");
            }
        }
        remove_dir_quiet(&tmp);
        return Err(anyhow!("模型落盘失败: {e}"));
    }
    if let Some(trash) = trash {
        remove_dir_quiet(&trash);
    }

    Ok(ImportedModel {
        id,
        name: stem,
        model_file,
        motions: info.motions,
        expressions: info.expressions,
        textures: info.textures.len(),
        source: source.to_string(),
    })
}

/// 从仓库目录回读一个已导入模型（重启后重建列表用）。
fn load_imported(dir: &Path, id: &str) -> Result<ImportedModel> {
    let meta = read_meta(dir).unwrap_or_default();
    // 优先按落盘时记录的主配置回读（同一目录含多个 model3.json 时不会取错模型）
    let recorded = meta.model_file.clone();
    let config = if is_model_config(Path::new(&recorded)) && dir.join(&recorded).is_file() {
        dir.join(&recorded)
    } else {
        collect_model_configs(dir)
            .first()
            .cloned()
            .ok_or_else(|| anyhow!("未找到 {MODEL_CONFIG_SUFFIX}"))?
    };
    let text = fs::read_to_string(&config)?;
    let info = parse_config(&text)?;
    let model_file = file_name_lossy(&config);
    let fallback_name = model_stem(&model_file).unwrap_or_else(|| id.to_string());
    let name = if meta.name.is_empty() {
        fallback_name
    } else {
        meta.name
    };
    // source 是展示字段，只接受两个合法值（meta 被手工改坏时不把脏值传给前端）
    let source = if meta.source == "zip" {
        "zip"
    } else {
        "folder"
    };
    Ok(ImportedModel {
        id: id.to_string(),
        name,
        model_file,
        motions: info.motions,
        expressions: info.expressions,
        textures: info.textures.len(),
        source: source.to_string(),
    })
}

// ---- 配置解析与校验（纯函数，便于单测）----

/// 解析 `model3.json` 的 `FileReferences`（不校验文件是否存在，见 `verify_referenced_files`）。
fn parse_config(text: &str) -> Result<ConfigInfo> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| anyhow!("模型配置不是合法 JSON: {e}"))?;
    let refs = value
        .get("FileReferences")
        .ok_or_else(|| anyhow!("缺少 FileReferences 字段（不是 Cubism 3+ 的 .model3.json）"))?;
    let moc = refs
        .get("Moc")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("缺少 FileReferences.Moc（模型文件不完整）"))?;
    let textures: Vec<String> = refs
        .get("Textures")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    if textures.is_empty() {
        bail!("缺少 FileReferences.Textures（没有贴图无法渲染）");
    }
    let motions = refs
        .get("Motions")
        .and_then(|v| v.as_object())
        .map(|obj| obj.keys().cloned().collect())
        .unwrap_or_default();
    let expressions = refs
        .get("Expressions")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.get("Name").and_then(|v| v.as_str()).map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    // FileReferences 下的所有字符串都是文件路径（Moc / Textures / Motions[].File / …）
    let mut references = Vec::new();
    collect_references(refs, &mut references);
    Ok(ConfigInfo {
        moc,
        textures,
        motions,
        expressions,
        references,
    })
}

/// 递归收集 `FileReferences` 下的文件路径。
///
/// 注意 `Expressions[].Name`（表情展示名）等字段是**非路径字符串**，不能拿去校验文件存在性；
/// 因此只收集已知的路径键（`Moc` / `File` / `Sound` / `Physics` / `Pose` / …），
/// 以及 `Textures` 这类「数组里直接放路径」的值。
fn collect_references(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::Array(items) => {
            for item in items {
                match item {
                    serde_json::Value::String(text) => out.push(text.clone()),
                    other => collect_references(other, out),
                }
            }
        }
        serde_json::Value::Object(map) => {
            for (key, item) in map {
                match item {
                    serde_json::Value::String(text) if is_path_key(key) => out.push(text.clone()),
                    other => collect_references(other, out),
                }
            }
        }
        _ => {}
    }
}

/// `FileReferences` 下表示文件路径的键名（其余如 `Name` / `Id` 是展示字段，不是路径）。
fn is_path_key(key: &str) -> bool {
    matches!(
        key,
        "Moc"
            | "Textures"
            | "File"
            | "Sound"
            | "Physics"
            | "Pose"
            | "UserData"
            | "DisplayInfo"
            | "Audio"
            | "MotionSync"
            | "Expressions"
            | "Motions"
    )
}

/// 校验配置引用：moc / 贴图必须存在（缺了无法渲染）；其余引用（动作 / 表情 / 物理 / 姿势）
/// 路径必须合法，文件缺失只告警（部分模型会引用可选的运行时资源）。
fn verify_referenced_files(model_root: &Path, info: &ConfigInfo) -> Result<()> {
    for required in std::iter::once(&info.moc).chain(info.textures.iter()) {
        ensure_file(model_root, required)?;
    }
    for reference in &info.references {
        ensure_safe_reference(reference)?;
        if !model_root.join(reference).is_file() {
            log::warn!("[model_store] 配置引用的可选文件缺失: {reference}");
        }
    }
    Ok(())
}

/// 引用路径必须是指向模型目录内的相对路径（挡住 `..` / 盘符 / 绝对路径，防止越界或复制后 404）。
fn ensure_safe_reference(relative: &str) -> Result<()> {
    let normalized = relative.replace('\\', "/");
    let safe = !normalized.is_empty()
        && !normalized.starts_with('/')
        && !normalized.contains(':')
        && normalized
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..");
    if !safe {
        bail!("配置引用了非法路径: {relative}");
    }
    Ok(())
}

/// 单个引用文件存在性校验（相对路径，先做越界检查）。
fn ensure_file(model_root: &Path, relative: &str) -> Result<()> {
    ensure_safe_reference(relative)?;
    if model_root.join(relative).is_file() {
        Ok(())
    } else {
        bail!("配置引用的文件缺失: {relative}")
    }
}

// ---- 目录扫描 ----

/// 收集目录内的全部模型配置，按「层级浅 → 深、路径字典序」排序，保证导入顺序稳定。
fn collect_model_configs(dir: &Path) -> Vec<PathBuf> {
    let mut found: Vec<(usize, PathBuf)> = Vec::new();
    walk_configs(dir, 1, &mut found);
    found.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    found.into_iter().map(|(_, path)| path).collect()
}

/// 递归收集模型配置（跳过隐藏目录与 macOS 资源叉；读不了的目录静默跳过）。
fn walk_configs(dir: &Path, depth: usize, found: &mut Vec<(usize, PathBuf)>) {
    if depth > MAX_SCAN_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            let name = file_name_lossy(&path);
            if name.starts_with('.') || name == "__MACOSX" || name == "node_modules" {
                continue;
            }
            walk_configs(&path, depth + 1, found);
        } else if file_type.is_file() && is_model_config(&path) {
            found.push((depth, path));
        }
    }
}

/// 目录内是否存在 Cubism 2 模型配置（用于给出更准确的「不支持」提示）。
fn contains_cubism2_config(dir: &Path) -> bool {
    let mut found: Vec<(usize, PathBuf)> = Vec::new();
    walk_files(dir, 1, &mut found);
    found.iter().any(|(_, path)| is_cubism2_config(path))
}

/// 递归收集所有文件（仅用于 Cubism 2 提示，不参与导入）。
fn walk_files(dir: &Path, depth: usize, found: &mut Vec<(usize, PathBuf)>) {
    if depth > MAX_SCAN_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            let name = file_name_lossy(&path);
            if name.starts_with('.') || name == "__MACOSX" {
                continue;
            }
            walk_files(&path, depth + 1, found);
        } else if file_type.is_file() {
            found.push((depth, path));
        }
    }
}

/// 是否为 Cubism 3+ 模型配置（`*.model3.json`，大小写不敏感）。
fn is_model_config(path: &Path) -> bool {
    file_name_lossy(path)
        .to_ascii_lowercase()
        .ends_with(MODEL_CONFIG_SUFFIX)
}

/// 是否为 Cubism 2 模型配置（`*.model.json`，大小写不敏感）。
fn is_cubism2_config(path: &Path) -> bool {
    let lower = file_name_lossy(path).to_ascii_lowercase();
    lower.ends_with(CUBISM2_CONFIG_SUFFIX) && !lower.ends_with(MODEL_CONFIG_SUFFIX)
}

// ---- zip 解压 ----

/// 是否为 zip 文件（按扩展名判断，避免依赖文件头嗅探）。
fn is_zip_file(path: &Path) -> bool {
    file_name_lossy(path).to_ascii_lowercase().ends_with(".zip")
}

/// 解压 zip 到目标目录：拒绝路径穿越 / 绝对路径 / 资源叉，限制条目数与总字节数。
fn extract_zip(zip_path: &Path, dest: &Path) -> Result<()> {
    let file = fs::File::open(zip_path)
        .with_context(|| format!("打开压缩包失败: {}", zip_path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| anyhow!("无法解析 zip 压缩包（可能已损坏或不是 zip）: {e}"))?;
    fs::create_dir_all(dest)?;
    let mut total_bytes: u64 = 0;
    let mut extracted = 0usize;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| anyhow!("读取压缩包条目失败（第 {} 项）: {e}", index + 1))?;
        // enclosed_name 已剔除绝对路径与 `..`；返回 None 的条目直接跳过
        let Some(relative) = entry.enclosed_name() else {
            log::warn!("[model_store] 跳过可疑压缩包条目（路径越界）");
            continue;
        };
        if is_junk_entry(&relative) {
            continue;
        }
        extracted += 1;
        if extracted > MAX_ZIP_ENTRIES {
            bail!("压缩包文件数超过 {MAX_ZIP_ENTRIES}，已中止");
        }
        let out = dest.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent)?;
        }
        // 声明的 size 只做快速预检；真正的上限按「实际写出的字节数」累计——
        // zip 4.x 的读取端不按 uncompressed_size 截断，声明 1KB 实际吐几十 GB 的条目
        // 会一直写到磁盘满才报错，因此必须边写边计数。
        total_bytes = total_bytes.saturating_add(entry.size());
        if total_bytes > MAX_ZIP_BYTES {
            bail!(
                "压缩包解压后超过 {} MB，已中止",
                MAX_ZIP_BYTES / (1024 * 1024)
            );
        }
        let mut writer = fs::File::create(&out)
            .with_context(|| format!("写入解压文件失败: {}", out.display()))?;
        let written = copy_limited(&mut entry, &mut writer, &mut total_bytes, MAX_ZIP_BYTES)?;
        log::debug!(
            "[model_store] 解压 {}（{} 字节）",
            relative.display(),
            written
        );
    }
    log::info!(
        "[model_store] 已解压 {} 个文件（{}）",
        extracted,
        file_name_lossy(zip_path)
    );
    Ok(())
}

/// 边读边写并累计**实际**字节数：超过 `limit` 立刻中止（防「声明大小撒谎」的解压炸弹）。
fn copy_limited<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    total: &mut u64,
    limit: u64,
) -> Result<u64> {
    let mut buffer = [0u8; 64 * 1024];
    let mut written: u64 = 0;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        *total = total.saturating_add(read as u64);
        if *total > limit {
            bail!("压缩包解压后超过 {} MB，已中止", limit / (1024 * 1024));
        }
        let chunk = buffer
            .get(..read)
            .ok_or_else(|| anyhow!("读取压缩包数据越界"))?;
        writer.write_all(chunk)?;
        written = written.saturating_add(read as u64);
    }
    Ok(written)
}

/// 压缩包里应跳过的条目（macOS 资源叉与系统垃圾文件）。
fn is_junk_entry(relative: &Path) -> bool {
    let Some(first) = relative.components().next() else {
        return true;
    };
    if first.as_os_str().to_string_lossy() == "__MACOSX" {
        return true;
    }
    let name = file_name_lossy(relative);
    name == ".DS_Store" || name == "Thumbs.db" || name.starts_with("._")
}

// ---- 文件复制与命名 ----

/// 递归复制目录树（保留相对结构；符号链接 / junction 跳过并告警，限深防环）。
fn copy_tree(src: &Path, dst: &Path) -> Result<()> {
    copy_tree_inner(src, dst, 1)
}

/// `copy_tree` 的递归实现（`depth` 从 1 起，超过 `MAX_COPY_DEPTH` 停止向下复制）。
fn copy_tree_inner(src: &Path, dst: &Path, depth: usize) -> Result<()> {
    fs::create_dir_all(dst)?;
    let entries = fs::read_dir(src).with_context(|| format!("读取目录失败: {}", src.display()))?;
    for entry in entries.flatten() {
        // 单个条目读属性失败只跳过，不让整份模型复制失败
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let from = entry.path();
        // 符号链接 / Windows junction / 重解析点一律跳过：跟随可能成环或复制出仓库外的巨量数据
        if is_link_like(&from) {
            log::warn!("[model_store] 跳过链接/重解析点: {}", from.display());
            continue;
        }
        let to = dst.join(entry.file_name());
        if file_type.is_dir() {
            if depth >= MAX_COPY_DEPTH {
                log::warn!("[model_store] 目录层级过深，跳过: {}", from.display());
                continue;
            }
            copy_tree_inner(&from, &to, depth + 1)?;
        } else if file_type.is_file() {
            fs::copy(&from, &to).with_context(|| format!("复制文件失败: {}", from.display()))?;
        } else {
            log::warn!("[model_store] 跳过不支持的条目: {}", from.display());
        }
    }
    Ok(())
}

/// 是否为符号链接 / Windows 目录联接（junction）等重解析点。
#[cfg(windows)]
fn is_link_like(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    /// `FILE_ATTRIBUTE_REPARSE_POINT`
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    fs::symlink_metadata(path)
        .map(|meta| meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
        .unwrap_or(false)
}

/// 是否为符号链接（类 Unix 平台）。
#[cfg(not(windows))]
fn is_link_like(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
}

/// 分配仓库内的唯一 id：`imported-<slug>`；同批次或仓库里已有**不同名**模型的 id 追加 `-2`、`-3`。
///
/// slug 会把非 ASCII 名称折叠成 `model`（`我的模型` / `模型A` 都变成 `imported-model`），
/// 所以必须比对旧目录里记录的展示名：只有同名模型才允许覆盖，不同名让位到下一个后缀。
fn allocate_id(root: &Path, name: &str, used: &mut HashSet<String>) -> String {
    let base = format!("{IMPORTED_ID_PREFIX}{}", slug(name));
    let mut candidate = base.clone();
    let mut suffix = 1u32;
    loop {
        let conflict_in_batch = used.contains(&candidate);
        let disk_meta = read_meta(&root.join(&candidate));
        let conflict_on_disk = disk_meta
            .map(|meta| !meta.name.is_empty() && meta.name != name)
            .unwrap_or(false);
        if !conflict_in_batch && !conflict_on_disk {
            break;
        }
        suffix += 1;
        candidate = format!("{base}-{suffix}");
    }
    used.insert(candidate.clone());
    candidate
}

/// 生成 URL 安全的 id 片段：仅保留 ASCII 字母数字与 `-_.`，其它字符折成 `-`。
fn slug(raw: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if ch == '-' || ch == '_' || ch == '.' {
            if !out.is_empty() {
                out.push(ch);
            }
        } else if !out.is_empty() && !last_dash {
            out.push('-');
            last_dash = true;
        }
        if out.len() >= 48 {
            break;
        }
    }
    let trimmed = out
        .trim_matches(|c: char| c == '-' || c == '_' || c == '.')
        .to_string();
    if trimmed.is_empty() {
        "model".to_string()
    } else {
        trimmed
    }
}

/// 从模型配置文件名取展示名（去掉 `.model3.json`，大小写不敏感）。
fn model_stem(file_name: &str) -> Option<String> {
    let lower = file_name.to_ascii_lowercase();
    let index = lower.rfind(MODEL_CONFIG_SUFFIX)?;
    if index == 0 {
        return None;
    }
    file_name.get(..index).map(str::to_owned)
}

/// 取文件名（非 UTF-8 情况用替换字符兜底，不 panic）。
fn file_name_lossy(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// 仓库内的临时目录路径（`.` 前缀保证不会被 `list()` 当成模型展示）。
fn temp_dir_path(root: &Path) -> PathBuf {
    root.join(format!("{TMP_PREFIX}{}", uuid::Uuid::new_v4()))
}

/// 清理上次崩溃 / 强杀留下的 `.tmp-*`、`.trash-*` 目录。
///
/// 调用方必须持有 `IMPORT_LOCK`：只有「没有在途导入」时这些目录才确定是垃圾。
fn remove_stale_dirs(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = file_name_lossy(&entry.path());
        if name.starts_with(TMP_PREFIX) || name.starts_with(TRASH_PREFIX) {
            log::info!("[model_store] 清理残留临时目录 {name}");
            remove_dir_quiet(&entry.path());
        }
    }
}

/// 尽力删除目录（失败仅告警，不影响主流程）。
fn remove_dir_quiet(dir: &Path) {
    if let Err(e) = fs::remove_dir_all(dir) {
        if dir.exists() {
            log::warn!("[model_store] 清理临时目录失败 {}: {e}", dir.display());
        }
    }
}

/// 当前 UTC 时间的 RFC 3339 文本（元数据排查用；格式化失败时返回空串）。
fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

/// 写入模型元数据。
fn write_meta(dir: &Path, meta: &ModelMeta) -> Result<()> {
    let text = serde_json::to_string_pretty(meta)?;
    fs::write(dir.join(META_FILE), text).with_context(|| "写入模型元数据失败")?;
    Ok(())
}

/// 读取模型元数据（缺失或损坏时返回 None，由调用方回退默认值）。
fn read_meta(dir: &Path) -> Option<ModelMeta> {
    let text = fs::read_to_string(dir.join(META_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

// ---- 只读 URI 协议服务 ----

/// 自定义协议处理器：把 `mascot-model://<id>/<相对路径>` 映射到仓库内文件并读回。
///
/// 跨源说明：页面源是 `http://tauri.localhost`（生产）或 Vite 开发服务器，
/// 与协议源 `http://mascot-model.localhost` 不同源，故必须回写
/// `Access-Control-Allow-Origin: *`（Live2D 的 XHR/贴图请求都走 CORS）。
pub fn respond(app: &AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    match serve_file(app, request) {
        Ok(response) => response,
        Err(e) => {
            log::warn!("[model_store] 资源请求失败 {}: {e}", request.uri().path());
            plain_response(StatusCode::NOT_FOUND, "模型资源不存在")
        }
    }
}

/// 解析请求路径并读回文件（失败向上抛，由 `respond` 统一转成 404）。
fn serve_file(app: &AppHandle, request: &Request<Vec<u8>>) -> Result<Response<Vec<u8>>> {
    let decoded = percent_encoding::percent_decode_str(request.uri().path())
        .decode_utf8()
        .map_err(|_| anyhow!("请求路径不是合法 UTF-8"))?;
    let trimmed = decoded.trim_start_matches('/');
    let mut parts = trimmed.splitn(2, '/');
    let id = parts.next().unwrap_or_default();
    let relative = parts.next().unwrap_or_default();
    if !is_valid_id(id) {
        bail!("非法的模型 id");
    }
    let relative = relative.replace('\\', "/");
    if relative.is_empty()
        || relative.split('/').any(|segment| {
            segment.is_empty() || segment == "." || segment == ".." || segment.contains(':')
        })
    {
        bail!("非法的资源路径");
    }

    let base = store_root(app)?.join(id);
    let file = base.join(&relative);
    let canonical = file
        .canonicalize()
        .with_context(|| format!("资源不存在: {}", file.display()))?;
    // 二次防线：规范化后必须仍位于该模型目录内（防符号链接/相对路径逃逸）
    let base_canonical = base
        .canonicalize()
        .with_context(|| "模型目录不存在或已被删除")?;
    if !canonical.starts_with(&base_canonical) {
        bail!("资源路径越界");
    }
    let bytes =
        fs::read(&canonical).with_context(|| format!("读取资源失败: {}", canonical.display()))?;
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type(&canonical))
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(bytes)
        .map_err(|e| anyhow!("构造资源响应失败: {e}"))
}

/// 模型 id 白名单（同时挡住路径穿越：id 不允许 `/`、`\`、`:`，也不允许 `.` / `..`）。
fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id != "."
        && id != ".."
        && id.len() <= 80
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// 按扩展名给出 Content-Type（JSON 配置必须走 JSON 类型，否则模型加载器解析失败）。
fn content_type(path: &Path) -> &'static str {
    let name = file_name_lossy(path).to_ascii_lowercase();
    if name.ends_with(".json") {
        "application/json; charset=utf-8"
    } else if name.ends_with(".moc3") {
        "application/octet-stream"
    } else if name.ends_with(".png") {
        "image/png"
    } else if name.ends_with(".jpg") || name.ends_with(".jpeg") {
        "image/jpeg"
    } else if name.ends_with(".webp") {
        "image/webp"
    } else if name.ends_with(".wav") {
        "audio/wav"
    } else if name.ends_with(".mp3") {
        "audio/mpeg"
    } else if name.ends_with(".ogg") {
        "audio/ogg"
    } else if name.ends_with(".m4a") {
        "audio/mp4"
    } else {
        "application/octet-stream"
    }
}

/// 构造纯文本响应（错误兜底；保留 CORS 头，避免前端看到误导性的跨源错误）。
fn plain_response(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(message.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(message.as_bytes().to_vec()))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic, clippy::indexing_slicing)] // 测试代码：断言失败即用例失败，属受控例外
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn slug_keeps_ascii_and_folds_other_chars() {
        assert_eq!(slug("Haru"), "haru");
        assert_eq!(slug("Haru 2"), "haru-2");
        assert_eq!(slug("我的模型"), "model");
        assert_eq!(slug("--"), "model");
        assert_eq!(slug("a.b_c-d"), "a.b_c-d");
    }

    #[test]
    fn model_stem_strips_suffix_case_insensitively() {
        assert_eq!(model_stem("Haru.model3.json").as_deref(), Some("Haru"));
        assert_eq!(model_stem("HARU.MODEL3.JSON").as_deref(), Some("HARU"));
        assert_eq!(model_stem("Haru.model.json"), None);
        assert_eq!(model_stem(".model3.json"), None);
    }

    #[test]
    fn parse_config_reads_file_references() {
        let json = r#"{
            "Version": 3,
            "FileReferences": {
                "Moc": "Haru.moc3",
                "Textures": ["Haru.2048/texture_00.png"],
                "Motions": { "Idle": [], "TapBody": [] },
                "Expressions": [
                    { "Name": "F01", "File": "expressions/F01.exp3.json" }
                ]
            }
        }"#;
        let info = parse_config(json).unwrap();
        assert_eq!(info.moc, "Haru.moc3");
        assert_eq!(info.textures.len(), 1);
        assert_eq!(
            info.motions,
            vec!["Idle".to_string(), "TapBody".to_string()]
        );
        assert_eq!(info.expressions, vec!["F01".to_string()]);
        // 动作 / 表情引用的文件也要进 references，供落盘前统一做路径合法性校验
        assert!(info.references.iter().any(|r| r == "Haru.moc3"));
        assert!(info
            .references
            .iter()
            .any(|r| r == "expressions/F01.exp3.json"));
    }

    #[test]
    fn reference_paths_must_stay_inside_model_dir() {
        assert!(ensure_safe_reference("Haru.moc3").is_ok());
        assert!(ensure_safe_reference("textures/tex.png").is_ok());
        assert!(ensure_safe_reference("../secret.moc3").is_err());
        assert!(ensure_safe_reference("textures/../../x.png").is_err());
        assert!(ensure_safe_reference("/etc/passwd").is_err());
        assert!(ensure_safe_reference("C:/x.png").is_err());
        assert!(ensure_safe_reference("a//b.png").is_err());
        assert!(ensure_safe_reference("").is_err());
    }

    #[test]
    fn copy_limited_counts_actual_bytes() {
        let mut reader = Cursor::new(vec![7u8; 32]);
        let mut out: Vec<u8> = Vec::new();
        let mut total = 0u64;
        assert!(copy_limited(&mut reader, &mut out, &mut total, 16).is_err());
        assert_eq!(total, 32);

        let mut ok_reader = Cursor::new(vec![7u8; 8]);
        let mut ok_out: Vec<u8> = Vec::new();
        let mut ok_total = 0u64;
        assert_eq!(
            copy_limited(&mut ok_reader, &mut ok_out, &mut ok_total, 1024).unwrap(),
            8
        );
        assert_eq!(ok_out.len(), 8);
    }

    #[test]
    fn parse_config_rejects_incomplete_configs() {
        assert!(parse_config("not json").is_err());
        assert!(parse_config("{}").is_err());
        assert!(parse_config(r#"{"FileReferences": {}}"#).is_err());
        assert!(parse_config(r#"{"FileReferences": {"Moc": "a.moc3"}}"#).is_err());
        assert!(parse_config(r#"{"FileReferences": {"Moc": "a.moc3", "Textures": []}}"#).is_err());
    }

    #[test]
    fn config_suffix_detection() {
        assert!(is_model_config(Path::new("A/Haru.model3.json")));
        assert!(is_model_config(Path::new("A/HARU.MODEL3.JSON")));
        assert!(!is_model_config(Path::new("A/Haru.model.json")));
        assert!(is_cubism2_config(Path::new("A/Haru.model.json")));
        assert!(!is_cubism2_config(Path::new("A/Haru.model3.json")));
    }

    #[test]
    fn content_type_covers_live2d_assets() {
        assert!(content_type(Path::new("a/model3.json")).starts_with("application/json"));
        assert_eq!(
            content_type(Path::new("a/b.moc3")),
            "application/octet-stream"
        );
        assert_eq!(content_type(Path::new("a/b.PNG")), "image/png");
        assert_eq!(
            content_type(Path::new("a/b.moc3.bin")),
            "application/octet-stream"
        );
    }

    #[test]
    fn id_validation_rejects_traversal() {
        assert!(is_valid_id("imported-haru"));
        assert!(is_valid_id("imported-haru-2"));
        assert!(!is_valid_id(""));
        assert!(!is_valid_id("."));
        assert!(!is_valid_id(".."));
        assert!(!is_valid_id("../models"));
        assert!(!is_valid_id("a/b"));
        assert!(!is_valid_id("a\\b"));
        assert!(!is_valid_id("C:"));
    }

    /// 中文名折叠成同一 slug 时不能互相覆盖：不同名模型必须各占一个 id。
    #[test]
    fn models_with_colliding_slugs_get_distinct_ids() {
        let base =
            std::env::temp_dir().join(format!("kanbanniang-model-test-{}", uuid::Uuid::new_v4()));
        let store = base.join("store");
        fs::create_dir_all(&store).unwrap();
        for (name, texture) in [("模型甲", "a.png"), ("模型乙", "b.png")] {
            let source = base.join(name);
            fs::create_dir_all(&source).unwrap();
            fs::write(source.join(format!("{name}.moc3")), b"MOC3").unwrap();
            fs::write(source.join(texture), b"PNG").unwrap();
            fs::write(
                source.join(format!("{name}.model3.json")),
                format!(r#"{{"FileReferences":{{"Moc":"{name}.moc3","Textures":["{texture}"]}}}}"#),
            )
            .unwrap();
            import_from_dir(&store, &source, "folder", &mut HashSet::new()).unwrap();
        }
        let mut ids: Vec<String> = fs::read_dir(&store)
            .unwrap()
            .flatten()
            .map(|entry| file_name_lossy(&entry.path()))
            .filter(|name| !name.starts_with('.'))
            .collect();
        ids.sort();
        assert_eq!(
            ids,
            vec!["imported-model".to_string(), "imported-model-2".to_string()]
        );
        // 两份模型文件都还在（第二次导入没有把第一次的目录删掉）
        assert!(store.join("imported-model").join("模型甲.moc3").is_file());
        assert!(store.join("imported-model-2").join("模型乙.moc3").is_file());
        fs::remove_dir_all(&base).ok();
    }

    /// 同一目录含多个配置时，回读按元数据记录的主配置，而不是字典序第一个。
    #[test]
    fn load_imported_prefers_recorded_model_file() {
        let base =
            std::env::temp_dir().join(format!("kanbanniang-model-test-{}", uuid::Uuid::new_v4()));
        let store = base.join("store");
        let source = base.join("source");
        fs::create_dir_all(&store).unwrap();
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("A.moc3"), b"MOC3").unwrap();
        fs::write(source.join("tex.png"), b"PNG").unwrap();
        for name in ["A", "B"] {
            fs::write(
                source.join(format!("{name}.model3.json")),
                r#"{"FileReferences":{"Moc":"A.moc3","Textures":["tex.png"]}}"#,
            )
            .unwrap();
        }
        let models = import_from_dir(&store, &source, "folder", &mut HashSet::new()).unwrap();
        assert_eq!(models.len(), 2);
        for model in &models {
            let read_back = load_imported(&store.join(&model.id), &model.id).unwrap();
            assert_eq!(read_back.model_file, model.model_file);
            assert_eq!(read_back.name, model.name);
        }
        fs::remove_dir_all(&base).ok();
    }

    /// 端到端（不涉及 Tauri）：在临时目录准备一个合规模型，导入到临时仓库并回读。
    #[test]
    fn install_and_list_model_round_trip() {
        let base =
            std::env::temp_dir().join(format!("kanbanniang-model-test-{}", uuid::Uuid::new_v4()));
        let source = base.join("source");
        let store = base.join("store");
        fs::create_dir_all(&store).unwrap();
        fs::create_dir_all(source.join("textures")).unwrap();
        fs::write(source.join("Demo.moc3"), b"MOC3").unwrap();
        fs::write(source.join("textures").join("tex.png"), b"PNG").unwrap();
        fs::write(
            source.join("Demo.model3.json"),
            r#"{"Version":3,"FileReferences":{"Moc":"Demo.moc3","Textures":["textures/tex.png"],"Motions":{"Idle":[]},"Expressions":[{"Name":"Smile"}]}}"#,
        )
        .unwrap();

        let mut used = HashSet::new();
        let models = import_from_dir(&store, &source, "folder", &mut used).unwrap();
        assert_eq!(models.len(), 1);
        let model = &models[0];
        assert_eq!(model.id, "imported-demo");
        assert_eq!(model.name, "Demo");
        assert_eq!(model.model_file, "Demo.model3.json");
        assert_eq!(model.textures, 1);
        assert_eq!(model.motions, vec!["Idle".to_string()]);
        assert_eq!(model.expressions, vec!["Smile".to_string()]);
        assert!(store.join("imported-demo").join("Demo.moc3").is_file());
        assert!(store.join("imported-demo").join(META_FILE).is_file());

        let listed = load_imported(&store.join("imported-demo"), "imported-demo").unwrap();
        assert_eq!(listed.name, "Demo");
        assert_eq!(listed.source, "folder");

        // 重复导入同一模型：覆盖而不是追加
        let again = import_from_dir(&store, &source, "folder", &mut HashSet::new()).unwrap();
        assert_eq!(again.len(), 1);
        assert_eq!(again[0].id, "imported-demo");
        let entries: Vec<_> = fs::read_dir(&store).unwrap().flatten().collect();
        assert_eq!(entries.len(), 1);

        // 缺贴图的模型必须被拒绝
        let broken = base.join("broken");
        fs::create_dir_all(&broken).unwrap();
        fs::write(
            broken.join("Broken.model3.json"),
            r#"{"FileReferences":{"Moc":"Missing.moc3","Textures":["Missing.png"]}}"#,
        )
        .unwrap();
        assert!(import_from_dir(&store, &broken, "folder", &mut HashSet::new()).is_err());

        fs::remove_dir_all(&base).ok();
    }
}
