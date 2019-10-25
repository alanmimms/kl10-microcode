'use strict';

const fs = require('fs');
const util = require('util');
const _ = require('lodash');

const CLA = require('command-line-args');
const CLU = require('command-line-usage');

const EBOX = require('./ebox-model');
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


function main()
{
  const {CRAM, DRAM, CR, DR} = EBOX;

  // Load CRAM from our Microcode
  _.range(0, UCODE.CRAM.nWords).forEach((mw, addr) => {
    CRAM.addr = addr;
    CR.value = mw;
    CRAM.latch();
  });

  // Load DRAM from our Microcode
  _.range(0, UCODE.DRAM.nWords).forEach((dw, addr) => {
    DRAM.addr = addr;
    DR.value = dw;
    DRAM.latch();
  });

  // Reset
  CRAM.addr = 0;
  DRAM.addr = 0;

  // Launch the microcode by calling the first microinstruction
  // function.
  EBOX.ops[0](cpu);
}


main();
