const { deflateRawSync } = require("node:zlib");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const filename = Buffer.from(name);
    const source = Buffer.from(value);
    const compressed = deflateRawSync(source);
    const crc = crc32(source);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(source.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, compressed);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(source.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuffer, end]);
}

function xml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" })[character]);
}

function paragraph(text, bold = false) {
  const run = text ? `<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>` : "";
  return `<w:p><w:pPr><w:spacing w:after="80"/></w:pPr>${run}</w:p>`;
}

function tableCell(text, bold = false) {
  return `<w:tc><w:tcPr><w:tcW w:w="2200" w:type="dxa"/></w:tcPr>${paragraph(text, bold)}</w:tc>`;
}

function characteristicsTable(text) {
  const lines = String(text).split(/\r?\n/);
  const rows = [];
  let section = "";
  let index = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line === "ОБЯЗАТЕЛЬНЫЕ ХАРАКТЕРИСТИКИ КТРУ" || line === "ДОПОЛНИТЕЛЬНЫЕ ХАРАКТЕРИСТИКИ") {
      section = line.startsWith("ОБЯЗАТЕЛЬНЫЕ") ? "Обязательная" : "Дополнительная";
      continue;
    }
    const match = line.match(/^[-•]\s+([^:]+):\s*(.*)$/);
    if (!match || !section) continue;
    const reason = lines[lineIndex + 1]?.trim().replace(/^Обоснование:\s*/, "") || "";
    rows.push([String(++index), match[1], match[2], section, reason]);
  }
  if (!rows.length) return "";
  const header = ["№", "Характеристика", "Значение", "Тип требования", "Обоснование"].map(value => tableCell(value, true)).join("");
  const body = rows.map(row => `<w:tr>${row.map(value => tableCell(value)).join("")}</w:tr>`).join("");
  return `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="600"/><w:gridCol w:w="2600"/><w:gridCol w:w="2200"/><w:gridCol w:w="1600"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr>${header}</w:tr>${body}</w:tbl>`;
}

function createDocx(text) {
  const source = String(text);
  const paragraphs = source.split(/\r?\n/).map((line, index) => {
    const heading = /^(ПРОЕКТ|ОБЯЗАТЕЛЬНЫЕ|ДОПОЛНИТЕЛЬНЫЕ)/.test(line);
    const run = line ? `<w:r>${heading ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${xml(line)}</w:t></w:r>` : "";
    return `<w:p><w:pPr><w:spacing w:after="${index === 0 ? 240 : 80}"/></w:pPr>${run}</w:p>`;
  }).join("") + characteristicsTable(source);
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`
  };
  return zip(files);
}

module.exports = { createDocx };
