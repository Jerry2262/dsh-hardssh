/**
 * Decode DSH session logs: concatenated independent zstd frames, one JSONL
 * event per line. `zstdDecompressSync` alone stops after the first frame, so
 * the frame boundaries are scanned with the public Zstd frame format.
 *
 * Usage: node decode-sessions.mjs <outDir> <session.v4.jsonl.zstd>...
 * Writes <outDir>/<session-id>.jsonl and prints a per-file line count.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528

function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset + 4 <= buffer.length) {
    const magic = buffer.readUInt32LE(offset)
    if (magic !== ZSTD_MAGIC) throw new Error(`bad zstd magic at ${offset}: 0x${magic.toString(16)}`)
    const start = offset
    offset += 4
    const descriptor = buffer[offset]
    offset += 1
    const fcsFlag = descriptor >> 6
    const singleSegment = ((descriptor >> 5) & 1) === 1
    const checksumFlag = ((descriptor >> 2) & 1) === 1
    const dictIdFlag = descriptor & 3
    if (!singleSegment) offset += 1
    const dictIdSize = [0, 1, 2, 4][dictIdFlag]
    offset += dictIdSize
    const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][fcsFlag]
    offset += fcsSize
    // blocks
    for (;;) {
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) === 1
      const blockType = (blockHeader >> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 0 || blockType === 2) offset += blockSize
      else if (blockType === 1) offset += 1
      else throw new Error(`reserved zstd block type at ${offset - 3}`)
      if (lastBlock) break
    }
    if (checksumFlag) offset += 4
    frames.push(buffer.subarray(start, offset))
  }
  return frames
}

const [outDir, ...sessions] = process.argv.slice(2)
if (outDir === undefined || sessions.length === 0) {
  console.error('usage: node decode-sessions.mjs <outDir> <session.v4.jsonl.zstd>...')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })
for (const path of sessions) {
  const id = basename(dirname(path))
  const frames = scanFrames(readFileSync(path))
  const text = frames.map(frame => zstdDecompressSync(frame).toString('utf8')).join('')
  const target = join(outDir, `${id}.jsonl`)
  writeFileSync(target, text)
  console.log(`${id}\t${frames.length} frames\t${text.split('\n').filter(Boolean).length} lines\t${target}`)
}
