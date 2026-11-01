use rusqlite::{params, Connection};
use std::sync::Mutex;

pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    pub fn open() -> Result<Self, String> {
        let path = crate::config::app_data_dir().join("cache.db");
        let conn = Connection::open(&path).map_err(|e| format!("打开数据库失败: {}", e))?;

        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS cache (
                hash TEXT PRIMARY KEY,
                src TEXT NOT NULL,
                dst TEXT NOT NULL,
                provider TEXT,
                created_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_cache_created ON cache(created_at);
             CREATE TABLE IF NOT EXISTS usage (
                day TEXT PRIMARY KEY,
                requests INTEGER NOT NULL DEFAULT 0,
                chars INTEGER NOT NULL DEFAULT 0,
                messages INTEGER NOT NULL DEFAULT 0
             );",
        )
        .map_err(|e| format!("初始化数据库失败: {}", e))?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn cache_get(&self, hash: &str) -> Option<String> {
        let conn = self.conn.lock().ok()?;
        let mut stmt = conn
            .prepare("SELECT dst FROM cache WHERE hash = ?1")
            .ok()?;
        stmt.query_row(params![hash], |row| row.get::<_, String>(0))
            .ok()
    }

    pub fn cache_put(&self, hash: &str, src: &str, dst: &str, provider: &str) {
        if let Ok(conn) = self.conn.lock() {
            let now = chrono::Utc::now().timestamp();
            let _ = conn.execute(
                "INSERT OR REPLACE INTO cache (hash, src, dst, provider, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![hash, src, dst, provider, now],
            );
        }
    }

    pub fn cache_count(&self) -> i64 {
        if let Ok(conn) = self.conn.lock() {
            if let Ok(mut stmt) = conn.prepare("SELECT COUNT(*) FROM cache") {
                if let Ok(n) = stmt.query_row([], |row| row.get::<_, i64>(0)) {
                    return n;
                }
            }
        }
        0
    }

    pub fn cache_clear(&self) {
        if let Ok(conn) = self.conn.lock() {
            let _ = conn.execute("DELETE FROM cache", []);
        }
    }

    /// 清理过期缓存（默认 30 天）
    pub fn cache_prune(&self, days: i64) {
        if let Ok(conn) = self.conn.lock() {
            let cutoff = chrono::Utc::now().timestamp() - days * 86_400;
            let _ = conn.execute("DELETE FROM cache WHERE created_at < ?1", params![cutoff]);
        }
    }

    /// (requests, chars, messages)
    pub fn usage_today(&self) -> (i64, i64, i64) {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        if let Ok(conn) = self.conn.lock() {
            if let Ok(mut stmt) = conn.prepare(
                "SELECT requests, chars, messages FROM usage WHERE day = ?1",
            ) {
                if let Ok(row) = stmt.query_row(params![today], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                }) {
                    return row;
                }
            }
        }
        (0, 0, 0)
    }

    pub fn usage_add(&self, requests: i64, chars: i64, messages: i64) {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        if let Ok(conn) = self.conn.lock() {
            let _ = conn.execute(
                "INSERT INTO usage (day, requests, chars, messages) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(day) DO UPDATE SET
                    requests = requests + excluded.requests,
                    chars = chars + excluded.chars,
                    messages = messages + excluded.messages",
                params![today, requests, chars, messages],
            );
        }
    }
}
