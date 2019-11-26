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


describe('EBOX', () => {

  beforeEach('EBOX reset', () => {
    EBOX.reset();
  });

  it(`should clear EBOX state`, () => {
    CRADR.stack = [1n, 2n, 3n];    // Fill up a few things with state
    CRADR.value = 0o1234n;
    _.range(1000).forEach(k => CRAM.data[k] = BigInt(k) * 0o1234567n);
    expect(CRAM.data[123]).to.equal(123n * 0o1234567n);
    IR.value = (0o123456n << 18n) | 0o765432n;
    PC.value = 0o123456n;
    EBOX.reset();
    expect(CRAM.data[123]).to.equal(0n);
    expect(CRADR.value).to.equal(0n);
    expect(CRADR.stack.length).to.equal(0);
    expect(IR.value).to.equal(0n);
    expect(PC.value).to.equal(0n);
  });

  it(`should reflect its serial number`, () => {
    expect(SERIAL_NUMBER.get()).to.equal(EBOX.serialNumber);
  });
});


describe('Clocking/latching', () => {
  const X = 100n;
  const Y = 200n;
  const Z = 300n;

  beforeEach('Reset EBOX and fill CRAM with canonical X,Y,Z jumping ucode', () => {
    EBOX.reset();
    // X: J/Y
    CR.value = 0n;
    CR.J = Y;
    CRAM.data[X] = CR.value;

    // J/Z
    CR.value = 0n;
    CR.J = Z;
    CRAM.data[Y] = CR.value;

    // J/X
    CR.value = 0n;
    CR.J = X;
    CRAM.data[Z] = CR.value;
  });

  describe(`Verify basic CRAM J/x jump operation`, () => {

    it(`should cycle through X, Y, Z and then repeat`, () => {
      CRADR.value = X;
      CRAM.latch();

      expect(CRADR.get().toString(8)).to.equal(X.toString(8));
      EBOX.cycle();
      expect(CRADR.get().toString(8)).to.equal(Y.toString(8));
      EBOX.cycle();
      expect(CRADR.get().toString(8)).to.equal(Z.toString(8));
      EBOX.cycle();
      expect(CRADR.get().toString(8)).to.equal(X.toString(8));
      EBOX.cycle();
      expect(CRADR.get().toString(8)).to.equal(Y.toString(8));
      EBOX.cycle();
      expect(CRADR.get().toString(8)).to.equal(Z.toString(8));
      EBOX.cycle();
      expect(CRADR.get().toString(8)).to.equal(X.toString(8));
    });
  });
});


// Note we cannot use string forward references here unless we call
// Named.fixupForwardReferences() again.
describe('Mux+Reg', () => {
  const CLK = Clock({name: 'CLK'});
  const Mcontrol = ConstantUnit({name: 'Mcontrol', bitWidth: 36n, value: 0n});
  const A = ConstantUnit({name: 'A', bitWidth: 36n, value: 65n});
  const B = ConstantUnit({name: 'B', bitWidth: 36n, value: 66n});
  const C = ConstantUnit({name: 'C', bitWidth: 36n, value: 67n});
  const D = ConstantUnit({name: 'D', bitWidth: 36n, value: 68n});
  const E = ConstantUnit({name: 'E', bitWidth: 36n, value: 69n});
  const M = Mux({name: 'M', bitWidth: 36n, clock: CLK,
                 inputs: [A,B,C,D,E], control: Mcontrol});
  const R = Reg({name: 'R', bitWidth: 36n, clock: CLK, input: M});

  beforeEach('Reset EBOX', () => {
    EBOX.reset();
  });

  const expectedK = k => (BigInt(k) & 1n) ? BigInt(k) + 65n : 0n;

  describe('Mux', () => {

    it(`should select Mux inputs A-E (65-69 decimal) in turn`, () => {
      _.range(5).forEach(k => {
        const bigK = BigInt(k);
        Mcontrol.value = bigK;
        expect(M.get()).to.equal(bigK + 65n);
        CLK.cycle();
        expect(M.get()).to.equal(bigK + 65n);
      });
    });

    it(`should properly call and react to result of 'enableF'`, () => {

      _.range(5).forEach(k => {
        const bigK = BigInt(k);
        M.enableF = () => bigK & 1n; // Only enable on odd values
        Mcontrol.value = bigK;
        expect(M.get()).to.equal(expectedK(k));
        CLK.cycle();
        expect(M.get()).to.equal(expectedK(k));
      });
    });
  });

  describe('Reg', () => {

    it(`should latch Mux output selected to A-E (65-69 decimal) in turn`, () => {
      M.enableF = () => 1n;     // Always enabled again

      _.range(5).forEach(k => {
        const bigK = BigInt(k);
        Mcontrol.value = bigK;
        CLK.cycle();
        expect(R.get().toString(8)).to.equal((bigK + 65n).toString(8));
      });
    });
  });
});
