"""Inline lib.js into the page template -> dist/index.html (the published page)."""
from pathlib import Path
here = Path(__file__).parent
page = (here / "index.template.html").read_text().replace("/*LIB*/", (here / "lib.js").read_text())
(here / "dist").mkdir(exist_ok=True)
(here / "dist" / "index.html").write_text(page)
print("dist/index.html", len(page), "bytes")
