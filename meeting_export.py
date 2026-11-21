"""Build one PDF or Word document containing all meeting materials."""
from io import BytesIO
import re
import unicodedata
from xml.sax.saxutils import escape
from zipfile import ZIP_DEFLATED, ZipFile


def document_lines(sections):
    for title, content in sections:
        yield title, True
        for line in content.splitlines():
            yield line, False


def word_document(sections):
    paragraphs = []
    for line, heading in document_lines(sections):
        clean = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]", "", line)
        heading_style = '<w:pPr><w:keepNext/></w:pPr>' if heading else ""
        size = 32 if heading else 22
        bold = '<w:b/>' if heading else ''
        paragraphs.append(
            f'<w:p>{heading_style}<w:r><w:rPr>{bold}<w:sz w:val="{size}"/></w:rPr>'
            f'<w:t xml:space="preserve">{escape(clean)}</w:t></w:r></w:p>'
        )
    buffer = BytesIO()
    with ZipFile(buffer, "w", ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>""")
        archive.writestr("_rels/.rels", """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>""")
        archive.writestr("word/document.xml", (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
            + "".join(paragraphs) + '<w:sectPr/></w:body></w:document>'
        ))
    return buffer.getvalue()


def wrap_line(line, limit=86):
    part = []
    width = 0
    for char in line.expandtabs(4):
        size = 2 if unicodedata.east_asian_width(char) in ("W", "F", "A") else 1
        if width + size > limit:
            yield "".join(part)
            part = []
            width = 0
        part.append(char)
        width += size
    yield "".join(part)


def pdf_document(sections):
    # Use the standard Simplified Chinese PDF font and a Unicode CMap.
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"",
        b"<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] >>",
        b"<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 5 0 R /DW 1000 >>",
        b"<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>",
    ]
    pages = []
    commands = []
    y = 795

    def flush():
        nonlocal commands, y
        if not commands:
            return
        stream = "\n".join(commands).encode("ascii")
        stream_id = len(objects) + 1
        objects.append(b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream))
        pages.append(len(objects) + 1)
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents {stream_id} 0 R >>".encode()
        )
        commands = []
        y = 795

    for line, heading in document_lines(sections):
        if heading and commands:
            y -= 12
        for part in wrap_line(line, 60 if heading else 86):
            if y < 48:
                flush()
            encoded = "".join(c if ord(c) < 65536 else "□" for c in part).encode("utf-16-be").hex()
            commands.append(f"BT /F1 {16 if heading else 11} Tf 42 {y} Td <{encoded}> Tj ET")
            y -= 24 if heading else 17
    flush()
    kids = " ".join(f"{page} 0 R" for page in pages)
    objects[1] = f"<< /Type /Pages /Count {len(pages)} /Kids [{kids}] >>".encode()
    pdf = BytesIO()
    pdf.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, obj in enumerate(objects, 1):
        offsets.append(pdf.tell())
        pdf.write(b"%d 0 obj\n%s\nendobj\n" % (number, obj))
    xref = pdf.tell()
    pdf.write(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        pdf.write(f"{offset:010d} 00000 n \n".encode())
    pdf.write(f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return pdf.getvalue()
