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
  shiftForBit, fieldExtract, maskForBit, fieldMask,
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
  if (typeof op === 'string') op = I[op];

  // Allow i, x to be left out for simpler addressing modes
  if (x === null && y === null) {
    x = 0;
    y = i;
  }
  
  return 0n |
    BigInt(op) << shiftForBit(8) |
    BigInt(a) << shiftForBit(12) |
    BigInt(i) << shiftForBit(13) |
    BigInt(x) << shiftForBit(17) |
    BigInt(y);
}


function assembleIO(op, dev, i, x, y) {
  if (typeof op === 'string') op = I[op];

  // Allow i, x to be left out for simpler addressing modes
  if (x === null && y === null) {
    x = 0;
    y = i;
  }
  
  return 0n |
    BigInt(op) << shiftForBit(12) |
    BigInt(dev) << shiftForBit(9) |
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


function installTestCode() {
  // Device numbers
  const APR = 0;
  const PAG = 1;

  // WREBR/RDEBR and CONO/CONI PAG flags
  const PGCLKE = maskForBit(18);                // CACHE LOOK ENABLE
  const PGCLDE = maskForBit(19);                // CACHE LOAD ENABLE
  const PGKLMD = maskForBit(21);                // KL20 PAGING MODE
  const PGTPEN = maskForBit(22);                // TRAP ENABLE
  const PGEBRM = fieldMask(23, 35);             // EXEC BASE REGISTER

  // KL APR bits
  const AP = {
    RES: maskForBit(19),			// IOB RESET (SAME ON KI AND KL)
    CLR: maskForBit(22),
    SET: maskForBit(23),
    NXM: maskForBit(25),
    RNX: maskForBit(22) | maskForBit(25),
  };

  // BOOT.MAC ACs
  const F = 0;				// FLAGS
  const T1 = 1;				// GP TEMP
  const T2 = 2;				//  ...
  const T3 = 3;				//  ...
  const T4 = 4;				//  ...
  const Q1 = 5;				// GENERALLY HOLDS A SINGLE CHARACTER
  const Q2 = 6;				// BYTE POINTER TO AN INPUT STRING
  const Q3 = 7;				// BYTE POINTER TO AN OUTPUT STRING
  const P1 = 10;			// OFTEN PRESERVED
  const P2 = 11;			//  ..
  const P3 = 12;			// A NUMBER
  const P4 = 13;			// DESTINATION POINTER (DISK ADDR, BYTE PTR)
  const P5 = 14;			// DISK ADDRESS OR PARSER STATE
  const P6 = 15;			// DEVICE TYPE INDEX
  const CX = 16;			// RETURN ADDRESS FOR VBOOT ENTRY FROM MONITOR
        				//  NO INTERNAL BOOT CODE MUST USE THIS AC!!!
  const P = 17;				// STACK POINTER

  // ;Bits provided by KLINIT on a special load condition

  const F11 = {
    LD: maskForBit(0),			// DO DEFAULT LOAD
    DM: maskForBit(1),                  // DO DUMP OF CORE
    OK: maskForBit(35),                 // [7.1224] (flag to monitor) BOOTFL is valid
  };

  // ; EXEC PROCESS TABLE LOCATIONS
  const EPTEST = 0o540n;		// INDEX TO EXEC SECTION TABLE
  const EPTATR = 0o421n;		// INDEX TO ARITHMETIC TRAP INSTRUCTION
  const EPTPDO = 0o422n;		// INDEX FOR PDL OVERFLOW
  const EPTSPT = 0o760n;		// INDEX TO SPT (ONE WORD TABLE FOR VBOOT)

  // ;UPT DEFINITIONS
  const UPTPFW = 0o500n;		// PAGE FAIL ADDRESS
  const UPTPFN = 0o503n;		// INDEX TO PAGE FAIL WORD
  const UPTPFO = 0o502n;		// PAGE FAIL PC WORD


  // Some test code
  let a = 0;
  MBOX.data[a++] = assemble(`HRROI`, 0o13, 0o123456n);
  MBOX.data[a++] = assemble(`HRLZI`, 0o12, 0o1234n);
  MBOX.data[a++] = assemble(`MOVEI`, 0o11, 0o3333n);
  MBOX.data[a++] = assemble(`ADDI`, 0o11, 0o4321n);
  MBOX.data[a++] = assemble(`SUBI`, 0o11, 0o2222n);
  MBOX.data[a++] = assemble(`MOVEI`, 0o10, 0, 0o11, 0o77);

  // CONO APR,AP.RES		;IOB RESET - CLEAR I/O DEVICES
  const ENT = a;
  MBOX.data[a++] = assembleIO('CONO', APR, AP.RES);
  // CONI PAG,15		;GET CURRENT STATE OF PAGER
  MBOX.data[a++] = assembleIO('CONI', PAG, 0o15);
  // ANDI 15,PGCLKE!PGCLDE	;CLEAR ALL BUT CACHE STRATEGY BITS
  MBOX.data[a++] = assemble(`ANDI`, 0o15, PGCLKE | PGCLDE);
  // CONO PAG,0(15)		;TURN OFF PAGING
  MBOX.data[a++] = assembleIO(`CONO`, PAG, 0, 0o15, 0);

//;Figure out where we landed and determine offset for self-relocating code.

  // MOVSI 17,(<JRST (16)>)	;RETURN INST
  MBOX.data[a++] = assemble(`MOVSI`, 0o17, 0, 0, assemble(`JRST`, 0, 0o16, 0) >> 18n);
  // JSP 16,17    		;GET CURRENT PC
  MBOX.data[a++] = assemble(`JSP`, 0o16, 0o17);
  // SUBI 16,.-ENT		;RETURN HERE
  const a0 = a - ENT;
  MBOX.data[a++] = assemble(`SUBI`, 0o16, a0);
  //                               16 NOW CONTAINS RUNTIME ORIGIN OF BOOT
  // AND F,[F11.DM!F11.LD]-ENT(16) ;SAVE ONLY DEFINED BITS
  makeLiteral(a, F11.DM | F11.LD);
  MBOX.data[a++] = assemble(`AND`, F, 0, 0o16, negateRH(ENT));

//;Set up the UPT and EPT to be the same page, starting at the end of the
//;code. Point to a page fault handler. AC 15 contains control bits used in
//;previous CONO PAG/WREBR.
  // MOVEI T1,PAGTRP-ENT(16)	;THE PAGE FAULT HANDLER
  forward(a, 'PAGTRP');
  MBOX.data[a++] = assemble(`MOVEI`, T1, 0, 0o16, negateRH(ENT));
// MOVEM T1,CODEND-ENT+UPTPFN(16) ;SET UP TEMPORARY EPT/UPT
  forward(a, `CODEND`);
  MBOX.data[a++] = assemble(`MOVEM`, T1, 0, 0o16, negateRH(ENT) + UPTPFN);
  // MOVEI T1,CODEND-ENT(16) ;GET LOCAL ADDRESS OF EPT (END OF CODE)
  forward(a, `CODEND`);
  MBOX.data[a++] = assemble(`MOVEI`, T1, 0, 0o16, negateRH(ENT));
  // LSH T1,-11		;MAKE IT A PAGE NUMBER
  MBOX.data[a++] = assemble(`LSH`, T1, 0, 0, negateRH(0o11));
  // IOR 15,T1		;ADD PAGE NUMBER TO THE CONTROL BITS
  MBOX.data[a++] = assemble(`IOR`, 0o15, 0, 0, T1);
  // CONO PAG,0(15)		;MAKE EBR POINT TO THAT PAGE
  MBOX.data[a++] = assembleIO(`CONO`, PAG, 0, 0o15, 0);
  // TDO T1,[1B2+1B18]-ENT(16) ;AND SET UBR AND INHIBIT METER UPDATE
  makeLiteral(a, maskForBit(2) + maskForBit(18));
  MBOX.data[a++] = assemble(`TDO`, T1, 0, 0o16, negateRH(ENT));
  // DATAO PAG,T1		;MAKE UBR POINT TO ITS PAGE
  MBOX.data[a++] = assembleIO(`DATAO`, PAG, 0, 0, T1);

  a = allocateLiterals(a);
}


// Return the halfword for `value` negated.
function negateRH(value) {
  return maskForBit(17) - BigInt(value);
}


// Add a and b modulo 18 bits and return the result.
function addRH(a, b) {
  return (BigInt(a) + BigInt(b)) & 0o777777n;
}


const forwardRefs = {};

// Remember a forward referenced symbol `name` whose address, when
// defined by `defineForward()` must be added to the RH value in
// `fixupLoc`.
function forward(fixupLoc, name) {
  if (!forwardRefs[name]) forwardRefs[name] = [];
  forwardRefs[name].push(fixupLoc);
}


// Define a symbol and fixup all forward references to it by adding
// the value of symbol to the RH of each `fixupLoc` word`.
function defineSymbol(name, value) {
  if (!forwardRefs[name]) return; // If not forward referenced, do nothing
  forwardRefs[name].forEach(loc => MBOX.data[loc] = addRH(MBOX.data[loc], value));
}


const literals = [];

// Remember a MACRO style [...] literal whose address must be added to
// the RH value in `fixupLoc`.
function makeLiteral(fixupLoc, value) {
  literals.push({fixupLoc, value});
}


// Allocate space for and initialize all of our literal words.
function allocateLiterals(a) {
  literals.forEach(({fixupLoc, value}) => {
    MBOX.data[fixupLoc] = addRH(MBOX.data[fixupLoc], a);
    MBOX.data[a++] = value;
  });

  return a;
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

  installTestCode();

  // Prefetch CR content for first cycle
  CRAMClock.cycle();
}


function main()
{
  doReset();
  setImmediate(startEmulator);
}


main();
