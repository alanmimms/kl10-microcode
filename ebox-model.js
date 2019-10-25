'use strict';
const util = require('util');
const StampIt = require('@stamp/it');


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
// EBOXUnit's current address, however that is conveyed inside the
// machine.
const EBOXUnitItems = {};       // Accumulated list of EBOXUnit stamps
const EBOXUnit = StampIt({
  // Must override in derived stamps
  name: 'EBOXUnit',
}).init(function({name, bitWidth}) {
  this.name = name;
  this.bitWidth = bitWidth;
  EBOXUnitItems[this.name] = this;
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
  this.shift = shiftForBit(e, this.bitWidth);
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
// FM. Elements are BigInt by default. The `input` is the EBOXUnit
// that provides a value for calls to `latch()`.
const RAM = StampIt(EBOXUnit, {
  name: 'RAM',
}).init(function({nWords, input, addr = 0, elementValue = 0n}) {
  this.data = new Array(nWords).map(x => elementValue);
  this.input = input;
  this.addr = addr;
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
const Mux = StampIt(EBOXUnit, {
  name: 'Mux',
}).init(function({inputs, control}) {
  this.inputs = inputs;
  this.control = control;
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

// Used to provide a uWord to CRAM to load it
const CRAM_IN = Reg({name: 'CRAM_IN', bitWidth: 84});

const CRAM = RAM({name: 'CRAM', nWords: 2048, bitWidth: CRAM_IN.bitWidth, input: CRAM_IN});
const CR = Reg({name: 'CR', input: CRAM, bitWidth: CRAM.bitWidth});

defineBitFields(CR, `
J/=<1:11>+	;SYMBOLS WILL BE DEFINED BY TAGS (CRA1&CRA2)

;MAIN ADDER CONTROLS.  Bit 0 = carry in, bit 1 = boolean operation
; Bits 2-5 are S8-S1 of the 10181 ALU chip.  For normal arithmetic,
; the AD and ADX are separated unless SPEC/AD LONG or equivalent is given.


AD/=<12:17>	; (DP03, EXCEPT CARRY IN, ON CTL1)
	A+1=40,1
	A+XCRY=00,1
;	A+ANDCB=01,1
;	A+AND=02,1
	A*2=03,1
	A*2+1=43,1
;	OR+1=44,1
;	OR+ANDCB=05,1
	A+B=06,1
	A+B+1=46,1
;	A+OR=07,1
	ORCB+1=50,1
	A-B-1=11,1
	A-B=51,1
;	AND+ORCB=52,1
;	A+ORCB=53,1
	XCRY-1=54,1
;	ANDCB-1=15,1
;	AND-1=16,1
	A-1=17,1
		;ADDER LOGICAL FUNCTIONS
	SETCA=20
	ORC=21		;NAND
	ORCA=22
	1S=23
	ANDC=24		;NOR
	NOR=24
	SETCB=25
	EQV=26
	ORCB=27
	ANDCA=30
	XOR=31
	B=32
	OR=33
	0S=34
	ANDCB=35
	AND=36
	A=37
		;BOOLEAN FUNCTIONS FOR WHICH CRY0 IS INTERESTING
	CRY A EQ -1=60,1	;GENERATE CRY0 IF A=1S, AD=SETCA
	CRY A.B#0=36,1		;CRY 0 IF A&B NON-ZERO, AD=AND
	CRY A#0=37,1		;GENERATE CRY0 IF A .NE. 0, AD=A
	CRY A GE B=71,1		;CRY0 IF A .GE. B, UNSIGNED; AD=XOR

ADA/=<18:20>		; (DP03)
	AR=0
	ARX=1
	MQ=2
	PC=3
ADA EN/=<18:18>		;ADA ENABLE ALSO ENABLES ADXA (DP03)
	EN=0
	0S=1
U21/=<21:21>D,0		;BIT 21 UNUSED
ADB/=<22:23>		;CONTROLS ADB AND ADXB (DP03)
	FM=0,,1		;MUST HAVE TIME FOR PARITY CHECK
	BR*2=1		;ADB35 is BRX0; ADXB35 is 0
	BR=2
	AR*4=3		;ADB34,35 are ARX0,1; ADXB34,35 are 0
U23/=<23:23>D,1		;PREVENT DEFAULT SELECTION OF FM
			;FORCE IT TO TAKE ONE OF THE SHORTER
			;PATHS IF FM NOT NEEDED ALSO DISABLES
			;PARITY CHECKING LOGIC

;REGISTER INPUTS

AR/=<24:26>D,0		; (DP01)
	AR=0
	ARMM=0		;REQUIRES SPECIAL FUNCTION
	MEM=0		;[346] MB WAIT will poke to 1 (CACHE) or 2 (AD)
	CACHE=1		;ORDINARILY SELECTED BY HWARE
	AD=2
	EBUS=3
	SH=4
	AD*2=5		;Low bit from ADX0
	ADX=6
	AD*.25=7
ARX/=<27:29>D,0		; (DP02)
	ARX=0		;[345] BY DEFAULT
	MEM=0		;[346] Gets poked by MB WAIT to 1 or 2
	CACHE=1		;ORDINARILY BY MBOX RESP
	AD=2
	MQ=3
	SH=4
	ADX*2=5		;Low bit from MQ0
	ADX=6
	ADX*.25=7	;High bits from AD34,35
BR/=<30:30>D,0		;DEFAULT TO RECIRCULATE (DP04)
	AR=1
BRX/=<31:31>D,0		;DEFAULT TO RECIRCULATE (DP04)
	ARX=1
MQ/=<32:32>D,0		;DEFAULT TO RECIRCULATE (DP02)
	SH=1		;LOAD FROM SHIFT MATRIX
	MQ*2=0		;With SPEC/MQ SHIFT--Low bit from AD CRY -2
	MQ*.25=1	;With SPEC/MQ SHIFT--High bits from ADX34, ADX35
	MQ SEL=0	;WITH COND/REG CTL
	MQM SEL=1	;WITH COND/REG CTL
;FMADR SELECTS THE SOURCE OF THE FAST MEMORY ADDRESS,
; RATHER THAN PROVIDING THE ADDRESS ITSELF

FMADR/=<33:35>		; (APR4&APR5)
	AC0=0		;IR 9-12
	AC1=1		;<IR 9-12>+1 MOD 16
	XR=2		;ARX 14-17
	VMA=3		;VMA 32-35
	AC2=4		;<IR 9-12>+2 MOD 16
	AC3=5		;<IR 9-12>+3 MOD 16
	AC+#=6		;CURRENT BLOCK, AC+ MAGIC #
	#B#=7		;BLOCK AND AC SELECTED BY # FIELD

.TOC	"CONTROL RAM DEFINITIONS -- 10-BIT LOGIC"

SCAD/=<36:38>		; (SCD1)
	A=0
	A-B-1=1
	A+B=2
	A-1=3
	A+1=4
	A-B=5
	OR=6
	AND=7
SCADA/=<39:41>		; (SCD1)
	FE=0
	AR0-5=1		;BYTE POINTER P FIELD
	AR EXP=2	;<AR 01-08> XOR <AR 00>
	#=3		;SIGN EXTENDED WITH #00
SCADA EN/=<39:39>	; (SCD1)
	0S=1
U42/=<42:42>D,0	;BIT 42 UNUSED
SCADB/=<43:44>		; (SCD1)
	SC=0
	AR6-11=1	;BYTE POINTER S FIELD
	AR0-8=2
	#=3		;NO SIGN EXTENSION
U45/=<45:45>D,0		;BIT 45 UNUSED
SC/=<46:46>D,0		;RECIRCULATE BY DEFAULT (SCD2)
	FE=0		;WITH SCM ALT
	SCAD=1
	AR SHIFT=1	;WITH SCM ALT ;AR 18, 28-35
FE/=<47:47>D,0		;RECIRCULATE BY DEFAULT (SCD2)
	SCAD=1
U48/=<48:48>D,0		;BIT 48 UNUSED
SH/=<49:50>		; (SH1)
	SHIFT AR!ARX=0	;LEFT BY (SC)
	AR=1
	ARX=2
	AR SWAP=3	;HALVES SWAPPED
ARMM/=<49:50>		;SAME BITS AS SH CONTROL (SCD3)
	#=0		;MAGIC # 0-8 TO AR 0-8
	EXP_SIGN=1	;AR1-8 _ AR0
	SCAD EXP=2	;AR0-8_SCAD
	SCAD POS=3	;AR0-5_SCAD
VMAX/=<49:50>		;SAME BITS AS SH CONTROL (VMA4)
	VMAX=0		;VMA SECTION #
	PC SEC=1	;PC SECTION #
	PREV SEC=2	;PREVIOUS CONTEXT SECT
	AD12-17=3
U51/=<51:51>D,0		;BIT 51 UNUSED
VMA/=<52:53>D,0		;ALSO CONTROLLED BY SPECIAL FUNCTIONS
	VMA=0		;BY DEFAULT
	PC=1		;MAY BE OVERRIDDEN BY MCL LOGIC	TO LOAD FROM AD
	LOAD=1		; IF WE KNOW IT WILL BE OVERRIDDEN, USE THIS
	PC+1=2
	AD=3		;ENTIRE VMA, INCLUDING SECTION
TIME/=<54:55>T		;CONTROLS MINIMUM MICROINSTRUCTION EXECUTION
			; TIME, COUNTING MBOX CLOCK TICKS (CLK)
			;ASSEMBLER GENERALLY TAKES CARE OF THIS
	2T=0		;2 TICKS
	3T=1		;3 TICKS
	4T=2		;4 TICKS
	5T=3		;5 TICKS (COND/DIAG FUNC & #00, --> .5 USEC)

.TOC	"CONTROL RAM DEFINITIONS -- MEM SPECIAL FUNCTIONS"

MEM/=<56:59>D,0		;(MCL1, except MB WAIT on CON5 and CLK4)
;
;	Note:  MB WAIT is implicit whenever bit 58 is set.
;
;	NOP=0		;DEFAULT
	ARL IND=1	;CONTROL AR LEFT MUX FROM # FIELD
	MB WAIT=2	;WAIT FOR MBOX RESP IF PENDING
	RESTORE VMA=3	;AD FUNC WITHOUT GENERATING A REQUEST
	A RD=4		;OPERAND READ and load PXCT bits
	B WRITE=5	;CONDITIONAL WRITE ON DRAM B 01
	FETCH=6		;LOAD NEXT INSTR TO ARX (CONTROL BY #)
	REG FUNC=7	;MBOX REGISTER FUNCTIONS
	AD FUNC=10	;FUNCTION LOADED FROM AD LEFT
	EA CALC=11	;FUNCTION DECODED FROM # FIELD
	LOAD AR=12
	LOAD ARX=13
	RW=14		;READ, TEST WRITABILITY
	RPW=15		;READ-PAUSE-WRITE
	WRITE=16	;FROM AR TO MEMORY
	IFET=17		;UNCONDITIONAL instruction FETCH
SKIP/=<60:65>D,0	;MICRO-PROGRAM SKIPS
			; 40-57 DECODED ON (CRA2)
;	SPARE=40
	EVEN PAR=41,,1	;AR PARITY IS EVEN
	BR0=42		;BR BIT 00
	ARX0=43		;ARX BIT 00
	AR18=44		;AR BIT 18
	AR0=45		;AR BIT 00
	AC#0=46		;IR9-12 .EQ. 0
	SC0=47		;SC BIT 00
	PC SEC0=50
	SCAD0=51,,1	;Sign of SCAD output--WRONG ON OVERFLOW FROM BIT 1!!!
	SCAD#0=52,,1	;SCAD OUTPUT IS NON-ZERO
	ADX0=53,1	;ADDER EXTENSION BIT 00
	AD CRY0=54,1	;CARRY OUT OF AD BIT -2 (BOOLE IGNORED)
	AD0=55,1	;ADDER BIT 00
	AD#0=56,1	;AD BITS 00-35 CONTAIN SOME ONES
	-LOCAL AC ADDR=57	;VMA18-31 =0 ON LOCAL REF IN SEC >1

			; 60-77 DECODED ON (CON2)
	FETCH=60	;VMA FETCH (LAST CYCLE WAS A FETCH)
	KERNEL=61	;PC IS IN KERNEL MODE
	USER=62		;PC IS IN USER MODE
	PUBLIC=63	;PC IS PUBLIC (INCLUDING SUPER)
	RPW REF=64	;MIDDLE OF READ-PAUSE-WRITE CYCLE
	PI CYCLE=65	;PI CYCLE IN PROGRESS
	-EBUS GRANT=66	;PI HASN'T RELEASED BUS FOR CPU USE
	-EBUS XFER=67	;NO TRANSFER RECIEVED FROM DEVICE
	INTRPT=70	;AN INTERRUPT REQUEST WAITING FOR SERVICE
	-START=71	;NO CONTINUE BUTTON
	RUN=72		;PROCESSOR NOT HALTED
	IO LEGAL=73	;KERNEL, PI CYCLE, USER IOT, OR DEVICE .GE. 740
	P!S XCT=74	;PXCT OR SXCT
	-VMA SEC0=75	;VMA SECTION NUMBER (13-17) IS NOT ZERO
	AC REF=76,,1	;VMA .LT.20 ON READ OR WRITE
	-MTR REQ=77	;INTERRUPT REQUEST NOT DUE TO METER
;SKIP/COND FIELD CONTINUED
COND/=<60:65>D,0	;NON-SKIP SPECIAL FUNCTIONS
			;0-7 DECODED ON (CTL2)
;	NOP=0		;BY DEFAULT
	LD AR0-8=1
	LD AR9-17=2	;Gates VMAX into ARMM (see VMA4)
	LD AR18-35=3
	AR CLR=4
	ARX CLR=5
	ARL IND=6	;CONTROL AR LEFT, CALL, AND CLEAR BITS FROM #
	REG CTL=7	;CONTROL AR LOAD, EXP TST, AND MQ FROM #
			; 10-37 DECODED ON (CON1)
	FM WRITE=10	;WRITE AR INTO CURRENTLY ADDRESSED FM LOC
	PCF_#=11	;SET PC FLAGS FROM # FIELD
	FE SHRT=12	;SHIFT FE RIGHT 1
	AD FLAGS=13	;SET PC CRY0, CRY1, OVRFLO, TRAP1 AS APPROPRIATE
	LOAD IR=14	;LATCH AD OR CACHE DATA INTO IR, load PXCT bits
	SPEC INSTR=15	;SET/CLR SXCT, PXCT, PICYC, TRAP INSTR FLAGS
	SR_#=16		;CONTROL FOR STATE REGISTER and PXCT bits (CON3, MCL4)
	SEL VMA=17	;READ VMA THROUGH ADA/PC
	DIAG FUNC=20	;SELECT DIAGNOSTIC INFO ONTO EBUS
	EBOX STATE=21	;SET STATE FLOPS
	EBUS CTL=22	;I/O FUNCTIONS
	MBOX CTL=23
;	SPARE=24
	LONG EN=25	;THIS WORD CAN BE INTERPRETED AS LONG INDIRECT
;	SPARE=26
;	SPARE=27
	VMA_#=30
	VMA_#+TRAP=31
	VMA_#+MODE=32
	VMA_#+AR32-35=33
	VMA_#+PI*2=34
	VMA DEC=35	;VMA_VMA-1
	VMA INC=36	;VMA_VMA+1
	LD VMA HELD=37	;HOLD VMA ON SIDE

CALL/=<66:66>D,0	;CALL function--May not coexist with DISP/RETURN
	CALL=1		;GOOD TO 15 LEVELS IN MODEL B
DISP/=<67:71>D,10	;0-7 AND 30-37 ARE DISPATCHES (CRA1&CRA2)
	DIAG=0
	DRAM J=1
	DRAM A RD=2	;IMPLIES INH CRY18
	RETURN=3	;POPJ return--may not coexist with CALL
	PG FAIL=4	;PAGE FAIL TYPE DISP
	SR=5		;16 WAYS ON STATE REGISTER
	NICOND=6	;NEXT INSTRUCTION CONDITION (see NEXT for detail)
	SH0-3=7,,1	;[337] 16 WAYS ON HIGH-ORDER BITS OF SHIFTER
	MUL=30		;FE0*4 + MQ34*2 + MQ35; implies MQ SHIFT, AD LONG
	DIV=31,,1	;FE0*4 + BR0*2 + AD CRY0; implies MQ SHIFT, AD LONG
	SIGNS=32,1	;ARX0*8 + AR0*4 + BR0*2 + AD0
	DRAM B=33	;8 WAYS ON DRAM B FIELD
	BYTE=34,,1	;FPD*4 + AR12*2 + SCAD0--WRONG ON OVERFLOW FROM BIT 1!!
	NORM=35,2	;See normalization for details. Implies AD LONG
	EA MOD=36	;(ARX0 or -LONG EN)*8 + -(LONG EN and ARX1)*4 +
			;ARX13*2 + (ARX2-5) or (ARX14-17) non zero; enable
			;is (ARX0 or -LONG EN) for second case.  If ARX18
			;is 0, clear AR left; otherwise, poke ARL select
			;to set bit 2 (usually gates AD left into ARL)

SPEC/=<67:71>D,10	;NON-DISPATCH SPECIAL FUNCTIONS (CTL1)
;	NOP=10		;DEFAULT
	INH CRY18=11
	MQ SHIFT=12	;ENABLE MQ*2, MQ SHRT2
	SCM ALT=13	;ENABLE FE, ARSHIFT
	CLR FPD=14
	LOAD PC=15
	XCRY AR0=16	;CARRY INTO AD IS XOR'D WITH AR00
	GEN CRY18=17
	STACK UPDATE=20	;CONTROL CRY18 IF LOCAL STACK
;	SUBR CALL=21	;Obsolete--model A only
	ARL IND=22	;# SPECIFIES ARL MIX, ENABLES, & CALL
	MTR CTL=23	;# CONTROLS METERS
	FLAG CTL=24	;FUNCTION ENCODED IN # FIELD
	SAVE FLAGS=25	;TELLS PI CYCLE TO HOLD INTRPT
	SP MEM CYCLE=26	;MEM REQUEST IS MODIFIED BY #
	AD LONG=27	;AD BECOMES 72 BIT ALU

U73/=<72:73>D,0		;BITS 72-73 UNUSED

MARK/=<74:74>D,0	;FIELD SERVICE "MARK" BIT

#/=<75:83>D,0		;THE INFAMOUS "MAGIC NUMBERS"

MAJVER/=<75:80>		;[356] Major version number
MINVER/=<81:83>		;[356] Minor version number

;
;	Options bits, designating different assemblies from the same sources
;

KLPAGE/=<75:75>			;KLPAGING
	OPTIONS=1

LONGPC/=<76:76>			;LONG PC FORMAT AS IN EXTENDED ADDRESSING
	OPTIONS=1		;(The model A used a different format due
				; to space limitations)
NONSTD/=<77:77>			;NONSTANDARD (EG DIAGNOSTIC) MICROCODE
.IF/NONSTD
	OPTIONS=1
.IFNOT/NONSTD
	OPTIONS=0
.ENDIF/NONSTD

PV/=<78:78>			;MODEL B - PV CPU
	OPTIONS=1

PMOVE/=<79:79>			;[435] Physical memory move instructions
	OPTIONS=1

ISTAT/=<83:83>			;STATISTICS GATHERING CODE (IE TRACKS)
.IF/INSTR.STAT
	OPTIONS=1
.IFNOT/INSTR.STAT
	OPTIONS=0
.ENDIF/INSTR.STAT

PXCT/=<75:77>		;(MCL4) Loaded by CON/SR_#, CON/LOAD IR, and MEM/A RD
			;Bit 0 enables the VMAX to not come from the AD when
			; VMA/AD (allowing local AC refs, for example).  Bits
			; 1 and 2 select which PXCT bits a memory reference
			; will select for possible previous context.

ACB/=<77:79>		;AC block number. Used with FMADR/#B#
	PAGB=6		;AC block used for KL paging registers
	MICROB=7	;AC block for general microcode scratch

AC#/=<80:83>		;AC number used with ACB or AC-OP (below)

;
;	Warning:  when AC-OP is used with COND/FM WRITE, the previous micro-
;	instruction must have the same # field as the current one.  Otherwise
;	the address lines won't make it in time for the write pulse.  [210]
;
AC-OP/=<75:79>		;CONTROLS AC #.  AD functions < 40 all work
	AC+#=6
	#=32		;JUST AC#
	OR=33		;AC <OR> AC#

;VARIOUS SPECIAL FUNCTIONS ENABLE SPECIAL DECODING OF THE
; "MAGIC #" FIELD, AS FOLLOWS:

;SPECIAL DATA PATH CONTROLS

;CALL/=<75:75>		;ENABLED BY ARL IND (CTL2)--Model A only
;	CALL=1
AR0-8/=<76:76>		;ENABLED BY ARL IND (CTL2)
	LOAD=1
CLR/=<77:80>		;ENABLED BY ARL IND (CTL2)
	MQ=10
	ARX=4
	ARL=2
	ARR=1
	AR=3
	AR+ARX=7
	AR+MQ=13
	ARX+MQ=14
	AR+ARX+MQ=17
	ARL+ARX=6
	ARL+ARX+MQ=16
	ARR+MQ=11
ARL/=<81:83>		;ENABLED BY ARL IND (CTL2)
	ARL=0
	ARMM=0		;REQUIRES SPECIAL FUNCTION
	CACHE=1		;ORDINARILY SELECTED BY HWARE
	AD=2
	EBUS=3
	SH=4
	AD*2=5
	ADX=6
	AD*.25=7
AR CTL/=<75:77>		;ENABLED BY COND/REG CTL (CTL2)
	AR0-8 LOAD=4
	AR9-17 LOAD=2	;Gates VMAX into ARMM (see VMA4)
	ARR LOAD=1
	ARL LOAD=6
EXP TST/=<80:80>	;ENABLED BY COND/REG CTL (CTL1)
	AR_EXP=1
MQ CTL/=<82:83>		;ENABLED BY COND/REG CTL (CTL2)
;	MQ=0		;WITH MQ/MQ SEL
	MQ*2=1		;WITH MQ/MQ SEL--Low bit is ADX0
;	MQ*.5=2		; " (DROPS BITS 0,6,12,18,24,30)
	0S=3		; "
	SH=0		;WITH MQ/MQM SEL
	MQ*.25=1	;WITH MQ/MQM SEL--High bits are ADX34, ADX35
	1S=2		; "
	AD=3		; "

;SPECIAL CONTROL OF EBOX FLAGS & FUNCTIONS

PC FLAGS/=<75:83>	;ENABLED BY COND/PCF_# (SCD4)
;	OVERF=400	;Any arithmetic overflow
;	FLOVERF=200	;Floating overflow
	FPD=100		;SET FIRST PART DONE
	TRAP2=40	;SET TRAP2 (PDL OVFLO)
	TRAP1=20	;SET TRAP1 (ARITH OVFLO)
;	EXPUND=10	;Exponent underflow
;	NO DIV=4	;No divide
	AROV=420	;SET ARITH OVFLO & TRAP1
	FLOV=620	;SAME, PLUS FLOATING OVFLO
	FXU=630		;FLOV + EXP UNDERFLOW
	DIV CHK=424	;NO DIVIDE + AROV
	FDV CHK=624	;FLOATING NO DIVIDE
FLAG CTL/=<75:83>	;ENABLED BY SPEC/FLAG CTL (SCD5)
	RSTR FLAGS=420	;AS IN JRSTF
	JFCL=602	;FORCE PC 00 = AROV
	JFCL+LD=622	;SECOND PART OF JFCL -- CLEAR TESTED FLAGS
	DISMISS=502	;CLEAR PI CYCLE IF SET (CON5)
			; ELSE DISMISS HIGHEST PI HOLD
	DISMISS+LD=522	;LOAD FLAGS AND DISMISS
	HALT=442	;STOP PROCESSOR IF LEGAL (CON2)
	SET FLAGS=20	;AS IN MUUO
	PORTAL=412	;CLEAR PUBLIC IF PRIVATE INSTR
SPEC INSTR/=<75:83>	;ENABLED BY COND/SPEC INSTR
	SET PI CYCLE=714; (CON5)
	KERNEL CYCLE=200;MAKE IO LEGAL, EXEC ADDR SPACE (CON4)
	INH PC+1=100	;TO MAKE JSR WORK IN TRAP, INTRPT (CON4)
	SXCT=40		;START SECTION XCT (MCL4)
	PXCT=20		;START PREV CONTXT XCT (MCL4)
	INTRPT INH=10	;INHIBIT INTERRUPTS (CON4)
	INSTR ABORT=4	; (CON2)
	HALTED=302	;TELL CONSOLE WE'RE HALTED (CON4)
	CONS XCT=310	;FLAGS FOR INSTR XCT'D FROM CONSOLE
	CONT=0		;RESTORE NORMAL STATE FOR CONTINUE
FETCH/=<75:83>		;ENABLED BY MEM/FETCH
	UNCOND=400
			;LOW 2 BITS DECODED ON (IR3)
	COMP=201,2	;DEPENDING ON AD AND DRAM B
	SKIP=202,2
	TEST=203,1
	JUMP=502,2	;AS IN JUMPX, ON AD AND DRAM B
	JFCL=503,1	;JUMP ON TEST CONDITION
;SPECIAL MEMORY REQUEST FUNCTIONS

EA CALC/=<75:83>	;SPECIFIC CONTROLS FOR MEM/EA CALC
;	LOAD AR=400
;	LOAD ARX=200
;	PAUSE=100	;Freeze memory--always use with 040
;	WRITE=040	;SET VMA WRITE
;	PREV EN=20	;PREV CONTXT SELECTED BY SR AND PXCT
;	INDIRECT=10	;PREV CONTXT FOR EA CALC
;	EA=2		;RESTORATION OF ORIGINAL EA CONDITIONS
;	STACK=1		;PREV CONTXT SELECTED BY PXCT B12
	A IND=230	;INDIRECT AT FIRST EA CALC TIME
	BYTE LD=420	;Read byte data to AR only [337]
	BYTE RD=620	;READ BYTE DATA TO AR & ARX
	BYTE RD PC=621	;READ BYTE DATA TO AR & ARX WITH PC SECTION
	BYTE RPW=760	;Read byte data to AR, ARX, write test, pause [312]
	BYTE IND=610	;INDIRECT AT BYTE EA CALC TIME
	PUSH=041	;STORE TO STACK
	POP AR=421	;READ FROM STACK TO AR
	POP ARX=221	;READ FROM STACK TO ARX
	POP AR-ARX=621	;POP TO BOTH
	WRITE(E)=042
	LD AR(EA)=402	;LOAD AR GLOBAL/LOCAL AS IN EA
	LD AR+WR=440	;LOAD AR, TEST WRITABILITY
	LD ARX+WR=240	;LOAD ARX, TEST WRITABILITY

SP MEM/=<75:83>		;ENABLED BY SPEC/SP MEM CYCLE
	FETCH=400	;LOAD IR WHEN DATA ARRIVES (MCL5)
	USER=200	;FORCE USER OR UPT (MCL2)
	EXEC=100	;FORCE EXEC OR EPT (MCL3)
	SEC 0=40	;CLEAR VMAX (MCL4)
	UPT EN=20	;UPT IF USER EN (MCL3)
	EPT EN=10	;EPT IF NOT USER EN (MCL3)
	CACHE INH=2	; (MCL6)
	UNCSH+UNPAGE=103;UNCACHED AND UNPAGED
	UNPAGED+CACHED=101	;physical reference with cache enabled.
.IFNOT/MULTI
	UNPAGED=101	; (MCL6)
	EPT=111
	EPT CACHE=111	;[260]
	EPT FETCH=511
	UPT=221
	UPT FETCH=621
	PT=31
	PT FETCH=431
.IF/MULTI
	UNPAGED=103	; (MCL6)
	EPT=113
	EPT CACHE=111	;[260]
	EPT FETCH=513
	UPT=223
	UPT FETCH=623
	PT=33
	PT FETCH=433
.ENDIF/MULTI
;MBOX CONTROLS

MREG FNC/=<75:83>	;ENABLED BY MEM/REG FUNC (APR6)
	SBUS DIAG=407	;PERFORM SBUS DIAGNOSTIC CYCLE
	READ UBR=502	;ASK MBOX TO LOAD UBR INTO EBUS REG
	READ EBR=503	;PUT EBR INTO EBUS REG
	READ ERA=504
	WR REFILL RAM=505	;DISGUISED AS A "READ REG" FUNCTION
	LOAD CCA=606	;START A SWEEP
	LOAD UBR=602	;SETUP UBR FROM VMA
	LOAD EBR=603	;SETUP EBR FROM VMA
	MAP=140		;GET PHYS ADDR CORRESPONDING TO VMA (MCL6)
MBOX CTL/=<75:83>	;ENABLED BY COND/MBOX CTL (APR5)
	SET PAGE FAIL=200
	SET IO PF ERR=100
	CLR PT LINE(NK)=61,,1;[333] Clear valid if no Keep bit set
	PT DIR CLR(NK)=41;Enable clear of PT DIR for non keep entries
	CLR PT LINE=31,,1;CLEAR VALID FOR 4 ENTRIES (new pager board) [342]
	PT DIR WR=20,1	;WRITE PAGE TABLE DIRECTORY
	PT WR=10,1	;WRITE PAGE TABLE ENTRY SELECTED BY VMA
	PT DIR CLR=1	;SELECT FOR CLEARING PT DIR (PAG3)
	NORMAL=0	;RESET PT WR SELECTION
MTR CTL/=<81:83>	;FUNCTION DECODING FOR METERS (MTR3)
	CLR TIME=0		; USUALLY USED WITH DIAG FUNC
	CLR PERF=1
	CLR E CNT=2
	CLR M CNT=3
	LD PA LH=4
	LD PA RH=5
	CONO MTR=6
	CONO TIM=7
;I/O FUNCTIONS

EBUS CTL/=<75:83>	;ENABLED BY COND/EBUS CTL (APR3)
	GRAB EEBUS=400	;"EBUS RETURN" TAKES ECL EBUS FOR EBOX
	REQ EBUS=200
	REL EBUS=100	; (CON3)
	EBUS DEMAND=60	;ASSERT DEMAND, KEEP CS, FUNC
	EBUS NODEMAND=20;DROP DEMAND, KEEP CS, FUNC
;	CTL_IR=10	;SELECT F01 & F02 FROM IR
;	DISABLE CS=4	;TURN OFF CONTROLLER SELECT
;	DATAIO=2	;0 FOR CONI/O
;	INPUT=1		;0 FOR OUTPUT
	IO INIT=30	;ENABLE IR3-9 TO EBUS CONTROLLER SELECT,
			; IR10-12 (DECODED) TO FUNCTION
			; AND AR ONTO EBUS IF FUNCTION IS OUTPUT
	DATAO=26	;0'S TO CS, DATAO TO FCN, AND AR TO EBUS
	DATAI=27	;0'S TO CS, DATAI TO FCN
	REL EEBUS=0	;LEGGO
DIAG FUNC/=<75:83>	;ENABLED BY COND/DIAG FUNC (CTL3)
	.5 USEC=400,3		;STRETCH CLOCK TO LET EBUS SETTLE (CON?)
	LD PA LEFT=404,3	;LH PERF ANAL CONTROLS FROM RH (MTR)
	LD PA RIGHT=405,3	;RH PA CONTROLS FROM RH (MTR)
	CONO MTR=406,3		;ACCOUNTING CONTROLS (MTR)
	CONO TIM=407,3		;INTERVAL TIMER CONTROLS (MTR)
	CONO APR=414,3		; (CON3)
	CONO PI=415,3		; (CON3)
	CONO PAG=416,3		;CACHE & PAGING CTL (CON3)
	DATAO APR=417,3		;ADDRESS BREAK (CON3)
	DATAO PAG=620,3		;AC BLOCKS & PREV CONTXT (CON3)
	LD AC BLKS=425,3	;FORCE LOADING AC BLOCKS
	LD PCS+CWSX=426,3	;FORCE LOADING PREV CONTXT SEC, CWSX
	CONI PI(R)=500,3	;PI HOLD & ACTIVE TO LH (PI)
	CONI PI(L)=501,3	;PI GEN TO LH (PI)
	CONI APR(R)=510,3	;APR INTERRUPT & PIA TO LH (APR6)
	RD TIME=510,3		;TIME BASE TO RH (MTR5)
	DATAI PAG(L)=511,3	;AC BLOCKS, PREV CONTXT TO LH (APR6)
	RD PERF CNT=511,3	;PERFORMANCE COUNT TO RH (MTR5)
	CONI APR(L)=512,3	;APR INTERRUPT ENABLES TO LH (APR6)
	RD EBOX CNT=512,3	;EBOX COUNT TO RH (MTR5)
	DATAI APR=513,3		;ADDR BREAK CONDITIONS TO LH (APR6)
	RD CACHE CNT=513,3	;CACHE COUNT TO RH (MTR5)
	RD INTRVL=514,3		;INTERVAL TIMER TO RH (MTR5)
	RD PERIOD=515,3		;PERIOD REGISTER TO RH (MTR5)
	CONI MTR=516,3		;CONTROLS & PIA TO RH (MTR5)
	RD MTR REQ=517,3	;ENCODED UPDATE REQUEST TO 20-22 (MTR5)
	CONI PI(PAR)=530,3	;WRITE EVEN PARITY ENABLES TO RH (CON1)
	CONI PAG=531,3		;CACHE & TRAP CTL TO RH (CON1)
	RD EBUS REG=567,3	;EBUS REGISTER IN MBOX (MBZ1 & MBC1)
`);


const DRAM_IN = Reg({name: 'DRAM_IN', bitWidth: 24});
const DRAM = RAM({name: 'DRAM', input: DRAM_IN, nWords: 512, bitWidth: 24});
const DR = Reg({name: 'DR', input: DRAM});

defineBitFields(DR, `
;FIELDS ARE ARRANGED FOR EASY READING, NOT COMPACTNESS
A/=<0:2>		;OPERAND FETCH MODE
	IMMED=0		;IMMEDIATE
	IMMED-PF=1	;IMMEDIATE, START PREFETCH
	ADDR=2		;FULL EFFECTIVE ADDRESS
	WR-TST=3	;TEST WRITABILITY
	READ=4		;READ ONLY
	READ-PF=5	;READ, THEN PREFETCH
	RD-WR=6		;READ WRITE (SEPARATE CYCLES)
	RD-P-WR=7	;READ PAUSE WRITE

B/=<3:5>		;STORE RESULTS AT--
	DBL AC=1	;DOUBLE RESULT TO AC & AC+1
	DBL BOTH=2	;MULB, DIVB, ETC
	SELF=3		;SELF MODE INSTRUCTIONS
	AC=5		;SINGLE RESULT TO AC, PREFETCH IN PROG
	MEM=6		;RESULT TO MEMORY
	BOTH=7		;SINGLE RESULT TO MEMORY AND AC

	SJC-=3		;SKIP JUMP COMPARE CONTROLS
	SJCL=2
	SJCE=1
	SJCLE=0
	SJCA=7
	SJCGE=6
	SJCN=5
	SJCG=4
B0/=<3:3>		;INVERTS VARIOUS TEST, SKIP, AND JUMP CONTROLS
	CRY0(0)=0	;TEST TST CAUSES PC SKIP IF CRY0=0
	CRY0(1)=1	; SAME IF CRY0=1
B1-2/=<4:5>		;FLOATING RESULT STORE MODE
	AC=1	;RESULT TO AC
	MEM=2	;RESULT JUST TO MEM
	BOTH=3	;RESULT TO BOTH

PARITY/=<11:11>P
;
;	The J field is the starting location of the microroutine to
;	execute the instruction.  Note that the 40 and 20 bits must
;	always be zero.  Also, even-odd pairs of DRAM J fields may
;	differ only in the low order three bits.  (Someone thought he
;	was being very clever when he designed the machine this way.
;	It probably reduced our transfer cost by at least five dollars,
;	after all, and the microcode pain that occurred later didn't cost
;	anything, in theory.)
;
J/=<14:23>		;EXECUTOR
`);


// This needs its `input` set before a `latch()` call.
const FM = RAM({name: 'FM', nWords: 8*16, bitWidth: 36});

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
const AR_00_12 = BitField({name: 'AR_00_12', s: 0, e: 12, input: AR});

////////////////////////////////////////////////////////////////
// Logic units.
const BRx2 = ShiftMult({name: 'BRx2', input: BR, multiplier: 2});
const ARx4 = ShiftMult({name: 'ARx2', input: AR, multiplier: 4});
const BRXx2 = ShiftMult({name: 'BRXx2', input: BRX, multiplier: 2});
const ARXx4 = ShiftMult({name: 'ARXx4', input: ARX, multiplier: 4});
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

const SH = LogicUnit.compose({
  name: 'SH',
  bitWidth: 36,
  function: CR.SH,
}).methods({

  get() {
    const count = SC.get();

    switch (this.function.get()) {
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

// XXX needs implementation
const ADX = LogicUnit.compose({
  name: 'ADX',
  bitWidth: 36,
  control: CR.AD,
  inputs: [ADXA, ADXB],
});

const ARSIGN_SMEAR = LogicUnit.compose({
  name: 'ARSIGN_SMEAR',
  bitWidth: 9,
  inputs: [AR],
}).methods({
  get() {
    return +!!(AR.get() & maskForBit(0, 9));
  },
});

const SCAD_EXP = BitField({name: 'SCAD_EXP', s: 0, e: 8, input: SCAD});
const SCAD_POS = BitField({name: 'SCAD_POS', s: 0, e: 5, input: SCAD});
const PC_13_17 = BitField({name: 'PC_13_17', s: 13, e: 17, input: PC});

const VMA_PREV_SECT_13_17 = BitField({
  name: 'VMA_PREV_SECT_13_17',
  s: 13,
  e: 17,
  input: VMA_PREV_SECT
});

const ARMML = Mux.compose({
  name: 'ARMML',
  bitWidth: 9,
  control: CR.ARMM,
  inputs: [CR['#'], ARSIGN_SMEAR, SCAD_EXP, SCAD_POS],
});

const ARMMR = Mux.compose({
  name: 'ARMMR',
  bitWidth: 17 - 13 + 1,
  inputs: [PC_13_17, VMA_PREV_SECT_13_17],

  control: BitCombiner.compose({
    name: 'ARMMRcontrol',
    inputs: [CR.VMAX],
  }).methods({
    get() {
      return +!!(CR.VMAX & CR.VMAX['PREV SEC']);
    },
  }),
});


const ARMM = BitCombiner({name: 'ARMM', inputs: [ARMML, ARMMR]});

const ADx2 = ShiftMult({name: 'ADx2', input: AD, multiplier: 2});
const ADdiv4 = ShiftDiv({name: 'ADdiv4', input: AD, divisor: 4});

// XXX temporary. This needs to be implemented.
const SERIAL_NUMBER = zeroUnit;

// XXX very temporary. Needs implementation.
const EBUS = zeroUnit;

// XXX very temporary. Needs implementation.
const CACHE = zeroUnit;

const ARMR = Mux.compose({
  name: 'ARMR',
  bitWidth: 18,
  control: CR.AR,
  inputs: [SERIAL_NUMBER, CACHE, ADX, EBUS, SH, ADx2, ADdiv4],
});

const ARML = Mux.compose({
  name: 'ARML',
  bitWidth: 18,
  control: CR.AR,
  inputs: [ARMM, CACHE, ADX, EBUS, SH, ADx2, ADdiv4],
});

const ADXx2 = ShiftMult({name: 'ADXx2', input: ADX, multiplier: 2});
const ADXdiv4 = ShiftDiv({name: 'ADXdiv4', input: ADX, divisor: 4});

const ARXM = Mux.compose({
  name: 'ARXM',
  bitWidth: 36,
  control: CR.ARXM,
  inputs: [zeroUnit, CACHE, AD, MQ, SH, ADXx2, ADX, ADXdiv4],
});

const SCM = Mux({
  name: 'SCM',
  bitWidth: 10,
  inputs: [SC, FE, SCAD, AR_SHIFT],

  control: BitCombiner.compose({
    name: 'SCMcontrol',
    inputs: [CR.SC, CR.SPEC],
  }).methods({
    get() {
      return CR.SC | (+(CR.SPEC === CR.SPEC['SCM ALT']) << 1);
    },
  }),
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
MQ.input = MQM;


const SCD_FLAGS = Reg({name: 'SCD_FLAGS', bitWidth: 13, input: AR_00_12});
const VMA_FLAGS = Reg({name: 'VMA_FLAGS', bitWidth: 13, input: null /* XXX */});
const PC_PLUS_FLAGS = BitCombiner({name: 'PC_PLUS_FLAGS', inputs: [SCD_FLAGS, PC]});
const VMA_PLUS_FLAGS = BitCombiner({name: 'VMA_PLUS_FLAGS', inputs: [VMA_FLAGS, VMA_HELD]});

const VMA_HELD_OR_PC = Mux.compose({
  name: 'VMA HELD OR PC',
  bitWidth: 36,
  inputs: [PC, VMA_HELD],

  control: BitCombiner.compose({
    name: 'SEL VMA HELD',
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


// Export every EBOXUnit
Object.assign(module.exports, EBOXUnitItems);
