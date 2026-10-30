use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf};
use tauri::{
    ipc::{Channel, InvokeBody, Request},
    Manager, State,
};
use tokio::{
    io::AsyncWriteExt,
    process::{Child, ChildStdin, Command},
    sync::Mutex,
};

mod runtime_bridge;
use runtime_bridge::{ConnectionStatus, RuntimeBridge};

#[cfg(all(test, unix))]
#[path = "../build.rs"]
mod build_resources;

#[cfg(windows)]
fn contain_runtime(child: &Child) -> Result<std::os::windows::io::OwnedHandle, String> {
    use std::os::windows::io::{FromRawHandle, RawHandle};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if handle.is_null() {
        return Err("无法创建本地任务进程组".into());
    }
    let owned = unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(handle as RawHandle) };
    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let configured = unsafe {
        SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            std::mem::size_of_val(&info) as u32,
        )
    };
    if configured == 0 {
        return Err("无法设置本地任务退出规则".into());
    }
    let child_handle = child.raw_handle().ok_or("本地执行进程句柄不可用")?;
    if unsafe { AssignProcessToJobObject(handle, child_handle as _) } == 0 {
        return Err("无法将本地执行组件加入任务进程组".into());
    }
    Ok(owned)
}

fn secret_operation(method: &str, params: &Value) -> Result<Value, String> {
    let key = params
        .get("key")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 512)
        .ok_or("凭据引用无效")?;
    let entry = keyring::Entry::new("video-quickly", key).map_err(|error| error.to_string())?;
    match method {
        "host.secret.get" => match entry.get_password() {
            Ok(value) => Ok(Value::String(value)),
            Err(keyring::Error::NoEntry) => Ok(Value::Null),
            Err(error) => Err(error.to_string()),
        },
        "host.secret.set" => {
            let value = params
                .get("value")
                .and_then(Value::as_str)
                .ok_or("缺少凭据内容")?;
            entry
                .set_password(value)
                .map_err(|error| error.to_string())?;
            Ok(Value::Null)
        }
        "host.secret.delete" => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(Value::Null),
            Err(error) => Err(error.to_string()),
        },
        _ => Err("未知凭据操作".into()),
    }
}

#[tauri::command]
async fn runtime_request(
    method: String,
    params: Option<Value>,
    bridge: State<'_, RuntimeBridge>,
) -> Result<Value, String> {
    bridge.request(method, params).await
}

#[tauri::command]
async fn runtime_subscribe(
    channel: Channel<Value>,
    bridge: State<'_, RuntimeBridge>,
) -> Result<(), String> {
    bridge.subscribe(channel).await
}

#[tauri::command]
async fn runtime_status(bridge: State<'_, RuntimeBridge>) -> Result<ConnectionStatus, String> {
    Ok(bridge.status().await)
}

#[tauri::command]
async fn runtime_reconnect(bridge: State<'_, RuntimeBridge>) -> Result<ConnectionStatus, String> {
    bridge.reconnect().await
}

#[tauri::command]
fn read_secret(key: String) -> Result<Value, String> {
    secret_operation("host.secret.get", &json!({"key":key}))
}
#[tauri::command]
fn write_secret(key: String, value: String) -> Result<(), String> {
    secret_operation("host.secret.set", &json!({"key":key,"value":value})).map(|_| ())
}
#[tauri::command]
fn delete_secret(key: String) -> Result<(), String> {
    secret_operation("host.secret.delete", &json!({"key":key})).map(|_| ())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrameRate {
    numerator: u32,
    denominator: u32,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenderProfile {
    width: u32,
    height: u32,
    frame_rate: FrameRate,
}
struct RenderSession {
    child: Child,
    stdin: Option<ChildStdin>,
    target: PathBuf,
    temporary: PathBuf,
    frame_bytes: usize,
    expected_frames: u64,
    written: u64,
}
#[derive(Default)]
struct Renders(Mutex<HashMap<String, RenderSession>>);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderReceipt {
    id: String,
    output_path: String,
}

fn safe_name(value: &str) -> String {
    let value: String = value
        .chars()
        .filter(|character| character.is_alphanumeric() || *character == '-' || *character == '_')
        .take(80)
        .collect();
    if value.is_empty() {
        "video".into()
    } else {
        value
    }
}

#[tauri::command]
async fn render_begin(
    app: tauri::AppHandle,
    profile: RenderProfile,
    total_frames: u64,
    name: String,
    renders: State<'_, Renders>,
) -> Result<RenderReceipt, String> {
    let fps = f64::from(profile.frame_rate.numerator) / f64::from(profile.frame_rate.denominator);
    if !(64..=7680).contains(&profile.width)
        || !(64..=7680).contains(&profile.height)
        || profile.width % 2 != 0
        || profile.height % 2 != 0
        || !fps.is_finite()
        || !(1.0..=120.0).contains(&fps)
        || total_frames == 0
    {
        return Err("视频规格无效".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("exports");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let target = directory.join(format!("{}-{}.mp4", safe_name(&name), &id[..8]));
    let temporary = directory.join(format!("{id}.partial.mp4"));
    let resource = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let bundled = resource.join(if cfg!(windows) {
        "sidecar/media/ffmpeg.exe"
    } else {
        "sidecar/media/ffmpeg"
    });
    let ffmpeg = std::env::var_os("VIDEO_QUICKLY_FFMPEG")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            if bundled.exists() {
                bundled
            } else {
                PathBuf::from("ffmpeg")
            }
        });
    let mut command = Command::new(ffmpeg);
    command
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pixel_format",
            "rgba",
            "-video_size",
            &format!("{}x{}", profile.width, profile.height),
            "-framerate",
            &format!(
                "{}/{}",
                profile.frame_rate.numerator, profile.frame_rate.denominator
            ),
            "-i",
            "pipe:0",
            "-frames:v",
            &total_frames.to_string(),
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
        ])
        .arg(&temporary)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 FFmpeg：{error}"))?;
    let stdin = child.stdin.take().ok_or("无法打开编码输入")?;
    let session = RenderSession {
        child,
        stdin: Some(stdin),
        target: target.clone(),
        temporary,
        frame_bytes: profile.width as usize * profile.height as usize * 4,
        expected_frames: total_frames,
        written: 0,
    };
    renders.0.lock().await.insert(id.clone(), session);
    Ok(RenderReceipt {
        id,
        output_path: target.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
async fn render_frame(request: Request<'_>, renders: State<'_, Renders>) -> Result<(), String> {
    let id = request
        .headers()
        .get("x-render-id")
        .and_then(|value| value.to_str().ok())
        .ok_or("缺少导出编号")?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("视频帧必须使用二进制传输".into());
    };
    let mut sessions = renders.0.lock().await;
    let session = sessions.get_mut(id).ok_or("导出任务不存在")?;
    if bytes.len() != session.frame_bytes || session.written >= session.expected_frames {
        return Err("视频帧尺寸或数量无效".into());
    }
    session
        .stdin
        .as_mut()
        .ok_or("编码输入已关闭")?
        .write_all(bytes)
        .await
        .map_err(|error| error.to_string())?;
    session.written += 1;
    Ok(())
}

#[tauri::command]
async fn render_finish(id: String, renders: State<'_, Renders>) -> Result<String, String> {
    let mut session = renders.0.lock().await.remove(&id).ok_or("导出任务不存在")?;
    session.stdin.take();
    if session.written != session.expected_frames {
        let _ = session.child.kill().await;
        return Err("导出帧尚未完整写入".into());
    }
    let status = session
        .child
        .wait()
        .await
        .map_err(|error| error.to_string())?;
    if !status.success() {
        return Err("FFmpeg 编码失败".into());
    }
    std::fs::rename(&session.temporary, &session.target).map_err(|error| error.to_string())?;
    Ok(session.target.to_string_lossy().into_owned())
}
#[tauri::command]
async fn render_cancel(id: String, renders: State<'_, Renders>) -> Result<(), String> {
    if let Some(mut session) = renders.0.lock().await.remove(&id) {
        session.stdin.take();
        let _ = session.child.kill().await;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Renders::default())
        .invoke_handler(tauri::generate_handler![
            runtime_request,
            runtime_subscribe,
            runtime_status,
            runtime_reconnect,
            read_secret,
            write_secret,
            delete_secret,
            render_begin,
            render_frame,
            render_finish,
            render_cancel
        ])
        .setup(|app| {
            let bridge = tauri::async_runtime::block_on(RuntimeBridge::start(app.handle()))
                .map_err(std::io::Error::other)?;
            app.manage(bridge);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("无法启动 Video Quickly");
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            let state = app.state::<RuntimeBridge>();
            tauri::async_runtime::block_on(async {
                let _ = state.shutdown().await;
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::secret_operation;
    use serde_json::{json, Value};

    #[test]
    fn credential_roundtrip_uses_an_isolated_test_entry() {
        let key = format!("test-{}", uuid::Uuid::new_v4());
        let parameters = json!({"key": key, "value": "video-quickly-local-test"});
        secret_operation("host.secret.set", &parameters)
            .expect("test credential should be writable");
        let loaded = secret_operation("host.secret.get", &parameters);
        let removed = secret_operation("host.secret.delete", &parameters);
        assert_eq!(
            loaded.unwrap(),
            Value::String("video-quickly-local-test".into())
        );
        removed.expect("test credential should be removed");
        assert_eq!(
            secret_operation("host.secret.get", &parameters).unwrap(),
            Value::Null
        );
    }
}
