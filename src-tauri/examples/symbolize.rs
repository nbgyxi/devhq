//! Turn the frames of a `stack` line in the health log into function names.
//!
//! The log writes frames as `wint+0x1234` because the running app has no
//! symbols for anything and no business loading a 278 MB PDB to find out.
//! This does it afterwards, against the build the log came from:
//!
//! ```text
//! cargo run --example symbolize -- target/debug/wint.exe 0x1c76d74 0x122f2 ...
//! ```
//!
//! Offsets are module-relative, exactly as the log prints them, and anything
//! that is not a `0x...` argument is ignored — so a whole `stack` line can be
//! pasted in and the `wint+` frames pulled out of it.

use windows::core::PCWSTR;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Diagnostics::Debug::{
    SymFromAddrW, SymGetLineFromAddrW64, SymInitialize, SymLoadModuleExW, SymSetOptions,
    IMAGEHLP_LINEW64, SYMBOL_INFOW, SYMOPT_LOAD_LINES, SYMOPT_UNDNAME,
};
use windows::Win32::System::Threading::GetCurrentProcess;

/// Anywhere the module can be pretended to live; only the offsets matter.
const BASE: u64 = 0x1000_0000;
const MAX_SYM_NAME: usize = 2000;

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(exe) = args.next() else {
        eprintln!("usage: symbolize <exe> <offset>...  (offsets as 0x… , or a whole stack line)");
        std::process::exit(2);
    };
    let offsets: Vec<u64> = args
        .flat_map(|arg| {
            arg.split(|c: char| !c.is_ascii_alphanumeric() && c != 'x')
                .filter_map(|word| word.strip_prefix("0x"))
                .filter_map(|hex| u64::from_str_radix(hex, 16).ok())
                .collect::<Vec<_>>()
        })
        .collect();
    if offsets.is_empty() {
        eprintln!("no 0x… offsets in the arguments");
        std::process::exit(2);
    }

    let process: HANDLE = unsafe { GetCurrentProcess() };
    unsafe {
        SymSetOptions(SYMOPT_UNDNAME | SYMOPT_LOAD_LINES);
        SymInitialize(process, None, false).expect("dbghelp would not start");
        let path = wide(&exe);
        let loaded = SymLoadModuleExW(
            process,
            None,
            PCWSTR(path.as_ptr()),
            PCWSTR::null(),
            BASE,
            0,
            None,
            None,
        );
        if loaded == 0 {
            eprintln!("could not load symbols for {exe} — is the .pdb beside it?");
            std::process::exit(1);
        }
    }

    for offset in offsets {
        let address = BASE + offset;
        let mut buffer = vec![0u8; std::mem::size_of::<SYMBOL_INFOW>() + MAX_SYM_NAME * 2];
        let info = buffer.as_mut_ptr().cast::<SYMBOL_INFOW>();
        let mut displacement = 0u64;
        let name = unsafe {
            (*info).SizeOfStruct = std::mem::size_of::<SYMBOL_INFOW>() as u32;
            (*info).MaxNameLen = MAX_SYM_NAME as u32;
            if SymFromAddrW(process, address, Some(&mut displacement), info).is_ok() {
                let chars = std::slice::from_raw_parts((*info).Name.as_ptr(), MAX_SYM_NAME);
                let end = chars.iter().position(|&c| c == 0).unwrap_or(0);
                Some(String::from_utf16_lossy(&chars[..end]))
            } else {
                None
            }
        };
        let mut line = IMAGEHLP_LINEW64 {
            SizeOfStruct: std::mem::size_of::<IMAGEHLP_LINEW64>() as u32,
            ..Default::default()
        };
        let mut line_displacement = 0u32;
        let at = unsafe {
            if SymGetLineFromAddrW64(process, address, &mut line_displacement, &mut line).is_ok() {
                let file = PCWSTR(line.FileName.0).to_string().unwrap_or_default();
                Some(format!("{file}:{}", line.LineNumber))
            } else {
                None
            }
        };
        match (name, at) {
            (Some(name), Some(at)) => println!("0x{offset:x}  {name} +{displacement}  [{at}]"),
            (Some(name), None) => println!("0x{offset:x}  {name} +{displacement}"),
            (None, Some(at)) => println!("0x{offset:x}  ?  [{at}]"),
            (None, None) => println!("0x{offset:x}  (no symbol)"),
        }
    }
}
