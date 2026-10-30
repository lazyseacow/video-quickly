use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};
use tauri::{ipc::Channel, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex},
};

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;
type Subscribers = Arc<Mutex<Vec<Channel<Value>>>>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatus {
    state: &'static str,
    generation: u64,
    message: Option<String>,
}

struct Session {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Pending,
    #[cfg(windows)]
    _job: std::os::windows::io::OwnedHandle,
}

pub struct RuntimeBridge {
    node: PathBuf,
    arguments: Vec<String>,
    directory: PathBuf,
    session: Mutex<Option<Session>>,
    operation: Mutex<()>,
    status: Arc<Mutex<ConnectionStatus>>,
    subscribers: Subscribers,
    sequence: AtomicU64,
    shutting_down: AtomicBool,
}

impl RuntimeBridge {
    pub async fn start(app: &tauri::AppHandle) -> Result<Self, String> {
        let data = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        std::fs::create_dir_all(&data).map_err(|error| error.to_string())?;
        let development =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../.generated/sidecar");
        let directory = if cfg!(debug_assertions) && development.join("runtime.mjs").exists() {
            development
        } else {
            app.path()
                .resource_dir()
                .map_err(|error| error.to_string())?
                .join("sidecar")
        };
        let bridge = Self::new(
            directory.join(if cfg!(windows) { "node.exe" } else { "node" }),
            vec![
                directory.join("runtime.mjs").to_string_lossy().into_owned(),
                "--data-dir".into(),
                data.to_string_lossy().into_owned(),
            ],
            directory,
        );
        // Keep the window available when startup fails, so the failure is actionable.
        let _ = bridge.reconnect().await;
        Ok(bridge)
    }

    fn new(node: PathBuf, arguments: Vec<String>, directory: PathBuf) -> Self {
        Self {
            node,
            arguments,
            directory,
            session: Mutex::new(None),
            operation: Mutex::new(()),
            status: Arc::new(Mutex::new(ConnectionStatus {
                state: "disconnected",
                generation: 0,
                message: None,
            })),
            subscribers: Arc::new(Mutex::new(Vec::new())),
            sequence: AtomicU64::new(1),
            shutting_down: AtomicBool::new(false),
        }
    }

    pub async fn status(&self) -> ConnectionStatus {
        self.status.lock().await.clone()
    }

    pub async fn subscribe(&self, channel: Channel<Value>) -> Result<(), String> {
        let status = self.status.lock().await;
        let mut subscribers = self.subscribers.lock().await;
        channel
            .send(json!({"type":"runtime.connection","data": &*status}))
            .map_err(|error| error.to_string())?;
        subscribers.push(channel);
        Ok(())
    }

    pub async fn reconnect(&self) -> Result<ConnectionStatus, String> {
        let _operation = self.operation.lock().await;
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err("应用正在退出".into());
        }
        let status = self.status().await;
        if status.state == "ready" {
            let mut session = self.session.lock().await;
            if let Some(session) = session.as_mut() {
                if session
                    .child
                    .try_wait()
                    .map_err(|error| error.to_string())?
                    .is_none()
                {
                    return Ok(status);
                }
            }
        }
        let generation = status.generation + 1;
        self.set_status(generation, "reconnecting", None).await;
        if let Err(error) = self.stop_session().await {
            self.set_status(generation, "disconnected", Some(error.clone()))
                .await;
            return Err(error);
        }
        let ready = match self.spawn_session(generation).await {
            Ok(ready) => ready,
            Err(error) => {
                self.set_status(generation, "disconnected", Some(error.clone()))
                    .await;
                return Err(error);
            }
        };
        let result = tokio::time::timeout(std::time::Duration::from_secs(60), ready).await;
        match result {
            Ok(Ok(Ok(()))) => {
                let mut status = self.status.lock().await;
                if status.generation != generation || status.state == "disconnected" {
                    return Err(status
                        .message
                        .clone()
                        .unwrap_or_else(|| "执行组件已退出".into()));
                }
                status.state = "ready";
                status.message = None;
                self.subscribers.lock().await.retain(|channel| {
                    channel
                        .send(json!({"type":"runtime.connection","data": &*status}))
                        .is_ok()
                });
                Ok(status.clone())
            }
            _ => {
                let previous = self.status().await;
                let message = previous
                    .message
                    .unwrap_or_else(|| "执行组件启动未完成，请检查组件后重新连接。".into());
                let stop = self.stop_session().await;
                let message = stop.err().unwrap_or(message);
                self.set_status(generation, "disconnected", Some(message.clone()))
                    .await;
                Err(message)
            }
        }
    }

    async fn set_status(&self, generation: u64, state: &'static str, message: Option<String>) {
        let mut status = self.status.lock().await;
        if generation < status.generation {
            return;
        }
        *status = ConnectionStatus {
            state,
            generation,
            message,
        };
        self.subscribers.lock().await.retain(|channel| {
            channel
                .send(json!({"type":"runtime.connection","data": &*status}))
                .is_ok()
        });
    }

    async fn spawn_session(
        &self,
        generation: u64,
    ) -> Result<oneshot::Receiver<Result<(), String>>, String> {
        let mut command = Command::new(&self.node);
        command
            .args(&self.arguments)
            .env("VIDEO_QUICKLY_MODE", "desktop")
            .current_dir(&self.directory)
            .kill_on_drop(true)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let media = self.directory.join("media");
        let ffmpeg = media.join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
        let ffprobe = media.join(if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" });
        if ffmpeg.exists() {
            command
                .env("VIDEO_QUICKLY_FFMPEG", ffmpeg)
                .env("VIDEO_QUICKLY_FFPROBE", ffprobe);
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动本地执行组件：{error}"))?;
        #[cfg(windows)]
        let job = match super::contain_runtime(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill().await;
                return Err(error);
            }
        };
        let stdin = Arc::new(Mutex::new(
            child.stdin.take().ok_or("执行组件缺少输入通道")?,
        ));
        let stdout = child.stdout.take().ok_or("执行组件缺少输出通道")?;
        let stderr = child.stderr.take().ok_or("执行组件缺少日志通道")?;
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (ready_sender, ready) = oneshot::channel();
        let read_pending = pending.clone();
        let host_stdin = stdin.clone();
        let subscribers = self.subscribers.clone();
        let connection = self.status.clone();
        tauri::async_runtime::spawn(async move {
            let mut ready_sender = Some(ready_sender);
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(method) = message.get("method").and_then(Value::as_str) {
                    if method == "runtime.ready" {
                        if let Some(sender) = ready_sender.take() {
                            let _ = sender.send(Ok(()));
                        }
                    } else if method == "runtime.failed" {
                        let reason = message["params"]["message"]
                            .as_str()
                            .unwrap_or("执行组件启动失败")
                            .to_string();
                        let mut status = connection.lock().await;
                        if status.generation == generation {
                            status.state = "disconnected";
                            status.message = Some(reason.clone());
                        }
                        if let Some(sender) = ready_sender.take() {
                            let _ = sender.send(Err(reason));
                        }
                    } else if method.starts_with("host.secret.") {
                        let result = super::secret_operation(
                            method,
                            message.get("params").unwrap_or(&Value::Null),
                        );
                        let response = match result {
                            Ok(value) => json!({"jsonrpc":"2.0","id":message["id"],"result":value}),
                            Err(error) => {
                                json!({"jsonrpc":"2.0","id":message["id"],"error":{"code":-32000,"message":error}})
                            }
                        };
                        let _ = write_message(&host_stdin, &response).await;
                    } else if method == "runtime.event" {
                        let status = connection.lock().await;
                        if status.generation == generation {
                            subscribers
                                .lock()
                                .await
                                .retain(|channel| channel.send(message["params"].clone()).is_ok());
                        }
                    }
                } else if let Some(id) = message.get("id").and_then(Value::as_u64) {
                    if let Some(sender) = read_pending.lock().await.remove(&id) {
                        let result = if let Some(error) = message.get("error") {
                            Err(error["message"]
                                .as_str()
                                .unwrap_or("执行请求失败")
                                .to_string())
                        } else {
                            Ok(message.get("result").cloned().unwrap_or(Value::Null))
                        };
                        let _ = sender.send(result);
                    }
                }
            }
            let mut status = connection.lock().await;
            if status.generation == generation {
                status.state = "disconnected";
                if status.message.is_none() {
                    status.message = Some("本地执行组件已退出，请重新连接后核对任务状态。".into());
                }
                subscribers.lock().await.retain(|channel| {
                    channel
                        .send(json!({"type":"runtime.connection","data": &*status}))
                        .is_ok()
                });
            }
            for (_, sender) in read_pending.lock().await.drain() {
                let _ = sender.send(Err("执行组件已失联，请重新连接后核对操作是否完成。".into()));
            }
        });
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("[runtime] {line}");
            }
        });
        let mut session = self.session.lock().await;
        if self.shutting_down.load(Ordering::SeqCst) {
            let _ = child.kill().await;
            return Err("应用正在退出".into());
        }
        *session = Some(Session {
            child,
            stdin,
            pending,
            #[cfg(windows)]
            _job: job,
        });
        Ok(ready)
    }

    pub async fn request(&self, method: String, params: Option<Value>) -> Result<Value, String> {
        self.request_with_timeout(method, params, std::time::Duration::from_secs(180))
            .await
    }

    async fn request_with_timeout(
        &self,
        method: String,
        params: Option<Value>,
        timeout: std::time::Duration,
    ) -> Result<Value, String> {
        if method.starts_with("host.") {
            return Err("该操作由执行组件内部调用".into());
        }
        let status = self.status.lock().await;
        if status.state != "ready" {
            return Err("本地执行组件未连接，请先重新连接。".into());
        }
        let (stdin, pending) = {
            let session = self.session.lock().await;
            let session = session.as_ref().ok_or("本地执行组件未连接")?;
            (session.stdin.clone(), session.pending.clone())
        };
        let id = self.sequence.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        pending.lock().await.insert(id, sender);
        let generation = status.generation;
        drop(status);
        let request = async {
            write_message(&stdin, &json!({"jsonrpc":"2.0","id":id,"method":method,"params":params.unwrap_or(Value::Null)})).await?;
            receiver
                .await
                .map_err(|_| "执行通道已关闭，请核对操作是否完成。".to_string())?
        };
        let result = match tokio::time::timeout(timeout, request).await {
            Ok(result) => result,
            Err(_) => {
                let message = "执行组件请求超时，请重新连接后核对操作是否完成。".to_string();
                // A timed-out write may contain a partial JSON line. Replace the
                // connection before accepting another request; never replay it.
                self.set_status(generation, "disconnected", Some(message.clone()))
                    .await;
                Err(message)
            }
        };
        pending.lock().await.remove(&id);
        result
    }

    async fn stop_session(&self) -> Result<(), String> {
        let mut session = self.session.lock().await;
        if let Some(mut previous) = session.take() {
            if let Err(error) = previous.child.kill().await {
                if previous
                    .child
                    .try_wait()
                    .map_err(|error| error.to_string())?
                    .is_none()
                {
                    *session = Some(previous);
                    return Err(format!("无法停止原执行组件：{error}"));
                }
            }
            for (_, sender) in previous.pending.lock().await.drain() {
                let _ = sender.send(Err("执行组件已停止，请核对操作是否完成。".into()));
            }
            // Dropping the Windows job also stops descendants before a replacement opens SQLite.
        }
        Ok(())
    }

    pub async fn shutdown(&self) -> Result<(), String> {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.set_status(
            self.status().await.generation + 1,
            "disconnected",
            Some("执行组件已停止".into()),
        )
        .await;
        self.stop_session().await
    }
}

async fn write_message(stdin: &Arc<Mutex<ChildStdin>>, value: &Value) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    let mut writer = stdin.lock().await;
    writer
        .write_all(&bytes)
        .await
        .map_err(|error| error.to_string())?;
    writer.flush().await.map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Arc<RuntimeBridge>, PathBuf) {
        let directory = std::env::temp_dir().join(format!("vq-bridge-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let sidecar = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../.generated/sidecar");
        let bridge = RuntimeBridge::new(
            sidecar.join(if cfg!(windows) { "node.exe" } else { "node" }),
            vec![
                sidecar.join("runtime.mjs").to_string_lossy().into_owned(),
                "--data-dir".into(),
                directory.to_string_lossy().into_owned(),
            ],
            sidecar,
        );
        (Arc::new(bridge), directory)
    }

    async fn wait_status(bridge: &RuntimeBridge, state: &str) {
        for _ in 0..100 {
            if bridge.status().await.state == state {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("bridge did not reach {state}");
    }

    #[test]
    fn reconnects_a_real_runtime_without_repeating_a_completed_review_activity() {
        tauri::async_runtime::block_on(async {
            let (bridge, directory) = fixture();
            let connected = bridge.reconnect().await.unwrap();
            let first = bridge
                .request("workspace.summary".into(), None)
                .await
                .unwrap();
            assert!(first["projects"][0]["shotCount"].is_number());
            assert!(first["projects"][0].get("shots").is_none());
            assert!(first.get("runs").is_none());
            let project = first["projects"][0]["id"].clone();
            let detail = bridge
                .request(
                    "project.get".into(),
                    Some(json!({"projectId":project.clone()})),
                )
                .await
                .unwrap();
            assert_eq!(detail["project"]["id"], project);
            let run = bridge
                .request(
                    "run.start".into(),
                    Some(json!({"projectId":project,"nodeId":"style"})),
                )
                .await
                .unwrap();
            let id = run["id"].clone();
            for _ in 0..100 {
                let snapshot = bridge
                    .request("workspace.snapshot".into(), None)
                    .await
                    .unwrap();
                if snapshot["runs"][0]["status"] == "waiting_review" {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            bridge
                .session
                .lock()
                .await
                .as_mut()
                .unwrap()
                .child
                .kill()
                .await
                .unwrap();
            wait_status(&bridge, "disconnected").await;
            assert!(bridge
                .request(
                    "project.create".into(),
                    Some(json!({"title":"must not submit"}))
                )
                .await
                .is_err());
            let one = {
                let bridge = bridge.clone();
                tauri::async_runtime::spawn(async move { bridge.reconnect().await })
            };
            let two = {
                let bridge = bridge.clone();
                tauri::async_runtime::spawn(async move { bridge.reconnect().await })
            };
            assert_eq!(
                one.await.unwrap().unwrap().generation,
                connected.generation + 1
            );
            assert_eq!(
                two.await.unwrap().unwrap().generation,
                connected.generation + 1
            );
            let restored = bridge
                .request("workspace.snapshot".into(), None)
                .await
                .unwrap();
            assert_eq!(restored["runs"][0]["status"], "waiting_review");
            assert_eq!(
                restored["runs"][0]["activities"].as_array().unwrap().len(),
                1
            );
            assert_eq!(restored["projects"].as_array().unwrap().len(), 1);
            bridge
                .request(
                    "run.review".into(),
                    Some(json!({"runId":id,"approved":true})),
                )
                .await
                .unwrap();
            let mut completed = false;
            for _ in 0..100 {
                let snapshot = bridge
                    .request("workspace.snapshot".into(), None)
                    .await
                    .unwrap();
                if snapshot["runs"][0]["status"] == "succeeded" {
                    completed = true;
                    assert_eq!(
                        snapshot["runs"][0]["activities"].as_array().unwrap().len(),
                        1
                    );
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            assert!(completed);
            bridge.shutdown().await.unwrap();
            std::fs::remove_dir_all(directory).unwrap();
        });
    }

    #[test]
    fn fails_pending_requests_on_process_exit_and_allows_retry_after_startup_failure() {
        tauri::async_runtime::block_on(async {
            let (bridge, directory) = fixture();
            let peer = directory.join("peer.mjs");
            let node = bridge.node.clone();
            let fixture = RuntimeBridge::new(
                node,
                vec![peer.to_string_lossy().into_owned()],
                directory.clone(),
            );
            assert!(fixture.reconnect().await.is_err());
            assert_eq!(fixture.status().await.state, "disconnected");
            std::fs::write(&peer, "process.stdout.write(JSON.stringify({method:'runtime.ready'})+'\\n'); process.stdin.resume();").unwrap();
            let fixture = Arc::new(fixture);
            fixture.reconnect().await.unwrap();
            let pending = {
                let fixture = fixture.clone();
                tauri::async_runtime::spawn(
                    async move { fixture.request("hold".into(), None).await },
                )
            };
            for _ in 0..100 {
                if !fixture
                    .session
                    .lock()
                    .await
                    .as_ref()
                    .unwrap()
                    .pending
                    .lock()
                    .await
                    .is_empty()
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            fixture
                .session
                .lock()
                .await
                .as_mut()
                .unwrap()
                .child
                .kill()
                .await
                .unwrap();
            assert!(
                tokio::time::timeout(std::time::Duration::from_secs(2), pending)
                    .await
                    .unwrap()
                    .unwrap()
                    .is_err()
            );
            fixture.reconnect().await.unwrap();
            fixture.shutdown().await.unwrap();
            std::fs::remove_dir_all(directory).unwrap();
        });
    }

    #[test]
    fn times_out_an_unresponsive_peer_without_replaying_the_request() {
        tauri::async_runtime::block_on(async {
            let (template, directory) = fixture();
            let peer = directory.join("unresponsive.mjs");
            std::fs::write(&peer, "process.stdout.write(JSON.stringify({method:'runtime.ready'})+'\\n'); process.stdin.resume();").unwrap();
            let bridge = RuntimeBridge::new(
                template.node.clone(),
                vec![peer.to_string_lossy().into_owned()],
                directory.clone(),
            );
            let first = bridge.reconnect().await.unwrap();
            assert!(bridge
                .request_with_timeout("hold".into(), None, std::time::Duration::from_millis(50))
                .await
                .is_err());
            assert_eq!(bridge.status().await.state, "disconnected");
            assert!(bridge
                .session
                .lock()
                .await
                .as_ref()
                .unwrap()
                .pending
                .lock()
                .await
                .is_empty());
            assert!(bridge.request("hold".into(), None).await.is_err());
            assert_eq!(bridge.sequence.load(Ordering::Relaxed), 2);
            assert_eq!(
                bridge.reconnect().await.unwrap().generation,
                first.generation + 1
            );
            bridge.shutdown().await.unwrap();
            std::fs::remove_dir_all(directory).unwrap();
        });
    }
}
