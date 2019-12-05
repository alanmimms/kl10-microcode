'use strict';

const fs = require('fs');
const util = require('util');
const _ = require('lodash');
const readline = require('readline');
const keypress = require('keypress');

const CLA = require('command-line-args');
const CLU = require('command-line-usage');

const {
  octal, oct6, octW, octA,
  shiftForBit,
  wrapMethod, unwrapMethod, wrappedMethods, methodIsWrapped,
  typeofFunction,
} = require('./util');

const EBOXmodel = require('./ebox-model');
const KLX_CRAM = require('./cram.js');
const KLX_DRAM = require('./dram.js');
const KLX_CRAM_lines = require('./cram-lines.js');

const {
  EBOX, MBOX, FM,
  CRADR, CRAM, CR, DRAM, DR,
  AR, ARX, BR, BRX, MQ, VMA, PC, IR,
  Named, EBOXUnit,
} = EBOXmodel;


const historyMax = 100;
var breakpoint = {};
let historyEnabled = false;
const cradrHistory = [];
let cradrHistoryX = -1;

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
   description: 'Continue execution until CRADR reaches a specified address.',
   doFn: doTil,
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

  {name: 'cradr',
   description: 'Set CRADR to specified value',
   doFn: (words) => CRADR.value = getAddress(words),
  },

  {name: 'symbol',
   description: 'Find symbols near specified value (or ".") with a second optional value\n' +
   'to set the maximum distance for "near" (default=030).',
   doFn: doSymbol,
  },

  {name: 'history',
   description: `Display CRADRs 25 (or specified count) backward in time up to ${historyMax}.
Use 'history on' or 'history off' to enable or disable history mechanism.`,
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
   description: `With no args, display current registered debug flags and their values.
With arguments, set specified flag to specified value. If value is unspecified, toggle.
Use "debug EBOX-unit-name method" (or "*" for all methods) to log or unlog actions.`,
   doFn: doDebug,
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
      const x = CRADR.get();
      console.log(`CRADR=${octal(x)}`);
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
  return octal(w, 84/3, 4);
}


// XXX temporary
function displayableAddress(x) {
  return octal(x);
}


function curInstruction() {
  const x = CRADR.get();

  if (OPT.testMicrocode) {
    return `${octal(x, 4)}: ${disassemble(CRAM.data[x])}`;
  } else {
    const bar = `─`.repeat(120);
    const vbar = `│`;
    const NL = `\n`;
    const barredLines = KLX_CRAM_lines[x].split(/\n/).join(NL + vbar);
    return `┌` + bar + NL + vbar + barredLines + NL + '└' + bar;
  }
}


function doDump(words) {
  const dump = [AR, ARX, BR, BRX, MQ, VMA, PC, IR]
        .map(r => `${r.name}=${octW(r.get())}`)
        .reduce((cur, rd, x) => cur + rd + ((x & 3) === 0 ? '\n' : '  '), '');
  
  console.log(dump);
}


function doCDump(words) {
  const ACs = _.range(16)
        .map(rn => `${octal(rn, 2)}=${octW(FM.data[rn])}`);
  const others = [PC]
        .map(r => `${r.name}=${octW(r.get())}`);
  const dump = [...ACs, ...others]
        .reduce((cur, rd, x) => cur + rd + ((x & 3) === 3 ? '\n' : '  '), '');
  
  console.log(dump);
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
  console.log(`[Running from ${octA(CRADR.get())}]`);
  run();
}


function doCPUGo(words) {
  EBOX.run = true;
  console.log(`[CPU Running from ${octA(PC.get())}; EBOX waiting]`);
}


function doCPUStop(words) {
  EBOX.run = false;
  console.log(`[Stopping CPU at ${octA(PC.get())}; EBOX waiting]`);
}


function doTil(words) {
  console.log(`Not yet implemented.`);
}


function doAddressBreak(words) {
  console.log(`Not yet implemented.`);
}


function doExamine(words) {

  if (words.length > 1) {
    const result = EBOX.eval(words.slice(1).join(' '));

    if (typeof result === 'bigint' || typeof result === 'number') {
      console.log(octW(result));
    } else {
      console.log(result);
    }
  } else {
    console.log(`Examine what?`);
  }
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


function doDebug(words) {

  if (words.length === 1) {
    displayDebugFlags();
  } else if (words.length === 2) {
    setDebugFlag(words[1]);
  } if (words.length === 3) { // "debug unit-name method-or-*"
    wrapUnit(words[1].toUpperCase(), words[2]);
  }


  function displayDebugFlags() {
    // Display all our wrapped (for debug) EBOX unit methods first.
    EBOX.unitArray
      .sort()
      .forEach(u => wrappedMethods(u)
               .forEach(method => console.log(`  debug logging on ${u.name} ${method}`)));

    if (CRADR.debugNICOND) console.log(`NICOND debug ON`);
  }


  function setDebugFlag(flag) {

    switch (flag) {
    case 'NICOND':
      CRADR.debugNICOND ^= 1;
      console.log(`NICOND debug now ${CRADR.debugNICOND ? 'ON' : 'OFF'}`);
      break;

    default:
      console.log(`UNKNOWN debug flag ${flag} ignored`);
      break;
    }
  }


  function wrapUnit(unitName, method) {
    const unit = Named.units[unitName];

    if (!unit) return;

    if (method === '*') {

      // Do ALL the methods on our wrappable list.
      (unit.wrappableMethods || [])
        .filter(method => typeof unit[method] === typeofFunction)
        .forEach(method => {

          if (methodIsWrapped(unit, method)) { // Already wrapped, so unwrap
            unwrapMethod(unit, method);
            console.log(`${unit.name} ${method} debug now off`);
          } else {                             // Not wrapped, so wrap
            wrapMethod(unit, method);
            console.log(`${unit.name} ${method} debug now on`);
          }
        });
    } else {

      if (typeof unit[method] !== typeofFunction) {
        console.error(`${unit.name} doesn't have a method called "${method}"`);
      } else {

        if (methodIsWrapped(unit, method)) { // Already wrapped, so unwrap
          unwrapMethod(unit, method);
          console.log(`${unit.name} ${method} debug now off`);
        } else {                             // Not wrapped, so wrap
          wrapMethod(unit, method);
          console.log(`${unit.name} ${method} debug now on`);
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
  lastL = CRADR.get();
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
  lastL = CRADR.get();
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
      const cradr = CRADR.get();

      if (breakpoint[cradr]) {
	console.log(`[${breakpoint[cradr]}]`); // Say why we stopped
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

      if (!maxCount || breakpoint[CRADR.get()]) {
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


function assemble(op, a, i, x, y) {
  return 0n |
    BigInt(op) << shiftForBit(8) |
    BigInt(a) << shiftForBit(12) |
    BigInt(i) << shiftForBit(13) |
    BigInt(x) << shiftForBit(17) |
    BigInt(y);
}


const X = 0o123n;
const Y = 0o222n;
const Z = 0o321n;


function createTestMicrocode() {
  const cram = CRAM.data;

  CR.value = 0n;
  CR.J = X;                     // Jump to three instruction bounce loop
  cram[0] = CR.value;
  console.log(`0000: ${disassemble(CR.value)}`);

  CR.value = 0n;
  CR.J = Y;
  cram[X] = CR.value;
  console.log(`${octal(X, 4)}: ${disassemble(CR.value)}`);

  CR.value = 0n;
  CR.J = Z;
  cram[Y] = CR.value;
  console.log(`${octal(Y, 4)}: ${disassemble(CR.value)}`);

  CR.value = 0n;
  CR.J = X;
  cram[Z] = CR.value;
  console.log(`${octal(Z, 4)}: ${disassemble(CR.value)}`);
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

  console.log(`After ${octal(0, 4)}: ${disassemble(CRAM.data[0])}`);
  console.log(`After ${octal(X, 4)}: ${disassemble(CRAM.data[X])}`);
  console.log(`After ${octal(Y, 4)}: ${disassemble(CRAM.data[Y])}`);
  console.log(`After ${octal(Z, 4)}: ${disassemble(CRAM.data[Z])}`);

  // HRROI 13,123456
  MBOX.data[0] = assemble(0o561, 0o13, 0, 0, 0o123456n);

  // HRLZI 12,1234
  MBOX.data[1] = assemble(0o515, 0o12, 0, 0, 0o1234n);

  // ADDI 11,4321
  MBOX.data[2] = assemble(0o271, 0o11, 0, 0, 0o4321n);
}


function main()
{
  doReset();
  setImmediate(startEmulator);
}


main();
