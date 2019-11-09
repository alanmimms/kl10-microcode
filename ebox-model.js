'use strict';
const _ = require('lodash');
const fs = require('fs');
const util = require('util');
const StampIt = require('@stamp/it');

const {
  octal,
  maskForBit, shiftForBit,
  fieldInsert, fieldExtract, fieldMask
} = require('./util');

// EBOX notes:
//
// M8539 APR module is replaced by M8545 in KL10 model B.
// M8523 VMA module is replaced by M8542 in KL10 model B.


// Split `define.mic` file to retrieve CRAM definitions section and
// DRAM definitions sections so we can parse them into definitions we
// can use.
const definesRE = new RegExp([
  /^.*\.TOC\s+"CONTROL RAM DEFINITIONS -- J, AD"\s+/,
  /(?<CRAM>.*?)(?=\.DCODE\s+)/,
  /(?<DRAM>.*?)(?=\s+\.UCODE\s+)/,
].map(re => re.source).join(''), 'ms');

const define_mic = fs.readFileSync('./define.mic');

if (!define_mic) {
  console.error(`ERROR: Missing 'define.mic' file which is required for ebox-model`);
  process.exit(-1);
}

const definesMatches = define_mic
      .toString()
      .match(definesRE);
const defines = definesMatches.groups;


// This is a mixin for anything with a `this.name` property and a
// `this.fixups` property, where `fixups` is comma separated list of
// property names on `this` whose value is itself a comma separated
// list of names to convert (in place) from string to array of object
// refs. This allows forward refernces to objects in more than one
// property on our Stamps, resolving these foward references for all
// Stamps that use this mixin facility after all Stamps that are
// defined by calling Fixupable.fixup(). If you specify a fixup name
// in square brackets (e.g., `[ARL]`) it will be fixed up as an array.
// Otherwise singleton values (with no comma separated list) will be
// object references without the array wrapper.
const Fixupable = StampIt({name: 'Fixupable'})
      .statics({
        needsFixup: [],

        // Called at end of declarations to transform the `inputs`
        // string of comma-separated names into an array of real objects.
        fixup() {

          Fixupable.needsFixup.forEach(o => { // Loop for each object needing fixup
            if (typeof o.fixups !== 'string') return;

            o.fixups.split(/,\s*/).forEach(fuItem => {

              // Check for fixup item wrapped in `[]` in which case we
              // force the result to be an array even if it is a
              // singleton. Otherwise, singletons are not array-wrapped.
              const wrapped = fuItem.match(/^\[(?<unwrapped>[^\]]+)]$/);

              if (wrapped) fuItem = wrapped.groups.unwrapped;

              // Do nothing if fixup is not a string - already fixed up?
              if (typeof o[fuItem] !== 'string') return;

              o[fuItem] = o[fuItem].split(/,\s*/)
                .map(fi => {
                  const resolution = eval(fi);

                  if (typeof resolution === undefined) {
                    console.error(`Fixupable: ${o.name}.${fuItem} ${fi} is not defined`);
                  }

                  return resolution;
                });

              // Unwrap singletons unless otherwise requested.
              if (!wrapped && o[fuItem].length === 1) o[fuItem] = o[fuItem][0];
            });
          });
        },
      }).init(function({fixups = 'inputs'}) {
        this.fixups = fixups;
        Fixupable.needsFixup.push(this);
      });
module.exports.Fixupable = Fixupable;

// All of our Units need to have a name for debugging and display.
const Named = StampIt({name: 'Named'})
      .init(function({name}) {
        this.name = name;
      });
module.exports.Named = Named;


const Clock = Named.init(function({drives = []}) {
        this.drives = drives;
      }).methods({

        addUnit(unit) {
          this.drives.push(unit);
        },

        clockEdge() {
        },
      });
module.exports.Clock = Clock;

// Used for non-clocked objects like ZERO and ONES
const NOCLOCK = Clock({name: 'NOCLOCK'});

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
//   |                     +-- `clockEdge()` copies `latchedValue` to `value`
//   |
//   +-- `latch()`, saves `getInputs()` value to `latchedValue`
//

////////////////////////////////////////////////////////////////
// Stamps

// Base Stamp for EBOX functional units. This is an abstract Stamp
// defining protocol but all should be completely overridden.
//
// The convention is that each EBOXUnit has a `getInputs()` method
// that retrieves the unit's value based on its current inputs and
// configuration. EBOXUnit uses `getInputs()` method to retrieve
// inputs and aggregates them to save what would be saved on the clock
// edge.
//
// The combinational logic in the KL10 does not really transition
// piecemeal like our implementation would do if we simply allowed
// each Unit's output to change as we walk through and recalculate
// each Unit's state during each clock. So we have to effectively
// treat EVERY Unit as being clocked and apply the latch --> clock
// discipline because we do not have hardware paralellism. So every
// Unit actually is composed from EBOXUnit.
//
// * `latch()` copies `getInputs()` result into `latchedValue`.
// * `clockEdge()` copies `latchedValue` to `value`.
// * `get()` returns `value`.

const EBOX = StampIt.compose(Named, {
}).init(function ({serialNumber}) {
  this.serialNumber = serialNumber;
  this.units = {};              // List of all EBOX Units
  this.unitArray = [];          // List of all EBOX Units as an array of objects
  this.clock = Clock({name: 'EBOXClock', control: 'ZERO'});
  this.run = false;
})
.methods({

  reset() {
    this.resetActive = true;
    this.run = false;
    this.unitArray = Object.keys(this.units)
      .map(name => this.units[name]);

    // Reset every Unit back to initial value.
    this.unitArray.forEach(unit => unit.reset());

    // RESET always generates several clocks with zero CRAM and DRAM.
    _.range(4).forEach(k => {
      this.latch();
      this.clockEdge();
    });

    this.resetActive = false;
  },

  latch() {
    this.clock.drives.forEach(unit => {
//      console.log(`${unit.name}.latch()`);
      unit.latch();
    });
  },

  clockEdge() {
    this.clock.drives.forEach(unit => {
//      console.log(`${unit.name}.clockEdge()`);
      unit.clockEdge();
    });
  },

  cycle() {
    this.latch();
    this.clockEdge();
  },
  
}) ({name: 'EBOX', serialNumber: 3210});
module.exports.EBOX = EBOX;


const EBOXUnit = StampIt.compose(Fixupable, {
  name: 'EBOXUnit',
}).init(function({name, bitWidth, inputs = '', clock = EBOX.clock, debugTrace = false}) {
  this.name = name;
  EBOX.units[this.name.replace(/[ .,]/g, '_')] = this;
  this.inputs = inputs;
  this.clock = clock;
  this.value = this.latchedValue = 0n;
  this.debugTrace = debugTrace;

  // We remember if bitWidth needs to be fixed up after inputs are
  // transformed or if it was explicitly specified.
  this.specifiedBitWidth = this.bitWidth = 
    typeof bitWidth === 'undefined' ? bitWidth : BigInt(bitWidth);

  clock.addUnit(this);
  this.reset();
}).methods({
  reset() {this.latchedValue = this.value = 0n},
  get() {return this.value},
  latch() {this.latchedValue = this.getInputs()},
  clockEdge() {this.value = this.latchedValue},

  // NEARLY ALWAYS should be overridden in derivative stamps
  getInputs() {return this.value},

  getLH() {
    return BigInt.asUintN(18, this.value >> 18n);
  },

  getRH() {
    return BigInt.asUintN(18, this.value);
  },

  joinHalves(lh, rh) {
    return (BigInt.asUintN(18, lh) << 18n) | BigInt.asUintN(18, rh);
  },
});
module.exports.EBOXUnit = EBOXUnit;


////////////////////////////////////////////////////////////////
// BitField definition. Define with a specific name. Convention is
// that `s` is PDP10 numbered leftmost bit and `e` is PDP10 numbered
// rightmost bit in field. So number of bits is `e-s+1`.
// Not an EBOXUnit, just a useful stamp.
const BitField = StampIt.compose(Fixupable, {name: 'BitField'})
      .init(function({name, s, e, inputs}) {
        this.name = name;
        this.s = s;
        this.e = e;
        this.inputs = inputs;
        this.bitWidth = BigInt(e - s + 1);
        this.reset();
      }).methods({

        reset() {
          this.wordWidth = Number(this.inputs.bitWidth);
          this.shift = shiftForBit(this.e, this.inputs.bitWidth);
          this.mask = (1n << BigInt(this.bitWidth)) - 1n;
        },

        get() {
          return this.getInputs();
        },

        getInputs() {
          const v = this.inputs.getInputs();
          const shifted = BigInt.asUintN(this.wordWidth + 1, v) >> this.shift;
          return shifted & this.mask;
        },
      });
module.exports.BitField = BitField;


////////////////////////////////////////////////////////////////
// Use this for inputs that are always zero.
const ConstantUnit = EBOXUnit.compose({name: 'ConstantUnit'})
      .init(function ({name, value = 0, bitWidth = 36n}) {
        this.name = name;
        this.inputs = [];       // To avoid "is not defined" messages from FixupableInputs
        this.constant = true;
        value = BigInt(value);
        this.value = value >= 0n ? value : BigInt.asUintN(Number(bitWidth), value);
        this.latchedValue = this.value;
        this.clock = NOCLOCK;
      }).methods({
        latch() {},
        clockEdge() {},
        getInputs() {return this.latchedValue = this.value},
        get() {return this.getInputs()},
      });

const ZERO = ConstantUnit({name: 'ZERO', bitWidth: 36, value: 0n});
const ONES = ConstantUnit({name: 'ONES', bitWidth: 36, value: -1n});
module.exports.ZERO = ZERO;
module.exports.ONES = ONES;


////////////////////////////////////////////////////////////////
// Take a group of inputs and concatenate them into a single wide
// field.
const BitCombiner = EBOXUnit.compose({name: 'BitCombiner'})
      .methods({

        getInputs() {
          return this.inputs.reduce((v, i) => {
            v = (v << i.bitWidth) | i.getInputs();
            return v;
          }, 0n);
        }
      });
module.exports.BitCombiner = BitCombiner;


////////////////////////////////////////////////////////////////
// Given an address, retrieve the stored word. Can also store new
// words for diagnostic purposes. This is meant for CRAM and DRAM, not
// FM. Elements are BigInt by default. The one element in `inputs` is
// the EBOXUnit that provides a value for calls to `latch()` or write
// data. A nonzero value on `control` means the clock cycle is a
// WRITE, otherwise it is a read.
const RAM = EBOXUnit.compose({name: 'RAM'})
      .init(function({nWords, fixups = 'inputs,control,addrInput',
                      control = 'ZERO', addrInput, initValue = 0n}) {
        this.nWords = nWords,
        this.fixups = fixups;
        this.control = control;
        this.addrInput = addrInput;
        this.initValue = initValue;
        this.reset();
      }).methods({

        reset() {
          this.data = _.range(Number(this.nWords)).map(x => this.initValue);
          this.latchedAddr = 0;
          this.writeCycle = false;
          this.latchedValue = this.value = this.initValue;
        },

        get() { return this.value },

        clockEdge() {

          if (this.writeCycle) {
            this.data[this.latchedAddr] = this.value = this.latchedValue;
          }
        },

        latch() {
          this.writeCycle = this.isWriteCycle();
          this.latchedAddr = this.addrInput.getInputs();

          if (this.writeCycle) {
            this.latchedValue = this.value = this.getInputs();
          } else {
            this.latchedValue = this.value = this.data[this.latchedAddr];
          }
        },

        isWriteCycle() {
          return !!this.control.getInputs();
        },
      });
module.exports.RAM = RAM;


// Use this for example as a `control` for a RAM to write when
// `COND/FM WRITE` with {inputs: 'CR.COND', matchValue: "CR.COND['FM WRITE']"}.
const FieldMatcher = EBOXUnit.compose({name: 'FieldMatcher'})
      .init(function({fixups = 'inputs,matchValue', inputs, matchValue, debugTrace = false}) {
        this.matchValue = eval(matchValue); // Should be static
        this.inputs = inputs;
        this.debugTrace = debugTrace;
      }).methods({

        getInputs() {
          const v = this.inputs.getInputs();
          const result = BigInt(+(v === this.matchValue));
          if (this.debugTrace) console.log(`${this.name} getInputs value=${result}`);
          return result;
        },
      });

////////////////////////////////////////////////////////////////
// Given a control input and a series of selectable inputs, produce
// the value of the selected input on the output.
const Mux = EBOXUnit.compose({name: 'Mux'})
      .init(function({fixups = '[inputs],control', control}) {
        this.control = control;
        this.fixups = fixups;
      }).methods({

        getInputs() {
          console.log(`${this.name} getInputs control=${this.control.name} \
value=${this.control.getInputs()}`);
          return this.inputs[this.control.getInputs()].getInputs();
        }
      });
module.exports.Mux = Mux;


////////////////////////////////////////////////////////////////
// Latch inputs for later retrieval.
const Reg = EBOXUnit.compose({name: 'Reg'})
      .methods({

        latch() {
          this.value = this.latchedValue;
          this.latchedValue = this.inputs.getInputs();
          if (this.debugTrace) {
            const nd = Math.ceil(Number(this.bitWidth) / 3);
            console.log(`${this.name} latch() value=${octal(this.value, nd)} \
latchedValue=${octal(this.latchedValue, nd)}\
`);
          }
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
const ShiftReg = EBOXUnit.compose({name: 'ShiftReg'})
      .init(function({fixups = 'inputs,control', control}) {
        this.control = control;
        this.fixups = fixups;
      });
module.exports.ShiftReg = ShiftReg;


////////////////////////////////////////////////////////////////
// Given a function selector and a set of inputs, compute a set of
// results.
const LogicUnit = EBOXUnit.compose({name: 'LogicUnit'})
      .init(function({splitter, fixups = 'inputs,control', control, addrInput, func}) {
        this.splitter = splitter;
        this.control = control;
        this.addrInput = addrInput;
        this.fixups = fixups;
        this.func = func;
      }).methods({

        get() {
          console.log(`${this.name} needs a 'get()' implementation`);
          return 0n;
        },
      });
module.exports.LogicUnit = LogicUnit;


////////////////////////////////////////////////////////////////
// Given a function selector and a set of inputs, compute a set of
// results.
const ShiftMult = EBOXUnit.compose({name: 'ShiftMult'})
      .init(function({shift = 1}) {
        this.shift = BigInt(shift);
      }).methods({
        getInputs() {return this.inputs.getInputs() << this.shift },
      });
module.exports.ShiftMult = ShiftMult;


////////////////////////////////////////////////////////////////
// Given a function selector and a set of inputs, compute a set of
// results.
const ShiftDiv = EBOXUnit.compose({name: 'ShiftDiv'})
      .init(function({shift = 1}) {
        this.shift = BigInt(shift);
      }).methods({
        getInputs() {return this.inputs.getInputs() >> this.shift },
      });
module.exports.ShiftDiv = ShiftDiv;


////////////////////////////////////////////////////////////////
// Compute N+k for a given input. Can be used to subtract using
// negative k.
const Adder = EBOXUnit.compose({name: 'Adder'})
      .init(function({k = 1}) {
        this.k = k;
      }).methods({
        getInputs() {return this.inputs.getInputs() + this.k},
      });
module.exports.ShiftDiv = ShiftDiv;


////////////////////////////////////////////////////////////////
// Wire up an EBOX block diagram.

// RAMs

// CRAM_IN is used to provide a uWord to CRAM when loading it.
const CRAM_IN = ConstantUnit({name: 'CRAM_IN', bitWidth: 84, value: 0n});
const CRAM = RAM({name: 'CRAM', nWords: 2048, bitWidth: 84,
                  control: 'ZERO', inputs: 'CRAM_IN', addrInput: 'CRADR'});
const CR = Reg({name: 'CR', bitWidth: 84, inputs: 'CRAM'});

// Complex CRAM address calculation logic goes here...
const CRADR = ConstantUnit.init(function({stackDepth = 4}) {
  this.stackDepth = stackDepth;
  this.reset();
}).methods({

  reset() {
    this.value = 0n;
    this.force1777 = false;
    this.stack = [];
  },

  getInputs() {

    if (this.force1777) {
      this.force1777 = false;

      // Push return address from page fault handler.
      this.stack.push(this.value);

      if (this.debugTrace) console.log(`${this.name} force1777`);
      return this.latchedValue = 0o1777n;
    } else {
      const skip = CR.SKIP.getInputs();
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

      const disp = CR.DISP.getInputs();

      switch (disp) {

      // See schematics p. 344 and
      // EK-EBOX-all p. 256 for explanation.
      // FE0*4 + MQ34*2 + MQ35; implies MQ SHIFT, AD LONG
      case CR.DISP.MUL:
        if (FE.getInputs() >= 0o1000n) orBits |= 0o04n;
        orBits |= MQ.getInputs() & 3n;
        break;

      case CR.DISP['DRAM J']:
        orBits = DR.J.getInputs() & 0o17n;
        break;

      case CR.DISP['RETURN']:   // POPJ return--may not coexist with CALL
        orBits = this.stack.pop();
        break;

      case CR.DISP['DRAM B']:   // 8 WAYS ON DRAM B FIELD
        orBits = DR.B.getInputs();
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

      const result = this.latchedValue = orBits | CR.J.get();

      if (!EBOX.resetActive && this.debugTrace)
        console.log(`${this.name} getInputs = ${octal(result)}`);

      return result;
    }
  },
}) ({name: 'CRADR', bitWidth: 11});

const excludeCRAMfields = `U0,U21,U23,U42,U45,U48,U51,U73`.split(/,/);
defineBitFields(CR, defines.CRAM, excludeCRAMfields);


// This clock is pulsed in next cycle after IR is stable but not on
// prefetch.
const DR_CLOCK = Clock({name: 'DR_CLOCK'});

// Complex DRAM address calculation logic goes here...
const DRA = ConstantUnit.methods({

  reset() {
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
      // Replace DRA4-10 with IRAC
      a = fieldInsert(a, ac, 4, 10, addrWidth);
    } else if ((op & 0o774n) === 0o700n) { // I/O instruction to internal dev
      // DRA3-5 = 7 (x on Fig 1-4 p. 19)
      a = fieldInsert(a, 7, 3, 5, addrWidth);
      // DRA6-8 = IR10-12
      a = fieldInsert(a, fieldExtract(ir, 10, 12, IR.bitWidth), 6, 8, addrWidth);
    } else if ((op & 0o700n) === 0o700n) { // I/O instruction to external dev
      // DRA3-5,6-8 = IR7-9,10-12 (x on Fig 1-4 p. 19)
      a = fieldInsert(a, fieldExtract(ir, 7, 12, IR.bitWidth), 3, 8, addrWidth);
    }

    if (!EBOX.resetActive) console.log(`DRA=${octal(a)}`);
    return a;
  },
}) ({name: 'DRA', bitWidth: 9, debugTrace: true});

// DRAM_IN is used to provide a word to DRAM when loading it.
const DRAM_IN = ConstantUnit({name: 'DRAM_IN', bitWidth: 24, value: 0n});
const DRAM = RAM({name: 'DRAM', nWords: 512, bitWidth: 24,
                  control: 'ZERO', inputs: 'DRAM_IN', addrInput: 'DRA'});
const DR = Reg.methods({name: 'DR', bitWidth: 24, clock: DR_CLOCK, inputs: 'DRAM'});
defineBitFields(DR, defines.DRAM);

const LOAD_AC_BLOCKS = Clock({name: 'LOAD_AC_BLOCKS'});
const CURRENT_BLOCK = Reg({name: 'CURRENT_BLOCK', bitWidth: 3, clock: LOAD_AC_BLOCKS,
                           inputs: 'EBUS'});

const ARX_14_17 = BitField({name: 'ARX_14_17', s: 14, e: 17, inputs: 'ARX'});
const VMA_32_35 = BitField({name: 'VMA_32_35', s: 32, e: 35, inputs: 'VMA'});


// This clock is pulsed when an instruction is on AD, ready for IR to
// latch it for decoding and execution.
const IR_CLOCK = Clock({name: 'IR_CLOCK'});

// Instruction register. This flows from CACHE (eventually) and AD.
// This is ECL 10173 with flow through input to output while !HOLD
// (HOLD DRAM B) whose rising edge latches inputs.
const IR = Reg.methods({

  latch() {
    const cond = CR.COND.getInputs();

    if (cond == CR.COND['LOAD IR']) {
      this.latchedValue = this.inputs.getInputs();
    }
  },
}) ({name: 'IR', bitWidth: 12, clock: IR_CLOCK, inputs: 'AD'});

// AC subfield of IR.
const IRAC = BitField({name: 'IRAC', s: 9, e: 12, inputs: 'IR'});


const FM_ADR = LogicUnit.methods({
  
  getInputs() {
    let acr;
    
    switch(this.addrInput.getInputs()) {
    default:
    case CR.FMADR.AC0:
      return IRAC.getInputs();
    case CR.FMADR.AC1:
      return (IRAC.getInputs() + 1) & 15n;
    case CR.FMADR.XR:
      return ARX_14_17.getInputs();
    case CR.FMADR.VMA:
      return VMA_32_35.getInputs();
    case CR.FMADR.AC2:
      return  (IRAC.getInputs() + 2) & 15n;
    case CR.FMADR.AC3:
      return (IRAC.getInputs() + 3) & 15n;
    case CR.FMADR['AC+#']:
      return (IRAC.getInputs() + MAGIC_NUMBER.getInputs()) & 15n;
    case CR.FMADR['#B#']:
      // THIS NEEDS TO BE MAGIC_NUMBER<4:0> defining 10181 function (LSB is BOOLE).
      return MAGIC_NUMBER.getInputs() & 15n;
    }
  },
}) ({name: 'FM_ADR', bitWidth: 4, addrInput: CR.FMADR, inputs: 'IRAC,ARX,VMA,MAGIC_NUMBER'});

const FMA = BitCombiner({name: 'FMA', bitWidth: 7, inputs: 'CR.ACB,FM_ADR'});
const FM = RAM({name: 'FM', nWords: 8*16, bitWidth: 36, debugTrace: true,
                control: FieldMatcher({name: 'FM_WRITE', inputs: 'CR.COND',
                                       debugTrace: true,
                                       matchValue: 'CR.COND["FM WRITE"]'}),
                inputs: 'AR', addrInput: 'FMA'});


const ALU10181 = StampIt.init(function({bitWidth = 36}) {
  this.bitWidth = bitWidth = BigInt(bitWidth);
  this.ONES = (1n << bitWidth) - 1n;
  this.name = 'ALU10181';
}).methods({

  add(a, b, cin = 0n) {
    const sum = (a + b + cin);
    this.cout = sum > this.ONES ? 1n : 0n;
    return sum & this.ONES;
  },

  sub(a, b, cin = 0n) {
    const diff = (a - b - cin);
    this.cout = diff > this.ONES ? 1n : 0n;
    return diff & this.ONES;
  },

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

  this.getCarry = EBOXUnit.init(function({parentALU}) {
    this.parentALU = parentALU;
  }).methods({

    getInputs() {
      return this.parentALU.cout;
    },
    }) ({name: this.name + '.getCarry', bitWidth: 1, parentALU: this});
}).methods({

  do(aluFunction, a, b, cin = 0n) {
    const v = this.alu.do(aluFunction, a, b, cin);
    this.cout = v.cout;
    return v.value;
  },

  getInputs() {
    const func = Number(this.func.getInputs());
    const f = func & 0o37;
    const a = this.inputs[0].getInputs();
    const b = this.inputs[1].getInputs();
    const cin = (func & 0o40) ? 1n : this.inputs[2].getInputs();

    // XXX CIN is affected by p. 364 E7/E8/E19 grid A4-5.
    // When that isn't true, CIN is ADX COUT.
    //
    // Also note that SPEC/XCRY AR0 means AD XORed with AR00
    //
    // Also note the schematic symbols XXX CRY 36 mean the carry INTO
    // the LSB of the adder for XXX (i.e., from a bit to the right).

    switch(func) {
    case CR.AD['A+1']:      return this.do(f, a, cin);
    case CR.AD['A+XCRY']:   return this.do(f, a, cin);
    case CR.AD['A+ANDCB']:  return this.do(f, a);
    case CR.AD['A+AND']:    return this.do(f, a);
    case CR.AD['A*2']:      return this.do(f, a, a);
    case CR.AD['A*2+1']:    return this.do(f, a, a, 1n);
    case CR.AD['OR+1']:     return this.do(f, a, a, cin);
    case CR.AD['OR+ANDCB']: return this.do(f, a, a);
    case CR.AD['A+B']:      return this.do(f, a, b);
    case CR.AD['A+B+1']:    return this.do(f, a, b, cin);
    case CR.AD['A+OR']:     return this.do(f, a, b);
    case CR.AD['ORCB+1']:   return this.do(f, a, b, cin);
    case CR.AD['A-B-1']:    return this.do(f, a, b);
    case CR.AD['A-B']:      return this.do(f, a, b, cin);
    case CR.AD['AND+ORCB']: return this.do(f, a, b, cin);
    case CR.AD['XCRY-1']:   return this.do(f, a, b, cin);
    case CR.AD['ANDCB-1']:  return this.do(f, a, b);
    case CR.AD['AND-1']:    return this.do(f, a, b);
    case CR.AD['A-1']:      return this.do(f, a, b);
    }

    return 0n;
  },
});

const ADX = DataPathALU({name: 'ADX', bitWidth: 36, func: CR.AD,
                         fixups: '[inputs],func',
                         inputs: 'ADXA, ADXB, ZERO'});

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
const AD = DataPathALU({name: 'AD', bitWidth: 38, func: CR.AD,
                        inputs: 'ADB, ADA, ZERO'});


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

          switch (CR.COND.getInputs()) {
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
          switch (CR.VMA.getInputs()) {
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
        },
      }) ({name: 'VMA', bitWidth: 35 - 13 + 1});

const PC = Reg({name: 'PC', bitWidth: 35 - 13 + 1, inputs: 'VMA'});

const AD_13_35 = BitField({name: 'AD_13_35', s: 13, e: 35, inputs: 'AD'});
const ADR_BREAK = Reg({name: 'ADR BREAK', bitWidth: 35 - 13 + 1, inputs: 'AD_13_35'});

const VMA_HELD = Reg({name: 'VMA HELD', bitWidth: 35 - 13 + 1, inputs: 'VMA'});

const AD_13_17 = BitField({name: 'AD_13_17', s: 13, e: 17, inputs: 'AD'});
const VMA_PREV_SECT = Reg({name: 'VMA PREV SECT', bitWidth: 17 - 13 + 1, inputs: 'AD_13_17'});

const MQ = LogicUnit.methods({

  getInputs() {

    // Our complex operations are selected by COND/REG CTL
    if (CR.COND.getInputs() === CR.COND['REG CTL']) {
      const MQ_CTL = CR['MQ CTL'];

      if (MQ.getInputs() === MQ['MQ SEL']) {

        switch (MQ_CTL.getInputs()) {
        default:
        case MQ_CTL.MQ:
          return this.latchedValue;

        case MQ_CTL['MQ*2']:
          return (this.latchedValue << 1n) | ADX.getInputs() & 1;

        case MQ_CTL['MQ*.5']:
          return (this.latchedValue >> 1n) & ~(maskForBit(0)  |
                                               maskForBit(6)  |
                                               maskForBit(12) |
                                               maskForBit(18) |
                                               maskForBit(24) |
                                               maskForBit(30));

        case MQ_CTL['0S']:
          return 0n;
        }
      } else {                  // Must be MQ/MQM SEL

        switch (MQ_CTL.getInputs()) {
        default:
        case MQ_CTL['SH']:
          return SH.getInputs();

        case MQ_CTL['MQ*.25']:
          return ((this.latchedValue >> 2n) & ~(3n << 34n)) | (ADX.getInputs() << 34n);

        case MQ_CTL['1S']:
          return ONES.get();

        case MQ_CTL['1S']:
          return AD.getInputs();
        }
      }
    }

    return 0n;
  },
}) ({name: 'MQ', bitWidth: 36,
     // ZERO is complex above
     inputs: 'ZERO, SH, ONES, AD'});


// POSSIBLY MISSING REGISTERS:
// Stuff from M8539 module in upper-left corner of p. 137:
// MCL, CURRENT BLOCK, PREV BLOCK


////////////////////////////////////////////////////////////////
// BitField splitters used by various muxes and logic elements.
const AR_00_08 = BitField({name: 'AR_00_08', s: 0, e: 8, inputs: 'AR'});
const AR_EXP = BitField({name: 'AR_EXP', s: 1, e: 8, inputs: 'AR'});
const AR_SIZE = BitField({name: 'AR_SIZE', s: 6, e: 11, inputs: 'AR'});
const AR_POS = BitField({name: 'AR_POS', s: 0, e: 5, inputs: 'AR'});
// XXX needs AR18 to determine direction of shift
const AR_SHIFT = BitField({name: 'AR_SHIFT', s: 28, e: 35, inputs: 'AR'});
const AR_00_12 = BitField({name: 'AR_00_12', s: 0, e: 12, inputs: 'AR'});
const AR_12_36 = BitField({name: 'AR_12_35', s: 12, e: 35, inputs: 'AR'});

////////////////////////////////////////////////////////////////
// Logic units.
const BRx2 = ShiftMult({name: 'BRx2', inputs: 'BR', shift: 1, bitWidth: 36});
const ARx4 = ShiftMult({name: 'ARx4', inputs: 'AR', shift: 1, bitWidth: 36});
const BRXx2 = ShiftMult({name: 'BRXx2', inputs: 'BRX', shift: 1, bitWidth: 36});
const ARXx4 = ShiftMult({name: 'ARXx4', inputs: 'ARX', shift: 1, bitWidth: 36});


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
    const func = Number(this.func.getInputs());
    const a = this.inputs[0].getInputs();
    const b = this.inputs[1].getInputs();

    switch(func) {
    default:
    case CR.SCAD.A:        return this.alu.do(0o00, a, b);
    case CR.SCAD['A-B-1']: return this.alu.do(0o11, a, b);
    case CR.SCAD['A+B']:   return this.alu.do(0o06, a, b);
    case CR.SCAD['A-1']:   return this.alu.do(0o17, a, b);
    case CR.SCAD['A+1']:   return this.alu.do(0o00, a, b, 1n);
    case CR.SCAD['A-B']:   return this.alu.do(0o11, a, b, 1n);
    case CR.SCAD.OR:       return this.alu.do(0o04, a, b);
    case CR.SCAD.AND:      return this.alu.do(0o16, a, b, 1n);
    }
  },
}) ({name: 'SCAD', bitWidth: 10, inputs: 'SCADA, SCADB', func: CR.SCAD});

const FEcontrol = LogicUnit.compose({name: 'FEcontrol'})
      .methods({

        // This takes the two CR fields we depend on for our
        // control function and returns
        // 0: LOAD
        // 1: SHIFT RIGHT
        // 2: SHIFT LEFT
        // 3: HOLD
        getInputs() {

          if (CR.FE.getInputs())
            return 0;
          else if (CR.COND.getInputs() == CR.COND['FE SHRT'])
            return 1;
          else
            return 3;
        },

      }) ({name: 'FEcontrol', bitWidth: 2, inputs: 'CR'});

const FE = ShiftReg({name: 'FE', control: FEcontrol, inputs: 'SCAD', bitWidth: 10});

const SH = LogicUnit.methods({

  getInputs() {
    const count = SC.getInputs();
    const func = this.func.getInputs();

    switch (func) {
    default:
    case 0:
      const arx0 = ARX.getInputs();
      const src0 = (AR.getInputs() << 36n) | arx0;
      return (count < 0 || count > 35) ? arx0 : src0 << count;

    case 1:
      return AR.getInputs();

    case 2:
      return ARX.getInputs();

    case 3:
      const src3 = AR.getInputs();
      return (src3 >> 18) | (src3 << 18);
    }
  },
}) ({
  name: 'SH',
  bitWidth: 36,
  func: CR.SH,
});


////////////////////////////////////////////////////////////////
// Muxes
const ADA = Mux({name: 'ADA', control: CR.ADA, bitWidth: 36,
                 inputs: 'ZERO, ZERO, ZERO, ZERO, AR, ARX, MQ, PC'});

const ADB = Mux({name: 'ADB', bitWidth: 36, control: CR.ADB,
                 inputs: 'FM, BRx2, BR, ARx4'});

const ADXA = Mux({name: 'ADXA', bitWidth: 36, control: CR.ADA,
                  inputs: 'ZERO, ZERO, ZERO, ZERO, ARX, ARX, ARX, ARX'});

const ADXB = Mux({name: 'ADXB', bitWidth: 36, control: CR.ADB,
                  inputs: 'ZERO, BRXx2, BRX, ARXx4'});

const ARSIGN_SMEAR = LogicUnit.methods({
  getInputs() {
    return BigInt(+!!(AR.getInputs() & maskForBit(0, 9)));
  },
}) ({name: 'ARSIGN_SMEAR', bitWidth: 9, inputs: 'AR'});

const SCAD_EXP = BitField({name: 'SCAD_EXP', s: 0, e: 8, inputs: 'SCAD'});
const SCAD_POS = BitField({name: 'SCAD_POS', s: 0, e: 5, inputs: 'SCAD'});
const PC_13_17 = BitField({name: 'PC_13_17', s: 13, e: 17, inputs: 'PC'});

const VMA_PREV_SECT_13_17 = BitField({name: 'VMA_PREV_SECT_13_17', s: 13, e: 17,
                                      inputs: 'VMA_PREV_SECT'});

const MAGIC_NUMBER = CR['#'];

const ARMML = Mux({name: 'ARMML', bitWidth: 9, control: CR.ARMM, 
                   inputs: 'MAGIC_NUMBER, ARSIGN_SMEAR, SCAD_EXP, SCAD_POS'});

const ARMMR = Mux.methods({
  getInputs() {
    return BigInt(+!!(CR.VMAX.getInputs() & CR.VMAX['PREV SEC']));
  },
}) ({name: 'ARMMR', bitWidth: 17 - 13 + 1,
     inputs: 'PC_13_17, VMA_PREV_SECT_13_17',
     control: CR.VMAX});


const ARMM = BitCombiner({name: 'ARMM', bitWidth: 9 + 5, inputs: 'ARMML, ARMMR'});

const ADx2 = ShiftMult({name: 'ADx2', inputs: 'AD', shift: 1, bitWidth: 36});
const ADdiv4 = ShiftDiv({name: 'ADdiv4', inputs: 'AD', shift: 2, bitWidth: 36});

const SERIAL_NUMBER = ConstantUnit.methods({

  reset() {
    this.value = BigInt(EBOX.serialNumber);
  },
}) ({name: 'SERIAL_NUMBER', value: 0n, bitWidth: 18});


// XXX very temporary. Needs implementation.
const EBUS = ZERO;

// XXX very temporary. Needs implementation.
const CACHE = ZERO;

const ARMR = Mux({name: 'ARMR', bitWidth: 18, control: CR.AR,
                  inputs: 'SERIAL_NUMBER, CACHE, ADX, EBUS, SH, ADx2, ADdiv4'});

// XXX This is wrong in many cases
const ARML = Mux.methods({
}) ({name: 'ARML', bitWidth: 18, control: CR.AR,
     inputs: 'AR, CACHE, AD, EBUS, SH, ADx2, ADX, ADdiv4'});

const ARL = Reg({name: 'ARL', bitWidth: 18, inputs: 'ARML'});
const ARR = Reg({name: 'ARR', bitWidth: 18, inputs: 'ARMR'});

const ARX = LogicUnit.methods({

  getInputs() {
    const ARX = CR.ARX;

    // Our complex operations are selected by ARX/
    switch (ARX.getInputs()) {
    default:
    case ARX.MEM:
    case ARX.ARX:
      return this.latchedValue;

    case ARX.CACHE:
      return 0n;                // XXX someday...

    case ARX.AD:
      return AD.getInputs();

    case ARX.MQ:
      return MQ.getInputs();

    case ARX.SH:
      return SH.getInputs();

    case ARX['ADX*2']:
      return ADX.getInputs() << 1n | ((MQ.getInputs() >> 35n) & 1);

    case ARX.ADX:
      return ADX.getInputs();

    case ARX['ADX*.25']:
      return ADX.getInputs() >> 2n | (AD.getInputs() & 3n);
    }
  },
}) ({name: 'ARX', bitWidth: 36,
     control: 'CR.ARX',
     // The ZERO inputs are complex as above
     inputs: 'ARX, CACHE, AD, MQ, SH, ZERO, ADX, ZERO',
    });

// E.g.
// AR_AR AND ADMSK	"ADMSK,ADB/FM,ADA/AR,AD/AND,AR/AD"
// FETCH		"MEM/IFET"
// U 1072: VMA_AR AND ADMSK,FETCH,J/NOP
const AR = BitCombiner({name: 'AR', inputs: 'ARL, ARR'});
const BR = Reg({name: 'BR', bitWidth: 36, inputs: 'AR'});
const BRX = Reg({name: 'BRX', bitWidth: 36, inputs: 'ARX'});

const SC = LogicUnit.methods({

  getInputs() {
    const SCM_ALT = CR['SCM ALT'];
    const SPEC = CR.SPEC.getInputs();

    // Our complex operations are selected by SC/ and SPEC/SCM ALT
    if (CR.SC.getInputs() === 0n) {      // Either recirculate or FE
      return SPEC !== SCM_ALT ? this.latchedValue : FE.getInputs();
    } else {

      if (SPEC !== SCM_ALT) {
        return SCAD.getInputs();
      } else {
        const ar = AR.getInputs();
        const ar18filled = ((ar >> 18n) & 1n) ? 0o777777000000n : 0n;
        return ar18filled | ar & 0o377n; // smear(AR18),,ar28-35
      }
    }
  },
}) ({name: 'SC', bitWidth: 10, inputs: 'SC, FE, AR, SCAD'});


const SCADA = Mux({name: 'SCADA', bitWidth: 10, control: CR.SCADA,
                   inputs: 'ZERO, ZERO, ZERO, ZERO, FE, AR_POS, AR_EXP, MAGIC_NUMBER'});

const SCADB = Mux({name: 'SCADB', bitWidth: 10, control: CR.SCADB,
                   // XXX This input #3 is shown as "0,#" in p. 137
                   inputs: 'FE, AR_SIZE, AR_00_08, MAGIC_NUMBER'});

const SCD_FLAGS = Reg({name: 'SCD_FLAGS', bitWidth: 13, inputs: 'AR_00_12'});
const VMA_FLAGS = Reg({name: 'VMA_FLAGS', bitWidth: 13, inputs: 'ZERO' /* XXX */});
const PC_PLUS_FLAGS = BitCombiner({name: 'PC_PLUS_FLAGS', bitWidth: 36,
                                   inputs: 'SCD_FLAGS, PC'});
const VMA_PLUS_FLAGS = BitCombiner({name: 'VMA_PLUS_FLAGS', bitWidth: 36,
                                    inputs: 'VMA_FLAGS, VMA_HELD'});

const VMA_HELD_OR_PC = Mux.methods({
  getInputs() {
    return +(CR.COND.getInputs() === CR.COND['VMA HELD']);
  },
}) ({name: 'VMA HELD OR PC', bitWidth: 36, inputs: 'PC, VMA_HELD', control: CR.COND});


////////////////////////////////////////////////////////////////
// System memory.
//
// The `control` input is the EBOX request type, directly accessed out
// of the CR.MEM field.
const MBOX = RAM.methods({

  getInputs() {
    const op = this.control.getInputs(); // MEM/op
    let v = 0n;

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

    return v;
  },
}) ({name: 'MBOX', nWords: 4n * 1024n * 1024n, bitWidth: 36, debugTrace: true,
     inputs: 'MBUS', addrInput: 'VMA', control: 'CR.MEM'});

const MBUS = Reg({name: 'MBUS', bitWidth: 36, inputs: 'ZERO', debugTrace: true});


// Parse a sequence of microcode field definitions (see define.mic for
// examples) and return BitField stamps for each of the fields.
// Pass an array of field names to ignore (for CRAM unused fields).
function defineBitFields(input, s, ignoreFields = []) {
  const inputs = input;         // BitField does not get input transformation
  let curField = undefined;

  return s.split(/\n/).forEach(line => {
    const m = line.match(/^(?<name>[^\/;]+)\/=<(?<ss>\d+):(?<es>\d+)>.*/);

    // Define a subfield of `input`, but only if it is not an unused CRAM field
    if (m) {
      const {name, ss, es} = m.groups;

      if (name && !ignoreFields.includes(name)) {
        const s = parseInt(ss);
        const e = parseInt(es);
        const bitWidth = e - s + 1;
        curField = BitField({name: `${input.name}['${name}']`, s, e, inputs, bitWidth});
        input[name] = curField;
      }
    } else {                    // Define a constant name for this subfield
      const m = line.match(/^\s+(?<name>[^=;]+)=(?<value>\d+).*/);

      if (m) {
        const {name, value} = m.groups;

        if (name) {

          if (curField) {
            curField[name] = BigInt(parseInt(value, 8));
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


// Transform comma separated lists (strings) of Units and BitFields
// into object references for the various Fixupable properties (e.g.,
// `input`, `control`).
Fixupable.fixup();

// Export every EBOXUnit
module.exports = Object.assign(module.exports, EBOX.units);
