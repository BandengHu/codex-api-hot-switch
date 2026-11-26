"""知识库服务的运行参数，全部来自环境变量，便于后续扩展多个知识库。"""

import os
from pathlib import Path


def _env(name: str, default: str) -> str:
    value = os.environ.get(name)
    return value if value else default


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


ROOT = Path(_env("KB_ROOT", "/opt/kb"))
DATA_DIR = ROOT / "data"
DB_PATH = Path(_env("KB_DB", str(DATA_DIR / "kb.sqlite3")))

# 查询编码用的向量模型（索引向量由本地构建，这里只编码查询语句）
MODEL_DIR = Path(_env("KB_MODEL_DIR", str(ROOT / "models" / "bge-small-zh-onnx")))

LISTEN_HOST = _env("KB_HOST", "127.0.0.1")
LISTEN_PORT = _env_int("KB_PORT", 54142)

# 对外服务时的公开地址，写进 /docs 与给智能体的接入说明
PUBLIC_BASE_URL = _env("KB_PUBLIC_BASE_URL", "")

# 挂在反代子路径下时的前缀（如 /kb）；直接访问根路径时留空
PATH_PREFIX = _env("KB_PATH_PREFIX", "")

CHUNK_TARGET_CHARS = _env_int("KB_CHUNK_CHARS", 420)
CHUNK_OVERLAP_CHARS = _env_int("KB_CHUNK_OVERLAP", 80)

DEFAULT_TOP_K = _env_int("KB_TOP_K", 8)

