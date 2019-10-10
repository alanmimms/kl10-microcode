'use strict';

// Read and digest the microcode from the klx.mcr listing file,
// applying the conditions contained herein and the field names from
// define.mic. I know this is hacky as fuck. But it gets the job done
// and there will never be any new file format to handle.

const fs = require('fs');
const _ = require('lodash');
const stampit = require('@stamp/it');
const WordBits = require('./wordbits.js');


// This WordBits instance allows us to extract bitfields from the
// 12-bit subwords of the CRAM and DRAM words, with the bits numbered
// as PDP10s number them - MSB is bit #0.
const CRAMWordBits = new WordBits(12, true);

// The same, but for 24bit words we create to get a field that spans
// two 12bit subwords.
const DRAMWordBits = new WordBits(24, true);

// A word of CRAM or DRAM. These are overloaded a bit with properties
// for their address (a), their data (words), the field definitions
// they have (defs), and each field defined for this particular type
// of RAM (other names).
class XRAMWord {

  constructor(a, words, defs) {
    this.a = a;
    this.words = words;
    this.defs = defs;
  }

  f(fieldName) {
    return this[fieldName];
  }
}


const conditionals = {};

`\
.SET/TRUE=1            ; Define TRUE for ifStack
.SET/SNORM.OPT=1
.SET/XADDR=1
.SET/EPT540=1
.SET/LONG.PC=1
.SET/MODEL.B=1
.SET/KLPAGE=1
.SET/FPLONG=0
.SET/BLT.PXCT=1
.SET/SMP=0		;No SMP (DOES RPW instead of RW FOR DPB, IDPB)
.SET/EXTEXP=1
.SET/MULTI=1		;DOES NOT CACHE PAGE TABLE DATA
.SET/NOCST=1		;DOES NOT DO AGE UPDATES, ETC. WITH CST = 0
.SET/OWGBP=1		;ONE WORD GLOBAL BYTE POINTERS
.SET/IPA20=1		;IPA20-L
.SET/GFTCNV=0		;DO NOT DO GFLOAT CONVERSION INSTRUCTIONS [273]
			;SAVES 75 WORDS. MONITOR WILL TAKE CARE OF THEM.
`.split(/\n/)
  .forEach(d => {
    const m = d.match(/\.SET\/([^=]+)=(\d+)/)
    if (!m) return;
    const [_, def, val] = m;
    conditionals[def] = +val;
  });


// Read DEFINE.MIC for all field definitions and the names of field values.
function readAndHandleDirectives(cramDefs, dramDefs) {
  // These point to one or the other as we go through define.mic.
  let fieldDefs = cramDefs;
  let ramName = 'CRAM';

  const ifStack = ['TRUE'];
  let fn = null;
  let widest = 0;

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
  delete cramDefs.U23;
  delete cramDefs.U42;
  delete cramDefs.U45;
  delete cramDefs.U48;
  delete cramDefs.U51;
  delete cramDefs.U73;
}


function parse(lines, re) {
  const ram = [];
  const defs = {};

  // This has to be a forEach() loop because the RAM is declared in
  // random address order so map() is not applicable.
  lines.forEach(line => {
    const m = line.match(re);
    if (!m) return;
    const a = parseInt(m[1], 8);
    const words = m.slice(2).map(w => parseInt(w, 8));
    ram[a] = new XRAMWord(a, words, defs);
  });

  return [ram, defs];
}


function makeFieldsSymbolic(row, defs, fn) {
  let valSyms = _.invert(defs[fn]);
  let fVal = getField(row, defs[fn]);
  if (valSyms[fVal]) fVal = valSyms[fVal];
  row[fn] = fVal;
}


// This can be used to extract a field's (specified by def) value from
// either a cram or dram row.
function getField(row, def) {
  const bpsw = CRAMWordBits.bpw;
  const sw = Math.trunc(def.s / bpsw); // Word index of start bit
  const ew = Math.trunc(def.e / bpsw); // Word index of end bit
  const n = def.e - def.s + 1;	       // Number of bits wide

  if (sw === ew) {		// Simplest case: s and e are in same word
    const sb = def.s % bpsw;	// Start bit # within word
    const eb = def.e % bpsw;	// End bit # within word
    return CRAMWordBits.getMiddleBits(row.words[sw], eb, n);
  } else {
    const w24 = (row.words[sw] << bpsw) | row.words[ew];
    const eb = bpsw + def.e % bpsw;	// End bit # within dword
    return DRAMWordBits.getMiddleBits(w24, eb, n);
  }
}


function main() {

  // Read our microcode assembly listing so we can suck out its brainz.
  const ucodeListing = _.takeWhile(
    fs.readFileSync('klx.mcr').toString().split(/[\n\r\f]+/),
    line => !line.match(/^\s+END\s*$/));

  // The xram arrays are the XRAMWord representation of the microcode.
  //
  // The xramDefs objects are indexed by microcode field. Each property
  // there defines an object whose properties are the field value names
  // corresponding values for that field.
  const [cram, cramDefs] = parse(ucodeListing,
                                 /^U\s+(\d+), (\d+),(\d+),(\d+),(\d+),(\d+),(\d+),(\d+).*/);
  // Fill each CRAM word's entry with fieldName: values for every field.
  cram.forEach(
    row => Object.getOwnPropertyNames(cramDefs).forEach(
      fn => makeFieldsSymbolic(row, cramDefs, fn)
    )
  );

  // Same for DRAM
  const [dram, dramDefs] = parse(ucodeListing,
                                 /^D\s+(\d+), (\d+),(\d+).*/);
  dram.forEach(
    row => Object.getOwnPropertyNames(dramDefs).forEach(
      fn => makeFieldsSymbolic(row, dramDefs, fn)
    )
  );

  readAndHandleDirectives(cramDefs, dramDefs);


  if (1) {
    console.log("cram[0142]=", cram[0o142].words.map(w => _.padStart(w.toString(8), 4, '0')));

    [
      {s:  0, e:  8},
      {s: 15, e: 23},
      {s:  9, e: 20}
    ]
      .forEach(
        d => console.log(`getField(0142, ${d.s}/${d.e}) = ` +
                         `${getField(cram[0o142], d).toString(8)}`)
      );
  }
}


main();
