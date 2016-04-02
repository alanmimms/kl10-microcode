'use strict';

class WordBits {
  constructor(bitsPerWord, msbIsBit0) {
    this.bpw = bitsPerWord;
    this.be = msbIsBit0;
  }
  
  // Given a word w and a count of nBits bits, return the LEAST
  // significant nBits bits of the word as a right-aligned integer.
  getLSBs(w, nBits) {return (w & ((1 << nBits) - 1))}

  // Given a word w and a count of nBits bits, return the MOST
  // significant nBits bits of the word as a right-aligned integer.
  getMSBs(w, nBits) {return this.getLSBs(w >>> (this.bpw - nBits), nBits)}

  // Given a word w and a rightMostBitNumber in this word's bit
  // numbering style, return a field of nBits to the left of that
  // rightmost bit as a right-aligned integer.
  getMiddleBits(w, rightMostBitNumber, nBits) {
    return this.getLSBs(w >>> this.bn_(rightMostBitNumber + 1), nBits)
  }

  // Return n as a canononicalized bit number (2^n is bit number n)
  // for this word's bit numbering style.
  bn_(n) {return this.be ? this.bpw - n : n}
};

module.exports = WordBits;
