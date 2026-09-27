"""Копирует интерфейс из server/web в cloud/web (запускать после обновления StreamRec)."""
import shutil
from pathlib import Path
src = Path(__file__).resolve().parent.parent / "server" / "web"
dst = Path(__file__).resolve().parent / "web"
for name in ("app.js", "app.css", "vendor/hls.min.js"):
    (dst / name).parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src / name, dst / name)
# облачная страница: вместо прямого запуска app.js — шифрование (e2e.js) и загрузчик (boot.js)
html = (src / "index.html").read_text("utf-8")
html = html.replace('<script src="/static/app.js"></script>',
                    '<script src="/static/e2e.js"></script>\n<script src="/static/boot.js"></script>')
(dst / "index.html").write_text(html, "utf-8", newline="\n")
print("ok")
