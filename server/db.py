"""
Tunnel - 数据库操作层 (SQLite + aiosqlite)
"""
import os
import uuid
import secrets
import string
from datetime import datetime
from typing import Optional

import aiosqlite

DB_PATH = os.environ.get("DB_PATH", "data/tunnel.db")

# ======================== 建表 ========================

_SCHEMA = """
CREATE TABLE IF NOT EXISTS server_config (
    id          TEXT PRIMARY KEY,
    domain      TEXT NOT NULL DEFAULT 'aicq.online:7739',
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tunnel (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    code        TEXT UNIQUE NOT NULL,
    local_port  INTEGER,
    local_host  TEXT,
    auth_token  TEXT UNIQUE NOT NULL,
    status      TEXT NOT NULL DEFAULT 'offline',
    public_url  TEXT,
    p2p_info    TEXT,
    description TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tunnel_tcp_port (
    id          TEXT PRIMARY KEY,
    tunnel_code TEXT NOT NULL,
    local_port  INTEGER NOT NULL,
    public_port INTEGER NOT NULL,
    name        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    UNIQUE(tunnel_code, local_port),
    UNIQUE(public_port)
);

CREATE TABLE IF NOT EXISTS tunnel_http_port (
    id          TEXT PRIMARY KEY,
    tunnel_code TEXT NOT NULL,
    local_port  INTEGER NOT NULL,
    public_port INTEGER NOT NULL,
    created_at  TEXT NOT NULL,
    UNIQUE(tunnel_code),
    UNIQUE(public_port)
);

CREATE TABLE IF NOT EXISTS tunnel_log (
    id          TEXT PRIMARY KEY,
    tunnel_id   TEXT NOT NULL,
    action      TEXT NOT NULL,
    message     TEXT NOT NULL,
    ip          TEXT,
    bytes_in    INTEGER DEFAULT 0,
    bytes_out   INTEGER DEFAULT 0,
    created_at  TEXT NOT NULL,
    FOREIGN KEY (tunnel_id) REFERENCES tunnel(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tunnel_subdomain (
    id          TEXT PRIMARY KEY,
    tunnel_code TEXT NOT NULL,
    subdomain   TEXT UNIQUE NOT NULL,
    local_port  INTEGER NOT NULL,
    created_at  TEXT NOT NULL,
    UNIQUE(tunnel_code)
);

CREATE TABLE IF NOT EXISTS ssl_config (
    id          TEXT PRIMARY KEY,
    domain      TEXT NOT NULL,
    ali_key     TEXT NOT NULL DEFAULT '',
    ali_secret  TEXT NOT NULL DEFAULT '',
    cert_path   TEXT NOT NULL DEFAULT '',
    key_path    TEXT NOT NULL DEFAULT '',
    not_before  TEXT,
    not_after   TEXT,
    last_renew  TEXT,
    renew_log   TEXT DEFAULT '',
    updated_at  TEXT NOT NULL
);
"""


async def init_db():
    """初始化数据库，建表 + 自动迁移"""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript(_SCHEMA)
        # 确保有一条默认配置
        await db.execute(
            "INSERT OR IGNORE INTO server_config (id, domain, updated_at) VALUES (?, ?, ?)",
            ("default", "aicq.online:7739", _now()),
        )
        # 自动迁移: 给旧表添加 public_url 列
        cursor = await db.execute("PRAGMA table_info(tunnel)")
        columns = [row[1] for row in await cursor.fetchall()]
        if "public_url" not in columns:
            await db.execute("ALTER TABLE tunnel ADD COLUMN public_url TEXT")
        if "p2p_info" not in columns:
            await db.execute("ALTER TABLE tunnel ADD COLUMN p2p_info TEXT")
        await db.commit()


# ======================== Config ========================

async def get_config(db: aiosqlite.Connection) -> dict:
    cursor = await db.execute("SELECT id, domain, updated_at FROM server_config LIMIT 1")
    row = await cursor.fetchone()
    if row:
        return {"id": row[0], "domain": row[1], "updated_at": row[2]}
    return {"id": "default", "domain": "aicq.online:7739", "updated_at": _now()}


async def set_config(db: aiosqlite.Connection, domain: str) -> dict:
    await db.execute(
        "UPDATE server_config SET domain = ?, updated_at = ? WHERE id = 'default'",
        (domain, _now()),
    )
    await db.commit()
    return {"domain": domain}


# ======================== Tunnel CRUD ========================

def _gen_code() -> str:
    """生成 8 位大写字母数字隧道编码"""
    chars = string.ascii_uppercase + string.digits
    while True:
        code = "".join(secrets.choice(chars) for _ in range(8))
        # 避免全数字（易与普通路径混淆）
        if any(c.isalpha() for c in code):
            return code


def _gen_token() -> str:
    """生成 32 位认证令牌"""
    return secrets.token_urlsafe(24)


async def list_tunnels(db: aiosqlite.Connection) -> list:
    cursor = await db.execute(
        "SELECT id, name, code, local_port, local_host, auth_token, status, public_url, p2p_info, description, created_at, updated_at "
        "FROM tunnel ORDER BY created_at DESC"
    )
    rows = await cursor.fetchall()
    return [_row_to_tunnel(r) for r in rows]


async def get_tunnel(db: aiosqlite.Connection, code: str) -> Optional[dict]:
    cursor = await db.execute(
        "SELECT id, name, code, local_port, local_host, auth_token, status, public_url, p2p_info, description, created_at, updated_at "
        "FROM tunnel WHERE code = ?", (code.upper(),)
    )
    row = await cursor.fetchone()
    return _row_to_tunnel(row) if row else None


async def get_tunnel_by_token(db: aiosqlite.Connection, token: str) -> Optional[dict]:
    cursor = await db.execute(
        "SELECT id, name, code, local_port, local_host, auth_token, status, public_url, p2p_info, description, created_at, updated_at "
        "FROM tunnel WHERE auth_token = ?", (token,)
    )
    row = await cursor.fetchone()
    return _row_to_tunnel(row) if row else None


async def create_tunnel(db: aiosqlite.Connection, name: str, description: str = "",
                       auth_token: Optional[str] = None) -> dict:
    code = _gen_code()
    token = auth_token if auth_token else _gen_token()
    tid = str(uuid.uuid4())
    now = _now()
    await db.execute(
        "INSERT INTO tunnel (id, name, code, local_port, local_host, auth_token, status, public_url, p2p_info, description, created_at, updated_at) "
        "VALUES (?, ?, ?, NULL, NULL, ?, 'offline', NULL, NULL, ?, ?, ?)",
        (tid, name, code, token, description, now, now),
    )
    await db.commit()
    return {
        "id": tid, "name": name, "code": code,
        "local_port": None, "local_host": None,
        "auth_token": token, "status": "offline",
        "public_url": None, "p2p_info": None, "description": description,
        "created_at": now, "updated_at": now,
    }


async def delete_tunnel(db: aiosqlite.Connection, tunnel_id: str) -> bool:
    cursor = await db.execute("DELETE FROM tunnel WHERE id = ?", (tunnel_id,))
    await db.commit()
    return cursor.rowcount > 0


async def update_tunnel_status(db: aiosqlite.Connection, code: str, status: str):
    await db.execute(
        "UPDATE tunnel SET status = ?, updated_at = ? WHERE code = ?",
        (status, _now(), code),
    )
    await db.commit()


async def update_tunnel_client_info(db: aiosqlite.Connection, code: str,
                                      local_port: int, local_host: str):
    """客户端连接时上报其本地端口和地址"""
    await db.execute(
        "UPDATE tunnel SET local_port = ?, local_host = ?, updated_at = ? WHERE code = ?",
        (local_port, local_host, _now(), code),
    )
    await db.commit()


async def update_tunnel_public_url(db: aiosqlite.Connection, code: str,
                                     public_url: Optional[str]):
    """更新隧道的 P2P 公网地址（UPnP 成功后由客户端上报）"""
    await db.execute(
        "UPDATE tunnel SET public_url = ?, updated_at = ? WHERE code = ?",
        (public_url, _now(), code),
    )
    await db.commit()


# 哨兵值：区分"不更新 public_url"和"设为 NULL"
_UNSET = object()


async def update_tunnel_p2p_info(db: aiosqlite.Connection, code: str,
                                   p2p_info: Optional[str], public_url=_UNSET):
    """更新隧道的 P2P 详细信息 (JSON 格式)

    Args:
        p2p_info: P2P JSON 信息，传 None 表示清空
        public_url: P2P 公网地址。传 None 表示清空，不传（默认）表示不更新该字段
    """
    if public_url is not _UNSET:
        # 显式传入了 public_url（包括 None），同时更新两个字段
        await db.execute(
            "UPDATE tunnel SET p2p_info = ?, public_url = ?, updated_at = ? WHERE code = ?",
            (p2p_info, public_url, _now(), code),
        )
    else:
        # 未传 public_url，仅更新 p2p_info
        await db.execute(
            "UPDATE tunnel SET p2p_info = ?, updated_at = ? WHERE code = ?",
            (p2p_info, _now(), code),
        )
    await db.commit()


# ======================== Logs ========================

async def add_log(db: aiosqlite.Connection, tunnel_id: str, action: str,
                  message: str, ip: str = "", bytes_in: int = 0, bytes_out: int = 0):
    await db.execute(
        "INSERT INTO tunnel_log (id, tunnel_id, action, message, ip, bytes_in, bytes_out, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (str(uuid.uuid4()), tunnel_id, action, message, ip, bytes_in, bytes_out, _now()),
    )
    # 每个隧道滚动保留最近 100 条日志
    await db.execute(
        "DELETE FROM tunnel_log WHERE tunnel_id = ? AND id NOT IN "
        "(SELECT id FROM tunnel_log WHERE tunnel_id = ? ORDER BY created_at DESC LIMIT 100)",
        (tunnel_id, tunnel_id),
    )
    await db.commit()


async def get_logs(db: aiosqlite.Connection, tunnel_id: str, limit: int = 100) -> list:
    cursor = await db.execute(
        "SELECT id, action, message, ip, bytes_in, bytes_out, created_at "
        "FROM tunnel_log WHERE tunnel_id = ? ORDER BY created_at DESC LIMIT ?",
        (tunnel_id, limit),
    )
    rows = await cursor.fetchall()
    return [
        {
            "id": r[0], "action": r[1], "message": r[2],
            "ip": r[3], "bytes_in": r[4], "bytes_out": r[5], "created_at": r[6],
        }
        for r in rows
    ]


# ======================== TCP 端口持久化 ========================

async def get_tcp_ports(db: aiosqlite.Connection, tunnel_code: str) -> list:
    """获取隧道已持久化的 TCP 端口映射列表"""
    cursor = await db.execute(
        "SELECT local_port, public_port, name FROM tunnel_tcp_port WHERE tunnel_code = ?",
        (tunnel_code,),
    )
    rows = await cursor.fetchall()
    return [{"local_port": r[0], "public_port": r[1], "name": r[2]} for r in rows]


async def save_tcp_port(db: aiosqlite.Connection, tunnel_code: str,
                        local_port: int, public_port: int, name: str = ""):
    """持久化一条 TCP 端口映射"""
    await db.execute(
        "INSERT OR REPLACE INTO tunnel_tcp_port (id, tunnel_code, local_port, public_port, name, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (str(uuid.uuid4()), tunnel_code, local_port, public_port, name, _now()),
    )
    await db.commit()


async def delete_tcp_ports(db: aiosqlite.Connection, tunnel_code: str):
    """删除隧道的所有 TCP 端口映射"""
    await db.execute("DELETE FROM tunnel_tcp_port WHERE tunnel_code = ?", (tunnel_code,))
    await db.commit()


# ======================== HTTP 端口持久化 ========================

async def get_http_port(db: aiosqlite.Connection, tunnel_code: str) -> Optional[dict]:
    """获取隧道已持久化的 HTTP 端口映射"""
    cursor = await db.execute(
        "SELECT local_port, public_port FROM tunnel_http_port WHERE tunnel_code = ?",
        (tunnel_code,),
    )
    row = await cursor.fetchone()
    if row:
        return {"local_port": row[0], "public_port": row[1]}
    return None


async def save_http_port(db: aiosqlite.Connection, tunnel_code: str,
                         local_port: int, public_port: int):
    """持久化一条 HTTP 端口映射（每个隧道只有一个 HTTP 端口）"""
    await db.execute(
        "INSERT OR REPLACE INTO tunnel_http_port (id, tunnel_code, local_port, public_port, created_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (str(uuid.uuid4()), tunnel_code, local_port, public_port, _now()),
    )
    await db.commit()


async def delete_http_port(db: aiosqlite.Connection, tunnel_code: str):
    """删除隧道的 HTTP 端口映射"""
    await db.execute("DELETE FROM tunnel_http_port WHERE tunnel_code = ?", (tunnel_code,))
    await db.commit()


# ======================== 子域名持久化 ========================

async def get_subdomain(db: aiosqlite.Connection, tunnel_code: str) -> Optional[dict]:
    """获取隧道已持久化的子域名映射"""
    cursor = await db.execute(
        "SELECT subdomain, local_port FROM tunnel_subdomain WHERE tunnel_code = ?",
        (tunnel_code,),
    )
    row = await cursor.fetchone()
    if row:
        return {"subdomain": row[0], "local_port": row[1]}
    return None


async def get_subdomain_by_name(db: aiosqlite.Connection, subdomain: str) -> Optional[dict]:
    """根据子域名查找映射"""
    cursor = await db.execute(
        "SELECT tunnel_code, subdomain, local_port FROM tunnel_subdomain WHERE subdomain = ?",
        (subdomain,),
    )
    row = await cursor.fetchone()
    if row:
        return {"tunnel_code": row[0], "subdomain": row[1], "local_port": row[2]}
    return None


async def save_subdomain(db: aiosqlite.Connection, tunnel_code: str,
                         subdomain: str, local_port: int):
    """持久化子域名映射（每个隧道只有一个子域名）"""
    await db.execute(
        "INSERT OR REPLACE INTO tunnel_subdomain (id, tunnel_code, subdomain, local_port, created_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (str(uuid.uuid4()), tunnel_code, subdomain, local_port, _now()),
    )
    await db.commit()


async def delete_subdomain(db: aiosqlite.Connection, tunnel_code: str):
    """删除隧道的子域名映射"""
    await db.execute("DELETE FROM tunnel_subdomain WHERE tunnel_code = ?", (tunnel_code,))
    await db.commit()


# ======================== SSL 证书配置 ========================

async def get_ssl_config(db: aiosqlite.Connection) -> Optional[dict]:
    """获取 SSL 证书配置"""
    cursor = await db.execute(
        "SELECT id, domain, ali_key, ali_secret, cert_path, key_path, not_before, not_after, last_renew, renew_log, updated_at "
        "FROM ssl_config LIMIT 1"
    )
    row = await cursor.fetchone()
    if row:
        return {
            "id": row[0], "domain": row[1],
            "ali_key": row[2], "ali_secret": row[3],
            "cert_path": row[4], "key_path": row[5],
            "not_before": row[6], "not_after": row[7],
            "last_renew": row[8], "renew_log": row[9],
            "updated_at": row[10],
        }
    return None


async def save_ssl_config(db: aiosqlite.Connection, domain: str,
                          ali_key: str, ali_secret: str) -> dict:
    """保存 SSL 证书的阿里云 API 配置"""
    existing = await get_ssl_config(db)
    now = _now()
    if existing:
        await db.execute(
            "UPDATE ssl_config SET domain = ?, ali_key = ?, ali_secret = ?, updated_at = ? WHERE id = ?",
            (domain, ali_key, ali_secret, now, existing["id"]),
        )
    else:
        tid = str(uuid.uuid4())
        cert_path = f"/etc/letsencrypt/live/{domain}/fullchain.pem"
        key_path = f"/etc/letsencrypt/live/{domain}/privkey.pem"
        await db.execute(
            "INSERT INTO ssl_config (id, domain, ali_key, ali_secret, cert_path, key_path, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (tid, domain, ali_key, ali_secret, cert_path, key_path, now),
        )
    await db.commit()
    return await get_ssl_config(db)


async def update_ssl_cert_info(db: aiosqlite.Connection, not_before: str,
                                not_after: str, renew_log: str = "") -> dict:
    """更新证书的有效期信息（续证成功后调用）"""
    existing = await get_ssl_config(db)
    if not existing:
        return None
    now = _now()
    await db.execute(
        "UPDATE ssl_config SET not_before = ?, not_after = ?, last_renew = ?, renew_log = ?, updated_at = ? WHERE id = ?",
        (not_before, not_after, now, renew_log, now, existing["id"]),
    )
    await db.commit()
    return await get_ssl_config(db)


# ======================== Helpers ========================

def _now() -> str:
    return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")


def _row_to_tunnel(row) -> dict:
    return {
        "id": row[0],
        "name": row[1],
        "code": row[2],
        "local_port": row[3],
        "local_host": row[4],
        "auth_token": row[5],
        "status": row[6],
        "public_url": row[7],
        "p2p_info": row[8],
        "description": row[9] or "",
        "created_at": row[10],
        "updated_at": row[11],
    }
