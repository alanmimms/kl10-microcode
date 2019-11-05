'use strict';
const _ = require('lodash');
const fs = require('fs');
const util = require('util');
const StampIt = require('@stamp/it');


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


// Array containing the bit mask indexed by PDP-10 numbered bit number.
const maskForBit = (n, width = 36) => BigInt(Math.pow(2, width - 1 - n));

// The shift right count to get PDP10 bit #n into LSB.
const shiftForBit = (n, width = 36) => BigInt(BigInt(width) - 1n - BigInt(n));


// This is a mixin for anything with a `this.name` property and a
// `this.fixups` property, where `fixups` is comma separated list of
// property names on `this` whose value is itself a comma separated
// list of names to convert (in place) from string to array of object
// refs. This allows forward refernces to objects in more than one
// property on our Stamps, resolving these foward references for all
// Stamps that use this mixin facility after all Stamps that are
// defined by calling Fixupable.fixup().
const Fixupable = StampIt({name: 'Fixupable'})
      .statics({
        needsFixup: [],

        // Called at end of declarations to transform the `inputs`
        // string of comma-separated names into an array of real objects.
        fixup() {

          Fixupable.needsFixup.forEach(fu => {
            if (fu.fixupsDebug) debugger;
            if (!fu.fixups || typeof fu.fixups !== 'string') return;

            fu.fixups.split(/,\s*/).forEach(fuName => {
              if (typeof fu[fuName] !== 'string') return;

              fu[fuName] = fu[fuName].split(/,\s*/)
                .map(fi => {
                  const resolution = eval(fi);

                  if (typeof resolution === undefined) {
                    console.error(`Fixupable: ${fu.name}.${fuName} ${fi} is not defined`);
                  }
                  
                  return resolution;
                });
            });
          });
        },
      }).init(function({fixups = 'inputs', fixupsDebug = false}) {
        this.fixups = fixups;
        this.fixupsDebug = fixupsDebug;
        Fixupable.needsFixup.push(this);
      });


// All of our Units need to have a name for debugging and display.
const Named = StampIt({name: 'Named'})
      .init(function({name}) {
        this.name = name;
      });


const Clock = Named.init(function({drives = []}) {
        this.drives = drives;
      }).methods({

        addUnit(unit) {
          this.drives.push(unit);
        },

        clockEdge() {
        },
      });


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
})
.methods({

  reset() {
    this.unitArray = Object.keys(this.units).map(name => this.units[name]);

    // Reset every Unit back to initial value.
    this.unitArray.forEach(unit => unit.reset());

    // RESET always generates a bunch of clocks with zero CRAM and DRAM.
    _.range(10).forEach(k => {
      this.latch();
      this.clockEdge();
    });
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
  
}) ({name: 'EBOX', serialNumber: 4042});
module.exports.EBOX = EBOX;


const EBOXUnit = StampIt.compose(Fixupable, {
  name: 'EBOXUnit',
}).init(function({name, bitWidth, inputs = '', clock = EBOX.clock}) {
  this.name = name;
  EBOX.units[this.name] = this;
  this.inputs = inputs;
  this.clock = clock;
  this.value = this.latchedValue = 0n;

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
      .init(function({name, s, e, inputs = ''}) {
        this.name = name;
        this.s = s;
        this.e = e;
        this.inputs = inputs;
        this.bitWidth = BigInt(e - s + 1);
        this.shift = shiftForBit(e, this.inputs[0].bitWidth);
        this.mask = (1n << BigInt(this.bitWidth)) - 1n;
      }).methods({

        get() {
          return this.getInputs();
        },

        getInputs() {
          const v = this.inputs[0].getInputs();
          return (BigInt.asUintN(Number(this.bitWidth) + 1, v) >> this.shift) & this.mask;
        },
      });
module.exports.BitField = BitField;


////////////////////////////////////////////////////////////////
// Use this for inputs that are always zero.
const ConstantUnit = EBOXUnit.compose({name: 'ConstantUnit'})
      .init(function ({name, value, bitWidth = 36n}) {
        this.name = name;
        this.inputs = [];       // To avoid "is not defined" messages from FixupableInputs
        this.constant = true;
        this.value = value >= 0 ? value : BigInt.asUintN(Number(bitWidth), value);
      }).methods({
        latch() {},
        clockEdge() {},
        getInputs() {return this.value},
        get() {return this.value},
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
      .init(function({nWords, fixups = 'inputs,control', 
                      control = ZERO, addrInput, initValue = 0n}) {
        this.nWords = nWords,
        this.fixups = fixups;
        this.control = control;
        this.writeCycle = false;
        this.addrInput = addrInput;
        this.initValue = initValue;
        this.latchedValue = this.value = initValue;
        this.latchedAddr = 0;
        this.reset();
      }).methods({

        reset() {
          this.data = _.range(this.nWords).map(x => this.initValue);
        },

        get() { return this.value },

        clockEdge() {

          if (this.writeCycle) {
            this.data[this.latchedAddr] = this.value = this.latchedValue;
          } else {
            this.latchedValue = this.value = this.data[this.latchedAddr];
          }
        },

        latch() {
          this.writeCycle = !!this.control.getInputs();
          this.latchedAddr = this.addrInput.getInputs();
          if (this.writeCycle) this.latchedValue = this.getInputs();
        },
      });
module.exports.RAM = RAM;


////////////////////////////////////////////////////////////////
// Given a control input and a series of selectable inputs, produce
// the value of the selected input on the output.
const Mux = EBOXUnit.compose({name: 'Mux'})
      .init(function({fixups = 'inputs,control', control}) {
        this.control = control;
        this.fixups = fixups;
      }).methods({

        getInputs() {
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
          this.latchedValue = this.inputs[0].getInputs();
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
      .init(function({splitter, fixups = 'inputs,control', control, func}) {
        this.splitter = splitter;
        this.control = control;
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
        getInputs() {return this.inputs[0].getInputs() << this.shift },
      });
module.exports.ShiftMult = ShiftMult;


////////////////////////////////////////////////////////////////
// Given a function selector and a set of inputs, compute a set of
// results.
const ShiftDiv = EBOXUnit.compose({name: 'ShiftDiv'})
      .init(function({shift = 1}) {
        this.shift = BigInt(shift);
      }).methods({
        getInputs() {return this.inputs[0].getInputs() >> this.shift },
      });
module.exports.ShiftDiv = ShiftDiv;


////////////////////////////////////////////////////////////////
// Compute N+k for a given input. Can be used to subtract using
// negative k.
const Adder = EBOXUnit.compose({name: 'Adder'})
      .init(function({k = 1}) {
        this.k = k;
      }).methods({
        getInputs() {return this.inputs[0].getInputs() + this.k},
      });
module.exports.ShiftDiv = ShiftDiv;


////////////////////////////////////////////////////////////////
// Wire up an EBOX block diagram.

// RAMs

// Complex CRAM address calculation logic goes here...
const CRAM_ADDR = LogicUnit.methods({
}) ({name: 'CRAM_ADDR', bitWidth: 11});

// CRAM_IN is used to provide a uWord to CRAM when loading it.
const CRAM_IN = ConstantUnit({name: 'CRAM_IN', bitWidth: 84, value: 0n});
const CRAM = RAM({name: 'CRAM', nWords: 2048, bitWidth: 84,
                  inputs: 'CRAM_IN', addrInput: CRAM_ADDR});
const CR = Reg({name: 'CR', bitWidth: 84, inputs: 'CRAM'});

const excludeCRAMfields = `U0,U21,U23,U42,U45,U48,U51,U73`.split(/,/);
defineBitFields(CR, defines.CRAM, excludeCRAMfields);

// Complex DRAM address calculation logic goes here...
const DRAM_ADDR = LogicUnit.methods({
  // XXX this needs to be defined
}) ({name: 'DRAM_ADDR', bitWidth: 9});

// DRAM_IN is used to provide a word to DRAM when loading it.
const DRAM_IN = ConstantUnit({name: 'DRAM_IN', bitWidth: 24, value: 0n});
const DRAM = RAM({name: 'DRAM', nWords: 512, bitWidth: 24,
                  inputs: 'DRAM_IN', addrInput: DRAM_ADDR});
const DR = Reg({name: 'DR', bitWidth: 24, inputs: 'DRAM'});

defineBitFields(DR, defines.DRAM);

const LOAD_AC_BLOCKS = Clock({name: 'LOAD_AC_BLOCKS'});
const CURRENT_BLOCK = Reg({name: 'CURRENT_BLOCK', bitWidth: 3, clock: LOAD_AC_BLOCKS,
                           inputs: 'EBUS'});

const ARX_14_17 = BitField({name: 'ARX_14_17', s: 14, e: 17, inputs: 'ARX'});
const VMA_32_35 = BitField({name: 'VMA_32_35', s: 32, e: 35, inputs: 'VMA'});

const FM_ADR = LogicUnit.methods({
  
  getInputs() {
    
    switch(this.control.getInputs()) {
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
      return (IRAC.getInputs() + 2) & 15n;
    case CR.FMADR.AC3:
      return (IRAC.getInputs() + 3) & 15n;
    case CR.FMADR['AC+#']:
      return (IRAC.getInputs() + MAGIC_NUMBER.getInputs()) & 15n;
    case CR.FMADR['#B#']:
      // THIS NEEDS TO BE MAGIC_NUMBER<4:0> defining 10181 function (LSB is BOOLE).
      return MAGIC_NUMBER.getInputs() & 15n;
    }
  },
}) ({name: 'FM_ADR', bitWidth: 4, control: CR.FMADR, inputs: 'IRAC,ARX,VMA,MAGIC_NUMBER'});


const FM_BLOCK = LogicUnit.methods({
  
  getInputs() {
    
    switch(this.control.getInputs()) {
    default:
    case CR.FMADR.AC0:
    case CR.FMADR.AC1:
    case CR.FMADR.XR:
    case CR.FMADR.VMA:
    case CR.FMADR.AC2:
    case CR.FMADR.AC3:
    case CR.FMADR['AC+#']:
      return CURRENT_BLOCK.getInputs();
    case CR.FMADR['#B#']:
      // THIS NEEDS TO BE MAGIC_NUMBER<4:0> defining 10181 function (LSB is BOOLE).
      return (MAGIC_NUMBER.getInputs() >> 4n) & 7n;
    }
  },
}) ({name: 'FM_BLOCK', bitWidth: 3, control: CR.FMADR,
     inputs: 'IRAC,ARX,VMA,MAGIC_NUMBER'});

const FMA = BitCombiner({name: 'FMA', inputs: 'FM_BLOCK,FM_ADR'});
const FM = RAM({name: 'FM', nWords: 8*16, bitWidth: 36,
                inputs: 'AR', addrInput: FMA});


const ALU10181 = StampIt.init(function({bitWidth = 36}) {
  this.bitWidth = bitWidth;
  this.ONES = (1n << bitWidth) - 1n;
}).methods({

  add(a, b, cin = 0n) {
  },

  sub(a, b, cin = 0n) {
  },

  do(func, a, b, cin = 0n) {

    switch (func) {
    // ARITHMETIC
    default:
    case 0o00: return this.add(a, 0n, cin);
    case 0o01: return this.add(a, a & NOT(b), cin);
    case 0o02: return this.add(a, a & b, cin);
    case 0o03: return this.add(a, a, cin);
    case 0o04: return this.add(a | b, 0n, cin);
    case 0o05: return this.add(a & NOT(b), a | b, cin);
    case 0o06: return this.add(a, b, cin);
    case 0o07: return this.add(a, a | b, cin);
    case 0o10: return {value: a | NOT(b), cout: 0n};
    case 0o11: return this.sub(a, b, 1n);
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


const AD = LogicUnit.init(function() {
  this.alu = ALU10181({bitWidth: 38});
}).methods({

  do(aluFunction, a, b, cin = 0n) {
    const v = this.alu.do(aluFunction, a, b, cin);
    this.cout = v.cout;
    return v.value;
  },

  getInputs() {
    const func = this.func.getInputs();
    const af = func & 0o37;
    const [a, b] = [this.inputs[0].getInputs(), this.inputs[1].getInputs()];

    // XXX CIN is affected by p. 364 E7/E8/E19 grid A4-5.
    // When that isn't true, CIN is ADX COUT.

    switch(func) {
    case CR.AD['A+1']:    return this.do(af, a, 1n);
    case CR.AD['A*2']:    return this.do(af, a, a);
    case CR.AD['A*2+1']:  return this.do(af, a, a, 1n);
    case CR.AD['A+B']:    return this.do(af, a, b);
    case CR.AD['A+B+1']:  return this.do(af, a, b, 1n);
    case CR.AD['ORCB']:   return this.do(af, a, b, 1n);
    case CR.AD['A-B-1']:  return this.do(af, a, b, 1n);
    case CR.AD['A-B']:    return this.do(af, a, b);
    case CR.AD['XCRY-1']: return this.do(af, 0n, 0n, cin);
    case CR.AD['A-1']:    return this.do(af, a, 1n);
    }

    return 0n;
  },

  getCarry() {
  },
}) ({name: 'AD', bitWidth: 38, func: CR.AD, inputs: 'ADB,ADA'});


// Instruction register. This flows from CACHE (eventually) and AD.
const IR = Reg({name: 'IR', bitWidth: 12, inputs: 'AD'});

// AC field of IR.
// This is ECL 10173 with flow through input to output while !HOLD
// (HOLD DRAM B) whose rising edge latches inputs.
const IR_09_12 = BitField({name: 'IR_09_12', s: 9, e: 12, inputs: 'IR'});
const IRAC = Reg({name:'IRAC', bitWidth: 4, inputs: 'IR_09_12'});

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
const SCAD = LogicUnit.methods({

  getInputs() {
    console.log(`${this.name} needs a 'getInputs()' implementation`);
    return 0n;
  },
}) ({name: 'SCAD', bitWidth: 10, inputs: 'SCADA, SCADB', func: CR.SCAD});

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

const ADB = Mux({name: 'ADB', bitWidth: 36, control: CR.ADB, bitWidth: 36,
                 inputs: 'FM, BRx2, BR, ARx4'});

const ADXA = Mux({name: 'ADXA', bitWidth: 36, control: CR.ADA, bitWidth: 36,
                  inputs: 'ZERO, ZERO, ZERO, ZERO, ARX, ARX, ARX, ARX'});

const ADXB = Mux({name: 'ADXB', bitWidth: 36, control: CR.ADB, bitWidth: 36,
                  inputs: 'ZERO, BRXx2, BRX, ARXx4'});

// XXX needs implementation
const ADX = LogicUnit.methods({

  getCarry() {
  },
}) ({name: 'ADX', bitWidth: 36, control: CR.AD, bitWidth: 36,
                       inputs: 'ADXA, ADXB'});

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

const ARML = Mux({name: 'ARML', bitWidth: 18, control: CR.AR,
                  inputs: 'ARMM, CACHE, ADX, EBUS, SH, ADx2, ADdiv4'});

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


function computeCPUState(newCA) {
  // First, get values from all of the LogicUnit instances based on
  // their inputs from the previous cycle.
  const SCADv = SCAD.get();
  const ADv = AD.get();
  const ADXv = ADX.get();
  const SHv = SH.get();
  const ARSIGN_SMEARv = ARSIGN_SMEAR.get();

  // Fetch new microinstruction
  CRAM.addr = newCA;
  CRAM.get();
  CR.latch();
  // XXX add a CRAM addr history ringlog here

  // Update everything based on new CR (microinstruction).

}


// Parse a sequence of microcode field definitions (see define.mic for
// examples) and return BitField stamps for each of the fields.
// Pass an array of field names to ignore (for CRAM unused fields).
function defineBitFields(input, s, ignoreFields = []) {
  const inputs = [input];       // BitField does not get input transformation
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

//EBOX.reset();
