'use strict';
const util = require('util');
// 10181 netlist
// All references are to F10181.pdf p. 7-107 schematic.

// If true, build trees of ops.
const growTrees = false;

// If true, build array trees of ops.
const growATrees = true;

// If true, use lisp style ops.
const beLispy = false;

// If true, use symbolic ops, otherwise numeric/boolean ops.
const beSymbolic = false;


// First logic stage (row of two tiers of NOR gates decoding S0-3).
// In left to right order.
function do10181(a, b, m, s, c0) {
  const [a3, a2, a1, a0] = a;
  const [b3, b2, b1, b0] = b;
  const [s3, s2, s1, s0] = s;

  const a3a = NOR(NOT(a3), NOR(b3, s0), NOR(s1, NOT(b3)));
  const a3b = NOR(NOR(NOT(b3), a3, s2), NOR(a3, b3, s3));

  const a2a = NOR(NOT(a2), NOR(b2, s0), NOR(s1, NOT(b2)));
  const a2b = NOR(NOR(NOT(b2), a2, s2), NOR(a2, b2, s3));

  const a1a = NOR(NOT(a1), NOR(b1, s0), NOR(s1, NOT(b1)));
  const a1b = NOR(NOR(NOT(b1), a1, s2), NOR(a1, b1, s3));

  const a0a = NOR(NOT(a0), NOR(b0, s0), NOR(s1, NOT(b0)));
  const a0b = NOR(NOR(NOT(b0), a0, s2), NOR(a0, b0, s3));

  // t = s3 s2 s1 s0  a3  a2  a1  a0  b3  b2  b1  b0
  // f = s3 s2 s1 s0 !a3 !a2 !a1 !a0 !b3 !b2 !b1 !b0
  // ab=              b3  b2  b1  b0
  // nb=             !b3 !b2 !b1 !b0
  // s2=              s2  s2  s2  s2  s2  s2  s2  s2
  // s3=              s3  s3  s3  s3  s3  s3  s3  s3

  // Middle tier XOR gates
  const b3x = XOR(a3a, a3b);
  const b2x = XOR(a2a, a2b);
  const b1x = XOR(a1a, a1b);
  const b0x = XOR(a0a, a0b);

  // Third tier of NOR gates.
  const m3a = NOR(a3a, a2a, a1a, a0a, c0);
  const m3b = NOR(a3a, a2a, a1a, a0b);
  const m3c = NOR(a3a, a2a, a1b);
  const m3d = NOR(a3a, a2b);
  const m3e = NOT(a3b);
  const m3f = NOR(a3a, a2a, a1a, a0a);

  const m2a = NOR(c0, a0a, a1a, a2a, m);
  const m2b = NOR(a0b, a1a, a2a, m);
  const m2c = NOR(a1b, a2a, m);
  const m2d = NOR(a2b, m);

  const m1a = NOR(c0, a1a, a0a, m);
  const m1b = NOR(a0b, a1a, m);
  const m1c = NOR(a1b, m);

  const m0a = NOR(c0, a0a, m);
  const m0b = NOR(a0b, m);

  // Fourth tier of OR gates
  const n3 = OR(m3b, m3c, m3d, m3e);
  const n2 = OR(m2a, m2b, m2c, m2d);
  const n1 = OR(m1a, m1b, m1c);
  const n0 = OR(m0a, m0b);

  // Outputs
  const c4 = NOR(m3a, n3);
  const g = NOT(n3);
  const p = m3f;
  const f3 = NOT(XOR(b3x, n2));
  const f2 = NOT(XOR(b2x, n1));
  const f1 = NOT(XOR(b1x, n0));
  const f0 = NOT(XOR(b0x, NOR(c0, m)));

  const f = [f3, f2, f1, f0];
  return {c4, g, p, f};
}


function NOT(z) {

  if (growTrees) {
    return {NOT: z};
  } else if (growATrees) {

    // Double NOT optimization
    if (Array.isArray(z) && z[0] === 'NOT')
      return z[1];
    else
      return ['NOT', z];

  } else if (beLispy) {
    return `(NOT ${z})`;
  } else if (beSymbolic) {
    const needsParen = !z.match(/^[a-z0-9]+$/) && !z.match(/^\(.*\)$/);;
    return needsParen ? `!(${z})` : `!${z}`;
  } else {
    return !z;
  }
}

function OR(...z) {

  if (growTrees) {
    return z.reduce((cur, y) => cur === 0 ? y : {OR: [cur, y]}, 0);
  } else if (growATrees) {
    return ['OR', ...z];
  } else if (beLispy) {
    return `(OR ${z.join(' ')})`;
  } else if (beSymbolic) {
    return '(' + z.join(' | ') + ')';
  } else {
    return z.reduce((cur, y) => cur | y);
  }
}


function XOR(...z) {

  if (growTrees) {
    return z.reduce((cur, y) => cur === 0 ? y : {XOR: [cur, y]}, 0);
  } else if (growATrees) {
    return ['XOR', ...z];
  } else if (beLispy) {
    return `(XOR ${z.join(' ')})`;
  } else if (beSymbolic) {
    return '(' + z.join(' ^ ') + ')';
  } else {
    return z.reduce((cur, y) => cur ^ y);
  }
}


function AND(...z) {

  if (growTrees) {
    return z.reduce((cur, y) => cur === 0 ? y : {AND: [cur, y]}, 0);
  } else if (growATrees) {
    return ['AND', ...z];
  } else if (beLispy) {
    return `(AND ${z.join(' ')})`;
  } else if (beSymbolic) {
    return '(' + z.join(' & ') + ')';
  } else {
    return z.reduce((cur, y) => cur & y);
  }
}


function NOR(...z) {

  if (beLispy || beSymbolic) {
    return NOT(OR(...z));
  } else {
    return NOT(z.reduce((cur, y) => OR(cur, y)));
  }
}


// Split a four bit number `p` into its separate bits
// and return a four element array [p3, p2, p1, p0].
function bitSplit(p) {
  return [(p >> 3) & 1,
          (p >> 2) & 1,
          (p >> 1) & 1,
          (p >> 0) & 1];
}


function do1(a, b, m, s, c0) {
  const {c4, g, p, f} = do10181(bitSplit(a), bitSplit(b), m, bitSplit(s), c0);
  console.log(`f=${f.map(b => +b).join('')} c4=${+c4} g=${+g} p=${+p}`);
}

module.exports = {
  do1, bitSplit, NOR, do10181,
};


function dump(n, o) {
  console.log(`${n}: ${util.inspect(o, {depth: 999, compact: true, maxArrayLength: 9999})},`);
}


function demorgan(n) {
  if (!Array.isArray(n)) return n;
  
// NOR(a, ..., z) = AND(NOT(a), ..., NOT(z))
  if (n[0] === 'NOT' && Array.isArray(n[1]) && n[1][0] === 'OR') {

    n[1].forEach((v, x, a) => {

      if (x === 0) 
        a[x] = 'AND';
      else
        a[x] = NOT(demorgan(v));
    });

    // Replace (NOT(OR a ... z)) with newly modified (AND a ... z)
    n = n[1];
  } else {

    n.forEach((v, x) => {
      if (x > 0) n[x] = demorgan(v);
    });
  }

  return n;
}


function main() {
  const {c4, g, p, f} = do10181('a3,a2,a1,a0'.split(/,/),
                                'b3,b2,b1,b0'.split(/,/),
                                'm',
                                's3,s2,s1,s0'.split(/,/),
                                'c0');
/*
  console.log(`const NORtree = {`);
  dump('c4', c4);
  dump('g', g);
  dump('p', p);
  dump('f3', f[3]);
  dump('f2', f[2]);
  dump('f1', f[1]);
  dump('f0', f[0]);
  console.log(`};`);
*/  
  console.log(`const ANDCtree = {`);
  dump('c4', demorgan(c4));
  dump('g', demorgan(g));
  dump('p', demorgan(p));
  dump('f3', demorgan(f[3]));
  dump('f2', demorgan(f[2]));
  dump('f1', demorgan(f[1]));
  dump('f0', demorgan(f[0]));
  console.log(`};`);

  console.log(`module.exports = {ANDCtree};`);
}

main();
