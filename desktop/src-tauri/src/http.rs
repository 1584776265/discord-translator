use std::collections::HashMap;

/// 通用 HTTP 请求，供前端 engine.js 调用。
/// 放在 Rust 侧的原因：WebView2 里的 fetch 受 CORS 限制，
/// 而 Discord 页面的 CSP 又禁止直接连第三方接口。
pub async fn request(
    url: &str,
    method: &str,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
    timeout_ms: u64,
) -> Result<(u16, String), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(format!("只允许 http/https 请求: {}", url));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms.clamp(1000, 120_000)))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let m = reqwest::Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|e| format!("非法 HTTP 方法: {}", e))?;

    let mut req = client.request(m, url);

    if let Some(h) = headers {
        for (k, v) in h.iter() {
            req = req.header(k.as_str(), v.as_str());
        }
    }

    if let Some(b) = body {
        req = req.body(b);
    }

    let res = req.send().await.map_err(|e| format!("网络请求失败: {}", e))?;
    let status = res.status().as_u16();
    let text = res
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    Ok((status, text))
}
