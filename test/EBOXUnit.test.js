'use strict';
const _ = require('lodash');
const expect = require('chai').expect;

const {octal} = require('../util');

const {
  EBOXUnit, Fixupable, Clock, Named, ConstantUnit, Reg, Mux,
  SERIAL_NUMBER, EBOX,
  CRAM, CRADR, CR,
  DRAM, DRADR, DR,
  PC, IR,
  BR, MQ,
} = require('../ebox-model');


describe('Fixupable', () => {
  it(`should wrap singletons marked as such explicitly and leave others unwrapped`, () => {
    const obj1ToRef = {a: 'this is the first singleton object we refer to'};
    const obj2ToRef = {a: 'this is the second singleton object we refer to'};

    var q = Fixupable.init(function({wrapped, notWrapped}) {
      this.wrapped = wrapped;
      this.notWrapped = notWrapped;
    }) ({name: 'qq',
         fixups: '[wrapped],notWrapped',
         wrapped: 'obj1ToRef',
         notWrapped: 'obj2ToRef'});

    Fixupable.fixup(x => eval(x));


    // {
    //   fixups: '[wrapped],notWrapped',
    //   wrapped: [ { a: 'this is the first singleton object we refer to' } ],
    //   notWrapped: { a: 'this is the second singleton object we refer to' }
    // });

    expect(q.wrapped).to.be.an('array');
    expect(q.wrapped[0]).to.have.key('a');
    expect(q.wrapped[0].a).to.equal('this is the first singleton object we refer to');

    expect(q.notWrapped).to.be.an('object');
    expect(q.notWrapped).to.have.key('a');
    expect(q.notWrapped.a).to.equal('this is the second singleton object we refer to');
  });
});


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
    M = Mux({name: 'M', bitWidth: 36, clock: CLK, //debugTrace: true,
             inputs: 'A,B,C,D,E', control: 'Mcontrol'});
    A = ConstantUnit({name: 'A', bitWidth: 36, value: 65n});
    B = ConstantUnit({name: 'B', bitWidth: 36, value: 66n});
    C = ConstantUnit({name: 'C', bitWidth: 36, value: 67n});
    D = ConstantUnit({name: 'D', bitWidth: 36, value: 68n});
    E = ConstantUnit({name: 'E', bitWidth: 36, value: 69n});
    Mcontrol = ConstantUnit({name: 'Mcontrol', bitWidth: 36, value: 0n});
    Fixupable.fixup(x => eval(x));

    it(`should select Mux inputs A-E (65-69 decimal) in turn`, () => {
      _.range(5).forEach(k => {
        Mcontrol.value = BigInt(k);
        CLK.latch();
        expect(M.getInputs()).to.equal(BigInt(k + 65));
        CLK.clockEdge();
        expect(M.get()).to.equal(BigInt(k + 65));
      });
    });
  });

  describe('Reg', () => {
    const R = Reg({name: 'R', bitWidth: 36, clock: CLK, inputs: 'M'});
    Fixupable.fixup(x => eval(x));

    it(`should latch Mux output selected to A-E (65-69 decimal) in turn`, () => {
      _.range(5).forEach(k => {
        Mcontrol.value = BigInt(k);
        CLK.latch();
        //    console.log(`↓ ${k}: R=${R.get()} M=${M.get()}`);
        expect(R.latchedValue).to.equal(BigInt(k + 65));
        CLK.clockEdge();
        //    console.log(`↑ ${k}: R=${R.get()} M=${M.get()}`);
        expect(R.get()).to.equal(BigInt(k + 65));
      });
    });
  });
});


describe('Clocking/latching', () => {

  describe('Fill CRAM with test microcode', () => {
    const X = 100n;
    const Y = 200n;
    const Z = 300n;

    // Setup stable state so AD can perform an ADD in first cycle.
    PC.latchedValue = 0o123456n;
    BR.latchedValue = 0o600100n;
    MQ.latchedValue = 0o000010n;

    const Xcode = `X: AD/A+B, ADA/PC ADB/BR, J/Y`;
    CRADR.latchedValue = X;
    CR.latchedValue = 0n;
    CR.AD = CR.AD['A+B'];
    CR.ADA = CR.ADA.PC;
    CR.ADB = CR.ADB.BR;
    CR.J = Y;
    CRAM.data[CRADR.latchedValue] = CR.latchedValue;
    CD(Xcode);

    const Ycode = `Y: AD/A+B, ADA/MQ, ADB/AR*4`;
    CRADR.latchedValue = Y;
    CR.latchedValue = 0n;
    CR.AD = CR.AD['A+B'];
    CR.ADA = CR.ADA.MQ;
    CR.ADB = CR.ADB['AR*4'];
    CR.J = Z;
    CRAM.data[CRADR.latchedValue] = CR.latchedValue;
    CD(Ycode);

    const Zcode = `Z: AD/A+B, ADA/AR, ADB/BR*2`;
    CRADR.latchedValue = Z;
    CR.latchedValue = 0n;
    CR.AD = CR.AD['A+B'];
    CR.ADA = CR.ADA.AR;
    CR.ADB = CR.ADB['BR*2'];
    CR.J = X;
    CRAM.data[CRADR.latchedValue] = CR.latchedValue;
    CD(Zcode);

    CRADR.latchedValue = X;
    CL(Xcode);
    EBOX.cycle();
    CL(`   after`);

    CL(Ycode);
    EBOX.cycle();
    CL(`   after`);

    CL(Zcode);
    EBOX.cycle();
    CL(`   after`);

    CL(Xcode);
    EBOX.cycle();
    CL(`   after`);

    CL(Ycode);
    EBOX.cycle();
    CL(`   after`);

    CL(Zcode);
    EBOX.cycle();
    CL(`   after`);

    CL(Xcode);
    EBOX.cycle();
    CL(`   after`);

    function CL(pre) {
      console.log(`\
${pre} ; CRADR=${octal(CRADR.latchedValue)} \
PC=${octal(PC.latchedValue)} BR=${octal(BR.latchedValue)} MQ=${octal(MQ.latchedValue)}`);
    }

    function CD(code) {
      console.log(`${code}
${octal(CRADR.latchedValue)}: ${octal(CR.latchedValue, 84/3)}`);
    }
  });
});


if (0) {describe('EBOX', () => {

  it(`should reset itself and all EBOXUnits`, () => {
    CRADR.stack = [1, 2, 3];    // Fill up a few things with state
    CRADR.latchedValue = 0o1234;
    _.range(1000).forEach(k => CRAM.data[k] = BigInt(k) * 0o1234567n);
    expect(CRAM.data[123]).to.equal(123n * 0o1234567n);
    IR.latchedValue = (0o123456n << 18n) | 0o765432n;
    PC.latchedValue = 0o123456n;
    EBOX.reset();
    expect(CRAM.data[123]).to.equal(0n);
    expect(CRADR.latchedValue).to.equal(0n);
    expect(CRADR.stack.length).to.equal(0);
    expect(IR.latchedValue).to.equal(0n);
    expect(PC.latchedValue).to.equal(0n);
  });

  it(`should reflect its serial number`, () => {
    expect(EBOX.SERIAL_NUMBER.latchedValue).to.equal(EBOX.serialNumber);
  });
});}

