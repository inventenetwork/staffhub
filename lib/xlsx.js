'use strict';
const zlib = require('zlib');

function escapeXml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// ---------------- CRC32 calculation ----------------
function getCrc32(buf) {
  if (zlib.crc32) return zlib.crc32(buf) >>> 0;
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  let crc = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ (-1)) >>> 0;
}

// ---------------- Minimal ZIP Packer ----------------
function zipPack(files) {
  const localHeaders = [];
  const cdHeaders = [];
  let offset = 0;

  for (const file of files) {
    const fileBuf = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const pathBuf = Buffer.from(file.path, 'utf8');
    const compressed = zlib.deflateRawSync(fileBuf);
    const crc = getCrc32(fileBuf);
    const compSize = compressed.length;
    const uncompSize = fileBuf.length;

    const lh = Buffer.alloc(30 + pathBuf.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 flag
    lh.writeUInt16LE(8, 8); // compression: Deflate
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compSize, 18);
    lh.writeUInt32LE(uncompSize, 22);
    lh.writeUInt16LE(pathBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    pathBuf.copy(lh, 30);

    localHeaders.push(lh, compressed);

    const cdh = Buffer.alloc(46 + pathBuf.length);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(8, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(compSize, 20);
    cdh.writeUInt32LE(uncompSize, 24);
    cdh.writeUInt16LE(pathBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(offset, 42);
    pathBuf.copy(cdh, 46);

    cdHeaders.push(cdh);
    offset += lh.length + compressed.length;
  }

  const cdStart = offset;
  let cdSize = 0;
  for (const cdh of cdHeaders) cdSize += cdh.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, ...cdHeaders, eocd]);
}

// ---------------- Minimal ZIP Unpacker ----------------
function zipUnpack(buf) {
  const files = {};
  let eocdPos = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos === -1) throw new Error('Invalid ZIP file: EOCD signature not found.');

  const entriesCount = buf.readUInt16LE(eocdPos + 10);
  const cdOffset = buf.readUInt32LE(eocdPos + 16);

  let pos = cdOffset;
  for (let i = 0; i < entriesCount; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) break;
    const compMethod = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);

    const filePath = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    pos += 46 + nameLen + extraLen + commentLen;

    if (localOffset + 30 <= buf.length && buf.readUInt32LE(localOffset) === 0x04034b50) {
      const locNameLen = buf.readUInt16LE(localOffset + 26);
      const locExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + locNameLen + locExtraLen;
      const compData = buf.subarray(dataStart, dataStart + compSize);

      let uncompData;
      if (compMethod === 8) {
        uncompData = zlib.inflateRawSync(compData);
      } else if (compMethod === 0) {
        uncompData = compData;
      }
      if (uncompData) {
        files[filePath.replace(/\\/g, '/')] = uncompData;
      }
    }
  }
  return files;
}

// ---------------- Column letter helper ----------------
function colToLetter(colIndex) {
  let letter = '';
  let temp = colIndex;
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
}

function letterToCol(letter) {
  let col = 0;
  for (let i = 0; i < letter.length; i++) {
    col = col * 26 + (letter.charCodeAt(i) - 64);
  }
  return col - 1;
}

// ---------------- buildXlsx ----------------
function buildXlsx(sheets) {
  const files = [];

  // 1. [Content_Types].xml
  let contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n  <Default Extension="xml" ContentType="application/xml"/>\n  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>\n`;
  sheets.forEach((_, idx) => {
    contentTypesXml += `  <Override PartName="/xl/worksheets/sheet${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>\n`;
  });
  contentTypesXml += `</Types>`;
  files.push({ path: '[Content_Types].xml', data: contentTypesXml });

  // 2. _rels/.rels
  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>\n</Relationships>`;
  files.push({ path: '_rels/.rels', data: relsXml });

  // 3. xl/_rels/workbook.xml.rels
  let workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n`;
  sheets.forEach((_, idx) => {
    workbookRelsXml += `  <Relationship Id="rId${idx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${idx + 1}.xml"/>\n`;
  });
  workbookRelsXml += `</Relationships>`;
  files.push({ path: 'xl/_rels/workbook.xml.rels', data: workbookRelsXml });

  // 4. xl/workbook.xml
  let workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\n  <sheets>\n`;
  sheets.forEach((s, idx) => {
    workbookXml += `    <sheet name="${escapeXml(s.name)}" sheetId="${idx + 1}" r:id="rId${idx + 1}"/>\n`;
  });
  workbookXml += `  </sheets>\n</workbook>`;
  files.push({ path: 'xl/workbook.xml', data: workbookXml });

  // 5. xl/worksheets/sheetX.xml
  sheets.forEach((s, idx) => {
    let sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">\n  <sheetData>\n`;
    (s.rows || []).forEach((row, rIdx) => {
      const rowNum = rIdx + 1;
      sheetXml += `    <row r="${rowNum}">\n`;
      (row || []).forEach((val, cIdx) => {
        const ref = `${colToLetter(cIdx)}${rowNum}`;
        if (val === null || val === undefined || val === '') return;
        if (typeof val === 'number') {
          sheetXml += `      <c r="${ref}"><v>${val}</v></c>\n`;
        } else {
          sheetXml += `      <c r="${ref}" t="inlineStr"><is><t>${escapeXml(String(val))}</t></is></c>\n`;
        }
      });
      sheetXml += `    </row>\n`;
    });
    sheetXml += `  </sheetData>\n</worksheet>`;
    files.push({ path: `xl/worksheets/sheet${idx + 1}.xml`, data: sheetXml });
  });

  return zipPack(files);
}

// ---------------- parseXlsx ----------------
function parseXlsx(buf) {
  const files = zipUnpack(buf);
  const workbookXml = files['xl/workbook.xml'] ? files['xl/workbook.xml'].toString('utf8') : '';
  if (!workbookXml) throw new Error('Invalid XLSX: workbook.xml not found.');

  const workbookRelsXml = files['xl/_rels/workbook.xml.rels'] ? files['xl/_rels/workbook.xml.rels'].toString('utf8') : '';

  const rIdToTarget = {};
  const relRegex = /<Relationship\s+[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g;
  let relMatch;
  while ((relMatch = relRegex.exec(workbookRelsXml)) !== null) {
    rIdToTarget[relMatch[1]] = relMatch[2].replace(/^\//, '');
  }

  const sheets = [];
  const sheetRegex = /<sheet\s+[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g;
  let sheetMatch;
  while ((sheetMatch = sheetRegex.exec(workbookXml)) !== null) {
    const name = unescapeXml(sheetMatch[1]);
    const rId = sheetMatch[2];
    let target = rIdToTarget[rId] || `worksheets/sheet${sheets.length + 1}.xml`;
    if (!target.startsWith('xl/')) target = 'xl/' + target;
    sheets.push({ name, target });
  }

  const sharedStrings = [];
  const sharedStringsXml = files['xl/sharedStrings.xml'] ? files['xl/sharedStrings.xml'].toString('utf8') : '';
  if (sharedStringsXml) {
    const siRegex = /<si>(.*?)<\/si>/gs;
    let siMatch;
    while ((siMatch = siRegex.exec(sharedStringsXml)) !== null) {
      const siContent = siMatch[1];
      const tRegex = /<t[^>]*>(.*?)<\/t>/gs;
      let text = '';
      let tMatch;
      while ((tMatch = tRegex.exec(siContent)) !== null) {
        text += unescapeXml(tMatch[1]);
      }
      sharedStrings.push(text);
    }
  }

  const parsedSheets = sheets.map((s) => {
    const sheetXml = files[s.target] ? files[s.target].toString('utf8') : '';
    const rows = [];
    if (!sheetXml) return { name: s.name, rows: [] };

    const rowRegex = /<row\s+[^>]*r="(\d+)"[^>]*>(.*?)<\/row>/gs;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(sheetXml)) !== null) {
      const rIdx = parseInt(rowMatch[1], 10) - 1;
      const rowContent = rowMatch[2];
      const rowData = [];

      const cRegex = /<c\s+[^>]*r="([A-Z]+)(\d+)"([^>]*)>(.*?)<\/c>/gs;
      let cMatch;
      while ((cMatch = cRegex.exec(rowContent)) !== null) {
        const colLetter = cMatch[1];
        const cIdx = letterToCol(colLetter);
        const attrs = cMatch[3];
        const inner = cMatch[4];

        const tAttrMatch = /t="([^"]+)"/.exec(attrs);
        const type = tAttrMatch ? tAttrMatch[1] : '';

        let val = '';
        if (type === 's') {
          const vMatch = /<v>(.*?)<\/v>/.exec(inner);
          if (vMatch) {
            const idx = parseInt(vMatch[1], 10);
            val = sharedStrings[idx] !== undefined ? sharedStrings[idx] : '';
          }
        } else if (type === 'inlineStr') {
          const tMatch = /<t[^>]*>(.*?)<\/t>/s.exec(inner);
          if (tMatch) val = unescapeXml(tMatch[1]);
        } else if (type === 'b') {
          const vMatch = /<v>(.*?)<\/v>/.exec(inner);
          val = vMatch && vMatch[1] === '1';
        } else {
          const vMatch = /<v>(.*?)<\/v>/.exec(inner);
          if (vMatch) {
            const rawVal = vMatch[1];
            val = !isNaN(rawVal) && rawVal.trim() !== '' ? Number(rawVal) : unescapeXml(rawVal);
          }
        }
        rowData[cIdx] = val;
      }

      rows[rIdx] = rowData;
    }

    const cleanRows = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || [];
      const arr = [];
      for (let j = 0; j < r.length; j++) {
        arr[j] = r[j] !== undefined ? r[j] : '';
      }
      cleanRows.push(arr);
    }

    return { name: s.name, rows: cleanRows };
  });

  return parsedSheets;
}

function findSheet(parsedSheets, name) {
  if (!Array.isArray(parsedSheets)) return null;
  const targetName = String(name || '').toLowerCase().trim();
  const s = parsedSheets.find((sheet) => String(sheet.name || '').toLowerCase().trim() === targetName);
  return s ? s.rows : null;
}

function serialDateToISO(serial) {
  if (typeof serial !== 'number' || Number.isNaN(serial)) return null;
  const utcDays = Math.floor(serial - 25569);
  const utcValue = utcDays * 86400 * 1000;
  const date = new Date(utcValue);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

module.exports = {
  buildXlsx,
  parseXlsx,
  findSheet,
  serialDateToISO,
};
