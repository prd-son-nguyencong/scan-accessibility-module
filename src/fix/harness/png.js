// Minimal PNG decoder (8-bit RGB/RGBA, non-interlaced: what Playwright screenshots emit). No dependency, CRCs are not checked.
import { inflateSync } from 'node:zlib';

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** @returns {{w:number,h:number,data:Uint8Array}} RGBA pixels */
export function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('PNG_INVALID: bad signature');
  let p = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9];
      if (d[8] !== 8 || d[12] !== 0 || (ct !== 2 && ct !== 6)) throw new Error('PNG_UNSUPPORTED: need 8-bit RGB/RGBA, not interlaced');
    } else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    p += len + 12;
  }
  if (!w || !h) throw new Error('PNG_INVALID: no IHDR');
  const bpp = ct === 6 ? 4 : 3;
  const stride = w * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * h) throw new Error('PNG_INVALID: truncated data');
  const out = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      const x = line[i];
      cur[i] = (f === 0 ? x : f === 1 ? x + a : f === 2 ? x + b : f === 3 ? x + ((a + b) >> 1) : x + paeth(a, b, c)) & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, s = x * bpp;
      out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = bpp === 4 ? cur[s + 3] : 255;
    }
    [prev, cur] = [cur, prev];
  }
  return { w, h, data: out };
}
