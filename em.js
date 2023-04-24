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

const {uasm} = require('./uasm');

const {DTE} = require('./dte');

// Each opcode with mnemonics for the property names.
const I = require('./instructions');

const EBOXmodel = require('./ebox');
const KLX_CRAM = require('./cram.js');
const KLX_DRAM = require('./dram.js');
const KLX_CRAM_lines = require('./cram-lines.js');

const {
  EBOX, MBOX, FM,
  CRAMClock, CRAM, CR, DRAM, DR,
  AR, ARR, ARX, BR, BRX, MQ, VMA, PC, SC, FE, IR,
  SCAD,
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


// From AA-H352B-TK_RSX-20F-Nov81.pdf CHAPTER 4:
// When you enter the PARSER, you receive one of the following prompts:
//
//    PAR>     This indicates that the PARSER is ready to accept
//             commands and the HL is running (that is, the KL clock
//             is running the KL run flop is on).
//
//    PAR%     This indicates the PARSER is ready to accept
//             commands but the KL microcode is in the HALT loop.
//             (The KL clock is running but the KL run flop is off.)
//    PAR#     This indicates that the PARSER si ready to accept
//             commands bu the KL clock is stopped and the KL is not
//             running.

// The CONTINUE command takes the KL out of the HALT loop and starts
// execution at the instruction pointed to by the PC.

// HALT
//      The HALT command tries to put the KL into the HALT loop by
//      clearing the RUN flop (FXCT 10) and waiting. If the KL refuses
//      to go into the HALT loop, the front end tries for orce it in by
//      using BURST mode. If this does not work, the following error
//      message is issued:
//          PAR -- [HALT] CFH - CAN'T FIND KL HALT LOOP

// JUMP
//      The JUMP command starts the KL at the specified address and exits
//      from PARSER. A this point, the CTY is connected to the
//      TOPS-10 or TOPS-20 operating system. THe argument addr must be
//      an octal, positive, nonzero address with a maximum value of
//      17,,777777.

// SHUTDOWN
//      The SHUTDOWN command deposits a minus one into the KL EXEC,
//      virtual location 30 (octal). This command is used to bring down
//      a running system gracefully.

// RESET
// RESET ALL
// RESET APR
// RESET DTE-20
// RESET ERROR
// RESET INITIALIZE
// RESET IO
// RESET PAG
// RESET PI
// 


// DEPOSIT AR=newdata
//      The DEPOSIT AR command sets the contents of the arithmetic
//      register to new data.

// EXAMINE KL
//      The EXAMINE KL command performs the EXAMINE PC, EXAMINE VMA,
//      EXAMINE PI, and the EXAMINE FLAGS commands, in that order.


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
   description: 'Step microcode N times, where N is 1 if not specified',
   doFn: doStep,
  },

  {name: 'go',
   description: 'Continue microcode execution.',
   doFn: doGo,
  },

  {name: 'til',
   description: 'Continue microcode execution until CRA reaches a specified address.',
   doFn: doTil,
  },

  {name: 'start',
   description: 'Start CPU at specified address.',
   doFn: doStart,
  },

  {name: 'halt',
   description: 'Stop CPU (instructions) execution.',
   doFn: doHalt,
  },

  {name: 'continue',
   description: 'Continue CPU (instructions) execution from PC.',
   doFn: doContinue,
  },

  {name: 'pc',
   description: 'Set CPU PC to specified value.',
   doFn: doPC,
  },

  {name: 'cstep',
   description: 'Step N CPU instructions times, where N is 1 if not specified',
   doFn: doCPUStep,
  },

  {name: 'mux',
   description: `\
Display the output of a specified mux ("mixer") when its
control input is a specified value.`,
   doFn: doMux,
  },

  {name: 'ab',
   description: 'Continue until access of specified address.',
   doFn: doAddressBreak,
  },

  {name: 'examine',
   description: 'Evaluate expression.',
   doFn: doExamine,
  },

  {name: 'ei',
   description: 'Evaluate expression for internal debugging.',
   doFn: words => doExamine(words, false),
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
└${bar}`;
  restoreWrappers();
  return result;
}


function doDump(words) {
  disableWrappers();
  const dump = [AR, ARX, BR, BRX, MQ, VMA, PC, SC, FE, IR]
        .map(r => `${r.name.padStart(4)}=${octW(r.get())}`)
        .reduce((cur, rd, x) => cur + rd + ((x & 3) === 3 ? '\n' : '  '), '');
  
  console.log(dump);
  console.log(`[CPU ${EBOX.run ? '' : 'NOT '}running]`);
  console.log(`[CPU start flag ${EBOX.start}]`);
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
  run(n, doDump);
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


function doStart(words) {
  let a = PC.get();
  if (words.length === 2) a = BigInt(parseInt(words[1], 8));
  EBOX.run = true;
  PC.value = a;
  disableWrappers();
  console.log(`[Starting CPU from ${octA(a)}; EBOX waiting]`);
  restoreWrappers();
}


function doHalt(words) {
  disableWrappers();
  EBOX.run = false;
  console.log(`[Halting CPU at ${octA(PC.get())}; EBOX waiting]`);
  restoreWrappers();
}


function doContinue(words) {
  disableWrappers();
  EBOX.start = true;
  console.log(`[CONTINUING CPU at ${octA(PC.get())}; EBOX waiting]`);
  restoreWrappers();
}


function doPC(words) {

  if (words.length !== 2) {
    console.error(`You must specify a new PC value.`);
    return;
  }

  const newPC = BigInt(parseInt(words[1], 8));
  disableWrappers();
  PC.value = newPC;
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


function doExamine(words, forceGet = true) {
  disableWrappers();

  if (words.length > 1) {
    let result = 0n;
    const toEval = words.slice(1).join(' ');

    try {
      result = EBOX.eval(toEval);

      // So you can say "ex AR" and get content of AR.
      if (forceGet && typeof result === 'object') result = result.get();
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

    case 'DTE':
      dte0.debug = !dte0.debug;
      console.log(`DTE debug now ${dte0.debug ? 'ON' : 'OFF'}`);
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


const dte0 = DTE({name: 'DTE0', number: 0, isMaster: true});


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


function run(maxCount = Number.POSITIVE_INFINITY, doAfterFn) {
  stopCommandLine();
  setImmediate(runAsync);

  function runAsync() {
    EBOX.ucodeRun = true;
    const startCount = EBOX.microInstructionsExecuted;
    const startT = process.hrtime();

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
	const stopT = process.hrtime();
	const nSec = (stopT[0] - startT[0]) + (stopT[1] - startT[1]) / 1e9;

	EBOX.executionTime += nSec;
	const nInstructions = EBOX.instructionsExecuted - startOfLastStep;
	const ips =  nInstructions / EBOX.executionTime;
	console.log(`[Executed ${nInstructions} μinsns or ${ips.toFixed(1)}/s]`);

	startOfLastStep = 0;	// Report full count next time if not in a step
      }

      if (doAfterFn) doAfterFn();
      startCommandLine();
    }
  }
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

  uasm(cramData, sourceLines, CR, `\
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



// Our temporary holding ground while we build 36 bit words from the
// file contents byte stream.
const buf = new Buffer.alloc(256);


// Read from already open binary file `fd` starting at WORD offset
// `ofs` one 36 bit word and return it. THROWS AN ERROR upon EOF.
function fetchC36Word(fd, ofs) {
  let byteOfs = Math.floor(ofs * 5);
  if (fs.readSync(fd, buf, 0, 16, byteOfs) <= 0) throw new Error(`EOF`);
  return BigInt(buf.readUInt32BE(0)) * 16n + BigInt(buf.readUInt8(4) & 0x0F);
}


// Load a DEC CSAV (C36) format file into memory. File consists of a
// sequence of IOWD datablocks (-nWords,,addr-1) followed by entry
// vector info. The entry vector is known because its LH is positive.
// EV[0] is instr to execute to start, EV[1] is instr to execute to
// reenter, and EV[2] is program version number. Return the entry
// vector.
function loadDECSAV(fd) {
  let w = 0n;
  let fileOfs = 0;
  const ev = {loAddr: 1n << 36n, hiAddr: 0n, startInsn: 0n};

  try {
    while (true) {
      // Get IOWD: -nWords,,addr-1
      w = fetchC36Word(fd, fileOfs++);

      let lh = getLH(w);

      // Exit the data block loop when we find first entry vector word.
      if (lh < 0o400000) break;

      // Negate the LH of our IOWD datablock to get nWords
      let nWords = maskForBit(17) - getRH(lh);
      let addr = getRH(w) + 1n;

      const w1 = fetchC36Word(fd, fileOfs);
      const w2 = fetchC36Word(fd, fileOfs + 1);
//    console.log(`nWords=${octW(nWords)}, addr=${octW(addr)}: ${octW(w1)}  ${octW(w2)}`);

      if (addr < ev.loAddr) ev.loAddr = addr;

      // Copy words from file into memory at specified address.
      while (nWords-- > 0n) {
        if (addr > ev.hiAddr) ev.hiAddr = addr;
        MBOX.data[addr++] = fetchC36Word(fd, fileOfs++);
      }
    }

    ev.startInsn = w;
    return ev;
  } catch(e) {
    console.error(`Error loading: ${e}`);
  }

  return ev;
}


function installTestCode() {
  const saveFileName = `boot.sav`;
  const bootFD = fs.openSync(saveFileName, 'r');

  if (!bootFD) {
    console.error(`Can't open "${saveFileName}". Exiting.`);
    process.exit();
  }

  const ev = loadDECSAV(bootFD);
  MBOX.data[0] = ev.startInsn;  // Copy start instruction to PC=0 (for now?)
  console.log(`\
${saveFileName}: \
lo:${octW(ev.loAddr)} hi:${octW(ev.hiAddr)} startInsn=${octW(ev.startInsn)}`);
}


function getLH(v) {
  return (BigInt(v) >> 18n) & 0o777777n;
}


function getRH(v) {
  return BigInt(v) & 0o777777n;
}


// Return the halfword for `value` negated.
function negateRH(value) {
  return maskForBit(17) - BigInt(value);
}


// Add a and b modulo 18 bits and return the result.
function addRH(a, b) {
  return (BigInt(a) + BigInt(b)) & 0o777777n;
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

  // Prefetch CR content for first cycle
  CRAMClock.cycle();

  // Run 1000 cycles while EBOX.run is false to get microcode
  // initialized.
//  _.range(1000).forEach(c => EBOX.cycle());

  installTestCode();
}


function main()
{
  doReset();
//  EBOX.run = true;              // Microcode initialized, so prepare to run
  setImmediate(startEmulator);
}


main();
