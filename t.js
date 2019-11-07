const e = require('./ebox-model');

var q = e.Fixupable.init(function({zzz}) {
  this.zzz = zzz;
}) ({name: 'qq', fixups: '[zzz]', zzz: '["a", "b", "c"]'});

e.Fixupable.fixup();

console.log(q);

