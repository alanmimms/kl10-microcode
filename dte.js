// Implement bare-bones part of DTE20 so we can do console I/O.
'use strict';
const {
  NEG1, Named,
  EBOX, PC,
} = require('./ebox');

const {
  maskForBit, fieldExtract,
  octW, octal, oct6,
} = require('./util');

const dteBitNumbers = {
  // CONI DTE bit numbers
  DTEPRV: 20,	// Privileged/restricted bit in CONI

  // CONO DTE bit numbers
  TO11DB: 22,		// To 11 doorbell
  CR11B: 23,		// Clear the reload PDP-11 button
  SR11B: 24,		// Set reload PDP-11 button. Setting ROM boots PDP11.
  CL11PI: 26,		// Clear PDP11 requestion I/O interrupt flag
  DLTO11: 29,		// Clear both TO11 normal and error termination flags
  CLTO10: 30,		// Clear both TO10 noraml and error termination flags
  PIENB: 31,		// Set PI assignment
  PI0ENB: 32,		// Enable PI 0

  // DATAO DTE bit numbers
  DON10S: 15,		// Set TO10 normal termination for diags.
  DON10C: 14,		// Clear TO10 normal termination for diags.
  ERR10S: 13,		// Set TO10 error termination for diags.
  ERR10C: 12,		// Clear TO10 normal termination for diags.
  INT11S: 11,		// Set 10 to 11 request.
  INT11C: 10,		// Clear 10 to 11 request.
  PERCLR:  9,		// Clear PDP11 memory parity error flag.
  INT10S:  8,		// Set request PDP10 interrupt thru EPT 142+8*n.
  DON11S:  7,		// Set TO11 normal termination flag for diags.
  DON11C:  6,		// Clear TO11 normal termination flag for diags.
  INTRON:  5,		// KEnable DTE to gen PDP11 BR requests.
  EBUSPC:  4,		// Clear EBus parity error.
  INTROF:  3,		// Disable DTE from gen PDP 11 BR requests.
  EBUSPS:  2,		// Set EBus parity error.
  ERR11S:  1,		// Set TO11 error termination flag for diags.
  ERR11C:  0,		// Clear TO11 error termination flag for diags.

  // DATAI DTE bit numbers
  TO10ND: 15,			// TO10 byte count now zero or PDP11 set DON10S.
  TO10ER: 13,			// TO10 error during transfer.
  RAMIS0: 12,			// Data from RAM is all 0s for diags.
  TO11DBdatai: 11,		// PDP10 CONO DTE requested PDP11 doorbell int.
  MPE11:   9,			// PDP11 memory parity error.
  TO10DB:  8,			// PDP11 requested PDP10 doorbell int.
  TO11DN:  7,			// TO11 byte count now zero or PDP11 set DON11S.
  EBSEL:   6,			// E Buffer Select for diags.
  NULSTP:  5,			// TO11 xfer stopped because TO11BC[Zstop] = 1.
  BPARER:  4,			// EBus parity error.
  RM:      3,			// PDP11 is in restricted mode.
  DEXON:   2,			// Last deposit or examine has completed.
  TO11ER:  1,			// Error in TO11 byte transfer or PDP11 set ERR11S.
  INTSON:  0,			// DTE is enabled for PDP11 BR requests.
};

const dte = {
  // DTE offsets in EPT
  //	First, the Channel Control Block words 
  DTEII:  0o142,		// DTE interrupt instruction
  DTEEPW: 0o144,		// DTE Examine Protection Word
  DTEERW: 0o145,		// DTE Examine Relocation Word
  DTEDPW: 0o146,		// DTE Deposit Protection Word
  DTEDRW: 0o147,		// DTE Deposit Relocation Word

  //	Then the secondary protocol words
  DTEFLG: 0o444,		// Operation complete flag word
  DTEF11: 0o450,		// PDP11 to PDP10 argument
  DTECMD: 0o451,		// PDP10 to PDP11 command word
  DTEOPR: 0o453,		// Operation in progress flag
  DTEMTD: 0o455,		// Monitor output done when nonzero
  DTEMTI: 0o456,		// 0 if ready for another char from 11

  restrictedMode: 0,		// We're PRIVILEGED
  piAssigned: 0,
  pi0Enabled: 0,

  monitorMode: 0,		// We're in Secondary Protocol or MONITOR mode
};


// Add each symbol for a bit number listed in `dteBitNumbers` as a
// field in `dte` containing the bit mask for the named bit.
Object.entries(dteBitNumbers)
  .forEach(([name, bit]) => dte[name] = maskForBit(bit));


const DTE = Named.compose({name: 'DTE'}).init(function({number, isMaster}) {
  this.number = number;
  this.isMaster = isMaster;
  this.debug = false;
  this.debugFlags = `DTE`.split(/,\s*/);
}).methods({
  // Called asynchronously when there's input on our CTY. TODO This
  // will lamely drop characters if PDP10 isn't keeping up. DTEMTI
  // will already be set in this case and we've got no way to wait.
  ttyIn(ch) {
    EBOX.putEPT(BigInt(dte.DTEF11), BigInt(ch));
    EBOX.putEPT(BigInt(dte.DTEMTI), NEG1);
  },

  clear() {
  },

  conditionsIn() {
    const v = (this.isMaster ? 0 : dte.restrictedMode * dte.DTEPRV) +
	  dte.piAssigned * dte.PIENB +
	  dte.pi0Enabled * dte.PI0ENB;
    return v;
  },

  conditionsOut(e) {
    const prefix = 'FE says: ';
    const PCprefix = `${prefix}PC=${octW(PC.value)}`;

    if (e & dte.PI0ENB)
      dte.pi0Enabled = 1n;
    else
      dte.pi0Enabled = 0n;

    if (e & dte.PIENB) dte.piAssigned = e & 7n;

    // Did the 11 get an interrupt from the 10? If so handle it
    // asynchronously.
    if (e & dte.TO11DB) setImmediate(() => {
	let w = EBOX.getEPT(dte.DTECMD);
	let monitorModeCmd = fieldExtract(w, 27, 4);

	switch (monitorModeCmd) {
	case 0o10:			// .DTTYO TTY output
	  w &= 0x7F;
	  const ch = String.fromCharCode(w);
	  process.stdout.write(ch);
	  setImmediate(() => EBOX.putEPT(BigInt(dte.DTEMTD), NEG1));
	  break;

	case 0o11:			// .DTMMN Monitor mode
	  dte.monitorMode = 1;
	  if (this.debug) console.log(`${prefix}DTE now in MONITOR mode`);
	  // Set command completed flag asynchronously.
	  setImmediate(() => EBOX.putEPT(BigInt(dte.DTEFLG), NEG1));
	  break;

	case 0o12:			// .DTNMC go to PRIMARY mode
	  console.log(`${PCprefix} Leaving DTE 'monitor' mode isn't supported.`);
	  //	dte.monitorMode = 0;
	  // Set command completed flag asynchronously.
	  setImmediate(() => EBOX.putEPT(BigInt(dte.DTEFLG), NEG1));
	  break;

	default:		// If it's not monitor mode command it
	  // might be one of the diagnostic ones
	  switch (w) {
	  case 0o401:
	    console.log(`${PCprefix} Fatal program error in KL10`);
	    EBOX.run = false;
	    break;

	  case 0o402:
	    console.log(`${PCprefix} Error halt in KL10`);
	    EBOX.run = false;
	    break;

	  case 0o403:
	    console.log(`${PCprefix} End of program notification`);
	    EBOX.run = false;
	    break;

	  case 0o404:
	    console.log(`${PCprefix} End of pass notification`);
	    EBOX.run = false;
	    break;

	  default:
	    console.log(`${PCprefix} Unknown DTE command word: ${octW(w)} IGNORED`);
	    break;
	  }

	  break;
	}
      });
  },
});
module.exports.DTE = DTE;
