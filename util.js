'use strict';
const _ = require('lodash');
const util = require('util');

var wrapperEnableLevel = 1;
module.exports.wrapperEnableLevel = wrapperEnableLevel;

// Return octal string for `n` value decoded as groups of `groupSize`
// with at least `minDigits` octal digits padded on left with leading
// zeroes.
function octal(n, minDigits = 4, groupSize = (minDigits % 6 === 0 || minDigits < 12) ? 6 : 4, delim = '.') {
  const lzString = _.padStart(n.toString(8), minDigits, '0');

  if (groupSize > 0 && groupSize < minDigits) {
    let s = lzString;
    const slices = [];

    // Build up the `slices` array with right hand slices of groupSize
    // bytes until `s` holds the remainder (if any), which ends up as
    // the first element of the array.
    while (s) {
      slices.unshift(s.slice(-groupSize));
      s = s.slice(0, -groupSize);
    }

    return slices.join(delim);
  } else {
    return lzString;
  }
}
module.exports.octal = octal;                                   // Default is four octal digits zero left padded
const oct6 = module.exports.oct6 = n => octal(n, 6);            // 18b halfwords zero left padded
const octW = module.exports.octW = n => octal(n, 12, 6, ',,');  // Full 36b words x,,y zero left padded
const octA = module.exports.octA = n => octal(n, 7, 6, ',,');   // Addresses x,,y padded to at least one x digit
const octC = module.exports.octC = n => octal(n, 84/3);         // CRAM words


// Return BigInt bit mask for PDP bit numbering bit `n` in word of
// width `w`.
function maskForBit(n, w = 36) {
  n = Number(n);
  w = Number(w);
  return 1n << shiftForBit(n, w);
}
module.exports.maskForBit = maskForBit;


// In a PDP10 word of `w` bits, return the shift right count to get
// bit #n into LSB.
function shiftForBit(n, w = 36) {
  n = Number(n);
  w = Number(w);
  return BigInt(w - 1 - n);
}
module.exports.shiftForBit = shiftForBit;


// Return a BigInt mask for PDP10 numbered bit positions within `w` bit word
// of `s`..`e`. 
function fieldMask(s, e, w = 36) {
  s = Number(s);
  e = Number(e);
  w = Number(w);
  const sMask = (maskForBit(s, w) << 1n) - 1n;
  const eMask = maskForBit(e, w) - 1n;
  return sMask - eMask;
}
module.exports.fieldMask = fieldMask;


// Insert into BigInt `v` whose full width is `w` bits the value `n`
// at PDP10 numbered bit positions within `v` of `s`..`e`. Returns
// BigInt.
function fieldInsert(v, n, s, e, w = 36) {
  v = BigInt(v);
  n = BigInt(n);
  s = Number(s);
  e = Number(e);
  w = Number(w);
  return v & ~fieldMask(s, e, w) | (n << shiftForBit(e, w));
}
module.exports.fieldInsert = fieldInsert;


// Return BigInt extracted from BigInt `v` whose full width is `w`
// bits the PDP10 numbered bitfield `s`..`e`.
function fieldExtract(v, s, e, w = 36) {
  v = BigInt(v);
  s = Number(s);
  e = Number(e);
  w = Number(w);
  return (v & fieldMask(s, e, w)) >> shiftForBit(e, w);
}
module.exports.fieldExtract = fieldExtract;


// Wrap a method named `method` for an optionally stamp-based object
// `objToWrap` with a function that logs the fact of the method call,
// the name of the object method was invoked for, its parent stamp
// name (if any) and its result. The `wrapAction` function can be
// specified if some other action is needed in the wrapper (e.g.,
// maintaining statistics, debugging, etc.). Pass an object for `opts`
// to specify preAction, postAction, and replaceAction functions to be
// used before, after, and in place of the unwrapped implementation of
// the method.
let wrapDepth = 0;              // Indentation counter
const contextSymbol = Symbol('wrapping context');
function wrapMethod(objToWrap, method,
                    opts = {
                      verbose: false,
                      preAction: defaultPreAction,
                      postAction: defaultPostAction,
                      replaceAction: null,
                    })
{
  opts.preAction = opts.preAction || defaultPreAction;
  opts.postAction = opts.postAction || defaultPostAction;
  opts.replaceAction = opts.replaceAction;

  const context = {
    wrappedObj: objToWrap,
    name: objToWrap.name,
    methodName: method,
    originalFunction: objToWrap[method],
    preAction: opts.preAction,
    postAction: opts.postAction,
    replaceAction: opts.replaceAction,
    verbose: opts.verbose,
  };

  // Do not wrap methods we are told not to.
  if (objToWrap.doNotWrap[method]) return objToWrap;

  objToWrap[method] = wrapper.bind(context);
  objToWrap[method][contextSymbol] = context;
  return objToWrap;


  function wrapper(...a) {
    const stamp = this.wrappedObj.stamp || {name: ''};
    const name = `${this.name}@${stamp.name}`;
    const bitWidth = Number(this.wrappedObj.bitWidth || 36);
    this.preAction({stamp, name, bitWidth, context});
    const fToBind = opts.replaceAction ? opts.replaceAction : this.originalFunction;
    const result = fToBind.apply(objToWrap, a);
    return this.postAction({result, stamp, name, bitWidth});
  }
}
module.exports.wrapMethod = wrapMethod;


function defaultPreAction({stamp, name, bitWidth, context}) {
  const o = this.wrappedObj;
  this.beforeValue = o.value;
  this.beforeToLatch = o.toLatch;

  if (this.verbose) {
    if (wrapperEnableLevel) console.log(`\
${''.padStart(wrapDepth*2)}${name}.${this.methodName}: \
before value=${o.vToString(this.beforeValue)} toLatch=${o.vToString(this.beforeToLatch)}`);
  } else {
    // Not verbose. Do nothing in preAction.
  }
  
  ++wrapDepth;
}
module.exports.defaultPreAction = defaultPreAction;


function defaultPostAction({result, stamp, name, bitWidth, context}) {
  const o = this.wrappedObj;

  --wrapDepth;

  if (wrapperEnableLevel) {
    let resultString = result;

    try {
      resultString = o.vToString(result);
    } catch(e) {
      resultString = result || '<>';
    }

    if (this.verbose) {
      console.log(`\
${''.padStart(wrapDepth*2)}${name}.${this.methodName} \
 after value=${o.vToString(o.value)} toLatch=${o.vToString(o.toLatch)}  returns ${resultString}`);
    } else {
      console.log(`\
${''.padStart(wrapDepth*2)}${resultString} from ${name}.${this.methodName}`);
    }
  }

  return result;
}
module.exports.defaultPostAction = defaultPostAction;


// The antidote to `wrapMethod()` to unwrap. Note this must be done in
// LIFO order if nested wrapping on the method.
function unwrapMethod(wrappedObj, method) {

  // Do not unwrap methods we are told not to.
  if (wrappedObj.doNotWrap[method]) return;

  const context = wrappedObj[method][contextSymbol];
  wrappedObj[method] = context.originalFunction;
}
module.exports.unwrapMethod = unwrapMethod;


function methodIsWrapped(obj, method) {
  const value = obj[method];
  return typeof value === typeofFunction && value[contextSymbol];
}
module.exports.methodIsWrapped = methodIsWrapped;


function disableWrappers() {
  --wrapperEnableLevel;
}
module.exports.disableWrappers = disableWrappers;

function restoreWrappers() {
  ++wrapperEnableLevel;
}
module.exports.restoreWrappers = restoreWrappers;



// Return a list of names of methods that have wrappers or [] if none.
const typeofFunction = typeof (() => 0);
module.exports.typeofFunction = typeofFunction;
function wrappedMethods(obj) {
  return Object.keys(obj)
    .filter(name => methodIsWrapped(obj, name));
}
module.exports.wrappedMethods = wrappedMethods;


function centeredBanner(s, width = 80, pad = '=') {
  const leftPad = (width - s.length) >>> 1;
  s = ' ' + s + ' ';
  return s
    .padStart(s.length + leftPad, pad)
    .padEnd(width, pad);
}
module.exports.centeredBanner = centeredBanner;
