'use strict';
const _ = require('lodash');
const util = require('util');
const {assert} = require('chai');
const StampIt = require('@stamp/it');

const {
  octal, oct6, octW, octA, octC,
  maskForBit, shiftForBit,
  fieldInsert, fieldExtract, fieldMask,
  wrapMethod, unwrapMethod,
  centeredBanner, typeofFunction,
} = require('./util');

const utilFormats = require('./util');


// Read our defines.mic and gobble definitions for fields and
// constants for CRAM and DRAM.
const {CRAMdefinitions, DRAMdefinitions} = require('./read-defs');


// EBOX notes:
//
// M8539 APR module is replaced by M8545 in KL10 model B.
// M8523 VMA module is replaced by M8542 in KL10 model B.


////////////////////////////////////////////////////////////////
// Handy utility functions

// For each XXXXis(name) function, return 1n iff XXXX/${name} is true.
const SPECis = matcherFactory('SPEC');
const CONDis = matcherFactory('COND');
const VMAXis = matcherFactory('VMAX');
const  MEMis = matcherFactory('MEM');


// Return 1n iff CR[fieldName] has value of the constant
// fieldValueName defined for that field.
function fieldIs(fieldName, fieldValueName) {
  return BigInt(CR[fieldName].get() === CR[fieldName][fieldValueName]);
}


// Returns a matcher function to match CR field `fieldName` against
// its constant value named by the function parameter.
function matcherFactory(fieldName) {
  return name => {
    const toMatch = CR[fieldName][name];
/*
    const {s, e} = CR[fieldName];
    const w = e - s + 1;
    const cur = fieldExtract(CR.value, s, e, CR.bitWidth);
    console.log(`CR=${octal(CR.get(), 84/3)}`);
    console.log(`matcher CR.${fieldName}['${name}']=${octal(cur, w/3)} toMatch=${octal(toMatch, w/3)}`);
*/
    const cur = CR[fieldName].get();
    return cur === toMatch;
  }
}


////////////////////////////////////////////////////////////////
// Wire up an EBOX block diagram.
////////////////////////////////////////////////////////////////

// Name our instances for debugging and display. Every single Named
// unit is remembered in the Named.units object.
const Named = StampIt({name: 'Named'}).statics({
  units: {},                    // Dictionary of all Named instances

  // This is the list of property names that should be fixed up. That
  // is, replace their string values with the result of evaluating
  // that string at the end of the module.
  mayFixup: `input,inputs,func,control,addr,matchValue,enableF,loBits,hiBits`.split(/,\s*/),

  // This is the STAMP (not instance) method invoked at the end of
  // this module to fix up all of the `mayFixup` properties on all
  // stamps we know about.
  fixupForwardReferences(){
    Object.values(Named.units).forEach(unit => unit.fixupForwardReferences());
  },
}).init(function({name}, {stamp}) {
  this.name = name;
  this.stamp = stamp;
  this.propName = this.name.replace(/[ .,]/g, '_');
  Named.units[this.propName] = this;
}).methods({

  reset() { },

  debugBanner(msg) {
    console.log(`${this.name}: ` + centeredBanner(msg, 80 - this.name.length));
  },
  
  // This is called on every instance to fix up forward references
  // found in its `mayFixup` stamp static property, which is an array
  // of property names whose value is a string to be evaluated at the
  // end of the module to replace its value.
  fixupForwardReferences() {
    const that = this;

    this.stamp.mayFixup
      .filter(prop => typeof that[prop] === typeof 'string')
      .forEach(prop => {
        const asString = that[prop];
        that[prop] = eval(asString);
//      console.log(`${that.name}.${prop} = ${asString}`);
      });
  },
});
module.exports.Named = Named;


// Each Clock has a list of units it drives. Calling the `latch()` or
// `sampleInputs()` method on a Clock calls that same method each driven
// unit.
const Clock = Named.init(function({drives = []}) {
  this.drives = drives;
  this.wrappableMethods = `cycle,addUnit`.split(/,\s*/);
}).methods({
  addUnit(unit) { this.drives.push(unit) },

  cycle(debug = false) {
    if (debug) this.debugBanner(`sampleInputs`);

    this.drives.forEach(unit => {
      assert(typeof unit.sampleInputs === typeofFunction, `${unit.name} sampleInputs() must exist`); 
     unit.sampleInputs();
    });

    if (debug) this.debugBanner(`latch`);

    this.drives.forEach(unit => {
      assert(typeof unit.latch === typeofFunction, `${unit.name} latch() must exist`);
      unit.latch();
    });

    if (debug) this.debugBanner('cycle complete');
  },
});
module.exports.Clock = Clock;


// Used for non-clocked objects like ZERO and ONES. This is never
// actually cycled.
const NOCLOCK = Clock({name: 'NOCLOCK'});
module.exports.NOCLOCK = NOCLOCK;

// The EBOX-wide clock that drives the whole kaboodle.
const EBOXClock = Clock({name: 'EBOXClock'});
module.exports.EBOXClock = EBOXClock;


////////////////////////////////////////////////////////////////
//
// Derived from p. 212 Figure 3-5 Loading IR Via FM (COND/LOAD IR) and
// p. 214 Figure 3-7 NICOND Dispatch and Waiting.
//
//   │[=========]<---`sampleInputs()` regs recursively load inputs to `toLatch`, output remains stable
//   │[=========]<---non-regs settle inputs --> outputs
//   │           │[========]<---`latch()` regs drive `toLatch` on their outputs
// __│           │ __________│           │ __________│          │ _
//   \           │/          \           │/          \          │/ EBOX CLOCK
//   |\__________/           │\__________/           │\_________/
//   │           │           │           │           │          │ 
//   │ __________│           │ __________│           │ _________│ 
//   |/          │           │/          \           │/         \  EBOX SYNC
// __/           │\__________/           │\__________/          │\_
//   │           │           │           │           │          │ 
// __│ __________│ __________│___________│ __________│__________│ _
//   \/UNLATCHED \/ μinsn1   │ UNLATCHED \/ μinsn2   │UNLATCHED \/ CR
// __/\__________/\__________│___________/\__________│__________/\_
//   │           │           │           │           │          │ 
// __│___________│___________│___________│           │          │ 
//   │           │           │           \           │          │  NICOND DISP
//   │           │           │           │\__________│__________│__
//   │           │           │           │           │          │ 
//   │           │           │           │ __________│__________│ 
//   │           │           │           │/          │          \ CON LOAD DRAM
// __│___________│___________│___________/           │          │\_
//   │           │           │           │           │          │ 
//   │           │           │           │ __________│          │ _
//   │           │           UNLATCHED   │/  LATCHED \ UNLATCHED│/ DR
// __│___________│___________│___________/           │\_________/ 
//   │           │           │           │           │          │ 
//   │           │           │           │ __________│__________│ 
//   │           │           UNLATCHED   │/  LATCHED │          \ IR
// __│___________│___________│___________/           │          │\_
//   │           │           │           │           │          │ 
//   ^           │           ^           │           ^          │ 
//   └───────────│───────────┴───────────│───────────┴──────────│──  `latch()`: `value = toLatch`
//               ^                       ^                      ^ 
//               └───────────────────────┴──────────────────────┴─── `sampleInputs()`: `toLatch = input.get()`
//                                                                   (reg outputs remain stable)
//                                                                   (regs get non-reg state recursively)


////////////////////////////////////////////////////////////////
// Stamps
//
// Base Stamp for EBOX functional units. This is an abstract Stamp
// defining protocol but all should be completely overridden.
//
// The convention is that each EBOXUnit has a `getInputs()` method
// that retrieves the unit's value based on its current inputs and
// control and address and configuration.
//
// There is also a `get()` method to retrieve the current _output_ of
// the Unit.
//
// Combinatorial (not clocked) logic units simply implement `get()` as
// directly returning the value from `getInputs()`. Since these are
// not clocked, they implement a no-op for `latch()` and
// `sampleInputs()`. Registered and RAMs (Clocked) return the
// currently addressed or latched value in `get()` and use
// `getInputs()` (and `getControl()` and `getAddress()`) to determine
// what value to latch during `sampleInputs()`. When `latch()` is
// called, the output of a Clocked Unit reflects what was loaded
// during `sampleInputs()`.
//
// * `sampleInputs()` uses `getInputs()`, `getControl()` and
//   `getAddress()` to save a register or RAM's value and is a no-op
//   for combinatorial units.
//
// * `latch()` makes the saved value the new output of the unit. 
//
// * `get()` returns current output value. For combinatorial units
//   this just returns the transformed inputs.
//
const EBOXUnit = Named.compose({name: 'EBOXUnit'}).init(
  function({name, bitWidth, input, inputs, addr, func, control, clock = EBOXClock, debugFormat = 'octW'}) {
    this.name = name;
    this.clock = clock;
    this.input = input;         // We can use singular OR plural
    this.inputs = inputs;       //  but not both (`input` wins over `inputs`)
    this.func = func;
    this.control = control;
    clock.addUnit(this);        // Because of this `clock` cannot be on `mayFixup` list
    this.addr = addr;
    this.bitWidth = BigInt(bitWidth || 0);
    this.value = this.toLatch = 0n;
    this.debugFormat = debugFormat;
    this.wrappableMethods = `\
reset,cycle,getAddress,getFunc,getControl,getInputs,get,latch,sampleInputs
`.trim().split(/,\s*/);
  }).props({
    value: 0n,
  }).methods({

    // Stringify a value of our `this.value` type.
    vToString(v) { return utilFormats[this.debugFormat](v, Math.ceil(Number(this.bitWidth) / 3)) },

    reset() {
      this.value = 0n;
      this.bitWidth = BigInt(this.bitWidth || 1n);
      this.ones = (1n << this.bitWidth) - 1n;
      this.halfOnes = (1n << (this.bitWidth / 2n)) - 1n;
    },

    cycle() {
      this.sampleInputs();
      this.latch();
    },

    getAddress() { assert(this.addr, `${this.name}.addr not null`); return this.addr.get() },
    getFunc()    { assert(this.func, `${this.name}.func not null`); return this.func.get() },
    getControl() { assert(this.control, `${this.name}.control not null`); return this.control.get() },
    getInputs()  { assert(this.input, `${this.name}.input not null`); return this.input.get() & this.ones },

    getLH(v = this.value) { return (v >> 18n) & this.halfOnes },
    getRH(v = this.value) { return v & this.halfOnes },
    joinHalves(lh, rh) { return (lh << 18n) | (rh & this.halfOnes) },
  });
module.exports.EBOXUnit = EBOXUnit;


////////////////////////////////////////////////////////////////
// The EBOX.
const EBOX = StampIt.compose(Named, {
}).init(function ({serialNumber}) {
  this.serialNumber = serialNumber;
  this.microInstructionsExecuted = 0n;
  this.executionTime = 0;
  this.debugNICOND = false;
  this.debugCLOCK = false;
}).props({
  unitArray: [],      // List of all EBOX Units as an array of objects
  clock: EBOXClock,
  wrappableMethods: `cycle,reset`.split(/,\s*/),
  run: false,
  memCycle: false,              // Initiated by MEM/xxx, cleared by MEM/MB WAIT
  fetchCycle: false,            // Initiated by MEM/IFET, cleared by MEM/MB WAIT
}).methods({

  reset() {
    // Substitute real object references for strings we placed in
    // properties whose names are in `unit.stamp.mayFixup`.
    Named.fixupForwardReferences();

    this.resetActive = true;
    this.ucodeRun = false;
    this.run = true;            // By default I usually just want to go while testing microcode
    this.unitArray = Object.values(Named.units).concat([this]);

    // Reset every Unit back to initial value.
    this.unitArray.filter(unit => unit !== this).forEach(unit => unit.reset());

    // RESET always generates several clocks with zero CRAM and DRAM.
    CRAM.cycle();               // Explicitly set up CRAM for this cycle.
    _.range(4).forEach(k => this.cycle());

    this.resetActive = false;
  },

  cycle() {
    this.clock.cycle(this.debugCLOCK);
    CRAM.cycle(this.debugCLOCK); // Explicitly set up CRAM for next cycle.
    ++this.microInstructionsExecuted;
  },

  // Used by doExamine to allow arbitrary expression evaluation for
  // debugging.
  eval(s) {
    return eval(s);
  },
}) ({name: 'EBOX', serialNumber: 0o6543n});
module.exports.EBOX = EBOX;


// Use this mixin to define a Combinatorial unit that is unclocked.
const Combinatorial = EBOXUnit.compose({name: 'Combinatorial'}).methods({
  sampleInputs() { },
  latch() { },

  get() { 
    assert(typeof this.getInputs() === 'bigint', `${this.name}.getInputs returned non-BigInt`);
    return this.value = this.getInputs() & this.ones;
  },
});


// Use this mixin to define a Clocked unit.
const Clocked = EBOXUnit.compose({name: 'Clocked'}).methods({
  sampleInputs() { this.toLatch = this.getInputs() },
  latch() { this.value = this.toLatch },
  get() { return this.value },
});


////////////////////////////////////////////////////////////////
// BitField definition. Define with a specific name. Convention is
// that `s` is PDP10 numbered leftmost bit and `e` is PDP10 numbered
// rightmost bit in field. So number of bits is `e-s+1`.
// Not an EBOXUnit, just a useful stamp.
const BitField = Combinatorial.compose({name: 'BitField'}).init(function({name, s, e}) {
  this.name = name;
  this.s = s;
  this.e = e;
  this.bitWidth = BigInt(e - s + 1);
}).methods({

  reset() {
    assert(this.input, `${this.name}.input not null`);
    this.wordWidth = Number(this.input.bitWidth);
    this.shift = shiftForBit(this.e, this.input.bitWidth);
    this.ones = (1n << this.bitWidth) - 1n;
  },

  getInputs() {
    const v = this.input.get();
    const shifted = v >> BigInt(this.shift);
    return shifted & this.ones;
  },
});
module.exports.BitField = BitField;


////////////////////////////////////////////////////////////////
// Use this for inputs that are always zero.
const ConstantUnit = Combinatorial.compose({name: 'ConstantUnit'})
      .init(function ({value = 0, bitWidth}) {
        value = BigInt(value);
        this.bitWidth = BigInt(bitWidth);
        this.ones = (1n << this.bitWidth) - 1n;
        this.value = value >= 0n ? value : value & this.ones;
      }).methods({
        getInputs() {return this.value},

        // Neuter to prevent this.value being replaced with 0n
        reset() {},
      });
module.exports.ConstantUnit = ConstantUnit;

const ZERO = ConstantUnit({name: 'ZERO', bitWidth: 36n, value: 0n});
module.exports.ZERO = ZERO;
const ONES = ConstantUnit({name: 'ONES', bitWidth: 36n, value: (1n << 36n) - 1n});
module.exports.ONES = ONES;


////////////////////////////////////////////////////////////////
// Take a group of inputs and concatenate them into a single wide
// field.
const BitCombiner = Combinatorial.compose({name: 'BitCombiner'}).methods({

  getInputs() {
    assert(this.inputs, `${this.name}.inputs not null`);
    const combined = this.inputs.reduce((v, i) => (v << i.bitWidth) | i.get(), 0n);
    return this.value = combined & this.ones;
  },
});
module.exports.BitCombiner = BitCombiner;


////////////////////////////////////////////////////////////////
// Given an address, retrieve the stored word or if `isWrite()` write
// the value presented via `sampleInputs()`.
const RAM = Clocked.compose({name: 'RAM'}).init(function({nWords, initValue = 0n}) {
  this.nWords = nWords;
  this.initValue = initValue;
}).methods({

  RAMreset() {

    if (this.bitWidth <= 64 && this.initValue === 0n) {
      this.data = new BigUint64Array(this.nWords);
    } else {
      this.data = _.range(Number(this.nWords)).map(x => this.initValue);
    }

    this.latchedAddr = 0n;
    this.toLatch = this.value = this.initValue;
    this.ones = (1n << this.bitWidth) - 1n;
  },

  reset() { this.RAMreset() },

  sampleInputs() {
    this.latchedIsWrite = this.isWrite();
    this.latchedAddr = this.getAddress();

    if (this.latchedIsWrite) {  // Write
      this.toLatch = this.getInputs() & this.ones;
    } else {                    // Read
      // RAMs act as Combinatorial, passing through to their outputs
      // whatever is addressed during read.
      this.value = this.toLatch = this.data[this.latchedAddr] & this.ones;
    }

  },

  latch() {

    // Read was already handled during sampleInputs()
    if (this.latchedIsWrite) {  // Write
      this.value = this.data[this.latchedAddr] = this.toLatch;
    }
  },

  // Default behavior
  isWrite() {
    return !!this.getControl();          // Active-high truthy WRITE control
  },
});
module.exports.RAM = RAM;


// Use this for example as a `control` for a RAM (e.g., FM) to write
// when `COND/FM WRITE` with:
//      input: 'CR.COND', matchValue: "CR.COND['FM WRITE']"
const FieldMatcher = Combinatorial.compose({name: 'FieldMatcher'})
      .init(function({bitWidth = 1n,
                      matchValue,
                      matchF = (cur => cur === this.matchValue)}) {
        this.matchValue = matchValue;
        this.matchF = matchF;
        this.bitWidth = bitWidth;
      }).methods({

        getInputs() {
          const cur = this.input.get();
          return this.value = BigInt(!!this.matchF(cur));
        },
      });

// Use this for example as a `control` for a RAM to write when
// `COND/FM WRITE` with {input: 'CR.COND', matchValue: "CR.COND['FM WRITE']"}.
const FieldMatchClock = Clock.compose({name: 'FieldMatchClock'})
      .init(function({input, clock = EBOXClock, matchValue = 0n, matchF}) {
        this.input = input;
        this.clock = clock;
        this.matchValue = matchValue;
        this.matchF = matchF || (cur => cur === this.matchValue);
        clock.addUnit(this);
      }).methods({

        sampleInputs() { },     // XXX this needs to be fixed?

        latch() {
          const cur = this.input.get();
          this.value = BigInt(this.matchF(cur));

          if (this.value) {
            this.drives.forEach(unit => {
              assert(typeof unit.cycle === typeofFunction, `${unit.name}.cycle must be a function`);
              unit.cycle();
            });
          }
        },
      });

////////////////////////////////////////////////////////////////
// Given a control input and a series of selectable inputs, produce
// the value of the selected input on the output.
const Mux = Combinatorial.compose({name: 'Mux'}).init(function({enableF = () => 1n}) {
  this.enableF = enableF;
}).methods({

  get() {
    const controlValue = this.getControl();
    const input = this.inputs[controlValue];
    assert(this.enableF, `${this.name}.enableF not null`);
    assert(input, `${this.name}.get(): input not null for controlValue=${controlValue}.`);
    return this.enableF() ? input.get() & this.ones : 0n;
  },
});
module.exports.Mux = Mux;


////////////////////////////////////////////////////////////////
// Latch input for later retrieval.
const Reg = Clocked.compose({name: 'Reg'});
module.exports.Reg = Reg;


////////////////////////////////////////////////////////////////
// Latch input or shift or hold. Equivalent to ECL 10141.
// The `control` input provides a function code:
// 0: LOAD
// 1: SHIFT RIGHT
// 2: SHIFT LEFT
// 3: HOLD
// XXX needs implementation
const ShiftReg = Clocked.compose({name: 'ShiftReg'});
module.exports.ShiftReg = ShiftReg;


////////////////////////////////////////////////////////////////
// Given a function selector and a set of inputs, compute a set of
// results.
const LogicUnit = Combinatorial.compose({name: 'LogicUnit'});
module.exports.LogicUnit = LogicUnit;


////////////////////////////////////////////////////////////////
// Given a function selector and a set of inputs, compute a set of
// results.
const ShiftMult = Combinatorial.compose({name: 'ShiftMult'})
      .init(function({shift = 1, loBits = ZERO}) {
        this.shift = BigInt(shift);
        this.loBits = loBits;
      }).methods({

        get() {
          const inp = this.input.get();
          assert(this.loBits, `${this.name}.loBits not null`);
          const loBits = this.loBits.get() >> (this.loBits.bitWidth - this.shift);
          return (inp << this.shift | loBits) & this.ones;
        },
      });
module.exports.ShiftMult = ShiftMult;


////////////////////////////////////////////////////////////////
// Given a function selector and a set of inputs, compute a set of
// results.
const ShiftDiv = Combinatorial.compose({name: 'ShiftDiv'})
      .init(function({shift = 1, hiBits = ZERO}) {
        this.shift = BigInt(shift);
        this.hiBits = hiBits;
      }).methods({

        getInputs() {
          assert(this.hiBits, `${this.name}.hiBits not null`);
          const hiBits = this.hiBits.get() << (this.hiBits.bitWidth - this.shift);
          assert(this.input, `${this.name} must have input`);
          assert(typeof this.input.get === typeofFunction, `${this.name} must have input.get()`);
          return ((this.input.get() | hiBits) >> this.shift) & this.ones;
        },
      });
module.exports.ShiftDiv = ShiftDiv;


////////////////////////////////////////////////////////////////
// RAMs

// Control RAM: Readonly by default. This is not a RAM object because
// we explicitly clock it and manage its settled value for each EBOX
// cycle in EBOX. The CRAM value never changes during a cycle; it only
// changes in the time between cycles.
const CRAM = RAM.methods({

  reset() {
    this.RAMreset();
    this.force1777 = false;     // Set by page fault conditions
    this.stack = [];
  },

  sampleInputs() {},
  latch() {},

  cycle(debug = false) {
    if (debug) this.debugBanner(`sampleInputs`);
    this.latchedAddr = this.getAddress();
    if (debug) this.debugBanner(`latch`);
    this.value = this.data[this.latchedAddr];
    if (debug) this.debugBanner(`cycle complete`);
  },

  get() { return this.value },

  getAddress() {
    // XXX Still remaining:
    // * A7: The conditions from Muxes E1,E32 CRA2
    // * A8: The conditions from Muxes E2,E16 CRA2
    // * A9: The conditions from Muxes E6,E26 CRA2
    // * A10: The conditions from Muxes E22,E31,E36,E39 CRA2
    // * A10: CON COND ADR 10 CRA2
 
    if (this.force1777) {
      this.force1777 = false;   // Handled.
      // Push return address from page fault handler.
      // Push VALUE not TOLATCH.
      this.stack.push(this.latchedAddr);
      // Force next address to 0o1777 ORed with current MSBs.
      return this.latchedAddr | 0o1777n;
    }

    const skip = CR.SKIP.get();
    let orBits = 0n;

    // Determine if LSB is forced to '1' by a skip test condition or
    // If DISP/MUL finds sign(FE) == 0.
    switch(skip) {
    default:
      break;

    case CR.SKIP.RUN:
      if (EBOX.run) orBits = 0o1n;
      break;

    case CR.SKIP.KERNEL:
      orBits = 0o1n;          // XXX for now we are always in KERNEL mode
      break;

    case CR.SKIP['-START']:   // Needed?
    case CR.SKIP.FETCH:       // Soon
    case CR.SKIP.USER:
    case CR.SKIP.PUBLIC:
    case CR.SKIP['RPW REF']:
    case CR.SKIP['PI CYCLE']:
    case CR.SKIP['-EBUS GRANT']:
    case CR.SKIP['-EBUS XFER']:
    case CR.SKIP.INTRPT:
    case CR.SKIP['IO LEGAL']:
    case CR.SKIP['P!S XCT']:
    case CR.SKIP['-VMA SEC0']:
    case CR.SKIP['AC REF']:   // Soon
    case CR.SKIP['-MTR REQ']:
      break;                  // XXX these need to be implemented
    }

    const disp = CR.DISP.get();

    switch (disp) {

      // See schematics p. 344 and
      // EK-EBOX-all p. 256 for explanation.
      // FE0*4 + MQ34*2 + MQ35; implies MQ SHIFT, AD LONG
    case CR.DISP.MUL:
      if (FE.get() >= 0o1000n) orBits |= 0o04n;
      orBits |= MQ.get() & 3n;
      break;

    case CR.DISP['DRAM J']:
      orBits = DR.J.get() & 0o17n;
      break;

    case CR.DISP['RETURN']:   // POPJ return--may not coexist with CALL
      orBits = this.stack.pop();
      break;

    case CR.DISP['DRAM B']:   // 8 WAYS ON DRAM B FIELD
      // E.g., EXIT "DISP/DRAM B,MEM/B WRITE,J/ST0"
      orBits = DR.B.get();
      break;

    case CR.DISP['EA MOD']:	// (ARX0 or -LONG EN)*8 + -(LONG EN and ARX1)*4 +
      // ARX13*2 + (ARX2-5) or (ARX14-17) non zero; enable
      // is (ARX0 or -LONG EN) for second case.  If ARX18
      // is 0, clear AR left; otherwise, poke ARL select
      // to set bit 2 (usually gates AD left into ARL)
      // XXX this needs to be conditional on instructtion word
      // format for byte pointers, etc.
      if (IR.get() & X_NONZERO_MASK) orBits |= 0o01n;
      if (IR.get() & INDEXED_MASK) orBits |= 0o02n;
      break;

    case CR.DISP['NICOND']:   // NEXT INSTRUCTION CONDITION (see NEXT for detail)

      if (EBOX.piCyclePending) {
        if (EBOX.debugNICOND) console.log(`NICOND: CON PI CYCLE`);
      } else if (!EBOX.run) {
        orBits |= 0o02n;                      // -CON RUN (halt)
        if (EBOX.debugNICOND) console.log(`NICOND: CON -RUN (halt)`);
      } else if (EBOX.mtrIntReq) {
        orBits |= 0o04n;                      // MTR INT REQ (meter interrupt)
        if (EBOX.debugNICOND) console.log(`NICOND: MTR INT REQ (meter interrupt)`);
      } else if (EBOX.intReq) {
        orBits |= 0o06n;                      // INT REQ (interrupt)
        if (EBOX.debugNICOND) console.log(`NICOND: INT REQ (interrupt)`);
      } else if (EBOX.ucodeState05) {
        orBits |= 0o10n;                      // STATE 05 Tracks enable
        if (EBOX.trapReq) orBits |= 1n;       // STATE 05 Tracks enable+TRAP
        if (EBOX.debugNICOND) console.log(`NICOND: STATE 05 Tracks enable`);
      } else if (!EBOX.vmaACRef) {
        orBits |= 0o12n;                      // Normal instruction
        if (EBOX.trapReq) orBits |= 1n;       // normal instruction=TRAP
        if (EBOX.debugNICOND) console.log(`NICOND: Normal instruction`);
      } else {
        orBits |= 0o16n;                      // AC ref and not PI cycle
        if (EBOX.trapReq) orBits |= 1n;       // AC ref and not PI cycle+TRAP
        if (EBOX.debugNICOND) console.log(`NICOND: AC ref and not PI cycle`);
      }

      break;

    case CR.DISP['DRAM A RD']:// IMPLIES INH CRY18
      // 01 234 567 89A
      const a = DR.A.get();   // Dispatch on DRAM A

      // This condition matches CRA3 A .GE. 3 L
      orBits |= a >= 3n ? a : (DR.J.get() & 0o1777n);

      // If DR.A is IMMED-PF or READ-PF, prefetch next instruction.
      switch(a) {
      case DR.A['IMMED-PF']:
      case DR.A['READ-PF']:
        MBOX.startFetch();
        break;
      }

      break;

    case CR.DISP['DIAG']:
    case CR.DISP['PG FAIL']:  // PAGE FAIL TYPE DISP
    case CR.DISP['SR']:	// 16 WAYS ON STATE REGISTER
    case CR.DISP['SH0-3']:    // [337] 16 WAYS ON HIGH-ORDER BITS OF SHIFTER
    case CR.DISP['DIV']:      // FE0*4 + BR0*2 + AD CRY0; implies MQ SHIFT, AD LONG
    case CR.DISP['SIGNS']:    // ARX0*8 + AR0*4 + BR0*2 + AD0
    case CR.DISP['BYTE']:     // FPD*4 + AR12*2 + SCAD0--WRONG ON OVERFLOW FROM BIT 1!!
    case CR.DISP['NORM']:     // See normalization for details. Implies AD LONG
      break;
    }

    if (CR.CALL.get()) {
      this.stack.push(this.latchedAddr);
    }

/*
    console.log(`CRAM getAddress: \
this.latchedAddr=${octal(this.latchedAddr)} \
orBits=${octal(orBits)} \
CR.J=${octal(CR.J.get())}`);
*/

    return CR.J.get() | orBits;
  },
}) ({name: 'CRAM', nWords: 2048, bitWidth: 84n, clock: NOCLOCK});

// This simply passes CRAM current addressed word through so we can
// extract bitfields.
const CR = Combinatorial({name: 'CR', bitWidth: 84n, input: `CRAM`});

// Populate CR with properties representing CRAM bit fields. Ignore
// the unusued bits.
defineBitFields(CR, CRAMdefinitions, `U0,U21,U23,U42,U45,U48,U51,U73`.split(/,/));


// Mask for I bit in instruction word
const INDEXED_MASK = maskForBit(13);

// Mask for index register number in instruction word
const X_NONZERO_MASK = fieldMask(14, 18);

// Dispatch RAM: readonly by default
const DRAM = RAM.methods({

  // Special method to use weird DRAM addressing to get DRAM word.
  // We ignore `this.addr`.
  //
  // IR1 p. 128 shows DRAM address generation.
  // DR ADR 00-02 = IR00-02.
  // DR ADR 03-05 = INSTR 7XX ? (IR03-06 !== 0b1111 ? IR07-09<<1 :
  // 012 345 678
  getAddress() {
    const ir = IR.get();
    const op = fieldExtract(ir, 0, 8);
    let result = op;

    if ((op & 0o700n) === 0o700n) {     // IO instructions are special
      result = 0o700n | fieldExtract(ir, 7, 12);
      if ((op & 0o074n) === 0o074n) result |= 0o070n; // A03-05
    }

    return this.value = result;
  },
}) ({name: 'DRAM', nWords: 512, bitWidth: 24n, input: `ONES`, control: `ZERO`, addr: `CR.J`});

// This clock is pulsed in next cycle after IR is stable but not on
// prefetch. XXX this is not used right now.
const DR_CLOCK = Clock({name: 'DR_CLOCK'});

const DR = Reg.methods({

  // Special override to handle special cases for DRAM read/dispatch
  // logic.
  get() {
    const op = Number(IR.OP);
    const ac = Number(IR.AC);
    const indirect = Number(IR.INDIRECT);
    const x = Number(IR.X);
    let dw = DRAM.get();

    if (op === 0o254) {         // JRST
      // JRST case clears J4,J7-10 and then substitutes AC number from
      // IR for J7-10.
      dw = dw & ~0o37 | ac;
    }

    return dw;
  },
}) ({name: 'DR', bitWidth: 24n,
     // XXX not used XXX clock: DR_CLOCK,
     input: `DRAM`});
defineBitFields(DR, DRAMdefinitions);

// XXX this should probably be eliminated and replaced with explicit
// loading of CURRENT_BLOCK as a side effect of some other operation.
const LOAD_AC_BLOCKS = Clock({name: 'LOAD_AC_BLOCKS'});
const CURRENT_BLOCK = Reg({name: 'CURRENT_BLOCK', bitWidth: 3n,
                           clock: LOAD_AC_BLOCKS, input: `EBUS`});

// Instruction register. This flows from CACHE (eventually) and AD.
// This is ECL 10173 with flow through input to output while !HOLD
// (HOLD DRAM B) whose rising edge latches input.
//
// MCL VMA FETCH & CON5 MEM CYCLE ==> CON5 FETCH CYCLE H (p.162).
//
// It looks to be clearer and simpler to just latch IR.value from the
// various sources (MBOX, COND/LOAD IR) while also driving the full
// instruction into ARX. We let IR_CLOCK handle the COND/LOAD IR
// condition normally while forcing the IR.value from the external
// sources when appropriate.
const COND_LOAD_IR = CR.COND['LOAD IR'];
const IR = Reg.init(function() {
  const fields = {
    op: {s: 0, e: 8},
    ac: {s: 9, e: 12},
    indirect: {s: 13, e: 13},
    x: {s: 14, e: 17},
    y: {s: 18, e: 35},
  };

  const that = this;   // Create closure variable

  // NOTE The fields we define here have getter/setter so you can
  // directly reference them as IR members without using
  // fieldName.get().
  Object.entries(fields).forEach(([name, field]) => {
    const {s, e} = field;

    Object.defineProperty(that, name, {
      configurable: true,
      enumerable: true,
      get() {return fieldExtract(that.value, s, e)},
      set(v) {that.value = fieldInsert(that.value, v, s, e, that.bitWidth)},
    });
  });
}) ({name: 'IR', bitWidth: 36n, input: `MBOX`,
                clock: FieldMatchClock({name: 'IR_CLOCK', input: 'CR.COND',
                                        matchValue: 'COND_LOAD_IR'})});

// AC subfield of IR.
const IRAC = BitField({name: 'IRAC', s: 9, e: 12, input: `IR`});

// State Register (internal machine state during instructions)
// This is CON3 E35 p. 150.
// This is also used for PXCT bits (see PXCT/=<75:77>).
// See SR_xxx macros for more info.
const SR = Reg({name: 'SR', bitWidth: 4n, input: `CR['#']`,
                clock: FieldMatchClock({name: 'SR_CLOCK', input: 'CR.COND',
                                        matchF: cond => cond === CR.COND['SR_#']})});

// EBOX STATE (UCODE STATE) Register (internal machine state during instructions)
// This is CON4 E50 p. 161.
// * MTR4 E54 input CON UCODE STATE 01 is an OR condition for MTR PERF CNT CLOCK
// * MTR2 E40 input CON UCODE STATE 03 controls MTR CACHE CNT EN
const EBOX_STATE = Reg({name: 'EBOX_STATE', bitWidth: 4n, input: `CR['#']`,
                        clock: FieldMatchClock({name: 'EBOX_STATE_CLOCK', input: 'CR.COND',
                                                matchF: cond => cond === CR.COND['EBOX STATE']})});

const ALU10181 = StampIt.init(function({bitWidth = 36n}) {
  this.bitWidth = BigInt(bitWidth);
}).props({
  name: 'ALU10181',
}).methods({

  reset() {
    this.ONES = (1n << this.bitWidth) - 1n;
  },

  add(a, b, cin = 0n) {
    const sum = a + b + cin;
    const cout = sum > this.ONES ? 1n : 0n;
    return {value: sum & this.ONES, cout};
  },

  sub(a, b, cin = 0n) {
    const diff = a - b + cin;
    const cout = diff > this.ONES ? 1n : 0n;      // XXX Need to support diff < 0
    return {value: diff & this.ONES, cout};
  },

  // This side-effect sets this.cout for carry and returns the value.
  do(func, a, b, cin = 0n) {
    assert(typeof a === 'bigint', `a is BigInt (was ${a})`);
    assert(typeof b === 'bigint', `b is BigInt (was ${b})`);
    const ones = this.ONES;
    const NOT = x => x ^ ones;

    if (!cin) {            // Without hard knowledge of cin, get it from ADX cout
      cin = ADX.cout;
    }

    assert(typeof cin === 'bigint', `cin is BigInt (was ${cin})`);

    switch (func) {
    // ARITHMETIC
    default:
    case 0o00: return this.add(a, 0n, cin);
    case 0o01: return this.add(a, a & NOT(b), cin);
    case 0o02: return this.add(a, a & b, cin);
    case 0o03: return this.add(a, a, cin);
    case 0o04: return this.add(a | b, 0n, cin);
    case 0o05: return this.add(a | b, a & NOT(b), cin);
    case 0o06: return this.add(a, b, cin);
    case 0o07: return this.add(a, a | b, cin);
    case 0o10: return this.add(a | NOT(b), 0n, cin);
    case 0o11: return this.sub(a, b, cin ^ 1n);
    case 0o12: return this.add(a | NOT(b), a & b, cin);
    case 0o13: return this.add(a, a | NOT(b), cin);
    case 0o14: return this.add(ones, 0n, cin);
    case 0o15: return this.sub(a & NOT(b), 1n, cin);
    case 0o16: return this.sub(a & b, 1n, cin);
    case 0o17: return this.sub(a, 1n, cin);

    // BOOLEAN
    case 0o20: return BOOL(!cin ? NOT(a) : a);
    case 0o21: return BOOL(!cin ? NOT(a) | NOT(b) : this.add(a, a & NOT(b)));
    case 0o22: return BOOL(!cin ? NOT(a) | b : this.add(a, a & b));
    case 0o23: return BOOL(!cin ? ones : this.add(a, a));
    case 0o24: return BOOL(!cin ? NOT(a | b) : a & b);
    case 0o25: return BOOL(!cin ? NOT(b) : this.add(a & NOT(b), a | b));
    case 0o26: return BOOL(!cin ? NOT(a ^ b) : this.add(a, b));
    case 0o27: return BOOL(!cin ? a | NOT(b) : this.add(a, a | b));
    case 0o30: return BOOL(!cin ? NOT(a) & b : a | NOT(b));
    case 0o31: return BOOL(!cin ? a ^ b : this.sub(a, b, 1n));
    case 0o32: return BOOL(!cin ? b : this.add(a | NOT(b), a & b));
    case 0o33: return BOOL(!cin ? a | b : this.add(a, a | NOT(b)));
    case 0o34: return BOOL(!cin ? 0n : ones);
    case 0o35: return BOOL(!cin ? a & NOT(b) : this.sub(a & NOT(b), 1n));
    case 0o36: return BOOL(!cin ? a & b : this.sub(a & b, 1n));
    case 0o37: return BOOL(!cin ? a : this.sub(a, 1n));
    }


    function BOOL(v) {
      const value = typeof v === 'object' ? v.value : v;
      return {value, cout: 0n};
    }
  },
});


// Takes THREE inputs: A, B, and carry-in.
const DataPathALU = LogicUnit.init(function({bitWidth}) {
  this.alu = ALU10181({bitWidth});

  this.getCarry = Combinatorial
    .init(function({parentALU}) {
      this.parentALU = parentALU;
    }).methods({
      getInputs() { return this.parentALU.cout },
    }) ({name: this.name + '.getCarry', bitWidth: 1n, parentALU: this});
}).methods({

  reset() {
    this.cout = 0n;
    this.ones = (1n << this.bitWidth) - 1n;
    this.alu.reset();
  },

  do(aluFunction, a, b, cin = 0n) {
    const {value, cout} = this.alu.do(aluFunction, a, b, cin);
    this.cout = cout;
    return value;
  },

  get() {
    assert(this.inputs, `${this.name}.inputs not null`);
    assert(this.inputs[0], `${this.name}.inputs[0] not null`);
    assert(this.inputs[1], `${this.name}.inputs[1] not null`);
    const func = this.getFunc();
    const f = Number(func) & 0o37;
    const a = this.inputs[0].get();
    assert(typeof a === 'bigint', `${this.name} A is BigInt`);
    const b = this.inputs[1].get();
    assert(typeof b === 'bigint', `${this.name} B is BigInt`);

/*
    console.log(`\
${this.name} \
a=${octW(a)}(${this.inputs[0].name}) \
b=${octW(b)}(${this.inputs[1].name})`);
*/

    const allOnes = this.alu.ONES;
    const NOT = v => v ^ allOnes;
    const bw = this.bitWidth;
    const unsigned = x => a & allOnes;

    // If 0o40 mask is lit, force cin.
    const cin = (func & 0o40n) ? 1n : this.inputs[2].get();

    // XXX CIN is affected by p. 364 E7/E8/E19 grid A4-5.
    // When that isn't true, CIN is ADX COUT.
    //
    // Also note that SPEC/XCRY AR0 means AD XORed with AR00
    //
    // Also note the schematic symbols XXX CRY 36 mean the carry INTO
    // the LSB of the adder for XXX (i.e., from a bit to the right).
    return this.do(f, a, b, cin) & allOnes;
  },
});

// XXX cin needs to be correctly defined.
const ADX = DataPathALU.compose({name: 'ADX'}).methods({

  // XXX this needs an implementation
  getCRY_02() { return 0n },

}) ({name: 'ADX', bitWidth: 36n, inputs: `[ADXA, ADXB, ZERO]`, func: `CR.AD`});

// XXX Need to implement APR3 FM EXTENDED/APR FM 36 bit from p. 384 lower left corner.
const FM = RAM.props({
  curBlock: 0n,
  alu: ALU10181({bitWidth: 4n}),
}).methods({

  // XXX this needs more ACB possibilities.
  // XXX this needs to support AC-OP<75:79> ALU operations.
  // XXX FM block number (CURRENT and PREV) are complex. See p. 386.
  //     0,1,4,5,6: APR5 CURRENT BLOCK
  //     2: APR5 XR BLOCK
  //     3: APR5 VMA BLOCK
  //     6: APR5 CURRENT BLOCK
  //     7: CRAM #<02:04>
  // APR5 CURRENT/PREV BLOCK loaded from EBUS<06:11> by CON LOAD AC BLOCKS.
  // APR5 VMA BLOCK loaded from mux(MCL4 VMA PREV EN)[APR5 CURRENT BLOCK,APR5 PREV BLOCK]
  //      when MCL4 LOAD VMA CONTEXT.
  //
  // APR FM ADR bits from p. 385.
  getAddress() {
    const ac = IRAC.get();
    const blkShifted = this.curBlock << 4n;
    const op = CR.FMADR.get();
    
    switch(op) {
    default:
    case CR.FMADR.AC0:
    case CR.FMADR.AC1:
    case CR.FMADR.AC2:
    case CR.FMADR.AC3:
      return blkShifted | (ac + op) & 15n;

    case CR.FMADR.XR:
      return blkShifted | ARX_14_17.get();

    case CR.FMADR.VMA:
      return blkShifted | VMA_32_35.get();

    case CR.FMADR['AC+#']:
      const magic = MAGIC_NUMBER.get();
      const aluOp = magic >> 4n;
      return blkShifted | this.alu(aluOp, ac, magic & 15n, 0n);

    case CR.FMADR['#B#']:
      return MAGIC_NUMBER.get() & 0o177n;
    }
  },
}) ({name: 'FM', nWords: 8*16, bitWidth: 36n,
     input: `AR`,
     control: FieldMatcher({name: 'FM_WRITE', input: `CR.COND`, matchValue: `CR.COND['FM WRITE']`})});


// Note many DISP field values affect carry and LONG:
//
// DISP/=<67:71>D,10	;0-7 AND 30-37 ARE DISPATCHES (CRA1&CRA2)
// 	DIAG=0
// 	DRAM J=1
//** 	DRAM A RD=2	;IMPLIES INH CRY18
// 	RETURN=3	;POPJ return--may not coexist with CALL
// 	PG FAIL=4	;PAGE FAIL TYPE DISP
// 	SR=5		;16 WAYS ON STATE REGISTER
// 	NICOND=6	;NEXT INSTRUCTION CONDITION (see NEXT for detail)
// 	SH0-3=7,,1	;[337] 16 WAYS ON HIGH-ORDER BITS OF SHIFTER
//** 	MUL=30		;FE0*4 + MQ34*2 + MQ35; implies MQ SHIFT, AD LONG
//** 	DIV=31,,1	;FE0*4 + BR0*2 + AD CRY0; implies MQ SHIFT, AD LONG
// 	SIGNS=32,1	;ARX0*8 + AR0*4 + BR0*2 + AD0
// 	DRAM B=33	;8 WAYS ON DRAM B FIELD
// 	BYTE=34,,1	;FPD*4 + AR12*2 + SCAD0--WRONG ON OVERFLOW FROM BIT 1!!
//** 	NORM=35,2	;See normalization for details. Implies AD LONG
//**? 	EA MOD=36	;(ARX0 or -LONG EN)*8 + -(LONG EN and ARX1)*4 +
// 			;ARX13*2 + (ARX2-5) or (ARX14-17) non zero; enable
// 			;is (ARX0 or -LONG EN) for second case.  If ARX18
// 			;is 0, clear AR left; otherwise, poke ARL select
// 			;to set bit 2 (usually gates AD left into ARL)
// XXX cin needs to be correctly defined.
const AD = DataPathALU({name: 'AD', bitWidth: 38n, inputs: `[ADA, ADB, ZERO]`, func: `CR.AD`});
const AD_13_17 = BitField({name: 'AD_13_17', s: 13, e: 17, input: `AD`});
const AD_13_35 = BitField({name: 'AD_13_35', s: 13, e: 35, input: `AD`});

// This does not use the canonical EBOXUnit `control` or `func` inputs
// since it has very complex decoding of VMA/xxx and COND/xxx values
// to determine its operation.
const VMA = Reg.methods({

  sampleInputs() {
    // XXX this needs to implement the load/inc/dec/hold. It is
    // probably going to have to take the Addr+Data Paths VMA
    // architecture completely into account. The good news is
    // that the logic to do some of this is part of SCD TRAP
    // MIX.
    //
    // From inspecting schematics (VMA starts on p. 354), VMA
    // only holds the full PC including section. Flags come from
    // elsewhere.
    //
    // It is pretty clear I need a completely new data path
    // diagram for VMA based on M8542 which replaces the M8523 -
    // outdated for KL10-PV model B but is shown on p. 137.

    // Note the data path diagram shows these values inverted
    // because in schematics they are active low. These are
    // right.
    // VMA/=<52:53>D,0	;ALSO CONTROLLED BY SPECIAL FUNCTIONS
    // 	VMA=0		;BY DEFAULT
    // 	PC=1		;MAY BE OVERRIDDEN BY MCL LOGIC	TO LOAD FROM AD
    // 	LOAD=1		; IF WE KNOW IT WILL BE OVERRIDDEN, USE THIS
    // 	PC+1=2
    // 	AD=3		;ENTIRE VMA, INCLUDING SECTION
    //
    // COND/=<60:65>D,0
    //     VMA_#=30
    //     VMA_#+TRAP=31
    //     VMA_#+MODE=32
    //     VMA_#+AR32-35=33
    //     VMA_#+PI*2=34
    //     VMA DEC=35	;VMA_VMA-1
    //     VMA INC=36	;VMA_VMA+1

    switch (CR.COND.get()) {
    case CR['VMA_#']:
    case CR['VMA_#+TRAP']:
    case CR['VMA_#+MODE']:
    case CR['VMA_#+AR32-35']:
    case CR['VMA_#+PI*2']:
      break;

    case CR['VMA DEC']:
    case CR['VMA INC']:
      break;
    }

    const pc = PC.get();

    // VMA
    switch (CR.VMA.get()) {
    case CR.VMA.VMA:      // VMA (noop)
      break;
    case CR.VMA.PC:       // PC or LOAD
    case CR.VMA.LOAD:     // PC or LOAD
      // XXX to do: MAY BE OVERRIDDEN BY MCL LOGIC TO LOAD FROM AD
      this.toLatch = pc;
      break;
    case CR.VMA['PC+1']:  // PC+1
      this.toLatch = this.joinHalves(this.getLH(), pc + 1n);
      break;
    case CR.VMA.AD:       // AD (ENTIRE VMA, INCLUDING SECTION)
      this.toLatch = AD.get();
      break;
    }
  },
}) ({name: 'VMA', bitWidth: 35n - 13n + 1n, input: `ONES`});

const VMA_32_35 = BitField({name: 'VMA_32_35', s: 32, e: 35,
                            input: `VMA`});
const VMA_HELD = Reg({name: 'VMA HELD', bitWidth: 35n - 13n + 1n,
                      input: `VMA`});
const VMA_PREV_SECT = Reg({name: 'VMA PREV SECT', bitWidth: 17n - 13n + 1n,
                           input: `AD_13_17`});
const VMA_PREV_SECT_13_17 = BitField({name: 'VMA_PREV_SECT_13_17', s: 13, e: 17,
                                      input: `VMA_PREV_SECT`});
// XXX VERY temporary input
const VMA_FLAGS = Reg({name: 'VMA_FLAGS', bitWidth: 13n,
                       input: `ZERO`});

const VMA_PLUS_FLAGS = BitCombiner({name: 'VMA_PLUS_FLAGS', bitWidth: 36n,
                                    inputs: `[VMA_FLAGS, VMA_HELD]`});

const VMA_HELD_OR_PC = Mux.methods({
  getInputs() { return BigInt(+this.getControl()) },
}) ({name: 'VMA HELD OR PC', bitWidth: 36n, inputs: '[PC, VMA_HELD]',
     control: FieldMatcher({name: 'VMA_HELD_OR_PC_CONTROL', input: 'CR.COND',
                            matchValue: CR.COND['VMA HELD']})});

const PC = Reg.methods({

  // XXX p. 139 says PC loaded automatically from VMA at NICOND.
  // XXX see Figure 2-63 PC Loading or Inhibit on p. 140 for details.

  // Allow SPEC/LOAD PC to override our normal load from VMA.
  getInputs() {
    const input = SPECis('LOAD PC') ? AR : VMA;
    return input.get();
  },
}) ({name: 'PC', bitWidth: 35n - 13n + 1n, input: `VMA`});

const PC_13_17 = BitField({name: 'PC_13_17', s: 13, e: 17,
                           input: `PC`});
const PC_PLUS_FLAGS = BitCombiner({name: 'PC_PLUS_FLAGS', bitWidth: 36n,
                                   inputs: `[SCD_FLAGS, PC]`});

const DIAG_FUNC = CR['DIAG FUNC'];
const DATAO_APR = CR['DIAG FUNC']['DATAO APR'];
const COND_DIAG_FUNC = CR.COND['DIAG FUNC'];
const ADR_BREAK_matchF = (cur => cur === COND_DIAG_FUNC && DIAG_FUNC.get() === DATAO_APR);
const ADR_BREAK_CLOCK = FieldMatchClock({name: 'ADR_BREAK_CLOCK',
                                         input: DIAG_FUNC,
                                         matchF: ADR_BREAK_matchF, matchValue: DATAO_APR});
const ADR_BREAK = Reg({name: 'ADR BREAK', bitWidth: 35n - 13n + 1n,
                       input: `AD_13_35`,
                       clock: ADR_BREAK_CLOCK});

const MQ = Reg.methods({

  getInputs() {
    let result = this.value;

    // From MP00301_KL10PV_Jun80 p. 365 (CTL2)
    const mqmEnable = CR.MQ.get();
    const mqCtlV = CR['MQ CTL'].get();

    const x = mqmEnable << 2n | mqCtlV;
    result = this.inputs[x].get();

    // Some of the cases yield > 36 bits and need trimming.
    return this.value = result &= ONES.value;
  },
}) ({name: 'MQ', bitWidth: 36n, inputs: `[MQ, MQx2, MQ, ZERO, SH, MQdiv4, ONES, AD]`});

const MQx2 = ShiftMult({name: 'MQx2', shift: 1, bitWidth: 36n, input: `MQ`, loBits: `ADX`});
const MQdiv4 = ShiftDiv({name: 'MQdiv4', shift: 2, bitWidth: 36n, input: `MQ`, hiBits: `ADX`});


// POSSIBLY MISSING REGISTERS:
// Stuff from M8539 module in upper-left corner of p. 137:
// MCL, CURRENT BLOCK, PREV BLOCK

////////////////////////////////////////////////////////////////
// BitField splitters used by various muxes and logic elements.
const AR_00_08 = BitField({name: 'AR_00_08', s: 0, e: 8, input: `AR`});
const AR_EXP = BitField({name: 'AR_EXP', s: 1, e: 8, input: `AR`});
const AR_SIZE = BitField({name: 'AR_SIZE', s: 6, e: 11, input: `AR`});
const AR_POS = BitField({name: 'AR_POS', s: 0, e: 5, input: `AR`});
// XXX needs AR18 to determine direction of shift
const AR_SHIFT = BitField({name: 'AR_SHIFT', s: 28, e: 35, input: `AR`});
const AR_00_12 = BitField({name: 'AR_00_12', s: 0, e: 12, input: `AR`});

////////////////////////////////////////////////////////////////
// Logic units.
const BRx2 = ShiftMult({name: 'BRx2', shift: 1, bitWidth: 36n, input: 'BR', loBits: `ARX`});
const ARx4 = ShiftMult({name: 'ARx4', shift: 2, bitWidth: 36n, input: 'AR', loBits: `ARX`});
const BRXx2 = ShiftMult({name: 'BRXx2', shift: 1, bitWidth: 36n, input: 'BRX', loBits: `MQ`});
const ARXx4 = ShiftMult({name: 'ARXx4', shift: 2, bitWidth: 36n, input: 'ARX', loBits: `MQ`});

// SCAD CONTROL
// 0    A
// 1    A-B-1
// 2    A+B
// 3    A-1
// 4    A+1
// 5    A-B
// 6    A|B
// 7    A&B
// XXX no implementation yet.
const SCAD = LogicUnit.init(function({bitWidth}) {
  this.alu = ALU10181({bitWidth});
}).methods({

  reset() {
    this.ones = (1n << this.bitWidth) - 1n;
    this.alu.reset();
  },

  getInputs() {
    const func = Number(this.getFunc());
    const a = this.inputs[0].get();
    const b = this.inputs[1].get();
    let result;

    switch(func) {
    default:
    case CR.SCAD.A:        result = a;                                   break;
    case CR.SCAD['A-B-1']: result = this.alu.do(0o11n, a, b);            break;
    case CR.SCAD['A+B']:   result = this.alu.do(0o06n, a, b);            break;
    case CR.SCAD['A-1']:   result = this.alu.do(0o17n, a, b);            break;
    case CR.SCAD['A+1']:   result = this.alu.do(0o00n, a, b, 1n);        break;
    case CR.SCAD['A-B']:   result = this.alu.do(0o11n, a, b, 1n);        break;
    case CR.SCAD.OR:       result = this.alu.do(0o04n, a, b);            break;
    case CR.SCAD.AND:      result = this.alu.do(0o16n, a, b, 1n);        break;
    }

    assert(typeof result === 'bigint',
           `SCAD.getInputs() func=${func.toString(8)} return non-Bigint`);
    return result;
  },
}) ({name: 'SCAD', bitWidth: 10n, inputs: `[SCADA, SCADB, ZERO]`, func: `CR.SCAD`});


const FEcontrol = LogicUnit.compose({name: 'FEcontrol'})
      .methods({

        // This takes the two CR fields we depend on for our
        // control function and returns
        // 0: LOAD
        // 1: SHIFT RIGHT
        // 2: SHIFT LEFT
        // 3: HOLD
        getInputs() {
          let result;

          if (CR.FE.get())
            result = 0;
          else if (CONDis('FE SHRT'))
            result = 1;
          else
            result = 3;

          return result;
        },

      }) ({name: 'FEcontrol', bitWidth: 2n});

const FE = ShiftReg({name: 'FE', bitWidth: 10n, input: `SCAD`, control: `FEcontrol`,
                     clock: FieldMatchClock({name: 'FE_CLOCK',
                                             input: 'CR.FE', matchValue: CR.FE.SCAD})});
const SH = Reg.methods({

  getInputs() {
    const count = SC.get();
    const func = this.getControl();
    let result;

    switch (func) {
    default:
    case 0n:
      const arx0 = ARX.get();
      const src0 = (AR.get() << 36n) | arx0;
      result = (count < 0 || count > 35) ? arx0 : src0 << count;
      break;

    case 1n:
      result = AR.get();
      break;

    case 2n:
      result = ARX.get();
      break;

    case 3n:
      const src3 = AR.get();
      result = (src3 >> 18n) | (src3 << 18n);
      break;
    }

    return result;
  },
}) ({name: 'SH', bitWidth: 36n, inputs: `[AR, ARX]`, control: `CR.SH`});


////////////////////////////////////////////////////////////////
// Muxes
const ADA = Mux({name: 'ADA', bitWidth: 36n,
                 inputs: `[AR, ARX, MQ, PC, ZERO, ZERO, ZERO, ZERO]`,
                 // Note three bit field
                 control: `CR.ADA`});
const ADB = Mux({name: 'ADB', bitWidth: 36n,
                 inputs: `[FM, BRx2, BR, ARx4]`,
                 control: `CR.ADB`});
const ADXA = Mux({name: 'ADXA', bitWidth: 36n,
                  inputs: `[ARX, ARX, ARX, ARX, ZERO, ZERO, ZERO]`,
                  control: `CR.ADA`});
const ADXB = Mux({name: 'ADXB', bitWidth: 36n,
                  inputs: `[ZERO, BRXx2, BRX, ARXx4]`,
                  control: `CR.ADB`});

const ARSIGN_SMEAR = LogicUnit.methods({
  getInputs() { return BigInt(+!!(AR.get() & maskForBit(0, 9))) },
}) ({name: 'ARSIGN_SMEAR', bitWidth: 9n});

const SCAD_EXP = BitField({name: 'SCAD_EXP', s: 0, e: 8, input: `SCAD`});
const SCAD_POS = BitField({name: 'SCAD_POS', s: 0, e: 5, input: `SCAD`});

const MAGIC_NUMBER = CR['#'];

const ARMML = Mux({name: 'ARMML', bitWidth: 9n,
                   inputs: `[MAGIC_NUMBER, ARSIGN_SMEAR, SCAD_EXP, SCAD_POS]`,
                   control: `CR.ARMM`});

const ARMMR = Mux.methods({
  getInputs() { return VMAXis('PREV SEC') },
}) ({name: 'ARMMR', bitWidth: 17n - 13n + 1n,
     inputs: `[PC_13_17, VMA_PREV_SECT_13_17]`,
     control: `CR.VMAX`});

const ADx2 = ShiftMult({name: 'ADx2', shift: 1, bitWidth: 36n, input: 'AD', loBits: 'ADX'});
const ADXx2 = ShiftMult({name: 'ADXx2', shift: 1, bitWidth: 36n, input: 'ADX', loBits: 'MQ'});

const ADdiv4 = ShiftDiv({name: 'ADdiv4', shift: 2, bitWidth: 36n, input: 'AD', hiBits: `ZERO`});
const ADXdiv4 = ShiftDiv({name: 'ADXdiv4', shift: 2, bitWidth: 36n, input: 'ADX', hiBits: 'AD'});

const SERIAL_NUMBER = ConstantUnit.methods({
  reset() { this.value = BigInt(EBOX.serialNumber) },
}) ({name: 'SERIAL_NUMBER', value: 0n, bitWidth: 18n});
module.exports.SERIAL_NUMBER = SERIAL_NUMBER;

// XXX very temporary. Needs implementation.
const EBUS = ZERO;

// XXX this is still very wrong.
// * Needs to take ARMM special function into account.
// * Needs to take CLR<77:80> into account.
// * Needs to support loading of AR0-8 only.
// This probably should be rewritten to separate AR0-8 into a Unit by itself.
const ARML = Mux.methods({

  // This supplies the logic to control the ARL input mux ARML.
  // CTL2 ARL IND SEL 1,2,4 are p.365 E39 lower left.
  // XXX CR.ARL only controls this if ARL_IND() returns true
  //     (see ARL<81:83> comments and CTL2).
  getControl() {
    return ARL_IND() ? CR.ARL.get() : CR.AR.get();
  },
}) ({name: 'ARML', bitWidth: 18n,
     inputs: `[ARMML, CACHE, AD, EBUS, SH, ADx2, ADX, ADdiv4]`});

// ARL_IND is defined in MEM/, SPEC/, and COND/ and they are ORed
// together in E31 in middle of p.365.
function ARL_IND() {
  return CONDis('ARL IND') || SPECis('ARL IND') || MEMis('ARL IND');
}

// XXX this is enabled by COND/REG CTL (CTL2)
const AR_CTL = CR['AR CTL'];
const ARMR = Mux({name: 'ARMR', bitWidth: 18n,
                  inputs: `[AR, CACHE, AD, EBUS, SH, ADx2, ADX, ADdiv4]`,
                  control: `CR.AR`});
const ARR_LOADmask = AR_CTL['ARR LOAD'];

// XXX each field of AR has a corresponding CLR. See p. 15 E52 OR gate.
// CTL ARR LOAD = CTL1 REG CTL # 02 & (
//                CRAM ARM SEL 4 | CTL ARR SEL 2 | CTL ARR SEL 1 |
//                CTL ARR CLR | CTL2 COND/ARR LOAD)
const ARR = Reg({name: 'ARR', bitWidth: 18n, input: `ARMR`,
                 clock: FieldMatchClock({name: 'ARR_CLOCK', input: `AR_CTL`,
                                         matchF: cur => (cur & ARR_LOADmask ||
                                                         CR.AR !== CR.AR.AR)})});
const ARL_LOADmask = AR_CTL['ARL LOAD'];

// XXX each field of AR has a corresponding CLR. See p. 15 E52 OR gate.
// CTL AR 00-08 LOAD = CTL2 COND/ARLL LOAD | CTL1 REG CTL # 00 | (CTL2 ARL IND & CRAM # 01) |
//                     CTL AR 00-11 CLR | CTL ARL SEL 4,2,1
const AR00_08 = Reg({name: 'AR00_08', bitWidth: 9n, input: `ARML`,
                     clock: FieldMatchClock({name: 'ARL_CLOCK', input: `AR_CTL`,
                                             matchF: cur => (cur & ARL_LOADmask || ARL_IND())})});
// XXX each field of AR has a corresponding CLR. See p. 15 E52 OR gate.
// CTL AR 09-17 LOAD = CTL2 COND/ARLR LOAD | CTL1 REG CTL # 01 | 
//                     CTL AR 00-11 CLR | CTL ARL SEL 4,2,1
const AR09_17 = Reg({name: 'AR09_17', bitWidth: 9n, input: `ARML`,
                     clock: FieldMatchClock({name: 'ARL_CLOCK', input: `AR_CTL`,
                                             matchF: cur => (cur & ARL_LOADmask || ARL_IND())})});

const ARXM = Mux({name: 'ARXM', bitWidth: 36n,
                  inputs: `[ARX, CACHE, AD, MQ, SH, ADXx2, ADX, ADXdiv4]`,
                  control: `CR.ARX`});
const ARX = Reg({name: 'ARX', bitWidth: 36n, input: `ARXM`});
const ARX_14_17 = BitField({name: 'ARX_14_17', s: 14, e: 17, input: `ARX`});

// XXX needs to implement AR/ARMM, SPEC/REG CTL as a special getInputs() method.
const AR = BitCombiner({name: 'AR', bitWidth: 36n, inputs: `[AR00_08, AR09_17, ARR]`});

const BR = Reg({name: 'BR', bitWidth: 36n, input: `AR`,
                clock: FieldMatchClock({name: 'BR_CLOCK',
                                        input: `CR.BR`, matchValue: CR.BR.AR})});
const BRX = Reg({name: 'BRX', bitWidth: 36n, input: `ARX`,
                 clock: FieldMatchClock({name: 'BRX_CLOCK',
                                         input: `CR.BRX`, matchValue: CR.BRX.ARX})});

const SC = Reg.methods({

  getInputs() {
    const isSCM_ALT = SPECis('SCM ALT');
    const SCM_ALT = CR['SCM ALT'];
    const SPEC = CR.SPEC.get();
    let result;

    // Our complex operations are selected by SC/ and SPEC/SCM ALT
    if (CR.SC.get() === 0n) {      // Either recirculate or FE
      result = isSCM_ALT ? FE.get() : this.value;
    } else {

      if (isSCM_ALT) {
        const ar = AR.get();
        const ar18filled = ((ar >> 18n) & 1n) ? 0o777777000000n : 0n;
        result = ar18filled | ar & 0o377n; // smear(AR18),,ar28-35
      } else {
        result = SCAD.get();
      }
    }

    return result;
  },
}) ({name: 'SC', bitWidth: 10n, inputs: `[SC, FE, AR, SCAD]`});

const SCADA = Mux({name: 'SCADA', bitWidth: 10n,
                   // SCADA/= includes SCADA EN/= as its MSB.
                   inputs: `[FE, AR_POS, AR_EXP, MAGIC_NUMBER, ZERO, ZERO, ZERO, ZERO]`,
                   control: `CR.SCADA`});
const SCADB = Mux({name: 'SCADB', bitWidth: 10n,
                   inputs: `[FE, AR_SIZE, AR_00_08, MAGIC_NUMBER]`,
                   control: `CR.SCADB`});

const SCD_FLAGS = Reg({name: 'SCD_FLAGS', bitWidth: 13n,
                       input: 'AR_00_12',
                       clock: FieldMatchClock({name: 'SET_FLAGS',
                                               input: 'CR.SPEC',
                                               matchF: (spec => spec === CR.SPEC['FLAG CTL'] &&
                                                        fieldIs('FLAG CTL', 'SET FLAGS'))})});


////////////////////////////////////////////////////////////////
// System memory.
//
// The `control` input is the EBOX request type, directly accessed out
// of the CR.MEM field.
const MBOX = RAM.props({
  writeCycle: false,
}).methods({

  isWrite() {
    return this.writeCycle;
  },

  startFetch() {
    if (EBOX.fetchCycle) return;
    console.log(`================ MBOX fetchCycle start from ${octW(this.getAddress())}`);
    EBOX.fetchCycle = true;   // Start a memory cycle
  },

  get() {
    const op = this.getControl(); // MEM/op
    const addr = this.getAddress();
    let result = 0n;

    switch(op) {
    default:
    case CR.MEM['NOP']:		// DEFAULT
      break;

    case CR.MEM['ARL IND']:	// CONTROL AR LEFT MUX FROM # FIELD
    case CR.MEM['RESTORE VMA']:	// AD FUNC WITHOUT GENERATING A REQUEST
    case CR.MEM['A RD']:	// OPERAND READ and load PXCT bits
    case CR.MEM['REG FUNC']:	// MBOX REGISTER FUNCTIONS
    case CR.MEM['AD FUNC']:	// FUNCTION LOADED FROM AD LEFT
    case CR.MEM['EA CALC']:	// FUNCTION DECODED FROM # FIELD
    case CR.MEM['LOAD AR']:
    case CR.MEM['LOAD ARX']:
      break;

    case CR.MEM['B WRITE']:	// CONDITIONAL WRITE ON DRAM B 01

      if (DR.B.get() & 2n) {
        console.log(`================ DRAM B MBOX writeCycle start`);
        this.writeCycle = true;
      }

      break;

    case CR.MEM['RW']:		// READ, TEST WRITABILITY
    case CR.MEM['RPW']:		// READ-PAUSE-WRITE
    case CR.MEM['WRITE']:	// FROM AR TO MEMORY
      console.log(`================ MBOX writeCycle start`);
      this.writeCycle = true;
      break;

    case CR.MEM['MB WAIT']:	// WAIT FOR MBOX RESP IF PENDING
      result = this.data[addr];

      if (EBOX.fetchCycle) {
        IR.value = result;      // XXX HACK?
        ARX.value = result;     // XXX HACK?
        console.log(`\
MBOX op=${octal(op)} addr=${octW(addr)} \
result=${octW(result)} loaded into IR and ARX`);
      }
      
      console.log(`\
================ MBOX \
${EBOX.fetchCycle ? 'FETCH' : 'non-FETCH'} cycle end \
${octW(addr)}=${octW(result)}`);
      EBOX.fetchCycle = false;  // Wait is over.
      EBOX.memCycle = false;
      this.writeCycle = false;
      break;

    case CR.MEM['IFET']:	// UNCONDITIONAL instruction FETCH
    case CR.MEM['FETCH']:	// LOAD NEXT INSTR TO ARX (CONTROL BY #)
      this.startFetch();
      result = 0n;
      break;
    }

    return result;
  },
}) ({name: 'MBOX', nWords: 4 * 1024 * 1024, bitWidth: 36n, 
     input: 'MBUS', addr: 'VMA', control: 'CR.MEM'});

// Use MBOX as input here to force MBOX to issue a `get()` each cycle
// since its decoding drives the IR/ARX latching of instructions.
const MBUS = Reg({name: 'MBUS', bitWidth: 36n, input: 'MBOX'});

// XXX very temporary. Needs implementation.
const CACHE = MBUS;


// Simplify grabbing a CR field object (for retrieving properties
// defining constant values) and the value of the CR field.
function getCRFieldAndValue(fieldName) {
  return [CR[fieldName], CR[fieldName].get()];
}


// Parse a sequence of microcode field definitions (see define.mic for
// examples) and return BitField stamps for each of the fields. Pass
// an array of field names to ignore (for CRAM unused fields). This
// uses Object.defineProperty() `set` handler to allow things like
// `CR.AD = CR.AD['A+B']` where `CR.AD['A+B']` is a constant to select
// the adder A+B function and assigning to `CR.AD` is meant to set the
// `AD` field of the `CR` microcode word to that selector value.
function defineBitFields(input, s, ignoreFields = []) {
  let curField = undefined;

  return s.split(/\n/).forEach(line => {
    const m = line.match(/^(?<fieldName>[^\/;]+)\/=<(?<ss>\d+):(?<es>\d+)>.*/);

    // Define a subfield of `input`, but only if it is not an unused CRAM field
    if (m) {
      const {fieldName, ss, es} = m.groups;

      if (fieldName && !ignoreFields.includes(fieldName)) {
        const s = parseInt(ss);
        const e = parseInt(es);
        const bitWidth = BigInt(e - s + 1);
        const bfName = `${input.name}['${fieldName}']`;
        const inputClosure = input;   // Create closure variable
        curField = BitField({name: bfName, s, e, input: inputClosure, bitWidth});
        const thisField = curField; // Create closure variable for getter

        Object.defineProperty(input, fieldName, {
          configurable: true,
          enumerable: true,
          get() {return thisField},
          set(v) {input.value = fieldInsert(input.value, v, s, e, input.bitWidth)},
        });
      }
    } else {                    // Define a constant name for this subfield
      const m = line.match(/^\s+(?<defName>[^=;]+)=(?<value>\d+).*/);

      if (m) {
        const {defName, value} = m.groups;

        if (defName) {

          if (curField) {
            curField[defName] = BigInt(parseInt(value, 8));
          } else {
            console.error(`ERROR: no field context for value definition in "${line}"`);
          }
        } else {
          // Ignore lines that do not match either regexp.
        }
      }
    }
  });
}

// Export every EBOXUnit
module.exports = Object.assign(module.exports, Named.units);
