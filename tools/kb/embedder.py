"""本地编码器：bge-small-zh 量化 ONNX，CPU 推理。"""

import time
from pathlib import Path
from typing import List, Sequence

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

# bge 官方推荐：检索查询加指令前缀，被索引的文档不加
QUERY_PREFIX = "为这个句子生成表示："
MAX_SEQ_LEN = 512


class Embedder:
    def __init__(self, model_dir) -> None:
        model_dir = Path(model_dir)
        onnx_path = model_dir / "onnx" / "model_quantized.onnx"
        tokenizer_path = model_dir / "tokenizer.json"
        if not onnx_path.is_file():
            raise SystemExit("模型缺失: %s" % onnx_path)

        started = time.time()
        self._tokenizer = Tokenizer.from_file(str(tokenizer_path))
        self._tokenizer.enable_truncation(max_length=MAX_SEQ_LEN)
        self._tokenizer.enable_padding(pad_id=0, pad_token="[PAD]")

        options = ort.SessionOptions()
        options.intra_op_num_threads = max(2, (os_cpu_count() or 4))
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self._session = ort.InferenceSession(
            str(onnx_path), sess_options=options, providers=["CPUExecutionProvider"]
        )
        self._inputs = [item.name for item in self._session.get_inputs()]
        print("embedder ready %.2fs inputs=%s" % (time.time() - started, ",".join(self._inputs)))

    def encode(self, texts: Sequence[str], batch_size: int = 32) -> np.ndarray:
        if not texts:
            return np.zeros((0, 512), dtype=np.float32)
        out: List[np.ndarray] = []
        for start in range(0, len(texts), batch_size):
            out.append(self._encode_batch(list(texts[start:start + batch_size])))
        return np.vstack(out)

    def encode_query(self, query: str) -> np.ndarray:
        return self.encode([QUERY_PREFIX + query])[0]

    def _encode_batch(self, batch: List[str]) -> np.ndarray:
        encodings = self._tokenizer.encode_batch(batch)
        ids = np.array([enc.ids for enc in encodings], dtype=np.int64)
        mask = np.array([enc.attention_mask for enc in encodings], dtype=np.int64)
        feed = {"input_ids": ids, "attention_mask": mask}
        if "token_type_ids" in self._inputs:
            feed["token_type_ids"] = np.zeros_like(ids)
        hidden = self._session.run(None, feed)[0]

        weights = mask[..., None].astype(np.float32)
        pooled = (hidden * weights).sum(axis=1) / np.clip(weights.sum(axis=1), 1e-6, None)
        norms = np.linalg.norm(pooled, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        return (pooled / norms).astype(np.float32)


def os_cpu_count():
    import os
    return os.cpu_count()

