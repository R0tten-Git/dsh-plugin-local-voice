#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用同一批音频横向比较不同量化/尺寸的 Qwen3-ASR 模型。

指标：
  · 加载耗时（冷启动）
  · 每句推理耗时（热态）
  · 字准确率（1 - CER，去标点后算编辑距离）
  · 进程峰值内存（RSS）

用法：
    python3 bench_models.py \
        --model ~/models/Qwen3-ASR-1.7B-8bit \
        --model ~/models/Qwen3-ASR-1.7B-4bit \
        --wav-dir /tmp/stt_test --ref /tmp/stt_test/ref_sent.txt
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WORKER = os.path.join(ROOT, "qwen3_worker.py")

PUNCT = re.compile(r"[，。、；：！？「」『』（）《》〈〉“”‘’\-—…·,.!?;:\"'()\[\]{}<>\s]")


def norm(text: str) -> str:
    return PUNCT.sub("", text)


def edit_distance(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i] + [0] * len(b)
        for j in range(1, len(b) + 1):
            cur[j] = min(
                prev[j] + 1,
                cur[j - 1] + 1,
                prev[j - 1] + (0 if a[i - 1] == b[j - 1] else 1),
            )
        prev = cur
    return prev[-1]


def peak_rss_mb(pid: int) -> float:
    try:
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)],
                             capture_output=True, text=True, timeout=5).stdout.strip()
        return int(out) / 1024.0 if out else 0.0
    except Exception:
        return 0.0


def run_one(model: str, wavs: list[str]) -> dict:
    python = os.path.expanduser("~/.local/venvs/mlx-audio/bin/python")
    t0 = time.time()
    proc = subprocess.Popen(
        [python, WORKER, os.path.expanduser(model)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, bufsize=1,
    )
    ready = proc.stdout.readline()
    load_ms = int((time.time() - t0) * 1000)
    try:
        if json.loads(ready).get("type") != "ready":
            raise RuntimeError(f"worker 没就绪: {ready[:120]}")
    except Exception as error:
        proc.kill()
        raise RuntimeError(f"加载失败：{error}")

    texts, times = [], []
    for index, wav in enumerate(wavs):
        with open(wav, "rb") as handle:
            payload = base64.b64encode(handle.read()).decode()
        started = time.time()
        proc.stdin.write(json.dumps({"id": index, "wav": payload, "language": "auto"}) + "\n")
        proc.stdin.flush()
        reply = json.loads(proc.stdout.readline())
        times.append(time.time() - started)
        texts.append((reply.get("text") or "").strip())

    rss = peak_rss_mb(proc.pid)
    proc.stdin.close()
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except Exception:
        proc.kill()

    return {"load_ms": load_ms, "times": times, "texts": texts, "rss_mb": rss}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", action="append", required=True)
    parser.add_argument("--wav-dir", default="/tmp/stt_test")
    parser.add_argument("--ref", default="/tmp/stt_test/ref_sent.txt")
    args = parser.parse_args()

    refs = [line.strip() for line in open(args.ref, encoding="utf-8") if line.strip()]
    wavs = [os.path.join(args.wav_dir, f"seg_{i}.wav") for i in range(len(refs))]
    missing = [w for w in wavs if not os.path.exists(w)]
    if missing:
        print(f"× 缺音频：{missing[:2]}", file=sys.stderr)
        return 2

    print(f"样本：{len(refs)} 句 / {sum(len(norm(r)) for r in refs)} 字\n")
    rows = []
    for model in args.model:
        name = os.path.basename(model.rstrip("/"))
        print(f"▶ {name} …", flush=True)
        try:
            result = run_one(model, wavs)
        except Exception as error:
            print(f"  × 失败：{error}\n")
            continue

        errors = 0
        total = 0
        for ref, hyp in zip(refs, result["texts"]):
            r, h = norm(ref), norm(hyp)
            total += len(r)
            errors += edit_distance(r, h)

        rows.append({
            "name": name,
            "load_ms": result["load_ms"],
            "avg_ms": sum(result["times"]) / len(result["times"]) * 1000,
            "max_ms": max(result["times"]) * 1000,
            "cer": errors / max(1, total),
            "rss_mb": result["rss_mb"],
            "texts": result["texts"],
        })
        print(f"  加载 {result['load_ms']}ms | 每句均 {rows[-1]['avg_ms']:.0f}ms "
              f"峰 {rows[-1]['max_ms']:.0f}ms | 准确率 {(1 - rows[-1]['cer']) * 100:.2f}% "
              f"| RSS {rows[-1]['rss_mb']:.0f}MB\n")

    if not rows:
        return 1

    print("=" * 78)
    print(f"{'模型':<26} {'加载':>7} {'每句均':>8} {'最慢':>7} {'准确率':>8} {'RSS':>8}")
    print("-" * 78)
    for row in rows:
        print(f"{row['name']:<26} {row['load_ms']:>6}ms {row['avg_ms']:>7.0f}ms "
              f"{row['max_ms']:>6.0f}ms {(1 - row['cer']) * 100:>7.2f}% {row['rss_mb']:>7.0f}MB")

    print("\n逐句对照（基准 = 第一个模型）：")
    base = rows[0]
    for index, ref in enumerate(refs, 1):
        print(f"\n{index}. {ref}")
        for row in rows:
            mark = "✓" if norm(row["texts"][index - 1]) == norm(ref) else "✗"
            print(f"   {mark} [{row['name'][:22]:<22}] {row['texts'][index - 1]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
