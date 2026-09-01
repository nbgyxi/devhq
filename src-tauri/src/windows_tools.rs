use serde::{Deserialize, Serialize};
use std::process::{Command, Output};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepAwakeResult {
    pub active: bool,
    pub flags: u32,
}

/// Ask Windows to suspend its normal idle policy for this process. Windows
/// automatically releases the request when DevHQ exits.
pub fn keep_awake_set(
    system: bool,
    display: bool,
    away_mode: bool,
) -> Result<KeepAwakeResult, String> {
    use std::sync::{mpsc, OnceLock};
    use windows::Win32::System::Power::{
        SetThreadExecutionState, ES_AWAYMODE_REQUIRED, ES_CONTINUOUS, ES_DISPLAY_REQUIRED,
        ES_SYSTEM_REQUIRED,
    };

    let mut state = ES_CONTINUOUS;
    if system {
        state |= ES_SYSTEM_REQUIRED;
    }
    if display {
        state |= ES_DISPLAY_REQUIRED;
    }
    if away_mode {
        state |= ES_AWAYMODE_REQUIRED;
    }

    type Request = (u32, mpsc::Sender<Result<(), String>>);
    static WORKER: OnceLock<mpsc::Sender<Request>> = OnceLock::new();
    let worker = WORKER.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<Request>();
        std::thread::spawn(move || {
            while let Ok((flags, reply)) = rx.recv() {
                let result = unsafe {
                    SetThreadExecutionState(windows::Win32::System::Power::EXECUTION_STATE(flags))
                };
                let answer = if result.0 == 0 {
                    Err("Windows rejected the execution-state request.".into())
                } else {
                    Ok(())
                };
                let _ = reply.send(answer);
            }
        });
        tx
    });
    let (reply_tx, reply_rx) = mpsc::channel();
    worker
        .send((state.0, reply_tx))
        .map_err(|_| "The keep-awake worker stopped.".to_string())?;
    reply_rx
        .recv()
        .map_err(|_| "The keep-awake worker did not respond.".to_string())??;
    Ok(KeepAwakeResult {
        active: system || display || away_mode,
        flags: state.0,
    })
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub ok: bool,
    pub output: String,
    pub error: String,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EventRecord {
    pub time: String,
    pub channel: String,
    pub level: String,
    pub provider: String,
    pub id: u32,
    pub message: String,
    pub xml: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventQuery {
    pub channels: Vec<String>,
    pub levels: Vec<String>,
    pub text: String,
    pub limit: u32,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RegistryItem {
    pub name: String,
    pub kind: String,
    pub value: String,
    pub is_key: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryChange {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub value: String,
    pub delete: bool,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PathEntry {
    pub scope: String,
    pub value: String,
    pub expanded: String,
    pub status: String,
    pub detail: String,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentItem {
    pub scope: String,
    pub name: String,
    pub value: String,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SystemReport {
    pub paths: Vec<PathEntry>,
    pub variables: Vec<EnvironmentItem>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LogTail {
    pub path: String,
    pub size: u64,
    pub modified_ms: u64,
    pub lines: Vec<String>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LockProcess {
    pub pid: u32,
    pub name: String,
    pub service: String,
    pub application_type: String,
    pub restartable: bool,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub flow: String,
    pub is_default: bool,
    pub volume: u32,
    pub muted: bool,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepairTarget {
    pub id: String,
    pub name: String,
    pub detail: String,
    pub status: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ActiveWindow {
    pub title: String,
    pub process: String,
    pub path: String,
    pub pid: u32,
    pub idle_ms: u64,
}

/// A cheap snapshot used by the local time tracker. No hook is installed: the
/// front end samples this while DevHQ is alive, so tracking cannot outlive the
/// app or leave a background helper behind.
#[cfg(windows)]
pub fn active_window() -> Result<ActiveWindow, String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    };

    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return Err("Windows has no foreground window.".into());
        }
        let length = GetWindowTextLengthW(hwnd).max(0) as usize;
        let mut title_buf = vec![0u16; length + 1];
        let copied = GetWindowTextW(hwnd, &mut title_buf) as usize;
        let title = String::from_utf16_lossy(&title_buf[..copied]);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));

        let mut path = String::new();
        if let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            let mut buf = vec![0u16; 32768];
            let mut size = buf.len() as u32;
            if QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_FORMAT(0),
                PWSTR(buf.as_mut_ptr()),
                &mut size,
            )
            .is_ok()
            {
                path = String::from_utf16_lossy(&buf[..size as usize]);
            }
            let _ = CloseHandle(handle);
        }
        let process = std::path::Path::new(&path)
            .file_name()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_string();
        let mut input = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        let idle_ms = if GetLastInputInfo(&mut input).as_bool() {
            u64::from(
                windows::Win32::System::SystemInformation::GetTickCount()
                    .wrapping_sub(input.dwTime),
            )
        } else {
            0
        };
        Ok(ActiveWindow {
            title,
            process,
            path,
            pid,
            idle_ms,
        })
    }
}

const WINDOW_BOUNDS_CS: &str = r#"Add-Type -TypeDefinition @'
using System;using System.Collections.Generic;using System.Runtime.InteropServices;using System.Text;
public static class DevHQWindows { public delegate bool CB(IntPtr h,IntPtr l); [StructLayout(LayoutKind.Sequential)]struct R{public int l,t,r,b;} [DllImport("user32.dll")]static extern bool EnumWindows(CB c,IntPtr l);[DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);[DllImport("user32.dll")]static extern bool IsIconic(IntPtr h);[DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr h,out R r);[DllImport("user32.dll")]static extern int GetWindowText(IntPtr h,StringBuilder s,int n);[DllImport("user32.dll")]static extern IntPtr MonitorFromRect(ref R r,uint f);[DllImport("user32.dll")]static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int w,int z,uint f);
public static object[] List(){var o=new List<object>();EnumWindows((h,l)=>{R r;if(!IsWindowVisible(h)||IsIconic(h)||!GetWindowRect(h,out r))return true;var s=new StringBuilder(512);GetWindowText(h,s,512);if(s.Length==0)return true;bool off=MonitorFromRect(ref r,0)==IntPtr.Zero;if(off)o.Add(new{id=h.ToInt64().ToString(),name=s.ToString(),detail="("+r.l+", "+r.t+") "+(r.r-r.l)+"x"+(r.b-r.t),status="off-screen"});return true;},IntPtr.Zero);return o.ToArray();}
public static void Pull(long id){var h=new IntPtr(id);R r;if(!GetWindowRect(h,out r))throw new Exception("Window no longer exists");int w=Math.Max(640,Math.Min(1280,r.r-r.l)),z=Math.Max(480,Math.Min(900,r.b-r.t));if(!SetWindowPos(h,IntPtr.Zero,120,120,w,z,0x0004|0x0010))throw new Exception("SetWindowPos failed");}}
'@;"#;

const CORE_AUDIO_CS: &str = r#"Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class DevHQAudio {
 public enum Flow { Render, Capture, All } public enum Role { Console, Multimedia, Communications }
 [Flags] public enum State:uint { Active=1 }
 [StructLayout(LayoutKind.Sequential)] public struct PropertyKey { public Guid fmtid; public uint pid; }
 [StructLayout(LayoutKind.Explicit)] public struct PropVariant { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr pointer; }
 [ComImport,Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class Enumerator {}
 [InterfaceType(ComInterfaceType.InterfaceIsIUnknown),Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")] public interface IEnum { [PreserveSig]int EnumAudioEndpoints(Flow f,State s,[MarshalAs(UnmanagedType.Interface)]out ICollection c); [PreserveSig]int GetDefaultAudioEndpoint(Flow f,Role r,[MarshalAs(UnmanagedType.Interface)]out IDevice d); [PreserveSig]int GetDevice(string id,[MarshalAs(UnmanagedType.Interface)]out IDevice d); [PreserveSig]int RegisterEndpointNotificationCallback(IntPtr c); [PreserveSig]int UnregisterEndpointNotificationCallback(IntPtr c); }
 [InterfaceType(ComInterfaceType.InterfaceIsIUnknown),Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E")] public interface ICollection { [PreserveSig]int GetCount(out uint c); [PreserveSig]int Item(uint i,out IDevice d); }
 [InterfaceType(ComInterfaceType.InterfaceIsIUnknown),Guid("D666063F-1587-4E43-81F1-B948E807363F")] public interface IDevice { [PreserveSig]int Activate(ref Guid id,uint ctx,IntPtr p,[MarshalAs(UnmanagedType.IUnknown)]out object o); [PreserveSig]int OpenPropertyStore(uint mode,out IStore s); [PreserveSig]int GetId([MarshalAs(UnmanagedType.LPWStr)]out string id); [PreserveSig]int GetState(out uint s); }
 [InterfaceType(ComInterfaceType.InterfaceIsIUnknown),Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")] public interface IStore { [PreserveSig]int GetCount(out uint c); [PreserveSig]int GetAt(uint i,out PropertyKey k); [PreserveSig]int GetValue(ref PropertyKey k,out PropVariant v); [PreserveSig]int SetValue(ref PropertyKey k,ref PropVariant v); [PreserveSig]int Commit(); }
 [ComImport,Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")] public class PolicyClient {}
 [InterfaceType(ComInterfaceType.InterfaceIsIUnknown),Guid("F8679F50-850A-41CF-9C72-430F290290C8")] public interface IPolicy { [PreserveSig]int GetMixFormat(string id,out IntPtr f); [PreserveSig]int GetDeviceFormat(string id,int d,out IntPtr f); [PreserveSig]int ResetDeviceFormat(string id); [PreserveSig]int SetDeviceFormat(string id,IntPtr e,IntPtr m); [PreserveSig]int GetProcessingPeriod(string id,int d,out long x,out long y); [PreserveSig]int SetProcessingPeriod(string id,IntPtr p); [PreserveSig]int GetShareMode(string id,IntPtr m); [PreserveSig]int SetShareMode(string id,IntPtr m); [PreserveSig]int GetPropertyValue(string id,int s,ref PropertyKey k,out PropVariant v); [PreserveSig]int SetPropertyValue(string id,int s,ref PropertyKey k,ref PropVariant v); [PreserveSig]int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)]string id,Role r); [PreserveSig]int SetEndpointVisibility(string id,int v); }
 [InterfaceType(ComInterfaceType.InterfaceIsIUnknown),Guid("5CDF2C82-841E-4546-9722-0CF74078229A")] public interface IVolume { [PreserveSig]int RegisterControlChangeNotify(IntPtr n); [PreserveSig]int UnregisterControlChangeNotify(IntPtr n); [PreserveSig]int GetChannelCount(out uint n); [PreserveSig]int SetMasterVolumeLevel(float v,IntPtr c); [PreserveSig]int SetMasterVolumeLevelScalar(float v,IntPtr c); [PreserveSig]int GetMasterVolumeLevel(out float v); [PreserveSig]int GetMasterVolumeLevelScalar(out float v); [PreserveSig]int SetChannelVolumeLevel(uint n,float v,IntPtr c); [PreserveSig]int SetChannelVolumeLevelScalar(uint n,float v,IntPtr c); [PreserveSig]int GetChannelVolumeLevel(uint n,out float v); [PreserveSig]int GetChannelVolumeLevelScalar(uint n,out float v); [PreserveSig]int SetMute(int m,IntPtr c); [PreserveSig]int GetMute(out int m); [PreserveSig]int GetVolumeStepInfo(out uint s,out uint n); [PreserveSig]int VolumeStepUp(IntPtr c); [PreserveSig]int VolumeStepDown(IntPtr c); [PreserveSig]int QueryHardwareSupport(out uint m); [PreserveSig]int GetVolumeRange(out float min,out float max,out float step); }
 [InterfaceType(ComInterfaceType.InterfaceIsIUnknown),Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064")] public interface IMeter { [PreserveSig]int GetPeakValue(out float v); [PreserveSig]int GetMeteringChannelCount(out uint n); [PreserveSig]int GetChannelsPeakValues(uint n,[Out]float[] v); [PreserveSig]int QueryHardwareSupport(out uint m); }
 static string Name(IDevice d) { IStore s; d.OpenPropertyStore(0,out s); var k=new PropertyKey{fmtid=new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"),pid=14}; PropVariant v; s.GetValue(ref k,out v); return v.pointer==IntPtr.Zero?"Unknown device":Marshal.PtrToStringUni(v.pointer); }
 static IVolume Volume(IDevice d) { var iid=new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");object o;int rc=d.Activate(ref iid,23,IntPtr.Zero,out o);if(rc!=0)Marshal.ThrowExceptionForHR(rc);return (IVolume)o; }
 public static object[] List() { var e=(IEnum)new Enumerator(); var result=new List<object>(); foreach(Flow f in new[]{Flow.Render,Flow.Capture}) { var defs=new HashSet<string>(); foreach(Role r in new[]{Role.Console,Role.Multimedia,Role.Communications}) { IDevice dd;string did;if(e.GetDefaultAudioEndpoint(f,r,out dd)==0&&dd.GetId(out did)==0)defs.Add(did); } ICollection c;int er=e.EnumAudioEndpoints(f,State.Active,out c);if(er!=0)Marshal.ThrowExceptionForHR(er);uint n;c.GetCount(out n);for(uint i=0;i<n;i++){IDevice d;c.Item(i,out d);string id;d.GetId(out id);float level=0;int mute=0;var v=Volume(d);v.GetMasterVolumeLevelScalar(out level);v.GetMute(out mute);result.Add(new{id=id,name=Name(d),flow=f==Flow.Render?"playback":"recording",isDefault=defs.Count==1&&defs.Contains(id),volume=(uint)Math.Round(Math.Max(0,Math.Min(1,level))*100),muted=mute!=0});}} return result.ToArray(); }
 public static void Set(string id) { var e=(IEnum)new Enumerator();IDevice chosen;int found=e.GetDevice(id,out chosen);if(found!=0)Marshal.ThrowExceptionForHR(found);var p=(IPolicy)new PolicyClient(); foreach(Role r in new[]{Role.Console,Role.Multimedia,Role.Communications}) { int rc=p.SetDefaultEndpoint(id,r); if(rc!=0)Marshal.ThrowExceptionForHR(rc); } foreach(Role r in new[]{Role.Console,Role.Multimedia,Role.Communications}) { bool applied=false;foreach(Flow f in new[]{Flow.Render,Flow.Capture}){IDevice d;string actual;if(e.GetDefaultAudioEndpoint(f,r,out d)==0&&d.GetId(out actual)==0&&actual==id)applied=true;}if(!applied)throw new Exception("Windows did not apply the selected endpoint for "+r+"."); } }
 public static void SetVolume(string id,uint level) { var e=(IEnum)new Enumerator();IDevice d;int rc=e.GetDevice(id,out d);if(rc!=0)Marshal.ThrowExceptionForHR(rc);rc=Volume(d).SetMasterVolumeLevelScalar(Math.Max(0,Math.Min(100,level))/100f,IntPtr.Zero);if(rc!=0)Marshal.ThrowExceptionForHR(rc); }
 public static void SetMute(string id,bool muted) { var e=(IEnum)new Enumerator();IDevice d;int rc=e.GetDevice(id,out d);if(rc!=0)Marshal.ThrowExceptionForHR(rc);rc=Volume(d).SetMute(muted?1:0,IntPtr.Zero);if(rc!=0)Marshal.ThrowExceptionForHR(rc); }
 public static string Test(string id,string flow) { var e=(IEnum)new Enumerator();IDevice d;int rc=e.GetDevice(id,out d);if(rc!=0)Marshal.ThrowExceptionForHR(rc);if(flow=="recording"){var iid=new Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064");object o;rc=d.Activate(ref iid,23,IntPtr.Zero,out o);if(rc!=0)Marshal.ThrowExceptionForHR(rc);var meter=(IMeter)o;float peak=0;for(int i=0;i<30;i++){float value;rc=meter.GetPeakValue(out value);if(rc!=0)Marshal.ThrowExceptionForHR(rc);peak=Math.Max(peak,value);System.Threading.Thread.Sleep(50);}return "Microphone peak: "+Math.Round(peak*100)+"%";}Set(id);const int rate=44100,ms=500,samples=rate*ms/1000;var stream=new System.IO.MemoryStream();var w=new System.IO.BinaryWriter(stream);w.Write(System.Text.Encoding.ASCII.GetBytes("RIFF"));w.Write(36+samples*2);w.Write(System.Text.Encoding.ASCII.GetBytes("WAVEfmt "));w.Write(16);w.Write((short)1);w.Write((short)1);w.Write(rate);w.Write(rate*2);w.Write((short)2);w.Write((short)16);w.Write(System.Text.Encoding.ASCII.GetBytes("data"));w.Write(samples*2);for(int i=0;i<samples;i++)w.Write((short)(Math.Sin(2*Math.PI*660*i/rate)*9000));stream.Position=0;new System.Media.SoundPlayer(stream).PlaySync();return "Test sound played through the selected device"; }
}
'@;"#;

fn ps(script: &str, env: &[(&str, &str)]) -> Result<Output, String> {
    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
    ]);
    for (key, value) in env {
        command.env(key, value);
    }
    command.output().map_err(|e| e.to_string())
}

fn output_result(output: Result<Output, String>) -> ToolResult {
    match output {
        Ok(value) => ToolResult {
            ok: value.status.success(),
            output: String::from_utf8_lossy(&value.stdout).trim().to_string(),
            error: String::from_utf8_lossy(&value.stderr).trim().to_string(),
        },
        Err(error) => ToolResult {
            error,
            ..Default::default()
        },
    }
}

pub fn event_query(query: EventQuery) -> Result<Vec<EventRecord>, String> {
    let allowed_channels = ["Application", "System", "Security"];
    let channels: Vec<&str> = query
        .channels
        .iter()
        .map(String::as_str)
        .filter(|v| allowed_channels.contains(v))
        .collect();
    if channels.is_empty() {
        return Err("Choose at least one event log.".into());
    }
    let limit = query.limit.clamp(1, 500).to_string();
    let levels = query.levels.join(",");
    let script = r#"$ErrorActionPreference='Stop'; $logs=$env:DEVHQ_CHANNELS -split ','; $wanted=$env:DEVHQ_LEVELS -split ','; $needle=$env:DEVHQ_TEXT; Get-WinEvent -FilterHashtable @{LogName=$logs} -MaxEvents ([int]$env:DEVHQ_LIMIT) | Where-Object { (!$wanted[0] -or $wanted -contains $_.LevelDisplayName) -and (!$needle -or $_.ProviderName -match $needle -or $_.Message -match $needle -or [string]$_.Id -eq $needle) } | ForEach-Object { [pscustomobject]@{time=$_.TimeCreated.ToString('o');channel=$_.LogName;level=$_.LevelDisplayName;provider=$_.ProviderName;id=[uint32]$_.Id;message=[string]$_.Message;xml=$_.ToXml()} } | ConvertTo-Json -Compress"#;
    let out = ps(
        script,
        &[
            ("DEVHQ_CHANNELS", &channels.join(",")),
            ("DEVHQ_LEVELS", &levels),
            ("DEVHQ_TEXT", &query.text),
            ("DEVHQ_LIMIT", &limit),
        ],
    )?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().into());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let text = text.trim();
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("Could not read Event Log output: {e}"))?;
    if value.is_array() {
        serde_json::from_value(value).map_err(|e| e.to_string())
    } else {
        serde_json::from_value(value)
            .map(|one| vec![one])
            .map_err(|e| e.to_string())
    }
}

fn normalize_registry_path(path: &str) -> Result<String, String> {
    let path = path.trim().replace('/', "\\");
    let pairs = [
        ("HKCU", "HKEY_CURRENT_USER"),
        ("HKLM", "HKEY_LOCAL_MACHINE"),
        ("HKCR", "HKEY_CLASSES_ROOT"),
        ("HKU", "HKEY_USERS"),
    ];
    for (short, long) in pairs {
        if path.eq_ignore_ascii_case(short) {
            return Ok(long.into());
        }
        if path.len() > short.len()
            && path[..short.len()].eq_ignore_ascii_case(short)
            && path.as_bytes()[short.len()] == b'\\'
        {
            return Ok(format!("{}{}", long, &path[short.len()..]));
        }
        if path.eq_ignore_ascii_case(long)
            || (path.len() > long.len()
                && path[..long.len()].eq_ignore_ascii_case(long)
                && path.as_bytes()[long.len()] == b'\\')
        {
            return Ok(path);
        }
    }
    Err("Registry paths must start with HKCU, HKLM, HKCR, or HKU.".into())
}

pub fn registry_list(path: &str) -> Result<Vec<RegistryItem>, String> {
    let path = normalize_registry_path(path)?;
    let script = r#"$ErrorActionPreference='Stop'; $p='Registry::'+$env:DEVHQ_REG_PATH; $rows=@(); Get-ChildItem -LiteralPath $p -ErrorAction SilentlyContinue | ForEach-Object { $rows += [pscustomobject]@{name=$_.PSChildName;kind='KEY';value='';isKey=$true} }; $key=Get-Item -LiteralPath $p; foreach($n in $key.GetValueNames()){ $k=[string]$key.GetValueKind($n); $v=$key.GetValue($n,$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); if($v -is [array]){$v=$v -join '\0'}; $rows += [pscustomobject]@{name=if($n){$n}else{'(Default)'};kind=$k;value=[string]$v;isKey=$false} }; $rows | ConvertTo-Json -Compress"#;
    let out = ps(script, &[("DEVHQ_REG_PATH", &path)])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().into());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let text = text.trim();
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let value: serde_json::Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    if value.is_array() {
        serde_json::from_value(value).map_err(|e| e.to_string())
    } else {
        serde_json::from_value(value)
            .map(|v| vec![v])
            .map_err(|e| e.to_string())
    }
}

pub fn registry_change(change: RegistryChange) -> ToolResult {
    let path = match normalize_registry_path(&change.path) {
        Ok(v) => v,
        Err(error) => {
            return ToolResult {
                error,
                ..Default::default()
            }
        }
    };
    let name = if change.name == "(Default)" {
        ""
    } else {
        &change.name
    };
    if change.delete {
        let mut command = Command::new("reg.exe");
        command.args(["delete", &path, "/f"]);
        if !name.is_empty() {
            command.args(["/v", name]);
        } else {
            command.arg("/ve");
        }
        return output_result(command.output().map_err(|e| e.to_string()));
    }
    let kind = match change.kind.to_ascii_uppercase().as_str() {
        "STRING" => "REG_SZ",
        "EXPANDSTRING" => "REG_EXPAND_SZ",
        "DWORD" => "REG_DWORD",
        "QWORD" => "REG_QWORD",
        "MULTISTRING" => "REG_MULTI_SZ",
        "BINARY" => "REG_BINARY",
        other => other,
    }
    .to_string();
    let kinds = [
        "REG_SZ",
        "REG_EXPAND_SZ",
        "REG_DWORD",
        "REG_QWORD",
        "REG_MULTI_SZ",
        "REG_BINARY",
    ];
    if !kinds.contains(&kind.as_str()) {
        return ToolResult {
            error: "Unsupported registry value type.".into(),
            ..Default::default()
        };
    }
    let mut command = Command::new("reg.exe");
    command.args(["add", &path, "/f", "/t", &kind, "/d", &change.value]);
    if !name.is_empty() {
        command.args(["/v", name]);
    } else {
        command.arg("/ve");
    }
    output_result(command.output().map_err(|e| e.to_string()))
}

pub fn system_report() -> Result<SystemReport, String> {
    let script = r#"$ErrorActionPreference='Stop'; $rows=@(); $vars=@(); foreach($scope in 'User','Machine'){ $raw=[Environment]::GetEnvironmentVariable('Path',$scope); $seen=@{}; $i=0; foreach($part in ($raw -split ';')){ if(!$part){continue}; $i++; $expanded=[Environment]::ExpandEnvironmentVariables($part); $key=$expanded.TrimEnd('\').ToLowerInvariant(); $status=if($seen[$key]){'duplicate'}elseif($expanded -match '%[^%]+%'){'unresolved'}elseif(!(Test-Path -LiteralPath $expanded)){'missing'}else{'ok'}; $seen[$key]=$true; $rows += [pscustomobject]@{scope=$scope.ToLower();value=$part;expanded=$expanded;status=$status;detail=if($status -eq 'ok'){''}elseif($status -eq 'duplicate'){'an earlier entry already wins'}elseif($status -eq 'unresolved'){'contains an undefined variable'}else{'folder does not exist'}} }; [Environment]::GetEnvironmentVariables($scope).GetEnumerator() | Sort-Object Key | ForEach-Object { if($_.Key -ne 'Path'){$vars += [pscustomobject]@{scope=$scope.ToLower();name=[string]$_.Key;value=[string]$_.Value}} } }; [pscustomobject]@{paths=$rows;variables=$vars}|ConvertTo-Json -Depth 4 -Compress"#;
    let out = ps(script, &[])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().into());
    }
    serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())
}

pub fn log_tail(path: &str, line_count: u32) -> Result<LogTail, String> {
    use std::io::{BufRead, BufReader};
    let file = std::fs::File::open(path).map_err(|e| format!("Could not open the log: {e}"))?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("Choose a file to tail.".into());
    }
    // A bounded ring keeps even a multi-gigabyte log from becoming a giant IPC
    // response. Reading is off-thread; only the requested tail crosses to JS.
    let cap = line_count.clamp(10, 2000) as usize;
    let mut tail = std::collections::VecDeque::with_capacity(cap);
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|e| format!("Could not read the log: {e}"))?;
        if tail.len() == cap {
            tail.pop_front();
        }
        tail.push_back(line);
    }
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0);
    Ok(LogTail {
        path: path.into(),
        size: metadata.len(),
        modified_ms,
        lines: tail.into(),
    })
}

pub fn lock_inspect(path: &str) -> Result<Vec<LockProcess>, String> {
    if !std::path::Path::new(path).exists() {
        return Err("That file or folder does not exist.".into());
    }
    // Restart Manager is the same Windows facility installers use before they
    // say which applications must close. Unlike a filename guess from the
    // process table, it asks the kernel which registered processes hold it.
    let script = r#"$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class DevHQLocks {
 [StructLayout(LayoutKind.Sequential)] struct RM_UNIQUE_PROCESS { public int pid; public System.Runtime.InteropServices.ComTypes.FILETIME start; }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct RM_PROCESS_INFO { public RM_UNIQUE_PROCESS Process; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=256)] public string app; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=64)] public string service; public uint type; public uint status; public uint session; [MarshalAs(UnmanagedType.Bool)] public bool restartable; }
 [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint h,int flags,string key);
 [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
 [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint h,uint nf,string[] files,uint na,IntPtr apps,uint ns,string[] services);
 [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] static extern int RmGetList(uint h,out uint needed,ref uint count,[In,Out] RM_PROCESS_INFO[] info,ref uint reasons);
 public static object[] Find(string path) { uint h; string key=Guid.NewGuid().ToString("N"); int rc=RmStartSession(out h,0,key); if(rc!=0) throw new Exception("RmStartSession: "+rc); try { rc=RmRegisterResources(h,1,new[]{path},0,IntPtr.Zero,0,null); if(rc!=0) throw new Exception("RmRegisterResources: "+rc); uint need=0,count=0,reasons=0; rc=RmGetList(h,out need,ref count,null,ref reasons); if(rc==0)return new object[0]; if(rc!=234)throw new Exception("RmGetList: "+rc); var rows=new RM_PROCESS_INFO[need]; count=need; rc=RmGetList(h,out need,ref count,rows,ref reasons); if(rc!=0)throw new Exception("RmGetList: "+rc); var result=new List<object>(); for(int i=0;i<count;i++) result.Add(new {pid=(uint)rows[i].Process.pid,name=rows[i].app??"",service=rows[i].service??"",applicationType=rows[i].type.ToString(),restartable=rows[i].restartable}); return result.ToArray(); } finally { RmEndSession(h); } }
}
'@; [DevHQLocks]::Find($env:DEVHQ_LOCK_PATH) | ConvertTo-Json -Compress"#;
    let out = ps(script, &[("DEVHQ_LOCK_PATH", path)])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().into());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let text = text.trim();
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| format!("Could not read Restart Manager output: {e}"))?;
    if value.is_array() {
        serde_json::from_value(value).map_err(|e| e.to_string())
    } else {
        serde_json::from_value(value)
            .map(|v| vec![v])
            .map_err(|e| e.to_string())
    }
}

pub fn audio_devices() -> Result<Vec<AudioDevice>, String> {
    let script = format!("$ErrorActionPreference='Stop'; {CORE_AUDIO_CS} [DevHQAudio]::List() | ConvertTo-Json -Compress");
    let out = ps(&script, &[])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().into());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let text = text.trim();
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("Could not read audio devices: {e}"))?;
    if value.is_array() {
        serde_json::from_value(value).map_err(|e| e.to_string())
    } else {
        serde_json::from_value(value)
            .map(|v| vec![v])
            .map_err(|e| e.to_string())
    }
}

pub fn audio_set_default(id: &str) -> ToolResult {
    if id.trim().is_empty() {
        return ToolResult {
            error: "Choose an audio device.".into(),
            ..Default::default()
        };
    }
    let script=format!("$ErrorActionPreference='Stop'; {CORE_AUDIO_CS} [DevHQAudio]::Set($env:DEVHQ_AUDIO_ID); 'Default endpoint changed for all three roles'");
    output_result(ps(&script, &[("DEVHQ_AUDIO_ID", id)]))
}

pub fn audio_set_volume(id: &str, volume: u32) -> ToolResult {
    if id.trim().is_empty() {
        return ToolResult { error: "Choose an audio device.".into(), ..Default::default() };
    }
    let level = volume.min(100).to_string();
    let script=format!("$ErrorActionPreference='Stop'; {CORE_AUDIO_CS} [DevHQAudio]::SetVolume($env:DEVHQ_AUDIO_ID,[uint32]$env:DEVHQ_AUDIO_VOLUME); 'Volume changed to '+$env:DEVHQ_AUDIO_VOLUME+'%'");
    output_result(ps(&script, &[("DEVHQ_AUDIO_ID", id), ("DEVHQ_AUDIO_VOLUME", &level)]))
}

pub fn audio_set_muted(id: &str, muted: bool) -> ToolResult {
    if id.trim().is_empty() {
        return ToolResult { error: "Choose an audio device.".into(), ..Default::default() };
    }
    let state = if muted { "true" } else { "false" };
    let script=format!("$ErrorActionPreference='Stop'; {CORE_AUDIO_CS} [DevHQAudio]::SetMute($env:DEVHQ_AUDIO_ID,[bool]::Parse($env:DEVHQ_AUDIO_MUTED)); if([bool]::Parse($env:DEVHQ_AUDIO_MUTED)){{'Device muted'}}else{{'Device unmuted'}}");
    output_result(ps(&script, &[("DEVHQ_AUDIO_ID", id), ("DEVHQ_AUDIO_MUTED", state)]))
}

pub fn audio_test(id: &str, flow: &str) -> ToolResult {
    if id.trim().is_empty() || !matches!(flow, "playback" | "recording") {
        return ToolResult { error: "Choose an audio device to test.".into(), ..Default::default() };
    }
    let script=format!("$ErrorActionPreference='Stop'; {CORE_AUDIO_CS} [DevHQAudio]::Test($env:DEVHQ_AUDIO_ID,$env:DEVHQ_AUDIO_FLOW)");
    output_result(ps(&script, &[("DEVHQ_AUDIO_ID", id), ("DEVHQ_AUDIO_FLOW", flow)]))
}

pub fn repair_targets(id: &str) -> Result<Vec<RepairTarget>, String> {
    let (script, env) = match id {
        "radio" => (
            r#"[Console]::OutputEncoding=[Text.Encoding]::UTF8;$a=Get-NetAdapter -Physical -ErrorAction SilentlyContinue|ForEach-Object{[pscustomobject]@{id='net:'+ $_.Name;name=$_.InterfaceDescription;detail=$_.Name+' · '+$_.LinkSpeed;status=$_.Status}};$b=Get-PnpDevice -Class Bluetooth -Status OK -ErrorAction SilentlyContinue|ForEach-Object{[pscustomobject]@{id='pnp:'+ $_.InstanceId;name=$_.FriendlyName;detail='Bluetooth device';status=$_.Status}};@($a)+@($b)|ConvertTo-Json -Compress"#,
            vec![],
        ),
        "usb" => (
            r#"Get-PnpDevice -Class USB -PresentOnly -ErrorAction Stop|Where-Object FriendlyName|ForEach-Object{[pscustomobject]@{id=$_.InstanceId;name=$_.FriendlyName;detail=$_.Class;status=$_.Status}}|ConvertTo-Json -Compress"#,
            vec![],
        ),
        "bounds" => ("[DevHQWindows]::List()|ConvertTo-Json -Compress", vec![]),
        "audio" => (
            r#"Get-Service Audiosrv,AudioEndpointBuilder -ErrorAction Stop|ForEach-Object{[pscustomobject]@{id=$_.Name;name=$_.DisplayName;detail=($_.DependentServices.Count.ToString()+' dependent services');status=[string]$_.Status}}|ConvertTo-Json -Compress"#,
            vec![],
        ),
        "gpu" => (
            r#"$g=Get-CimInstance Win32_VideoController|ForEach-Object{[pscustomobject]@{id=$_.PNPDeviceID;name=$_.Name;detail=('driver '+$_.DriverVersion+' · '+[math]::Round($_.AdapterRAM/1GB,1)+' GB');status=$_.Status}};$m=Get-PnpDevice -Class Monitor -PresentOnly -ErrorAction SilentlyContinue|ForEach-Object{[pscustomobject]@{id=$_.InstanceId;name=$_.FriendlyName;detail='display endpoint';status=$_.Status}};@($g)+@($m)|ConvertTo-Json -Compress"#,
            vec![],
        ),
        "wifi" => (
            r#"[Console]::OutputEncoding=[Text.Encoding]::UTF8;$wifi=@{};$cur=$null;try{foreach($line in (netsh wlan show interfaces)){if($line -match '^\s*Name\s*:\s*(.+)$'){$cur=$Matches[1].Trim();$wifi[$cur]=@{}}elseif($cur -and $line -match '^\s*SSID\s*:\s*(.+)$'){$wifi[$cur].SSID=$Matches[1].Trim()}elseif($cur -and $line -match '^\s*Signal\s*:\s*(.+)$'){$wifi[$cur].Signal=$Matches[1].Trim()}}}catch{};$rows=@([pscustomobject]@{id='all';name='Every connection on this machine';detail='Restarts each physical adapter, flushes DNS, clears ARP, renews every DHCP lease';status='full cycle'});foreach($a in @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue)){$ip=@(Get-NetIPAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue|ForEach-Object IPAddress)[0];$gw=@(Get-NetRoute -InterfaceIndex $a.ifIndex -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue|ForEach-Object NextHop)[0];$bits=@($a.Name);if($wifi.ContainsKey($a.Name)){if($wifi[$a.Name].SSID){$bits+=('SSID '+$wifi[$a.Name].SSID)};if($wifi[$a.Name].Signal){$bits+=('signal '+$wifi[$a.Name].Signal)}}else{$bits+=[string]$a.LinkSpeed};$bits+=$(if($ip){'IP '+$ip}else{'no IPv4'});if($gw){$bits+=('gateway '+$gw)};$dnsServers=@(Get-DnsClientServerAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue|ForEach-Object ServerAddresses|Where-Object{$_});if($dnsServers.Count){$bits+=('DNS '+($dnsServers -join ', '))};$rows+=[pscustomobject]@{id='net:'+$a.Name;name=$a.InterfaceDescription;detail=($bits -join ' · ');status=[string]$a.Status}};$rows|ConvertTo-Json -Compress"#,
            vec![],
        ),
        "net" => (
            r#"@([pscustomobject]@{id='dns';name='Flush resolver cache';detail='ipconfig /flushdns';status='step 1'},[pscustomobject]@{id='winsock';name='Reset Winsock catalog';detail='netsh winsock reset';status='step 2'},[pscustomobject]@{id='arp';name='Clear ARP table';detail='arp -d *';status='step 3'},[pscustomobject]@{id='dhcp';name='Renew DHCP lease';detail='ipconfig /renew';status='step 4'})|ConvertTo-Json -Compress"#,
            vec![],
        ),
        "shell" => (
            r#"$icon=Get-Item (Join-Path $env:LOCALAPPDATA 'IconCache.db') -ErrorAction SilentlyContinue;$thumb=@(Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Explorer\thumbcache_*.db') -ErrorAction SilentlyContinue);$exp=@(Get-Process explorer -ErrorAction SilentlyContinue);@([pscustomobject]@{id='explorer';name='Windows Explorer';detail=($exp.Count.ToString()+' process instances');status=if($exp){'running'}else{'stopped'}},[pscustomobject]@{id='icons';name='Icon cache';detail=if($icon){[math]::Round($icon.Length/1MB,1).ToString()+' MB'}else{'not present'};status='cache'},[pscustomobject]@{id='thumbs';name='Thumbnail databases';detail=([math]::Round(($thumb|Measure-Object Length -Sum).Sum/1MB,1).ToString()+' MB · '+$thumb.Count+' files');status='cache'})|ConvertTo-Json -Compress"#,
            vec![],
        ),
        "spooler" => (
            r#"$s=Get-Service Spooler -ErrorAction Stop;$jobs=@(Get-Printer|ForEach-Object{Get-PrintJob -PrinterName $_.Name -ErrorAction SilentlyContinue});@([pscustomobject]@{id='service';name=$s.DisplayName;detail=($jobs.Count.ToString()+' queued jobs');status=[string]$s.Status})+@($jobs|ForEach-Object{[pscustomobject]@{id=[string]$_.ID;name=$_.DocumentName;detail=$_.PrinterName;status=[string]$_.JobStatus}})|ConvertTo-Json -Compress"#,
            vec![],
        ),
        _ => return Ok(Vec::new()),
    };
    let full = if id == "bounds" {
        format!("$ErrorActionPreference='Stop';{WINDOW_BOUNDS_CS}{script}")
    } else {
        format!("$ErrorActionPreference='Stop';{script}")
    };
    let out = ps(&full, &env)?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().into());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let text = text.trim();
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let value: serde_json::Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    if value.is_array() {
        serde_json::from_value(value).map_err(|e| e.to_string())
    } else {
        serde_json::from_value(value)
            .map(|v| vec![v])
            .map_err(|e| e.to_string())
    }
}

/// Everything the Wi-Fi reset does, in the order Windows wants it: bounce the
/// adapter, wait for it to associate again, drop the caches that sit between it
/// and the internet, take a fresh DHCP lease, then ask every resolver in play
/// whether it still answers.
const WIFI_RESET_PS: &str = r#"
# Run by DevHQ, elevated when Windows will grant it. Native tools here report
# trouble on stderr and half of them need administrator rights, so the script
# never stops at the first refusal: it does what it can and says, step by step,
# what happened. The report is written to -Report because an elevated process
# has no pipe back to DevHQ.
param([string] $Scope, [string] $Name, [string] $Report)
$ErrorActionPreference = 'Continue'
$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
[Console]::OutputEncoding = [Text.Encoding]::UTF8
function Write-Report([string] $line) {
  if ($Report) { Set-Content -LiteralPath $Report -Value $line -Encoding UTF8 } else { $line }
}
$names = if ($Scope -eq 'all') {
  @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object Status -ne 'Disabled' | ForEach-Object Name)
} else { @($Name) | Where-Object { $_ } }
if (-not $names -or $names.Count -eq 0) { Write-Report 'ERROR: There is no connection to reset.'; exit 1 }
$names = @(Get-NetAdapter -Name $names -ErrorAction SilentlyContinue | ForEach-Object Name)
if ($names.Count -eq 0) { Write-Report 'ERROR: That connection is not on this machine any more.'; exit 1 }
function Invoke-Native([scriptblock] $step) {
  try { & $step 2>&1 | Out-Null; return $LASTEXITCODE -eq 0 } catch { return $false }
}
$done = @()
$notes = @()
$restarted = @()
foreach ($n in $names) {
  try { Restart-NetAdapter -Name $n -Confirm:$false -ErrorAction Stop; $restarted += $n }
  catch { $notes += ('could not restart ' + $n + ': ' + $_.Exception.Message.Trim()) }
}
if ($restarted.Count) {
  $done += 'restarted ' + ($restarted -join ', ')
  $deadline = (Get-Date).AddSeconds(25)
  while ((Get-Date) -lt $deadline) {
    if (@(Get-NetAdapter -Name $names -ErrorAction SilentlyContinue | Where-Object Status -eq 'Up').Count -ge 1) { break }
    Start-Sleep -Milliseconds 500
  }
}
if (Invoke-Native { ipconfig /flushdns }) { $done += 'flushed the DNS cache' } else { $notes += 'could not flush the DNS cache' }
if (Invoke-Native { arp -d * }) { $done += 'cleared the ARP cache' } else { $notes += 'could not clear the ARP cache' }
$renewed = @()
foreach ($n in $names) {
  [void](Invoke-Native { ipconfig /release $n })
  if (Invoke-Native { ipconfig /renew $n }) { $renewed += $n }
}
if ($renewed.Count) { $done += 'renewed the DHCP lease' } else { $notes += 'no DHCP lease was renewed' }
$ip = @(Get-NetIPAddress -InterfaceAlias $names -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object IPAddress)[0]
$gw = @(Get-NetRoute -InterfaceAlias $names -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | ForEach-Object NextHop)[0]
$gwUp = if ($gw) { [bool](Test-Connection -ComputerName $gw -Count 1 -Quiet -ErrorAction SilentlyContinue) } else { $false }
$online = [bool](Test-Connection -ComputerName 1.1.1.1 -Count 2 -Quiet -ErrorAction SilentlyContinue)
# Which resolvers this connection actually uses, and whether each one answers.
# A name that resolves through 1.1.1.1 but not through the router says the fault
# is the router's resolver rather than the connection.
$servers = @(Get-DnsClientServerAddress -InterfaceAlias $names -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object ServerAddresses | Where-Object { $_ } | Select-Object -Unique)
function Test-Resolver($server) {
  $label = if ($server) { $server } else { 'the system resolver' }
  $watch = [Diagnostics.Stopwatch]::StartNew()
  try {
    $answer = if ($server) { Resolve-DnsName -Name www.microsoft.com -Type A -Server $server -DnsOnly -QuickTimeout -ErrorAction Stop }
              else { Resolve-DnsName -Name www.microsoft.com -Type A -DnsOnly -QuickTimeout -ErrorAction Stop }
    $watch.Stop()
    if ($answer) { return ($label + ' answered in ' + [int]$watch.ElapsedMilliseconds + ' ms') }
  } catch { }
  $watch.Stop()
  return ($label + ' did not answer')
}
$parts = @()
$parts += $(if ($done.Count) { $done -join ', ' } else { 'nothing could be reset' })
$parts += $(if ($ip) { 'IPv4 ' + $ip } else { 'no IPv4 address' })
$parts += $(if ($gw) { 'gateway ' + $gw + ' ' + $(if ($gwUp) { 'answers' } else { 'is silent' }) } else { 'no gateway' })
$parts += $(if ($online) { 'internet reachable' } else { 'internet unreachable' })
$parts += $(if ($servers.Count) { 'DNS servers ' + ($servers -join ', ') } else { 'no DNS server is configured' })
$parts += Test-Resolver $null
foreach ($s in $servers) { $parts += Test-Resolver $s }
if ($servers -notcontains '1.1.1.1') { $parts += Test-Resolver '1.1.1.1' }
$parts += $(if ($elevated) { 'ran as administrator' } else { 'ran without administrator rights' })
$parts += $notes
Write-Report ($parts -join ' · ')
"#;

/// Runs the staged reset as an administrator, the way the hosts file asks for
/// the one write it cannot do: a single `runas` prompt for this one action, a
/// hidden window, and a bounded wait for it to finish.
#[cfg(windows)]
fn run_elevated(params: &str) -> Result<(), String> {
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    use windows::Win32::System::Threading::WaitForSingleObject;
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let params = HSTRING::from(params);
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: w!("runas"),
        lpFile: w!("powershell.exe"),
        lpParameters: PCWSTR(params.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    unsafe {
        // ShellExecuteExW wants COM on the calling thread, and this runs on a
        // blocking worker that has none of its own.
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        ShellExecuteExW(&mut info)
            .map_err(|_| "The administrator prompt was declined".to_string())?;
        if info.hProcess.is_invalid() {
            return Err("Windows did not start the elevated reset".into());
        }
        WaitForSingleObject(info.hProcess, 180_000);
        let _ = CloseHandle(info.hProcess);
    }
    Ok(())
}

#[cfg(not(windows))]
fn run_elevated(_params: &str) -> Result<(), String> {
    Err("Only Windows connections can be reset".into())
}

/// Reset one connection, or every physical adapter on the machine when the
/// target is `all`.
///
/// The two steps that matter most - bouncing the adapter and clearing the ARP
/// cache - need administrator rights, and DevHQ never runs elevated. So the
/// script is staged beside the report it writes and started through `runas`:
/// one prompt, for this one action. Declining is not the end of it; the same
/// script then runs unelevated, does what it can, and names what was refused.
fn wifi_reset(target: &str) -> ToolResult {
    let (scope, name) = if target == "all" {
        ("all", "")
    } else if let Some(rest) = target.strip_prefix("net:") {
        ("one", rest)
    } else {
        return ToolResult {
            error: "Choose a connection to reset.".into(),
            ..Default::default()
        };
    };
    if name.contains('"') {
        return ToolResult {
            error: "That adapter name cannot be handed to Windows safely.".into(),
            ..Default::default()
        };
    }
    let stamp = std::process::id();
    let script = std::env::temp_dir().join(format!("devhq-wifi-reset-{stamp}.ps1"));
    let report = std::env::temp_dir().join(format!("devhq-wifi-reset-{stamp}.txt"));
    let _ = std::fs::remove_file(&report);
    // PowerShell 5.1 reads a .ps1 without a byte-order mark in the ANSI code
    // page, which would turn every non-ASCII character in the report into
    // mojibake. The mark is what makes it read the file as UTF-8.
    let staged = format!("\u{feff}{WIFI_RESET_PS}");
    if let Err(error) = std::fs::write(&script, staged) {
        return ToolResult {
            error: format!("Could not stage the reset: {error}"),
            ..Default::default()
        };
    }
    let args = [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        &script.display().to_string(),
        "-Scope",
        scope,
        "-Name",
        name,
        "-Report",
        &report.display().to_string(),
    ]
    .map(str::to_string);
    let run_plain = || {
        Command::new("powershell.exe")
            .args(&args)
            .output()
            .map(|_| ())
            .map_err(|error| error.to_string())
    };
    let mut declined = false;
    let started = if crate::dns::is_elevated() {
        run_plain()
    } else {
        let quoted = args
            .iter()
            .map(|arg| {
                if arg.contains(' ') {
                    format!("\"{arg}\"")
                } else {
                    arg.clone()
                }
            })
            .collect::<Vec<_>>()
            .join(" ");
        match run_elevated(&quoted) {
            Ok(()) => Ok(()),
            Err(_) => {
                declined = true;
                run_plain()
            }
        }
    };
    let _ = std::fs::remove_file(&script);
    if let Err(error) = started {
        let _ = std::fs::remove_file(&report);
        return ToolResult {
            error: format!("The reset could not be started: {error}"),
            ..Default::default()
        };
    }
    let written = std::fs::read_to_string(&report).unwrap_or_default();
    let _ = std::fs::remove_file(&report);
    let written = written.trim_start_matches('\u{feff}').trim();
    if let Some(message) = written.strip_prefix("ERROR: ") {
        return ToolResult {
            error: message.trim().to_string(),
            ..Default::default()
        };
    }
    if written.is_empty() {
        return ToolResult {
            error: "The reset finished without reporting anything back.".into(),
            ..Default::default()
        };
    }
    let mut output = written.to_string();
    if declined {
        output.push_str(" · administrator was declined, so only the steps that do not need it ran");
    }
    ToolResult {
        ok: true,
        output,
        error: String::new(),
    }
}

pub fn repair_target_run(id: &str, target: &str) -> ToolResult {
    if target.trim().is_empty() {
        return ToolResult {
            error: "Choose an item first.".into(),
            ..Default::default()
        };
    }
    if id == "wifi" {
        return wifi_reset(target);
    }
    let (script, key, value) = match id {
        "radio" if target.starts_with("net:") => (
            "Restart-NetAdapter -Name $env:DEVHQ_TARGET -Confirm:$false",
            "DEVHQ_TARGET",
            &target[4..],
        ),
        "radio" if target.starts_with("pnp:") => (
            "pnputil /restart-device $env:DEVHQ_TARGET",
            "DEVHQ_TARGET",
            &target[4..],
        ),
        "usb" => (
            "pnputil /restart-device $env:DEVHQ_TARGET",
            "DEVHQ_TARGET",
            target,
        ),
        "bounds" => (
            "[DevHQWindows]::Pull([long]$env:DEVHQ_TARGET)",
            "DEVHQ_TARGET",
            target,
        ),
        _ => {
            return ToolResult {
                error: "Unsupported repair target.".into(),
                ..Default::default()
            }
        }
    };
    let prefix = if id == "bounds" { WINDOW_BOUNDS_CS } else { "" };
    output_result(ps(
        &format!("$ErrorActionPreference='Stop';{prefix}{script};'Completed'"),
        &[(key, value)],
    ))
}

pub fn repair_run(id: &str) -> ToolResult {
    let script=match id {
        "audio" => "Restart-Service Audiosrv,AudioEndpointBuilder -Force",
        "gpu" => "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class Keys { [DllImport(\"user32.dll\")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e); }'; 0x5B,0x11,0x10,0x42 | ForEach-Object {[Keys]::keybd_event($_,0,0,[UIntPtr]::Zero)}; 0x42,0x10,0x11,0x5B | ForEach-Object {[Keys]::keybd_event($_,0,2,[UIntPtr]::Zero)}",
        "net" => "ipconfig /flushdns; netsh winsock reset; arp -d *; ipconfig /renew",
        "shell" => "Stop-Process -Name explorer -Force; Remove-Item \"$env:LOCALAPPDATA\\IconCache.db\" -Force -ErrorAction SilentlyContinue; Remove-Item \"$env:LOCALAPPDATA\\Microsoft\\Windows\\Explorer\\thumbcache_*.db\" -Force -ErrorAction SilentlyContinue; Start-Process explorer.exe",
        "spooler" => "Stop-Service Spooler -Force; Remove-Item \"$env:SystemRoot\\System32\\spool\\PRINTERS\\*\" -Force -ErrorAction SilentlyContinue; Start-Service Spooler",
        _ => return ToolResult { error: "Unknown repair action.".into(), ..Default::default() },
    };
    output_result(ps(
        &format!("$ErrorActionPreference='Stop'; {script}; 'Completed'"),
        &[],
    ))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn tail_is_bounded() {
        let path = format!("{}\\Cargo.toml", env!("CARGO_MANIFEST_DIR"));
        let result = log_tail(&path, 10).expect("Cargo.toml should be readable");
        assert!(!result.lines.is_empty());
        assert!(result.lines.len() <= 10);
    }

    #[test]
    fn restart_manager_inspection_runs() {
        let path = format!("{}\\Cargo.toml", env!("CARGO_MANIFEST_DIR"));
        lock_inspect(&path).expect("Restart Manager should inspect an existing file");
    }

    #[test]
    fn system_environment_is_real() {
        let report = system_report().expect("environment scan should finish");
        assert!(!report.paths.is_empty());
        assert!(!report.variables.is_empty());
    }

    #[test]
    fn core_audio_enumeration_runs() {
        audio_devices().expect("Core Audio endpoint enumeration should finish");
    }

    #[test]
    fn repair_target_enumeration_runs() {
        for id in [
            "bounds", "radio", "usb", "audio", "gpu", "net", "wifi", "shell", "spooler",
        ] {
            repair_targets(id).unwrap_or_else(|error| panic!("{id} enumeration failed: {error}"));
        }
    }

    #[test]
    fn event_records_include_native_xml() {
        let rows = event_query(EventQuery {
            channels: vec!["System".into()],
            levels: vec![],
            text: String::new(),
            limit: 2,
        })
        .expect("System Event Log should be readable");
        assert!(rows.iter().all(|row| row.xml.contains("<Event")));
    }
}
