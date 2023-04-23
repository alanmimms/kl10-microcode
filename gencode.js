'use strict';

// Read and digest the microcode from the klx.mcr listing file,
// applying the conditions contained herein and the field names from
// define.mic. I know this is hacky as fuck. But it gets the job done
// and there will never be any new file format to handle.

const fs = require('fs');
const _ = require('lodash');
const util = require('util');
const StampIt = require('@stamp/it');

const {octal} = require('./util');
const EBOX = require('./ebox');
const {Named, EBOXUnit, CRAM, DRAM} = EBOX;

const cramDefs = {bpw: 84};
const dramDefs = {bpw: 12};
var cram, cramLines;
var dram;


function readMicroAssemblyListing() {
  // Read our microcode assembly listing so we can suck out its brainz.
  const ucodeListing = _.takeWhile(
    fs.readFileSync('kl10-source/klx.mcr').toString()
      .replace(/\f[^\n]*\n[^\n]*\n/g, '') // Elminate formfeeds and page headers
      .split(/[\n\r\f]+/),
    line => !line.match(/^\s+END\s*$/));

  // The xram arrays are the BigInt representation of the microcode
  // and the lines arrays are the strings of source code for each. The
  // xramDefs objects are indexed by microcode field. Each property
  // there defines an object whose properties are the field value
  // names corresponding values for that field.
  ({bytes: cram, linesArray: cramLines} =
   parse(ucodeListing,
         /^U\s+(\d+), (\d+),(\d+),(\d+),(\d+),(\d+),(\d+),(\d+).*/,
         /^.*?;NICOND \(NXT INSTR\)/));
  ({bytes: dram} = parse(ucodeListing, /^D\s+(\d+), (\d+),(\d+).*/));
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

  fs.readFileSync('kl10-source/define.mic')
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
//        console.log(`${ramName}: ${m[1]}/=<${m[2]}${m[3]? ":" + m[3] : ''}>`);
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
}


// Parse a line of microassembly listing, extracting address and code.
// This works for CRAM or DRAM with the only different controlled by
// the `re` parameter. `linesRE` (only specified for CRAM) is the
// position to reference as the start of source code for the first
// CRAM word.
function parse(lines, re, linesRE) {
  let lastPos = lines.findIndex(line => line.match(linesRE));

  // This has to be a reduce() instead of a map because the
  // microassembly listing builds microcode words in essentially
  // random address order.
  return lines.reduce(({bytes, linesArray}, line, lineX) => {
    const m = line.match(re);

    if (m) {
      const a = parseInt(m[1], 8);
      bytes[a] = `0o${m.slice(2).join('')}`;

      if (lastPos) {
        linesArray[a] = lines.slice(lastPos, lineX + 1).join('\n');
        lastPos = lineX + 1;
      }
    }

    return {bytes, linesArray};
  }, {bytes: [], linesArray: []});
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
    `// SPEC = ${octal(SPEC)}`,
  ];

  switch (SPEC) {
  case 0o15:                    // LOAD PC
    code.push(`PC.input = AR_12_35;`);
    break;

  case 0o24:                    // FLAG CTL
    const func = getField(mw, cramDefs, '#');

/*
    if (func === 0o20) {
      code.push(`SCD_FLAGS.input = AR_00_12;`);
    }
*/
    
    break;
  }

  return code;
}



function generateModel() {
  const moduleHeader = `\
'use strict';
`;

  const allCode = [
    moduleHeader,
    dumpDefs('cram', cramDefs),
    dumpDefs('dram', dramDefs),
  ].join('\n\n');
  
  fs.writeFileSync(`fields-model.js`, allCode, {mode: 0o664});


  function dumpDefs(typeName, defs) {
    return `module.exports.${typeName}Fields = ${util.inspect(defs)};`;
  }
}


function generateFunctions() {
  return _.range(CRAM.nWords).map(ma => {
    const mw = cram[ma];

    const headerCode = [
      `// uW = ${octal(mw, cramDefs.bpw/3)}`,
      `// J = ${octal(getField(mw, cramDefs, 'J'))}`,
      `// # = ${octal(getField(mw, cramDefs, '#'))}`,
    ].join('\n  ');

    const specCode = handleSPEC(mw);

    const latchCode = [];
    latchCode.push(`EBOX.latch();`);

    const clockCode = [];
    clockCode.push(`EBOX.clockEdge();`);

    return `\
function cram_${octal(ma)}(cpu) {
  ${[
    headerCode,
    latchCode,
    specCode,
    clockCode,
  ].flat().join('\n  ')
  }
},
`;
  }).join('\n\n');
}


function generateXRAMArray(wordsArray, bitWidth) {
  return wordsArray.map(mw => `${octal(mw, bitWidth/3, 0)}n`).join(',\n  ');
}


function generateLinesArray(linesArray) {
  return linesArray.map(line => '`' + line + '`').join(',\n  ');
}


function generateFile({filename, 
                       prefixCode = '', 
                       code, 
                       suffixCode = '',
                       arrayName = 'module.exports'}) {
  const allCode = `\
'use strict';

${prefixCode}

${arrayName} = [
  ${code}
];

${suffixCode}
`;
  
  fs.writeFileSync(filename, allCode, {mode: 0o664});
}


function generateMicrocode() {
  generateFile({filename: 'cram.js', code: generateXRAMArray(cram, 84)});
  generateFile({filename: 'cram-lines.js', code: generateLinesArray(cramLines)});
  generateFile({filename: 'dram.js', code: generateXRAMArray(dram, 24)});

  generateFile({filename: 'microcode.js', arrayName: 'const ops',
                prefixCode: `\
var ${Object.keys(EBOX).join(',')};


module.exports.initialize = function initialize(e) {
  EBOX = e;
  ${Object.keys(Named.units)
    .map(n => `${n} = e.units.${n};`)
    .join('\n  ')}
};

`,
                code: generateFunctions(),
                suffixCode: `\

module.exports.ops = ops;
`});
}


function main() {
  readMicroAssemblyListing();
  readAndHandleDirectives();
  generateModel();
  generateMicrocode();
}


main();
