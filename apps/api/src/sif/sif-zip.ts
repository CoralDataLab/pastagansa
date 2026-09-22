/** A small ZIP writer using uncompressed entries so exported XML bytes stay exact. */
export function createSifZip(entries: readonly { name: string; content: Buffer }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    if (!/^[a-zA-Z0-9/_-]+\.(?:xml|json)$/.test(entry.name))
      throw new Error("Invalid SIF archive entry name");
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.content;
    if (name.length > 0xffff || data.length > 0xffffffff)
      throw new Error("SIF archive entry exceeds ZIP limits");
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + data.length;
    if (offset > 0xffffffff) throw new Error("SIF archive exceeds ZIP limits");
  }
  if (entries.length > 0xffff) throw new Error("SIF archive exceeds ZIP limits");
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  if (offset + centralSize > 0xffffffff) throw new Error("SIF archive exceeds ZIP limits");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
