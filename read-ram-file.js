'use strict';
const _ = require('lodash');
const fs = require('fs');
const util = require('util');
const {octal, oct6, fieldExtract} = require('./util');
const {cramFields} = require('./fields-model');
const {unusedCRAMFields, CR} = require('./ebox-model');


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

  for (let k = 0, shift = 0n; shift < 79n; ++k, shift += 16n) {
    w = (w << shift) | BigInt(a[k]);
  }

  return w;
}


function decodeLines(lines) {
  const ram = [];

  lines.forEach(line => {
    const recType = line[0];
    if (recType === undefined || recType === ';') return;
    const dataS = line.slice(2);
    const decoded = dataS.split(/,/).map(decodeSplats);

    switch(recType) {
    case 'Z':
      const [zWC, zAdr, zCount, zCksum] = decoded;
      console.log(`Zero ${zWC}@${octal(zAdr)} count=${zCount}. cksum=${zCksum}.`);
      break;

    case 'C':
    case 'D':
      const [wc, adr, ...a] = decoded;
      const checksum = a.pop();
      const dump = a.map((w, x) => oct6(w) + (x % 6 === 5 ? '\n          ' : '')).join(',');
      console.log(`${recType === 'C' ? 'CRAM' : 'DRAM'} ${octal(adr)}: ${dump}`);

      if (recType === 'C') {

        for (let adrOffset = 0, k = 0; k < a.length; k += 6) {
          ram[adr + adrOffset++] = joinSplats(a.slice(k, k + 6));
        }
      }

      break;

    default:
      console.log(`Unknown recType: "${recType}"`);
      break;
    }
  });

  return ram;
}


function disassembleCRAMWord(w, a) {
  const wSplit = _.range(0, 84, 12).reduce((cur, s) => cur.concat([octal(fieldExtract(w, s, s+11, 84))]), []);
  CR.value = w;

  const dis = fieldsByBit.filter(names => !unusedCRAMFields.includes(names[0])).map(names => {
    const name = names[0];
    const field = cramFields[name];
    return `${names[0]}/${fieldExtract(w, field.s, field.e, 84)}`;
  }).join(', ');

  console.log(`U ${octal(a)}: ${wSplit}  ${dis}`);
}


function main() {
  const [ramA, ramB] = ['kl10-source/eboxa.ram', 'kl10-source/eboxa.ram']
        .map(fileName => decodeLines(fs.readFileSync(fileName)
                                     .toString()
                                     .split(/\n/)));

  ramA.forEach((w, a) => disassembleCRAMWord(w, a));
}


main();
