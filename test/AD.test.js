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


describe('AD ALU', () => {
  const X = 100n;
  const Y = 200n;
  const Z = 300n;
  const PCinitial = 0o123456n;
  const MQinitial = 0o000010n;
  const BRinitial = 0o600100n;

  describe(`Addition`, () => {

    beforeEach(() => {
      EBOX.reset();

      VMA.value = PC.value = PCinitial;
      BR.value = BRinitial;
      MQ.value = MQinitial;
    });
    

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
      const ARinitial = 0o654321n;

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
      ARR.value = 0o654321n;
      EBOX.cycle();
      expect(CRADR.get().toString(8)).to.equal(X.toString(8));
      expect(AR.value.toString(8)).to.equal((0o654321n + 0o600100n*2n).toString(8));
    });
  });
});
