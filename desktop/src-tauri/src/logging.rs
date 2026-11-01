use std::io::Write;
use std::sync::Mutex;

static LOCK: Mutex<()> = Mutex::new(());

const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

fn rotate_if_needed(path: &std::path::Path) {
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > MAX_LOG_BYTES {
            let old = path.with_extension("log.1");
            let _ = std::fs::rename(path, old);
        }
    }
}

pub fn write(level: &str, msg: &str) {
    let _guard = LOCK.lock();
    let path = crate::config::log_path();
    rotate_if_needed(&path);

    let line = format!(
        "[{}] [{}] {}\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
        level,
        msg
    );

    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = f.write_all(line.as_bytes());
    }
}
