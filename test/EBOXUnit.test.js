'use strict';
const _ = require('lodash');
const expect = require('chai').expect;

const {octal, oct6, octW} = require('../util');

const {
  EBOXUnit, Combinatorial, Clocked, Clock, Named, ConstantUnit, Reg, Mux,
  SERIAL_NUMBER, EBOX,
  CRAM, CRADR, CR,
  DRAM, DRADR, DR,
  VMA, PC, IR,
  AR, ARX, BR, BRX, MQ, AD, SH,
  ZERO, ONES,
} = require('../ebox-model');


const LOG = () => 0;
// const LOG = console.log;


describe('Named', () => {
  it('should allow us to name our stamps', () => {
    const q = Named({name: 'this is q'});
    expect(q.name).to.equal('this is q');
  });
});


describe('Clock', () => {
  it('should accumulate references to Units it drives', () => {
    const clock = Clock({name: 'clock'});
    const driven = EBOXUnit({name: 'driven', clock});

    expect(driven.clock).to.equal(clock);
    expect(clock.drives).to.satisfy(d => d.includes(driven));
  });
});


describe('Mux+Reg', () => {
  const CLK = Clock({name: 'CLK'});
  let M, A, B, C, D, E, Mcontrol, R;

  describe('Mux', () => {
    describe(`RESET EBOX`, () => EBOX.reset());

    Mcontrol = ConstantUnit({name: 'Mcontrol', bitWidth: 36, value: 0n});
    A = ConstantUnit({name: 'A', bitWidth: 36, value: 65n});
    B = ConstantUnit({name: 'B', bitWidth: 36, value: 66n});
    C = ConstantUnit({name: 'C', bitWidth: 36, value: 67n});
    D = ConstantUnit({name: 'D', bitWidth: 36, value: 68n});
    E = ConstantUnit({name: 'E', bitWidth: 36, value: 69n});
    M = Mux({name: 'M', bitWidth: 36, clock: CLK,
             inputs: [A,B,C,D,E], control: Mcontrol});

    it(`should select Mux inputs A-E (65-69 decimal) in turn`, () => {
      _.range(5).forEach(k => {
        Mcontrol.value = BigInt(k);
        expect(M.get()).to.equal(BigInt(k + 65));
        CLK.cycle();
        expect(M.get()).to.equal(BigInt(k + 65));
      });
    });
  });

  describe('Reg', () => {
    const R = Reg({name: 'R', bitWidth: 36, clock: CLK, inputs: M, control: ONES});

    it(`should latch Mux output selected to A-E (65-69 decimal) in turn`, () => {
      _.range(5).forEach(k => {
        Mcontrol.value = BigInt(k);
        CLK.cycle();
        expect(R.get().toString(8)).to.equal(BigInt(k + 65).toString(8));
      });
    });
  });
});


describe('Clocking/latching', () => {
  const X = 100n;
  const Y = 200n;
  const Z = 300n;
  let Xcode, Ycode, Zcode;

  describe('Fill CRAM with test microcode', () => {

    it(`should install CRAM microcode`, () => {
      // Setup stable state so AD can perform an ADD in first cycle.
      EBOX.reset();
      LOG(`\n\n= = = = EBOX was RESET = = = =\n`);
      VMA.value = PC.value = 0o123456n;
      BR.value = 0o600100n;
      MQ.value = 0o000010n;

      Xcode = `X: AD/A+B, ADB/BR, ADA/PC, AR/AD, AR CTL/ARR LOAD, J/Y`;
      CRADR.value = X;
      CR.value = 0n;
      CR.AD = CR.AD['A+B'];
      CR.ADA = CR.ADA.PC;
      CR.ADB = CR.ADB.BR;
      CR.AR = CR.AR.AD;
      CR['AR CTL'] = CR['AR CTL']['ARR LOAD'];
      CR.J = Y;
      CRAM.data[CRADR.value] = CR.value;
      CD(Xcode);

      Ycode = `Y: AD/A+B, ADB/AR*4, ADA/MQ, AR/AD, AR CTL/ARR LOAD, J/Z`;
      CRADR.value = Y;
      CR.value = 0n;
      CR.AD = CR.AD['A+B'];
      CR.ADA = CR.ADA.MQ;
      CR.ADB = CR.ADB['AR*4'];
      CR['AR CTL'] = CR['AR CTL']['ARR LOAD'];
      CR.AR = CR.AR.AD;
      CR.J = Z;
      CRAM.data[CRADR.value] = CR.value;
      CD(Ycode);

      Zcode = `Z: AD/A+B, ADA/AR, ADB/BR*2, AR CTL/ARR LOAD, J/X`;
      CRADR.value = Z;
      CR.value = 0n;
      CR.AD = CR.AD['A+B'];
      CR.ADA = CR.ADA.AR;
      CR.ADB = CR.ADB['BR*2'];
      CR['AR CTL'] = CR['AR CTL']['ARR LOAD'];
      CR.AR = CR.AR.AD;
      CR.J = X;
      CRAM.data[CRADR.value] = CR.value;
      CD(Zcode);
    });
  });

  describe(`Verify basic jump and ALU operation`, () => {

    it(`should cycle through X, Y, Z and then repeat while doing muxing and logic`, () => {
      CRADR.value = X;
      CRAM.latch();
      expect(CRADR.get().toString(8)).to.equal(X.toString(8));

      doCycle(Xcode);
      expect(CRADR.get().toString(8)).to.equal(Y.toString(8));
      expect(AR.value.toString(8)).to.equal(0o723556n.toString(8));

      doCycle(Ycode);
      expect(CRADR.get().toString(8)).to.equal(Z.toString(8));
      expect(AR.value.toString(8)).to.equal(0o3516700n.toString(8));

      doCycle(Zcode);
      expect(CRADR.get().toString(8)).to.equal(X.toString(8));
      expect(AR.value.toString(8)).to.equal(0o5117100n.toString(8));

      doCycle(Xcode);
      expect(CRADR.get().toString(8)).to.equal(Y.toString(8));
      expect(AR.value.toString(8)).to.equal(0o723556n.toString(8));

      doCycle(Ycode);
      expect(CRADR.get().toString(8)).to.equal(Z.toString(8));
      expect(AR.value.toString(8)).to.equal(0o3516700n.toString(8));

      doCycle(Zcode);
      expect(CRADR.get().toString(8)).to.equal(X.toString(8));
      expect(AR.value.toString(8)).to.equal(0o5117100n.toString(8));
    });
  });

  function doCycle(code) {
    LOG(`
EXECUTE:`);
    CL(code);
    EBOX.cycle();
    CL(`   after`);
  }

  function CL(pre) {
    LOG(`\
${pre} ; CRADR=${octal(CRADR.value)}
   PC=${octW(PC.value)} BR=${octW(BR.value)} \
MQ=${octW(MQ.value)} AD=${octW(AD.value)} AR=${octW(AR.value)}`);
  }

  function CD(code) {
    LOG(`CRAM[${octal(CRADR.value)}] put ${code}
${octal(CR.value, 84/3)}`);
  }
});


if (0) {describe('EBOX', () => {

  it(`should reset itself and all EBOXUnits`, () => {
    CRADR.stack = [1n, 2n, 3n];    // Fill up a few things with state
    CRADR.value = 0o1234n;
    _.range(1000).forEach(k => CRAM.data[k] = BigInt(k) * 0o1234567n);
    expect(CRAM.data[123]).to.equal(123n * 0o1234567n);
    IR.value = (0o123456n << 18n) | 0o765432n;
    PC.value = 0o123456n;
    describe(`RESET EBOX`, () => EBOX.reset());
    expect(CRAM.data[123]).to.equal(0n);
    expect(CRADR.value).to.equal(0n);
    expect(CRADR.stack.length).to.equal(0);
    expect(IR.value).to.equal(0n);
    expect(PC.value).to.equal(0n);
  });

  it(`should reflect its serial number`, () => {
    expect(EBOX.SERIAL_NUMBER.value).to.equal(EBOX.serialNumber);
  });
});}
