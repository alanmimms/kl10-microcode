const e = require('./ebox-model');

global.obj1ToRef = {a: 'this is the first singleton object we refer to'};
global.obj2ToRef = {a: 'this is the second singleton object we refer to'};

var q = e.Fixupable.init(function({wrapped, notWrapped}) {
  this.wrapped = wrapped;
  this.notWrapped = notWrapped;
}) ({name: 'qq', fixups: '[wrapped],notWrapped', wrapped: 'obj1ToRef', notWrapped: 'obj2ToRef'});

e.Fixupable.fixup();

console.log(q);

