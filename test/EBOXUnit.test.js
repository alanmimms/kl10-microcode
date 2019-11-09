'use strict';
const _ = require('lodash');
const expect = require('expect.js');

const e = require('../ebox-model');

describe('Fixupable', () => {
  it(`should wrap singletons marked as such explicitly and leave others unwrapped`, () => {
    global.obj1ToRef = {a: 'this is the first singleton object we refer to'};
    global.obj2ToRef = {a: 'this is the second singleton object we refer to'};

    var q = e.Fixupable.init(function({wrapped, notWrapped}) {
      this.wrapped = wrapped;
      this.notWrapped = notWrapped;
    }) ({name: 'qq',
         fixups: '[wrapped],notWrapped',
         wrapped: 'obj1ToRef',
         notWrapped: 'obj2ToRef'});

    e.Fixupable.fixup();


    // {
    //   fixups: '[wrapped],notWrapped',
    //   wrapped: [ { a: 'this is the first singleton object we refer to' } ],
    //   notWrapped: { a: 'this is the second singleton object we refer to' }
    // });

    expect(q.wrapped).to.be.an('array');
    expect(q.wrapped[0]).to.only.have.keys('a');
    expect(q.wrapped[0].a).to.be('this is the first singleton object we refer to');

    expect(q.notWrapped).to.be.an('object');
    expect(q.notWrapped).to.only.have.key('a');
    expect(q.notWrapped.a).to.be('this is the second singleton object we refer to');
  });
});
