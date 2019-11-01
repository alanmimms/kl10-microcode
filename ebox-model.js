'use strict';
const fs = require('fs');
const util = require('util');
const StampIt = require('@stamp/it');


// Split `define.mic` file to retrieve CRAM definitions section and
// DRAM definitions sections so we can parse them into definitions we
// can use.
const definesRE = new RegExp([
  /^.*\.TOC\s+"CONTROL RAM DEFINITIONS -- J, AD"/,
  /\s+(?<CRAM>.*?)(?=\.DCODE\s+)/,
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

const EBOXUnitItems = {};       // Accumulated list of EBOXUnit stamps
const EBOXUnit = StampIt({
  name: 'EBOXUnit',
}).init(function({name, inputs, bitWidth}) {
  this.name = name;
  this.value = 0n;
  this.bitWidth = bitWidth;
  EBOXUnitItems[this.name] = this;
  this.latchedValue = this.value = 0n;
  this.inputs = inputs;
  this.bitWidth = bitWidth || inputs && inputs.bitWidth;
}).methods({
  get() {return this.value},
  latch() {this.latchedValue = this.getInputs()},
  clock() {this.value = this.latchedValue},

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
      .init(function({s, e}) {
        this.s = s;
        this.e = e;
        this.nBits = e - s + 1;
        this.shift = shiftForBit(e, this.nBits);
        this.mask = (1n << BigInt(this.nBits)) - 1n;
      }).methods({

        getInputs() {
          const v = this.inputs.get();
          return (BigInt.asUintN(this.nBits + 1, v) >> this.shift) & this.mask;
        },
      });
module.exports.BitField = BitField;


////////////////////////////////////////////////////////////////
// Use this for inputs that are always zero.
const ConstantUnit = EBOXUnit.compose({name: 'ConstantUnit'})
      .init(function ({name, value, bitWidth = 36}) {
        this.name = name;
        this.value = value >= 0 ? value : BigInt.asUintN(bitWidth, value);
      });

const zero = ConstantUnit({name: 'zero', value: 0n});
const ones = ConstantUnit({name: 'ones', value: -1n});
module.exports.zero = zero;
module.exports.ones = ones;


////////////////////////////////////////////////////////////////
// Take a group of inputs and concatenate them into a single wide
// field.
const BitCombiner = EBOXUnit.compose({name: 'BitCombiner'})
      .init(function() {
        this.bitWidth = this.inputs.reduce((cur, i) => cur += i.bitWidth, 0);
      }).methods({

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
      .init(function({nWords, control = zero, addrInput = 0, elementValue = 0n}) {
        this.data = new Array(nWords).map(x => elementValue);
        this.nWords = nWords,
        this.control = control;
        this.writeCycle = false;
        this.addrInput = addrInput;
      }).methods({

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
        this.bitWidth = this.inputs.reduce((cur, i) => Math.max(cur, i), this.bitWidth || 0);
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
          this.latched = this.inputs.get();
        },
      });
module.exports.Reg = Reg;


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
        get() {return this.inputs.get() * this.multiplier }
      });
module.exports.ShiftMult = ShiftMult;


////////////////////////////////////////////////////////////////
// Given a function selector and a set of inputs, compute a set of
// results.
const ShiftDiv = EBOXUnit.compose({name: 'ShiftDiv'})
      .init(function({divisor = 2}) {
        this.divisor = divisor;
      }).methods({
        get() {return this.inputs.get() / this.divisor }
      });
module.exports.ShiftDiv = ShiftDiv;


////////////////////////////////////////////////////////////////
// Wire up an EBOX block diagram.

// RAMs
// CRAM_IN is used to provide a uWord to CRAM when loading it.
const CRAM_IN = Reg({name: 'CRAM_IN', bitWidth: 84});
const CRAM = RAM({name: 'CRAM', nWords: 2048, bitWidth: CRAM_IN.bitWidth, inputs: [CRAM_IN]});
const CR = Reg({name: 'CR', inputs: [CRAM], bitWidth: CRAM.bitWidth});

defineBitFields(CR, defines.CRAM);

// DRAM_IN is used to provide a word to DRAM when loading it.
const DRAM_IN = Reg({name: 'DRAM_IN', bitWidth: 24});
const DRAM = RAM({name: 'DRAM', inputs: [DRAM_IN], nWords: 512, bitWidth: 24});
const DR = Reg({name: 'DR', inputs: [DRAM]});

defineBitFields(DR, defines.DRAM);

// This needs its `inputs` set before a `latch()` call.
const FM = RAM({name: 'FM', nWords: 8*16, bitWidth: 36});


// Registers
const IR = Reg({name: 'IR', bitWidth: 12});
const IRAC = Reg({name: 'IRAC', bitWidth: 4});
const PC = Reg({name: 'PC', bitWidth: 35 - 13 + 1});
const ADR_BREAK = Reg({name: 'ADR BREAK', bitWidth: 35 - 13 + 1});
const VMA_HELD = Reg({name: 'VMA HELD', bitWidth: 35 - 13 + 1});
const VMA_PREV_SECT = Reg({name: 'VMA PREV SECT', bitWidth: 17 - 13 + 1});
const ARL = Reg({name: 'ARL', bitWidth: 18});
const ARR = Reg({name: 'ARR', bitWidth: 18});
const ARX = Reg({name: 'ARX', bitWidth: 36});
const BR = Reg({name: 'BR', bitWidth: 36});
const BRX = Reg({name: 'BRX', bitWidth: 36});
const SC = Reg({name: 'SC', bitWidth: 10});

const FE = Reg.compose({name: 'FE'})
      .methods({
        load() {
        },

        shrt() {
        },
      }) ({name: 'FE', bitWidth: 10});


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

const MQ = Reg.compose({name: 'MQ'})
      .methods({
        load() {
        },

        shrt() {
        },

        srlt() {
        },

        hold() {
        },
      }) ({name: 'MQ', bitWidth: 36});


// POSSIBLY MISSING REGISTERS:
// Stuff from M8539 module in upper-left corner of p. 137:
// MCL, CURRENT BLOCK, PREV BLOCK


////////////////////////////////////////////////////////////////
// BitCombiners for common register/mux aggregates
const AR = BitCombiner({name: 'AR', inputs: [ARL, ARR]});


////////////////////////////////////////////////////////////////
// BitField splitters used by various muxes and logic elements.
const AR_00_08 = BitField({name: 'AR_00_08', s: 0, e: 8, inputs: [AR]});
const AR_EXP = BitField({name: 'AR_EXP', s: 1, e: 8, inputs: [AR]});
const AR_SIZE = BitField({name: 'AR_SIZE', s: 6, e: 11, inputs: [AR]});
const AR_POS = BitField({name: 'AR_POS', s: 0, e: 5, inputs: [AR]});
// XXX needs AR18 to determine direction of shift
const AR_SHIFT = BitField({name: 'AR_SHIFT', s: 28, e: 35, inputs: [AR]});
const AR_00_12 = BitField({name: 'AR_00_12', s: 0, e: 12, inputs: [AR]});
const AR_12_36 = BitField({name: 'AR_12_35', s: 12, e: 35, inputs: [AR]});

////////////////////////////////////////////////////////////////
// Logic units.
const BRx2 = ShiftMult({name: 'BRx2', inputs: [BR], multiplier: 2});
const ARx4 = ShiftMult({name: 'ARx2', inputs: [AR], multiplier: 4});
const BRXx2 = ShiftMult({name: 'BRXx2', inputs: [BRX], multiplier: 2});
const ARXx4 = ShiftMult({name: 'ARXx4', inputs: [ARX], multiplier: 4});
const MQdiv4 = ShiftDiv({name: 'MQdiv4', inputs: [MQ], divisor: 4});


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
}) ({name: 'AD', bitWidth: 38, func: CR.AD});

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
const ADA = Mux({
  name: 'ADA',
  control: CR.ADA,
  inputs: [zero, zero, zero, zero, AR, ARX, MQ, PC]});

const ADB = Mux({
  name: 'ADB',
  bitWidth: 36,
  control: CR.ADB,
  inputs: [FM, BRx2, BR, ARx4],
});

const ADXA = Mux({
  name: 'ADXA',
  bitWidth: 36,
  control: CR.ADA,
  inputs: [zero, zero, zero, zero, ARX, ARX, ARX, ARX],
});

const ADXB = Mux({
  name: 'ADXB',
  bitWidth: 36,
  control: CR.ADB,
  inputs: [zero, BRXx2, BRX, ARXx4],
});

// XXX needs implementation
const ADX = LogicUnit({
  name: 'ADX',
  bitWidth: 36,
  control: CR.AD,
  inputs: [ADXA, ADXB],
});

const ARSIGN_SMEAR = LogicUnit.methods({
  get() {
    return +!!(AR.get() & maskForBit(0, 9));
  },
}) ({name: 'ARSIGN_SMEAR', bitWidth: 9, inputs: [AR]});

const SCAD_EXP = BitField({name: 'SCAD_EXP', s: 0, e: 8, inputs: [SCAD]});
const SCAD_POS = BitField({name: 'SCAD_POS', s: 0, e: 5, inputs: [SCAD]});
const PC_13_17 = BitField({name: 'PC_13_17', s: 13, e: 17, inputs: [PC]});

const VMA_PREV_SECT_13_17 = BitField({
  name: 'VMA_PREV_SECT_13_17',
  s: 13,
  e: 17,
  inputs: [VMA_PREV_SECT],
});

const ARMML = Mux({
  name: 'ARMML',
  bitWidth: 9,
  control: CR.ARMM,
  inputs: [CR['#'], ARSIGN_SMEAR, SCAD_EXP, SCAD_POS],
});

const ARMMR = Mux.methods({
  get() {
    return +!!(CR.VMAX & CR.VMAX['PREV SEC']);
  },
}) ({
  name: 'ARMMR',
  bitWidth: 17 - 13 + 1,
  inputs: [PC_13_17, VMA_PREV_SECT_13_17],
  control: BitCombiner({name: 'ARMMRcontrol', inputs: [CR.VMAX]}),
});


const ARMM = BitCombiner({name: 'ARMM', inputs: [ARMML, ARMMR]});

const ADx2 = ShiftMult({name: 'ADx2', inputs: [AD], multiplier: 2});
const ADdiv4 = ShiftDiv({name: 'ADdiv4', inputs: [AD], divisor: 4});

// XXX temporary. This needs to be implemented.
const SERIAL_NUMBER = zero;

// XXX very temporary. Needs implementation.
const EBUS = zero;

// XXX very temporary. Needs implementation.
const CACHE = zero;

const ARMR = Mux({
  name: 'ARMR',
  bitWidth: 18,
  control: CR.AR,
  inputs: [SERIAL_NUMBER, CACHE, ADX, EBUS, SH, ADx2, ADdiv4],
});

const ARML = Mux({
  name: 'ARML',
  bitWidth: 18,
  control: CR.AR,
  inputs: [ARMM, CACHE, ADX, EBUS, SH, ADx2, ADdiv4],
});

const ADXx2 = ShiftMult({name: 'ADXx2', inputs: [ADX], multiplier: 2});
const ADXdiv4 = ShiftDiv({name: 'ADXdiv4', inputs: [ADX], divisor: 4});

const ARXM = Mux({
  name: 'ARXM',
  bitWidth: 36,
  control: CR.ARXM,
  inputs: [zero, CACHE, AD, MQ, SH, ADXx2, ADX, ADXdiv4],
});

const SCM = Mux.methods({
  get() {
    return CR.SC | (+(CR.SPEC === CR.SPEC['SCM ALT']) << 1);
  },
}) ({
  name: 'SCM',
  bitWidth: 10,
  inputs: [SC, FE, SCAD, AR_SHIFT],
  control: BitCombiner({name: 'SCMcontrol', inputs: [CR.SC, CR.SPEC]}),
});

const SCADA = Mux({
  name: 'SCADA',
  bitWidth: 10,
  control: CR.SCADA,
  inputs: [zero, zero, zero, zero, FE, AR_POS, AR_EXP, CR['#']],
});

const SCADB = Mux({
  name: 'SCADB',
  bitWidth: 10,
  control: CR.SCADB,
  // XXX This input #3 is shown as "0,#" in p. 137
  inputs: [FE, AR_SIZE, AR_00_08, CR['#']],
});

SCAD.input = [SCADA, SCADB];

const MQM = Mux({
  name: 'MQM',
  bitWidth: 36,
  control: CR.MQM,
  inputs: [zero, zero, zero, zero, MQdiv4, SH, AD, ones],
});
MQ.input = MQM;


const SCD_FLAGS = Reg({name: 'SCD_FLAGS', bitWidth: 13, inputs: [AR_00_12]});
const VMA_FLAGS = Reg({name: 'VMA_FLAGS', bitWidth: 13, inputs: [null] /* XXX */});
const PC_PLUS_FLAGS = BitCombiner({name: 'PC_PLUS_FLAGS', inputs: [SCD_FLAGS, PC]});
const VMA_PLUS_FLAGS = BitCombiner({name: 'VMA_PLUS_FLAGS', inputs: [VMA_FLAGS, VMA_HELD]});

const VMA_HELD_OR_PC = Mux.methods({
  get() {
    return +(CR.COND === CR.COND['VMA HELD']);
  },
}) ({
  name: 'VMA HELD OR PC',
  bitWidth: 36,
  inputs: [PC, VMA_HELD],
  control: BitCombiner({name: 'SEL VMA HELD',inputs: [CR.COND]}),
});


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
function defineBitFields(input, s) {
  const bitWidth = input.bitWidth;

  return s.split(/\n/).reduce((state, line) => {
    const [, name, s, e] = line.match(/^([^\/;]+)\/=<(\d+):(\d+)>.*/) || [];

    if (name) {
      state.curField = name;
      const entry = BitField({name, s: parseInt(s), e: parseInt(e), input, bitWidth});
      state.fields.push(entry);
      input[name] = entry;
    } else {
      const [, name, value] = line.match(/^\s+([^=;]+)=(\d+).*/) || [];

      if (name) {

        if (state.curField) {
          state.fields[state.fields.length - 1][name] = BigInt(parseInt(value, 8));
        } else {
          console.log(`ERROR: no field context for value definition in "${line}"`);
        }
      } else {
        // Ignore lines that do not match either regexp.
      }
    }

    return state;
  }, {fields: [], curField: null});
}

// Export every EBOXUnit
module.exports = Object.assign(module.exports, EBOXUnitItems);
