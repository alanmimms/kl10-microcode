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
  BR, BRX, MQ, AD, SH,
  AR, ARR, ARL, ARX,
  ZERO, ONES,
} = require('../ebox-model');


const X = 100n;
const Y = 200n;
const Z = 300n;
const PCinitial = 0o123456n;
const MQinitial = 0o000010n;
const BRinitial = 0o600100n;
const ARinitial = 0o654321n;
const ones36 = 0o777777777777n;
const ones38 = 0o3777777777777n;


beforeEach(() => {
  EBOX.reset();

  VMA.value = PC.value = PCinitial;
  BR.value = BRinitial;
  MQ.value = MQinitial;
  ARR.value = ARinitial;
});


describe('AD ALU', () => {

  describe(`Addition`, () => {

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
      expect(CRADR.get().toString(8)).to.equal(X.toString(8));
      EBOX.cycle();
      expect(CRADR.get().toString(8)).to.equal(Y.toString(8));
      expect(AR.value.toString(8)).to.equal((BRinitial + PCinitial).toString(8));
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
      expect(CRADR.get().toString(8)).to.equal(Z.toString(8));
      expect(AR.value.toString(8)).to.equal((ARinitial*4n + MQinitial).toString(8));
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
      expect(CRADR.get().toString(8)).to.equal(X.toString(8));
      expect(AR.value.toString(8)).to.equal((ARinitial + BRinitial*2n).toString(8));
    });
  });

  describe(`Boolean`, () => {
    
    describe(`Logical functions`, () => {

      it(`should do OR`, () => boolOp('OR', (a, b) => a | b));
      it(`should do AND`, () => boolOp('AND', (a, b) => a & b));
      it(`should do XOR`, () => boolOp('XOR', (a, b) => a ^ b));
      it(`should do EQV`, () => boolOp('EQV', (a, b) => NOT(a ^ b)));
      it(`should do SETCA`, () => boolOp('XOR', (a, b) => NOT(a)));
      it(`should do SETCB`, () => boolOp('XOR', (a, b) => NOT(b)));
      it(`should do 0S`, () => boolOp('0S', (a, b) => 0n));
      it(`should do 1S`, () => boolOp('1S', (a, b) => ones36));
      it(`should do NOR`, () => boolOp('NOR', (a, b) => NOT(a | b)));
      it(`should do ORC (NAND)`, () => boolOp('ORC', (a, b) => NOT(a & b)));
      it(`should do ORCA`, () => boolOp('ORCA', (a, b) => NOT(a) | b));
      it(`should do ANDC`, () => boolOp('ANDC', (a, b) => NOT(a & b)));
      it(`should do ORCB`, () => boolOp('ORCB', (a, b) => a | NOT(b)));
      it(`should do ANDCA`, () => boolOp('ANDCA', (a, b) => NOT(a) & b));
      it(`should do ANDCB`, () => boolOp('ANDCB', (a, b) => a & NOT(b)));
      it(`should do A`, () => boolOp('A', (a, b) => a));
      it(`should do B`, () => boolOp('B', (a, b) => b));


      // Set up CRAM for binary op on AR and BR called CR.AD/`CRname`.
      // Test for result calculated by opFunc.
      function boolOp(CRname, opFunc) {
        const expected = opFunc(ARinitial, BRinitial);
        // Z: AD/OR, ADA/AR, ADB/BR, AR CTL/ARR LOAD, J/X
        CR.value = 0n;
        CR.AD = CR.AD[CRname];
        CR.ADA = CR.ADA.AR;
        CR.ADB = CR.ADB['BR'];
        CR['AR CTL'] = CR['AR CTL']['ARR LOAD'];
        CR.AR = CR.AR.AD;
        CR.J = X;
        CRAM.data[Z] = CR.value;
        CRADR.value = Z;
        EBOX.cycle();
        expect(CRADR.get().toString(8)).to.equal(X.toString(8));
        expect(AR.value.toString(8)).to.equal(expected.toString(8));
      }

      function NOT(x) {
        return x ^ ones36;
      }
    });
  });
});
