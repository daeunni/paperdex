#!/usr/bin/env python3
"""PaperDex — 매일 읽은 논문 아카이브 로컬 서버 (표준 라이브러리만 사용).

실행:  python3 server.py            → http://127.0.0.1:8765
옵션:  --port 9000  --no-open
데이터: data/db.json (하루 한 번 data/backups/ 에 자동 백업)
"""
import argparse
import datetime
import json
import os
import re
import shutil
import threading
import urllib.parse
import urllib.request
import webbrowser
import xml.etree.ElementTree as ET
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")
DATA = os.environ.get("PAPERDEX_DATA", os.path.join(ROOT, "data"))
DB_PATH = os.path.join(DATA, "db.json")
BACKUPS = os.path.join(DATA, "backups")
IMAGES = os.path.join(DATA, "images")
IMG_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}\.(webp|jpg|jpeg|png)$")
IMG_TYPES = {"webp": "image/webp", "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png"}
MAX_IMG = 20 * 1024 * 1024
COLLECTIONS = ("papers", "ideas")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

lock = threading.Lock()


def load_db():
    if not os.path.exists(DB_PATH):
        return {"papers": [], "ideas": []}
    with open(DB_PATH, encoding="utf-8") as f:
        db = json.load(f)
    for c in COLLECTIONS:
        db.setdefault(c, [])
    return db


def save_db(db):
    os.makedirs(BACKUPS, exist_ok=True)
    if os.path.exists(DB_PATH):
        daily = os.path.join(BACKUPS, f"db-{datetime.date.today().isoformat()}.json")
        if not os.path.exists(daily):
            shutil.copy2(DB_PATH, daily)
    tmp = DB_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=2)
    os.replace(tmp, DB_PATH)


def fetch_arxiv(q):
    m = re.search(r"(\d{4}\.\d{4,5})(v\d+)?", q) or re.search(r"([a-z\-]+(?:\.[A-Z]{2})?/\d{7})", q)
    if not m:
        raise ValueError("arXiv ID를 찾을 수 없어요")
    aid = m.group(1)
    url = "https://export.arxiv.org/api/query?" + urllib.parse.urlencode({"id_list": aid})
    req = urllib.request.Request(url, headers={"User-Agent": "PaperDex/1.0"})
    with urllib.request.urlopen(req, timeout=15) as r:
        root = ET.fromstring(r.read())
    ns = {"a": "http://www.w3.org/2005/Atom"}
    entry = root.find("a:entry", ns)
    title = entry.findtext("a:title", "", ns) if entry is not None else ""
    if entry is None or not title.strip() or title.strip() == "Error":
        raise ValueError("arXiv에서 논문을 찾지 못했어요")
    clean = lambda s: re.sub(r"\s+", " ", s or "").strip()
    published = entry.findtext("a:published", "", ns)
    return {
        "arxivId": aid,
        "title": clean(title),
        "authors": ", ".join(clean(a.findtext("a:name", "", ns)) for a in entry.findall("a:author", ns)),
        "abstract": clean(entry.findtext("a:summary", "", ns)),
        "venue": f"arXiv {published[:4]}" if published else "arXiv",
        "url": f"https://arxiv.org/abs/{aid}",
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STATIC, **kw)

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def _item_route(self):
        parts = urllib.parse.urlparse(self.path).path.strip("/").split("/")
        if len(parts) == 3 and parts[0] == "api" and parts[1] in COLLECTIONS and ID_RE.match(parts[2]):
            return parts[1], parts[2]
        return None, None

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/api/db":
            with lock:
                return self._json(200, load_db())
        if u.path == "/api/arxiv":
            q = urllib.parse.parse_qs(u.query).get("q", [""])[0]
            try:
                return self._json(200, fetch_arxiv(q))
            except ValueError as e:
                return self._json(404, {"error": str(e)})
            except Exception as e:  # network errors etc.
                return self._json(502, {"error": f"arXiv 요청 실패: {e}"})
        if u.path.startswith("/images/"):
            name = u.path[len("/images/"):]
            path = os.path.join(IMAGES, name)
            if not IMG_RE.match(name) or not os.path.isfile(path):
                return self._json(404, {"error": "not found"})
            with open(path, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", IMG_TYPES[name.rsplit(".", 1)[1].lower()])
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        return super().do_GET()

    def do_PUT(self):
        coll, item_id = self._item_route()
        if not coll:
            return self._json(404, {"error": "not found"})
        item = self._body()
        item["id"] = item_id
        with lock:
            db = load_db()
            items = db[coll]
            idx = next((i for i, x in enumerate(items) if x.get("id") == item_id), None)
            if idx is None:
                items.append(item)
            else:
                items[idx] = item
            save_db(db)
        return self._json(200, item)

    def do_DELETE(self):
        coll, item_id = self._item_route()
        if not coll:
            return self._json(404, {"error": "not found"})
        with lock:
            db = load_db()
            db[coll] = [x for x in db[coll] if x.get("id") != item_id]
            save_db(db)
        return self._json(200, {"ok": True})

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/api/images":
            name = urllib.parse.parse_qs(u.query).get("name", [""])[0]
            n = int(self.headers.get("Content-Length") or 0)
            if not IMG_RE.match(name):
                return self._json(400, {"error": "잘못된 파일 이름"})
            if n <= 0 or n > MAX_IMG:
                return self._json(413, {"error": "이미지가 너무 커요 (최대 20MB)"})
            os.makedirs(IMAGES, exist_ok=True)
            path = os.path.join(IMAGES, name)
            if os.path.exists(path):
                return self._json(409, {"error": "이미 있는 파일 이름"})
            with open(path, "wb") as f:
                f.write(self.rfile.read(n))
            return self._json(200, {"src": f"/images/{name}"})
        if u.path != "/api/import":
            return self._json(404, {"error": "not found"})
        incoming = self._body()
        with lock:
            db = load_db()
            counts = {}
            for c in COLLECTIONS:
                by_id = {x["id"]: x for x in db[c] if "id" in x}
                new = [x for x in incoming.get(c, []) if isinstance(x, dict) and ID_RE.match(str(x.get("id", "")))]
                for x in new:
                    by_id[x["id"]] = x
                db[c] = list(by_id.values())
                counts[c] = len(new)
            save_db(db)
        return self._json(200, {"ok": True, "imported": counts})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-open", action="store_true")
    args = ap.parse_args()
    os.makedirs(DATA, exist_ok=True)
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{args.host}:{args.port}"
    print(f"🐱 PaperDex running at {url}  (data: {DB_PATH})")
    if not args.no_open:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye!")


if __name__ == "__main__":
    main()
