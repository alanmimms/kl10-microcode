'use strict';

// Read and digest the microcode from the klx.mcr listing file,
// applying the conditions contained herein and the field names from
// define.mic. I know this is hacky as fuck. But it gets the job done
// and there will never be any new file format to handle.

const fs = require('fs');
const _ = require('lodash');
const util = require('util');
const StampIt = require('@stamp/it')

const cramDefs = {bpw: 84};
const dramDefs = {bpw: 12};
var cram;
var dram;


function readMicroAssemblyListing() {
  // Read our microcode assembly listing so we can suck out its brainz.
  const ucodeListing = _.takeWhile(
    fs.readFileSync('klx.mcr').toString().split(/[\n\r\f]+/),
    line => !line.match(/^\s+END\s*$/));

  // The xram arrays are the BigInt representation of the microcode.
  //
  // The xramDefs objects are indexed by microcode field. Each property
  // there defines an object whose properties are the field value names
  // corresponding values for that field.
  cram = parse(ucodeListing, /^U\s+(\d+), (\d+),(\d+),(\d+),(\d+),(\d+),(\d+),(\d+).*/);
  dram = parse(ucodeListing, /^D\s+(\d+), (\d+),(\d+).*/);
}


// Extract from BigInt word `w` a PDP10 bit-numbering field starting
// at bit `s` and going through bit `e` (inclusive) in a word of
// `wordSize` bits.
function extract(w, s, e, wordSize) {
  // E.g., extract s=1, e=3 with wordSize=10
  // 0123456789
  // xFFFxxxxxx
  return (BigInt.asUintN(wordSize, w) >> BigInt(wordSize - e - 1)) &
    ((1n << BigInt(e - s + 1)) - 1n);
}


// For a BigInt parameter `n`, return its value decoded as groups of
// four octal digits with leading zeroes. For Number `n`, just return
// leading zero octal digits for the specified bits-per-word size
// `bpw`.
function octal4(n, bpw = 12) {

  if (typeof n === 'bigint') {
    const oneMore = 1n << BigInt(bpw);
    return (n | oneMore).toString(8).slice(1).match(/(.{4})/g).join(' ');
  } else {
    const oneMore = 1 << bpw;
    return (n | oneMore).toString(8).slice(1);
  }
}


// Read DEFINE.MIC for all field definitions and the names of field values.
function readAndHandleDirectives() {
  // These point to one or the other as we go through define.mic.
  let fieldDefs = cramDefs;
  let ramName = 'CRAM';

  const ifStack = ['TRUE'];
  let fn = null;
  let widest = 0;

  const conditionals = `\
    .SET/TRUE=1                 ; Define TRUE for ifStack
    .SET/SNORM.OPT=1
    .SET/XADDR=1
    .SET/EPT540=1
    .SET/LONG.PC=1
    .SET/MODEL.B=1
    .SET/KLPAGE=1
    .SET/FPLONG=0
    .SET/BLT.PXCT=1
    .SET/SMP=0                  ;No SMP (DOES RPW instead of RW FOR DPB, IDPB)
    .SET/EXTEXP=1
    .SET/MULTI=1		;DOES NOT CACHE PAGE TABLE DATA
    .SET/NOCST=1		;DOES NOT DO AGE UPDATES, ETC. WITH CST = 0
    .SET/OWGBP=1		;ONE WORD GLOBAL BYTE POINTERS
    .SET/IPA20=1		;IPA20-L
    .SET/GFTCNV=0		;DO NOT DO GFLOAT CONVERSION INSTRUCTIONS [273]
                                ;SAVES 75 WORDS. MONITOR WILL TAKE CARE OF THEM.
`.split(/\n/)
    .reduce((cur, d) => {
      const [, def, val] = d.match(/^\s*\.SET\/([^=]+)=(\d+)/) || [];
      if (def) cur[def] = +val;
      return cur;
    }, {});

  fs.readFileSync('define.mic')
    .toString()
    .split(/[\r\n\f]/)
    .forEach(f => {
      // Strip ^L
      f = f.replace(/\f/, '');

      // Strip comments
      f = f.replace(/\s*;.*/, '');

      // Handle directives
      let m = f.match(/^\s*\.(dcode|ucode|endif|ifnot|if)(?:\/([^\s]+))?.*/im);

      if (m) {
        let dir = m[1].toUpperCase();
        let name = m[2] ? m[2].toUpperCase() : '';

        //    console.log("directive=", dir, name);

        switch (dir) {
        case 'DCODE':
          //      console.log(".DCODE");
          fieldDefs = dramDefs;
          ramName = 'DRAM';
          return;

        case 'UCODE':
          //      console.log(".UCODE");
          fieldDefs = cramDefs;
          ramName = 'CRAM';
          return;

        case 'IF':
          // Oddly, .IF and .IFNOT with the SAME CONDITIONAL don't nest,
          // they act as ELSEIFs.
          if ("!" + name === ifStack.slice(-1)[0]) {
            //	console.log("Pop-Push", name);
	    ifStack.pop();
          }

          ifStack.push(name);
          //      console.log("IF", ifStack.slice(-1)[0]);
          return;

        case 'IFNOT':
          // Oddly, .IF and .IFNOT with the SAME CONDITIONAL don't nest,
          // they act as ELSEIFs.
          if (name === ifStack.slice(-1)[0]) {
            //	console.log("Pop-Push", "!" + name);
	    ifStack.pop();
          }

          ifStack.push('!' + name);
          //      console.log("IF !", ifStack.slice(-1)[0]);
          return;

        case 'ENDIF':
          ifStack.pop();
          //      console.log("Back to", ifStack.slice(-1)[0]);
          return;
        }
      }

      // Stop if we're skipping based on .IF/.IFNOT
      if (!conditionals[ifStack.slice(-1)[0]]) return;
      
      // Ignore other directives
      if (f.match(/^\s*\..*/)) return;

      //  console.log("Def line?", f);

      m = f.match(/^([^.][^/=]*)\/=<(\d+)(?::(\d+))?>.*/);

      if (m) {
        //    console.log(`${ramName}: ${m[1]}/=<${m[2]}${m[3]? ":" + m[3] : ''}>`);
        fn = m[1];
        fieldDefs[fn] = {s: +m[2]};
        if (m[3])
          fieldDefs[fn].e = +m[3];
        else
          fieldDefs[fn].e = +m[2];

        let w = fieldDefs[fn].e - fieldDefs[fn].b + 1;
        if (w > widest) widest = w;
      } else if ((m = f.match(/^\s+(.*)=(\d+)/m))) {
        fieldDefs[fn][m[1]] = +m[2];
      }
    });

  // Delete unused fields in CRAM
  delete cramDefs.U0;
  delete cramDefs.U21;
  delete cramDefs.U42;
  delete cramDefs.U45;
  delete cramDefs.U48;
  delete cramDefs.U51;
  delete cramDefs.U73;
}


function parse(lines, re) {
  const ram = [];

  // This has to be a forEach() loop because the RAM is declared in
  // random address order so map() is not applicable.
  lines.forEach(line => {
    const m = line.match(re);
    if (!m) return;
    const a = parseInt(m[1], 8);
    ram[a] = BigInt('0o' + m.slice(2).join(''));
  });

  return ram;
}


// Extract named `field` (as specified in `defs`) from microword `mw`
// and return it as a simple integer (not a BigInt).
function getField(mw, defs, field) {
  const def = defs[field];
  return Number(extract(mw, def.s, def.e, defs.bpw));
}


function handleSPEC(mw) {
  const SPEC = getField(mw, cramDefs, 'SPEC');
  const code = [
    `// SPEC = ${octal4(SPEC)}`,
  ];

  switch (SPEC) {
  case 0o15:                    // LOAD PC
    code.push(`cpu.PC = cpu.AR & 0o37777777;`);
    break;

  case 0o24:                    // FLAG CTL
    const func = getField(mw, cramDefs, '#');

    if (func === 0o20) {
      code.push(`cpu.flags = cpu.AR >>> (36 - 13);`);
    }

    break;
  }

  return code;
}


function generateAll() {
  const allCode = [
    `'use strict;'`,
  ].concat(_.range(0o4000).map(ma => {
    const mw = cram[ma];

    const headerCode = [
      `  cpu.computeCPUState();`,
      `// uW = ${octal4(mw, cramDefs.bpw)}`,
      `// J = ${octal4(getField(mw, cramDefs, 'J'))}`,
      `// # = ${octal4(getField(mw, cramDefs, '#'))}`,
    ];

    const stores = {};              // Used by store() and storing process.
    const storesConstsCode = [];

    const specCode = handleSPEC(mw);

    const tailCall = [];

    if (1) {                    // Constant next CRAM address
      // XXX This is temporary to show the concept, but it is also wrong.
      const nextuPC = getField(mw, cramDefs, 'J');

      tailCall.push(`cram_${octal4(nextuPC)}(cpu);`);
    } else {                    // Compute next CRAM address
      tailCall.push(`// XXX calculated tailCall not yet implemented!`);
    }

    // VMA
    switch (getField(mw, cramDefs, 'VMA')) {
    case 0:                     // VMA (noop)
      break;
    case 1:                     // PC or LOAD (;MAY BE OVERRIDDEN BY MCL LOGIC TO LOAD FROM AD)
      store('VMA', 'cpu.PC');
      break;
    case 2:                     // PC+1
      store('VMA', 'cpu.PC+1');
      break;
    case 3:                     // AD (ENTIRE VMA, INCLUDING SECTION)
      store('VMA', 'cpu.AD');
      break;
    }

    // Store back the changes we made this cycle into CPU state.
    const storeBackCode = Object.keys(stores)
          .map(dest => `cpu.${dest} = ${dest}`);
    
    return `\
function cram_${octal4(ma)}(cpu) {
${[].concat(
  headerCode,
  storesConstsCode,
  specCode,
  storeBackCode,
  tailCall)
  .join('\n  ')}
}
`;

    // When a `cram_xxxx` function needs to modify a CPU state
    // register, call this with its name. This will note that we need
    // to store back the value of the modification and it will declare
    // a const for `dest` to hold the result until it is stored back
    // at the end of the function. This allows many references to a
    // CPU state register that all receive the same value (start of
    // this cycle) and the value will then be updated at the end of
    // the cycle with the value held in the const.
    function store(dest, value) {
      if (stores[dest]) console.log(`CODING ERROR: multiple stores to ${dest}`);
      stores[dest] = value;
      storesConstsCode.push(`const ${dest} = ${value};`);
    }
  })).join(`\n\n`);
  
  fs.writeFileSync(`microcode.js`, allCode, {mode: 0o664});
}


// Canonical register and mux stamps we compose with other device
// specific behaviors.
const HasSubField = StampIt({
  name: 'HasSubField',
  s: 0,
  e: 0,
  
});
const Reg = StampIt({name: 'Reg'});
const Mux = StampIt({name: 'Mux'});


// class Value extends NamedElement(Object) {

//   constructor(value) {
//     this.value = value;
//   }

//   get() {
//     return this.value;
//   }

//   getSubField(pos, end) {
//     return Math.trunc(this.get() / mask[pos]) % mask[end];
//   }
// }


const CPUState = StampIt({
  props: {
    CRALOC: 0,
    USTACK: [],

    CRAM: [],
    DRAM: [],

    PC: 0,
    FLAGS: 0,
    IR: 0,
    IRAC: 0,

    VMA: 0,
    VMAHELD: 0,
    PREVSECT: 0,
    ADRBREAK: 0,

    AD: 0,
    AR: 0,
    BR: 0,
    SH: 0,
    ARX: 0,
    ADX: 0,
    BRX: 0,
    MQ: 0,

    FE: 0,
    SC: 0,

    CURBLK: 0,
    PREVBLK: 0,

    FM: _.range(4).map(x => Array(16).fill(0)),
  },

  init() {
  },

});

// Array containing the bit mask indexed by PDP-10 numbered bit number.
const mask = _.range(36).map(n => Math.pow(2, 35 - n));


const AlwaysTrue = () => true;


// Object containing all of our components so we can iterate to set
// them up for each cycle.
const ebox = {};


// class NamedElement = (superclass) => class extends superclass {

//   constructor(name) {
//     this.name = name;

//     // Add this instance to an array in 'ebox' property whose name is
//     // our class name.
//     this.isa = this.constructor.name.toLowerCase();
//     if (!ebox[this.isa]) ebox[this.isa] = [];
//     ebox[this.isa].push(this);
//   }
// }


class Value extends NamedElement(Object) {

  constructor(value) {
    this.value = value;
  }

  get() {
    return this.value;
  }

  getSubField(pos, end) {
    return Math.trunc(this.get() / mask[pos]) % mask[end];
  }
}


// Constant value so we can just call get() on constants.
class Constant extends Value {
}


class OldReg extends Value {

  constructor(name) {
    super(name);
    this.nextValue = null;	// Set during cycle calculation phase.
    this.load = AlwaysTrue;	// Default is to always load each step.
  }

  // Define the chain of logic that produces this register's input
  // value each clock cycle. By calling this.input.get() we can
  // recursively determine what the next clock will latch in the
  // register.
  setInput(a) {
    this.input = a;
  }

  // Define the function that says we should load this.nextValue into
  // this.value. If undefined, we do so on every step.
  setLoad(a) {	// TODO: Define this for ARL, ARR, ARX, BR, BRX, PC,
		// VMA_PREV, ADR_BREAK
    this.load = a;
    return this;
  }

  // Store this register's value.
  setIfLoadEnabled(value) {
    if (this.load()) this.value = value;
  }
}


class Mux extends Value {

  setControl(c) {
    this.control = c;
    return this;
  }

  setInputs(a) {
    this.inputs = a;
    return this;
  }

  get() {
    // Determine which input is selected by our control.
    const c = this.control.get();
    return this.inputs[c].get();
  }
}


class Field extends NamedElement {
}


class Shifter extends Mux {
}


class RAM extends NamedElement {
}


class ALU extends Value {
}


class Concatenation extends NamedElement {
}


class SCAD_Logic extends NamedElement {
}


class VMA_Logic extends NamedElement {
}


class VMA_ALU_Logic extends NamedElement {
}


class EBUS_Interface extends NamedElement {
}


// Note DRAM addressing is complicated. See EBOX UD p. 1-7.
const DRAM = new RAM('DRAM', 512);
const DR;

// Note CRAM addressing is complicated.
const CRAM = new RAM('CRAM', 2048);
const CR;

// Fast memory is our 8 blocks of 16 ACs each.
const FM = new RAM('FM', 8 * 16);

// Macro instruction we're working on at the moment.
const IR = new Reg('IR');
const IRAC = new Reg('IRAC');	// Saved AC field <9:12>

const ARLL = new Reg('ARLL');
const ARLR = new Reg('ARLR');
const ARR = new Reg('ARR');
const ARX = new Reg('ARX');
const BR = new Reg('BR');
const BRX = new Reg('BRX');
const MQ = new Reg('MQ');
const FE = new Reg('FE');
const SC = new Reg('SC');
const SH_MUX = new Mux('SH MUX');
const SH = new Shifter('SH', SC);

const ADR_BREAK = new Reg('ADR BREAK');
const VMA = new VMA_Logic('VMA Logic');

const PC = new Reg('PC');
const VMA_PREV = new Reg('VMA PREV');

const ARML = new Mux('ARML');
const ARMR = new Mux('ARMR');

const ARM0L = new Mux('ARM0L');
const ARM0R = new Mux('ARM0R');

const ARXM = new Mux('ARXM');
const ADA = new Mux('ADA');
const ADB = new Mux('ADB');
const ADXA = new Mux('ADXA');
const ADXB = new Mux('ADXB');

const ARMMhi = new Mux('ARMMhi');
const ARMMlo = new Mux('ARMMlo');
const ARMM = new Concatenation(ARMMhi, ARMMlo);

const MQM = new Mux('MQM');

const VMA_ALU = new VMA_ALU_Logic('VMA ALU');
const VMA_AD = new Mux('VMA AD');
const VMA_PREV_OR_PC = new Mux('VMA HELD OR PC', [VMA_PREV, PC]);
const SCD_TRAP = new Mux('SCD TRAP');

const SCM = new Mux('SCM');
const SCAD_A = new Mux('SCAD A');
const SCAD_B = new Mux('SCAD B');
const SCAD = new SCAD_Logic('SCAD', [SCAD_A, SCAD_B]);

const CURRENT_BLOCK = new Reg('CURRENT BLOCK');
const PREVIOUS_BLOCK = new Reg('PREVIOUS BLOCK');
const FMPREV = new Mux('FM PREV');
const FMADR = new Mux('FMADR');
const FMBLK = new Mux('FMBLK');

const AD = new ALU('AD', [ADA, ADB]);
const ADX = new ALU('ADX', [ADXA, ADXB]);

const EBOX_TO_CACHE = new EBUS_Interface('EBOX -> CACHE');
const CACHE_TO_EBOX = new EBUS_Interface('CACHE -> EBOX');

const EBOX_TO_EBUS = new EBUS_Interface('EBOX -> EBUS');
const EBUS_TO_EBOX = new EBUS_Interface('EBUS -> EBOX');

const EBOX_TO_MBUS = new EBUS_Interface('EBOX -> MBUS');
const MBUS_TO_EBOX = new EBUS_Interface('MBUS -> EBOX');


const UNDEFINED = new Constant(0);
const ZERO = new Constant(0);


ARMMhi.setInputs({
  0: () => CR.f('MAGIC'),
  1: () => AR.extractField(0, 0) * 0o777,
  2: () => SCAD.getSubField(0, 8),
  3: () => SCAD.getSubField(0, 5)})
  .setControl(() => CR.f('ARMM'));

ARMMlo.setInputs({
  0: () => PC.extractField(13, 17),
  1: () => VMA_PREV.extractField(13, 17),
  2: UNDEFINED,
  3: UNDEFINED})
  .setControl(ARMMhi.control);

ADA.setInputs({
  0: AR,
  1: ARX,
  2: MQ,
  3: PC})
  .setControl(() => !CR.f('ADA EN') ? CR.f('ADA') : 0);
// ADA EN should probably have been called ADA DIS


ADB.setInputs({
  0: FM,
  1: () => BR.get() * 2,
  2: BR,
  3: () => AR.get () * 4})
  .setControl(() => CR.f('ADB'));

ADXA.setInputs({
  0: ADX,
  1: ZERO})
  .setControl(() => CR.f('ADA EN'));

ADXB.setInputs({
  0: UNDEFINED,
  1: () => BRX.get() * 2,
  2: () => Math.trunc(BRX / 2),
  3: () => ARX.get() * 4})
  .setControl(ADB.control);

// This defines the ARM value when ARM's control is zero.
ARM0.setInputs({
  0: AR,
  1: ARMM,
  2: MBUS_TO_EBOX,
  3: UNDEFINED})
  .setControl(() => {
    if (CR.f('COND') === 4) return ZERO;

    if (CR.f('COND') === 6 || CR.f('SPEC') === 0o22) {
    }

    return 0;			// TODO Remove this default
  });

ARML.setInputs({
  0: ARM0,
  1: CACHE_TO_EBOX,
  2: EBUS_TO_EBOX,
  3: SH,
  4: () => AD.get() * 2,
  5: ADX * 2,
  6: () => Math.trunc(AD.get() / 4)})
  .setControl(() => CR.f('AR'));

ARXM.setInputs({
  0: ARX,				// TODO This is sometimes CACHE or ARX or MEM
  1: CACHE_TO_EBOX,
  2: AD,
  3: MQ,
  4: SH,
  5: () => ADX.get() * 2,
  6: ADX,
  7: () => Math.trunc(ADX.get() / 4)})
  .setControl(() => CR.f('ARX'));

MQM.setInputs({			// Note SPEC/MQ SHIFT is used as a second mux control bit
  0: MQ,
  1: SH,
  2: () => Math.trunc(MQ.get() / 4) + AD.getSubField(-2, -2),
  3: () => MQ.get() * 2})
  .setControl(() => (CR.f('SPEC') === 0o12 ? 2 : 0) + CR.f('MQ'));

SCM.setInputs({			// Note SPEC/SCM ALT is used as a second mux control bit
  0: SC,
  1: SCAD,
  2: FE,
  3: () => (AR.getSubField(18) << 8) | AR.getSubField(28, 35)})
  .setControl(() => CR.f('SC') * 2 + (CR.f('SPEC') === 0o13 ? 1 : 0));

SCAD_A.setInputs({
  0: FE,
  1: () => AR.getSubField(0, 5),
  2: () => AR.getSubField(0) ^ AR.getSubField(1, 8),
  3: () => CR.f('MAGIC'),
  4: ZERO})
  .setControl(() => CR.f('SCADA EN') ? 4 : CR.f('SCADA'));

SCAD_B.setInputs({
  0: SC,
  1: () => AR.getSubField(6, 11),
  2: () => AR.getSubField(0, 8),
  3: () => CR.f('MAGIC')})
  .setControl(() => CR.f('SCADB'));
  

let uPC = 0;
let nextuPC = 0;


function step() {
  // Fetch next microinstruction.
  CR = cram[nextuPC];
  uPC = nextuPC;

  // Walk through every register and calculate its new value. This
  // flows data through muxes and connections plumbed to each
  // register's input recursively. When it's all done we can store the
  // new value in each. We have to do it this way because some
  // register values depend on others and we want them all to change
  // like hardware would, latching their input values at the time of
  // this function call: a clock edge.
  ebox.reg.forEach(r => r.nextValue = r.input.get());

  // Now update them.
  ebox.reg.forEach(r => r.setIfLoadEnabled(r.nextValue));

  // Determine next uPC value.
  nextuPC = computeNextUPC();
}


function computeNextUPC() {
  return 0;			// TODO
}


function main() {
  readMicroAssemblyListing();
  readAndHandleDirectives();
  generateAll();
}


main();
