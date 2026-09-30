import { describe, expect, it } from 'vitest';
import { convertEndian, formatInteger } from './middle-endian-converter.service';

describe('convertEndian', () => {
  it('converts 32-bit byte-swapped correctly', () => {
    const result = convertEndian('0A0B0C0D', 32, 'byte-swapped');
    expect(result.bigEndian).toBe('0x0B0A0D0C');
    expect(result.littleEndian).toBe('0x0C0D0A0B');
  });

  it('converts 64-bit word-swapped correctly', () => {
    const result = convertEndian('0A0B0C0D0E0F1234', 64, 'word-swapped');
    expect(result.bigEndian).toBe('0x0C0D0A0B12340E0F');
    expect(result.littleEndian).toBe('0x0F0E34120B0A0D0C');
  });

  it('throws on invalid hex', () => {
    expect(() => convertEndian('ZZZZ', 32, 'byte-swapped')).toThrow();
  });

  it('throws on incorrect length', () => {
    expect(() => convertEndian('1234', 32, 'byte-swapped')).toThrow();
  });
});

describe('formatInteger', () => {
  it('should convert input hex to octal, decimal and hexa', () => {
    expect(formatInteger('0xFF')).toEqual({
      decimal: '255',
      octal: '0o377',
      hexadecimal: '0xFF',
    });
  });
});
