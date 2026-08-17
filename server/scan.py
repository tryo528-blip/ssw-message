#!/usr/bin/env python3
"""2단계 문서 보정. 정규화본은 유지하고, 확신이 있을 때만 *_scan.jpg 를 만든다.

    python scan.py <record.json>
    python scan.py --all

실패·건너뜀은 에러가 아니다. PIPELINE.md §3
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
READY = HERE / "inbox" / "ready" / "photo"


def apply_orientation(img, ori: int):
    import cv2
    if ori == 2:
        return cv2.flip(img, 1)
    if ori == 3:
        return cv2.rotate(img, cv2.ROTATE_180)
    if ori == 4:
        return cv2.flip(img, 0)
    if ori == 5:
        return cv2.transpose(cv2.flip(img, 0))
    if ori == 6:
        return cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
    if ori == 7:
        return cv2.transpose(cv2.flip(img, 1))
    if ori == 8:
        return cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return img


def order_quad(pts):
    import numpy as np
    pts = pts.reshape(4, 2).astype(np.float32)
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).reshape(4)
    return np.array([pts[np.argmin(s)], pts[np.argmin(d)], pts[np.argmax(s)], pts[np.argmax(d)]], dtype=np.float32)


def find_quad(gray):
    import cv2
    import numpy as np
    h, w = gray.shape
    area0 = float(h * w)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enh = clahe.apply(blur)
    edges = cv2.Canny(enh, 50, 150)
    edges = cv2.dilate(edges, None)
    cnts, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    best, best_a = None, 0.0
    for c in cnts:
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.02 * peri, True)
        if len(approx) != 4 or not cv2.isContourConvex(approx):
            continue
        a = abs(cv2.contourArea(approx))
        if a < 0.20 * area0 or a <= best_a:
            continue
        q = order_quad(approx)
        width = np.linalg.norm(q[1] - q[0])
        height = np.linalg.norm(q[3] - q[0])
        if width < 32 or height < 32:
            continue
        ratio = width / height
        if ratio < 0.35 or ratio > 2.8:
            continue
        best, best_a = q, a
    return best


def enhance_doc(warped):
    import cv2
    import numpy as np
    g = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY) if warped.ndim == 3 else warped
    bg = cv2.GaussianBlur(g, (0, 0), 15)
    bg[bg == 0] = 1
    norm = np.clip(g.astype(np.float32) / bg.astype(np.float32) * 230.0, 0, 255).astype(np.uint8)
    sharp = cv2.addWeighted(norm, 1.25, cv2.GaussianBlur(norm, (0, 0), 1.0), -0.25, 0)
    return cv2.cvtColor(sharp, cv2.COLOR_GRAY2BGR)


def process_file(folder: Path, rec: dict, f: dict) -> dict:
    import cv2
    import numpy as np
    src = folder / f["name"]
    img = cv2.imdecode(np.fromfile(str(src), dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        f["scan"] = None
        f["scan_status"] = "skipped"
        f["scan_reason"] = "undecodable"
        return f
    ori = int(f.get("orientation_pending") or 1)
    if ori != 1:
        img = apply_orientation(img, ori)
        ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
        if ok:
            buf.tofile(str(src))
            f["bytes"] = int(buf.size)
            f["width"], f["height"] = int(img.shape[1]), int(img.shape[0])
            f["orientation_applied"] = ori
            f["orientation_pending"] = 1
    t0 = time.perf_counter()
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    quad = find_quad(gray)
    if quad is None:
        f["scan"] = None
        f["scan_status"] = "skipped"
        f["scan_reason"] = "no_quad"
        f["scan_ms"] = int((time.perf_counter() - t0) * 1000)
        return f
    import numpy as np
    w = int(max(np.linalg.norm(quad[1] - quad[0]), np.linalg.norm(quad[2] - quad[3])))
    h = int(max(np.linalg.norm(quad[3] - quad[0]), np.linalg.norm(quad[2] - quad[1])))
    dst = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], dtype=np.float32)
    M = cv2.getPerspectiveTransform(quad, dst)
    warped = cv2.warpPerspective(img, M, (w, h))
    out = enhance_doc(warped)
    scan_name = Path(f["name"]).stem + "_scan.jpg"
    ok, buf = cv2.imencode(".jpg", out, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
    if not ok:
        f["scan_status"] = "failed"
        f["scan_reason"] = "encode"
        return f
    buf.tofile(str(folder / scan_name))
    f["scan"] = scan_name
    f["scan_status"] = "ok"
    f["scan_reason"] = None
    f["scan_ms"] = int((time.perf_counter() - t0) * 1000)
    return f


def process_record(json_path: Path) -> None:
    rec = json.loads(json_path.read_text(encoding="utf-8"))
    files = rec.get("files") or []
    if not files:
        return
    try:
        import cv2  # noqa: F401
    except ImportError:
        for f in files:
            if f.get("scan_status") == "pending":
                f["scan_status"] = "skipped"
                f["scan_reason"] = "opencv_missing"
        _write(json_path, rec)
        return
    folder = json_path.parent
    changed = False
    for f in files:
        if f.get("scan_status") not in (None, "pending"):
            continue
        process_file(folder, rec, f)
        changed = True
    if changed:
        _write(json_path, rec)


def _write(path: Path, rec: dict) -> None:
    tmp = path.with_suffix(".json.part")
    tmp.write_text(json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def main() -> int:
    if len(sys.argv) >= 2 and sys.argv[1] == "--all":
        if not READY.exists():
            print("ready/photo 없음")
            return 0
        n = 0
        for p in READY.rglob("*.json"):
            process_record(p)
            n += 1
        print("처리", n, "건")
        return 0
    if len(sys.argv) < 2:
        print("사용법: python scan.py <record.json> | --all")
        return 2
    process_record(Path(sys.argv[1]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
