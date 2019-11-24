'use strict';
// 10181 netlist
// All references are to F10181.pdf p. 7-107 schematic.
// The symbol @ means NOR.

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
  return !z;
}

function OR(...z) {
  return z.reduce((cur, y) => cur | y);
}


function XOR(...z) {
  return z.reduce((cur, y) => cur ^ y);
}


function NOR(...z) {
  return NOT(z.reduce((cur, y) => OR(cur, y)));
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
