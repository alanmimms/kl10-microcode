'use strict';
const _ = require('lodash');
const expect = require('chai').expect;

const {
  EBOXUnit, Fixupable, Clock, Named, ConstantUnit, Reg, Mux, SERIAL_NUMBER,
  EBOX, CRAM, CRADR, DRAM, IR, PC,
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


describe('EBOX', () => {

  it(`should reset itself and all EBOXUnits`, () => {
    CRADR.stack = [1, 2, 3];    // Fill up a few things with state
    CRADR.value = 0o1234;
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
    expect(EBOX.SERIAL_NUMBER.value).to.equal(EBOX.serialNumber);
  });
});
