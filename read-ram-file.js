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


function decodeSplats(s) {

  return s.split('').reduce((sum, cur) => {
    let ch = cur.charCodeAt(0);

    if (ch >= 0o100) ch -= 0o100;
    return (sum << 6) | ch;
  }, 0);
}


// Take a LSB-first group of six CRAM splats and turn them into a CRAM word.
function joinSplats(a) {
  let w = 0n;

  for (let k = 0, shift = 0n; shift < 80n; ++k, shift += 16n) {
    w = (w << shift) | BigInt(a[k]);
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
    const decoded = dataS.split(/,/).map(decodeSplats);

    switch(recType) {
    case 0:                     // Ignore lines with NULs and comment lines
    case ';':
      break;

    case 'Z':
      const [zWC, zAdr, zCount, zCksum] = decoded;
//      console.log(`Zero ${zWC}@${octal(zAdr)} count=${zCount}. cksum=${zCksum}.`);
      break;

    case 'C':
    case 'D':
      const [wc, adr, ...a] = decoded;
      const checksum = a.pop();
      const dump = a.map((w, x) => oct6(w) + (x % 6 === 5 ? '\n          ' : '')).join(',');
//      console.log(`${recType === 'C' ? 'CRAM' : 'DRAM'} ${octal(adr)}: ${dump}`);

      if (recType === 'C') {

        for (let adrOffset = 0, k = 0; k < a.length; k += 6) {
          ram[adr + adrOffset++] = joinSplats(a.slice(k, k + 6));
        }
      }

      break;

    default:
      console.error(`Unknown recType: "${recType}"`);
      break;
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
    pieces.push(`ADB/${maybeSymbolic(W.ADB)}`);
    if (ar) pieces.push(`AR/${maybeSymbolic(W.AR)}`);
    if (arx) pieces.push(`ARX/${maybeSymbolic(W.ARX)}`);
  }

  // Save the best for last
  pieces.push(`J/${octal(W.J.get())}`);

  console.log(`U ${octal(a)}: ${wSplit}  ${pieces.join(', ')}`);
}


function main() {
  const [klx, ramA, ramB] = ['kl10-source/klx.ram', 'kl10-source/eboxa.ram', 'kl10-source/eboxa.ram']
        .map(fileName => decodeLines(fs.readFileSync(fileName)
                                     .toString()
                                     .split(/\n/)));

  klx.forEach((w, a) => disassembleCRAMWord(w, a));
}


main();
