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
  const {EBOX, CRA, CRAM, DRAM} = EBOXmodel;

  const cpu = {

    updateState() {
      console.log(`${octal4(CRA.value)}`);
    },
  };               // XXX for now


  // Reset
  EBOX.reset();

  // Load CRAM from our Microcode
  CRAMwords.forEach((mw, addr) => CRAM.data[addr] = mw);

  // Load DRAM from our Microcode
  DRAMwords.forEach((dw, addr) => DRAM.data[addr] = dw);

  // Make all of our EBOX Unit names and stamps available in
  // microcode.js as module-global symbols to make code generation
  // less verbose.
  UCODE.initialize(EBOX);

  // Launch the microcode by calling the first microinstruction
  // function.
  debugger;

  while (true) {
    cpu.updateState();
    UCODE.ops[CRA.value](cpu);
  }
}


main();
