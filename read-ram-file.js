'use strict';
const _ = require('lodash');
const fs = require('fs');
const util = require('util');
const {octal, oct6, fieldExtract, maskForBit, fieldMask} = require('./util');
const {cramFields} = require('./fields-model');
const {unusedCRAMFields, CRAMdefinitions, defineBitFields, EBOX, ConstantUnit} = require('./ebox');


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
    if (recType === undefined) return;
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
//      console.log(`${recType === 'C' ? 'CRAM' : 'DRAM'} ${octal(adr)}: ${dump}`);

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


function maybeSymbolic(field) {
  const v = field.get();
  return field.namesForValues[v] || octal(v);
}


const W = ConstantUnit({name: 'WORD', bitWidth: 84, value: 0});
defineBitFields(W, CRAMdefinitions);


function needsADB(ad) {
  return W.AD.namesForValues[ad].includes('B');
}


function disassembleCRAMWord(w, a) {
  EBOX.reset();
  W.value = w;
  const wSplit = _.range(0, 84, 12).reduce((cur, s) => cur.concat([octal(fieldExtract(w, s, s+11, 84))]), []);

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
  const [ad, ada, adb, ar, arx] = 'AD,ADA,ADB,AR,ARX'.split(/,/).map(f => W[f].get());

  if (ad || ada || adb ||
      ar === W.AR.AD || ar === W.AR['AD*2'] || ar === W.AR['AD*.25'] ||
      arx === W.ARX.AD || arx === W.ARX['ADX*2'] || arx === W.ARX.ADX || arx === W.ARX['ADX*.25'])
  {
    pieces.push(`AD/${maybeSymbolic(W.AD)}`);

    pieces.push(`ADA/${maybeSymbolic(W.ADA)}`);
    if (needsADB(ad)) pieces.push(`ADB/${maybeSymbolic(W.ADB)}`);
    if (ar) pieces.push(`AR/${maybeSymbolic(W.AR)}`);
    if (arx) pieces.push(`ARX/${maybeSymbolic(W.ARX)}`);
  }

  // Save the best for last
  pieces.push(`J/${octal(W.J.get())}`);

  console.log(`U ${octal(a)}: ${wSplit}  ${pieces.join(', ')}`);
}


function main() {
  const [klx, eboxB] = ['kl10-source/klx.ram', 'kl10-source/eboxb.ram']
        .map(fileName => decodeLines(fs.readFileSync(fileName)
                                     .toString()
                                     .split(/\n/)));

  klx.forEach((w, a) => disassembleCRAMWord(w, a));
}


main();
