'use strict';
const _ = require('lodash');
const fs = require('fs');
const util = require('util');
const CLA = require('command-line-args');

const {octal, oct6, fieldExtract, maskForBit, fieldMask} = require('./util');
const {cramFields} = require('./fields-model');
const {unusedCRAMFields, CRAMdefinitions, defineBitFields, EBOX, ConstantUnit} = require('./ebox');

var seq = 0;


const optionList = [
  {
    name: 'ramName', defaultOption: true, defaultValue: 'kl10-source/eboxb.ram', type: String,
    description: 'RAM file to load (e.g., kl1-source/eboxb.ram)',
  },
];


const OPT = parseOptions(optionList);


function parseOptions(list) {
  let result = null;

  try {
    result = CLA(optionList, {camelCase: true});
  } catch(e) {
    usage(e.msg);
  }

  if (!result.ramName) usage();
  return result;
}


function usage(msg) {
  console.error(`Must specify a file to load.`);
  process.exit();
  return null;
}


// List of field names in an array indexed by leftmost bit.
const fieldsByBit = Object.entries(cramFields).reduce((fields, [name, o]) => {
  fields[o.s] = (fields[o.s] || []).concat([name]);
  return fields;
}, []).sort((a, b) => 0);


function decodeSplat(s) {

  return s.split('').reduce((sum, cur) => {
    let ch = cur.charCodeAt(0);

    if (ch >= 0o100 && ch < 0o175) ch -= 0o100;
    return (sum << 6) | ch;
  }, 0);
}

// U 0000, 1072,0001,0000,0000,0000,0024,0020
// U 0001, 0366,0001,0000,0000,0117,0010,0000
// C ^,,,,J@@,,Hz,T,B@,O@@,H@@,,Cv,H,,E@@,H@G,,H,[,H@B,B`@,,k@,,A,B,Ba`,K@,j@,`@,A,BnF
// 000000,000000,120000,000000,001072,000024,
// 000200,170000,100000,000000,000366,000010,
// 000000,050000,100007,000000,000010,000033,
// 100002,024000,000000,005300,000000,000001,
// 000002,024140,001300,005200,004000,000001

// Take a group of six CRAM splats and turn them into a CRAM word. At
// first you might think the documentation in text at the top of in
// CONVRT.SEQ tells you how the CRAM data is stored. But this is not
// correct. It is actually stored one bit at a time, extracted from
// three MSB first 36-bit words (left aligned) using a loop of ILDBs:
//
// MOVE T1,[POINT 1,HICORE(INDX)]
// ...
// ILDB T2,T1
//
// Each bit is then deposited into a 16-bit word using a table indexed
// by CRAM bit number containing a unique byte pointer for each bit
// (see table below). Each 16-bit word ends up right-aligned in its
// own 36-bit word during this process, and the UNUSED CRAM bits are
// not simply left out.
//
// When this is all done, all six of the 16-bit words are "asciized"
// at CRMCNV through successive calls to PUT11, making 3 ASCII
// characters per 16-bit word with leading two zero oits or leading
// one zero oit suppressed at PUTS11. `decodeSplat()` is implemented
// to support any number of six bit oits for simplicity.
//
// This is really fucking baroque and I hate it. But it works.
//
// The swizzles below are derived from the byte pointer table used in
// CONVRT.MAC. We deposit the oits into 16-bit image and then use
// index of each entry to cherry pick them backwards into the CRAM
// word.
const swizzles = `\
-1,35	;UNUSED		0
+4,25	;J00
+4,26	;J01
+4,27	;J02
+4,28	;J03
+4,29	;J04
+4,30	;J05
+4,31	;J06
+4,32	;J07
+4,33	;J08
+4,34	;J09		10
+4,35	;J10
+0,30	;AD CRY
+3,28	;AD BOOLE
+3,24	;AD SEL 8
+3,25	;AD SEL 4
+3,26	;AD SEL 2
+3,27	;AD SEL 1
+3,29	;ADA DIS
+3,30	;ADA SEL 2
+3,31	;ADA SEL 1	20
-1,34	;UNUSED
+3,32	;ADB SEL 2
+2,20	;ADB SEL 1
+2,33	;ARM SEL 4
+0,20	;ARM SEL 2
+0,22	;ARM SEL 1
+2,24	;ARXM SEL 4
+0,24	;ARXM SEL 2
+0,26	;ARXM SEL 1
+1,24	;BR LOAD	30
+1,26	;BRX LOAD
+3,20	;MQ SEL
+1,28	;FM ADR SEL 4
+1,29	;FM ADR SEL 2
+1,30	;FMADR SEL 1	35
+4,21	;SCAD 4		36
+4,22	;SCAD 2
+4,23	;SCAD 1
+4,20	;SCADA DIS
+2,28	;SCADA SEL 2	40
+2,29	;SCADA SEL 1
-1,33	;UNUSED
+2,30	;SCADB SEL 2
+1,32	;SCADB SEL 1
-1,32	;UNUSED
+1,34	;SCM SEL 2
+4,24	;FE LOAD
-1,31	;UNUSED
+2,34	;ARMM SEL 2
+2,35	;ARMM SEL 1	50
-1,30	;UNUSED
+2,32	;VMAM SEL 2
+0,28	;VMAM SEL 1
+0,32	;T00
+0,34	;T01
+1,20	;MEM 00
+1,21	;MEM 01
+1,22	;MEM 02
+1,23	;MEM 03
+3,21	;COND 00	60
+3,22	;COND 01
+3,23	;COND 02
+1,25	;COND 03
+1,27	;COND 04
+1,31	;COND 05
+5,30	;CALL (EXTENDED ADDRESSING)
+5,31	;SPEC 00
+5,32	;SPEC 01
+5,33	;SPEC 02
+5,34	;SPEC 03	70
+5,35	;SPEC 04	71
-1,28	;UNUSED		72
-1,27	;UNUSED
+2,31	;MARK
+3,33	;# 00
+3,34	;# 01
+3,35	;# 02
+2,21	;# 03
+2,22	;# 04
+2,23	;# 05		80
+2,25	;# 06
+2,26	;# 07
+2,27	;# 08		83`
      .split(/\n/)
      .map(line => {
        const wx = parseInt(line);
        const bx = parseInt(line.slice(3));
        return {wx, bx};
      });

function joinSplats(a) {
  let w = 0n;

  for (let k = 0; k < 84; ++k) {
    w <<= 1n;
    const {wx, bx} = swizzles[k];
    if (wx >= 0 && (maskForBit(bx) & BigInt(a[wx]))) w |= 1n;
  }

  return w;
}


function decodeLines(lines) {
  const ram = [];
  const eof = lines.indexOf(';EOF');

  if (eof > 0) lines = lines.slice(0, eof);

  lines.forEach(line => {
    const recType = line[0];
    if (!recType) return;
    const dataS = line.slice(2);

    if (recType === 0 || recType === ';') return;

    const decoded = dataS.split(/,/).map(decodeSplat);

    if (recType === 'Z') {
      const [wc, adr, count, cksum] = decoded;
//      console.log(`Zero ${wc}@${octal(adr)} count=${count}. cksum=${cksum}.`);
    } else if (recType === 'C' || recType === 'D') {
      const [wc, adr, ...a] = decoded;
      const checksum = a.pop();
      const dump = a.map((w, x) => oct6(w) + (x % 6 === 5 ? '\n          ' : '')).join(',');
//      if (adr < 0o20) console.log(`${recType === 'C' ? 'CRAM' : 'DRAM'} ${octal(adr)}: ${dump}`);

      if (recType === 'C') {

        for (let adrOffset = 0, k = 0; k < a.length; k += 6) {
          ram[adr + adrOffset++] = joinSplats(a.slice(k, k + 6));
        }
      }

    } else {
      console.error(`Unknown recType: "${recType}"`);
    }
  });

  return ram;
}


const W = ConstantUnit({name: 'WORD', bitWidth: 84, value: 0});
defineBitFields(W, CRAMdefinitions);


// List of AD/xxx values that require the A parameter
const needsAList = `\
A+1,A+XCRY,A+ANDCB,A+AND,A*2,A*2+1,OR+1,OR+ANDCB,A+B,A+B+1,A+OR,\
ORCB,A-B,A-B,AND+ORCB,A+ORCB,ANDCB-1,AND-1,A-1,SETCA,ORC,ORCA,ANDC,NOR,EQV,ORCB,ANDCA,\
XOR,OR,ANDCB,AND,A,CRY A EQ -1,CRY A.B#0,CRY A#0,CRY A GE B`
      .split(/,/)
      .map(fieldName => W.AD[fieldName]);

const needsBList = `\
A+ANDCB,A+AND,OR+1,OR+ANDCB,A+B,A+B+1,A+OR,ORCB+1,A-B-1,A-B,AND+ORCB,A+ORCB,ANDCB-1,\
AND-1,ORC,ORCA,ANDC,NOR,SETCB,EQV,ORCB,ANDCA,XOR,B,OR,ANDCB,AND,CRY A.B#0,CRY A GE B`
      .split(/,/)
      .map(fieldName => W.AD[fieldName]);


function disassembleCRAMWord(w, a, macros) {
  EBOX.reset();
  W.value = w;

  const wSplit = _.range(0, 84, 12)
        .reduce((cur, s) => cur.concat([octal(fieldExtract(w, s, s+11, 84))]),
                []);

  // Compute mask of CRAM word bits we need to disassemble. This is
  // gradually zeroed as we proceed disassembling this word.
  let remainingMask = fieldMask(0, 83, 84);
  unusedCRAMFields.forEach(name => {
    const {s, e} = cramFields[name];
    remainingMask &= ~fieldMask(s, e, 84);
  });

  // Clear bits for J since we do it at the end
  remainingMask &= ~fieldMask(W.J.s, W.J.e);

  const pieces = [];
  const [ad, ada, adb, ar, arx, arl] = 'AD,ADA,ADB,AR,ARX,ARL'
        .split(/,/)
        .map(f => W[f].get());

  if (ad || ada || adb ||
      ar === W.AR.AD ||
      ar === W.AR['AD*2'] || ar === W.AR['AD*.25'] ||
      arx === W.ARX.AD || arx === W.ARX['ADX*2'] ||
      arx === W.ARX.ADX || arx === W.ARX['ADX*.25'])
  {
    if (ad) pieces.push(setFor('AD'));

    if (W['ADA EN'].get())
      pieces.push(`ADA EN/0S`);
    else
      if (needsAList.includes(ad)) pieces.push(setFor('ADA'));

    if (needsBList.includes(ad)) pieces.push(setFor('ADB'));
    if (ar) pieces.push(setFor('AR'));
    if (arx) pieces.push(setFor('ARX'));
  }

  if (W.BR.get()) pieces.push(`BR/AR`);
  if (W.BRX.get()) pieces.push(`BRX/ARX`);

  const spec = W.SPEC.get();
  const specName = W.SPEC.namesForValues[spec];
  const skip = W.SKIP.get();
  const skipName = W.SKIP.namesForValues[skip];
  const cond = W.COND.get();
  const condName = W.COND.namesForValues[cond];
  const mq = W.MQ.get();

  if (spec === W.SPEC['MQ SHIFT']) {
    pieces.push(`MQ/${mq ? 'MQ*.25' : 'MQ*2'}`);
  } else if (cond === W.COND['REG CTL']) {
    const mqCtl = W['MQ CTL'].get();

    if (mq === W.MQ['MQ SEL']) {
      pieces.push(`MQ/MQ SEL`);

      switch(mqCtl) {
      case W['MQ CTL'].MQ:
        pieces.push(`MQ CTL/MQ`);
        break;

      case W['MQ CTL']['MQ*2']:
        pieces.push(`MQ CTL/MQ*2`);
        break;

      case W['MQ CTL']['0S']:
        pieces.push(`MQ CTL/0S`);
        break;
      }
    } else {
      pieces.push(`MQ/MQM SEL`);

      switch(mqCtl) {
      case W['MQ CTL'].SH:
        pieces.push(`MQ CTL/SH`);
        break;

      case W['MQ CTL']['MQ*.25']:
        pieces.push(`MQ CTL/MQ*.25`);
        break;

      case W['MQ CTL']['1S']:
        pieces.push(`MQ CTL/1S`);
        break;

      case W['MQ CTL'].AD:
        pieces.push(`MQ CTL/AD`);
        break;
      }
    }
  } else if (mq) {
    pieces.push(`MQ/SH`);
  }

  const fmadr = W.FMADR.get();

  if (spec === W.SPEC['FM WRITE'] || fmadr) {
    pieces.push(setFor('FMADR'));
  }

  const sc = W.SC.get();
  const fe = W.FE.get();
  const armm = W.ARMM.get();
  const disp = W.DISP.get();

  if (sc || fe ||
      armm === W.ARMM['SCAD EXP'] || armm === W.ARMM['SCAD POS'] ||
      skip === W.SKIP['SCAD0'] || skip === W.SKIP['SCAD#0'] ||
      disp === W.DISP.BYTE)
  {
    pieces.push(setFor('SCAD'));
    pieces.push(setFor('SCADA'));
    pieces.push(setFor('SCADB'));
  }

  if (spec === W.SPEC['SCM ALT']) {
    pieces.push(`SC/${sc ? 'FE' : 'AR SHIFT'}`);
  } else if (sc) {
    pieces.push(`SC/SCAD`);
  }

  if (ar === W.AR.SH || arx === W.ARX.SH ||
      mq === W.MQ.SH || disp === W.DISP['SH0-3'] ||
      arl === W.ARL.SH)
  {
    pieces.push(setFor('SH'));
  } else if (W.AR.get() === W.AR.ARMM && W.COND.get() === W.COND['ARL IND']) {
    pieces.push(setFor('ARMM'));
  } else if (W.SPEC.get() === W.SPEC['SP MEM CYCLE']) {
    pieces.push(setFor('VMAX'));
  }

  if (specName) {
    pieces.push(`SPEC/${specName}`);

    switch(spec) {
    case W.SPEC['FLAG CTL']:
      pieces.push(setFor('FLAG CTL'));
      break;

    case W.SPEC['SP MEM CYCLE']:
      pieces.push(setFor('FLAG CTL'));
      break;
    }
  }

  const magic = W['#'].get();
  const acb = W['ACB'].get();
  const acOp = W['AC-OP'].get();
  const mem = W.MEM.get();

  if (skipName) pieces.push(`SKIP/${skipName}}`);
  if (condName) pieces.push(`COND/${condName}`);
  if (W.VMA.get()) pieces.push(setFor('VMA'));

  if (W.MEM.get()) pieces.push(setFor('MEM'));
  if (disp < 8n || disp >= 0o30n && disp < 0o40n) pieces.push(setFor('DISP'));

  if (cond === W.COND['SR_#'] ||
      cond === W.COND['LOAD IR'] ||
      cond === W.MEM['A RD'])
  {
    pieces.push(`PXCT/${octal(W.PXCT.get(), 3)}`);
  }

  if (fmadr === W.FMADR['#B#']) {
    pieces.push(setFor('ACB'));
    pieces.push(`AC#/${octal(W['AC#'].get(), 2)}`);
  }

  if (cond === W.COND['FM WRITE'] && acOp) {
    pieces.push(setFor('AC-OP'));
    pieces.push(`AC#/${octal(W['AC#'].get(), 2)}`);
  }

  if (spec === W.SPEC['ARL IND']) {
    if (W['AR0-8'].get()) pieces.push(`AR0-8/LOAD`);
    if (W.CLR.get()) pieces.push(setFor('CLR'));
    if (W.ARL.get()) pieces.push(setFor('ARL'));
  } else if (cond === W.COND['REG CTL']) {
    if (W['EXP TST'].get()) pieces.push(`EXP TST/AR_EXP`);
  } else if (cond === W.COND['PCF_#']) {
    if (W['PC FLAGS'].get()) pieces.push(setFor('PC FLAGS'));
  } else if (spec === W.SPEC['FLAG CTL']) {
    if (W['FLAG CTL'].get()) pieces.push(setFor('FLAG CTL'));
  } else if (cond === W.COND['SPEC INSTR']) {
    if (W['SPEC INSTR'].get()) pieces.push(setFor('SPEC INSTR'));
  } else if (mem === W.MEM.FETCH) {
    if (W['FETCH'].get()) pieces.push(setFor('FETCH'));
  } else if (mem === W.MEM['EA CALC']) {
    if (W['EA CALC'].get()) pieces.push(setFor('EA CALC'));
  } else if (mem === W.MEM['SP MEM CYCLE']) {
    if (W['SP MEM'].get()) pieces.push(setFor('SP MEM'));
  } else if (mem === W.MEM['REG FUNC']) {
    if (W['MREG FNC'].get()) pieces.push(setFor('MREG FNC'));
  } else if (mem === W.MEM['MBOX CTL']) {
    if (W['MBOX CTL'].get()) pieces.push(setFor('MBOX CTL'));
  } else if (spec === W.SPEC['MTR CTL']) {
    if (W['MTR CTL'].get()) pieces.push(setFor('MTR CTL'));
  } else if (cond === W.COND['EBUS CTL']) {
    if (W['EBUS CTL'].get()) pieces.push(setFor('EBUS CTL'));
  } else if (cond === W.COND['DIAG FUNC']) {
    if (W['DIAG FUNC'].get()) pieces.push(setFor('DIAG FUNC'));
  } else {
    pieces.push(`#/${octal(magic, 3)}`);
  }

  // Save the best for last
  pieces.push(`J/${octal(W.J.get())}`);

  // Create disS with first line prefixed by codeS and all subsequent
  // lines prefixed by the same number of blanks.
  const codeS = `U ${octal(a)}, ${wSplit}`;
  const makeSeq = s => s.toString().padStart(4);
  const lineWidthMax = 130;

  const disS = pieces.reduce((accum, piece, n) => {
    const lastNL = accum.lastIndexOf('\n');
    const lastLineLen = lastNL < 0 ? accum.length : accum.length - lastNL;

    if (lastLineLen + piece.length > lineWidthMax) {
        accum += `,\n${''.padStart(codeS.length)}\t; ${makeSeq(++seq)}          `;
    } else if (n !== 0) {
      accum += ', ';
    }

    accum += piece;
    return accum;
  }, `${codeS}\t; ${makeSeq(++seq)}  `);

  console.log(disS);


  function setFor(fieldName) {
    const field = W[fieldName];
    const v = field.get();
    const value = field.namesForValues[v] || octal(v);
    return `${fieldName}/${value}`;
  }
}


function parseMacros(src) {
  let DCODEseen = false;

  return src.split(/\n/).reduce((list, line) => {
    let m;

    if (DCODEseen) return list; // Ignore all lines afer .DCODE
    line = line.replace(/;.*/, '');    // Remove comments

    // Ignore .XXX directives, but note the one that is our end sentinel (.DCODE).
    if ((m = line.match(/^\s*\.([A-Za-z0-9.$%@]+)/))) {
      if (m[1] === 'DCODE') DCODEseen = true;
      return list;
    } else if (line.match(/^\s*$/)) return list; // Ignore blank lines

    m = line.match(/^(.*?)\s+"([^"]*)/);

    if (!m) {
      console.error(`Unrecognized MACRO.MIC line syntax: "${line}"`);
      return list;
    }

    const [, macro, expansion] = m;
    const parameterized = expansion.includes('@');
    list[macro] = {expansion, parameterized, fields: {}};
    return list;
  }, {});
}


function markMacroFields(macros) {
  // Enable W to work properly with all bitwidths populated
  EBOX.reset();

  Object.entries(macros)
    .filter(([macName, mac]) => !mac.parameterized)
    .forEach(([macName, mac]) => {
      // Break macro expansion into field-sets so we can expand any macros therein.
      const sets = mac.expansion.split(/,\s*/);
      let did1 = true;

      // Keep expanding entire list over and over until no expansions occur
      while (did1) {
        did1 = false;

        sets.forEach((set, x) => {
          const [field, value] = set.split(/\//);

          if (value == null) {    // No value means it must be a macro name
            const m = macros[field];

            if (!m) {
              console.error(`Undefined macro "${field}" requested`);
            } else {
              const expansionSets = m.expansion.split(/,\s*/);
              sets.splice(x, 1, ...expansionSets);
              did1 = true;
            }
          } else {
            mac.fields[field] = value;
          }
        });
      }

      // Set all bits in each bitfield covered by each field defined in
      // the full expansion.
      sets.forEach(set => {
        const [field, ] = set.split(/\//);
        W[field] = W[field].ones;
      });

      // Remember the bits covered in this macro expansion.
      mac.coverage = W.value;
    });
}


function main() {
  parseOptions();
  const macros = parseMacros(fs.readFileSync('kl10-source/macro.mic').toString());
  markMacroFields(macros);

  decodeLines(fs.readFileSync(OPT.ramName).toString().split(/\n/))
    .forEach((w, a) => disassembleCRAMWord(w, a, macros));
}


main();
