'use strict';
const _ = require('lodash');
const expect = require('chai').expect;

const e = require('../ebox-model');
const {EBOXUnit, Fixupable, Clock, Named} = e;


describe('Fixupable', () => {
  it(`should wrap singletons marked as such explicitly and leave others unwrapped`, () => {
    global.obj1ToRef = {a: 'this is the first singleton object we refer to'};
    global.obj2ToRef = {a: 'this is the second singleton object we refer to'};

    var q = Fixupable.init(function({wrapped, notWrapped}) {
      this.wrapped = wrapped;
      this.notWrapped = notWrapped;
    }) ({name: 'qq',
         fixups: '[wrapped],notWrapped',
         wrapped: 'obj1ToRef',
         notWrapped: 'obj2ToRef'});

    Fixupable.fixup();


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


describe('EBOXUnit', () => {

});
