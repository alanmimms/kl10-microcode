'use strict';
const StampIt = require('@stamp/it');


// Parse a sequence of microcode field definitions (see define.mic for
// examples) and return BitField stamps for each of the fields.
function defineBitFields(s) {
  return s.split(/\n/).map(line => {
    const [, name, s, e] = line.match(/([^\/]+)\/=<(\d+):(\d+)>.*/);
    return BitField({name, s, e});
  });
}


////////////////////////////////////////////////////////////////
// Stamps

// Base Stamp for EBOX functional units. This is an abstract Stamp
// defining protocol but all should be completely overridden.
const EBOXUnit = StampIt({
  // Must override in derived stamps
  name: 'EBOXUnit',
}).init(function({bitWidth}) {
  this.bitWidth = bitWidth;
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
}).init(function({s, e}) {
  this.s = s;
  this.e = e;
}).methods({
  get() { return undefined; }
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


// Take a wide input and split it into multiple subfields.
const BitSplitter = StampIt(EBOXUnit, {
  name: 'BitSplitter',
}).init(function({input}) {
  this.input = input;
}).methods({
  get() { }
});
module.exports.BitSplitter = BitSplitter;


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


////////////////////////////////////////////////////////////////
// RAMs
// Wire up an EBOX block diagram.
const CRAM = RAM({name: 'CRAM', nWords: 2048});
const CR = Reg({name: 'CR', input: CRAM});

const CRsplitter = BitSplitter({
  name: 'CRsplitter',
  input: CR,

  bitFields: defineBitFields(`
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
;CALL/=<75:75>		;ENABLED BY ARL IND (CTL2)--Model A only
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

const DRsplitter = BitSplitter({
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
const FE = Reg({name: 'FE', bitWidth: 10});
const SC = Reg({name: 'SC', bitWidth: 10});

const VMA = Reg({name: 'VMA', bitWidth: 35 - 13 + 1}).methods({
  load() {
  },

  inc() {
  },

  dec() {
  },

  hold() {
  },
});

const MQ = Reg({name: 'MQ', bitWidth: 36}).methods({
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
// Logic units
const BRx2 = ShiftMult({name: 'BRx2', input: BR, multiplier: 2});
const ARx4 = LogicUnit({name: 'ARx2', input: AR, multiplier: 4});
const BRXx2 = ShiftMult({name: 'BRXx2', input: BRX, multiplier: 2});
const ARXx4 = LogicUnit({name: 'ARXx2', input: ARX, multiplier: 4});


////////////////////////////////////////////////////////////////
// Muxes
const ADA = Mux({name: 'ADA', control: CR.ADA, inputs: [
  zeroUnit, zeroUnit, zeroUnit, zeroUnit, AR, ARX, MQ, PC]}).methods({

  get() {
    const control = this.control.get();
    return control ? this.inputs[control & 3] : 0n;
  },
});

const ADB = Mux({name: 'ADB', control: CR.ADB, inputs: [FM, BRx2, BR, ARx4]});
const ADXA = Mux({name: 'ADXA', control: CR.ADA, inputs: [
  zeroUnit, zeroUnit, zeroUnit, zeroUnit, ARX, ARX, ARX, ARX]});
const ADXB = Mux({name: 'ADXB', control: CR.ADB, inputs: [zeroUnit, BRXx2, BRX, ARXx4]});
