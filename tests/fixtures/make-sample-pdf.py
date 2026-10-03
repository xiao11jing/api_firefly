"""生成 E2E 使用的 PDF 夹具（一次性运行，产物已提交）。
运行： MIMO_PYTHON tests/fixtures/make-sample-pdf.py
"""
from pathlib import Path

from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas

OUT = Path(__file__).with_name("sample.pdf")

pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))

c = canvas.Canvas(str(OUT), pagesize=(360, 260))

c.setFont("Helvetica", 14)
c.drawString(36, 210, "MiMo Attachment Fixture")
c.setFont("Helvetica", 10)
c.drawString(36, 190, "PLAIN_TEXT_LINE_ONE")

c.showPage()
c.setFont("STSong-Light", 14)
c.drawString(36, 210, "中文文档测试")
c.setFont("STSong-Light", 10)
c.drawString(36, 190, "第二行的中文内容")

c.showPage()
c.save()
print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
