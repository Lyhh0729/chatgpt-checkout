"""
ChatGPT 订阅链接生成工具 - Flask 后端
代理转发到 OpenAI 内部 API，不存储任何 Token

代理配置（环境变量）:
  HTTPS_PROXY  - HTTP 代理地址，例如 http://user:pass@proxy:8080
                  留空则直连 chatgpt.com（Render Oregon 通常不需要）
  USE_CURL_CFFI - 设为 "1" 启用 TLS 指纹伪装（需要 pip install curl_cffi）
"""
import os
import logging
from flask import Flask, render_template, request, jsonify

# --- 代理和请求库 ---
USE_CURL_CFFI = os.environ.get("USE_CURL_CFFI", "0") == "1"
SESSION = None  # 延迟初始化，因为需要知道代理配置

if USE_CURL_CFFI:
    try:
        from curl_cffi import requests as cffi_requests
        logger_temp = logging.getLogger("init")
        logger_temp.info("已启用 curl_cffi TLS 指纹伪装")
    except ImportError:
        USE_CURL_CFFI = False

import requests

# --- 配置 ---
OPENAI_BASE = "https://chatgpt.com"
CHECKOUT_URL = f"{OPENAI_BASE}/backend-api/payments/checkout"
# 订阅查询依次尝试的端点
ACCOUNT_CHECK_URLS = [
    f"{OPENAI_BASE}/backend-api/accounts/check",   # 最可能返回 accounts.default
    f"{OPENAI_BASE}/api/auth/session",              # 备选：session 信息
]

REGION_PRESETS = {
    "PH": {"country": "PH", "currency": "PHP"},
    "ID": {"country": "ID", "currency": "IDR"},
    "IN": {"country": "IN", "currency": "INR"},
    "US": {"country": "US", "currency": "USD"},
}

REGION_LOCALE = {
    "PH": "en-PH",
    "ID": "en-ID",
    "IN": "en-IN",
    "US": "en-US",
}

CHECKOUT_WEB_URL = f"{OPENAI_BASE}/checkout/openai_llc"
REQUEST_TIMEOUT = 30

# 代理配置（从环境变量读取）
HTTPS_PROXY = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy") or None
HTTP_PROXY = os.environ.get("HTTP_PROXY") or os.environ.get("http_proxy") or None

# 日志
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

if HTTPS_PROXY:
    logger.info(f"已配置代理: {HTTPS_PROXY}")
else:
    logger.info("直连模式（未配置代理）")


# --- Flask ---
app = Flask(__name__)


# ======================== 请求会话（带代理） ========================
def _get_session():
    """
    获取共享的 requests Session（带代理 + 浏览器级 Headers）
    使用 Session 可以维持 Cookie，绕过部分 Cloudflare 检测
    """
    global SESSION
    if SESSION is not None:
        return SESSION

    proxies = None
    if HTTPS_PROXY:
        proxies = {"http": HTTPS_PROXY, "https": HTTPS_PROXY}
    elif HTTP_PROXY:
        proxies = {"http": HTTP_PROXY, "https": HTTP_PROXY}

    if USE_CURL_CFFI:
        # curl_cffi 可以伪装成 Chrome 的 TLS 指纹
        session = cffi_requests.Session()
        session.headers.update({
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/131.0.0.0 Safari/537.36"
            ),
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        })
        session.proxies = proxies
        SESSION = session
        return SESSION

    # 标准 requests Session
    session = requests.Session()

    # Chrome 131 标准 Headers（不设 Accept-Encoding，让 requests 自动处理解压）
    session.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/131.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Sec-Ch-Ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "Upgrade-Insecure-Requests": "1",
    })

    if proxies:
        session.proxies = proxies

    SESSION = session
    return SESSION


def _openai_api_headers(access_token: str) -> dict:
    """构建调用 OpenAI API 时的额外 Headers"""
    return {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "Origin": "https://chatgpt.com",
        "Referer": "https://chatgpt.com/",
        "oai-language": "en-US",
    }


def _safe_requests(method: str, url: str, access_token: str, json_body: dict = None) -> tuple:
    """
    安全地向 OpenAI API 发送请求
    返回 (ok: bool, result: dict, status_code: int)
    """
    session = _get_session()
    headers = _openai_api_headers(access_token)

    for attempt in range(3):
        try:
            if method.upper() == "GET":
                resp = session.get(url, headers=headers, timeout=REQUEST_TIMEOUT)
            else:
                resp = session.post(url, headers=headers, json=json_body, timeout=REQUEST_TIMEOUT)

            logger.info(f"OpenAI {method} {url} → {resp.status_code} (attempt {attempt + 1})")

            # Cloudflare 拦截：403 + HTML
            ct = resp.headers.get("Content-Type", "")
            if resp.status_code == 403 and "text/html" in ct:
                logger.warning(f"疑似 Cloudflare 拦截 (403 HTML), attempt {attempt + 1}")
                if attempt < 2:
                    import time
                    time.sleep(1.5)
                    continue

            # 尝试解析 JSON
            try:
                body = resp.json()
            except Exception:
                # 非 JSON 响应：根据 Content-Type 处理
                if "text/html" in ct:
                    body = {"error": f"OpenAI 返回了 HTML 页面 (状态码 {resp.status_code})，可能被 Cloudflare 拦截或端点不存在"}
                elif "text/plain" in ct:
                    body = {"error": resp.text[:500]}
                else:
                    # 二进制或其他格式，不暴露原始数据
                    body = {"error": f"OpenAI 返回了非 JSON 响应 (Content-Type: {ct}, 状态码: {resp.status_code})，该端点可能不可用"}

            if resp.ok:
                return True, body, resp.status_code
            else:
                return False, body, resp.status_code

        except requests.exceptions.Timeout:
            if attempt < 2:
                logger.warning(f"请求超时，重试... (attempt {attempt + 1})")
                import time
                time.sleep(1)
                continue
            return False, {"error": "请求 OpenAI 超时，请重试"}, 504

        except requests.exceptions.ConnectionError as e:
            if attempt < 2:
                logger.warning(f"连接失败，重试... (attempt {attempt + 1})")
                import time
                time.sleep(1)
                continue
            return False, {"error": f"无法连接 OpenAI: {str(e)[:200]}"}, 502

        except Exception as exc:
            logger.exception("请求 OpenAI 异常")
            return False, {"error": f"请求异常: {str(exc)}"}, 500

    return False, {"error": "多次重试后仍失败"}, 502


# ======================== 请求体构建 ========================
def _build_checkout_payload(data: dict) -> dict:
    region = data.get("region", "US").upper()
    preset = REGION_PRESETS.get(region, REGION_PRESETS["US"])

    payload = {
        "plan_name": data.get("planName", "chatgptplusplan"),
        "billing_details": {
            "country": preset["country"],
            "currency": preset["currency"],
        },
        "cancel_url": "https://chatgpt.com/#pricing",
        "checkout_ui_mode": data.get("uiMode", "custom"),
        "locale": REGION_LOCALE.get(region, "en-US"),
    }

    if data.get("promoEnabled") and data.get("planName") != "chatgptteamplan":
        payload["promo_campaign"] = {
            "promo_campaign_id": "plus-1-month-free",
            "is_coupon_from_query_param": False,
        }

    if data.get("planName") == "chatgptteamplan":
        payload["team_plan_data"] = {
            "workspace_name": data.get("workspaceName", "MyTeam"),
            "price_interval": "month",
            "seat_quantity": data.get("seatQuantity", 5),
        }

    return payload


# ======================== 页面 ========================
@app.route("/")
def index():
    return render_template("index.html")


# ======================== API：生成订阅链接 ========================
@app.route("/api/checkout", methods=["POST"])
def api_checkout():
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"ok": False, "error": "请提供 JSON 请求体"}), 400

    access_token = (data.get("accessToken") or "").strip()
    if not access_token:
        return jsonify({"ok": False, "error": "请提供 Access Token"}), 400

    ui_mode = data.get("uiMode", "custom")
    plan_name = data.get("planName", "chatgptplusplan")

    payload = _build_checkout_payload(data)
    logger.info(
        f"生成链接: plan={plan_name}, region={data.get('region')}, "
        f"uiMode={ui_mode}, promo={data.get('promoEnabled')}"
    )

    ok, body, status = _safe_requests("POST", CHECKOUT_URL, access_token, payload)

    if not ok:
        error_msg = (
            body.get("error", {}).get("detail")
            or body.get("error", {}).get("message")
            or body.get("error")
            or (jsonify(body).get_data(as_text=True) if isinstance(body, dict) else str(body)[:500])
        )
        return jsonify({"ok": False, "error": str(error_msg), "raw": body}), status

    # 提取链接
    link = None
    if ui_mode == "hosted":
        link = body.get("url")
    else:
        session_id = body.get("checkout_session_id")
        if session_id:
            link = f"{CHECKOUT_WEB_URL}/{session_id}"

    if not link:
        return jsonify({"ok": False, "error": "未能生成链接，OpenAI 响应中缺少 URL", "raw": body}), 502

    return jsonify({"ok": True, "link": link, "raw": body})


# ======================== API：查询订阅来源 ========================
@app.route("/api/check", methods=["POST"])
def api_check():
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"ok": False, "error": "请提供 JSON 请求体"}), 400

    access_token = (data.get("accessToken") or "").strip()
    if not access_token:
        return jsonify({"ok": False, "error": "请提供 Access Token"}), 400

    logger.info("查询订阅来源")

    last_error = None
    for url in ACCOUNT_CHECK_URLS:
        logger.info(f"尝试: {url}")
        ok, body, status = _safe_requests("GET", url, access_token)
        if ok and body.get("accounts"):
            return jsonify({"ok": True, **body})
        if ok and body.get("user"):
            # /api/auth/session 返回用户信息，包装成兼容格式
            return jsonify({"ok": True, **body})
        if not ok:
            last_error = body

    # 全部失败
    error_msg = (
        last_error.get("error", {}).get("detail")
        or last_error.get("error", {}).get("message")
        or last_error.get("error")
        or "所有查询端点均失败，请检查 Token 是否有效"
        if isinstance(last_error, dict)
        else str(last_error)[:300]
    )
    return jsonify({"ok": False, "error": str(error_msg)}), 502


# ======================== API：健康检查 + 连通性测试 ========================
@app.route("/api/health", methods=["GET"])
def api_health():
    """健康检查 + chatgpt.com 连通性测试"""
    result = {
        "status": "ok",
        "proxy_enabled": bool(HTTPS_PROXY),
        "curl_cffi": USE_CURL_CFFI,
    }
    # 测试是否能到达 chatgpt.com
    try:
        session = _get_session()
        resp = session.get(f"{OPENAI_BASE}/api/auth/csrf", timeout=10)
        result["chatgpt_reachable"] = resp.ok
        result["chatgpt_status"] = resp.status_code
    except Exception as e:
        result["chatgpt_reachable"] = False
        result["chatgpt_error"] = str(e)[:200]

    return jsonify(result)


# ======================== 启动 ========================
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"
    print("=" * 50)
    print("ChatGPT 订阅链接生成工具")
    print(f"代理: {'已配置 ' + HTTPS_PROXY if HTTPS_PROXY else '直连模式'}")
    print(f"TLS 伪装: {'curl_cffi' if USE_CURL_CFFI else '标准 requests'}")
    print(f"访问: http://0.0.0.0:{port}")
    print(f"健康检查: http://localhost:{port}/api/health")
    print("=" * 50)
    app.run(host="0.0.0.0", port=port, debug=debug)
