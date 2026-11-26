"""索引读写：SQLite 存文档与 FTS5，向量单独存 float32 矩阵。

为什么不用 sqlite-vec：
在 1.6 万条 512 维向量上，vec0 的 kNN 查询实测卡死（100% CPU 超过 100 秒），
而同一份数据用 numpy 矩阵做全量点积只要几毫秒。向量总量在几十万级以内，
内存矩阵是最简单也最快的选择，且不引入扩展依赖。
"""

import json
import logging
import sqlite3
import threading
import time
from pathlib import Path
from typing import Dict, List, Optional, Sequence

import numpy as np

from text import segment_text

log = logging.getLogger("kb.index")

SCHEMA = """
pragma journal_mode = wal;
pragma synchronous = normal;

create table if not exists libraries (
  name        text primary key,
  title       text not null,
  description text,
  source      text,
  created_at  real not null,
  doc_count   integer not null default 0,
  chunk_count integer not null default 0,
  char_count  integer not null default 0,
  dim         integer not null default 0,
  model       text
);

create table if not exists documents (
  id          integer primary key autoincrement,
  library     text not null,
  external_id text,
  title       text not null,
  raw         text not null,
  meta        text,
  char_count  integer not null default 0,
  created_at  real not null
);
create index if not exists idx_documents_library on documents(library);
create unique index if not exists ux_documents_external
  on documents(library, external_id) where external_id is not null;

create table if not exists chunks (
  id          integer primary key autoincrement,
  document_id integer not null,
  library     text not null,
  ordinal     integer not null,
  content     text not null,
  heading     text,
  char_count  integer not null default 0
);
create index if not exists idx_chunks_document on chunks(document_id);
create index if not exists idx_chunks_library on chunks(library);

create virtual table if not exists chunks_fts using fts5(
  content,
  tokens,
  tokenize = 'unicode61 remove_diacritics 2'
);
"""


class IndexStore:
    def __init__(self, path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        self._lock = threading.Lock()
        # 向量矩阵常驻内存：library -> (chunk_ids array, matrix float32)
        self._vectors: Dict[str, tuple] = {}
        self._init_schema()
        self.reload_vectors()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.path), timeout=30,
                               check_same_thread=False, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("pragma busy_timeout = 30000")
        return conn

    @property
    def conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = self._connect()
            self._local.conn = conn
        return conn

    def _init_schema(self) -> None:
        conn = self._connect()
        try:
            conn.executescript(SCHEMA)
        finally:
            conn.close()

    # ---------------- 向量矩阵 ----------------
    def vectors_dir(self) -> Path:
        return self.path.parent / "vectors"

    def vector_path(self, library: str) -> Path:
        return self.vectors_dir() / ("%s.npz" % library)

    def reload_vectors(self) -> Dict[str, int]:
        """把磁盘上的 npz 向量文件读进内存。"""
        loaded = {}
        with self._lock:
            self._vectors.clear()
            if not self.vectors_dir().is_dir():
                return loaded
            for path in sorted(self.vectors_dir().glob("*.npz")):
                library = path.stem
                try:
                    data = np.load(path, allow_pickle=False)
                    ids = data["chunk_ids"].astype(np.int64)
                    matrix = data["vectors"].astype(np.float32)
                    self._vectors[library] = (ids, matrix)
                    loaded[library] = int(matrix.shape[0])
                except Exception as exc:
                    log.error("load vectors failed %s: %s", path, exc)
        return loaded

    def vector_stats(self) -> Dict[str, Dict]:
        with self._lock:
            return {
                name: {"rows": int(matrix.shape[0]), "dim": int(matrix.shape[1])}
                for name, (_ids, matrix) in self._vectors.items()
            }

    # ---------------- 库管理 ----------------
    def upsert_library(self, name, title, description="", source="", dim=0, model=""):
        self.conn.execute(
            """
            insert into libraries(name, title, description, source, created_at, dim, model)
            values (?, ?, ?, ?, ?, ?, ?)
            on conflict(name) do update set
              title = excluded.title,
              description = excluded.description,
              source = excluded.source,
              dim = excluded.dim,
              model = excluded.model
            """,
            (name, title, description, source, time.time(), dim, model),
        )

    def library_exists(self, name) -> bool:
        return self.conn.execute("select 1 from libraries where name = ?", (name,)).fetchone() is not None

    def list_libraries(self) -> List[Dict]:
        rows = self.conn.execute(
            """
            select name, title, description, source, created_at,
                   doc_count, chunk_count, char_count, dim, model
              from libraries order by created_at
            """
        ).fetchall()
        return [dict(row) for row in rows]

    def refresh_counts(self, library):
        row = self.conn.execute(
            """
            select count(distinct d.id) as docs, count(c.id) as chunks,
                   coalesce(sum(c.char_count), 0) as chars
              from documents d left join chunks c on c.document_id = d.id
             where d.library = ?
            """,
            (library,),
        ).fetchone()
        self.conn.execute(
            "update libraries set doc_count=?, chunk_count=?, char_count=? where name=?",
            (row["docs"], row["chunks"], row["chars"], library),
        )

    def drop_library(self, library):
        rows = self.conn.execute("select id from documents where library = ?", (library,)).fetchall()
        for row in rows:
            self.delete_document_by_id(row["id"])
        self.conn.execute("delete from documents where library = ?", (library,))
        path = self.vector_path(library)
        if path.is_file():
            path.unlink()
        with self._lock:
            self._vectors.pop(library, None)
        return len(rows)

    # ---------------- 文档写入 ----------------
    def delete_document_by_id(self, document_id: int) -> int:
        rows = self.conn.execute("select id from chunks where document_id = ?", (document_id,)).fetchall()
        for row in rows:
            self.conn.execute("delete from chunks_fts where rowid = ?", (row["id"],))
        self.conn.execute("delete from chunks where document_id = ?", (document_id,))
        return len(rows)

    def delete_document(self, library: str, external_id: str) -> int:
        row = self.conn.execute(
            "select id from documents where library = ? and external_id = ?", (library, external_id)
        ).fetchone()
        if row is None:
            return 0
        removed = self.delete_document_by_id(row["id"])
        self.conn.execute("delete from documents where id = ?", (row["id"],))
        return removed

    def add_document(self, library, title, raw, external_id, meta, chunk_texts, headings):
        if external_id:
            self.delete_document(library, external_id)
        cursor = self.conn.execute(
            """
            insert into documents(library, external_id, title, raw, meta, char_count, created_at)
            values (?, ?, ?, ?, ?, ?, ?)
            """,
            (library, external_id, title, raw, json.dumps(meta or {}, ensure_ascii=False),
             len(raw), time.time()),
        )
        document_id = cursor.lastrowid
        for ordinal, chunk in enumerate(chunk_texts):
            heading = headings[ordinal] if ordinal < len(headings) else title
            chunk_cursor = self.conn.execute(
                """
                insert into chunks(document_id, library, ordinal, content, heading, char_count)
                values (?, ?, ?, ?, ?, ?)
                """,
                (document_id, library, ordinal, chunk, heading or title, len(chunk)),
            )
            self.conn.execute(
                "insert into chunks_fts(rowid, content, tokens) values (?, ?, ?)",
                (chunk_cursor.lastrowid, chunk, segment_text(chunk)),
            )
        return {"document_id": document_id, "chunks": len(chunk_texts)}

    # ---------------- 检索 ----------------
    def match_expression(self, expression: str, library: str, limit: int):
        if not expression:
            return []
        rows = self.conn.execute(
            """
            select c.id, c.document_id, c.content, c.heading, c.ordinal,
                   d.title, d.external_id, bm25(chunks_fts) as score
              from chunks_fts
              join chunks c on c.id = chunks_fts.rowid
              join documents d on d.id = c.document_id
             where chunks_fts match ? and c.library = ?
             order by score limit ?
            """,
            (expression, library, limit),
        ).fetchall()
        return [dict(row) for row in rows]

    def vector_search(self, vector: Sequence[float], library: str, limit: int):
        with self._lock:
            entry = self._vectors.get(library)
        if entry is None:
            return []
        ids, matrix = entry
        query = np.asarray(vector, dtype=np.float32)
        norm = float(np.linalg.norm(query))
        if norm > 0:
            query = query / norm
        scores = matrix @ query
        top = np.argpartition(-scores, min(limit, len(scores) - 1))[:limit]
        top = top[np.argsort(-scores[top])]
        chunk_ids = ids[top]
        if len(chunk_ids) == 0:
            return []

        placeholders = ",".join("?" * len(chunk_ids))
        rows = self.conn.execute(
            """
            select c.id, c.document_id, c.content, c.heading, c.ordinal,
                   d.title, d.external_id
              from chunks c join documents d on d.id = c.document_id
             where c.id in (%s)
            """ % placeholders,
            [int(x) for x in chunk_ids],
        ).fetchall()
        by_id = {row["id"]: dict(row) for row in rows}
        out = []
        for position, chunk_id in enumerate(chunk_ids):
            item = by_id.get(int(chunk_id))
            if item is None:
                continue
            item["similarity"] = round(float(scores[top[position]]), 4)
            out.append(item)
        return out

    def scan_chunks(self, library: str, document_id=None):
        """全库流式扫描，供正则检索逐条比对。

        必须真正扫完整个库：正则表达式形如 R1[6-8]、[《]天地一体 时，
        取出的字面量探测词（R1 / 天地一体）在 FTS 里命中的往往是别的词元
        （R16、R19 都含 R1 前缀），粗召回既不全也不准。1.6 万条内容全扫
        实测 55~95ms，直接扫更可靠也更简单。

        逐条 yield，避免一次性把 16 万行正文读进内存。
        """
        if document_id is None:
            cursor = self.conn.execute(
                """
                select c.id, c.document_id, c.content, c.heading, c.ordinal,
                       d.title, d.external_id, 0.0 as score
                  from chunks c join documents d on d.id = c.document_id
                 where c.library = ? order by c.id
                """,
                (library,),
            )
        else:
            cursor = self.conn.execute(
                """
                select c.id, c.document_id, c.content, c.heading, c.ordinal,
                       d.title, d.external_id, 0.0 as score
                  from chunks c join documents d on d.id = c.document_id
                 where c.library = ? and c.document_id = ? order by c.id
                """,
                (library, document_id),
            )
        for row in cursor:
            yield dict(row)

    def get_document(self, document_id: int):
        row = self.conn.execute("select * from documents where id = ?", (document_id,)).fetchone()
        return dict(row) if row else None

    def get_document_chunks(self, document_id: int):
        rows = self.conn.execute(
            "select id, ordinal, content, heading from chunks where document_id = ? order by ordinal",
            (document_id,),
        ).fetchall()
        return [dict(row) for row in rows]

    def begin(self):
        self.conn.execute("begin")

    def commit(self):
        self.conn.execute("commit")

    def rollback(self):
        self.conn.execute("rollback")

