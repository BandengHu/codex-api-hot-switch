"""把本地构建好的索引包装载进服务器数据库。"""

import argparse
import json
import logging
import sys
import time
from pathlib import Path

import numpy as np

import config
from index_store import IndexStore


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--index", required=True, help="xxx.index.json")
    parser.add_argument("--vectors", required=True, help="xxx.vectors.npz")
    parser.add_argument("--replace", action="store_true")
    return parser.parse_args()


def main():
    args = parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    started = time.time()
    payload = json.load(open(args.index, encoding="utf-8"))
    library = payload["library"]
    docs = payload["docs"]
    chunks = payload["chunks"]

    data = np.load(args.vectors, allow_pickle=False)
    vectors = data["vectors"].astype(np.float32)
    if len(vectors) != len(chunks):
        raise SystemExit("向量数 %d 与分块数 %d 不一致" % (len(vectors), len(chunks)))

    store = IndexStore(config.DB_PATH)
    if args.replace and store.library_exists(library):
        removed = store.drop_library(library)
        print("dropped existing library, documents =", removed)

    store.upsert_library(library, payload["title"], payload.get("description", ""),
                         payload.get("source", ""), int(vectors.shape[1]), payload.get("model", ""))

    # 文档与分块写入：一个事务，避免逐条 fsync
    chunk_doc_positions = [item["document"] for item in chunks]
    store.begin()
    try:
        doc_ids = []
        for position, doc in enumerate(docs):
            cursor = store.conn.execute(
                """
                insert into documents(library, external_id, title, raw, meta, char_count, created_at)
                values (?, ?, ?, ?, ?, ?, ?)
                """,
                (library, doc.get("external_id"), doc["title"], doc["raw"],
                 json.dumps(doc.get("meta") or {}, ensure_ascii=False),
                 len(doc["raw"]), time.time()),
            )
            doc_ids.append(cursor.lastrowid)
            if position % 100 == 0:
                print("  documents %d/%d" % (position, len(docs)))

        db_chunk_ids = []
        for position, chunk in enumerate(chunks):
            document_id = doc_ids[chunk_doc_positions[position]]
            cursor = store.conn.execute(
                """
                insert into chunks(document_id, library, ordinal, content, heading, char_count)
                values (?, ?, ?, ?, ?, ?)
                """,
                (document_id, library, position, chunk["content"],
                 chunk.get("heading") or "", len(chunk["content"])),
            )
            db_chunk_ids.append(cursor.lastrowid)
        store.commit()
    except Exception:
        store.rollback()
        raise

    # FTS 索引单独批量灌，避免和文档写入混在一个大事务里
    from text import segment_text
    store.begin()
    try:
        for position, chunk in enumerate(chunks):
            store.conn.execute(
                "insert into chunks_fts(rowid, content, tokens) values (?, ?, ?)",
                (db_chunk_ids[position], chunk["content"], segment_text(chunk["content"])),
            )
        store.commit()
    except Exception:
        store.rollback()
        raise

    store.refresh_counts(library)

    # 向量按数据库真实 chunk id 落盘
    store.vectors_dir().mkdir(parents=True, exist_ok=True)
    target = store.vector_path(library)
    np.savez_compressed(
        target,
        chunk_ids=np.array(db_chunk_ids, dtype=np.int64),
        vectors=vectors,
    )

    loaded = store.reload_vectors()
    print(json.dumps({
        "library": library,
        "documents": len(docs),
        "chunks": len(chunks),
        "dim": int(vectors.shape[1]),
        "seconds": round(time.time() - started, 1),
        "vectors_loaded": loaded,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

