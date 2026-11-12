"""Print the text of the given pages of a PDF (1-based page numbers), one page after another, each preceded by
a line "=== page N ===". Used by tools/bodies/fetch-sources.mjs to read tables out of downloaded NASA reports;
run with `python -I` (the PDF is untrusted data: it is only parsed, never executed).

    python -I tools/bodies/pdftext.py <file.pdf> <page> [<page> ...]
"""
import sys

from pypdf import PdfReader


def main() -> None:
    path = sys.argv[1]
    pages = [int(p) for p in sys.argv[2:]]
    reader = PdfReader(path)
    out = []
    for p in pages:
        out.append(f"=== page {p} ===")
        out.append(reader.pages[p - 1].extract_text() or "")
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdout.write("\n".join(out) + "\n")


if __name__ == "__main__":
    main()
