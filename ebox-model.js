'use strict';
const _ = require('lodash');
const util = require('util');
const StampIt = require('@stamp/it');

const {
  octal,
  maskForBit, shiftForBit,
  fieldInsert, fieldExtract, fieldMask
} = require('./util');

// Read our defines.mic and gobble definitions for fields and
// constants for CRAM and DRAM.
const {CRAMdefinitions, DRAMdefinitions} = require('./read-defs');


// Enable debug output for each method type by setting appropriate
// property value to `LOG()` or similar debug output function.
const D = {
  getInputs: nop,
  get: nop,
  latch: LOG,
  write: nop,
  reset: nop,
  addr: nop,
  control: nop,
  func: nop,
};


function nop(T, P, F, x) {return x}

// Log unit T of parent class P function F returning value x.
function LOG(T, P, F, x) {
  const name = `${T.name}@${P || ''}`;
  const bw = Number(T.bitWidth || 36);
  const xString = x == null ? '' : `=${octal(x, Math.ceil(bw/3))}`;
  console.log(`${name} ${F}${xString}`);
  return x;
}


// EBOX notes:
//
// M8539 APR module is replaced by M8545 in KL10 model B.
// M8523 VMA module is replaced by M8542 in KL10 model B.

var EBOX;                       // Forward references are a pain.


// Most of our instances need to have a name for debugging and
// display.
const Named = StampIt({name: 'Named'})
      .init(function({name}) {
        this.name = name;
      });
module.exports.Named = Named;


// Each Clock has a list of units it drives. Calling the `latch()`
// function on a Clock calls `latch()` on each driven unit.
const Clock = Named.init(function({drives = []}) {
        this.drives = drives;
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
const EBOXUnit = StampIt({
  name: 'EBOXUnit',
}).statics({
  units: {},                    // Dictionary of all units derived from this
}).init(function({name, bitWidth, inputs, addr, func, control, clock = EBOXClock}) {
  this.name = name;
  this.propName = this.name.replace(/[ .,]/g, '_');
  EBOXUnit.units[this.propName] = this;
  this.clock = clock;
  this.inputs = inputs;
  this.funcInput = func;
  this.controlInput = control;
  this.addrInput = addr;
  this.bitWidth = typeof bitWidth === 'undefined' ? bitWidth : BigInt(bitWidth);
  clock.addUnit(this);
}).props({
  value: 0n,
}).methods({

  reset() {
    this.value = 0n;
  },

  // Some commonly used default methods for RAM, LogicUnit, Mux, etc.
  getAddress() {
    return D.addr(this, 'EBOXUnit', 'getAddress', this.addrInput.get());
  },

  getFunc() {
    return D.func(this, 'EBOXUnit', 'getFunc', this.funcInput.get());
  },

  getControl() {
    return D.control(this, 'EBOXUnit', 'getControl', this.controlInput.get());
  },

  getInputs() {
    return D.getInputs(this, 'EBOXUnit', 'getInputs', this.inputs.get());
  },

  getLH(v = this.value) {
    return BigInt.asUintN(18, v >> 18n);
  },

  getRH(v = this.value) {
    return BigInt.asUintN(18, v);
  },

  joinHalves(lh, rh) {
    return (BigInt.asUintN(18, lh) << 18n) | BigInt.asUintN(18, rh);
  },
});
module.exports.EBOXUnit = EBOXUnit;


// Use this mixin to define a Combinatorial unit that is unclocked.
const Combinatorial = EBOXUnit.compose({name: 'Combinatorial'}).methods({
  latch() { },

  get() {
    this.value = this.getInputs();
    return D.get(this, 'Combinatorial', 'get', this.value);
  },
});


// Use this mixin to define a Clocked unit.
const Clocked = EBOXUnit.compose({name: 'Clocked'}).methods({

  latch() {
    this.value = this.getInputs();
    return D.latch(this, 'Clocked', 'latch', this.value);
  },

  get() {
    return D.get(this, 'Clocked', 'get', this.value);
  },
});


////////////////////////////////////////////////////////////////
// BitField definition. Define with a specific name. Convention is
// that `s` is PDP10 numbered leftmost bit and `e` is PDP10 numbered
// rightmost bit in field. So number of bits is `e-s+1`.
// Not an EBOXUnit, just a useful stamp.
const BitField = Combinatorial.compose({name: 'BitField'})
      .init(function({name, s, e}) {
        this.name = name;
        this.s = s;
        this.e = e;
        this.bitWidth = BigInt(e - s + 1);
      }).methods({

        reset() {
          D.reset(this, 'BitField', 'reset');
          this.wordWidth = Number(this.inputs.bitWidth);
          this.shift = shiftForBit(this.e, this.inputs.bitWidth);
          this.mask = (1n << BigInt(this.bitWidth)) - 1n;
        },

        getInputs() {
          const v = this.inputs.get();
          const shifted = BigInt.asUintN(this.wordWidth + 1, v) >> BigInt(this.shift);
          const result = shifted & this.mask;
          return D.getInputs(this, 'BitField', 'getInputs', result);
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

const ZERO = ConstantUnit({name: 'ZERO', bitWidth: 36, value: 0n});
const ONES = ConstantUnit({name: 'ONES', bitWidth: 36, value: -1n});
module.exports.ZERO = ZERO;
module.exports.ONES = ONES;


////////////////////////////////////////////////////////////////
// Take a group of inputs and concatenate them into a single wide
// field.
const BitCombiner = Combinatorial.compose({name: 'BitCombiner'})
      .methods({

        getInputs() {
          this.value = this.inputs.reduce((v, i) => (v << i.bitWidth) | i.get(), 0n);
          return D.getInputs(this, 'BitCombiner', 'getInputs', this.value);
        },
      });
module.exports.BitCombiner = BitCombiner;


////////////////////////////////////////////////////////////////
// Given an address, retrieve the stored word. Can also store new
// words for diagnostic purposes. Elements are BigInt by default. The
// one element in `inputs` is the unit that provides a value for calls
// to `latch()` or write data. A ZERO VALUE on `control` means the
// clock cycle is a WRITE, otherwise it is a read.
const RAM = Clocked.compose({name: 'RAM'})
      .init(function({nWords, initValue = 0n}) {
        this.nWords = nWords;
        this.initValue = initValue;
      }).methods({

        reset() {
          D.reset(this, 'RAM', 'reset');

          if (this.bitWidth <= 64 && this.initValue === 0n) {
            this.data = new BigUint64Array(this.nWords);
          } else {
            this.data = _.range(Number(this.nWords)).map(x => this.initValue);
          }

          this.value = this.initValue;
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

          return D.latch(this, 'RAM', isWrite ? 'write' : 'read', this.value);
        },
      });
module.exports.RAM = RAM;


// Use this for example as a `control` for a RAM (e.g., FM) to write
// when `COND/FM WRITE` with:
//      inputs: 'CR.COND', matchValue: "CR.COND['FM WRITE']"
const FieldMatcher = Combinatorial.compose({name: 'FieldMatcher'})
      .init(function({matchValue, matchF = (cur => BigInt(+(cur === this.matchValue)))}) {
        this.matchValue = eval(matchValue); // Should be static
        this.matchF = matchF;
      }).methods({

        getInputs() {
          const cur = this.inputs.get();
          this.value = this.matchF(cur);
          return D.getInputs(this, 'FieldMatcher', 'getInputs', this.value);
        },
      });

// Use this for example as a `control` for a RAM to write when
// `COND/FM WRITE` with {inputs: 'CR.COND', matchValue: "CR.COND['FM WRITE']"}.
const FieldMatchClock = Clock.compose({name: 'FieldMatchClock'})
      .init(function({inputs, matchValue, matchF}) {
        this.inputs = inputs;
        this.matchValue = eval(matchValue); // Should be static
        this.matchF = matchF || (cur => BigInt(+(cur === this.matchValue)));
        EBOXClock.addUnit(this);
      }).methods({

        reset() {
          this.value = this.prevValue = 0n;
        },

        latch() {
          const cur = this.inputs.get();
          this.value = this.matchF(cur);

          if (this.value && !this.prevValue) { // Do on rising edge only
            D.latch(this, 'FieldMatchClock', 'latch', this.value);
            this.drives.forEach(unit => unit.latch());
          }

          this.prevValue = this.value;
        },
      });

////////////////////////////////////////////////////////////////
// Given a control input and a series of selectable inputs, produce
// the value of the selected input on the output.
const Mux = Combinatorial.compose({name: 'Mux'}).methods({

  getInputs() {
    const controlValue = this.getControl();
    const input = this.inputs[controlValue];
    return D.getInputs(this, `Mux control=${controlValue}`, 'getInputs', input.get());
  },
});
module.exports.Mux = Mux;


////////////////////////////////////////////////////////////////
// Latch inputs for later retrieval.
const Reg = Clocked.compose({name: 'Reg'}).methods({

  latch() {
    this.value = this.getInputs();
    return D.latch(this, 'Reg',  'latch', this.value);
  },
});
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
const LogicUnit = Combinatorial.compose({name: 'LogicUnit'}).methods({
//  get() { return this.getInputs() },
});
module.exports.LogicUnit = LogicUnit;


////////////////////////////////////////////////////////////////
// Given a function selector and a set of inputs, compute a set of
// results.
const ShiftMult = Combinatorial.compose({name: 'ShiftMult'})
      .init(function({shift = 1}) {
        this.shift = BigInt(shift);
      }).methods({

        getInputs() {
          const result = this.inputs.get() << this.shift;
          return D.getInputs(this, 'ShiftMult', 'getInputs', result);
        },
      });
module.exports.ShiftMult = ShiftMult;


////////////////////////////////////////////////////////////////
// Given a function selector and a set of inputs, compute a set of
// results.
const ShiftDiv = Combinatorial.compose({name: 'ShiftDiv'})
      .init(function({shift = 1}) {
        this.shift = BigInt(shift);
      }).methods({

        getInputs() {
          const result = this.inputs.get() >> this.shift;
          return D.getInputs(this, 'ShiftDiv', 'getInputs', result);
        },
      });
module.exports.ShiftDiv = ShiftDiv;


////////////////////////////////////////////////////////////////
// Compute N+k for a given input. Can be used to subtract using
// negative k.
const Adder = Combinatorial.compose({name: 'Adder'})
      .init(function({k = 1}) {
        this.k = k;
      }).methods({

        getInputs() {
          const result = this.inputs.get() + this.k;
          return D.getInputs(this, 'Adder', 'getInputs', result);
        },
      });
module.exports.ShiftDiv = ShiftDiv;


// RAMs
const CRAM = RAM({name: 'CRAM', nWords: 2048, bitWidth: 84});
const CR = Reg({name: 'CR', bitWidth: 84});
const excludeCRAMfields = `U0,U21,U23,U42,U45,U48,U51,U73`.split(/,/);
defineBitFields(CR, CRAMdefinitions, excludeCRAMfields);


// Complex CRAM address calculation logic goes here...
const CRADR = Clocked.init(function({stackDepth = 4}) {
  this.stackDepth = stackDepth;
}).methods({

  reset() {
    D.reset(this, null, 'reset');
    this.value = 0n;
    this.force1777 = false;
    this.stack = [];
  },

  getInputs() {

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

      case CR.DISP['DIAG']:
      case CR.DISP['DRAM A RD']:// IMPLIES INH CRY18
      case CR.DISP['PG FAIL']:  // PAGE FAIL TYPE DISP
      case CR.DISP['SR']:	// 16 WAYS ON STATE REGISTER
      case CR.DISP['NICOND']:   // NEXT INSTRUCTION CONDITION (see NEXT for detail)
      case CR.DISP['SH0-3']:    // [337] 16 WAYS ON HIGH-ORDER BITS OF SHIFTER
      case CR.DISP['DIV']:      // FE0*4 + BR0*2 + AD CRY0; implies MQ SHIFT, AD LONG
      case CR.DISP['SIGNS']:    // ARX0*8 + AR0*4 + BR0*2 + AD0
      case CR.DISP['BYTE']:     // FPD*4 + AR12*2 + SCAD0--WRONG ON OVERFLOW FROM BIT 1!!
      case CR.DISP['NORM']:     // See normalization for details. Implies AD LONG
        break;

      }

      this.value = orBits | CR.J.get();
      return D.getInputs(this, null, 'getInputs', this.value);
    }
  },
}) ({name: 'CRADR', bitWidth: 11});

// This clock is pulsed in next cycle after IR is stable but not on
// prefetch.
const DR_CLOCK = Clock({name: 'DR_CLOCK'});

// Complex DRAM address calculation logic goes here...
const DRADR = ConstantUnit.methods({

  reset() {
    D.reset(this, null, 'reset');
    this.value = 0n;
  },

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

    return D.getInputs(this, null, 'getInputs', a);
  },
}) ({name: 'DRADR', bitWidth: 9});

const DRAM = RAM({name: 'DRAM', nWords: 512, bitWidth: 24});
const DR = Reg.methods({name: 'DR', bitWidth: 24, clock: DR_CLOCK});
defineBitFields(DR, DRAMdefinitions);


////////////////////////////////////////////////////////////////
// The EBOX.
EBOX = StampIt.compose(Named, {
}).init(function ({serialNumber}) {
  this.serialNumber = serialNumber;
}).props({
  unitArray: [],      // List of all EBOX Units as an array of objects
  clock: EBOXClock,
  run: false,
}).methods({

  reset() {
    D.reset(this, null, 'reset');
    this.resetActive = true;
    this.run = false;
    this.unitArray = Object.values(EBOXUnit.units);

    // Reset every Unit back to initial value.
    this.unitArray.forEach(unit => unit.reset());

    // RESET always generates several clocks with zero CRAM and DRAM.
    _.range(4).forEach(k => this.cycle());

    this.resetActive = false;
  },

  run() {
    this.run = true;
  },

  cycle() {
    this.clock.cycle();
  },
  
}) ({name: 'EBOX', serialNumber: 3210});
module.exports.EBOX = EBOX;


const LOAD_AC_BLOCKS = Clock({name: 'LOAD_AC_BLOCKS'});
const CURRENT_BLOCK = Reg({name: 'CURRENT_BLOCK', bitWidth: 3, clock: LOAD_AC_BLOCKS});

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
    return D.latch(this, null, 'latch', this.value);
  },
}) ({name: 'IR', bitWidth: 12, clock: IR_CLOCK,
     control: FieldMatcher({name: 'IR_WRITE', inputs: 'CR.COND',
                            matchValue: 'CR.COND["LOAD IR"]'})});


// AC subfield of IR.
const IRAC = BitField({name: 'IRAC', s: 9, e: 12});


const FM_ADR = LogicUnit.methods({
  
  getInputs() {
    let acr;
    
    switch(CR.FMADR.get()) {
    default:
    case CR.FMADR.AC0:
      acr = IRAC.get(); break;
    case CR.FMADR.AC1:
      acr = (IRAC.get() + 1) & 15n; break;
    case CR.FMADR.XR:
      acr = ARX_14_17.get(); break;
    case CR.FMADR.VMA:
      acr = VMA_32_35.get(); break;
    case CR.FMADR.AC2:
      acr =  (IRAC.get() + 2) & 15n; break;
    case CR.FMADR.AC3:
      acr = (IRAC.get() + 3) & 15n; break;
    case CR.FMADR['AC+#']:
      acr = (IRAC.get() + MAGIC_NUMBER.get()) & 15n; break;
    case CR.FMADR['#B#']:
      // THIS NEEDS TO BE MAGIC_NUMBER<4:0> defining 10181 function (LSB is BOOLE).
      acr = MAGIC_NUMBER.get() & 15n; break;
    }

    return D.getInputs(this, null, 'getInputs', acr);
  },
}) ({name: 'FM_ADR', bitWidth: 4});

const FMA = BitCombiner({name: 'FMA', bitWidth: 7});
const FM = RAM({name: 'FM', nWords: 8*16, bitWidth: 36});


const ALU10181 = StampIt.init(function({bitWidth = 36}) {
  this.bitWidth = bitWidth = BigInt(bitWidth);
  this.ONES = (1n << bitWidth) - 1n;
}).props({
  name: 'ALU10181',
}).methods({

  add(a, b, cin = 0n) {
    if (typeof a !== 'bigint') debugger;
    if (typeof b !== 'bigint') debugger;
    if (typeof cin !== 'bigint') debugger;
    const sum = a + b + cin;
    this.cout = sum > this.ONES ? 1n : 0n;
    return sum & this.ONES;
  },

  sub(a, b, cin = 0n) {
    const diff = a - b - cin;
    this.cout = diff > this.ONES ? 1n : 0n;
    return diff & this.ONES;
  },

  // This side-effect sets this.cout for carry and returns the value.
  do(func, a, b, cin = 0n) {

    // XXX this badly needs testing
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
    case 0o14: return this.add(this.ONES, 0n, cin);
    case 0o15: return this.sub(a & NOT(b), 1n, cin);
    case 0o16: return this.sub(a & b, 1n, cin);
    case 0o17: return this.sub(a, 1n, cin);

    // BOOLEAN
    case 0o20: return BOOL(NOT(a), a);
    case 0o21: return BOOL(NOT(a) | NOT(b), this.add(a, a & NOT(b)));
    case 0o22: return BOOL(NOT(a) | b, this.add(a, a & b));
    case 0o23: return BOOL(1n, this.add(a, a));
    case 0o24: return BOOL(a & b, a | b);
    case 0o25: return BOOL(NOT(b), this.add(a & NOT(b), a | b));
    case 0o26: return BOOL(NOT(a ^ b), this.add(a, b));
    case 0o27: return BOOL(a | NOT(b), this.add(a, a | b));
    case 0o30: return BOOL(NOT(a) & b, a | NOT(b));
    case 0o31: return BOOL(a ^ b, this.sub(a, b, 1n));
    case 0o32: return BOOL(b, this.add(a | NOT(b), a & b));
    case 0o33: return BOOL(a | b, this.add(a, a | NOT(b)));
    case 0o34: return BOOL(0n, this.ONES);
    case 0o35: return BOOL(a & NOT(b), this.sub(a & NOT(b), 1n));
    case 0o36: return BOOL(a & b, this.sub(a & b, 1n));
    case 0o37: return BOOL(a, this.sub(a, 1n));
    }


    function BOOL(noCarry, withCarry) {
      return {value: cin ? withCarry : noCarry, cout: 0n};
    }
    
    function NOT(v) {
      return v ^ this.ONES;
    }
  },
});


const DataPathALU = LogicUnit.init(function({bitWidth}) {
  this.alu = ALU10181({bitWidth});

  this.getCarry = Combinatorial.init(function({parentALU}) {
    this.parentALU = parentALU;
  }).methods({

    getInputs() {
      return D.getInputs(this, 'Combinatorial', 'getInputs', this.parentALU.cout);
    },
  }) ({name: this.name + '.getCarry', bitWidth: 1, parentALU: this});
}).methods({

  do(aluFunction, a, b, cin = 0n) {
    const v = this.alu.do(aluFunction, a, b, cin);
    this.cout = v.cout;
    return v;
  },

  getInputs() {
    const func = this.getFunc();
    const f = Number(func) & 0o37;
    const a = this.inputs[0].get();
    const b = this.inputs[1].get();
    const cin = (func & 0o40n) ? 1n : this.inputs[2].get();

    // XXX CIN is affected by p. 364 E7/E8/E19 grid A4-5.
    // When that isn't true, CIN is ADX COUT.
    //
    // Also note that SPEC/XCRY AR0 means AD XORed with AR00
    //
    // Also note the schematic symbols XXX CRY 36 mean the carry INTO
    // the LSB of the adder for XXX (i.e., from a bit to the right).
    let result = 0n;

    switch(func) {
    case CR.AD['A+1']:      result = this.do(f, a, cin);        break;
    case CR.AD['A+XCRY']:   result = this.do(f, a, cin);        break;
    case CR.AD['A+ANDCB']:  result = this.do(f, a);             break;
    case CR.AD['A+AND']:    result = this.do(f, a);             break;
    case CR.AD['A*2']:      result = this.do(f, a, a);          break;
    case CR.AD['A*2+1']:    result = this.do(f, a, a, 1n);      break;
    case CR.AD['OR+1']:     result = this.do(f, a, a, cin);     break;
    case CR.AD['OR+ANDCB']: result = this.do(f, a, a);          break;
    case CR.AD['A+B']:      result = this.do(f, a, b);          break;
    case CR.AD['A+B+1']:    result = this.do(f, a, b, cin);     break;
    case CR.AD['A+OR']:     result = this.do(f, a, b);          break;
    case CR.AD['ORCB+1']:   result = this.do(f, a, b, cin);     break;
    case CR.AD['A-B-1']:    result = this.do(f, a, b);          break;
    case CR.AD['A-B']:      result = this.do(f, a, b, cin);     break;
    case CR.AD['AND+ORCB']: result = this.do(f, a, b, cin);     break;
    case CR.AD['XCRY-1']:   result = this.do(f, a, b, cin);     break;
    case CR.AD['ANDCB-1']:  result = this.do(f, a, b);          break;
    case CR.AD['AND-1']:    result = this.do(f, a, b);          break;
    case CR.AD['A-1']:      result = this.do(f, a, b);          break;
    }

    return D.getInputs(this, 'DataPathALU', 'getInputs', result);
  },
});

const ADX = DataPathALU({name: 'ADX', bitWidth: 36});

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
const AD = DataPathALU({name: 'AD', bitWidth: 38});


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

          return D.latch(this, null, 'latch', this.value);
        },
      }) ({name: 'VMA', bitWidth: 35 - 13 + 1});

const PC = Reg({name: 'PC', bitWidth: 35 - 13 + 1});

const AD_13_35 = BitField({name: 'AD_13_35', s: 13, e: 35});

const DATAO_APR = CR['DIAG FUNC']['DATAO APR'];
const DIAG_FUNC = CR.COND['DIAG FUNC'];
const ADR_BREAK_matchF = cur => cur === DIAG_FUNC && CR['DIAG FUNC'] === DATAO_APR;
const ADR_BREAK = Reg({name: 'ADR BREAK', bitWidth: 35 - 13 + 1,
                       clock: FieldMatchClock({name: 'ADR_BREAK_CLOCK',
                                               inputs: CR['DIAG FUNC'],
                                               matchF: ADR_BREAK_matchF,
                                               matchValue: DATAO_APR})});

const VMA_HELD = Reg({name: 'VMA HELD', bitWidth: 35 - 13 + 1});

const AD_13_17 = BitField({name: 'AD_13_17', s: 13, e: 17});
const VMA_PREV_SECT = Reg({name: 'VMA PREV SECT', bitWidth: 17 - 13 + 1});

const MQ = LogicUnit.methods({

  getInputs() {
    let result = 0n;

    // Our complex operations are selected by COND/REG CTL
    if (CR.COND.get() === CR.COND['REG CTL']) {
      const MQ_CTL = CR['MQ CTL'];

      if (MQ.get() === MQ['MQ SEL']) {

        switch (MQ_CTL.get()) {
        default:
        case MQ_CTL.MQ:
          result = this.value;
          break;

        case MQ_CTL['MQ*2']:
          result = (this.value << 1n) | ADX.get() & 1;
          break;

        case MQ_CTL['MQ*.5']:
          result = (this.value >> 1n) & ~(maskForBit(0)  |
                                          maskForBit(6)  |
                                          maskForBit(12) |
                                          maskForBit(18) |
                                          maskForBit(24) |
                                          maskForBit(30));

        case MQ_CTL['0S']:
          result = 0n;
          break;
        }
      } else {                  // Must be MQ/MQM SEL

        switch (MQ_CTL.get()) {
        default:
        case MQ_CTL['SH']:
          result = SH.get();
          break;

        case MQ_CTL['MQ*.25']:
          result = ((this.value >> 2n) & ~(3n << 34n)) | (ADX.get() << 34n);
          break;

        case MQ_CTL['1S']:
          result = ONES.get();
          break;

        case MQ_CTL['1S']:
          result = AD.get();
          break;
        }
      }
    }

    return D.getInputs(this, null, 'getInputs', result);
  },
}) ({name: 'MQ', bitWidth: 36});


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
const BRx2 = ShiftMult({name: 'BRx2', shift: 1, bitWidth: 36});
const ARx4 = ShiftMult({name: 'ARx4', shift: 1, bitWidth: 36});
const BRXx2 = ShiftMult({name: 'BRXx2', shift: 1, bitWidth: 36});
const ARXx4 = ShiftMult({name: 'ARXx4', shift: 1, bitWidth: 36});


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

  getInputs() {
    const func = Number(this.getFunc());
    const a = this.inputs[0].get();
    const b = this.inputs[1].get();
    let result;

    switch(func) {
    default:
    case CR.SCAD.A:        result = this.alu.do(0o00, a, b);            break;
    case CR.SCAD['A-B-1']: result = this.alu.do(0o11, a, b);            break;
    case CR.SCAD['A+B']:   result = this.alu.do(0o06, a, b);            break;
    case CR.SCAD['A-1']:   result = this.alu.do(0o17, a, b);            break;
    case CR.SCAD['A+1']:   result = this.alu.do(0o00, a, b, 1n);        break;
    case CR.SCAD['A-B']:   result = this.alu.do(0o11, a, b, 1n);        break;
    case CR.SCAD.OR:       result = this.alu.do(0o04, a, b);            break;
    case CR.SCAD.AND:      result = this.alu.do(0o16, a, b, 1n);        break;
    }

    return D.getInputs(this, null, 'getInputs', result);
  },
}) ({name: 'SCAD', bitWidth: 10});

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
          else if (CR.COND.get() == CR.COND['FE SHRT'])
            result = 1;
          else
            result = 3;

          return D.getInputs(this, null, 'getInputs', result);
        },

      }) ({name: 'FEcontrol', bitWidth: 2});

const FE = ShiftReg({name: 'FE', bitWidth: 10,
                     clock: FieldMatchClock({name: 'FE_CLOCK',
                                             inputs: CR.FE, matchValue: CR.FE.SCAD})});
const SH = LogicUnit.methods({

  getInputs() {
    const count = SC.get();
    const func = this.getFunc();
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

    return D.getInputs(this, null, 'getInputs', result);
  },
}) ({name: 'SH', bitWidth: 36});


////////////////////////////////////////////////////////////////
// Muxes
const ADA = Mux({name: 'ADA', bitWidth: 36});
const ADB = Mux({name: 'ADB', bitWidth: 36});
const ADXA = Mux({name: 'ADXA', bitWidth: 36});
const ADXB = Mux({name: 'ADXB', bitWidth: 36});

const ARSIGN_SMEAR = LogicUnit.methods({

  getInputs() {
    return D.getInputs(this, null, 'getInputs',
                       BigInt(+!!(AR.get() & maskForBit(0, 9))));
  },
}) ({name: 'ARSIGN_SMEAR', bitWidth: 9});

const SCAD_EXP = BitField({name: 'SCAD_EXP', s: 0, e: 8});
const SCAD_POS = BitField({name: 'SCAD_POS', s: 0, e: 5});
const PC_13_17 = BitField({name: 'PC_13_17', s: 13, e: 17});
const VMA_PREV_SECT_13_17 = BitField({name: 'VMA_PREV_SECT_13_17', s: 13, e: 17});

const MAGIC_NUMBER = CR['#'];

const ARMML = Mux({name: 'ARMML', bitWidth: 9});

const ARMMR = Mux.methods({

  getInputs() {
    return D.getInputs(this, null, 'getInputs',
                       BigInt(+!!(CR.VMAX.get() & CR.VMAX['PREV SEC'])));
  },
}) ({name: 'ARMMR', bitWidth: 17 - 13 + 1});


const ARMM = BitCombiner({name: 'ARMM', bitWidth: 18});
const ADx2 = ShiftMult({name: 'ADx2', shift: 1, bitWidth: 36});
const ADdiv4 = ShiftDiv({name: 'ADdiv4', shift: 2, bitWidth: 36});

const SERIAL_NUMBER = ConstantUnit.methods({

  reset() {
    D.reset(this, null, 'reset');
    this.value = BigInt(EBOX.serialNumber);
  },
}) ({name: 'SERIAL_NUMBER', value: 0n, bitWidth: 18});
module.exports.SERIAL_NUMBER = SERIAL_NUMBER;

// XXX very temporary. Needs implementation.
const EBUS = ZERO;

// XXX very temporary. Needs implementation.
const CACHE = ZERO;

// XXX This is wrong in many cases
const ARML = Mux({name: 'ARML', bitWidth: 18});

const ARMR = Mux({name: 'ARMR', bitWidth: 18});

const ARL = Reg({name: 'ARL', bitWidth: 18,
                 clock: FieldMatchClock({name: 'ARL_CLOCK', inputs: CR['AR CTL'],
                                         matchValue: CR['AR CTL']['ARL LOAD']})});
const ARR = Reg({name: 'ARR', bitWidth: 18,
                 clock: FieldMatchClock({name: 'ARR_CLOCK', inputs: CR['AR CTL'],
                                         matchValue: CR['AR CTL']['ARR LOAD']})});

const ARX = LogicUnit.methods({

  getInputs() {
    const ARX = CR.ARX;
    let result;

    // Our complex operations are selected by ARX/
    switch (ARX.get()) {
    default:
    case ARX.MEM:
    case ARX.ARX:
      result = this.value;
      break;

    case ARX.CACHE:
      result = 0n;                // XXX someday...
      break;

    case ARX.AD:
      result = AD.get();
      break;

    case ARX.MQ:
      result = MQ.get();
      break;

    case ARX.SH:
      result = SH.get();
      break;

    case ARX['ADX*2']:
      result = ADX.get() << 1n | ((MQ.get() >> 35n) & 1);
      break;

    case ARX.ADX:
      result = ADX.get();
      break;

    case ARX['ADX*.25']:
      result = ADX.get() >> 2n | (AD.get() & 3n);
      break;
    }

    return D.getInputs(this, null, 'getInputs', result);

  },
}) ({name: 'ARX', bitWidth: 36});

// E.g.
// AR_AR AND ADMSK	"ADMSK,ADB/FM,ADA/AR,AD/AND,AR/AD"
// FETCH		"MEM/IFET"
// U 1072: VMA_AR AND ADMSK,FETCH,J/NOP
const AR = BitCombiner({name: 'AR', bitWidth: 36});
const BR = Reg({name: 'BR', bitWidth: 36,
                clock: FieldMatchClock({name: 'BR_CLOCK',
                                        inputs: CR.BR, matchValue: CR.BR.AR})});
const BRX = Reg({name: 'BRX', bitWidth: 36,
                 clock: FieldMatchClock({name: 'BRX_CLOCK',
                                         inputs: CR.BRX, matchValue: CR.BRX.ARX})});

const SC = LogicUnit.methods({

  getInputs() {
    const SCM_ALT = CR['SCM ALT'];
    const SPEC = CR.SPEC.get();
    let result;

    // Our complex operations are selected by SC/ and SPEC/SCM ALT
    if (CR.SC.get() === 0n) {      // Either recirculate or FE
      result = SPEC !== SCM_ALT ? this.value : FE.get();
    } else {

      if (SPEC !== SCM_ALT) {
        result = SCAD.get();
      } else {
        const ar = AR.get();
        const ar18filled = ((ar >> 18n) & 1n) ? 0o777777000000n : 0n;
        result = ar18filled | ar & 0o377n; // smear(AR18),,ar28-35
      }
    }

    return D.getInputs(this, null, 'getInputs', result);
  },
}) ({name: 'SC', bitWidth: 10});


const SCADA = Mux({name: 'SCADA', bitWidth: 10});
const SCADB = Mux({name: 'SCADB', bitWidth: 10});

const SCD_FLAGS = Reg({name: 'SCD_FLAGS', bitWidth: 13});
const VMA_FLAGS = Reg({name: 'VMA_FLAGS', bitWidth: 13});
const PC_PLUS_FLAGS = BitCombiner({name: 'PC_PLUS_FLAGS', bitWidth: 36});
const VMA_PLUS_FLAGS = BitCombiner({name: 'VMA_PLUS_FLAGS', bitWidth: 36});

const VMA_HELD_OR_PC = Mux.methods({

  getInputs() {
    return D.getInputs(this, null, 'getInputs', BigInt(+this.getControl()));
  },
}) ({name: 'VMA HELD OR PC', bitWidth: 36,
     control: FieldMatcher({name: 'VMA_HELD_OR_PC_CONTROL', inputs: 'CR.COND',
                            matchValue: 'CR.COND["VMA HELD"]'})});


////////////////////////////////////////////////////////////////
// System memory.
//
// The `control` input is the EBOX request type, directly accessed out
// of the CR.MEM field.
const MBOX = RAM.methods({

  getInputs() {
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
      break;

    case CR.MEM['FETCH']:	// LOAD NEXT INSTR TO ARX (CONTROL BY #)
      break;
    }

    return D.getInputs(this, null, 'getInputs', result);
  },
}) ({name: 'MBOX', nWords: 4 * 1024 * 1024, bitWidth: 36});

const MBUS = Reg({name: 'MBUS', bitWidth: 36});


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
        const bitWidth = e - s + 1;
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

FM_ADR.inputs = [IRAC, ARX, VMA, MAGIC_NUMBER];
FMA.inputs = [CR.ACB, FM_ADR];
FM.addrInput = FMA;
FM.inputs = AR;
FM.controlInput = FieldMatcher({name: 'FM_WRITE', inputs: CR.COND,
                                matchValue: CR.COND['FM WRITE']});

AD.inputs = [ADB, ADA, ZERO];
AD.funcInput = CR.AD;
AD_13_35.inputs = AD;
AD_13_17.inputs = AD;
ADX.inputs = [ADXB, ADXA, ZERO];
ADX.funcInput = CR.AD;

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

MQ.inputs = [ZERO, SH, ONES, AD];

ADA.inputs = [AR, ARX, MQ, PC];
ADA.controlInput = CR.ADA;

ADB.inputs = [FM, BRx2, BR, ARx4];
ADB.controlInput = CR.ADB;

ADXA.inputs = [ARX, ARX, ARX, ARX];
ADXA.controlInput = CR.ADA;

ADXB.inputs = [ZERO, BRXx2, BRX, ARXx4];
ADXB.controlInput = CR.ADB;

ARMML.inputs = [MAGIC_NUMBER, ARSIGN_SMEAR, SCAD_EXP, SCAD_POS];
ARMML.controlInput = CR.ARMM;

ARMMR.inputs = [PC_13_17, VMA_PREV_SECT_13_17];
ARMMR.controlInput = CR.VMAX;

ARMM.inputs = [ARMML, ARMMR];

ARMR.inputs = [SERIAL_NUMBER, CACHE, ADX, EBUS, SH, ADx2, ADdiv4];
ARMR.controlInput = CR.AR;

ARML.inputs = [AR, CACHE, AD, EBUS, SH, ADx2, ADX, ADdiv4];
ARML.controlInput = CR.AR;

ARL.inputs = ARML;
ARR.inputs = ARMR;

ARX.inputs = [ARX, CACHE, AD, MQ, SH, ZERO, ADX, ZERO];
ARX.controlInput = CR.ARX;
ARX_14_17.inputs = ARX;

AR.inputs = [ARL, ARR];
AR_00_08.inputs = AR;
AR_EXP.inputs = AR;
AR_SIZE.inputs = AR;
AR_POS.inputs = AR;
AR_SHIFT.inputs = AR;
AR_00_12.inputs = AR;

BR.inputs = AR;
BRX.inputs = ARX;

FE.inputs = SCAD;
FE.controlInput = FEcontrol;

SH.inputs = [AR, ARX];
SH.controlInput = CR.SH;

SCAD.inputs = [SCADA, SCADB];
SCAD.funcInput = CR.SCAD;
SCAD_EXP.inputs = SCAD;
SCAD_POS.inputs = SCAD;
SC.inputs = [SC, FE, AR, SCAD];
SCADA.inputs = [ZERO, ZERO, ZERO, ZERO, FE, AR_POS, AR_EXP, MAGIC_NUMBER];
SCADA.controlInput = CR.SCADA;
SCADB.inputs = [FE, AR_SIZE, AR_00_08, MAGIC_NUMBER];
SCADB.controlInput = CR.SCADB;

ADx2.inputs = AD;
ADdiv4.inputs = AD;
BRx2.inputs = BR;
ARx4.inputs = AR;
BRXx2.inputs = BRX;
ARXx4.inputs = ARX;

SCD_FLAGS.inputs = AR_00_12;
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
module.exports = Object.assign(module.exports, EBOXUnit.units);
