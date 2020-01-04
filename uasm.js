'use strict';

// Assemble lines of microcode from `code` storing microwords in
// `cram`. This does not support macros (yet?), but has full field and
// value constant support. Each source line optionally begins with
// octal digits and a colon defining the address (cra) of the
// microword, followed by a standard sequence of field/value separated
// by commas. If not specified, the `cra` value is one greater than
// that of the previous line.
//
// The `code` string may include comments. Sequences of these will be
// included in sourceLines[] for the microword following them. The
// symbol `@NEXT` is a macro for the next address after cra. This
// `cra` value is used to save the line(s) in sourceLines[].
//
// This assembler does NOT support lines that break after a comma.
// Instead, just use backslash on the end of the line that needs to be
// continued.
//
// E.g.:
// ; This is a comment
// 0123: FMADR/AC+#, #/3, ADB/FM, AD/B, COND/REG CTL, MQ/MQM SEL, MQ CTL/AD, J/@NEXT
// ; Looping enough for you yet?
// J/0123
function uasm(cram, sourceLines, CR, code) {
  let linesForThisWord = [];
  let cra = 0n;

  code.split(/\n/).forEach(line => {
    CR.value = 0n;

    linesForThisWord.push(line);

    // Do nothing but save blank and comment lines.
    if (line.match(/^\s*;.*$/) || line.match(/^\s*$/)) return;

    // Microassemble a line of code.
    // First grab the address prefix if present.
    const prefixM = line.match(/^([0-7]+)\s*:\s*/);

    if (prefixM) {
      cra = BigInt(parseInt(prefixM[1], 8));
      line = line.slice(prefixM[0].length); // Rest of line after org prefix is microword
    } else {                                // If not present, next uinsn goes at @NEXT
      ++cra;
    }

    if (sourceLines) sourceLines[cra] = linesForThisWord.join('\n');
    linesForThisWord = [];

    line.trim().split(/,\s*/)
      .forEach(assignment => {
        const [field, value] = assignment.split(/\//);

        if (field in CR) {

          if (value === '@NEXT') {
            CR[field] = cra + 1n;
          } else if (value.match(/^[0-7].*/)) {
            CR[field] = BigInt(parseInt(value, 8));
          } else if (value in CR[field]) {
            CR[field] = CR[field][value];
          } else {
            console.error(`\
uasm['${line}]':
  '${assignment}' contains undefined value '${value}'`);
          }
        } else {
          console.error(`\
uasm['${line}']:
  '${assignment}' contains undefined field '${field}'`);
        }
      });

    cram[cra] = CR.value;
  });

  return CR.value;
}
module.exports.uasm = uasm;
