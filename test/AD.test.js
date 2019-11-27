'use strict';
const _ = require('lodash');
const expect = require('chai').expect;

const {
  octal, oct6, octW,
  wrapMethod,
} = require('../util');

const {
  EBOXUnit, Combinatorial, Clocked, Clock, Named, ConstantUnit, Reg, Mux,
  SERIAL_NUMBER, EBOX,
  CRAM, CRADR, CR,
  DRAM, DRADR, DR,
  VMA, PC, IR,
  BR, BRX, MQ, SH,
  AD, AR, ARR, ARL, ADX, ARX,
  ZERO, ONES,
} = require('../ebox-model');


const X = 100n;
const Y = 200n;
const Z = 300n;
const PCinitial = 0o123456n;
const ARinitial = 0o654321n;
const BRinitial = 0o246100n;
const BRXinitial = 0o777777n;   // Must cause carry out if added to MQinitial
const MQinitial = 0o000010n;
const ARones = (1n << 38n) - 1n;
const ARRones = (1n << 18n) - 1n;
const ARXones = (1n << 36n) - 1n;
const ones36 = 0o777777777777n;
const ones38 = 0o3777777777777n;
const NOT = x => x ^ ones38;


describe('AD ALU', () => {

  function desc(op) {
    return `should do ${ARinitial.toString(8)} ${op} ${BRinitial.toString(8)}`;
  }

  beforeEach('Reset EBOX', () => {
    EBOX.reset();

    VMA.value = PC.value = PCinitial;
    BR.value = BRinitial;
    MQ.value = MQinitial;
    ARR.value = ARinitial;
  });

  describe(`Arithmetic functions`, () => {

    it(`should add BR and PC to ARR and jump to Y`, () => {
      // `X: AD/A+B, ADB/BR, ADA/PC, AR/AD, AR CTL/ARR LOAD, J/Y
      CR.value = 0n;
      CR.AD = CR.AD['A+B'];
      CR.ADA = CR.ADA.PC;
      CR.ADB = CR.ADB.BR;
      CR.AR = CR.AR.AD;
      CR['AR CTL'] = CR['AR CTL']['ARR LOAD'];
      CR.J = Y;
      CRAM.data[X] = CR.value;

      CRADR.value = X;
      expect(CRADR.get().toString(8)).to.equal(X.toString(8), `CRADR.get() before cycle`);
      EBOX.cycle();
      expect(CRADR.get().toString(8)).to.equal(Y.toString(8), `CRADR.get() after cycle`);
      expect(AR.get().toString(8)).to
        .equal(((BRinitial + PCinitial) & ARRones).toString(8), `AR.get()`);
    });

    it(`should add AR*4 and MQ to ARR and jump to Z`, () => {

      // Y: AD/A+B, ADB/AR*4, ADA/MQ, AR/AD, AR CTL/ARR LOAD, J/Z
      CR.value = 0n;
      CR.AD = CR.AD['A+B'];
      CR.ADA = CR.ADA.MQ;
      CR.ADB = CR.ADB['AR*4'];
      CR['AR CTL'] = CR['AR CTL']['ARR LOAD'];
      CR.AR = CR.AR.AD;
      CR.J = Z;
      CRAM.data[Y] = CR.value;

      CRADR.value = Y;
      ARR.value = ARinitial;
      EBOX.cycle();
      expect(CRADR.get().toString(8)).to.equal(Z.toString(8), `CRADR.get()`);
      expect(AR.get().toString(8)).to
        .equal(((ARinitial*4n + MQinitial) & ARRones).toString(8), `AR.get()`);
    });

    it(`should add AR and BR*2 to ARR and jump to X`, () => {
      // Z: AD/A+B, ADA/AR, ADB/BR*2, AR CTL/ARR LOAD, J/X
      CR.value = 0n;
      CR.AD = CR.AD['A+B'];
      CR.ADA = CR.ADA.AR;
      CR.ADB = CR.ADB['BR*2'];
      CR['AR CTL'] = CR['AR CTL']['ARR LOAD'];
      CR.AR = CR.AR.AD;
      CR.J = X;
      CRAM.data[Z] = CR.value;

      CRADR.value = Z;
      EBOX.cycle();
      expect(CRADR.get().toString(8)).to.equal(X.toString(8), `CRADR.get()`);
      expect(AR.get().toString(8)).to
        .equal(((ARinitial + BRinitial*2n) & ARRones).toString(8), `AR.get()`);
    });

    it(desc('A+1'),           () => arithOp('A+1',    (a, b) => a + 1n));
    it(desc('A+XCRY c=0'),    () => arithOp('A+XCRY', (a, b) => a + 0n, 0n));
    it(desc('A+XCRY c=1'),    () => arithOp('A+XCRY', (a, b) => a + 1n, 1n));
    it(desc('A*2 c=0'),       () => arithOp('A*2',    (a, b) => a * 2n + 0n));
    it(desc('A*2 c=1'),       () => arithOp('A*2',    (a, b) => a * 2n + 1n, 1n));
    it(desc('A*2+1'),         () => arithOp('A*2+1',  (a, b) => a * 2n + 1n));
    it(desc('A+B c=0'),       () => arithOp('A+B',    (a, b) => a + b + 0n, 0n));
    it(desc('A+B c=1'),       () => arithOp('A+B',    (a, b) => a + b + 1n, 1n));
    it(desc('A+B+1'),         () => arithOp('A+B+1',  (a, b) => a + b + 1n));
    it(desc('ORCB+1'),        () => arithOp('ORCB+1', (a, b) => (a | NOT(b)) + 1n));
    it(desc('A-B-1'),         () => arithOp('A-B-1',  (a, b) => a - b - 1n));
    it(desc('A-B c=0'),       () => arithOp('A-B',    (a, b) => a - b - 1n, 0n));
    it(desc('A-B c=1'),       () => arithOp('A-B',    (a, b) => a - b - 0n, 1n));
    it(desc('XCRY-1 c=0'),    () => arithOp('XCRY-1', (a, b) => ARRones, 0n));
    it(desc('XCRY-1 c=1'),    () => arithOp('XCRY-1', (a, b) => 0n, 1n));
    it(desc('A-1 c=0'),       () => arithOp('A-1',    (a, b) => a - 1n, 0n));
    it(desc('A-1 c=1'),       () => arithOp('A-1',    (a, b) => a, 1n));


    // Set up CRAM for binary op on AR and BR called CR.AD/`CRname`.
    // Test for result calculated by opFunc.
    function arithOp(CRname, opFunc, cin = 0n) {
      const sb = opFunc(ARinitial, BRinitial) & ARRones;
      const arxA = cin ? 0o777777777770n : 0n; // Cause ARX to generate carry out
      const arxSB = (arxA + MQinitial) & ARXones;

      // Z: AD/${CRname}, ADA/AR, ADB/BR, ARX/ADX, AR CTL/ARR LOAD, J/X
      CR.value = 0n;
      CR.AD = CR.AD[CRname];
      CR.ADA = CR.ADA.AR;
      CR.ADB = CR.ADB.BR;
      CR['AR CTL'] = CR['AR CTL']['ARR LOAD'];
      CR.AR = CR.AR.AD;
      ARX.value = arxA;         // As if generated by previous cycle
      if (!cin) BRX.value = 0n; // Do not generate carry out of ARX
      CR.ARX = CR.ARX.ADX;      // Will compute arxA + BRX (may generate carry)
      CR.J = X;
      CRAM.data[Z] = CR.value;
      CRADR.value = Z;
      EBOX.cycle();
      expect(CRADR.get().toString(8)).to.equal(X.toString(8), `CRADR.get()`);
      expect(AR.get().toString(8)).to.equal(sb.toString(8), `AR.get()`);
      expect(ADX.cout.toString(8)).to.equal(cin.toString(8), `ADX.cout`);
    }
  });

  describe(`Logical functions`, () => {
    it(desc('A'),          () => boolOp('A',     (a, b) => a));
    it(desc('B'),          () => boolOp('B',     (a, b) => b));
    it(desc('OR'),         () => boolOp('OR',    (a, b) => a | b));
    it(desc('AND'),        () => boolOp('AND',   (a, b) => a & b));
    it(desc('XOR'),        () => boolOp('XOR',   (a, b) => a ^ b));
    it(desc('EQV'),        () => boolOp('EQV',   (a, b) => NOT(a ^ b)));
    it(desc('SETCA'),      () => boolOp('SETCA', (a, b) => NOT(a)));
    it(desc('SETCB'),      () => boolOp('SETCB', (a, b) => NOT(b)));
    it(desc('0S'),         () => boolOp('0S',    (a, b) => 0n));
    it(desc('1S'),         () => boolOp('1S',    (a, b) => ones36));
    it(desc('NOR'),        () => boolOp('NOR',   (a, b) => NOT(a | b)));
    it(desc('ORCA'),       () => boolOp('ORCA',  (a, b) => NOT(a) | b));
    it(desc('ORCB'),       () => boolOp('ORCB',  (a, b) => a | NOT(b)));
    it(desc('ANDCA'),      () => boolOp('ANDCA', (a, b) => NOT(a) & b));
    it(desc('ANDCB'),      () => boolOp('ANDCB', (a, b) => a & NOT(b)));
    it(desc('ANDC (NOR)'), () => boolOp('ANDC',  (a, b) => NOT(a | b)));
    it(desc('ORC (NAND)'), () => boolOp('ORC',   (a, b) => NOT(a) | NOT(b)));

    
    // Set up CRAM for binary op on AR and BR called CR.AD/`CRname`.
    // Test for result calculated by opFunc.
    function boolOp(CRname, opFunc) {
      const expected = opFunc(ARinitial, BRinitial) & ARRones;

      // Z: AD/${CRname}, ADA/AR, ADB/BR, AR CTL/ARR LOAD, J/X
      CR.value = 0n;
      CR.AD = CR.AD[CRname];
      CR.ADA = CR.ADA.AR;
      CR.ADB = CR.ADB.BR;
      CR['AR CTL'] = CR['AR CTL']['ARR LOAD'];
      CR.AR = CR.AR.AD;
      CR.J = X;
      CRAM.data[Z] = CR.value;
      CRADR.value = Z;
      EBOX.cycle();
      expect(CRADR.get().toString(8)).to.equal(X.toString(8), `CRADR.get()`);
      expect(ARR.get().toString(8)).to
        .equal(expected.toString(8), `op was ${oct6(ARinitial)} ${CRname} ${oct6(BRinitial)}`);
    }
  });
});
