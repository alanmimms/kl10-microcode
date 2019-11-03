'use strict';
const _ = require('lodash');
const fs = require('fs');
const util = require('util');
const StampIt = require('@stamp/it');


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
const maskForBit = (n, width = 36) => Math.pow(2, width - 1 - n);

// The shift right count to get PDP10 bit #n into LSB.
const shiftForBit = (n, width = 36) => width - 1 - n;


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
//   |                     +-- `clock()` copies `latchedValue` to `value`
//   |
//   +-- `latch()`, saves `getInputs()` value to `latchedValue`
//

////////////////////////////////////////////////////////////////
// Stamps

// Base Stamp for EBOX functional units. This is an abstract Stamp
// defining protocol but all should be completely overridden.
//
// The convention is that each EBOXUnit has a `getInputs()` method
// (sometimes with parameters) that retrieves the unit's value based
// on its current inputs and configuration. EBOXUnit uses
// `getInputs()` method to retrieve inputs and aggregates them to save
// what would be saved on the clock edge.
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
// * `clock()` copies `latchedValue` to `value`.
// * `get()` returns `value`.

const EBOX = StampIt({
}).init(function ({name, serialNumber}) {
  this.serialNumber = serialNumber;
  this.units = {};              // List of all EBOX Units
  this.unitArray = [];          // List of all EBOX Units as an array of objects
})
.methods({

  fixupInputs() {
    this.unitArray = Object.keys(this.units).map(name => this.units[name]);

    // For every EBOXUnit that has some, we transform `inputs` from
    // string to array of Units.
    this.unitArray.forEach(u => u.fixupInputs());
  },

  reset() {

    // Reset every Unit back to initial value.
    this.unitArray.forEach(unit => unit.reset());

    // RESET always generates a bunch of clocks with zero CRAM.
    _.range(10).forEach(k => {this.latch(); this.clock()});
  },

  latch() {
    this.unitArray.forEach(unit => unit.latch());
  },

  clock() {
    this.unitArray.forEach(unit => unit.clock());
  },
  
}) ({name: 'EBOX', serialNumber: 4042});
module.exports.EBOX = EBOX;


const EBOXUnit = StampIt({
  name: 'EBOXUnit',
}).init(function({name, inputs, bitWidth}) {
  this.name = name;
  EBOX.units[this.name] = this;
  this.inputs = inputs || [];
  this.value = this.latchedValue = 0n;

  // We remember if bitWidth needs to be fixed up after inputs are
  // transformed or if it was explicitly specified.
  this.specifiedBitWidth = this.bitWidth = bitWidth;

  this.reset();
}).methods({

  // Called by EBOX enumeration of all Units to transform the `inputs`
  // string of comma-separated EBOXUnit names into an array of
  // EBOXUnits.
  fixupInputs() {
    if (typeof this.inputs !== 'string') return;

    this.inputs = this.inputs.split(/,\s*/)
      .map(fi => {
        const unit = eval(fi);
        if (!unit) console.error(`In ${this.name}.inputs ${fi} is not defined`);
        return unit;
      });

//    console.log(`${this.name} inputs=[${this.inputs.map(i => i.name).join(', ')}]`);
  },

  reset() {this.latchedValue = this.value = 0n},
  get() {return this.value},
  latch() {this.latchedValue = this.getInputs()},
  clock() {this.value = this.latchedValue},

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
const BitField = StampIt.compose({name: 'BitField'})
      .init(function({name, inputs, s, e}) {
        this.name = name;
        this.s = s;
        this.e = e;
        this.inputs = inputs;
        this.nBits = e - s + 1;
        this.shift = shiftForBit(e, this.inputs[0].bitWidth);
        this.mask = (1n << BigInt(this.nBits)) - 1n;
      }).methods({
        get() {
          return this.getInputs();
        },

        getInputs() {
          const v = this.inputs[0].get();
          console.log(`${this.name}.getInputs v=${v} this=${util.inspect(this)}`);
          return (BigInt.asUintN(this.nBits + 1, v) >> this.shift) & this.mask;
        },
      });
module.exports.BitField = BitField;


////////////////////////////////////////////////////////////////
// Use this for inputs that are always zero.
const ConstantUnit = EBOXUnit.compose({name: 'ConstantUnit'})
      .init(function ({name, value, bitWidth = 36}) {
        this.name = name;
        this.constant = true;
        this.value = value >= 0 ? value : BigInt.asUintN(bitWidth, value);
      }).methods({
        latch() {},
        clock() {},
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
            v = (v << i.bitWidth) | i.get();
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
      .init(function({nWords, control = ZERO, addrInput = 0, initValue = 0n}) {
        this.nWords = nWords,
        this.control = control;
        this.writeCycle = false;
        this.addrInput = addrInput;
        this.initValue = initValue;
        this.reset();
      }).methods({

        reset() {
          this.data = new Array(this.nWords).map(x => this.initValue);
        },

        get() { return this.value },

        clock() {

          if (this.writeCycle) {
            this.data[this.latchedAddr] = this.value = this.latchedValue;
          } else {
            this.latchedValue = this.value = this.data[this.latchedAddr];
          }
        },

        latch() {
          this.writeCycle = !!this.control.get();
          this.latchedAddr = this.addrInput;
          if (this.writeCycle) this.latchedValue = this.getInputs();
        },
      });
module.exports.RAM = RAM;


////////////////////////////////////////////////////////////////
// Given a control input and a series of selectable inputs, produce
// the value of the selected input on the output.
const Mux = EBOXUnit.compose({name: 'Mux'})
      .init(function({control}) {
        this.control = control;
      }).methods({

        get() {
          return this.inputs[this.control].get();
        }
      });
module.exports.Mux = Mux;


////////////////////////////////////////////////////////////////
// Latch inputs for later retrieval.
const Reg = EBOXUnit.compose({name: 'Reg'})
      .methods({

        latch() {
          this.value = this.latched;
          this.latched = this.inputs[0].get();
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
      .init(function({control}) {
        this.control = control;
      });
module.exports.ShiftReg = ShiftReg;


////////////////////////////////////////////////////////////////
// Given a function selector and a set of inputs, compute a set of
// results.
const LogicUnit = EBOXUnit.compose({name: 'LogicUnit'})
      .init(function({splitter, func}) {
        this.splitter = splitter;
        this.func = func;
      }).methods({

        get() {
          console.log(`${this.name} needs a 'get()' implementation`);
        },
      });
module.exports.LogicUnit = LogicUnit;


////////////////////////////////////////////////////////////////
// Given a function selector and a set of inputs, compute a set of
// results.
const ShiftMult = EBOXUnit.compose({name: 'ShiftMult'})
      .init(function({multiplier = 2}) {
        this.multiplier = multiplier;
      }).methods({
        get() {return this.inputs[0].get() * this.multiplier }
      });
module.exports.ShiftMult = ShiftMult;


////////////////////////////////////////////////////////////////
// Given a function selector and a set of inputs, compute a set of
// results.
const ShiftDiv = EBOXUnit.compose({name: 'ShiftDiv'})
      .init(function({divisor = 2}) {
        this.divisor = divisor;
      }).methods({
        get() {return this.inputs[0].get() / this.divisor }
      });
module.exports.ShiftDiv = ShiftDiv;


////////////////////////////////////////////////////////////////
// Wire up an EBOX block diagram.

// RAMs
// CRAM_IN is used to provide a uWord to CRAM when loading it.
const CRAM_IN = ConstantUnit({name: 'CRAM_IN', bitWidth: 84, value: 0n});
const CRAM = RAM({name: 'CRAM', nWords: 2048, bitWidth: 84, inputs: 'CRAM_IN'});
const CR = Reg({name: 'CR', bitWidth: 84, inputs: 'CRAM'});

defineBitFields(CR, defines.CRAM, `U0,U21,U23,U42,U45,U48,U51,U73`.split(/,/));

// DRAM_IN is used to provide a word to DRAM when loading it.
const DRAM_IN = ConstantUnit({name: 'DRAM_IN', bitWidth: 24, value: 0n});
const DRAM = RAM({name: 'DRAM', nWords: 512, bitWidth: 24, inputs: 'DRAM_IN'});
const DR = Reg({name: 'DR', bitWidth: 24, inputs: 'DRAM'});

defineBitFields(DR, defines.DRAM);

const FM = RAM({name: 'FM', nWords: 8*16, bitWidth: 36, inputs: 'AR'});


const AD = LogicUnit.methods({

  get() {
    const func = this.func.get();
    console.log(`${this.name} needs a 'get()' implementation`);

    switch (func) {
    default:
    case 0:
      break;
    }
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

          switch (CR.COND) {
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
          switch (CR.VMA) {
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

const VMA_HELD = Reg({name: 'VMA HELD', inputs: 'VMA', bitWidth: 35 - 13 + 1});

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

          if (CR.FE) 
            return 0;
          else if (CR.COND == CR.COND['FE SHRT']) 
            return 1;
          else
            return 3;
        },
        
      }) ({name: 'FEcontrol', bitWidth: 2, inputs: 'CR'});

const MQ = Reg({name: 'MQ', bitWidth: 36, inputs: 'MQM'});


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
const BRx2 = ShiftMult({name: 'BRx2', inputs: 'BR', multiplier: 2, bitWidth: 36});
const ARx4 = ShiftMult({name: 'ARx4', inputs: 'AR', multiplier: 4, bitWidth: 36});
const BRXx2 = ShiftMult({name: 'BRXx2', inputs: 'BRX', multiplier: 2, bitWidth: 36});
const ARXx4 = ShiftMult({name: 'ARXx4', inputs: 'ARX', multiplier: 4, bitWidth: 36});
const MQdiv4 = ShiftDiv({name: 'MQdiv4', inputs: 'MQ', divisor: 4, bitWidth: 36});


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
  get() {
    console.log(`${this.name} needs a 'get()' implementation`);
  },
}) ({name: 'SCAD', bitWidth: 10, func: CR.SCAD});

const FE = ShiftReg({name: 'FE', control: FEcontrol, inputs: 'SCAD', bitWidth: 10});

const SH = LogicUnit.methods({

  get() {
    const count = SC.get();
    const func = this.func.get();

    switch (func) {
    default:
    case 0:
      const src0 = (AR << 36n) | ARX;
      return (count < 0 || count > 35) ? ARX.get() : src0 << count;

    case 1:
      return AR.get();

    case 2:
      return ARX.get();

    case 3:
      const src3 = AR.get();
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
const ADX = LogicUnit({name: 'ADX', bitWidth: 36, control: CR.AD, bitWidth: 36,
                       inputs: 'ADXA, ADXB'});

const ARSIGN_SMEAR = LogicUnit.methods({
  get() {
    return +!!(AR.get() & maskForBit(0, 9));
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
  get() {
    return +!!(CR.VMAX & CR.VMAX['PREV SEC']);
  },
}) ({name: 'ARMMR', bitWidth: 17 - 13 + 1,
     inputs: 'PC_13_17, VMA_PREV_SECT_13_17',
     control: CR.VMAX});


const ARMM = BitCombiner({name: 'ARMM', bitWidth: 9 + 5, inputs: 'ARMML, ARMMR'});

const ADx2 = ShiftMult({name: 'ADx2', inputs: 'AD', multiplier: 2, bitWidth: 36});
const ADdiv4 = ShiftDiv({name: 'ADdiv4', inputs: 'AD', divisor: 4, bitWidth: 36});

const SERIAL_NUMBER = ConstantUnit.methods({

  reset() {
    this.value = EBOX.serialNumber;
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

const ADXx2 = ShiftMult({name: 'ADXx2', inputs: 'ADX', multiplier: 2, bitWidth: 36});
const ADXdiv4 = ShiftDiv({name: 'ADXdiv4', inputs: 'ADX', divisor: 4, bitWidth: 36});

const ARXM = Mux({name: 'ARXM', bitWidth: 36, control: CR.ARXM,
                  inputs: 'ZERO, CACHE, AD, MQ, SH, ADXx2, ADX, ADXdiv4'});

const ARL = Reg({name: 'ARL', bitWidth: 18, inputs: 'ARML'});
const ARR = Reg({name: 'ARR', bitWidth: 18, inputs: 'ARMR'});
const ARX = Reg({name: 'ARX', bitWidth: 36, inputs: 'ARXM'});
const AR = BitCombiner({name: 'AR', inputs: 'ARL, ARR'});
const BR = Reg({name: 'BR', bitWidth: 36, inputs: 'AR'});
const BRX = Reg({name: 'BRX', bitWidth: 36, inputs: 'ARX'});
const SC = Reg({name: 'SC', bitWidth: 10, inputs: 'SCM'});

const SCM = Mux.methods({
  get() {
    return CR.SC | (+(CR.SPEC === CR.SPEC['SCM ALT']) << 1);
  },
}) ({name: 'SCM', bitWidth: 10, inputs: 'SC, FE, SCAD, AR_SHIFT',
     control: BitCombiner({name: 'SCMcontrol', bitWidth: 2,
                           inputs: 'CR.SC, CR.SPEC'})});

const SCADA = Mux({name: 'SCADA', bitWidth: 10, control: CR.SCADA,
                   inputs: 'ZERO, ZERO, ZERO, ZERO, FE, AR_POS, AR_EXP, MAGIC_NUMBER'});

const SCADB = Mux({name: 'SCADB', bitWidth: 10, control: CR.SCADB,
                   // XXX This input #3 is shown as "0,#" in p. 137
                   inputs: 'FE, AR_SIZE, AR_00_08, MAGIC_NUMBER'});

SCAD.input = [SCADA, SCADB];

const MQM = Mux({name: 'MQM', bitWidth: 36, control: CR.MQM,
                 inputs: 'ZERO, ZERO, ZERO, ZERO, MQdiv4, SH, AD, ONES'});

const SCD_FLAGS = Reg({name: 'SCD_FLAGS', bitWidth: 13, inputs: 'AR_00_12'});
const VMA_FLAGS = Reg({name: 'VMA_FLAGS', bitWidth: 13, inputs: 'ZERO' /* XXX */});
const PC_PLUS_FLAGS = BitCombiner({name: 'PC_PLUS_FLAGS', bitWidth: 36,
                                   inputs: 'SCD_FLAGS, PC'});
const VMA_PLUS_FLAGS = BitCombiner({name: 'VMA_PLUS_FLAGS', bitWidth: 36,
                                    inputs: 'VMA_FLAGS, VMA_HELD'});

const VMA_HELD_OR_PC = Mux.methods({
  get() {
    return +(CR.COND === CR.COND['VMA HELD']);
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

  return s.split(/\n/).reduce((state, line) => {
    const m = line.match(/^(?<name>[^\/;]+)\/=<(?<ss>\d+):(?<es>\d+)>.*/);

    // Define a subfield of `input`, but only if it is not an unused CRAM field
    if (m) {
      const {name, ss, es} = m.groups;

      if (name && !ignoreFields.includes(name)) {
        const s = parseInt(ss);
        const e = parseInt(es);
        const bitWidth = e - s + 1;
        state.curField = BitField({name: `${input.name}['${name}']`, s, e, inputs, bitWidth});
        state.fields.push(state.curField);
        input[name] = state.curField;
      }
    } else {                    // Define a constant name for this subfield
      const m = line.match(/^\s+(?<name>[^=;]+)=(?<value>\d+).*/);

      if (m) {
        const {name, value} = m.groups;

        if (name) {

          if (state.curField) {
            state.curField[name] = ConstantUnit({
              name: `${input.name}['${name}']`,
              value: BigInt(parseInt(value, 8)),
              bitWidth: state.curField.bitWidth,
            });
          } else {
            console.log(`ERROR: no field context for value definition in "${line}"`);
          }
        } else {
          // Ignore lines that do not match either regexp.
        }
      }
    }

    return state;
  }, {fields: [], curField: null});
}


// Transform `inputs` from comma separated string to array of Units.
EBOX.fixupInputs();


// Export every EBOXUnit
module.exports = Object.assign(module.exports, EBOX.units);

