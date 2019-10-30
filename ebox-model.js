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
// Stamps

// Base Stamp for EBOX functional units. This is an abstract Stamp
// defining protocol but all should be completely overridden.
//
// The convention is that each EBOXUnit has a `get()` method
// (sometimes with parameters) that retrieves the unit's value based
// on its current inputs and configuration. If the unit is a RAM or a
// Reg there is also a `latch()` method that stores a value at the
// EBOXUnit's current address(RAM) or in its `latched` property (Reg).
const EBOXUnitItems = {};       // Accumulated list of EBOXUnit stamps
const EBOXUnit = StampIt({
  // Must override in derived stamps
  name: 'EBOXUnit',
}).init(function({name, bitWidth}) {
  this.name = name;
  this.value = 0n;
  this.bitWidth = bitWidth;
  EBOXUnitItems[this.name] = this;
}).methods({
  get() {return this.value},

  getLH() {
    return BigInt.asUintN(18, this.value >> 18n);
  },

  getRH() {
    return BigInt.asUintN(18, this.value);
  },

  joinHalves(lh, rh) {
    return (BigInt.asUintN(18, lh) << 18n) | BigInt.asUintN(18, rh);
  }
});

module.exports.EBOXUnit = EBOXUnit;


// XXX TODO: Build a ClockedUnit composed from EBOXUnit for each type
// of Unit that has a clock and latches its value (RAM and Reg for
// example). Use `getInputs()` method to retrieve inputs and aggregate
// them to save what would be saved by the latch on the clock edge.
//
// On non-clocked Units:
// * `latch()` does nothing or is unimplemented.
// * `clock()` does nothing or is unimplemented.
// * `get()` returns `getInputs()` result directly..
//
// On ClockedUnits:
// * `latch()` copies `getInputs()` result into `latchedValue`.
// * `clock()` copies `latchedValue` to `value.
// * `get()` returns `value`.


// BitField definition. Define with a specific name. Convention is
// that `s` is PDP10 numbered leftmost bit and `e` is PDP10 numbered
// rightmost bit in field. So number of bits is `e-s+1`.
const BitField = EBOXUnit
      .compose({name: 'BitField'})
      .init(function({s, e, input}) {
        this.s = s;
        this.e = e;
        this.input = input;
        this.bitWidth = e - s + 1;
        this.shift = shiftForBit(e, this.bitWidth);
        this.nBits = e - s + 1;
        this.mask = (1n << BigInt(this.nBits)) - 1n;
      }).methods({

        get() {
          const v = this.input.get();
          return (BigInt.asUintN(this.nBits + 1, v) >> this.shift) & this.mask;
        },
      });
module.exports.BitField = BitField;


// Use this for inputs that are always zero.
const ConstantUnit = EBOXUnit
      .compose({name: 'ConstantUnit'})
      .init(function ({name, value, bitWidth = 36}) {
        this.name = name;
        this.bitWidth = bitWidth;
        this.value = value >= 0 ? value : BigInt.asUintN(bitWidth, value);
      });

const zeroUnit = ConstantUnit({name: 'zero', value: 0n});
const onesUnit = ConstantUnit({name: 'ones', value: -1n});
module.exports.zeroUnit = zeroUnit;
module.exports.onesUnit = onesUnit;


// Take a group of inputs and concatenate them into a single wide
// field.
const BitCombiner = EBOXUnit.compose({name: 'BitCombiner'})
      .init(function({inputs}) {
        this.inputs = inputs;
        this.bitWidth = inputs.reduce((cur, i) => cur += i.bitWidth, 0);
      }).methods({

        get() {
          return this.inputs.reduce((v, i) => {
            v = (v << i.bitWidth) | i.get();
            return v;
          }, 0n);
        }
      });
module.exports.BitCombiner = BitCombiner;


// Given an address, retrieve the stored word. Can also store new
// words for diagnostic purposes. This is meant for CRAM and DRAM, not
// FM. Elements are BigInt by default. The `input` is the EBOXUnit
// that provides a value for calls to `latch()`.
const RAM = EBOXUnit.compose({name: 'RAM'})
      .init(function({nWords, input, addr = 0, elementValue = 0n}) {
        this.data = new Array(nWords).map(x => elementValue);
        this.nWords = nWords,
        this.input = input;
        this.addr = addr;
        this.bitWidth = this.input.bitWidth;
      }).methods({

        get() {
          return this.data[this.addr];
        },

        latch(value) {
          this.data[this.addr] = this.input.get();
        },
      });
module.exports.RAM = RAM;


// Given a selector input and a series of selectable inputs, produce
// the value of the selected input on the output.
const Mux = EBOXUnit.compose({name: 'Mux'})
      .init(function({inputs, control}) {
        this.inputs = inputs;
        this.control = control;
        this.bitWidth = inputs[0].bitWidth;
      }).methods({

        get() {
          return this.inputs[this.control].get();
        }
      });
module.exports.Mux = Mux;


// Latch input for later retrieval.
const Reg = EBOXUnit.compose({name: 'Reg'})
      .init(function({input}) {
        this.input = input;
        this.bitWidth = input.bitWidth;
        this.latched = 0n;
      }).methods({

        latch() {
          this.value = this.latched;
          this.latched = this.input.get();
        },
      });
module.exports.Reg = Reg;


// Given a function selector and a set of inputs, compute a set of
// results.
const LogicUnit = EBOXUnit.compose({name: 'LogicUnit'})
      .init(function({splitter, inputs, func}) {
        this.splitter = splitter;
        this.inputs = inputs;
        this.func = func;
      }).methods({

        get() {
          console.log(`${this.name} needs a 'get()' implementation`);
        },
      });
module.exports.LogicUnit = LogicUnit;


// Given a function selector and a set of inputs, compute a set of
// results.
const ShiftMult = EBOXUnit.compose({name: 'ShiftMult'})
      .init(function({input, multiplier = 2}) {
        this.input = input;
      }).methods({
        get() {return this.input.get() * this.multiplier }
      });
module.exports.ShiftMult = ShiftMult;


// Given a function selector and a set of inputs, compute a set of
// results.
const ShiftDiv = EBOXUnit
      .compose({name: 'ShiftDiv'})
      .init(function({input, divisor = 2}) {
        this.input = input;
      }).methods({
        get() {return this.input.get() / this.divisor }
      });
module.exports.ShiftDiv = ShiftDiv;


////////////////////////////////////////////////////////////////
// RAMs
// Wire up an EBOX block diagram.

// Used to provide a uWord to CRAM to load it
const CRAM_IN = Reg({name: 'CRAM_IN', bitWidth: 84});

const CRAM = RAM({name: 'CRAM', nWords: 2048, bitWidth: CRAM_IN.bitWidth, input: CRAM_IN});
const CR = Reg({name: 'CR', input: CRAM, bitWidth: CRAM.bitWidth});

defineBitFields(CR, defines.CRAM);


const DRAM_IN = Reg({name: 'DRAM_IN', bitWidth: 24});
const DRAM = RAM({name: 'DRAM', input: DRAM_IN, nWords: 512, bitWidth: 24});
const DR = Reg({name: 'DR', input: DRAM});

defineBitFields(DR, defines.DRAM);


// This needs its `input` set before a `latch()` call.
const FM = RAM({name: 'FM', nWords: 8*16, bitWidth: 36});

////////////////////////////////////////////////////////////////
// Registers
const IR = Reg.props({name: 'IR', bitWidth: 12});
const IRAC = Reg.props({name: 'IRAC', bitWidth: 4});
const PC = Reg.props({name: 'PC', bitWidth: 35 - 13 + 1});
const ADR_BREAK = Reg.props({name: 'ADR BREAK', bitWidth: 35 - 13 + 1});
const VMA_HELD = Reg.props({name: 'VMA HELD', bitWidth: 35 - 13 + 1});
const VMA_PREV_SECT = Reg.props({name: 'VMA PREV SECT', bitWidth: 17 - 13 + 1});
const ARL = Reg.props({name: 'ARL', bitWidth: 18});
const ARR = Reg.props({name: 'ARR', bitWidth: 18});
const ARX = Reg.props({name: 'ARX', bitWidth: 36});
const BR = Reg.props({name: 'BR', bitWidth: 36});
const BRX = Reg.props({name: 'BRX', bitWidth: 36});
const SC = Reg.props({name: 'SC', bitWidth: 10});

const FE = Reg
      .compose({name: 'FE'})
      .props({name: 'FE', bitWidth: 10})
      .methods({
        load() {
        },

        shrt() {
        },
      });

const VMA = Reg
      .compose({name: 'VMA'})
      .props({name: 'VMA', bitWidth: 35 - 13 + 1})
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
          // diagram for VMA based on M8542 which replaces M8523 which
          // is outdated for KL10-PV model B but is shown on p. 137.

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
      });

const MQ = Reg
      .compose({name: 'MQ'})
      .props({name: 'MQ', bitWidth: 36})
      .methods({
        load() {
        },

        shrt() {
        },

        srlt() {
        },

        hold() {
        },
      });


// POSSIBLY MISSING REGISTERS:
// Stuff from M8539 module in upper-left corner of p. 137:
// MCL, CURRENT BLOCK, PREV BLOCK


////////////////////////////////////////////////////////////////
// BitCombiners for common register/mux aggregates
const AR = BitCombiner.props({name: 'AR', inputs: [ARL, ARR]});


////////////////////////////////////////////////////////////////
// BitField splitters used by various muxes and logic elements.
const AR_00_08 = BitField.props({name: 'AR_00_08', s: 0, e: 8, input: AR});
const AR_EXP = BitField.props({name: 'AR_EXP', s: 1, e: 8, input: AR});
const AR_SIZE = BitField.props({name: 'AR_SIZE', s: 6, e: 11, input: AR});
const AR_POS = BitField.props({name: 'AR_POS', s: 0, e: 5, input: AR});
// XXX needs AR18 to determine direction of shift
const AR_SHIFT = BitField.props({name: 'AR_SHIFT', s: 28, e: 35, input: AR});
const AR_00_12 = BitField.props({name: 'AR_00_12', s: 0, e: 12, input: AR});
const AR_12_36 = BitField.props({name: 'AR_12_35', s: 12, e: 35, input: AR});

////////////////////////////////////////////////////////////////
// Logic units.
const BRx2 = ShiftMult.props({name: 'BRx2', input: BR, multiplier: 2});
const ARx4 = ShiftMult.props({name: 'ARx2', input: AR, multiplier: 4});
const BRXx2 = ShiftMult.props({name: 'BRXx2', input: BRX, multiplier: 2});
const ARXx4 = ShiftMult.props({name: 'ARXx4', input: ARX, multiplier: 4});
const MQdiv4 = ShiftDiv.props({name: 'MQdiv4', input: MQ, divisor: 4});


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
const SCAD = LogicUnit
      .props({name: 'SCAD', bitWidth: 10, func: CR.SCAD})
      .methods({
        get() {
          console.log(`${this.name} needs a 'get()' implementation`);
        },
      });


const AD = LogicUnit.props({name: 'AD', bitWidth: 38, func: CR.AD})
      .methods({

        get() {
          const func = this.func.get();
          console.log(`${this.name} needs a 'get()' implementation`);

          switch (func) {
          default:
          case 0:
            break;
          }
        },
      });

const SH = LogicUnit.props({
  name: 'SH',
  bitWidth: 36,
  func: CR.SH,
}).methods({

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
});


////////////////////////////////////////////////////////////////
// Muxes
const ADA = Mux.props({
  name: 'ADA',
  control: CR.ADA,
  inputs: [zeroUnit, zeroUnit, zeroUnit, zeroUnit, AR, ARX, MQ, PC]});

const ADB = Mux.props({
  name: 'ADB',
  bitWidth: 36,
  control: CR.ADB,
  inputs: [FM, BRx2, BR, ARx4],
});

const ADXA = Mux.props({
  name: 'ADXA',
  bitWidth: 36,
  control: CR.ADA,
  inputs: [zeroUnit, zeroUnit, zeroUnit, zeroUnit, ARX, ARX, ARX, ARX],
});

const ADXB = Mux.props({
  name: 'ADXB',
  bitWidth: 36,
  control: CR.ADB,
  inputs: [zeroUnit, BRXx2, BRX, ARXx4],
});

// XXX needs implementation
const ADX = LogicUnit.props({
  name: 'ADX',
  bitWidth: 36,
  control: CR.AD,
  inputs: [ADXA, ADXB],
});

const ARSIGN_SMEAR = LogicUnit.props({
  name: 'ARSIGN_SMEAR',
  bitWidth: 9,
  inputs: [AR],
}).methods({
  get() {
    return +!!(AR.get() & maskForBit(0, 9));
  },
});

const SCAD_EXP = BitField.props({name: 'SCAD_EXP', s: 0, e: 8, input: SCAD});
const SCAD_POS = BitField.props({name: 'SCAD_POS', s: 0, e: 5, input: SCAD});
const PC_13_17 = BitField.props({name: 'PC_13_17', s: 13, e: 17, input: PC});

const VMA_PREV_SECT_13_17 = BitField.props({
  name: 'VMA_PREV_SECT_13_17',
  s: 13,
  e: 17,
  input: VMA_PREV_SECT
});

const ARMML = Mux.props({
  name: 'ARMML',
  bitWidth: 9,
  control: CR.ARMM,
  inputs: [CR['#'], ARSIGN_SMEAR, SCAD_EXP, SCAD_POS],
});

const ARMMR = Mux.props({
  name: 'ARMMR',
  bitWidth: 17 - 13 + 1,
  inputs: [PC_13_17, VMA_PREV_SECT_13_17],

  control: BitCombiner.props({
    name: 'ARMMRcontrol',
    inputs: [CR.VMAX],
  }).methods({
    get() {
      return +!!(CR.VMAX & CR.VMAX['PREV SEC']);
    },
  }),
});


const ARMM = BitCombiner.props({name: 'ARMM', inputs: [ARMML, ARMMR]});

const ADx2 = ShiftMult.props({name: 'ADx2', input: AD, multiplier: 2});
const ADdiv4 = ShiftDiv.props({name: 'ADdiv4', input: AD, divisor: 4});

// XXX temporary. This needs to be implemented.
const SERIAL_NUMBER = zeroUnit;

// XXX very temporary. Needs implementation.
const EBUS = zeroUnit;

// XXX very temporary. Needs implementation.
const CACHE = zeroUnit;

const ARMR = Mux.props({
  name: 'ARMR',
  bitWidth: 18,
  control: CR.AR,
  inputs: [SERIAL_NUMBER, CACHE, ADX, EBUS, SH, ADx2, ADdiv4],
});

const ARML = Mux.props({
  name: 'ARML',
  bitWidth: 18,
  control: CR.AR,
  inputs: [ARMM, CACHE, ADX, EBUS, SH, ADx2, ADdiv4],
});

const ADXx2 = ShiftMult.props({name: 'ADXx2', input: ADX, multiplier: 2});
const ADXdiv4 = ShiftDiv.props({name: 'ADXdiv4', input: ADX, divisor: 4});

const ARXM = Mux.props({
  name: 'ARXM',
  bitWidth: 36,
  control: CR.ARXM,
  inputs: [zeroUnit, CACHE, AD, MQ, SH, ADXx2, ADX, ADXdiv4],
});

const SCM = Mux.props({
  name: 'SCM',
  bitWidth: 10,
  inputs: [SC, FE, SCAD, AR_SHIFT],

  control: BitCombiner.props({
    name: 'SCMcontrol',
    inputs: [CR.SC, CR.SPEC],
  }).methods({
    get() {
      return CR.SC | (+(CR.SPEC === CR.SPEC['SCM ALT']) << 1);
    },
  }),
});

const SCADA = Mux.props({
  name: 'SCADA',
  bitWidth: 10,
  control: CR.SCADA,
  inputs: [zeroUnit, zeroUnit, zeroUnit, zeroUnit, FE, AR_POS, AR_EXP, CR['#']],
});

const SCADB = Mux.props({
  name: 'SCADB',
  bitWidth: 10,
  control: CR.SCADB,
  // XXX This input #3 is shown as "0,#" in p. 137
  inputs: [FE, AR_SIZE, AR_00_08, CR['#']],
});

SCAD.inputs = [SCADA, SCADB];

const MQM = Mux.props({
  name: 'MQM',
  bitWidth: 36,
  control: CR.MQM,
  inputs: [zeroUnit, zeroUnit, zeroUnit, zeroUnit, MQdiv4, SH, AD, onesUnit],
});
MQ.input = MQM;


const SCD_FLAGS = Reg.props({name: 'SCD_FLAGS', bitWidth: 13, input: AR_00_12});
const VMA_FLAGS = Reg.props({name: 'VMA_FLAGS', bitWidth: 13, input: null /* XXX */});
const PC_PLUS_FLAGS = BitCombiner.props({name: 'PC_PLUS_FLAGS', inputs: [SCD_FLAGS, PC]});
const VMA_PLUS_FLAGS = BitCombiner.props({name: 'VMA_PLUS_FLAGS', inputs: [VMA_FLAGS, VMA_HELD]});

const VMA_HELD_OR_PC = Mux.props({
  name: 'VMA HELD OR PC',
  bitWidth: 36,
  inputs: [PC, VMA_HELD],

  control: BitCombiner
    .compose({name: 'SEL VMA HELD'})
    .props({
      inputs: [CR.COND],
    }).methods({

      get() {
        return +(CR.COND === CR.COND['VMA HELD']);
      },
    }),

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
          const fields = state.fields;
          fields[fields.length - 1][name] = BigInt(parseInt(value, 8));
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
Object.assign(module.exports, EBOXUnitItems);
