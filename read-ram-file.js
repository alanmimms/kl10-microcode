'use strict';
const fs = require('fs');
const util = require('util');
const {octal,oct6} = require('./util');


function decode(s) {

  return s.split('').reduce((sum, cur) => {
    let ch = cur.charCodeAt(0);

    if (ch >= 0o100) ch -= 0o100;
    return (sum << 6) | ch;
  }, 0);
}


function dump(lines) {

  lines.forEach(line => {
    const recType = line[0];
    if (recType === undefined || recType === ';') return;

    const dataS = line.slice(2);
    const [wc, adr, ...data] = dataS.split(/,/).map(decode);
    const checksum = data.pop();

    switch(recType) {
    case 'Z':
      const count = data[0];
      console.log(`Zero ${wc}@${octal(adr)} count=${count}`);
      break;

    case 'C':
    case 'D':
      const dataS = data.map((w, x) => oct6(w) + (x % 6 === 5 ? '\n            ' : '')).join(',');
      console.log(`${recType === 'C' ? 'CRAM' : 'DRAM'} ${wc}@${octal(adr)}:${dataS}`);
      break;

    default:
      console.log(`Unknown recType: "${recType}"`);
      break;
    }
  });
}


function main() {
  const eboxa = fs.readFileSync('kl10-source/eboxa.ram').toString().split(/\n/);
  console.log(`
EBOX A:`);
  dump(eboxa);

  const eboxb = fs.readFileSync('kl10-source/eboxb.ram').toString().split(/\n/);
  console.log(`
EBOX B:`);
  dump(eboxb);
}


main();
