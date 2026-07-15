import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const sizes = [16, 48, 128];
const outDir = path.resolve('extension/icons');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

function createPng(size) {
  // PNG 文件结构：IHDR + IDAT + IEND
  const width = size;
  const height = size;

  // 创建像素数据：蓝色背景 + 白色 "API" 简化成一个圆角方块+中心白点
  const pixels = Buffer.alloc(width * height * 4);
  const bg = { r: 26, g: 115, b: 232 }; // #1a73e8

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;

      // 圆角处理
      const r = size * 0.2;
      const inCorner =
        (x < r && y < r && Math.hypot(x - r, y - r) > r) ||
        (x > width - r && y < r && Math.hypot(x - (width - r), y - r) > r) ||
        (x < r && y > height - r && Math.hypot(x - r, y - (height - r)) > r) ||
        (x > width - r && y > height - r && Math.hypot(x - (width - r), y - (height - r)) > r);

      if (inCorner) {
        pixels[idx] = 0;
        pixels[idx + 1] = 0;
        pixels[idx + 2] = 0;
        pixels[idx + 3] = 0;
      } else {
        pixels[idx] = bg.r;
        pixels[idx + 1] = bg.g;
        pixels[idx + 2] = bg.b;
        pixels[idx + 3] = 255;
      }
    }
  }

  // 中间白色 "A" 形简化：一条竖线 + 两条斜线
  const line = (x1, y1, x2, y2, thickness) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    for (let t = 0; t <= len; t++) {
      const px = Math.round(x1 + (dx * t) / len);
      const py = Math.round(y1 + (dy * t) / len);
      for (let oy = -thickness; oy <= thickness; oy++) {
        for (let ox = -thickness; ox <= thickness; ox++) {
          const nx = px + ox;
          const ny = py + oy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const idx = (ny * width + nx) * 4;
            pixels[idx] = 255;
            pixels[idx + 1] = 255;
            pixels[idx + 2] = 255;
            pixels[idx + 3] = 255;
          }
        }
      }
    }
  };

  const cx = width / 2;
  const margin = size * 0.22;
  const top = margin;
  const bottom = height - margin;
  const left = margin;
  const right = width - margin;
  const barY = height * 0.62;
  const thickness = Math.max(1, Math.round(size * 0.08));

  line(left, bottom, cx, top, thickness);
  line(right, bottom, cx, top, thickness);
  line(left + (cx - left) * 0.35, barY, right - (right - cx) * 0.35, barY, thickness);

  return encodePng(width, height, pixels);
}

function encodePng(width, height, pixels) {
  // 压缩 IDAT（简单实现，无压缩）：每行前面加 filter 0
  const rowSize = width * 4;
  const raw = Buffer.alloc((rowSize + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowSize + 1)] = 0; // filter type None
    pixels.copy(raw, y * (rowSize + 1) + 1, y * rowSize, (y + 1) * rowSize);
  }

  const idatData = zlib.deflateSync(raw, { level: 9 });

  const chunks = [];
  chunks.push(pngChunk('IHDR', Buffer.concat([
    writeUint32(width),
    writeUint32(height),
    Buffer.from([8, 6, 0, 0, 0]), // 8-bit, RGBA
  ])));
  chunks.push(pngChunk('IDAT', idatData));
  chunks.push(pngChunk('IEND', Buffer.alloc(0)));

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ...chunks,
  ]);
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const chunk = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(chunk), 0);
  return Buffer.concat([writeUint32(data.length), chunk, crc]);
}

function writeUint32(n) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(n, 0);
  return buf;
}

function crc32(buf) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return ~c >>> 0;
}

for (const size of sizes) {
  const png = createPng(size);
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), png);
  console.log(`Generated icon${size}.png`);
}
