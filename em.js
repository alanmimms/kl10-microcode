'use strict';

const fs = require('fs');
const util = require('util');
const _ = require('lodash');
const readline = require('readline');
const keypress = require('keypress');

const CLA = require('command-line-args');
const CLU = require('command-line-usage');

const {
  octal, oct6, octW,
  shiftForBit,
  wrapMethod, unwrapMethod, wrappedMethods, methodIsWrapped,
} = require('./util');

const EBOXmodel = require('./ebox-model');
const CRAMwords = require('./cram.js');
const DRAMwords = require('./dram.js');
const cramLines = require('./cram-lines.js');

const {
  EBOX, MBOX,
  CRADR, CRAM, CR, DRAM, DR,
  AR, ARX, BR, BRX, MQ, VMA, PC,
  EBOXUnit,
} = EBOXmodel;


const historyMax = 100;
var breakpoint = {};
let historyEnabled = false;
const cradrHistory = [];
let cradrHistoryX = -1;

let startOfLastStep = 0;


const optionList =   {
  name: 'program', defaultOption: true,
  defaultValue: 'boot.sav',
  description: '[not yet implemented] REQUIRED program image to load (e.g., boot.sav)',
};

const OPT = CLA([optionList], {camelCase: true});


function usage(msg) {
  console.warn(CLU([
    {
      header: 'em',
      content: `\
Emulate a DEC KL10PV CPU configured to run TOPS-20 by running its \
microcode on simulated hardware`,
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
   description: 'Dump frequently used processor state including ACs',
   doFn: doDump,
  },
  
  {name: 'step',
   description: 'Step N times, where N is 1 if not specified',
   doFn: doStep,
  },

  {name: 'go',
   description: 'Continue execution.',
   doFn: doGo,
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
With arguments, set specified flag to specified value. If value is unspecified, toggle.`,
   doFn: doDebug,
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
  return cramLines[x];
}


function doDump(words) {
  const dump = [AR, ARX, BR, BRX, MQ, VMA, PC]
        .map(r => `${r.name}=${octW(r.get())}`)
        .reduce((cur, rd, x) => cur + rd + ((x & 3) === 0 ? '\n' : '  '), '');
  
  console.log(dump);
}


function doStep(words) {
  const n = words.length > 1 ? parseInt(words[1]) : 1;
  run(n);
  doDump();
}


function doGo(words) {
  console.log(`[Running from ${octal(CRADR.get())}]`);
  run();
}


function doTil(words) {
  console.log(`Not yet implemented.`);
}


function doAddressBreak(words) {
  console.log(`Not yet implemented.`);
}


function doExamine(words) {
  console.log(`Not yet implemented.`);
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

    // Display all our wrapped (for debug) EBOX unit methods first.
    EBOX.unitArray
      .sort()
      .forEach(u => wrappedMethods(u)
               .forEach(method => console.log(`  debug logging on ${u.name} ${method}`)));

    // XXX Display all our debug flags.

  } else if (words.length === 3) { // "debug unit-name method"
    const unitName = words[1].toUpperCase();
    const unit = EBOXUnit.units[unitName];
    const method = words[2];

    if (unit) {

      if (!unit[method]) {
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
    } else {
    }
  }
}


function doStats(words) {
  console.log(`Not yet implemented.`);
}


function doUnits(words) {
  const unitNamesSorted = Object.keys(EBOXUnit.units).sort();
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
  const parseLine = () => line.toLowerCase().trim().split(/\s+/);
  let words = parseLine();

  if ((words.length === 0 || words[0].length === 0) && lastLine != 0) {
    line = lastLine;
    words = parseLine();
  }

  let cmd = words[0] || '?';

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
    EBOX.run = false;
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
    if (c === 0o34) EBOX.run = false;

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
    EBOX.run = true;
    const startCount = EBOX.microInstructionsExecuted;
    const startTime = process.hrtime();

    for (let n = insnsPerTick; EBOX.run && n; --n) {
      EBOX.cycle();
      const cradr = CRADR.get();

      if (breakpoint[cradr]) {
	console.log(`[${breakpoint[cradr]}]`); // Say why we stopped
	breakpoint = {};
        EBOX.run = false;
      } else {
        if (maxCount && EBOX.microInstructionsExecuted - startCount >= maxCount)
	  EBOX.run = false;
      }
    }

    if (EBOX.run) {
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


function main()
{

  // Reset
  EBOX.reset();

  // Load CRAM from our Microcode
  CRAMwords.forEach((mw, addr) => CRAM.data[addr] = mw);

  // Load DRAM from our Microcode
  DRAMwords.forEach((dw, addr) => DRAM.data[addr] = dw);

  // HRROI 13,01234567
  MBOX.data[0] = 0o1234567n << 0n |
    0n << 18n |
    0n << 13n |
    13n << 12n |
    0o561n << shiftForBit(6);

  // HRLZI 12,1234
  MBOX.data[1] = 0o1234n << 0n |
    0n << 18n |
    0n << 13n |
    12n << 12n |
    0o555n << shiftForBit(6);

  // ADDI 11,4321
  MBOX.data[2] = 0o4321n << 0n |
    0n << 18n |
    0n << 13n |
    11n << 12n |
    0o271n << shiftForBit(6);

  setImmediate(startEmulator);
}


main();
