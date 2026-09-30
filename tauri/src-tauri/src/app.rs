// Codex SwitchGate — Tauri 外壳
//
// 设计要点（与 Electron 外壳的关键差异）：
//
// 1. **不再自带 Node 运行时**。Electron 外壳是拿 `electron.exe` + `ELECTRON_RUN_AS_NODE=1`
//    当 Node 跑 `server.js`，代价是包里背着一整个 Chromium（约 140MB）。
//    Tauri 外壳改成探测宿主机的 Node，WebView 用系统 WebView2，内存量级完全不同。
//
// 2. **不碰原生模块**。`lib/server/codex-session-sync/sqlite.ts` 优先用 Node 内置的
//    `node:sqlite`（Node >= 22.5 可用），`better-sqlite3` 只是 Node 20 的兜底。
//    所以只要宿主 Node >= 22.5，就完全不需要 node-gyp / VS Build Tools。
//    这是"用通用 Node"能成立的根本原因。
//
// 3. 服务进程是 `node server.js`，cwd 指向解包出来的 server 目录，
//    通过 NODE_PATH 暴露 vendor（.pnpm 扁平化后的依赖树）。

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, RunEvent, State};
use tauri_plugin_opener::OpenerExt;

/// `node:sqlite` 自 Node 22.5 起可用；低于这个版本会回退到 better-sqlite3，
/// 而那份 .node 是按 Electron ABI 编的，在真 Node 上加载不了。所以这是硬门槛。
const MIN_NODE_MAJOR: u32 = 22;
const MIN_NODE_MINOR: u32 = 5;

const DEFAULT_HOST: &str = "127.0.0.1";
const DEFAULT_PORT: u16 = 8787;

// ---------------------------------------------------------------- 运行时状态

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeProbe {
    /// 探测到的 node 可执行文件绝对路径
    pub path: String,
    /// 形如 "22.22.2"
    pub version: String,
    pub major: u32,
    pub minor: u32,
    /// 是否满足 >= 22.5（node:sqlite 门槛）
    pub supported: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    /// starting | running | failed | stopped
    pub state: String,
    pub message: String,
    pub endpoint: String,
    pub owned: bool,
}

#[derive(Debug, Deserialize)]
pub struct StartOptions {
    pub host: Option<String>,
    pub port: Option<u16>,
    /// 数据目录；不传则用 %APPDATA%/codex-api-hot-switch/data
    pub data_dir: Option<String>,
}

pub struct ServerRuntime {
    child: Mutex<Option<Child>>,
    status: Mutex<ServerStatus>,
    node: Mutex<Option<NodeProbe>>,
}

impl Default for ServerRuntime {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            status: Mutex::new(ServerStatus {
                state: "starting".into(),
                message: "尚未启动".into(),
                endpoint: format!("http://{DEFAULT_HOST}:{DEFAULT_PORT}"),
                owned: false,
            }),
            node: Mutex::new(None),
        }
    }
}

// ---------------------------------------------------------------- 路径解析

/// 开发态：仓库根目录。发布态：随包资源目录下的 `server/`。
///
/// 关于发布态的路径：`bundle.resources` 配的是 `resources/server/**/*`，
/// Tauri 打包时会把这条相对路径**原样保留**到安装目录下，于是最终落在
///   <install>\resources\server\server.js
/// 但 `resource_dir()` 在 Windows NSIS（currentUser 模式）下返回的是**安装根目录**
/// <install>，不是 <install>\resources。所以必须自己补上 `resources` 这一层。
///
/// 实测踩过：只 join("server") 会得到 `<install>\server`，直接报
/// “找不到 server.js：\\?\C:\Users\...\AppData\Local\Codex SwitchGate\server”。
/// 这里把两种布局都试一遍，免得以后调整 resources 前缀时又炸。
fn server_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        // 开发时直接指向仓库里已构建好的 standalone，省去每次拷贝
        let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join(".next")
            .join("standalone");
        if dev.join("server.js").exists() {
            return Ok(dev);
        }
    }

    let res = app
        .path()
        .resource_dir()
        .map_err(|e| format!("无法定位资源目录：{e}"))?;

    // 候选顺序：<res>/resources/server（当前打包布局）、<res>/server（旧布局）
    let candidates = [res.join("resources").join("server"), res.join("server")];

    for candidate in &candidates {
        if candidate.join("server.js").exists() {
            // 关键：剥掉 `\\?\` 前缀再交出去。
            // 后续要把它拼进 node 的入口参数 / current_dir / NODE_PATH，
            // 带前缀会让 node 把路径解析成 `C:` 并抛 EISDIR（见函数注释）。
            return Ok(strip_windows_long_prefix(candidate.clone()));
        }
    }

    Err(format!(
        "找不到 server.js，已尝试：\n  {}\n  {}\n请确认安装包完整（resources/server 应存在）。",
        candidates[0].display(),
        candidates[1].display()
    ))
}

/// 去掉 Windows 的 `\\?\` 长路径前缀。
///
/// **这是个真踩过的坑**：Tauri 的 `resource_dir()` 在 Windows 上返回的是
/// `\\?\C:\Users\...\Codex Switch Gate` 这种带扩展前缀的形式。这个前缀对 Win32 API
/// 本身没问题（它就是为了绕开 260 字符限制而设计的），但**不能原样交给 Node**：
/// Node 在校验入口路径时（`resolveMainPath` → `toRealPath` → `realpathSync`）
/// 会把它解析成 `C:`，然后在一级盘符上做 `lstat`，直接抛
/// `EISDIR: illegal operation on a directory, lstat 'C:'`，进程秒退，
/// 表现为引导页「正在启动…」转 30 秒后超时。
///
/// 所以凡是准备传给子进程（node 的入口参数、`NODE_PATH`、`current_dir`）的路径，
/// 都要先过这一道。
fn strip_windows_long_prefix(p: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        use std::path::PathBuf as Pb;
        let s = p.to_string_lossy();
        // `\\?\C:\x` -> `C:\x`
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            // 注意：`\\?\UNC\server\share` 是另一回事，这里不处理（本应用用不到网络路径）
            if !rest.starts_with("UNC\\") && !rest.starts_with("unc\\") {
                return Pb::from(rest);
            }
        }
        p
    }
    #[cfg(not(windows))]
    {
        p
    }
}

fn default_data_dir() -> PathBuf {
    if let Ok(explicit) = std::env::var("CODEX_HOT_SWITCH_DATA_DIR") {
        if !explicit.trim().is_empty() {
            return PathBuf::from(explicit);
        }
    }
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    // 同样剥前缀：这个路径会以 CODEX_HOT_SWITCH_DATA_DIR 传给 node 子进程。
    strip_windows_long_prefix(base.join("codex-api-hot-switch").join("data"))
}

// ---------------------------------------------------------------- Node 探测

/// 在 Windows 上直接 `Command::new("node")` 有时找不到（PATH 里是 node.exe 的 shim），
/// 所以先试裸名，再逐个试常见安装位置。全平台都保留裸名兜底。
fn candidate_node_paths() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        candidates.push(PathBuf::from("node.exe"));
        if let Ok(pf) = std::env::var("ProgramFiles") {
            candidates.push(PathBuf::from(&pf).join("nodejs").join("node.exe"));
        }
        if let Ok(pf86) = std::env::var("ProgramFiles(x86)") {
            candidates.push(PathBuf::from(&pf86).join("nodejs").join("node.exe"));
        }
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            candidates.push(
                PathBuf::from(&local)
                    .join("Programs")
                    .join("nodejs")
                    .join("node.exe"),
            );
            // nvm-windows / fnm / volta 的常见落点
            candidates.push(PathBuf::from(&local).join("fnm_multishells").join("node.exe"));
            candidates.push(PathBuf::from(&local).join("Volta").join("bin").join("node.exe"));
        }
        if let Ok(appdata) = std::env::var("APPDATA") {
            candidates.push(PathBuf::from(&appdata).join("nvm").join("node.exe"));
        }
    } else {
        candidates.push(PathBuf::from("node"));
        candidates.push(PathBuf::from("/usr/local/bin/node"));
        candidates.push(PathBuf::from("/usr/bin/node"));
        candidates.push(PathBuf::from("/opt/homebrew/bin/node"));
    }
    candidates
}

/// 跑一次 `<node> -e "console.log(process.versions.node)"` 拿版本。
/// 返回 (可执行路径, 版本字符串)。
///
/// 带超时：候选路径里可能有挂在网络盘 / 已损坏的 node.exe，
/// 无超时的 `output()` 会让整个探测永久卡住，界面就一直停在「正在检测」。
fn probe_node_version(exe: &Path) -> Option<(PathBuf, String)> {
    let mut child = Command::new(exe)
        .arg("-e")
        .arg("process.stdout.write(process.versions.node)")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    // 轮询等待，最多 4 秒
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                break;
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    }

    let mut buf = String::new();
    use std::io::Read;
    child.stdout.as_mut()?.read_to_string(&mut buf).ok()?;
    let version = buf.trim().to_string();
    if version.is_empty() {
        return None;
    }
    Some((exe.to_path_buf(), version))
}

/// 解析 "22.22.2" / "24.16.0-nightly" 这类版本串。
fn parse_version(version: &str) -> Option<(u32, u32)> {
    let cleaned = version.trim_start_matches('v');
    let mut parts = cleaned.split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    // minor 可能带着 -nightly 之类的后缀
    let minor_raw = parts.next().unwrap_or("0");
    let minor: u32 = minor_raw
        .split(|c: char| !c.is_ascii_digit())
        .next()?
        .parse()
        .unwrap_or(0);
    Some((major, minor))
}

#[tauri::command]
fn probe_node() -> Result<NodeProbe, String> {
    for candidate in candidate_node_paths() {
        if let Some((path, version)) = probe_node_version(&candidate) {
            let (major, minor) =
                parse_version(&version).ok_or_else(|| format!("无法解析 Node 版本：{version}"))?;
            let supported = major > MIN_NODE_MAJOR || (major == MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
            return Ok(NodeProbe {
                path: path.to_string_lossy().to_string(),
                version,
                major,
                minor,
                supported,
            });
        }
    }
    Err("未在系统里找到可用的 Node，请先安装 Node 22.5 或更高版本".into())
}

// ---------------------------------------------------------------- 服务生命周期

fn health_ok(endpoint: &str) -> bool {
    // 用 shell 插件的侧车请求不方便，这里直接用 std TcpStream 做最轻量的探活，
    // 真正的健康判定交给前端 fetch /api/console。
    use std::net::TcpStream;
    use std::time::Duration;
    let addr = endpoint.trim_start_matches("http://");
    let addr = if addr.starts_with("0.0.0.0") {
        addr.replacen("0.0.0.0", "127.0.0.1", 1)
    } else {
        addr.to_string()
    };
    TcpStream::connect_timeout(
        &addr.parse().unwrap_or_else(|_| "127.0.0.1:1".parse().unwrap()),
        Duration::from_millis(600),
    )
    .is_ok()
}

/// 把 vendor 拼进 NODE_PATH。
///
/// 注意：这里**不再**扫 `.pnpm/*/node_modules`。打包脚本已经删掉整个 .pnpm 链接农场
/// （原因见 scripts/prepare-tauri-build.cjs 的 prunePnpmStore：pnpm 的目录名把 peer
/// 依赖校验和嵌进去了，实测有 146 个条目的绝对路径超过 Windows 260 字符上限，
/// NSIS 打包会整体中止；而实测删掉它之后服务与 16 个 API 路由全部正常）。
/// 现在 vendor 下只有 `tsx`（企业微信启动器的 --import loader），一个目录足够。
fn build_node_path(server_root: &Path) -> String {
    let vendor = server_root.join("vendor");
    let mut entries: Vec<String> = vec![vendor.to_string_lossy().to_string()];
    // 兼容旧布局：万一以后又把 .pnpm 放回来，这段会自动带上
    let pnpm = vendor.join(".pnpm");
    if let Ok(read) = std::fs::read_dir(&pnpm) {
        for entry in read.flatten() {
            let candidate = entry.path().join("node_modules");
            if candidate.exists() {
                entries.push(candidate.to_string_lossy().to_string());
            }
        }
    }
    std::env::join_paths(entries.iter().map(Path::new))
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| vendor.to_string_lossy().to_string())
}

#[tauri::command]
fn start_server(
    app: tauri::AppHandle,
    state: State<'_, ServerRuntime>,
    options: StartOptions,
) -> Result<ServerStatus, String> {
    // 已在跑就直接返回
    {
        let mut guard = state.child.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            if child.try_wait().ok().flatten().is_none() {
                return Ok(state.status.lock().unwrap().clone());
            }
            *guard = None;
        }
    }

    let node = {
        let cached = state.node.lock().unwrap().clone();
        match cached {
            Some(probe) if probe.supported => probe,
            _ => {
                let probe = probe_node()?;
                if !probe.supported {
                    return Err(format!(
                        "Node 版本过低：{}。需要 {MIN_NODE_MAJOR}.{MIN_NODE_MINOR} 或更高（node:sqlite 依赖）。",
                        probe.version
                    ));
                }
                *state.node.lock().unwrap() = Some(probe.clone());
                probe
            }
        }
    };

    let host = options.host.unwrap_or_else(|| DEFAULT_HOST.to_string());
    let port = options.port.unwrap_or(DEFAULT_PORT);
    let endpoint = format!("http://{host}:{port}");

    // 端口已经被别的实例占了 —— 直接复用，不重复拉起
    if health_ok(&endpoint) {
        let status = ServerStatus {
            state: "running".into(),
            message: format!("已连接正在运行的中转服务：{host}:{port}"),
            endpoint,
            owned: false,
        };
        *state.status.lock().unwrap() = status.clone();
        return Ok(status);
    }

    let root = server_root(&app)?;
    let server_js = root.join("server.js");
    let data_dir = options
        .data_dir
        .map(PathBuf::from)
        .map(strip_windows_long_prefix)
        .unwrap_or_else(default_data_dir);
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("无法创建数据目录：{e}"))?;

    let log_dir = data_dir
        .parent()
        .map(|p| p.join("logs"))
        .unwrap_or_else(|| data_dir.clone());
    std::fs::create_dir_all(&log_dir).ok();

    let out_log = std::fs::File::create(log_dir.join("server.out.log")).ok();
    let err_log = std::fs::File::create(log_dir.join("server.err.log")).ok();

    let mut cmd = Command::new(&node.path);
    cmd.arg("--max-old-space-size=1024")
        .arg(&server_js)
        .current_dir(&root)
        .env("HOSTNAME", &host)
        .env("PORT", port.to_string())
        .env("NODE_ENV", "production")
        .env("NEXT_TELEMETRY_DISABLED", "1")
        .env("CODEX_HOT_SWITCH_DATA_DIR", &data_dir)
        .env("NODE_PATH", build_node_path(&root))
        .stdin(Stdio::null())
        .stdout(out_log.map(Stdio::from).unwrap_or_else(Stdio::null))
        .stderr(err_log.map(Stdio::from).unwrap_or_else(Stdio::null));

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 不弹黑框
        cmd.creation_flags(0x0800_0000);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("拉起 node 失败（{}）：{e}", node.path))?;

    // Windows：把子进程挂进一个 Job Object，并设「关闭即杀」。
    // 光靠 RunEvent 里 kill 不够——进程被强杀 / 崩溃 / 注销时那条路径不会执行，
    // 会留下占着 8787 端口的孤儿 node（实测踩过）。Job Object 是内核级的保证。
    #[cfg(windows)]
    attach_kill_on_close_job(&child);

    *state.child.lock().unwrap() = Some(child);
    let status = ServerStatus {
        state: "starting".into(),
        message: format!("正在启动本地中转服务：{host}:{port}（node {}）", node.version),
        endpoint,
        owned: true,
    };
    *state.status.lock().unwrap() = status.clone();
    Ok(status)
}

#[tauri::command]
fn server_status(state: State<'_, ServerRuntime>) -> ServerStatus {
    let mut status = state.status.lock().unwrap().clone();
    // 用端口探活修正状态，避免前端拿到过期的 "starting"
    if status.state == "starting" && health_ok(&status.endpoint) {
        status.state = "running".into();
        status.message = format!("本地中转服务运行中：{}", status.endpoint);
        *state.status.lock().unwrap() = status.clone();
    }
    status
}

#[tauri::command]
fn stop_server(state: State<'_, ServerRuntime>) -> Result<(), String> {
    let mut guard = state.child.lock().unwrap();
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    let mut status = state.status.lock().unwrap();
    status.state = "stopped".into();
    status.message = "本地中转服务已停止".into();
    status.owned = false;
    Ok(())
}

#[tauri::command]
fn restart_server(app: tauri::AppHandle, state: State<'_, ServerRuntime>) -> Result<ServerStatus, String> {
    stop_server(state.clone())?;
    std::thread::sleep(std::time::Duration::from_millis(600));
    start_server(app, state, StartOptions { host: None, port: None, data_dir: None })
}

/// 用系统浏览器打开外链（授权登录走这条）。
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("只允许打开 http/https 链接".into());
    }
    app.opener()
        .open_url(trimmed, None::<&str>)
        .map_err(|e| format!("打开浏览器失败：{e}"))
}

/// 引导页把状态/错误写进 `logs/guide.log`。
///
/// 为什么要这个：外壳是 `windows_subsystem = "windows"` 的 GUI 程序，
/// 没有控制台，引导页里的报错（Node 探测失败、server.js 找不到、invoke 被 capability 拦）
/// 在界面上只能看到一行字，出了问题很难定位。落盘之后就有一个稳定的排查入口。
#[tauri::command]
fn guide_log(level: String, message: String) {
    let dir = default_data_dir()
        .parent()
        .map(|p| p.join("logs"))
        .unwrap_or_else(|| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("guide.log"))
    {
        use std::io::Write;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "[{ts}] {level}  {message}");
        let _ = f.flush();
    }
}

/// 给引导页排查用：返回外壳实际解析到的资源路径，界面可以显示出来。
#[tauri::command]
fn debug_paths(app: tauri::AppHandle) -> serde_json::Value {
    let res = app.path().resource_dir().ok();
    let resolved = server_root(&app).ok();
    serde_json::json!({
        // resource_dir() 的原始返回值（Windows 上带 `\\?\` 前缀，仅供参考）
        "resourceDir": res.as_ref().map(|p| p.display().to_string()),
        // 以下都是剥过前缀、真正交给子进程的形式
        "resourceDirNormalized": res.as_ref().map(|p| strip_windows_long_prefix(p.clone()).display().to_string()),
        "serverRoot": resolved.as_ref().map(|p| p.display().to_string()),
        "serverJs": resolved.as_ref().map(|p| p.join("server.js").display().to_string()),
        "serverJsExists": resolved.as_ref().map(|p| p.join("server.js").exists()).unwrap_or(false),
        "exeDir": std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.display().to_string())),
        "dataDir": default_data_dir().display().to_string(),
        "debugBuild": cfg!(debug_assertions),
    })
}

// ---------------------------------------------------------------- 孤儿进程防护

/// 把子进程加入一个 Job Object，并设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。
///
/// 效果：只要本进程结束（正常退出、崩溃、被任务管理器结束、系统注销），
/// 内核就会连带终止 Job 里的所有进程。这是唯一能覆盖所有退出路径的做法。
///
/// 实现要点：Job handle 故意**不关闭**——句柄随进程销毁时关闭，
/// 那一刻触发 KILL_ON_JOB_CLOSE，子进程随之被杀。这正是我们要的时机。
#[cfg(windows)]
fn attach_kill_on_close_job(child: &Child) {
    use std::mem::size_of;
    use std::os::windows::io::AsRawHandle;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    unsafe {
        let job: HANDLE = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return;
        }

        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            CloseHandle(job);
            return;
        }

        let process_handle = child.as_raw_handle() as HANDLE;
        // 注意：不 CloseHandle(job)。句柄泄漏是刻意的，见函数注释。
        let assigned = AssignProcessToJobObject(job, process_handle);
        if assigned == 0 {
            let code = windows_sys::Win32::Foundation::GetLastError();
            // 常见失败：本进程已被放进某个 Job 且不允许嵌套（ERROR_ACCESS_DENIED = 5）。
            eprintln!("[switchgate] AssignProcessToJobObject 失败，GetLastError={code}");
        }
    }
}

// ---------------------------------------------------------------- 托盘

/// 托盘图标：关窗只隐藏不退出，所以必须有托盘作为「回到窗口」的入口，
/// 否则用户点一次 X 就再也叫不出界面了（服务还在跑，进程还活着）。
fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItemBuilder::with_id("show", "显示主窗口").build(app)?;
    let restart = MenuItemBuilder::with_id("restart", "重启中转服务").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&show)
        .separator()
        .item(&restart)
        .separator()
        .item(&quit)
        .build()?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Codex SwitchGate");

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => reveal_main_window(app),
            "restart" => {
                // 托盘菜单里没有 State 参数，这里手动取
                if let Some(state) = app.try_state::<ServerRuntime>() {
                    if let Ok(mut child) = state.child.lock().map(|mut g| g.take()).map_err(|_| ()) {
                        if let Some(mut c) = child.take() {
                            let _ = c.kill();
                            let _ = c.wait();
                        }
                    }
                    let _ = helper_start(app.clone(), state);
                }
            }
            "quit" => {
                if let Some(state) = app.try_state::<ServerRuntime>() {
                    if let Ok(mut guard) = state.child.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击托盘图标 -> 把窗口叫回来
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                reveal_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn reveal_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 供托盘「重启服务」复用：把 start_server 的 State 版本包一层，避免菜单回调里
/// 拿不到 State 泛型。
fn helper_start(app: tauri::AppHandle, state: State<'_, ServerRuntime>) -> Result<ServerStatus, String> {
    start_server(app, state, StartOptions { host: None, port: None, data_dir: None })
}

// ---------------------------------------------------------------- 入口

pub fn run() {
    // 把 panic 落盘。WebView 初始化失败之类的问题往往表现为静默 abort，
    // 没有这个 hook 就什么都看不到。
    let log_dir = default_data_dir()
        .parent()
        .map(|p| p.join("logs"))
        .unwrap_or_else(|| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&log_dir);
    let panic_log = log_dir.join("tauri-shell.log");

    // 启动痕迹：GUI 程序没有控制台，进程若在 build/run 阶段静默退出，
    // 没有这两行就完全无从判断死在哪一步。
    {
        use std::io::Write;
        let trace = log_dir.join("boot.log");
        #[allow(unused_mut)]
        let write = |msg: &str| {
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&trace)
            {
                let _ = writeln!(f, "[{}] {}", std::process::id(), msg);
                let _ = f.flush();
            }
        };
        write(&format!(
            "run() enter; exe={:?}; data_dir={:?}",
            std::env::current_exe().ok(),
            default_data_dir()
        ));
    }

    std::panic::set_hook(Box::new(move |info| {
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&panic_log)
        {
            use std::io::Write;
            let _ = writeln!(f, "[{info}]");
        }
        eprintln!("[switchgate] panic: {info}");
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(ServerRuntime::default())
        .invoke_handler(tauri::generate_handler![
            probe_node,
            start_server,
            server_status,
            stop_server,
            restart_server,
            open_external,
            guide_log,
            debug_paths,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            // 托盘失败不该让整个应用起不来 —— 记一笔继续。
            if let Err(e) = setup_tray(&handle) {
                let dir = default_data_dir()
                    .parent()
                    .map(|p| p.join("logs"))
                    .unwrap_or_else(|| PathBuf::from("."));
                let _ = std::fs::create_dir_all(&dir);
                if let Ok(mut f) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(dir.join("tauri-shell.log"))
                {
                    use std::io::Write;
                    let _ = writeln!(f, "[setup] 托盘创建失败：{e}");
                }
            }

            // 窗口在配置里是 visible: false。放一个小延迟再显示，让引导页先完成首帧，
            // 免得窗口一闪出来是块白底。WebView2 冷启通常几百毫秒，600ms 够用。
            // （不用 on_page_load：Tauri 2 的 WebviewWindow 上已无此方法。）
            if let Some(window) = app.get_webview_window("main") {
                let w = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(600));
                    let _ = w.show();
                    let _ = w.set_focus();
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败")
        .run(|app_handle, event| match event {
            // 窗口被关（点 X / Alt+F4）时不退出应用，只把窗口藏起来。
            // 这是桌面工具该有的行为：服务还在跑，托盘还在。
            RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } if label == "main" => {
                api.prevent_close();
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            // 退出时把服务进程带走。这只是优雅路径上的清理，
            // 强杀/崩溃的兜底靠 spawn 时挂的 Job Object。
            RunEvent::Exit => {
                if let Some(state) = app_handle.try_state::<ServerRuntime>() {
                    if let Some(mut child) = state.child.lock().unwrap().take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
            _ => {}
        });
}
