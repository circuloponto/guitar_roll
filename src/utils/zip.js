// Minimal ZIP writer (STORE, no compression: audio is already compressed or not worth
// the cost) and reader (STORE, plus DEFLATE via DecompressionStream for zips made by other tools).
// Entries are { path, data } where path uses forward slashes and data is a Uint8Array.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++)
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ZIP stores timestamps in the old MS-DOS packed format.
function dosDateTime(d) {
  const time =
    ((d.getHours() & 31) << 11) |
    ((d.getMinutes() & 63) << 5) |
    (Math.floor(d.getSeconds() / 2) & 31)
  const date =
    (((d.getFullYear() - 1980) & 127) << 9) |
    (((d.getMonth() + 1) & 15) << 5) |
    (d.getDate() & 31)
  return { time, date }
}

export function makeZip(entries) {
  const enc = new TextEncoder()
  const { time, date } = dosDateTime(new Date())
  const body = []
  const central = []
  let offset = 0

  for (const e of entries) {
    const nameBytes = enc.encode(e.path)
    const data = e.data
    const crc = crc32(data)

    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true) // local file header
    local.setUint16(4, 20, true) // version needed
    local.setUint16(6, 0x0800, true) // UTF-8 filenames
    local.setUint16(8, 0, true) // method: store
    local.setUint16(10, time, true)
    local.setUint16(12, date, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, data.length, true) // compressed size
    local.setUint32(22, data.length, true) // uncompressed size
    local.setUint16(26, nameBytes.length, true)
    local.setUint16(28, 0, true) // extra length
    body.push(new Uint8Array(local.buffer), nameBytes, data)

    const cd = new DataView(new ArrayBuffer(46))
    cd.setUint32(0, 0x02014b50, true) // central directory header
    cd.setUint16(4, 20, true) // version made by
    cd.setUint16(6, 20, true) // version needed
    cd.setUint16(8, 0x0800, true)
    cd.setUint16(10, 0, true)
    cd.setUint16(12, time, true)
    cd.setUint16(14, date, true)
    cd.setUint32(16, crc, true)
    cd.setUint32(20, data.length, true)
    cd.setUint32(24, data.length, true)
    cd.setUint16(28, nameBytes.length, true)
    cd.setUint16(30, 0, true) // extra
    cd.setUint16(32, 0, true) // comment
    cd.setUint16(34, 0, true) // disk number
    cd.setUint16(36, 0, true) // internal attrs
    cd.setUint32(38, 0, true) // external attrs
    cd.setUint32(42, offset, true) // local header offset
    central.push(new Uint8Array(cd.buffer), nameBytes)

    offset += 30 + nameBytes.length + data.length
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0)
  const eocd = new DataView(new ArrayBuffer(22))
  eocd.setUint32(0, 0x06054b50, true) // end of central directory
  eocd.setUint16(4, 0, true)
  eocd.setUint16(6, 0, true)
  eocd.setUint16(8, entries.length, true)
  eocd.setUint16(10, entries.length, true)
  eocd.setUint32(12, centralSize, true)
  eocd.setUint32(16, offset, true)
  eocd.setUint16(20, 0, true) // comment length

  return new Blob([...body, ...central, new Uint8Array(eocd.buffer)], {
    type: 'application/zip',
  })
}


// Read every file entry of a zip. Returns [{ path, data: Uint8Array }].
export async function readZip(arrayBuffer) {
  const buf = new Uint8Array(arrayBuffer)
  const dv = new DataView(arrayBuffer)
  const dec = new TextDecoder()
  // Find the end-of-central-directory record (scan back past a possible comment).
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('Not a zip file')
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  const out = []
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt zip')
    const method = dv.getUint16(p + 10, true)
    const csize = dv.getUint32(p + 20, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const localOff = dv.getUint32(p + 42, true)
    const path = dec.decode(buf.subarray(p + 46, p + 46 + nameLen))
    p += 46 + nameLen + extraLen + commentLen
    if (path.endsWith('/')) continue
    const lNameLen = dv.getUint16(localOff + 26, true)
    const lExtraLen = dv.getUint16(localOff + 28, true)
    const start = localOff + 30 + lNameLen + lExtraLen
    const raw = buf.subarray(start, start + csize)
    let data
    if (method === 0) data = raw.slice()
    else if (method === 8) {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
      data = new Uint8Array(await new Response(stream).arrayBuffer())
    } else throw new Error(`Unsupported zip compression (${method})`)
    out.push({ path, data })
  }
  return out
}
