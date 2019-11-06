'use strict';

const fs = require('fs');
const util = require('util');
const _ = require('lodash');

const CLA = require('command-line-args');
const CLU = require('command-line-usage');

const EBOXmodel = require('./ebox-model');
const CRAMwords = require('./cram.js');
const DRAMwords = require('./dram.js');
const UCODE = require('./microcode.js');


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
Emulate a DEC KL10PV CPU configured to run TOPS-20`,
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


const cpu = {

  updateState(mpc) {
  },
};               // XXX for now


function main()
{
  const {EBOX, CRAM, DRAM, CR, DR} = EBOXmodel;

  UCODE.initialize(EBOX);

  // Load CRAM from our Microcode
  _.range(0, CRAMwords.nWords).forEach((mw, addr) => {
    CRAM.addr = addr;
    CR.value = mw;
    CRAM.latch();
  });

  // Load DRAM from our Microcode
  _.range(0, DRAMwords.nWords).forEach((dw, addr) => {
    DRAM.addr = addr;
    DR.value = dw;
    DRAM.latch();
  });

  // Reset
  EBOX.reset();

  // Launch the microcode by calling the first microinstruction
  // function.
  debugger;

  let mpc = 0;

  while (true) {
    cpu.updateState(mpc);
    mpc = UCODE.ops[mpc](cpu);
  }
}


main();
