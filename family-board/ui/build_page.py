"""Wrap the esbuild bundle (dist/app.js) into the published page: ../artifact/dist/index.html."""
from pathlib import Path
here = Path(__file__).parent
app = (here / "dist" / "app.js").read_text().replace("</script", "<\\/script")
page = (here / "shell.html").read_text().replace("/*APP*/", app)
out = here.parent / "artifact" / "dist" / "index.html"
out.write_text(page)
print(out, len(page), "bytes")
