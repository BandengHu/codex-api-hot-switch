"""API Key 鉴权。

密钥只存 sha256，不落明文；比较用常量时间，避免时序侧信道。
"""

import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path
from typing import Dict, List, Optional

import config

KEYS_PATH = Path(os.environ.get("KB_KEYS_FILE", str(config.DATA_DIR / "api-keys.json")))


def _load() -> Dict:
    if not KEYS_PATH.is_file():
        return {"version": 1, "keys": []}
    with KEYS_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


def _save(payload: Dict) -> None:
    KEYS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = KEYS_PATH.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    tmp.replace(KEYS_PATH)
    os.chmod(KEYS_PATH, 0o600)


def _hash(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def fingerprint(key: str) -> str:
    return _hash(key)[:8]


def create_key(name: str, libraries: Optional[List[str]] = None) -> Dict:
    """生成一个新 key；明文只在创建时返回一次。"""
    payload = _load()
    raw = "kb_" + secrets.token_urlsafe(32)
    record = {
        "id": secrets.token_hex(8),
        "name": name,
        "fingerprint": fingerprint(raw),
        "hash": _hash(raw),
        "libraries": libraries or ["*"],
        "created_at": time.time(),
        "last_used_at": None,
        "use_count": 0,
        "enabled": True,
    }
    payload["keys"].append(record)
    _save(payload)
    return {"key": raw, "id": record["id"], "name": name, "libraries": record["libraries"]}


def list_keys() -> List[Dict]:
    out = []
    for record in _load().get("keys", []):
        item = {k: v for k, v in record.items() if k != "hash"}
        out.append(item)
    return out


def revoke_key(key_id: str) -> bool:
    payload = _load()
    before = len(payload.get("keys", []))
    payload["keys"] = [k for k in payload["keys"] if k["id"] != key_id]
    if len(payload["keys"]) == before:
        return False
    _save(payload)
    return True


def authenticate(raw_key: str) -> Optional[Dict]:
    if not raw_key:
        return None
    digest = _hash(raw_key)
    for record in _load().get("keys", []):
        if not record.get("enabled", True):
            continue
        if hmac.compare_digest(record.get("hash", ""), digest):
            _touch(record["id"])
            return record
    return None


def _touch(key_id: str) -> None:
    payload = _load()
    for record in payload.get("keys", []):
        if record["id"] == key_id:
            record["use_count"] = record.get("use_count", 0) + 1
            record["last_used_at"] = time.time()
            break
    try:
        _save(payload)
    except OSError:
        pass


def allowed_libraries(record: Dict) -> List[str]:
    libs = record.get("libraries") or ["*"]
    return libs


def can_access(record: Dict, library: str) -> bool:
    libs = allowed_libraries(record)
    return "*" in libs or library in libs

