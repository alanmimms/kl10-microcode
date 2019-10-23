'use strict';
const util = require('util');
const StampIt = require('@stamp/it');


// Parse a sequence of microcode field definitions (see define.mic for
// examples) and return BitField stamps for each of the fields.
function defineBitFields(s, input) {
  return s.split(/\n/).reduce((cur, line) => {
    const [, name, s, e] = line.match(/([^\/]+)\/=<(\d+):(\d+)>.*/) || [];
    if (name) cur.push(BitField({name, s, e, input}));
    return cur;
  }, []);
}

// Array containing the bit mask indexed by PDP-10 numbered bit number.
const maskForBit = (n, width = 36) => Math.pow(2, width - 1 - n);

const shiftForBit = (n, width = 36) => width - 1 - n;


////////////////////////////////////////////////////////////////
// Stamps

// Base Stamp for EBOX functional units. This is an abstract Stamp
// defining protocol but all should be completely overridden.
const EBOXUnitItems = {};       // Accumulated list of EBOXUnit stamps
const EBOXUnit = StampIt({
  // Must override in derived stamps
  name: 'EBOXUnit',
}).init(function({name, bitWidth}) {
  this.name = name;
  this.bitWidth = bitWidth;
  EBOXUnitItems[this.name] = this;
}).methods({
  // Must override in derived stamps
  get() { return undefined; }
});
module.exports.EBOXUnit = EBOXUnit;


// BitField definition. Define with a specific name. Convention is
// that `s` is PDP10 numbered leftmost bit and `e` is PDP10 numbered
// rightmost bit in field. So number of bits is `e-s+1`.
const BitField = StampIt(EBOXUnit, {
  name: 'BitField',
}).init(function({s, e, input}) {
  this.s = s;
  this.e = e;
  this.input = input;
  this.shift = shiftForBit(e, input.bitWidth);
  this.nBits = e - s + 1;
  this.mask = (1n << BigInt(this.nBits)) - 1n;
}).methods({

  get() {
    return (BigInt.asUintN(this.nBits + 1, this.input.get()) >> this.shift) & this.mask;
  },
});
module.exports.BitField = BitField;


// Use this for inputs that are always zero.
const bigInt0 = BigInt(0);
const zeroUnit = StampIt(EBOXUnit, {
  name: 'zero',
}).methods({
  get() { return bigInt0; }
});
module.exports.bigInt0 = bigInt0;
module.exports.zeroUnit = zeroUnit;

const onesUnit = StampIt(EBOXUnit, {
  name: 'ones',
}).methods({
  get() { return (1n << 36n) - 1n; }
});
module.exports.onesUnit = onesUnit;


// Take a group of inputs and concatenate them into a single wide
// field.
const BitCombiner = StampIt(EBOXUnit, {
  name: 'BitCombiner',
}).init(function({inputs}) {
  this.inputs = inputs;
}).methods({
  get() { }
});
module.exports.BitCombiner = BitCombiner;


// Given an address, retrieve the stored word. Can also store new
// words for diagnostic purposes. This is meant for CRAM and DRAM, not
// FM. Elements are BigInt by default.
const RAM = StampIt(EBOXUnit, {
  name: 'RAM',
}).init(function({nWords, elementValue = 0n}) {
  this.data = new Array(nWords).map(x => elementValue);
}).methods({
  get(addr) {
    return this.data[addr];
  },

  put(addr, value) {
    this.data[addr] = value;
  },
});
module.exports.RAM = RAM;


// Given a selector input and a series of selectable inputs, produce
// the value of the selected input on the output.
const Mux = StampIt(EBOXUnit, {
  name: 'Mux',
}).init(function({splitter, combiner}) {
  this.splitter = splitter;
  this.combiner = combiner;
}).methods({
  get() { }
});
module.exports.Mux = Mux;


// Latch input for later retrieval.
const Reg = StampIt(EBOXUnit, {
  name: 'Reg',
}).init(function({input}) {
  this.input = input;
}).methods({
  get() { },

  latch() {
    this.value = this.input;
  },
});
module.exports.Reg = Reg;


// Given a function selector and a set of inputs, compute a set of
// results.
const LogicUnit = StampIt(EBOXUnit, {
  name: 'LogicUnit',
}).init(function({splitter, inputs}) {
  this.splitter = splitter;
  this.inputs = inputs;
}).methods({
  get() { }
});
module.exports.LogicUnit = LogicUnit;


// Given a function selector and a set of inputs, compute a set of
// results.
const ShiftMult = StampIt(EBOXUnit, {
  name: 'ShiftMult',
}).init(function({input, multiplier = 2}) {
  this.input = input;
}).methods({
  get() {return this.input.get() * this.multiplier }
});
module.exports.ShiftMult = ShiftMult;


// Given a function selector and a set of inputs, compute a set of
// results.
const ShiftDiv = StampIt(EBOXUnit, {
  name: 'ShiftDiv',
}).init(function({input, divisor = 2}) {
  this.input = input;
}).methods({
  get() {return this.input.get() / this.divisor }
});
module.exports.ShiftDiv = ShiftDiv;


////////////////////////////////////////////////////////////////
// RAMs
// Wire up an EBOX block diagram.
const CRAM = RAM({name: 'CRAM', nWords: 2048});
const CR = Reg({name: 'CR', input: CRAM});

const CRsplitter = BitField({
  name: 'CRsplitter',
  input: CR,

  bitFields: defineBitFields(CR, `
J/=<1:11>+      	;SYMBOLS WILL BE DEFINED BY TAGS (CRA1&CRA2)
AD/=<12:17>             ; (DP03, EXCEPT CARRY IN, ON CTL1)
ADA/=<18:20>		; (DP03)
ADA EN/=<18:18>		;ADA ENABLE ALSO ENABLES ADXA (DP03)
ADB/=<22:23>		;CONTROLS ADB AND ADXB (DP03)
U23/=<23:23>D,1		;PREVENT DEFAULT SELECTION OF FM
AR/=<24:26>D,0		; (DP01)
ARX/=<27:29>D,0		; (DP02)
BR/=<30:30>D,0		;DEFAULT TO RECIRCULATE (DP04)
BRX/=<31:31>D,0		;DEFAULT TO RECIRCULATE (DP04)
MQ/=<32:32>D,0		;DEFAULT TO RECIRCULATE (DP02)
FMADR/=<33:35>		; (APR4&APR5)
SCAD/=<36:38>		; (SCD1)
SCADA/=<39:41>		; (SCD1)
SCADA EN/=<39:39>	; (SCD1)
SCADB/=<43:44>		; (SCD1)
SC/=<46:46>D,0		;RECIRCULATE BY DEFAULT (SCD2)
FE/=<47:47>D,0		;RECIRCULATE BY DEFAULT (SCD2)
SH/=<49:50>		; (SH1)
ARMM/=<49:50>		;SAME BITS AS SH CONTROL (SCD3)
VMAX/=<49:50>		;SAME BITS AS SH CONTROL (VMA4)
VMA/=<52:53>D,0		;ALSO CONTROLLED BY SPECIAL FUNCTIONS
TIME/=<54:55>T		;CONTROLS MINIMUM MICROINSTRUCTION EXECUTION
MEM/=<56:59>D,0		;(MCL1, except MB WAIT on CON5 and CLK4)
SKIP/=<60:65>D,0	;MICRO-PROGRAM SKIPS
COND/=<60:65>D,0	;NON-SKIP SPECIAL FUNCTIONS
CALL/=<66:66>D,0	;CALL function--May not coexist with DISP/RETURN
DISP/=<67:71>D,10	;0-7 AND 30-37 ARE DISPATCHES (CRA1&CRA2)
SPEC/=<67:71>D,10	;NON-DISPATCH SPECIAL FUNCTIONS (CTL1)
MARK/=<74:74>D,0	;FIELD SERVICE "MARK" BIT
#/=<75:83>D,0		;THE INFAMOUS "MAGIC NUMBERS"
MAJVER/=<75:80>		;[356] Major version number
MINVER/=<81:83>		;[356] Minor version number
KLPAGE/=<75:75>		;KLPAGING
LONGPC/=<76:76>		;LONG PC FORMAT AS IN EXTENDED ADDRESSING
NONSTD/=<77:77>		;NONSTANDARD (EG DIAGNOSTIC) MICROCODE
PV/=<78:78>		;MODEL B - PV CPU
PMOVE/=<79:79>		;[435] Physical memory move instructions
ISTAT/=<83:83>		;STATISTICS GATHERING CODE (IE TRACKS)
PXCT/=<75:77>		;(MCL4) Loaded by CON/SR_#, CON/LOAD IR, and MEM/A RD
ACB/=<77:79>		;AC block number. Used with FMADR/#B#
AC#/=<80:83>		;AC number used with ACB or AC-OP (below)
AC-OP/=<75:79>		;CONTROLS AC #.  AD functions < 40 all work
AR0-8/=<76:76>		;ENABLED BY ARL IND (CTL2)
CLR/=<77:80>		;ENABLED BY ARL IND (CTL2)
ARL/=<81:83>		;ENABLED BY ARL IND (CTL2)
AR CTL/=<75:77>		;ENABLED BY COND/REG CTL (CTL2)
EXP TST/=<80:80>	;ENABLED BY COND/REG CTL (CTL1)
MQ CTL/=<82:83>		;ENABLED BY COND/REG CTL (CTL2)
PC FLAGS/=<75:83>	;ENABLED BY COND/PCF_# (SCD4)
FLAG CTL/=<75:83>	;ENABLED BY SPEC/FLAG CTL (SCD5)
SPEC INSTR/=<75:83>	;ENABLED BY COND/SPEC INSTR
FETCH/=<75:83>		;ENABLED BY MEM/FETCH
EA CALC/=<75:83>	;SPECIFIC CONTROLS FOR MEM/EA CALC
SP MEM/=<75:83>		;ENABLED BY SPEC/SP MEM CYCLE
MREG FNC/=<75:83>	;ENABLED BY MEM/REG FUNC (APR6)
MBOX CTL/=<75:83>	;ENABLED BY COND/MBOX CTL (APR5)
MTR CTL/=<81:83>	;FUNCTION DECODING FOR METERS (MTR3)
EBUS CTL/=<75:83>	;ENABLED BY COND/EBUS CTL (APR3)
DIAG FUNC/=<75:83>	;ENABLED BY COND/DIAG FUNC (CTL3)
`),
});


const DRAM = RAM({name: 'DRAM', nWords: 512});
const DR = Reg({name: 'DR', input: DRAM});

const DRsplitter = BitField({
  name: 'DRsplitter',
  input: DR,

  bitFields: defineBitFields(`
A/=<0:2>		;OPERAND FETCH MODE
B/=<3:5>		;STORE RESULTS AT--
B0/=<3:3>		;INVERTS VARIOUS TEST, SKIP, AND JUMP CONTROLS
B1-2/=<4:5>		;FLOATING RESULT STORE MODE
PARITY/=<11:11>P
J/=<14:23>		;EXECUTOR
`),
});


const FM = RAM({name: 'FM', nWords: 8*16});

////////////////////////////////////////////////////////////////
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

const FE = Reg.compose({name: 'FE', bitWidth: 10}).methods({
  load() {
  },

  shrt() {
  },
});

const VMA = Reg.compose({name: 'VMA', bitWidth: 35 - 13 + 1}).methods({
  load() {
  },

  inc() {
  },

  dec() {
  },

  hold() {
  },
});

const MQ = Reg.compose({name: 'MQ', bitWidth: 36}).methods({
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
const AR = BitCombiner({name: 'AR', inputs: [ARL, ARR]});


////////////////////////////////////////////////////////////////
// BitField splitters used by various muxes and logic elements.
const AR_00_08 = BitField({name: 'AR_00_08', s: 0, e: 8, input: AR});
const AR_EXP = BitField({name: 'AR_EXP', s: 1, e: 8, input: AR});
const AR_SIZE = BitField({name: 'AR_SIZE', s: 6, e: 11, input: AR});
const AR_POS = BitField({name: 'AR_POS', s: 0, e: 5, input: AR});
// XXX needs AR18 to determine direction of shift
const AR_SHIFT = BitField({name: 'AR_SHIFT', s: 28, e: 35, input: AR});


////////////////////////////////////////////////////////////////
// Logic units.
const BRx2 = ShiftMult({name: 'BRx2', input: BR, multiplier: 2});
const ARx4 = LogicUnit({name: 'ARx2', input: AR, multiplier: 4});
const BRXx2 = ShiftMult({name: 'BRXx2', input: BRX, multiplier: 2});
const ARXx4 = LogicUnit({name: 'ARXx2', input: ARX, multiplier: 4});
const MQdiv4 = ShiftDiv({name: 'MQdiv4', input: MQ, divisor: 4});


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
const SCAD = LogicUnit({name: 'SCAD', bitWidth: 10, function: CR.SCAD});

// XXX no implementation yet.
const AD = LogicUnit.compose({name: 'AD', bitWidth: 38, function: CR.AD});

// XXX this is unfinished. See p. 153-154. CR.SH is two bits to select
// from [ARcatenatedWithARX, AR, ARX (SHIFT 36?), AR_SWAPPED (SHIFT
// 50?)] selected by CR.SH. SC can specify up to 35 shift. Any number
// < 0 or > 35 selects ARX as output. Need to determine how AR18 is
// combined with AR28-35 to make a signed shift count (probably from
// schematics). Need to understand precisely what AR_SWAPPED is.
const SH = LogicUnit.compose({name: 'SH', bitWidth: 36, function: CR.SH});


////////////////////////////////////////////////////////////////
// Muxes
const ADA = Mux.compose({
  name: 'ADA',
  control: CR.ADA,
  inputs: [zeroUnit, zeroUnit, zeroUnit, zeroUnit, AR, ARX, MQ, PC]});

const ADB = Mux.compose({
  name: 'ADB',
  bitWidth: 36,
  control: CR.ADB,
  inputs: [FM, BRx2, BR, ARx4],
});

const ADXA = Mux.compose({
  name: 'ADXA',
  bitWidth: 36,
  control: CR.ADA,
  inputs: [zeroUnit, zeroUnit, zeroUnit, zeroUnit, ARX, ARX, ARX, ARX],
});

const ADXB = Mux.compose({
  name: 'ADXB',
  bitWidth: 36,
  control: CR.ADB,
  inputs: [zeroUnit, BRXx2, BRX, ARXx4],
});

const SCM = Mux({
  name: 'SCM',
  bitWidth: 10,
  control: SCMcontrol,
  // XXX This input #3 is shown as "AR18,28-35" in p. 137
  inputs: [SC, FE, SCAD, AR_SHIFT],
});

const SCADA = Mux({
  name: 'SCADA',
  bitWidth: 10,
  control: CR.SCADA,
  inputs: [zeroUnit, zeroUnit, zeroUnit, zeroUnit, FE, AR_POS, AR_EXP, CR['#']],
});

const SCADB = Mux({
  name: 'SCADB',
  bitWidth: 10,
  control: CR.SCADB,
  // XXX This input #3 is shown as "0,#" in p. 137
  inputs: [FE, AR_SIZE, AR_00_08, CR['#']],
});

SCAD.inputs = [SCADA, SCADB];

const MQM = Mux.compose({
  name: 'MQM',
  bitWidth: 36,
  control: CR.MQM,
  inputs: [zeroUnit, zeroUnit, zeroUnit, zeroUnit, MQdiv4, SH, AD, onesUnit],
});


// Export every EBOXUnit
Object.assign(module.exports, EBOXUnitItems);
