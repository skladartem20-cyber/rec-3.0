"""StreamRec Cloud — посредник для удалённого доступа (Timeweb Cloud App Platform, Docker).

СКВОЗНОЕ ШИФРОВАНИЕ: посредник не может прочитать ни данные, ни команды.
Браузер и ПК шифруют всё ключом AES-256-GCM, который получается из вашего пароля
прямо на устройствах. Сюда приходят только шифротексты; пароль и ключ сюда не попадают.
Облако знает лишь: онлайн ли ПК, сколько открыто вкладок, объём и время трафика.

Переменные окружения (значения выдаёт ПК: Настройки → облако):
  AGENT_TOKEN     — секрет подключения ПК (кнопка «Создать» у токена)
  AUTH_VERIFIER   — проверочный хеш пароля (кнопка «Задать пароль»); расшифровать данные по нему нельзя
  TOTP_SECRET     — необязательно: двухфакторный код
  SESSION_HOURS   — срок входа, часов (по умолчанию 720)
  (порт всегда 8080 — как EXPOSE в Dockerfile)
  INSECURE_HTTP=1 — только для локальной проверки без https
"""
import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import struct
import time
from pathlib import Path

from aiohttp import web, WSMsgType

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname).1s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("relay")

WEB = Path(__file__).resolve().parent / "web"
AGENT_TOKEN = os.environ.get("AGENT_TOKEN", "")
AUTH_VERIFIER = os.environ.get("AUTH_VERIFIER", "").strip().lower()
E2E_SALT = base64.b64encode(b"StreamRec-E2E-v3").decode()   # фиксированная соль (не секрет)
TOTP_SECRET = os.environ.get("TOTP_SECRET", "").strip().replace(" ", "").upper()
SESSION_HOURS = float(os.environ.get("SESSION_HOURS", "720"))
INSECURE = os.environ.get("INSECURE_HTTP") == "1"
COOKIE = "sr" if INSECURE else "__Host-sr"
MAX_REQ = 1024 * 1024
EPOCH = hashlib.sha256((AUTH_VERIFIER + E2E_SALT).encode()).hexdigest()[:16]  # смена пароля = выход везде


def verify_auth(auth_b64: str) -> bool:
    try:
        raw = base64.b64decode(auth_b64, validate=True)
    except Exception:
        return False
    if len(raw) != 32 or len(AUTH_VERIFIER) != 64:
        return False
    return hmac.compare_digest(hashlib.sha256(raw).hexdigest(), AUTH_VERIFIER)


def verify_totp(code: str) -> bool:
    if not TOTP_SECRET:
        return True
    code = (code or "").strip().replace(" ", "")
    if not code.isdigit() or len(code) != 6:
        return False
    try:
        key = base64.b32decode(TOTP_SECRET + "=" * (-len(TOTP_SECRET) % 8))
    except Exception:
        return False
    step = int(time.time() // 30)
    for s in (step - 1, step, step + 1):
        h = hmac.new(key, struct.pack(">Q", s), hashlib.sha1).digest()
        o = h[-1] & 15
        val = (struct.unpack(">I", h[o:o + 4])[0] & 0x7FFFFFFF) % 1_000_000
        if hmac.compare_digest(f"{val:06d}", code):
            return True
    return False


class Relay:
    def __init__(self):
        self.agent: web.WebSocketResponse | None = None
        self.last_seen = 0.0
        self.state_blob: str | None = None      # последнее зашифрованное состояние
        self.viewers: set[web.WebSocketResponse] = set()
        self.pending: dict[str, asyncio.Future] = {}
        self.sessions: dict[str, dict] = {}
        self.fails: dict[str, list] = {}
        self.global_fails: list = []
        self.used_totp: dict[str, float] = {}

    def pc_online(self) -> bool:
        return self.agent is not None and not self.agent.closed

    def meta(self) -> str:
        return json.dumps({"type": "meta", "pc": self.pc_online(), "pc_seen": self.last_seen,
                           "viewers": len(self.viewers), "now": time.time()})

    async def send_all(self, text: str):
        for ws in list(self.viewers):
            if not ws.closed:
                try:
                    await ws.send_str(text)
                except Exception:
                    pass

    async def tell_agent_viewers(self):
        if self.pc_online():
            try:
                await self.agent.send_str(json.dumps({"type": "viewers", "n": len(self.viewers)}))
            except Exception:
                pass


R = Relay()


def client_ip(req: web.Request) -> str:
    return req.headers.get("X-Real-IP") or (req.headers.get("X-Forwarded-For", "").split(",")[-1].strip()) \
        or (req.remote or "?")


def token_ok(tok: str | None) -> bool:
    if not tok or len(tok) > 200:
        return False
    s = R.sessions.get(hashlib.sha256(tok.encode()).hexdigest())
    return bool(s and s["exp"] > time.time() and s["epoch"] == EPOCH)


def session_token(req: web.Request) -> str | None:
    # cookie (обычные браузеры) или заголовок X-SR-Session (Safari не всегда шлёт cookie из service worker)
    return req.headers.get("X-SR-Session") or req.cookies.get(COOKIE)


def session_ok(req: web.Request) -> bool:
    return token_ok(session_token(req))


# ---------------------------------------------------------------- защита
PROTECTED = ("/rpc", "/api/logout_all")


@web.middleware
async def security_mw(req: web.Request, handler):
    if req.method == "POST" and req.path != "/api/login":
        origin = req.headers.get("Origin")
        if origin and origin.split("://", 1)[-1] != req.host:
            return _h(web.json_response({"error": "forbidden origin"}, status=403), req)
    if req.path.startswith(PROTECTED) and not session_ok(req):
        return _h(web.json_response({"error": "auth"}, status=401), req)
    try:
        resp = await handler(req)
    except web.HTTPException as e:
        _h(e, req)
        raise
    return _h(resp, req)


def _h(resp, req):
    h = resp.headers
    h["X-Content-Type-Options"] = "nosniff"
    h["X-Frame-Options"] = "DENY"
    h["Referrer-Policy"] = "no-referrer"
    h["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if not INSECURE:
        h["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    h["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; "
        f"script-src 'self'; worker-src 'self' blob:; connect-src 'self' wss://{req.host} ws://{req.host}; "
        "frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    return resp


# ---------------------------------------------------------------- страницы (публичные: секретов не содержат)
def _file(name, cache="no-cache"):
    async def h(req):
        return web.FileResponse(WEB / name, headers={"Cache-Control": cache})
    return h


async def static_file(req):
    name = req.match_info["name"]
    f = (WEB / name).resolve()
    if not str(f).startswith(str(WEB.resolve())) or not f.is_file():
        raise web.HTTPNotFound()
    return web.FileResponse(f, headers={"Cache-Control": "no-cache"})


async def healthz(req):
    return web.json_response({"ok": True, "pc": R.pc_online(), "e2e": True, "session": session_ok(req)})


async def e2e_salt(req):
    return web.json_response({"salt": E2E_SALT, "totp": bool(TOTP_SECRET), "iter": 600000})


# ---------------------------------------------------------------- вход
async def api_login(req):
    ip = client_ip(req)
    now = time.time()
    fails = [t for t in R.fails.get(ip, []) if now - t < 900]
    R.fails[ip] = fails
    R.global_fails = [t for t in R.global_fails if now - t < 900]
    if len(fails) >= 5:
        wait = int(900 - (now - fails[0]))
        return web.json_response({"ok": False, "error": f"Слишком много попыток. Повторите через {wait // 60 + 1} мин."},
                                 status=429)
    await asyncio.sleep(min(10, 0.3 + len(R.global_fails) * 0.3))
    try:
        d = await req.json()
    except Exception:
        d = {}
    ok_auth = verify_auth(str(d.get("auth", ""))[:100])
    if d.get("probe"):
        # самопроверка ПК: совпадает ли пароль (без создания сессии; неудачи считаются как обычно)
        if not ok_auth:
            fails.append(now)
            R.global_fails.append(now)
            return web.json_response({"ok": False}, status=403)
        R.fails.pop(ip, None)
        return web.json_response({"ok": True, "probe": True})
    code = str(d.get("code", ""))[:12]
    ok_code = verify_totp(code)
    if ok_code and TOTP_SECRET:
        if code in R.used_totp:
            ok_code = False
        else:
            R.used_totp = {k: v for k, v in R.used_totp.items() if now - v < 120}
            R.used_totp[code] = now
    if not (ok_auth and ok_code):
        fails.append(now)
        R.global_fails.append(now)
        log.warning("неудачный вход с %s", ip)
        return web.json_response({"ok": False, "error": "Неверный пароль" + (" или код" if TOTP_SECRET else "")},
                                 status=403)
    R.fails.pop(ip, None)
    tok = secrets.token_urlsafe(32)
    R.sessions = {k: v for k, v in R.sessions.items() if v["exp"] > now}
    R.sessions[hashlib.sha256(tok.encode()).hexdigest()] = {"exp": now + SESSION_HOURS * 3600, "epoch": EPOCH}
    log.info("вход с %s", ip)
    resp = web.json_response({"ok": True, "session": tok, "hours": SESSION_HOURS})
    resp.set_cookie(COOKIE, tok, max_age=int(SESSION_HOURS * 3600), httponly=True, secure=not INSECURE,
                    samesite="Lax", path="/")
    return resp


async def api_logout(req):
    tok = session_token(req)
    if tok:
        R.sessions.pop(hashlib.sha256(tok.encode()).hexdigest(), None)
    resp = web.json_response({"ok": True})
    resp.del_cookie(COOKIE, path="/")
    return resp


async def api_logout_all(req):
    R.sessions.clear()
    resp = web.json_response({"ok": True})
    resp.del_cookie(COOKIE, path="/")
    for ws in list(R.viewers):
        await ws.close()
    return resp


# ---------------------------------------------------------------- браузеры
async def ws_view(req):
    ws = web.WebSocketResponse(heartbeat=25, compress=True)
    await ws.prepare(req)
    tok = session_token(req)
    if not token_ok(tok):
        # Safari: cookie может не прийти — ждём первое сообщение {"type":"auth","token":...}
        try:
            msg = await ws.receive(timeout=8)
            d = json.loads(msg.data) if msg.type == WSMsgType.TEXT else {}
            tok = d.get("token") if d.get("type") == "auth" else None
        except Exception:
            tok = None
        if not token_ok(tok):
            await ws.send_str(json.dumps({"type": "auth_failed"}))
            await ws.close(code=4401)
            return ws
    R.viewers.add(ws)
    await R.tell_agent_viewers()
    await R.send_all(R.meta())
    try:
        if R.state_blob:
            await ws.send_str(json.dumps({"type": "enc", "d": R.state_blob}))
        async for msg in ws:
            if not token_ok(tok):
                break
            if msg.type == WSMsgType.TEXT and msg.data == "ping":
                await ws.send_str(R.meta())
    finally:
        R.viewers.discard(ws)
        await R.tell_agent_viewers()
        await R.send_all(R.meta())
    return ws


async def rpc(req: web.Request):
    """Зашифрованный запрос браузера -> ПК -> зашифрованный ответ. Содержимое здесь не читается."""
    if not R.pc_online():
        return web.json_response({"error": "ПК не на связи"}, status=503)
    blob = await req.content.read(MAX_REQ + 1)
    if len(blob) > MAX_REQ or len(blob) < 29:
        return web.json_response({"error": "bad request"}, status=400)
    rid = secrets.token_hex(12)
    fut = asyncio.get_running_loop().create_future()
    R.pending[rid] = fut
    try:
        await R.agent.send_bytes(rid.encode().ljust(32, b" ") + blob)
        kind, data = await asyncio.wait_for(fut, 90)
    except asyncio.TimeoutError:
        return web.json_response({"error": "ПК не ответил"}, status=504)
    except Exception as e:  # noqa: BLE001
        return web.json_response({"error": str(e)}, status=502)
    finally:
        R.pending.pop(rid, None)
    if kind == "err":
        return web.json_response({"error": data}, status=409)
    return web.Response(body=data, content_type="application/octet-stream", headers={"Cache-Control": "no-store"})


# ---------------------------------------------------------------- ПК
async def ws_agent(req):
    auth = req.headers.get("Authorization", "")
    if not AGENT_TOKEN or len(AGENT_TOKEN) < 24 or not hmac.compare_digest(auth, f"Bearer {AGENT_TOKEN}"):
        log.warning("отклонено подключение ПК с %s", client_ip(req))
        raise web.HTTPUnauthorized()
    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=32 * 1024 * 1024, compress=True)
    await ws.prepare(req)
    old = R.agent
    R.agent, R.last_seen = ws, time.time()
    if old and not old.closed:
        await old.close()
    log.info("ПК подключён")
    await ws.send_str(json.dumps({"type": "hello"}))
    await R.tell_agent_viewers()
    await R.send_all(R.meta())
    try:
        async for msg in ws:
            R.last_seen = time.time()
            if msg.type == WSMsgType.BINARY:
                rid = msg.data[:32].decode(errors="ignore").strip()
                f = R.pending.get(rid)
                if f and not f.done():
                    f.set_result(("ok", msg.data[32:]))
            elif msg.type == WSMsgType.TEXT:
                d = json.loads(msg.data)
                if d.get("type") == "state" and isinstance(d.get("d"), str):
                    R.state_blob = d["d"]
                    await R.send_all(json.dumps({"type": "enc", "d": R.state_blob}))
                elif d.get("type") == "res_err":
                    f = R.pending.get(d.get("id"))
                    if f and not f.done():
                        f.set_result(("err", str(d.get("error", ""))[:300]))
    finally:
        if R.agent is ws:
            R.agent = None
            log.info("ПК отключился")
            for f in R.pending.values():
                if not f.done():
                    f.set_exception(ConnectionError("ПК отключился"))
            await R.send_all(R.meta())
    return ws


async def watchdog(app):
    while True:
        await asyncio.sleep(10)
        a = R.agent
        if a and not a.closed and time.time() - R.last_seen > 60:
            log.warning("ПК не отвечает — разрываю соединение")
            await a.close()
        await R.send_all(R.meta())


async def on_startup(app):
    if len(AGENT_TOKEN) < 24:
        log.error("AGENT_TOKEN не задан или короче 24 символов")
    if len(AUTH_VERIFIER) != 64:
        log.error("Не задан AUTH_VERIFIER — вход невозможен")
    app["wd"] = asyncio.create_task(watchdog(app))


def make_app():
    app = web.Application(middlewares=[security_mw], client_max_size=MAX_REQ + 1024)
    r = app.router
    r.add_get("/", _file("index.html"))
    r.add_get("/login", _file("login.html"))
    r.add_get("/sw.js", _file("sw.js"))
    r.add_get("/static/{name:.+}", static_file)
    r.add_get("/healthz", healthz)
    r.add_get("/api/e2e_salt", e2e_salt)
    r.add_post("/api/login", api_login)
    r.add_post("/api/logout", api_logout)
    r.add_post("/api/logout_all", api_logout_all)
    r.add_post("/rpc", rpc)
    r.add_get("/ws", ws_view)
    r.add_get("/agent", ws_agent)
    app.on_startup.append(on_startup)
    return app


if __name__ == "__main__":
    log.info("StreamRec Cloud запущен на порту 8080")
    web.run_app(make_app(), host="0.0.0.0", port=8080, access_log=None, print=None)
