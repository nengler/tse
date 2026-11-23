//! `native/include/tse.h`, as Rust declarations. The header is the source of truth.
use std::os::raw::c_char;

pub const TSE_ABI_VERSION: i32 = 16;
pub const TSE_TYPED_MAX: usize = 64;

pub const TSE_IN_LEN: usize = 7;

pub const TSE_OPEN_RESIZABLE: u32 = 1;
pub const TSE_OPEN_VSYNC: u32 = 2;
pub const TSE_OPEN_HIDDEN: u32 = 4;
pub const TSE_OPEN_SMOOTH: u32 = 8;
pub const TSE_OPEN_SHARP: u32 = 16;
pub const TSE_OPEN_HIGHDPI: u32 = 32;

extern "C" {
    pub fn tse_abi_version() -> i32;
    pub fn tse_key_count() -> i32;
    pub fn tse_open(width: i32, height: i32, title: *const c_char, options: u32) -> i32;
    pub fn tse_close();
    pub fn tse_set_fullscreen(on: i32) -> i32;
    pub fn tse_load_texture(path: *const c_char) -> i32;
    pub fn tse_load_shader(path: *const c_char) -> i32;
    pub fn tse_load_sound(path: *const c_char) -> i32;
    pub fn tse_play_sound_ex(handle: i32, volume: f64);
    pub fn tse_load_music(path: *const c_char) -> i32;
    pub fn tse_music_play(handle: i32, volume: f64, loop_: i32);
    pub fn tse_music_set_volume(handle: i32, volume: f64);
    pub fn tse_music_stop(handle: i32);
    pub fn tse_set_gamepad_deadzone(deadzone: f64);
    pub fn tse_measure_text(text: *const c_char, size: f64, out: *mut f64) -> i32;
    pub fn tse_texture_size(handle: i32, out: *mut f64) -> i32;
    pub fn tse_storage_open(game_id: *const c_char) -> i32;
    pub fn tse_storage_read(name: *const c_char, out: *mut u8, capacity: i32) -> i32;
    pub fn tse_storage_write(name: *const c_char, data: *const u8, length: i32) -> i32;
    pub fn tse_storage_remove(name: *const c_char) -> i32;
    pub fn tse_typed(out: *mut u32, capacity: i32) -> i32;
    pub fn tse_overlaps(boxes: *const f64, count: i32, order: *mut i32, pairs: *mut i32, capacity: i32) -> i32;
    pub fn tse_frame(
        clear_color: u32,
        records: *const f64,
        records_length: i32,
        text: *const c_char,
        text_offsets: *const i32,
        text_count: i32,
        input: *mut f64,
        keys: *mut u8,
    );
}
