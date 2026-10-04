#!/bin/sh
# tsx's CLI opens a named Unix socket for watch-mode IPC, which the offline
# sandbox deliberately denies. Its Node loader runs TypeScript files without
# creating a listening socket and keeps normal imports/source maps working.
exec /usr/local/bin/node --import /usr/local/lib/node_modules/tsx/dist/loader.mjs "$@"
