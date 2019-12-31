'use strict';
const fs = require('fs');
const util = require('util');


function decode(s) {

  return s.split('').reduce((sum, cur) => {
    const ch = cur.charCodeAt(0);

    if (ch >= 0o100) ch -= 0o100;
    return (sum << 6) | ch;
  }, 0);
}


function dump(lines) {

  lines.forEach(line => {
    const recType = line[0];
    const dataS = line.slice(2);
    const data = dataS.split(/,/).map(decode);
  });
}


function main() {
  const eboxaS = fs.readFileSync('kl10-source/eboxa.ram').toString().split(/\n/);
  dump(eboxaS);

  const eboxbS = fs.readFileSync('kl10-source/eboxb.ram').toString().split(/\n/);
  dump(eboxbS);
}
