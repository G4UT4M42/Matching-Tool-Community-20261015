/** Small, bounded ZIP/STORE codec. No decompression, links, descriptors or ZIP64. */
const MAX_FILE = 256 * 1024 * 1024;
const MAX_ARCHIVE = 512 * 1024 * 1024;
const MAX_FILES = 4096;
const table = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
function crc32(data: Buffer): number { let c = 0xffffffff; for (const byte of data) c = table[(c ^ byte) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
export function safeArchivePath(path: string): void {
  if (!path || Buffer.byteLength(path, 'utf8') > 240 || path.includes('\\') || /[\u0000-\u001f<>:"|?*]/.test(path) || path.startsWith('/') || /^[A-Za-z]:/.test(path) ||
      path.split('/').some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) throw new Error('Unsafe archive path');
}
export function encodeZip(entries: Map<string, Buffer>): Buffer {
  if (entries.size > MAX_FILES) throw new Error('Too many backup files');
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    safeArchivePath(name);
    if (data.length > MAX_FILE) throw new Error('Backup file exceeds limit');
    const filename = Buffer.from(name, 'utf8'), crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8);
    record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE(offset, 42);
    local.push(header, filename, data); central.push(record, filename); offset += header.length + filename.length + data.length;
    if (offset > MAX_ARCHIVE) throw new Error('Backup archive exceeds limit');
  }
  const centralSize = central.reduce((n, part) => n + part.length, 0);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.size, 8); end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  if (offset + centralSize + end.length > MAX_ARCHIVE) throw new Error('Backup archive exceeds limit');
  return Buffer.concat([...local, ...central, end]);
}
export function decodeZip(zip: Buffer): Map<string, Buffer> {
  if (zip.length > MAX_ARCHIVE || zip.length < 22) throw new Error('Backup archive size invalid');
  const endAt = zip.length - 22;
  if (zip.readUInt32LE(endAt) !== 0x06054b50 || zip.readUInt16LE(endAt + 4) || zip.readUInt16LE(endAt + 6) || zip.readUInt16LE(endAt + 20)) throw new Error('Unsupported ZIP structure');
  const count = zip.readUInt16LE(endAt + 10), centralSize = zip.readUInt32LE(endAt + 12), centralAt = zip.readUInt32LE(endAt + 16);
  if (count > MAX_FILES || centralAt + centralSize !== endAt || count !== zip.readUInt16LE(endAt + 8)) throw new Error('Invalid ZIP directory');
  const entries = new Map<string, Buffer>(); const normalizedNames = new Set<string>(); let cursor = centralAt; let nextLocalOffset = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > endAt || zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP entry');
    const flags = zip.readUInt16LE(cursor + 8), method = zip.readUInt16LE(cursor + 10), crc = zip.readUInt32LE(cursor + 16);
    const size = zip.readUInt32LE(cursor + 20), inflated = zip.readUInt32LE(cursor + 24), nameLen = zip.readUInt16LE(cursor + 28);
    const extra = zip.readUInt16LE(cursor + 30), comment = zip.readUInt16LE(cursor + 32), offset = zip.readUInt32LE(cursor + 42);
    const attrs = zip.readUInt32LE(cursor + 38);
    if (flags !== 0x800 || method !== 0 || size !== inflated || size > MAX_FILE || extra || comment || attrs || cursor + 46 + nameLen > endAt) throw new Error('Unsupported or unsafe ZIP entry');
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8'); safeArchivePath(name);
    if (Buffer.byteLength(name) !== nameLen || normalizedNames.has(name.toLowerCase()) || offset !== nextLocalOffset || offset + 30 + nameLen + size > centralAt || zip.readUInt32LE(offset) !== 0x04034b50 || zip.readUInt16LE(offset + 6) !== flags || zip.readUInt16LE(offset + 8) !== method || zip.readUInt32LE(offset + 14) !== crc || zip.readUInt32LE(offset + 18) !== size || zip.readUInt32LE(offset + 22) !== size || zip.readUInt16LE(offset + 26) !== nameLen || zip.readUInt16LE(offset + 28) !== 0 || !zip.subarray(offset + 30, offset + 30 + nameLen).equals(zip.subarray(cursor + 46, cursor + 46 + nameLen))) throw new Error('Invalid ZIP local record');
    const data = zip.subarray(offset + 30 + nameLen, offset + 30 + nameLen + size);
    if (crc32(data) !== crc) throw new Error('ZIP checksum mismatch');
    entries.set(name, data); normalizedNames.add(name.toLowerCase()); nextLocalOffset = offset + 30 + nameLen + size; cursor += 46 + nameLen;
  }
  if (cursor !== endAt || nextLocalOffset !== centralAt) throw new Error('Trailing or hidden ZIP data');
  return entries;
}
