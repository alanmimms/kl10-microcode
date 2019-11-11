'use strict';
const _ = require('lodash');
const expect = require('chai').expect;

const e = require('../ebox-model');
const {EBOXUnit, Fixupable, Clock, Named, ConstantUnit, Reg, Mux} = e;


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

    _.range(5).forEach(k => {
      Mcontrol.value = BigInt(k);
      CLK.latch();
      expect(M.getInputs()).to.equal(BigInt(k + 65));
      CLK.clockEdge();
      expect(M.get()).to.equal(BigInt(k + 65));
    });
  });

  describe('Reg', () => {
    const R = Reg({name: 'R', bitWidth: 36, clock: CLK, inputs: 'M'});
    Fixupable.fixup(x => eval(x));

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
