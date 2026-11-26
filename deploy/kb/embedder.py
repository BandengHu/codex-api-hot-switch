"""服务器端编码器：只用于把查询语句转成向量。

索引向量在本地构建，服务器只承担「查询 → 512 维向量」这一步，
300MB 内存、几毫秒一次，不影响线上中转。
"""

import threading
import time
from typing import List, Sequence

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

import config

QUERY_PREFIX = "\u4e3a\u8fd9\u4e2a\u53e5\u5b50\u751f\u6210\u8868\u793a\uff1a"  # 为这个句子生成表示：
MAX_SEQ_LEN = 512

_instance = None
_lock = threading.Lock()


class Embedder:
    def __init__(self) -> None:
        onnx_path = config.MODEL_DIR / "onnx" / "model_quantized.onnx"
        tokenizer_path = config.MODEL_DIR / "tokenizer.json"
        if not onnx_path.is_file():
            raise RuntimeError("向量模型缺失: %s" % onnx_path)

        started = time.time()
        self._tokenizer = Tokenizer.from_file(str(tokenizer_path))
        self._tokenizer.enable_truncation(max_length=MAX_SEQ_LEN)
        self._tokenizer.enable_padding(pad_id=0, pad_token="[PAD]")

        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self._session = ort.InferenceSession(
            str(onnx_path), sess_options=options, providers=["CPUExecutionProvider"]
        )
        self._inputs = [item.name for item in self._session.get_inputs()]
        self._run_lock = threading.Lock()
        self.load_seconds = time.time() - started

    def encode_one(self, text: str, is_query: bool = True) -> List[float]:
        payload = (QUERY_PREFIX + text) if is_query else text
        encodings = self._tokenizer.encode_batch([payload])
        enc = encodings[0]
        ids = np.array([enc.ids], dtype=np.int64)
        mask = np.array([enc.attention_mask], dtype=np.int64)
        feed = {"input_ids": ids, "attention_mask": mask}
        if "token_type_ids" in self._inputs:
            feed["token_type_ids"] = np.zeros_like(ids)
        with self._run_lock:
            hidden = self._session.run(None, feed)[0]
        weights = mask[..., None].astype(np.float32)
        pooled = (hidden * weights).sum(axis=1) / np.clip(weights.sum(axis=1), 1e-6, None)
        norm = float(np.linalg.norm(pooled))
        if norm > 0:
            pooled = pooled / norm
        return [round(float(x), 6) for x in pooled[0]]


def get_embedder() -> Embedder:
    global _instance
    if _instance is None:
        with _lock:
            if _instance is None:
                _instance = Embedder()
    return _instance

