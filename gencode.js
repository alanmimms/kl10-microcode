'use strict';

// Read and digest the microcode from the klx.mcr listing file,
// applying the conditions contained herein and the field names from
// define.mic. I know this is hacky as fuck. But it gets the job done
// and there will never be any new file format to handle.

const fs = require('fs');
const _ = require('lodash');
const util = require('util');
const StampIt = require('@stamp/it');

const EBOXModel = require('./ebox-model.js');

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


function main() {
  readMicroAssemblyListing();
  readAndHandleDirectives();
  generateAll();
}


main();
