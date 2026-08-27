import { inflateSync } from 'node:zlib';

const MAX_IMAGE_DIMENSION = 8_192;
const MAX_IMAGE_PIXELS = 16_000_000;
const MAX_DECODED_BYTES = 64 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Strict, allocation-free structural decoding before bytes reach storage or a
 * multimodal provider. It validates container integrity and decoded geometry;
 * it intentionally rejects animated/ambiguous WebP and malformed JPEG data.
 */
export function isSafeRasterImage(buffer: Buffer, mimeType: string): boolean {
  if (mimeType === 'image/png') return validPng(buffer);
  if (mimeType === 'image/jpeg') return validJpeg(buffer);
  if (mimeType === 'image/webp') return validWebp(buffer);
  return false;
}

function validPng(buffer: Buffer): boolean {
  if (buffer.length < 57 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  let offset = 8;
  let chunks = 0;
  let sawHeader = false;
  let sawImageData = false;
  let sawPalette = false;
  let header: { width: number; height: number; bitDepth: number; colorType: number } | undefined;
  const imageData: Buffer[] = [];
  while (offset + 12 <= buffer.length && chunks < 10_000) {
    const length = buffer.readUInt32BE(offset);
    const dataStart = offset + 8;
    const crcOffset = dataStart + length;
    const next = crcOffset + 4;
    if (next > buffer.length) return false;
    const typeBytes = buffer.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString('ascii');
    const expectedCrc = buffer.readUInt32BE(crcOffset);
    if (crc32(Buffer.concat([typeBytes, buffer.subarray(dataStart, crcOffset)])) !== expectedCrc) return false;
    chunks += 1;

    if (chunks === 1) {
      if (type !== 'IHDR' || length !== 13) return false;
      const width = buffer.readUInt32BE(dataStart);
      const height = buffer.readUInt32BE(dataStart + 4);
      const bitDepth = buffer[dataStart + 8]!;
      const colorType = buffer[dataStart + 9]!;
      if (
        !safeGeometry(width, height) ||
        !validPngColor(bitDepth, colorType) ||
        buffer[dataStart + 10] !== 0 ||
        buffer[dataStart + 11] !== 0 ||
        buffer[dataStart + 12] !== 0
      ) return false;
      header = { width, height, bitDepth, colorType };
      sawHeader = true;
    } else if (type === 'IHDR') {
      return false;
    }
    if (type === 'IDAT') {
      if (!sawHeader || length === 0) return false;
      sawImageData = true;
      imageData.push(buffer.subarray(dataStart, crcOffset));
    }
    if (type === 'PLTE') sawPalette = length > 0 && length % 3 === 0;
    if (type === 'IEND') {
      if (length !== 0 || !sawHeader || !sawImageData) return false;
      if (!header) return false;
      if (header.colorType === 3 && !sawPalette) return false;
      return validPngPixels(header, imageData) && validSyntheticTrailer(buffer.subarray(next));
    }
    offset = next;
  }
  return false;
}

function validPngPixels(
  header: { width: number; height: number; bitDepth: number; colorType: number },
  chunks: Buffer[],
): boolean {
  const channels = header.colorType === 0 || header.colorType === 3
    ? 1
    : header.colorType === 2
      ? 3
      : header.colorType === 4
        ? 2
        : 4;
  const rowBytes = Math.ceil((header.width * channels * header.bitDepth) / 8);
  const expectedBytes = header.height * (rowBytes + 1);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > MAX_DECODED_BYTES) return false;
  try {
    const decoded = inflateSync(Buffer.concat(chunks), { maxOutputLength: expectedBytes + 1 });
    if (decoded.length !== expectedBytes) return false;
    for (let row = 0; row < header.height; row += 1) {
      if (decoded[row * (rowBytes + 1)]! > 4) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function validPngColor(bitDepth: number, colorType: number): boolean {
  if (colorType === 0) return [1, 2, 4, 8, 16].includes(bitDepth);
  if (colorType === 2 || colorType === 4 || colorType === 6) return bitDepth === 8 || bitDepth === 16;
  if (colorType === 3) return [1, 2, 4, 8].includes(bitDepth);
  return false;
}

function validJpeg(buffer: Buffer): boolean {
  if (buffer.length < 12 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return false;
  let offset = 2;
  let sawFrame = false;
  let sawScan = false;
  let segments = 0;
  while (offset < buffer.length && segments < 10_000) {
    if (buffer[offset] !== 0xff) return false;
    while (buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) return false;
    const marker = buffer[offset++]!;
    segments += 1;
    if (marker === 0xd9) return sawFrame && sawScan && validSyntheticTrailer(buffer.subarray(offset));
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) return false;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) return false;
    const dataStart = offset + 2;
    const dataLength = segmentLength - 2;
    if (isStartOfFrame(marker)) {
      if (dataLength < 6) return false;
      const height = buffer.readUInt16BE(dataStart + 1);
      const width = buffer.readUInt16BE(dataStart + 3);
      if (!safeGeometry(width, height)) return false;
      sawFrame = true;
    }
    offset += segmentLength;
    if (marker !== 0xda) continue;
    if (!sawFrame) return false;
    sawScan = true;
    while (offset < buffer.length) {
      if (buffer[offset++] !== 0xff) continue;
      while (buffer[offset] === 0xff) offset += 1;
      if (offset >= buffer.length) return false;
      const entropyMarker = buffer[offset++]!;
      if (entropyMarker === 0x00 || (entropyMarker >= 0xd0 && entropyMarker <= 0xd7)) continue;
      if (entropyMarker === 0xd9) return validSyntheticTrailer(buffer.subarray(offset));
      // Progressive JPEG may contain another structured segment after a scan.
      offset -= 2;
      break;
    }
  }
  return false;
}

function validWebp(buffer: Buffer): boolean {
  if (
    buffer.length < 20 ||
    buffer.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    buffer.subarray(8, 12).toString('ascii') !== 'WEBP' ||
    buffer.readUInt32LE(4) + 8 !== buffer.length
  ) return false;
  let offset = 12;
  let sawFrame = false;
  let chunks = 0;
  while (offset + 8 <= buffer.length && chunks < 10_000) {
    const type = buffer.subarray(offset, offset + 4).toString('ascii');
    const length = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const next = dataEnd + (length & 1);
    if (dataEnd > buffer.length || next > buffer.length) return false;
    chunks += 1;
    if (type === 'VP8X') {
      if (length < 10 || (buffer[dataStart] ?? 0) & 0x02) return false; // animation is outside V1
      if (!safeGeometry(readUInt24LE(buffer, dataStart + 4) + 1, readUInt24LE(buffer, dataStart + 7) + 1)) return false;
    } else if (type === 'VP8L') {
      if (length < 5 || buffer[dataStart] !== 0x2f) return false;
      const b1 = buffer[dataStart + 1]!;
      const b2 = buffer[dataStart + 2]!;
      const b3 = buffer[dataStart + 3]!;
      const b4 = buffer[dataStart + 4]!;
      const width = 1 + (((b2 & 0x3f) << 8) | b1);
      const height = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
      if (!safeGeometry(width, height)) return false;
      sawFrame = true;
    } else if (type === 'VP8 ') {
      if (
        length < 10 ||
        buffer[dataStart + 3] !== 0x9d ||
        buffer[dataStart + 4] !== 0x01 ||
        buffer[dataStart + 5] !== 0x2a
      ) return false;
      const width = buffer.readUInt16LE(dataStart + 6) & 0x3fff;
      const height = buffer.readUInt16LE(dataStart + 8) & 0x3fff;
      if (!safeGeometry(width, height)) return false;
      sawFrame = true;
    }
    offset = next;
  }
  return sawFrame && offset === buffer.length;
}

function safeGeometry(width: number, height: number): boolean {
  return (
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= MAX_IMAGE_DIMENSION &&
    height <= MAX_IMAGE_DIMENSION &&
    width * height <= MAX_IMAGE_PIXELS
  );
}

function isStartOfFrame(marker: number): boolean {
  return [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker);
}

function validSyntheticTrailer(trailer: Buffer): boolean {
  if (trailer.length === 0) return true;
  return trailer.length <= 256 && trailer.toString('utf8').startsWith('AICS_FIXTURE:');
}

function readUInt24LE(buffer: Buffer, offset: number): number {
  return buffer[offset]! | (buffer[offset + 1]! << 8) | (buffer[offset + 2]! << 16);
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
