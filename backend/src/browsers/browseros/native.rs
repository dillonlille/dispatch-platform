//! Native input on the worker's private Xvfb display. No host display or helper process.
use crate::{Error, Result, ensure};
use serde_json::{Value, json};
use std::{
    ffi::{CStr, c_int, c_uint, c_ulong, c_void},
    time::Duration,
};

struct Library(*mut c_void);
impl Library {
    fn open(name: &CStr) -> Result<Self> {
        let handle = unsafe { libc::dlopen(name.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
        ensure(!handle.is_null(), "browser_interaction_required", 503)?;
        Ok(Self(handle))
    }
    // Each caller supplies the exact C ABI signature from Xlib/XTest.
    unsafe fn symbol<T: Copy>(&self, name: &CStr) -> Result<T> {
        let address = unsafe { libc::dlsym(self.0, name.as_ptr()) };
        ensure(!address.is_null(), "browser_interaction_required", 503)?;
        Ok(unsafe { std::mem::transmute_copy(&address) })
    }
}
impl Drop for Library {
    fn drop(&mut self) {
        unsafe {
            libc::dlclose(self.0);
        }
    }
}
type Display = *mut c_void;
struct Input {
    display: Display,
    close: unsafe extern "C" fn(Display) -> c_int,
    sync: unsafe extern "C" fn(Display, c_int) -> c_int,
    code: unsafe extern "C" fn(Display, c_ulong) -> u8,
    symbol: unsafe extern "C" fn(Display, u8, c_int, c_int) -> c_ulong,
    key: unsafe extern "C" fn(Display, c_uint, c_int, c_ulong) -> c_int,
    button: unsafe extern "C" fn(Display, c_uint, c_int, c_ulong) -> c_int,
    motion: unsafe extern "C" fn(Display, c_int, c_int, c_int, c_ulong) -> c_int,
    _x: Library,
    _test: Library,
}
impl Input {
    fn open() -> Result<Self> {
        let x = Library::open(c"libX11.so.6")?;
        let test = Library::open(c"libXtst.so.6")?;
        unsafe {
            let open: unsafe extern "C" fn(*const libc::c_char) -> Display =
                x.symbol(c"XOpenDisplay")?;
            // Resolve all symbols before opening so any error cannot leak the display.
            let mut input = Self {
                display: std::ptr::null_mut(),
                close: x.symbol(c"XCloseDisplay")?,
                sync: x.symbol(c"XSync")?,
                code: x.symbol(c"XKeysymToKeycode")?,
                symbol: x.symbol(c"XkbKeycodeToKeysym")?,
                key: test.symbol(c"XTestFakeKeyEvent")?,
                button: test.symbol(c"XTestFakeButtonEvent")?,
                motion: test.symbol(c"XTestFakeMotionEvent")?,
                _x: x,
                _test: test,
            };
            input.display = open(c":99".as_ptr());
            ensure(
                !input.display.is_null(),
                "browser_interaction_required",
                503,
            )?;
            Ok(input)
        }
    }
}
impl Drop for Input {
    fn drop(&mut self) {
        if !self.display.is_null() {
            unsafe {
                (self.key)(
                    self.display,
                    (self.code)(self.display, 0xffe1) as c_uint,
                    0,
                    0,
                );
                (self.sync)(self.display, 0);
                (self.close)(self.display);
            }
        }
    }
}
pub(super) fn move_pointer(x: i32, y: i32) -> Result<Value> {
    ensure(
        (0..1024).contains(&x) && (0..768).contains(&y),
        "invalid_native_input",
        400,
    )?;
    let input = Input::open()?;
    unsafe {
        (input.motion)(input.display, -1, x, y, 0);
        (input.sync)(input.display, 0);
    }
    std::thread::sleep(Duration::from_millis(50));
    Ok(json!({}))
}
pub(super) fn click(x: i32, y: i32) -> Result<Value> {
    ensure(
        (0..1024).contains(&x) && (0..768).contains(&y),
        "invalid_native_input",
        400,
    )?;
    let input = Input::open()?;
    unsafe {
        ensure(
            (input.motion)(input.display, -1, x, y, 0) != 0
                && (input.button)(input.display, 1, 1, 0) != 0
                && (input.button)(input.display, 1, 0, 0) != 0,
            "browser_interaction_required",
            503,
        )?;
        (input.sync)(input.display, 0);
    }
    std::thread::sleep(Duration::from_millis(50));
    Ok(json!({}))
}
pub(super) fn type_text(text: &str) -> Result<Value> {
    ensure(
        !text.is_empty() && text.len() <= 64 && text.bytes().all(|b| (32..=126).contains(&b)),
        "invalid_native_input",
        400,
    )?;
    let input = Input::open()?;
    unsafe {
        let shift = (input.code)(input.display, 0xffe1) as c_uint;
        for byte in text.bytes() {
            let symbol = byte as c_ulong;
            let code = (input.code)(input.display, symbol);
            let shifted = if code != 0 && (input.symbol)(input.display, code, 0, 0) == symbol {
                false
            } else if code != 0 && (input.symbol)(input.display, code, 0, 1) == symbol {
                true
            } else {
                return Err(Error::new("browser_interaction_required", 503));
            };
            if shifted {
                (input.key)(input.display, shift, 1, 0);
            }
            (input.key)(input.display, code as c_uint, 1, 0);
            (input.key)(input.display, code as c_uint, 0, 0);
            if shifted {
                (input.key)(input.display, shift, 0, 0);
            }
            (input.sync)(input.display, 0);
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    Ok(json!({}))
}
