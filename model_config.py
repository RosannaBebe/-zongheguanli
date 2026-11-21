"""Server-side model profiles, scoped to the current browser."""
from contextlib import closing
import http.client
import ipaddress
import json
import os
from pathlib import Path
import socket
import sqlite3
from urllib.parse import urlsplit
from uuid import uuid4


class ModelConfigError(ValueError):
    pass


def endpoint_url(value, allow_private=False):
    if not isinstance(value, str) or len(value) > 2048:
        raise ModelConfigError("请输入有效的模型 URL")
    try:
        url = urlsplit(value.strip())
        host, port = url.hostname, url.port
    except ValueError:
        raise ModelConfigError("请输入有效的模型 URL") from None
    local_http = allow_private and host in {"localhost", "127.0.0.1", "::1"}
    if (not host or url.username is not None or url.password is not None or url.query
            or url.fragment or port == 0 or (url.scheme != "https" and not (local_http and url.scheme == "http"))
            or any(c.isspace() or ord(c) < 32 for c in value.strip()) or "\\" in value):
        raise ModelConfigError("请输入 HTTPS 接口地址，本机模型可使用 localhost 的 HTTP 地址")
    path = url.path.rstrip("/").removesuffix("/chat/completions")
    return url._replace(path=path).geturl()


def _text(value, limit, error):
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > limit:
        raise ModelConfigError(error)
    return value.strip()


class ModelProfiles:
    def __init__(self, path, default):
        self.path = Path(path)
        self.default = default

    def _connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        db = sqlite3.connect(self.path)
        db.execute("CREATE TABLE IF NOT EXISTS profiles (owner TEXT PRIMARY KEY, settings TEXT NOT NULL)")
        return db

    def _read(self, db, owner):
        if db and owner:
            row = db.execute("SELECT settings FROM profiles WHERE owner = ?", (owner,)).fetchone()
            if row:
                return json.loads(row[0])
        default = {key: self.default[key] for key in ("id", "url", "model")}
        default["api_key"] = ""
        default["use_default_key"] = True
        return {"active_id": default["id"] if self.default["api_key"] else None, "models": [default]}

    def get(self, owner):
        if owner and self.path.is_file():
            with closing(self._connect()) as db:
                return self._read(db, owner)
        return self._read(None, None)

    def _key(self, model):
        if model.get("use_default_key"):
            return self.default["api_key"] if model["url"] == self.default["url"] else ""
        return model["api_key"]

    def active(self, settings):
        for model in settings["models"]:
            if model["id"] == settings["active_id"] and self._key(model):
                return {**model, "api_key": self._key(model)}
        return None

    def public(self, settings):
        active = self.active(settings)
        return {"active_id": active["id"] if active else None, "models": [
            {"id": model["id"], "url": model["url"], "model": model["model"],
             "has_key": bool(self._key(model))} for model in settings["models"]
        ]}

    def update(self, owner, data, allow_private=False):
        action = data.get("action")
        with closing(self._connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            settings = self._read(db, owner)
            models = settings["models"]
            model = next((item for item in models if item["id"] == data.get("id")), None)
            if action == "add" or (action == "edit" and model):
                name = _text(data.get("model"), 200, "请输入有效的模型名称")
                url = endpoint_url(data.get("url"), allow_private)
                key = data.get("api_key", "")
                if key:
                    key = _text(key, 4096, "请输入有效的 API Key")
                    if not key.isascii() or any(ord(c) < 33 or ord(c) > 126 for c in key):
                        raise ModelConfigError("请输入有效的 API Key")
                if action == "add":
                    if len(models) >= 30:
                        raise ModelConfigError("最多可保存 30 个模型配置")
                    model = {"id": uuid4().hex, "api_key": ""}
                    models.append(model)
                if not key and (not self._key(model) or model.get("url") != url):
                    raise ModelConfigError("新增配置或更改接口地址时，请填写该接口的 API Key")
                model.update(model=name, url=url)
                if key:
                    model.update(api_key=key, use_default_key=False)
            elif action == "enable" and model:
                if not self._key(model):
                    raise ModelConfigError("请先填写 API Key")
                settings["active_id"] = model["id"]
            elif action == "disable" and model:
                if settings["active_id"] == model["id"]:
                    settings["active_id"] = None
            elif action == "delete" and model:
                models.remove(model)
                if settings["active_id"] == model["id"]:
                    settings["active_id"] = None
            else:
                raise ModelConfigError("模型配置或操作不存在")
            db.execute("INSERT OR REPLACE INTO profiles VALUES (?, ?)", (owner, json.dumps(settings)))
            return self.public(settings)


def request_model(url, api_key, payload, allow_private=False):
    """Connect to a validated address, keeping HTTPS verification on the original hostname."""
    parsed = urlsplit(endpoint_url(url, allow_private))
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    addresses = socket.getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM)
    permitted = []
    for family, kind, proto, _, address in addresses:
        ip = ipaddress.ip_address(address[0].split("%", 1)[0])
        ip = getattr(ip, "ipv4_mapped", None) or ip
        if ip.is_multicast or ip.is_unspecified or ip.is_link_local or (ip.is_reserved and not ip.is_loopback):
            continue
        if ip.is_global or (allow_private and (ip.is_private or ip.is_loopback)):
            permitted.append((family, kind, proto, address))
    if not permitted:
        raise ModelConfigError("此部署仅能访问允许的模型接口地址")

    def connect(_, timeout, source_address=None):
        last_error = OSError("模型地址不可达")
        for family, kind, proto, address in permitted:
            sock = socket.socket(family, kind, proto)
            try:
                sock.settimeout(timeout)
                sock.connect(address)
                return sock
            except OSError as error:
                sock.close()
                last_error = error
        raise last_error

    connection_type = http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    with closing(connection_type(parsed.hostname, port, timeout=45)) as connection:
        connection._create_connection = connect
        connection.request("POST", parsed.path + "/chat/completions", json.dumps(payload).encode("utf-8"), {
            "Authorization": "Bearer " + api_key, "Content-Type": "application/json",
        })
        with connection.getresponse() as response:
            if response.status != 200:
                return response.status, None
            return response.status, json.loads(response.read(2_000_000))
