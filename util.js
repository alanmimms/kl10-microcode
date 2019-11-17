'use strict';
const _ = require('lodash');

// Return octal string for `n` value decoded as groups of `groupSize`
// with at least `minDigits` octal digits padded on left with leading
// zeroes.
function octal(n, minDigits = 4, groupSize = (minDigits % 6 === 0) ? 6 : 4, delim = '.') {
  const lzString = _.padStart(n.toString(8), minDigits, '0');

  if (groupSize > 0) {
    const re = RegExp(`(.{${groupSize}})`, 'g');
    return (lzString.match(re) || [lzString]).join(delim);
  } else {
    return lzString;
  }
}
module.exports.octal = octal;
module.exports.oct6 = n => octal(n, 6);
module.exports.octW = n => octal(n, 12, 6, ',,');


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
