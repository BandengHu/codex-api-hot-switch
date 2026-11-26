"""本地编码器：bge-small-zh 量化 ONNX；有 GPU 就走 GPU。

实测（256 块、平均 876 字、RTX 3050 Ti 4G）：
  CPU 8 线程   33.5s   7.6 块/s
  DirectML     4.2s   61.2 块/s   → 8 倍

DirectML 走 Windows 自带的 D3D12，不需要装 CUDA Toolkit；显存不够会自己回退到内存。
GPU 与 CPU 的向量余弦相似度 0.9985~0.9998，排序结果一致。

服务器上跑的是 deploy/kb/embedder.py（只编码查询），与本文件无关。
"""

import os
import time
from pathlib import Path
from typing import List, Sequence

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

# bge 官方推荐：检索查询加指令前缀，被索引的文档不加
QUERY_PREFIX = "为这个句子生成表示："
MAX_SEQ_LEN = 512

# GPU 上大 batch 明显更划算：显存 4G 时 64 是安全上限，再大就容易 OOM 回退
GPU_BATCH_SIZE = 64
CPU_BATCH_SIZE = 32


def pick_providers() -> tuple:
    """按「用户指定 > GPU > CPU」的顺序选执行后端，返回 (providers, 标签)。"""
    available = ort.get_available_providers()
    forced = (os.environ.get("KB_EMBED_PROVIDER") or "").strip().lower()

    if forced == "cpu":
        return ["CPUExecutionProvider"], "cpu"
    if forced in ("dml", "directml"):
        if "DmlExecutionProvider" not in available:
            raise SystemExit("指定了 KB_EMBED_PROVIDER=dml，但 onnxruntime 没有 DirectML 支持")
        return ["DmlExecutionProvider", "CPUExecutionProvider"], "dml"
    if forced in ("cuda", "gpu"):
        if "CUDAExecutionProvider" not in available:
            raise SystemExit("指定了 KB_EMBED_PROVIDER=cuda，但 onnxruntime 没有 CUDA 支持")
        return ["CUDAExecutionProvider", "CPUExecutionProvider"], "cuda"

    if "DmlExecutionProvider" in available:
        return ["DmlExecutionProvider", "CPUExecutionProvider"], "dml"
    if "CUDAExecutionProvider" in available:
        return ["CUDAExecutionProvider", "CPUExecutionProvider"], "cuda"
    return ["CPUExecutionProvider"], "cpu"


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
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        providers, self.device = pick_providers()
        if self.device == "cpu":
            options.intra_op_num_threads = max(2, (os_cpu_count() or 4))

        self._session = ort.InferenceSession(
            str(onnx_path), sess_options=options, providers=providers
        )
        self._inputs = [item.name for item in self._session.get_inputs()]
        self.batch_size = GPU_BATCH_SIZE if self.device != "cpu" else CPU_BATCH_SIZE

        # DirectML 首次推理要编译算子，几分钟的构建里预热一次很值
        self._warmup()

        print("embedder ready %.2fs device=%s providers=%s inputs=%s batch=%d" % (
            time.time() - started,
            self.device,
            ",".join(self._session.get_providers()),
            ",".join(self._inputs),
            self.batch_size,
        ))

    def _warmup(self) -> None:
        started = time.time()
        self._encode_batch(["预热"])
        print("embedder warmup %.2fs" % (time.time() - started))

    def encode(self, texts: Sequence[str], batch_size: int = None) -> np.ndarray:
        if not texts:
            return np.zeros((0, 512), dtype=np.float32)
        if batch_size is None:
            batch_size = self.batch_size
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

