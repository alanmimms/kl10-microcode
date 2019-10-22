'use strict';
const StampIt = require('@stamp/it');

// Base Stamp for EBOX functional units. This is an abstract Stamp
// defining protocol but all should be completely overridden.
const EBOXUnit = StampIt({
  // Must override in derived stamps
  name: 'EBOXUnit',
}).props({
  // Should set in derived stamps
  bitWidth: 0,
}).methods({
  // Must override in derived stamps
  get() { return undefined; }
});
module.exports.EBOXUnit = EBOXUnit;


// BitField definition. Define with a specific name. Convention is
// that `s` is PDP10 numbered leftmost bit and `e` is PDP10 numbered
// rightmost bit in field. So number of bits is `e-s+1`.
const BitField = StampIt(EBOXUnit, {
  name: 'BitField',
}).props({
  s: 0,
  e: 0,
});
module.exports.BitField = BitField;


// Use this for inputs that are always zero.
const bigInt0 = BigInt(0);
const zeroUnit = StampIt(EBOXUnit, {
  name: 'zero',
}).methods({
  get() { return bigInt0; }
});
module.exports.bigInt0 = bigInt0;
module.exports.zeroUnit = zeroUnit;
