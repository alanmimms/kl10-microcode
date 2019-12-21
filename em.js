'use strict';

const fs = require('fs');
const util = require('util');
const _ = require('lodash');
const readline = require('readline');
const keypress = require('keypress');

const CLA = require('command-line-args');
const CLU = require('command-line-usage');

const {
  octal, oct6, octW, octA, octC,
  shiftForBit, fieldExtract,
  wrapMethod, unwrapMethod, wrappedMethods, methodIsWrapped, disableWrappers, restoreWrappers,
  typeofFunction,
} = require('./util');

// Each opcode with mnemonics for the property names.
const I = require('./instructions');

const EBOXmodel = require('./ebox-model');
const KLX_CRAM = require('./cram.js');
const KLX_DRAM = require('./dram.js');
const KLX_CRAM_lines = require('./cram-lines.js');

const {
  EBOX, MBOX, FM,
  CRAMClock, CRAM, CR, DRAM, DR,
  AR, ARX, BR, BRX, MQ, VMA, PC, IR,
  Named, EBOXUnit,
} = EBOXmodel;


const historyMax = 100;
var breakpoint = {};
let historyEnabled = false;
const craHistory = [];
let craHistoryX = -1;

let startOfLastStep = 0;


const optionList = [
  {
    name: 'test-microcode', alias: 'T', defaultValue: false, type: Boolean,
    description: 'load internal testCRAM[]/testDRAM[] DEC KLX.MCR into CRAM/DRAM',
  }, {
    name: 'program', alias: 'P', defaultOption: true, defaultValue: 'boot.sav', type: String,
    description: '[not yet implemented] REQUIRED program image to load (e.g., boot.sav)',
  },
];


const OPT = parseOptions(optionList);

let sourceLines = OPT.testMicrocode ? [] : KLX_CRAM_lines;


function parseOptions(list) {
  let result = null;

  try {
    result = CLA(optionList, {camelCase: true});
  } catch(e) {
    usage(e.msg);
  }

  return result;
}


function usage(msg) {
  console.warn(CLU([
    {
      header: 'em',
      content: `\
Emulate a DEC KL10PV CPU configured to run TOPS-20 by running its \
microcode on simulated hardware.`,
    },
    {
      header: 'Options',
      optionList,
      hide: ['dirs'],
    },
    {
      content: `>>>> ` + msg,
    },
  ]));

  process.exit();
  return null;
}


// User can enter short substrings, and it's not the unambiguous match
// but rather the first (case-insensitive) match that is used. PUT
// THESE IN ORDER OF PRECEDENCE IN CASE OF AMBIGUITY OF THE SHORTENED
// NAME.
const commands = [
  {name: 'dump',
   description: 'Dump frequently used microcode state',
   doFn: doDump,
  },
  
  {name: 'cdump',
   description: 'Dump CPU level frequently used processor state including ACs',
   doFn: doCDump,
  },
  
  {name: 'step',
   description: 'Step N times, where N is 1 if not specified',
   doFn: doStep,
  },

  {name: 'cstep',
   description: 'Step N CPU instructions times, where N is 1 if not specified',
   doFn: doCPUStep,
  },

  {name: 'go',
   description: 'Continue execution.',
   doFn: doGo,
  },

  {name: 'cgo',
   description: 'Run CPU (instructions).',
   doFn: doCPUGo,
  },

  {name: 'cstop',
   description: 'Stop CPU (instructions) execution.',
   doFn: doCPUStop,
  },

  {name: 'til',
   description: 'Continue execution until CRA reaches a specified address.',
   doFn: doTil,
  },

  {name: 'mux',
   description: 'Display the output of a specified mux ("mixer") when its control input is a specified value.',
   doFn: doMux,
  },

  {name: 'ab',
   description: 'Continue until access of specified address.',
   doFn: doAddressBreak,
  },

  {name: 'examine',
   description: 'Display memory at specified address.',
   doFn: doExamine,
  },

  {name: 'list',
   description: 'Disassemble memory at specified address.',
   doFn: doList,
  },

  {name: 'cra',
   description: 'Set CRA to specified value',
   doFn: (words) => CRAM.latchedAddr = getAddress(words),
  },

  {name: 'symbol',
   description: 'Find symbols near specified value (or ".") with a second optional value\n' +
   'to set the maximum distance for "near" (default=030).',
   doFn: doSymbol,
  },

  {name: 'history',
   description: `\
Display CRAs 25 (or specified count) backward in time up to
${historyMax}. Use 'history on' or 'history off' to enable or disable
history mechanism.`,
   doFn: doHistory,
  },

  {name: 'value',
   description: 'Look up specified symbol\'s value.',
   doFn: doValue,
  },

  {name: 'quit',
   description: 'Exit the emulator.',
   doFn: doQuit,
  },

  {name: 'debug',
   description: `\
With no args, display current registered debug flags and their values.
With arguments, set specified flag to specified value. If value is
unspecified, toggle. Use "debug EBOX-unit-name method" (or "*" for all
methods) to log or unlog actions.`,
   doFn: words => doDebug(words, false),
  },

  {name: 'vdebug',
   description: `\
VERBOSE debug: With no args, display current registered debug flags
and their values. With arguments, set specified flag to specified
value. If value is unspecified, toggle. Use "debug EBOX-unit-name
method" (or "*" for all methods) to log or unlog actions.`,
   doFn: words => doDebug(words, true),
  },

  {name: 'reset',
   description: 'Reset and reload everything from scratch.',
   doFn: doReset,
  },

  {name: 'stats',
   description: 'Display statistics we capture.',
   doFn: doStats,
  },

  {name: 'units',
   description: 'Display list of EBOX units.',
   doFn: doUnits,
  },

  {name: 'help',
   description: 'Get a list of available commands and description of each.',
   doFn: doHelp,
  },
];


// XXX temporary
function findSymbol(sym) {
  return null;
}


function getAddress(words) {

  switch (words[1]) {

  default:

    if (words.length < 2) {
      const x = CRAM.latchedAddr;
      console.log(`CRA=${octal(x)}`);
      return x;
    }

    if (words[1].match(/^[A-Z$%].*/i)) {
      let sym = findSymbol(words[1]);

      if (sym === null) {
	console.log(`Undefined symbol '${words[1]}'`);
	return lastX;
      } else {
	return sym;
      }
    } else {
      return parseInt(words[1], 8);
    }
  }
}


// Disassemble or display a CRAM word `w`.
function disassemble(w) {
  return octC(w);
}


// XXX temporary
function displayableAddress(x) {
  return octal(x);
}


function curInstruction() {
  const bar = `─`.repeat(120);
  disableWrappers();
  const result = `\
┌${bar}
│${(sourceLines[CRAM.latchedAddr] || '').split(/\n/).join(`\n│`)}
│     CR=${octC(CR.get())}
└${bar}`;
  restoreWrappers();
  return result;
}


function doDump(words) {
  disableWrappers();
  const dump = [AR, ARX, BR, BRX, MQ, VMA, PC, IR]
        .map(r => `${r.name.padStart(4)}=${octW(r.get())}`)
        .reduce((cur, rd, x) => cur + rd + ((x & 3) === 3 ? '\n' : '  '), '');
  
  console.log(dump);
  restoreWrappers();
}


function doCDump(words) {
  disableWrappers();
  const ACs = _.range(16)
        .map(rn => `${octal(rn, 2)}=${octW(FM.data[rn])}`);
  const others = [PC]
        .map(r => `${r.name}=${octW(r.get())}`);
  const dump = [...ACs, ...others]
        .reduce((cur, rd, x) => cur + rd + ((x & 3) === 3 ? '\n' : '  '), '');
  
  console.log(dump);
  restoreWrappers();
}


function doStep(words) {
  const n = words.length > 1 ? parseInt(words[1]) : 1;
  run(n);
  doDump();
}


function doCPUStep(words) {
  const n = words.length > 1 ? parseInt(words[1]) : 1;
  console.log(`Not yet implemented.`);
}


function doGo(words) {
  let a = CRAM.latchedAddr;

  if (words.length === 2) a = BigInt(parseInt(words[1], 8));

  if (a !== CRAM.latchedAddr) {
    CRAM.latchedAddr = a;
    CRAMClock.cycle();          // Fetch new CRAM location
  }

  console.log(`[Running from ${octA(CRAM.latchedAddr)}]`);
  run();
}


function doCPUGo(words) {
  EBOX.run = true;
  disableWrappers();
  console.log(`[CPU Running from ${octA(PC.get())}; EBOX waiting]`);
  restoreWrappers();
}


function doCPUStop(words) {
  disableWrappers();
  EBOX.run = false;
  console.log(`[Stopping CPU at ${octA(PC.get())}; EBOX waiting]`);
  restoreWrappers();
}


function doMux(words) {

  if (words.length !== 3) {
    console.error(`\
The "mux" command needs the name of a Combinatorial unit \
and an octal value for its control input`);
    return;
  }

  const unitName = words[1];
  const unit = Named.units[unitName];
  const controlValue = BigInt(parseInt(words[2], 8));

  // Wrap `getControl()` but the wrapper is replaced with our mocked
  // value.
  wrapMethod(unit, 'getControl', {
    preAction() {},
    postAction({result}) {return result},
    replaceAction() {return controlValue},
  });
  const result = unit.get();

  // Restore normal behavior.
  unwrapMethod(unit, 'getControl');
  console.log(`${unitName}.get() returns ${octW(result)}`);
}


function doTil(words) {

  if (words.length !== 2) {
    console.error(`"til" command must have an argument with the address to stop at`);
    return;
  }

  const a = BigInt(parseInt(words[1], 8));
  breakpoint[a] = 'til';
  doGo([]);
}


function doAddressBreak(words) {
  console.log(`Not yet implemented.`);
}


function doExamine(words) {
  disableWrappers();

  if (words.length > 1) {
    let result = 0n;
    const toEval = words.slice(1).join(' ');

    try {
      result = EBOX.eval(toEval);

      // So you can say "ex AR" and get content of AR.
      if (typeof result === 'object') result = result.get();
    } catch(e) {
      console.error(`Error evaluating "${toEval}":
${e.msg}`);
      restoreWrappers();
      return;
    }

    if (typeof result === 'bigint' || typeof result === 'number') {
      console.log(octW(result));
    } else {
      console.log(result);
    }
  } else {
    console.log(`Examine what?`);
  }

  restoreWrappers();
}


function doList(words) {
  console.log(`Not yet implemented.`);
}


function doSymbol(words) {
  console.log(`Not yet implemented.`);
}


function doHistory(words) {
  console.log(`Not yet implemented.`);
}


function doValue(words) {
  console.log(`Not yet implemented.`);
}


const EBOXDebugFlags = `NICOND,CLOCK`.split(/,\s*/);


function doDebug(words, verbose = false) {

  if (words.length === 1) {
    displayDebugFlags();
    return;
  }

  const name = words[1].toUpperCase();

  if (words.length === 2) {

    if (Named.units[name]) {
      wrapUnit(name, '*', verbose);
    } else {
      setDebugFlag(name);
    }
  } if (words.length === 3) { // "debug unit-name method-or-*"
    wrapUnit(name, words[2], verbose);
  }


  function displayDebugFlags() {
    // Display all our wrapped (for debug) EBOX unit methods first.
    EBOX.unitArray
      .sort()
      .forEach(u => wrappedMethods(u)
               .forEach(method => console.log(`  debug logging on ${u.name} ${method}`)));

    EBOXDebugFlags.forEach(f => console.log(`${f} debug is ${EBOX['debug' + f] ? 'ON' : 'OFF'}`));
  }


  function setDebugFlag(flag) {

    switch (flag) {
    case 'NICOND':
      EBOX.debugNICOND ^= 1;
      console.log(`NICOND debug now ${EBOX.debugNICOND ? 'ON' : 'OFF'}`);
      break;

    case 'CLOCK':
      EBOX.debugCLOCK ^= 1;
      console.log(`CLOCK debug now ${EBOX.debugCLOCK ? 'ON' : 'OFF'}`);
      break;

    default:
      console.log(`UNKNOWN debug flag ${flag} ignored`);
      break;
    }
  }


  function wrapUnit(unitName, method, verbose = false) {
    const unit = Named.units[unitName];
    const v = verbose ? 'v' : '';

    if (!unit) return;

    if (method === '*') {

      // Do ALL the methods on our wrappable list.
      (unit.wrappableMethods || [])
        .filter(method => typeof unit[method] === typeofFunction)
        .forEach(method => {

          if (methodIsWrapped(unit, method)) { // Already wrapped, so unwrap
            unwrapMethod(unit, method);
            console.log(`${unit.name} ${method} ${v}debug now off`);
          } else {                             // Not wrapped, so wrap
            wrapMethod(unit, method, {verbose});
            console.log(`${unit.name} ${method} ${v}debug now on`);
          }
        });
    } else {

      if (typeof unit[method] !== typeofFunction) {
        console.error(`${unit.name} doesn't have a method called "${method}"`);
      } else {

        if (methodIsWrapped(unit, method)) { // Already wrapped, so unwrap
          unwrapMethod(unit, method);
          console.log(`${unit.name} ${method} ${v}debug now off`);
        } else {                             // Not wrapped, so wrap
          wrapMethod(unit, method, {verbose});
          console.log(`${unit.name} ${method} ${v}debug now on`);
        }
      }
    }
  }
}


function doStats(words) {
  console.log(`Not yet implemented.`);
}


function doUnits(words) {
  const unitNamesSorted = Object.keys(Named.units).sort();
  const maxW = unitNamesSorted.reduce((curMax, name) => Math.max(curMax, name.length), 0);
  const unitNamesChunked = _.chunk(unitNamesSorted, 4);
  const result = unitNamesChunked
        .map(chunk => chunk.map(name => _.padEnd(name, maxW)).join('  '))
        .join('\n');
  console.log(result);
}


var lastLine = "";
var lastL = 0n;
var lastX = 0n;


function handleLine(line) {
  const parseLine = () => line.trim().split(/\s+/);
  let words = parseLine();

  if ((words.length === 0 || words[0].length === 0) && lastLine != 0) {
    line = lastLine;
    words = parseLine();
  }

  let cmd = (words[0] || '?').toLowerCase();

  lastLine = line;

  var cmdX = commands.findIndex(c => c.name.indexOf(cmd) === 0);

  if (cmdX >= 0) {
    commands[cmdX].doFn(words);
  } else {
    doHelp();
  }

  if (rl) prompt();
  lastL = CRAM.latchedAddr;
}


function doHelp(words) {

  if (!words || words.length === 1) {
    const maxWidth = commands.map(c => c.name)
      .reduce((prev, cur) => cur.length > prev ? cur.length : prev, 0);

    console.log('\nCommands:\n' + 
		commands
		.map(c => (_.padStart(c.name, maxWidth) + ': ' +
			   c.description.replace(/\n/g, '\n  ' +
						 _.padStart('', maxWidth))))
		.join('\n\n'));
  } else {
    const cx = commands.findIndex(c => c.name.indexOf(words[1]) === 0);

    if (cx < 0)
      console.log(`Unknown command ${words[1]}`);
    else
      console.log(commands[cx].description);
  }
}


// Our readline interface instance used for command line interactions.
var rl;


function stopCommandLine() {
  if (rl) rl.close();
  rl = null;

  if (process.stdin.setRawMode) { // This is not defined if debugging
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', dteKeypressHandler);
    process.stdin.resume();
  }
}


var trapped = false;


function startCommandLine() {
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 1000,

    completer: function tabCompleter(line) {
      const completions = commands.map(c => c.name);
      const hits = completions.filter(c => c.indexOf(line) === 0);
      return [hits.length ? hits : completions, line];
    },
  });

  if (process.stdin.setRawMode) {
    process.stdin.removeListener('keypress', dteKeypressHandler);
    process.stdin.setRawMode(false);
  }

  // Note ^C to allow user to regain control from long execute loops.
  rl.on('SIGINT', () => {
    console.log('\n[INTERRUPT]\n');
    EBOX.ucodeRun = false;
    startCommandLine();
  });

  prompt();
  lastL = CRAM.latchedAddr;
}


function prompt() {
  rl.question(`\
${curInstruction()}
> `,
                      handleLine);
}


var dte0;			// We need this to pass on tty input

function dteKeypressHandler(ch, key) {

  if (ch != null) {
    let c = ch.charCodeAt(0);

    // Stop with C-\ keypress
    if (c === 0o34) EBOX.ucodeRun = false;

    dte0.ttyIn(c);
  } else if (key.sequence) {

    // Tail-recursively send key inputs for each character in the sequence.
    function spoolOutKeySequence(seq) {
      let c = seq.charCodeAt(0);
      dte0.ttyIn(c);

      if (seq.length > 1) {
	seq = seq.slice(1);
	setImmediate(spoolOutKeySequence, seq);
      }
    }

    setImmediate(spoolOutKeySequence, key.sequence.slice(0));
  }
}


function doQuit(words) {
  if (rl) rl.close();
  console.log("[Exiting]");
  process.exit(0);
}


function startEmulator() {
  console.log('[Control-\\ will interrupt execution and return to prompt]');
  startCommandLine();
}


const insnsPerTick = 100;


function run(maxCount = Number.POSITIVE_INFINITY) {
  stopCommandLine();
  setImmediate(runAsync);

  function runAsync() {
    EBOX.ucodeRun = true;
    const startCount = EBOX.microInstructionsExecuted;
    const startTime = process.hrtime();

    for (let n = insnsPerTick; EBOX.ucodeRun && n; --n) {
      EBOX.cycle();
      const cra = CRAM.latchedAddr;

      if (breakpoint[cra]) {
	console.log(`[${breakpoint[cra]}]`); // Say why we stopped
	breakpoint = {};
        EBOX.ucodeRun = false;
      } else {
        if (maxCount && EBOX.microInstructionsExecuted - startCount >= maxCount)
	  EBOX.ucodeRun = false;
      }
    }

    if (EBOX.ucodeRun) {
      setImmediate(runAsync);
    } else {

      if (!maxCount || breakpoint[CRAM.latchedAddr]) {
	const stopTime = process.hrtime();
	const nSec = (stopTime[0] - startTime[0]) + (stopTime[1] - startTime[1]) / 1e9;

	EBOX.executionTime += nSec;
	const nInstructions = EBOX.instructionsExecuted - startOfLastStep;
	const ips =  nInstructions / EBOX.executionTime;
	console.log(`[Executed ${nInstructions} micro-instructions ` +
		    `or ${ips.toFixed(1)}/s]`);

	startOfLastStep = 0;	// Report full count next time if not in a step
      }

      startCommandLine();
    }
  }
}


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
function uasm(cram, code) {
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

    sourceLines[cra] = linesForThisWord.join('\n');
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


function assemble(op, a, i, x, y) {
  return 0n |
    BigInt(op) << shiftForBit(8) |
    BigInt(a) << shiftForBit(12) |
    BigInt(i) << shiftForBit(13) |
    BigInt(x) << shiftForBit(17) |
    BigInt(y);
}


function createTestMicrocode() {
  const X = 0o123n;
  const Y = 0o222n;
  const Z = 0o321n;
  const cramData = CRAM.data;

  _.range(16).forEach(a => FM.data[a] = 0o010101010101n * BigInt(a));

  uasm(cramData, `\
; ================ Test CR.J jump
; Jump to three instruction bounce loop
0000: J/0123
0123: J/0222
0222: J/0321
0321: J/0400

; ================ Test FM, MQ, AD/ADA/ADB

; MQ_AD   "COND/REG CTL,MQ/MQM SEL,MQ CTL/AD"
; MQ=AC3=${octW(FM.data[3])}
0400: FMADR/AC+#, #/3, ADB/FM, AD/B, COND/REG CTL, MQ/MQM SEL, MQ CTL/AD, J/@NEXT

; AR_MQ+FM[]    "ADA/MQ,ADB/FM,@1,AD/A+B,AR/AD"
; AR=MQ+AC4=${octW(FM.data[4])}
FMADR/AC+#, #/4 ADB/FM, AD/B, AR/AD, J/@NEXT

; AR<-(AR+MQ)*.25
ADA/MQ,ADB/AR*4,AD/A+B,AR/AD*.25, J/0000
`);
}


function doReset() {
  // Reset
  EBOX.reset();

  if (OPT.testMicrocode) {
    createTestMicrocode();
  } else {
    // Load CRAM and DRAM from our KLX microcode
    KLX_CRAM.forEach((mw, addr) => CRAM.data[addr] = mw);
    KLX_DRAM.forEach((dw, addr) => DRAM.data[addr] = dw);
  };

  // Some test code
  let a = 0;
  MBOX.data[a++] = assemble(I.HRROI, 0o13, 0, 0, 0o123456n);
  MBOX.data[a++] = assemble(I.HRLZI, 0o12, 0, 0, 0o1234n);
  MBOX.data[a++] = assemble(I.MOVEI, 0o11, 0, 0, 0o3333n);
  MBOX.data[a++] = assemble(I.ADDI, 0o11, 0, 0, 0o4321n);
  MBOX.data[a++] = assemble(I.SUBI, 0o11, 0, 0, 0o2222n);

  // Prefetch CR content for first cycle
  CRAMClock.cycle();
}


function main()
{
  doReset();
  setImmediate(startEmulator);
}


main();
