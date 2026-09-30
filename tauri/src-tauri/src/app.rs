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
/// Tauri 的 `resource_dir()` 在 Windows 上指向 exe 同级目录，
/// 我们把 standalone 产物以 `server/` 为前缀塞进 resources。
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
    let packaged = res.join("server");
    if packaged.join("server.js").exists() {
        return Ok(packaged);
    }
    Err(format!("找不到 server.js：{}", packaged.display()))
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
    base.join("codex-api-hot-switch").join("data")
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
fn probe_node_version(exe: &Path) -> Option<(PathBuf, String)> {
    let output = Command::new(exe)
        .arg("-e")
        .arg("process.stdout.write(process.versions.node)")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
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

/// standalone 的 node_modules 里只有结构，真正跑起来要靠 vendor。
/// 这里把 vendor 与 .pnpm/*/node_modules 全部拼进 NODE_PATH —— 与 Electron 外壳同策略。
fn build_node_path(server_root: &Path) -> String {
    let vendor = server_root.join("vendor");
    let mut entries: Vec<String> = vec![vendor.to_string_lossy().to_string()];
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
        ])
        .setup(|app| {
            // 允许 WebView 直接指向本地中转服务（默认同源策略只放行 tauri:// 与 devUrl）
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
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
