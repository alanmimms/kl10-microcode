'use strict';
const _ = require('lodash');
const util = require('util');
const StampIt = require('@stamp/it');

const {
  octal, oct6, octW,
  maskForBit, shiftForBit,
  fieldInsert, fieldExtract, fieldMask,
  wrapMethod, unwrapMethod,
} = require('./util');

// Read our defines.mic and gobble definitions for fields and
// constants for CRAM and DRAM.
const {CRAMdefinitions, DRAMdefinitions} = require('./read-defs');


// EBOX notes:
//
// M8539 APR module is replaced by M8545 in KL10 model B.
// M8523 VMA module is replaced by M8542 in KL10 model B.


// Name our instances for debugging and display. Every single Named
// unit is remembered in the Named.units object.
const Named = StampIt({name: 'Named'}).statics({
  units: {},                    // Dictionary of all Named instances
}).init(function({name}, {stamp}) {
  this.name = name;
  this.stamp = stamp;
  this.propName = this.name.replace(/[ .,]/g, '_');
  Named.units[this.propName] = this;
}).methods({
  reset() { },
});
module.exports.Named = Named;


// Each Clock has a list of units it drives. Calling the `latch()`
// function on a Clock calls `latch()` on each driven unit.
const Clock = Named.init(function({drives = []}) {
  this.drives = drives;
  this.wrappableMethods = ['cycle'];
}).methods({
  addUnit(unit) { this.drives.push(unit) },
  cycle() { this.drives.forEach(unit => unit.latch()) },
});
module.exports.Clock = Clock;


// Used for non-clocked objects like ZERO and ONES
const NOCLOCK = Clock({name: 'NOCLOCK'});

// The EBOX-wide clock.
const EBOXClock = Clock({name: 'EBOXClock'});


////////////////////////////////////////////////////////////////
//
// Stolen from p. 212 Figure 3-5 Loading IR Via FM (COND/LOAD IR)
// and p. 214 Figure 3-7 NICOND Dispatch and Waiting.
//
// _ |_____________________| _____________________ |_
//  \/  micro instruction1 \/  micro instruction2 \/   CR
// _/\_____________________/\_____________________/\_
//   |                     |                       |
//   |_________            | __________            |_
//   /         \           |/          \           /    EBOX CLOCK
// _/|          \__________/            \_________/|
//   |                     |                       |
//   |           __________|             _________ |
//   |          /          \            /         \|    EBOX SYNC
// ____________/           |\__________/           \_
//   |                     |                       |
// __|_____________________|                       |
//   |                     \                       |    NICOND DISP
//   |                     |\______________________|_
//   |                     |                       |
//   |                     | _____________________ |
//   |                     |/                     \|    CON LOAD DRAM
// __|_____________________/                       \_
//   |                     |                       |
//   |                     | __________            |_
//   |                     |/  LATCHED \ UNLATCHED /    DR
// __|_____________________/            \_________/| 
//   |                     |                       |
//   |                     | _____________________ |
//   |         UNLATCHED   |/  LATCHED            \|    IR
// __|_____________________/                       \_
//   |                     |                       |
//   |_____________________|                       |
//   /                     \                       |    COND/LOAD IR
// _/|                     |\______________________|_
//   |                     |                       |
//   |_____________________| _____________________ |_
//   /                     \/                     \/    AD/A
// _/|                     |\_____________________/\_
//   |                     |                       |
//   |_____________________| _____________________ |_
//   /                     \/                     \/    ADA/AR
// _/|                     |\_____________________/\_
//   |                     |                       |
//   |_________            | ______________________|_
//   /         \ UNLATCHED |/ LATCHED              |    HOLD IR
// _/|          \__________/                       |
//   |                     |                       |
//   |      _______________|                       |
//   |     /////           \                       |    IR MIXER IN
// __|____/////            |\ _____________________|_
//   |                     |                       |
//   |                     |
//   |                     +-- instruction loads into ARX
//   |                     | 
//   |                     +-- `latch()` copies `getInputs()` to `value`
//   +
//

////////////////////////////////////////////////////////////////
// Stamps

// Base Stamp for EBOX functional units. This is an abstract Stamp
// defining protocol but all should be completely overridden.
//
// The convention is that each EBOXUnit has a `getInputs()` method
// that retrieves the unit's value based on its current inputs and
// configuration. EBOXUnit uses `getInputs()` method to retrieve
// inputs to save what would be saved on the latching clock edge.
//
// There is also a `get()` method to retrieve the current _output_ of
// the Unit.
//
// Combinatorial (not clocked) logic units will simply implement
// `get()` as directly returning the value from `getInputs()`. Since
// these are not clocked, they implement a no-op for `latch()`.
// Registered and RAMs (clocked) will return the currently addressed
// or latched value in `get()` while using `getInputs()` to determine
// what value to latch and, in the case of RAMs, what address. The act
// of latching is done through a call to the `latch()` method.
//
// * `getInputs()` and `getControl()` and `getAddress()` retrieve the
//   inputs to the unit from the units that drive their input pins.
//
// * `latch()` uses `getInputs()` and `getAddress()` to latch a
//   register or RAM's value and is a no-op for combinatorial units.
//
// * `get()` returns currently latched value or direct value from
//   `getInputs()` for combinatorial units.
const EBOXUnit = Named.compose({name: 'EBOXUnit'}).init(
  function({name, bitWidth, inputs, addr, func, control, clock = EBOXClock}) {
    this.name = name;
    this.clock = clock;
    this.inputs = inputs;
    this.funcInput = func;
    this.controlInput = control;
    this.addrInput = addr;
    this.bitWidth = typeof bitWidth === 'undefined' ? bitWidth : BigInt(bitWidth);
    this.wrappableMethods = `\
reset,getAddress,getAddr,getFunc,getControl,getInputs,getInput,get,latch,cycle
`.trim().split(/,\s*/);
    clock.addUnit(this);
  }).props({
    value: 0n,
  }).methods({

    reset() {
      this.value = 0n;
      this.bitWidth = BigInt(this.bitWidth || 1n);
      this.ones = (1n << this.bitWidth) - 1n;
    },

    // Some commonly used default methods for RAM, LogicUnit, Mux, etc.
    getAddress() { return this.addrInput.get() },
    getFunc() { return this.funcInput.get() },
    getControl() { return this.controlInput.get() },
    getInputs() {
      if (typeof this.inputs.get !== typeof (() => 0)) debugger;
      return this.inputs.get() & this.ones;
    },
    getLH(v = this.value) { return BigInt.asUintN(18, v >> 18n) },
    getRH(v = this.value) { return BigInt.asUintN(18, v) },
    joinHalves(lh, rh) { return (BigInt.asUintN(18, lh) << 18n) | BigInt.asUintN(18, rh) },
  });
module.exports.EBOXUnit = EBOXUnit;


////////////////////////////////////////////////////////////////
// The EBOX.
const EBOX = StampIt.compose(Named, {
}).init(function ({serialNumber}) {
  this.serialNumber = serialNumber;
  this.microInstructionsExecuted = 0n;
  this.executionTime = 0;
}).props({
  unitArray: [],      // List of all EBOX Units as an array of objects
  clock: EBOXClock,
  run: false,
}).methods({

  reset() {
    this.resetActive = true;
    this.ucodeRun = false;
    this.run = false;
    this.unitArray = Object.values(Named.units).concat([this]);

    // Reset every Unit back to initial value.
    this.unitArray.filter(unit => unit !== this).forEach(unit => unit.reset());

    // RESET always generates several clocks with zero CRAM and DRAM.
    _.range(4).forEach(k => this.cycle());

    this.resetActive = false;
    this.wrappableMethods = ['cycle'];
  },

  cycle() {
    this.clock.cycle();
    ++this.microInstructionsExecuted;
  },
  
}) ({name: 'EBOX', serialNumber: 0o6543n});
module.exports.EBOX = EBOX;


// Use this mixin to define a Combinatorial unit that is unclocked.
const Combinatorial = EBOXUnit.compose({name: 'Combinatorial'}).methods({
  latch() { },
  get() { return this.value = this.getInputs() & this.ones },
});


// Use this mixin to define a Clocked unit.
const Clocked = EBOXUnit.compose({name: 'Clocked'}).methods({
  latch() { return this.value = this.getInputs() & this.ones },
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
    this.wordWidth = Number(this.inputs.bitWidth);
    this.shift = shiftForBit(this.e, this.inputs.bitWidth);
    this.ones = (1n << this.bitWidth) - 1n;
  },

  getInputs() {
    const v = this.inputs.get();
    const shifted = BigInt.asUintN(this.wordWidth + 1, v) >> BigInt(this.shift);
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
        this.value = value >= 0n ? value : BigInt.asUintN(Number(bitWidth), value);
      }).methods({
        getInputs() {return this.value},
        get() {return this.value},
        reset() {},
        latch() {},
      });
module.exports.ConstantUnit = ConstantUnit;

const ZERO = ConstantUnit({name: 'ZERO', bitWidth: 36n, value: 0n});
const ONES = ConstantUnit({name: 'ONES', bitWidth: 36n, value: (1n << 36n) - 1n});
module.exports.ZERO = ZERO;
module.exports.ONES = ONES;


////////////////////////////////////////////////////////////////
// Take a group of inputs and concatenate them into a single wide
// field.
const BitCombiner = Combinatorial.compose({name: 'BitCombiner'}).methods({

  getInputs() {
    const combined = this.inputs.reduce((v, i) => (v << i.bitWidth) | i.get(), 0n);
    return this.value = combined & this.ones;
  },
});
module.exports.BitCombiner = BitCombiner;


////////////////////////////////////////////////////////////////
// Given an address, retrieve the stored word. Can also store new
// words for diagnostic purposes. Elements are BigInt by default. The
// one element in `inputs` is the unit that provides a value for calls
// to `latch()` or write data. A ZERO VALUE on `control` means the
// clock cycle is a WRITE, otherwise it is a read.
const RAM = Clocked.compose({name: 'RAM'}).init(function({nWords, initValue = 0n}) {
  this.nWords = nWords;
  this.initValue = initValue;
}).methods({

  reset() {

    if (this.bitWidth <= 64 && this.initValue === 0n) {
      this.data = new BigUint64Array(this.nWords);
    } else {
      this.data = _.range(Number(this.nWords)).map(x => this.initValue);
    }

    this.value = this.initValue;
    this.ones = (1n << this.bitWidth) - 1n;
  },

  latch() {
    this.addr = this.getAddress();
    const isWrite = !this.getControl(); // Active-low /WRITE control

    if (isWrite) {
      this.value = this.get();
      this.data[this.addr] = this.value;
    } else {
      this.value = this.data[this.addr];
    }

    return this.value;
  },
});
module.exports.RAM = RAM;


// Use this for example as a `control` for a RAM (e.g., FM) to write
// when `COND/FM WRITE` with:
//      inputs: 'CR.COND', matchValue: "CR.COND['FM WRITE']"
const FieldMatcher = Combinatorial.compose({name: 'FieldMatcher'})
      .init(function({bitWidth = 1n,
                      matchValue,
                      matchF = (cur => BigInt(cur === this.matchValue))}) {
        this.matchValue = eval(matchValue); // Should be static
        this.matchF = matchF;
        this.bitWidth = bitWidth;
      }).methods({

        getInputs() {
          const cur = this.inputs.get();
          return this.value = this.matchF(cur) & this.ones;
        },
      });

// Use this for example as a `control` for a RAM to write when
// `COND/FM WRITE` with {inputs: 'CR.COND', matchValue: "CR.COND['FM WRITE']"}.
const FieldMatchClock = Clock.compose({name: 'FieldMatchClock'})
      .init(function({inputs, matchValue = 0n, matchF}) {
        this.inputs = inputs;
        this.matchValue = eval(matchValue); // MUST BE STATIC to use this
        this.matchF = matchF || (cur => BigInt(cur === this.matchValue));
        EBOXClock.addUnit(this);
      }).methods({

        latch() {
          const cur = this.inputs.get();
          this.value = this.matchF(cur);

          if (this.value) {
            this.drives.forEach(unit => unit.latch());
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
    return this.enableF() ? input.get() & this.ones : 0n;
  },
});
module.exports.Mux = Mux;


////////////////////////////////////////////////////////////////
// Latch inputs for later retrieval.
const Reg = Clocked.compose({name: 'Reg'});
module.exports.Reg = Reg;


////////////////////////////////////////////////////////////////
// Latch inputs or shift or hold. Equivalent to ECL 10141.
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
      }).methods({

        get() {
          const inp = this.inputs.get();
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
      }).methods({

        getInputs() {
          const hiBits = this.hiBits.get() << (this.hiBits.bitWidth - this.shift);
          return ((this.inputs.get() | hiBits) >> this.shift) & this.ones;
        },
      });
module.exports.ShiftDiv = ShiftDiv;


////////////////////////////////////////////////////////////////
// RAMs
const CRAM = RAM({name: 'CRAM', nWords: 2048, bitWidth: 84n});
const CR = Reg({name: 'CR', bitWidth: 84n});
const excludeCRAMfields = `U0,U21,U23,U42,U45,U48,U51,U73`.split(/,/);
defineBitFields(CR, CRAMdefinitions, excludeCRAMfields);


// Complex CRAM address calculation logic goes here...
const CRADR = Clocked.init(function({stackDepth = 4}) {
  this.stackDepth = stackDepth;
}).methods({

  reset() {
    this.value = 0n;
    this.force1777 = false;
    this.stack = [];
    this.ones = (1n << this.bitWidth) - 1n;
  },

  getInputs() {
    const prevValue = this.value;                 // Save in case of CALL

    if (this.force1777) {
      this.force1777 = false;

      // Push return address from page fault handler.
      this.stack.push(this.value);
    } else {
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
        orBits = DR.B.get();
        break;

      case CR.DISP['EA MOD']:	// (ARX0 or -LONG EN)*8 + -(LONG EN and ARX1)*4 +
                                // ARX13*2 + (ARX2-5) or (ARX14-17) non zero; enable
                                // is (ARX0 or -LONG EN) for second case.  If ARX18
                                // is 0, clear AR left; otherwise, poke ARL select
                                // to set bit 2 (usually gates AD left into ARL)
        break;

      case CR.DISP['NICOND']:   // NEXT INSTRUCTION CONDITION (see NEXT for detail)

        if (EBOX.piCyclePending) {
          break;                          // orBits |= 0;
        } else if (!EBOX.run) {
          orBits |= 0o02n;
          break;
        } else if (EBOX.mtrIntReq) {
          orBits |= 0o04n;
          break;
        } else if (EBOX.intReq) {
          orBits |= 0o06n;
          break;
        } else if (EBOX.ucodeState05) {
          orBits |= 0o10n;
          if (EBOX.trapReq) orBits |= 1n; // This is from klx NICOND comments
          break;
        } else if (EBOX.vmaACRef) {
          orBits |= 0o12n;
          if (EBOX.trapReq) orBits |= 1n; // This is from klx NICOND comments
          break;
        } else {
          orBits |= 0o16n;                // Nothing pending
          if (EBOX.trapReq) orBits |= 1n; // This is from klx NICOND comments
          break;
        }

        break;

      case CR.DISP['DIAG']:
      case CR.DISP['DRAM A RD']:// IMPLIES INH CRY18
      case CR.DISP['PG FAIL']:  // PAGE FAIL TYPE DISP
      case CR.DISP['SR']:	// 16 WAYS ON STATE REGISTER
      case CR.DISP['SH0-3']:    // [337] 16 WAYS ON HIGH-ORDER BITS OF SHIFTER
      case CR.DISP['DIV']:      // FE0*4 + BR0*2 + AD CRY0; implies MQ SHIFT, AD LONG
      case CR.DISP['SIGNS']:    // ARX0*8 + AR0*4 + BR0*2 + AD0
      case CR.DISP['BYTE']:     // FPD*4 + AR12*2 + SCAD0--WRONG ON OVERFLOW FROM BIT 1!!
      case CR.DISP['NORM']:     // See normalization for details. Implies AD LONG
        break;

      }

      this.value = orBits | CR.J.get();

      if (CR.CALL.get()) {
        this.stack.push(prevValue);
      }

      return this.value;
    }
  },
}) ({name: 'CRADR', bitWidth: 11n});

// This clock is pulsed in next cycle after IR is stable but not on
// prefetch.
const DR_CLOCK = Clock({name: 'DR_CLOCK'});

// Complex DRAM address calculation logic goes here...
const DRADR = ConstantUnit.methods({

  // From EK-EBOX--all-OCR p. 19: Figure 1-4 illustrates the
  // organization of the DRAM. By sharing portions of the DRAM between
  // even/odd instruction, the shared pieces become half the
  // nonshared. Therefore, the A, B, and J7-10 portions consist of 10
  // X 512 words and the P, J4, J1-3 portions consist of 5 X 256
  // words. This saves essentially 5 X 256 words of DRAMstorage. In
  // addition, for JRST DRAM COMMON, bit 4 is made zero and DRAM J7-10
  // is replaced by IR 9-12, again yielding a savings. Here the
  // savings is 5 X 16 words of DRAMstorage. The areas allocated by
  // the DRAMare indicated in Figure 1-3.
  getInputs() {
    const addrWidth = 11;
    //     +----OP----+-AC-+
    // IR: 0 123 456 789 abc
    const ir = IR.get();
    const op = ir >> 4n;
    const ac = IRAC.get();
    let a = op;
    
    // 012 345 678
    if (op === 0o254n) {                  // JRST
      // Replace DRADR4-10 with IRAC
      a = fieldInsert(a, ac, 4, 10, addrWidth);
    } else if ((op & 0o774n) === 0o700n) { // I/O instruction to internal dev
      // DRADR3-5 = 7 (x on Fig 1-4 p. 19)
      a = fieldInsert(a, 7, 3, 5, addrWidth);
      // DRADR6-8 = IR10-12
      a = fieldInsert(a, fieldExtract(ir, 10, 12, IR.bitWidth), 6, 8, addrWidth);
    } else if ((op & 0o700n) === 0o700n) { // I/O instruction to external dev
      // DRADR3-5,6-8 = IR7-9,10-12 (x on Fig 1-4 p. 19)
      a = fieldInsert(a, fieldExtract(ir, 7, 12, IR.bitWidth), 3, 8, addrWidth);
    }

    return a;
  },
}) ({name: 'DRADR', bitWidth: 9n});

const DRAM = RAM({name: 'DRAM', nWords: 512, bitWidth: 24n});
const DR = Reg.methods({name: 'DR', bitWidth: 24n, clock: DR_CLOCK});
defineBitFields(DR, DRAMdefinitions);


const LOAD_AC_BLOCKS = Clock({name: 'LOAD_AC_BLOCKS'});
const CURRENT_BLOCK = Reg({name: 'CURRENT_BLOCK', bitWidth: 3n, clock: LOAD_AC_BLOCKS});

const ARX_14_17 = BitField({name: 'ARX_14_17', s: 14, e: 17});
const VMA_32_35 = BitField({name: 'VMA_32_35', s: 32, e: 35});


// This clock is pulsed when an instruction is on AD, ready for IR to
// latch it for decoding and execution.
const IR_CLOCK = Clock({name: 'IR_CLOCK'});

// Instruction register. This flows from CACHE (eventually) and AD.
// This is ECL 10173 with flow through input to output while !HOLD
// (HOLD DRAM B) whose rising edge latches inputs.
const IR = Reg.methods({

  latch() {
    if (this.getControl()) this.value = this.getInputs();
    return this.value;
  },
}) ({name: 'IR', bitWidth: 12n, clock: IR_CLOCK,
     control: FieldMatcher({name: 'IR_WRITE', inputs: 'CR.COND',
                            matchValue: CR.COND['LOAD IR']})});


// AC subfield of IR.
const IRAC = BitField({name: 'IRAC', s: 9, e: 12});


// State Register (internal machine state during instructions)
const SR = Reg({name: 'SR', bitWidth: 4n,
                clock: FieldMatchClock({name: 'SR_CLOCK', inputs: CR.COND,
                                        matchValue: CR.COND['SR_#']})});

const FM_ADR = LogicUnit.methods({
  
  getInputs() {
    let acr;
    
    switch(CR.FMADR.get()) {
    default:
    case CR.FMADR.AC0:
      acr = IRAC.get(); break;
    case CR.FMADR.AC1:
      acr = (IRAC.get() + 1n) & 15n; break;
    case CR.FMADR.AC2:
      acr = (IRAC.get() + 2n) & 15n; break;
    case CR.FMADR.AC3:
      acr = (IRAC.get() + 3n) & 15n; break;
    case CR.FMADR.XR:
      acr = ARX_14_17.get(); break;
    case CR.FMADR.VMA:
      acr = VMA_32_35.get(); break;
    case CR.FMADR['AC+#']:
      acr = (IRAC.get() + MAGIC_NUMBER.get()) & 15n; break;
    case CR.FMADR['#B#']:
      // THIS NEEDS TO BE MAGIC_NUMBER<4:0> defining 10181 function (LSB is BOOLE).
      acr = MAGIC_NUMBER.get() & 15n; break;
    }

    return acr;
  },
}) ({name: 'FM_ADR', bitWidth: 4n});

const FMA = BitCombiner({name: 'FMA', bitWidth: 7n});
const FM = RAM({name: 'FM', nWords: 8*16, bitWidth: 36n});


const ALU10181 = StampIt.init(function({bitWidth = 36n}) {
  this.bitWidth = bitWidth = BigInt(bitWidth);
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
    const ones = this.ONES;
    const NOT = x => x ^ ones;

    if (!cin) {            // Without hard knowledge of cin, get it from ARX cout
      const ARXresult = ARX.get();
      cin = ARX.cout;
    }

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
    case 0o20: return BOOL(cin ? NOT(a) : a);
    case 0o21: return BOOL(cin ? NOT(a) | NOT(b) : this.add(a, a & NOT(b)));
    case 0o22: return BOOL(cin ? NOT(a) | b : this.add(a, a & b));
    case 0o23: return BOOL(cin ? 1n : this.add(a, a));
    case 0o24: return BOOL(cin ? a & b : a | b);
    case 0o25: return BOOL(cin ? NOT(b) : this.add(a & NOT(b), a | b));
    case 0o26: return BOOL(cin ? NOT(a ^ b) : this.add(a, b));
    case 0o27: return BOOL(cin ? a | NOT(b) : this.add(a, a | b));
    case 0o30: return BOOL(cin ? NOT(a) & b : a | NOT(b));
    case 0o31: return BOOL(cin ? a ^ b : this.sub(a, b, 1n));
    case 0o32: return BOOL(cin ? b : this.add(a | NOT(b), a & b));
    case 0o33: return BOOL(cin ? a | b : this.add(a, a | NOT(b)));
    case 0o34: return BOOL(cin ? 0n : ones);
    case 0o35: return BOOL(cin ? a & NOT(b) : this.sub(a & NOT(b), 1n));
    case 0o36: return BOOL(cin ? a & b : this.sub(a & b, 1n));
    case 0o37: return BOOL(cin ? a : this.sub(a, 1n));
    }


    function BOOL(v) {
      const value = typeof v === 'object' ? v.value : v;
      return {value, cout: 0n};
    }
  },
});


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
    const func = this.getFunc();
    const f = Number(func) & 0o37;
    const a = this.inputs[0].get();
    const b = this.inputs[1].get();

    const allOnes = this.alu.ONES;
    const NOT = v => v ^ allOnes;
    const bw = this.bitWidth;
    const unsigned = x => BigInt.asUintN(bw, a);

    // If 0o40 mask is lit, force cin.
    const cin = (func & 0o40n) ? 1n : this.inputs[2].get();

    // XXX CIN is affected by p. 364 E7/E8/E19 grid A4-5.
    // When that isn't true, CIN is ADX COUT.
    //
    // Also note that SPEC/XCRY AR0 means AD XORed with AR00
    //
    // Also note the schematic symbols XXX CRY 36 mean the carry INTO
    // the LSB of the adder for XXX (i.e., from a bit to the right).
    let result = 0n;

    result = this.do(f, a, b, cin);
    console.log(`${this.name} f=${f.toString(8)} func=${func.toString(8)} result=${result}`);
    return result & allOnes;
  },
});

const ADX = DataPathALU.compose({name: 'ADX'}).methods({

  // XXX this needs an implementation
  getCRY_02() { return 0n },

}) ({name: 'ADX', bitWidth: 36n});


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
const AD = DataPathALU({name: 'AD', bitWidth: 38n});


// This does not use the canonical EBOXUnit `control` or `func` inputs
// since it has very complex decoding of VMA/xxx and COND/xxx values
// to determine its operation.
const VMA = Reg.compose({name: 'VMA'})
      .methods({

        latch() {
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

          // VMA
          switch (CR.VMA.get()) {
          case 0:                     // VMA (noop)
            break;
          case 1:                     // PC or LOAD
            // XXX to do: MAY BE OVERRIDDEN BY MCL LOGIC TO LOAD FROM AD
            this.value = PC.value;
            break;
          case 2:                     // PC+1
            this.value = this.joinHalves(this.getLH(), PC.value + 1n);
            break;
          case 3:                     // AD (ENTIRE VMA, INCLUDING SECTION)
            this.value = AD.value;
            break;
          }

          return this.value;
        },
      }) ({name: 'VMA', bitWidth: BigInt(35 - 13 + 1)});

const PC = Reg({name: 'PC', bitWidth: BigInt(35 - 13 + 1)});

const AD_13_35 = BitField({name: 'AD_13_35', s: 13, e: 35});

const DATAO_APR = CR['DIAG FUNC']['DATAO APR'];
const DIAG_FUNC = CR.COND['DIAG FUNC'];
const ADR_BREAK_matchF = cur => cur === DIAG_FUNC && CR['DIAG FUNC'] === DATAO_APR;
const ADR_BREAK = Reg({name: 'ADR BREAK', bitWidth: BigInt(35 - 13 + 1),
                       clock: FieldMatchClock({name: 'ADR_BREAK_CLOCK',
                                               inputs: CR['DIAG FUNC'],
                                               matchF: ADR_BREAK_matchF,
                                               matchValue: DATAO_APR})});

const VMA_HELD = Reg({name: 'VMA HELD', bitWidth: BigInt(35 - 13 + 1)});

const AD_13_17 = BitField({name: 'AD_13_17', s: 13, e: 17});
const VMA_PREV_SECT = Reg({name: 'VMA PREV SECT', bitWidth: BigInt(17 - 13 + 1)});

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
}) ({name: 'MQ', bitWidth: 36n});


const MQx2 = ShiftMult({name: 'MQx2', shift: 1, bitWidth: 36n});
const MQdiv4 = ShiftDiv({name: 'MQdiv4', shift: 2, bitWidth: 36n});


// POSSIBLY MISSING REGISTERS:
// Stuff from M8539 module in upper-left corner of p. 137:
// MCL, CURRENT BLOCK, PREV BLOCK

////////////////////////////////////////////////////////////////
// BitField splitters used by various muxes and logic elements.
const AR_00_08 = BitField({name: 'AR_00_08', s: 0, e: 8});
const AR_EXP = BitField({name: 'AR_EXP', s: 1, e: 8});
const AR_SIZE = BitField({name: 'AR_SIZE', s: 6, e: 11});
const AR_POS = BitField({name: 'AR_POS', s: 0, e: 5});
// XXX needs AR18 to determine direction of shift
const AR_SHIFT = BitField({name: 'AR_SHIFT', s: 28, e: 35});
const AR_00_12 = BitField({name: 'AR_00_12', s: 0, e: 12});

////////////////////////////////////////////////////////////////
// Logic units.
const BRx2 = ShiftMult({name: 'BRx2', shift: 1, bitWidth: 36n});
const ARx4 = ShiftMult({name: 'ARx4', shift: 2, bitWidth: 36n});
const BRXx2 = ShiftMult({name: 'BRXx2', shift: 1, bitWidth: 36n});
const ARXx4 = ShiftMult({name: 'ARXx4', shift: 2, bitWidth: 36n});


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
    case CR.SCAD.A:        result = this.alu.do(0o00n, a, b);            break;
    case CR.SCAD['A-B-1']: result = this.alu.do(0o11n, a, b);            break;
    case CR.SCAD['A+B']:   result = this.alu.do(0o06n, a, b);            break;
    case CR.SCAD['A-1']:   result = this.alu.do(0o17n, a, b);            break;
    case CR.SCAD['A+1']:   result = this.alu.do(0o00n, a, b, 1n);        break;
    case CR.SCAD['A-B']:   result = this.alu.do(0o11n, a, b, 1n);        break;
    case CR.SCAD.OR:       result = this.alu.do(0o04n, a, b);            break;
    case CR.SCAD.AND:      result = this.alu.do(0o16n, a, b, 1n);        break;
    }

    return result;
  },
}) ({name: 'SCAD', bitWidth: 10n});

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

const FE = ShiftReg({name: 'FE', bitWidth: 10n,
                     clock: FieldMatchClock({name: 'FE_CLOCK',
                                             inputs: CR.FE, matchValue: CR.FE.SCAD})});
const SH = Reg.methods({

  getInputs() {
    const count = SC.get();
    const func = this.getControl();
    let result;

    switch (func) {
    default:
    case 0:
      const arx0 = ARX.get();
      const src0 = (AR.get() << 36n) | arx0;
      result = (count < 0 || count > 35) ? arx0 : src0 << count;
      break;

    case 1:
      result = AR.get();
      break;

    case 2:
      result = ARX.get();
      break;

    case 3:
      const src3 = AR.get();
      result = (src3 >> 18) | (src3 << 18);
      break;
    }

    return result;
  },
}) ({name: 'SH', bitWidth: 36n});


////////////////////////////////////////////////////////////////
// Muxes
const ADA = Mux({name: 'ADA', bitWidth: 36n});
const ADB = Mux({name: 'ADB', bitWidth: 36n});
const ADXA = Mux({name: 'ADXA', bitWidth: 36n});
const ADXB = Mux({name: 'ADXB', bitWidth: 36n});

const ARSIGN_SMEAR = LogicUnit.methods({
  getInputs() { return BigInt(+!!(AR.get() & maskForBit(0, 9))) },
}) ({name: 'ARSIGN_SMEAR', bitWidth: 9n});

const SCAD_EXP = BitField({name: 'SCAD_EXP', s: 0, e: 8});
const SCAD_POS = BitField({name: 'SCAD_POS', s: 0, e: 5});
const PC_13_17 = BitField({name: 'PC_13_17', s: 13, e: 17});
const VMA_PREV_SECT_13_17 = BitField({name: 'VMA_PREV_SECT_13_17', s: 13, e: 17});

const MAGIC_NUMBER = BitCombiner({name: 'MAGIC_NUMBER', bitWidth: 9n, inputs: [CR['#']]});

const ARMML = Mux({name: 'ARMML', bitWidth: 9n});

const ARMMR = Mux.methods({
  getInputs() { return VMAXis('PREV SEC') },
}) ({name: 'ARMMR', bitWidth: BigInt(17 - 13 + 1)});


const ADx2 = ShiftMult({name: 'ADx2', shift: 1, bitWidth: 36n});
const ADdiv4 = ShiftDiv({name: 'ADdiv4', shift: 2, bitWidth: 36n});
const ADXx2 = ShiftMult({name: 'ADXx2', shift: 1, bitWidth: 36n});
const ADXdiv4 = ShiftDiv({name: 'ADXdiv4', shift: 2, bitWidth: 36n});

const SERIAL_NUMBER = ConstantUnit.methods({
  reset() { this.value = BigInt(EBOX.serialNumber) },
}) ({name: 'SERIAL_NUMBER', value: 0n, bitWidth: 18n});
module.exports.SERIAL_NUMBER = SERIAL_NUMBER;

// XXX very temporary. Needs implementation.
const EBUS = ZERO;

// XXX very temporary. Needs implementation.
const CACHE = ZERO;

// XXX This is wrong in many cases
const ARML = Mux({name: 'ARML', bitWidth: 18n});

const ARMR = Mux({name: 'ARMR', bitWidth: 18n});

const ARL_LOADmask = CR['AR CTL']['ARL LOAD'];
const ARL = Reg({name: 'ARL', bitWidth: 18n,
                 clock: FieldMatchClock({name: 'ARL_CLOCK', inputs: CR['AR CTL'],
                                         matchF: cur => !!(cur & ARL_LOADmask)})});

const ARR_LOADmask = CR['AR CTL']['ARR LOAD'];
const ARR = Reg({name: 'ARR', bitWidth: 18n,
                 clock: FieldMatchClock({name: 'ARR_CLOCK', inputs: CR['AR CTL'],
                                         matchF: cur => !!(cur & ARR_LOADmask)})});

const ARXM = Mux({name: 'ARXM', bitWidth: 36n});
const ARX = Reg({name: 'ARX', bitWidth: 36n});

const AR = BitCombiner({name: 'AR', bitWidth: 36n});
const BR = Reg({name: 'BR', bitWidth: 36n,
                clock: FieldMatchClock({name: 'BR_CLOCK',
                                        inputs: CR.BR, matchValue: CR.BR.AR})});
const BRX = Reg({name: 'BRX', bitWidth: 36n,
                 clock: FieldMatchClock({name: 'BRX_CLOCK',
                                         inputs: CR.BRX, matchValue: CR.BRX.ARX})});

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
}) ({name: 'SC', bitWidth: 10n});


const SCADA = Mux({name: 'SCADA', bitWidth: 10n});
const SCADB = Mux({name: 'SCADB', bitWidth: 10n});

const SCD_FLAGS = Reg({name: 'SCD_FLAGS', bitWidth: 13n});
const VMA_FLAGS = Reg({name: 'VMA_FLAGS', bitWidth: 13n});
const PC_PLUS_FLAGS = BitCombiner({name: 'PC_PLUS_FLAGS', bitWidth: 36n});
const VMA_PLUS_FLAGS = BitCombiner({name: 'VMA_PLUS_FLAGS', bitWidth: 36n});

const VMA_HELD_OR_PC = Mux.methods({
  getInputs() { return BigInt(+this.getControl()) },
}) ({name: 'VMA HELD OR PC', bitWidth: 36n,
     control: FieldMatcher({name: 'VMA_HELD_OR_PC_CONTROL', inputs: 'CR.COND',
                            matchValue: CR.COND['VMA HELD']})});


////////////////////////////////////////////////////////////////
// System memory.
//
// The `control` input is the EBOX request type, directly accessed out
// of the CR.MEM field.
const MBOX = RAM.methods({

  get() {
    const op = this.getControl(); // MEM/op
    let result = 0n;

    switch(op) {
    default:
    case CR.MEM['NOP']:		// DEFAULT
    case CR.MEM['ARL IND']:	// CONTROL AR LEFT MUX FROM # FIELD
    case CR.MEM['MB WAIT']:	// WAIT FOR MBOX RESP IF PENDING
    case CR.MEM['RESTORE VMA']:	// AD FUNC WITHOUT GENERATING A REQUEST
    case CR.MEM['A RD']:	// OPERAND READ and load PXCT bits
    case CR.MEM['B WRITE']:	// CONDITIONAL WRITE ON DRAM B 01
    case CR.MEM['REG FUNC']:	// MBOX REGISTER FUNCTIONS
    case CR.MEM['AD FUNC']:	// FUNCTION LOADED FROM AD LEFT
    case CR.MEM['EA CALC']:	// FUNCTION DECODED FROM # FIELD
    case CR.MEM['LOAD AR']:
    case CR.MEM['LOAD ARX']:
    case CR.MEM['RW']:		// READ, TEST WRITABILITY
    case CR.MEM['RPW']:		// READ-PAUSE-WRITE
    case CR.MEM['WRITE']:	// FROM AR TO MEMORY
      break;

    case CR.MEM['IFET']:	// UNCONDITIONAL instruction FETCH
      result = this.data[this.getAddress()];
      break;

    case CR.MEM['FETCH']:	// LOAD NEXT INSTR TO ARX (CONTROL BY #)
      break;
    }

    return result;
  },
}) ({name: 'MBOX', nWords: 4 * 1024 * 1024, bitWidth: 36n});

const MBUS = Reg({name: 'MBUS', bitWidth: 36n});


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
        const inputs = input;   // Create closure variable
        curField = BitField({name: bfName, s, e, inputs, bitWidth});
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
            console.log(`ERROR: no field context for value definition in "${line}"`);
          }
        } else {
          // Ignore lines that do not match either regexp.
        }
      }
    }
  });
}

////////////////////////////////////////////////////////////////
// Handy utility functions

// For each XXXXis(name) function, return 1n iff XXXX/${name} is true.
const SPECis = matcherFactory('SPEC');
const CONDis = matcherFactory('COND');
const VMAXis = matcherFactory('VMAX');


// Return 1n iff CR[fieldName] has value of the constant
// fieldValueName defined for that field.
function fieldIs(fieldName, fieldValueName) {
  return BigInt(CR[fieldName].get() === CR[fieldName][fieldValueName]);
}


// Returns a matcher function to match CR field `fieldName` against
// its constant value named by the function parameter.
function matcherFactory(fieldName) {
  return name => BigInt(CR[fieldName].get() === CR[fieldName][name]);
}


////////////////////////////////////////////////////////////////
// Wire up an EBOX block diagram.
CRAM.addrInput = CRADR;
CRAM.controlInput = ONES;       // Readonly by default
CR.inputs = CRAM;

DRAM.addrInput = DRADR;
DRAM.controlInput = ONES;       // Readonly by default
DR.inputs = DRAM;

CURRENT_BLOCK.inputs = EBUS;

IR.inputs = AD;
IRAC.inputs = IR;
SR.inputs = CR['#'];

FM_ADR.inputs = [IRAC, ARX, VMA, MAGIC_NUMBER];
FMA.inputs = [CR.ACB, FM_ADR];
FM.addrInput = FMA;
FM.inputs = AR;
FM.controlInput = FieldMatcher({name: 'FM_WRITE', inputs: CR.COND,
                                matchValue: CR.COND['FM WRITE']});

// XXX cin needs to be correctly defined.
AD.inputs = [ADA, ADB, ZERO];
AD.funcInput = CR.AD;
AD_13_35.inputs = AD;
AD_13_17.inputs = AD;

PC.inputs = VMA;
PC.controlInput = FieldMatcher({name: 'LOAD_PC', inputs: CR.SPEC,
                                matchValue: CR.SPEC['LOAD PC']});
PC_13_17.inputs = PC;
//VMA.inputs = [CR['#'], ];
VMA_32_35.inputs = VMA;
ADR_BREAK.inputs = AD_13_35;
VMA_HELD.inputs = VMA;
VMA_PREV_SECT.inputs = AD_13_17;
VMA_PREV_SECT_13_17.inputs = VMA_PREV_SECT;

MQ.inputs = [MQ, MQx2, MQ, ZERO, SH, MQdiv4, ONES, AD];
MQdiv4.hiBits = ADX;
MQx2.inputs = MQ;
MQx2.loBits = ADX;

ADA.inputs = [AR, ARX, MQ, PC, ZERO, ZERO, ZERO, ZERO];
ADA.controlInput = CR.ADA;      // Note three bit field

ADB.inputs = [FM, BRx2, BR, ARx4];
ADB.controlInput = CR.ADB;

// XXX cin (ADXCRY36) needs to be correctly defined.
ADX.inputs = [ADXA, ADXB, ZERO];
ADX.funcInput = CR.AD;

ADXA.inputs = [ARX, ARX, ARX, ARX, ZERO, ZERO, ZERO];
ADXA.controlInput = CR.ADA;

ADXB.inputs = [ZERO, BRXx2, BRX, ARXx4];
ADXB.controlInput = CR.ADB;

ARMML.inputs = [MAGIC_NUMBER, ARSIGN_SMEAR, SCAD_EXP, SCAD_POS];
ARMML.controlInput = CR.ARMM;

ARMMR.inputs = [PC_13_17, VMA_PREV_SECT_13_17];
ARMMR.controlInput = CR.VMAX;

ARMR.inputs = [ARMMR, CACHE, AD, EBUS, SH, ADx2, ADdiv4];
ARMR.controlInput = CR.AR;

ARML.inputs = [ARMML, CACHE, AD, EBUS, SH, ADx2, ADX, ADdiv4];
ARML.controlInput = CR.AR;

ARL.inputs = ARML;
ARR.inputs = ARMR;

ARX.inputs = ARXM;
ARX_14_17.inputs = ARX;

ARXM.inputs = [ARX, CACHE, AD, MQ, SH, ADXx2, ADX, ADXdiv4];
ARXM.controlInput = CR.ARX;

AR.inputs = [ARL, ARR];
AR_00_08.inputs = AR;
AR_EXP.inputs = AR;
AR_SIZE.inputs = AR;
AR_POS.inputs = AR;
AR_SHIFT.inputs = AR;
AR_00_12.inputs = AR;

// XXX TODO: BR is clocked by CRAM BR LOAD?
BR.inputs = AR;

// XXX TODO: BRX is clocked by CRAM BRX LOAD?
BRX.inputs = ARX;

FE.inputs = SCAD;
FE.controlInput = FEcontrol;

SH.inputs = [AR, ARX];
SH.controlInput = CR.SH;

SCAD.inputs = [SCADA, SCADB, ZERO];
SCAD.funcInput = CR.SCAD;
SCAD_EXP.inputs = SCAD;
SCAD_POS.inputs = SCAD;
SC.inputs = [SC, FE, AR, SCAD];

// SCADA/= includes SCADA EN/= as its MSB.
SCADA.inputs = [FE, AR_POS, AR_EXP, MAGIC_NUMBER, ZERO, ZERO, ZERO, ZERO];
SCADA.controlInput = CR.SCADA;

SCADB.inputs = [FE, AR_SIZE, AR_00_08, MAGIC_NUMBER];
SCADB.controlInput = CR.SCADB;

ADx2.inputs = AD;
ADx2.loBits = ADX;

ADdiv4.inputs = AD;

BRx2.inputs = BR;
BRx2.loBits = BRX;

ARx4.inputs = AR;
ARx4.loBits = ARX;

BRXx2.inputs = BRX;
BRXx2.loBits = ZERO;

ADXx2.inputs = ADX;
ADXx2.loBits = MQ;

ADXdiv4.inputs = ADX;
ADXdiv4.hiBits = AD;

ARXx4.inputs = ARX;
ARXx4.inputs = ZERO;

SCD_FLAGS.inputs = AR_00_12;
SCD_FLAGS.clock = FieldMatchClock({name: 'SET_FLAGS',
                                   inputs: CR.SPEC,
                                   matchF: spec => BigInt(spec === CR.SPEC['FLAG CTL'] &&
                                                          fieldIs('FLAG CTL', 'SET FLAGS'))});

VMA_FLAGS.inputs = ZERO;        // XXX VERY temporary
PC_PLUS_FLAGS.inputs = [SCD_FLAGS, PC];
VMA_PLUS_FLAGS.inputs = [VMA_FLAGS, VMA_HELD];
VMA_HELD_OR_PC.inputs = [PC, VMA_HELD];
VMA_HELD_OR_PC.controlInput = FieldMatcher({name: 'VMA_HELD_OR_PC_CONTROL', inputs: CR.COND,
                                            matchValue: CR.COND['LD VMA HELD']});
MBOX.inputs = MBUS;
MBOX.addrInput = VMA;
MBOX.controlInput = CR.MEM;
MBUS.inputs = ZERO;             // XXX temporary

// Export every EBOXUnit
module.exports = Object.assign(module.exports, Named.units);
