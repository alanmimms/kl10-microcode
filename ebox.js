'use strict';
// Components of KL10-PV CPU's EBOX.

const _ = require('lodash');

let microcode = require('./microcode.js');
let cram = microcode.cram;
let dram = microcode.dram;
let cramDefs = microcode.cramDefs;
let dramDefs = microcode.dramDefs;
let getField = microcode.getField;


// Array containing the bit mask indexed by PDP-10 numbered bit number.
const mask = _.range(36).map(n => Math.pow(2, 35 - n));


const AlwaysTrue = () => true;


// Object containing all of our components so we can iterate to set
// them up for each cycle.
let ebox = {};


class NamedElement {

  constructor(name) {
    this.name = name;

    // Add this instance to an array in 'ebox' property whose name is
    // our class name.
    this.isa = this.constructor.name.toLowerCase();
    if (!ebox[this.isa]) ebox[this.isa] = [];
    ebox[this.isa].push(this);
  }
}


let HasValueMixin = (superclass) => class extends superclass {

  constructor(value) {
    this.value = value;
  }

  get() {
    return this.value;
  }

  getField(pos, end) {
    return Math.trunc(this.get() / mask[pos]) % mask[end];
  }
}


// Constant value so we can just call get() on constants.
class Constant extends HasValueMixin(Object) {
}


class Reg extends HasValueMixin(NamedElement) {

  constructor(name) {
    super(name);
    this.nextValue = null;	// Set during cycle calculation phase.
    this.load = AlwaysTrue;	// Default is to always load each step.
  }

  // Define the chain of logic that produces this register's input
  // value each clock cycle. By calling this.input.get() we can
  // recursively determine what the next clock will latch in the
  // register.
  setInput(a) {
    this.input = a;
  }

  // Define the function that says we should load this.nextValue into
  // this.value. If undefined, we do so on every step.
  setLoad(a) {	// TODO: Define this for ARL, ARR, ARX, BR, BRX, PC,
		// VMA_PREV, ADR_BREAK
    this.load = a;
    return this;
  }

  // Store this register's value.
  setIfLoadEnabled(value) {
    if (this.load()) this.value = value;
  }
}


class Mux extends HasValueMixin(NamedElement) {

  setControl(c) {
    this.control = c;
    return this;
  }

  setInputs(a) {
    this.inputs = a;
    return this;
  }

  get() {
    // Determine which input is selected by our control.
    const c = this.control.get();
    return this.inputs[c].get();
  }
}


class Field extends NamedElement {
}


class Shifter extends Mux {
}


class RAM extends NamedElement {
}


class ALU extends HasValueMixin(NamedElement) {
}


class Concatenation extends NamedElement {
}


class SCAD_Logic extends NamedElement {
}


class VMA_Logic extends NamedElement {
}


class VMA_ALU_Logic extends NamedElement {
}


class EBUS_Interface extends NamedElement {
}


// Note DRAM addressing is complicated. See EBOX UD p. 1-7.
let DRAM = new RAM('DRAM', 512);
let DR;

// Note CRAM addressing is complicated.
let CRAM = new RAM('CRAM', 2048);
let CR;

// Fast memory is our 8 blocks of 16 ACs each.
let FM = new RAM('FM', 8 * 16);

// Macro instruction we're working on at the moment.
let IR = new Reg('IR');

let ARLL = new Reg('ARLL');
let ARLR = new Reg('ARLR');
let ARR = new Reg('ARR');
let ARX = new Reg('ARX');
let BR = new Reg('BR');
let BRX = new Reg('BRX');
let MQ = new Reg('MQ');
let FE = new Reg('FE');
let SC = new Reg('SC');
let SH_MUX = new Mux('SH MUX');
let SH = new Shifter('SH', SC);

let ADR_BREAK = new Reg('ADR BREAK');
let VMA = new VMA_Logic('VMA Logic');

let PC = new Reg('PC');
let VMA_PREV = new Reg('VMA PREV');

let ARMLL = new Mux('ARMLL');
let ARMLR = new Mux('ARMLR');
let ARMR = new Mux('ARMR');

let ARM0LL = new Mux('ARM0LL');
let ARM0LR = new Mux('ARM0LR');
let ARM0R = new Mux('ARM0R');

let ARXM = new Mux('ARXM');
let ADA = new Mux('ADA');
let ADB = new Mux('ADB');
let ADXA = new Mux('ADXA');
let ADXB = new Mux('ADXB');

let ARMMhi = new Mux('ARMMhi');
let ARMMlo = new Mux('ARMMlo');
let ARMM = new Concatenation(ARMMhi, ARMMlo);

let MQM = new Mux('MQM');

let VMA_ALU = new VMA_ALU_Logic('VMA ALU');
let VMA_AD = new Mux('VMA AD');
let VMA_PREV_OR_PC = new Mux('VMA HELD OR PC', [VMA_PREV, PC]);
let SCD_TRAP = new Mux('SCD TRAP');

let SCM = new Mux('SCM');
let SCAD_A = new Mux('SCAD A');
let SCAD_B = new Mux('SCAD B');
let SCAD = new SCAD_Logic('SCAD', [SCAD_A, SCAD_B]);

let CURRENT_BLOCK = new Reg('CURRENT BLOCK');
let PREVIOUS_BLOCK = new Reg('PREVIOUS BLOCK');
let FMPREV = new Mux('FM PREV');
let FMADR = new Mux('FMADR');
let FMBLK = new Mux('FMBLK');

let AD = new ALU('AD', [ADA, ADB]);
let ADX = new ALU('ADX', [ADXA, ADXB]);

let EBOX_TO_CACHE = new EBUS_Interface('EBOX -> CACHE');
let CACHE_TO_EBOX = new EBUS_Interface('CACHE -> EBOX');

let EBOX_TO_EBUS = new EBUS_Interface('EBOX -> EBUS');
let EBUS_TO_EBOX = new EBUS_Interface('EBUS -> EBOX');

let EBOX_TO_MBUS = new EBUS_Interface('EBOX -> MBUS');
let MBUS_TO_EBOX = new EBUS_Interface('MBUS -> EBOX');


const UNDEFINED = new Constant(0);
const ZERO = new Constant(0);


ARMMhi.setInputs({
  0: () => CR.f('MAGIC'),
  1: () => AR.extractField(0, 0) * 0o777,
  2: () => SCAD.getField(0, 8),
  3: () => SCAD.getField(0, 5)})
  .setControl(() => CR.f('ARMM'));

ARMMlo.setInputs({
  0: () => PC.extractField(13, 17),
  1: () => VMA_PREV.extractField(13, 17),
  2: UNDEFINED,
  3: UNDEFINED})
  .setControl(ARMMhi.control);

ADA.setInputs({
  0: AR,
  1: ARX,
  2: MQ,
  3: PC})
  .setControl(() => !CR.f('ADA EN') ? CR.f('ADA') : 0);
// ADA EN should probably have been called ADA DIS


ADB.setInputs({
  0: FM,
  1: () => BR.get() * 2,
  2: BR,
  3: () => AR.get () * 4})
  .setControl(() => CR.f('ADB'));

ADXA.setInputs({
  0: ADX,
  1: ZERO})
  .setControl(() => CR.f('ADA EN'));

ADXB.setInputs({
  0: UNDEFINED,
  1: () => BRX.get() * 2,
  2: () => Math.trunc(BRX / 2),
  3: () => ARX.get() * 4})
  .setControl(ADB.control);

// This defines the ARM value when ARM's control is zero.
ARM0.setInputs({
  0: AR,
  1: ARMM,
  2: MBUS_TO_EBOX,
  3: UNDEFINED})
  .setControl(() => {
    if (CR.f('COND') === 4) return ZERO;

    if (CR.f('COND') === 6 || CR.f('SPEC') === 0o22) {
    }

    return 0;			// TODO Remove this default
  });

ARM.setInputs({
  0: ARM0,
  1: CACHE_TO_EBOX,
  2: EBUS_TO_EBOX,
  3: SH,
  4: () => AD.get() * 2,
  5: ADX * 2,
  6: () => Math.trunc(AD.get() / 4)})
  .setControl(() => CR.f('AR'));

ARXM.setInputs({
  0: ARX,				// TODO This is sometimes CACHE or ARX or MEM
  1: CACHE_TO_EBOX,
  2: AD,
  3: MQ,
  4: SH,
  5: () => ADX.get() * 2,
  6: ADX,
  7: () => Math.trunc(ADX.get() / 4)})
  .setControl(() => CR.f('ARX'));

MQM.setInputs({			// Note SPEC/MQ SHIFT is used as a second mux control bit
  0: MQ,
  1: SH,
  2: () => Math.trunc(MQ.get() / 4) + AD.getField(-2, -2),
  3: () => MQ.get() * 2})
  .setControl(() => (CR.f('SPEC') === 0o12 ? 2 : 0) + CR.f('MQ'));

SCM.setInputs({			// Note SPEC/SCM ALT is used as a second mux control bit
  0: SC,
  1: SCAD,
  2: FE,
  3: () => (AR.getField(18) << 8) | AR.getField(28, 35)})
  .setControl(() => CR.f('SC') * 2 + (CR.f('SPEC') === 0o13 ? 1 : 0));

SCAD_A.setInputs({
  0: FE,
  1: () => AR.getField(0, 5),
  2: () => AR.getField(0) ^ AR.getField(1, 8),
  3: () => CR.f('MAGIC'),
  4: ZERO})
  .setControl(() => CR.f('SCADA EN') ? 4 : CR.f('SCADA'));

SCAD_B.setInputs({
  0: SC,
  1: () => AR.getField(6, 11),
  2: () => AR.getField(0, 8),
  3: () => CR.f('MAGIC')})
  .setControl(() => CR.f('SCADB'));
  

let uPC = 0;
let nextuPC = 0;


function step() {
  // Fetch next microinstruction.
  CR = cram[nextuPC];
  uPC = nextuPC;

  // Walk through every register and calculate its new value based on
  // current conditions. This flows data through muxes and connections
  // plumbed to each register's input recursively. When this is all
  // done we can then store the new value in each. We have to do it
  // this way because some register values depend on others and we
  // want them all to change like hardware would - on a clock edge,
  // based on their input values at that instant.
  ebox.reg.forEach(r => r.nextValue = r.input.get());

  // Now update them.
  ebox.reg.forEach(r => r.setIfLoadEnabled(r.nextValue));

  // Determine next uPC value.
  nextuPC = computeNextUPC();
}


function computeNextUPC() {
  return 0;			// TODO
}
