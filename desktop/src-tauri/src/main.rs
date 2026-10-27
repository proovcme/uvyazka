#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{sync::Mutex,time::Duration};
use serde::Serialize;
use tauri::{Manager,State};
use tauri_plugin_shell::{ShellExt,process::{CommandChild,CommandEvent}};

#[derive(Default)]
struct Core { child:Mutex<Option<CommandChild>>, port:Mutex<Option<u16>>, starting:tokio::sync::Mutex<()> }
#[derive(Serialize)]
struct Ready { url:String, version:String }

#[tauri::command]
async fn start_backend(app:tauri::AppHandle,state:State<'_,Core>)->Result<Ready,String>{
    let _starting=state.starting.lock().await;
    if let Some(port)=*state.port.lock().map_err(|_|"State lock")? {
        if std::net::TcpStream::connect_timeout(&std::net::SocketAddr::from(([127,0,0,1],port)),Duration::from_millis(300)).is_ok(){
            return Ok(Ready{url:format!("http://127.0.0.1:{port}/"),version:app.package_info().version.to_string()});
        }
    }
    if let Some(child)=state.child.lock().map_err(|_|"State lock")?.take(){let _=child.kill();}
    // Stable origin retains local preferences and IndexedDB between app starts.
    // Never attach to an unknown process if this port is occupied.
    let port=std::env::var("UVYAZKA_DESKTOP_PORT").unwrap_or_else(|_|"17881".into());
    let port=port.parse::<u16>().ok().filter(|p|*p>1024).ok_or("Invalid desktop port")?.to_string();
    let (mut events,child)=app.shell().sidecar("uvyazka-core").map_err(|e|e.to_string())?.args(["--serve","--port",port.as_str()]).spawn().map_err(|e|e.to_string())?;
    *state.child.lock().map_err(|_|"State lock")?=Some(child);
    let ready=tokio::time::timeout(Duration::from_secs(90),async {
        let mut pending=String::new();
        while let Some(event)=events.recv().await {
            match event {
                CommandEvent::Stdout(raw)=>{
                    pending.push_str(&String::from_utf8_lossy(&raw));
                    if pending.len()>65536{return Err("Unexpected backend output".to_string());}
                    for line in pending.lines(){
                        if let Ok(value)=serde_json::from_str::<serde_json::Value>(line){
                            if value["desktop_api"]==1 {
                                let port=value["port"].as_u64().filter(|p|*p>1024&&*p<=65535).ok_or("Invalid backend port")?;
                                return Ok(port as u16);
                            }
                        }
                    }
                }
                CommandEvent::Terminated(payload)=>return Err(format!("Project core exited: {:?}",payload.code)),
                _=>{}
            }
        }
        Err("Project core did not start".into())
    }).await.map_err(|_|"Project core startup timed out".to_string()).and_then(|x|x);
    let ready=match ready {Ok(port)=>port,Err(error)=>{
        if let Some(child)=state.child.lock().map_err(|_|"State lock")?.take(){let _=child.kill();}
        *state.port.lock().map_err(|_|"State lock")?=None;
        return Err(error);
    }};
    *state.port.lock().map_err(|_|"State lock")?=Some(ready);
    // Retain/drain the event receiver; full pipes must never stop project jobs.
    tauri::async_runtime::spawn(async move {while events.recv().await.is_some(){}});
    Ok(Ready{url:format!("http://127.0.0.1:{ready}/"),version:app.package_info().version.to_string()})
}

#[tauri::command]
fn stop_backend(state:State<'_,Core>)->Result<(),String>{
    if let Some(child)=state.child.lock().map_err(|_|"State lock")?.take(){child.kill().map_err(|e|e.to_string())?;}
    *state.port.lock().map_err(|_|"State lock")?=None;Ok(())
}

fn main(){
    let app=tauri::Builder::default().manage(Core::default())
        .plugin(tauri_plugin_single_instance::init(|app,_,_|{if let Some(window)=app.get_webview_window("main"){let _=window.unminimize();let _=window.show();let _=window.set_focus();}}))
        .plugin(tauri_plugin_shell::init()).plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init()).invoke_handler(tauri::generate_handler![start_backend,stop_backend])
        .build(tauri::generate_context!()).expect("Uvyazka desktop build");
    app.run(|handle,event|{if matches!(event,tauri::RunEvent::Exit){if let Ok(mut child)=handle.state::<Core>().child.lock(){if let Some(child)=child.take(){let _=child.kill();}}}});
}
