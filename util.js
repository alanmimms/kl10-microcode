// For a BigInt parameter `n`, return its value decoded as groups of
// four octal digits with leading zeroes. For Number `n`, just return
// leading zero octal digits for the specified bits-per-word size
// `bpw`.
module.exports.octal4 = function octal4(n, bpw = 12) {

  if (typeof n === 'bigint') {
    const oneMore = 1n << BigInt(bpw);
    return (n | oneMore).toString(8).slice(1).match(/(.{4})/g).join(' ');
  } else {
    const oneMore = 1 << bpw;
    return (n | oneMore).toString(8).slice(1);
  }
}
