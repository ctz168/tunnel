"""
TunnelNet - 数据库操作层 (SQLite + aiosqlite)
"""
import os
import uuid
import secrets
import string
from datetime import datetime

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
    local_port  INTEGER NOT NULL,
    local_host  TEXT NOT NULL DEFAULT 'localhost',
    auth_token  TEXT UNIQUE NOT NULL,
    status      TEXT NOT NULL DEFAULT 'offline',
    description TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
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
"""


async def init_db():
    """初始化数据库，建表"""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.executescript(_SCHEMA)
        # 确保有一条默认配置
        await db.execute(
            "INSERT OR IGNORE INTO server_config (id, domain, updated_at) VALUES (?, ?, ?)",
            ("default", "aicq.online:7739", _now()),
        )
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


async def list_tunnels(db: aiosqlite.Connection) -> list[dict]:
    cursor = await db.execute(
        "SELECT id, name, code, local_port, local_host, auth_token, status, description, created_at, updated_at "
        "FROM tunnel ORDER BY created_at DESC"
    )
    rows = await cursor.fetchall()
    return [_row_to_tunnel(r) for r in rows]


async def get_tunnel(db: aiosqlite.Connection, code: str) -> dict | None:
    cursor = await db.execute("SELECT * FROM tunnel WHERE code = ?", (code.upper(),))
    row = await cursor.fetchone()
    return _row_to_tunnel(row) if row else None


async def get_tunnel_by_token(db: aiosqlite.Connection, token: str) -> dict | None:
    cursor = await db.execute(
        "SELECT id, name, code, local_port, local_host, auth_token, status, description, created_at, updated_at "
        "FROM tunnel WHERE auth_token = ?", (token,)
    )
    row = await cursor.fetchone()
    return _row_to_tunnel(row) if row else None


async def create_tunnel(db: aiosqlite.Connection, name: str, local_port: int,
                        local_host: str = "localhost", description: str = "") -> dict:
    code = _gen_code()
    token = _gen_token()
    tid = str(uuid.uuid4())
    now = _now()
    await db.execute(
        "INSERT INTO tunnel (id, name, code, local_port, local_host, auth_token, status, description, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, 'offline', ?, ?, ?)",
        (tid, name, code, local_port, local_host, token, description, now, now),
    )
    await db.commit()
    return {
        "id": tid,
        "name": name,
        "code": code,
        "local_port": local_port,
        "local_host": local_host,
        "auth_token": token,
        "status": "offline",
        "description": description,
        "created_at": now,
        "updated_at": now,
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


# ======================== Logs ========================

async def add_log(db: aiosqlite.Connection, tunnel_id: str, action: str,
                  message: str, ip: str = "", bytes_in: int = 0, bytes_out: int = 0):
    await db.execute(
        "INSERT INTO tunnel_log (id, tunnel_id, action, message, ip, bytes_in, bytes_out, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (str(uuid.uuid4()), tunnel_id, action, message, ip, bytes_in, bytes_out, _now()),
    )
    await db.commit()


async def get_logs(db: aiosqlite.Connection, tunnel_id: str, limit: int = 100) -> list[dict]:
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
        "description": row[7] or "",
        "created_at": row[8],
        "updated_at": row[9],
    }
