'use strict';
const StampIt = require('@stamp/it');

// Base Stamp for EBOX functional units. This is an abstract Stamp
// defining protocol but all should be completely overridden.
const EBOXUnit = StampIt({
  // Must override in derived stamps
  name: 'EBOXUnit',
}).init(function({bitWidth}) {
  this.bitWidth = bitWidth;
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
}).init(function({s, e}) {
  this.s = s;
  this.e = e;
}).methods({
  get() { return undefined; }
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


// Take a group of inputs and concatenate them into a single wide
// field.
const BitCombiner = StampIt(EBOXUnit, {
  name: 'BitCombiner',
}).methods({
  get() { }
});
module.exports.BitCombiner = BitCombiner;


// Take a wide input and split it into multiple subfields.
const BitSplitter = StampIt(EBOXUnit, {
  name: 'BitSplitter',
}).methods({
  get() { }
});
module.exports.BitSplitter = BitSplitter;


// Given a selector input and a series of selectable inputs, produce
// the value of the selected input on the output.
const Mux = StampIt(EBOXUnit, {
  name: 'Mux',
}).methods({
  get() { }
});
module.exports.Mux = Mux;


// Latch input for later retrieval.
const Reg = StampIt(EBOXUnit, {
  name: 'Reg',
}).methods({
  get() { }
});
module.exports.Reg = Reg;


// Given a function selector and a set of inputs, compute a set of
// results.
const LogicUnit = StampIt(EBOXUnit, {
  name: 'LogicUnit',
}).init(function({splitter, inputs}) {
  this.splitter = splitter;
  this.inputs = inputs;
}).methods({
  get() { }
});
module.exports.LogicUnit = LogicUnit;


