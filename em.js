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


