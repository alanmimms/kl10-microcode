'use strict';
var fs = require('fs');
var _ = require('lodash');

// This WordBits instance allows us to extract bitfields from the
// 12-bit subwords of the CRAM and DRAM words, with the bits numbered
// as PDP10s number them - MSB is bit #0.
let WordBits = require('./wordbits.js');
const XRAMWord = new WordBits(12, true);

// The same, but for 24bit words we create to get a field that spans
// two 12bit subwords.
const XRAMDWord = new WordBits(24, true);

const defsString = `
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
`;

var defs = {TRUE: 1};		// Define TRUE for ifStack

defsString.split(/\n/).forEach(d => {
  if (d.match(/^\s+;.*/)) return;
  let f = d.split(/[/=]|\s+/);
  if (f[0] !== '.SET') return;
  defs[f[1]] = +f[2].trim();
});

//console.log('Defs=', defs);

var ucode = fs.readFileSync('klx.mcr')
  .toString()
  .split(/[\n\r\f]+/);

var keeping = true;
ucode = ucode.filter(line => {
  keeping &= !line.match(/^\s+END\s*$/);
  return keeping;
});

var cramLines = ucode.filter(line => line.match(/^U/));
var dramLines = ucode.filter(line => line.match(/^D/));

console.log(`cram len=${cramLines.length}  dram len=${dramLines.length}`);

var cram = [];
var dram = [];

cramLines.forEach(l => {
  let m = l.match(/^U\s+(\d+), (\d+),(\d+),(\d+),(\d+),(\d+),(\d+),(\d+).*/);
  if (!m) {console.log("cram mismatch:", l); return}
  let a = parseInt(m[1], 8);
  let words = m.slice(2).map(w => parseInt(w, 8));
  cram[a] = {a, words};
});

//console.log("cram=", cram);

dramLines.forEach(l => {
  let m = l.match(/^D\s+(\d+), (\d+),(\d+).*/);
  if (!m) {console.log("dram mismatch:", l); return}
  let a = parseInt(m[1], 8);
  let words = m.slice(2).map(w => parseInt(w, 8));
  dram[a] = {a, words};
});

//console.log("dram=", dram);


var fieldString = fs.readFileSync('define.mic').toString().split(/[\r\n\f]/);

var cramDefs = {};
var dramDefs = {};
var fieldDefs = cramDefs;	// This points to one or the other as we go through define.mic
var ramName = 'CRAM';

var fn = null;
var ifStack = ['TRUE'];
var widest = 0;

fieldString.forEach(f => {
  // Strip ^L
  f = f.replace(/\f/, '');

  // Strip comments
  f = f.replace(/\s*;.*/, '');

  // Handle directives
  var m = f.match(/^\s*\.(dcode|ucode|endif|ifnot|if)(?:\/([^\s]+))?.*/im);

  if (m) {
    let dir = m[1].toUpperCase();
    let name = m[2] ? m[2].toUpperCase() : '';

//    console.log("directive=", dir, name);

    switch (dir) {
    case 'DCODE':
      console.log(".DCODE");
      fieldDefs = dramDefs;
      ramName = 'DRAM';
      return;

    case 'UCODE':
      console.log(".UCODE");
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
  if (!defs[ifStack.slice(-1)[0]]) return;
  
  // Ignore other directives
  if (f.match(/^\s*\..*/)) return;

//  console.log("Def line?", f);

  var m = f.match(/^([^.][^/=]*)\/=<(\d+)(?::(\d+))?>.*/);

  if (m) {
    console.log(`${ramName}: ${m[1]}/=<${m[2]}${m[3]? ":" + m[3] : ''}>`);
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

//console.log("fieldDefs=", fieldDefs);
//console.log("widest=", widest);


function makeFieldsSymbolic(row, defs, fn) {
  let valSyms = _.invert(defs[fn]);
  let fVal = getField(row, defs[fn]);
  if (valSyms[fVal]) fVal = valSyms[fVal];
  row[fn] = fVal;
}


// Fill each CRAM word's entry with fieldName: values for every field.
cram.forEach(
  row => Object.getOwnPropertyNames(cramDefs).forEach(
    fn => makeFieldsSymbolic(row, cramDefs, fn)
  )
);

// Same for DRAM
dram.forEach(
  row => Object.getOwnPropertyNames(dramDefs).forEach(
    fn => makeFieldsSymbolic(row, dramDefs, fn)
  )
);

// Define muxes.
const muxes = 'ADA,ADB,AR,ARX,BR,BRX,MQ,FMADR,SCAD,SCADA,SCADA EN,SCADB'.split(/,/);

// Compute pseudocode for each CRAM microstep.
cram.forEach(row => {

});

console.log('cram=', cram);


// This can be used to extract a field's (specified by def) value from
// either a cram or dram row.
function getField(row, def) {
  const bpsw = XRAMWord.bpw;
  const sw = Math.trunc(def.s / bpsw); // Word index of start bit
  const ew = Math.trunc(def.e / bpsw); // Word index of end bit
  const n = def.e - def.s + 1;	       // Number of bits wide

  if (sw === ew) {		// Simplest case: s and e are in same word
    const sb = def.s % bpsw;	// Start bit # within word
    const eb = def.e % bpsw;	// End bit # within word
    return XRAMWord.getMiddleBits(row.words[sw], eb, n);
  } else {
    const w24 = (row.words[sw] << bpsw) | row.words[ew];
    const eb = bpsw + def.e % bpsw;	// End bit # within dword
    return XRAMDWord.getMiddleBits(w24, eb, n);
  }
}


if (0) {
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
