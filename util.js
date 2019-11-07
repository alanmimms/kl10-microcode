'use strict';

// For a BigInt parameter `n`, return its value decoded as groups of
// four octal digits with leading zeroes. For Number `n`, just return
// leading zero octal digits for the specified bits-per-word size
// `bpw`.
function octal(n, bpw = 12, digits = 4) {

  if (typeof n === 'bigint') {
    const oneMore = 1n << BigInt(bpw);
    const re = RegExp(`(.{${digits}})`, 'g');
    return (n | oneMore).toString(8).slice(1).match(re).join(' ');
  } else {
    const oneMore = 1 << bpw;
    return (n | oneMore).toString(8).slice(1);
  }
}
module.exports.octal = octal;


// Return BigInt bit mask for PDP bit numbering bit `n` in word of
// width `w`.
function maskForBit(n, w = 36) {
  return BigInt(Math.pow(2, w - 1 - n));
}
module.exports.maskForBit = maskForBit;


// In a PDP10 word of `w` bits, return the shift right count to get
// bit #n into LSB.
function shiftForBit(n, w = 36) {
  return BigInt(w) - 1n - BigInt(n);
}
module.exports.shiftForBit = shiftForBit;


// Return a BigInt mask for PDP10 numbered bit positions within `w` bit word
// of `s`..`e`. 
function fieldMask(s, e, w) {
  const sMask = (1n << shiftForBit(s - 1, w)) - 1n;
  const rightMask = (1n << shiftForBit(e, w)) - 1n;
  return sMask ^ rightMask;
}
module.exports.fieldMask = fieldMask;


// Insert into `v` whose full width is `w` bits the value `n` at PDP10
// numbered bit positions within `v` of `s`..`e`. All values are BigInt.
function fieldInsert(v, n, s, e, w) {
  return v & ~fieldMask(s, e, w) | (BigInt(n) << shiftForBit(e, w));
}
module.exports.fieldInsert = fieldInsert;


// Return from `v` whose full width is `w` bits the PDP10 numbered
// bitfield `s`..`e`. All values are BigInt.
function fieldExtract(v, s, e, w) {
  return (v & fieldMask(s, e, w)) >> shiftForBit(e, w);
}
module.exports.fieldExtract = fieldExtract;
