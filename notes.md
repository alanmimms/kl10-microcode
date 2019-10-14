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

