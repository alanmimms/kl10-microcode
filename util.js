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
const oct6 = module.exports.oct6 = n => octal(n, 6);
const octW = module.exports.octW = n => octal(n, 12, 6, ',,');


// Return BigInt bit mask for PDP bit numbering bit `n` in word of
// width `w`.
function maskForBit(n, w = 36) {
  return 1n << shiftForBit(n, w);
}
module.exports.maskForBit = maskForBit;


// In a PDP10 word of `w` bits, return the shift right count to get
// bit #n into LSB.
function shiftForBit(n, w = 36) {
  return BigInt(w - 1 - n);
}
module.exports.shiftForBit = shiftForBit;


// Return a BigInt mask for PDP10 numbered bit positions within `w` bit word
// of `s`..`e`. 
function fieldMask(s, e, w = 36) {
  const sMask = maskForBit(s - 1, w) - 1n;
  const rightMask = maskForBit(e, w) - 1n;
  return sMask - rightMask;
}
module.exports.fieldMask = fieldMask;


// Insert into BigInt `v` whose full width is `w` bits the value `n`
// at PDP10 numbered bit positions within `v` of `s`..`e`. Returns
// BigInt.
function fieldInsert(v, n, s, e, w = 36) {
  return v & ~fieldMask(s, e, w) | (BigInt(n) << shiftForBit(e, w));
}
module.exports.fieldInsert = fieldInsert;


// Return BigInt extracted from BigInt `v` whose full width is `w`
// bits the PDP10 numbered bitfield `s`..`e`.
function fieldExtract(v, s, e, w = 36) {
  return (v & fieldMask(s, e, w)) >> shiftForBit(e, w);
}
module.exports.fieldExtract = fieldExtract;


// Wrap a method named `method` for an optionally stamp-based object
// `objToWrap` with a function that logs the fact of the method call,
// the name of the object method was invoked for, its parent stamp
// name (if any) and its result. The `wrapAction` function can be
// specified if some other action is needed in the wrapper (e.g.,
// maintaining statistics, debugging, etc.).
const contextSymbol = Symbol('wrapping context');
function wrapMethod(objToWrap, method, wrapAction = defaultWrapAction) {
  const context = {
    wrappedObj: objToWrap,
    name: objToWrap.name,
    methodName: method,
    originalFunction: objToWrap[method].bind(objToWrap),
    wrapAction,
  };
  objToWrap[method] = wrapper.bind(context);
  objToWrap[method][contextSymbol] = context;
  return objToWrap;


  function wrapper(...a) {
    const result = this.originalFunction(...a);
    const stamp = this.wrappedObj.stamp || {name: ''};
    const name = `${this.name}@${stamp.name}`;
    const bitWidth = Number(this.wrappedObj.bitWidth || 36);
    return this.wrapAction({result, stamp, name, bitWidth});
  }
}
module.exports.wrapMethod = wrapMethod;


function defaultWrapAction({result, stamp, name, bitWidth, context}) {
  const resultString = result == null ? '' : `=${octW(result)}`;
  console.log(`${name} ${this.methodName}${resultString}`);
  return result;
}
module.exports.defaultWrapAction = defaultWrapAction;


// The antidote to `wrapMethod()` to unwrap. Note this must be done in
// LIFO order if nested wrapping on the method.
function unwrapMethod(wrappedObj, method) {
  const context = wrappedObj[method][contextSymbol];
  wrappedObj[method] = context.originalFunction;
}
module.exports.unwrapMethod = unwrapMethod;


function methodIsWrapped(obj, method) {
  const value = obj[method];
  return typeof value === typeofFunction && value[contextSymbol];
}
module.exports.methodIsWrapped = methodIsWrapped;


// Return a list of names of methods that have wrappers or [] if none.
const typeofFunction = typeof (() => 0);
module.exports.typeofFunction = typeofFunction;
function wrappedMethods(obj) {
  return Object.keys(obj)
    .filter(name => methodIsWrapped(obj, name));
}
module.exports.wrappedMethods = wrappedMethods;
