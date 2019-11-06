'use strict';

const fs = require('fs');
const util = require('util');
const _ = require('lodash');

const CLA = require('command-line-args');
const CLU = require('command-line-usage');

const {octal4} = require('./util');

const EBOXmodel = require('./ebox-model');
const CRAMwords = require('./cram.js');
const DRAMwords = require('./dram.js');


const optionList =   {
  name: 'program', defaultOption: true,
  defaultValue: 'boot.sav',
  description: 'REQUIRED program image to load (e.g., boot.sav)',
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


function main()
{
  const {EBOX, CRADR, CRAM, DRAM} = EBOXmodel;

  // Reset
  EBOX.reset();

  // Load CRAM from our Microcode
  CRAMwords.forEach((mw, addr) => CRAM.data[addr] = mw);

  // Load DRAM from our Microcode
  DRAMwords.forEach((dw, addr) => DRAM.data[addr] = dw);

  // Launch the microcode by calling the first microinstruction
  // function.
  debugger;

  // This exits the microcode HALT loop and allows instructions to
  // execute.
  EBOX.run = true;              // Run forever for now...

  while (true) {
    console.log(`upc=${octal4(CRADR.get())}`);
    EBOX.cycle();
  }
}


main();
