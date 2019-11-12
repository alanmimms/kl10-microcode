# 20191011
## gencode.js and microcode.js
* [gencode.js] (klx.mcr, define.mic) ==> microcode.js
* Each microinstruction is a function performing that instruction's operations
* Load new register content based on microinstruction mux settings
* Update register values after all load, ALU, mux, shift, etc. done

## EBox
* ebox.js simulates entire EBox
* Runs microcode engine and provides interfaces for EBus, E/M interface

## MBox
* mbox.js simulates MBox and memory
* Provides channel interface to DMA devices
* Invoked for each cycle EBox drives changes on E/M interface
* Provides reply stimulus on E/M interface back to EBox


# Stamps

* EBOXUnit
  * get() // Undefined: must be overridden
  * bitWidth: integer

* BitField(EBOXUnit)
  * input: EBOXUnit
  * s: 0
  * e: 0
  * get()

* BitCombiner(EBOXUnit)
  * inputs: { EBOXUnit ... }
  * get()

* RAM(EBOXUnit)
  * splitter: BitSplitter
  * get(addr, field)
  * put(addr, value) // For loading

* Mux(EBOXUnit)
  * splitter: BitSplitter
  * combiner: BitCombiner
  * get(field)

* Reg(EBOXUnit)
  * input: input
  * get(field)
  * latch()

* LogicUnit(EBOXUnit)
  * splitter: BitSplitter
  * inputs: { EBOXUnit ... }
  * get(field)


## IDEAS
* Make BitSplitter decorate its `input` stamp with proxies to itself
  to retrieve each field it contains. This could allows DR.J
  references to automagically know to get the field using DRsplitter.
  Copying the values from DRAM.get(addr, 'J') into DR.J could happen
  in DR.latch().
* Add a EBOXForwardRef Stamp to allow automatically resolved forward
  references to EBOXUnits. Make this a more generally applicable
  Stamp?


## Clocking latch --> clock

* X: J/Y
* Y: J/Z
* Z: J/X

       CRADR     CR
* 0↓:   X     ?: J/X

* 0↑:   X     X: J/Y

* 1↓:   Y     X: J/Y

* 1↑:   Y     Y: J/Z

* 2↓:   Z     Y: J/Z

* 2↑:   Z     Z: J/X

* 3↓:   X     Z: J/X

* 3↑:   X     X: J/Y
