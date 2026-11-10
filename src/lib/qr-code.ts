/**
 * Self-contained ISO/IEC 18004 QR Code Matrix & SVG Generator (Versions 1–10, ECC Level L, Byte Mode).
 * Zero external dependencies — works in both Node.js and browser Canvas/SVG.
 */

interface VersionSpec {
  version: number;
  ecCodewordsPerBlock: number;
  group1Blocks: number;
  group1DataCodewords: number;
  group2Blocks: number;
  group2DataCodewords: number;
  alignmentPositions: number[];
  versionInfoBits?: number;
}

const VERSION_SPECS_L: VersionSpec[] = [
  {
    version: 1,
    ecCodewordsPerBlock: 7,
    group1Blocks: 1,
    group1DataCodewords: 19,
    group2Blocks: 0,
    group2DataCodewords: 0,
    alignmentPositions: [],
  },
  {
    version: 2,
    ecCodewordsPerBlock: 10,
    group1Blocks: 1,
    group1DataCodewords: 34,
    group2Blocks: 0,
    group2DataCodewords: 0,
    alignmentPositions: [6, 18],
  },
  {
    version: 3,
    ecCodewordsPerBlock: 15,
    group1Blocks: 1,
    group1DataCodewords: 55,
    group2Blocks: 0,
    group2DataCodewords: 0,
    alignmentPositions: [6, 22],
  },
  {
    version: 4,
    ecCodewordsPerBlock: 20,
    group1Blocks: 1,
    group1DataCodewords: 80,
    group2Blocks: 0,
    group2DataCodewords: 0,
    alignmentPositions: [6, 26],
  },
  {
    version: 5,
    ecCodewordsPerBlock: 26,
    group1Blocks: 1,
    group1DataCodewords: 108,
    group2Blocks: 0,
    group2DataCodewords: 0,
    alignmentPositions: [6, 30],
  },
  {
    version: 6,
    ecCodewordsPerBlock: 18,
    group1Blocks: 2,
    group1DataCodewords: 68,
    group2Blocks: 0,
    group2DataCodewords: 0,
    alignmentPositions: [6, 34],
  },
  {
    version: 7,
    ecCodewordsPerBlock: 20,
    group1Blocks: 2,
    group1DataCodewords: 78,
    group2Blocks: 0,
    group2DataCodewords: 0,
    alignmentPositions: [6, 22, 38],
    versionInfoBits: 0x07c94,
  },
  {
    version: 8,
    ecCodewordsPerBlock: 24,
    group1Blocks: 2,
    group1DataCodewords: 97,
    group2Blocks: 0,
    group2DataCodewords: 0,
    alignmentPositions: [6, 24, 42],
    versionInfoBits: 0x085bc,
  },
  {
    version: 9,
    ecCodewordsPerBlock: 30,
    group1Blocks: 2,
    group1DataCodewords: 116,
    group2Blocks: 0,
    group2DataCodewords: 0,
    alignmentPositions: [6, 26, 46],
    versionInfoBits: 0x09a99,
  },
  {
    version: 10,
    ecCodewordsPerBlock: 18,
    group1Blocks: 2,
    group1DataCodewords: 68,
    group2Blocks: 2,
    group2DataCodewords: 69,
    alignmentPositions: [6, 28, 50],
    versionInfoBits: 0x0a4d3,
  },
];

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function reedSolomonDivisor(degree: number): Uint8Array {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) {
        result[j] ^= result[j + 1];
      }
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
  const result = new Uint8Array(divisor.length);
  for (let i = 0; i < data.length; i += 1) {
    const factor = data[i] ^ result[0];
    result.copyWithin(0, 1);
    result[divisor.length - 1] = 0;
    for (let j = 0; j < divisor.length; j += 1) {
      result[j] ^= gfMultiply(divisor[j], factor);
    }
  }
  return result;
}

function appendBits(val: number, len: number, bits: number[]) {
  for (let i = len - 1; i >= 0; i -= 1) {
    bits.push((val >>> i) & 1);
  }
}

function selectVersionSpec(byteLength: number): VersionSpec {
  for (const spec of VERSION_SPECS_L) {
    const totalDataCodewords =
      spec.group1Blocks * spec.group1DataCodewords + spec.group2Blocks * spec.group2DataCodewords;
    const countIndicatorBits = spec.version <= 9 ? 8 : 16;
    const availableBits = totalDataCodewords * 8 - 4 - countIndicatorBits;
    if (byteLength * 8 <= availableBits) {
      return spec;
    }
  }
  throw new Error(`QR payload too long (${byteLength} bytes, max 271 bytes)`);
}

function encodeDataCodewords(bytes: Uint8Array, spec: VersionSpec): Uint8Array {
  const totalDataCodewords =
    spec.group1Blocks * spec.group1DataCodewords + spec.group2Blocks * spec.group2DataCodewords;
  const capacityBits = totalDataCodewords * 8;
  const bits: number[] = [];

  // Byte mode indicator (0100)
  appendBits(0b0100, 4, bits);
  // Character count indicator (8 bits for V1-9, 16 bits for V10+)
  appendBits(bytes.length, spec.version <= 9 ? 8 : 16, bits);
  for (let i = 0; i < bytes.length; i += 1) {
    appendBits(bytes[i], 8, bits);
  }

  // Terminator (up to 4 zero bits)
  appendBits(0, Math.min(4, capacityBits - bits.length), bits);
  // Pad to byte boundary
  appendBits(0, (8 - (bits.length % 8)) % 8, bits);

  // Pad bytes (0xEC, 0x11 alternating)
  let padToggle = 0;
  while (bits.length < capacityBits) {
    appendBits(padToggle % 2 === 0 ? 0xec : 0x11, 8, bits);
    padToggle += 1;
  }

  const codewords = new Uint8Array(totalDataCodewords);
  for (let i = 0; i < bits.length; i += 1) {
    codewords[i >>> 3] |= bits[i] << (7 - (i & 7));
  }
  return codewords;
}

function interleaveWithEcc(dataCodewords: Uint8Array, spec: VersionSpec): Uint8Array {
  const divisor = reedSolomonDivisor(spec.ecCodewordsPerBlock);
  const dataBlocks: Uint8Array[] = [];
  const eccBlocks: Uint8Array[] = [];

  let offset = 0;
  for (let i = 0; i < spec.group1Blocks; i += 1) {
    const block = dataCodewords.subarray(offset, offset + spec.group1DataCodewords);
    offset += spec.group1DataCodewords;
    dataBlocks.push(block);
    eccBlocks.push(reedSolomonRemainder(block, divisor));
  }
  for (let i = 0; i < spec.group2Blocks; i += 1) {
    const block = dataCodewords.subarray(offset, offset + spec.group2DataCodewords);
    offset += spec.group2DataCodewords;
    dataBlocks.push(block);
    eccBlocks.push(reedSolomonRemainder(block, divisor));
  }

  const totalBlocks = spec.group1Blocks + spec.group2Blocks;
  const maxDataLen = Math.max(spec.group1DataCodewords, spec.group2DataCodewords);
  const totalCodewords = dataCodewords.length + totalBlocks * spec.ecCodewordsPerBlock;
  const result = new Uint8Array(totalCodewords);

  let outIdx = 0;
  for (let col = 0; col < maxDataLen; col += 1) {
    for (let b = 0; b < totalBlocks; b += 1) {
      if (col < dataBlocks[b].length) {
        result[outIdx] = dataBlocks[b][col];
        outIdx += 1;
      }
    }
  }
  for (let col = 0; col < spec.ecCodewordsPerBlock; col += 1) {
    for (let b = 0; b < totalBlocks; b += 1) {
      result[outIdx] = eccBlocks[b][col];
      outIdx += 1;
    }
  }
  return result;
}

function computeFormatBits(mask: number): number {
  // ECC Level L = 01
  const data = (0b01 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function drawFormatBits(modules: boolean[][], isFunction: boolean[][], mask: number) {
  const size = modules.length;
  const bits = computeFormatBits(mask);

  const setFunctionModule = (x: number, y: number, isDark: boolean) => {
    modules[y][x] = isDark;
    isFunction[y][x] = true;
  };

  for (let i = 0; i <= 5; i += 1) {
    setFunctionModule(8, i, ((bits >>> i) & 1) !== 0);
  }
  setFunctionModule(8, 7, ((bits >>> 6) & 1) !== 0);
  setFunctionModule(8, 8, ((bits >>> 7) & 1) !== 0);
  setFunctionModule(7, 8, ((bits >>> 8) & 1) !== 0);
  for (let i = 9; i < 15; i += 1) {
    setFunctionModule(14 - i, 8, ((bits >>> i) & 1) !== 0);
  }

  for (let i = 0; i < 8; i += 1) {
    setFunctionModule(size - 1 - i, 8, ((bits >>> i) & 1) !== 0);
  }
  for (let i = 8; i < 15; i += 1) {
    setFunctionModule(8, size - 15 + i, ((bits >>> i) & 1) !== 0);
  }
  setFunctionModule(8, size - 8, true);
}

function drawFunctionPatterns(modules: boolean[][], isFunction: boolean[][], spec: VersionSpec) {
  const size = modules.length;
  const setFunctionModule = (x: number, y: number, isDark: boolean) => {
    modules[y][x] = isDark;
    isFunction[y][x] = true;
  };

  // Timing patterns
  for (let i = 0; i < size; i += 1) {
    setFunctionModule(6, i, i % 2 === 0);
    setFunctionModule(i, 6, i % 2 === 0);
  }

  // Finder patterns (3 corners)
  const drawFinderPattern = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = cx + dx;
        const yy = cy + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) {
          setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }
  };
  drawFinderPattern(3, 3);
  drawFinderPattern(size - 4, 3);
  drawFinderPattern(3, size - 4);

  // Alignment patterns
  const pos = spec.alignmentPositions;
  const numAlign = pos.length;
  for (let i = 0; i < numAlign; i += 1) {
    for (let j = 0; j < numAlign; j += 1) {
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === numAlign - 1) ||
        (i === numAlign - 1 && j === 0)
      ) {
        continue;
      }
      const cx = pos[j];
      const cy = pos[i];
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          setFunctionModule(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // Reserve format bits
  drawFormatBits(modules, isFunction, 0);

  // Version info bits (V7+)
  if (spec.versionInfoBits !== undefined) {
    for (let i = 0; i < 18; i += 1) {
      const bit = ((spec.versionInfoBits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunctionModule(a, b, bit);
      setFunctionModule(b, a, bit);
    }
  }
}

function drawCodewords(modules: boolean[][], isFunction: boolean[][], allCodewords: Uint8Array) {
  const size = modules.length;
  let bitIdx = 0;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && bitIdx < allCodewords.length * 8) {
          const isDark = ((allCodewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1) !== 0;
          modules[y][x] = isDark;
          bitIdx += 1;
        }
      }
    }
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(modules: boolean[][], isFunction: boolean[][], mask: number) {
  const size = modules.length;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!isFunction[y][x] && maskBit(mask, x, y)) {
        modules[y][x] = !modules[y][x];
      }
    }
  }
}

function computePenaltyScore(modules: boolean[][]): number {
  const size = modules.length;
  let result = 0;

  // Adjacent modules in row having same color
  for (let y = 0; y < size; y += 1) {
    let runColor = false;
    let runX = 0;
    for (let x = 0; x < size; x += 1) {
      if (x === 0 || modules[y][x] !== runColor) {
        runColor = modules[y][x];
        runX = 1;
      } else {
        runX += 1;
        if (runX === 5) result += 3;
        else if (runX > 5) result += 1;
      }
    }
  }

  // Adjacent modules in column having same color
  for (let x = 0; x < size; x += 1) {
    let runColor = false;
    let runY = 0;
    for (let y = 0; y < size; y += 1) {
      if (y === 0 || modules[y][x] !== runColor) {
        runColor = modules[y][x];
        runY = 1;
      } else {
        runY += 1;
        if (runY === 5) result += 3;
        else if (runY > 5) result += 1;
      }
    }
  }

  // 2x2 blocks of same color
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
        result += 3;
      }
    }
  }

  // Balance of dark and light modules
  let dark = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (modules[y][x]) dark += 1;
    }
  }
  const total = size * size;
  const k = Math.ceil((Math.abs(dark * 20 - total * 10) + total - 1) / total) - 1;
  result += Math.max(0, k) * 10;

  return result;
}

/**
 * Encodes a UTF-8 string into a square boolean matrix (true = dark module, false = light module).
 */
export function generateQrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  const spec = selectVersionSpec(bytes.length);
  const size = spec.version * 4 + 17;

  const modules: boolean[][] = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const isFunction: boolean[][] = Array.from({ length: size }, () => Array<boolean>(size).fill(false));

  drawFunctionPatterns(modules, isFunction, spec);
  const dataCodewords = encodeDataCodewords(bytes, spec);
  const allCodewords = interleaveWithEcc(dataCodewords, spec);
  drawCodewords(modules, isFunction, allCodewords);

  // Pick lowest-penalty mask (0..7)
  let bestMask = 0;
  let minPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    applyMask(modules, isFunction, mask);
    drawFormatBits(modules, isFunction, mask);
    const penalty = computePenaltyScore(modules);
    if (penalty < minPenalty) {
      minPenalty = penalty;
      bestMask = mask;
    }
    applyMask(modules, isFunction, mask); // undo
  }

  applyMask(modules, isFunction, bestMask);
  drawFormatBits(modules, isFunction, bestMask);
  return modules;
}

/**
 * Converts a QR matrix into an SVG path string (`M...h1v1h-1z`) with the given quiet zone border.
 */
export function qrMatrixToSvgPath(matrix: boolean[][], border = 2): { viewBoxSize: number; pathData: string } {
  const size = matrix.length;
  const viewBoxSize = size + border * 2;
  const parts: string[] = [];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (matrix[y][x]) {
        parts.push(`M${x + border},${y + border}h1v1h-1z`);
      }
    }
  }

  return {
    viewBoxSize,
    pathData: parts.join(""),
  };
}
