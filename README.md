# KL10 microcode level emulator

[![forthebadge](https://forthebadge.com/images/badges/powered-by-electricity.svg)](https://forthebadge.com)
[![forthebadge](https://forthebadge.com/images/badges/contains-technical-debt.svg)](https://forthebadge.com)
[![forthebadge](https://forthebadge.com/images/badges/made-with-javascript.svg)](https://forthebadge.com)

(NOTE: This is a work in progress.)

The goal of this project is to build an emulator for the hardware of a
PDP-10 CPU called the KL10 model B. This was the ~1983 pinnacle of the
PDP10 universe in that it could support up to 16MWords (36-bit) of
memory, allowed huge I/O DMA capability for disk and tape drives,
could host a DECnet or a TCP/IP networking interface, and supported up
to (I think) about 256 TTY RS-232C serial terminals. These machines
had a PDP-11/40 as their front-end processor for loading microcode,
doing diagnostics, and interfacing the console and command and control
for the system. Unlike most of the mainframes of their day, they had
virtual no console switches or lights. All of the management of the
system was done through the PDP-11/40's interface into the innards of
the system.

This emulator runs (with no changes) the final TOPS-20 capable
microcode release from DEC.

## Building

For now, the macro assembly listing file for the microcode is read by
a quick JavaScript utility called `gencode.js` to build source files
needed by the emulator. You can run this by

```
node gencode
```

This generates:

* `cram.js` which is the CRAM (microcode) RAM contents.
* `cram-lines.js` for source level microcode debugging and single
  stepping.
* `dram.js` which is the DRAM (dispatch) RAM contents.
* `fields-model.js` which I don't currently use.

## Running
You can run the emulator by

```
node em
```

This starts the microcode debugger. This debugger will eventually
handle two levels of debugging: the microcode level and the PDP-10
instruction level. For now you can start and stop the PDP-10
instruction level only. The rest of the features (some of which aren't
yet implemented or are simply hacks to get past some bug I was working
on) are for controlling microcode emulation.


## Yarn
I use `yarn` for package management. Some people use `npm`. I like
mine. You can use `yarn run` to select from the scripts to run. Or
just specify `yarn run build` and then `yarn run run` to run the
emulator.


# Status
The project has been going for a few months of spare time so far. I
have most of the EBOX (execution box) emulated to at least the first
order of detail now, and the microcode correctly fetches an
instruction from the MBOX (memory) and begins to execute it.

Don't expect this to be stable or tagged for releases until I get a
lot further down the path. For now, since it isn't stable anyway, I
checkpoint my source tree to GitHub with impunity and little care. It
could be in any state when I do that.

I have code from an earlier project that will eventually supply the
emulation for disk and tape drives, and I'll write an Ethernet based
emulator for the TCP/IP interface when the time comes as well.

I expect this emulation to run at only a fraction of the speed of the
real DECSYSTEM-20 because I'm emulating at such a low level and I'm
not being very concerned with performance at this point.

# The Future
When this is working more completely, I want to take the understanding
I have gained from creating this emulator and build one in C or C++
that is meant to go _fast_. I didn't do that first instead because it
would have slowed me down considerably. The whole C/C++ edit, compile,
link, debug loop is much slower than my JavaScript debugging process,
and the JavaScript language is extremely expressive. It's just faster
to get concepts from brain to working code.


# Thanks
Many _many_ thanks to Al Kossow and his comrades at the Computer
History Museum for having read magtapes, imaged documents, and
generally supported the DEC historical community for projects like
this one. Much of the information that I have used in various ways
during this project came from his archive at

http://www.bitsavers.org/pdf/dec/pdp10/

of which there are fortunately many mirrors.
